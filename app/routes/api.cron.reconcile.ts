// app/routes/api.cron.reconcile.ts
//
// Hourly reconciliation of billing attempts Shopify has settled but whose
// webhook never arrived. See app/lib/billing-reconcile.server.ts for why this
// exists: a PENDING attempt hides its subscription from api.cron.billing.ts on
// every future run, and Shopify cannot be asked to re-deliver a lost event.
//
// Usage — same shape and secret as /api/cron/billing:
//   curl -s "https://<host>/api/cron/reconcile?secret=$CRON_SECRET" -o /dev/null
//   curl -s -X POST "https://<host>/api/cron/reconcile" \
//        -H "x-cron-secret: $CRON_SECRET" -o /dev/null
//
// SCHEDULE IT HOURLY, and place one run shortly before the daily billing run.
// api.cron.billing.ts does not call this itself, so the schedule is the only
// thing standing between a lost webhook and a day of missed billing.
//
// The same run drives prepaid subscriptions, which api.cron.billing.ts never
// charges (their payment hold keeps them out of it, see prepaid-hold.server.ts):
//   1. restores any missing payment hold, ahead of the next billing run
//   2. emails a "confirm and pay" link to each prepaid subscription entering
//      its lead window (issueDueRenewalInvoices)
//   3. catches payments whose orders/paid webhook was lost, sends the halfway
//      reminder, and pauses subscriptions whose link expired unpaid
//      (processOpenInvoices)
// Hourly is what makes links, reminders and pauses land on time.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { reconcilePendingAttempts } from "../lib/billing-reconcile.server";
import { ensurePrepaidHolds } from "../lib/prepaid-hold.server";
import { issueDueRenewalInvoices, processOpenInvoices } from "../lib/prepaid.server";

// Every step handles its own errors, and they run one after the other so a
// slow prepaid pass can't delay the billing-attempt reconciliation first.
async function runAll() {
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

// Duplicated from api.cron.billing.ts on purpose: both are standalone entry
// points, and a shared helper would put the secret check one import further from
// the route that depends on it.
function isAuthorized(request: Request): boolean {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) return false;

  const headerSecret = request.headers.get("x-cron-secret");
  if (headerSecret === expectedSecret) return true;

  const url = new URL(request.url);
  return url.searchParams.get("secret") === expectedSecret;
}

export async function loader({ request }: LoaderFunctionArgs) {
  console.log("[reconcile] GET /api/cron/reconcile");
  if (!isAuthorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  return json(await runAll());
}

export async function action({ request }: ActionFunctionArgs) {
  console.log("[reconcile] POST /api/cron/reconcile");
  if (!isAuthorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  return json(await runAll());
}
