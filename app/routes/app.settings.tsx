// app/routes/app.settings.tsx

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { useState, useCallback, useEffect } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Checkbox,
  Select,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
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

// ─── Default settings shape ───────────────────────────────────
const DEFAULTS = {
  notifyOnBillingFailure:  true,
  notifyOnCancellation:    true,
  notifyOnNewSubscription: false,
  notificationEmail:       "",
  maxBillingRetries:       3,
  gracePeriodDays:         7,
  allowCustomerPause:      true,
  allowCustomerCancel:     true,
};

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const settings = await prisma.appSettings.findUnique({ where: { shop: session.shop } });
  return json({ settings: settings ?? { ...DEFAULTS, shop: session.shop } });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form        = await request.formData();

  const data = {
    notifyOnBillingFailure:  form.get("notifyOnBillingFailure")  === "true",
    notifyOnCancellation:    form.get("notifyOnCancellation")    === "true",
    notifyOnNewSubscription: form.get("notifyOnNewSubscription") === "true",
    notificationEmail:       (form.get("notificationEmail") as string) ?? "",
    maxBillingRetries:       parseInt(form.get("maxBillingRetries") as string, 10) || 3,
    gracePeriodDays:         parseInt(form.get("gracePeriodDays")   as string, 10) || 7,
    allowCustomerPause:      form.get("allowCustomerPause")  === "true",
    allowCustomerCancel:     form.get("allowCustomerCancel") === "true",
  };

  if (data.maxBillingRetries < 1 || data.maxBillingRetries > 10)
    return json({ error: "Max billing retries must be between 1 and 10." });
  if (data.gracePeriodDays < 1 || data.gracePeriodDays > 90)
    return json({ error: "Grace period must be between 1 and 90 days." });
  if (data.notificationEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.notificationEmail))
    return json({ error: "Please enter a valid notification email address." });

  await prisma.appSettings.upsert({
    where:  { shop: session.shop },
    update: data,
    create: { shop: session.shop, ...data },
  });

  return json({ success: true });
}

type TabKey = "general" | "billing" | "portal" | "webhooks";

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "general",  label: "General",        icon: "⚙️" },
  { key: "billing",  label: "Billing",         icon: "💳" },
  { key: "portal",   label: "Customer Portal", icon: "👤" },
  { key: "webhooks", label: "Webhooks",        icon: "🔗" },
];

const WEBHOOKS = [
  "Subscription Contracts Create",
  "Subscription Contracts Update",
  "Subscription Billing Attempts Success",
  "Subscription Billing Attempts Failure",
  "App Uninstalled",
];

// ─── Component ────────────────────────────────────────────────
export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();
  const actionData   = useActionData<typeof action>();
  const navigation   = useNavigation();
  const submit       = useSubmit();
  const isSaving     = navigation.state === "submitting";

  const [activeTab,     setActiveTab]     = useState<TabKey>("general");
  const [notifyBilling, setNotifyBilling] = useState(settings.notifyOnBillingFailure);
  const [notifyCancel,  setNotifyCancel]  = useState(settings.notifyOnCancellation);
  const [notifyNew,     setNotifyNew]     = useState(settings.notifyOnNewSubscription);
  const [notifyEmail,   setNotifyEmail]   = useState(settings.notificationEmail ?? "");
  const [maxRetries,    setMaxRetries]    = useState(String(settings.maxBillingRetries));
  const [gracePeriod,   setGracePeriod]   = useState(String(settings.gracePeriodDays));
  const [allowPause,    setAllowPause]    = useState(settings.allowCustomerPause);
  const [allowCancel,   setAllowCancel]   = useState(settings.allowCustomerCancel);
  const [showSaved,     setShowSaved]     = useState(false);

  useEffect(() => {
    if (actionData && "success" in actionData) {
      setShowSaved(true);
      const t = setTimeout(() => setShowSaved(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleSave = useCallback(() => {
    const fd = new FormData();
    fd.append("notifyOnBillingFailure",  String(notifyBilling));
    fd.append("notifyOnCancellation",    String(notifyCancel));
    fd.append("notifyOnNewSubscription", String(notifyNew));
    fd.append("notificationEmail",       notifyEmail);
    fd.append("maxBillingRetries",       maxRetries);
    fd.append("gracePeriodDays",         gracePeriod);
    fd.append("allowCustomerPause",      String(allowPause));
    fd.append("allowCustomerCancel",     String(allowCancel));
    submit(fd, { method: "post" });
  }, [notifyBilling, notifyCancel, notifyNew, notifyEmail, maxRetries, gracePeriod, allowPause, allowCancel, submit]);

  const retryOptions = Array.from({ length: 10 }, (_, i) => ({
    label: `${i + 1} attempt${i > 0 ? "s" : ""}`,
    value: String(i + 1),
  }));

  const graceOptions = [1, 2, 3, 5, 7, 14, 21, 30, 60, 90].map((d) => ({
    label: `${d} day${d > 1 ? "s" : ""}`,
    value: String(d),
  }));

  const card: React.CSSProperties = {
    background: "var(--p-color-bg-surface)",
    border: "0.5px solid var(--p-color-border)",
    borderRadius: "14px",
    padding: "20px 22px",
  };

  const btn: React.CSSProperties = {
    fontSize: "13px", padding: "8px 18px", borderRadius: "9px",
    cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
    display: "inline-flex", alignItems: "center", gap: "6px",
  };

  function SectionHeader({ icon, title, sub }: { icon: string; title: string; sub: string }) {
    return (
      <div style={{ marginBottom: "18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
          <span style={{ fontSize: "16px" }}>{icon}</span>
          <Text as="h2" variant="headingMd" fontWeight="semibold">{title}</Text>
        </div>
        <Text as="p" variant="bodySm" tone="subdued">{sub}</Text>
      </div>
    );
  }

  function StatusPill({ on, onLabel = "On", offLabel = "Off" }: { on: boolean; onLabel?: string; offLabel?: string }) {
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: "4px",
        fontSize: "11px", fontWeight: 600,
        padding: "2px 10px", borderRadius: "20px",
        background: on ? T.greenBg : "var(--p-color-bg-surface-secondary)",
        color: on ? T.greenFg : "var(--p-color-text-subdued)",
      }}>
        {on ? onLabel : offLabel}
      </span>
    );
  }

  function ConfigRow({ label, right }: { label: string; right: React.ReactNode }) {
    return (
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "7px 0", borderBottom: "0.5px solid var(--p-color-border-secondary)",
      }}>
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
        {right}
      </div>
    );
  }

  const showNotifications = activeTab === "general";
  const showBilling       = activeTab === "general" || activeTab === "billing";
  const showPortal        = activeTab === "general" || activeTab === "portal";
  const showWebhooks      = activeTab === "webhooks";

  return (
    <Page>
      <TitleBar title="Settings" />
      <BlockStack gap="500">

        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <BlockStack gap="100">
            <InlineStack gap="150" blockAlign="center">
              <span style={{
                width: "6px", height: "6px", borderRadius: "50%",
                background: T.purple, display: "inline-block", flexShrink: 0,
              }} />
              <div className="breadcrumbs-dashboard">
                <Text as="span" variant="bodySm" tone="subdued">
                  Smart Subscriptions › <span className="subscription">Settings</span>
                </Text>
              </div>
            </InlineStack>
            <div className="varient-section">
              <Text as="h1" variant="headingXl" fontWeight="bold">Settings</Text>
              <Text as="p" variant="bodySm" tone="subdued">Configure how your subscription app works.</Text>
            </div>
          </BlockStack>
          <button
            onClick={handleSave}
            disabled={isSaving}
            style={{ ...btn, background: T.purpleDark, color: "#fff", border: "none", marginTop: "4px" }}
          >
            {isSaving ? "Saving…" : "Save Settings"}
          </button>
        </div>

        {/* ── Success / Error banners ──────────────────────────── */}
        {showSaved && (
          <div style={{
            background: T.greenBg, border: `0.5px solid ${T.greenDot}`,
            borderRadius: "10px", padding: "10px 16px",
          }}>
            <Text as="p" variant="bodySm" tone="subdued">✅ Settings saved successfully.</Text>
          </div>
        )}
        {actionData && "error" in actionData && (
          <div style={{
            background: T.redBg, border: "0.5px solid #F09595",
            borderRadius: "10px", padding: "10px 16px",
          }}>
            <Text as="p" variant="bodySm" tone="subdued">❌ {actionData.error}</Text>
          </div>
        )}

        {/* ── Tabs ─────────────────────────────────────────────── */}
        <div style={{ borderBottom: "0.5px solid var(--p-color-border)", display: "flex", gap: "2px" }}>
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: "10px 18px",
                background: "none", border: "none", cursor: "pointer",
                fontWeight: 500, fontSize: "13px",
                color: activeTab === tab.key ? T.purpleFg : "var(--p-color-text-subdued)",
                borderBottom: activeTab === tab.key ? `2px solid ${T.purple}` : "2px solid transparent",
                display: "flex", alignItems: "center", gap: "6px",
                transition: "color 0.15s",
              }}
            >
              <span style={{ fontSize: "14px" }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Two-column body ──────────────────────────────────── */}
        <div style={{ display: "flex", gap: "20px", alignItems: "flex-start" }}>

          {/* ─ Left: form sections ─────────────────────────────── */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "16px" }}>

            {/* Notifications */}
            {showNotifications && (
              <div className="hover-card" style={card}>
                <SectionHeader
                  icon="🔔"
                  title="Notifications"
                  sub="Choose which events send an alert email to you or your team."
                />
                <BlockStack gap="300">
                  <Checkbox
                    label="Billing failure"
                    helpText="Get notified when a customer's payment fails."
                    checked={notifyBilling}
                    onChange={setNotifyBilling}
                  />
                  <Checkbox
                    label="Subscription cancelled"
                    helpText="Get notified when a subscription is cancelled."
                    checked={notifyCancel}
                    onChange={setNotifyCancel}
                  />
                  <Checkbox
                    label="New subscription"
                    helpText="Get notified when a customer starts a new subscription."
                    checked={notifyNew}
                    onChange={setNotifyNew}
                  />
                </BlockStack>
                <div style={{ marginTop: "18px" }}>
                  <TextField
                    label="Notification email"
                    helpText="Leave blank to use your Shopify store owner email."
                    type="email"
                    value={notifyEmail}
                    onChange={setNotifyEmail}
                    placeholder="alerts@yourstore.com"
                    autoComplete="email"
                    disabled={!notifyBilling && !notifyCancel && !notifyNew}
                  />
                </div>
              </div>
            )}

            {/* Billing Behaviour */}
            {showBilling && (
              <div className="hover-card" style={card}>
                <SectionHeader
                  icon="🔄"
                  title="Billing Behaviour"
                  sub="Control how the app handles failed payments before cancelling a subscription."
                />
                <div style={{ display: "flex", gap: "16px" }}>
                  <div style={{ flex: 1 }}>
                    <Select
                      label="Max billing retry attempts"
                      helpText="How many times to retry a failed charge."
                      options={retryOptions}
                      value={maxRetries}
                      onChange={setMaxRetries}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Select
                      label="Grace period after final failure"
                      helpText="Days to wait after the last failed retry before cancelling."
                      options={graceOptions}
                      value={gracePeriod}
                      onChange={setGracePeriod}
                    />
                  </div>
                </div>
                <div style={{
                  marginTop: "16px",
                  background: T.blueBg, border: `0.5px solid #A8CFEC`,
                  borderRadius: "8px", padding: "10px 14px",
                  display: "flex", alignItems: "center", gap: "8px",
                }}>
                  <span style={{ color: T.blueFg, fontSize: "14px" }}>ℹ</span>
                  <Text as="p" variant="bodySm" tone="subdued">
                    <strong>Summary:</strong> Retry up to{" "}
                    <strong style={{ color: T.blueFg }}>{maxRetries} time{Number(maxRetries) > 1 ? "s" : ""}</strong>
                    , then wait{" "}
                    <strong style={{ color: T.blueFg }}>{gracePeriod} day{Number(gracePeriod) > 1 ? "s" : ""}</strong>
                    {" "}before cancelling.
                  </Text>
                </div>
              </div>
            )}

            {/* Customer Portal */}
            {showPortal && (
              <div className="hover-card" style={card}>
                <SectionHeader
                  icon="👤"
                  title="Customer Portal"
                  sub="Control what customers can do from their own account portal."
                />
                <BlockStack gap="300">
                  <Checkbox
                    label="Allow customers to pause their subscription"
                    helpText="Customers can temporarily pause billing from their account page."
                    checked={allowPause}
                    onChange={setAllowPause}
                  />
                  <Checkbox
                    label="Allow customers to cancel their subscription"
                    helpText="Customers can cancel at any time from their account page."
                    checked={allowCancel}
                    onChange={setAllowCancel}
                  />
                </BlockStack>
              </div>
            )}

            {/* Webhooks tab content */}
            {showWebhooks && (
              <div className="hover-card" style={card}>
                <SectionHeader
                  icon="🔗"
                  title="Registered Webhooks"
                  sub="These webhooks keep your subscription data in sync with Shopify."
                />
                <BlockStack gap="200">
                  {WEBHOOKS.map((w) => (
                    <div key={w} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "8px 0", borderBottom: "0.5px solid var(--p-color-border-secondary)",
                    }}>
                      <Text as="span" variant="bodySm">{w}</Text>
                      <span style={{
                        fontSize: "11px", fontWeight: 600,
                        padding: "2px 10px", borderRadius: "20px",
                        background: T.greenBg, color: T.greenFg,
                      }}>
                        Active
                      </span>
                    </div>
                  ))}
                </BlockStack>
              </div>
            )}

          </div>

          {/* ─ Right: sidebar ──────────────────────────────────── */}
          <div style={{ width: "255px", flexShrink: 0, display: "flex", flexDirection: "column", gap: "16px" }}>

            {/* Current Configuration */}
            <div className="hover-card" style={card}>
              <Text as="h3" variant="headingSm" fontWeight="semibold">Current Configuration</Text>
              <div style={{ marginTop: "12px" }}>
                <ConfigRow label="Billing failure alert"    right={<StatusPill on={notifyBilling} />} />
                <ConfigRow label="Cancellation alert"       right={<StatusPill on={notifyCancel} />} />
                <ConfigRow label="New subscription alert"   right={<StatusPill on={notifyNew} />} />
                <ConfigRow
                  label="Max retries"
                  right={
                    <Text as="span" variant="bodySm" fontWeight="semibold">{maxRetries}x</Text>
                  }
                />
                <ConfigRow
                  label="Grace period"
                  right={
                    <Text as="span" variant="bodySm" fontWeight="semibold">{gracePeriod}d</Text>
                  }
                />
                <ConfigRow label="Customer can pause"  right={<StatusPill on={allowPause}  onLabel="Yes" offLabel="No" />} />
                <ConfigRow label="Customer can cancel" right={<StatusPill on={allowCancel} onLabel="Yes" offLabel="No" />} />
              </div>
            </div>

            {/* Registered Webhooks */}
            <div className="hover-card" style={card}>
              <Text as="h3" variant="headingSm" fontWeight="semibold">Registered Webhooks</Text>
              <div style={{ marginTop: "12px" }}>
                {WEBHOOKS.map((w) => (
                  <div key={w} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "6px 0", borderBottom: "0.5px solid var(--p-color-border-secondary)",
                  }}>
                    <Text as="span" variant="bodySm" tone="subdued">{w}</Text>
                    <span style={{
                      fontSize: "10px", fontWeight: 600,
                      padding: "2px 8px", borderRadius: "20px",
                      background: T.greenBg, color: T.greenFg,
                    }}>
                      Active
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

