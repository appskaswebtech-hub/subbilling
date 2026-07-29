// app/utils/planUtils.ts

import db from "../db.server";

export async function getShopPlanFromDB(shop: string) {
  const record = await db.shopPlan.findUnique({ where: { shop } });

  // No record at all → new install, no plan assigned yet
  // Return a virtual "no plan" object so the guard redirects to billing
  if (!record) {
    return await db.shopPlan.create({
      data: {
        shop,
        plan:   "none",   // "none" is not in PLANS → guard redirects to /app/billing
        status: "active",
      },
    });
  }

  return record;
}

export async function updateShopPlan(
  shop:           string,
  plan:           string,
  subscriptionId: string | null
) {
  const now = new Date();

  return db.shopPlan.upsert({
    where:  { shop },
    update: {
      plan,
      subscriptionId,
      status:           "active",
      billingStartedAt: subscriptionId ? now : null,  // only set when paid
    },
    create: {
      shop,
      plan,
      subscriptionId,
      status:           "active",
      billingStartedAt: subscriptionId ? now : null,
    },
  });
}

export async function cancelShopPlan(shop: string) {
  return db.shopPlan.update({
    where:  { shop },
    data: {
      plan:            "none",
      subscriptionId:  null,
      status:          "cancelled",
      billingStartedAt: null,
    },
  });
}
