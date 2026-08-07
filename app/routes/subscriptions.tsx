// app/routes/subscriptions.tsx
//
// Shopify Admin deep link target.
//
// On an order detail page, a subscription line item renders its selling plan
// name as a link to:
//   admin.shopify.com/store/<store>/apps/<handle>/subscriptions?id=…&customer_id=…
// which the admin loads as <application_url>/subscriptions in the embedded
// iframe. The app's own pages live under /app/*, so without this route the
// merchant gets a bare Remix 404.
//
// The whole query string is forwarded on every redirect, not just the parts we
// read: Shopify appends shop/host/embedded/session-token to the iframe URL and
// the /app layout needs them to boot the embedded session.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const url         = new URL(request.url);
  const qs          = url.searchParams.toString();
  const rawId       = url.searchParams.get("id");
  const rawCustomer = url.searchParams.get("customer_id");

  // Shopify's `id` is not documented for this surface — it may be a contract,
  // a selling plan, or a line. Logged once so the shape can be confirmed from
  // production rather than assumed.
  console.log(`[deep-link] /subscriptions id=${rawId} customer_id=${rawCustomer} shop=${session.shop}`);

  // 1. Treat `id` as a subscription contract. shopifyContractId is @unique and
  //    holds a full GID, but accept a bare numeric too.
  if (rawId) {
    const numeric    = rawId.split("/").pop() ?? "";
    const candidates = [rawId, `gid://shopify/SubscriptionContract/${numeric}`];

    const hit = await prisma.subscription.findFirst({
      where:  { shop: session.shop, shopifyContractId: { in: candidates } },
      select: { id: true },
    });

    if (hit) throw redirect(`/app/subscriptions-edit/${hit.id}?${qs}`);
  }

  // 2. Anything else — including an `id` that isn't a contract — falls back to
  //    the list, which filters itself on the customer_id already in the query.
  throw redirect(`/app/subscriptions?${qs}`);
};
