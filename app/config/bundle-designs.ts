// app/config/bundle-designs.ts
//
// Storefront themes a bundle can be shown in. Shared by the server (validation),
// the Bundles admin page (picker + live preview) and, by value, the storefront
// block (extensions/subscription/assets/bundle-offer.js), which must know the
// same four names. Not a .server file: the admin page renders these in the browser.

export type BundleDesign = "classic" | "together" | "compact" | "savings";

export const BUNDLE_DESIGNS: Array<{ value: BundleDesign; label: string; description: string }> = [
  { value: "classic",  label: "Classic list",    description: "Stacked rows with thumbnails, the bundle total and a full-width button." },
  { value: "together", label: "Bought together", description: "Product tiles side by side joined by “+”, like “Frequently bought together”." },
  { value: "compact",  label: "Compact bar",     description: "One slim row: overlapping thumbnails, savings, price and a small button." },
  { value: "savings",  label: "Savings card",    description: "A bold card with a “Save $X” ribbon, an item checklist and a big price." },
];

export function parseBundleDesign(raw: unknown): BundleDesign {
  return BUNDLE_DESIGNS.some((d) => d.value === raw) ? (raw as BundleDesign) : "classic";
}

export function bundleDesignLabel(value: string): string {
  return BUNDLE_DESIGNS.find((d) => d.value === value)?.label ?? "Classic list";
}
