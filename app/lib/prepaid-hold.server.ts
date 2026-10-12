// app/lib/prepaid-hold.server.ts
//
// Keeps prepaid subscriptions out of the automatic billing cron WITHOUT
// changing that cron (app/routes/api.cron.billing.ts stays self-contained).
//
// The billing cron charges every ACTIVE subscription that is due, except one
// that already has a PENDING BillingAttempt, since its guard reads that as "a
// charge is already in flight". A prepaid subscription is never charged
// automatically: each cycle is paid by an emailed link instead
// (app/lib/prepaid.server.ts). So every prepaid subscription always holds
// exactly one PENDING attempt, a "payment hold", standing for the cycle that
// is waiting to be paid by link. The cron then skips it by its own rules.
//
// The hold's lifecycle:
//   created   with the subscription (upsertContractLocally), or by the hourly
//             safety-net sweep if one is ever missing
//   amount    updated to the real total when the cycle's payment link is issued
//   settled   turned into the cycle's SUCCESS attempt when the link is paid,
//             and immediately replaced by a new hold for the next cycle
//
// Everything that treats PENDING attempts as Shopify billing attempts must
// leave holds alone: billing-reconcile.server.ts filters to POSTPAID, and the
// edit lock uses chargeInFlight() below.
//
// Deliberately depends on nothing but the database, so both
// subscription-sync.server.ts and prepaid.server.ts can import it without a
// circular import.

import db from "../db.server";

/**
 * Gives a prepaid subscription its hold if it has none. Returns whether one was
 * created. Safe to call for any subscription: anything that isn't prepaid, or
 * is cancelled, is left alone.
 */
export async function ensurePrepaidHold(subscriptionId: string): Promise<boolean> {
  const sub = await db.subscription.findUnique({
    where:  { id: subscriptionId },
    select: { id: true, paymentMode: true, status: true, price: true },
  });
  if (!sub || sub.paymentMode !== "PREPAID" || sub.status === "CANCELLED") return false;

  const existing = await db.billingAttempt.findFirst({
    where:  { subscriptionId: sub.id, status: "PENDING" },
    select: { id: true },
  });
  if (existing) return false;

  // sub.price is only an estimate (the first line's unit price); the amount is
  // corrected when the cycle's payment link is issued.
  await db.billingAttempt.create({
    data: { subscriptionId: sub.id, amount: sub.price, status: "PENDING" },
  });
  return true;
}

/**
 * The safety net: gives every live prepaid subscription that lacks a hold one.
 * Run hourly by the reconcile cron, ahead of the daily billing run, for every
 * shop; "Sync from Shopify" runs it for its own shop.
 */
export async function ensurePrepaidHolds(shop?: string): Promise<number> {
  try {
    const missing = await db.subscription.findMany({
      where: {
        ...(shop ? { shop } : {}),
        paymentMode:     "PREPAID",
        status:          { in: ["ACTIVE", "PAUSED"] },
        billingAttempts: { none: { status: "PENDING" } },
      },
      select: { id: true },
      take:   500,
    });

    let created = 0;
    for (const { id } of missing) {
      if (await ensurePrepaidHold(id)) created += 1;
    }
    if (created) console.log(`[prepaid] created ${created} missing payment hold(s)`);
    return created;
  } catch (err) {
    console.error("[prepaid] payment hold sweep failed:", err);
    return 0;
  }
}

/** The hold's id, if the subscription has one. */
export async function findPrepaidHold(subscriptionId: string): Promise<string | null> {
  const hold = await db.billingAttempt.findFirst({
    where:   { subscriptionId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    select:  { id: true },
  });
  return hold?.id ?? null;
}

/**
 * Why a subscription can't be edited right now, or null if it can.
 *
 * Postpaid: a PENDING attempt is a real charge in flight. The cron moves the
 * billing date before creating it, so an edit could bill a cycle twice.
 * Prepaid: the hold is always there and means nothing for editing. An OPEN
 * payment link does, since it was priced from the contract as it stood.
 */
export async function chargeInFlight(subscriptionId: string): Promise<string | null> {
  const sub = await db.subscription.findUnique({
    where:  { id: subscriptionId },
    select: { paymentMode: true },
  });
  if (!sub) return null;

  if (sub.paymentMode === "PREPAID") {
    const open = await db.prepaidInvoice.count({
      where: { subscriptionId, status: { in: ["CREATING", "SENT"] } },
    });
    return open > 0
      ? "A payment link is open for this subscription. Edit it after it's paid or expires."
      : null;
  }

  const pending = await db.billingAttempt.count({
    where: { subscriptionId, status: "PENDING" },
  });
  return pending > 0
    ? "A billing attempt is in progress for this subscription. Try again once it settles."
    : null;
}
