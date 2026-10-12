// app/lib/prepaid.server.ts
//
// Prepaid subscriptions: nothing is charged automatically. Before each cycle
// the customer is sent a link to confirm and pay, and the cycle ships only once
// they do.
//
// ─── Why draft orders ──────────────────────────────────────────────────────
// Shopify draft orders "don't currently support subscriptions", so a payment
// link can't create or renew a contract by itself. Each payment is therefore a
// one-off draft order (its invoiceUrl is the link), and this module keeps the
// contract in step:
//
//   RENEWAL  issued by the hourly reconcile cron (api.cron.reconcile.ts)
//            `leadDays` before nextBillingDate.
//            Paid → the payment hold becomes the cycle's SUCCESS attempt +
//            commission + contract moved one interval + a new hold.
//            Unpaid → reminder halfway through the window, paused at the end.
//   INITIAL  a merchant set up a prepaid subscription for a customer in the
//            app (app.subscriptions.new.tsx). Paid → the app creates the
//            contract itself, with subscriptionContractAtomicCreate and no
//            payment method (every later cycle is paid by link too).
//
// ─── How payment is detected ───────────────────────────────────────────────
// Fast path: orders/paid webhook. The draft order carries a `_kas_invoice`
// custom attribute that the order inherits. Shoppers can set cart attributes
// themselves, so the webhook path CONFIRMS the order really came from that
// invoice's draft order before settling anything.
// Backstop: processOpenInvoices() polls every open draft order hourly, so a
// lost webhook delays a payment by an hour at most and never loses it.
//
// ─── Staying out of the automatic billing cron ─────────────────────────────
// api.cron.billing.ts is not prepaid-aware and must stay unchanged. Every
// prepaid subscription carries one PENDING "payment hold" attempt, which that
// cron's own guard reads as a charge in flight, so it never charges a prepaid
// customer's card. See prepaid-hold.server.ts.
//
// ─── Idempotency ───────────────────────────────────────────────────────────
// (subscriptionId, cycleDate) is unique, so a cycle can be invoiced once.
// Settling claims the row with a conditional update (SENT → PAID), so the
// webhook and the poll racing produce one outcome, not two.

import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { chargeCommission } from "./app-commission.server";
import { sendPaymentRequest } from "./payment-email.server";
import { ensurePrepaidHold, ensurePrepaidHolds, findPrepaidHold } from "./prepaid-hold.server";
import {
  activateContract,
  formatUserErrors,
  pauseContract,
  setContractNextBillingDate,
  type AdminGraphQL,
  type UserError,
} from "./subscription-contract.server";
import {
  SUBSCRIPTION_CONTRACT_QUERY,
  advanceBillingDate,
  contractLines,
  normaliseFrequency,
  upsertContractLocally,
  type ContractAddress,
  type ShopifyContract,
} from "./subscription-sync.server";
import {
  parseEmailSender,
  prepaidEmailText,
  type EmailSender,
  type PrepaidEmailKind,
  type PrepaidEmailValues,
} from "../config/payment";

/** Draft order → order custom attribute that identifies the invoice. */
export const INVOICE_ATTRIBUTE = "_kas_invoice";
/** Contract custom attribute marking a contract the app created from an INITIAL invoice. */
export const PREPAID_CONTRACT_ATTRIBUTE = "_kas_prepaid_invoice";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;
// Bounds one run so a backlog can't become a request that never returns.
const MAX_PER_RUN = 100;
// The same, for a run inside a merchant's request (runPrepaidForShop).
const MAX_PER_SYNC = 25;
// A CREATING row older than this was abandoned mid-way (crash, timeout) and
// may be picked up again.
const STALE_CREATING_MS = 15 * 60 * 1000;

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const SHOP_QUERY = `#graphql
  query PrepaidShop { shop { name currencyCode } }
`;

const DRAFT_ORDER_CREATE = `#graphql
  mutation PrepaidDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id invoiceUrl totalPriceSet { presentmentMoney { amount currencyCode } } }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_STATUS = `#graphql
  query PrepaidDraftOrderStatus($id: ID!) {
    draftOrder(id: $id) { id status order { id displayFinancialStatus } }
  }
`;

const DRAFT_ORDER_DELETE = `#graphql
  mutation PrepaidDraftOrderDelete($id: ID!) {
    draftOrderDelete(input: { id: $id }) { deletedId userErrors { field message } }
  }
`;

const CONTRACT_CREATE = `#graphql
  mutation PrepaidContractCreate($input: SubscriptionContractAtomicCreateInput!) {
    subscriptionContractAtomicCreate(input: $input) {
      contract { id status nextBillingDate }
      userErrors { field message code }
    }
  }
`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InvoiceLine {
  variantId: string;
  quantity:  number;
  /** Per-unit price actually charged, in the invoice currency. */
  unitPrice: number;
  title:     string;
}

/** Shipping address in the shape both draft orders and contracts accept. */
export interface InvoiceAddress {
  firstName?:    string | null;
  lastName?:     string | null;
  company?:      string | null;
  phone?:        string | null;
  address1?:     string | null;
  address2?:     string | null;
  city?:         string | null;
  provinceCode?: string | null;
  countryCode?:  string | null;
  zip?:          string | null;
}

/** INITIAL invoices: everything needed to create the contract once paid. */
export interface InitialSetup {
  customerId:      string;
  email:           string;
  currencyCode:    string;
  interval:        string;         // DAY | WEEK | MONTH | YEAR
  intervalCount:   number;
  sellingPlanId:   string | null;  // the plan every line is subscribed on
  bundleId:        string | null;
  label:           string;         // plan or bundle name, for the email
  lines:           InvoiceLine[];
  shippingAddress: InvoiceAddress | null;
  shippingPrice:   number;
  /** Set once the contract exists, so a retry never creates a second one. */
  contractId?:     string;
}

type InvoiceRow = NonNullable<Awaited<ReturnType<typeof db.prepaidInvoice.findUnique>>>;

// ─── Small helpers ───────────────────────────────────────────────────────────

async function gql<T>(graphql: AdminGraphQL, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res  = await graphql(query, { variables });
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(" | "));
  if (!json.data) throw new Error("Shopify returned no data");
  return json.data;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || "Unknown error";
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return "Unknown error"; }
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(d);
}

/** Money arithmetic in the admin-create route rounds through this. */
export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function toInvoiceAddress(a: ContractAddress | null | undefined): InvoiceAddress | null {
  if (!a?.address1 || !a.countryCodeV2) return null;
  return {
    firstName:    a.firstName,
    lastName:     a.lastName,
    company:      a.company,
    phone:        a.phone,
    address1:     a.address1,
    address2:     a.address2,
    city:         a.city,
    provinceCode: a.provinceCode,
    countryCode:  a.countryCodeV2,
    zip:          a.zip,
  };
}

/** Drops empty fields: Shopify rejects "" for enums such as provinceCode. */
function addressInput(a: InvoiceAddress): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

async function shopInfo(graphql: AdminGraphQL): Promise<{ name: string; currencyCode: string }> {
  try {
    const data = await gql<{ shop: { name: string; currencyCode: string } }>(graphql, SHOP_QUERY);
    return data.shop;
  } catch {
    return { name: "Our store", currencyCode: "USD" };
  }
}

async function settingsFor(shop: string) {
  const s = await db.appSettings.findUnique({ where: { shop } });
  return {
    payWindowDays: s?.prepaidPayWindowDays   ?? 7,
    leadDays:      s?.prepaidInvoiceLeadDays ?? 3,
  };
}

/**
 * Subject and message for one email, in the merchant's wording from Settings
 * (or the default), with the placeholders filled in. Read at send time, so an
 * edit applies to the next email.
 */
async function emailText(
  shop: string,
  kind: PrepaidEmailKind,
  values: PrepaidEmailValues,
): Promise<{ subject: string; message: string }> {
  const s = await db.appSettings.findUnique({
    where:  { shop },
    select: {
      prepaidInitialSubject:  true, prepaidInitialMessage:  true,
      prepaidRenewalSubject:  true, prepaidRenewalMessage:  true,
      prepaidReminderSubject: true, prepaidReminderMessage: true,
    },
  });
  return prepaidEmailText(s, kind, values);
}

/**
 * The email sender for an invoice, read at send time so a merchant's change
 * applies to the next email: the bundle's setting, else the plan's, else the
 * Shopify invoice.
 */
async function resolveSender(
  shop: string,
  ref: { bundleId?: string | null; sellingPlanId?: string | null },
): Promise<EmailSender> {
  if (ref.bundleId) {
    const b = await db.productBundle.findFirst({
      where: { id: ref.bundleId, shop }, select: { paymentEmailSender: true },
    });
    if (b) return parseEmailSender(b.paymentEmailSender);
  }
  if (ref.sellingPlanId) {
    const p = await db.sellingPlanGroup.findFirst({
      where: { shop, shopifySellingPlanId: ref.sellingPlanId }, select: { paymentEmailSender: true },
    });
    if (p) return parseEmailSender(p.paymentEmailSender);
    const b = await db.productBundle.findFirst({
      where: { shop, shopifySellingPlanId: ref.sellingPlanId }, select: { paymentEmailSender: true },
    });
    if (b) return parseEmailSender(b.paymentEmailSender);
  }
  return "SHOPIFY";
}

/**
 * How many hours before its billing date a subscription's payment link goes
 * out: its bundle's own setting, else its plan's, else the shop's (Settings,
 * in days). Read at send time like the sender, so a change applies to the
 * next link.
 */
async function resolveLeadHours(
  shop: string,
  ref: { bundleId?: string | null; sellingPlanId?: string | null },
): Promise<number> {
  const own = async (): Promise<number | null> => {
    if (ref.bundleId) {
      const b = await db.productBundle.findFirst({
        where: { id: ref.bundleId, shop }, select: { prepaidLeadHours: true },
      });
      if (b) return b.prepaidLeadHours;
    }
    if (ref.sellingPlanId) {
      const p = await db.sellingPlanGroup.findFirst({
        where: { shop, shopifySellingPlanId: ref.sellingPlanId }, select: { prepaidLeadHours: true },
      });
      if (p) return p.prepaidLeadHours;
      const b = await db.productBundle.findFirst({
        where: { shop, shopifySellingPlanId: ref.sellingPlanId }, select: { prepaidLeadHours: true },
      });
      if (b) return b.prepaidLeadHours;
    }
    return null;
  };
  return (await own()) ?? (await settingsFor(shop)).leadDays * 24;
}

function parseSetup(invoice: { setupJson: string | null }): InitialSetup | null {
  if (!invoice.setupJson) return null;
  try { return JSON.parse(invoice.setupJson) as InitialSetup; } catch { return null; }
}

// One admin client per shop per run.
function adminCache() {
  const cache = new Map<string, AdminGraphQL | null>();
  return async function graphqlFor(shop: string): Promise<AdminGraphQL | null> {
    if (!cache.has(shop)) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        cache.set(shop, admin.graphql);
      } catch (err) {
        console.error(`[prepaid] no admin client for ${shop}:`, errorText(err));
        cache.set(shop, null);
      }
    }
    return cache.get(shop) ?? null;
  };
}

// ─── Draft orders ────────────────────────────────────────────────────────────

async function createDraftOrder(graphql: AdminGraphQL, args: {
  invoiceId:       string;
  customerId:      string | null;
  email:           string;
  currencyCode:    string;
  lines:           InvoiceLine[];
  shippingAddress: InvoiceAddress | null;
  shippingPrice:   number;
  note:            string;
  /** Contract-level discounts (e.g. loyalty) as one fixed amount off the order. */
  orderDiscount?:  number;
}): Promise<{ id: string; invoiceUrl: string; total: number; currency: string }> {
  const input: Record<string, unknown> = {
    email:                   args.email,
    presentmentCurrencyCode: args.currencyCode,
    // priceOverride, not the variant's catalogue price: the customer pays what
    // their subscription costs (plan discount, bundle discount and all), even
    // if the product's list price has changed since.
    lineItems: args.lines.map((l) => ({
      variantId:     l.variantId,
      quantity:      l.quantity,
      priceOverride: { amount: l.unitPrice.toFixed(2), currencyCode: args.currencyCode },
    })),
    customAttributes: [{ key: INVOICE_ATTRIBUTE, value: args.invoiceId }],
    tags:             ["kas-prepaid"],
    note:             args.note,
  };
  if (args.customerId) input.purchasingEntity = { customerId: args.customerId };
  if (args.orderDiscount && args.orderDiscount > 0) {
    input.appliedDiscount = {
      valueType: "FIXED_AMOUNT",
      value:     args.orderDiscount,
      title:     "Subscription discount",
    };
  }
  if (args.shippingAddress) {
    input.shippingAddress = addressInput(args.shippingAddress);
    input.shippingLine    = {
      title:             "Shipping",
      priceWithCurrency: { amount: args.shippingPrice.toFixed(2), currencyCode: args.currencyCode },
    };
  }

  const data = await gql<{
    draftOrderCreate: {
      draftOrder: { id: string; invoiceUrl: string; totalPriceSet: { presentmentMoney: { amount: string; currencyCode: string } } } | null;
      userErrors: UserError[];
    };
  }>(graphql, DRAFT_ORDER_CREATE, { input });

  const { draftOrder, userErrors } = data.draftOrderCreate;
  if (userErrors.length) throw new Error(formatUserErrors(userErrors));
  if (!draftOrder?.invoiceUrl) throw new Error("Shopify created no draft order");

  return {
    id:         draftOrder.id,
    invoiceUrl: draftOrder.invoiceUrl,
    total:      parseFloat(draftOrder.totalPriceSet.presentmentMoney.amount),
    currency:   draftOrder.totalPriceSet.presentmentMoney.currencyCode,
  };
}

async function deleteDraftOrder(graphql: AdminGraphQL, draftOrderId: string): Promise<void> {
  try {
    await gql(graphql, DRAFT_ORDER_DELETE, { id: draftOrderId });
  } catch (err) {
    // A draft that is already completed or gone can't be deleted, and that is
    // fine: the point is only that an expired link must stop working.
    console.warn(`[prepaid] could not delete draft order ${draftOrderId}:`, errorText(err));
  }
}

/** The paid order for a draft order, or null while it is still unpaid. */
async function paidOrderFor(graphql: AdminGraphQL, draftOrderId: string): Promise<string | null> {
  const data = await gql<{
    draftOrder: { status: string; order: { id: string; displayFinancialStatus: string | null } | null } | null;
  }>(graphql, DRAFT_ORDER_STATUS, { id: draftOrderId });

  const order = data.draftOrder?.order;
  if (!order) return null;
  // A completed draft whose payment is still pending (e.g. bank transfer) is
  // not paid yet. orders/paid fires when it is; the poll catches it after.
  return ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.displayFinancialStatus ?? "")
    ? order.id
    : null;
}

// ─── Building and sending one invoice ────────────────────────────────────────

/**
 * Creates the invoice's draft order if it has none yet, then emails the link.
 * Leaves the row SENT on success and FAILED (with the reason) otherwise. Never
 * throws.
 */
async function deliverInvoice(graphql: AdminGraphQL, invoiceId: string): Promise<boolean> {
  const invoice = await db.prepaidInvoice.findUnique({
    where: { id: invoiceId }, include: { subscription: true },
  });
  if (!invoice) return false;

  try {
    const shop     = await shopInfo(graphql);
    const settings = await settingsFor(invoice.shop);

    let to: string;
    let label: string;
    let senderRef: { bundleId?: string | null; sellingPlanId?: string | null };
    let draftInput: Parameters<typeof createDraftOrder>[1] | null = null;

    if (invoice.kind === "RENEWAL") {
      const sub = invoice.subscription;
      if (!sub) throw new Error("The subscription for this invoice no longer exists.");

      const data     = await gql<{ subscriptionContract: ShopifyContract | null }>(
        graphql, SUBSCRIPTION_CONTRACT_QUERY, { id: sub.shopifyContractId },
      );
      const contract = data.subscriptionContract;
      if (!contract) throw new Error("Shopify has no contract for this subscription any more.");

      const currency = contract.currencyCode ?? shop.currencyCode;
      const lines: InvoiceLine[] = contractLines(contract)
        .filter((l) => l.variantId && (l.quantity ?? 0) > 0)
        .map((l) => ({
          variantId: l.variantId!,
          quantity:  l.quantity ?? 1,
          unitPrice: l.currentPrice?.amount ? parseFloat(l.currentPrice.amount) : 0,
          title:     l.title ?? "Item",
        }));
      if (!lines.length) throw new Error("None of this subscription's products can be ordered any more.");

      // Discounts on the contract itself (a loyalty discount, a code applied to
      // the subscription) show up only in lineDiscountedPrice. An automatic
      // charge would honour them, so the payment link must too.
      const listTotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
      const netTotal  = contractLines(contract)
        .filter((l) => l.variantId && (l.quantity ?? 0) > 0)
        .reduce((s, l) => s + (l.lineDiscountedPrice?.amount ? parseFloat(l.lineDiscountedPrice.amount) : 0), 0);
      const orderDiscount = netTotal > 0 && netTotal < listTotal ? roundMoney(listTotal - netTotal) : 0;

      to        = contract.customer?.email || sub.customerEmail;
      label     = sub.productTitle;
      senderRef = { bundleId: sub.bundleId, sellingPlanId: sub.sellingPlanId };
      draftInput = {
        invoiceId:       invoice.id,
        customerId:      contract.customer?.id ?? (sub.customerId || null),
        email:           to,
        currencyCode:    currency,
        lines,
        shippingAddress: toInvoiceAddress(contract.deliveryMethod?.address),
        shippingPrice:   contract.deliveryPrice?.amount ? parseFloat(contract.deliveryPrice.amount) : 0,
        note:            `Prepaid renewal for ${formatDate(invoice.cycleDate)}. Subscription ${sub.shopifyContractId}`,
        orderDiscount,
      };
    } else {
      const setup = parseSetup(invoice);
      if (!setup) throw new Error("This invoice has no subscription details.");
      to        = setup.email;
      label     = setup.label;
      senderRef = { bundleId: setup.bundleId, sellingPlanId: setup.sellingPlanId };
      draftInput = {
        invoiceId:       invoice.id,
        customerId:      setup.customerId,
        email:           setup.email,
        currencyCode:    setup.currencyCode,
        lines:           setup.lines,
        shippingAddress: setup.shippingAddress,
        shippingPrice:   setup.shippingPrice,
        note:            `First payment for a new prepaid subscription: ${setup.label}`,
      };
    }

    // ── Draft order (once) ─────────────────────────────────────
    let { draftOrderId, invoiceUrl, amount, currency } = invoice;
    if (!draftOrderId || !invoiceUrl) {
      const draft = await createDraftOrder(graphql, draftInput);
      draftOrderId = draft.id;
      invoiceUrl   = draft.invoiceUrl;
      amount       = draft.total;
      currency     = draft.currency;
      await db.prepaidInvoice.update({
        where: { id: invoice.id },
        data:  { draftOrderId, invoiceUrl, amount, currency },
      });

      // The payment hold stood in for this cycle with an estimate; now the
      // real total is known.
      if (invoice.subscriptionId) {
        await db.billingAttempt.updateMany({
          where: { subscriptionId: invoice.subscriptionId, status: "PENDING" },
          data:  { amount },
        });
      }
    }

    // ── Email ──────────────────────────────────────────────────
    const now   = new Date();
    const dueAt = new Date(now.getTime() + settings.payWindowDays * DAY_MS);
    const isRenewal = invoice.kind === "RENEWAL";

    // The merchant's own wording (Settings → Prepaid & email), or the default.
    const text = await emailText(invoice.shop, isRenewal ? "renewal" : "initial", {
      shop:         shop.name,
      subscription: label,
      date:         formatDate(isRenewal ? invoice.cycleDate : now),
      due_date:     formatDate(dueAt),
      amount:       formatMoney(amount, currency),
    });

    const sender = await resolveSender(invoice.shop, senderRef);
    const result = await sendPaymentRequest({
      graphql,
      shop:         invoice.shop,
      sender,
      draftOrderId,
      to,
      content: {
        shopName:    shop.name,
        subject:     text.subject,
        message:     text.message,
        amountLabel: formatMoney(amount, currency),
        dueLabel:    `Please pay by ${formatDate(dueAt)}.`,
        invoiceUrl,
      },
    });

    await db.prepaidInvoice.update({
      where: { id: invoice.id },
      data: {
        status: "SENT",
        sender: result.sentWith,
        sentAt: now,
        dueAt,
        // Keep the fallback visible to the merchant; clear any earlier failure.
        error:  result.fallbackReason,
      },
    });

    console.log(`[prepaid] ✉️ ${invoice.kind} invoice ${invoice.id} sent via ${result.sentWith} to ${to}`);
    return true;

  } catch (err) {
    const message = errorText(err);
    console.error(`[prepaid] invoice ${invoiceId} failed:`, message);
    await db.prepaidInvoice.update({
      where: { id: invoiceId },
      data:  { status: "FAILED", error: message.slice(0, 2000) },
    }).catch(() => {});
    return false;
  }
}

// ─── Renewals (hourly reconcile cron) ────────────────────────────────────────

/**
 * Invoices every ACTIVE prepaid subscription whose billing date falls within
 * its lead time (its plan's or bundle's, else the shop's: resolveLeadHours).
 * Called hourly by api.cron.reconcile.ts, so a link goes out within the hour a
 * subscription enters its lead window.
 *
 * Safe to re-run: a cycle that already has a live invoice is skipped, and a
 * FAILED one is retried.
 *
 * `shop` limits it to one shop and `max` to that many emails, for a run inside
 * a merchant's request (runPrepaidForShop).
 */
export async function issueDueRenewalInvoices(opts: { shop?: string; max?: number } = {}): Promise<{
  checked: number; sent: number; results: Array<{ subscriptionId: string; result: string }>;
}> {
  const results: Array<{ subscriptionId: string; result: string }> = [];
  let sent = 0;
  const now = new Date();
  const max = opts.max ?? MAX_PER_RUN;

  // Widest possible lead time (14 days, in Settings and per plan alike); each
  // subscription's own lead time is applied below.
  const due = await db.subscription.findMany({
    where: {
      ...(opts.shop ? { shop: opts.shop } : {}),
      status:          "ACTIVE",
      paymentMode:     "PREPAID",
      nextBillingDate: { lte: new Date(now.getTime() + 14 * DAY_MS) },
    },
    orderBy: { nextBillingDate: "asc" },
    take:    max * 2,
  });

  const graphqlFor = adminCache();
  const leadCache  = new Map<string, number>();

  for (const sub of due) {
    if (sent >= max) break;

    // One lookup per plan or bundle per run.
    const leadKey = `${sub.shop}|${sub.bundleId ?? ""}|${sub.sellingPlanId ?? ""}`;
    if (!leadCache.has(leadKey)) {
      leadCache.set(leadKey, await resolveLeadHours(sub.shop, { bundleId: sub.bundleId, sellingPlanId: sub.sellingPlanId }));
    }
    const leadHours = leadCache.get(leadKey)!;
    if (sub.nextBillingDate.getTime() > now.getTime() + leadHours * HOUR_MS) continue;

    try {
      const existing = await db.prepaidInvoice.findUnique({
        where: { subscriptionId_cycleDate: { subscriptionId: sub.id, cycleDate: sub.nextBillingDate } },
      });

      // What an existing invoice for this cycle means:
      //   SENT / PAID        the cycle is handled — leave it.
      //   CREATING (recent)  another run is on it right now.
      //   FAILED, stale CREATING
      //                      retry, reusing any draft order already made.
      //   EXPIRED / CANCELLED
      //                      the link died unpaid and the subscription was
      //                      paused, yet it is ACTIVE again (resumed by the
      //                      merchant or customer). The cycle is still unpaid,
      //                      so it gets a fresh link rather than being skipped
      //                      forever.
      let reissue = false;
      if (existing) {
        if (existing.status === "SENT" || existing.status === "PAID") {
          results.push({ subscriptionId: sub.id, result: `already ${existing.status}` });
          continue;
        }
        if (existing.status === "CREATING" && now.getTime() - existing.updatedAt.getTime() < STALE_CREATING_MS) {
          results.push({ subscriptionId: sub.id, result: "in progress" });
          continue;
        }
        reissue = existing.status === "EXPIRED" || existing.status === "CANCELLED";
      }

      let invoiceId = existing?.id;
      if (!invoiceId) {
        try {
          const created = await db.prepaidInvoice.create({
            data: {
              shop:           sub.shop,
              kind:           "RENEWAL",
              subscriptionId: sub.id,
              cycleDate:      sub.nextBillingDate,
              status:         "CREATING",
            },
          });
          invoiceId = created.id;
        } catch (err: any) {
          // Unique violation: a concurrent run claimed this cycle first.
          if (err?.code === "P2002") {
            results.push({ subscriptionId: sub.id, result: "claimed by another run" });
            continue;
          }
          throw err;
        }
      } else {
        await db.prepaidInvoice.update({
          where: { id: invoiceId },
          data: {
            status: "CREATING",
            // The old link was deleted when it expired; start from scratch.
            ...(reissue
              ? { draftOrderId: null, invoiceUrl: null, sentAt: null, reminderSentAt: null, dueAt: null, error: null }
              : {}),
          },
        });
      }

      const graphql = await graphqlFor(sub.shop);
      if (!graphql) {
        await db.prepaidInvoice.update({
          where: { id: invoiceId },
          data:  { status: "FAILED", error: "No Shopify access for this shop (is the app still installed?)" },
        });
        results.push({ subscriptionId: sub.id, result: "no admin client" });
        continue;
      }

      const ok = await deliverInvoice(graphql, invoiceId);
      if (ok) sent += 1;
      results.push({ subscriptionId: sub.id, result: ok ? "SENT" : "FAILED" });
    } catch (err) {
      results.push({ subscriptionId: sub.id, result: `ERROR: ${errorText(err)}` });
    }
  }

  console.log(`[prepaid] renewal invoices: ${sent} sent of ${due.length} candidate(s)`);
  return { checked: due.length, sent, results };
}

// ─── Settling a payment ──────────────────────────────────────────────────────

/**
 * Creates the contract for a paid INITIAL invoice, or finishes one a previous
 * attempt started. Returns the local subscription id.
 */
async function finishInitialInvoice(graphql: AdminGraphQL, invoice: InvoiceRow): Promise<string> {
  const setup = parseSetup(invoice);
  if (!setup) throw new Error("This invoice has no subscription details.");

  let contract: ShopifyContract | null = null;

  if (setup.contractId) {
    // A previous attempt created it but didn't get as far as the local row.
    const data = await gql<{ subscriptionContract: ShopifyContract | null }>(
      graphql, SUBSCRIPTION_CONTRACT_QUERY, { id: setup.contractId },
    );
    contract = data.subscriptionContract;
  }

  if (!contract) {
    const paidAt = invoice.paidAt ?? new Date();
    const next   = advanceBillingDate(paidAt, normaliseFrequency(setup.interval, setup.intervalCount));

    const contractInput: Record<string, unknown> = {
      status:          "ACTIVE",
      billingPolicy:   { interval: setup.interval, intervalCount: setup.intervalCount },
      deliveryPolicy:  { interval: setup.interval, intervalCount: setup.intervalCount },
      deliveryPrice:   setup.shippingPrice,
      customAttributes: [{ key: PREPAID_CONTRACT_ATTRIBUTE, value: invoice.id }],
      // No paymentMethodId on purpose: prepaid cycles are paid by link, never
      // charged to a stored card.
    };
    if (setup.shippingAddress) {
      contractInput.deliveryMethod = { shipping: { address: addressInput(setup.shippingAddress) } };
    }

    const createWith = (withPlan: boolean) => gql<{
      subscriptionContractAtomicCreate: {
        contract: { id: string } | null;
        userErrors: UserError[];
      };
    }>(graphql, CONTRACT_CREATE, {
      input: {
        customerId:      setup.customerId,
        nextBillingDate: next.toISOString(),
        currencyCode:    setup.currencyCode,
        contract:        contractInput,
        lines: setup.lines.map((l) => ({
          line: {
            productVariantId: l.variantId,
            quantity:         l.quantity,
            currentPrice:     l.unitPrice,
            ...(withPlan && setup.sellingPlanId ? { sellingPlanId: setup.sellingPlanId } : {}),
          },
        })),
      },
    });

    let data = await createWith(true);
    // A merchant can put products on a subscription that aren't attached to
    // the chosen plan. If Shopify refuses the plan on those lines, the contract
    // is still valid without it: the price and schedule are set explicitly
    // here, and the local row keeps the plan for its email settings.
    if (
      setup.sellingPlanId &&
      data.subscriptionContractAtomicCreate.userErrors.some((e) => /selling.?plan/i.test(`${e.field?.join(".") ?? ""} ${e.message}`))
    ) {
      console.warn(`[prepaid] Shopify refused selling plan ${setup.sellingPlanId} on invoice ${invoice.id}'s lines — creating without it`);
      data = await createWith(false);
    }

    const { contract: created, userErrors } = data.subscriptionContractAtomicCreate;
    if (userErrors.length) throw new Error(formatUserErrors(userErrors));
    if (!created?.id) throw new Error("Shopify created no subscription contract.");

    // Record it BEFORE anything else can fail, so a retry reuses this contract
    // instead of creating a second one.
    await db.prepaidInvoice.update({
      where: { id: invoice.id },
      data:  { setupJson: JSON.stringify({ ...setup, contractId: created.id }) },
    });

    const fetched = await gql<{ subscriptionContract: ShopifyContract | null }>(
      graphql, SUBSCRIPTION_CONTRACT_QUERY, { id: created.id },
    );
    contract = fetched.subscriptionContract ?? { id: created.id, status: "ACTIVE", nextBillingDate: next.toISOString() };
  }

  const { id: subscriptionId } = await upsertContractLocally(invoice.shop, contract, {
    paymentMode: "PREPAID",
    bundleId:    setup.bundleId,
  });
  // The contracts/create webhook may have written the row first, from the
  // plan's CURRENT mode. This subscription was sold as prepaid, so say so.
  // sellingPlanId too: it's how later emails find the plan's sender, even if
  // the contract lines ended up without one.
  await db.subscription.update({
    where: { id: subscriptionId },
    data:  {
      paymentMode: "PREPAID",
      bundleId:    setup.bundleId,
      ...(setup.sellingPlanId ? { sellingPlanId: setup.sellingPlanId } : {}),
    },
  });

  return subscriptionId;
}

/**
 * Settles a paid invoice. Idempotent: only the first caller to move it out of
 * SENT (or EXPIRED, for a payment that raced the expiry) does the work.
 *
 * `verifyOrder` is for callers whose order id came from outside, i.e. the
 * webhook: the order must be the one this invoice's draft order produced.
 */
export async function markInvoicePaid(args: {
  graphql:      AdminGraphQL;
  invoiceId:    string;
  orderGid:     string;
  verifyOrder:  boolean;
}): Promise<{ ok: boolean; detail: string }> {
  const { graphql, invoiceId, orderGid } = args;

  const invoice = await db.prepaidInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { ok: false, detail: "unknown invoice" };
  if (!invoice.draftOrderId) return { ok: false, detail: "invoice has no draft order" };

  if (args.verifyOrder) {
    const paid = await paidOrderFor(graphql, invoice.draftOrderId);
    if (paid !== orderGid) {
      console.warn(`[prepaid] order ${orderGid} claims invoice ${invoiceId} but its draft order says ${paid ?? "unpaid"} — ignoring`);
      return { ok: false, detail: "order does not belong to this invoice" };
    }
  }

  const paidAt = new Date();
  const claim  = await db.prepaidInvoice.updateMany({
    where: { id: invoiceId, status: { in: ["SENT", "EXPIRED"] } },
    data:  { status: "PAID", paidAt, orderId: orderGid },
  });

  if (claim.count === 0) {
    // Already settled. An INITIAL invoice may still be missing its contract if
    // a previous attempt failed half-way; processOpenInvoices retries those.
    return { ok: true, detail: `already ${invoice.status}` };
  }

  const wasExpired = invoice.status === "EXPIRED";
  return settlePaidInvoice(graphql, { ...invoice, status: "PAID", paidAt, orderId: orderGid }, wasExpired);
}

async function settlePaidInvoice(
  graphql: AdminGraphQL,
  invoice: InvoiceRow,
  wasExpired: boolean,
): Promise<{ ok: boolean; detail: string }> {
  try {
    let subscriptionId = invoice.subscriptionId;

    if (invoice.kind === "INITIAL" && !subscriptionId) {
      subscriptionId = await finishInitialInvoice(graphql, invoice);
      await db.prepaidInvoice.update({
        where: { id: invoice.id },
        data:  { subscriptionId, error: null },
      });
    }

    const sub = subscriptionId ? await db.subscription.findUnique({ where: { id: subscriptionId } }) : null;
    if (!sub) throw new Error("The subscription for this invoice no longer exists.");

    // ── The cycle's charge, as the rest of the app understands charges ────
    // A SUCCESS attempt keeps billing history and analytics complete; the
    // commission keys off it exactly as for an automatic charge.
    //
    // A renewal settles the payment hold that stood for this cycle. The first
    // payment of an app-created subscription is its own record: the hold
    // created with the contract stands for the NEXT cycle.
    const holdId = invoice.kind === "RENEWAL" ? await findPrepaidHold(sub.id) : null;
    const attempt = holdId
      ? await db.billingAttempt.update({
          where: { id: holdId },
          data:  { amount: invoice.amount, status: "SUCCESS", errorMessage: null },
        })
      : await db.billingAttempt.create({
          data: { subscriptionId: sub.id, amount: invoice.amount, status: "SUCCESS" },
        });
    await chargeCommission({
      shop:             sub.shop,
      admin:            { graphql },
      subscription:     sub,
      billingAttemptId: attempt.id,
      contractGid:      sub.shopifyContractId,
      orderGid:         invoice.orderId,
      baseCurrency:     invoice.currency,
    });

    // ── Move the renewal forward one interval ──────────────────────────────
    // INITIAL contracts were created with the right date already.
    if (invoice.kind === "RENEWAL") {
      const next = advanceBillingDate(invoice.cycleDate, sub.frequency);
      if (next > sub.nextBillingDate) {
        const res = await setContractNextBillingDate(sub.shop, sub.shopifyContractId, next);
        if (!res.ok) console.warn(`[prepaid] could not move ${sub.shopifyContractId} to ${next.toISOString()}: ${res.error}`);
        await db.subscription.update({ where: { id: sub.id }, data: { nextBillingDate: next } });
      }

      // Paid after the window closed and the subscription was paused for it.
      if (wasExpired && sub.status === "PAUSED") {
        const res = await activateContract(sub.shop, sub.shopifyContractId);
        if (res.ok) await db.subscription.update({ where: { id: sub.id }, data: { status: "ACTIVE" } });
      }
    }

    // A hold for the next cycle, at once, so the billing cron can't treat the
    // subscription as chargeable in between.
    await ensurePrepaidHold(sub.id);

    console.log(`[prepaid] ✅ ${invoice.kind} invoice ${invoice.id} paid (order ${invoice.orderId})`);
    return { ok: true, detail: "PAID" };

  } catch (err) {
    const message = errorText(err);
    console.error(`[prepaid] invoice ${invoice.id} paid but could not be settled:`, message);
    await db.prepaidInvoice.update({
      where: { id: invoice.id },
      data:  { error: `Paid, but the subscription could not be updated: ${message}`.slice(0, 2000) },
    }).catch(() => {});
    return { ok: false, detail: message };
  }
}

// ─── Hourly upkeep (reconcile cron) ──────────────────────────────────────────

/**
 * Polls open invoices for payment, sends reminders, expires unpaid ones and
 * retries INITIAL invoices that were paid but whose contract wasn't created.
 * Never throws. `shop` limits it to one shop's invoices.
 */
export async function processOpenInvoices(opts: { shop?: string } = {}): Promise<{
  checked: number; paid: number; reminded: number; expired: number;
}> {
  const now = new Date();
  let paid = 0, reminded = 0, expired = 0;
  const graphqlFor = adminCache();

  let open: Array<InvoiceRow & { subscription: { status: string; shopifyContractId: string; shop: string; bundleId: string | null; sellingPlanId: string | null; customerEmail: string; productTitle: string } | null }> = [];
  try {
    open = await db.prepaidInvoice.findMany({
      where: {
        ...(opts.shop ? { shop: opts.shop } : {}),
        OR: [
          { status: "SENT" },
          // Paid INITIAL invoices still waiting for their contract.
          { status: "PAID", kind: "INITIAL", subscriptionId: null },
        ],
      },
      include: {
        subscription: {
          select: { status: true, shopifyContractId: true, shop: true, bundleId: true, sellingPlanId: true, customerEmail: true, productTitle: true },
        },
      },
      orderBy: { sentAt: "asc" },
      take:    MAX_PER_RUN,
    });
  } catch (err) {
    console.error("[prepaid] could not load open invoices:", errorText(err));
    return { checked: 0, paid, reminded, expired };
  }

  for (const invoice of open) {
    try {
      const graphql = await graphqlFor(invoice.shop);
      if (!graphql) continue;

      // ── Paid INITIAL without a contract: retry ──────────────
      if (invoice.status === "PAID") {
        const result = await settlePaidInvoice(graphql, invoice, false);
        if (result.ok) paid += 1;
        continue;
      }

      if (!invoice.draftOrderId) continue;

      // ── Subscription cancelled while the link was open ───────
      if (invoice.kind === "RENEWAL" && invoice.subscription?.status === "CANCELLED") {
        await deleteDraftOrder(graphql, invoice.draftOrderId);
        await db.prepaidInvoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED" } });
        continue;
      }

      // ── Paid? ─────────────────────────────────────────────────
      const orderGid = await paidOrderFor(graphql, invoice.draftOrderId);
      if (orderGid) {
        const result = await markInvoicePaid({ graphql, invoiceId: invoice.id, orderGid, verifyOrder: false });
        if (result.ok) paid += 1;
        continue;
      }

      if (!invoice.sentAt || !invoice.dueAt) continue;

      // ── Expired: close the link and pause ─────────────────────
      if (now > invoice.dueAt) {
        await deleteDraftOrder(graphql, invoice.draftOrderId);
        await db.prepaidInvoice.update({ where: { id: invoice.id }, data: { status: "EXPIRED" } });

        if (invoice.kind === "RENEWAL" && invoice.subscription && invoice.subscriptionId) {
          const res = await pauseContract(invoice.shop, invoice.subscription.shopifyContractId);
          if (res.ok) {
            await db.subscription.update({ where: { id: invoice.subscriptionId }, data: { status: "PAUSED" } });
          } else {
            console.warn(`[prepaid] could not pause ${invoice.subscription.shopifyContractId}: ${res.error}`);
          }
        }
        expired += 1;
        console.log(`[prepaid] ⌛ invoice ${invoice.id} expired unpaid`);
        continue;
      }

      // ── Reminder halfway through the window ───────────────────
      const halfway = invoice.sentAt.getTime() + (invoice.dueAt.getTime() - invoice.sentAt.getTime()) / 2;
      if (!invoice.reminderSentAt && now.getTime() >= halfway) {
        const ok = await sendReminder(graphql, invoice);
        if (ok) reminded += 1;
      }
    } catch (err) {
      console.error(`[prepaid] upkeep failed for invoice ${invoice.id}:`, errorText(err));
    }
  }

  if (open.length) {
    console.log(`[prepaid] upkeep: ${open.length} open, ${paid} paid, ${reminded} reminded, ${expired} expired`);
  }
  return { checked: open.length, paid, reminded, expired };
}

async function sendReminder(graphql: AdminGraphQL, invoice: InvoiceRow & {
  subscription: { bundleId: string | null; sellingPlanId: string | null; customerEmail: string; productTitle: string } | null;
}): Promise<boolean> {
  if (!invoice.draftOrderId || !invoice.invoiceUrl || !invoice.dueAt) return false;

  const setup = parseSetup(invoice);
  const to    = invoice.kind === "INITIAL" ? setup?.email : invoice.subscription?.customerEmail;
  if (!to) return false;

  const shop   = await shopInfo(graphql);
  const sender = await resolveSender(
    invoice.shop,
    invoice.kind === "INITIAL"
      ? { bundleId: setup?.bundleId, sellingPlanId: setup?.sellingPlanId }
      : { bundleId: invoice.subscription?.bundleId, sellingPlanId: invoice.subscription?.sellingPlanId },
  );

  const text = await emailText(invoice.shop, "reminder", {
    shop:         shop.name,
    subscription: invoice.kind === "INITIAL" ? (setup?.label ?? "subscription") : (invoice.subscription?.productTitle ?? "subscription"),
    date:         formatDate(invoice.cycleDate),
    due_date:     formatDate(invoice.dueAt),
    amount:       formatMoney(invoice.amount, invoice.currency),
  });

  try {
    await sendPaymentRequest({
      graphql,
      shop:         invoice.shop,
      sender,
      draftOrderId: invoice.draftOrderId,
      to,
      content: {
        shopName:    shop.name,
        subject:     text.subject,
        message:     text.message,
        amountLabel: formatMoney(invoice.amount, invoice.currency),
        dueLabel:    `Please pay by ${formatDate(invoice.dueAt)}.`,
        invoiceUrl:  invoice.invoiceUrl,
      },
    });
    await db.prepaidInvoice.update({ where: { id: invoice.id }, data: { reminderSentAt: new Date() } });
    return true;
  } catch (err) {
    console.error(`[prepaid] reminder for invoice ${invoice.id} failed:`, errorText(err));
    return false;
  }
}

// ─── Merchant actions ────────────────────────────────────────────────────────

export interface PrepaidRunSummary {
  /** Payment links emailed. */
  sent:   number;
  /** Paid links recorded. */
  paid:   number;
  /** Why links couldn't be sent, each reason once. */
  failed: string[];
}

/**
 * "Sync from Shopify" on the Subscriptions page: the hourly job's prepaid work
 * (api.cron.reconcile.ts) for one shop, now. Payment links are otherwise only
 * sent by that job, so this is what gets one out where it isn't running, and
 * what tells the merchant why a link couldn't be sent. Never throws.
 */
export async function runPrepaidForShop(shop: string): Promise<PrepaidRunSummary> {
  const started = new Date();
  const summary: PrepaidRunSummary = { sent: 0, paid: 0, failed: [] };
  try {
    await ensurePrepaidHolds(shop);
    // Capped: this runs inside the merchant's request. The hourly job sends the rest.
    summary.sent = (await issueDueRenewalInvoices({ shop, max: MAX_PER_SYNC })).sent;
    summary.paid = (await processOpenInvoices({ shop })).paid;

    const failed = await db.prepaidInvoice.findMany({
      where:  { shop, status: "FAILED", updatedAt: { gte: started } },
      select: { error: true },
    });
    summary.failed = [...new Set(failed.map((f) => f.error || "The payment email could not be sent."))];
  } catch (err) {
    summary.failed.push(errorText(err));
  }
  return summary;
}

/**
 * "Resend payment email" on the Subscriptions page. Re-sends an open link, or
 * retries a FAILED invoice from where it stopped.
 */
export async function resendInvoice(graphql: AdminGraphQL, shop: string, invoiceId: string): Promise<{ ok: boolean; error?: string }> {
  const invoice = await db.prepaidInvoice.findFirst({ where: { id: invoiceId, shop } });
  if (!invoice) return { ok: false, error: "Invoice not found." };
  if (!["SENT", "FAILED", "CREATING"].includes(invoice.status)) {
    return { ok: false, error: `This invoice is ${invoice.status.toLowerCase()} and can't be resent.` };
  }

  // A resend is a fresh chance to pay, so the window starts again. That happens
  // inside deliverInvoice, which also reuses the existing draft order.
  const ok = await deliverInvoice(graphql, invoiceId);
  if (ok) return { ok: true };
  const after = await db.prepaidInvoice.findUnique({ where: { id: invoiceId }, select: { error: true } });
  return { ok: false, error: after?.error ?? "The payment email could not be sent." };
}

/**
 * Withdraws a merchant-created prepaid subscription the customer hasn't paid
 * for yet: the payment link stops working and nothing is created.
 */
export async function cancelInitialInvoice(graphql: AdminGraphQL, shop: string, invoiceId: string): Promise<{ ok: boolean; error?: string }> {
  const invoice = await db.prepaidInvoice.findFirst({ where: { id: invoiceId, shop, kind: "INITIAL" } });
  if (!invoice) return { ok: false, error: "Invoice not found." };

  // Claim first, so a payment landing at the same moment wins rather than
  // being cancelled out from under the customer.
  const claim = await db.prepaidInvoice.updateMany({
    where: { id: invoiceId, status: { in: ["CREATING", "SENT", "FAILED"] } },
    data:  { status: "CANCELLED" },
  });
  if (claim.count === 0) {
    return { ok: false, error: `This one is already ${invoice.status.toLowerCase()} and can't be cancelled.` };
  }

  if (invoice.draftOrderId) {
    // If the customer paid in the last moments, the draft is already an order.
    const orderGid = await paidOrderFor(graphql, invoice.draftOrderId).catch(() => null);
    if (orderGid) {
      await db.prepaidInvoice.update({ where: { id: invoiceId }, data: { status: "SENT" } });
      await markInvoicePaid({ graphql, invoiceId, orderGid, verifyOrder: false });
      return { ok: false, error: "The customer has just paid, so the subscription was created instead." };
    }
    await deleteDraftOrder(graphql, invoice.draftOrderId);
  }
  return { ok: true };
}

/**
 * Starts a merchant-created prepaid subscription: records the INITIAL invoice
 * and emails the first payment link. The contract is created when it's paid.
 */
export async function createInitialInvoice(
  graphql: AdminGraphQL,
  shop: string,
  setup: InitialSetup,
): Promise<{ ok: boolean; invoiceId?: string; error?: string }> {
  const invoice = await db.prepaidInvoice.create({
    data: {
      shop,
      kind:      "INITIAL",
      cycleDate: new Date(),
      status:    "CREATING",
      currency:  setup.currencyCode,
      setupJson: JSON.stringify(setup),
    },
  });

  const ok = await deliverInvoice(graphql, invoice.id);
  if (ok) return { ok: true, invoiceId: invoice.id };

  const after = await db.prepaidInvoice.findUnique({ where: { id: invoice.id }, select: { error: true } });
  return { ok: false, invoiceId: invoice.id, error: after?.error ?? "The payment email could not be sent." };
}

/** Order webhook entry point: the invoice id carried on the order, if any. */
export function invoiceIdFromOrderPayload(payload: unknown): string | null {
  const attrs = (payload as { note_attributes?: Array<{ name?: string; value?: unknown }> })?.note_attributes;
  if (!Array.isArray(attrs)) return null;
  const hit = attrs.find((a) => a?.name === INVOICE_ATTRIBUTE);
  return typeof hit?.value === "string" && hit.value ? hit.value : null;
}
