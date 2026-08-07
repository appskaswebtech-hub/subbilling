// app/lib/subscription-draft.server.ts
//
// Editing a live subscription contract goes through Shopify's draft flow:
//
//   subscriptionContractUpdate   → opens a draft off the live contract
//   subscriptionDraftUpdate      → date / billing policy / delivery policy
//   subscriptionDraftLineUpdate  → quantity / price, one call per line
//   subscriptionDraftCommit      → applies everything, atomically
//
// The safety property this design leans on: a draft that is never committed
// has NO effect on the live contract. So on the first error we stop and return
// — there is nothing to roll back and no half-applied state to repair. Only
// the commit is observable to the customer.
//
// Every operation here was validated against the Admin schema before use.

import {
  formatUserErrors,
  type AdminGraphQL,
  type UserError,
} from "./subscription-contract.server";
import type { ShopifyContract } from "./subscription-sync.server";

// ─── Mutations ───────────────────────────────────────────────
const CREATE_DRAFT = `
  mutation SubContractUpdate($contractId: ID!) {
    subscriptionContractUpdate(contractId: $contractId) {
      draft { id }
      userErrors { field message code }
    }
  }
`;

const DRAFT_UPDATE = `
  mutation SubDraftUpdate($draftId: ID!, $input: SubscriptionDraftInput!) {
    subscriptionDraftUpdate(draftId: $draftId, input: $input) {
      draft {
        id
        nextBillingDate
        billingPolicy  { interval intervalCount }
        deliveryPolicy { interval intervalCount }
      }
      userErrors { field message code }
    }
  }
`;

const DRAFT_LINE_UPDATE = `
  mutation SubDraftLineUpdate($draftId: ID!, $lineId: ID!, $input: SubscriptionLineUpdateInput!) {
    subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: $input) {
      lineUpdated { id quantity currentPrice { amount currencyCode } }
      userErrors { field message code }
    }
  }
`;

const DRAFT_COMMIT = `
  mutation SubDraftCommit($draftId: ID!) {
    subscriptionDraftCommit(draftId: $draftId) {
      contract {
        id
        status
        nextBillingDate
        currencyCode
        customer { id email }
        billingPolicy  { interval intervalCount }
        deliveryPolicy { interval intervalCount }
        lines(first: 20) {
          edges {
            node {
              id title quantity sellingPlanName
              currentPrice        { amount currencyCode }
              lineDiscountedPrice { amount currencyCode }
            }
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

// Projected state of an uncommitted draft — used by the dry run.
export const DRAFT_PROJECTED_STATE = `
  query DraftProjectedState($draftId: ID!) {
    subscriptionDraft(id: $draftId) {
      id
      nextBillingDate
      billingPolicy  { interval intervalCount }
      deliveryPolicy { interval intervalCount }
      lines(first: 20) {
        edges {
          node {
            id title quantity sellingPlanName
            currentPrice        { amount currencyCode }
            lineDiscountedPrice { amount currencyCode }
          }
        }
      }
    }
  }
`;

// ─── Types ───────────────────────────────────────────────────
export type SellingPlanInterval = "DAY" | "WEEK" | "MONTH" | "YEAR";

export interface PolicyInput {
  interval:      SellingPlanInterval;
  intervalCount: number;
}

export interface LineEdit {
  lineId:        string;
  quantity?:     number;
  currentPrice?: string;
}

export interface ContractEdits {
  nextBillingDate?: Date;
  billingPolicy?:   PolicyInput;
  deliveryPolicy?:  PolicyInput;
  lines?:           LineEdit[];
  /** Point the contract at one of the customer's other saved payment methods. */
  paymentMethodId?: string;
}

export type DraftStage = "createDraft" | "draftUpdate" | "lineUpdate" | "commit" | "readback";

export type DraftEditResult =
  | { ok: true;  committed: true;  contract: ShopifyContract }
  | { ok: true;  committed: false; draftId: string; projected: ShopifyContract | null }
  | { ok: false; stage: DraftStage; error: string; draftId?: string };

interface GraphQLEnvelope {
  errors?: Array<{ message: string }>;
  data?: Record<string, any>;
}

// ─── One step ────────────────────────────────────────────────
// Returns the mutation payload, or throws a StageError carrying the stage.
class StageError extends Error {
  constructor(public stage: DraftStage, message: string) {
    super(message);
  }
}

async function step(
  graphql:    AdminGraphQL,
  stage:      DraftStage,
  document:   string,
  variables:  Record<string, unknown>,
  payloadKey: string,
): Promise<any> {
  let envelope: GraphQLEnvelope;
  try {
    const response = await graphql(document, { variables });
    envelope = await response.json() as GraphQLEnvelope;
  } catch (err) {
    throw new StageError(stage, err instanceof Error ? err.message : "Shopify request failed");
  }

  // Top-level errors: bad field, missing scope, throttling.
  if (envelope.errors?.length) {
    throw new StageError(stage, envelope.errors.map((e) => e.message).join(" | "));
  }

  const payload = envelope.data?.[payloadKey];
  if (!payload) {
    throw new StageError(
      stage,
      `Shopify returned no payload for ${payloadKey}. Check the write_own_subscription_contracts scope.`,
    );
  }

  const userErrors = (payload.userErrors ?? []) as UserError[];
  if (userErrors.length > 0) {
    throw new StageError(stage, formatUserErrors(userErrors));
  }

  return payload;
}

// ─── Public API ──────────────────────────────────────────────
export async function applyContractEdits(
  graphql:     AdminGraphQL,
  contractGid: string,
  edits:       ContractEdits,
  opts:        { commit?: boolean } = {},
): Promise<DraftEditResult> {
  const commit = opts.commit !== false;
  let draftId: string | undefined;

  try {
    // 1. Open a draft off the live contract.
    const created = await step(
      graphql, "createDraft", CREATE_DRAFT,
      { contractId: contractGid },
      "subscriptionContractUpdate",
    );
    draftId = created.draft?.id;
    if (!draftId) throw new StageError("createDraft", "Shopify did not return a draft id");

    // 2. Contract-level fields, in ONE call.
    const draftInput: Record<string, unknown> = {};
    if (edits.nextBillingDate) draftInput.nextBillingDate = edits.nextBillingDate.toISOString();
    if (edits.billingPolicy)   draftInput.billingPolicy   = edits.billingPolicy;
    if (edits.deliveryPolicy)  draftInput.deliveryPolicy  = edits.deliveryPolicy;
    if (edits.paymentMethodId) draftInput.paymentMethodId = edits.paymentMethodId;

    if (Object.keys(draftInput).length > 0) {
      await step(
        graphql, "draftUpdate", DRAFT_UPDATE,
        { draftId, input: draftInput },
        "subscriptionDraftUpdate",
      );
    }

    // 3. Line-level fields. Only changed keys are sent, so the audit trail
    //    reflects what the merchant actually touched.
    for (const line of edits.lines ?? []) {
      const lineInput: Record<string, unknown> = {};
      if (line.quantity     !== undefined) lineInput.quantity     = line.quantity;
      if (line.currentPrice !== undefined) lineInput.currentPrice = line.currentPrice;
      if (Object.keys(lineInput).length === 0) continue;

      await step(
        graphql, "lineUpdate", DRAFT_LINE_UPDATE,
        { draftId, lineId: line.lineId, input: lineInput },
        "subscriptionDraftLineUpdate",
      );
    }

    // 4a. Dry run: stop before commit and read back the projected state. The
    //     live contract is untouched — an uncommitted draft simply expires.
    if (!commit) {
      let projected: ShopifyContract | null = null;
      try {
        const response = await graphql(DRAFT_PROJECTED_STATE, { variables: { draftId } });
        const envelope = await response.json() as GraphQLEnvelope;
        projected = envelope.data?.subscriptionDraft ?? null;
      } catch {
        // Readback is diagnostic only; the dry run still succeeded.
      }
      return { ok: true, committed: false, draftId, projected };
    }

    // 4b. Commit — the only step the customer can observe.
    const committed = await step(
      graphql, "commit", DRAFT_COMMIT,
      { draftId },
      "subscriptionDraftCommit",
    );
    if (!committed.contract) {
      throw new StageError("commit", "Shopify committed the draft but returned no contract");
    }

    return { ok: true, committed: true, contract: committed.contract as ShopifyContract };
  } catch (err) {
    if (err instanceof StageError) {
      return { ok: false, stage: err.stage, error: err.message, draftId };
    }
    return {
      ok:      false,
      stage:   "createDraft",
      error:   err instanceof Error ? err.message : "Unknown error applying edits",
      draftId,
    };
  }
}
