// app/routes/api.v1.subscriptions.$id.pause.ts
//
// PATCH /api/v1/subscriptions/:id/pause  → pause subscription
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

  if (subscription.status !== "ACTIVE") {
    return json({ error: `Cannot pause subscription with status: ${subscription.status}` }, { status: 400 });
  }

  // Pause on Shopify via GraphQL
  try {
    const { admin } = await unauthenticated.admin(shop);
    await admin.graphql(`
      mutation SubscriptionContractUpdate($contractId: ID!) {
        subscriptionContractUpdate(contractId: $contractId) {
          draft {
            status
          }
          userErrors { field message }
        }
      }
    `, { variables: { contractId: subscription.shopifyContractId } });
  } catch (err) {
    console.error("[API] Failed to pause on Shopify:", err);
  }

  const updated = await prisma.subscription.update({
    where: { id },
    data:  { status: "PAUSED" },
  });

  return json({ subscription: updated, message: "Subscription paused successfully" });
}

