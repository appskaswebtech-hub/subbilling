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

// ─── Next billing date arithmetic ────────────────────────────
// Moved here from api.cron.billing.ts: the cron, the create webhook and the
// backfill all need it, and a route importing another route to get it was the
// wrong dependency direction.
export function advanceBillingDate(from: Date, frequency: string): Date {
  const d = new Date(from);
  const f = frequency.toUpperCase().trim();

  // Handle combined format like "2 WEEKLY", "3 DAILY"
  const match     = f.match(/^(\d+)\s+(.+)$/);
  const count     = match ? parseInt(match[1], 10) : 1;
  const unit      = match ? match[2] : f;
  const safeCount = Number.isFinite(count) && count > 0 ? count : 1;

  // Exact matches first (normalised values from normaliseFrequency)
  if (unit === "DAILY"   || unit === "DAY")   { d.setDate(d.getDate() + safeCount);         return d; }
  if (unit === "BIWEEKLY")                    { d.setDate(d.getDate() + 14);                return d; }
  if (unit === "WEEKLY"  || unit === "WEEK")  { d.setDate(d.getDate() + safeCount * 7);     return d; }
  if (unit === "MONTHLY" || unit === "MONTH") {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + safeCount);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return d;
  }
  if (unit === "YEARLY"  || unit === "YEAR")  { d.setFullYear(d.getFullYear() + safeCount); return d; }

  // Fallback — includes() check as last resort
  if (unit.includes("DAY"))   { d.setDate(d.getDate() + safeCount);         return d; }
  if (unit.includes("WEEK"))  { d.setDate(d.getDate() + safeCount * 7);     return d; }
  if (unit.includes("YEAR"))  { d.setFullYear(d.getFullYear() + safeCount); return d; }
  if (unit.includes("MONTH")) { d.setMonth(d.getMonth() + safeCount);       return d; }

  console.warn(`[sync] advanceBillingDate: unrecognised frequency "${frequency}" — defaulting to +1 month`);
  d.setMonth(d.getMonth() + 1);
  return d;
}

// ─── Create-or-update ────────────────────────────────────────
// applyContractToLocal only UPDATES — it cannot create, which is why contracts
// that predate the webhook never appear locally. This is the create-or-update
// counterpart, shared by the create webhook and the backfill so the two cannot
// drift on field mapping.
export interface UpsertResult {
  created: boolean;
  id:      string;
}

export async function upsertContractLocally(
  shop:     string,
  contract: ShopifyContract,
): Promise<UpsertResult> {
  const contractGid = toContractGid(contract.id);
  const first       = contractLines(contract)[0] ?? null;

  const status    = normaliseStatus(contract.status ?? "ACTIVE");
  const frequency = normaliseFrequency(
    contract.billingPolicy?.interval,
    contract.billingPolicy?.intervalCount,
  );

  // nextBillingDate is non-null in the schema, but Shopify omits it on cancelled
  // and expired contracts — project one forward rather than dropping the row.
  const parsed          = contract.nextBillingDate ? new Date(contract.nextBillingDate) : null;
  const nextBillingDate = (parsed && !isNaN(parsed.getTime()))
    ? parsed
    : advanceBillingDate(new Date(), frequency);

  const data = {
    customerEmail: contract.customer?.email ?? "",
    productTitle:  first?.title             ?? "Unknown Product",
    planName:      first?.sellingPlanName   ?? "Subscription",
    price:         first?.currentPrice?.amount ? parseFloat(first.currentPrice.amount) : 0,
    status,
    frequency,
    nextBillingDate,
  };

  const existing = await prisma.subscription.findUnique({
    where:  { shopifyContractId: contractGid },
    select: { id: true },
  });

  const row = await prisma.subscription.upsert({
    where:  { shopifyContractId: contractGid },
    update: data,
    create: {
      shop,
      shopifyContractId: contractGid,
      // customerId is required and has no default; an empty string is preferable
      // to skipping the contract entirely when Shopify withholds the customer.
      customerId: contract.customer?.id ?? "",
      ...data,
    },
  });

  return { created: !existing, id: row.id };
}
