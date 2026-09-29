// app/lib/payment-email.server.ts
//
// Delivers a prepaid "confirm and pay" request. Each prepaid plan (and
// recurring bundle) picks how:
//
//   SHOPIFY  draftOrderInvoiceSend: Shopify emails its own invoice, with the
//            draft order's checkout link, from the shop's sender address.
//   SMTP     the merchant's own mail server (Settings → Your email server)
//            sends an app-written email carrying the same checkout link.
//
// Either way the link is the draft order's invoiceUrl, so paying works the same.
//
// If SMTP is chosen but not set up, or the server refuses the message, we fall
// back to the Shopify invoice and report it. A customer who is never asked to
// pay is a subscription that silently lapses, which is worse than an email in
// the "wrong" style.

import nodemailer from "nodemailer";
import db from "../db.server";
import { decryptSecret } from "./secret-box.server";
import type { AdminGraphQL } from "./subscription-contract.server";
import { prepaidEmailText, type EmailSender, type PrepaidEmailValues } from "../config/payment";

const INVOICE_SEND = `#graphql
  mutation PrepaidInvoiceSend($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder { id invoiceSentAt }
      userErrors { field message }
    }
  }
`;

export interface SmtpConfig {
  host:   string;
  port:   number;
  secure: boolean;
  user:   string;
  pass:   string;
  from:   string;
  replyTo: string | null;
}

/**
 * The shop's SMTP settings, or null when they are incomplete or the password
 * can no longer be decrypted (e.g. APP_ENCRYPTION_KEY changed).
 *
 * Host and From are required. User and password are optional, since some
 * relays authenticate by IP.
 */
export async function getSmtpConfig(shop: string): Promise<SmtpConfig | null> {
  const s = await db.appSettings.findUnique({ where: { shop } });
  if (!s || !s.smtpHost.trim() || !s.smtpFrom.trim()) return null;

  let pass = "";
  if (s.smtpPassEnc) {
    try {
      pass = decryptSecret(s.smtpPassEnc);
    } catch (err) {
      console.error(`[email] ${shop}: stored SMTP password cannot be decrypted:`, err);
      return null;
    }
  }

  return {
    host:    s.smtpHost.trim(),
    port:    s.smtpPort || 587,
    secure:  s.smtpSecure,
    user:    s.smtpUser.trim(),
    pass,
    from:    s.smtpFrom.trim(),
    replyTo: s.notificationEmail.trim() || null,
  };
}

export async function sendSmtpMail(
  config: SmtpConfig,
  mail: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  const transport = nodemailer.createTransport({
    host:   config.host,
    port:   config.port,
    secure: config.secure,
    auth:   config.user ? { user: config.user, pass: config.pass } : undefined,
    // Fail fast: this runs inside a cron request and a webhook, neither of
    // which should hang on an unreachable server.
    connectionTimeout: 10_000,
    greetingTimeout:   10_000,
    socketTimeout:     20_000,
  });

  await transport.sendMail({
    from:    config.from,
    to:      mail.to,
    replyTo: config.replyTo ?? undefined,
    subject: mail.subject,
    text:    mail.text,
    html:    mail.html,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PaymentEmailContent {
  shopName:    string;
  subject:     string;
  /** One or two sentences, plain text. Shown in both email styles. */
  message:     string;
  /** Pre-formatted total, e.g. "₹1,250.00". */
  amountLabel: string;
  /** e.g. "Due by 2 October 2026". */
  dueLabel:    string;
  invoiceUrl:  string;
}

export function renderPaymentEmail(c: PaymentEmailContent): { html: string; text: string } {
  const text = [
    c.message,
    "",
    `Amount: ${c.amountLabel}`,
    c.dueLabel,
    "",
    `Confirm and pay: ${c.invoiceUrl}`,
    "",
    c.shopName,
  ].join("\n");

  // Inline styles and a table layout only: most mail clients ignore <style>.
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#202223">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
    <tr><td style="font-size:18px;font-weight:600;padding-bottom:12px">${escapeHtml(c.shopName)}</td></tr>
    <tr><td style="font-size:14px;line-height:1.55;padding-bottom:16px">${escapeHtml(c.message)}</td></tr>
    <tr><td style="font-size:14px;padding-bottom:4px"><strong>Amount:</strong> ${escapeHtml(c.amountLabel)}</td></tr>
    <tr><td style="font-size:13px;color:#6d7175;padding-bottom:20px">${escapeHtml(c.dueLabel)}</td></tr>
    <tr><td>
      <a href="${escapeHtml(c.invoiceUrl)}" style="display:inline-block;background:#5B4FCB;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px">Confirm and pay</a>
    </td></tr>
    <tr><td style="font-size:12px;color:#8c9196;padding-top:20px;line-height:1.5">
      If the button doesn't work, copy this link into your browser:<br>${escapeHtml(c.invoiceUrl)}
    </td></tr>
  </table>
</body></html>`;

  return { html, text };
}

export interface SendResult {
  /** What actually delivered the email. */
  sentWith: EmailSender;
  /** Set when SMTP was chosen but Shopify had to deliver instead. */
  fallbackReason: string | null;
}

async function sendViaShopify(
  graphql: AdminGraphQL,
  draftOrderId: string,
  to: string,
  subject: string,
  message: string,
): Promise<void> {
  const res  = await graphql(INVOICE_SEND, {
    variables: { id: draftOrderId, email: { to, subject, customMessage: message } },
  });
  const json = await res.json() as {
    errors?: Array<{ message: string }>;
    data?: { draftOrderInvoiceSend?: { userErrors?: Array<{ message: string }> } };
  };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(" | "));
  const userErrors = json.data?.draftOrderInvoiceSend?.userErrors ?? [];
  if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join(" | "));
}

/**
 * Sends one payment request. Throws only if no channel could deliver it.
 */
export async function sendPaymentRequest(args: {
  graphql:      AdminGraphQL;
  shop:         string;
  sender:       EmailSender;
  draftOrderId: string;
  to:           string;
  content:      PaymentEmailContent;
}): Promise<SendResult> {
  const { graphql, shop, sender, draftOrderId, to, content } = args;

  if (!to) throw new Error("The customer has no email address to send the payment link to.");

  let fallbackReason: string | null = null;

  if (sender === "SMTP") {
    const config = await getSmtpConfig(shop);
    if (!config) {
      fallbackReason = "SMTP is not set up in Settings";
    } else {
      try {
        const { html, text } = renderPaymentEmail(content);
        await sendSmtpMail(config, { to, subject: content.subject, html, text });
        return { sentWith: "SMTP", fallbackReason: null };
      } catch (err) {
        fallbackReason = `SMTP failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    console.warn(`[email] ${shop}: ${fallbackReason} — sending the Shopify invoice instead`);
  }

  await sendViaShopify(graphql, draftOrderId, to, content.subject, content.message);
  return { sentWith: "SHOPIFY", fallbackReason };
}

/**
 * For the Settings page's "Send test email" button. Proves the SMTP settings
 * work AND previews the merchant's wording: it sends a sample of the
 * "before each delivery" email, filled with example values, exactly as a
 * customer would receive it through SMTP.
 */
export async function sendSmtpTestEmail(shop: string, to: string, shopName: string): Promise<void> {
  const config = await getSmtpConfig(shop);
  if (!config) throw new Error("Fill in at least the SMTP host and From address, then save.");

  const settings = await db.appSettings.findUnique({ where: { shop } });
  const day      = 24 * 60 * 60 * 1000;
  const fmt      = (d: Date) => new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(d);
  const values: PrepaidEmailValues = {
    shop:         shopName,
    subscription: "Sample subscription",
    date:         fmt(new Date(Date.now() + 3 * day)),
    due_date:     fmt(new Date(Date.now() + 10 * day)),
    amount:       "$25.00",
  };
  const text = prepaidEmailText(settings, "renewal", values);

  const { html, text: plain } = renderPaymentEmail({
    shopName,
    subject:     text.subject,
    message:     text.message,
    amountLabel: values.amount,
    dueLabel:    `Please pay by ${values.due_date}.`,
    // A sample has no real payment link; the storefront keeps the button harmless.
    invoiceUrl:  `https://${shop}`,
  });

  await sendSmtpMail(config, { to, subject: `[Test] ${text.subject}`, html, text: plain });
}
