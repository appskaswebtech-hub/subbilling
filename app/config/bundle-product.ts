// app/config/bundle-product.ts
//
// The Shopify product the app creates for each bundle (see
// app/lib/bundles.server.ts, syncBundleProduct): how it is marked, and how to
// leave it out of a list of products. Shared by the server and the browser.

/** On every bundle product, set when it's created and on each save. */
export const BUNDLE_PRODUCT_TAG = "kas-bundle";

/**
 * A product search filter that leaves the app's bundle products out. A bundle
 * product stands for a bundle in the cart; it isn't something to put in
 * another bundle or sell on a subscription plan, so product pickers pass this.
 */
export const WITHOUT_BUNDLE_PRODUCTS = `tag_not:${BUNDLE_PRODUCT_TAG}`;
