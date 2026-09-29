// app/lib/bundles.server.ts
//
// Product bundles: a fixed set of products the merchant sells together at a
// discount. Two kinds, priced by two different Shopify mechanisms:
//
//   RECURRING  Every line goes in the cart on the bundle's OWN selling plan, so
//              Shopify puts them on one contract that renews together. The plan
//              lives in a selling plan group created for this bundle alone, and
//              its pricing policy IS the bundle discount, so every renewal keeps
//              it with no extra work. The group carries appId "kas-bundle" so
//              the storefront subscription widget can hide it from the normal
//              plan picker (subscription-options.liquid).
//
//   ONE_TIME   Plain lines, no selling plan. Discounted at checkout by the
//              bundle-discount function (extensions/bundle-discount), which
//              reads the list of one-time bundles from its discount's
//              $app/bundle-config metafield and discounts every item the
//              shopper kept ticked (products they untick simply aren't added).
//
// The storefront block adds every line with the `_kas_bundle` attribute so the
// function can tell bundle lines from the same products bought on their own.
//
// Shopify writes are best-effort around a local save that always succeeds: a
// bundle whose Shopify side failed is saved but not offered on the storefront
// (getStorefrontBundles requires a recurring bundle's plan to exist), and the
// merchant is told what to fix.

import db from "../db.server";
import { formatUserErrors, type AdminGraphQL, type UserError } from "./subscription-contract.server";
import {
  PREPAID_SHOPPER_NOTE,
  parseEmailSender,
  parsePaymentMode,
  type EmailSender,
  type PaymentMode,
} from "../config/payment";
import { parseBundleDesign, type BundleDesign } from "../config/bundle-designs";
import { writeBundleMetafield } from "./bundle-metafield.server";
import {
  MAX_TIERS,
  parseBundleKind,
  parsePricingMode,
  parseTiers,
  type BundleKind,
  type PricingMode,
  type Tier,
} from "../config/bundle-pricing";

export const BUNDLE_APP_ID    = "kas-bundle";
export const BUNDLE_ATTRIBUTE = "_kas_bundle";
const DISCOUNT_FUNCTION_HANDLE = "bundle-discount";
const DISCOUNT_CONFIG_KEY      = "bundle-config";

const INTERVALS = ["DAY", "WEEK", "MONTH", "YEAR"] as const;

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const PLAN_GROUP_QUERY = `#graphql
  query BundlePlanProducts($id: ID!) {
    sellingPlanGroup(id: $id) {
      id
      # Several plans once a bundle has tiers: the base plan plus one per tier,
      # told apart by their option label.
      sellingPlans(first: 10) { edges { node { id options } } }
      products(first: 250) { edges { node { id } } }
    }
  }
`;

const PLAN_GROUP_CREATE = `#graphql
  mutation BundlePlanCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
    sellingPlanGroupCreate(input: $input, resources: $resources) {
      sellingPlanGroup { id sellingPlans(first: 10) { edges { node { id options } } } }
      userErrors { field message }
    }
  }
`;

const PLAN_GROUP_UPDATE = `#graphql
  mutation BundlePlanUpdate($id: ID!, $input: SellingPlanGroupInput!) {
    sellingPlanGroupUpdate(id: $id, input: $input) {
      sellingPlanGroup { id sellingPlans(first: 10) { edges { node { id options } } } }
      userErrors { field message }
    }
  }
`;

const PLAN_GROUP_ADD_PRODUCTS = `#graphql
  mutation BundlePlanAddProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
      sellingPlanGroup { id }
      userErrors { field message }
    }
  }
`;

const PLAN_GROUP_REMOVE_PRODUCTS = `#graphql
  mutation BundlePlanRemoveProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
      removedProductIds
      userErrors { field message }
    }
  }
`;

const PLAN_GROUP_DELETE = `#graphql
  mutation BundlePlanDelete($id: ID!) {
    sellingPlanGroupDelete(id: $id) {
      deletedSellingPlanGroupId
      userErrors { field message }
    }
  }
`;

const VARIANT_PRICES = `#graphql
  query BundleVariantPrices($ids: [ID!]!) {
    nodes(ids: $ids) { ... on ProductVariant { id price } }
  }
`;

const DISCOUNT_EXISTS = `#graphql
  query BundleDiscountExists($id: ID!) { discountNode(id: $id) { id } }
`;

const DISCOUNT_CREATE = `#graphql
  mutation BundleDiscountCreate($discount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $discount) {
      automaticAppDiscount { discountId }
      userErrors { field message }
    }
  }
`;

const DISCOUNT_CONFIG_SET = `#graphql
  mutation BundleDiscountConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

// ─── Types ───────────────────────────────────────────────────────────────────

export type BundleType = "RECURRING" | "ONE_TIME";

export interface BundleItemInput {
  productId: string;
  variantId: string;
  handle:    string;
  title:     string;
  quantity:  number;
  /** The shopper picks the variant; variantId is only the default. */
  variantChoice: boolean;
}

export type BundleShowOn = "ITEMS" | "BASE";

/** A product whose page shows the bundle; it needn't be in the bundle. */
export interface BundleBaseInput {
  productId: string;
  handle:    string;
  title:     string;
}

export interface BundleInput {
  name:               string;
  type:               BundleType;
  design:             BundleDesign;
  showOn:             BundleShowOn;
  baseProducts:       BundleBaseInput[];
  /** See app/config/bundle-pricing.ts. */
  kind:               BundleKind;
  pricingMode:        PricingMode;
  fixedPrice:         number | null;
  minItems:           number;
  tiers:              Tier[];
  /** For FIXED_PRICE, replaced on save by the matching percentage. */
  discountPercent:    number;
  active:             boolean;
  interval:           string;
  intervalCount:      number;
  paymentMode:        PaymentMode;
  paymentEmailSender: EmailSender;
  items:              BundleItemInput[];
}

type BundleWithItems = NonNullable<Awaited<ReturnType<typeof loadBundle>>>;

interface PlanGroupNode {
  id:           string;
  sellingPlans: { edges: Array<{ node: { id: string; options: string[] } }> };
  products:     { edges: Array<{ node: { id: string } }> };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function gql<T>(graphql: AdminGraphQL, query: string, variables: Record<string, unknown>): Promise<T> {
  const res  = await graphql(query, { variables });
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(" | "));
  if (!json.data) throw new Error("Shopify returned no data");
  return json.data;
}

function assertNoUserErrors(errors: UserError[] | undefined): void {
  if (errors?.length) throw new Error(formatUserErrors(errors));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loadBundle(id: string) {
  return db.productBundle.findUnique({ where: { id }, include: { items: true, baseProducts: true } });
}

function intervalLabel(interval: string, count: number): string {
  const unit = interval.charAt(0) + interval.slice(1).toLowerCase();
  return `Every ${count} ${unit}${count > 1 ? "s" : ""}`;
}

/**
 * One item per product. Bundles saved before variant choice existed listed
 * every variant of a product as its own item; read those as a single item the
 * shopper picks the variant for, exactly as the editor shows them. Saving the
 * bundle in the editor stores it this way for good.
 */
export function collapseBundleItems<T extends { productId: string; variantChoice: boolean }>(items: T[]): T[] {
  const byProduct = new Map<string, T>();
  for (const item of items) {
    const existing = byProduct.get(item.productId);
    if (existing) byProduct.set(item.productId, { ...existing, variantChoice: true });
    else byProduct.set(item.productId, item);
  }
  return [...byProduct.values()];
}

/** "gid://shopify/ProductVariant/123" → "123", the form the Ajax cart takes. */
export function numericId(gid: string | null | undefined): string {
  return (gid ?? "").split("/").pop() ?? "";
}

/**
 * Checks and normalises what the bundle editor posted. Returns a message for
 * the merchant instead of throwing.
 */
export function parseBundleInput(raw: {
  name?: unknown; type?: unknown; design?: unknown; discountPercent?: unknown; active?: unknown;
  interval?: unknown; intervalCount?: unknown; paymentMode?: unknown;
  paymentEmailSender?: unknown; items?: unknown; showOn?: unknown; baseProducts?: unknown;
  kind?: unknown; pricingMode?: unknown; fixedPrice?: unknown; minItems?: unknown; tiers?: unknown;
}): { ok: true; value: BundleInput } | { ok: false; error: string } {
  const name = String(raw.name ?? "").trim();
  if (!name) return { ok: false, error: "Give the bundle a name." };

  const type: BundleType = raw.type === "ONE_TIME" ? "ONE_TIME" : "RECURRING";

  const discountPercent = Number(raw.discountPercent ?? 0);
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    return { ok: false, error: "The discount must be between 0 and 100%." };
  }

  const interval = String(raw.interval ?? "MONTH");
  if (!INTERVALS.includes(interval as typeof INTERVALS[number])) {
    return { ok: false, error: "Choose how often the bundle renews." };
  }
  const intervalCount = Number.parseInt(String(raw.intervalCount ?? "1"), 10);
  if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 36) {
    return { ok: false, error: "Renew every 1 to 36 intervals." };
  }

  let items: BundleItemInput[] = [];
  try {
    const parsed = typeof raw.items === "string" ? JSON.parse(raw.items) : raw.items;
    items = (Array.isArray(parsed) ? parsed : [])
      .map((i: any) => ({
        productId: String(i?.productId ?? ""),
        variantId: String(i?.variantId ?? ""),
        handle:    String(i?.handle ?? ""),
        title:     String(i?.title ?? "").slice(0, 190),
        quantity:  Math.max(1, Math.min(99, Number.parseInt(String(i?.quantity ?? "1"), 10) || 1)),
        variantChoice: i?.variantChoice === true || i?.variantChoice === "true",
      }))
      .filter((i) => i.productId.startsWith("gid://") && i.variantId.startsWith("gid://"));
  } catch {
    return { ok: false, error: "The bundle's products could not be read. Pick them again." };
  }

  if (items.length < 2) return { ok: false, error: "A bundle needs at least two products." };
  // One item per product: the shopper picks its variant (or it is fixed to
  // one), so the same product twice would be ambiguous.
  if (new Set(items.map((i) => i.productId)).size !== items.length) {
    return { ok: false, error: "The same product is in the bundle twice. Use its quantity instead." };
  }

  // ── Where it shows ──────────────────────────────────────────
  const showOn: BundleShowOn = raw.showOn === "BASE" ? "BASE" : "ITEMS";
  let baseProducts: BundleBaseInput[] = [];
  try {
    const parsed = typeof raw.baseProducts === "string" ? JSON.parse(raw.baseProducts) : raw.baseProducts;
    const seen = new Set<string>();
    baseProducts = (Array.isArray(parsed) ? parsed : [])
      .map((b: any) => ({
        productId: String(b?.productId ?? ""),
        handle:    String(b?.handle ?? "").slice(0, 190),
        title:     String(b?.title ?? "").slice(0, 190),
      }))
      .filter((b) => {
        if (!b.productId.startsWith("gid://shopify/Product/") || seen.has(b.productId)) return false;
        seen.add(b.productId);
        return true;
      });
  } catch {
    return { ok: false, error: "The base products could not be read. Pick them again." };
  }
  if (showOn === "BASE" && !baseProducts.length) {
    return { ok: false, error: "Pick at least one base product, or show the bundle on every product in it." };
  }

  // ── Kind and pricing ────────────────────────────────────────
  const kind        = parseBundleKind(raw.kind);
  const pricingMode = parsePricingMode(raw.pricingMode);
  if (kind === "BOX" && pricingMode === "FIXED_PRICE") {
    return { ok: false, error: "A build-your-own box can't have a fixed price. Use % off or tiered pricing." };
  }

  let minItems = 0;
  if (kind === "BOX") {
    minItems = Number.parseInt(String(raw.minItems ?? ""), 10);
    if (!Number.isInteger(minItems) || minItems < 1 || minItems > 99) {
      return { ok: false, error: "Set how many items shoppers pick: at least 1, up to 99." };
    }
    // The pool: shoppers choose quantities themselves.
    items = items.map((i) => ({ ...i, quantity: 1 }));
  }

  let fixedPrice: number | null = null;
  if (pricingMode === "FIXED_PRICE") {
    fixedPrice = Number(raw.fixedPrice);
    if (!Number.isFinite(fixedPrice) || fixedPrice <= 0) {
      return { ok: false, error: "Enter the bundle's fixed price." };
    }
    fixedPrice = Math.round(fixedPrice * 100) / 100;
  }

  let tiers: Tier[] = [];
  if (pricingMode === "TIERED") {
    let rawTiers: unknown = raw.tiers;
    if (typeof rawTiers === "string") {
      try { rawTiers = JSON.parse(rawTiers); } catch { rawTiers = null; }
    }
    const count = Array.isArray(rawTiers) ? rawTiers.length : 0;
    tiers = parseTiers(rawTiers).map(({ minItems: m, percent }) => ({ minItems: m, percent: Math.round(percent * 100) / 100 }));
    if (!tiers.length || tiers.length !== count) {
      return { ok: false, error: "Each tier needs a number of items (1 or more) and a discount between 0 and 100%." };
    }
    if (tiers.length > MAX_TIERS) {
      return { ok: false, error: `Use at most ${MAX_TIERS} tiers.` };
    }
    if (new Set(tiers.map((t) => t.minItems)).size !== tiers.length) {
      return { ok: false, error: "Two tiers can't start at the same number of items." };
    }
  }

  return {
    ok: true,
    value: {
      name,
      type,
      design: parseBundleDesign(raw.design),
      showOn,
      baseProducts,
      kind,
      pricingMode,
      fixedPrice,
      minItems,
      tiers,
      // Tiered bundles take their percentages from the tiers.
      discountPercent: pricingMode === "PERCENT" ? Math.round(discountPercent * 100) / 100 : 0,
      active:             raw.active === undefined ? true : raw.active === true || raw.active === "true",
      interval,
      intervalCount,
      // Payment settings only mean anything for recurring bundles; a one-time
      // bundle is simply bought at checkout.
      paymentMode:        type === "RECURRING" ? parsePaymentMode(raw.paymentMode) : "POSTPAID",
      paymentEmailSender: parseEmailSender(raw.paymentEmailSender),
      items,
    },
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function listBundles(shop: string) {
  return db.productBundle.findMany({
    where:   { shop },
    include: { items: true, baseProducts: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Recurring prepaid bundles, for the "create prepaid subscription" form. Fixed
 * sets only: a build-your-own box has no contents until a shopper picks them.
 */
export function listPrepaidBundles(shop: string) {
  return db.productBundle.findMany({
    where:   { shop, type: "RECURRING", paymentMode: "PREPAID", active: true, kind: "SET", shopifySellingPlanId: { not: null } },
    include: { items: true, baseProducts: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * What the storefront block needs for one product page: every active bundle
 * that product is part of. A recurring bundle is only offered once its selling
 * plan exists, since its lines can't be added to the cart without one.
 */
export async function getStorefrontBundles(shop: string, productGid: string) {
  const bundles = await db.productBundle.findMany({
    where: {
      shop,
      active: true,
      AND: [
        // Where it shows: on every product in it, or only on its base
        // products (which need not be in it). See ProductBundle.showOn.
        {
          OR: [
            { showOn: "ITEMS", items:        { some: { productId: productGid } } },
            { showOn: "BASE",  baseProducts: { some: { productId: productGid } } },
          ],
        },
        {
          OR: [
            { type: "ONE_TIME" },
            { type: "RECURRING", shopifySellingPlanId: { not: null } },
          ],
        },
      ],
    },
    include: { items: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });

  return bundles.map(toStorefrontBundle);
}

/**
 * Stores every bundle of this shop in Shopify, where the theme block reads them
 * without calling the app proxy (see bundle-metafield.server.ts).
 *
 * Each entry is the storefront shape plus what the block needs to decide
 * whether a product page shows it: `active` (off, or a recurring bundle whose
 * selling plan doesn't exist yet, never shows), `showOn`, and the numeric ids
 * of its items and base products. Never throws.
 */
export async function syncBundleMetafield(
  graphql: AdminGraphQL,
  shop: string,
  opts: { removedBundleIds?: string[] } = {},
): Promise<void> {
  try {
    const bundles = await listBundles(shop);
    const entries: Record<string, unknown> = {};
    for (const b of bundles) {
      const live = b.type === "ONE_TIME" || !!b.shopifySellingPlanId;
      entries[b.id] = {
        ...toStorefrontBundle(b),
        active:         b.active && live,
        showOn:         b.showOn === "BASE" ? "BASE" : "ITEMS",
        productIds:     [...new Set(b.items.map((i) => numericId(i.productId)))],
        baseProductIds: b.baseProducts.map((p) => numericId(p.productId)),
      };
    }
    await writeBundleMetafield(graphql, shop, entries, opts.removedBundleIds ?? []);
  } catch (err) {
    console.error(`[bundles] could not sync bundles to Shopify for ${shop}:`, errorText(err));
  }
}

type BundleRowForStorefront = {
  id: string; name: string; type: string; discountPercent: number; paymentMode: string;
  interval: string; intervalCount: number; shopifySellingPlanId: string | null; design: string;
  kind: string; pricingMode: string; fixedPrice: number | null; minItems: number; tiersJson: string | null;
  items: Array<{ productId: string; variantId: string; variantChoice: boolean; handle: string; title: string; quantity: number }>;
};

/**
 * What the storefront block renders for one bundle. Shared by the proxy
 * endpoint (getStorefrontBundles) and the copy stored in Shopify
 * (bundle-metafield.server.ts), so the two can't drift.
 */
export function toStorefrontBundle(b: BundleRowForStorefront) {
  return {
    id:              b.id,
    name:            b.name,
    type:            b.type,
    discountPercent: b.discountPercent,
    prepaid:         b.type === "RECURRING" && b.paymentMode === "PREPAID",
    frequency:       b.type === "RECURRING" ? intervalLabel(b.interval, b.intervalCount) : null,
    // The cart's `selling_plan` takes the numeric id.
    sellingPlanId:   b.type === "RECURRING" ? numericId(b.shopifySellingPlanId) : null,
    // Storefront theme; the block falls back to "classic" for anything unknown.
    design:          b.design,
    // Kind and pricing, as app/config/bundle-pricing.ts defines them. For
    // FIXED_PRICE, discountPercent above is the matching percentage.
    kind:            b.kind === "BOX" ? "BOX" : "SET",
    pricingMode:     b.pricingMode,
    fixedPrice:      b.pricingMode === "FIXED_PRICE" ? b.fixedPrice : null,
    minItems:        b.kind === "BOX" ? b.minItems : 0,
    // Each tier with its own selling plan (numeric, for the cart) on recurring bundles.
    tiers: b.pricingMode === "TIERED"
      ? parseTiers(b.tiersJson).map((t) => ({
          minItems:      t.minItems,
          percent:       t.percent,
          sellingPlanId: b.type === "RECURRING" && t.sellingPlanId ? numericId(t.sellingPlanId) : null,
        }))
      : [],
    items: collapseBundleItems(b.items).map((i) => ({
      productId:     numericId(i.productId),
      // With variantChoice the shopper picks from the product's variants and
      // this is only the one preselected.
      variantId:     numericId(i.variantId),
      variantChoice: i.variantChoice,
      handle:        i.handle,
      title:         i.title,
      quantity:      i.quantity,
    })),
  };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * Creates (id null) or updates a bundle, then brings Shopify in line.
 * `warning` is set when the bundle saved but its Shopify side did not.
 */
export async function saveBundle(
  graphql: AdminGraphQL,
  shop: string,
  id: string | null,
  input: BundleInput,
): Promise<{ ok: true; id: string; warning: string | null } | { ok: false; error: string }> {
  // A fixed price is stored with its matching percentage, worked out from the
  // products' current prices. Recurring bundles (a selling plan can't hold a
  // total) and partial sets use it; one-time full sets get the exact price at
  // checkout from the discount function.
  let discountPercent = input.discountPercent;
  if (input.pricingMode === "FIXED_PRICE" && input.fixedPrice) {
    let listTotal = 0;
    try {
      const data = await gql<{ nodes: Array<{ id: string; price: string } | null> }>(
        graphql, VARIANT_PRICES, { ids: input.items.map((i) => i.variantId) },
      );
      const prices = new Map(data.nodes.filter(Boolean).map((n) => [n!.id, parseFloat(n!.price)]));
      listTotal = input.items.reduce((s, i) => s + (prices.get(i.variantId) ?? 0) * i.quantity, 0);
    } catch (err) {
      return { ok: false, error: `Couldn't read the products' prices to check the fixed price: ${errorText(err)}` };
    }
    if (!(listTotal > input.fixedPrice)) {
      return { ok: false, error: `The fixed price must be below the products' total (${listTotal.toFixed(2)}).` };
    }
    discountPercent = Math.round((1 - input.fixedPrice / listTotal) * 10000) / 100;
  }

  const data = {
    name:               input.name,
    mainProductId:      input.items[0].productId,
    type:               input.type,
    design:             input.design,
    showOn:             input.showOn,
    kind:               input.kind,
    pricingMode:        input.pricingMode,
    fixedPrice:         input.fixedPrice,
    minItems:           input.minItems,
    // Tier selling plan ids are (re)assigned by the plan sync below.
    tiersJson:          input.tiers.length ? JSON.stringify(input.tiers.map(({ minItems, percent }) => ({ minItems, percent }))) : null,
    discountPercent,
    active:             input.active,
    interval:           input.interval,
    intervalCount:      input.intervalCount,
    paymentMode:        input.paymentMode,
    paymentEmailSender: input.paymentEmailSender,
  };
  const items = input.items.map(({ productId, variantId, handle, title, quantity, variantChoice }) => ({
    productId, variantId, handle, title, quantity, variantChoice,
  }));
  // Kept even when showOn is "ITEMS", so switching back and forth doesn't lose
  // the merchant's picks.
  const baseProducts = input.baseProducts.map(({ productId, handle, title }) => ({ productId, handle, title }));

  let bundleId: string;
  if (id) {
    const existing = await db.productBundle.findFirst({ where: { id, shop }, select: { id: true } });
    if (!existing) return { ok: false, error: "Bundle not found." };
    await db.$transaction([
      db.productBundleItem.deleteMany({ where: { bundleId: id } }),
      db.productBundleBase.deleteMany({ where: { bundleId: id } }),
      db.productBundle.update({
        where: { id },
        data:  { ...data, items: { create: items }, baseProducts: { create: baseProducts } },
      }),
    ]);
    bundleId = id;
  } else {
    const last = await db.productBundle.findFirst({
      where: { shop }, orderBy: { position: "desc" }, select: { position: true },
    });
    const created = await db.productBundle.create({
      data: {
        shop, ...data, position: (last?.position ?? -1) + 1,
        items: { create: items }, baseProducts: { create: baseProducts },
      },
    });
    bundleId = created.id;
  }

  const bundle = await loadBundle(bundleId);
  if (!bundle) return { ok: false, error: "Bundle not found after saving." };

  const problems: string[] = [];

  // Recurring bundles need their plan; a bundle switched to one-time must lose
  // it, or its products keep a plan nothing uses.
  if (bundle.type === "RECURRING") {
    const problem = await syncRecurringBundlePlan(graphql, bundle);
    if (problem) problems.push(`Its subscription plan couldn't be set up in Shopify: ${problem}`);
  } else if (bundle.shopifyGroupId) {
    const problem = await deleteBundlePlan(graphql, bundle);
    if (problem) problems.push(problem);
  }

  const discountProblem = await syncOneTimeBundleDiscount(graphql, shop);
  if (discountProblem && bundle.type === "ONE_TIME") problems.push(discountProblem);

  // Last, so the entry carries the selling plan the plan sync just created.
  await syncBundleMetafield(graphql, shop);

  return { ok: true, id: bundleId, warning: problems.length ? problems.join(" ") : null };
}

export async function setBundleActive(
  graphql: AdminGraphQL, shop: string, id: string, active: boolean,
): Promise<{ ok: boolean; error?: string; warning?: string | null }> {
  const updated = await db.productBundle.updateMany({ where: { id, shop }, data: { active } });
  if (!updated.count) return { ok: false, error: "Bundle not found." };
  // An inactive one-time bundle must stop being discounted too.
  const warning = await syncOneTimeBundleDiscount(graphql, shop);
  await syncBundleMetafield(graphql, shop);
  return { ok: true, warning };
}

export async function deleteBundle(
  graphql: AdminGraphQL, shop: string, id: string,
): Promise<{ ok: boolean; error?: string; warning?: string | null }> {
  const bundle = await db.productBundle.findFirst({ where: { id, shop }, include: { items: true } });
  if (!bundle) return { ok: false, error: "Bundle not found." };

  // Existing subscribers keep their contracts: deleting a selling plan group
  // doesn't touch contracts already created from it.
  const planProblem = bundle.shopifyGroupId ? await deleteBundlePlan(graphql, bundle) : null;
  await db.productBundle.delete({ where: { id } });
  const discountProblem = await syncOneTimeBundleDiscount(graphql, shop);

  await syncBundleMetafield(graphql, shop, { removedBundleIds: [id] });
  return { ok: true, warning: planProblem ?? discountProblem };
}

// ─── Shopify: recurring bundle plan ──────────────────────────────────────────

/**
 * The selling plans a recurring bundle needs. The first is the base plan (its
 * id is shopifySellingPlanId); tiered bundles add one plan per tier, because a
 * selling plan carries a single percentage and the storefront puts every line
 * on the plan of the tier the shopper reached. Each plan's option label is
 * unique within the group and is how existing plans are matched on update.
 */
type DesiredPlan = { key: string; percent: number; tierMinItems: number | null };

function desiredPlans(bundle: BundleWithItems): DesiredPlan[] {
  const label = intervalLabel(bundle.interval, bundle.intervalCount);
  const tiers = bundle.pricingMode === "TIERED" ? parseTiers(bundle.tiersJson) : [];
  // Below the first tier the base plan applies, which for tiered bundles is no
  // discount. Fixed-price bundles use their matching percentage.
  const basePercent = bundle.pricingMode === "TIERED" ? 0 : bundle.discountPercent;
  return [
    { key: label, percent: basePercent, tierMinItems: null },
    ...tiers.map((t) => ({ key: `${label} · ${t.minItems}+ items`, percent: t.percent, tierMinItems: t.minItems })),
  ];
}

function planInput(bundle: BundleWithItems, plan: DesiredPlan) {
  return {
    name:     plan.percent > 0 ? `${plan.key} (${plan.percent}% off)` : plan.key,
    options:  plan.key,
    category: "SUBSCRIPTION",
    billingPolicy:  { recurring: { interval: bundle.interval, intervalCount: bundle.intervalCount } },
    deliveryPolicy: { recurring: { interval: bundle.interval, intervalCount: bundle.intervalCount } },
    pricingPolicies: plan.percent > 0
      ? [{ fixed: { adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: plan.percent } } }]
      : [],
    description: bundle.paymentMode === "PREPAID" ? PREPAID_SHOPPER_NOTE : "",
  };
}

function groupInput(bundle: BundleWithItems) {
  return {
    // Shown in the Shopify admin on each product, so say what it is.
    name:         `Bundle: ${bundle.name}`,
    merchantCode: `kas-bundle-${bundle.id}`,
    appId:        BUNDLE_APP_ID,
    options:      [intervalLabel(bundle.interval, bundle.intervalCount)],
  };
}

/**
 * Records which selling plan serves which part of the bundle: the base plan's
 * id in shopifySellingPlanId, each tier's in tiersJson. Plans are matched to
 * what was asked for by their (unique) option label.
 */
async function storePlanIds(
  bundle: BundleWithItems,
  groupId: string,
  desired: DesiredPlan[],
  plans: Array<{ id: string; options: string[] }>,
): Promise<void> {
  const byKey = new Map(plans.map((p) => [p.options?.[0] ?? "", p.id]));
  const baseId = byKey.get(desired[0].key) ?? null;
  if (!baseId) throw new Error("Shopify returned no base selling plan for the bundle.");

  const tiers = desired
    .filter((d) => d.tierMinItems !== null)
    .map((d) => ({ minItems: d.tierMinItems as number, percent: d.percent, sellingPlanId: byKey.get(d.key) ?? null }));

  await db.productBundle.update({
    where: { id: bundle.id },
    data: {
      shopifyGroupId:       groupId,
      shopifySellingPlanId: baseId,
      ...(bundle.pricingMode === "TIERED" ? { tiersJson: JSON.stringify(tiers) } : {}),
    },
  });
}

/** Returns a problem to show the merchant, or null. */
async function syncRecurringBundlePlan(graphql: AdminGraphQL, bundle: BundleWithItems): Promise<string | null> {
  const wanted  = [...new Set(bundle.items.map((i) => i.productId))];
  const desired = desiredPlans(bundle);

  try {
    // Does the group still exist? A merchant can delete it from the Shopify
    // admin, and then it has to be created again.
    let group: PlanGroupNode | null = null;

    if (bundle.shopifyGroupId) {
      const data = await gql<{ sellingPlanGroup: PlanGroupNode | null }>(graphql, PLAN_GROUP_QUERY, { id: bundle.shopifyGroupId });
      group = data.sellingPlanGroup;
    }

    if (!group) {
      const data = await gql<{
        sellingPlanGroupCreate: {
          sellingPlanGroup: { id: string; sellingPlans: { edges: Array<{ node: { id: string; options: string[] } }> } } | null;
          userErrors: UserError[];
        };
      }>(graphql, PLAN_GROUP_CREATE, {
        input:     { ...groupInput(bundle), sellingPlansToCreate: desired.map((d) => planInput(bundle, d)) },
        resources: { productIds: wanted },
      });
      assertNoUserErrors(data.sellingPlanGroupCreate.userErrors);
      const created = data.sellingPlanGroupCreate.sellingPlanGroup;
      if (!created) throw new Error("Shopify created no selling plan group.");

      await storePlanIds(bundle, created.id, desired, created.sellingPlans.edges.map((e) => e.node));
      return null;
    }

    // ── Update the existing plans ──────────────────────────────
    // Keep the base plan (existing subscriptions point at it); reuse plans whose
    // label already matches; relabel leftovers for new tiers; delete the rest.
    const existing = group.sellingPlans.edges.map((e) => e.node);
    if (!existing.length) throw new Error("The bundle's selling plan group has no plan.");
    const base = existing.find((p) => p.id === bundle.shopifySellingPlanId)
      ?? existing.find((p) => p.options?.[0] === desired[0].key)
      ?? existing[0];

    const pool = existing.filter((p) => p !== base);
    const toUpdate: Array<Record<string, unknown>> = [{ id: base.id, ...planInput(bundle, desired[0]) }];
    const toCreate: Array<Record<string, unknown>> = [];
    const unmatched: DesiredPlan[] = [];

    for (const d of desired.slice(1)) {
      const idx = pool.findIndex((p) => p.options?.[0] === d.key);
      if (idx >= 0) toUpdate.push({ id: pool.splice(idx, 1)[0].id, ...planInput(bundle, d) });
      else unmatched.push(d);
    }
    for (const d of unmatched) {
      const reuse = pool.shift();
      if (reuse) toUpdate.push({ id: reuse.id, ...planInput(bundle, d) });
      else toCreate.push(planInput(bundle, d));
    }
    const toDelete = pool.map((p) => p.id);

    const updated = await gql<{
      sellingPlanGroupUpdate: {
        sellingPlanGroup: { id: string; sellingPlans: { edges: Array<{ node: { id: string; options: string[] } }> } } | null;
        userErrors: UserError[];
      };
    }>(graphql, PLAN_GROUP_UPDATE, {
      id: group.id,
      input: {
        ...groupInput(bundle),
        sellingPlansToUpdate: toUpdate,
        ...(toCreate.length ? { sellingPlansToCreate: toCreate } : {}),
        ...(toDelete.length ? { sellingPlansToDelete: toDelete } : {}),
      },
    });
    assertNoUserErrors(updated.sellingPlanGroupUpdate.userErrors);
    const plansAfter = updated.sellingPlanGroupUpdate.sellingPlanGroup?.sellingPlans.edges.map((e) => e.node) ?? [];

    // ── Attach exactly the bundle's products ───────────────────
    const attached = group.products.edges.map((e) => e.node.id);
    const toAdd    = wanted.filter((p) => !attached.includes(p));
    const toRemove = attached.filter((p) => !wanted.includes(p));

    if (toAdd.length) {
      const res = await gql<{ sellingPlanGroupAddProducts: { userErrors: UserError[] } }>(
        graphql, PLAN_GROUP_ADD_PRODUCTS, { id: group.id, productIds: toAdd },
      );
      assertNoUserErrors(res.sellingPlanGroupAddProducts.userErrors);
    }
    if (toRemove.length) {
      const res = await gql<{ sellingPlanGroupRemoveProducts: { userErrors: UserError[] } }>(
        graphql, PLAN_GROUP_REMOVE_PRODUCTS, { id: group.id, productIds: toRemove },
      );
      assertNoUserErrors(res.sellingPlanGroupRemoveProducts.userErrors);
    }

    await storePlanIds(bundle, group.id, desired, plansAfter);
    return null;

  } catch (err) {
    console.error(`[bundles] plan sync failed for ${bundle.id}:`, errorText(err));
    return errorText(err);
  }
}

async function deleteBundlePlan(graphql: AdminGraphQL, bundle: { id: string; shopifyGroupId: string | null }): Promise<string | null> {
  if (!bundle.shopifyGroupId) return null;
  try {
    const data = await gql<{ sellingPlanGroupDelete: { userErrors: UserError[] } }>(
      graphql, PLAN_GROUP_DELETE, { id: bundle.shopifyGroupId },
    );
    assertNoUserErrors(data.sellingPlanGroupDelete.userErrors);
  } catch (err) {
    // Already gone is fine; anything else is worth telling the merchant.
    const message = errorText(err);
    if (!/not.?found|does not exist/i.test(message)) {
      console.error(`[bundles] could not delete plan group for ${bundle.id}:`, message);
      return `The bundle's old subscription plan couldn't be removed from Shopify: ${message}`;
    }
  }
  await db.productBundle.updateMany({
    where: { id: bundle.id },
    data:  { shopifyGroupId: null, shopifySellingPlanId: null },
  });
  return null;
}

// ─── Shopify: one-time bundle discount ───────────────────────────────────────

/**
 * Keeps the bundle-discount function's config in step with the shop's active
 * one-time bundles, creating the automatic discount the first time one exists.
 * Returns a problem to show the merchant, or null.
 */
export async function syncOneTimeBundleDiscount(graphql: AdminGraphQL, shop: string): Promise<string | null> {
  try {
    const all = await db.productBundle.findMany({
      where:   { shop, type: "ONE_TIME", active: true },
      include: { items: true },
    });
    // Only bundles that discount anything: a % off, tiers or a fixed price.
    const bundles = all.filter((b) =>
      b.discountPercent > 0 ||
      (b.pricingMode === "TIERED" && parseTiers(b.tiersJson).length > 0) ||
      (b.pricingMode === "FIXED_PRICE" && !!b.fixedPrice));

    const config = JSON.stringify({
      bundles: bundles.map((b) => ({
        id:      b.id,
        title:   b.name,
        // PERCENT: the discount. FIXED_PRICE: the matching percentage, used for
        // partial sets. TIERED: unused (0); the tiers decide.
        percent: b.discountPercent,
        kind:        b.kind === "BOX" ? "BOX" : "SET",
        pricingMode: b.pricingMode,
        fixedPrice:  b.pricingMode === "FIXED_PRICE" ? b.fixedPrice : null,
        minItems:    b.kind === "BOX" ? b.minItems : 0,
        tiers:       b.pricingMode === "TIERED"
          ? parseTiers(b.tiersJson).map(({ minItems, percent }) => ({ minItems, percent }))
          : [],
        // By PRODUCT: the shopper may pick any variant of each item, and every
        // variant counts. (A fixed-variant item is the only variant the
        // storefront offers, so matching its product is equivalent.)
        lines:   collapseBundleItems(b.items).map((i) => ({ productId: i.productId, quantity: i.quantity })),
      })),
    });

    const settings = await db.appSettings.findUnique({ where: { shop }, select: { bundleDiscountId: true } });
    let discountId = settings?.bundleDiscountId ?? null;

    if (discountId) {
      const data = await gql<{ discountNode: { id: string } | null }>(graphql, DISCOUNT_EXISTS, { id: discountId });
      // Deleted from the Shopify admin: create a fresh one below.
      if (!data.discountNode) discountId = null;
    }

    // Nothing to discount and no discount yet: leave Shopify alone.
    if (!discountId && !bundles.length) return null;

    if (!discountId) {
      const data = await gql<{
        discountAutomaticAppCreate: { automaticAppDiscount: { discountId: string } | null; userErrors: UserError[] };
      }>(graphql, DISCOUNT_CREATE, {
        discount: {
          title:                    "Bundle discounts",
          functionHandle:           DISCOUNT_FUNCTION_HANDLE,
          startsAt:                 new Date().toISOString(),
          discountClasses:          ["PRODUCT"],
          // Recurring bundles are priced by their own selling plan.
          appliesOnOneTimePurchase: true,
          appliesOnSubscription:    false,
          combinesWith:             { orderDiscounts: true, productDiscounts: false, shippingDiscounts: true },
          metafields: [{ namespace: "$app", key: DISCOUNT_CONFIG_KEY, type: "json", value: config }],
        },
      });
      assertNoUserErrors(data.discountAutomaticAppCreate.userErrors);
      const created = data.discountAutomaticAppCreate.automaticAppDiscount?.discountId;
      if (!created) throw new Error("Shopify created no discount.");

      await db.appSettings.upsert({
        where:  { shop },
        update: { bundleDiscountId: created },
        create: { shop, bundleDiscountId: created },
      });
      return null;
    }

    const data = await gql<{ metafieldsSet: { userErrors: UserError[] } }>(graphql, DISCOUNT_CONFIG_SET, {
      metafields: [{ ownerId: discountId, namespace: "$app", key: DISCOUNT_CONFIG_KEY, type: "json", value: config }],
    });
    assertNoUserErrors(data.metafieldsSet.userErrors);
    return null;

  } catch (err) {
    const message = errorText(err);
    console.error(`[bundles] one-time discount sync failed for ${shop}:`, message);
    // The usual cause before launch: the function hasn't been deployed yet.
    return /function/i.test(message)
      ? `The bundle discount isn't active yet. Deploy the app's bundle-discount function, then save the bundle again. (${message})`
      : `The bundle discount couldn't be updated in Shopify: ${message}`;
  }
}
