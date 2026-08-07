// app/routes/apps.subscriptions.action.jsx
//
// Pause / resume / cancel a subscription from the Customer Account UI extension.
//
// This route used to take `shop` from the request body and use it to load that
// shop's offline access token, with no authentication of any kind — any caller
// could drive any shop's Admin API against any contract id. Both the shop and
// the customer now come from the verified customer-account session token, and
// the contract must belong to that customer.

import { json } from "@remix-run/node";
import prisma from "../db.server";
import {
  assertOwnsContract,
  authenticateCustomer,
  corsHeaders,
  toContractGid,
} from "../lib/customer-auth.server";
import {
  activateContract,
  cancelContract,
  pauseContract,
} from "../lib/subscription-contract.server";

const OPERATIONS = {
  pause:  pauseContract,
  resume: activateContract,
  cancel: cancelContract,
};

// Remix routes GET/HEAD/OPTIONS to the loader. This route only mutates, so the
// only reason it has one is to answer a CORS preflight — the extension no
// longer sends one, but a direct (non-proxied) caller reasonably could.
// Anything else is refused rather than answered with a bare 200, which would
// otherwise look like an unauthenticated endpoint.
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders("POST, OPTIONS") });
  }
  return json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders("POST, OPTIONS") });
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders("POST, OPTIONS") });
  }

  const ctx = await authenticateCustomer(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders("POST, OPTIONS") });
  }

  const { contractId, intent } = body ?? {};

  if (!contractId || !intent) {
    return json(
      { error: "Missing fields: contractId, intent" },
      { status: 400, headers: corsHeaders("POST, OPTIONS") },
    );
  }
  if (!OPERATIONS[intent]) {
    return json({ error: "Invalid intent" }, { status: 400, headers: corsHeaders("POST, OPTIONS") });
  }

  const gid = toContractGid(contractId);
  await assertOwnsContract(ctx, gid);

  // Shared helper: checks top-level errors and userErrors, and returns the
  // status Shopify actually applied.
  const result = await OPERATIONS[intent](ctx.shop, gid);

  if (!result.ok) {
    return json({ error: result.error }, { status: 422, headers: corsHeaders("POST, OPTIONS") });
  }

  // Mirror locally — non-fatal, the webhook reconciles anyway.
  try {
    await prisma.subscription.updateMany({
      where: {
        shop: ctx.shop,
        OR: [{ shopifyContractId: gid }, { shopifyContractId: contractId }],
      },
      data: { status: result.status, updatedAt: new Date() },
    });
  } catch (err) {
    console.error("[action] DB sync error:", err);
  }

  return json(
    { success: true, status: result.status },
    { status: 200, headers: corsHeaders("POST, OPTIONS") },
  );
}
