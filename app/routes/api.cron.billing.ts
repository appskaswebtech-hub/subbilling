// app/routes/api.cron.billing.ts
//
// Supports two invocation styles:
//
// A) CyberPanel cron panel (wget GET + query param):
//    wget "https://subscription.kaswebtechsolutions.com/api/cron/billing?secret=subscription-attempt-cron-secret"
//
// B) curl POST + header (manual / CI trigger):
//    curl -s -X POST https://subscription.kaswebtechsolutions.com/api/cron/billing \
//         -H "x-cron-secret: subscription-attempt-cron-secret" -o /dev/null
//
// Flow:
//   1. Auth: check x-cron-secret header OR ?secret= query param
//   2. Find ACTIVE subscriptions with nextBillingDate <= now, no PENDING attempt
//   3. Re-fetch each sub before billing (race condition guard)
//   4. Call subscriptionBillingAttemptCreate — always write PENDING
//   5. Advance nextBillingDate atomically (cron owns this — webhook only overrides if Shopify returns a future date)
//   6. Webhook (SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS/FAILURE) marks PENDING → SUCCESS/FAILED

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json }            from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import db                  from "../db.server";

// ─── GraphQL mutation ─────────────────────────────────────────
const BILLING_ATTEMPT_CREATE = `#graphql
  mutation SubscriptionBillingAttemptCreate(
    $subscriptionContractId: ID!
    $originTime: DateTime!
    $idempotencyKey: String!
  ) {
    subscriptionBillingAttemptCreate(
      subscriptionContractId: $subscriptionContractId
      subscriptionBillingAttemptInput: {
        originTime: $originTime
        idempotencyKey: $idempotencyKey
      }
    ) {
      subscriptionBillingAttempt {
        id
        ready
        errorMessage
        errorCode
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─── Auth helper (header OR query param) ─────────────────────
function isAuthorized(request: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) return false;

  const headerSecret = request.headers.get("x-cron-secret");
  if (headerSecret === expectedSecret) return true;

  const url         = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  if (querySecret === expectedSecret) return true;

  return false;
}

// ─── Serialize any thrown value to a readable string ─────────
function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.constructor.name || "Unknown Error";
  if (err instanceof Response) return `HTTP ${err.status} ${err.statusText}`;
  if (typeof err === "object" && err !== null) {
    try {
      const cast = err as Record<string, unknown>;
      if (typeof cast["message"] === "string") return cast["message"];
      if (Array.isArray(cast["errors"])) {
        const msgs = (cast["errors"] as Array<Record<string, unknown>>)
          .map((e) => (typeof e["message"] === "string" ? e["message"] : ""))
          .filter(Boolean);
        if (msgs.length) return msgs.join(", ");
      }
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err ?? "Unknown error");
}

// ─── Advance nextBillingDate ──────────────────────────────────
// Handles normalised values from normaliseFrequency():
//   DAILY, WEEKLY, BIWEEKLY, MONTHLY, YEARLY
// Also handles raw Shopify intervals (DAY, WEEK, MONTH, YEAR)
// and combined strings like "2 WEEKLY", "3 DAILY"
// Moved to app/lib/subscription-sync.server.ts, which the cron, the create
// webhook and the backfill all share.
//
// Deliberately NOT re-exported from here: Remix strips only loader/action/
// headers from a route's client bundle, so any other export pulls the
// .server module in with it and the build fails with "Server-only module
// referenced by client". Import it from the lib instead.
import { advanceBillingDate } from "../lib/subscription-sync.server";

// ─── Core billing logic ───────────────────────────────────────
async function runBilling() {
  const now = new Date();

  const dueSubs = await db.subscription.findMany({
    where: {
      status:          "ACTIVE",
      nextBillingDate: { lte: now },
      billingAttempts: {
        none: { status: "PENDING" },
      },
    },
    include: {
      billingAttempts: {
        orderBy: { createdAt: "desc" },
        take:    1,
      },
    },
  });

  console.log(`[cron] ${dueSubs.length} due subscription(s) at ${now.toISOString()}`);

  if (dueSubs.length === 0) {
    return { ok: true, processed: 0, results: [] };
  }

  const results: { contractId: string; result: string }[] = [];
  const originTime = now.toISOString();

  for (const sub of dueSubs) {

    // Re-fetch right before billing — catches pause/cancel race condition
    const fresh = await db.subscription.findUnique({ where: { id: sub.id } });

    if (!fresh || fresh.status !== "ACTIVE") {
      console.log(`[cron] Skipping ${sub.shopifyContractId} — status is now ${fresh?.status ?? "deleted"}`);
      results.push({ contractId: sub.shopifyContractId, result: `SKIPPED: ${fresh?.status ?? "deleted"}` });
      continue;
    }

    try {
      let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
      try {
        ({ admin } = await unauthenticated.admin(fresh.shop));
      } catch (adminErr: unknown) {
        const errMsg = `Failed to get admin client: ${serializeError(adminErr)}`;
        console.error(`[cron] ${fresh.shopifyContractId}: ${errMsg}`);
        await db.billingAttempt.create({
          data: { subscriptionId: fresh.id, amount: fresh.price, status: "FAILED", errorMessage: errMsg },
        });
        results.push({ contractId: fresh.shopifyContractId, result: `ERROR: ${errMsg}` });
        continue;
      }

      // Deterministic idempotency key: contract + billing date
      const idempotencyKey = `${fresh.shopifyContractId}-${fresh.nextBillingDate.toISOString()}`;

      const res = await admin.graphql(BILLING_ATTEMPT_CREATE, {
        variables: {
          subscriptionContractId: fresh.shopifyContractId,
          originTime,
          idempotencyKey,
        },
      });

      const result = await res.json() as {
        data?: {
          subscriptionBillingAttemptCreate?: {
            subscriptionBillingAttempt?: {
              id:           string;
              ready:        boolean;
              errorMessage: string | null;
              errorCode:    string | null;
            } | null;
            userErrors: Array<{ field: string[]; message: string }>;
          };
        };
        errors?: Array<{ message: string }>;
      };

      // Top-level GraphQL errors
      if (result?.errors?.length) {
        const errMsg = result.errors.map((e) => e.message).join(", ");
        console.error(`[cron] GraphQL errors for ${fresh.shopifyContractId}: ${errMsg}`);
        await db.$transaction([
          db.billingAttempt.create({
            data: { subscriptionId: fresh.id, amount: fresh.price, status: "FAILED", errorMessage: errMsg },
          }),
          db.subscription.update({ where: { id: fresh.id }, data: { status: "FAILED" } }),
        ]);
        results.push({ contractId: fresh.shopifyContractId, result: `ERROR: ${errMsg}` });
        continue;
      }

      const attempt    = result?.data?.subscriptionBillingAttemptCreate?.subscriptionBillingAttempt;
      const userErrors = result?.data?.subscriptionBillingAttemptCreate?.userErrors ?? [];

      // Shopify userErrors
      if (userErrors.length > 0) {
        const errMsg = userErrors.map((e) => e.message).join(", ");
        console.error(`[cron] userErrors for ${fresh.shopifyContractId}: ${errMsg}`);
        await db.$transaction([
          db.billingAttempt.create({
            data: { subscriptionId: fresh.id, amount: fresh.price, status: "FAILED", errorMessage: errMsg },
          }),
          db.subscription.update({ where: { id: fresh.id }, data: { status: "FAILED" } }),
        ]);
        results.push({ contractId: fresh.shopifyContractId, result: `ERROR: ${errMsg}` });
        continue;
      }

      if (attempt) {
        const nextDate = advanceBillingDate(fresh.nextBillingDate, fresh.frequency);

        await db.$transaction([
          db.billingAttempt.create({
            data: { subscriptionId: fresh.id, amount: fresh.price, status: "PENDING" },
          }),
          db.subscription.update({
            where: { id: fresh.id },
            data:  { nextBillingDate: nextDate },
          }),
        ]);

        console.log(`[cron] ✅ PENDING — ${fresh.shopifyContractId} — frequency: ${fresh.frequency} — next: ${nextDate.toISOString()}`);
        results.push({ contractId: fresh.shopifyContractId, result: "PENDING" });

      } else {
        const msg = "No attempt returned and no userErrors — check API version and scopes";
        console.error(`[cron] ${fresh.shopifyContractId}: ${msg}`);
        results.push({ contractId: fresh.shopifyContractId, result: `ERROR: ${msg}` });
      }

    } catch (err: unknown) {
      const errMsg = serializeError(err);
      console.error(`[cron] Exception for ${fresh.shopifyContractId}: ${errMsg}`);
      console.error(`[cron] Raw thrown value:`, err);
      await db.billingAttempt.create({
        data: { subscriptionId: fresh.id, amount: fresh.price, status: "FAILED", errorMessage: errMsg },
      });
      results.push({ contractId: fresh.shopifyContractId, result: `EXCEPTION: ${errMsg}` });
    }
  }

  return { ok: true, processed: dueSubs.length, results };
}

// ─── LOADER (GET) — CyberPanel wget cron ─────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  console.log("[cron] GET /api/cron/billing");
  if (!isAuthorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const data = await runBilling();
  return json(data);
}

// ─── ACTION (POST) — curl with x-cron-secret header ──────────
export async function action({ request }: ActionFunctionArgs) {
  console.log("[cron] POST /api/cron/billing");
  if (!isAuthorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  const data = await runBilling();
  return json(data);
}


