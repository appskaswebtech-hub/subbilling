// app/lib/app-commission.server.ts
//
// Charges the app's own commission when a merchant's customer subscription
// bills successfully. Only applies to plans that carry a `commissionRate`
// (today: "free") — flat-fee tiers return immediately.
//
// This is the app billing itself, NOT the merchant billing a shopper. It calls
// appUsageRecordCreate against the usage-priced line item on the merchant's
// AppSubscription, which the merchant approved (with its monthly cap) when they
// chose the plan.
//
// Invariant: this must NEVER throw and must NEVER be the reason a subscription
// billing webhook fails. A commission we cannot collect is a row in the ledger
// with status FAILED — it is not an outage for the merchant.

import db          from "../db.server";
import { PLANS, calcCommission } from "../config/plans";

// The subset of the Prisma Subscription row this module needs. Declared
// structurally so callers can pass the full record without a cast.
interface SubscriptionLike {
  id:                string;
  shop:              string;
  price:             number;
  shopifyContractId: string;
}

// Minimal shape of the authenticated admin client both webhook handlers hold.
interface AdminLike {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

interface ChargeCommissionArgs {
  shop:             string;
  admin:            AdminLike | undefined;
  subscription:     SubscriptionLike;
  /** Local BillingAttempt id — the idempotency key, in the DB and at Shopify. */
  billingAttemptId: string;
  /** Shopify subscription contract GID, stored for the audit trail. */
  contractGid:      string;
  /**
   * Shopify Order GID for the charge, when the caller has one. Present on
   * subscription_billing_attempts/success; absent on the synthesized attempt
   * for a checkout order, which falls back to the stored price.
   */
  orderGid:         string | null;
}

const ORDER_TOTAL_QUERY = `#graphql
  query CommissionOrderTotal($id: ID!) {
    order(id: $id) {
      name
      totalPriceSet { shopMoney { amount currencyCode } }
    }
  }
`;

// Every ledger write goes through here. It must be an upsert, not a create:
// billingAttemptId is unique, and a retry after a FAILED row would otherwise
// hit the constraint instead of recording the successful second attempt.
type LedgerWrite = {
  shop:             string;
  billingAttemptId: string;
  contractId:       string;
  baseAmount:       number;
  rate:             number;
  amount:           number;
  currency?:        string;
  status:           "CHARGED" | "SKIPPED" | "FAILED";
  reason?:          string | null;
  usageRecordId?:   string | null;
};

function recordCharge({ billingAttemptId, ...rest }: LedgerWrite) {
  const data = { billingAttemptId, ...rest };
  return db.commissionCharge.upsert({
    where:  { billingAttemptId },
    create: data,
    update: data,
  });
}

const USAGE_RECORD_CREATE = `#graphql
  mutation CommissionUsageRecordCreate(
    $subscriptionLineItemId: ID!
    $price: MoneyInput!
    $description: String!
    $idempotencyKey: String!
  ) {
    appUsageRecordCreate(
      subscriptionLineItemId: $subscriptionLineItemId
      price: $price
      description: $description
      idempotencyKey: $idempotencyKey
    ) {
      appUsageRecord { id }
      userErrors { field message }
    }
  }
`;

// Shopify reports a cap breach as a userError rather than a distinct code, so
// the message is all we have to classify it.
function isCapError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("capped") || m.includes("cap amount") || m.includes("exceed");
}

/**
 * Records a commission for one successful subscription charge.
 *
 * Safe to call for every shop on every success — it self-selects on the shop's
 * plan and is idempotent per `billingAttemptId`.
 */
export async function chargeCommission({
  shop,
  admin,
  subscription,
  billingAttemptId,
  contractGid,
  orderGid,
}: ChargeCommissionArgs): Promise<void> {
  try {
    // ── 1. Does this shop's plan take a commission at all? ──────────
    const shopPlan = await db.shopPlan.findUnique({ where: { shop } });
    const rate     = shopPlan ? PLANS[shopPlan.plan]?.commissionRate : undefined;

    if (!shopPlan || !rate) return;   // flat-fee tier, or no plan row — nothing owed

    // ── 2. Idempotency ──────────────────────────────────────────────
    // Shopify retries webhooks, and SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS is
    // not otherwise re-entrant.
    //
    // A settled outcome — CHARGED, or SKIPPED for a business reason such as a
    // cap breach — blocks the retry. FAILED does NOT: it means we never got a
    // usage record out of Shopify, and retrying is safe because the mutation
    // carries `billingAttemptId` as its idempotencyKey, so Shopify itself
    // rejects a genuine double-charge. Treating FAILED as terminal would
    // forfeit the commission on any transient error.
    const existing = await db.commissionCharge.findUnique({
      where: { billingAttemptId },
    });
    if (existing && existing.status !== "FAILED") {
      console.log(`[commission] already ${existing.status} for attempt ${billingAttemptId} — skipping`);
      return;
    }

    // ── 3. Work out what to take the percentage of ──────────────────
    // Subscription.price is the PER-UNIT price of the contract's FIRST line
    // (see subscription-sync.server.ts) so it under-reports multi-line and
    // multi-quantity contracts. Prefer the real order total whenever we have
    // an order to ask about.
    let baseAmount  = subscription.price;
    let currency    = "USD";
    let orderName   = "";
    let baseSource  = "subscription.price";

    if (orderGid && admin) {
      try {
        const res  = await admin.graphql(ORDER_TOTAL_QUERY, { variables: { id: orderGid } });
        const json = await res.json() as {
          data?: { order?: { name?: string; totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } } } };
        };

        const money = json?.data?.order?.totalPriceSet?.shopMoney;
        const total = money?.amount ? parseFloat(money.amount) : NaN;

        if (Number.isFinite(total) && total > 0) {
          baseAmount = total;
          currency   = money?.currencyCode ?? "USD";
          orderName  = json?.data?.order?.name ?? "";
          baseSource = "order.totalPriceSet";
        } else {
          console.warn(`[commission] order ${orderGid} returned no usable total — falling back to subscription.price`);
        }
      } catch (err) {
        console.warn(`[commission] failed to read order ${orderGid} — falling back to subscription.price:`, err);
      }
    }

    const amount = calcCommission(baseAmount, rate);

    console.log(
      `[commission] ${shop} — base ${baseAmount} ${currency} (${baseSource}) × ${rate} → ${amount}`
    );

    // ── 4. Nothing to charge ────────────────────────────────────────
    // A zero base (a 100%-discounted cycle, a free trial line) rounds to 0, and
    // Shopify rejects a 0 usage record. Log it as SKIPPED so the ledger still
    // accounts for every successful cycle.
    if (amount <= 0) {
      await recordCharge({
        shop, billingAttemptId, contractId: contractGid,
        baseAmount, rate, amount: 0, currency,
        status: "SKIPPED", reason: "zero-amount",
      });
      return;
    }

    // ── 5. We need the usage line item and an admin client ──────────
    if (!shopPlan.usageLineItemId) {
      console.error(`[commission] ${shop} is on "${shopPlan.plan}" but has no usageLineItemId — cannot bill`);
      // SKIPPED, not FAILED: retrying will not help. The subscription needs
      // re-approving before this shop can be billed at all, and until then a
      // retry loop would just repeat the same lookup.
      await recordCharge({
        shop, billingAttemptId, contractId: contractGid,
        baseAmount, rate, amount, currency,
        status: "SKIPPED", reason: "no-usage-line",
      });
      return;
    }

    if (!admin) {
      // FAILED, so a webhook retry that does carry an admin client can collect.
      await recordCharge({
        shop, billingAttemptId, contractId: contractGid,
        baseAmount, rate, amount, currency,
        status: "FAILED", reason: "no-admin-client",
      });
      return;
    }

    // ── 6. Bill the merchant ────────────────────────────────────────
    // The app subscription is always priced in USD (see app.billing.tsx), so
    // the usage record must be too even when the order settled in another
    // currency. `baseAmount`/`currency` keep the original on record.
    const description = orderName
      ? `${Math.round(rate * 100)}% commission on subscription order ${orderName}`
      : `${Math.round(rate * 100)}% commission on subscription charge`;

    const res = await admin.graphql(USAGE_RECORD_CREATE, {
      variables: {
        subscriptionLineItemId: shopPlan.usageLineItemId,
        price:                  { amount, currencyCode: "USD" },
        description,
        idempotencyKey:         billingAttemptId,
      },
    });

    const json = await res.json() as {
      data?: {
        appUsageRecordCreate?: {
          appUsageRecord?: { id: string } | null;
          userErrors?: { field: string[] | null; message: string }[];
        };
      };
    };

    const result     = json?.data?.appUsageRecordCreate;
    const userErrors = result?.userErrors ?? [];
    const recordId   = result?.appUsageRecord?.id ?? null;

    if (userErrors.length) {
      const message = userErrors.map((e) => e.message).join(", ");
      const capped  = isCapError(message);

      console.error(`[commission] ${shop} appUsageRecordCreate ${capped ? "CAPPED" : "error"}: ${message}`);

      await recordCharge({
        shop, billingAttemptId, contractId: contractGid,
        baseAmount, rate, amount, currency,
        // A cap breach is an expected business state, not a bug — the merchant
        // simply owes nothing more this period until they raise it, so it is
        // terminal for this charge. Anything else may be transient: FAILED
        // leaves the door open for a retry.
        status: capped ? "SKIPPED" : "FAILED",
        reason: capped ? "capped" : message.slice(0, 190),
      });
      return;
    }

    await recordCharge({
      shop, billingAttemptId, contractId: contractGid,
      baseAmount, rate, amount, currency,
      status: "CHARGED", usageRecordId: recordId,
    });

    console.log(`[commission] ✅ charged ${amount} USD to ${shop} (usage record ${recordId})`);

  } catch (err) {
    // Last resort. The merchant's subscription billing has already succeeded
    // and must stay that way, so swallow everything and leave a trace.
    console.error(`[commission] unexpected failure for ${shop} / attempt ${billingAttemptId}:`, err);

    try {
      await recordCharge({
        shop, billingAttemptId, contractId: contractGid,
        baseAmount: subscription.price, rate: 0, amount: 0,
        status: "FAILED",
        reason: err instanceof Error ? err.message.slice(0, 190) : "unknown error",
      });
    } catch {
      // Even the ledger write failed — most likely the database itself, or a
      // concurrent webhook retry racing us to the same row. Nothing further to
      // do; the console line above is the record.
    }
  }
}

/**
 * Month-to-date commission for the billing page. Returns zeroes for shops on a
 * flat-fee plan so callers need no branch of their own.
 */
export async function getCommissionSummary(shop: string) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const rows = await db.commissionCharge.findMany({
    where:  { shop, createdAt: { gte: monthStart } },
    select: { amount: true, status: true, reason: true },
  });

  return {
    charged:   rows.filter((r) => r.status === "CHARGED").reduce((sum, r) => sum + r.amount, 0),
    count:     rows.filter((r) => r.status === "CHARGED").length,
    // True once Shopify has refused a usage record for hitting the monthly cap:
    // the merchant is now getting the app for free and needs to re-approve.
    capReached: rows.some((r) => r.status === "SKIPPED" && r.reason === "capped"),
  };
}
