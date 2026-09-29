// app/routes/bundles.tsx
//
// Top-level twin of /apps/subscriptions/bundles, for when the app proxy URL has
// lost its subpath:  storefront /apps/subscriptions/bundles → /bundles
// See app/routes/widget-settings.tsx for why both shapes are served.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { bundlesLoader } from "../lib/bundle-endpoint.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return bundlesLoader(request);
}
