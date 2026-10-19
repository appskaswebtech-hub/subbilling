// app/routes/app.activity.tsx
//
// Activity: what happened to the shop's subscriptions, plans and bundles, and
// where each prepaid subscription's next payment link stands. Only for shops
// with prepaid subscriptions; the menu shows it on the same condition (app.tsx).
// The data comes from app/lib/activity.server.ts.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Page, BlockStack, InlineStack, Text, Button } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  ACTIVITY_WINDOWS,
  activityTimeline,
  hasPrepaidActivity,
  parseWindow,
  prepaidStatusBoard,
  type ActivityEvent,
  type ActivityKind,
  type BoardRow,
} from "../lib/activity.server";
import { BRAND_GRADIENT } from "../config/theme";

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  // The library's redirect: Remix's own drops the admin's store details on a
  // full page load, which ends on the "Log in" form.
  const { session, redirect } = await authenticate.admin(request);
  if (!(await hasPrepaidActivity(session.shop))) throw redirect("/app");

  const days = parseWindow(new URL(request.url).searchParams.get("days"));
  const [board, timeline] = await Promise.all([
    prepaidStatusBoard(session.shop),
    activityTimeline(session.shop, days),
  ]);
  // The next wider window for "Show older"; none once at the widest.
  const wider = ACTIVITY_WINDOWS.find((d) => d > days) ?? null;
  return json({ board, timeline, wider });
}

// ─── Design tokens (as on the Subscriptions page) ────────────
const T = {
  purple:   "#7F77DD",
  purpleBg: "#EEEDFE",
  purpleFg: "#3C3489",
  greenBg:  "#EAF3DE",
  greenFg:  "#27500A",
  amberBg:  "#FAEEDA",
  amberFg:  "#633806",
  redBg:    "#FCEBEB",
  redFg:    "#791F1F",
  blueBg:   "#E6F1FB",
  blueFg:   "#185FA5",
  greyBg:   "#F1F1F1",
  greyFg:   "#4A4A4A",
};

type Tone = { bg: string; fg: string };
const PURPLE = { bg: T.purpleBg, fg: T.purpleFg };
const GREEN  = { bg: T.greenBg,  fg: T.greenFg  };
const AMBER  = { bg: T.amberBg,  fg: T.amberFg  };
const RED    = { bg: T.redBg,    fg: T.redFg    };
const BLUE   = { bg: T.blueBg,   fg: T.blueFg   };
const GREY   = { bg: T.greyBg,   fg: T.greyFg   };

const BADGE: Record<ActivityKind, { label: string; tone: Tone }> = {
  "subscription-created": { label: "New subscription", tone: PURPLE },
  "plan-created":         { label: "Plan created",     tone: BLUE },
  "bundle-created":       { label: "Bundle created",   tone: BLUE },
  "link-sent":            { label: "Link sent",        tone: BLUE },
  "link-reminder":        { label: "Reminder",         tone: AMBER },
  "link-paid":            { label: "Paid",             tone: GREEN },
  "link-failed":          { label: "Not sent",         tone: RED },
  "link-expired":         { label: "Expired",          tone: RED },
  "link-cancelled":       { label: "Cancelled",        tone: GREY },
  "charged":              { label: "Charged",          tone: GREEN },
  "charge-failed":        { label: "Charge failed",    tone: RED },
  "charge-pending":       { label: "Charging",         tone: AMBER },
};

const CATEGORY_FILTERS = [
  { value: "all",     label: "All" },
  { value: "links",   label: "Payment links" },
  { value: "charges", label: "Charges" },
  { value: "setup",   label: "New & setup" },
];
const KIND_FILTERS = [
  { value: "all",     label: "Plans & bundles" },
  { value: "plans",   label: "Plans" },
  { value: "bundles", label: "Bundles" },
];

// ─── Formatting ───────────────────────────────────────────────
// Rendered on the server in UTC and again in the browser; the first browser
// render repeats UTC so hydration matches, then switches to local time.
function useTimeZone(): string | undefined {
  const [tz, setTz] = useState<string | undefined>("UTC");
  useEffect(() => setTz(undefined), []);
  return tz;
}

function fmtDate(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone });
}
function fmtDateTime(iso: string | null, timeZone?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone,
  });
}
function fmtTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
}
function dayHeading(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone });
}
function money(amount: number | null, currency: string | null): string {
  if (amount == null) return "";
  return currency && currency !== "USD" ? `${amount.toFixed(2)} ${currency}` : `$${amount.toFixed(2)}`;
}
const senderText = (sender: string | null) => (sender === "SMTP" ? "your email server (SMTP)" : "Shopify email");

/** The sentence under an event's title. */
function describe(e: ActivityEvent, tz?: string): string {
  const renewal = e.firstPayment ? "First payment" : e.cycleDate ? `Renewal ${fmtDate(e.cycleDate, tz)}` : "";
  const to      = e.customer ? ` to ${e.customer}` : "";
  const payBy   = e.payBy ? ` · pay by ${fmtDate(e.payBy, tz)}` : "";
  switch (e.kind) {
    case "subscription-created":
      return [e.prepaid ? "Prepaid" : "Postpaid", e.detail, e.customer].filter(Boolean).join(" · ");
    case "plan-created":   return `${e.prepaid ? "Prepaid" : "Postpaid"} subscription plan`;
    case "bundle-created": return e.detail === "One-time" ? "One-time bundle" : `Recurring ${e.prepaid ? "prepaid" : "postpaid"} bundle`;
    case "link-sent":      return `${renewal} · sent by ${senderText(e.detail)}${to}${payBy}`;
    case "link-reminder":  return `Reminder sent${to}${payBy}`;
    case "link-paid":      return [renewal, money(e.amount, e.currency) && `paid ${money(e.amount, e.currency)}`].filter(Boolean).join(" · ");
    case "link-failed":    return `${renewal ? `${renewal} · ` : ""}not sent: ${e.note || "the email could not be sent."}`;
    case "link-expired":   return e.firstPayment
      ? "Expired unpaid; the subscription wasn't created"
      : `${renewal} · expired unpaid${e.payBy ? ` on ${fmtDate(e.payBy, tz)}` : ""}; the subscription was paused`;
    case "link-cancelled": return `${renewal ? `${renewal} · ` : ""}link withdrawn`;
    case "charged":        return `Card charged ${money(e.amount, null)}`;
    case "charge-failed":  return `Charge of ${money(e.amount, null)} failed${e.note ? `: ${e.note}` : ""}`;
    case "charge-pending": return `Charge of ${money(e.amount, null)} in progress`;
  }
}

/** Where a prepaid subscription's link for its current renewal stands. */
function boardText(r: BoardRow, tz?: string): { text: string; tone: Tone } {
  switch (r.state) {
    case "waiting": return { text: `Next link around ${fmtDateTime(r.linkAt, tz)}`, tone: PURPLE };
    case "due":     return { text: "Due now: goes out within 15 minutes", tone: AMBER };
    case "sending": return { text: "Being sent…", tone: AMBER };
    case "sent":    return { text: `Link sent ${fmtDateTime(r.sentAt, tz)} · pay by ${fmtDate(r.payBy, tz)}`, tone: BLUE };
    case "failed":  return { text: `Not sent: ${r.error || "the email could not be sent."} Retried on the next run.`, tone: RED };
    case "paid":    return { text: "Paid", tone: GREEN };
    case "paused":  return { text: "Paused: no links until it's resumed", tone: GREY };
  }
}

// ─── Small pieces ─────────────────────────────────────────────
function Badge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span style={{
      display: "inline-block", whiteSpace: "nowrap", fontSize: "11px", fontWeight: 600,
      padding: "3px 10px", borderRadius: "999px", background: tone.bg, color: tone.fg,
    }}>
      {label}
    </span>
  );
}

function Tag({ bundle }: { bundle: boolean }) {
  return (
    <span style={{
      fontSize: "10px", fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase",
      padding: "2px 7px", borderRadius: "6px",
      background: bundle ? T.purpleBg : T.greyBg, color: bundle ? T.purpleFg : T.greyFg,
    }}>
      {bundle ? "Bundle" : "Plan"}
    </span>
  );
}

// Same pills as the plan editor's choices (app.plans.tsx).
function Pills({ label, options, value, onChange }: {
  label: string; options: Array<{ value: string; label: string }>; value: string; onChange: (v: string) => void;
}) {
  return (
    <div role="group" aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            style={{
              fontSize: "13px", padding: "6px 14px", borderRadius: "999px", cursor: "pointer",
              border: on ? "1px solid transparent" : "1px solid var(--p-color-border)",
              background: on ? BRAND_GRADIENT : "var(--p-color-bg-surface)",
              color: on ? "#fff" : "var(--p-color-text)",
              fontWeight: on ? 600 : 400,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const card: CSSProperties = {
  background: "var(--p-color-bg-surface)", border: "0.5px solid var(--p-color-border)",
  borderRadius: "14px", padding: "16px 20px",
};
const rowLine: CSSProperties = {
  display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap",
  padding: "10px 0", borderTop: "0.5px solid var(--p-color-border-secondary)",
};

// ─── Page ─────────────────────────────────────────────────────
export default function Activity() {
  const { board, timeline, wider } = useLoaderData<typeof loader>();
  const navigate            = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const tz                  = useTimeZone();

  const [category, setCategory] = useState("all");
  const [kind, setKind]         = useState("all");

  const shown = useMemo(() => timeline.events.filter((e) =>
    (category === "all" || e.category === category)
    && (kind === "all" || (kind === "bundles" ? e.isBundle : !e.isBundle)),
  ), [timeline.events, category, kind]);

  // Grouped by day, newest first (the events already are).
  const days = useMemo(() => {
    const groups: Array<{ day: string; events: ActivityEvent[] }> = [];
    for (const e of shown) {
      const day = dayHeading(e.at, tz);
      if (groups[groups.length - 1]?.day !== day) groups.push({ day, events: [] });
      groups[groups.length - 1].events.push(e);
    }
    return groups;
  }, [shown, tz]);


  return (
    <Page fullWidth>
      <TitleBar title="Activity" />

      <BlockStack gap="500">
        {/* ── Breadcrumb ── */}
        <InlineStack gap="150" blockAlign="center">
          <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: T.purple, display: "inline-block", flexShrink: 0 }} />
          <div className="breadcrumbs-dashboard">
            <Text as="span" variant="bodySm" tone="subdued">
              Smart Subscriptions › Dashboard › <span className="subscription">Activity</span>
            </Text>
          </div>
        </InlineStack>

        {/* ── Header ── */}
        <BlockStack gap="100">
          <Text as="h1" variant="headingXl" fontWeight="bold">Activity</Text>
          <Text as="p" variant="bodySm" tone="subdued">
            New subscriptions, payment links and charges. Payment links go out automatically; the app checks every 15 minutes.
          </Text>
        </BlockStack>

        {/* ── Prepaid subscriptions now ── */}
        <div style={card}>
          <BlockStack gap="200">
            <Text as="h2" variant="headingSm">Prepaid subscriptions now</Text>
            {board.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">No active or paused prepaid subscriptions.</Text>
            ) : board.map((r) => {
              const s = boardText(r, tz);
              return (
                <div key={r.subscriptionId} style={rowLine}>
                  <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      <Tag bundle={r.isBundle} />
                      <Button variant="plain" onClick={() => navigate(`/app/subscriptions-edit/${r.subscriptionId}`)}>
                        {r.title}
                      </Button>
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">{r.customer || "No email"}</Text>
                  </div>
                  <div style={{ flex: "0 1 160px" }}>
                    <Text as="p" variant="bodySm" tone="subdued">Renews</Text>
                    <Text as="p" variant="bodySm">{fmtDateTime(r.renewsAt, tz)}</Text>
                  </div>
                  <div style={{ flex: "1 1 260px", maxWidth: "420px" }}>
                    <span style={{
                      display: "inline-block", fontSize: "12px", lineHeight: 1.4, padding: "5px 12px",
                      borderRadius: "10px", background: s.tone.bg, color: s.tone.fg,
                    }}>
                      {s.text}
                    </span>
                  </div>
                </div>
              );
            })}
          </BlockStack>
        </div>

        {/* ── Timeline ── */}
        <div style={card}>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="200">
              <Text as="h2" variant="headingSm">Timeline · last {timeline.days} days</Text>
              {wider && (
                <Button onClick={() => setSearchParams({ days: String(wider) })}>
                  {`Show the last ${wider} days`}
                </Button>
              )}
            </InlineStack>

            <Pills label="Show" options={CATEGORY_FILTERS} value={category} onChange={setCategory} />
            <Pills label="Plans or bundles" options={KIND_FILTERS} value={kind} onChange={setKind} />

            {timeline.events.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">Nothing happened in the last {timeline.days} days.</Text>
            ) : shown.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">Nothing matches these filters.</Text>
            ) : days.map((g) => (
              <BlockStack key={g.day} gap="0">
                <div style={{ paddingTop: "8px" }}>
                  <Text as="h3" variant="bodySm" fontWeight="semibold" tone="subdued">{g.day}</Text>
                </div>
                {g.events.map((e) => (
                  <div key={e.id} style={rowLine}>
                    <div style={{ flex: "0 0 48px" }}>
                      <Text as="span" variant="bodySm" tone="subdued">{fmtTime(e.at, tz)}</Text>
                    </div>
                    <div style={{ flex: "0 0 128px" }}>
                      <Badge {...BADGE[e.kind]} />
                    </div>
                    <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                      <InlineStack gap="200" blockAlign="center">
                        <Tag bundle={e.isBundle} />
                        <Button variant="plain" onClick={() => navigate(e.href)}>{e.title}</Button>
                        {e.kind === "subscription-created" && e.status && e.status !== "ACTIVE" && (
                          <Text as="span" variant="bodySm" tone="subdued">now {e.status.toLowerCase()}</Text>
                        )}
                      </InlineStack>
                      <Text as="p" variant="bodySm" tone="subdued">{describe(e, tz)}</Text>
                      {e.kind === "link-sent" && e.note && (
                        <Text as="p" variant="bodySm" tone="caution">{e.note}</Text>
                      )}
                    </div>
                  </div>
                ))}
              </BlockStack>
            ))}

            {timeline.truncated && (
              <Text as="p" variant="bodySm" tone="subdued">
                Showing the latest {timeline.events.length} events of the last {timeline.days} days.
              </Text>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Resending a link replaces its earlier send time, and past pauses or cancellations aren't recorded, so a subscription shows only its current status.
            </Text>
          </BlockStack>
        </div>
      </BlockStack>
    </Page>
  );
}
