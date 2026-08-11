// app/routes/widget-settings.tsx
//
// Top-level twin of /apps/subscriptions/widget-settings.
//
// Shopify's app proxy replaces `/apps/subscriptions` with the configured proxy
// URL and appends whatever follows. So the storefront's single request to
// `https://{shop}/apps/subscriptions/widget-settings` arrives here as:
//
//   proxy URL `<app>/apps/subscriptions`  →  /apps/subscriptions/widget-settings
//   proxy URL `<app>`                     →  /widget-settings          ← this file
//
// Both shapes occur in practice: `shopify app dev` rewrites the proxy URL
// wholesale and a known CLI bug drops the subpath (Shopify/cli#2905), which is
// invisible locally because the toml on disk is not rewritten. Serving both
// paths removes the dependency on which shape is currently deployed.
//
// Logic lives in widget-settings.server.ts so all three endpoints stay
// identical.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getStoredWidgetSettings } from "../lib/widget-settings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url  = new URL(request.url);
  // The app proxy appends `shop`; the Liquid-supplied param covers direct calls.
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return json({ error: "Missing shop" }, { status: 400 });
  }

  // Nulls for anything unset, so the widget overrides only explicit choices and
  // leaves a theme's own accent colour alone.
  return json(await getStoredWidgetSettings(shop), {
    headers: { "Cache-Control": "public, max-age=30" },
  });
}
