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

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { reconcilePendingAttempts } from "../lib/billing-reconcile.server";

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
  return json(await reconcilePendingAttempts());
}

export async function action({ request }: ActionFunctionArgs) {
  console.log("[reconcile] POST /api/cron/reconcile");
  if (!isAuthorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  return json(await reconcilePendingAttempts());
}
