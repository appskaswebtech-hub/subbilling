// app/lib/commission-display.ts
//
// Shared shape and totals for CommissionCharge rows as the UI reads them.
//
// Deliberately NOT a .server module: one page splits these totals in its loader
// and another in its component, so both sides must be able to import it. It
// touches no Prisma client — callers pass rows they already fetched.

export type CommissionRow = {
  amount:        number;
  currency:      string;
  status:        string;
  reason:        string | null;
  usageRecordId: string | null;
};

export type CommissionTotals = {
  /** Money actually billed through appUsageRecordCreate. */
  charged:      number;
  chargedCount: number;
  /** Estimated on attempts that have not settled. Never billed as-is. */
  pending:      number;
  pendingCount: number;
  currency:     string;
};

/**
 * Splits a set of ledger rows into charged and pending totals.
 *
 * Only CHARGED and PENDING carry a figure worth showing. SKIPPED, FAILED and
 * VOID are counted in neither: nothing was billed, and a SKIPPED row's amount
 * may still be denominated in the ORDER's currency rather than the billing one
 * — summing it is exactly the mislabelling app-commission.server.ts guards
 * against.
 */
export function splitCommissions(rows: CommissionRow[]): CommissionTotals {
  const charged = rows.filter((r) => r.status === "CHARGED");
  const pending = rows.filter((r) => r.status === "PENDING");

  return {
    charged:      charged.reduce((sum, r) => sum + r.amount, 0),
    chargedCount: charged.length,
    pending:      pending.reduce((sum, r) => sum + r.amount, 0),
    pendingCount: pending.length,
    // Shopify fixes the currency on the AppSubscription at approval, so every
    // row for one shop shares it — the first row that has one speaks for all.
    currency:     charged[0]?.currency ?? pending[0]?.currency ?? "USD",
  };
}
