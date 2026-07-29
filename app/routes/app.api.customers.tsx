import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";

  if (!q || q.length < 2) return json({ customers: [] });

  const response = await admin.graphql(`
    query searchCustomers($query: String!) {
      customers(first: 10, query: $query) {
        edges {
          node {
            id
            email
            firstName
            lastName
          }
        }
      }
    }
  `, { variables: { query: q } });

  const data = await response.json();
  const customers = (data.data?.customers?.edges ?? []).map(({ node }: any) => ({
    shopifyCustomerId: node.id.replace("gid://shopify/Customer/", ""),
    email: node.email ?? "",
    firstName: node.firstName ?? null,
    lastName: node.lastName ?? null,
  }));

  return json({ customers });
};
