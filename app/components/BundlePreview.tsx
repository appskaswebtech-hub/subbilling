// app/components/BundlePreview.tsx
//
// How a bundle looks on the storefront, in each of its four themes. Mirrors
// extensions/subscription/assets/bundle-offer.js + blocks/bundle-offer.liquid;
// keep the two in step when changing a theme's layout.
//
// Pure presentation: prices are whatever the caller passes (the admin page
// loads live variant prices), and the accent defaults to the "Product bundles"
// theme block's default colour.
//
// Pricing follows app/config/bundle-pricing.ts. Sets show their starting
// state (everything ticked); a build-your-own box, which has one layout of its
// own whatever the theme, shows a shopper who has just picked the minimum.

import type { CSSProperties } from "react";
import type { BundleDesign } from "../config/bundle-designs";
import { nextTier, tierPercent, type BundleKind, type PricingMode, type Tier } from "../config/bundle-pricing";

export interface PreviewItem {
  key:           string;
  title:         string;
  imageUrl:      string | null;
  /** Per-unit price of the default / fixed variant, or null if unknown. */
  price:         number | null;
  quantity:      number;
  /** The shopper picks size/colour; shows a dropdown. */
  variantChoice: boolean;
  /** Fixed variant's name (e.g. "Black / Small"), or the default choice. */
  variantLabel?: string | null;
}

export interface BundlePreviewProps {
  design:          BundleDesign;
  name:            string;
  /** % off; for a fixed price, its matching percentage. */
  discountPercent: number;
  items:           PreviewItem[];
  /** "Every 1 Month" for recurring bundles; null for one-time. */
  frequency:       string | null;
  prepaid:         boolean;
  currency:        string;
  accent?:         string;
  buttonLabel?:    string;
  kind?:           BundleKind;
  pricingMode?:    PricingMode;
  /**
   * A recurring bundle sold as one product: fixed contents, so no ticks or
   * size choice, and a fixed price is exact.
   */
  locked?:         boolean;
  /** The full set's price. Exact for one-time bundles and locked ones. */
  fixedPrice?:     number | null;
  /** Boxes: shoppers pick at least this many. */
  minItems?:       number;
  tiers?:          Tier[];
}

const TEXT   = "#1a1a1a";
const MUTED  = "#6d7175";
const BORDER = "#e3e3e3";

function money(amount: number, currency: string): string {
  try {
    // A fixed locale: the page renders on the server first, and a locale that
    // differed between server and browser would make React re-render the text.
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function Thumb({ item, size, round = false, ring }: { item: PreviewItem; size: number; round?: boolean; ring?: string }) {
  const base: CSSProperties = {
    width: size, height: size, flexShrink: 0,
    borderRadius: round ? "50%" : Math.round(size / 7),
    background: "#f1f1f1", objectFit: "cover",
    border: ring ? `2px solid ${ring}` : `1px solid ${BORDER}`,
    boxSizing: "border-box",
  };
  if (item.imageUrl) return <img src={item.imageUrl} alt="" style={base} />;
  return (
    <div style={{ ...base, display: "flex", alignItems: "center", justifyContent: "center", color: MUTED, fontSize: Math.round(size / 2.6), fontWeight: 600 }}>
      {item.title.charAt(0).toUpperCase()}
    </div>
  );
}

/** A look-alike of the storefront's size/colour dropdown. */
function FakeSelect({ label }: { label?: string | null }) {
  return (
    <div style={{
      marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6,
      border: `1px solid ${BORDER}`, borderRadius: 6, padding: "2px 8px",
      fontSize: 11, color: TEXT, background: "#fff", maxWidth: "100%",
    }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label || "Choose option"}</span>
      <span style={{ color: MUTED }}>▾</span>
    </div>
  );
}

/**
 * A ticked checkbox, like the storefront's per-item tick (shoppers can untick
 * items they don't want). Always shown ticked: the preview is the starting state.
 */
function Tick({ accent, overlay = false }: { accent: string; overlay?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 16, height: 16, borderRadius: 4, background: accent, color: "#fff", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700,
        ...(overlay ? { position: "absolute", top: 5, left: 5, boxShadow: "0 0 0 2px #fff" } : {}),
      }}
    >✓</span>
  );
}

function Button({ accent, children, small = false }: { accent: string; children: string; small?: boolean }) {
  return (
    <div style={{
      background: accent, color: "#fff", fontWeight: 600, textAlign: "center",
      borderRadius: 8, fontSize: small ? 12 : 13, padding: small ? "7px 12px" : "10px 14px",
      whiteSpace: "nowrap",
    }}>
      {children}
    </div>
  );
}

/**
 * A box as a shopper might fill it: exactly `min` units spread over the pool
 * in turn (3 over four products → 1, 1, 1, 0).
 */
function boxExample(items: PreviewItem[], min: number): PreviewItem[] {
  const n = items.length;
  return items.map((item, idx) => ({
    ...item,
    quantity: n ? Math.floor(min / n) + (idx < min % n ? 1 : 0) : 0,
  }));
}

/** The tier ladder, the reached tier highlighted, and what the next one saves. */
function Ladder({ tiers, units, accent, verb }: { tiers: Tier[]; units: number; accent: string; verb: string }) {
  let reached: Tier | null = null;
  for (const t of tiers) if (units >= t.minItems) reached = t;
  const next = nextTier(tiers, units);
  return (
    <div style={{ margin: "0 0 10px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {tiers.map((t) => {
          const on = t === reached;
          return (
            <span key={t.minItems} style={{
              fontSize: 11, padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap",
              border: `1px solid ${on ? accent : BORDER}`, background: on ? accent : "#fff",
              color: on ? "#fff" : MUTED, fontWeight: on ? 700 : 400,
            }}>
              {t.minItems}+ · {t.percent}% off
            </span>
          );
        })}
      </div>
      {next && (
        <div style={{ fontSize: 12, fontWeight: 600, color: accent, marginTop: 6 }}>
          {verb} {next.minItems - units} more item{next.minItems - units === 1 ? "" : "s"} to save {next.percent}%
        </div>
      )}
    </div>
  );
}

function Stepper({ quantity, accent }: { quantity: number; accent: string }) {
  const step: CSSProperties = {
    width: 24, height: 24, borderRadius: "50%", border: `1px solid ${accent}`, color: accent, background: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14, lineHeight: 1,
  };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
      <span style={{ ...step, opacity: quantity ? 1 : 0.35 }}>−</span>
      <span style={{ fontWeight: 700, fontSize: 13 }}>{quantity}</span>
      <span style={step}>+</span>
    </div>
  );
}

export function BundlePreview(props: BundlePreviewProps) {
  const {
    design, name, discountPercent, items, frequency, prepaid, currency,
    accent = "#5B4FCB", buttonLabel = "Add bundle to cart",
    kind = "SET", pricingMode = "PERCENT", fixedPrice = null, minItems = 0, tiers = [], locked = false,
  } = props;

  const box        = kind === "BOX";
  const min        = Math.max(1, minItems);
  const tiered     = pricingMode === "TIERED" && tiers.length > 0;
  const shown      = box ? boxExample(items, min) : items;
  const units      = shown.reduce((s, i) => s + i.quantity, 0);
  const percent    = tiered ? tierPercent(tiers, units) : discountPercent || 0;
  // Exact for one-time sets and bundles sold as one product; older recurring
  // bundles (one line per item) use the matching percentage.
  const fixed      = pricingMode === "FIXED_PRICE" && !box && (!frequency || locked) && fixedPrice ? fixedPrice : null;

  const known      = shown.every((i) => i.price !== null);
  const total      = shown.reduce((s, i) => s + (i.price ?? 0) * i.quantity, 0);
  const discounted = fixed != null ? Math.min(total, fixed) : total * (1 - percent / 100);
  const saving     = total - discounted;
  const was        = known && discounted < total ? money(total, currency) : null;
  const now        = known ? money(discounted, currency) : fixed != null ? money(fixed, currency) : "—";
  // A fixed price's matching percentage is rounded; a chosen % is shown as set.
  const badge      = tiered
    ? `Save up to ${tiers[tiers.length - 1].percent}%`
    : discountPercent > 0 ? `Save ${pricingMode === "FIXED_PRICE" ? Math.round(discountPercent) : discountPercent}%` : null;
  const meta       = frequency
    ? `${frequency} · renews together${prepaid ? " · pay by email link before each delivery" : ""}`
    : null;
  const title      = name || "Your bundle";
  const ladder     = tiered ? <Ladder tiers={tiers} units={units} accent={accent} verb={box ? "Pick" : "Add"} /> : null;

  // ── Build-your-own box ──────────────────────────────────────
  if (box) {
    return (
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", background: "#fff", color: TEXT }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{title}</span>
          {badge && (
            <span style={{ fontSize: 12, fontWeight: 600, color: "#fff", background: accent, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap" }}>
              {badge}
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          {units} item{units === 1 ? "" : "s"} picked ✓ <span style={{ color: MUTED, fontWeight: 400 }}>· pick at least {min}</span>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: "#eee", overflow: "hidden", marginBottom: 12 }}>
          <div style={{ height: "100%", width: "100%", background: accent }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, marginBottom: 12 }}>
          {shown.map((item) => (
            <div key={item.key} style={{
              border: `1px solid ${item.quantity ? accent : BORDER}`, borderRadius: 10, padding: 8, fontSize: 11, lineHeight: 1.3,
              boxShadow: item.quantity ? `0 0 0 1px ${accent}` : "none",
            }}>
              <div style={{ display: "flex", justifyContent: "center" }}><Thumb item={item} size={64} /></div>
              <div style={{ marginTop: 6, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{item.title}</div>
              {item.price !== null && <div style={{ color: MUTED, marginTop: 2 }}>{money(item.price, currency)}</div>}
              {item.variantChoice && <FakeSelect label={item.variantLabel} />}
              <Stepper quantity={item.quantity} accent={accent} />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, fontSize: 15, flexWrap: "wrap" }}>
          {was && <span style={{ textDecoration: "line-through", color: MUTED, fontSize: 13 }}>{was}</span>}
          <span style={{ fontWeight: 700 }}>{now}</span>
          {known && saving > 0 && <span style={{ fontSize: 12, color: accent, fontWeight: 600 }}>You save {money(saving, currency)}</span>}
        </div>
        {ladder}
        {meta && <div style={{ fontSize: 13, color: MUTED, margin: "0 0 10px" }}>{meta}</div>}
        <Button accent={accent}>{`Add ${units} item${units === 1 ? "" : "s"} to cart`}</Button>
      </div>
    );
  }

  // ── Bought together ─────────────────────────────────────────
  if (design === "together") {
    return (
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, background: "#fff", color: TEXT }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12 }}>{title}</div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 8 }}>
          {shown.map((item, idx) => (
            <div key={item.key} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              {idx > 0 && (
                <div style={{
                  width: 22, height: 22, borderRadius: "50%", background: "#f1f1f1", color: MUTED,
                  display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, marginTop: 28, flexShrink: 0,
                }}>+</div>
              )}
              <div style={{ width: 88 }}>
                <div style={{ position: "relative", width: 80 }}>
                  <Thumb item={item} size={80} />
                  {!locked && <Tick accent={accent} overlay />}
                </div>
                <div style={{ fontSize: 11, marginTop: 6, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {item.quantity > 1 ? `${item.quantity} × ` : ""}{item.title}
                </div>
                {item.price !== null && <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{money(item.price, currency)}</div>}
                {item.variantChoice && <FakeSelect label={item.variantLabel} />}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: MUTED }}>Total price:</span>
          {was && <span style={{ fontSize: 13, color: MUTED, textDecoration: "line-through" }}>{was}</span>}
          <span style={{ fontSize: 17, fontWeight: 700 }}>{now}</span>
          {known && saving > 0 && <span style={{ fontSize: 12, color: accent, fontWeight: 600 }}>You save {money(saving, currency)}</span>}
        </div>
        {ladder && <div style={{ marginTop: 8 }}>{ladder}</div>}
        {meta && <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{meta}</div>}
        <div style={{ marginTop: 12 }}>
          <Button accent={accent}>{shown.length ? `Add all ${shown.length} to cart` : "Add all to cart"}</Button>
        </div>
      </div>
    );
  }

  // ── Compact bar ─────────────────────────────────────────────
  if (design === "compact") {
    const thumbs = shown.slice(0, 4);
    const extra  = shown.length - thumbs.length;
    return (
      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 999, padding: "8px 8px 8px 12px", background: "#fff", color: TEXT }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", flexShrink: 0 }}>
            {thumbs.map((item, idx) => (
              <div key={item.key} style={{ marginLeft: idx ? -10 : 0 }}><Thumb item={item} size={34} round ring="#fff" /></div>
            ))}
            {extra > 0 && (
              <div style={{
                marginLeft: -10, width: 34, height: 34, borderRadius: "50%", background: "#f1f1f1", border: "2px solid #fff",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: MUTED,
              }}>+{extra}</div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
            <div style={{ fontSize: 11, color: MUTED }}>
              {units} item{units === 1 ? "" : "s"}{badge ? ` · ${badge}` : ""}{frequency ? ` · ${frequency}` : ""}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            {was && <div style={{ fontSize: 10, color: MUTED, textDecoration: "line-through" }}>{was}</div>}
            <div style={{ fontSize: 14, fontWeight: 700 }}>{now}</div>
          </div>
          <Button accent={accent} small>Add</Button>
        </div>
        {ladder && <div style={{ margin: "6px 0 0 4px" }}>{ladder}</div>}
        {/* Ticks (and size/colour choices) live in here on the storefront. */}
        <div style={{ fontSize: 11, color: accent, margin: "4px 0 0 4px", fontWeight: 600 }}>{locked ? "What's included ▾" : "Customize bundle ▾"}</div>
      </div>
    );
  }

  // ── Savings card ────────────────────────────────────────────
  if (design === "savings") {
    return (
      <div style={{ border: `2px solid ${accent}`, borderRadius: 14, overflow: "hidden", background: "#fff", color: TEXT }}>
        <div style={{ background: accent, color: "#fff", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{title}</span>
          {badge && (
            <span style={{ background: "rgba(255,255,255,.22)", borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
              {known && saving > 0 ? `SAVE ${money(saving, currency)}` : badge.toUpperCase()}
            </span>
          )}
        </div>
        <div style={{ padding: "12px 16px 16px" }}>
          {shown.map((item) => (
            <div key={item.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
              <span style={{
                width: 18, height: 18, borderRadius: "50%", background: accent, color: "#fff", fontSize: 11,
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}>✓</span>
              <Thumb item={item} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{item.quantity > 1 ? `${item.quantity} × ` : ""}{item.title}</div>
                {item.variantChoice ? <FakeSelect label={item.variantLabel} /> : item.variantLabel
                  ? <div style={{ fontSize: 11, color: MUTED }}>{item.variantLabel}</div> : null}
              </div>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "10px 0 4px" }}>
            <span style={{ fontSize: 24, fontWeight: 800 }}>{now}</span>
            {was && <span style={{ fontSize: 14, color: MUTED, textDecoration: "line-through" }}>{was}</span>}
          </div>
          {ladder}
          {meta && <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>{meta}</div>}
          <Button accent={accent}>{buttonLabel}</Button>
        </div>
      </div>
    );
  }

  // ── Classic list (default) ──────────────────────────────────
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", background: "#fff", color: TEXT }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{title}</span>
        {badge && (
          <span style={{ fontSize: 12, fontWeight: 600, color: "#fff", background: accent, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap" }}>
            {badge}
          </span>
        )}
      </div>
      {shown.map((item) => (
        <div key={item.key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, marginBottom: 8 }}>
          {!locked && <Tick accent={accent} />}
          <Thumb item={item} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>{item.title}</div>
            {item.variantChoice ? <FakeSelect label={item.variantLabel} /> : item.variantLabel
              ? <div style={{ fontSize: 12, color: MUTED }}>{item.variantLabel}</div> : null}
          </div>
          {item.quantity > 1 && <span style={{ color: MUTED }}>× {item.quantity}</span>}
        </div>
      ))}
      {meta && <div style={{ fontSize: 13, color: MUTED, margin: "2px 0 10px" }}>{meta}</div>}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, fontSize: 15 }}>
        {was && <span style={{ textDecoration: "line-through", color: MUTED, fontSize: 13 }}>{was}</span>}
        <span style={{ fontWeight: 700 }}>{now}</span>
      </div>
      {ladder}
      <Button accent={accent}>{buttonLabel}</Button>
    </div>
  );
}

/**
 * A scaled-down preview for the theme picker cards. Rendered at full size and
 * shrunk, so it is pixel-for-pixel the real layout.
 */
export function MiniBundlePreview(props: BundlePreviewProps & { height?: number }) {
  const { height = 150, ...rest } = props;
  const scale = 0.58;
  return (
    <div style={{ height, overflow: "hidden", pointerEvents: "none", position: "relative" }}>
      <div style={{ width: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <BundlePreview {...rest} />
      </div>
    </div>
  );
}
