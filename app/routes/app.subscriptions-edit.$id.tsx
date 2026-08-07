// app/routes/app.subscriptions.$id.tsx

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useSubmit,
  useNavigation,
  useActionData,
} from "@remix-run/react";
import { Page, BlockStack, InlineStack, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import dashboardStyles from "../styles/dashboard.css?url";
import { IconCell, CellIcon, IconCalendar } from "../components/TableIcons";
import SubscriptionEditForm from "../components/SubscriptionEditForm";
import {
  SUBSCRIPTION_CONTRACT_QUERY,
  contractRevision,
  toContractGid as toFullGid,
  type ShopifyContract,
} from "../lib/subscription-sync.server";
import { handleContractEdit } from "../lib/subscription-edit.server";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];

// Everything imported from a .server module above is referenced ONLY inside
// the loader and action bodies. Remix strips those two exports from the client
// bundle; anything the component touches must be client-safe, hence the local
// display-only copy below rather than reusing toContractGid.
function displayGid(raw: string): string {
  if (raw.startsWith("gid://")) return raw;
  if (raw.includes("/"))        return `gid://shopify/${raw}`;
  return `gid://shopify/SubscriptionContract/${raw}`;
}

// ─── Mutations ───────────────────────────────────────────────
// IMPORTANT: Shopify Admin GraphQL 2024-01+ uses `subscriptionContractId`
// We also try both argument names and check which one works for your API version
const PAUSE_MUTATION = `
  mutation subscriptionContractPause($subscriptionContractId: ID!) {
    subscriptionContractPause(subscriptionContractId: $subscriptionContractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const ACTIVATE_MUTATION = `
  mutation subscriptionContractActivate($subscriptionContractId: ID!) {
    subscriptionContractActivate(subscriptionContractId: $subscriptionContractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `
  mutation subscriptionContractCancel($subscriptionContractId: ID!) {
    subscriptionContractCancel(subscriptionContractId: $subscriptionContractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const OPERATIONS = {
  pause:  { mutation: PAUSE_MUTATION,    payloadKey: "subscriptionContractPause",    localStatus: "PAUSED"    },
  resume: { mutation: ACTIVATE_MUTATION, payloadKey: "subscriptionContractActivate", localStatus: "ACTIVE"    },
  cancel: { mutation: CANCEL_MUTATION,   payloadKey: "subscriptionContractCancel",   localStatus: "CANCELLED" },
} as const;

type Intent = keyof typeof OPERATIONS;

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
  redBorder:  "#F09595",
};

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);

  const subscription = await prisma.subscription.findFirst({
    where:   { id: params.id, shop: session.shop },
    include: { billingAttempts: { orderBy: { createdAt: "desc" }, take: 50 } },
  });

  if (!subscription) throw new Response("Not found", { status: 404 });

  // Line ids live only in Shopify — the local model has no line data — so the
  // edit form needs the live contract. If Shopify is unreachable the page must
  // still render read-only rather than blowing up.
  let contract: ShopifyContract | null = null;
  let contractError: string | null     = null;
  try {
    const res    = await admin.graphql(SUBSCRIPTION_CONTRACT_QUERY, {
      variables: { id: toFullGid(subscription.shopifyContractId) },
    });
    const result = await res.json() as any;
    if (result?.errors?.length) {
      contractError = result.errors.map((e: any) => e.message).join(" | ");
    } else {
      contract = result?.data?.subscriptionContract ?? null;
      if (!contract) contractError = "Shopify returned no contract for this subscription.";
    }
  } catch (err) {
    contractError = err instanceof Error ? err.message : "Could not reach Shopify.";
  }

  // Editing mid-charge can bill the same cycle twice — the cron advances
  // nextBillingDate before it creates the attempt.
  const pendingAttempts = await prisma.billingAttempt.count({
    where: { subscriptionId: subscription.id, status: "PENDING" },
  });

  return json({
    subscription,
    contract,
    contractError,
    revision:          contractRevision(contract),
    hasPendingAttempt: pendingAttempts > 0,
  });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const formData           = await request.formData();
  const rawIntent          = formData.get("intent") as string;

  // Draft-flow edits. Handled before the pause/resume/cancel guard below,
  // which rejects anything not in OPERATIONS.
  if (rawIntent === "update-contract" || rawIntent === "preview-contract") {
    return handleContractEdit({
      graphql: admin.graphql, shop: session.shop, localId: params.id!, formData,
      commit: rawIntent === "update-contract",
    });
  }

  const intent = rawIntent as Intent;

  if (!OPERATIONS[intent])
    return json({ error: `Unknown intent: ${intent}` }, { status: 400 });

  const sub = await prisma.subscription.findFirst({
    where: { id: params.id, shop: session.shop },
  });

  if (!sub) throw new Response("Not found", { status: 404 });

  // ── KEY FIX: ensure full GID ──────────────────────────────
  const contractGid = toFullGid(sub.shopifyContractId);

  console.log(`[${intent}] Using GID:`, contractGid);
  console.log(`[${intent}] Raw stored value:`, sub.shopifyContractId);

  const op = OPERATIONS[intent];

  let result: any;
  try {
    const res = await admin.graphql(op.mutation, {
      variables: { subscriptionContractId: contractGid },
    });
    result = await res.json();
  } catch (err: any) {
    console.error(`[${intent}] GraphQL request threw:`, err?.message);
    return json({ error: `GraphQL request failed: ${err?.message}` });
  }

  // Log the full raw response so you can see exactly what Shopify returned


  // Top-level GraphQL errors (auth, syntax, etc.)
  if (result?.errors?.length) {
    const msg = result.errors.map((e: any) => e.message).join(" | ");
    console.error(`[${intent}] Top-level GraphQL errors:`, msg);
    return json({ error: `Shopify GraphQL error: ${msg}` });
  }
  const payload    = result?.data?.[op.payloadKey];


  // If the payload itself is null, the mutation wasn't found or scope is missing
  if (!payload) {
    const msg = `No payload returned for ${op.payloadKey}. Check write_own_subscription_contracts scope.`;
    console.error(`[${intent}]`, msg);
    return json({ error: msg });
  }

  const userErrors = (payload?.userErrors ?? []) as Array<{ field: string[]; message: string }>;

  if (userErrors.length > 0) {
    const msg = userErrors
      .map((e) => `[${e.field?.join(".") ?? "field"}] ${e.message}`)
      .join(" | ");
    console.error(`[${intent}] userErrors:`, msg);
    return json({ error: msg });
  }

  // Confirm Shopify returned the updated contract
  const returnedStatus = payload?.contract?.status;
  console.log(`[${intent}] Success — Shopify returned status:`, returnedStatus);

  // Sync local DB
  await prisma.subscription.update({
    where: { id: params.id! },
    data:  { status: op.localStatus },
  });

  return redirect(`/app/subscriptions`);
}

// ─── Helpers ─────────────────────────────────────────────────
type BadgeTone = "success" | "warning" | "critical" | "info";

function badgeTone(status: string): BadgeTone {
  const map: Record<string, BadgeTone> = {
    ACTIVE: "success", PAUSED: "warning", CANCELLED: "critical",
    FAILED: "critical", PENDING: "info", SUCCESS: "success",
  };
  return map[status] ?? "info";
}

function statusPill(status: string) {
  const styles: Record<string, { bg: string; color: string; dot: string }> = {
    ACTIVE:    { bg: T.greenBg, color: T.greenFg, dot: T.greenDot },
    PAUSED:    { bg: T.amberBg, color: T.amberFg, dot: "#BA7517"  },
    CANCELLED: { bg: T.redBg,   color: T.redFg,   dot: "#E24B4A"  },
    FAILED:    { bg: T.redBg,   color: T.redFg,   dot: "#E24B4A"  },
    PENDING:   { bg: T.purpleBg,color: T.purpleFg,dot: T.purple   },
  };
  const s = styles[status] ?? styles.PENDING;
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: "5px",
        fontSize: "12px", fontWeight: 500,
        padding: "4px 12px", background: s.bg, color: s.color,
        borderRadius: "20px",
      }}
    >
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: s.dot, display: "inline-block" }} />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function fmt(date: string | Date) {
  return new Date(date).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(date: string | Date) {
  return new Date(date).toLocaleString("en-GB", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ─── Detail row ──────────────────────────────────────────────
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display:        "flex",
        justifyContent: "space-between",
        alignItems:     "center",
        padding:        "10px 0",
        borderBottom:   "0.5px solid var(--p-color-border-secondary)",
      }}
    >
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      <div style={{ textAlign: "right" }}>{children}</div>
    </div>
  );
}

function DetailRowLast({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      <div style={{ textAlign: "right" }}>{children}</div>
    </div>
  );
}

// ─── Section card wrapper ─────────────────────────────────────
function SectionCard({ title, icon, children }: { title: string; icon?: string; children: React.ReactNode }) {
  return (
    <div
      className="section-card"
      style={{
        background:   "var(--p-color-bg-surface)",
        border:       "0.5px solid var(--p-color-border)",
        borderRadius: "14px",
        overflow:     "visible",
      }}
    >
      <div
        style={{
          padding:      "14px 20px",
          borderBottom: "0.5px solid var(--p-color-border)",
          display:      "flex",
          alignItems:   "center",
          gap:          "8px",
        }}
      >
        {icon && (
          <span style={{
            width: "28px", height: "28px", borderRadius: "7px",
            background: T.purpleBg, display: "inline-flex",
            alignItems: "center", justifyContent: "center",
            fontSize: "14px", flexShrink: 0,
          }}>
            {icon}
          </span>
        )}
        <Text as="h2" variant="headingMd" fontWeight="bold">{title}</Text>
      </div>
      <div style={{ padding: "4px 20px 6px" }}>{children}</div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────
export default function SubscriptionDetail() {
  const { subscription, contract, contractError, revision, hasPendingAttempt } =
    useLoaderData<typeof loader>();
  const actionData        = useActionData<typeof action>();
  const submit            = useSubmit();
  const navigation        = useNavigation();

  const isSubmitting = navigation.state === "submitting";
  const activeIntent = navigation.formData?.get("intent") as string | undefined;
  const s            = subscription;

  const editLines   = contract?.lines?.edges?.map((e: any) => e.node) ?? [];
  const isEditing   = activeIntent === "update-contract" || activeIntent === "preview-contract";
  const editDisabled = s.status === "CANCELLED" || hasPendingAttempt || !contract;
  const editNote =
    !contract       ? `Live contract data is unavailable, so editing is off. ${contractError ?? ""}`
    : hasPendingAttempt ? "A billing attempt is in progress — editing is locked until it settles."
    : s.status === "CANCELLED" ? "This subscription is cancelled and can no longer be edited."
    : null;

  function doAction(intent: Intent) {
    const fd = new FormData();
    fd.append("intent", intent);
    submit(fd, { method: "post" });
  }

  const canResume = s.status === "PAUSED" || s.status === "FAILED";
  const canPause  = s.status === "ACTIVE";
  const canCancel = s.status !== "CANCELLED";

  const shopifyAdminUrl = `https://${s.shop}/admin/subscriptions/${
    s.shopifyContractId.split("/").pop()
  }`;

  const successAttempts = s.billingAttempts.filter((a) => a.status === "SUCCESS");
  const failedAttempts  = s.billingAttempts.filter((a) => a.status === "FAILED");
  const totalCollected  = successAttempts.reduce((sum, a) => sum + a.amount, 0);

  return (
    <Page>
      <TitleBar title={s.productTitle} />

      <BlockStack gap="600">

        {/* ── Page header ─────────────────────────────── */}
        <div
          style={{
            display:        "flex",
            alignItems:     "flex-start",
            justifyContent: "space-between",
            gap:            "16px",
          }}
        >
          <InlineStack gap="300" blockAlign="start">
            {/* Product avatar */}
            <div style={{
              width: "52px", height: "52px", borderRadius: "14px",
              background: T.purpleBg, color: T.purpleFg,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "22px", fontWeight: 700, flexShrink: 0,
            }}>
              {s.productTitle.charAt(0).toUpperCase()}
            </div>
            <BlockStack gap="100">
              <InlineStack gap="150" blockAlign="center">
                <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: T.purple, display: "inline-block" }} />
                <div className="breadcrumbs-dashboard">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Smart Subscriptions › Subscriptions › <span className="subscription">Detail</span>
                  </Text>
                </div>
              </InlineStack>
              <InlineStack gap="300" blockAlign="center">
                <Text as="h1" variant="headingXl" fontWeight="bold">{s.productTitle}</Text>
                {statusPill(s.status)}
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Contract #{s.shopifyContractId.split("/").pop()} · {s.customerEmail}
              </Text>
              {/* Quick stat chips */}
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "4px" }}>
                {[
                  { icon: "📅", label: `Next billing: ${fmt(s.nextBillingDate)}` },
                  { icon: "💰", label: `$${s.price.toFixed(2)} / ${titleCase(s.frequency)}` },
                  { icon: "🔄", label: `${s.billingAttempts.length} billing attempt${s.billingAttempts.length !== 1 ? "s" : ""}` },
                ].map((chip) => (
                  <span key={chip.label} style={{
                    fontSize: "11px", fontWeight: 500,
                    padding: "3px 10px", borderRadius: "20px",
                    background: "var(--p-color-bg-surface-secondary)",
                    border: "0.5px solid var(--p-color-border-secondary)",
                    color: "var(--p-color-text-subdued)",
                    display: "inline-flex", alignItems: "center", gap: "4px",
                  }}>
                    {chip.icon} {chip.label}
                  </span>
                ))}
              </div>
            </BlockStack>
          </InlineStack>

          {/* Action buttons */}
          <InlineStack gap="200" blockAlign="center">
            {canResume && (
              <button
                onClick={() => doAction("resume")}
                disabled={isSubmitting}
                style={{
                  background:   T.purpleDark,
                  color:        T.purpleBg,
                  border:       "none",
                  padding:      "9px 18px",
                  borderRadius: "10px",
                  fontSize:     "13px",
                  fontWeight:   500,
                  cursor:       "pointer",
                  opacity:      isSubmitting && activeIntent === "resume" ? 0.7 : 1,
                }}
              >
                {isSubmitting && activeIntent === "resume" ? "Resuming…" : "Resume subscription"}
              </button>
            )}
            {canPause && (
              <button
                onClick={() => doAction("pause")}
                disabled={isSubmitting}
                style={{
                  background:   T.amberBg,
                  color:        T.amberFg,
                  border:       "0.5px solid #EF9F27",
                  padding:      "9px 18px",
                  borderRadius: "10px",
                  fontSize:     "13px",
                  fontWeight:   500,
                  cursor:       "pointer",
                  opacity:      isSubmitting && activeIntent === "pause" ? 0.7 : 1,
                }}
              >
                {isSubmitting && activeIntent === "pause" ? "Pausing…" : "Pause subscription"}
              </button>
            )}
            {canCancel && (
              <button
                onClick={() => {
                  if (window.confirm("Permanently cancel this subscription? This cannot be undone."))
                    doAction("cancel");
                }}
                disabled={isSubmitting}
                style={{
                  background:   "var(--p-color-bg-surface)",
                  color:        T.redFg,
                  border:       `0.5px solid ${T.redBorder}`,
                  padding:      "9px 16px",
                  borderRadius: "10px",
                  fontSize:     "13px",
                  cursor:       "pointer",
                  opacity:      isSubmitting && activeIntent === "cancel" ? 0.7 : 1,
                }}
              >
                {isSubmitting && activeIntent === "cancel" ? "Cancelling…" : "Cancel"}
              </button>
            )}
            <button
              onClick={() => window.open(shopifyAdminUrl, "_blank")}
              style={{
                background:   "var(--p-color-bg-surface)",
                color:        "var(--p-color-text-subdued)",
                border:       "0.5px solid var(--p-color-border-secondary)",
                padding:      "9px 14px",
                borderRadius: "10px",
                fontSize:     "13px",
                cursor:       "pointer",
              }}
            >
              Shopify Admin ↗
            </button>
          </InlineStack>
        </div>

        {/* ── Error / status banners ───────────────────── */}
        {actionData && "error" in actionData && (
          <div style={{ background: T.redBg, border: `0.5px solid ${T.redBorder}`, borderRadius: "12px", padding: "14px 16px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
            <span style={{ fontSize: "16px", flexShrink: 0 }}>❌</span>
            <div>
              <Text as="p" variant="bodyMd" fontWeight="semibold">Action failed</Text>
              <Text as="p" variant="bodySm" tone="subdued">{(actionData as any).error}</Text>
              <Text as="p" variant="bodySm" tone="subdued" >
                Common causes: missing <strong>write_own_subscription_contracts</strong> scope, or contract state doesn't allow this action.
              </Text>
            </div>
          </div>
        )}

        {actionData && "ok" in actionData && (actionData as any).ok && (
          <div style={{ background: T.greenBg, border: `0.5px solid ${T.greenDot}`, borderRadius: "12px", padding: "14px 16px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
            <span style={{ fontSize: "16px", flexShrink: 0 }}>✅</span>
            <div>
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {(actionData as any).preview ? "Preview only — nothing was saved" : "Subscription updated"}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {(actionData as any).preview
                  ? "Shopify accepted these changes as a draft and discarded it. The customer was not affected."
                  : "Shopify committed the change and the local record now mirrors it."}
              </Text>
            </div>
          </div>
        )}

        {s.status === "CANCELLED" && (
          <div style={{ background: T.redBg, border: `0.5px solid ${T.redBorder}`, borderRadius: "12px", padding: "12px 16px", display: "flex", gap: "10px", alignItems: "center" }}>
            <span>🚫</span>
            <Text as="p" variant="bodySm" fontWeight="semibold">This subscription has been cancelled.</Text>
          </div>
        )}

        {s.status === "FAILED" && (
          <div style={{ background: T.amberBg, border: "0.5px solid #DEB96A", borderRadius: "12px", padding: "12px 16px", display: "flex", gap: "10px", alignItems: "center" }}>
            <span>⚠️</span>
            <div>
              <Text as="p" variant="bodySm" fontWeight="semibold">Last payment failed.</Text>
              <Text as="p" variant="bodySm" tone="subdued">Resume once the customer updates their payment method.</Text>
            </div>
          </div>
        )}

        {/* ── Main 2-col layout ───────────────────────── */}
        <div
          style={{
            display:             "grid",
            gridTemplateColumns: "1fr 340px",
            gap:                 "20px",
            alignItems:          "start",
          }}
        >
          {/* Left column */}
          <BlockStack gap="400">

            {/* Subscription details */}
            <SectionCard title="Subscription details" icon="📋">
              <DetailRow label="Status">{statusPill(s.status)}</DetailRow>
              <DetailRow label="Product">
                <Text as="span" variant="bodySm" fontWeight="semibold">{s.productTitle}</Text>
              </DetailRow>
              <DetailRow label="Plan">
                <Text as="span" variant="bodySm" tone="subdued">{s.planName}</Text>
              </DetailRow>
              <DetailRow label="Price">
                <Text as="span" variant="bodySm" fontWeight="semibold">${s.price.toFixed(2)}</Text>
              </DetailRow>
              <DetailRow label="Frequency">
                <Text as="span" variant="bodySm">{titleCase(s.frequency)}</Text>
              </DetailRow>
              <DetailRow label="Next billing">
                <Text as="span" variant="bodySm">{fmt(s.nextBillingDate)}</Text>
              </DetailRow>
              <DetailRow label="Created">
                <Text as="span" variant="bodySm" tone="subdued">{fmt(s.createdAt)}</Text>
              </DetailRow>
              <DetailRowLast label="Last updated">
                <Text as="span" variant="bodySm" tone="subdued">{fmt(s.updatedAt)}</Text>
              </DetailRowLast>
            </SectionCard>

            {/* Edit — every field goes into one draft and one commit */}
            <SectionCard title="Edit subscription" icon="✏️">
              <SubscriptionEditForm
                contract={contract ?? {}}
                lines={editLines}
                revision={revision}
                disabled={editDisabled}
                disabledNote={editNote}
                submitting={isSubmitting && isEditing}
                onSubmit={(fd) => submit(fd, { method: "post" })}
              />
            </SectionCard>

            {/* Billing history */}
            <SectionCard title={`Billing history (${s.billingAttempts.length})`} icon="🧾">
              {s.billingAttempts.length === 0 ? (
                <div style={{ padding: "16px 0" }}>
                  <Text as="p" tone="subdued">No billing attempts recorded yet.</Text>
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {["Date", "Amount", "Status", "Error"].map((h, i) => (
                          <th
                            key={i}
                            style={{
                              padding:       "10px 0 10px 0",
                              paddingRight:  "16px",
                              textAlign:     "left",
                              fontSize:      "11px",
                              fontWeight:    500,
                              color:         "var(--p-color-text-subdued)",
                              letterSpacing: "0.06em",
                              textTransform: "uppercase",
                              borderBottom:  "0.5px solid var(--p-color-border)",
                              whiteSpace:    "nowrap",
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {s.billingAttempts.map((a, i) => {
                        const isLast = i === s.billingAttempts.length - 1;
                        const cell: React.CSSProperties = {
                          padding:      "12px 16px 12px 0",
                          fontSize:     "12px",
                          color:        "var(--p-color-text)",
                          borderBottom: isLast ? "none" : "0.5px solid var(--p-color-border-secondary)",
                          verticalAlign:"middle",
                        };
                        const rowAccent = a.status === "SUCCESS" ? T.greenDot : a.status === "FAILED" ? T.redFg : T.purple;
                        return (
                          <tr key={a.id} style={{ borderLeft: `3px solid ${rowAccent}` }}>
                            <td style={{ ...cell, paddingLeft: "12px", color: "var(--p-color-text-subdued)" }}>
                              <IconCell icon={<CellIcon icon={IconCalendar} color={rowAccent} />}>
                                {fmtDateTime(a.createdAt)}
                              </IconCell>
                            </td>
                            <td style={{ ...cell, fontWeight: 500 }}>
                              ${a.amount.toFixed(2)}
                            </td>
                            <td style={cell}>
                              {statusPill(a.status)}
                            </td>
                            <td style={{ ...cell, color: "var(--p-color-text-subdued)", fontSize: "11px" }}>
                              {a.errorMessage ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

          </BlockStack>

          {/* Right column */}
          <BlockStack gap="400">

            {/* Customer */}
            <SectionCard title="Customer" icon="👤">
              <DetailRow label="Email">
                <Text as="span" variant="bodySm">{s.customerEmail || "—"}</Text>
              </DetailRow>
              <DetailRowLast label="Customer ID">
                <Text as="span" variant="bodySm" tone="subdued">
                  {s.customerId.split("/").pop() ?? s.customerId}
                </Text>
              </DetailRowLast>
              {s.customerEmail && (
                <div style={{ paddingBottom: "12px" }}>
                  <button
                    onClick={() => window.open(
                      `https://${s.shop}/admin/customers?email=${encodeURIComponent(s.customerEmail)}`,
                      "_blank",
                    )}
                    style={{
                      fontSize:     "12px",
                      padding:      "6px 14px",
                      border:       "0.5px solid var(--p-color-border-secondary)",
                      borderRadius: "8px",
                      background:   "var(--p-color-bg-surface)",
                      color:        "var(--p-color-text-subdued)",
                      cursor:       "pointer",
                      width:        "100%",
                    }}
                  >
                    View in Shopify ↗
                  </button>
                </div>
              )}
            </SectionCard>

            {/* Contract IDs */}
            <SectionCard title="Contract IDs" icon="🔑">
              <div style={{ padding: "10px 0", borderBottom: "0.5px solid var(--p-color-border-secondary)" }}>
                <Text as="p" variant="bodySm" tone="subdued">Local ID</Text>
                <Text as="p" variant="bodySm">
                  <span style={{ fontFamily: "monospace", fontSize: "11px", wordBreak: "break-all" }}>
                    {s.id}
                  </span>
                </Text>
              </div>
              <div style={{ padding: "10px 0 12px" }}>
                <Text as="p" variant="bodySm" tone="subdued">Shopify GID</Text>
                <Text as="p" variant="bodySm">
                  <span style={{ fontFamily: "monospace", fontSize: "11px", wordBreak: "break-all" }}>
                    {displayGid(s.shopifyContractId)}
                  </span>
                </Text>
              </div>
            </SectionCard>

            {/* Billing stats */}
            <SectionCard title="Billing stats" icon="📊">
              <DetailRow label="Total attempts">
                <Text as="span" variant="bodySm" fontWeight="semibold">{s.billingAttempts.length}</Text>
              </DetailRow>
              <DetailRow label="Successful">
                <span style={{ fontSize: "12px", fontWeight: 500, color: T.greenFg, background: T.greenBg, padding: "2px 8px", borderRadius: "20px" }}>
                  {successAttempts.length}
                </span>
              </DetailRow>
              <DetailRow label="Failed">
                <span style={{ fontSize: "12px", fontWeight: 500, color: T.redFg, background: T.redBg, padding: "2px 8px", borderRadius: "20px" }}>
                  {failedAttempts.length}
                </span>
              </DetailRow>
              <DetailRowLast label="Total collected">
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  ${totalCollected.toFixed(2)}
                </Text>
              </DetailRowLast>
            </SectionCard>

          </BlockStack>
        </div>

      </BlockStack>
    </Page>
  );
}

