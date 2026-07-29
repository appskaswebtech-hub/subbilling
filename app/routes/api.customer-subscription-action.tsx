// app/routes/api.customer-subscription-action.tsx
// Called by the Customer Account UI extension to pause / resume / cancel
// a subscription. Verifies the customer owns the contract before acting.

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ─── Mutations (same as admin detail page) ───────────────────
const MUTATIONS: Record<string, { gql: string; payloadKey: string; localStatus: string }> = {
  pause: {
    gql: `mutation subscriptionContractPause($subscriptionContractId: ID!) {
      subscriptionContractPause(subscriptionContractId: $subscriptionContractId) {
        contract { id status }
        userErrors { field message }
      }
    }`,
    payloadKey:  "subscriptionContractPause",
    localStatus: "PAUSED",
  },
  resume: {
    gql: `mutation subscriptionContractActivate($subscriptionContractId: ID!) {
      subscriptionContractActivate(subscriptionContractId: $subscriptionContractId) {
        contract { id status }
        userErrors { field message }
      }
    }`,
    payloadKey:  "subscriptionContractActivate",
    localStatus: "ACTIVE",
  },
  cancel: {
    gql: `mutation subscriptionContractCancel($subscriptionContractId: ID!) {
      subscriptionContractCancel(subscriptionContractId: $subscriptionContractId) {
        contract { id status }
        userErrors { field message }
      }
    }`,
    payloadKey:  "subscriptionContractCancel",
    localStatus: "CANCELLED",
  },
};

// ─── Verify customer token ────────────────────────────────────
async function verifyCustomerToken(token: string, shop: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://shopify.com/authentication/${shop}/oauth/token/introspect`,
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${token}`,
        },
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.active) return null;
    return data.sub ?? null;
  } catch {
    return null;
  }
}

// ─── GID helper ───────────────────────────────────────────────
function toFullGid(raw: string): string {
  if (raw.startsWith("gid://")) return raw;
  if (raw.includes("/")) return `gid://shopify/${raw}`;
  return `gid://shopify/SubscriptionContract/${raw}`;
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Verify customer token
  const authHeader  = request.headers.get("Authorization") ?? "";
  const token       = authHeader.replace("Bearer ", "").trim();
  if (!token) return json({ error: "Missing authorization token" }, { status: 401 });

  const url  = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? request.headers.get("x-shopify-shop-domain") ?? "";
  if (!shop) return json({ error: "Missing shop" }, { status: 400 });

  const customerGid = await verifyCustomerToken(token, shop);
  if (!customerGid) return json({ error: "Invalid or expired token" }, { status: 401 });

  // Parse body
  let body: { id?: string; intent?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, intent } = body;
  if (!id || !intent) return json({ error: "Missing id or intent" }, { status: 400 });

  const op = MUTATIONS[intent];
  if (!op) return json({ error: `Unknown intent: ${intent}` }, { status: 400 });

  // ── CRITICAL: verify the customer owns this subscription ───
  // Prevents any customer from cancelling another customer's subscription
  const sub = await prisma.subscription.findFirst({
    where: {
      id,
      shop,
      customerId: customerGid, // must belong to the requesting customer
    },
  });

  if (!sub) {
    console.warn("[customer-subscription-action] Not found or ownership mismatch:", {
      id, customerGid, shop,
    });
    return json({ error: "Subscription not found" }, { status: 404 });
  }

  // Get admin API access via Shopify app auth
  const { admin } = await authenticate.admin(
    new Request(`https://${shop}/admin`, { headers: request.headers }),
  );

  const contractGid = toFullGid(sub.shopifyContractId);
  console.log(`[customer-action/${intent}] GID:`, contractGid);

  // Call Shopify Admin GraphQL
  let result: any;
  try {
    const res = await admin.graphql(op.gql, {
      variables: { subscriptionContractId: contractGid },
    });
    result = await res.json();
  } catch (err: any) {
    return json({ error: `Shopify request failed: ${err?.message}` });
  }

  console.log(`[customer-action/${intent}] Shopify response:`, JSON.stringify(result, null, 2));

  if (result?.errors?.length) {
    return json({ error: result.errors.map((e: any) => e.message).join(" | ") });
  }

  const payload    = result?.data?.[op.payloadKey];
  const userErrors = (payload?.userErrors ?? []) as Array<{ field: string[]; message: string }>;

  if (userErrors.length > 0) {
    return json({ error: userErrors.map((e) => `[${e.field}] ${e.message}`).join(" | ") });
  }

  // Sync local DB
  await prisma.subscription.update({
    where: { id },
    data:  { status: op.localStatus },
  });

  return json(
    { ok: true, status: op.localStatus },
    {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    },
  );
}
