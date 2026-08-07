// app/components/SubscriptionEditForm.tsx
//
// Edit controls for a live subscription contract.
//
// All four editable areas — next billing date, billing/delivery frequency,
// line quantity and line price — go into ONE draft and ONE commit on the
// server, so this is one form with one submit rather than inline-editable
// rows. The read-only "Subscription details" card next to it stays as the
// record of what Shopify currently says.

import { useMemo, useState } from "react";
import { Text } from "@shopify/polaris";

export interface EditableLine {
  id:                   string;
  title?:               string;
  variantTitle?:        string | null;
  quantity?:            number;
  currentPrice?:        { amount: string; currencyCode: string } | null;
  lineDiscountedPrice?: { amount: string; currencyCode: string } | null;
}

export interface EditableContract {
  nextBillingDate?: string | null;
  currencyCode?:    string;
  billingPolicy?:   { interval?: string; intervalCount?: number } | null;
  deliveryPolicy?:  { interval?: string; intervalCount?: number } | null;
}

interface Props {
  contract:      EditableContract;
  lines:         EditableLine[];
  revision:      string;
  disabled:      boolean;
  disabledNote?: string | null;
  submitting:    boolean;
  onSubmit:      (formData: FormData) => void;
}

const INTERVALS = ["DAY", "WEEK", "MONTH", "YEAR"] as const;

// Shopify bills on the local nextBillingDate, so anything earlier than
// tomorrow charges the customer on the next cron run.
function tomorrowISO(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function toDateInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

const field: React.CSSProperties = {
  width: "100%", padding: "7px 10px", fontSize: "13px",
  border: "0.5px solid var(--p-color-border)", borderRadius: "8px",
  background: "var(--p-color-bg-surface)", color: "var(--p-color-text)",
};

const label: React.CSSProperties = {
  display: "block", fontSize: "12px", fontWeight: 500,
  marginBottom: "4px", color: "var(--p-color-text-subdued)",
};

export default function SubscriptionEditForm({
  contract, lines, revision, disabled, disabledNote, submitting, onSubmit,
}: Props) {
  const minDate = useMemo(tomorrowISO, []);

  const initial = useMemo(() => ({
    nextBillingDate:       toDateInput(contract.nextBillingDate),
    billingInterval:       (contract.billingPolicy?.interval  ?? "MONTH").toUpperCase(),
    billingIntervalCount:  String(contract.billingPolicy?.intervalCount  ?? 1),
    deliveryInterval:      (contract.deliveryPolicy?.interval ?? contract.billingPolicy?.interval ?? "MONTH").toUpperCase(),
    deliveryIntervalCount: String(contract.deliveryPolicy?.intervalCount ?? contract.billingPolicy?.intervalCount ?? 1),
    lines: Object.fromEntries(lines.map((l) => [
      l.id,
      { qty: String(l.quantity ?? 1), price: l.currentPrice?.amount ?? "" },
    ])),
  }), [contract, lines]);

  const [form, setForm]           = useState(initial);
  const [deliverySame, setSame]   = useState(
    initial.billingInterval === initial.deliveryInterval &&
    initial.billingIntervalCount === initial.deliveryIntervalCount,
  );

  const currency = contract.currencyCode ?? lines[0]?.currentPrice?.currencyCode ?? "";

  const dirty = useMemo(() => {
    if (form.nextBillingDate      !== initial.nextBillingDate)      return true;
    if (form.billingInterval      !== initial.billingInterval)      return true;
    if (form.billingIntervalCount !== initial.billingIntervalCount) return true;
    if (!deliverySame) {
      if (form.deliveryInterval      !== initial.deliveryInterval)      return true;
      if (form.deliveryIntervalCount !== initial.deliveryIntervalCount) return true;
    }
    return lines.some((l) =>
      form.lines[l.id]?.qty   !== initial.lines[l.id]?.qty ||
      form.lines[l.id]?.price !== initial.lines[l.id]?.price,
    );
  }, [form, initial, deliverySame, lines]);

  function setLine(id: string, key: "qty" | "price", value: string) {
    setForm((f) => ({ ...f, lines: { ...f.lines, [id]: { ...f.lines[id], [key]: value } } }));
  }

  function build(intent: "update-contract" | "preview-contract"): FormData {
    const fd = new FormData();
    fd.append("intent", intent);
    fd.append("revision", revision);
    fd.append("nextBillingDate", form.nextBillingDate);
    fd.append("billingInterval", form.billingInterval);
    fd.append("billingIntervalCount", form.billingIntervalCount);
    fd.append("deliveryInterval", deliverySame ? form.billingInterval : form.deliveryInterval);
    fd.append("deliveryIntervalCount", deliverySame ? form.billingIntervalCount : form.deliveryIntervalCount);
    for (const l of lines) {
      fd.append(`qty:${l.id}`, form.lines[l.id]?.qty ?? "");
      fd.append(`price:${l.id}`, form.lines[l.id]?.price ?? "");
    }
    return fd;
  }

  const locked = disabled || submitting;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "12px 0 4px" }}>

      {disabledNote && (
        <div style={{
          background: "#FAEEDA", border: "0.5px solid #DEB96A", borderRadius: "10px",
          padding: "10px 12px", fontSize: "12px", color: "#633806",
        }}>
          {disabledNote}
        </div>
      )}

      {/* Next billing date */}
      <div>
        <label style={label} htmlFor="nextBillingDate">Next billing date</label>
        <input
          id="nextBillingDate"
          type="date"
          min={minDate}
          disabled={locked}
          value={form.nextBillingDate}
          onChange={(e) => setForm((f) => ({ ...f, nextBillingDate: e.target.value }))}
          style={{ ...field, maxWidth: "220px" }}
        />
        <Text as="p" variant="bodySm" tone="subdued">
          Must be tomorrow or later — an earlier date bills the customer on the next billing run.
        </Text>
      </div>

      {/* Billing frequency */}
      <div>
        <span style={label}>Billing frequency</span>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{ fontSize: "13px", color: "var(--p-color-text-subdued)" }}>Every</span>
          <input
            type="number" min={1} disabled={locked}
            value={form.billingIntervalCount}
            onChange={(e) => setForm((f) => ({ ...f, billingIntervalCount: e.target.value }))}
            style={{ ...field, width: "80px" }}
          />
          <select
            disabled={locked}
            value={form.billingInterval}
            onChange={(e) => setForm((f) => ({ ...f, billingInterval: e.target.value }))}
            style={{ ...field, width: "130px" }}
          >
            {INTERVALS.map((i) => (
              <option key={i} value={i}>{i.charAt(0) + i.slice(1).toLowerCase()}(s)</option>
            ))}
          </select>
        </div>
      </div>

      {/* Delivery frequency */}
      <div>
        <label style={{ ...label, display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
          <input
            type="checkbox" disabled={locked}
            checked={deliverySame}
            onChange={(e) => setSame(e.target.checked)}
          />
          Deliver on the same schedule as billing
        </label>
        {!deliverySame && (
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <span style={{ fontSize: "13px", color: "var(--p-color-text-subdued)" }}>Every</span>
            <input
              type="number" min={1} disabled={locked}
              value={form.deliveryIntervalCount}
              onChange={(e) => setForm((f) => ({ ...f, deliveryIntervalCount: e.target.value }))}
              style={{ ...field, width: "80px" }}
            />
            <select
              disabled={locked}
              value={form.deliveryInterval}
              onChange={(e) => setForm((f) => ({ ...f, deliveryInterval: e.target.value }))}
              style={{ ...field, width: "130px" }}
            >
              {INTERVALS.map((i) => (
                <option key={i} value={i}>{i.charAt(0) + i.slice(1).toLowerCase()}(s)</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Lines */}
      <div>
        <span style={label}>Items</span>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {lines.map((l) => (
            <div key={l.id} style={{
              border: "0.5px solid var(--p-color-border)", borderRadius: "10px", padding: "10px 12px",
            }}>
              <Text as="p" variant="bodySm" fontWeight="semibold">
                {l.title}{l.variantTitle ? ` — ${l.variantTitle}` : ""}
              </Text>
              <div style={{ display: "flex", gap: "10px", marginTop: "8px", flexWrap: "wrap" }}>
                <div>
                  <label style={label} htmlFor={`qty-${l.id}`}>Quantity</label>
                  <input
                    id={`qty-${l.id}`} type="number" min={1} disabled={locked}
                    value={form.lines[l.id]?.qty ?? ""}
                    onChange={(e) => setLine(l.id, "qty", e.target.value)}
                    style={{ ...field, width: "100px" }}
                  />
                </div>
                <div>
                  <label style={label} htmlFor={`price-${l.id}`}>Price per unit {currency && `(${currency})`}</label>
                  <input
                    id={`price-${l.id}`} type="number" min={0} step="0.01" disabled={locked}
                    value={form.lines[l.id]?.price ?? ""}
                    onChange={(e) => setLine(l.id, "price", e.target.value)}
                    style={{ ...field, width: "140px" }}
                  />
                </div>
              </div>
              {l.lineDiscountedPrice && l.currentPrice &&
               l.lineDiscountedPrice.amount !== l.currentPrice.amount && (
                <Text as="p" variant="bodySm" tone="subdued">
                  After discounts the customer currently pays {l.lineDiscountedPrice.amount} {l.lineDiscountedPrice.currencyCode} per unit.
                  Editing the price above does not remove existing discounts.
                </Text>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={locked || !dirty}
          onClick={() => onSubmit(build("update-contract"))}
          style={{
            padding: "8px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: 600,
            border: "none", background: "#26215C", color: "#fff",
            cursor: locked || !dirty ? "not-allowed" : "pointer",
            opacity: locked || !dirty ? 0.55 : 1,
          }}
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          disabled={locked || !dirty}
          onClick={() => onSubmit(build("preview-contract"))}
          style={{
            padding: "8px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: 500,
            border: "0.5px solid var(--p-color-border-secondary)",
            background: "var(--p-color-bg-surface)", color: "var(--p-color-text)",
            cursor: locked || !dirty ? "not-allowed" : "pointer",
            opacity: locked || !dirty ? 0.55 : 1,
          }}
        >
          Preview without saving
        </button>
      </div>
      <Text as="p" variant="bodySm" tone="subdued">
        Preview builds the change in Shopify without committing it — the customer is not affected.
      </Text>
    </div>
  );
}
