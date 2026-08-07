// app/routes/api.v1.subscriptions.$id.pause.ts
//
// PATCH /api/v1/subscriptions/:id/pause  → pause subscription
// Headers: x-api-key: sk_xxxx

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticateApiKey } from "../lib/api-auth.server";
import { pauseContract } from "../lib/subscription-contract.server";
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

  // Shopify is the source of truth — only mirror locally once it confirms.
  const result = await pauseContract(shop, subscription.shopifyContractId);

  if (!result.ok) {
    return json({ error: `Shopify rejected the pause: ${result.error}` }, { status: 502 });
  }

  const updated = await prisma.subscription.update({
    where: { id },
    data:  { status: result.status },
  });

  return json({ subscription: updated, message: "Subscription paused successfully" });
}

