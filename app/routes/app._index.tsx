// app/routes/app._index.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useFetcher, useNavigation, useRevalidator } from "@remix-run/react";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  Box,
  Text,
  Button,
  Divider,
  EmptyState,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import dashboardStyles from "../styles/dashboard.css?url";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

type ShapedContract = {
  id: string;
  shortId: string;
  customerEmail: string;
  productTitle: string;
  planName: string;
  status: string;
  price: string;
  priceAmount: number;
  nextBillingDate: string;
  nextBillingTs: number;
  createdTs: number;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  let fetchError: string | null = null;
  let liveContracts: ShapedContract[] = [];

  try {
    const response = await admin.graphql(
      `#graphql
      query getSubscriptionContracts($first: Int!) {
        subscriptionContracts(first: $first) {
          edges {
            node {
              id
              status
              nextBillingDate
              createdAt
              customer { email }
              lines(first: 1) {
                edges {
                  node {
                    title
                    currentPrice { amount currencyCode }
                    sellingPlanName
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { first: 250 } },
    );

    const result = await response.json();

    if (result?.errors?.length) {
      fetchError = result.errors.map((e: { message: string }) => e.message).join(" | ");
    } else {
      liveContracts = (result?.data?.subscriptionContracts?.edges ?? []).map(
        (e: {
          node: {
            id: string;
            status: string;
            nextBillingDate: string | null;
            createdAt: string | null;
            customer: { email: string } | null;
            lines: {
              edges: {
                node: {
                  title: string;
                  currentPrice: { amount: string; currencyCode: string } | null;
                  sellingPlanName: string | null;
                };
              }[];
            };
          };
        }) => {
          const c = e.node;
          const line = c.lines.edges[0]?.node;
          return {
            id: c.id,
            shortId: c.id.split("/").pop() ?? c.id,
            customerEmail: c.customer?.email ?? "—",
            productTitle: line?.title ?? "—",
            planName: line?.sellingPlanName ?? "Subscription",
            status: c.status,
            price: line?.currentPrice
              ? `${line.currentPrice.currencyCode} ${parseFloat(line.currentPrice.amount).toFixed(2)}`
              : "—",
            priceAmount: line?.currentPrice ? parseFloat(line.currentPrice.amount) : 0,
            nextBillingDate: c.nextBillingDate
              ? new Date(c.nextBillingDate).toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })
              : "—",
            nextBillingTs: c.nextBillingDate ? new Date(c.nextBillingDate).getTime() : Infinity,
            createdTs: c.createdAt ? new Date(c.createdAt).getTime() : 0,
          };
        },
      );
    }
  } catch (err: unknown) {
    fetchError = `Failed to fetch: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Fallback to DB if Shopify API returns nothing
  const dbSubs =
    liveContracts.length === 0
      ? await db.subscription.findMany({
          where: { shop },
          orderBy: { createdAt: "desc" },
          take: 250,
        })
      : [];

  const contracts: ShapedContract[] =
    liveContracts.length > 0
      ? liveContracts
      : dbSubs.map((s) => ({
          id: s.id,
          shortId: s.id.slice(-6),
          customerEmail: s.customerEmail,
          productTitle: s.productTitle,
          planName: s.planName,
          status: s.status,
          price: `INR ${s.price.toFixed(2)}`,
          priceAmount: s.price,
          nextBillingDate: new Date(s.nextBillingDate).toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          }),
          nextBillingTs: new Date(s.nextBillingDate).getTime(),
          createdTs: new Date(s.createdAt).getTime(),
        }));

  const active    = contracts.filter((c) => c.status === "ACTIVE").length;
  const paused    = contracts.filter((c) => c.status === "PAUSED").length;
  const cancelled = contracts.filter(
    (c) => c.status === "CANCELLED" || c.status === "EXPIRED",
  ).length;

  return {
    shop,
    stats: { total: contracts.length, active, paused, cancelled },
    contracts,
    fetchError,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Deterministic vivid color per row (used to color-coordinate the leading icons)
const ROW_COLORS = [
  "#7F77DD", "#3B82F6", "#14B8A6", "#22C55E", "#F59E0B",
  "#EC4899", "#06B6D4", "#8B5CF6", "#EF4444", "#0EA5E9",
];
function rowColorFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return ROW_COLORS[Math.abs(h) % ROW_COLORS.length];
}

// Animate a number from 0 → target on mount (easeOutCubic)
function useCountUp(target: number, duration = 700) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return n;
}

type StatusStyle = { bg: string; color: string; dot: string };

function statusStyle(s: string): StatusStyle {
  const map: Record<string, StatusStyle> = {
    ACTIVE:    { bg: "#EAF6E3", color: "#2A5A0F", dot: "#52A41B" },
    PAUSED:    { bg: "#FAEEDA", color: "#633806", dot: "#BA7517" },
    CANCELLED: { bg: "#FCEBEB", color: "#791F1F", dot: "#E24B4A" },
    EXPIRED:   { bg: "#FCEBEB", color: "#791F1F", dot: "#E24B4A" },
    FAILED:    { bg: "#FCEBEB", color: "#791F1F", dot: "#E24B4A" },
    PENDING:   { bg: "#E8EEFB", color: "#1F3A78", dot: "#4A7BD8" },
  };
  return map[s] ?? { bg: "#F1F1F4", color: "#444", dot: "#888" };
}

// ─── Icons ────────────────────────────────────────────────────────────────────

const IconTotal = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7F77DD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="16" y2="17" />
  </svg>
);

const IconActive = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#52A41B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
);

const IconPaused = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#BA7517" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);

const IconCancelled = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E24B4A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="9" y1="9" x2="15" y2="15" />
    <line x1="15" y1="9" x2="9" y2="15" />
  </svg>
);

const IconCalendar = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

const IconBox = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
);

const IconInfo = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7F77DD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

const IconRefresh = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  iconBg,
  icon,
  dotColor,
}: {
  label: string;
  value: number;
  sub: string;
  iconBg: string;
  icon: React.ReactNode;
  dotColor: string;
}) {
  const display = useCountUp(value);
  return (
    <div
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.transform = "translateY(-3px)";
        el.style.boxShadow = "0 8px 24px rgba(0,0,0,0.08)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.transform = "none";
        el.style.boxShadow = "none";
      }}
      style={{
        background: "var(--p-color-bg-surface)",
        border: "1px solid var(--p-color-border)",
        borderRadius: "12px",
        padding: "20px",
        minWidth: 0,
        transition: "transform 0.15s ease, box-shadow 0.15s ease",
      }}
    >
      <InlineStack gap="400" blockAlign="center" wrap={false}>
        <div
          style={{
            width: "48px",
            height: "48px",
            borderRadius: "12px",
            background: iconBg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            {label}
          </Text>
          <Text as="p" variant="heading2xl" fontWeight="bold">
            {display}
          </Text>
        </BlockStack>
      </InlineStack>
      <div style={{ marginTop: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: dotColor,
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        <Text as="span" variant="bodySm" tone="subdued">
          {sub}
        </Text>
      </div>
    </div>
  );
}

// ─── Status Donut ─────────────────────────────────────────────────────────────

function StatusDonut({
  slices,
  total,
}: {
  slices: { label: string; value: number; color: string }[];
  total: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const size = 180;
  const stroke = 22;
  const r = (size - stroke) / 2;
  const c = size / 2;

  let acc = 0;
  const segs = slices.map((s, i) => {
    const pct = total > 0 ? (s.value / total) * 100 : 0;
    const seg = { ...s, i, pct, off: acc };
    acc += pct;
    return seg;
  });
  const active = hover != null ? segs[hover] : null;

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "32px", flexWrap: "wrap" }}>
      {/* Donut */}
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke="var(--p-color-bg-surface-secondary)"
            strokeWidth={stroke}
          />
          {segs.map((seg) => (
            <circle
              key={seg.label}
              cx={c}
              cy={c}
              r={r}
              fill="none"
              pathLength={100}
              strokeDasharray={`${seg.pct} ${100 - seg.pct}`}
              strokeDashoffset={-seg.off}
              strokeLinecap="butt"
              opacity={hover == null || hover === seg.i ? 1 : 0.35}
              onMouseEnter={() => setHover(seg.i)}
              onMouseLeave={() => setHover(null)}
              style={{
                stroke: seg.color,
                strokeWidth: hover === seg.i ? stroke + 4 : stroke,
                cursor: "pointer",
                transition: "opacity 0.15s ease, stroke-width 0.15s ease",
              }}
            />
          ))}
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <span style={{ fontSize: "30px", fontWeight: 700, color: "var(--p-color-text)", lineHeight: 1 }}>
            {active ? active.value : total}
          </span>
          <span style={{ fontSize: "12px", color: "var(--p-color-text-subdued)", marginTop: "4px" }}>
            {active ? active.label : "Total"}
          </span>
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: "200px" }}>
        {segs.map((seg) => (
          <div
            key={seg.label}
            onMouseEnter={() => setHover(seg.i)}
            onMouseLeave={() => setHover(null)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              cursor: "pointer",
              opacity: hover == null || hover === seg.i ? 1 : 0.5,
              transition: "opacity 0.15s ease",
            }}
          >
            <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: seg.color, flexShrink: 0 }} />
            <Text as="span" variant="bodySm">{seg.label}</Text>
            <span style={{ marginLeft: "auto", display: "flex", gap: "6px", alignItems: "baseline" }}>
              <Text as="span" variant="bodySm" fontWeight="semibold">{seg.value}</Text>
              <Text as="span" variant="bodySm" tone="subdued">({seg.pct.toFixed(0)}%)</Text>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Area/line chart (subscriptions over time) ────────────────────────────────

function niceCeil(n: number) {
  if (n <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  return Math.ceil(n / pow) * pow;
}

function AreaLineChart({ data }: { data: { label: string; value: number }[] }) {
  const W = 1000;
  const H = 220;
  const rawMax = Math.max(...data.map((d) => d.value), 1);
  const max = niceCeil(rawMax);
  const n = data.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - (v / max) * H;

  const linePts = data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ");
  const areaPts = `0,${H} ${linePts} ${W},${H}`;

  const gridLines = [0, 0.25, 0.5, 0.75, 1]; // fractions of max (bottom → top)

  return (
    <div style={{ display: "flex", gap: "8px" }}>
      {/* Y axis labels */}
      <div
        style={{
          display: "flex",
          flexDirection: "column-reverse",
          justifyContent: "space-between",
          height: `${H}px`,
          fontSize: "11px",
          color: "var(--p-color-text-subdued)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {gridLines.map((g) => (
          <span key={g}>{Math.round(max * g)}</span>
        ))}
      </div>

      {/* Plot + X labels */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ position: "relative", height: `${H}px` }}>
          {/* gridlines */}
          {gridLines.map((g) => (
            <div
              key={g}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: `${g * 100}%`,
                borderTop: "1px solid var(--p-color-border-secondary)",
                opacity: 0.6,
              }}
            />
          ))}
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={H}
            preserveAspectRatio="none"
            style={{ display: "block", position: "relative" }}
          >
            <defs>
              <linearGradient id="ov-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7F77DD" stopOpacity="0.28" />
                <stop offset="100%" stopColor="#7F77DD" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon points={areaPts} fill="url(#ov-gradient)" />
            <polyline
              points={linePts}
              fill="none"
              stroke="#7F77DD"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
        </div>
        {/* X axis labels */}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px" }}>
          {data.map((d, i) => (
            <span
              key={`${d.label}-${i}`}
              style={{ fontSize: "10px", color: "var(--p-color-text-subdued)", whiteSpace: "nowrap" }}
            >
              {d.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Status Pill ──────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const s = statusStyle(status);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 10px",
        background: s.bg,
        color: s.color,
        borderRadius: "20px",
        fontSize: "12px",
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: s.dot,
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      {titleCase(status)}
    </span>
  );
}

// ─── Row Action Menu ──────────────────────────────────────────────────────────

function RowActionMenu({ contractId, status }: { contractId: string; status: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fetcher = useFetcher();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Posts to the Subscriptions page's action, which owns the pause/resume/
  // cancel mutations. It used to post to "/app/subscriptions/action" — a route
  // that does not exist — so every click fell through to the root catch-all and
  // returned 405.
  //
  // `contractId` is the Shopify GID on the dashboard's live path and the Prisma
  // cuid on its DB fallback; that action resolves either.
  const STATUS_FOR: Record<"pause" | "resume" | "cancel", string> = {
    pause:  "PAUSED",
    resume: "ACTIVE",
    cancel: "CANCELLED",
  };

  const busy  = fetcher.state !== "idle";
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  const submit = (action: "pause" | "resume" | "cancel") => {
    if (busy) return;
    setOpen(false);
    fetcher.submit(
      { id: contractId, status: STATUS_FOR[action] },
      { method: "post", action: "/app/subscriptions" },
    );
  };

  // Disabled while a change is in flight so a second click cannot fire another
  // billing-state mutation before the first settles.
  const canPause  = status === "ACTIVE" && !busy;
  const canResume = status === "PAUSED" && !busy;
  const canCancel = (status === "ACTIVE" || status === "PAUSED") && !busy;

  const itemStyle = (enabled: boolean): React.CSSProperties => ({
    display: "block",
    width: "100%",
    padding: "8px 14px",
    fontSize: "13px",
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: enabled ? "var(--p-color-text)" : "var(--p-color-text-disabled)",
    cursor: enabled ? "pointer" : "not-allowed",
  });

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "28px",
          height: "28px",
          border: "none",
          background: "transparent",
          borderRadius: "6px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--p-color-text-subdued)",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--p-color-bg-surface-hover)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        }}
        aria-label="Actions"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "-66px",
            right: 0,
            minWidth: "150px",
            background: "var(--p-color-bg-surface)",
            border: "1px solid var(--p-color-border)",
            borderRadius: "8px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            zIndex: 10,
            padding: "4px 0",
          }}
        >
          <button
            disabled={!canPause}
            onClick={() => canPause && submit("pause")}
            style={itemStyle(canPause)}
          >
            Pause
          </button>
          <button
            disabled={!canResume}
            onClick={() => canResume && submit("resume")}
            style={itemStyle(canResume)}
          >
            Resume
          </button>
          <div style={{ height: "1px", background: "var(--p-color-border-secondary)", margin: "4px 0" }} />
          <button
            disabled={!canCancel}
            onClick={() => canCancel && submit("cancel")}
            style={{
              ...itemStyle(canCancel),
              color: canCancel ? "#E24B4A" : "var(--p-color-text-disabled)",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Nothing read fetcher.data before, so a failed pause/cancel was
          indistinguishable from nothing happening — which is how the wrong
          endpoint survived unnoticed until it started returning 405. */}
      {error && (
        <div
          role="alert"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "4px",
            zIndex: 11,
            minWidth: "200px",
            padding: "8px 10px",
            background: "var(--p-color-bg-surface)",
            border: "1px solid #E24B4A",
            borderRadius: "6px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            fontSize: "12px",
            color: "#E24B4A",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

// ─── Contracts Table ──────────────────────────────────────────────────────────

type ColKey = "customer" | "product" | "plan" | "status" | "price" | "nextBilling";

const COLUMNS: Array<{
  key: ColKey;
  label: string;
  width: string;
  type: "text" | "number";
  searchVal: (c: ShapedContract) => string;
  sortVal: (c: ShapedContract) => string | number;
}> = [
  { key: "customer",    label: "Customer",     width: "22%", type: "text",   searchVal: (c) => c.customerEmail,   sortVal: (c) => c.customerEmail },
  { key: "product",     label: "Product",      width: "17%", type: "text",   searchVal: (c) => c.productTitle,    sortVal: (c) => c.productTitle },
  { key: "plan",        label: "Plan",         width: "17%", type: "text",   searchVal: (c) => c.planName,        sortVal: (c) => c.planName },
  { key: "status",      label: "Status",       width: "12%", type: "text",   searchVal: (c) => c.status,          sortVal: (c) => c.status },
  { key: "price",       label: "Price",        width: "12%", type: "number", searchVal: (c) => c.price,           sortVal: (c) => c.priceAmount },
  { key: "nextBilling", label: "Next Billing", width: "15%", type: "number", searchVal: (c) => c.nextBillingDate, sortVal: (c) => c.nextBillingTs },
];

const emptyFilters: Record<ColKey, string> = {
  customer: "", product: "", plan: "", status: "", price: "", nextBilling: "",
};

// Friendly sort-button labels per sortable column
const SORT_LABELS: Partial<Record<ColKey, { asc: string; desc: string }>> = {
  customer:    { asc: "Sort ascending", desc: "Sort descending" },
  product:     { asc: "Sort ascending", desc: "Sort descending" },
  price:       { asc: "Lowest",         desc: "Highest" },
  nextBilling: { asc: "Coming up",      desc: "Far away" },
};

// Plan interval options (value = substring matched against planName)
const PLAN_OPTIONS = [
  { value: "",      label: "All plans" },
  { value: "day",   label: "Day"   },
  { value: "week",  label: "Week"  },
  { value: "month", label: "Month" },
  { value: "year",  label: "Year"  },
];

function ContractsTable({ contracts }: { contracts: ShapedContract[] }) {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Record<ColKey, string>>(emptyFilters);
  const [sortCol, setSortCol] = useState<ColKey | "created" | "">("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [popover, setPopover] = useState<{ col: ColKey; x: number; y: number } | null>(null);

  // The visible column that "owns" the current sort (the synthetic "created" sort lives in Customer)
  const sortOwnerCol: ColKey | "" = sortCol === "created" ? "customer" : sortCol;

  // Close the column popover on outside click / scroll / resize
  useEffect(() => {
    if (!popover) return;
    const close = () => setPopover(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-col-popover]") && !t.closest("[data-col-trigger]")) close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [popover]);

  // Reset to page 1 whenever the filters or sort change
  useEffect(() => {
    setPage(1);
  }, [filters, sortCol, sortDir]);

  // Status options: canonical set (matches stat cards) + any extra statuses in the data
  const statusOptions = useMemo(() => {
    const base = ["ACTIVE", "PAUSED", "CANCELLED"];
    const extra = Array.from(new Set(contracts.map((c) => c.status))).filter((s) => s && !base.includes(s));
    return ["", ...base, ...extra]; // "" = All statuses
  }, [contracts]);

  // Per-column search (AND across columns with a non-empty query)
  const filtered = useMemo(() => {
    const active = COLUMNS.filter((c) => filters[c.key].trim());
    if (!active.length) return contracts;
    return contracts.filter((c) =>
      active.every((col) =>
        col.searchVal(c).toLowerCase().includes(filters[col.key].trim().toLowerCase()),
      ),
    );
  }, [contracts, filters]);

  const sorted = useMemo(() => {
    if (!sortCol) return filtered;
    const spec =
      sortCol === "created"
        ? { type: "number" as const, val: (c: ShapedContract) => c.createdTs }
        : (() => {
            const col = COLUMNS.find((c) => c.key === sortCol)!;
            return { type: col.type, val: col.sortVal };
          })();
    return [...filtered].sort((a, b) => {
      const r =
        spec.type === "number"
          ? (spec.val(a) as number) - (spec.val(b) as number)
          : String(spec.val(a)).localeCompare(String(spec.val(b)), undefined, { sensitivity: "base" });
      return sortDir === "asc" ? r : -r;
    });
  }, [filtered, sortCol, sortDir]);

  function openPopover(col: ColKey, e: React.MouseEvent<HTMLButtonElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    setPopover((p) =>
      p?.col === col ? null : { col, x: Math.min(r.left, window.innerWidth - 232), y: r.bottom + 6 },
    );
  }

  function applySort(col: ColKey | "created", d: "asc" | "desc") {
    setSortCol(col);
    setSortDir(d);
    setPopover(null);
  }

  function clearColumn(col: ColKey) {
    setFilters((f) => ({ ...f, [col]: "" }));
    if (sortOwnerCol === col) setSortCol("");
    setPopover(null);
  }

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const start    = (page - 1) * PAGE_SIZE;
  const pageRows = sorted.slice(start, start + PAGE_SIZE);

  const thStyle: React.CSSProperties = {
    padding: "12px 20px",
    textAlign: "left",
    fontSize: "11px",
    fontWeight: 600,
    color: "var(--p-color-text-subdued)",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    background: "transparent",
    borderBottom: "1px solid var(--p-color-border-secondary)",
    whiteSpace: "nowrap",
  };

  const tdStyle: React.CSSProperties = {
    padding: "16px 20px",
    verticalAlign: "middle",
    borderBottom: "1px solid var(--p-color-border-secondary)",
    fontSize: "13px",
    color: "var(--p-color-text)",
    maxWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  return (
    <BlockStack gap="0">
      <div style={{ overflowX: "auto", width: "100%" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            {COLUMNS.map((col) => (
              <col key={col.key} style={{ width: col.width }} />
            ))}
            <col style={{ width: "5%" }} />
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((col) => {
                const isActive = filters[col.key].trim() !== "" || sortOwnerCol === col.key;
                return (
                  <th key={col.key} style={thStyle}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      {col.label}
                      {sortOwnerCol === col.key && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#3C3489" strokeWidth="3">
                          {sortDir === "asc"
                            ? <polyline points="18 15 12 9 6 15" />
                            : <polyline points="6 9 12 15 18 9" />}
                        </svg>
                      )}
                      <button
                        data-col-trigger
                        onClick={(e) => openPopover(col.key, e)}
                        aria-label={`Filter and sort ${col.label}`}
                        style={{
                          display:        "inline-flex",
                          alignItems:     "center",
                          justifyContent: "center",
                          width:          "20px",
                          height:         "20px",
                          padding:        0,
                          cursor:         "pointer",
                          border:         "none",
                          borderRadius:   "5px",
                          background:     isActive ? "#EEEDFE" : "transparent",
                          color:          isActive ? "#3C3489" : "var(--p-color-text-subdued)",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                        </svg>
                      </button>
                    </span>
                  </th>
                );
              })}
              <th style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((c, i) => {
              const isLast = i === pageRows.length - 1;
              const cell: React.CSSProperties = isLast
                ? { ...tdStyle, borderBottom: "none" }
                : tdStyle;
              const baseBg = i % 2 === 1 ? "var(--p-color-bg-surface-secondary)" : "transparent";
              const rowColor = rowColorFor(c.id || c.customerEmail || c.shortId);
              const initial = (c.customerEmail?.[0] ?? "?").toUpperCase();

              return (
                <tr
                  key={c.id}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background =
                      "var(--p-color-bg-surface-hover)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = baseBg;
                  }}
                  style={{ background: baseBg, transition: "background 0.12s ease", cursor: "default" }}
                >
                  {/* Customer */}
                  <td style={cell}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                      <div
                        style={{
                          width: "32px",
                          height: "32px",
                          borderRadius: "50%",
                          background: rowColor,
                          color: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "14px",
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {initial}
                      </div>
                      <div style={{ minWidth: 0, overflow: "hidden" }}>
                        <div
                          style={{
                            fontWeight: 500,
                            fontSize: "13px",
                            color: "var(--p-color-text)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.customerEmail}
                        </div>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "var(--p-color-text-subdued)",
                            marginTop: "2px",
                          }}
                        >
                          #{c.shortId}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Product */}
                  <td style={cell}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                      <div
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "6px",
                          background: rowColor,
                          border: "none",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                          color: "#fff",
                        }}
                      >
                        {IconBox}
                      </div>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          minWidth: 0,
                        }}
                      >
                        {c.productTitle}
                      </span>
                    </div>
                  </td>

                  {/* Plan */}
                  <td
                    style={{
                      ...cell,
                      color: "var(--p-color-text-subdued)",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        overflow: "hidden",
                        maxWidth: "100%",
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "26px", height: "26px", borderRadius: "6px", background: `${rowColor}22`, color: rowColor, flexShrink: 0 }}>{IconCalendar}</span>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.planName}
                      </span>
                    </span>
                  </td>

                  {/* Status */}
                  <td style={{ ...cell, overflow: "visible" }}>
                    <StatusPill status={c.status} />
                  </td>

                  {/* Price */}
                  <td style={{ ...cell, fontWeight: 600 }}>{c.price}</td>

                  {/* Next Billing */}
                  <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "26px", height: "26px", borderRadius: "6px", background: `${rowColor}22`, color: rowColor, flexShrink: 0 }}>
                        {IconCalendar}
                      </span>
                      {c.nextBillingDate}
                    </span>
                  </td>

                  {/* Actions */}
                  <td style={{ ...cell, overflow: "visible", textAlign: "right" }} className="view-more">
                    <div className="action_cancel_resu">
                    <RowActionMenu contractId={c.id} status={c.status} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* No results after filtering */}
      {sorted.length === 0 && (
        <Box paddingBlock="800" paddingInline="400">
          <Text as="p" variant="bodySm" tone="subdued" alignment="center">
            No contracts match your filters.
          </Text>
        </Box>
      )}

      {/* Pagination — hidden when ≤ PAGE_SIZE rows */}
      {totalPages > 1 && (
        <>
          <Divider />
          <Box paddingBlock="300" paddingInline="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                Showing {start + 1}–{Math.min(start + PAGE_SIZE, sorted.length)} of{" "}
                {sorted.length} contracts
              </Text>

              <InlineStack gap="100" blockAlign="center">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--p-color-border)",
                    background: "var(--p-color-bg-surface)",
                    color:
                      page === 1
                        ? "var(--p-color-text-disabled)"
                        : "var(--p-color-text)",
                    fontSize: "13px",
                    cursor: page === 1 ? "not-allowed" : "pointer",
                    opacity: page === 1 ? 0.5 : 1,
                  }}
                >
                  ← Prev
                </button>

                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter(
                    (p) =>
                      p === 1 ||
                      p === totalPages ||
                      Math.abs(p - page) <= 1,
                  )
                  .reduce<(number | "...")[]>((acc, p, idx, arr) => {
                    if (idx > 0 && (arr[idx - 1] as number) < p - 1) {
                      acc.push("...");
                    }
                    acc.push(p);
                    return acc;
                  }, [])
                  .map((p, i) =>
                    p === "..." ? (
                      <span
                        key={`dots-${i}`}
                        style={{
                          padding: "0 4px",
                          color: "var(--p-color-text-subdued)",
                          fontSize: "13px",
                        }}
                      >
                        …
                      </span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => setPage(p as number)}
                        style={{
                          width: "32px",
                          height: "32px",
                          borderRadius: "6px",
                          border: "1px solid var(--p-color-border)",
                          background:
                            p === page
                              ? "#26215C"
                              : "var(--p-color-bg-surface)",
                          color:
                            p === page
                              ? "#fff"
                              : "var(--p-color-text-subdued)",
                          fontSize: "13px",
                          cursor: "pointer",
                          fontWeight: p === page ? 600 : 400,
                          transition: "all 0.1s ease",
                        }}
                      >
                        {p}
                      </button>
                    ),
                  )}

                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "1px solid var(--p-color-border)",
                    background: "var(--p-color-bg-surface)",
                    color:
                      page === totalPages
                        ? "var(--p-color-text-disabled)"
                        : "var(--p-color-text)",
                    fontSize: "13px",
                    cursor: page === totalPages ? "not-allowed" : "pointer",
                    opacity: page === totalPages ? 0.5 : 1,
                  }}
                >
                  Next →
                </button>
              </InlineStack>
            </InlineStack>
          </Box>
        </>
      )}

      {/* Per-column filter/sort popover (fixed, anchored to the header icon) */}
      {popover && (() => {
        const col = COLUMNS.find((c) => c.key === popover.col)!;
        const current = filters[col.key];

        const optionBtn = (active: boolean): React.CSSProperties => ({
          display:      "flex",
          alignItems:   "center",
          gap:          "8px",
          width:        "100%",
          textAlign:    "left",
          padding:      "8px 10px",
          fontSize:     "13px",
          border:       "none",
          borderRadius: "7px",
          background:   active ? "#EEEDFE" : "transparent",
          color:        active ? "#3C3489" : "var(--p-color-text)",
          fontWeight:   active ? 500 : 400,
          cursor:       "pointer",
        });

        const wrap = (children: React.ReactNode) => (
          <div
            data-col-popover
            style={{
              position:     "fixed",
              top:          popover.y,
              left:         popover.x,
              width:        "220px",
              background:   "var(--p-color-bg-surface)",
              border:       "1px solid var(--p-color-border)",
              borderRadius: "10px",
              boxShadow:    "0 6px 24px rgba(0,0,0,0.12)",
              padding:      "6px",
              zIndex:       400,
            }}
          >
            {children}
          </div>
        );

        // ── Status: pick a status to filter by ──
        if (col.key === "status") {
          return wrap(
            statusOptions.map((s) => (
              <button
                key={s || "all"}
                style={optionBtn(current === s)}
                onClick={() => { setFilters((f) => ({ ...f, status: s })); setPopover(null); }}
              >
                {s ? (
                  <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: statusStyle(s).dot, flexShrink: 0 }} />
                ) : (
                  <span style={{ width: "8px", flexShrink: 0 }} />
                )}
                {s ? titleCase(s) : "All statuses"}
              </button>
            )),
          );
        }

        // ── Plan: pick an interval to filter by ──
        if (col.key === "plan") {
          return wrap(
            PLAN_OPTIONS.map((opt) => (
              <button
                key={opt.value || "all"}
                style={optionBtn(current === opt.value)}
                onClick={() => { setFilters((f) => ({ ...f, plan: opt.value })); setPopover(null); }}
              >
                {opt.label}
              </button>
            )),
          );
        }

        // ── Customer: sort by email (A–Z / Z–A) or creation date (Newest / Oldest) ──
        if (col.key === "customer") {
          const hasFilterC = current.trim() !== "";
          const clockIcon = (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          );
          return wrap(
            <>
              <button style={optionBtn(sortCol === "customer" && sortDir === "asc")} onClick={() => applySort("customer", "asc")}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
                Sort ascending
              </button>
              <button style={optionBtn(sortCol === "customer" && sortDir === "desc")} onClick={() => applySort("customer", "desc")}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                Sort descending
              </button>
              <button style={optionBtn(sortCol === "created" && sortDir === "desc")} onClick={() => applySort("created", "desc")}>
                {clockIcon}
                Newest
              </button>
              <button style={optionBtn(sortCol === "created" && sortDir === "asc")} onClick={() => applySort("created", "asc")}>
                {clockIcon}
                Oldest
              </button>

              <div style={{ height: "1px", background: "var(--p-color-border-secondary)", margin: "6px 4px" }} />

              <div
                style={{
                  display:      "flex",
                  alignItems:   "center",
                  gap:          "8px",
                  padding:      "6px 8px",
                  border:       "1px solid var(--p-color-border)",
                  borderRadius: "8px",
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                  <path d="M14 14L10 10M11.3333 6.66667C11.3333 9.24227 9.24227 11.3333 6.66667 11.3333C4.09106 11.3333 2 9.24227 2 6.66667C2 4.09106 4.09106 2 6.66667 2C9.24227 2 11.3333 4.09106 11.3333 6.66667L14 14" stroke="#9CA3AF" strokeWidth="1.33333" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <input
                  autoFocus
                  value={current}
                  onChange={(e) => setFilters((f) => ({ ...f, customer: e.target.value }))}
                  placeholder="Search Customer…"
                  style={{
                    border:     "none",
                    background: "transparent",
                    fontSize:   "13px",
                    color:      "var(--p-color-text)",
                    outline:    "none",
                    width:      "100%",
                    minWidth:   0,
                  }}
                />
              </div>

              {(hasFilterC || sortOwnerCol === "customer") && (
                <button
                  onClick={() => clearColumn("customer")}
                  style={{
                    width:        "100%",
                    marginTop:    "6px",
                    padding:      "7px 10px",
                    fontSize:     "12px",
                    border:       "none",
                    borderRadius: "7px",
                    background:   "transparent",
                    color:        "#E24B4A",
                    cursor:       "pointer",
                    textAlign:    "left",
                  }}
                >
                  Clear
                </button>
              )}
            </>,
          );
        }

        // ── Sortable columns: product / price / nextBilling ──
        const labels = SORT_LABELS[col.key] ?? { asc: "Sort ascending", desc: "Sort descending" };
        const hasFilter = current.trim() !== "";
        return wrap(
          <>
            <button style={optionBtn(sortCol === col.key && sortDir === "asc")} onClick={() => applySort(col.key, "asc")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="18 15 12 9 6 15" />
              </svg>
              {labels.asc}
            </button>
            <button style={optionBtn(sortCol === col.key && sortDir === "desc")} onClick={() => applySort(col.key, "desc")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="6 9 12 15 18 9" />
              </svg>
              {labels.desc}
            </button>

            <div style={{ height: "1px", background: "var(--p-color-border-secondary)", margin: "6px 4px" }} />

            <div
              style={{
                display:      "flex",
                alignItems:   "center",
                gap:          "8px",
                padding:      "6px 8px",
                border:       "1px solid var(--p-color-border)",
                borderRadius: "8px",
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <path d="M14 14L10 10M11.3333 6.66667C11.3333 9.24227 9.24227 11.3333 6.66667 11.3333C4.09106 11.3333 2 9.24227 2 6.66667C2 4.09106 4.09106 2 6.66667 2C9.24227 2 11.3333 4.09106 11.3333 6.66667L14 14" stroke="#9CA3AF" strokeWidth="1.33333" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <input
                autoFocus
                value={current}
                onChange={(e) => setFilters((f) => ({ ...f, [col.key]: e.target.value }))}
                placeholder={`Search ${col.label}…`}
                style={{
                  border:     "none",
                  background: "transparent",
                  fontSize:   "13px",
                  color:      "var(--p-color-text)",
                  outline:    "none",
                  width:      "100%",
                  minWidth:   0,
                }}
              />
            </div>

            {(hasFilter || sortCol === col.key) && (
              <button
                onClick={() => clearColumn(col.key)}
                style={{
                  width:        "100%",
                  marginTop:    "6px",
                  padding:      "7px 10px",
                  fontSize:     "12px",
                  border:       "none",
                  borderRadius: "7px",
                  background:   "transparent",
                  color:        "#E24B4A",
                  cursor:       "pointer",
                  textAlign:    "left",
                }}
              >
                Clear
              </button>
            )}
          </>,
        );
      })()}
    </BlockStack>
  );
}

// ─── Page Component ───────────────────────────────────────────────────────────

export default function Index() {
  const { stats, contracts, fetchError } = useLoaderData<typeof loader>();
  const navigate    = useNavigate();
  const navigation  = useNavigation();
  const revalidator = useRevalidator();

  // Real sync time for the footer. It used to be the hardcoded words "just
  // now", which claimed the data was fresh however long the page had been open.
  const [lastSyncedAt, setLastSyncedAt] = useState<Date>(new Date());

  useEffect(() => {
    if (navigation.state === "idle" && revalidator.state === "idle") {
      setLastSyncedAt(new Date());
    }
  }, [contracts, navigation.state, revalidator.state]);

  // Same shape as the one on app.subscriptions.tsx. Kept local rather than
  // extracted so this fix does not touch that page, which already works.
  function timeAgo(d: Date) {
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 5)    return "just now";
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  const safeTotal      = stats.total || 1;
  const activeRatio    = Math.round((stats.active    / safeTotal) * 100);
  const pausedRatio    = Math.round((stats.paused    / safeTotal) * 100);
  const cancelledRatio = Math.round((stats.cancelled / safeTotal) * 100);

  // Status breakdown slices for the donut — always list the canonical statuses
  // (Active/Paused/Cancelled) even at 0, plus any other statuses present.
  const statusCounts = useMemo(() => {
    const m: Record<string, number> = {};
    contracts.forEach((c) => { m[c.status] = (m[c.status] ?? 0) + 1; });
    return m;
  }, [contracts]);
  const CANON_STATUSES = ["ACTIVE", "PAUSED", "CANCELLED"];
  const donutSlices = [
    ...CANON_STATUSES,
    ...Object.keys(statusCounts).filter((s) => !CANON_STATUSES.includes(s)).sort(),
  ].map((status) => ({
    label: titleCase(status),
    value: statusCounts[status] ?? 0,
    color: statusStyle(status).dot,
  }));

  // Cumulative subscriptions over time for the overview chart
  const [range, setRange] = useState(12); // trailing months
  const overviewData = useMemo(() => {
    const now = new Date();
    const startBound = new Date(now.getFullYear(), now.getMonth() - (range - 1), 1).getTime();
    const buckets: { key: string; label: string; count: number }[] = [];
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({
        key: `${d.getFullYear()}-${d.getMonth()}`,
        label: d.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
        count: 0,
      });
    }
    const idx: Record<string, number> = {};
    buckets.forEach((b, i) => (idx[b.key] = i));
    let base = 0; // subscriptions created before the window → starting cumulative
    contracts.forEach((c) => {
      if (c.createdTs < startBound) { base++; return; }
      const d = new Date(c.createdTs);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (key in idx) buckets[idx[key]].count++;
    });
    let running = base;
    return buckets.map((b) => ({ label: b.label, value: (running += b.count) }));
  }, [contracts, range]);

  const RANGE_OPTIONS = [
    { value: 3, label: "3M" },
    { value: 6, label: "6M" },
    { value: 12, label: "12M" },
  ];

  return (
    <Page fullWidth>
      <TitleBar title="Dashboard" />

      <BlockStack gap="600">

        {/* Error banner */}
        {fetchError && (
          <Banner title="Could not load live contracts" tone="critical">
            <Text as="p" variant="bodySm">
              {fetchError}
            </Text>
          </Banner>
        )}
        <div className="breadcrumb-wrapper">
  <InlineStack gap="150" blockAlign="center">
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: "#7F77DD",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <div className="breadcrumbs-dashboard">
              <Text as="span" variant="bodySm" tone="subdued">
                Smart Subscriptions › Dashboard › <span className="subscription">Subscriptions</span>
              </Text>
              </div>
            </InlineStack>
            </div>
        {/* ── Page header ─────────────────────────────────────────── */}
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <BlockStack gap="100">

            <Text as="h1" variant="headingXl" fontWeight="bold">
              Subscriptions
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Overview of all subscription contracts
            </Text>
          </BlockStack>

        <div className="top-analytics-btn">

          <InlineStack gap="200">
            <Button onClick={() => navigate("/app/analytics")}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M3.33337 14V10M8.00004 14V2M12.6667 14V6" stroke="#1A1A1A" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round"/>
</svg>


              Analytics
            </Button>
            <Button variant="primary" onClick={() => navigate("/app/plans")}>
     <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M5.33337 1.33333V3.99999M10.6667 1.33333V3.99999" stroke="white" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M3.33333 2.66667H12.6667C13.4026 2.66667 14 3.26412 14 4.00001V13.3333C14 14.0692 13.4026 14.6667 12.6667 14.6667H3.33333C2.59745 14.6667 2 14.0692 2 13.3333V4.00001C2 3.26412 2.59745 2.66667 3.33333 2.66667V2.66667" stroke="white" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M2 6.66667H14M5.33333 9.33334H5.34M8 9.33334H8.00667M10.6667 9.33334H10.6733M5.33333 12H5.34M8 12H8.00667M10.6667 12H10.6733" stroke="white" stroke-width="1.33333" stroke-linecap="round" stroke-linejoin="round"/>
</svg>

              Manage plans
            </Button>
          </InlineStack>
        </div>
        </InlineStack>

        {/* ── Stat cards ──────────────────────────────────────────── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "16px",
          }}
        >
          <div className="total_contracts">
          <StatCard
            label="Total Contracts"
            value={stats.total}
            sub="All statuses"
            iconBg="#EEEDFE"
            icon={IconTotal}
            dotColor="#7F77DD"
          />
          </div>
            <div className="total_contracts-second">
          <StatCard
            label="Active"
            value={stats.active}
            sub={`${activeRatio}% of total`}
            iconBg="#EAF6E3"
            icon={IconActive}
            dotColor="#52A41B"
          />
          </div>
          <div className="total_contracts-third">
          <StatCard
            label="Paused"
            value={stats.paused}
            sub={`${pausedRatio}% of total`}
            iconBg="#FAEEDA"
            icon={IconPaused}
            dotColor="#BA7517"
          />
          </div>
          <div className="total_contracts-fourth">
          <StatCard
            label="Cancelled"
            value={stats.cancelled}
            sub={`${cancelledRatio}% of total`}
            iconBg="#FCEBEB"
            icon={IconCancelled}
            dotColor="#E24B4A"
          />
        </div>
        </div>

        {/* ── Subscriptions overview + status donut ────────────────── */}
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "stretch" }}>
          {/* Overview */}
          <div
            style={{
              flex: "1 1 340px",
              minWidth: 0,
              background: "var(--p-color-bg-surface)",
              border: "1px solid var(--p-color-border)",
              borderRadius: "12px",
              padding: "20px 24px",
            }}
          >
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd" fontWeight="bold">Subscriptions Overview</Text>
              <div
                style={{
                  display: "flex",
                  gap: "2px",
                  padding: "3px",
                  borderRadius: "9px",
                  background: "var(--p-color-bg-surface-secondary)",
                }}
              >
                {RANGE_OPTIONS.map((opt) => {
                  const isActive = range === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setRange(opt.value)}
                      style={{
                        border: "none",
                        borderRadius: "7px",
                        padding: "4px 12px",
                        fontSize: "12px",
                        fontWeight: isActive ? 600 : 400,
                        cursor: "pointer",
                        background: isActive ? "var(--p-color-bg-surface)" : "transparent",
                        color: isActive ? "#3C3489" : "var(--p-color-text-subdued)",
                        boxShadow: isActive ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </InlineStack>
            <div style={{ marginTop: "16px" }}>
              {stats.total === 0 ? (
                <Text as="p" tone="subdued">No data yet.</Text>
              ) : (
                <AreaLineChart data={overviewData} />
              )}
            </div>
          </div>

          {/* Status donut */}
          <div
            style={{
              flex: "1 1 340px",
              minWidth: 0,
              background: "var(--p-color-bg-surface)",
              border: "1px solid var(--p-color-border)",
              borderRadius: "12px",
              padding: "20px 24px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd" fontWeight="bold">Subscriptions by Status</Text>
              <Text as="p" variant="bodySm" tone="subdued">{stats.total} total</Text>
            </InlineStack>
            <div style={{ marginTop: "16px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              {stats.total === 0 ? (
                <Text as="p" tone="subdued">No subscriptions yet.</Text>
              ) : (
                <StatusDonut slices={donutSlices} total={stats.total} />
              )}
            </div>
          </div>
        </div>

        {/* ── Contracts table ──────────────────────────────────────── */}
        <div
          style={{
            background: "var(--p-color-bg-surface)",
            border: "1px solid var(--p-color-border)",
            borderRadius: "12px",
            overflow: "hidden",
          }}
        >
          <div className="table-banner">
          {/* Table header */}
          {/* <Box paddingInline="500" paddingBlock="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: "#52A41B",
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  <Text as="h2" variant="headingMd" fontWeight="bold">
                    Subscription Contracts
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {stats.total} total · synced live from Shopify API
                </Text>
              </BlockStack>
              <Button onClick={() => navigate("/app/subscriptions")}>
                View all →
              </Button>
            </InlineStack>
          </Box> */}

          <Divider />

          {contracts.length === 0 && !fetchError ? (
            <Box padding="600">
              <EmptyState
                heading="No subscription contracts yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{
                  content: "Create selling plan",
                  onAction: () => navigate("/app/plans"),
                }}
              >
                <Text as="p" tone="subdued">
                  Contracts appear once a customer subscribes at checkout.
                </Text>
              </EmptyState>
            </Box>
          ) : (
            <ContractsTable contracts={contracts} />
          )}
        </div>
</div>
        {/* ── Info banner ─────────────────────────────────────────── */}
        <div
          style={{
            background: "#F6F5FE",
            border: "1px solid #E1DEFB",
            borderRadius: "12px",
            padding: "16px 20px",
          }}
        >
          <InlineStack align="space-between" blockAlign="center" wrap={false}>
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <div
                style={{
                  width: "36px",
                  height: "36px",
                  borderRadius: "10px",
                  background: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {IconInfo}
              </div>
              <Text as="p" variant="bodySm">
                All subscription data is synced in real-time from Shopify. Last synced {timeAgo(lastSyncedAt)}.
              </Text>
            </InlineStack>
            <button
              type="button"
              onClick={() => revalidator.revalidate()}
              disabled={revalidator.state === "loading"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 14px",
                background: "#fff",
                border: "1px solid var(--p-color-border)",
                borderRadius: "8px",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--p-color-text)",
                cursor: revalidator.state === "loading" ? "wait" : "pointer",
                opacity: revalidator.state === "loading" ? 0.7 : 1,
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  animation: revalidator.state === "loading" ? "spin 1s linear infinite" : "none",
                }}
              >
                {IconRefresh}
              </span>
              Refresh now
            </button>
          </InlineStack>
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


