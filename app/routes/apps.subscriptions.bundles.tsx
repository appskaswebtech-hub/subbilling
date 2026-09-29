// app/routes/apps.subscriptions.bundles.tsx
//
// Bundles offered on a product page, served through Shopify's app proxy at
// https://{shop}/apps/subscriptions/bundles?productId=<id>, and called by the
// bundle-offer theme block. Twin of app/routes/bundles.tsx.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { bundlesLoader } from "../lib/bundle-endpoint.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return bundlesLoader(request);
}
