// app/routes/app.billing-return.tsx
//
// Shopify redirects here after the merchant approves (or cancels) billing.
// This is where we ACTUALLY update the ShopPlan table — only after confirmation.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { useEffect }                  from "react";
import {
  Page,
  Spinner,
  BlockStack,
  Text,
  Banner,
} from "@shopify/polaris";
import { TitleBar }     from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { PLANS }        from "../config/plans";
import { updateShopPlan } from "../utils/planUtils";

// ─── Types ────────────────────────────────────────────────────
interface AppSubscriptionLineItem {
  id:   string;
  plan: { pricingDetails?: { __typename?: string } };
}

interface ActiveSubscription {
  id:        string;
  name:      string;
  status:    "ACTIVE" | "PENDING" | "EXPIRED" | "DECLINED" | "FROZEN" | "CANCELLED";
  lineItems: AppSubscriptionLineItem[];
}

interface ActiveSubscriptionResponse {
  data?: {
    currentAppInstallation?: {
      activeSubscriptions?: ActiveSubscription[];
    };
  };
}

interface LoaderData {
  ok:   boolean;
  plan: { key: string; label: string } | null;
}

// ─── GraphQL ──────────────────────────────────────────────────
// lineItems is selected because appUsageRecordCreate needs the usage LINE
// ITEM's GID — the AppSubscription GID is rejected there — and this is the only
// point in the flow where the approved subscription is read back.
const ACTIVE_SUBSCRIPTION_QUERY = `#graphql
  query {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        lineItems {
          id
          plan { pricingDetails { __typename } }
        }
      }
    }
  }
`;

// ─── LOADER ───────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop               = session.shop;

  try {
    const response                         = await admin.graphql(ACTIVE_SUBSCRIPTION_QUERY);
    const data: ActiveSubscriptionResponse = await response.json();

    const activeSubscriptions =
      data?.data?.currentAppInstallation?.activeSubscriptions ?? [];

    // Find the ACTIVE subscription that matches one of our plan keys
    const activeSub = activeSubscriptions.find(
      (sub) =>
        sub.status === "ACTIVE" &&
        Object.keys(PLANS).includes(sub.name.toLowerCase())
    );

    if (activeSub) {
      const planKey  = activeSub.name.toLowerCase();
      const planMeta = PLANS[planKey];

      // Commission is billed against this line item on every successful
      // subscription charge. Without it the shop is on a commission plan we
      // cannot invoice, so log loudly rather than failing silently.
      const usageLineItemId =
        activeSub.lineItems?.find(
          (li) => li.plan?.pricingDetails?.__typename === "AppUsagePricing"
        )?.id ?? null;

      if (planMeta?.commissionRate && !usageLineItemId) {
        console.error(
          `[billing-return] ⚠️ ${shop} approved "${planKey}" but no AppUsagePricing line item came back — commission cannot be charged.`
        );
      }

      await updateShopPlan(shop, planKey, activeSub.id, usageLineItemId);

      console.log(
        `[billing-return] ✅ Plan updated → ${planKey} for ${shop}` +
        (usageLineItemId ? ` (usage line ${usageLineItemId})` : "")
      );

      return {
        ok:   true,
        plan: { key: planKey, label: planMeta?.label ?? planKey },
      } satisfies LoaderData;
    }

    // No active subscription found — merchant likely cancelled.
    // "none" (not "free") is the no-plan sentinel: "free" is a real plan now,
    // and writing it here would grant the tier to a merchant who declined.
    console.warn(`[billing-return] ⚠️ No ACTIVE subscription found for ${shop}.`);
    await updateShopPlan(shop, "none", null);

    return { ok: false, plan: null } satisfies LoaderData;

  } catch (err) {
    console.error("[billing-return] error:", err);
    return { ok: false, plan: null } satisfies LoaderData;
  }
};

// ─── COMPONENT ────────────────────────────────────────────────
export default function BillingReturnPage() {
  const { ok, plan } = useLoaderData<typeof loader>();
  const navigate     = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => navigate("/app/billing"), 5000);
    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <Page>
      <TitleBar title="Billing" />

      <div
        style={{
          display:        "flex",
          flexDirection:  "column",
          alignItems:     "center",
          justifyContent: "center",
          minHeight:      "60vh",
          gap:            "24px",
        }}
      >
        <BlockStack gap="400" inlineAlign="center">

          {ok && plan ? (
            <Banner tone="success" title="Plan activated successfully!">
              <Text as="p">
                You are now on the <strong>{plan.label}</strong> plan.
                Redirecting you back to billing…
              </Text>
            </Banner>
          ) : (
            <Banner tone="warning" title="Could not confirm plan.">
              <Text as="p">
                Your subscription may have been cancelled or is still pending.
                Redirecting you back. Please check your plan status.
              </Text>
            </Banner>
          )}

          <Spinner size="large" />

          <Text tone="subdued" variant="bodySm" as="p">
            Redirecting in 5 seconds…
          </Text>

        </BlockStack>
      </div>
    </Page>
  );
}
