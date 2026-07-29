// app/routes/api.customer-subscriptions.tsx
// Called by the Customer Account UI extension to fetch subscriptions
// for the currently logged-in customer.
//
// Auth: reads the Bearer token from Authorization header,
// verifies it with Shopify's Customer Account API, then queries
// local DB by customerId (Shopify GID).

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

// ─── Verify customer token with Shopify ──────────────────────
// Returns the customer GID if valid, null if invalid
async function verifyCustomerToken(
  token: string,
  shop: string,
): Promise<string | null> {
  try {
    // Shopify Customer Account API — introspect the token to get customer ID
    const res = await fetch(
      `https://shopify.com/authentication/${shop}/oauth/token/introspect`,
      {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${token}`,
        },
      },
    );

    if (!res.ok) return null;
    const data = await res.json();

    // Token must be active and have the customer GID
    if (!data.active) return null;
    return data.sub ?? null; // sub = "gid://shopify/Customer/123456"
  } catch {
    return null;
  }
}

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  // Only allow GET
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Extract Bearer token
  const authHeader = request.headers.get("Authorization") ?? "";
  const token      = authHeader.replace("Bearer ", "").trim();
  if (!token) {
    return json({ error: "Missing authorization token" }, { status: 401 });
  }

  // Get shop from URL or header
  const url  = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? request.headers.get("x-shopify-shop-domain") ?? "";
  if (!shop) {
    return json({ error: "Missing shop" }, { status: 400 });
  }

  // Verify token → get customer GID
  const customerGid = await verifyCustomerToken(token, shop);
  if (!customerGid) {
    return json({ error: "Invalid or expired token" }, { status: 401 });
  }

  console.log("[api/customer-subscriptions] customerGid:", customerGid);

  // Fetch subscriptions from local DB for this customer only
  const subscriptions = await prisma.subscription.findMany({
    where: {
      shop,
      customerId: customerGid,  // exact match — no risk of leaking other customers
    },
    orderBy: { createdAt: "desc" },
    select: {
      id:               true,
      shopifyContractId:true,
      productTitle:     true,
      planName:         true,
      status:           true,
      price:            true,
      frequency:        true,
      nextBillingDate:  true,
    },
  });

  return json(
    { subscriptions },
    {
      headers: {
        // Allow the extension origin to call this endpoint
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    },
  );
}

// Handle CORS preflight
export async function action({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }
  return json({ error: "Method not allowed" }, { status: 405 });
}
