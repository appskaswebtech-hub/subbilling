// app/routes/apps.subscriptions.widget-settings.jsx
//
// Widget settings for the theme app extension, served through Shopify's app
// proxy at https://{shop}/apps/subscriptions/widget-settings.
//
// Why the proxy rather than calling the app host directly:
//   • Same-origin from the storefront, so no CORS and no preflight.
//   • The theme never needs to know the app's URL, which changes with every
//     `shopify app dev` tunnel — the mistake that broke the customer-account
//     extension twice.
//   • Storefront visitors are already past any password page, and the request
//     carries their cookies automatically, so the password-page redirect that
//     makes the proxy unusable from customer-account extensions does not apply
//     here.
//
// Unauthenticated by design: it exposes nothing but this shop's own widget
// colours, and it must work for every anonymous storefront visitor.

import { json } from "@remix-run/node";
import { getStoredWidgetSettings } from "../lib/widget-settings.server";

export async function loader({ request }) {
  const url = new URL(request.url);

  // Shopify's app proxy appends `shop` to every forwarded request; the explicit
  // param from the Liquid template is a fallback for direct calls.
  const shop = url.searchParams.get("shop");
  if (!shop) {
    return json({ error: "Missing shop" }, { status: 400 });
  }

  // Returns nulls for anything the merchant has not set, so the widget
  // overrides only their explicit choices and leaves the theme's own accent
  // colour alone on shops that never opened the settings page.
  return json(await getStoredWidgetSettings(shop), {
    headers: {
      // Short: the merchant saves in the admin and immediately reloads the
      // product page to check. A long cache is indistinguishable from the
      // setting not applying at all.
      "Cache-Control": "public, max-age=30",
    },
  });
}
