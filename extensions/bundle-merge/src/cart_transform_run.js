// @ts-check

/**
 * One-time bundles as ONE line in cart and checkout.
 *
 * The storefront bundle block adds each item the shopper keeps as its own cart
 * line, tagged with the `_kas_bundle` attribute. This merges a bundle's lines
 * into a single line whose parent is the bundle's own (unlisted) product, so
 * Shopify shows it as a bundle: the parent with its image, and the items, each
 * with theirs, underneath. Orders still list every item as a component, so
 * each is stocked and shipped as usual.
 *
 * The bundle price is the merge's percentage decrease, following the same rules
 * as app/config/bundle-pricing.ts:
 *   kind BOX         not merged below `minItems` (the block won't add it).
 *   PERCENT          `percent` off.
 *   TIERED           the percentage of the highest tier the units reach.
 *   FIXED_PRICE      exactly `fixedPrice` (shop currency, converted with
 *                    presentmentCurrencyRate) per complete set, and `percent`
 *                    (the matching percentage) on units outside complete sets,
 *                    folded into one percentage for the whole line.
 *
 * Cart transforms run before discount functions, so the bundle-discount
 * function then only sees the merged line, which isn't a bundle item, and adds
 * nothing. Bundles this doesn't merge (no product yet, or a store that can't
 * sell bundles) keep their separate lines, which that function prices instead.
 *
 * Recurring bundles never reach here: they are sold as one product already,
 * and Shopify rejects merges of lines that have a selling plan.
 *
 * Config (cart transform metafield $app/bundle-merge), maintained by the app:
 *   { "bundles": [ { "id", "title", "parentVariantId", "percent", "kind",
 *                    "pricingMode", "fixedPrice", "minItems",
 *                    "tiers": [{ "minItems", "percent" }],
 *                    "lines": [ { "productId", "quantity" } ] } ] }
 */

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  if (!input.cart.lines.length) return NO_CHANGES;

  const bundles = readConfig(input.cartTransform?.metafield);
  if (!bundles.length) return NO_CHANGES;

  const rate = Number(input.presentmentCurrencyRate) || 1;

  // Bundle lines in the cart, grouped by the bundle they were added for.
  /** @type {Map<string, BundleLine[]>} */
  const linesByBundle = new Map();
  for (const line of input.cart.lines) {
    const bundleId = line.bundleId?.value;
    if (!bundleId || line.merchandise.__typename !== 'ProductVariant') continue;
    const list = linesByBundle.get(bundleId) ?? [];
    list.push({
      id:           line.id,
      productId:    line.merchandise.product.id,
      quantity:     line.quantity,
      unitPrice:    Number(line.cost?.amountPerQuantity?.amount) || 0,
      onPlan:       !!line.sellingPlanAllocation,
    });
    linesByBundle.set(bundleId, list);
  }

  const operations = [];
  for (const bundle of bundles) {
    const tagged = linesByBundle.get(bundle.id);
    if (!tagged) continue;
    const merge = mergeFor(bundle, tagged.filter((l) => inBundle(bundle, l)), rate);
    if (merge) operations.push({ linesMerge: merge });
  }

  return operations.length ? { operations } : NO_CHANGES;
}

/**
 * @typedef {{ id: string, productId: string, quantity: number, unitPrice: number, onPlan: boolean }} BundleLine
 */

/** The merge for one bundle's lines, or null when they stay as they are. */
function mergeFor(bundle, lines, rate) {
  if (!lines.length) return null;
  // Shopify rejects the merge if any line has a selling plan.
  if (lines.some((l) => l.onPlan)) return null;

  const units = lines.reduce((sum, l) => sum + l.quantity, 0);
  if (bundle.kind === 'BOX' && units < (bundle.minItems || 0)) return null;

  const percent = round4(clamp(bundlePercent(bundle, lines, units, rate)));
  return {
    cartLines:       lines.map((l) => ({ cartLineId: l.id, quantity: l.quantity })),
    parentVariantId: bundle.parentVariantId,
    title:           bundle.title || undefined,
    ...(percent > 0 ? { price: { percentageDecrease: { value: String(percent) } } } : {}),
    // Not `_kas_bundle`: the bundle-discount function must not see the merged
    // line as a bundle item.
    attributes:      [{ key: '_kas_bundle_id', value: bundle.id }],
  };
}

/** The percentage off the whole merged line. */
function bundlePercent(bundle, lines, units, rate) {
  if (bundle.pricingMode === 'TIERED') return tierPercent(bundle.tiers, units);
  if (bundle.pricingMode === 'FIXED_PRICE' && bundle.fixedPrice > 0) return fixedPricePercent(bundle, lines, rate);
  return bundle.percent;
}

/**
 * Exactly `fixedPrice` per complete set, and the matching percentage on units
 * outside complete sets, expressed as one percentage off the lines' total.
 */
function fixedPricePercent(bundle, lines, rate) {
  const requirements = setRequirements(bundle);

  let sets = Infinity;
  for (const req of requirements) {
    const have = lines.filter((l) => l.productId === req.productId).reduce((s, l) => s + l.quantity, 0);
    sets = Math.min(sets, Math.floor(have / req.required));
  }
  if (!Number.isFinite(sets)) sets = 0;

  // Units of each line that belong to complete sets, in cart order.
  const claimed = new Map();
  if (sets > 0) {
    for (const req of requirements) {
      let left = req.required * sets;
      for (const line of lines) {
        if (left <= 0) break;
        if (line.productId !== req.productId) continue;
        const take = Math.min(left, line.quantity - (claimed.get(line.id) ?? 0));
        if (take <= 0) continue;
        claimed.set(line.id, (claimed.get(line.id) ?? 0) + take);
        left -= take;
      }
    }
  }

  const total    = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const setValue = lines.reduce((s, l) => s + (claimed.get(l.id) ?? 0) * l.unitPrice, 0);
  const leftover = total - setValue;
  if (!(total > 0)) return 0;

  const matching = bundle.percent > 0 ? bundle.percent : 0;
  const target   = Math.min(setValue, bundle.fixedPrice * rate * sets) + leftover * (1 - matching / 100);
  return (1 - target / total) * 100;
}

// ── Helpers ────────────────────────────────────────────────────

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function clamp(n) {
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

/** The percentage for `count` units: the highest tier reached, else 0. */
function tierPercent(tiers, count) {
  let percent = 0;
  for (const t of Array.isArray(tiers) ? tiers : []) {
    if (t && count >= t.minItems && t.percent > 0 && t.percent <= 100) percent = t.percent;
  }
  return percent;
}

/** Required units per product for one complete set. */
function setRequirements(bundle) {
  const byProduct = new Map();
  for (const l of bundle.lines) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.quantity);
  return [...byProduct].map(([productId, required]) => ({ productId, required }));
}

/** Whether a tagged line's product belongs to the bundle. */
function inBundle(bundle, line) {
  return bundle.lines.some((l) => l.productId === line.productId);
}

/**
 * The bundles worth considering, with anything malformed dropped rather than
 * allowed to throw: a function that errors leaves the whole cart unmerged.
 */
function readConfig(metafield) {
  const raw = metafield?.jsonValue;
  const list = raw && Array.isArray(raw.bundles) ? raw.bundles : [];

  return list.filter(
    (b) =>
      b &&
      typeof b.id === 'string' &&
      typeof b.parentVariantId === 'string' &&
      b.parentVariantId.startsWith('gid://shopify/ProductVariant/') &&
      typeof b.percent === 'number' &&
      b.percent >= 0 &&
      b.percent <= 100 &&
      Array.isArray(b.lines) &&
      b.lines.length > 0 &&
      b.lines.every((l) => l && typeof l.productId === 'string' && l.quantity > 0),
  );
}
