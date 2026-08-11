// app/routes/api.widget-settings.ts
// Public endpoint — returns widget settings for a shop.
//
// The theme extension calls the app-proxy twin of this route
// (/apps/subscriptions/widget-settings) instead, because that is same-origin
// from the storefront and needs no hardcoded app URL. This direct route is kept
// for anything calling the app host directly.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getWidgetSettings } from "../lib/widget-settings.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // Short on purpose. These settings are edited in the admin and the merchant
  // expects to see the result immediately; a long cache reads as "my change
  // didn't save".
  "Cache-Control":                "public, max-age=30",
};

export async function loader({ request }: LoaderFunctionArgs) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url  = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return json({ error: "Missing ?shop= parameter" }, { status: 400, headers: CORS_HEADERS });
  }

  return json(await getWidgetSettings(shop), { headers: CORS_HEADERS });
}
