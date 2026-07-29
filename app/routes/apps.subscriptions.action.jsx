// app/routes/apps.subscriptions.action.jsx

import { json } from "@remix-run/node";
import prisma from "../db.server";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type":                 "application/json",
  };
}

// ── OPTIONS preflight + GET both handled in loader ────────────
export async function loader({ request }) {
  // OPTIONS preflight MUST be handled here in Remix (not in action)
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  return json({ ok: true }, { headers: corsHeaders() });
}

// ── POST ──────────────────────────────────────────────────────
export async function action({ request }) {
  // Also handle OPTIONS here just in case
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ── Parse body ──────────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() });
  }

  const { contractId, intent, shop } = body;

  if (!contractId || !intent || !shop) {
    return json(
      { error: "Missing fields: contractId, intent, shop" },
      { status: 400, headers: corsHeaders() }
    );
  }

  if (!["pause", "resume", "cancel"].includes(intent)) {
    return json({ error: "Invalid intent" }, { status: 400, headers: corsHeaders() });
  }

  // ── Look up offline session ──────────────────────────────────
  let session;
  try {
    session = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });
  } catch (err) {
    console.error("[action] DB error:", err);
    return json({ error: "DB error" }, { status: 500, headers: corsHeaders() });
  }

  if (!session?.accessToken) {
    console.error("[action] No offline session for shop:", shop);
    return json(
      { error: "App not installed or session expired for: " + shop },
      { status: 401, headers: corsHeaders() }
    );
  }

  // ── Build GID ────────────────────────────────────────────────
  const gid = contractId.startsWith("gid://")
    ? contractId
    : `gid://shopify/SubscriptionContract/${contractId}`;

  // ── Shopify Admin GraphQL mutations ──────────────────────────
  const MUTATIONS = {
    pause:  `mutation { subscriptionContractPause(subscriptionContractId: "${gid}") { contract { id status } userErrors { field message } } }`,
    resume: `mutation { subscriptionContractActivate(subscriptionContractId: "${gid}") { contract { id status } userErrors { field message } } }`,
    cancel: `mutation { subscriptionContractCancel(subscriptionContractId: "${gid}") { contract { id status } userErrors { field message } } }`,
  };

  const KEYS = {
    pause:  "subscriptionContractPause",
    resume: "subscriptionContractActivate",
    cancel: "subscriptionContractCancel",
  };
  console.log("[action] Received intent:", intent, "for contractId:", contractId, "shop:", shop);
  console.log("[action] Using GID:", session.accessToken);
  // ── Call Shopify Admin API ────────────────────────────────────
  let newStatus;
  try {
    const apiRes = await fetch(
      `https://${shop}/admin/api/2026-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type":           "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({ query: MUTATIONS[intent] }),
      }
    );

    const data   = await apiRes.json();
    console.log("[action] Shopify response:", JSON.stringify(data));
    const result = data?.data?.[KEYS[intent]];

    console.log("[action] Shopify response:", JSON.stringify(data));

    if (!result) {
      return json(
        { error: "No result from Shopify" },
        { status: 500, headers: corsHeaders() }
      );
    }

    if (result.userErrors?.length > 0) {
      return json(
        { error: result.userErrors[0].message },
        { status: 422, headers: corsHeaders() }
      );
    }

    newStatus = result.contract?.status;
  } catch (err) {
    console.error("[action] Shopify API error:", err);
    return json(
      { error: "Shopify API failed: " + err.message },
      { status: 500, headers: corsHeaders() }
    );
  }

  // ── Sync to DB (non-fatal) ────────────────────────────────────
  try {
    await prisma.subscription.updateMany({
      where: {
        shop,
        OR: [{ shopifyContractId: gid }, { shopifyContractId: contractId }],
      },
      data: { status: newStatus, updatedAt: new Date() },
    });
  } catch (err) {
    console.error("[action] DB sync error:", err);
  }

  return json(
    { success: true, status: newStatus },
    { status: 200, headers: corsHeaders() }
  );
}
