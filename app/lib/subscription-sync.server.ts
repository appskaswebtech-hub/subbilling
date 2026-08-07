// app/lib/subscription-sync.server.ts
//
// The single place that translates a Shopify SubscriptionContract into the
// local Subscription row.
//
// Two things write that row — the subscription_contracts webhooks and the
// admin edit action. When they normalise independently they drift, and the
// drift shows up as the UI and Shopify disagreeing. So both call
// applyContractToLocal() and neither writes normalisation logic of its own.

import prisma from "../db.server";

// ─── GID helper ──────────────────────────────────────────────
// Shopify mutations require the full GID. Accepts a bare numeric id, a
// "Type/id" fragment, or a GID that is already complete.
export function toContractGid(raw: string | number): string {
  const id = String(raw);
  if (id.startsWith("gid://")) return id;
  if (id.includes("/"))        return `gid://shopify/${id}`;
  return `gid://shopify/SubscriptionContract/${id}`;
}

// ─── Status ──────────────────────────────────────────────────
export function normaliseStatus(raw: string): string {
  const map: Record<string, string> = {
    ACTIVE:    "ACTIVE",
    PAUSED:    "PAUSED",
    CANCELLED: "CANCELLED",
    EXPIRED:   "CANCELLED",
    FAILED:    "CANCELLED",
  };
  return map[raw?.toUpperCase()] ?? "PENDING";
}

// ─── Frequency ───────────────────────────────────────────────
// Stores a consistent string that advanceBillingDate() can handle.
// DAY/1   → "DAILY"
// WEEK/1  → "WEEKLY"
// WEEK/2  → "BIWEEKLY"
// WEEK/3+ → "3 WEEKLY"
// MONTH/1 → "MONTHLY"
// MONTH/2 → "2 MONTHLY"
// YEAR/1  → "YEARLY"
// YEAR/2  → "2 YEARLY"
export function normaliseFrequency(interval?: string, count?: number): string {
  if (!interval) return "MONTHLY";
  const i = interval.toUpperCase();
  const c = count ?? 1;

  if (i === "DAY")   return c > 1 ? `${c} DAILY`   : "DAILY";
  if (i === "WEEK")  return c === 1 ? "WEEKLY" : c === 2 ? "BIWEEKLY" : `${c} WEEKLY`;
  if (i === "MONTH") return c > 1 ? `${c} MONTHLY` : "MONTHLY";
  if (i === "YEAR")  return c > 1 ? `${c} YEARLY`  : "YEARLY";
  return "MONTHLY";
}

// ─── Contract query ──────────────────────────────────────────
export const SUBSCRIPTION_CONTRACT_QUERY = `
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
      lines(first: 20) {
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

// ─── Types ───────────────────────────────────────────────────
export interface ContractLine {
  id:                   string;
  title?:               string;
  variantTitle?:        string | null;
  quantity?:            number;
  variantId?:           string | null;
  sellingPlanId?:       string | null;
  sellingPlanName?:     string | null;
  currentPrice?:        { amount: string; currencyCode: string } | null;
  lineDiscountedPrice?: { amount: string; currencyCode: string } | null;
}

export interface ShopifyContract {
  id:               string;
  status?:          string;
  nextBillingDate?: string | null;
  currencyCode?:    string;
  customer?:        { id?: string; email?: string } | null;
  billingPolicy?:   { interval?: string; intervalCount?: number } | null;
  deliveryPolicy?:  { interval?: string; intervalCount?: number } | null;
  lines?:           { edges?: Array<{ node: ContractLine }> } | null;
}

export function contractLines(contract: ShopifyContract | null | undefined): ContractLine[] {
  return contract?.lines?.edges?.map((e) => e.node) ?? [];
}

// ─── Revision guard ──────────────────────────────────────────
// Two admins editing at once each build a draft from the same base, and the
// second commit silently clobbers the first. The page hashes the state it
// rendered; the edit action refuses if the contract moved underneath it.
export function contractRevision(contract: ShopifyContract | null): string {
  if (!contract) return "none";
  return [
    contract.nextBillingDate ?? "",
    `${contract.billingPolicy?.interval ?? ""}:${contract.billingPolicy?.intervalCount ?? ""}`,
    `${contract.deliveryPolicy?.interval ?? ""}:${contract.deliveryPolicy?.intervalCount ?? ""}`,
    ...contractLines(contract).map(
      (l) => `${l.id}:${l.quantity ?? ""}:${l.currentPrice?.amount ?? ""}`,
    ),
  ].join("|");
}

// ─── Local mirror ────────────────────────────────────────────
// Writes only what Shopify returned. Fields Shopify did not supply are left
// as `undefined` so Prisma skips them rather than nulling a good value.
//
// `price` is the PER-UNIT amount, matching what the webhook has always
// written. Storing a line total here would be silently reverted by the next
// subscription_contracts/update webhook.
export async function applyContractToLocal(
  contractGid: string,
  contract:    ShopifyContract,
): Promise<number> {
  const first      = contractLines(contract)[0] ?? null;
  const rawNext    = contract.nextBillingDate;
  const parsedNext = rawNext ? new Date(rawNext) : null;

  const result = await prisma.subscription.updateMany({
    // shopifyContractId is @unique, so this targets exactly one row.
    where: { shopifyContractId: contractGid },
    data: {
      status:          contract.status ? normaliseStatus(contract.status) : undefined,
      nextBillingDate: (parsedNext && !isNaN(parsedNext.getTime())) ? parsedNext : undefined,
      customerEmail:   contract.customer?.email   ?? undefined,
      productTitle:    first?.title               ?? undefined,
      planName:        first?.sellingPlanName     ?? undefined,
      price:           first?.currentPrice?.amount ? parseFloat(first.currentPrice.amount) : undefined,
      frequency:       contract.billingPolicy?.interval
        ? normaliseFrequency(contract.billingPolicy.interval, contract.billingPolicy.intervalCount)
        : undefined,
    },
  });

  return result.count;
}
