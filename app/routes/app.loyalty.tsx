// app/routes/app.automations.loyalty.tsx

import { useState, useEffect } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useNavigation, useSubmit, useNavigate } from "@remix-run/react";
import { Page, BlockStack, InlineStack, Text, TextField, Select } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import dashboardStyles from "../styles/dashboard.css?url";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];

const T = {
  purple:    "#7F77DD",
  purpleBg:  "#EEEDFE",
  purpleDark:"#26215C",
  purpleFg:  "#3C3489",
  greenBg:   "#EAF3DE",
  greenFg:   "#27500A",
  amberBg:   "#FAEEDA",
  amberFg:   "#633806",
  redBg:     "#FCEBEB",
  redFg:     "#791F1F",
};

const RENEWAL_OPTIONS = [
  { label: "1st renewal",  value: "1"  },
  { label: "2nd renewal",  value: "2"  },
  { label: "3rd renewal",  value: "3"  },
  { label: "4th renewal",  value: "4"  },
  { label: "5th renewal",  value: "5"  },
  { label: "6th renewal",  value: "6"  },
  { label: "10th renewal", value: "10" },
  { label: "12th renewal", value: "12" },
];

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shopPlan = await prisma.shopPlan.findUnique({ where: { shop: session.shop } });
  const tier = shopPlan?.plan ?? "free";
  const hasAccess = tier === "pro" || tier === "advanced";

  const loyalty = (await prisma.loyaltyDiscount.findUnique({
    where: { shop: session.shop },
  }) as any) ?? null;

  return json({ hasAccess, tier, loyalty });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const shopPlan = await prisma.shopPlan.findUnique({ where: { shop: session.shop } });
  const tier = shopPlan?.plan ?? "free";
  if (tier !== "pro" && tier !== "advanced") {
    return json({ ok: false, error: "Upgrade to Pro or Advanced to use loyalty discounts." });
  }

  const data = {
    name:           (form.get("name") as string)?.trim() || "Loyalty discount",
    applyOnRenewal: parseInt(form.get("applyOnRenewal") as string, 10) || 1,
    discountValue:  parseFloat(form.get("discountValue") as string) || 10,
    enabled:        form.get("enabled") === "true",
  };

  if (data.discountValue < 1 || data.discountValue > 100) {
    return json({ ok: false, error: "Discount value must be between 1 and 100." });
  }

  await (prisma as any).loyaltyDiscount.upsert({
    where:  { shop: session.shop },
    update: data,
    create: { shop: session.shop, ...data },
  });

  return json({ ok: true });
}

// ─── Page ─────────────────────────────────────────────────────
export default function LoyaltyDiscountPage() {
  const { hasAccess, tier, loyalty } = useLoaderData<typeof loader>();
  const actionData  = useActionData<typeof action>();
  const navigation  = useNavigation();
  const submitFn    = useSubmit();
  const navigate    = useNavigate();
  const isSaving    = navigation.state === "submitting";

  const [name,          setName]          = useState((loyalty as any)?.name          ?? "Loyalty discount");
  const [applyOn,       setApplyOn]       = useState(String((loyalty as any)?.applyOnRenewal ?? "1"));
  const [discountValue, setDiscountValue] = useState(String((loyalty as any)?.discountValue  ?? "10"));
  const [enabled,       setEnabled]       = useState((loyalty as any)?.enabled       ?? false);
  const [savedBanner,   setSavedBanner]   = useState(false);

  useEffect(() => {
    if (actionData && "ok" in actionData && (actionData as any).ok) {
      setSavedBanner(true);
      const t = setTimeout(() => setSavedBanner(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  function handleSave() {
    const fd = new FormData();
    fd.append("name",           name);
    fd.append("applyOnRenewal", applyOn);
    fd.append("discountValue",  discountValue);
    fd.append("enabled",        String(enabled));
    submitFn(fd, { method: "post" });
  }

  const card: React.CSSProperties = {
    background: "var(--p-color-bg-surface)",
    border: "0.5px solid var(--p-color-border)",
    borderRadius: "14px", padding: "22px",
  };

  return (
    <Page>
      <TitleBar title="Loyalty Discount" />
      <BlockStack gap="500">

        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <BlockStack gap="100">
            <InlineStack gap="150" blockAlign="center">
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: T.purple, display: "inline-block", flexShrink: 0 }} />
              <div className="breadcrumbs-dashboard">
                <Text as="span" variant="bodySm" tone="subdued">
                  Smart Subscriptions › Automations › <span className="subscription">Loyalty Discount</span>
                </Text>
              </div>
            </InlineStack>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <button
                onClick={() => navigate("/app/automations")}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: "18px", color: "var(--p-color-text-subdued)", padding: "0",
                }}
              >
                ←
              </button>
              <Text as="h1" variant="headingXl" fontWeight="bold">Loyalty discount</Text>
            </div>
          </BlockStack>

          <button
            onClick={handleSave}
            disabled={isSaving || !hasAccess}
            style={{
              fontSize: "13px", padding: "8px 18px", borderRadius: "9px",
              background: savedBanner ? T.greenFg : T.purpleDark,
              color: "#fff", border: "none",
              cursor: isSaving || !hasAccess ? "not-allowed" : "pointer",
              fontWeight: 500, marginTop: "4px",
              opacity: !hasAccess ? 0.5 : isSaving ? 0.7 : 1,
              transition: "background 0.3s",
            }}
          >
            {isSaving ? "Saving…" : savedBanner ? "✓ Saved!" : "Save loyalty discount"}
          </button>
        </div>

        {/* ── Plan gate banner ─────────────────────────────────── */}
        {!hasAccess && (
          <div style={{
            background: T.amberBg, border: "0.5px solid #DEB96A",
            borderRadius: "12px", padding: "16px 18px",
            display: "flex", gap: "12px", alignItems: "flex-start",
          }}>
            <span style={{ fontSize: "20px", flexShrink: 0 }}>⚠️</span>
            <div style={{ flex: 1 }}>
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                This functionality is available only on Pro or Advanced plan
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Upgrade your plan to create loyalty discounts for your subscribers. Loyalty discounts
                reward customers for keeping their subscription active.
              </Text>
            </div>
            <a
              href="/app/billing"
              style={{
                fontSize: "12px", fontWeight: 600,
                color: T.amberFg, background: "#fff",
                border: "0.5px solid #DEB96A", borderRadius: "8px",
                padding: "6px 14px", textDecoration: "none",
                whiteSpace: "nowrap", flexShrink: 0,
              }}
            >
              Upgrade plan →
            </a>
          </div>
        )}

        {/* ── Error banner ─────────────────────────────────────── */}
        {actionData && "error" in actionData && (actionData as any).error && (
          <div style={{ background: T.redBg, border: "0.5px solid #F09595", borderRadius: "10px", padding: "12px 16px" }}>
            <Text as="p" variant="bodySm">❌ {(actionData as any).error}</Text>
          </div>
        )}

        {/* ── Form ─────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: "20px", alignItems: "flex-start" }}>

          {/* Left: settings */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "16px" }}>

            {/* Enable toggle */}
            <div className="hover-card" style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <Text as="p" variant="bodyMd" fontWeight="semibold">Enable loyalty discount</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    When enabled, subscribers will receive this discount on the configured renewal.
                  </Text>
                </div>
                <div
                  onClick={() => hasAccess && setEnabled(!enabled)}
                  style={{
                    width: "44px", height: "26px", borderRadius: "13px",
                    background: enabled ? T.purpleDark : "#d1d5db",
                    position: "relative", cursor: hasAccess ? "pointer" : "not-allowed",
                    transition: "background 0.2s", flexShrink: 0,
                  }}
                >
                  <div style={{
                    position: "absolute", top: "3px",
                    left: enabled ? "21px" : "3px",
                    width: "20px", height: "20px", borderRadius: "50%",
                    background: "#fff", transition: "left 0.2s",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                  }} />
                </div>
              </div>
            </div>

            {/* Discount settings */}
            <div className="hover-card" style={card}>
              <Text as="h2" variant="headingMd" fontWeight="semibold">Discount settings</Text>
              <Text as="p" variant="bodySm" tone="subdued">Configure when and how much discount to give.</Text>

              <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
                <TextField
                  label="Discount name"
                  helpText="This name will show up in the customer portal."
                  value={name}
                  onChange={setName}
                  autoComplete="off"
                  disabled={!hasAccess}
                />

                <Select
                  label="Apply this discount on"
                  helpText="The discount will apply only on this specific renewal and will then be removed."
                  options={RENEWAL_OPTIONS}
                  value={applyOn}
                  onChange={setApplyOn}
                  disabled={!hasAccess}
                />

                <TextField
                  label="Discount value (%)"
                  helpText="Set the percentage discount to apply on the specified renewal."
                  type="number"
                  value={discountValue}
                  onChange={setDiscountValue}
                  suffix="%"
                  autoComplete="off"
                  disabled={!hasAccess}
                />
              </div>
            </div>

          </div>

          {/* Right: info */}
          <div style={{ width: "260px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "16px" }}>

            <div className="hover-card" style={card}>
              <Text as="h3" variant="headingSm" fontWeight="semibold">How it works</Text>
              <div style={{ marginTop: "14px", display: "flex", flexDirection: "column", gap: "12px" }}>
                {[
                  { icon: "1️⃣", text: "Customer subscribes to a product" },
                  { icon: "2️⃣", text: `On the ${RENEWAL_OPTIONS.find(o => o.value === applyOn)?.label ?? "1st renewal"}, the discount is applied automatically` },
                  { icon: "3️⃣", text: `Customer gets ${discountValue}% off that specific billing cycle` },
                  { icon: "4️⃣", text: "After that renewal, discount is removed and normal pricing resumes" },
                ].map((step, i) => (
                  <div key={i} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                    <span style={{ fontSize: "16px", flexShrink: 0 }}>{step.icon}</span>
                    <Text as="p" variant="bodySm" tone="subdued">{step.text}</Text>
                  </div>
                ))}
              </div>
            </div>

            <div className="hover-card" style={{
              ...card,
              background: T.purpleBg,
              border: `0.5px solid #C8C3F2`,
            }}>
              <Text as="h3" variant="headingSm" fontWeight="semibold">
                <span style={{ color: T.purpleFg }}>Current status</span>
              </Text>
              <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                {[
                  { label: "Status",   value: enabled ? "Active" : "Inactive", green: enabled },
                  { label: "Triggers", value: `${RENEWAL_OPTIONS.find(o => o.value === applyOn)?.label ?? "1st renewal"}` },
                  { label: "Discount", value: `${discountValue}% off` },
                ].map((row) => (
                  <div key={row.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "0.5px solid #C8C3F2" }}>
                    <Text as="span" variant="bodySm" tone="subdued">{row.label}</Text>
                    <span style={{
                      fontSize: "12px", fontWeight: 600,
                      color: row.green ? T.greenFg : T.purpleFg,
                      background: row.green ? T.greenBg : "#fff",
                      padding: "2px 8px", borderRadius: "20px",
                    }}>
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>

      </BlockStack>
    </Page>
  );
}

