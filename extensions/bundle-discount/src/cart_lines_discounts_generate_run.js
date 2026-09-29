import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

/**
 * One-time bundle discount.
 *
 * The storefront bundle block adds each bundle item the shopper keeps as its
 * own cart line, with a `_kas_bundle` attribute naming the bundle. A line only
 * counts if its PRODUCT is in that bundle (any variant), so tagging an unrelated
 * product with a bundle's attribute gets nothing.
 *
 * Pricing (same rules as app/config/bundle-pricing.ts):
 *   kind BOX         nothing until the shopper has at least `minItems` units.
 *   PERCENT          `percent` off every counted line.
 *   TIERED           the percentage of the highest tier reached by the units.
 *   FIXED_PRICE      the full set costs exactly `fixedPrice` (shop currency,
 *                    converted with presentmentCurrencyRate), per complete set.
 *                    Units outside complete sets get `percent`, the matching
 *                    percentage the app stored.
 *
 * Recurring bundles never reach here: their discount is the pricing policy of
 * their own selling plans, and this discount is created with
 * appliesOnSubscription: false.
 *
 * Config (discount metafield $app/bundle-config), maintained by the app:
 *   { "bundles": [ { "id", "title", "percent", "kind", "pricingMode",
 *                    "fixedPrice", "minItems", "tiers": [{ "minItems", "percent" }],
 *                    "lines": [ { "productId", "quantity" } ] } ] }
 * Older configs have only id/title/percent/lines (and maybe variantId lines);
 * those are PERCENT sets and still work.
 */

/**
  * @typedef {import("../generated/api").CartInput} RunInput
  * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
  */

/**
  * @param {RunInput} input
  * @returns {CartLinesDiscountsGenerateRunResult}
  */
export function cartLinesDiscountsGenerateRun(input) {
  const empty = {operations: []};

  if (!input.cart.lines.length) return empty;
  if (!input.discount.discountClasses.includes(DiscountClass.Product)) return empty;

  const bundles = readConfig(input.discount.metafield);
  if (!bundles.length) return empty;

  const rate = Number(input.presentmentCurrencyRate) || 1;

  // Bundle lines in the cart, grouped by the bundle they were added for.
  const linesByBundle = new Map();
  for (const line of input.cart.lines) {
    const bundleId = line.bundleId?.value;
    if (!bundleId || line.merchandise.__typename !== 'ProductVariant') continue;
    const list = linesByBundle.get(bundleId) ?? [];
    list.push({
      id: line.id,
      variantId: line.merchandise.id,
      productId: line.merchandise.product.id,
      quantity: line.quantity,
      unitPrice: Number(line.cost?.amountPerQuantity?.amount) || 0,
    });
    linesByBundle.set(bundleId, list);
  }

  const candidates = [];
  for (const bundle of bundles) {
    const tagged = linesByBundle.get(bundle.id);
    if (!tagged) continue;
    candidates.push(...bundleCandidates(bundle, inBundle(bundle, tagged), rate));
  }

  if (!candidates.length) return empty;

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          // Each candidate is a different bundle or line, so they all apply.
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

/** The discount candidates for one bundle's counted lines. */
function bundleCandidates(bundle, lines, rate) {
  if (!lines.length) return [];

  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (bundle.kind === 'BOX' && units < (bundle.minItems || 0)) return [];

  const name = bundle.title || 'Bundle';

  if (bundle.pricingMode === 'FIXED_PRICE' && bundle.fixedPrice > 0) {
    return fixedPriceCandidates(bundle, lines, rate, name);
  }

  const percent = bundle.pricingMode === 'TIERED'
    ? tierPercent(bundle.tiers, units)
    : bundle.percent;
  if (!(percent > 0)) return [];

  return [{
    message: `${name}: ${percent}% off`,
    targets: lines.map((line) => ({cartLine: {id: line.id}})),
    value: {percentage: {value: percent}},
  }];
}

/**
 * Exact fixed price for every complete set, plus the stored matching
 * percentage on any units outside complete sets. One fixed-amount candidate
 * per line, so a line never carries two discounts.
 */
function fixedPriceCandidates(bundle, lines, rate, name) {
  const requirements = setRequirements(bundle);

  // How many whole sets the lines add up to.
  let sets = Infinity;
  for (const req of requirements) {
    const have = lines.filter((line) => matches(line, req)).reduce((s, l) => s + l.quantity, 0);
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
        if (!matches(line, req)) continue;
        const free = line.quantity - (claimed.get(line.id) ?? 0);
        if (free <= 0) continue;
        const take = Math.min(left, free);
        claimed.set(line.id, (claimed.get(line.id) ?? 0) + take);
        left -= take;
      }
    }
  }

  // The set discount: what the set units cost now, minus the fixed price(s),
  // shared across the set lines in proportion to their value.
  const setValue = lines.reduce((s, l) => s + (claimed.get(l.id) ?? 0) * l.unitPrice, 0);
  const setDiscount = Math.max(0, setValue - bundle.fixedPrice * rate * sets);
  const percent = bundle.percent > 0 ? bundle.percent : 0;

  const amounts = new Map();
  let allocated = 0;
  const setLines = lines.filter((l) => (claimed.get(l.id) ?? 0) > 0);
  setLines.forEach((line, idx) => {
    const value = (claimed.get(line.id) ?? 0) * line.unitPrice;
    const share = idx === setLines.length - 1
      ? round2(setDiscount - allocated)                               // the remainder, so the total is exact
      : round2(setValue > 0 ? setDiscount * (value / setValue) : 0);
    allocated = round2(allocated + share);
    amounts.set(line.id, share);
  });

  // Units outside complete sets: the matching percentage.
  for (const line of lines) {
    const leftover = line.quantity - (claimed.get(line.id) ?? 0);
    if (leftover <= 0 || !percent) continue;
    amounts.set(line.id, round2((amounts.get(line.id) ?? 0) + leftover * line.unitPrice * (percent / 100)));
  }

  const candidates = [];
  for (const line of lines) {
    const amount = amounts.get(line.id) ?? 0;
    if (amount <= 0) continue;
    candidates.push({
      message: `${name}: bundle price`,
      targets: [{cartLine: {id: line.id}}],
      // Decimal is serialized as a string. Once per line, not per unit.
      value: {fixedAmount: {amount: amount.toFixed(2), appliesToEachItem: false}},
    });
  }
  return candidates;
}

// ── Helpers ────────────────────────────────────────────────────

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** The percentage for `count` units: the highest tier reached, else 0. */
function tierPercent(tiers, count) {
  let percent = 0;
  for (const t of Array.isArray(tiers) ? tiers : []) {
    if (t && count >= t.minItems && t.percent > 0 && t.percent <= 100) percent = t.percent;
  }
  return percent;
}

/**
 * What a config line matches a cart line on: the product id for current
 * configs, the exact variant for older ones.
 */
function lineKey(configLine) {
  return typeof configLine.productId === 'string'
    ? {field: 'productId', id: configLine.productId}
    : {field: 'variantId', id: configLine.variantId};
}

function matches(line, req) {
  return line[req.field] === req.id;
}

/** Required units per product (or legacy variant) for one complete set. */
function setRequirements(bundle) {
  const byKey = new Map();
  for (const configLine of bundle.lines) {
    const key = lineKey(configLine);
    const mapKey = key.field + ':' + key.id;
    const existing = byKey.get(mapKey);
    if (existing) existing.required += configLine.quantity;
    else byKey.set(mapKey, {field: key.field, id: key.id, required: configLine.quantity});
  }
  return [...byKey.values()];
}

/** The tagged lines whose product (or legacy variant) belongs to the bundle. */
function inBundle(bundle, tagged) {
  const allowed = new Set(bundle.lines.map((configLine) => {
    const key = lineKey(configLine);
    return key.field + ':' + key.id;
  }));
  return tagged.filter((line) => allowed.has('productId:' + line.productId) || allowed.has('variantId:' + line.variantId));
}

/**
 * The bundles worth considering, with anything malformed dropped rather than
 * allowed to throw: a function that errors blocks the whole discount.
 */
function readConfig(metafield) {
  const raw = metafield?.jsonValue;
  const list = raw && Array.isArray(raw.bundles) ? raw.bundles : [];

  return list.filter(
    (b) =>
      b &&
      typeof b.id === 'string' &&
      typeof b.percent === 'number' &&
      b.percent >= 0 &&
      b.percent <= 100 &&
      Array.isArray(b.lines) &&
      b.lines.length > 0 &&
      b.lines.every(
        (l) =>
          l &&
          (typeof l.productId === 'string' || typeof l.variantId === 'string') &&
          l.quantity > 0,
      ),
  );
}
