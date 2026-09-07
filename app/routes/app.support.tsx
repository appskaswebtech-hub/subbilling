// app/routes/app.support.tsx
//
// Contact details only — deliberately no contact form. The app has no
// email-sending dependency and no SMTP credentials, so a form here would need
// nodemailer/Resend plus new deploy config. Merchants mail us directly instead.

import { useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Text, BlockStack, InlineStack } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { PLANS } from "../config/plans";
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
  blueBg:     "#E6F1FB",
  blueFg:     "#185FA5",
};

// ─── Support configuration ────────────────────────────────────
// Single place to change the address and the promises we make about it.
const SUPPORT_EMAIL = "info@kaswebtechsolutions.com";

// Response windows advertised per support tier. These are commitments shown to
// merchants — change them here, not in the JSX.
const RESPONSE_TIME: Record<"email" | "priority", string> = {
  email:    "Within 48 hours",
  priority: "Within 24 hours",
};

const SUPPORT_HOURS = "Monday to Friday, 9:00 – 18:00 IST";

// ─── FAQ ──────────────────────────────────────────────────────
// Answers point at real behaviour in this app; keep them in step with the code.
const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "When are my customers actually charged?",
    a: "A background job runs on a schedule and charges every subscription whose next billing date has passed. Shopify then creates the order and confirms the payment back to the app, which is when the charge is marked successful in your dashboard.",
  },
  {
    q: "A payment failed. What happens next?",
    a: "The app retries according to the max retries and grace period you set in Settings. Once a subscription exceeds the retry limit inside the grace period, it is cancelled automatically and the customer is notified if you have failure notifications enabled.",
  },
  {
    q: "Why does a subscription show a next billing date in the future right after a failure?",
    a: "The billing date advances when the charge is attempted, not when it settles. This is expected — the retry logic tracks failures separately, so a failed charge is still retried on schedule.",
  },
  {
    q: "Can I edit a subscription while a charge is in flight?",
    a: "No. Editing is blocked while a billing attempt is pending, because changing the contract mid-charge would produce an order that does not match the subscription. Wait for the attempt to resolve, then edit.",
  },
  {
    q: "How do I move between plans?",
    a: "Open Upgrade Plans and pick the tier you want. Shopify shows an approval screen, and the new plan takes effect as soon as you approve it. Your subscriptions and selling plans are untouched by a plan change.",
  },
  {
    q: "What happens to my data if I uninstall?",
    a: "Uninstalling cancels your app subscription so you are not billed again, and removes your shop's data from our database. Your Shopify subscription contracts themselves belong to your store and are not deleted by the app.",
  },
];

// ─── Getting started ──────────────────────────────────────────
// The five steps that take a new install to a working subscription. `to` is
// rendered as an inline link, so this doubles as the page's navigation.
const STEPS: Array<{ title: string; body: string; to?: string; linkLabel?: string }> = [
  {
    title:     "Create a subscription plan",
    body:      "Set the delivery interval — weekly, monthly or yearly — how many intervals apart each order sits, and the discount subscribers get as either a percentage or a fixed amount.",
    to:        "/app/plans",
    linkLabel: "Open Subscription Plans",
  },
  {
    title:     "Attach your products",
    body:      "Add the products this plan should apply to. A product can belong to more than one plan, and shoppers pick between them on the product page.",
    to:        "/app/plans",
    linkLabel: "Manage products on a plan",
  },
  {
    title:     "Customize the storefront widget",
    body:      "Choose one of four designs — Default, Arctic, Ribbon or Benefits — then set your primary and badge colours, corner radius, and whether the one-time purchase option is shown alongside the subscription.",
    to:        "/app/widget-settings",
    linkLabel: "Open Widget Settings",
  },
  {
    title:     "Place a test order",
    body:      "Buy a subscription product on your storefront to confirm the widget appears and the contract lands in the app. It shows up under Subscriptions within a few seconds.",
    to:        "/app/subscriptions",
    linkLabel: "View Subscriptions",
  },
  {
    title:     "Set your billing policy",
    body:      "Decide how many times a failed payment is retried, how long the grace period runs before the subscription is cancelled, and which events email you.",
    to:        "/app/settings",
    linkLabel: "Open Settings",
  },
];

// ─── Help topics ──────────────────────────────────────────────
// Every bullet describes behaviour that actually ships. Note the automations
// entry: three of the four cards on that page are `available: false`, so this
// says so rather than implying they work.
const TOPICS: Array<{ icon: string; title: string; points: string[] }> = [
  {
    icon:  "◎",
    title: "Managing subscriptions",
    points: [
      "Browse, search and filter every contract from the Subscriptions page.",
      "Subscriptions created before you installed the app can be pulled in with Sync.",
      "Pause, resume or cancel any contract, and edit quantity, price or next billing date.",
      "Editing is locked while a charge is in flight — wait for it to settle first.",
    ],
  },
  {
    icon:  "◈",
    title: "Billing and retries",
    points: [
      "A scheduled job charges every subscription whose next billing date has passed.",
      "Failed payments retry up to your Max billing retries setting.",
      "Once retries are exhausted inside the grace period, the subscription is cancelled.",
      "The next billing date moves when a charge is attempted, not when it settles — a future date right after a failure is expected.",
    ],
  },
  {
    icon:  "✉",
    title: "Notifications",
    points: [
      "Get emailed on billing failures, on cancellations, and on new subscriptions.",
      "Each of the three is toggled independently in Settings.",
      "By default mail goes to the shop owner; set a notification email to send it elsewhere.",
    ],
  },
  {
    icon:  "⬡",
    title: "Customer portal",
    points: [
      "Customers manage their own subscriptions from their account area.",
      "You control whether they may pause and whether they may cancel.",
      "Turning both off makes the portal read-only — customers contact you instead.",
    ],
  },
  {
    icon:  "★",
    title: "Loyalty and automations",
    points: [
      "Loyalty discount rewards customers with an extra discount after a set number of renewals.",
      "Loyalty discounts are available on the Pro and Advanced plans.",
      "Bulk actions, automated interval changes and product upsells are on the roadmap and not available yet.",
    ],
  },
  {
    icon:  "⬢",
    title: "API access",
    points: [
      "Generate an API key to read and control subscriptions from your own systems.",
      "Endpoints cover listing subscriptions and pausing, resuming or cancelling one.",
      "You can also update a subscription's next billing date.",
      "Revoke a key at any time — it stops working immediately.",
    ],
  },
];

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const record      = await getShopPlanFromDB(session.shop);
  const planMeta    = PLANS[record.plan];

  // "none" (fresh install, no plan approved yet) has no catalog entry. Fall back
  // to the slowest queue rather than rendering a blank support promise.
  const tier = planMeta?.supportTier ?? "email";

  return json({
    shop:         session.shop,
    planLabel:    planMeta?.label ?? "No plan",
    tier,
    responseTime: RESPONSE_TIME[tier],
    supportEmail: SUPPORT_EMAIL,
    supportHours: SUPPORT_HOURS,
  });
}

// ─── Page ─────────────────────────────────────────────────────
export default function SupportPage() {
  const { shop, planLabel, tier, responseTime, supportEmail, supportHours } =
    useLoaderData<typeof loader>();

  const [copied, setCopied]   = useState<"email" | "details" | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const isPriority = tier === "priority";

  // Everything a first reply usually needs, so the merchant does not get asked
  // for it in a round trip.
  const diagnostics = `Shop: ${shop}\nPlan: ${planLabel}\nApp: Smart Subscriptions`;

  async function copy(text: string, which: "email" | "details") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard is blocked in some embedded contexts — the value is on screen
      // and selectable either way, so there is nothing useful to recover to.
    }
  }

  const card: React.CSSProperties = {
    background:   "var(--p-color-bg-surface)",
    border:       "0.5px solid var(--p-color-border)",
    borderRadius: "12px",
    padding:      "20px",
  };

  const btn: React.CSSProperties = {
    fontSize: "12px", padding: "7px 14px", borderRadius: "8px",
    cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
    display: "inline-flex", alignItems: "center", gap: "6px",
  };

  return (
    <Page>
      <TitleBar title="Help and Support" />
      <BlockStack gap="500">

        {/* ── Header ─────────────────────────────────────────── */}
        <BlockStack gap="100">
          <InlineStack gap="150" blockAlign="center">
            <span style={{
              width: "6px", height: "6px", borderRadius: "50%",
              background: T.purple, display: "inline-block", flexShrink: 0,
            }} />
            <div className="breadcrumbs-dashboard">
              <Text as="span" variant="bodySm" tone="subdued">
                Smart Subscriptions › <span className="subscription">Help and Support</span>
              </Text>
            </div>
          </InlineStack>
          <div className="varient-section">
            <Text as="h1" variant="headingXl" fontWeight="bold">Help and Support</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Guides for setting up and running subscriptions, answers to common questions, and a real person when you need one.
            </Text>
          </div>
        </BlockStack>

        {/* ── Contact ────────────────────────────────────────── */}
        <div className="hover-card" style={{ ...card, background: T.purpleBg, border: `0.5px solid ${T.purple}` }}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="start" wrap={false}>
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd" fontWeight="bold">Email us</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  The fastest way to reach us. Include your shop domain so we can look up your account.
                </Text>
              </BlockStack>
              <span style={{
                fontSize: "10px", fontWeight: 700, padding: "3px 10px", borderRadius: "20px",
                background: isPriority ? T.greenBg : "var(--p-color-bg-surface)",
                color:      isPriority ? T.greenFg : T.purpleFg,
                letterSpacing: "0.03em", whiteSpace: "nowrap", flexShrink: 0,
              }}>
                {isPriority ? "PRIORITY" : "EMAIL"} SUPPORT
              </span>
            </InlineStack>

            <div style={{
              display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap",
              background: "var(--p-color-bg-surface)", borderRadius: "10px",
              padding: "12px 16px", border: "0.5px solid var(--p-color-border)",
            }}>
              <a
                href={`mailto:${supportEmail}`}
                style={{ fontSize: "15px", fontWeight: 600, color: T.purpleFg, textDecoration: "none", wordBreak: "break-all" }}
              >
                {supportEmail}
              </a>
              <button
                onClick={() => copy(supportEmail, "email")}
                style={{ ...btn, marginLeft: "auto", border: "0.5px solid var(--p-color-border-secondary)", background: "var(--p-color-bg-surface)" }}
              >
                {copied === "email" ? "✓ Copied" : "Copy"}
              </button>
            </div>

            <InlineStack gap="500" wrap>
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">Response time</Text>
                <Text as="span" variant="bodySm" fontWeight="semibold">{responseTime}</Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">Support hours</Text>
                <Text as="span" variant="bodySm" fontWeight="semibold">{supportHours}</Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">Your plan</Text>
                <Text as="span" variant="bodySm" fontWeight="semibold">{planLabel}</Text>
              </BlockStack>
            </InlineStack>
          </BlockStack>
        </div>

        {/* ── Details to include ─────────────────────────────── */}
        <div className="hover-card" style={card}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="050">
                <Text as="h2" variant="headingMd" fontWeight="bold">Include this in your message</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Paste these details and we can usually answer on the first reply.
                </Text>
              </BlockStack>
              <button
                onClick={() => copy(diagnostics, "details")}
                style={{ ...btn, border: "0.5px solid var(--p-color-border-secondary)", background: "var(--p-color-bg-surface)", flexShrink: 0 }}
              >
                {copied === "details" ? "✓ Copied" : "Copy details"}
              </button>
            </InlineStack>
            <pre style={{
              margin: 0, padding: "14px 16px", borderRadius: "10px",
              background: "var(--p-color-bg-surface-secondary)",
              border: "0.5px solid var(--p-color-border)",
              fontSize: "12px", lineHeight: 1.7, overflowX: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              color: "var(--p-color-text)",
            }}>
              {diagnostics}
            </pre>
            <Text as="p" variant="bodySm" tone="subdued">
              If your question is about one subscription, add its ID from the Subscriptions page.
            </Text>
          </BlockStack>
        </div>

        {/* ── Getting started ────────────────────────────────── */}
        <div className="hover-card" style={card}>
          <BlockStack gap="400">
            <BlockStack gap="050">
              <Text as="h2" variant="headingMd" fontWeight="bold">Getting started</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Five steps from a fresh install to your first live subscription.
              </Text>
            </BlockStack>

            <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
              {STEPS.map((step, i) => (
                <div key={i} style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
                  <span style={{
                    width: "26px", height: "26px", borderRadius: "50%", flexShrink: 0,
                    background: T.purpleBg, color: T.purpleFg,
                    fontSize: "12px", fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {i + 1}
                  </span>
                  <div style={{ minWidth: 0, maxWidth: "72ch" }}>
                    <Text as="h3" variant="bodySm" fontWeight="semibold">{step.title}</Text>
                    <div style={{ marginTop: "3px" }}>
                      <Text as="p" variant="bodySm" tone="subdued">{step.body}</Text>
                    </div>
                    {step.to && (
                      <a
                        href={step.to}
                        style={{
                          display: "inline-block", marginTop: "6px", fontSize: "12px",
                          fontWeight: 600, color: T.purpleFg, textDecoration: "none",
                        }}
                      >
                        {step.linkLabel} →
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </BlockStack>
        </div>

        {/* ── Help topics ────────────────────────────────────── */}
        <div className="hover-card" style={card}>
          <BlockStack gap="400">
            <BlockStack gap="050">
              <Text as="h2" variant="headingMd" fontWeight="bold">Help topics</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                How each part of the app behaves, in short.
              </Text>
            </BlockStack>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
              {TOPICS.map((topic) => (
                <div
                  key={topic.title}
                  style={{
                    border: "0.5px solid var(--p-color-border)",
                    borderRadius: "10px", padding: "16px",
                    background: "var(--p-color-bg-surface)",
                  }}
                >
                  <InlineStack gap="200" blockAlign="center">
                    <span style={{
                      width: "28px", height: "28px", borderRadius: "8px", flexShrink: 0,
                      background: T.purpleBg, color: T.purpleFg, fontSize: "13px",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {topic.icon}
                    </span>
                    <Text as="h3" variant="bodySm" fontWeight="semibold">{topic.title}</Text>
                  </InlineStack>

                  <ul style={{ margin: "12px 0 0", padding: 0, listStyle: "none" }}>
                    {topic.points.map((point, i) => (
                      <li key={i} style={{ display: "flex", gap: "8px", marginTop: i === 0 ? 0 : "8px" }}>
                        <span style={{ color: T.greenDot, fontSize: "11px", flexShrink: 0, marginTop: "3px" }}>◆</span>
                        <Text as="span" variant="bodySm" tone="subdued">{point}</Text>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </BlockStack>
        </div>

        {/* ── FAQ ────────────────────────────────────────────── */}
        <div className="hover-card" style={{ ...card, padding: "20px 20px 8px" }}>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd" fontWeight="bold">Common questions</Text>
            <div>
              {FAQS.map((faq, i) => {
                const open = openFaq === i;
                return (
                  <div key={i} style={{ borderBottom: "0.5px solid var(--p-color-border-secondary)" }}>
                    <button
                      onClick={() => setOpenFaq(open ? null : i)}
                      aria-expanded={open}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", gap: "12px",
                        justifyContent: "space-between", background: "none", border: "none",
                        padding: "14px 0", cursor: "pointer", textAlign: "left",
                        font: "inherit", color: "var(--p-color-text)",
                      }}
                    >
                      <span style={{ fontSize: "13px", fontWeight: 500 }}>{faq.q}</span>
                      <span style={{
                        color: T.purpleFg, fontSize: "14px", flexShrink: 0,
                        transform: open ? "rotate(45deg)" : "none", transition: "transform 0.15s",
                      }}>
                        +
                      </span>
                    </button>
                    {open && (
                      <div style={{ padding: "0 0 16px", maxWidth: "70ch" }}>
                        <Text as="p" variant="bodySm" tone="subdued">{faq.a}</Text>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </BlockStack>
        </div>

        {!isPriority && (
          <div style={{
            background: T.blueBg, border: "0.5px solid #A8CFEC",
            borderRadius: "12px", padding: "14px 18px",
          }}>
            <Text as="p" variant="bodySm">
              Need faster replies? <strong>Pro</strong> and <strong>Advanced</strong> include priority
              support with a {RESPONSE_TIME.priority.toLowerCase()} response time.{" "}
              <a href="/app/billing" style={{ color: T.blueFg, fontWeight: 600 }}>Compare plans →</a>
            </Text>
          </div>
        )}

      </BlockStack>
    </Page>
  );
}
