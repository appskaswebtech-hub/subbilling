import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { WITHOUT_BUNDLE_PRODUCTS } from "../config/bundle-product";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";

  if (!q || q.length < 2) return json({ variants: [] });

  // The search, minus the products the app made for bundles.
  const response = await admin.graphql(`
    query searchProducts($query: String!) {
      products(first: 10, query: $query) {
        edges {
          node {
            id
            title
            featuredImage { url }
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  price
                }
              }
            }
          }
        }
      }
    }
  `, { variables: { query: `${q} ${WITHOUT_BUNDLE_PRODUCTS}` } });

  const data = await response.json();
  const variants: any[] = [];

  for (const { node: product } of data.data?.products?.edges ?? []) {
    const productId = product.id.replace("gid://shopify/Product/", "");
    const image = product.featuredImage?.url ?? null;

    for (const { node: variant } of product.variants?.edges ?? []) {
      const variantId = variant.id.replace("gid://shopify/ProductVariant/", "");
      variants.push({
        shopifyProductId: productId,
        shopifyVariantId: variantId,
        title: product.title,
        variantTitle: variant.title !== "Default Title" ? variant.title : null,
        price: variant.price,
        image,
      });
    }
  }

  return json({ variants });
};
