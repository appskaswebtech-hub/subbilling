// app/routes/webhooks.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { advanceBillingDate } from "./api.cron.billing";

// ─── GraphQL query ────────────────────────────────────────────
const SUBSCRIPTION_CONTRACT_QUERY = `
  query GetSubscriptionContract($id: ID!) {
    subscriptionContract(id: $id) {
      id
      status
      nextBillingDate
      currencyCode
      customer {
        id
        email
        firstName
        lastName
      }
      billingPolicy {
        interval
        intervalCount
        minCycles
        maxCycles
      }
      deliveryPolicy {
        interval
        intervalCount
      }
      lines(first: 10) {
        edges {
          node {
            id
            title
            variantTitle
            sku
            quantity
            productId
            variantId
            sellingPlanId
            sellingPlanName
            currentPrice {
              amount
              currencyCode
            }
            lineDiscountedPrice {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

// ─── Convert numeric REST id → GID ───────────────────────────
function toContractGid(raw: string | number): string {
  const id = String(raw);
  return id.startsWith("gid://") ? id : `gid://shopify/SubscriptionContract/${id}`;
}

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  console.log(`[Webhook] ${topic} from ${shop}`);
  console.log(`[Webhook] Raw payload:`, JSON.stringify(payload, null, 2));

  switch (topic) {

    // ── New subscription created ──────────────────────────────
    case "SUBSCRIPTION_CONTRACTS_CREATE": {
      const p          = payload as any;
      const contractId = p.admin_graphql_api_id as string;

      if (!admin) {
        console.error("[Webhook] No admin API client — cannot fetch contract details");
        break;
      }

      let contract: any = null;
      try {
        const res    = await admin.graphql(SUBSCRIPTION_CONTRACT_QUERY, { variables: { id: contractId } });
        const result = await res.json();
        contract     = result?.data?.subscriptionContract ?? null;
        console.log("[Webhook] GraphQL contract:", JSON.stringify(contract, null, 2));
      } catch (err) {
        console.error("[Webhook] GraphQL fetch failed:", err);
      }

      const status        = contract?.status ?? p.status ?? "ACTIVE";
      const interval      = contract?.billingPolicy?.interval ?? p.billing_policy?.interval;
      const intervalCount = contract?.billingPolicy?.intervalCount ?? p.billing_policy?.interval_count ?? 1;
      const frequency     = normaliseFrequency(interval, intervalCount);

      const rawNext         = contract?.nextBillingDate as string | null | undefined;
      const parsedNext      = rawNext ? new Date(rawNext) : null;
      const fallbackDate    = advanceBillingDate(new Date(), frequency);
      const nextBillingDate = (parsedNext && !isNaN(parsedNext.getTime())) ? parsedNext : fallbackDate;

      const customerId    = contract?.customer?.id ?? p.admin_graphql_api_customer_id ?? String(p.customer_id ?? "");
      const customerEmail = contract?.customer?.email ?? "";
      const firstNode     = contract?.lines?.edges?.[0]?.node ?? null;
      const productTitle  = firstNode?.title           ?? "Unknown Product";
      const planName      = firstNode?.sellingPlanName ?? "Subscription";
      const priceAmount   = firstNode?.currentPrice?.amount ?? "0";

      console.log(`[Webhook] Creating subscription — frequency: ${frequency}, nextBillingDate: ${nextBillingDate.toISOString()}`);

      const newSub = await prisma.subscription.upsert({
        where:  { shopifyContractId: contractId },
        update: {
          status:          normaliseStatus(status),
          nextBillingDate,
          customerEmail,
          productTitle,
          planName,
          price:           parseFloat(priceAmount),
          frequency,
        },
        create: {
          shop,
          shopifyContractId: contractId,
          customerId,
          customerEmail,
          productTitle,
          planName,
          status:          normaliseStatus(status),
          price:           parseFloat(priceAmount),
          frequency,
          nextBillingDate,
        },
      });

      // Only create initial billing attempt for brand new subscriptions
      const existingAttempt = await prisma.billingAttempt.findFirst({
        where: { subscriptionId: newSub.id },
      });

      if (!existingAttempt) {
        await prisma.billingAttempt.create({
          data: {
            subscriptionId: newSub.id,
            amount:         parseFloat(priceAmount),
            status:         "SUCCESS",
          },
        });
      }

      console.log(`[Webhook] ✅ Subscription created: ${contractId} — frequency: ${frequency}`);
      break;
    }

    // ── Subscription updated ──────────────────────────────────
    case "SUBSCRIPTION_CONTRACTS_UPDATE": {
      const p          = payload as any;
      const contractId = p.admin_graphql_api_id as string;

      if (admin) {
        try {
          const res      = await admin.graphql(SUBSCRIPTION_CONTRACT_QUERY, { variables: { id: contractId } });
          const result   = await res.json();
          const contract = result?.data?.subscriptionContract ?? null;

          if (contract) {
            const firstNode  = contract.lines?.edges?.[0]?.node ?? null;
            const rawNext    = contract.nextBillingDate as string | null | undefined;
            const parsedNext = rawNext ? new Date(rawNext) : null;

            await prisma.subscription.updateMany({
              where: { shopifyContractId: contractId },
              data: {
                status:          normaliseStatus(contract.status),
                nextBillingDate: (parsedNext && !isNaN(parsedNext.getTime())) ? parsedNext : undefined,
                customerEmail:   contract.customer?.email   ?? undefined,
                productTitle:    firstNode?.title           ?? undefined,
                planName:        firstNode?.sellingPlanName ?? undefined,
                price:           firstNode?.currentPrice?.amount ? parseFloat(firstNode.currentPrice.amount) : undefined,
                frequency:       normaliseFrequency(contract.billingPolicy?.interval, contract.billingPolicy?.intervalCount),
              },
            });

            console.log(`[Webhook] ✅ Subscription updated (GraphQL): ${contractId}`);
            break;
          }
        } catch (err) {
          console.warn("[Webhook] GraphQL refresh failed, falling back to payload:", err);
        }
      }

      const updated = await prisma.subscription.updateMany({
        where: { shopifyContractId: contractId },
        data: {
          status:          normaliseStatus(p.status),
          nextBillingDate: p.next_billing_date ? new Date(p.next_billing_date) : undefined,
        },
      });

      if (updated.count === 0) {
        console.warn(`[Webhook] Contract ${contractId} not found for update — skipping`);
      }

      console.log(`[Webhook] ✅ Subscription updated (payload fallback): ${contractId}`);
      break;
    }

    // ── Billing succeeded ─────────────────────────────────────
    case "SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS": {
      const p          = payload as any;
      const contractId = toContractGid(p.subscription_contract_id);

      console.log(`[Webhook] Billing success contractId (GID): ${contractId}`);

      const sub = await prisma.subscription.findFirst({
        where: { shopifyContractId: contractId },
      });

      if (!sub) {
        console.warn(`[Webhook] No subscription found for contractId: ${contractId}`);
        break;
      }

      // ── Mark PENDING attempt as SUCCESS ──────────────────────
      const pending = await prisma.billingAttempt.findFirst({
        where:   { subscriptionId: sub.id, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });

      if (pending) {
        await prisma.billingAttempt.update({
          where: { id: pending.id },
          data:  { status: "SUCCESS" },
        });
      } else {
        await prisma.billingAttempt.create({
          data: { subscriptionId: sub.id, amount: sub.price, status: "SUCCESS" },
        });
      }

      // ── Smart nextBillingDate update ──────────────────────────
      // The cron ALREADY advanced nextBillingDate before triggering the billing attempt.
      // Shopify in test mode returns the SAME date — we must NOT overwrite the cron-advanced date.
      //
      // Rule:
      //   Shopify date > current DB date → trust Shopify (production stores advance correctly)
      //   Shopify date <= current DB date → keep what cron set (test mode / same-day return)
      if (admin) {
        try {
          const res = await admin.graphql(`
            query GetNextBillingDate($id: ID!) {
              subscriptionContract(id: $id) {
                nextBillingDate
              }
            }
          `, { variables: { id: contractId } });

          const result    = await res.json();
          const nextDate  = result?.data?.subscriptionContract?.nextBillingDate as string | null;
          const currentDB = sub.nextBillingDate;

          console.log(`[Webhook] Shopify nextBillingDate: ${nextDate}`);
          console.log(`[Webhook] Current DB nextBillingDate: ${currentDB.toISOString()}`);

          if (nextDate) {
            const shopifyNext = new Date(nextDate);

            if (shopifyNext > currentDB) {
              // Shopify returned a future date — trust it (production behaviour)
              await prisma.subscription.update({
                where: { id: sub.id },
                data:  { nextBillingDate: shopifyNext },
              });
              console.log(`[Webhook] ✅ Next billing date updated from Shopify: ${shopifyNext.toISOString()}`);
            } else {
              // Shopify returned same/past date — keep the cron-advanced date
              console.log(`[Webhook] ⚠️ Shopify returned same/past date (${nextDate}) — keeping cron-advanced date: ${currentDB.toISOString()}`);
            }
          } else {
            console.log(`[Webhook] ⚠️ Shopify returned no nextBillingDate — keeping cron-advanced date: ${currentDB.toISOString()}`);
          }
        } catch (err) {
          console.error("[Webhook] Failed to fetch nextBillingDate from Shopify:", err);
          // Cron-advanced date stays intact — no action needed
        }
      }

      console.log(`[Webhook] ✅ Billing success: ${contractId}`);
      break;
    }

    // ── Billing failed ────────────────────────────────────────
    case "SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE": {
      const p          = payload as any;
      const contractId = toContractGid(p.subscription_contract_id);
      const errMsg     = (p.error_message ?? p.error_code ?? "Payment declined") as string;

      console.log(`[Webhook] Billing failed contractId (GID): ${contractId}`);

      const sub = await prisma.subscription.findFirst({
        where: { shopifyContractId: contractId },
      });

      if (!sub) {
        console.warn(`[Webhook] No subscription found for contractId: ${contractId}`);
        break;
      }

      // Mark PENDING as FAILED
      const pending = await prisma.billingAttempt.findFirst({
        where:   { subscriptionId: sub.id, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });

      if (pending) {
        await prisma.billingAttempt.update({
          where: { id: pending.id },
          data:  { status: "FAILED", errorMessage: errMsg },
        });
      } else {
        await prisma.billingAttempt.create({
          data: { subscriptionId: sub.id, amount: sub.price, status: "FAILED", errorMessage: errMsg },
        });
      }

      // ── Retry logic using AppSettings ────────────────────────
      // The cron already advanced nextBillingDate, so the sub will retry
      // on the next billing cycle. Cancel only after maxBillingRetries failures.
      const settings   = await prisma.appSettings.findUnique({ where: { shop: sub.shop } });
      const maxRetries = settings?.maxBillingRetries ?? 3;
      const graceDays  = settings?.gracePeriodDays  ?? 7;

      const recentFailures = await prisma.billingAttempt.count({
        where: {
          subscriptionId: sub.id,
          status:         "FAILED",
          createdAt:      { gte: new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000) },
        },
      });

      if (recentFailures >= maxRetries) {
        await prisma.subscription.update({
          where: { id: sub.id },
          data:  { status: "CANCELLED" },
        });
        console.log(`[Webhook] ❌ Subscription cancelled after ${recentFailures} failures: ${contractId}`);
      } else {
        console.log(`[Webhook] ⚠️ Billing failed (${recentFailures}/${maxRetries} retries): ${contractId} — ${errMsg}`);
      }

      console.log(`[Webhook] ❌ Billing failed: ${contractId} — ${errMsg}`);
      break;
    }

    // ── App uninstalled ───────────────────────────────────────
    case "APP_UNINSTALLED": {
      await prisma.subscription.updateMany({
        where: { shop, status: { in: ["ACTIVE", "PAUSED"] } },
        data:  { status: "CANCELLED" },
      });
      console.log(`[Webhook] App uninstalled: ${shop}`);
      break;
    }

    // ── GDPR (mandatory) ─────────────────────────────────────
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
      console.log(`[Webhook] GDPR ${topic} from ${shop}`);
      break;

    default:
      console.log(`[Webhook] Unhandled topic: ${topic}`);
  }

  return json({ ok: true });
}

// ─── Helpers ──────────────────────────────────────────────────

function normaliseStatus(raw: string): string {
  const map: Record<string, string> = {
    ACTIVE:    "ACTIVE",
    PAUSED:    "PAUSED",
    CANCELLED: "CANCELLED",
    EXPIRED:   "CANCELLED",
    FAILED:    "CANCELLED",
  };
  return map[raw?.toUpperCase()] ?? "PENDING";
}

// Stores a consistent string that advanceBillingDate() can handle.
// DAY/1   → "DAILY"
// WEEK/1  → "WEEKLY"
// WEEK/2  → "BIWEEKLY"
// WEEK/3+ → "3 WEEKLY"
// MONTH/1 → "MONTHLY"
// MONTH/2 → "2 MONTHLY"
// YEAR/1  → "YEARLY"
// YEAR/2  → "2 YEARLY"
function normaliseFrequency(interval?: string, count?: number): string {
  if (!interval) return "MONTHLY";
  const i = interval.toUpperCase();
  const c = count ?? 1;

  if (i === "DAY")   return c > 1 ? `${c} DAILY`   : "DAILY";
  if (i === "WEEK")  return c === 1 ? "WEEKLY" : c === 2 ? "BIWEEKLY" : `${c} WEEKLY`;
  if (i === "MONTH") return c > 1 ? `${c} MONTHLY` : "MONTHLY";
  if (i === "YEAR")  return c > 1 ? `${c} YEARLY`  : "YEARLY";
  return "MONTHLY";
}

