// app/lib/bundles.server.ts
//
// Product bundles: a fixed set of products the merchant sells together at a
// discount. Two kinds, priced by two different Shopify mechanisms:
//
//   RECURRING  Sold as ONE Shopify product the app creates for the bundle
//              (syncBundleProduct): status UNLISTED so it stays out of the
//              catalog, subscription-only, priced at the bundle price, with the
//              items listed in its description and in an "Includes" line
//              property. Cart, checkout, the subscription and every renewal
//              order show one line. (Shopify's cart transform could merge item
//              lines into one, but it rejects lines that have a selling plan.)
//              So a recurring bundle is a fixed set of fixed variants, priced
//              at % off or an exact fixed price: no ticks, boxes or tiers.
//
//              The product is on the bundle's OWN selling plan, in a selling
//              plan group created for this bundle alone, whose pricing policy
//              IS the bundle discount, so every renewal keeps it. The group
//              carries appId "kas-bundle" so the storefront subscription widget
//              hides it from the normal plan picker (subscription-options.liquid).
//              Bundles saved before the product existed have none yet: their
//              plan stays on the items and the block adds one line per item,
//              until the merchant saves them again.
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

import { createHash } from "node:crypto";
import db from "../db.server";
import { formatUserErrors, type AdminGraphQL, type UserError } from "./subscription-contract.server";
import {
  PREPAID_SHOPPER_NOTE,
  cycleHours,
  parseEmailSender,
  parseLeadHours,
  parsePaymentMode,
  type EmailSender,
  type PaymentMode,
} from "../config/payment";
import { parseBundleDesign, type BundleDesign } from "../config/bundle-designs";
import { BUNDLE_PRODUCT_TAG } from "../config/bundle-product";
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

// ── The product a recurring bundle is sold as ──

const BUNDLE_ITEM_DETAILS = `#graphql
  query BundleItemDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        title
        image { url }
        product { title featuredMedia { preview { image { url } } } }
      }
    }
  }
`;

const BUNDLE_PRODUCT_LOOKUP = `#graphql
  query BundleProductLookup($id: ID!) {
    product(id: $id) { id handle variants(first: 1) { nodes { id } } }
  }
`;

const BUNDLE_PRODUCT_CREATE = `#graphql
  mutation BundleProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id handle variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }
`;

const BUNDLE_PRODUCT_UPDATE = `#graphql
  mutation BundleProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id handle }
      userErrors { field message }
    }
  }
`;

const BUNDLE_VARIANT_UPDATE = `#graphql
  mutation BundleVariantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

// `name` is deprecated in favour of the catalog's title, but sales-channel
// publications (Online Store, Point of Sale, Shop) have no catalog, so the
// name is the only thing that says which one is the Online Store.
const PUBLICATIONS = `#graphql
  query BundlePublications {
    publications(first: 50) { nodes { id name catalog { title } } }
  }
`;

const BUNDLE_PRODUCT_PUBLISH = `#graphql
  mutation BundleProductPublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

// ── The bundle product's images (syncBundleImages) ──

// `collage`: what the app kept there before, when it drew a picture of the
// items; only read to tidy it away.
const BUNDLE_PRODUCT_MEDIA = `#graphql
  query BundleProductMedia($id: ID!) {
    product(id: $id) {
      media(first: 50) { nodes { id } }
      images: metafield(namespace: "kas_bundle", key: "images") { jsonValue }
      collage: metafield(namespace: "kas_bundle", key: "collage") { id }
    }
  }
`;

const BUNDLE_MEDIA_ATTACH = `#graphql
  mutation BundleMediaAttach($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
    productUpdate(product: $product, media: $media) {
      product { id }
      userErrors { field message }
    }
  }
`;

const BUNDLE_MEDIA_REORDER = `#graphql
  mutation BundleMediaReorder($id: ID!, $moves: [MoveInput!]!) {
    productReorderMedia(id: $id, moves: $moves) {
      mediaUserErrors { field message }
    }
  }
`;

const BUNDLE_MEDIA_DELETE = `#graphql
  mutation BundleMediaDelete($ids: [ID!]!) {
    fileDelete(fileIds: $ids) {
      deletedFileIds
      userErrors { field message }
    }
  }
`;

const PRODUCT_METAFIELDS_DELETE = `#graphql
  mutation BundleProductMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }
`;

const PRODUCT_METAFIELDS_SET = `#graphql
  mutation BundleProductMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const BUNDLES_ELIGIBILITY = `#graphql
  query BundlesEligibility {
    shop { features { bundles { eligibleForBundles ineligibilityReason } } }
  }
`;

// ── The cart transform that merges one-time bundles (extensions/bundle-merge) ──

const CART_TRANSFORMS = `#graphql
  query BundleCartTransforms {
    cartTransforms(first: 5) { nodes { id functionId } }
  }
`;

const CART_TRANSFORM_CREATE = `#graphql
  mutation BundleCartTransformCreate($metafields: [MetafieldInput!]) {
    cartTransformCreate(functionHandle: "bundle-merge", blockOnFailure: false, metafields: $metafields) {
      cartTransform { id }
      userErrors { field message }
    }
  }
`;

const CART_TRANSFORM_CONFIG_SET = `#graphql
  mutation BundleMergeConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const BUNDLE_PRODUCT_DELETE = `#graphql
  mutation BundleProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
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
  /** Hours before the billing date a prepaid bundle's link is sent; null = the shop setting. */
  prepaidLeadHours:   number | null;
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
  paymentEmailSender?: unknown; prepaidLeadHours?: unknown; items?: unknown; showOn?: unknown; baseProducts?: unknown;
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
  // A recurring bundle is sold as one product with fixed contents (see the top
  // of this file), so the shopper can't change what's in it.
  if (type === "RECURRING") {
    if (kind === "BOX") {
      return { ok: false, error: "A build-your-own box can only be a one-time bundle. A recurring bundle is sold as one product with fixed contents." };
    }
    if (pricingMode === "TIERED") {
      return { ok: false, error: "Tiered pricing is for one-time bundles. A recurring bundle is one product with fixed contents: use % off or a fixed price." };
    }
    if (items.some((i) => i.variantChoice)) {
      return { ok: false, error: "Pick one size or colour for each product. A recurring bundle is one product with fixed contents." };
    }
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
      prepaidLeadHours:   type === "RECURRING" && parsePaymentMode(raw.paymentMode) === "PREPAID"
        ? parseLeadHours(raw.prepaidLeadHours, cycleHours(interval, intervalCount))
        : null,
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
  bundleVariantId: string | null; bundleProductHandle: string | null;
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
    // The product a recurring bundle is sold as: the block adds this one
    // variant (one cart line) instead of the items, and prices it from the
    // product's own selling plan allocation. Null: one line per item.
    product: b.type === "RECURRING" && b.bundleVariantId && b.bundleProductHandle
      ? { handle: b.bundleProductHandle, variantId: numericId(b.bundleVariantId) }
      : null,
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
    prepaidLeadHours:   input.prepaidLeadHours,
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

  let bundle = await loadBundle(bundleId);
  if (!bundle) return { ok: false, error: "Bundle not found after saving." };

  const problems: string[] = [];

  // Every bundle needs its product: a recurring one is sold as it, a one-time
  // one is merged into it in the cart (extensions/bundle-merge). Recurring
  // bundles also need their plan, on that product, so the product first. A
  // bundle switched to one-time must lose the plan, or its products keep a
  // plan nothing uses; existing subscribers keep renewing with the product.
  const productProblem = await syncBundleProduct(graphql, bundle);
  if (productProblem) {
    problems.push(bundle.type === "RECURRING"
      ? `It still adds one cart line per item, because its product couldn't be set up in Shopify: ${productProblem}`
      : `It shows as separate lines in the cart, because its bundle product couldn't be set up in Shopify: ${productProblem}`);
  }
  bundle = (await loadBundle(bundleId)) ?? bundle;

  // Its images: the items', the first item's leading, for every line that shows it.
  const imagesProblem = await syncBundleImages(graphql, bundle);
  if (imagesProblem) problems.push(`Its images couldn't be updated: ${imagesProblem}`);

  if (bundle.type === "RECURRING") {
    const problem = await syncRecurringBundlePlan(graphql, bundle);
    if (problem) problems.push(`Its subscription plan couldn't be set up in Shopify: ${problem}`);
  } else if (bundle.shopifyGroupId) {
    const problem = await deleteBundlePlan(graphql, bundle);
    if (problem) problems.push(problem);
  }

  const discountProblem = await syncOneTimeBundleDiscount(graphql, shop);
  if (discountProblem && bundle.type === "ONE_TIME") problems.push(discountProblem);
  const mergeProblem = await syncBundleMergeConfig(graphql, shop);
  if (mergeProblem && bundle.type === "ONE_TIME" && !productProblem) problems.push(mergeProblem);

  // Last, so the entry carries the selling plan the plan sync just created.
  await syncBundleMetafield(graphql, shop);

  return { ok: true, id: bundleId, warning: problems.length ? problems.join(" ") : null };
}

export async function setBundleActive(
  graphql: AdminGraphQL, shop: string, id: string, active: boolean,
): Promise<{ ok: boolean; error?: string; warning?: string | null }> {
  const updated = await db.productBundle.updateMany({ where: { id, shop }, data: { active } });
  if (!updated.count) return { ok: false, error: "Bundle not found." };
  // An inactive one-time bundle must stop being discounted and merged too.
  const warning = await syncOneTimeBundleDiscount(graphql, shop);
  const mergeWarning = await syncBundleMergeConfig(graphql, shop);
  await syncBundleMetafield(graphql, shop);
  return { ok: true, warning: warning ?? mergeWarning };
}

export async function deleteBundle(
  graphql: AdminGraphQL, shop: string, id: string,
): Promise<{ ok: boolean; error?: string; warning?: string | null }> {
  const bundle = await db.productBundle.findFirst({ where: { id, shop }, include: { items: true } });
  if (!bundle) return { ok: false, error: "Bundle not found." };

  // Existing subscribers keep their contracts: deleting a selling plan group
  // doesn't touch contracts already created from it.
  const planProblem = bundle.shopifyGroupId ? await deleteBundlePlan(graphql, bundle) : null;

  // A recurring bundle's product renews those contracts, so it's only deleted
  // when nobody subscribes to it any more. Left in place, it can't be
  // subscribed to again: its plan is gone and it's unlisted. A one-time
  // bundle's product has no subscribers and simply goes; past orders keep it.
  let productProblem: string | null = null;
  if (bundle.bundleProductId) {
    const subscribers = await db.subscription.count({
      where: { shop, bundleId: id, status: { in: ["ACTIVE", "PAUSED"] } },
    });
    productProblem = subscribers
      ? `Its product "${bundle.name}" stays in Shopify (unlisted) because ${subscribers} subscription${subscribers === 1 ? " still renews" : "s still renew"} with it. Delete it from Products once they've ended.`
      : await deleteBundleProduct(graphql, bundle.bundleProductId);
  }

  await db.productBundle.delete({ where: { id } });
  const discountProblem = await syncOneTimeBundleDiscount(graphql, shop);
  const mergeProblem    = await syncBundleMergeConfig(graphql, shop);

  await syncBundleMetafield(graphql, shop, { removedBundleIds: [id] });
  return { ok: true, warning: planProblem ?? productProblem ?? discountProblem ?? mergeProblem };
}

// ─── Shopify: recurring bundle plan ──────────────────────────────────────────

/**
 * The selling plans a recurring bundle needs. The first is the base plan (its
 * id is shopifySellingPlanId); tiered bundles add one plan per tier, because a
 * selling plan carries a single percentage and the storefront puts every line
 * on the plan of the tier the shopper reached. Each plan's option label is
 * unique within the group and is how existing plans are matched on update.
 */
type DesiredPlan = {
  key: string; percent: number; tierMinItems: number | null;
  /** A new price instead of % off: a fixed-price bundle sold as its product. */
  price: number | null;
};

function desiredPlans(bundle: BundleWithItems): DesiredPlan[] {
  const label = intervalLabel(bundle.interval, bundle.intervalCount);
  const tiers = bundle.pricingMode === "TIERED" ? parseTiers(bundle.tiersJson) : [];
  // A fixed-price bundle sold as its product is one line: the plan sets that
  // line's price exactly. Items on their own lines (bundles saved before the
  // product existed) can't share a total, so they use the matching percentage.
  const price = bundle.pricingMode === "FIXED_PRICE" && bundle.bundleVariantId && bundle.fixedPrice
    ? bundle.fixedPrice
    : null;
  // Below the first tier the base plan applies, which for tiered bundles is no
  // discount.
  const basePercent = bundle.pricingMode === "TIERED" ? 0 : bundle.discountPercent;
  return [
    { key: label, percent: basePercent, tierMinItems: null, price },
    ...tiers.map((t) => ({ key: `${label} · ${t.minItems}+ items`, percent: t.percent, tierMinItems: t.minItems, price: null })),
  ];
}

function planInput(bundle: BundleWithItems, plan: DesiredPlan) {
  // Shown in the cart and on the subscription. For a new price, `percent` is
  // its matching percentage, rounded here as on the storefront badge.
  const saving = plan.price !== null ? Math.round(plan.percent) : plan.percent;
  return {
    name:     saving > 0 ? `${plan.key} (${saving}% off)` : plan.key,
    options:  plan.key,
    category: "SUBSCRIPTION",
    billingPolicy:  { recurring: { interval: bundle.interval, intervalCount: bundle.intervalCount } },
    deliveryPolicy: { recurring: { interval: bundle.interval, intervalCount: bundle.intervalCount } },
    pricingPolicies: plan.price !== null
      ? [{ fixed: { adjustmentType: "PRICE", adjustmentValue: { fixedValue: plan.price } } }]
      : plan.percent > 0
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
  // On the product it's sold as, once that's live; bundles still adding one
  // line per item need it on the items. Switching moves it: the attach step
  // below removes whatever isn't wanted. Existing subscriptions are unaffected.
  const wanted  = bundle.bundleVariantId && bundle.bundleProductId
    ? [bundle.bundleProductId]
    : [...new Set(bundle.items.map((i) => i.productId))];
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

// ─── Shopify: the product a recurring bundle is sold as ──────────────────────

export { BUNDLE_PRODUCT_TAG };

/** The most item images the bundle's product gets. */
const MAX_BUNDLE_IMAGES = 10;

type ItemDetail = {
  id: string; price: string; title: string; image: { url: string } | null;
  product: { title: string; featuredMedia: { preview: { image: { url: string } | null } | null } | null };
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The item's own image: the variant's, else the product's. */
function itemImageUrl(detail: ItemDetail): string | null {
  return detail.image?.url ?? detail.product.featuredMedia?.preview?.image?.url ?? null;
}

/** "2 ×The Collection Snowboard – Large". */
function includedItemLabel(quantity: number, detail: ItemDetail): string {
  const variant = /^default title$/i.test(detail.title) ? "" : ` – ${detail.title}`;
  return `${quantity > 1 ? `${quantity} × ` : ""}${detail.product.title}${variant}`;
}

/** The Online Store's publication: where the product must be for the cart to take it. */
async function onlineStorePublicationId(graphql: AdminGraphQL): Promise<string> {
  const data = await gql<{ publications: { nodes: Array<{ id: string; name: string | null; catalog: { title: string } | null }> } }>(
    graphql, PUBLICATIONS, {},
  );
  const isOnlineStore = (s: string | null | undefined) => /^online store$/i.test(s?.trim() ?? "");
  const pub = data.publications.nodes.find((p) => isOnlineStore(p.catalog?.title) || isOnlineStore(p.name));
  if (!pub) throw new Error("The Online Store sales channel wasn't found.");
  return pub.id;
}

/**
 * Creates or updates the product a recurring bundle is sold as (see the top of
 * this file) and records it on the bundle. Returns a problem to show the
 * merchant, or null.
 *
 * Priced at the items' total. The discount, or the exact fixed price, is the
 * pricing policy of the bundle's selling plan, like any subscription discount,
 * so someone who opens the unlisted product and buys it one-time pays full
 * price. It isn't subscription-only: prepaid payments go through draft orders,
 * whose lines can't carry a selling plan.
 *
 * A one-time bundle's product is the parent its item lines are merged into in
 * the cart (extensions/bundle-merge); its price comes from those lines. It
 * "requires components", so it can't be bought on its own, unless subscribers
 * from when the bundle was recurring still renew with it.
 *
 * The bundle only becomes one cart line once the product is on the Online
 * Store (bundleVariantId set); until then it keeps adding one line per item.
 */
async function syncBundleProduct(graphql: AdminGraphQL, bundle: BundleWithItems): Promise<string | null> {
  try {
    const items = collapseBundleItems(bundle.items);
    const found = await gql<{ nodes: Array<ItemDetail | null> }>(
      graphql, BUNDLE_ITEM_DETAILS, { ids: items.map((i) => i.variantId) },
    );
    const byId = new Map(found.nodes.filter((n): n is ItemDetail => !!n?.id).map((n) => [n.id, n]));
    const gone = items.filter((i) => !byId.has(i.variantId));
    if (gone.length) {
      throw new Error(`${gone.map((i) => i.title).join(", ")} no longer exist${gone.length === 1 ? "s" : ""}. Pick the products again.`);
    }

    const listTotal = Math.round(items.reduce((s, i) => s + parseFloat(byId.get(i.variantId)!.price) * i.quantity, 0) * 100) / 100;
    const included  = items.map((i) => includedItemLabel(i.quantity, byId.get(i.variantId)!));
    const product   = {
      title:           bundle.name,
      descriptionHtml: `<p>This bundle includes:</p><ul>${included.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`,
      productType:     "Bundle",
      tags:            [BUNDLE_PRODUCT_TAG],
      // Bought only through the bundle block: kept out of collections, search
      // and recommendations, but reachable by its link (which the cart uses).
      status:          "UNLISTED",
    };

    let productId: string | null = bundle.bundleProductId;
    let variantId: string | null = null;
    let handle:    string | null = null;

    if (productId) {
      const data = await gql<{ product: { id: string; handle: string; variants: { nodes: Array<{ id: string }> } } | null }>(
        graphql, BUNDLE_PRODUCT_LOOKUP, { id: productId },
      );
      if (data.product) {
        const updated = await gql<{ productUpdate: { product: { handle: string } | null; userErrors: UserError[] } }>(
          graphql, BUNDLE_PRODUCT_UPDATE, { product: { id: productId, ...product } },
        );
        assertNoUserErrors(updated.productUpdate.userErrors);
        handle    = updated.productUpdate.product?.handle ?? data.product.handle;
        variantId = data.product.variants.nodes[0]?.id ?? null;
      } else {
        // Deleted in the Shopify admin: make a new one.
        productId = null;
      }
    }

    if (!productId) {
      // Its images come next, from syncBundleImages.
      const created = await gql<{
        productCreate: { product: { id: string; handle: string; variants: { nodes: Array<{ id: string }> } } | null; userErrors: UserError[] };
      }>(graphql, BUNDLE_PRODUCT_CREATE, { product });
      assertNoUserErrors(created.productCreate.userErrors);
      const p = created.productCreate.product;
      if (!p) throw new Error("Shopify created no product.");
      productId = p.id;
      handle    = p.handle;
      variantId = p.variants.nodes[0]?.id ?? null;
    }
    if (!variantId) throw new Error("The bundle's product has no variant.");

    // Recorded before anything else can fail, so a product that exists is
    // never created twice. Not yet the variant: see below.
    await db.productBundle.update({ where: { id: bundle.id }, data: { bundleProductId: productId } });

    // Only a merge parent needs components; a product subscribers renew with
    // must stay buyable on its own.
    const subscribers = bundle.type === "ONE_TIME"
      ? await db.subscription.count({ where: { bundleId: bundle.id, status: { in: ["ACTIVE", "PAUSED"] } } })
      : 0;
    const requiresComponents = bundle.type === "ONE_TIME" && subscribers === 0;

    const priced = await gql<{ productVariantsBulkUpdate: { userErrors: UserError[] } }>(graphql, BUNDLE_VARIANT_UPDATE, {
      productId,
      variants: [{
        id:              variantId,
        price:           listTotal.toFixed(2),
        compareAtPrice:  null,
        taxable:         true,
        // Stock is the items' business; the bundle itself never runs out.
        inventoryPolicy: "CONTINUE",
        inventoryItem:   { tracked: false, requiresShipping: true },
        requiresComponents,
      }],
    });
    assertNoUserErrors(priced.productVariantsBulkUpdate.userErrors);

    try {
      const published = await gql<{ publishablePublish: { userErrors: UserError[] } }>(graphql, BUNDLE_PRODUCT_PUBLISH, {
        id: productId, input: [{ publicationId: await onlineStorePublicationId(graphql) }],
      });
      assertNoUserErrors(published.publishablePublish.userErrors);
    } catch (err) {
      const message = errorText(err);
      if (/access denied|read_publications|write_publications/i.test(message)) {
        throw new Error("the app needs permission to publish products. Open the app, accept its updated permissions, then save the bundle again.");
      }
      // Shopify won't publish bundle products in a store that can't sell bundles.
      const reason = requiresComponents ? await bundleIneligibility(graphql) : null;
      throw new Error(reason
        ? `your store can't sell bundles yet (${reason}).`
        : `it couldn't be published to your Online Store: ${message}`);
    }

    // On the Online Store: from now on the bundle is one cart line.
    await db.productBundle.update({
      where: { id: bundle.id },
      data:  { bundleProductId: productId, bundleVariantId: variantId, bundleProductHandle: handle },
    });
    return null;

  } catch (err) {
    console.error(`[bundles] product sync failed for ${bundle.id}:`, errorText(err));
    return errorText(err);
  }
}

/**
 * Keeps the images of a bundle's product the same as its items' images, in
 * bundle order, so its main image is the first item's. The line in cart,
 * checkout, orders, emails and the subscription page shows that main image.
 *
 * Replaced only when the items or their images change: the media the app added
 * and a signature of the images live in the product metafield
 * kas_bundle.images. Only the app's own media are ever removed; images the
 * merchant adds in Shopify stay, after the items'. A product from before that
 * record holds only what the app put there (the items' images, and the picture
 * of them it used to draw), so all of it is the app's. Returns a problem to
 * show the merchant, or null; the bundle works either way.
 */
async function syncBundleImages(graphql: AdminGraphQL, bundle: BundleWithItems): Promise<string | null> {
  const productId = bundle.bundleProductId;
  if (!productId) return null;
  let unrecorded: string[] = [];   // added to the product, not yet in the record
  try {
    type MediaState = {
      product: {
        media:   { nodes: Array<{ id: string }> };
        images:  { jsonValue: unknown } | null;
        collage: { id: string } | null;
      } | null;
    };
    const before = await gql<MediaState>(graphql, BUNDLE_PRODUCT_MEDIA, { id: productId });
    if (!before.product) return null;

    // The old picture's record; the picture itself goes with the rest below.
    if (before.product.collage) {
      try {
        const cleared = await gql<{ metafieldsDelete: { userErrors: UserError[] } }>(graphql, PRODUCT_METAFIELDS_DELETE, {
          metafields: [{ ownerId: productId, namespace: "kas_bundle", key: "collage" }],
        });
        assertNoUserErrors(cleared.metafieldsDelete.userErrors);
      } catch (err) {
        // A leftover record is untidy, not broken.
        console.error(`[bundles] could not delete the old picture record of ${bundle.id}:`, errorText(err));
      }
    }

    const mediaIds = before.product.media.nodes.map((n) => n.id);
    const saved    = (before.product.images?.jsonValue ?? null) as { mediaIds?: unknown; signature?: unknown } | null;
    const savedIds = Array.isArray(saved?.mediaIds) ? saved.mediaIds.filter((id): id is string => typeof id === "string") : null;
    const ours     = savedIds ? mediaIds.filter((id) => savedIds.includes(id)) : mediaIds;

    // The items' images in bundle order, each once.
    const items = collapseBundleItems(bundle.items);
    const found = await gql<{ nodes: Array<ItemDetail | null> }>(
      graphql, BUNDLE_ITEM_DETAILS, { ids: items.map((i) => i.variantId) },
    );
    const byId   = new Map(found.nodes.filter((n): n is ItemDetail => !!n?.id).map((n) => [n.id, n]));
    const images = new Map<string, string>();   // url → alt
    for (const item of items) {
      const detail = byId.get(item.variantId);
      const url    = detail ? itemImageUrl(detail) : null;
      if (detail && url && !images.has(url)) images.set(url, detail.product.title);
    }
    const wanted = [...images].slice(0, MAX_BUNDLE_IMAGES);

    const signature = createHash("sha1").update(JSON.stringify(wanted.map(([url]) => url))).digest("hex").slice(0, 16);
    if (savedIds && saved?.signature === signature && ours.length === savedIds.length) return null;   // up to date

    const record = async (ids: string[], sig: string) => {
      const recorded = await gql<{ metafieldsSet: { userErrors: UserError[] } }>(graphql, PRODUCT_METAFIELDS_SET, {
        metafields: [{
          ownerId: productId, namespace: "kas_bundle", key: "images", type: "json",
          value: JSON.stringify({ mediaIds: ids, signature: sig }),
        }],
      });
      assertNoUserErrors(recorded.metafieldsSet.userErrors);
    };

    let added: string[] = [];
    if (wanted.length) {
      const attached = await gql<{ productUpdate: { userErrors: UserError[] } }>(graphql, BUNDLE_MEDIA_ATTACH, {
        product: { id: productId },
        media:   wanted.map(([originalSource, alt]) => ({ originalSource, mediaContentType: "IMAGE", alt })),
      });
      assertNoUserErrors(attached.productUpdate.userErrors);
      const after = await gql<MediaState>(graphql, BUNDLE_PRODUCT_MEDIA, { id: productId });
      added = unrecorded = (after.product?.media.nodes.map((n) => n.id) ?? []).filter((id) => !mediaIds.includes(id));
      if (!added.length) throw new Error("Shopify didn't add the items' images to the product.");

      // Recorded with the old ones straight away, unfinished (no signature):
      // whatever fails from here on, the next save clears all of them away.
      await record([...ours, ...added], "");
      unrecorded = [];
    }

    if (ours.length) {
      const removed = await gql<{ fileDelete: { userErrors: UserError[] } }>(graphql, BUNDLE_MEDIA_DELETE, { ids: ours });
      assertNoUserErrors(removed.fileDelete.userErrors);
    }

    // Shopify adds new media last: move them ahead of any the merchant added.
    if (added.length && mediaIds.length > ours.length) {
      const moved = await gql<{ productReorderMedia: { mediaUserErrors: UserError[] } }>(graphql, BUNDLE_MEDIA_REORDER, {
        id: productId, moves: added.map((id, k) => ({ id, newPosition: String(k) })),
      });
      assertNoUserErrors(moved.productReorderMedia.mediaUserErrors);
    }

    await record(added, signature);
    return null;

  } catch (err) {
    const message = errorText(err);
    console.error(`[bundles] images failed for ${bundle.id}:`, message);
    // Unrecorded, the images just added would stay for good: take them away,
    // and the next save tries again.
    if (unrecorded.length) {
      try {
        await gql(graphql, BUNDLE_MEDIA_DELETE, { ids: unrecorded });
      } catch (undoErr) {
        console.error(`[bundles] could not take back the new images of ${bundle.id}:`, errorText(undoErr));
      }
    }
    return /access denied|write_files|read_files/i.test(message)
      ? "the app needs permission to manage files. Open the app, accept its updated permissions, then save the bundle again."
      : message;
  }
}

/**
 * Why Shopify won't let this store sell bundles, or null when it can (or when
 * that can't be found out).
 */
async function bundleIneligibility(graphql: AdminGraphQL): Promise<string | null> {
  try {
    const data = await gql<{ shop: { features: { bundles: { eligibleForBundles: boolean; ineligibilityReason: string | null } } } }>(
      graphql, BUNDLES_ELIGIBILITY, {},
    );
    const b = data.shop.features.bundles;
    return b.eligibleForBundles ? null : (b.ineligibilityReason || "Shopify didn't say why");
  } catch {
    return null;
  }
}

/** Returns a problem to show the merchant, or null. */
async function deleteBundleProduct(graphql: AdminGraphQL, productId: string): Promise<string | null> {
  try {
    const data = await gql<{ productDelete: { userErrors: UserError[] } }>(
      graphql, BUNDLE_PRODUCT_DELETE, { input: { id: productId } },
    );
    assertNoUserErrors(data.productDelete.userErrors);
    return null;
  } catch (err) {
    const message = errorText(err);
    if (/not.?found|does not exist/i.test(message)) return null;
    console.error(`[bundles] could not delete bundle product ${productId}:`, message);
    return `The bundle's product couldn't be deleted from Shopify: ${message}`;
  }
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

// ─── Shopify: one-time bundles as one cart line ──────────────────────────────

const MERGE_CONFIG_KEY = "bundle-merge";

/**
 * Keeps the bundle-merge cart transform (extensions/bundle-merge) in step with
 * the shop's active one-time bundles that have their product, installing the
 * transform the first time one exists. It merges each such bundle's item lines
 * into one line with its product as the parent and prices it, so cart and
 * checkout show one bundle with its items. Bundles it doesn't cover keep their
 * separate lines, priced by the bundle discount (syncOneTimeBundleDiscount).
 * Returns a problem to show the merchant, or null.
 */
export async function syncBundleMergeConfig(graphql: AdminGraphQL, shop: string): Promise<string | null> {
  let toMerge = 0;   // one-time bundles the cart should group
  try {
    const bundles = await db.productBundle.findMany({
      where:   { shop, type: "ONE_TIME", active: true, bundleVariantId: { not: null } },
      include: { items: true },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    toMerge = bundles.length;

    const config = JSON.stringify({
      bundles: bundles.map((b) => ({
        id:              b.id,
        title:           b.name,
        parentVariantId: b.bundleVariantId,
        // PERCENT: the discount. FIXED_PRICE: the matching percentage, used on
        // units outside complete sets. TIERED: unused (0); the tiers decide.
        percent:         b.discountPercent,
        kind:            b.kind === "BOX" ? "BOX" : "SET",
        pricingMode:     b.pricingMode,
        fixedPrice:      b.pricingMode === "FIXED_PRICE" ? b.fixedPrice : null,
        minItems:        b.kind === "BOX" ? b.minItems : 0,
        tiers:           b.pricingMode === "TIERED"
          ? parseTiers(b.tiersJson).map(({ minItems, percent }) => ({ minItems, percent }))
          : [],
        // By product, like the bundle discount: any variant of an item counts.
        lines:           collapseBundleItems(b.items).map((i) => ({ productId: i.productId, quantity: i.quantity })),
      })),
    });
    const metafield = { namespace: "$app", key: MERGE_CONFIG_KEY, type: "json", value: config };

    // Only this app's transforms are listed, and an app has at most one per store.
    const found = await gql<{ cartTransforms: { nodes: Array<{ id: string }> } }>(graphql, CART_TRANSFORMS, {});
    const transformId = found.cartTransforms.nodes[0]?.id ?? null;

    if (!transformId) {
      // Nothing to merge and nothing installed: leave Shopify alone.
      if (!bundles.length) return null;
      const created = await gql<{ cartTransformCreate: { userErrors: UserError[] } }>(
        graphql, CART_TRANSFORM_CREATE, { metafields: [metafield] },
      );
      assertNoUserErrors(created.cartTransformCreate.userErrors);
      return null;
    }

    const saved = await gql<{ metafieldsSet: { userErrors: UserError[] } }>(
      graphql, CART_TRANSFORM_CONFIG_SET, { metafields: [{ ownerId: transformId, ...metafield }] },
    );
    assertNoUserErrors(saved.metafieldsSet.userErrors);
    return null;

  } catch (err) {
    const message = errorText(err);
    console.error(`[bundles] bundle merge sync failed for ${shop}:`, message);
    if (/access denied|cart_transforms/i.test(message)) {
      // Without the permission nothing was ever installed, so with no one-time
      // bundles there is nothing wrong to report.
      if (!toMerge) return null;
      return"One-time bundles show as separate lines in the cart: the app needs permission to change how the cart shows them. Open the app, accept its updated permissions, then save the bundle again.";
    }
    // The usual cause before launch: the function hasn't been deployed yet.
    return /function/i.test(message)
      ? `One-time bundles show as separate lines in the cart until the app's bundle-merge function is deployed. Then save the bundle again. (${message})`
      : `One-time bundles show as separate lines in the cart: the cart grouping couldn't be updated in Shopify: ${message}`;
  }
}
