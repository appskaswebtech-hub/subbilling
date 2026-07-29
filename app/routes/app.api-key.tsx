// app/routes/app.api-key.tsx

import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Text, BlockStack, InlineStack, Modal } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import crypto from "crypto";
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
  amberBg:    "#FAEEDA",
  amberFg:    "#633806",
  redBg:      "#FCEBEB",
  redFg:      "#791F1F",
  blueBg:     "#E6F1FB",
  blueFg:     "#185FA5",
};

function generateApiKey(): string {
  return `sk_${crypto.randomBytes(32).toString("hex")}`;
}

// ─── Loader ──────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const apiKey = await prisma.apiKey.findUnique({ where: { shop } });
  return json({
    hasKey:    !!apiKey,
    active:    apiKey?.active ?? false,
    createdAt: apiKey?.createdAt ?? null,
  });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const _action  = formData.get("_action") as string;

  if (_action === "generate") {
    const key = generateApiKey();
    await prisma.apiKey.upsert({
      where:  { shop },
      update: { key, active: true },
      create: { shop, key, active: true },
    });
    return json({ success: true, action: "generated", key });
  }

  if (_action === "revoke") {
    await prisma.apiKey.updateMany({ where: { shop }, data: { active: false } });
    return json({ success: true, action: "revoked" });
  }

  return json({ success: false });
}

// ─── Endpoint config ─────────────────────────────────────────
const ENDPOINTS = [
  {
    title: "List all subscriptions",
    method: "GET",   path: "/subscriptions",
    methodColor: "#27500A", methodBg: "#EAF3DE",
    iconBg: T.blueBg,   iconFg: T.blueFg,   icon: "≡",
  },
  {
    title: "Get single subscription",
    method: "GET",   path: "/subscriptions/{id}",
    methodColor: "#27500A", methodBg: "#EAF3DE",
    iconBg: T.blueBg,   iconFg: T.blueFg,   icon: "◎",
  },
  {
    title: "Pause subscription",
    method: "PATCH", path: "/subscriptions/{id}/pause",
    methodColor: T.blueFg,  methodBg: T.blueBg,
    iconBg: T.purpleBg, iconFg: T.purpleFg, icon: "⏸",
  },
  {
    title: "Resume subscription",
    method: "PATCH", path: "/subscriptions/{id}/resume",
    methodColor: "#27500A", methodBg: "#EAF3DE",
    iconBg: "#EAF3DE",  iconFg: "#27500A",  icon: "▶",
  },
  {
    title: "Cancel subscription",
    method: "PATCH", path: "/subscriptions/{id}/cancel",
    methodColor: T.redFg,   methodBg: T.redBg,
    iconBg: T.redBg,    iconFg: T.redFg,    icon: "✕",
  },
  {
    title: "Update next billing date",
    method: "PATCH", path: "/subscriptions/{id}",
    note:  'Body: { "nextBillingDate": "2025-06-01" }',
    methodColor: T.amberFg, methodBg: T.amberBg,
    iconBg: T.amberBg,  iconFg: T.amberFg,  icon: "📅",
  },
];

const BASE_URL = "https://api.kassubscription.com/v1";

// Per-endpoint documentation details (keyed by endpoint title)
const DOC_META: Record<string, { desc: string; reqBody?: string; response: string }> = {
  "List all subscriptions": {
    desc: "Returns all subscriptions for your store.",
    response: `{
  "subscriptions": [
    {
      "id": "sub_clx123",
      "customerEmail": "jane@example.com",
      "productTitle": "The Collection Snowboard",
      "planName": "Monthly",
      "status": "ACTIVE",
      "price": 29.99,
      "frequency": "MONTHLY",
      "nextBillingDate": "2025-06-01"
    }
  ],
  "total": 1
}`,
  },
  "Get single subscription": {
    desc: "Returns a single subscription by its ID.",
    response: `{
  "id": "sub_clx123",
  "customerEmail": "jane@example.com",
  "productTitle": "The Collection Snowboard",
  "planName": "Monthly",
  "status": "ACTIVE",
  "price": 29.99,
  "frequency": "MONTHLY",
  "nextBillingDate": "2025-06-01"
}`,
  },
  "Pause subscription": {
    desc: "Pauses an active subscription. Billing stops until it is resumed.",
    response: `{ "id": "sub_clx123", "status": "PAUSED" }`,
  },
  "Resume subscription": {
    desc: "Resumes a paused subscription.",
    response: `{ "id": "sub_clx123", "status": "ACTIVE" }`,
  },
  "Cancel subscription": {
    desc: "Cancels a subscription. This action cannot be undone.",
    response: `{ "id": "sub_clx123", "status": "CANCELLED" }`,
  },
  "Update next billing date": {
    desc: "Updates the next billing date of a subscription.",
    reqBody: `{ "nextBillingDate": "2025-06-01" }`,
    response: `{ "id": "sub_clx123", "nextBillingDate": "2025-06-01" }`,
  },
};

const HELP_ITEMS = [
  { icon: "📖", title: "Learn how to integrate", sub: "View our API documentation 🔗" },
  { icon: "💬", title: "Have questions?",          sub: "Contact our support team"      },
  { icon: "⚡", title: "Rate limits",              sub: "1000 requests per minute"      },
];

// ─── Page ─────────────────────────────────────────────────────
export default function ApiKeyPage() {
  const loaderData  = useLoaderData<typeof loader>();
  const fetcher     = useFetcher<typeof action>();
  const [showRevoke,      setShowRevoke]      = useState(false);
  const [copied,          setCopied]          = useState(false);
  const [copiedAll,       setCopiedAll]       = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [showDocs,        setShowDocs]        = useState(false);

  // Close the docs modal on Escape
  useEffect(() => {
    if (!showDocs) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowDocs(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showDocs]);

  const isLoading   = fetcher.state === "submitting";
  const fetcherData = fetcher.data as any;

  const generatedKey = fetcherData?.action === "generated" ? fetcherData.key : null;
  const isRevoked    = fetcherData?.action === "revoked";
  const hasKey       = isRevoked ? false : (loaderData.hasKey || !!generatedKey);
  const isActive     = isRevoked ? false : (loaderData.active || !!generatedKey);

  const handleGenerate = () => {
    const fd = new FormData();
    fd.append("_action", "generate");
    fetcher.submit(fd, { method: "POST" });
  };

  const handleRevoke = () => {
    const fd = new FormData();
    fd.append("_action", "revoke");
    fetcher.submit(fd, { method: "POST" });
    setShowRevoke(false);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyAllEndpoints = () => {
    const all = ENDPOINTS.map((e) => `${e.method} ${BASE_URL}${e.path}`).join("\n");
    navigator.clipboard.writeText(all);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  const btn: React.CSSProperties = {
    fontSize: "12px", padding: "7px 14px", borderRadius: "8px",
    cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
    display: "inline-flex", alignItems: "center", gap: "6px",
  };

  return (
    <Page>
      <TitleBar title="API Access" />
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
                  Smart Subscriptions › <span className="subscription">API Access</span>
                </Text>
              </div>
            </InlineStack>
            <div className="varient-section">
              <Text as="h1" variant="headingXl" fontWeight="bold">API Access</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Use your API key to manage subscriptions programmatically
              </Text>
            </div>
          </BlockStack>
          <button
            onClick={() => setShowDocs(true)}
            style={{
              ...btn, marginTop: "4px",
              border: `0.5px solid ${T.purple}`,
              background: T.purpleBg, color: T.purpleFg,
            }}
          >
            📖 API Documentation
          </button>
        </div>

        {/* ── Info Banner ─────────────────────────────────────── */}
        {!bannerDismissed && (
          <div style={{
            background: T.blueBg, border: "0.5px solid #A8CFEC",
            borderRadius: "12px", padding: "14px 16px",
            display: "flex", alignItems: "flex-start", gap: "10px",
          }}>
            <span style={{ fontSize: "18px", flexShrink: 0 }}>🛡️</span>
            <div style={{ flex: 1 }}>
              <Text as="p" variant="bodyMd" fontWeight="semibold">Secure & Simple Integration</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Use your API key to integrate with external systems. Include it in every request as{" "}
                <code style={{
                  background: "#D1E8F7", padding: "1px 6px",
                  borderRadius: "4px", fontSize: "12px", fontFamily: "monospace",
                }}>
                  x-api-key
                </code>{" "}
                header.
              </Text>
            </div>
            <button
              onClick={() => setBannerDismissed(true)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: T.blueFg, fontSize: "18px", lineHeight: 1, padding: "0", flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* ── API Key card + Need help ─────────────────────────── */}
        <div style={{ display: "flex", gap: "16px", alignItems: "stretch" }}>

          {/* Left: API Key */}
          <div className="hover-card" style={{
            flex: 1,
            background: "var(--p-color-bg-surface)",
            border: "0.5px solid var(--p-color-border)",
            borderRadius: "14px", padding: "24px",
            display: "flex", alignItems: "flex-start", gap: "16px",
          }}>
            <div style={{ flex: 1 }}>
              <Text as="h2" variant="headingMd" fontWeight="semibold">Your API Key</Text>
              <div style={{ marginTop: "10px", marginBottom: "20px" }}>
                {generatedKey ? (
                  <BlockStack gap="200">
                    <div style={{
                      background: T.amberBg, border: `0.5px solid ${T.amberFg}`,
                      borderRadius: "8px", padding: "10px 12px",
                    }}>
                      <Text as="p" variant="bodySm" tone="subdued">
                        ⚠️ Copy this key now — it won't be shown again for security reasons.
                      </Text>
                    </div>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <input
                        readOnly
                        value={generatedKey}
                        style={{
                          flex: 1, fontFamily: "monospace", fontSize: "12px",
                          padding: "8px 12px",
                          border: "0.5px solid var(--p-color-border)",
                          borderRadius: "8px",
                          background: "var(--p-color-bg-surface-secondary)",
                          color: "var(--p-color-text)", outline: "none",
                        }}
                      />
                      <button
                        onClick={() => copyToClipboard(generatedKey)}
                        style={{ ...btn, background: T.purpleDark, color: "#fff", border: "none" }}
                      >
                        {copied ? "✓ Copied" : "Copy Key"}
                      </button>
                    </div>
                  </BlockStack>
                ) : isRevoked ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Your API key has been revoked. Generate a new one to restore access.
                  </Text>
                ) : hasKey ? (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Your API key is active. For security, the full key is only shown when generated.
                      If you've lost your key, click Regenerate to invalidate the old key.
                    </Text>
                    {loaderData.createdAt && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Generated: {new Date(loaderData.createdAt).toLocaleDateString()}
                      </Text>
                    )}
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    You don't have an API key yet. Generate one to get started.
                  </Text>
                )}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  onClick={handleGenerate}
                  disabled={isLoading}
                  style={{ ...btn, background: T.purpleDark, color: "#fff", border: "none" }}
                >
                  🪄 {isLoading ? "Generating…" : hasKey ? "Regenerate Key" : "Generate API Key"}
                </button>
                {hasKey && isActive && !generatedKey && (
                  <button
                    onClick={() => setShowRevoke(true)}
                    style={{ ...btn, background: T.redBg, color: T.redFg, border: "0.5px solid #F09595" }}
                  >
                    Revoke Key
                  </button>
                )}
              </div>
            </div>

            {/* Lock illustration */}
            <div style={{
              width: "90px", display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: "10px",
              padding: "8px", flexShrink: 0,
            }}>
              <div style={{
                width: "64px", height: "64px", borderRadius: "50%",
                background: T.purpleBg, display: "flex",
                alignItems: "center", justifyContent: "center", fontSize: "28px",
              }}>
                🔑
              </div>
              <div style={{ display: "flex", gap: "4px" }}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} style={{
                    width: "7px", height: "7px", borderRadius: "50%",
                    background: T.purpleBg, display: "inline-block",
                  }} />
                ))}
              </div>
            </div>
          </div>

          {/* Right: Need help */}
          <div className="hover-card" style={{
            width: "210px", flexShrink: 0,
            background: "var(--p-color-bg-surface)",
            border: "0.5px solid var(--p-color-border)",
            borderRadius: "14px", padding: "20px",
          }}>
            <Text as="h3" variant="headingSm" fontWeight="semibold">Need help?</Text>
            <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "16px" }}>
              {HELP_ITEMS.map((item) => (
                <div key={item.title} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                  <span style={{ fontSize: "15px", flexShrink: 0, marginTop: "1px" }}>{item.icon}</span>
                  <div>
                    <Text as="p" variant="bodySm" fontWeight="medium">{item.title}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">{item.sub}</Text>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── API Endpoints ────────────────────────────────────── */}
        <div className="hover-card" style={{
          background: "var(--p-color-bg-surface)",
          border: "0.5px solid var(--p-color-border)",
          borderRadius: "14px", overflow: "hidden",
        }}>
          {/* Header row */}
          <div style={{
            padding: "16px 20px",
            borderBottom: "0.5px solid var(--p-color-border)",
            display: "flex", justifyContent: "space-between",
            alignItems: "center", flexWrap: "wrap", gap: "10px",
          }}>
            <div>
              <Text as="h2" variant="headingMd" fontWeight="semibold">API Endpoints</Text>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
                <Text as="span" variant="bodySm" tone="subdued">Base URL:</Text>
                <span style={{
                  fontSize: "12px", color: T.purpleFg,
                  fontFamily: "monospace",
                }}>
                  {BASE_URL}
                </span>
              </div>
            </div>
            <button
              onClick={copyAllEndpoints}
              style={{
                ...btn,
                border: "0.5px solid var(--p-color-border-secondary)",
                background: "var(--p-color-bg-surface)",
                color: "var(--p-color-text)",
              }}
            >
              {copiedAll ? "✓ Copied!" : "📋 Copy all endpoints"}
            </button>
          </div>

          {/* Endpoint rows */}
          {ENDPOINTS.map((ep, i) => (
            <div
              key={`${ep.method}-${ep.path}`}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--p-color-bg-surface-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              style={{
                display: "flex", alignItems: "center", gap: "14px",
                padding: "14px 20px",
                background: "transparent",
                transition: "background 0.12s ease",
                borderBottom: i < ENDPOINTS.length - 1
                  ? "0.5px solid var(--p-color-border-secondary)"
                  : "none",
              }}
            >
              {/* Icon */}
              <div style={{
                width: "32px", height: "32px", borderRadius: "8px",
                background: ep.iconBg, color: ep.iconFg,
                display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: "14px", flexShrink: 0,
              }}>
                {ep.icon}
              </div>

              {/* Title + method + path */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text as="p" variant="bodySm" fontWeight="medium">{ep.title}</Text>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "3px" }}>
                  <span style={{
                    fontSize: "10px", fontWeight: 600,
                    padding: "1px 7px", borderRadius: "4px",
                    background: ep.methodBg, color: ep.methodColor,
                    textTransform: "uppercase", letterSpacing: "0.04em",
                  }}>
                    {ep.method}
                  </span>
                  <code style={{
                    fontSize: "11px", color: "var(--p-color-text-subdued)",
                    fontFamily: "monospace",
                  }}>
                    {ep.path}
                  </code>
                </div>
                {ep.note && (
                  <Text as="p" variant="bodySm" tone="subdued">{ep.note}</Text>
                )}
              </div>

              {/* Headers badge */}
              <div style={{
                fontSize: "11px", padding: "3px 10px",
                background: "var(--p-color-bg-surface-secondary)",
                borderRadius: "6px", color: "var(--p-color-text-subdued)",
                whiteSpace: "nowrap", flexShrink: 0, fontFamily: "monospace",
              }}>
                Headers: x-api-key: your_key
              </div>
            </div>
          ))}
        </div>

      </BlockStack>

      {/* Revoke Modal */}
      <Modal
        open={showRevoke}
        onClose={() => setShowRevoke(false)}
        title="Revoke API Key"
        primaryAction={{ content: "Revoke", destructive: true, onAction: handleRevoke }}
        secondaryActions={[{ content: "Cancel", onAction: () => setShowRevoke(false) }]}
      >
        <Modal.Section>
          <Text as="p" variant="bodyMd">
            Are you sure? All applications using this key will lose access immediately.
          </Text>
        </Modal.Section>
      </Modal>

      {/* ── API Documentation modal ────────────────────────────── */}
      {showDocs && (
        <div
          onClick={() => setShowDocs(false)}
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
              width: "100%", maxWidth: "720px", maxHeight: "85vh",
              overflow: "auto", position: "relative",
            }}
          >
            {/* Header */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "18px 22px", borderBottom: "0.5px solid var(--p-color-border)",
              position: "sticky", top: 0, background: "var(--p-color-bg-surface)", zIndex: 1,
            }}>
              <Text as="h2" variant="headingMd" fontWeight="bold">📖 API Documentation</Text>
              <button
                onClick={() => setShowDocs(false)}
                aria-label="Close"
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: "20px", lineHeight: 1, color: "var(--p-color-text-subdued)", padding: 0 }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: "22px" }}>
              {/* Authentication */}
              <div>
                <Text as="h3" variant="headingSm" fontWeight="semibold">Authentication</Text>
                <div style={{ marginTop: "6px" }}>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Every request must include your API key in the{" "}
                    <code style={{ background: "var(--p-color-bg-surface-secondary)", padding: "1px 6px", borderRadius: "4px", fontFamily: "monospace", fontSize: "12px" }}>x-api-key</code>{" "}
                    header. All endpoints are relative to the base URL below.
                  </Text>
                </div>
                <pre style={{
                  marginTop: "10px", background: "var(--p-color-bg-surface-secondary)",
                  borderRadius: "8px", padding: "12px 14px", fontSize: "12px",
                  fontFamily: "monospace", overflowX: "auto", whiteSpace: "pre-wrap",
                }}>
{`Base URL: ${BASE_URL}
x-api-key: <your API key>`}
                </pre>
              </div>

              {/* Endpoints */}
              {ENDPOINTS.map((ep) => {
                const meta = DOC_META[ep.title];
                return (
                  <div key={`${ep.method}-${ep.path}`} style={{
                    border: "0.5px solid var(--p-color-border)", borderRadius: "12px",
                    padding: "14px 16px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <span style={{
                        fontSize: "10px", fontWeight: 600, padding: "1px 7px", borderRadius: "4px",
                        background: ep.methodBg, color: ep.methodColor,
                        textTransform: "uppercase", letterSpacing: "0.04em",
                      }}>
                        {ep.method}
                      </span>
                      <Text as="span" variant="bodySm" fontWeight="semibold">{ep.title}</Text>
                    </div>
                    <code style={{ display: "block", marginTop: "6px", fontSize: "12px", fontFamily: "monospace", color: "var(--p-color-text-subdued)", wordBreak: "break-all" }}>
                      {ep.method} {BASE_URL}{ep.path}
                    </code>
                    {meta?.desc && (
                      <div style={{ marginTop: "6px" }}>
                        <Text as="p" variant="bodySm" tone="subdued">{meta.desc}</Text>
                      </div>
                    )}
                    {meta?.reqBody && (
                      <>
                        <div style={{ marginTop: "10px" }}>
                          <Text as="p" variant="bodySm" fontWeight="medium">Request body</Text>
                        </div>
                        <pre style={{ marginTop: "4px", background: "var(--p-color-bg-surface-secondary)", borderRadius: "8px", padding: "10px 12px", fontSize: "12px", fontFamily: "monospace", overflowX: "auto", whiteSpace: "pre-wrap" }}>
{meta.reqBody}
                        </pre>
                      </>
                    )}
                    {meta?.response && (
                      <>
                        <div style={{ marginTop: "10px" }}>
                          <Text as="p" variant="bodySm" fontWeight="medium">Example response</Text>
                        </div>
                        <pre style={{ marginTop: "4px", background: "var(--p-color-bg-surface-secondary)", borderRadius: "8px", padding: "10px 12px", fontSize: "12px", fontFamily: "monospace", overflowX: "auto", whiteSpace: "pre-wrap" }}>
{meta.response}
                        </pre>
                      </>
                    )}
                  </div>
                );
              })}

              <Text as="p" variant="bodySm" tone="subdued">
                Rate limit: 1000 requests per minute. Need help? Contact our support team.
              </Text>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
