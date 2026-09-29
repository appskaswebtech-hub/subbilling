// app/lib/commission-sync.server.ts
//
// Brings the local commission ledger (CommissionCharge) in line with what
// Shopify has actually billed the merchant, as part of "Sync from Shopify".
//
// READ-ONLY TOWARD SHOPIFY. This never calls appUsageRecordCreate and never
// charges anything. It reads the usage records Shopify holds and corrects the
// ledger to match. Commission that was never sent to Shopify stays uncharged and
// shows up as a mismatch — catching it up would take money from the merchant,
// and that is a decision, not a sync.
//
// ─── The join key ───────────────────────────────────────────────────────────
// chargeCommission sends `idempotencyKey: billingAttemptId` on every usage
// record, and CommissionCharge.billingAttemptId is unique. So each Shopify record
// maps to exactly one ledger row, with no matching on amount or date.
//
// ─── Scope ──────────────────────────────────────────────────────────────────
// `activeSubscriptions` returns only the merchant's CURRENT app subscription.
// Records billed under an earlier one (before a plan change or re-approval) are
// not visible here, so the mirror covers the current subscription only.

import db from "../db.server";
import type { AdminGraphQL } from "./subscription-contract.server";

const USAGE_RECORDS_QUERY = `#graphql
  query CommissionUsageRecords($after: String) {
    currentAppInstallation {
      activeSubscriptions {
        lineItems {
          id
          usageRecords(first: 100, after: $after, reverse: true) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                createdAt
                idempotencyKey
                price { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

// Same ceiling as backfillContracts: a large shop must not spin indefinitely
// inside one request. Newest first, so what is dropped is the oldest history.
const MAX_RECORDS = 1000;

interface UsageRecord {
  id:             string;
  createdAt:      string;
  idempotencyKey: string | null;
  price:          { amount: string; currencyCode: string };
}

interface RecordsEnvelope {
  errors?: Array<{ message: string }>;
  data?: {
    currentAppInstallation?: {
      activeSubscriptions?: Array<{
        lineItems?: Array<{
          id: string;
          usageRecords?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            edges?: Array<{ node: UsageRecord }>;
          };
        }>;
      }>;
    } | null;
  };
}

export interface CommissionSyncSummary {
  /** Ledger rows that already agreed with Shopify. */
  matched: number;
  /** Ledger rows corrected to Shopify's figures. */
  updated: number;
  /** Rows created for records Shopify billed but the ledger lacked. */
  added: number;
  /** CHARGED rows in this app that Shopify did not return. Reported, never deleted. */
  missingAtShopify: number;
  /** Why nothing was synced, when that is the case. */
  skipped: string | null;
  /** True when the record cap stopped the walk before Shopify ran out. */
  truncated: boolean;
  /** Set when the sync could not run; the caller reports it. */
  error: string | null;
}

/**
 * Walks the shop's usage records newest first and reconciles the ledger.
 *
 * Never throws. It runs inside the contract sync, and a commission problem must
 * never cost the merchant their contract sync — it is reported beside it.
 */
export async function syncCommissionFromShopify(
  graphql: AdminGraphQL,
  shop:    string,
): Promise<CommissionSyncSummary> {
  const summary: CommissionSyncSummary = {
    matched: 0, updated: 0, added: 0, missingAtShopify: 0,
    skipped: null, truncated: false, error: null,
  };

  try {
    const shopPlan = await db.shopPlan.findUnique({ where: { shop } });

    // A flat-fee plan has no usage line, so there is nothing to mirror.
    if (!shopPlan?.usageLineItemId) {
      summary.skipped = "no-usage-line";
      return summary;
    }

    // ── Fetch ────────────────────────────────────────────────────
    const records: UsageRecord[] = [];
    let after: string | null = null;

    for (;;) {
      const res      = await graphql(USAGE_RECORDS_QUERY, { variables: { after } });
      const envelope = await res.json() as RecordsEnvelope;

      if (envelope?.errors?.length) {
        throw new Error(envelope.errors.map((e) => e.message).join(" | "));
      }

      // The usage line is identified by the id stored at approval. The flat-fee
      // line on the same subscription has no records and is ignored.
      const line = (envelope?.data?.currentAppInstallation?.activeSubscriptions ?? [])
        .flatMap((s) => s.lineItems ?? [])
        .find((l) => l.id === shopPlan.usageLineItemId);

      if (!line) {
        // The stored line id is not on the active subscription — the merchant
        // changed or re-approved their plan. Nothing here can be matched safely.
        summary.skipped = "usage-line-not-active";
        return summary;
      }

      for (const edge of line.usageRecords?.edges ?? []) {
        records.push(edge.node);
        if (records.length >= MAX_RECORDS) break;
      }

      const pageInfo = line.usageRecords?.pageInfo;
      if (records.length >= MAX_RECORDS) {
        summary.truncated = Boolean(pageInfo?.hasNextPage);
        break;
      }
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      after = pageInfo.endCursor;
    }

    // ── Reconcile ────────────────────────────────────────────────
    const seenRecordIds = new Set<string>();

    for (const record of records) {
      seenRecordIds.add(record.id);

      // Not created by this app's billing path. Its owner is unknowable, so it
      // is left alone rather than attached to a guessed attempt.
      const key = record.idempotencyKey;
      if (!key) continue;

      const amount   = parseFloat(record.price.amount);
      const currency = record.price.currencyCode;

      const existing = await db.commissionCharge.findUnique({
        where: { billingAttemptId: key },
      });

      if (existing) {
        // A key belonging to another shop means something is badly wrong; do
        // not touch that row.
        if (existing.shop !== shop) continue;

        const agrees =
          existing.status === "CHARGED" &&
          existing.usageRecordId === record.id &&
          Math.abs(existing.amount - amount) < 0.005 &&
          existing.currency === currency;

        if (agrees) {
          summary.matched += 1;
          continue;
        }

        // Shopify is the truth: it billed this, so the row is CHARGED at
        // Shopify's figure. Settles PENDING estimates, and FAILED rows whose
        // charge actually went through.
        await db.commissionCharge.update({
          where: { billingAttemptId: key },
          data:  {
            status:        "CHARGED",
            amount,
            currency,
            usageRecordId: record.id,
            reason:        null,
          },
        });
        summary.updated += 1;
        continue;
      }

      // Billed at Shopify, missing locally — the ledger write was lost. Fill in
      // what the local attempt can still tell us.
      const attempt = await db.billingAttempt.findUnique({
        where:  { id: key },
        select: { amount: true, subscription: { select: { shopifyContractId: true } } },
      });

      await db.commissionCharge.create({
        data: {
          shop,
          billingAttemptId: key,
          contractId:       attempt?.subscription?.shopifyContractId ?? "",
          baseAmount:       attempt?.amount ?? 0,
          rate:             attempt?.amount ? amount / attempt.amount : 0,
          amount,
          currency,
          status:           "CHARGED",
          reason:           "synced-from-shopify",
          usageRecordId:    record.id,
          // Shopify's date, not today's: the row must land in the month the
          // merchant was actually billed, or "Commission this month" moves
          // money between months.
          createdAt:        new Date(record.createdAt),
        },
      });
      summary.added += 1;
    }

    // ── Drift ────────────────────────────────────────────────────
    // Only inside the window the fetch actually covered. A ledger row older than
    // the oldest record returned may simply be past the cap or from an earlier
    // app subscription — flagging it would be a false alarm.
    if (records.length) {
      const oldest = records.reduce(
        (min, r) => (r.createdAt < min ? r.createdAt : min),
        records[0].createdAt,
      );

      const localCharged = await db.commissionCharge.findMany({
        where:  { shop, status: "CHARGED", createdAt: { gte: new Date(oldest) } },
        select: { usageRecordId: true },
      });

      summary.missingAtShopify = localCharged.filter(
        (r) => !r.usageRecordId || !seenRecordIds.has(r.usageRecordId),
      ).length;
    }

    return summary;
  } catch (err) {
    console.error(`[commission-sync] ${shop}:`, err);
    summary.error = err instanceof Error ? err.message : "unknown error";
    return summary;
  }
}
