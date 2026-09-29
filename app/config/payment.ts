// app/config/payment.ts
//
// Payment-mode and email-sender vocabulary shared by the server and the admin
// UI. Deliberately not a .server file: the plan and bundle editors render these
// options in the browser.

export type PaymentMode = "POSTPAID" | "PREPAID";
export type EmailSender = "SHOPIFY" | "SMTP";

export const PAYMENT_MODE_OPTIONS: Array<{ label: string; value: PaymentMode }> = [
  { label: "Postpaid: card charged automatically each cycle", value: "POSTPAID" },
  { label: "Prepaid: customer pays by emailed link before each cycle", value: "PREPAID" },
];

export const EMAIL_SENDER_OPTIONS: Array<{ label: string; value: EmailSender }> = [
  { label: "Shopify invoice email", value: "SHOPIFY" },
  { label: "My own email server (SMTP)", value: "SMTP" },
];

export function parsePaymentMode(raw: unknown): PaymentMode {
  return raw === "PREPAID" ? "PREPAID" : "POSTPAID";
}

export function parseEmailSender(raw: unknown): EmailSender {
  return raw === "SMTP" ? "SMTP" : "SHOPIFY";
}

/** Shown to shoppers on prepaid plans (selling plan description, bundle block). */
export const PREPAID_SHOPPER_NOTE =
  "You'll get an email with a link to pay before each delivery.";

// ─── Payment email text ──────────────────────────────────────────────────────
// Merchants can reword the three prepaid emails in Settings → Prepaid & email.
// Whatever they leave blank falls back to these. The amount, the "pay by" line
// and the button are always added by the app, so the text never has to carry
// the link itself.

export type PrepaidEmailKind = "initial" | "renewal" | "reminder";

export const PREPAID_EMAIL_DEFAULTS: Record<PrepaidEmailKind, { subject: string; message: string }> = {
  initial: {
    subject: "Confirm and pay to start your {subscription} subscription",
    message:
      "{shop} has set up a prepaid subscription for you: {subscription}. Pay using the link below to confirm it. " +
      "Before each later delivery you'll get an email like this one to confirm and pay.",
  },
  renewal: {
    subject: "Confirm and pay for your next {subscription} delivery",
    message:
      "Your prepaid subscription ({subscription}) renews on {date}. Nothing is charged automatically. " +
      "Pay using the link below to confirm this delivery.",
  },
  reminder: {
    subject: "Reminder: your subscription payment is still open",
    message:
      "Just a reminder: your {subscription} payment is still open. The link below works until {due_date}. " +
      "If it isn't paid by then, the delivery won't go ahead.",
  },
};

/** Listed under the fields in Settings. */
export const PREPAID_EMAIL_PLACEHOLDERS: Array<{ token: string; meaning: string }> = [
  { token: "{shop}",         meaning: "your store name" },
  { token: "{subscription}", meaning: "the plan, bundle or product name" },
  { token: "{date}",         meaning: "the delivery (billing) date" },
  { token: "{due_date}",     meaning: "the date the link must be paid by" },
  { token: "{amount}",       meaning: "the amount to pay" },
];

export const PREPAID_SUBJECT_MAX = 150;
export const PREPAID_MESSAGE_MAX = 1000;

export interface PrepaidEmailValues {
  shop:         string;
  subscription: string;
  date:         string;
  due_date:     string;
  amount:       string;
}

/**
 * Replaces the known placeholders. Anything else in braces is left as typed,
 * so a stray "{" in the merchant's text can't break or blank the email.
 */
export function fillTemplate(text: string, values: PrepaidEmailValues): string {
  return text.replace(/\{(shop|subscription|date|due_date|amount)\}/g, (_, key: keyof PrepaidEmailValues) => values[key]);
}

/** The AppSettings columns that hold the merchant's wording. */
export interface PrepaidEmailSettings {
  prepaidInitialSubject?:  string | null;
  prepaidInitialMessage?:  string | null;
  prepaidRenewalSubject?:  string | null;
  prepaidRenewalMessage?:  string | null;
  prepaidReminderSubject?: string | null;
  prepaidReminderMessage?: string | null;
}

/** Subject and message for one email: the merchant's text, else the default, filled in. */
export function prepaidEmailText(
  settings: PrepaidEmailSettings | null | undefined,
  kind: PrepaidEmailKind,
  values: PrepaidEmailValues,
): { subject: string; message: string } {
  const custom =
    kind === "initial" ? { subject: settings?.prepaidInitialSubject,  message: settings?.prepaidInitialMessage }
    : kind === "renewal" ? { subject: settings?.prepaidRenewalSubject, message: settings?.prepaidRenewalMessage }
    : { subject: settings?.prepaidReminderSubject, message: settings?.prepaidReminderMessage };

  return {
    subject: fillTemplate(custom.subject?.trim() || PREPAID_EMAIL_DEFAULTS[kind].subject, values),
    message: fillTemplate(custom.message?.trim() || PREPAID_EMAIL_DEFAULTS[kind].message, values),
  };
}
