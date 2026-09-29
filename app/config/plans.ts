// app/config/plans.ts

export interface Plan {
  key:       string;
  label:     string;
  price:     number;
  trialDays: number;
  features:  string[];
  color:     string;
  popular:   boolean;

  // ── Usage (commission) pricing ────────────────────────────────
  // Only set on plans monetized per-transaction instead of (or on top of) a
  // flat monthly fee. When commissionRate is set, appSubscriptionCreate sends
  // an extra appUsagePricingDetails line item and every successful subscription
  // charge bills the merchant via appUsageRecordCreate.
  //
  // Shopify makes cappedAmount a REQUIRED field on usage pricing — there is no
  // uncapped mode. The merchant approves the cap once; past it, no further
  // usage can be recorded until they approve a higher one.
  commissionRate?:    number;  // 0.005 = 0.5% of each successful subscription charge
  usageCappedAmount?: number;  // monthly ceiling, in USD
  usageTerms?:        string;  // shown verbatim on the merchant approval screen

  // Which support queue the tier buys. Declared explicitly rather than parsed
  // out of `features` — that copy is marketing text and is free to be reworded.
  supportTier: "email" | "priority";
}

export const PLANS: Record<string, Plan> = {
  free: {
    key:       "free",
    label:     "Free",
    price:     0,
    trialDays: 0,
    color:     "#F1F8F5",
    popular:   false,

    commissionRate:    0.005,
    // Meant to be effectively unlimited, but Shopify has no uncapped mode — the
    // cap is required. At 0.5% this binds only above $200,000/month of
    // subscription revenue. It is also shown verbatim on the approval screen
    // ("up to $1,000.00 per month"), which is why it isn't set higher still.
    //
    // Changing this does NOT reach merchants already approved: Shopify locks the
    // cap into their approved AppSubscription, so they keep the one they agreed
    // to until they re-approve. The RATE is different — it is applied by
    // app-commission.server.ts at charge time, so a change applies at once.
    usageCappedAmount: 1000,
    usageTerms:        "0.5% commission on each successful subscription charge",

    supportTier: "email",
    features: [
      "No monthly fee — 0.5% per subscription charge",
      "Up to 5 Subscription Plans",
      "Up to 50 Subscription Products",
      "Weekly, Monthly and Yearly Billing",
      "Email Support",
    ],
  },
  basic: {
    key:       "basic",
    label:     "Basic",
    price:     9.99,
    trialDays: 7,
    color:     "#f6f6f7",
    popular:   false,
    supportTier: "email",
    features: [
      "Up to 5 Subscription Plans",
      "Weekly, Monthly and Yearly Billing",
      "Email Support",
      "Up to 50 Subscription Products",
    ],
  },
  pro: {
    key:       "pro",
    label:     "Pro",
    price:     14.99,
    trialDays: 7,
    color:     "#f0f4ff",
    popular:   true,
    supportTier: "priority",
    features: [
      "Up to 10 Subscription Plans",
      "Up to 500 Subscription Products",
      "Weekly, Monthly and Yearly Billing",
      "Priority Support",
    ],
  },
  advanced: {
    key:       "advanced",
    label:     "Advanced",
    price:     19.99,
    trialDays: 7,
    color:     "#f3f0ff",
    popular:   false,
    supportTier: "priority",
    features: [
      "Unlimited Everything",
      "Unlimited Subscription Products",
      "API & Webhook Access",
      "Weekly, Monthly and Yearly Billing",
    ],
  },
};

/**
 * The currency every app charge is created in.
 *
 * Every money number in this file — `price` and `usageCappedAmount` — is
 * denominated in it. Shopify does support billing merchants in their local
 * currency (query `shopBillingPreferences.currency`), but switching to that
 * needs a per-currency price table: sending 9.99 with currencyCode "INR" bills
 * ₹9.99, not the intended ~₹830. Until that table exists this stays USD, and
 * app-commission.server.ts refuses to bill an order denominated in anything
 * else rather than silently relabelling the number.
 */
export const APP_BILLING_CURRENCY = "USD";

export const PLAN_KEYS = Object.keys(PLANS);

// Order the billing page and compare table render in: cheapest first.
export const PLAN_ORDER = ["free", "basic", "pro", "advanced"];

// Rounds to cents. Shopify rejects a usage price with more than 2 decimals,
// and float multiplication routinely produces them (0.02 * 49.99 = 0.9998).
export function calcCommission(base: number, rate: number): number {
  return Math.round(base * rate * 100) / 100;
}

/**
 * A commission rate as merchants read it: 0.005 → "0.5%", 0.02 → "2%".
 *
 * Every place that shows the rate must go through this. `Math.round(rate * 100)`
 * — what the app used to do — turns 0.5% into "1%", because Math.round(0.5) is
 * 1. That wrong figure would then appear on the merchant's Shopify invoice via
 * the usage record description, beside a charge worked out at the true rate.
 */
export function formatRate(rate: number): string {
  // toFixed then Number strips float noise (0.005 * 100 = 0.5000000000000001)
  // and trailing zeros, so whole rates stay "2%" rather than "2.00%".
  return `${Number((rate * 100).toFixed(2))}%`;
}

/** The free plan's rate, formatted — for copy that names it in passing. */
export const FREE_RATE_LABEL = formatRate(PLANS.free.commissionRate ?? 0);
