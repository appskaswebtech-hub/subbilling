// app/lib/activity.server.ts
//
// What the Activity page shows (app/routes/app.activity.tsx), built entirely
// from rows the app already keeps: subscriptions, plans, bundles, prepaid
// payment links (PrepaidInvoice) and charges (BillingAttempt). Nothing here
// writes, and there is no separate event table, so what can be shown is what
// those rows remember:
//   - a resend overwrites a link's sentAt, so only its latest send appears
//   - pauses and cancellations aren't recorded as they happen; a subscription
//     carries only its current status
//
// The page only exists for shops with prepaid subscriptions
// (hasPrepaidActivity), which is also when the menu shows it (app.tsx).

import db from "../db.server";
import { nextLinkAt, type LeadCache } from "./prepaid.server";

// At most this many events on one page; the window can be widened instead.
const MAX_EVENTS = 300;
const DAY_MS     = 24 * 60 * 60 * 1000;

export const ACTIVITY_WINDOWS = [30, 90, 365] as const;

// ─── Is there anything to show? ──────────────────────────────────────────────

/**
 * Whether the shop has anything prepaid: a prepaid subscription, or a payment
 * link (which covers a merchant-made prepaid subscription still waiting for
 * its first payment, before it has a subscription row).
 */
export async function hasPrepaidActivity(shop: string): Promise<boolean> {
  const sub = await db.subscription.findFirst({ where: { shop, paymentMode: "PREPAID" }, select: { id: true } });
  if (sub) return true;
  const link = await db.prepaidInvoice.findFirst({ where: { shop }, select: { id: true } });
  return !!link;
}

// ─── Prepaid subscriptions now ───────────────────────────────────────────────

export type BoardState = "waiting" | "due" | "sending" | "sent" | "failed" | "paid" | "paused";

export interface BoardRow {
  subscriptionId: string;
  title:          string;
  isBundle:       boolean;
  customer:       string;
  renewsAt:       string;
  state:          BoardState;
  /** When this renewal's link goes out (waiting, due, failed). */
  linkAt:         string | null;
  sentAt:         string | null;
  payBy:          string | null;
  error:          string | null;
}

/**
 * Where each live prepaid subscription's link for its current billing date
 * stands, soonest renewal first. Paused ones are listed too: they get no links
 * until resumed, which is otherwise easy to mistake for a fault.
 */
export async function prepaidStatusBoard(shop: string, now = new Date()): Promise<BoardRow[]> {
  const subs = await db.subscription.findMany({
    where:   { shop, paymentMode: "PREPAID", status: { in: ["ACTIVE", "PAUSED"] } },
    orderBy: { nextBillingDate: "asc" },
    include: { prepaidInvoices: { orderBy: { cycleDate: "desc" }, take: 3 } },
  });

  const leads: LeadCache = new Map();
  const rows: BoardRow[] = [];
  for (const sub of subs) {
    const current = sub.prepaidInvoices.find((i) => i.cycleDate.getTime() === sub.nextBillingDate.getTime());
    const linkAt  = await nextLinkAt(sub, leads);

    // Mirrors issueDueRenewalInvoices: an expired or cancelled link on an
    // active subscription is issued again, so it counts as no link.
    let state: BoardState;
    if (sub.status === "PAUSED")                state = "paused";
    else if (current?.status === "SENT")        state = "sent";
    else if (current?.status === "PAID")        state = "paid";
    else if (current?.status === "FAILED")      state = "failed";
    else if (current?.status === "CREATING")    state = "sending";
    else                                        state = linkAt > now ? "waiting" : "due";

    rows.push({
      subscriptionId: sub.id,
      title:          sub.productTitle,
      isBundle:       !!sub.bundleId,
      customer:       sub.customerEmail,
      renewsAt:       sub.nextBillingDate.toISOString(),
      state,
      linkAt:         linkAt.toISOString(),
      sentAt:         current?.sentAt?.toISOString() ?? null,
      payBy:          current?.dueAt?.toISOString() ?? null,
      error:          state === "failed" || state === "sent" ? current?.error ?? null : null,
    });
  }
  return rows;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export type ActivityCategory = "setup" | "links" | "charges";

export type ActivityKind =
  | "subscription-created" | "plan-created" | "bundle-created"
  | "link-sent" | "link-reminder" | "link-paid" | "link-failed" | "link-expired" | "link-cancelled"
  | "charged" | "charge-failed" | "charge-pending";

export interface ActivityEvent {
  id:        string;
  at:        string;
  kind:      ActivityKind;
  category:  ActivityCategory;
  isBundle:  boolean;
  /** Subscription, plan or bundle name. */
  title:     string;
  customer:  string | null;
  href:      string;
  prepaid:   boolean;
  /** Plan name (subscriptions), sender (links), bundle type (bundles). */
  detail:    string | null;
  /** Current status of a subscription, for its "created" event. */
  status:    string | null;
  amount:    number | null;
  currency:  string | null;
  /** The billing date a link pays for, and when it must be paid by. */
  cycleDate: string | null;
  payBy:     string | null;
  /** A failure reason, or a note left on a sent link (e.g. an SMTP fallback). */
  note:      string | null;
  /** A merchant-made subscription's first payment, rather than a renewal. */
  firstPayment: boolean;
}

const CATEGORY: Record<ActivityKind, ActivityCategory> = {
  "subscription-created": "setup", "plan-created": "setup", "bundle-created": "setup",
  "link-sent": "links", "link-reminder": "links", "link-paid": "links",
  "link-failed": "links", "link-expired": "links", "link-cancelled": "links",
  "charged": "charges", "charge-failed": "charges", "charge-pending": "charges",
};

const BLANK = {
  customer: null, prepaid: false, detail: null, status: null, amount: null, currency: null,
  cycleDate: null, payBy: null, note: null, firstPayment: false,
};

function event(id: string, at: Date, kind: ActivityKind, fields: Partial<ActivityEvent> & { title: string; href: string; isBundle: boolean }): ActivityEvent {
  return { ...BLANK, ...fields, id, at: at.toISOString(), kind, category: CATEGORY[kind] };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** What an INITIAL invoice was set up for, from its stored setup. */
function setupOf(setupJson: string | null): { label?: string; email?: string; bundleId?: string | null } {
  if (!setupJson) return {};
  try { return JSON.parse(setupJson); } catch { return {}; }
}

export interface ActivityTimeline {
  days:      number;
  events:    ActivityEvent[];
  /** More events than MAX_EVENTS fell in the window; the oldest were left out. */
  truncated: boolean;
}

/** Everything that happened in the shop's last `days` days, newest first. */
export async function activityTimeline(shop: string, days: number, now = new Date()): Promise<ActivityTimeline> {
  const since = new Date(now.getTime() - days * DAY_MS);

  // Every subscription, for the names and flags the other rows refer to.
  const subs = await db.subscription.findMany({
    where:  { shop },
    select: { id: true, productTitle: true, planName: true, customerEmail: true, bundleId: true, paymentMode: true, status: true, createdAt: true },
  });
  const subById = new Map(subs.map((s) => [s.id, s]));
  const subHref = (id: string) => `/app/subscriptions-edit/${id}`;

  const [plans, bundles, links, charges] = await Promise.all([
    db.sellingPlanGroup.findMany({
      where:  { shop, createdAt: { gte: since } },
      select: { id: true, name: true, paymentMode: true, createdAt: true },
    }),
    db.productBundle.findMany({
      where:  { shop, createdAt: { gte: since } },
      select: { id: true, name: true, type: true, paymentMode: true, createdAt: true },
    }),
    // Every event of a link happens at or before its last update.
    db.prepaidInvoice.findMany({
      where:   { shop, updatedAt: { gte: since } },
      orderBy: { updatedAt: "desc" },
      take:    MAX_EVENTS * 2,
    }),
    subs.length
      ? db.billingAttempt.findMany({
          where:   { subscriptionId: { in: subs.map((s) => s.id) }, createdAt: { gte: since } },
          orderBy: { createdAt: "desc" },
          take:    MAX_EVENTS * 2,
        })
      : Promise.resolve([]),
  ]);

  const events: ActivityEvent[] = [];

  // ── New & setup ─────────────────────────────────────────────
  for (const s of subs) {
    if (s.createdAt < since) continue;
    events.push(event(`sub-${s.id}`, s.createdAt, "subscription-created", {
      title: s.productTitle, href: subHref(s.id), isBundle: !!s.bundleId,
      customer: s.customerEmail || null, prepaid: s.paymentMode === "PREPAID",
      detail: s.planName, status: s.status,
    }));
  }
  for (const p of plans) {
    events.push(event(`plan-${p.id}`, p.createdAt, "plan-created", {
      title: p.name, href: "/app/plans", isBundle: false, prepaid: p.paymentMode === "PREPAID",
    }));
  }
  for (const b of bundles) {
    events.push(event(`bundle-${b.id}`, b.createdAt, "bundle-created", {
      title: b.name, href: "/app/bundles", isBundle: true, prepaid: b.paymentMode === "PREPAID",
      detail: b.type === "ONE_TIME" ? "One-time" : "Recurring",
    }));
  }

  // ── Payment links ───────────────────────────────────────────
  for (const inv of links) {
    const sub   = inv.subscriptionId ? subById.get(inv.subscriptionId) : undefined;
    const setup = inv.kind === "INITIAL" ? setupOf(inv.setupJson) : {};
    const base = {
      title:        sub?.productTitle ?? setup.label ?? "Subscription",
      href:         sub ? subHref(sub.id) : "/app/subscriptions",
      isBundle:     !!(sub?.bundleId ?? setup.bundleId),
      customer:     sub?.customerEmail || setup.email || null,
      prepaid:      true,
      cycleDate:    inv.kind === "RENEWAL" ? iso(inv.cycleDate) : null,
      payBy:        iso(inv.dueAt),
      amount:       inv.amount || null,
      currency:     inv.currency,
      firstPayment: inv.kind === "INITIAL",
    };

    if (inv.sentAt) {
      events.push(event(`link-sent-${inv.id}`, inv.sentAt, "link-sent", {
        ...base, detail: inv.sender, note: inv.status === "SENT" ? inv.error : null,
      }));
    }
    if (inv.reminderSentAt) {
      events.push(event(`link-reminder-${inv.id}`, inv.reminderSentAt, "link-reminder", { ...base, detail: inv.sender }));
    }
    if (inv.paidAt) {
      events.push(event(`link-paid-${inv.id}`, inv.paidAt, "link-paid", base));
    }
    if (inv.status === "FAILED") {
      events.push(event(`link-failed-${inv.id}`, inv.updatedAt, "link-failed", { ...base, note: inv.error }));
    } else if (inv.status === "EXPIRED") {
      events.push(event(`link-expired-${inv.id}`, inv.updatedAt, "link-expired", base));
    } else if (inv.status === "CANCELLED") {
      events.push(event(`link-cancelled-${inv.id}`, inv.updatedAt, "link-cancelled", base));
    }
  }

  // ── Charges ─────────────────────────────────────────────────
  for (const a of charges) {
    const sub = subById.get(a.subscriptionId);
    if (!sub) continue;
    // A prepaid subscription's PENDING row is its payment hold, and its
    // SUCCESS rows are paid links (shown above) or its checkout order.
    if (sub.paymentMode === "PREPAID" && (a.status === "PENDING" || a.status === "SUCCESS")) continue;
    const kind: ActivityKind | null =
      a.status === "SUCCESS" ? "charged" : a.status === "FAILED" ? "charge-failed" : a.status === "PENDING" ? "charge-pending" : null;
    if (!kind) continue;
    events.push(event(`charge-${a.id}`, a.createdAt, kind, {
      title: sub.productTitle, href: subHref(sub.id), isBundle: !!sub.bundleId,
      customer: sub.customerEmail || null, prepaid: sub.paymentMode === "PREPAID",
      amount: a.amount, note: a.errorMessage,
    }));
  }

  const inWindow = events.filter((e) => e.at >= since.toISOString()).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { days, events: inWindow.slice(0, MAX_EVENTS), truncated: inWindow.length > MAX_EVENTS };
}

/** The window asked for in the URL, or the shortest. */
export function parseWindow(raw: string | null): number {
  const n = Number(raw);
  return (ACTIVITY_WINDOWS as readonly number[]).includes(n) ? n : ACTIVITY_WINDOWS[0];
}
