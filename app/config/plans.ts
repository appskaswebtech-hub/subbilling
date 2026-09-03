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
  commissionRate?:    number;  // 0.02 = 2% of each successful subscription charge
  usageCappedAmount?: number;  // monthly ceiling, in USD
  usageTerms?:        string;  // shown verbatim on the merchant approval screen
}

export const PLANS: Record<string, Plan> = {
  free: {
    key:       "free",
    label:     "Free",
    price:     0,
    trialDays: 0,
    color:     "#F1F8F5",
    popular:   false,

    commissionRate:    0.02,
    // At 2% this stops earning above $2,500/mo of subscription revenue. Raising
    // it later does NOT affect merchants already approved at the old value —
    // Shopify locks the cap into the approved AppSubscription, so they keep the
    // cap they agreed to until they re-approve a new one.
    usageCappedAmount: 50,
    usageTerms:        "2% commission on each successful subscription charge",

    features: [
      "No monthly fee — 2% per subscription charge",
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
    features: [
      "Unlimited Everything",
      "Unlimited Subscription Products",
      "API & Webhook Access",
      "Weekly, Monthly and Yearly Billing",
    ],
  },
};

export const PLAN_KEYS = Object.keys(PLANS);

// Order the billing page and compare table render in: cheapest first.
export const PLAN_ORDER = ["free", "basic", "pro", "advanced"];

// Rounds to cents. Shopify rejects a usage price with more than 2 decimals,
// and float multiplication routinely produces them (0.02 * 49.99 = 0.9998).
export function calcCommission(base: number, rate: number): number {
  return Math.round(base * rate * 100) / 100;
}
