// app/config/currency.ts
//
// Support for billing merchants in their own currency.
//
// Shopify tells us what currency a shop pays for apps in
// (`shopBillingPreferences.currency`), and recommends matching app charges to
// it. The Free plan's app subscription is therefore created in that currency,
// and commission is 2% of an order already denominated in it — so the money
// path involves NO conversion at all for the overwhelmingly common case where
// a shop sells and pays in the same currency.
//
// The rates below exist for two narrow jobs, never for the primary charge:
//
//   1. Turning the canonical $50 monthly cap into a sensible local figure for
//      the approval screen.
//   2. The rare shop that sells in one currency and pays Shopify in another.
//
// Because job 1 only sets a ceiling and job 2 is uncommon, rate drift cannot
// produce the kind of error this module was written to prevent — billing 2% of
// ₹5,000 as $100. A stale rate moves a cap slightly; it does not mischarge by
// an exchange rate.

/**
 * Approximate units of each currency per 1 USD.
 *
 * Hand-maintained and deliberately approximate. Covers the currencies Shopify
 * bills apps in; anything absent falls back to USD (see `resolveBillingCurrency`),
 * which is always accepted.
 */
export const USD_RATES: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  CAD: 1.36,
  AUD: 1.52,
  NZD: 1.64,
  JPY: 150,
  CNY: 7.2,
  HKD: 7.8,
  SGD: 1.34,
  INR: 83.2,
  IDR: 15800,
  MYR: 4.7,
  PHP: 56,
  THB: 35.5,
  TWD: 32,
  KRW: 1340,
  VND: 25000,
  CHF: 0.88,
  SEK: 10.5,
  NOK: 10.7,
  DKK: 6.9,
  PLN: 4.0,
  CZK: 23,
  HUF: 360,
  RON: 4.6,
  TRY: 32,
  ILS: 3.7,
  AED: 3.67,
  SAR: 3.75,
  ZAR: 18.5,
  NGN: 1500,
  EGP: 48,
  KES: 130,
  BRL: 5.1,
  MXN: 17,
  ARS: 950,
  CLP: 950,
  COP: 3900,
  PEN: 3.75,
};

/** Currencies with no minor unit — a cap or charge of "4.50" is invalid. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "IDR", "CLP", "HUF"]);

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has(currency.toUpperCase());
}

/**
 * The currency the app subscription will actually be created in.
 *
 * Falls back to USD for anything absent from `USD_RATES` — Shopify accepts USD
 * from every shop, so an unrecognised currency degrades to a working charge
 * rather than a failed approval.
 */
export function resolveBillingCurrency(shopBillingCurrency: string | null | undefined): string {
  const c = (shopBillingCurrency ?? "").toUpperCase();
  return c && USD_RATES[c] ? c : "USD";
}

/**
 * Rounds to a figure that reads like a price rather than a conversion, while
 * staying close to the value asked for.
 *
 * Snaps to the nearest half-magnitude step — 5s below 100, 50s below 1,000,
 * 500s below 10,000 — which keeps the result within ~6% of the input. Coarser
 * schemes (snapping to 1/2/5/10 × magnitude) drift badly: £39.50 became £50
 * and A$76 became A$100, misrepresenting the ceiling the merchant approves.
 */
function niceRound(value: number): number {
  if (value <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const step      = magnitude / 2;
  return Math.round(value / step) * step;
}

/**
 * The monthly usage cap, expressed in `currency`.
 *
 * `usdCap` is the canonical figure from PLANS. The result is deliberately a
 * round number: it is shown verbatim on the merchant's approval screen, where
 * "up to ₹4,000.00 per month" reads as a considered price and "up to
 * ₹4,160.00" reads as a machine translation.
 */
export function localizedCap(usdCap: number, currency: string): number {
  const code = currency.toUpperCase();
  const rate = USD_RATES[code];
  if (!rate || code === "USD") return usdCap;

  const rounded = niceRound(usdCap * rate);
  return isZeroDecimal(code) ? Math.round(rounded) : rounded;
}

/**
 * Hand-set local prices, keyed by currency then plan.
 *
 * These are PRICING DECISIONS, not conversions — a merchant in India should see
 * ₹799, not ₹831.17. Review them before launch; they are chosen to sit near the
 * USD price at the rates above while reading as a deliberate local price.
 *
 * Any currency absent here is derived from the USD price via `USD_RATES` and
 * rounded by `nicePrice`, so every market gets something sensible without
 * needing an entry.
 */
export const PRICE_OVERRIDES: Record<string, Record<string, number>> = {
  EUR: { basic:   9.99, pro:   14.99, advanced:   19.99 },
  GBP: { basic:   8.99, pro:   12.99, advanced:   17.99 },
  CAD: { basic:  13.99, pro:   19.99, advanced:   26.99 },
  AUD: { basic:  14.99, pro:   22.99, advanced:   29.99 },
  NZD: { basic:  16.99, pro:   24.99, advanced:   32.99 },
  INR: { basic: 799,    pro: 1199,    advanced: 1599    },
  JPY: { basic: 1500,   pro: 2200,    advanced: 2900    },
  SGD: { basic:  13.99, pro:   19.99, advanced:   26.99 },
  ZAR: { basic: 179,    pro:  279,    advanced:  369    },
  BRL: { basic:  49.90, pro:   74.90, advanced:   99.90 },
  MXN: { basic: 169,    pro:  249,    advanced:  339    },
  AED: { basic:  36.99, pro:   54.99, advanced:   72.99 },
};

/** Rounds a converted price to something that reads like a price tag. */
function nicePrice(value: number, currency: string): number {
  if (value <= 0) return 0;

  if (isZeroDecimal(currency)) return niceRound(value);

  // Charm pricing below 100 (13.58 → 13.99); round figures above it, where a
  // trailing .99 stops reading as deliberate.
  if (value < 100) return Math.max(0.99, Math.round(value) - 0.01);
  return niceRound(value) - 1;
}

/**
 * The price of `planKey` in `currency`.
 *
 * Prefers a hand-set override, falls back to a rounded conversion. Returns the
 * USD price unchanged when the currency is USD or has no rate.
 */
export function localizedPrice(usdPrice: number, currency: string, planKey: string): number {
  if (usdPrice <= 0) return 0;

  const code = currency.toUpperCase();
  if (code === "USD") return usdPrice;

  const override = PRICE_OVERRIDES[code]?.[planKey];
  if (override !== undefined) return override;

  const rate = USD_RATES[code];
  if (!rate) return usdPrice;

  return nicePrice(usdPrice * rate, code);
}

/**
 * Converts between two currencies via USD, for the uncommon shop that sells in
 * one currency and pays Shopify in another.
 *
 * Returns null when either side has no rate, so callers can decline to charge
 * rather than guess — never assume parity.
 */
export function convert(amount: number, from: string, to: string): number | null {
  const f = USD_RATES[from.toUpperCase()];
  const t = USD_RATES[to.toUpperCase()];
  if (!f || !t) return null;

  const converted = (amount / f) * t;
  return isZeroDecimal(to) ? Math.round(converted) : Math.round(converted * 100) / 100;
}

/** Formats money for display without assuming a dollar sign. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: isZeroDecimal(currency) ? 0 : 2,
      maximumFractionDigits: isZeroDecimal(currency) ? 0 : 2,
    }).format(amount);
  } catch {
    // Intl rejects codes it does not know; the amount still has to render.
    return `${currency} ${amount.toFixed(isZeroDecimal(currency) ? 0 : 2)}`;
  }
}
