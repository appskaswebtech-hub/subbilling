// app/config/widget-chips.ts
//
// Benefit chips for the "benefits" widget design.
//
// Deliberately NOT in widget-settings.server.ts: that module imports db.server,
// and the widget settings PAGE needs the limit and the parser in its React
// component as well as its loader. Importing a .server module from client code
// fails the build with "Server-only module referenced by client", so the pure
// parts live here and the server module builds on them.

/**
 * More than a handful wraps into a block that dwarfs the widget itself, so the
 * storefront is protected from a runaway paste regardless of the admin form.
 */
export const MAX_BENEFIT_CHIPS = 6;

/** A chip is a short selling point, and the column it lands in is VarChar(1000). */
export const MAX_CHIP_LENGTH = 80;

/**
 * Shown until the merchant saves their own. `{discount}` is substituted with
 * the active plan's discount when rendered, and a chip using the token is
 * dropped entirely when a plan has no discount.
 */
export const DEFAULT_BENEFIT_CHIPS = [
  "{discount}% off each order",
  "Manage subscriptions easily",
  "Earn loyalty points",
];

/** Stored newline-separated — readable in the DB, and a direct fit for the row editor. */
export function parseBenefitChips(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_BENEFIT_CHIPS);
}

export function serializeBenefitChips(chips: string[]): string {
  return chips
    .map((c) => c.trim().slice(0, MAX_CHIP_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_BENEFIT_CHIPS)
    .join("\n");
}
