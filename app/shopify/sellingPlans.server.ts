// app/shopify/sellingPlans.server.ts
// Shopify Admin GraphQL — SellingPlanGroup read helper.
// Calling convention: admin.graphql(query, { variables }) → response.json()
//
// The CRUD wrappers that used to live here were only reachable from the
// app.create-plans / app.edit-plans routes, which were removed along with the
// Prisma models they referenced. app.plans.tsx owns selling plan writes and
// issues its mutations inline.

// admin.graphql is typed as a callable that returns a Response
type AdminGraphQL = (
  query: string,
  options?: { variables?: Record<string, any> }
) => Promise<Response>;

async function gql(
  admin: AdminGraphQL,
  query: string,
  variables: Record<string, any>
) {
  const response = await admin(query, { variables });
  const body = await response.json();
  // Top-level GraphQL errors
  if (body.errors?.length) {
    throw new Error(body.errors.map((e: any) => e.message).join(", "));
  }
  return body.data;
}

// ─── getFirstSellingPlanId ────────────────────────────────────────────────────

const GET_SELLING_PLAN_ID = `#graphql
  query getSellingPlanId($id: ID!) {
    sellingPlanGroup(id: $id) {
      sellingPlans(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }
  }
`;

export async function getFirstSellingPlanId(
  admin: AdminGraphQL,
  shopifyGroupId: string
): Promise<string | null> {
  const data = await gql(admin, GET_SELLING_PLAN_ID, { id: shopifyGroupId });
  return data?.sellingPlanGroup?.sellingPlans?.edges?.[0]?.node?.id ?? null;
}
