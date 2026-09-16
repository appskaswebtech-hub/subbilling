// app/components/CommissionCell.tsx
//
// One CommissionCharge ledger row as the merchant should read it, shared by
// every billing-history table (subscription detail, customer detail).
//
// The amount rendered is the one stored at charge time — what Shopify actually
// billed through the usage record — never a percentage recomputed on render, so
// it stays right after a rate change and reads 0 where the cap stopped us.

import { Text } from "@shopify/polaris";
import { formatMoney } from "../config/currency";
import type { CommissionRow } from "../lib/commission-display";

// Re-exported so the pages that render this cell can keep importing the row
// shape from one place alongside it.
export type { CommissionRow };

export function CommissionCell({
  row,
  attemptStatus,
}: {
  row:           CommissionRow | undefined;
  attemptStatus: string;
}) {
  // No ledger row: either the attempt has not settled yet, or the shop is on a
  // flat-fee plan that owes no commission at all. Neither is an error.
  if (!row) {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        {attemptStatus === "PENDING" ? "Pending" : "—"}
      </Text>
    );
  }

  // Reserved at cron time, not yet settled. Shown as an approximation because
  // the base is the stored per-unit price — the real charge re-derives it from
  // the order total.
  if (row.status === "PENDING") {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        <span title="Estimated — not yet charged">
          ≈ {formatMoney(row.amount, row.currency)} pending
        </span>
      </Text>
    );
  }

  if (row.status === "VOID") {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        <span title={row.reason ?? undefined}>Released (billing failed)</span>
      </Text>
    );
  }

  if (row.status === "CHARGED") {
    return (
      <span
        style={{ fontWeight: 500 }}
        // The usage record is the merchant-facing proof of the charge — it shows
        // on their Shopify invoice — so keep it reachable without cluttering.
        title={row.usageRecordId ? `Usage record ${row.usageRecordId}` : undefined}
      >
        {formatMoney(row.amount, row.currency)}
      </span>
    );
  }

  // Everything else was NOT billed. Say so in the merchant's terms rather than
  // showing a number they were never charged.
  const note =
    row.reason === "capped"       ? "Cap reached — not charged"
    : row.reason === "zero-amount" ? "—"
    : row.status === "SKIPPED"     ? "Not charged"
    : "Not charged (retrying)";

  return (
    <Text as="span" variant="bodySm" tone="subdued">
      <span title={row.reason ?? undefined}>{note}</span>
    </Text>
  );
}
