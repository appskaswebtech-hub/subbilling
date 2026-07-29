// app/routes/webhooks.app.uninstalled.tsx

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    // 1. Cancel active Shopify app subscription so merchant isn't billed after uninstall
    try {
      const shopPlan = await db.shopPlan.findUnique({ where: { shop } });

      if (shopPlan?.subscriptionId && shopPlan.status === "active") {
        const response = await admin.graphql(
          `#graphql
          mutation appSubscriptionCancel($id: ID!) {
            appSubscriptionCancel(id: $id) {
              appSubscription {
                id
                status
              }
              userErrors {
                field
                message
              }
            }
          }`,
          { variables: { id: shopPlan.subscriptionId } },
        );

        const result = await response.json();
        const userErrors = result?.data?.appSubscriptionCancel?.userErrors ?? [];
        if (userErrors.length) {
          console.error(`[${topic}] appSubscriptionCancel errors:`, userErrors);
        }
      }
    } catch (err) {
      // Log but don't throw — must still return 200 so Shopify doesn't retry endlessly
      console.error(`[${topic}] Failed to cancel subscription for ${shop}:`, err);
    }

    // 2. Delete all shop data in FK-safe order, Session last
    try {
      await db.$transaction([
        // BillingAttempt references Subscription — must go first
        db.billingAttempt.deleteMany({
          where: { subscription: { shop } },
        }),
        db.subscription.deleteMany({ where: { shop } }),
        db.sellingPlanGroup.deleteMany({ where: { shop } }),
        db.appSettings.deleteMany({ where: { shop } }),
        db.shopPlan.deleteMany({ where: { shop } }),
        // Session last — matches Shopify's default behaviour
        db.session.deleteMany({ where: { shop } }),
      ]);
    } catch (err) {
      console.error(`[${topic}] DB cleanup failed for ${shop}:`, err);
    }
  }

  return new Response();
};
