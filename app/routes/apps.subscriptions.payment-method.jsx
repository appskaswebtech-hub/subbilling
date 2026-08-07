// app/routes/apps.subscriptions.payment-method.jsx
//
// Payment method management for a single subscription, called by the Customer
// Account UI extension.
//
//   GET  ?contractId=…            → the card this contract bills, plus the
//                                   customer's other usable saved cards
//   POST { intent: "switch",
//          contractId, paymentMethodId }
//                                 → point the contract at another saved card
//   POST { intent: "update-url",
//          contractId }           → a Shopify-hosted URL where the customer can
//                                   enter new card details
//
// Every request is authenticated from the customer-account session token and
// checked for ownership of the contract. No card data ever passes through this
// app — "update-url" hands the customer to Shopify's own page.

import { json } from "@remix-run/node";
import {
  assertOwnsContract,
  authenticateCustomer,
  corsHeaders,
  toContractGid,
} from "../lib/customer-auth.server";
import { applyContractEdits } from "../lib/subscription-draft.server";

const CARD_FIELDS = `
  id
  revokedAt
  instrument {
    ... on CustomerCreditCard { brand lastDigits expiryMonth expiryYear name }
  }
`;

const CONTRACT_PAYMENT_METHOD = `
  query ContractPaymentMethod($id: ID!) {
    subscriptionContract(id: $id) {
      id
      customer { id }
      customerPaymentMethod { ${CARD_FIELDS} }
    }
  }
`;

const CUSTOMER_PAYMENT_METHODS = `
  query CustomerPaymentMethods($id: ID!) {
    customer(id: $id) {
      id
      paymentMethods(first: 10) {
        edges { node { ${CARD_FIELDS} } }
      }
    }
  }
`;

const GET_UPDATE_URL = `
  mutation GetUpdateUrl($customerPaymentMethodId: ID!) {
    customerPaymentMethodGetUpdateUrl(customerPaymentMethodId: $customerPaymentMethodId) {
      updatePaymentMethodUrl
      userErrors { field message }
    }
  }
`;

// Flatten to what the extension renders. Non-card instruments (PayPal etc.)
// have no CustomerCreditCard fields, so they degrade to a bare label.
function shapeCard(node) {
  if (!node) return null;
  const i = node.instrument ?? {};
  return {
    id:          node.id,
    brand:       i.brand       ?? null,
    lastDigits:  i.lastDigits  ?? null,
    expiryMonth: i.expiryMonth ?? null,
    expiryYear:  i.expiryYear  ?? null,
    name:        i.name        ?? null,
    label: i.brand && i.lastDigits
      ? `${i.brand} •••• ${i.lastDigits}`
      : "Saved payment method",
  };
}

async function gql(admin, document, variables) {
  const res    = await admin.graphql(document, { variables });
  const result = await res.json();
  if (result?.errors?.length) {
    throw json(
      { error: result.errors.map((e) => e.message).join(" | ") },
      { status: 502, headers: corsHeaders() },
    );
  }
  return result?.data ?? {};
}

// ─── GET ──────────────────────────────────────────────────────
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const ctx = await authenticateCustomer(request);

  const url        = new URL(request.url);
  const contractId = url.searchParams.get("contractId");
  if (!contractId) {
    return json({ error: "Missing contractId" }, { status: 400, headers: corsHeaders() });
  }

  const contractGid = toContractGid(contractId);
  await assertOwnsContract(ctx, contractGid);

  const [contractData, customerData] = await Promise.all([
    gql(ctx.admin, CONTRACT_PAYMENT_METHOD, { id: contractGid }),
    gql(ctx.admin, CUSTOMER_PAYMENT_METHODS, { id: ctx.customerGid }),
  ]);

  const current = shapeCard(contractData?.subscriptionContract?.customerPaymentMethod);

  // A revoked method can no longer be charged, so it is never offered as an
  // alternative. The one currently in use is excluded from "switch to".
  const available = (customerData?.customer?.paymentMethods?.edges ?? [])
    .map((e) => e.node)
    .filter((n) => n && !n.revokedAt)
    .map(shapeCard)
    .filter((c) => c.id !== current?.id);

  return json(
    { current, available, currentRevoked: Boolean(contractData?.subscriptionContract?.customerPaymentMethod?.revokedAt) },
    { headers: corsHeaders() },
  );
}

// ─── POST ─────────────────────────────────────────────────────
export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const ctx = await authenticateCustomer(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() });
  }

  const { intent, contractId, paymentMethodId } = body ?? {};
  if (!contractId || !intent) {
    return json({ error: "Missing contractId or intent" }, { status: 400, headers: corsHeaders() });
  }

  const contractGid = toContractGid(contractId);
  await assertOwnsContract(ctx, contractGid);

  // ── Switch to another saved card ───────────────────────────
  if (intent === "switch") {
    if (!paymentMethodId) {
      return json({ error: "Missing paymentMethodId" }, { status: 400, headers: corsHeaders() });
    }

    // The target card must belong to this customer — otherwise a caller could
    // bill someone else's card for their own subscription.
    const customerData = await gql(ctx.admin, CUSTOMER_PAYMENT_METHODS, { id: ctx.customerGid });
    const owned = (customerData?.customer?.paymentMethods?.edges ?? [])
      .map((e) => e.node)
      .filter((n) => n && !n.revokedAt)
      .some((n) => n.id === paymentMethodId);

    if (!owned) {
      return json({ error: "That payment method is not available on this account." }, { status: 403, headers: corsHeaders() });
    }

    // Reuse the shared draft flow: it bails before commit on any error, so a
    // rejected change leaves the live contract untouched.
    const result = await applyContractEdits(ctx.admin.graphql, contractGid, { paymentMethodId });
    if (!result.ok) {
      return json(
        { error: `Could not update the payment method (${result.stage}): ${result.error}` },
        { status: 502, headers: corsHeaders() },
      );
    }

    const updated = shapeCard(result.contract?.customerPaymentMethod);
    return json({ success: true, current: updated }, { headers: corsHeaders() });
  }

  // ── Hand the customer to Shopify's hosted update page ──────
  if (intent === "update-url") {
    const contractData = await gql(ctx.admin, CONTRACT_PAYMENT_METHOD, { id: contractGid });
    const methodId     = contractData?.subscriptionContract?.customerPaymentMethod?.id;

    if (!methodId) {
      return json({ error: "This subscription has no payment method to update." }, { status: 404, headers: corsHeaders() });
    }

    const data       = await gql(ctx.admin, GET_UPDATE_URL, { customerPaymentMethodId: methodId });
    const payload    = data?.customerPaymentMethodGetUpdateUrl;
    const userErrors = payload?.userErrors ?? [];

    if (userErrors.length > 0) {
      return json({ error: userErrors.map((e) => e.message).join(" | ") }, { status: 422, headers: corsHeaders() });
    }
    if (!payload?.updatePaymentMethodUrl) {
      return json({ error: "Shopify did not return an update URL." }, { status: 502, headers: corsHeaders() });
    }

    return json({ success: true, updateUrl: payload.updatePaymentMethodUrl }, { headers: corsHeaders() });
  }

  return json({ error: `Unknown intent: ${intent}` }, { status: 400, headers: corsHeaders() });
}
