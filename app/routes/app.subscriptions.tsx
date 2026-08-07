// app/routes/app.subscriptions.tsx

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData,
  useNavigate,
  useSubmit,
  useSearchParams,
  useNavigation,
  useRevalidator,
} from "@remix-run/react";
import { useState, useCallback, useEffect, useRef } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  Text,
  Button,
  EmptyState,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import dashboardStyles from "../styles/dashboard.css?url";
import { IconCell, CellIcon, IconCalendar, rowColorFor } from "../components/TableIcons";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];

const PAGE_SIZE = 20;

// ─── Mutations ───────────────────────────────────────────────
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
  amberDot:   "#BA7517",
  redBg:      "#FCEBEB",
  redFg:      "#791F1F",
  redBorder:  "#F09595",
  blueBg:     "#E6F1FB",
  blueFg:     "#185FA5",
};

// Avatar palette (deterministic by email)
const AVATAR_PALETTE = [
  { bg: "#F4E1FD", fg: "#6A2A8C" },
  { bg: "#DEF2FB", fg: "#0F5F8A" },
  { bg: "#FBE2DE", fg: "#8C3522" },
  { bg: "#E4F4DC", fg: "#345E16" },
  { bg: "#FBEED2", fg: "#7A521A" },
  { bg: "#E6E2FA", fg: "#3C3489" },
];
function avatarFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url          = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "";
  const search       = url.searchParams.get("search") ?? "";
  const page         = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const skip         = (page - 1) * PAGE_SIZE;

  // Set when the Shopify admin deep-links here from an order or customer.
  // customerId is normally a full GID, but webhooks.tsx can fall back to a bare
  // numeric, so match both shapes.
  const rawCustomer  = url.searchParams.get("customer_id");
  const customerNum  = rawCustomer?.split("/").pop() || "";
  const customerWhere = customerNum
    ? { customerId: { in: [`gid://shopify/Customer/${customerNum}`, customerNum] } }
    : {};

  const where = {
    shop: session.shop,
    ...customerWhere,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(search
      ? { OR: [
            { customerEmail: { contains: search } },
            { productTitle:  { contains: search } },
          ],
        }
      : {}),
  };

  // Scoped to the customer too, so the stat cards agree with the visible rows.
  const baseWhere = { shop: session.shop, ...customerWhere };

  const [subscriptions, total, totalAll, totalActive, totalPaused, totalCancelled] =
    await Promise.all([
      prisma.subscription.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: PAGE_SIZE }),
      prisma.subscription.count({ where }),
      prisma.subscription.count({ where: baseWhere }),
      prisma.subscription.count({ where: { ...baseWhere, status: "ACTIVE" } }),
      prisma.subscription.count({ where: { ...baseWhere, status: "PAUSED" } }),
      prisma.subscription.count({ where: { ...baseWhere, status: "CANCELLED" } }),
    ]);

  return json({
    subscriptions,
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
    customerFilter: customerNum || null,
    counts: {
      all:       totalAll,
      active:    totalActive,
      paused:    totalPaused,
      cancelled: totalCancelled,
    },
  });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const formData           = await request.formData();
  const localId            = formData.get("id")     as string;
  const newStatus          = formData.get("status") as string;

  const sub = await prisma.subscription.findFirst({ where: { id: localId, shop: session.shop } });
  if (!sub) return json({ error: "Subscription not found" }, { status: 404 });

  let mutation: string;
  let payloadKey: string;
  if (newStatus === "PAUSED") {
    mutation = PAUSE_MUTATION;
    payloadKey = "subscriptionContractPause";
  } else if (newStatus === "CANCELLED") {
    mutation = CANCEL_MUTATION;
    payloadKey = "subscriptionContractCancel";
  } else {
    mutation = ACTIVATE_MUTATION;
    payloadKey = "subscriptionContractActivate";
  }

  const res    = await admin.graphql(mutation, { variables: { subscriptionContractId: sub.shopifyContractId } });
  const result = await res.json();
  const errors = (result?.data?.[payloadKey]?.userErrors ?? []) as Array<{ field: string[]; message: string }>;

  if (errors.length > 0)
    return json({ error: errors.map((e) => `${e.field?.join(".") ?? "error"}: ${e.message}`).join(" | ") });

  await prisma.subscription.update({ where: { id: localId }, data: { status: newStatus } });
  return json({ ok: true });
}

// ─── Helpers ─────────────────────────────────────────────────
function statusPill(status: string) {
  const styles: Record<string, { bg: string; color: string; dot: string }> = {
    ACTIVE:    { bg: T.greenBg,  color: T.greenFg,  dot: T.greenDot },
    PAUSED:    { bg: T.amberBg,  color: T.amberFg,  dot: T.amberDot },
    CANCELLED: { bg: T.redBg,    color: T.redFg,    dot: "#E24B4A"  },
    FAILED:    { bg: T.redBg,    color: T.redFg,    dot: "#E24B4A"  },
    PENDING:   { bg: T.blueBg,   color: T.blueFg,   dot: "#378ADD"  },
  };
  const s = styles[status] ?? styles.PENDING;
  return (
    <span className="top-pills"
      style={{
        display:      "inline-flex",
        alignItems:   "center",
        gap:          "5px",
        fontSize:     "11px",
        fontWeight:   500,
        padding:      "2px 14px",
        background:   s.bg,
        color:        s.color,
        borderRadius: "20px",
        whiteSpace:   "nowrap",
      }}
    >
      <span className="bottom-pills" style={{ width: "5px", height: "5px", borderRadius: "50%", background: s.dot, display: "inline-block" }} />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ─── Stat card config ────────────────────────────────────────
type StatKey = "" | "ACTIVE" | "PAUSED" | "CANCELLED";

const STAT_CARDS: Array<{
  key: StatKey;
  label: string;
  countField: "all" | "active" | "paused" | "cancelled";
  tint: { bg: string; fg: string };
  icon: JSX.Element;
}> = [
  {
    key: "",
    label: "All",
    countField: "all",
    tint: { bg: T.purpleBg, fg: T.purpleFg },
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      </svg>
    ),
  },
  {
    key: "ACTIVE",
    label: "Active",
    countField: "active",
    tint: { bg: T.greenBg, fg: T.greenFg },
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
  {
    key: "PAUSED",
    label: "Paused",
    countField: "paused",
    tint: { bg: T.amberBg, fg: T.amberFg },
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="6" y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </svg>
    ),
  },
  {
    key: "CANCELLED",
    label: "Cancelled",
    countField: "cancelled",
    tint: { bg: T.redBg, fg: T.redFg },
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="m15 9-6 6M9 9l6 6" />
      </svg>
    ),
  },
];

// ─── Stat card component ─────────────────────────────────────
function StatCard({
  active,
  label,
  count,
  tint,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  tint: { bg: string; fg: string };
  icon: JSX.Element;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex:         1,
        minWidth:     0,
        textAlign:    "left",
        background:   "var(--p-color-bg-surface)",
        border:       `0.5px solid ${active ? T.purple : "var(--p-color-border)"}`,
        borderRadius: "14px",
        padding:      "16px 18px 14px",
        cursor:       "pointer",
        position:     "relative",
        overflow:     "hidden",
        transition:   "border-color 0.15s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div
          style={{
            width:          "34px",
            height:         "34px",
            borderRadius:   "10px",
            background:     tint.bg,
            color:          tint.fg,
            display:        "flex",
            alignItems:     "center",
            justifyContent: "center",
            flexShrink:     0,
          }}
        >
          {icon}
        </div>
        <div style={{ textAlign: "right", minWidth: 0 }}>
          <div style={{ fontSize: "12px", color: "var(--p-color-text-subdued)", marginBottom: "2px" }}>
            {label}
          </div>
          <div style={{ fontSize: "26px", fontWeight: 700, color: "var(--p-color-text)", lineHeight: 1 }}>
            {count}
          </div>
        </div>
      </div>

      {/* Active underline indicator */}
      {active && (
        <div
          style={{
            position:   "absolute",
            left:       "16px",
            right:      "16px",
            bottom:     "0",
            height:     "3px",
            background: T.purple,
            borderRadius: "3px 3px 0 0",
          }}
        />
      )}
    </button>
  );
}

// ─── Row kebab menu ──────────────────────────────────────────
function RowMenu({
  status,
  onView,
  onPause,
  onResume,
  onCancel,
}: {
  status: string;
  onView: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const itemStyle: React.CSSProperties = {
    width:        "100%",
    textAlign:    "left",
    padding:      "8px 12px",
    fontSize:     "12px",
    color:        "var(--p-color-text)",
    background:   "transparent",
    border:       "none",
    cursor:       "pointer",
    whiteSpace:   "nowrap",
    display:      "flex",
    alignItems:   "center",
    gap:          "8px",
  };
  const dangerItem: React.CSSProperties = { ...itemStyle, color: "#A32D2D" };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="More actions"
        style={{
          width:          "28px",
          height:         "28px",
          padding:        0,
          border:         "0.5px solid var(--p-color-border-secondary)",
          borderRadius:   "7px",
          background:     "var(--p-color-bg-surface)",
          color:          "var(--p-color-text)",
          cursor:         "pointer",
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          flexShrink:     0,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5"  cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position:     "absolute",
            right:        0,
            top:          "calc(100% + 6px)",
            minWidth:     "150px",
            background:   "var(--p-color-bg-surface)",
            border:       "0.5px solid var(--p-color-border)",
            borderRadius: "10px",
            boxShadow:    "0 6px 20px rgba(0,0,0,0.08)",
            padding:      "4px",
            zIndex:       50,
            display:      "flex",
            flexDirection:"column",
            gap:          "1px",
          }}
        >
          <button style={itemStyle} onClick={() => { setOpen(false); onView(); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            View details
          </button>

          {status === "ACTIVE" && (
            <button style={itemStyle} onClick={() => { setOpen(false); onPause(); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
              Pause
            </button>
          )}

          {(status === "PAUSED" || status === "FAILED") && (
            <button style={itemStyle} onClick={() => { setOpen(false); onResume(); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Resume
            </button>
          )}

          {status !== "CANCELLED" && (
            <button style={dangerItem} onClick={() => { setOpen(false); onCancel(); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="m15 9-6 6M9 9l6 6" />
              </svg>
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────
export default function Subscriptions() {
  const { subscriptions, total, page, totalPages, counts, customerFilter } = useLoaderData<typeof loader>();
  const navigate    = useNavigate();
  const submit      = useSubmit();
  const [params]    = useSearchParams();
  const navigation  = useNavigation();
  const revalidator = useRevalidator();

  const [searchInput,  setSearchInput]  = useState(params.get("search") ?? "");
  const [actionError,  setActionError]  = useState<string | null>(null);
  const [statusOpen,   setStatusOpen]   = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date>(new Date());
  const statusFilterRef = useRef<HTMLDivElement | null>(null);

  const activeStatus = params.get("status") ?? "";

  // Update last synced timestamp when data reloads
  useEffect(() => {
    if (navigation.state === "idle" && revalidator.state === "idle") {
      setLastSyncedAt(new Date());
    }
  }, [subscriptions, navigation.state, revalidator.state]);

  // Close status dropdown on outside click
  useEffect(() => {
    if (!statusOpen) return;
    function handler(e: MouseEvent) {
      if (statusFilterRef.current && !statusFilterRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [statusOpen]);

  const goTo = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(window.location.search);
      Object.entries(updates).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
      navigate(`?${next.toString()}`);
    },
    [navigate],
  );

  function quickStatus(id: string, status: string) {
    setActionError(null);
    const fd = new FormData();
    fd.append("id", id);
    fd.append("status", status);
    submit(fd, { method: "post" });
  }

  function handleCancel(id: string) {
    if (!confirm("Cancel this subscription? This cannot be undone.")) return;
    quickStatus(id, "CANCELLED");
  }

  function timeAgo(d: Date) {
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 5)    return "just now";
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  // Table styles
  const th: React.CSSProperties = {
    padding:       "11px 16px",
    textAlign:     "left",
    fontSize:      "11px",
    fontWeight:    500,
    color:         "var(--p-color-text-subdued)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    borderBottom:  "0.5px solid var(--p-color-border)",
    whiteSpace:    "nowrap",
    background:    "var(--p-color-bg-surface-secondary)",
  };
  const td: React.CSSProperties = {
    padding:       "13px 16px",
    fontSize:      "13px",
    color:         "var(--p-color-text)",
    borderBottom:  "0.5px solid var(--p-color-border-secondary)",
    verticalAlign: "middle",
    overflow:      "hidden",
    textOverflow:  "ellipsis",
    whiteSpace:    "nowrap",
  };
  const tdLast: React.CSSProperties = { ...td, borderBottom: "none" };

  const STATUS_OPTIONS: Array<{ value: StatKey; label: string }> = [
    { value: "",          label: "All statuses" },
    { value: "ACTIVE",    label: "Active"       },
    { value: "PAUSED",    label: "Paused"       },
    { value: "CANCELLED", label: "Cancelled"    },
  ];
  const currentStatusLabel =
    STATUS_OPTIONS.find((o) => o.value === activeStatus)?.label ?? "All statuses";

  return (
    <Page fullWidth>
      <TitleBar title="All Subscriptions" />

      <BlockStack gap="500">

        {/* ── Breadcrumb ── */}
        <InlineStack gap="150" blockAlign="center">

          <span
            style={{
              width: "6px", height: "6px", borderRadius: "50%",
              background: T.purple, display: "inline-block", flexShrink: 0,
            }}
          />
           <div className="breadcrumbs-dashboard">
          <Text as="span" variant="bodySm" tone="subdued">
            Smart Subscriptions › Dashboard › <span className="subscription">Subscriptions</span>
          </Text>
          </div>
        </InlineStack>

        {/* ── Page header ── */}
        <div className="page-Selling plans">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h1" variant="headingXl" fontWeight="bold">
              All Subscriptions
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {total} total contract{total !== 1 ? "s" : ""}
            </Text>
          </BlockStack>
          <Button variant="primary" onClick={() => navigate("/app/plans")}>
            + Create plan
          </Button>
        </InlineStack>
</div>
        {/* Deep-linked from the Shopify admin for one customer */}
        {customerFilter && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: "8px",
            background: T.purpleBg, color: T.purpleFg,
            border: `0.5px solid ${T.purple}`, borderRadius: "20px",
            padding: "5px 8px 5px 14px", fontSize: "12px", fontWeight: 500,
            alignSelf: "flex-start",
          }}>
            Showing subscriptions for customer #{customerFilter}
            <button
              onClick={() => goTo({ customer_id: "", page: "1" })}
              aria-label="Clear customer filter"
              style={{
                border: "none", background: "transparent", cursor: "pointer",
                color: T.purpleFg, fontSize: "15px", lineHeight: 1, padding: "0 4px",
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Error banner */}
        {actionError && (
          <Banner tone="critical" title="Action failed" onDismiss={() => setActionError(null)}>
            <Text as="p">{actionError}</Text>
          </Banner>
        )}
        <div className="card-section">
        {/* ── Stat cards ── */}
        <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
          {STAT_CARDS.map((card) => (
            <StatCard
              key={card.key || "all"}
              active={activeStatus === card.key}
              label={card.label}
              count={counts[card.countField]}
              tint={card.tint}
              icon={card.icon}
              onClick={() => goTo({ status: card.key, page: "1" })}
            />
          ))}
        </div>
</div>
        {/* ── Main card ── */}
        <div className="main-card-item"

        >
          <div className="search-filter">

          {/* Search + filter toolbar */}
          <div
            style={{
              display:    "flex",
              alignItems: "center",
              gap:        "10px",
              borderBottom: "0.5px solid var(--p-color-border)",
               borderRadius: "14px 14px 0 0",
            }}  className="filter-toolbar"
          >
            {/* Search box */}
            <div
              style={{
                flex:         1,
                display:      "flex",
                alignItems:   "center",
                gap:          "8px",

                padding:      "8px 12px",
              }}
            >
             <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
<path d="M14 14L10 10M11.3333 6.66667C11.3333 9.24227 9.24227 11.3333 6.66667 11.3333C4.09106 11.3333 2 9.24227 2 6.66667C2 4.09106 4.09106 2 6.66667 2C9.24227 2 11.3333 4.09106 11.3333 6.66667L14 14" stroke="#9CA3AF" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && goTo({ search: searchInput, page: "1" })}
                onBlur={() => goTo({ search: searchInput, page: "1" })}
                placeholder="Search by email or product name…"
                style={{
                  border:     "none",
                  background: "transparent",
                  fontSize:   "13px",
                  color:      "var(--p-color-text)",
                  outline:    "none",
                  width:      "100%",
                }}
              />
              {searchInput && (
                <button
                  onClick={() => { setSearchInput(""); goTo({ search: "", page: "1" }); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--p-color-text-subdued)", fontSize: "16px", lineHeight: 1, padding: 0 }}
                >
                  ×
                </button>
              )}
            </div>
           </div>

            {/* Status filter dropdown */}
            <div ref={statusFilterRef} style={{ position: "relative" }}>
              <button
                onClick={() => setStatusOpen((v) => !v)}
                style={{
                  display:      "flex",
                  alignItems:   "center",
                  gap:          "8px",
                  fontSize:     "13px",
                  color:        activeStatus ? T.purpleFg : "var(--p-color-text)",
                  background:   activeStatus ? T.purpleBg : "var(--p-color-bg-surface)",
                  padding:      "8px 14px",
                  border:       `0.5px solid ${activeStatus ? "#AFA9EC" : "var(--p-color-border-secondary)"}`,
                  borderRadius: "9px",
                  cursor:       "pointer",
                  whiteSpace:   "nowrap",
                  fontWeight:   activeStatus ? 500 : 400,
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                </svg>
                {currentStatusLabel}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {statusOpen && (
                <div
                  style={{
                    position:     "absolute",
                    right:        0,
                    top:          "calc(100% + 6px)",
                    minWidth:     "180px",
                    background:   "var(--p-color-bg-surface)",
                    border:       "0.5px solid var(--p-color-border)",
                    borderRadius: "10px",
                    boxShadow:    "0 6px 20px rgba(0,0,0,0.08)",
                    padding:      "4px",
                    zIndex:       40,
                  }}
                >
                  {STATUS_OPTIONS.map((opt) => {
                    const isCurrent = opt.value === activeStatus;
                    return (
                      <button
                        key={opt.value || "all"}
                        onClick={() => { setStatusOpen(false); goTo({ status: opt.value, page: "1" }); }}
                        style={{
                          width:        "100%",
                          textAlign:    "left",
                          padding:      "8px 12px",
                          fontSize:     "13px",
                          color:        isCurrent ? T.purpleFg : "var(--p-color-text)",
                          fontWeight:   isCurrent ? 500 : 400,
                          background:   isCurrent ? T.purpleBg : "transparent",
                          border:       "none",
                          borderRadius: "7px",
                          cursor:       "pointer",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Table or empty */}
          {subscriptions.length === 0 ? (
            <div style={{ padding: "48px 24px" }}>
              <EmptyState
                heading="No subscriptions found"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <Text as="p" tone="subdued">Try adjusting your filters or search query.</Text>
              </EmptyState>
            </div>
          ) : (
            <div style={{ overflowX: "auto",  borderRadius: "10px", border: "1px solid #E5E7EB" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "11%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "8%"  }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={th}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                        Customer
                       <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none">
<path d="M9.5 4.5L6 8L2.5 4.5" stroke="#6D7175" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
                      </span>
                    </th>
                    <th style={th}>Product</th>
                    <th style={th}>Plan</th>
                    <th style={th}>Status</th>
                    <th style={th}>Price</th>
                    <th style={th}>Frequency</th>
                    <th style={th}>Next billing</th>
                    <th style={th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s: any, i: number) => {
                    const isLast    = i === subscriptions.length - 1;
                    const cell      = isLast ? tdLast : td;
                    const seed      = s.customerEmail || s.customerId || s.id;
                    const av        = avatarFor(seed);
                    const initial   = (s.customerEmail?.[0] ?? "?").toUpperCase();
                    const customerSub = s.customerId
                      ? `#${String(s.customerId).split("/").pop()}`
                      : "";

                    return (
                      <tr
                        key={s.id}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--p-color-bg-surface-hover)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        style={{ transition: "background 0.1s", cursor: "pointer" }}
                        onClick={() => navigate(`/app/subscriptions-edit/${s.id}`)}
                      >
                        {/* Customer w/ avatar */}
                        <td style={cell}>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                            <div
                              style={{
                                width:          "32px",
                                height:         "32px",
                                borderRadius:   "50%",
                                background:     av.bg,
                                color:          av.fg,
                                display:        "flex",
                                alignItems:     "center",
                                justifyContent: "center",
                                fontSize:       "14px",
                                fontWeight:     600,
                                flexShrink:     0,
                              }}
                            >
                              {initial}
                            </div>
                            <div style={{ minWidth: 0, overflow: "hidden" }}>
                              <div
                                style={{
                                  fontSize:     "13px",
                                  fontWeight:   500,
                                  color:        "var(--p-color-text)",
                                  overflow:     "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace:   "nowrap",
                                }}
                             className="customer-mail" >
                                {s.customerEmail || "—"}
                              </div>
                              {customerSub && (
                                <div
                                  style={{
                                    fontSize:   "11px",
                                    color:      "var(--p-color-text-subdued)",
                                    marginTop:  "1px",
                                    overflow:   "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {customerSub}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Product w/ thumbnail */}
                        <td style={cell}>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                            <div
                              style={{
                                width:          "32px",
                                height:         "32px",
                                borderRadius:   "8px",
                                background:     "var(--p-color-bg-surface-secondary)",
                                border:         "0.5px solid var(--p-color-border-secondary)",
                                overflow:       "hidden",
                                display:        "flex",
                                alignItems:     "center",
                                justifyContent: "center",
                                flexShrink:     0,
                              }}
                            >
                              {s.productImage ? (
                                <img
                                  src={s.productImage}
                                  alt={s.productTitle}
                                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                                />
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--p-color-text-subdued)" strokeWidth="2">
                                  <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                                  <line x1="3" y1="6" x2="21" y2="6" />
                                </svg>
                              )}
                            </div>
                            <div
                              style={{
                                fontSize:     "13px",
                                color:        "var(--p-color-text)",
                                overflow:     "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace:   "nowrap",
                                minWidth:     0,
                              }}
                            >
                              {s.productTitle}
                            </div>
                          </div>
                        </td>

                        {/* Plan (2 lines: interval + discount note) */}
                        <td style={cell}>
                          <div style={{ fontSize: "13px", color: "var(--p-color-text)" }}>
                            <IconCell icon={<CellIcon icon={IconCalendar} color={rowColorFor(seed)} />}>
                              {s.planName}
                            </IconCell>
                          </div>
                          {typeof s.discount === "number" && s.discount > 0 && (
                            <div
                              style={{
                                fontSize:   "11px",
                                color:      T.greenFg,
                                marginTop:  "1px",
                              }}
                             >
                              ({s.discount}% off)
                            </div>
                          )}
                        </td>

                        {/* Status */}

                        <td style={cell} className="status-name">{statusPill(s.status)}</td>

                        {/* Price */}
                        <td style={{ ...cell, fontWeight: 500 }} className="price-section">
                          {s.currency ?? "USD"} {Number(s.price).toFixed(2)}
                        </td>

                        {/* Frequency */}
                        <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>
                          {titleCase(s.frequency)}
                        </td>

                        {/* Next billing w/ icon */}
                        <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <rect x="3" y="4" width="18" height="18" rx="2" />
                              <line x1="16" y1="2" x2="16" y2="6" />
                              <line x1="8"  y1="2" x2="8"  y2="6" />
                              <line x1="3"  y1="10" x2="21" y2="10" />
                            </svg>
                            {new Date(s.nextBillingDate).toLocaleDateString("en-GB", {
                              day: "2-digit", month: "short", year: "numeric",
                            })}
                          </span>
                        </td>

                        {/* Actions */}
                        <td style={{ ...cell, overflow: "visible" }} onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: "flex", gap: "6px", alignItems: "center", justifyContent: "flex-start" }}>
                            {/* View */}
                            <button
                              onClick={() => navigate(`/app/subscriptions-edit/${s.id}`)}
                              style={{
                                fontSize:     "12px",
                                padding:      "5px 10px",
                                border:       "0.5px solid var(--p-color-border-secondary)",
                                borderRadius: "7px",
                                background:   "var(--p-color-bg-surface)",
                                color:        "var(--p-color-text)",
                                cursor:       "pointer",
                                whiteSpace:   "nowrap",
                              }}
                            >
                              View
                            </button>

                            {/* Kebab menu */}
                             {/* <RowMenu
                              status={s.status}
                              onView={() => navigate(`/app/subscriptions-edit/${s.id}`)}
                              onPause={() => quickStatus(s.id, "PAUSED")}
                              onResume={() => quickStatus(s.id, "ACTIVE")}
                              onCancel={() => handleCancel(s.id)}
                            /> */}

                            {/* Quick pause/resume (lowercase pill — matches mock) */}
                           {/* {s.status === "ACTIVE" && (
                              <button
                                onClick={() => quickStatus(s.id, "PAUSED")}
                                style={{
                                  fontSize:     "12px",
                                  padding:      "5px 10px",
                                  border:       `0.5px solid ${T.redBorder}`,
                                  borderRadius: "7px",
                                  background:   "var(--p-color-bg-surface)",
                                  color:        "#A32D2D",
                                  cursor:       "pointer",
                                  whiteSpace:   "nowrap",
                                }}
                              >
                                pause
                              </button>
                            )}*/}
                            {(s.status === "PAUSED" || s.status === "FAILED") && (
                              <button
                                onClick={() => quickStatus(s.id, "ACTIVE")}
                                style={{
                                  fontSize:     "12px",
                                  padding:      "5px 10px",
                                  border:       `0.5px solid #AFA9EC`,
                                  borderRadius: "7px",
                                  background:   T.purpleBg,
                                  color:        T.purpleFg,
                                  cursor:       "pointer",
                                  whiteSpace:   "nowrap",
                                }}
                              >
                                resume
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Pagination ── */}
          {totalPages > 1 && (
            <div
              style={{
                display:        "flex",
                alignItems:     "center",
                justifyContent: "space-between",
                padding:        "13px 20px",
                borderTop:      "0.5px solid var(--p-color-border)",
              }}
            >
              <Text as="p" variant="bodySm" tone="subdued">
                Page {page} of {totalPages} · {total} subscriptions
              </Text>

              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  disabled={page <= 1}
                  onClick={() => goTo({ page: String(page - 1) })}
                  style={{
                    padding:      "6px 14px",
                    border:       "0.5px solid var(--p-color-border-secondary)",
                    borderRadius: "8px",
                    background:   "var(--p-color-bg-surface)",
                    color:        page <= 1 ? "var(--p-color-text-disabled)" : "var(--p-color-text)",
                    fontSize:     "12px",
                    cursor:       page <= 1 ? "not-allowed" : "pointer",
                  }}
                >
                  ← Prev
                </button>
                <button
                  disabled={page >= totalPages}
                  onClick={() => goTo({ page: String(page + 1) })}
                  style={{
                    padding:      "6px 14px",
                    border:       "0.5px solid var(--p-color-border-secondary)",
                    borderRadius: "8px",
                    background:   "var(--p-color-bg-surface)",
                    color:        page >= totalPages ? "var(--p-color-text-disabled)" : "var(--p-color-text)",
                    fontSize:     "12px",
                    cursor:       page >= totalPages ? "not-allowed" : "pointer",
                  }}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Sync footer ── */}
        <div
          style={{
            background:   "var(--p-color-bg-surface)",
            border:       "0.5px solid var(--p-color-border)",
            borderRadius: "12px",
            padding:      "13px 18px",
            display:      "flex",
            alignItems:   "center",
            justifyContent: "space-between",
            gap:          "12px",
          }}
       className="footer-sun-section" >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
            <div
              style={{
                width:          "26px",
                height:         "26px",
                borderRadius:   "50%",
                background:     T.purpleBg,
                color:          T.purpleFg,
                display:        "flex",
                alignItems:     "center",
                justifyContent: "center",
                flexShrink:     0,
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
<path d="M1.33334 7.99998C1.33334 11.6794 4.32058 14.6666 8.00001 14.6666C11.6794 14.6666 14.6667 11.6794 14.6667 7.99998C14.6667 4.32055 11.6794 1.33331 8.00001 1.33331C4.32058 1.33331 1.33334 4.32055 1.33334 7.99998V7.99998" stroke="#5C4FC4" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M8 10.6666V7.99998M8 5.33331H8.00667" stroke="#5C4FC4" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
            </div>
            <div className="body-sm">
            <Text as="p" variant="bodySm" tone="subdued">
              All subscription data is synced in real-time from Shopify. Last synced {timeAgo(lastSyncedAt)}.
            </Text>
            </div>
          </div>

          <button
            onClick={() => revalidator.revalidate()}
            disabled={revalidator.state === "loading"}
            style={{
              display:      "flex",
              alignItems:   "center",
              gap:          "6px",
              fontSize:     "13px",
              padding:      "10px 20px",
              border:       "0.5px solid var(--p-color-border-secondary)",
              borderRadius: "8px",
              background:   "var(--p-color-bg-surface)",
              color:        "var(--p-color-text)",
              cursor:       revalidator.state === "loading" ? "wait" : "pointer",
              whiteSpace:   "nowrap",
              opacity:      revalidator.state === "loading" ? 0.7 : 1,
            }}
          className="refresh-preview">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{
                animation: revalidator.state === "loading" ? "spin 1s linear infinite" : "none",
              }}
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
            Refresh now
          </button>
        </div>

        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
        `}</style>

      </BlockStack>
    </Page>
  );
}

