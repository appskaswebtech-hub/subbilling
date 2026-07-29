// app/routes/app.billing.tsx

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  Form,
} from "@remix-run/react";
import { useState, useEffect } from "react";
import { Page, BlockStack, InlineStack, Text } from "@shopify/polaris";
import { TitleBar }          from "@shopify/app-bridge-react";
import { authenticate }      from "../shopify.server";
import { PLANS, PLAN_KEYS }  from "../config/plans";
import { getShopPlanFromDB } from "../utils/planUtils";
import dashboardStyles from "../styles/dashboard.css?url";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];

// ─── Design tokens ───────────────────────────────────────────
const T = {
  purple:     "#7F77DD",
  purpleBg:   "#EEEDFE",
  purpleDark: "#26215C",
  purpleFg:   "#3C3489",
  greenBg:    "#EAF3DE",
  greenFg:    "#27500A",
  greenDot:   "#3B6D11",
  amberBg:    "#FAEEDA",
  amberFg:    "#633806",
  redBg:      "#FCEBEB",
  redFg:      "#791F1F",
  blueBg:     "#E6F1FB",
  blueFg:     "#185FA5",
};

// ─── Types ────────────────────────────────────────────────────
interface LoaderData { currentPlan: string }
interface ActionData { confirmationUrl?: string; error?: string }
interface UserError  { field: string; message: string }
interface AppSubscriptionCreateResponse {
  data?: {
    appSubscriptionCreate?: {
      confirmationUrl?: string;
      userErrors?:      UserError[];
      appSubscription?: { id: string };
    };
  };
}

const PLANS_ORDERED = ["basic", "pro", "advanced"].map((k) => PLANS[k]).filter(Boolean);

// ─── Loader ───────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const record      = await getShopPlanFromDB(session.shop);
  return { currentPlan: record.plan } satisfies LoaderData;
};

// ─── Action ───────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop     = session.shop;
  const formData = await request.formData();
  const planKey  = formData.get("plan") as string;

  if (!PLAN_KEYS.includes(planKey))
    return { error: `Invalid plan: "${planKey}"` } satisfies ActionData;

  const selectedPlan = PLANS[planKey];

  try {
    const response = await admin.graphql(
      `#graphql
      mutation AppSubscriptionCreate(
        $name: String! $lineItems: [AppSubscriptionLineItemInput!]!
        $returnUrl: URL! $trialDays: Int $test: Boolean
      ) {
        appSubscriptionCreate(
          name: $name returnUrl: $returnUrl
          lineItems: $lineItems trialDays: $trialDays test: $test
        ) {
          userErrors { field message }
          appSubscription { id }
          confirmationUrl
        }
      }`,
      {
        variables: {
          name:      planKey,
          returnUrl: `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/billing-return`,
          trialDays: selectedPlan.trialDays,
          test:     false,
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price:    { amount: selectedPlan.price, currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          }],
        },
      }
    );

    const resJson: AppSubscriptionCreateResponse = await response.json() as unknown as AppSubscriptionCreateResponse;
    const { confirmationUrl, userErrors } = resJson.data?.appSubscriptionCreate ?? {};

    if (userErrors?.length)
      return { error: userErrors.map((e) => e.message).join(", ") } satisfies ActionData;
    if (!confirmationUrl)
      return { error: "No confirmation URL returned from Shopify." } satisfies ActionData;

    return { confirmationUrl } satisfies ActionData;
  } catch (err) {
    return { error: "Something went wrong. Please try again." } satisfies ActionData;
  }
};

// ─── Plan icons ───────────────────────────────────────────────
const PLAN_ICONS: Record<string, { icon: string; bg: string; fg: string }> = {
  basic:    { icon: "△", bg: T.purpleBg, fg: T.purpleFg },
  pro:      { icon: "★", bg: T.purpleBg, fg: T.purpleFg },
  advanced: { icon: "✓", bg: T.greenBg,  fg: T.greenFg  },
};

// ─── Page ─────────────────────────────────────────────────────
export default function BillingPage() {
  const { currentPlan } = useLoaderData<typeof loader>();
  const actionData      = useActionData<typeof action>() as ActionData | undefined;
  const navigation      = useNavigation();
  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("monthly");
  const [submittingPlan, setSubmittingPlan] = useState<string | null>(null);

  const isSubmitting     = navigation.state === "submitting";
  const currentPlanMeta  = PLANS[currentPlan];
  const currentPlanLabel = currentPlanMeta?.label ?? currentPlan.toUpperCase();
  const currentPlanPrice = currentPlanMeta?.price ?? 0;

  useEffect(() => {
    if (actionData?.confirmationUrl) open(actionData.confirmationUrl, "_top");
  }, [actionData]);

  function displayPrice(price: number) {
    const p = billingCycle === "yearly" ? price * 0.8 : price;
    return p % 1 === 0 ? `$${p.toFixed(2)}` : `$${p.toFixed(2)}`;
  }

  const btn: React.CSSProperties = {
    fontSize: "12px", padding: "7px 14px", borderRadius: "8px",
    cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
    display: "inline-flex", alignItems: "center", gap: "6px",
  };

  return (
    <Page>
      <TitleBar title="Choose Plan" />
      <BlockStack gap="500">

        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <BlockStack gap="100">
            <InlineStack gap="150" blockAlign="center">
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: T.purple, display: "inline-block", flexShrink: 0 }} />
              <div className="breadcrumbs-dashboard">
                <Text as="span" variant="bodySm" tone="subdued">
                  Smart Subscriptions › Billing › <span className="subscription">Choose Plan</span>
                </Text>
              </div>
            </InlineStack>
            <div className="varient-section">
              <Text as="h1" variant="headingXl" fontWeight="bold">Choose your plan</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Pick the plan that best fits your store's needs. All plans include a{" "}
                <span style={{ color: T.purpleFg, fontWeight: 500 }}>7-day free trial</span>.
              </Text>
            </div>
          </BlockStack>
          <button style={{ ...btn, border: `0.5px solid var(--p-color-border-secondary)`, background: "var(--p-color-bg-surface)", marginTop: "4px" }}>
            ⊞ Compare features
          </button>
        </div>

        {/* Error banner */}
        {actionData?.error && (
          <div style={{ background: T.redBg, border: "0.5px solid #F09595", borderRadius: "10px", padding: "12px 16px" }}>
            <Text as="p" variant="bodySm">❌ {actionData.error}</Text>
          </div>
        )}

        {/* ── Current plan banner ──────────────────────────────── */}
        <div style={{
          background: T.blueBg, border: "0.5px solid #A8CFEC",
          borderRadius: "12px", padding: "14px 18px",
          display: "flex", alignItems: "center", gap: "12px",
        }}>
          <div style={{
            width: "36px", height: "36px", borderRadius: "50%",
            background: T.purpleBg, display: "flex",
            alignItems: "center", justifyContent: "center", fontSize: "16px", flexShrink: 0,
          }}>
            🔄
          </div>
          <div>
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              You are currently on the <strong>{currentPlanLabel}</strong> plan
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {currentPlan === "advanced"
                ? "You have access to all features. Manage your plan below."
                : "Upgrade anytime to unlock more features for your store."}
            </Text>
          </div>
        </div>

        {/* ── Billing cycle toggle ─────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{
            display: "inline-flex", borderRadius: "8px",
            border: "0.5px solid var(--p-color-border-secondary)",
            overflow: "hidden",
          }}>
            {(["monthly", "yearly"] as const).map((cycle) => (
              <button
                key={cycle}
                onClick={() => setBillingCycle(cycle)}
                style={{
                  padding: "7px 18px", fontSize: "13px", fontWeight: 500,
                  border: "none", cursor: "pointer",
                  background: billingCycle === cycle ? T.purpleDark : "var(--p-color-bg-surface)",
                  color: billingCycle === cycle ? "#fff" : "var(--p-color-text-subdued)",
                  transition: "all 0.15s",
                }}
              >
                {cycle.charAt(0).toUpperCase() + cycle.slice(1)}
              </button>
            ))}
          </div>
          {billingCycle === "yearly" && (
            <span style={{
              fontSize: "12px", fontWeight: 600, padding: "3px 10px",
              borderRadius: "20px", background: T.greenBg, color: T.greenFg,
              display: "inline-flex", alignItems: "center", gap: "4px",
            }}>
              Save up to 20% ↓
            </span>
          )}
          {billingCycle === "monthly" && (
            <span style={{
              fontSize: "12px", fontWeight: 500, color: "var(--p-color-text-subdued)",
              display: "inline-flex", alignItems: "center", gap: "4px",
            }}>
              Save up to 20% ↓
            </span>
          )}
        </div>

        {/* ── Plan cards ───────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
          {PLANS_ORDERED.map((plan) => {
            const isCurrent = currentPlan === plan.key;
            const meta      = PLAN_ICONS[plan.key] ?? PLAN_ICONS.basic;

            const borderColor = isCurrent
              ? T.greenDot
              : plan.popular
              ? T.purpleFg
              : "var(--p-color-border)";
            const borderWidth = (isCurrent || plan.popular) ? "1.5px" : "0.5px";

            return (
              <div
                key={plan.key}
                style={{
                  background:    "var(--p-color-bg-surface)",
                  border:        `${borderWidth} solid ${borderColor}`,
                  borderRadius:  "14px",
                  display:       "flex",
                  flexDirection: "column",
                  overflow:      "hidden",
                  position:      "relative",
                }}
              >
                {/* Top badge */}
                {(plan.popular || isCurrent) && (
                  <div style={{
                    position: "absolute", top: "12px", right: "12px",
                    fontSize: "10px", fontWeight: 700, padding: "3px 10px",
                    borderRadius: "20px",
                    background: isCurrent ? T.greenBg : T.purpleBg,
                    color:      isCurrent ? T.greenFg : T.purpleFg,
                    letterSpacing: "0.03em",
                  }}>
                    {isCurrent ? "Current Plan" : "Most Popular"}
                  </div>
                )}

                {/* Card body */}
                <div style={{ padding: "22px 22px 0" }}>
                  {/* Icon */}
                  <div style={{
                    width: "36px", height: "36px", borderRadius: "8px",
                    background: meta.bg, color: meta.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "18px", fontWeight: 700, marginBottom: "12px",
                  }}>
                    {meta.icon}
                  </div>

                  {/* Name */}
                  <Text as="h2" variant="headingLg" fontWeight="bold">{plan.label}</Text>

                  {/* Price */}
                  <div style={{ marginTop: "8px" }}>
                    <span style={{ fontSize: "32px", fontWeight: 700, lineHeight: 1 }}>
                      {displayPrice(plan.price)}
                    </span>
                    <div style={{ fontSize: "12px", color: "var(--p-color-text-subdued)", marginTop: "2px" }}>
                      per month · {plan.trialDays}-day free trial
                    </div>
                  </div>

                  {/* Divider */}
                  <div style={{ borderTop: "0.5px solid var(--p-color-border)", margin: "16px 0 12px" }} />

                  {/* Features */}
                  <div style={{ marginBottom: "8px" }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">What's included</Text>
                    <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                      {plan.features.map((f, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                          <span style={{
                            color: T.greenDot, fontWeight: 700,
                            fontSize: "13px", flexShrink: 0, marginTop: "1px",
                          }}>
                            ✓
                          </span>
                          <Text as="span" variant="bodySm">{f}</Text>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* CTA */}
                <div style={{ padding: "16px 22px", marginTop: "auto" }}>
                  {isCurrent ? (
                    <button
                      disabled
                      style={{
                        width: "100%", padding: "9px", borderRadius: "9px",
                        fontSize: "13px", fontWeight: 600,
                        border: `0.5px solid ${T.greenDot}`,
                        background: T.greenBg, color: T.greenFg,
                        cursor: "not-allowed",
                      }}
                    >
                      ✓ Current Plan
                    </button>
                  ) : (
                    <Form method="post" style={{ width: "100%" }}>
                      <input type="hidden" name="plan" value={plan.key} />
                      <button
                        type="submit"
                        onClick={() => setSubmittingPlan(plan.key)}
                        disabled={isSubmitting || !!actionData?.confirmationUrl}
                        style={{
                          width: "100%", padding: "9px", borderRadius: "9px",
                          fontSize: "13px", fontWeight: 600,
                          border: plan.popular ? "none" : `0.5px solid var(--p-color-border-secondary)`,
                          background: plan.popular ? T.purpleDark : "var(--p-color-bg-surface)",
                          color:      plan.popular ? "#fff" : "var(--p-color-text)",
                          cursor: isSubmitting ? "not-allowed" : "pointer",
                          opacity: isSubmitting && submittingPlan !== plan.key ? 0.6 : 1,
                        }}
                      >
                        {isSubmitting && submittingPlan === plan.key
                          ? "Processing…"
                          : currentPlanPrice > plan.price
                          ? `Downgrade to ${plan.label}`
                          : `Upgrade to ${plan.label}`}
                      </button>
                    </Form>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── All plans include footer ──────────────────────────── */}
        <div style={{
          background: "var(--p-color-bg-surface)",
          border: "0.5px solid var(--p-color-border)",
          borderRadius: "12px", padding: "14px 20px",
          display: "flex", alignItems: "center", gap: "24px",
          flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "14px" }}>⊞</span>
            <Text as="span" variant="bodySm" fontWeight="semibold">All plans include</Text>
          </div>
          {["7-day free trial", "Cancel anytime", "No setup fees", "Secure & reliable"].map((item) => (
            <div key={item} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <span style={{ color: T.greenDot, fontWeight: 700, fontSize: "12px" }}>✓</span>
              <Text as="span" variant="bodySm" tone="subdued">{item}</Text>
            </div>
          ))}
        </div>

        {/* Footer note */}
        <Text as="p" alignment="center" variant="bodySm" tone="subdued">
          ⊞ All plans include a 7-day free trial. Cancel anytime from your Shopify admin. Billed in USD.
        </Text>

      </BlockStack>
    </Page>
  );
}


