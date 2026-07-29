// app/routes/api.v1.subscriptions.ts
//
// GET  /api/v1/subscriptions          → list all subscriptions for the shop
// Headers: x-api-key: sk_xxxx
//
// Query params:
//   ?status=ACTIVE|PAUSED|CANCELLED    filter by status
//   ?page=1                            pagination (25 per page)

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticateApiKey } from "../lib/api-auth.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await authenticateApiKey(request);

  const url    = new URL(request.url);
  const status = url.searchParams.get("status")?.toUpperCase() ?? undefined;
  const page   = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit  = 25;
  const skip   = (page - 1) * limit;

  const where = {
    shop,
    ...(status ? { status } : {}),
  };

  const [subscriptions, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id:                true,
        shopifyContractId: true,
        customerId:        true,
        customerEmail:     true,
        productTitle:      true,
        planName:          true,
        status:            true,
        price:             true,
        frequency:         true,
        nextBillingDate:   true,
        createdAt:         true,
        updatedAt:         true,
        billingAttempts: {
          orderBy: { createdAt: "desc" },
          take:    1,
          select:  { status: true, createdAt: true },
        },
      },
    }),
    prisma.subscription.count({ where }),
  ]);

  return json({
    subscriptions,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
  });
}
