// app/lib/reconcile.server.ts
//
// The recurring upkeep job, in one place so it can be run two ways: by the
// app's own scheduler (scheduler.server.ts) and by an external cron calling
// /api/cron/reconcile.
//
//   1. settles billing attempts Shopify finished but whose webhook never
//      arrived (billing-reconcile.server.ts)
//   2. restores any missing prepaid payment hold, ahead of the billing run
//   3. emails a "confirm and pay" link to each prepaid subscription entering
//      its lead time (issueDueRenewalInvoices)
//   4. catches payments whose orders/paid webhook was lost, sends the halfway
//      reminder, and pauses subscriptions whose link expired unpaid
//      (processOpenInvoices)
//
// Safe to run twice at once: each step claims what it works on.

import { reconcilePendingAttempts } from "./billing-reconcile.server";
import { ensurePrepaidHolds } from "./prepaid-hold.server";
import { issueDueRenewalInvoices, processOpenInvoices } from "./prepaid.server";

// Every step handles its own errors, and they run one after the other so a
// slow prepaid pass can't delay the billing-attempt reconciliation first.
export async function runReconcile() {
  const attempts = await reconcilePendingAttempts();
  const holds    = await ensurePrepaidHolds();
  const invoices = await issueRenewals();
  const upkeep   = await processOpenInvoices();
  return { ...attempts, prepaid: { holdsCreated: holds, invoices, upkeep } };
}

async function issueRenewals() {
  try {
    return await issueDueRenewalInvoices();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reconcile] prepaid invoicing failed: ${message}`);
    return { error: message };
  }
}
