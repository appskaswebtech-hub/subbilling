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
import { PLANS, PLAN_KEYS, PLAN_ORDER } from "../config/plans";
import { resolveBillingCurrency, localizedCap, localizedPrice, formatMoney } from "../config/currency";

// The currency this shop pays Shopify for apps in. Every charge must match it.
const SHOP_BILLING_CURRENCY_QUERY = `#graphql
  query CommissionBillingCurrency {
    shopBillingPreferences { currency }
  }
`;

/**
 * The shop's app-billing currency, or USD if it cannot be read.
 *
 * USD is accepted from every shop, so a failed lookup degrades to a working
 * subscription rather than a blocked upgrade. Used by both the loader (to price
 * the cards) and the action (to price the actual charge), so the two cannot
 * disagree about what the merchant was shown.
 */
async function resolveShopBillingCurrency(
  admin: { graphql: (q: string) => Promise<Response> },
  shop:  string
): Promise<string> {
  try {
    const res  = await admin.graphql(SHOP_BILLING_CURRENCY_QUERY);
    const json = await res.json() as { data?: { shopBillingPreferences?: { currency?: string } } };
    return resolveBillingCurrency(json?.data?.shopBillingPreferences?.currency);
  } catch (err) {
    console.warn(`[billing] could not read shopBillingPreferences for ${shop}; using USD:`, err);
    return "USD";
  }
}
import { getShopPlanFromDB } from "../utils/planUtils";
import { getCommissionSummary } from "../lib/app-commission.server";
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
interface CommissionData {
  charged:    number;   // month-to-date, in `currency` below
  count:      number;   // how many charges it came from
  cap:        number;   // the approved monthly ceiling
  capReached: boolean;  // Shopify has refused a usage record for hitting it
  currency:   string;   // what `charged` and `cap` are denominated in
  // "INR->USD" when a charge could not be converted into the billing
  // currency. Null when everything billed normally.
  unconvertible: string | null;
}
interface LoaderData {
  currentPlan: string;
  commission:  CommissionData | null;   // null on flat-fee plans
  // The currency this shop will actually be charged in. Every price on the
  // page is rendered in it so the cards match the approval screen.
  currency:    string;
}
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

const PLANS_ORDERED = PLAN_ORDER.map((k) => PLANS[k]).filter(Boolean);

// All PAID plans share one trial length, so the page-level copy reads it from
// config rather than hardcoding a number that can drift away from PLANS. Free
// has no trial (trialDays: 0) — there is no monthly fee to defer.
const TRIAL_DAYS = PLANS.basic.trialDays;

// ─── Shopify charge mode ──────────────────────────────────────
// Controls the `test` argument on appSubscriptionCreate. Nothing else.
//
//   true  → TEST charge. Merchant sees the approval screen, subscription
//           activates, NO real money moves. Correct for development stores.
//   false → REAL charge. Merchants are actually billed. Production only.
//
// The value is fixed when the bundle is built, so changing it requires
// `npm run build` AND a process restart before the running server picks it up.
// Editing this file alone has no effect on an already-running server.
//
// NOTE: this file (app/routes/app.billing.tsx) is the ONLY billing page Remix
// loads. app/app.billing.tsxeses is a dead copy; editing it has no effect on
// the running app.
const BILLING_TEST_MODE = true;

// ─── Loader ───────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const record      = await getShopPlanFromDB(session.shop);
  const planMeta    = PLANS[record.plan];

  // Price the cards in whatever the merchant will actually be charged in. A
  // shop already on a plan keeps the currency Shopify fixed at approval;
  // everyone else gets their current billing preference.
  const currency = record.subscriptionId
    ? record.billingCurrency
    : await resolveShopBillingCurrency(admin, session.shop);

  // Only commission-priced plans have anything to report — skip the query
  // entirely on flat-fee tiers.
  const summary = planMeta?.commissionRate
    ? await getCommissionSummary(session.shop)
    : null;

  const commission: CommissionData | null = summary
    ? {
        ...summary,
        // The cap must be shown in the same currency the charges are in, so it
        // is localized the same way it was when the subscription was created.
        cap: localizedCap(planMeta!.usageCappedAmount ?? 0, summary.currency),
      }
    : null;

  return { currentPlan: record.plan, commission, currency } satisfies LoaderData;
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

  // ── Which currency will this subscription be billed in? ───────────
  // Shopify recommends charging in the merchant's own billing currency, and for
  // the commission it is load-bearing: 2% of an order denominated in the shop's
  // currency can only be billed correctly if the usage line shares it.
  //
  // Every tier is localized, so the amounts below must come from
  // localizedPrice/localizedCap rather than the USD figures in PLANS — sending
  // 9.99 with currencyCode "INR" would bill ₹9.99.
  const billingCurrency = await resolveShopBillingCurrency(admin, shop);

  // A plan contributes a recurring line, a usage line, or both. The Free plan
  // is usage-only: no recurring line at all, so the merchant's Shopify bill
  // stays at zero until a subscription actually charges.
  const lineItems: Record<string, unknown>[] = [];

  if (selectedPlan.price > 0) {
    lineItems.push({
      plan: {
        appRecurringPricingDetails: {
          price: {
            amount:       localizedPrice(selectedPlan.price, billingCurrency, planKey),
            currencyCode: billingCurrency,
          },
          interval: "EVERY_30_DAYS",
        },
      },
    });
  }

  if (selectedPlan.commissionRate) {
    // `terms` is shown verbatim to the merchant on the approval screen, and
    // `cappedAmount` is required by Shopify — usage pricing cannot be uncapped.
    const cap = localizedCap(selectedPlan.usageCappedAmount ?? 0, billingCurrency);

    lineItems.push({
      plan: {
        appUsagePricingDetails: {
          terms:        selectedPlan.usageTerms ?? "Commission on each successful subscription charge",
          cappedAmount: { amount: cap, currencyCode: billingCurrency },
        },
      },
    });
  }

  if (!lineItems.length)
    return { error: `Plan "${planKey}" has no price and no commission configured.` } satisfies ActionData;

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
          test:     BILLING_TEST_MODE,
          lineItems,
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
  free:     { icon: "◇", bg: T.greenBg,  fg: T.greenFg  },
  basic:    { icon: "△", bg: T.purpleBg, fg: T.purpleFg },
  pro:      { icon: "★", bg: T.purpleBg, fg: T.purpleFg },
  advanced: { icon: "✓", bg: T.greenBg,  fg: T.greenFg  },
};

// ─── Feature comparison matrix (free / basic / pro / advanced) ─
// The monthly fee row is prepended at render time from the shop's own currency
// — hardcoding "$9.99" here would contradict the localized plan cards above it.
const COMPARE_ROWS: Array<{ label: string; values: Record<string, string> }> = [
  { label: "Transaction fee",       values: { free: "2% per charge", basic: "—",   pro: "—",         advanced: "—"         } },
  { label: "Subscription plans",    values: { free: "Up to 5",   basic: "Up to 5", pro: "Up to 10",  advanced: "Unlimited" } },
  { label: "Subscription products", values: { free: "Up to 50",  basic: "Up to 50", pro: "Up to 500", advanced: "Unlimited" } },
  { label: "Billing intervals",     values: { free: "Weekly, Monthly, Yearly", basic: "Weekly, Monthly, Yearly", pro: "Weekly, Monthly, Yearly", advanced: "Weekly, Monthly, Yearly" } },
  { label: "Support",               values: { free: "Email",     basic: "Email",   pro: "Priority",  advanced: "Priority"  } },
  { label: "Loyalty discounts",     values: { free: "—",         basic: "—",       pro: "✓",         advanced: "✓"         } },
  { label: "API & Webhook access",  values: { free: "—",         basic: "—",       pro: "—",         advanced: "✓"         } },
];

// ─── Page ─────────────────────────────────────────────────────
export default function BillingPage() {
  const { currentPlan, commission, currency } = useLoaderData<typeof loader>();
  const actionData      = useActionData<typeof action>() as ActionData | undefined;
  const navigation      = useNavigation();
  const [submittingPlan, setSubmittingPlan] = useState<string | null>(null);
  const [showCompare, setShowCompare] = useState(false);

  // Close the compare modal on Escape
  useEffect(() => {
    if (!showCompare) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowCompare(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showCompare]);

  const isSubmitting     = navigation.state === "submitting";
  const currentPlanMeta  = PLANS[currentPlan];
  const currentPlanLabel = currentPlanMeta?.label ?? currentPlan.toUpperCase();
  const currentPlanPrice = currentPlanMeta?.price ?? 0;

  useEffect(() => {
    if (actionData?.confirmationUrl) open(actionData.confirmationUrl, "_top");
  }, [actionData]);

  // Every price on the page goes through here, so the cards, the compare table
  // and the Shopify approval screen all quote the same figure.
  function displayPrice(usdPrice: number, planKey: string) {
    return formatMoney(localizedPrice(usdPrice, currency, planKey), currency);
  }

  // Prepended to the compare table so the fee row follows the shop's currency.
  const compareRows = [
    {
      label:  "Monthly fee",
      values: Object.fromEntries(
        PLAN_ORDER.map((k) => [
          k,
          PLANS[k]?.price ? displayPrice(PLANS[k].price, k) : formatMoney(0, currency),
        ])
      ),
    },
    ...COMPARE_ROWS,
  ];

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
                Pick the plan that best fits your store's needs. Start free and pay{" "}
                <span style={{ color: T.purpleFg, fontWeight: 500 }}>2% per subscription charge</span>,
                or choose a monthly plan with a{" "}
                <span style={{ color: T.purpleFg, fontWeight: 500 }}>{TRIAL_DAYS}-day free trial</span>.
              </Text>
            </div>
          </BlockStack>
          <button
            onClick={() => setShowCompare(true)}
            style={{ ...btn, border: `0.5px solid var(--p-color-border-secondary)`, background: "var(--p-color-bg-surface)", marginTop: "4px" }}
          >
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
                : currentPlan === "free"
                ? "No monthly fee — you're charged 2% each time a subscription bills. Switch to a paid plan anytime to remove the commission."
                : "Upgrade anytime to unlock more features for your store."}
            </Text>
          </div>
        </div>

        {/* ── Commission usage (free plan only) ────────────────── */}
        {commission && (
          <div
            className="hover-card"
            style={{
              background:   commission.capReached ? T.amberBg : "var(--p-color-bg-surface)",
              border:       `0.5px solid ${commission.capReached ? "#E0B15E" : "var(--p-color-border)"}`,
              borderRadius: "12px",
              padding:      "16px 20px",
            }}
          >
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  Commission this month
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {commission.count} charge{commission.count === 1 ? "" : "s"}
                </Text>
              </InlineStack>

              <InlineStack gap="150" blockAlign="baseline">
                <span style={{ fontSize: "26px", fontWeight: 700, lineHeight: 1 }}>
                  {formatMoney(commission.charged, commission.currency)}
                </span>
                <Text as="span" variant="bodySm" tone="subdued">
                  of {formatMoney(commission.cap, commission.currency)} monthly cap
                </Text>
              </InlineStack>

              {/* Usage bar */}
              <div style={{ height: "6px", borderRadius: "4px", background: "var(--p-color-bg-surface-secondary)", overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.min(100, commission.cap > 0 ? (commission.charged / commission.cap) * 100 : 0)}%`,
                    background: commission.capReached ? T.amberFg : T.purple,
                    borderRadius: "4px",
                  }}
                />
              </div>

              <Text as="p" variant="bodySm" tone="subdued">
                {commission.capReached
                  ? "⚠️ You've reached your monthly cap — no further commission can be charged until you re-approve a higher cap or switch to a paid plan. Your subscriptions keep billing normally."
                  : "Charged automatically each time one of your subscriptions bills successfully."}
              </Text>

              {commission.unconvertible && (
                <div style={{
                  background: T.amberBg, border: "0.5px solid #E0B15E",
                  borderRadius: "10px", padding: "12px 14px",
                }}>
                  <Text as="p" variant="bodySm">
                    Some orders could not be converted for billing
                    ({commission.unconvertible}), so no commission was taken on them.
                    Your subscriptions bill as normal and you were not charged.
                  </Text>
                </div>
              )}
            </BlockStack>
          </div>
        )}

        {/* ── Plan cards ───────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${PLANS_ORDERED.length}, 1fr)`, gap: "16px" }}>
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
                className="hover-card"
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
                      {plan.price > 0 ? displayPrice(plan.price, plan.key) : "Free"}
                    </span>
                    <div style={{ fontSize: "12px", color: "var(--p-color-text-subdued)", marginTop: "2px" }}>
                      {plan.commissionRate
                        ? `+ ${Math.round(plan.commissionRate * 100)}% per subscription charge`
                        : `per month · ${plan.trialDays}-day free trial`}
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
                          : plan.price === 0
                          // "Upgrade to Free" reads wrong from the no-plan state,
                          // and "Downgrade" is not what a merchant moving to a
                          // commission model is doing either.
                          ? `Start with ${plan.label}`
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
        <div className="hover-card" style={{
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
          {["Cancel anytime", "No setup fees", "Secure & reliable", "No long-term contract"].map((item) => (
            <div key={item} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <span style={{ color: T.greenDot, fontWeight: 700, fontSize: "12px" }}>✓</span>
              <Text as="span" variant="bodySm" tone="subdued">{item}</Text>
            </div>
          ))}
        </div>

        {/* Footer note */}
        <Text as="p" alignment="center" variant="bodySm" tone="subdued">
          ⊞ Paid plans include a {TRIAL_DAYS}-day free trial. Cancel anytime from your Shopify admin. Billed in USD.
        </Text>

      </BlockStack>

      {/* ── Compare features modal ─────────────────────────────── */}
      {showCompare && (
        <div
          onClick={() => setShowCompare(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: "20px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--p-color-bg-surface)", borderRadius: "16px",
              boxShadow: "0 24px 64px rgba(0,0,0,0.22)",
              width: "100%", maxWidth: "760px", maxHeight: "85vh",
              overflow: "auto", position: "relative",
            }}
          >
            {/* Header */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "18px 22px", borderBottom: "0.5px solid var(--p-color-border)",
              position: "sticky", top: 0, background: "var(--p-color-bg-surface)", zIndex: 1,
            }}>
              <Text as="h2" variant="headingMd" fontWeight="bold">Compare plans</Text>
              <button
                onClick={() => setShowCompare(false)}
                aria-label="Close"
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: "20px", lineHeight: 1, color: "var(--p-color-text-subdued)", padding: 0 }}
              >
                ×
              </button>
            </div>

            {/* Comparison table */}
            <div style={{ padding: "8px 22px 22px", overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "540px" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "14px 12px", fontSize: "12px", color: "var(--p-color-text-subdued)", fontWeight: 600, borderBottom: "1px solid var(--p-color-border)" }}>
                      Feature
                    </th>
                    {PLAN_ORDER.map((key) => {
                      const plan = PLANS[key];
                      const isCurrent = key === currentPlan;
                      return (
                        <th key={key} style={{
                          textAlign: "center", padding: "14px 12px",
                          borderBottom: "1px solid var(--p-color-border)",
                          background: plan.popular ? T.purpleBg : "transparent",
                          borderTopLeftRadius: plan.popular ? "10px" : 0,
                          borderTopRightRadius: plan.popular ? "10px" : 0,
                        }}>
                          <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--p-color-text)" }}>
                            {plan.label}
                          </div>
                          <div style={{ fontSize: "12px", color: "var(--p-color-text-subdued)", marginTop: "2px" }}>
                            {plan.price > 0 ? `${displayPrice(plan.price, plan.key)}/mo` : "Free"}
                          </div>
                          {isCurrent && (
                            <span style={{ display: "inline-block", marginTop: "4px", fontSize: "10px", fontWeight: 600, color: T.greenFg, background: T.greenBg, borderRadius: "10px", padding: "1px 8px" }}>
                              Current
                            </span>
                          )}
                          {plan.popular && !isCurrent && (
                            <span style={{ display: "inline-block", marginTop: "4px", fontSize: "10px", fontWeight: 600, color: T.purpleFg, background: "#fff", border: `0.5px solid ${T.purple}`, borderRadius: "10px", padding: "1px 8px" }}>
                              Popular
                            </span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {compareRows.map((row) => (
                    <tr key={row.label}>
                      <td style={{ padding: "12px", fontSize: "13px", color: "var(--p-color-text)", borderBottom: "0.5px solid var(--p-color-border-secondary)", whiteSpace: "nowrap" }}>
                        {row.label}
                      </td>
                      {PLAN_ORDER.map((key) => {
                        const val = row.values[key] ?? "—";
                        return (
                          <td key={key} style={{
                            padding: "12px", textAlign: "center", fontSize: "13px",
                            color: val === "✓" ? T.greenFg : val === "—" ? "var(--p-color-text-disabled)" : "var(--p-color-text)",
                            fontWeight: val === "✓" ? 700 : 400,
                            borderBottom: "0.5px solid var(--p-color-border-secondary)",
                            background: PLANS[key].popular ? "rgba(127,119,221,0.05)" : "transparent",
                          }}>
                            {val}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

