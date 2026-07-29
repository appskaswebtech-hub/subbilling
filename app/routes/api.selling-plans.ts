// app/routes/api.selling-plans.ts
//
// Public API — returns all selling plans with assigned products for a shop.
//
// Auth: x-api-key header (managed in App → API Key settings)
//
// GET /api/selling-plans
// Headers:
//   x-api-key: YOUR_API_KEY
//
// Response:
// {
//   "shop": "store.myshopify.com",
//   "plans": [
//     {
//       "id": "cuid",
//       "name": "Daily Subscription",
//       "interval": "DAY",
//       "intervalCount": 1,
//       "discount": 20,
//       "discountType": "percentage",
//       "shopifyGroupId": "gid://shopify/SellingPlanGroup/123",
//       "products": [
//         {
//           "id": "gid://shopify/Product/456",
//           "title": "My Product",
//           "handle": "my-product",
//           "variants": [
//             { "id": "gid://shopify/ProductVariant/789", "title": "Default", "price": "29.99" }
//           ]
//         }
//       ]
//     }
//   ]
// }

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json }               from "@remix-run/node";
import { authenticateApiKey } from "../lib/api-auth.server";
import { unauthenticated }    from "../shopify.server";
import db                     from "../db.server";

const GET_PLAN_GROUP_PRODUCTS = `#graphql
  query GetSellingPlanGroupProducts($id: ID!) {
    sellingPlanGroup(id: $id) {
      products(first: 50) {
        edges {
          node {
            id
            title
            handle
            variants(first: 20) {
              edges {
                node {
                  id
                  title
                  price
                  sku
                }
              }
            }
          }
        }
      }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  let shop: string;
  try {
    shop = await authenticateApiKey(request);
  } catch (err) {
    return err as Response;
  }

  // Fetch all selling plan groups for this shop from DB
  const groups = await db.sellingPlanGroup.findMany({
    where:   { shop },
    orderBy: { createdAt: "asc" },
  });

  if (!groups.length) {
    return json({ shop, plans: [] });
  }

  // Fetch assigned products from Shopify for each group
  let admin: any;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch {
    // If Shopify auth fails, return plans without products
    return json({
      shop,
      plans: groups.map((g) => ({
        id:            g.id,
        name:          g.name,
        interval:      g.interval,
        intervalCount: g.intervalCount,
        discount:      g.discount,
        discountType:  (g as any).discountType ?? "percentage",
        shopifyGroupId: g.shopifyGroupId
          ? `gid://shopify/SellingPlanGroup/${g.shopifyGroupId}`
          : null,
        products: [],
      })),
    });
  }

  const plans = await Promise.all(
    groups.map(async (group) => {
      let products: any[] = [];

      if (group.shopifyGroupId) {
        const gid = group.shopifyGroupId.startsWith("gid://")
          ? group.shopifyGroupId
          : `gid://shopify/SellingPlanGroup/${group.shopifyGroupId}`;

        try {
          const res  = await admin.graphql(GET_PLAN_GROUP_PRODUCTS, { variables: { id: gid } });
          const data = await res.json();
          const edges = data?.data?.sellingPlanGroup?.products?.edges ?? [];
          products = edges.map((e: any) => ({
            id:       e.node.id,
            title:    e.node.title,
            handle:   e.node.handle,
            variants: (e.node.variants?.edges ?? []).map((v: any) => ({
              id:    v.node.id,
              title: v.node.title,
              price: v.node.price,
              sku:   v.node.sku ?? null,
            })),
          }));
        } catch {
          products = [];
        }
      }

      return {
        id:            group.id,
        name:          group.name,
        interval:      group.interval,
        intervalCount: group.intervalCount,
        discount:      group.discount,
        discountType:  (group as any).discountType ?? "percentage",
        shopifyGroupId: group.shopifyGroupId
          ? `gid://shopify/SellingPlanGroup/${group.shopifyGroupId}`
          : null,
        products,
      };
    }),
  );

  return json({ shop, plans });
}

