// app/lib/bundle-endpoint.server.ts
//
// Shared loader for the storefront bundle endpoints (app/routes/bundles.tsx and
// app/routes/apps.subscriptions.bundles.tsx), so both proxy path shapes return
// the same thing. See app/routes/widget-settings.tsx for why two shapes exist.
//
// Unauthenticated by design, like widget-settings: it returns only what the
// product page shows anyway (bundle names, product handles, discounts), and
// it must work for every anonymous storefront visitor.

import { json } from "@remix-run/node";
import { getStorefrontBundles } from "./bundles.server";

export async function bundlesLoader(request: Request) {
  const url = new URL(request.url);

  // `shop` is appended by the app proxy; the block's own param covers direct calls.
  const shop      = url.searchParams.get("shop");
  // Numeric product id from Liquid's product.id.
  const productId = url.searchParams.get("productId");

  if (!shop || !productId || !/^\d+$|^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
    return json({ error: "Missing shop or productId" }, { status: 400 });
  }

  const gid = productId.startsWith("gid://") ? productId : `gid://shopify/Product/${productId}`;

  // An empty list rather than 404 when there's no bundle: that's the normal
  // case on most product pages and must not look like an error.
  const bundles = await getStorefrontBundles(shop, gid);

  return json(
    { bundles },
    // Short, like widget-settings: a merchant who saves a bundle reloads the
    // product page straight away to check it.
    { headers: { "Cache-Control": "public, max-age=30" } },
  );
}
