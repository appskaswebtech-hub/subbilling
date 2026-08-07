// app/lib/subscription-contract.server.ts
// Shared wrappers around the Shopify Subscription Contract mutations.
//
// One rule for every wrapper: Shopify decides, we mirror. The caller must not
// write local state unless the result is `ok`, and should persist the status
// Shopify returned rather than the one it asked for.

import { unauthenticated } from "../shopify.server";

const PAUSE_MUTATION = `
  mutation subscriptionContractPause($subscriptionContractId: ID!) {
    subscriptionContractPause(subscriptionContractId: $subscriptionContractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const ACTIVATE_MUTATION = `
  mutation subscriptionContractActivate($subscriptionContractId: ID!) {
    subscriptionContractActivate(subscriptionContractId: $subscriptionContractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `
  mutation subscriptionContractCancel($subscriptionContractId: ID!) {
    subscriptionContractCancel(subscriptionContractId: $subscriptionContractId) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

const SET_NEXT_BILLING_DATE_MUTATION = `
  mutation subscriptionContractSetNextBillingDate($contractId: ID!, $date: DateTime!) {
    subscriptionContractSetNextBillingDate(contractId: $contractId, date: $date) {
      contract { id nextBillingDate }
      userErrors { field message }
    }
  }
`;

// admin.graphql, as handed out by both authenticate.admin(request) and
// unauthenticated.admin(shop). Taking the callable rather than a shop lets the
// admin UI reuse the session it already has instead of minting a second one.
export type AdminGraphQL = (
  query: string,
  options?: { variables?: Record<string, any> }
) => Promise<Response>;

export interface UserError { field?: string[] | null; message: string; code?: string | null }

interface MutationResponse {
  errors?: Array<{ message: string }>;
  data?: Record<string, {
    contract?: { id: string; status?: string; nextBillingDate?: string } | null;
    userErrors?: UserError[];
  } | null>;
}

export type ContractResult =
  | { ok: true;  status: string; nextBillingDate: string | null }
  | { ok: false; error: string };

export function formatUserErrors(errors: UserError[]): string {
  return errors
    .map((e) => {
      const where = e.field?.join(".") || "error";
      return e.code ? `${where}: ${e.message} (${e.code})` : `${where}: ${e.message}`;
    })
    .join(" | ");
}

// Core: works off an admin.graphql callable.
export async function runContractMutationWith(
  graphql:    AdminGraphQL,
  mutation:   string,
  variables:  Record<string, unknown>,
  payloadKey: string,
): Promise<ContractResult> {
  try {
    const response = await graphql(mutation, { variables });
    const result   = await response.json() as MutationResponse;

    // Top-level GraphQL errors (bad field, missing scope, throttling)
    if (result.errors?.length) {
      return { ok: false, error: result.errors.map((e) => e.message).join(" | ") };
    }

    const payload = result.data?.[payloadKey];
    const userErrors = payload?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { ok: false, error: formatUserErrors(userErrors) };
    }

    if (!payload?.contract) {
      return { ok: false, error: "Shopify returned no contract for this mutation" };
    }

    return {
      ok:              true,
      status:          payload.contract.status ?? "",
      nextBillingDate: payload.contract.nextBillingDate ?? null,
    };
  } catch (err) {
    return {
      ok:    false,
      error: err instanceof Error ? err.message : "Shopify request failed",
    };
  }
}

// Shop-based wrappers: mint an offline client, then run the same core. Used by
// the public /api/v1 routes, which have no admin session to borrow.
async function runContractMutation(
  shop:       string,
  mutation:   string,
  variables:  Record<string, unknown>,
  payloadKey: string,
): Promise<ContractResult> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    return await runContractMutationWith(admin.graphql, mutation, variables, payloadKey);
  } catch (err) {
    return {
      ok:    false,
      error: err instanceof Error ? err.message : "Shopify request failed",
    };
  }
}

export function pauseContract(shop: string, contractId: string) {
  return runContractMutation(
    shop, PAUSE_MUTATION,
    { subscriptionContractId: contractId },
    "subscriptionContractPause",
  );
}

export function activateContract(shop: string, contractId: string) {
  return runContractMutation(
    shop, ACTIVATE_MUTATION,
    { subscriptionContractId: contractId },
    "subscriptionContractActivate",
  );
}

export function cancelContract(shop: string, contractId: string) {
  return runContractMutation(
    shop, CANCEL_MUTATION,
    { subscriptionContractId: contractId },
    "subscriptionContractCancel",
  );
}

export function setContractNextBillingDate(shop: string, contractId: string, date: Date) {
  return runContractMutation(
    shop, SET_NEXT_BILLING_DATE_MUTATION,
    { contractId, date: date.toISOString() },
    "subscriptionContractSetNextBillingDate",
  );
}
