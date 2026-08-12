// app/lib/subscription-backfill.server.ts
//
// Pulls a shop's existing subscription contracts from Shopify into the local
// Subscription table.
//
// Why this exists: the local table is only ever written by the
// subscription_contracts webhooks, which fire for contracts created AFTER the
// app was installed and its webhooks registered. Contracts that predate that
// never appear — the dashboard reads live from Shopify and shows them all,
// while the Subscriptions page reads Prisma and shows a fraction.
//
// Deliberately additive: it never deletes local rows for contracts missing from
// Shopify. Leaving a stale row visible is safer than silently removing a
// billing record.

import type { AdminGraphQL } from "./subscription-contract.server";
import {
  upsertContractLocally,
  type ShopifyContract,
} from "./subscription-sync.server";

// Only what upsertContractLocally needs, plus a cursor. Validated against the
// live schema; `customer { id }` and `billingPolicy` are what make customerId
// and frequency populatable — the similar query on the dashboard omits both.
export const CONTRACTS_PAGE_QUERY = `
  query ContractsPage($first: Int!, $after: String) {
    subscriptionContracts(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          status
          nextBillingDate
          customer { id email }
          billingPolicy { interval intervalCount }
          lines(first: 1) {
            edges { node { title sellingPlanName currentPrice { amount currencyCode } } }
          }
        }
      }
    }
  }
`;

export interface BackfillSummary {
  created: number;
  updated: number;
  failed:  Array<{ id: string; reason: string }>;
  /** True when the cap stopped it before Shopify ran out of contracts. */
  truncated: boolean;
}

const PAGE_SIZE   = 50;
const DEFAULT_MAX = 1000;

interface PageEnvelope {
  errors?: Array<{ message: string }>;
  data?: {
    subscriptionContracts?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      edges?: Array<{ node: ShopifyContract }>;
    } | null;
  };
}

/**
 * Walks every subscription contract in the shop and upserts it locally.
 *
 * Bounded by `max` so a large shop cannot spin indefinitely inside a request.
 * A single contract that fails to write is recorded and skipped — one bad
 * record must not cost the rest.
 */
export async function backfillContracts(
  graphql: AdminGraphQL,
  shop:    string,
  opts:    { max?: number } = {},
): Promise<BackfillSummary> {
  const max     = opts.max ?? DEFAULT_MAX;
  const summary: BackfillSummary = { created: 0, updated: 0, failed: [], truncated: false };

  let after: string | null = null;
  let seen = 0;

  for (;;) {
    const response = await graphql(CONTRACTS_PAGE_QUERY, {
      variables: { first: Math.min(PAGE_SIZE, max - seen), after },
    });
    const envelope = await response.json() as PageEnvelope;

    if (envelope?.errors?.length) {
      throw new Error(envelope.errors.map((e) => e.message).join(" | "));
    }

    const connection = envelope?.data?.subscriptionContracts;
    const nodes      = (connection?.edges ?? []).map((e) => e.node).filter(Boolean);

    for (const contract of nodes) {
      seen += 1;
      try {
        const { created } = await upsertContractLocally(shop, contract);
        if (created) summary.created += 1;
        else         summary.updated += 1;
      } catch (err: any) {
        summary.failed.push({
          id:     contract?.id ?? "(unknown)",
          reason: err?.message ?? "unknown error",
        });
      }
    }

    if (seen >= max) {
      summary.truncated = Boolean(connection?.pageInfo?.hasNextPage);
      break;
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor ?? null;
    if (!after) break; // defensive: no cursor means we cannot advance
  }

  return summary;
}
