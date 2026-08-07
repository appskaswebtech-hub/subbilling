// app/routes/apps.subscriptions.billing-history.jsx

import { json } from "@remix-run/node";
import prisma from "../db.server";
import {
  assertOwnsContract,
  authenticateCustomer,
  corsHeaders,
  toContractGid,
} from "../lib/customer-auth.server";

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders("GET, OPTIONS") });
  }

  // Shop and customer come from the verified session token, not the query
  // string — this used to serve any shop's billing history to any caller.
  const ctx = await authenticateCustomer(request);

  const url        = new URL(request.url);
  const contractId = url.searchParams.get("contractId");

  if (!contractId) {
    return json({ error: "Missing contractId" }, { status: 400, headers: corsHeaders("GET, OPTIONS") });
  }

  await assertOwnsContract(ctx, toContractGid(contractId));

  // Find subscription by shopifyContractId (short ID or full GID)
  const subscription = await prisma.subscription.findFirst({
    where: {
      shop: ctx.shop,
      OR: [
        { shopifyContractId: contractId },
        { shopifyContractId: `gid://shopify/SubscriptionContract/${contractId}` },
      ],
    },
  });

  if (!subscription) {
    // Return empty attempts rather than 404 — subscription may not be in DB yet
    return json({ attempts: [], stats: { totalAttempts: 0, totalPaid: 0, successCount: 0, failCount: 0 } }, { headers: corsHeaders() });
  }

  const billingAttempts = await prisma.billingAttempt.findMany({
    where: { subscriptionId: subscription.id },
    orderBy: { createdAt: "desc" },
  });

  const attempts = billingAttempts.map((a) => ({
    id:           a.id,
    amount:       a.amount,
    currency:     "USD",
    status:       a.status.toUpperCase(),
    errorMessage: a.errorMessage || null,
    createdAt:    a.createdAt.toISOString(),
  }));

  const successCount = attempts.filter(a => a.status === "SUCCESS").length;
  const failCount    = attempts.filter(a => a.status === "FAILED").length;
  const totalPaid    = attempts.filter(a => a.status === "SUCCESS").reduce((s, a) => s + a.amount, 0);

  return json({
    attempts,
    stats: {
      totalAttempts: attempts.length,
      successCount,
      failCount,
      totalPaid: parseFloat(totalPaid.toFixed(2)),
    },
  }, { headers: corsHeaders() });
}
