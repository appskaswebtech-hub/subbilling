// app/routes/api.v1.subscriptions.$id.cancel.ts
//
// PATCH /api/v1/subscriptions/:id/cancel  → cancel subscription
// Headers: x-api-key: sk_xxxx

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticateApiKey } from "../lib/api-auth.server";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const shop = await authenticateApiKey(request);
  const { id } = params;

  if (request.method !== "PATCH") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const subscription = await prisma.subscription.findFirst({
    where: { id, shop },
  });

  if (!subscription) {
    return json({ error: "Subscription not found" }, { status: 404 });
  }

  if (subscription.status === "CANCELLED") {
    return json({ error: "Subscription is already cancelled" }, { status: 400 });
  }

  // Cancel on Shopify via GraphQL
  try {
    const { admin } = await unauthenticated.admin(shop);
    await admin.graphql(`
      mutation SubscriptionContractCancel($subscriptionContractId: ID!) {
        subscriptionContractCancel(subscriptionContractId: $subscriptionContractId) {
          subscriptionContract { status }
          userErrors { field message }
        }
      }
    `, { variables: { subscriptionContractId: subscription.shopifyContractId } });
  } catch (err) {
    console.error("[API] Failed to cancel on Shopify:", err);
  }

  const updated = await prisma.subscription.update({
    where: { id },
    data:  { status: "CANCELLED" },
  });

  return json({ subscription: updated, message: "Subscription cancelled successfully" });
}

