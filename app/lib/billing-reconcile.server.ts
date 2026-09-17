// app/lib/billing-reconcile.server.ts
//
// Settles billing attempts by ASKING Shopify, instead of waiting to be told.
//
// subscription_billing_attempts/success and /failure are the normal path and
// stay the fast one. But a webhook can be lost — the tunnel is down, the server
// is restarting, Shopify gives up after its ~48h retry window — and a
// BillingAttempt stuck on PENDING is not cosmetic: api.cron.billing.ts selects
// subscriptions with `billingAttempts: { none: { status: "PENDING" } }`, so from
// that moment the subscription is skipped on EVERY future run. One lost delivery
// stops its billing permanently.
//
// Shopify cannot be asked to re-deliver an event, but the outcome can always be
// read back. That is what this does, hourly.
//
// ─── The invariant this depends on ──────────────────────────────────────────
// Nothing stores Shopify's SubscriptionBillingAttempt id locally, so a local row
// is paired to a remote attempt BY CREATION TIME. That is only unambiguous
// because of the same `none: { status: "PENDING" }` guard above: a subscription
// has at most ONE unsettled attempt at a time.
//
// If that guard is ever removed, this matching stops being safe — two attempts
// in flight could be paired the wrong way round, and since commission is keyed
// to billingAttemptId, the charge would follow the wrong cycle. The fix at that
// point is to store the attempt GID on BillingAttempt at creation, not to widen
// the time window.
//
// Idempotent with the webhook handlers: both settle the same row, and
// chargeCommission/voidCommission key off billingAttemptId, so the two racing
// produces one outcome, not two.

import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { chargeCommission, voidCommission } from "./app-commission.server";

// Shopify processes a billing attempt asynchronously — `ready: false` right
// after creation is normal. Only chase attempts old enough that silence means
// something went wrong rather than that Shopify is still working.
const SETTLE_GRACE_MS = 15 * 60 * 1000;

// How far from the local row's createdAt a remote attempt may sit and still be
// considered the same charge. The local row is written seconds after
// subscriptionBillingAttemptCreate returns; an hour is generous cover for clock
// skew and a slow run, and far tighter than the daily cadence of billing.
const MATCH_WINDOW_MS = 60 * 60 * 1000;

// A cap on how much one run will do, so a backlog cannot become a request that
// never returns. The next run picks up where this one stopped.
const MAX_PER_RUN = 100;

const CONTRACT_ATTEMPTS_QUERY = `#graphql
  query ReconcileContractAttempts($id: ID!) {
    subscriptionContract(id: $id) {
      billingAttempts(first: 25, reverse: true) {
        edges {
          node {
            id
            createdAt
            ready
            errorCode
            errorMessage
            order { id }
          }
        }
      }
    }
  }
`;

type RemoteAttempt = {
  id:           string;
  createdAt:    string;
  ready:        boolean;
  errorCode:    string | null;
  errorMessage: string | null;
  order:        { id: string } | null;
};

type AttemptResult = {
  attemptId: string;
  outcome:   "SUCCESS" | "FAILED" | "still-processing" | "no-match" | "error";
  detail?:   string;
};

function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message || "Unknown Error";
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return "Unknown Error"; }
}

/**
 * The remote attempt that corresponds to a local row, or null.
 *
 * Closest in time wins, within MATCH_WINDOW_MS. Returning null rather than a
 * best guess is deliberate: leaving a row PENDING for another hour costs one
 * cycle, while settling the wrong row misreports a charge and misattributes its
 * commission.
 */
function matchAttempt(remote: RemoteAttempt[], localCreatedAt: Date): RemoteAttempt | null {
  let best: RemoteAttempt | null = null;
  let bestDistance = Infinity;

  for (const node of remote) {
    const distance = Math.abs(new Date(node.createdAt).getTime() - localCreatedAt.getTime());
    if (distance <= MATCH_WINDOW_MS && distance < bestDistance) {
      best         = node;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * Settles every PENDING billing attempt Shopify has already decided.
 *
 * Safe to call as often as you like: an attempt Shopify is still processing is
 * left alone, and a settled attempt is no longer PENDING so it is never looked
 * at again.
 *
 * Never throws — it runs from a cron endpoint and must not be able to take it
 * down.
 */
export async function reconcilePendingAttempts(): Promise<{
  ok: boolean; checked: number; settled: number; results: AttemptResult[];
}> {
  const results: AttemptResult[] = [];
  let settled = 0;

  let pending: Array<{
    id: string; createdAt: Date;
    subscription: { id: string; shop: string; price: number; shopifyContractId: string };
  }> = [];

  try {
    pending = await db.billingAttempt.findMany({
      where: {
        status:    "PENDING",
        createdAt: { lt: new Date(Date.now() - SETTLE_GRACE_MS) },
      },
      // Oldest first: the most stuck are the ones actually blocking billing.
      orderBy: { createdAt: "asc" },
      take:    MAX_PER_RUN,
      select: {
        id:        true,
        createdAt: true,
        subscription: {
          select: { id: true, shop: true, price: true, shopifyContractId: true },
        },
      },
    });
  } catch (err) {
    console.error("[reconcile] could not load pending attempts:", serializeError(err));
    return { ok: false, checked: 0, settled: 0, results };
  }

  if (!pending.length) return { ok: true, checked: 0, settled: 0, results };

  // One admin client per shop rather than per attempt — a shop with a backlog
  // would otherwise re-authenticate for every row.
  const adminCache = new Map<string, Awaited<ReturnType<typeof unauthenticated.admin>>["admin"] | null>();

  async function adminFor(shop: string) {
    if (!adminCache.has(shop)) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        adminCache.set(shop, admin);
      } catch (err) {
        // Most often the app was uninstalled. Cache the failure so the rest of
        // that shop's attempts do not each retry it.
        console.error(`[reconcile] no admin client for ${shop}:`, serializeError(err));
        adminCache.set(shop, null);
      }
    }
    return adminCache.get(shop) ?? null;
  }

  for (const attempt of pending) {
    const sub = attempt.subscription;

    try {
      const admin = await adminFor(sub.shop);
      if (!admin) {
        results.push({ attemptId: attempt.id, outcome: "error", detail: "no admin client" });
        continue;
      }

      const res  = await admin.graphql(CONTRACT_ATTEMPTS_QUERY, {
        variables: { id: sub.shopifyContractId },
      });
      const json = await res.json() as {
        data?: {
          subscriptionContract?: {
            billingAttempts?: { edges?: Array<{ node: RemoteAttempt }> };
          } | null;
        };
      };

      const remote = (json?.data?.subscriptionContract?.billingAttempts?.edges ?? [])
        .map((e) => e.node)
        .filter(Boolean);

      const match = matchAttempt(remote, attempt.createdAt);

      if (!match) {
        console.warn(
          `[reconcile] no Shopify attempt near ${attempt.createdAt.toISOString()} for ${sub.shopifyContractId} — leaving PENDING`
        );
        results.push({ attemptId: attempt.id, outcome: "no-match" });
        continue;
      }

      // ── Succeeded ────────────────────────────────────────────
      // An order is the proof of a completed charge, same as the webhook's.
      if (match.order?.id) {
        await db.billingAttempt.update({
          where: { id: attempt.id },
          data:  { status: "SUCCESS" },
        });

        // Idempotent on billingAttemptId, so a webhook arriving late cannot
        // charge a second time.
        await chargeCommission({
          shop:             sub.shop,
          admin,
          subscription:     sub,
          billingAttemptId: attempt.id,
          contractGid:      sub.shopifyContractId,
          orderGid:         match.order.id,
        });

        settled += 1;
        results.push({ attemptId: attempt.id, outcome: "SUCCESS", detail: match.order.id });
        console.log(`[reconcile] ✅ ${attempt.id} → SUCCESS (order ${match.order.id})`);
        continue;
      }

      // ── Failed ───────────────────────────────────────────────
      if (match.errorCode || match.errorMessage) {
        // Keep both when Shopify sends both: the message is what the merchant
        // reads, the code is what support needs.
        const parts  = [match.errorMessage, match.errorCode ? `(${match.errorCode})` : null].filter(Boolean);
        const errMsg = parts.join(" ").slice(0, 190) || "Payment failed";

        await db.billingAttempt.update({
          where: { id: attempt.id },
          data:  { status: "FAILED", errorMessage: errMsg },
        });

        // Release the commission the cron reserved — nothing was billed.
        await voidCommission(attempt.id);

        settled += 1;
        results.push({ attemptId: attempt.id, outcome: "FAILED", detail: errMsg });
        console.log(`[reconcile] ❌ ${attempt.id} → FAILED (${errMsg})`);
        continue;
      }

      // ── Still working ────────────────────────────────────────
      // No order and no error: Shopify has not decided yet. Leave it.
      results.push({ attemptId: attempt.id, outcome: "still-processing" });

    } catch (err) {
      // One bad attempt must not stop the rest of the run.
      const detail = serializeError(err);
      console.error(`[reconcile] error on attempt ${attempt.id}:`, detail);
      results.push({ attemptId: attempt.id, outcome: "error", detail });
    }
  }

  console.log(`[reconcile] checked ${pending.length}, settled ${settled}`);
  return { ok: true, checked: pending.length, settled, results };
}
