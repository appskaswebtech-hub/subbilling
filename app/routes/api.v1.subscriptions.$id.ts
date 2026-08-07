// app/routes/api.v1.subscriptions.$id.ts
//
// GET   /api/v1/subscriptions/:id     → get single subscription
// PATCH /api/v1/subscriptions/:id     → update nextBillingDate
//
// Headers: x-api-key: sk_xxxx
//
// PATCH body:
// {
//   "nextBillingDate": "2026-06-01"
// }

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticateApiKey } from "../lib/api-auth.server";
import { setContractNextBillingDate } from "../lib/subscription-contract.server";
import prisma from "../db.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shop = await authenticateApiKey(request);
  const { id } = params;

  const subscription = await prisma.subscription.findFirst({
    where: { id, shop },
    include: {
      billingAttempts: {
        orderBy: { createdAt: "desc" },
        take:    5,
        select:  { id: true, amount: true, status: true, errorMessage: true, createdAt: true },
      },
    },
  });

  if (!subscription) {
    return json({ error: "Subscription not found" }, { status: 404 });
  }

  return json({ subscription });
}

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

  const body            = await request.json() as { nextBillingDate?: string };
  const nextBillingDate = body.nextBillingDate ? new Date(body.nextBillingDate) : null;

  if (!nextBillingDate || isNaN(nextBillingDate.getTime())) {
    return json({ error: "Invalid nextBillingDate" }, { status: 400 });
  }

  // Normalize to midnight UTC
  nextBillingDate.setUTCHours(0, 0, 0, 0);

  // Reschedule on the contract first — a local-only change would silently
  // desynchronize the app from the billing Shopify actually performs.
  const result = await setContractNextBillingDate(
    shop,
    subscription.shopifyContractId,
    nextBillingDate,
  );

  if (!result.ok) {
    return json({ error: `Shopify rejected the new billing date: ${result.error}` }, { status: 502 });
  }

  const updated = await prisma.subscription.update({
    where: { id },
    data:  {
      nextBillingDate: result.nextBillingDate
        ? new Date(result.nextBillingDate)
        : nextBillingDate,
    },
  });

  return json({ subscription: updated });
}

