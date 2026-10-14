// app/routes/api.cron.reconcile.ts
//
// Runs the upkeep job (app/lib/reconcile.server.ts) on request: billing
// attempts Shopify settled but whose webhook never arrived, and everything
// prepaid subscriptions need (payment holds, "confirm and pay" links,
// reminders, pausing unpaid ones).
//
// The app runs the same job itself every 15 minutes (scheduler.server.ts), so
// nothing has to call this. It stays for an external cron where that scheduler
// is switched off, and for running the job by hand:
//   curl -s "https://<host>/api/cron/reconcile?secret=$CRON_SECRET" -o /dev/null
//   curl -s -X POST "https://<host>/api/cron/reconcile" \
//        -H "x-cron-secret: $CRON_SECRET" -o /dev/null
//
// api.cron.billing.ts does not call this itself: a PENDING attempt hides its
// subscription from that run, so this has to have run shortly before it.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { runReconcile } from "../lib/reconcile.server";

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
  return json(await runReconcile());
}

export async function action({ request }: ActionFunctionArgs) {
  console.log("[reconcile] POST /api/cron/reconcile");
  if (!isAuthorized(request)) return json({ error: "Unauthorized" }, { status: 401 });
  return json(await runReconcile());
}
