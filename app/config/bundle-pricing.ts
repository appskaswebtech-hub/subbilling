// app/config/bundle-pricing.ts
//
// How a bundle is priced, shared by the server (validation, plan sync), the
// admin page (editor, live preview) and — as the same rules re-written in plain
// JS — the storefront block (extensions/subscription/assets/bundle-offer.js)
// and the checkout function (extensions/bundle-discount). Keep them in step.
// Not a .server file: the admin page uses it in the browser.
//
//   kind  SET   a fixed set of products; shoppers can untick items.
//         BOX   build-your-own: the shopper picks at least `minItems` units
//               from the bundle's products (the pool), repeats allowed.
//
//   pricingMode  PERCENT      `discountPercent` off every item kept.
//                FIXED_PRICE  `fixedPrice` for the full set (sets only).
//                             `discountPercent` holds the matching percentage,
//                             recomputed on save from current prices; it's what
//                             recurring bundles and partial sets use.
//                TIERED       the percentage grows with the number of units
//                             kept: the highest tier whose minItems is reached.

export type BundleKind  = "SET" | "BOX";
export type PricingMode = "PERCENT" | "FIXED_PRICE" | "TIERED";

export interface Tier {
  minItems: number;
  percent:  number;
  /** The tier's own selling plan on a recurring bundle (full GID server-side,
   *  numeric on the storefront). */
  sellingPlanId?: string | null;
}

export const MAX_TIERS = 5;

export function parseBundleKind(raw: unknown): BundleKind {
  return raw === "BOX" ? "BOX" : "SET";
}

export function parsePricingMode(raw: unknown): PricingMode {
  return raw === "FIXED_PRICE" ? "FIXED_PRICE" : raw === "TIERED" ? "TIERED" : "PERCENT";
}

/** Tiers from the stored JSON, sorted ascending; anything malformed dropped. */
export function parseTiers(raw: unknown): Tier[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((t: any) => ({
      minItems:      Math.floor(Number(t?.minItems)),
      percent:       Number(t?.percent),
      sellingPlanId: typeof t?.sellingPlanId === "string" ? t.sellingPlanId : null,
    }))
    .filter((t) => Number.isFinite(t.minItems) && t.minItems >= 1 && Number.isFinite(t.percent) && t.percent > 0 && t.percent <= 100)
    .sort((a, b) => a.minItems - b.minItems);
}

/** The percentage for `count` units: the highest tier reached, else 0. */
export function tierPercent(tiers: Tier[], count: number): number {
  let percent = 0;
  for (const t of tiers) if (count >= t.minItems) percent = t.percent;
  return percent;
}

/** The tier after the one reached, for "Add 1 more to save 15%". */
export function nextTier(tiers: Tier[], count: number): Tier | null {
  return tiers.find((t) => t.minItems > count) ?? null;
}

/** One line for cards and previews: "3 for $99", "2+ 10% · 3+ 15%", "Any 3+ · 15% off". */
export function pricingSummary(b: {
  kind: string; pricingMode: string; discountPercent: number; fixedPrice?: number | null;
  minItems?: number; tiers: Tier[]; itemCount: number;
}, money: (amount: number) => string): string {
  const box = b.kind === "BOX";
  const prefix = box && b.minItems ? `Any ${b.minItems}+ · ` : "";
  if (b.pricingMode === "FIXED_PRICE" && b.fixedPrice) {
    return `${b.itemCount} for ${money(b.fixedPrice)}`;
  }
  if (b.pricingMode === "TIERED" && b.tiers.length) {
    return prefix + b.tiers.map((t) => `${t.minItems}+ ${t.percent}%`).join(" · ");
  }
  return prefix + (b.discountPercent > 0 ? `${b.discountPercent}% off` : "No discount");
}
