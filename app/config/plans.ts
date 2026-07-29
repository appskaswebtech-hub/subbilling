// app/config/plans.ts

export interface Plan {
  key:       string;
  label:     string;
  price:     number;
  trialDays: number;
  features:  string[];
  color:     string;
  popular:   boolean;
}

export const PLANS: Record<string, Plan> = {
  basic: {
    key:       "basic",
    label:     "Basic",
    price:     9.99,
    trialDays: 0,
    color:     "#f6f6f7",
    popular:   false,
    features: [
      "Limited Subscription Plans",
      "Weekly, Monthly and Yearly Billing",
      "Email Support",
      "Up to 50 Subscription Products",
    ],
  },
  pro: {
    key:       "pro",
    label:     "Pro",
    price:     30,
    trialDays: 0,
    color:     "#f0f4ff",
    popular:   true,
    features: [
      "Unlimited Subscription Plans",
      "Up to 500 Subscription Products",
      "Weekly, Monthly and Yearly Billing",
      "Priority Support",
    ],
  },
  advanced: {
    key:       "advanced",
    label:     "Advanced",
    price:     40,
    trialDays: 0,
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
