// app/shopify/sellingPlans.server.ts
// Shopify Admin GraphQL — SellingPlanGroup CRUD
// Calling convention: admin.graphql(query, { variables }) → response.json()

import type { BillingInterval } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SellingPlanInput {
  name: string;
  description?: string | null;
  price: number;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  trialDays: number;
  maxCycles?: number | null;
}

export interface CreateSellingPlanGroupResult {
  groupId: string;       // gid://shopify/SellingPlanGroup/...
  sellingPlanId: string; // gid://shopify/SellingPlan/...
}

// admin.graphql is typed as a callable that returns a Response
type AdminGraphQL = (
  query: string,
  options?: { variables?: Record<string, any> }
) => Promise<Response>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function intervalLabel(interval: BillingInterval): string {
  return interval === "WEEK" ? "Weekly" : interval === "MONTH" ? "Monthly" : "Yearly";
}

function merchantCode(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Build a SellingPlanInput object that matches the Shopify API shape exactly.
 * category: SUBSCRIPTION, billingPolicy.recurring, deliveryPolicy.recurring,
 * pricingPolicies with PRICE adjustment, optional inventoryPolicy.
 */
function buildSellingPlanInput(plan: SellingPlanInput) {
  return {
    name: plan.name,
    options: intervalLabel(plan.interval),   // single string e.g. "Monthly"
    category: "SUBSCRIPTION",
    billingPolicy: {
      recurring: {
        interval: plan.interval,             // "WEEK" | "MONTH" | "YEAR"
        intervalCount: plan.intervalCount,
        ...(plan.maxCycles ? { maxCycles: plan.maxCycles } : {}),
      },
    },
    deliveryPolicy: {
      recurring: {
        interval: plan.interval,
        intervalCount: plan.intervalCount,
      },
    },
    inventoryPolicy: {
      reserve: "ON_SALE",
    },
    pricingPolicies: [
      {
        fixed: {
          adjustmentType: "PRICE",
          adjustmentValue: {
            fixedValue: parseFloat(plan.price.toFixed(2)),
          },
        },
      },
    ],
  };
}

async function gql(
  admin: AdminGraphQL,
  query: string,
  variables: Record<string, any>
) {
  const response = await admin(query, { variables });
  const body = await response.json();
  // Top-level GraphQL errors
  if (body.errors?.length) {
    throw new Error(body.errors.map((e: any) => e.message).join(", "));
  }
  return body.data;
}

// ─── sellingPlanGroupCreate ───────────────────────────────────────────────────

const SELLING_PLAN_GROUP_CREATE = `#graphql
  mutation sellingPlanGroupCreate(
    $input: SellingPlanGroupInput!
    $resources: SellingPlanGroupResourceInput
  ) {
    sellingPlanGroupCreate(input: $input, resources: $resources) {
      sellingPlanGroup {
        id
        sellingPlans(first: 1) {
          edges {
            node {
              id
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function createSellingPlanGroup(
  admin: AdminGraphQL,
  plan: SellingPlanInput
): Promise<CreateSellingPlanGroupResult> {
  const data = await gql(admin, SELLING_PLAN_GROUP_CREATE, {
    input: {
      name: plan.name,
      merchantCode: merchantCode(plan.name),
      description: plan.description ?? "",
      options: [intervalLabel(plan.interval)],
      sellingPlansToCreate: [buildSellingPlanInput(plan)],
    },
    resources: {},
  });

  const userErrors = data?.sellingPlanGroupCreate?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e: any) => `${e.field}: ${e.message}`).join(", "));
  }

  const group = data.sellingPlanGroupCreate.sellingPlanGroup;
  const groupId: string = group.id;
  const sellingPlanId: string = group.sellingPlans.edges[0].node.id;

  return { groupId, sellingPlanId };
}

// ─── sellingPlanGroupUpdate ───────────────────────────────────────────────────

const SELLING_PLAN_GROUP_UPDATE = `#graphql
  mutation sellingPlanGroupUpdate($id: ID!, $input: SellingPlanGroupInput!) {
    sellingPlanGroupUpdate(id: $id, input: $input) {
      sellingPlanGroup {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function updateSellingPlanGroup(
  admin: AdminGraphQL,
  shopifyGroupId: string,
  plan: SellingPlanInput,
  existingSellingPlanId?: string | null
): Promise<void> {
  const sellingPlanBase = buildSellingPlanInput(plan);

  // If we have the existing SellingPlan ID, update it in-place.
  // Otherwise create a new one (shouldn't happen in normal flow).
  const sellingPlansToUpdate = existingSellingPlanId
    ? [{ id: existingSellingPlanId, ...sellingPlanBase }]
    : [];
  const sellingPlansToCreate = existingSellingPlanId ? [] : [sellingPlanBase];

  const data = await gql(admin, SELLING_PLAN_GROUP_UPDATE, {
    id: shopifyGroupId,
    input: {
      name: plan.name,
      merchantCode: merchantCode(plan.name),
      description: plan.description ?? "",
      options: [intervalLabel(plan.interval)],
      ...(sellingPlansToUpdate.length ? { sellingPlansToUpdate } : {}),
      ...(sellingPlansToCreate.length ? { sellingPlansToCreate } : {}),
    },
  });

  const userErrors = data?.sellingPlanGroupUpdate?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e: any) => `${e.field}: ${e.message}`).join(", "));
  }
}

// ─── sellingPlanGroupDelete ───────────────────────────────────────────────────

const SELLING_PLAN_GROUP_DELETE = `#graphql
  mutation sellingPlanGroupDelete($id: ID!) {
    sellingPlanGroupDelete(id: $id) {
      deletedSellingPlanGroupId
      userErrors {
        field
        message
      }
    }
  }
`;

export async function deleteSellingPlanGroup(
  admin: AdminGraphQL,
  shopifyGroupId: string
): Promise<void> {
  const data = await gql(admin, SELLING_PLAN_GROUP_DELETE, {
    id: shopifyGroupId,
  });

  const userErrors = data?.sellingPlanGroupDelete?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e: any) => `${e.field}: ${e.message}`).join(", "));
  }
}

// ─── addProductsToSellingPlanGroup ────────────────────────────────────────────

const SELLING_PLAN_GROUP_ADD_PRODUCTS = `#graphql
  mutation sellingPlanGroupAddProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
      sellingPlanGroup {
        id
        productCount
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function addProductsToSellingPlanGroup(
  admin: AdminGraphQL,
  shopifyGroupId: string,
  productIds: string[]
): Promise<void> {
  if (!productIds.length) return;

  const data = await gql(admin, SELLING_PLAN_GROUP_ADD_PRODUCTS, {
    id: shopifyGroupId,
    productIds,
  });

  const userErrors = data?.sellingPlanGroupAddProducts?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e: any) => `${e.field}: ${e.message}`).join(", "));
  }
}

// ─── removeProductsFromSellingPlanGroup ───────────────────────────────────────

const SELLING_PLAN_GROUP_REMOVE_PRODUCTS = `#graphql
  mutation sellingPlanGroupRemoveProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
      removedProductIds
      userErrors {
        field
        message
      }
    }
  }
`;

export async function removeProductsFromSellingPlanGroup(
  admin: AdminGraphQL,
  shopifyGroupId: string,
  productIds: string[]
): Promise<void> {
  if (!productIds.length) return;

  const data = await gql(admin, SELLING_PLAN_GROUP_REMOVE_PRODUCTS, {
    id: shopifyGroupId,
    productIds,
  });

  const userErrors = data?.sellingPlanGroupRemoveProducts?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e: any) => `${e.field}: ${e.message}`).join(", "));
  }
}

// ─── getSellingPlanGroupProducts ──────────────────────────────────────────────

const GET_SELLING_PLAN_GROUP_PRODUCTS = `#graphql
  query getSellingPlanGroupProducts($id: ID!, $first: Int!, $after: String) {
    sellingPlanGroup(id: $id) {
      id
      name
      productCount
      products(first: $first, after: $after) {
        edges {
          node {
            id
            title
            handle
            status
            featuredImage {
              url
              altText
            }
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                }
              }
            }
          }
          cursor
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export async function getSellingPlanGroupProducts(
  admin: AdminGraphQL,
  shopifyGroupId: string,
  first = 20,
  after?: string
) {
  const data = await gql(admin, GET_SELLING_PLAN_GROUP_PRODUCTS, {
    id: shopifyGroupId,
    first,
    ...(after ? { after } : {}),
  });
  return data?.sellingPlanGroup ?? null;
}

// ─── searchProducts ───────────────────────────────────────────────────────────

const SEARCH_PRODUCTS = `#graphql
  query searchProducts($query: String!, $first: Int!) {
    products(query: $query, first: $first) {
      edges {
        node {
          id
          title
          handle
          status
          featuredImage {
            url
            altText
          }
          variants(first: 1) {
            edges {
              node {
                id
                price
              }
            }
          }
        }
      }
    }
  }
`;

export async function searchProducts(
  admin: AdminGraphQL,
  query: string,
  first = 10
) {
  const data = await gql(admin, SEARCH_PRODUCTS, {
    query: query?.trim() || "status:active",
    first,
  });
  return data?.products?.edges?.map((e: any) => e.node) ?? [];
}

// ─── getFirstSellingPlanId ────────────────────────────────────────────────────

const GET_SELLING_PLAN_ID = `#graphql
  query getSellingPlanId($id: ID!) {
    sellingPlanGroup(id: $id) {
      sellingPlans(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }
  }
`;

export async function getFirstSellingPlanId(
  admin: AdminGraphQL,
  shopifyGroupId: string
): Promise<string | null> {
  const data = await gql(admin, GET_SELLING_PLAN_ID, { id: shopifyGroupId });
  return data?.sellingPlanGroup?.sellingPlans?.edges?.[0]?.node?.id ?? null;
}
