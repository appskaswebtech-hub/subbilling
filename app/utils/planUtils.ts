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
  shop:            string,
  plan:            string,
  subscriptionId:  string | null,
  // GID of the usage-priced AppSubscriptionLineItem, when the plan has one.
  // appUsageRecordCreate needs this specific id — the AppSubscription GID in
  // `subscriptionId` is rejected. Null for flat-fee plans.
  usageLineItemId: string | null = null
) {
  const now = new Date();

  return db.shopPlan.upsert({
    where:  { shop },
    update: {
      plan,
      subscriptionId,
      usageLineItemId,
      status:           "active",
      billingStartedAt: subscriptionId ? now : null,  // only set when paid
    },
    create: {
      shop,
      plan,
      subscriptionId,
      usageLineItemId,
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
      usageLineItemId: null,
      status:          "cancelled",
      billingStartedAt: null,
    },
  });
}
