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
} from "@shopify/polaris";
import { Select } from "../components/AppSelect";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { encryptSecret, encryptionConfigured } from "../lib/secret-box.server";
import { sendSmtpTestEmail } from "../lib/payment-email.server";
import {
  PREPAID_EMAIL_DEFAULTS,
  PREPAID_EMAIL_PLACEHOLDERS,
  PREPAID_MESSAGE_MAX,
  PREPAID_SUBJECT_MAX,
  type PrepaidEmailKind,
} from "../config/payment";
import dashboardStyles from "../styles/dashboard.css?url";
import { BRAND_GRADIENT } from "../config/theme";
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
  prepaidPayWindowDays:    7,
  prepaidInvoiceLeadDays:  3,
  smtpHost:                "",
  smtpPort:                587,
  smtpSecure:              false,
  smtpUser:                "",
  smtpFrom:                "",
  // "" / null = the built-in wording (PREPAID_EMAIL_DEFAULTS).
  prepaidInitialSubject:   "",
  prepaidInitialMessage:   null as string | null,
  prepaidRenewalSubject:   "",
  prepaidRenewalMessage:   null as string | null,
  prepaidReminderSubject:  "",
  prepaidReminderMessage:  null as string | null,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The three editable prepaid emails, in the order the page shows them.
const EMAIL_SECTIONS: Array<{
  kind: PrepaidEmailKind; title: string; hint: string;
  subjectField: "prepaidInitialSubject" | "prepaidRenewalSubject" | "prepaidReminderSubject";
  messageField: "prepaidInitialMessage" | "prepaidRenewalMessage" | "prepaidReminderMessage";
}> = [
  { kind: "initial",  title: "First payment",        hint: "Sent when you create a prepaid subscription for a customer.",
    subjectField: "prepaidInitialSubject",  messageField: "prepaidInitialMessage" },
  { kind: "renewal",  title: "Before each delivery", hint: "Sent before every renewal of a prepaid subscription.",
    subjectField: "prepaidRenewalSubject",  messageField: "prepaidRenewalMessage" },
  { kind: "reminder", title: "Reminder",             hint: "Sent halfway through the payment window if the link is still unpaid.",
    subjectField: "prepaidReminderSubject", messageField: "prepaidReminderMessage" },
];

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const row = await prisma.appSettings.findUnique({ where: { shop: session.shop } });

  // The SMTP password never leaves the server, not even encrypted. The page only
  // needs to know whether one is stored.
  const { smtpPassEnc, ...settings } = row ?? { ...DEFAULTS, shop: session.shop, smtpPassEnc: null };

  return json({
    settings,
    smtpPasswordSet: !!smtpPassEnc,
    encryptionReady: encryptionConfigured(),
  });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form        = await request.formData();

  // ── Send a test email through the SAVED SMTP settings ──────
  // It is a sample of the "before each delivery" email in the SAVED wording, so
  // it checks the server and previews the text in one go.
  if (form.get("intent") === "test-smtp") {
    const to = ((form.get("testEmailTo") as string) ?? "").trim();
    if (!EMAIL_RE.test(to)) return json({ error: "Enter an address to send the test email to." });
    let shopName = session.shop;
    try {
      const res  = await admin.graphql(`#graphql
        query SettingsShopName { shop { name } }`);
      const body = await res.json() as { data?: { shop?: { name?: string } } };
      shopName   = body.data?.shop?.name || shopName;
    } catch { /* the domain will do for a test */ }
    try {
      await sendSmtpTestEmail(session.shop, to, shopName);
      return json({ testSent: to });
    } catch (err) {
      return json({ error: `Test email failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const data = {
    notifyOnBillingFailure:  form.get("notifyOnBillingFailure")  === "true",
    notifyOnCancellation:    form.get("notifyOnCancellation")    === "true",
    notifyOnNewSubscription: form.get("notifyOnNewSubscription") === "true",
    notificationEmail:       (form.get("notificationEmail") as string) ?? "",
    maxBillingRetries:       parseInt(form.get("maxBillingRetries") as string, 10) || 3,
    gracePeriodDays:         parseInt(form.get("gracePeriodDays")   as string, 10) || 7,
    allowCustomerPause:      form.get("allowCustomerPause")  === "true",
    allowCustomerCancel:     form.get("allowCustomerCancel") === "true",
    prepaidPayWindowDays:    parseInt(form.get("prepaidPayWindowDays")   as string, 10) || 7,
    prepaidInvoiceLeadDays:  parseInt(form.get("prepaidInvoiceLeadDays") as string, 10) || 0,
    smtpHost:                ((form.get("smtpHost") as string) ?? "").trim(),
    smtpPort:                parseInt(form.get("smtpPort") as string, 10) || 587,
    smtpSecure:              form.get("smtpSecure") === "true",
    smtpUser:                ((form.get("smtpUser") as string) ?? "").trim(),
    smtpFrom:                ((form.get("smtpFrom") as string) ?? "").trim(),
    // Blank = default wording. Messages are stored as NULL rather than "" so
    // an unset one is unmistakable.
    prepaidInitialSubject:   ((form.get("prepaidInitialSubject")  as string) ?? "").trim(),
    prepaidRenewalSubject:   ((form.get("prepaidRenewalSubject")  as string) ?? "").trim(),
    prepaidReminderSubject:  ((form.get("prepaidReminderSubject") as string) ?? "").trim(),
    prepaidInitialMessage:   ((form.get("prepaidInitialMessage")  as string) ?? "").trim() || null,
    prepaidRenewalMessage:   ((form.get("prepaidRenewalMessage")  as string) ?? "").trim() || null,
    prepaidReminderMessage:  ((form.get("prepaidReminderMessage") as string) ?? "").trim() || null,
  };

  for (const section of EMAIL_SECTIONS) {
    if (data[section.subjectField].length > PREPAID_SUBJECT_MAX)
      return json({ error: `The "${section.title}" subject can be at most ${PREPAID_SUBJECT_MAX} characters.` });
    if ((data[section.messageField] ?? "").length > PREPAID_MESSAGE_MAX)
      return json({ error: `The "${section.title}" message can be at most ${PREPAID_MESSAGE_MAX} characters.` });
  }

  if (data.maxBillingRetries < 1 || data.maxBillingRetries > 10)
    return json({ error: "Max billing retries must be between 1 and 10." });
  if (data.gracePeriodDays < 1 || data.gracePeriodDays > 90)
    return json({ error: "Grace period must be between 1 and 90 days." });
  if (data.notificationEmail && !EMAIL_RE.test(data.notificationEmail))
    return json({ error: "Please enter a valid notification email address." });
  if (data.prepaidPayWindowDays < 1 || data.prepaidPayWindowDays > 30)
    return json({ error: "The payment window must be between 1 and 30 days." });
  if (data.prepaidInvoiceLeadDays < 0 || data.prepaidInvoiceLeadDays > 14)
    return json({ error: "Send the payment link between 0 and 14 days before the billing date." });
  if (data.smtpPort < 1 || data.smtpPort > 65535)
    return json({ error: "Enter a valid SMTP port." });
  // Accepts both "you@shop.com" and "Your Shop <you@shop.com>".
  if (data.smtpFrom && !EMAIL_RE.test(data.smtpFrom.replace(/^.*<([^>]+)>\s*$/, "$1")))
    return json({ error: "The From address must be a valid email, e.g. Your Shop <orders@yourshop.com>." });

  // Password: blank leaves the stored one alone, since the page never has it to
  // send back. "Remove password" clears it explicitly.
  const newPassword = (form.get("smtpPassword") as string) ?? "";
  let smtpPassEnc: string | null | undefined;
  if (form.get("smtpClearPassword") === "true") {
    smtpPassEnc = null;
  } else if (newPassword) {
    if (!encryptionConfigured())
      return json({ error: "The server has no APP_ENCRYPTION_KEY, so the SMTP password can't be stored safely. Ask your developer to set it." });
    smtpPassEnc = encryptSecret(newPassword);
  }

  const write = smtpPassEnc === undefined ? data : { ...data, smtpPassEnc };

  await prisma.appSettings.upsert({
    where:  { shop: session.shop },
    update: write,
    create: { shop: session.shop, ...write },
  });

  return json({ success: true });
}

type TabKey = "general" | "billing" | "prepaid" | "portal" | "webhooks";

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "general",  label: "General",         icon: "⚙️" },
  { key: "billing",  label: "Billing",         icon: "💳" },
  { key: "prepaid",  label: "Prepaid & email", icon: "✉️" },
  { key: "portal",   label: "Customer Portal", icon: "👤" },
  { key: "webhooks", label: "Webhooks",        icon: "🔗" },
];

const WEBHOOKS = [
  "Subscription Contracts Create",
  "Subscription Contracts Update",
  "Subscription Billing Attempts Success",
  "Subscription Billing Attempts Failure",
  "Orders Paid",
  "App Uninstalled",
];

// ─── Component ────────────────────────────────────────────────
export default function Settings() {
  const { settings, smtpPasswordSet, encryptionReady } = useLoaderData<typeof loader>();
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
  const [payWindow,     setPayWindow]     = useState(String(settings.prepaidPayWindowDays));
  const [leadDays,      setLeadDays]      = useState(String(settings.prepaidInvoiceLeadDays));
  const [smtpHost,      setSmtpHost]      = useState(settings.smtpHost);
  const [smtpPort,      setSmtpPort]      = useState(String(settings.smtpPort));
  const [smtpSecure,    setSmtpSecure]    = useState(settings.smtpSecure);
  const [smtpUser,      setSmtpUser]      = useState(settings.smtpUser);
  const [smtpFrom,      setSmtpFrom]      = useState(settings.smtpFrom);
  // Write-only: starts blank whether or not a password is stored.
  const [smtpPassword,  setSmtpPassword]  = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [testTo,        setTestTo]        = useState(settings.notificationEmail ?? "");
  // The six editable email fields, keyed by their AppSettings column.
  const [emailTexts,    setEmailTexts]    = useState<Record<string, string>>(() =>
    Object.fromEntries(
      EMAIL_SECTIONS.flatMap((s) => [
        [s.subjectField, settings[s.subjectField] ?? ""],
        [s.messageField, settings[s.messageField] ?? ""],
      ]),
    ),
  );
  const setEmailText = (field: string) => (value: string) =>
    setEmailTexts((t) => ({ ...t, [field]: value }));
  const [showSaved,     setShowSaved]     = useState(false);

  useEffect(() => {
    if (actionData && "success" in actionData) {
      setShowSaved(true);
      // A saved password must not linger in the field, where it could be
      // re-submitted or read off the screen.
      setSmtpPassword("");
      setClearPassword(false);
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
    fd.append("prepaidPayWindowDays",    payWindow);
    fd.append("prepaidInvoiceLeadDays",  leadDays);
    fd.append("smtpHost",                smtpHost);
    fd.append("smtpPort",                smtpPort);
    fd.append("smtpSecure",              String(smtpSecure));
    fd.append("smtpUser",                smtpUser);
    fd.append("smtpFrom",                smtpFrom);
    fd.append("smtpPassword",            smtpPassword);
    fd.append("smtpClearPassword",       String(clearPassword));
    Object.entries(emailTexts).forEach(([field, value]) => fd.append(field, value));
    submit(fd, { method: "post" });
  }, [
    notifyBilling, notifyCancel, notifyNew, notifyEmail, maxRetries, gracePeriod, allowPause, allowCancel,
    payWindow, leadDays, smtpHost, smtpPort, smtpSecure, smtpUser, smtpFrom, smtpPassword, clearPassword,
    emailTexts, submit,
  ]);

  // Tests the SAVED settings, so it can't report success for values the merchant
  // hasn't actually stored yet.
  const handleTestEmail = useCallback(() => {
    const fd = new FormData();
    fd.append("intent", "test-smtp");
    fd.append("testEmailTo", testTo);
    submit(fd, { method: "post" });
  }, [testTo, submit]);

  const payWindowOptions = [1, 2, 3, 5, 7, 10, 14, 21, 30].map((d) => ({
    label: `${d} day${d > 1 ? "s" : ""}`,
    value: String(d),
  }));

  const leadDayOptions = [0, 1, 2, 3, 5, 7, 10, 14].map((d) => ({
    label: d === 0 ? "On the billing date" : `${d} day${d > 1 ? "s" : ""} before`,
    value: String(d),
  }));

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

  // One card, one tab. These used to also fire on "general", which re-rendered the
  // Billing and Customer Portal cards underneath Notifications — the same two cards
  // their own tabs already own.
  //
  // Note this only controls VISIBILITY. handleSave posts from React state rather
  // than from mounted inputs, so every field is still submitted whichever tab is
  // open; the blanket upsert in the action depends on that.
  const showNotifications = activeTab === "general";
  const showBilling       = activeTab === "billing";
  const showPrepaid       = activeTab === "prepaid";
  const showPortal        = activeTab === "portal";
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
            style={{ ...btn, background: BRAND_GRADIENT, color: "#fff", border: "none", marginTop: "4px" }}
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
        {actionData && "testSent" in actionData && (
          <div style={{
            background: T.greenBg, border: `0.5px solid ${T.greenDot}`,
            borderRadius: "10px", padding: "10px 16px",
          }}>
            <Text as="p" variant="bodySm" tone="subdued">✅ Test email sent to {actionData.testSent}. Check that inbox (and spam).</Text>
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

            {/* Prepaid payments */}
            {showPrepaid && (
              <div className="hover-card" style={card}>
                <SectionHeader
                  icon="🧾"
                  title="Prepaid payments"
                  sub="Prepaid subscriptions aren't charged automatically. Before each cycle the customer is emailed a link to confirm and pay."
                />
                <div style={{ display: "flex", gap: "16px" }}>
                  <div style={{ flex: 1 }}>
                    <Select
                      label="Send the payment link"
                      helpText="Earlier gives customers time to pay before the cycle is due. Plans and bundles can set their own."
                      options={leadDayOptions}
                      value={leadDays}
                      onChange={setLeadDays}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Select
                      label="Payment window"
                      helpText="A reminder goes out halfway through. If it's still unpaid at the end, the subscription is paused."
                      options={payWindowOptions}
                      value={payWindow}
                      onChange={setPayWindow}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Payment email text */}
            {showPrepaid && (
              <div className="hover-card" style={card}>
                <SectionHeader
                  icon="📝"
                  title="Payment email text"
                  sub="Write the emails your prepaid customers get, in your own words. Leave a field empty to use the default shown in it. The amount, the pay-by date and the pay button are always added for you."
                />
                <BlockStack gap="500">
                  {EMAIL_SECTIONS.map((section) => {
                    const subject = emailTexts[section.subjectField] ?? "";
                    const message = emailTexts[section.messageField] ?? "";
                    const edited  = !!subject || !!message;
                    return (
                      <BlockStack gap="200" key={section.kind}>
                        <InlineStack align="space-between" blockAlign="center">
                          <BlockStack gap="050">
                            <Text as="h3" variant="headingSm">{section.title}</Text>
                            <Text as="p" variant="bodySm" tone="subdued">{section.hint}</Text>
                          </BlockStack>
                          {edited && (
                            <button
                              onClick={() => setEmailTexts((t) => ({ ...t, [section.subjectField]: "", [section.messageField]: "" }))}
                              style={{ ...btn, padding: "4px 10px", background: "none", border: "none", color: T.purpleFg }}
                            >
                              Reset to default
                            </button>
                          )}
                        </InlineStack>
                        <TextField
                          label="Subject"
                          value={subject}
                          onChange={setEmailText(section.subjectField)}
                          placeholder={PREPAID_EMAIL_DEFAULTS[section.kind].subject}
                          maxLength={PREPAID_SUBJECT_MAX}
                          showCharacterCount={!!subject}
                          autoComplete="off"
                        />
                        <TextField
                          label="Message"
                          value={message}
                          onChange={setEmailText(section.messageField)}
                          placeholder={PREPAID_EMAIL_DEFAULTS[section.kind].message}
                          maxLength={PREPAID_MESSAGE_MAX}
                          showCharacterCount={!!message}
                          multiline={4}
                          autoComplete="off"
                        />
                      </BlockStack>
                    );
                  })}
                  <div style={{ background: T.blueBg, borderRadius: "8px", padding: "10px 14px" }}>
                    <Text as="p" variant="bodySm">
                      <strong>Placeholders</strong> are filled in for each customer:{" "}
                      {PREPAID_EMAIL_PLACEHOLDERS.map((p, i) => (
                        <span key={p.token}>
                          {i > 0 && " · "}
                          <code>{p.token}</code> {p.meaning}
                        </span>
                      ))}
                    </Text>
                  </div>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Plans that use the Shopify invoice email show this subject and message inside Shopify's own invoice template
                    (Shopify admin → Settings → Notifications → Draft order invoice). To preview the text, save, then use
                    "Send test email" below. It sends a sample "Before each delivery" email through your SMTP server.
                  </Text>
                </BlockStack>
              </div>
            )}

            {/* Merchant SMTP */}
            {showPrepaid && (
              <div className="hover-card" style={card}>
                <SectionHeader
                  icon="✉️"
                  title="Your email server (SMTP)"
                  sub="Used by prepaid plans and bundles set to send payment emails with your own email server. Plans set to Shopify invoice email don't need this."
                />
                {!encryptionReady && (
                  <div style={{
                    background: T.amberBg, borderRadius: "8px", padding: "10px 14px", marginBottom: "14px",
                  }}>
                    <Text as="p" variant="bodySm">
                      The server has no encryption key set (APP_ENCRYPTION_KEY), so an SMTP password can't be saved yet.
                    </Text>
                  </div>
                )}
                <BlockStack gap="300">
                  <div style={{ display: "flex", gap: "16px" }}>
                    <div style={{ flex: 2 }}>
                      <TextField label="SMTP host" value={smtpHost} onChange={setSmtpHost} placeholder="smtp.yourprovider.com" autoComplete="off" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField label="Port" type="number" value={smtpPort} onChange={setSmtpPort} autoComplete="off" />
                    </div>
                  </div>
                  <Checkbox
                    label="Use SSL/TLS from the start"
                    helpText="Turn on for port 465. Leave off for 587, which upgrades to TLS automatically."
                    checked={smtpSecure}
                    onChange={setSmtpSecure}
                  />
                  <div style={{ display: "flex", gap: "16px" }}>
                    <div style={{ flex: 1 }}>
                      <TextField label="Username" value={smtpUser} onChange={setSmtpUser} autoComplete="off" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Password"
                        type="password"
                        value={smtpPassword}
                        onChange={setSmtpPassword}
                        placeholder={smtpPasswordSet ? "Saved. Leave blank to keep it." : ""}
                        helpText="Stored encrypted and never shown again."
                        autoComplete="new-password"
                        disabled={clearPassword}
                      />
                    </div>
                  </div>
                  {smtpPasswordSet && (
                    <Checkbox label="Remove the saved password" checked={clearPassword} onChange={setClearPassword} />
                  )}
                  <TextField
                    label="From address"
                    value={smtpFrom}
                    onChange={setSmtpFrom}
                    placeholder="Your Shop <orders@yourshop.com>"
                    helpText="Customers reply to your notification email (General tab) if one is set."
                    autoComplete="off"
                  />
                  <div style={{ borderTop: "0.5px solid var(--p-color-border-secondary)", paddingTop: "14px" }}>
                    <InlineStack gap="300" blockAlign="end" wrap={false}>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Send a test email to"
                          type="email"
                          value={testTo}
                          onChange={setTestTo}
                          helpText="Uses your saved settings, so save first."
                          autoComplete="email"
                        />
                      </div>
                      <button
                        onClick={handleTestEmail}
                        disabled={isSaving || !testTo}
                        style={{ ...btn, background: "var(--p-color-bg-surface)", color: T.purpleFg, border: `0.5px solid ${T.purple}`, marginBottom: "22px" }}
                      >
                        Send test email
                      </button>
                    </InlineStack>
                  </div>
                </BlockStack>
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
                <ConfigRow
                  label="Prepaid payment window"
                  right={
                    <Text as="span" variant="bodySm" fontWeight="semibold">{payWindow}d</Text>
                  }
                />
                <ConfigRow
                  label="SMTP"
                  right={<StatusPill on={!!settings.smtpHost && !!settings.smtpFrom} onLabel="Set up" offLabel="Not set" />}
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

