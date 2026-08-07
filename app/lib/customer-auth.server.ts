// app/lib/customer-auth.server.ts
//
// Authentication for routes called by the Customer Account UI extensions.
//
// These routes previously took `shop` straight from the request body and used
// it to load that shop's offline access token — so anyone could drive any
// shop's Admin API. Now the caller must present the customer-account session
// token (`await shopify.sessionToken.get()` in the extension) as a Bearer
// header, and both the shop and the customer identity come from the *verified*
// JWT rather than from the client.
//
// App proxy auth is not usable here: `logged_in_customer_id` is only populated
// when the storefront customer session cookie rides along, which it does not on
// a cross-origin fetch from a customer-account extension.

import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

export function corsHeaders(methods = "GET, POST, OPTIONS"): Record<string, string> {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type":                 "application/json",
  };
}

export interface CustomerContext {
  shop:        string;
  customerGid: string;
  admin:       AdminApiContext;
}

/**
 * Guarantees the request carries `Authorization: Bearer <sessionToken>`.
 *
 * Requests reach us through Shopify's app proxy, and neither custom-header
 * forwarding nor OPTIONS preflight handling is guaranteed across that hop. So
 * the extension sends the token as a `token` field instead — query param on
 * GET, JSON body field on POST — which keeps its requests CORS-simple and needs
 * no preflight. We rebuild the request with the header set so that downstream
 * verification is identical either way.
 *
 * The Authorization header is still honoured when present: nothing in the app
 * sends it today, but a direct (non-proxied) caller reasonably would.
 */
async function withBearer(request: Request): Promise<Request> {
  if (request.headers.get("Authorization")) return request;

  let token: string | null = null;
  let body:  string | undefined;

  if (request.method === "GET" || request.method === "HEAD") {
    token = new URL(request.url).searchParams.get("token");
  } else {
    // clone() so the route can still read its own body afterwards — a consumed
    // body cannot be read twice.
    body = await request.clone().text();
    try {
      token = JSON.parse(body)?.token ?? null;
    } catch {
      token = null;
    }
  }

  if (!token) return request;

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(request.url, { method: request.method, headers, body });
}

/**
 * Verifies the customer-account session token and returns the shop, the
 * customer, and an Admin client for that shop.
 *
 * Throws a JSON Response on any failure — callers can let it propagate.
 */
export async function authenticateCustomer(request: Request): Promise<CustomerContext> {
  let sessionToken;
  try {
    ({ sessionToken } = await authenticate.public.customerAccount(await withBearer(request)));
  } catch {
    throw json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
  }

  // dest is the shop domain ("https://shop.myshopify.com" or bare).
  const shop = String(sessionToken.dest ?? "").replace(/^https?:\/\//, "");
  // sub is the customer, as a GID or a bare numeric id.
  const rawCustomer = String(sessionToken.sub ?? "");

  if (!shop || !rawCustomer) {
    throw json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
  }

  const customerGid = rawCustomer.startsWith("gid://")
    ? rawCustomer
    : `gid://shopify/Customer/${rawCustomer.split("/").pop()}`;

  let admin: AdminApiContext;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch {
    throw json({ error: "App is not installed for this shop." }, { status: 401, headers: corsHeaders() });
  }

  return { shop, customerGid, admin };
}

const CONTRACT_OWNER_QUERY = `
  query ContractOwner($id: ID!) {
    subscriptionContract(id: $id) {
      id
      customer { id }
    }
  }
`;

/**
 * Confirms the contract belongs to this customer.
 *
 * Without this any signed-in customer could pass someone else's contractId and
 * read or mutate it. Throws a 403 Response when it does not match.
 */
export async function assertOwnsContract(
  ctx:         CustomerContext,
  contractGid: string,
): Promise<void> {
  let ownerGid: string | null = null;
  try {
    const res    = await ctx.admin.graphql(CONTRACT_OWNER_QUERY, { variables: { id: contractGid } });
    const result = await res.json() as any;
    ownerGid     = result?.data?.subscriptionContract?.customer?.id ?? null;
  } catch {
    throw json({ error: "Could not verify this subscription." }, { status: 502, headers: corsHeaders() });
  }

  if (!ownerGid || ownerGid !== ctx.customerGid) {
    // Deliberately identical to a missing contract — do not confirm that some
    // other customer's contract exists.
    throw json({ error: "Subscription not found." }, { status: 403, headers: corsHeaders() });
  }
}

export function toContractGid(raw: string): string {
  return raw.startsWith("gid://")
    ? raw
    : `gid://shopify/SubscriptionContract/${raw}`;
}
