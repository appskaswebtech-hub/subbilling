// app/routes/app.plans.tsx

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData,
  useSubmit,
  useNavigation,
  useActionData,
  useFetcher,
} from "@remix-run/react";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Modal,
  TextField,
  Select,
  Banner,
  Toast,
  Frame,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getFirstSellingPlanId } from "../shopify/sellingPlans.server";
import dashboardStyles from "../styles/dashboard.css?url";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];

// ─── Types ────────────────────────────────────────────────────
type PickerProduct = {
  id: string;
  title: string;
  image: string | null;
  hasVariants: boolean;
  variantsCount: number;
};

type PickerVariant = {
  id: string;
  title: string;
  price: string | null;
  image: string | null;
};

// An assigned product on a plan card. `whole` = the entire product (all
// variants). Otherwise `variants` holds the specific selected variants.
type AssignedVariant = {
  id: string;
  title: string;
  image: string | null;
  price: string | null;
};

type AssignedProduct = {
  id: string;
  title: string;
  image: string | null;
  whole: boolean;
  variants: AssignedVariant[];
};

type PlanGroup = {
  id: string;
  shopifyGroupId: string | null;
  name: string;
  interval: string;
  intervalCount: number;
  discount: number;
  discountType: string;
  createdAt: string;
  productCount?: number;
  assigned?: AssignedProduct[];
};

type PlanFormValues = {
  name: string;
  interval: string;
  intervalCount: string;
  discount: string;
  discountType: string;
};

type ShopTier = "free" | "basic" | "pro" | "advanced";

// ─── Plan tier limits ─────────────────────────────────────────
// NOTE: -1 means unlimited. We avoid Infinity because JSON.stringify(Infinity) === "null"
const PLAN_LIMITS: Record<ShopTier, number> = {
  free: 1,
  basic: 3,
  pro: 5,
  advanced: -1, // -1 = unlimited
};

const PLAN_LABELS: Record<ShopTier, string> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  advanced: "Advanced",
};

function getPlanLimit(tier: string): number {
  return PLAN_LIMITS[tier as ShopTier] ?? 1;
}

function getPlanLabel(tier: string): string {
  return PLAN_LABELS[tier as ShopTier] ?? "Free";
}

function isUnlimitedLimit(limit: number): boolean {
  return limit === -1;
}

// ─── Design tokens ───────────────────────────────────────────
const T = {
  purple: "#7F77DD",
  purpleBg: "#EEEDFE",
  purpleMid: "#534AB7",
  purpleDark: "#26215C",
  purpleFg: "#3C3489",
  greenBg: "#EAF3DE",
  greenFg: "#27500A",
  greenDot: "#3B6D11",
  amberBg: "#FAEEDA",
  amberFg: "#633806",
  amberDot: "#BA7517",
  redBg: "#FCEBEB",
  redFg: "#791F1F",
  redBorder: "#F09595",
  tealBg: "#E1F5EE",
  tealStroke: "#0F6E56",
  // Stat-cell accents (match the mockup)
  statPurple: "#5C4FC4",
  statPurpleBg: "#EEEDFE",
  statGreen: "#1A8A55",
  statGreenBg: "#E3F7EE",
  statAmber: "#B7791F",
  statAmberBg: "#FBF0DC",
  statBlue: "#2563EB",
  statBlueBg: "#E6EFFE",
};

// Hover shadow shared by cards (mirrors KpiCard in app.analytics.tsx)
const CARD_SHADOW = "0 8px 24px rgba(0,0,0,0.08)";

function applyCardHover(el: HTMLElement) {
  el.style.transform = "translateY(-2px)";
  el.style.boxShadow = CARD_SHADOW;
}
function clearCardHover(el: HTMLElement) {
  el.style.transform = "none";
  el.style.boxShadow = "none";
}

// Normalise a subscription price to a monthly value (see app.analytics.tsx)
function toMonthlyValue(price: number, frequency: string): number {
  switch (frequency) {
    case "DAILY":
      return price * 30;
    case "WEEKLY":
      return price * 4.33;
    case "BIWEEKLY":
      return price * 2.17;
    case "MONTHLY":
      return price;
    case "YEARLY":
      return price / 12;
    default:
      return price;
  }
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

// Shared style for a kebab menu item
function kebabItemStyle(color: string, disabled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "9px",
    width: "100%",
    padding: "8px 10px",
    fontSize: "13px",
    fontWeight: 500,
    textAlign: "left",
    color,
    background: "transparent",
    border: "none",
    borderRadius: "8px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

const INTERVAL_OPTIONS = [
  { label: "Daily", value: "DAY" },
  { label: "Weekly", value: "WEEK" },
  { label: "Monthly", value: "MONTH" },
  { label: "Yearly", value: "YEAR" },
] as const;

function defaultPlanFormValues(): PlanFormValues {
  return {
    name: "Monthly Subscription",
    interval: "MONTH",
    intervalCount: "1",
    discount: "10",
    discountType: "percentage",
  };
}

function formatIntervalLabel(interval: string, intervalCount: number) {
  return `Every ${intervalCount} ${
    interval.charAt(0) + interval.slice(1).toLowerCase()
  }${intervalCount > 1 ? "s" : ""}`;
}

function merchantCode(name: string) {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function parsePlanForm(formData: FormData) {
  const name = (formData.get("name") as string | null)?.trim() ?? "";
  const interval = (formData.get("interval") as string | null) ?? "";
  const intervalCount = Number.parseInt(
    (formData.get("intervalCount") as string | null) ?? "",
    10,
  );
  const discount = Number.parseFloat(
    (formData.get("discount") as string | null) ?? "0",
  );
  const discountType =
    (formData.get("discountType") as string | null) ?? "percentage";

  if (!name) return { error: "Plan name is required." };
  if (!INTERVAL_OPTIONS.some((o) => o.value === interval))
    return { error: "Select a valid billing interval." };
  if (!Number.isInteger(intervalCount) || intervalCount < 1)
    return { error: "Interval count must be at least 1." };
  if (!["percentage", "fixed_amount"].includes(discountType))
    return { error: "Select a valid discount type." };
  if (discountType === "percentage" && (Number.isNaN(discount) || discount < 0 || discount > 100))
    return { error: "Percentage discount must be between 0 and 100." };
  if (discountType === "fixed_amount" && (Number.isNaN(discount) || discount < 0))
    return { error: "Fixed discount must be 0 or greater." };

  return { name, interval, intervalCount, discount, discountType };
}

function buildSellingPlanPayload({
  name,
  interval,
  intervalCount,
  discount,
  discountType,
}: {
  name: string;
  interval: string;
  intervalCount: number;
  discount: number;
  discountType: string;
}) {
  const optionLabel = formatIntervalLabel(interval, intervalCount);
  const discountLabel =
    discount > 0
      ? discountType === "fixed_amount"
        ? `${discount} off`
        : `${discount}% off`
      : null;
  const planName = discountLabel ? `${optionLabel} (${discountLabel})` : optionLabel;

  const pricingPolicies =
    discount > 0
      ? [
          {
            fixed:
              discountType === "fixed_amount"
                ? {
                    adjustmentType: "FIXED_AMOUNT",
                    adjustmentValue: { fixedValue: discount },
                  }
                : {
                    adjustmentType: "PERCENTAGE",
                    adjustmentValue: { percentage: discount },
                  },
          },
        ]
      : [];

  const sellingPlanInput = {
    name: planName,
    options: optionLabel,
    category: "SUBSCRIPTION",
    billingPolicy: { recurring: { interval, intervalCount } },
    deliveryPolicy: { recurring: { interval, intervalCount } },
    pricingPolicies,
  };

  return {
    groupInput: {
      name,
      merchantCode: merchantCode(name),
      options: [optionLabel],
    },
    sellingPlanInput,
  };
}

// Turn a selling plan group's products + productVariants connections into a
// product-grouped list. A product is `whole` when it has no individually-attached
// variants or when every one of its variants is attached; otherwise the specific
// attached variants are listed under it.
function buildAssignedList(spg: any): {
  assigned: AssignedProduct[];
  productCount: number;
} {
  const productEdges = spg?.products?.edges ?? [];
  const variantEdges = spg?.productVariants?.edges ?? [];

  // Group attached variants by their parent product
  const byProduct = new Map<
    string,
    {
      title: string;
      image: string | null;
      total: number;
      variants: Array<{ id: string; title: string; image: string | null; price: string | null }>;
    }
  >();
  for (const e of variantEdges) {
    const v = e.node;
    const p = v.product;
    if (!p?.id) continue;
    let entry = byProduct.get(p.id);
    if (!entry) {
      entry = {
        title: p.title ?? "Product",
        image: p.featuredImage?.url ?? null,
        total: p.variantsCount?.count ?? 0,
        variants: [],
      };
      byProduct.set(p.id, entry);
    }
    entry.variants.push({
      id: v.id,
      title: v.title,
      image: v.image?.url ?? p.featuredImage?.url ?? null,
      price: v.price ?? null,
    });
  }

  // Whole products from the group's products connection
  const productInfo = new Map<string, { title: string; image: string | null }>();
  for (const e of productEdges) {
    productInfo.set(e.node.id, {
      title: e.node.title,
      image: e.node.featuredImage?.url ?? null,
    });
  }

  const assigned: AssignedProduct[] = [];
  const productIds = new Set<string>([
    ...productInfo.keys(),
    ...byProduct.keys(),
  ]);

  for (const pid of productIds) {
    const vinfo = byProduct.get(pid);
    const pinfo = productInfo.get(pid);
    const assignedVariants = vinfo?.variants ?? [];
    const total = vinfo?.total ?? 0;
    const whole =
      assignedVariants.length === 0 ||
      (total > 0 && assignedVariants.length >= total);

    assigned.push({
      id: pid,
      title: pinfo?.title ?? vinfo?.title ?? "Product",
      image: pinfo?.image ?? vinfo?.image ?? null,
      whole,
      variants: whole ? [] : assignedVariants,
    });
  }

  return { assigned, productCount: productIds.size };
}

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);

  const shopPlan = await prisma.shopPlan.findUnique({
    where: { shop: session.shop },
  });
  const tier = (shopPlan?.plan ?? "free") as ShopTier;
  const planLimit = getPlanLimit(tier); // -1 means unlimited

  const localGroups = await prisma.sellingPlanGroup.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  const enriched = await Promise.all(
    localGroups.map(async (g) => {
      if (!g.shopifyGroupId) return { ...g, productCount: 0, assigned: [] };
      try {
        const res = await admin.graphql(
          `#graphql
          query getSellingPlanGroupProducts($id: ID!) {
            sellingPlanGroup(id: $id) {
              products(first: 50) {
                edges {
                  node { id title featuredImage { url } }
                }
              }
              productVariants(first: 100) {
                edges {
                  node {
                    id
                    title
                    price
                    image { url }
                    product {
                      id
                      title
                      featuredImage { url }
                      variantsCount { count }
                    }
                  }
                }
              }
            }
          }`,
          { variables: { id: g.shopifyGroupId } },
        );
        const result = await res.json();
        const spg = result?.data?.sellingPlanGroup;
        const { assigned, productCount } = buildAssignedList(spg);
        return { ...g, productCount, assigned };
      } catch {
        return { ...g, productCount: 0, assigned: [] };
      }
    }),
  );

  // ── Subscription metrics (live stats for the header) ──
  const activeSubscriptions = await prisma.subscription.findMany({
    where: { shop: session.shop, status: "ACTIVE" },
    select: { price: true, frequency: true },
  });
  const activeSubs = activeSubscriptions.length;
  const monthlyRevenue = activeSubscriptions.reduce(
    (sum, s) => sum + toMonthlyValue(s.price, s.frequency),
    0,
  );

  // Average discount across percentage-based plans
  const percentagePlans = localGroups.filter(
    (g) => g.discountType !== "fixed_amount" && g.discount > 0,
  );
  const avgDiscount =
    percentagePlans.length > 0
      ? percentagePlans.reduce((sum, g) => sum + g.discount, 0) /
        percentagePlans.length
      : 0;

  // ── Fetch all store products for the picker ──
  let allProducts: PickerProduct[] = [];
  try {
    const productsRes = await admin.graphql(
      `#graphql
      query getAllProducts {
        products(first: 100) {
          edges {
            node {
              id
              title
              featuredImage { url }
              hasOnlyDefaultVariant
              variantsCount { count }
            }
          }
        }
      }`,
    );
    const productsResult = await productsRes.json();
    allProducts = (productsResult?.data?.products?.edges ?? []).map(
      (e: any) => {
        const variantsCount = e.node.variantsCount?.count ?? 0;
        return {
          id: e.node.id,
          title: e.node.title,
          image: e.node.featuredImage?.url ?? null,
          // Only offer variant selection when the product has real variants
          hasVariants: !e.node.hasOnlyDefaultVariant && variantsCount > 1,
          variantsCount,
        };
      },
    );
  } catch {
    allProducts = [];
  }

  return json({
    planGroups: enriched as PlanGroup[],
    shopTier: tier,
    planLimit, // -1 = unlimited (safe to JSON serialize)
    planLabel: getPlanLabel(tier),
    allProducts,
    stats: {
      activeSubs,
      monthlyRevenue,
      avgDiscount,
    },
  });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Create ─────────────────────────────────────────────────
  if (intent === "create") {
    const shopPlan = await prisma.shopPlan.findUnique({
      where: { shop: session.shop },
    });
    const tier = shopPlan?.plan ?? "free";
    const limit = getPlanLimit(tier);
    const unlimited = isUnlimitedLimit(limit);

    if (!unlimited) {
      const currentCount = await prisma.sellingPlanGroup.count({
        where: { shop: session.shop },
      });
      if (currentCount >= limit) {
        return json(
          {
            ok: false,
            error: `Your ${getPlanLabel(tier)} plan allows up to ${limit} selling plan${limit === 1 ? "" : "s"}. Upgrade to create more.`,
            intent: "create",
            limitReached: true,
          },
          { status: 403 },
        );
      }
    }

    const parsed = parsePlanForm(formData);
    if ("error" in parsed) {
      return json(
        { ok: false, error: parsed.error, intent: "create" },
        { status: 422 },
      );
    }

    const { name, interval, intervalCount, discount, discountType } = parsed;
    const { groupInput, sellingPlanInput } = buildSellingPlanPayload({
      name,
      interval,
      intervalCount,
      discount,
      discountType,
    });
    const { pricingPolicies, ...sellingPlanWithoutPolicies } = sellingPlanInput;

    let response;
    try {
      response = await admin.graphql(
        `#graphql
        mutation sellingPlanGroupCreate(
          $input: SellingPlanGroupInput!
          $resources: SellingPlanGroupResourceInput
        ) {
          sellingPlanGroupCreate(input: $input, resources: $resources) {
            sellingPlanGroup {
              id name
              sellingPlans(first: 5) { edges { node { id name } } }
            }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              ...groupInput,
              sellingPlansToCreate: [
                discount > 0 ? sellingPlanInput : sellingPlanWithoutPolicies,
              ],
            },
            resources: { productIds: [], productVariantIds: [] },
          },
        },
      );
    } catch (err: any) {
      return json({ ok: false, error: `Request failed: ${err?.message}` });
    }

    const result = await response.json();

    if (result?.errors?.length)
      return json({
        ok: false,
        error: result.errors.map((e: any) => e.message).join(" | "),
      });

    const userErrors = result?.data?.sellingPlanGroupCreate?.userErrors ?? [];
    if (userErrors.length)
      return json({
        ok: false,
        error: userErrors
          .map((e: any) => `[${e.field}] ${e.message}`)
          .join(" | "),
      });

    const groupId =
      result?.data?.sellingPlanGroupCreate?.sellingPlanGroup?.id;
    if (!groupId)
      return json({
        ok: false,
        error:
          "No group ID returned. Check write_products + write_purchase_options scopes.",
      });

    await prisma.sellingPlanGroup.create({
      data: {
        shop: session.shop,
        shopifyGroupId: groupId,
        name,
        interval,
        intervalCount,
        discount,
        discountType,
      },
    });

    return json({ ok: true, error: null, intent: "create" });
  }

  // ── Update ─────────────────────────────────────────────────
  if (intent === "update") {
    const id = formData.get("id") as string;
    const group = await prisma.sellingPlanGroup.findFirst({
      where: { id, shop: session.shop },
    });

    if (!group) {
      return json(
        { ok: false, error: "Plan not found.", intent: "update" },
        { status: 404 },
      );
    }

    const parsed = parsePlanForm(formData);
    if ("error" in parsed) {
      return json(
        { ok: false, error: parsed.error, intent: "update" },
        { status: 422 },
      );
    }

    const { name, interval, intervalCount, discount, discountType } = parsed;
    const { groupInput, sellingPlanInput } = buildSellingPlanPayload({
      name,
      interval,
      intervalCount,
      discount,
      discountType,
    });

    if (group.shopifyGroupId) {
      let sellingPlanId: string | null = null;
      try {
        sellingPlanId = await getFirstSellingPlanId(
          admin.graphql,
          group.shopifyGroupId,
        );
      } catch (err: any) {
        return json({
          ok: false,
          error: `Could not load the Shopify selling plan: ${err?.message}`,
          intent: "update",
        });
      }

      if (!sellingPlanId) {
        return json({
          ok: false,
          error: "No Shopify selling plan was found for this group.",
          intent: "update",
        });
      }

      let response;
      try {
        response = await admin.graphql(
          `#graphql
          mutation sellingPlanGroupUpdate($id: ID!, $input: SellingPlanGroupInput!) {
            sellingPlanGroupUpdate(id: $id, input: $input) {
              sellingPlanGroup { id }
              userErrors { field message }
            }
          }`,
          {
            variables: {
              id: group.shopifyGroupId,
              input: {
                ...groupInput,
                sellingPlansToUpdate: [
                  { id: sellingPlanId, ...sellingPlanInput },
                ],
              },
            },
          },
        );
      } catch (err: any) {
        return json({
          ok: false,
          error: `Update failed: ${err?.message}`,
          intent: "update",
        });
      }

      const result = await response.json();

      if (result?.errors?.length) {
        return json({
          ok: false,
          error: result.errors.map((e: any) => e.message).join(" | "),
          intent: "update",
        });
      }

      const userErrors =
        result?.data?.sellingPlanGroupUpdate?.userErrors ?? [];
      if (userErrors.length) {
        return json({
          ok: false,
          error: userErrors
            .map((e: any) => `[${e.field}] ${e.message}`)
            .join(" | "),
          intent: "update",
        });
      }
    }

    await prisma.sellingPlanGroup.update({
      where: { id },
      data: { name, interval, intervalCount, discount, discountType },
    });

    return json({ ok: true, error: null, intent: "update" });
  }

  // ── Fetch a product's variants (lazy, for the picker) ──────
  if (intent === "fetch_variants") {
    const productId = formData.get("productId") as string;
    try {
      const response = await admin.graphql(
        `#graphql
        query getProductVariants($id: ID!) {
          product(id: $id) {
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  price
                  image { url }
                }
              }
            }
          }
        }`,
        { variables: { id: productId } },
      );
      const result = await response.json();
      const variants = (result?.data?.product?.variants?.edges ?? []).map(
        (e: any) => ({
          id: e.node.id,
          title: e.node.title,
          price: e.node.price ?? null,
          image: e.node.image?.url ?? null,
        }),
      );
      return json({
        ok: true,
        error: null,
        intent: "fetch_variants",
        productId,
        variants,
      });
    } catch (err: any) {
      return json({
        ok: false,
        error: `Could not load variants: ${err?.message}`,
        intent: "fetch_variants",
        productId,
        variants: [],
      });
    }
  }

  // ── Assign products / variants bulk ─────────────────────────
  if (intent === "assign_products_bulk") {
    const shopifyGroupId = formData.get("shopifyGroupId") as string;
    const productIds = formData.getAll("productId[]") as string[];
    const variantIds = formData.getAll("variantId[]") as string[];

    if (!productIds.length && !variantIds.length) {
      return json({
        ok: false,
        error: "No products or variants selected.",
        intent: "assign_products_bulk",
      });
    }

    const userErrors: string[] = [];
    try {
      if (productIds.length) {
        const response = await admin.graphql(
          `#graphql
          mutation sellingPlanGroupAddProducts($id: ID!, $productIds: [ID!]!) {
            sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
              sellingPlanGroup { id name }
              userErrors { field message }
            }
          }`,
          { variables: { id: shopifyGroupId, productIds } },
        );
        const result = await response.json();
        (result?.data?.sellingPlanGroupAddProducts?.userErrors ?? []).forEach(
          (e: any) => userErrors.push(e.message),
        );
      }

      if (variantIds.length) {
        const response = await admin.graphql(
          `#graphql
          mutation sellingPlanGroupAddProductVariants($id: ID!, $productVariantIds: [ID!]!) {
            sellingPlanGroupAddProductVariants(id: $id, productVariantIds: $productVariantIds) {
              sellingPlanGroup { id name }
              userErrors { field message }
            }
          }`,
          { variables: { id: shopifyGroupId, productVariantIds: variantIds } },
        );
        const result = await response.json();
        (
          result?.data?.sellingPlanGroupAddProductVariants?.userErrors ?? []
        ).forEach((e: any) => userErrors.push(e.message));
      }
    } catch (err: any) {
      return json({
        ok: false,
        error: `Assign failed: ${err?.message}`,
        intent: "assign_products_bulk",
      });
    }

    if (userErrors.length) {
      return json({
        ok: false,
        error: userErrors.join(" | "),
        intent: "assign_products_bulk",
      });
    }

    return json({ ok: true, error: null, intent: "assign_products_bulk" });
  }

  // ── Remove product ─────────────────────────────────────────
  if (intent === "remove_product") {
    const shopifyGroupId = formData.get("shopifyGroupId") as string;
    const productId = formData.get("productId") as string;
    try {
      await admin.graphql(
        `#graphql
        mutation sellingPlanGroupRemoveProducts($id: ID!, $productIds: [ID!]!) {
          sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
            removedProductIds
            userErrors { field message }
          }
        }`,
        { variables: { id: shopifyGroupId, productIds: [productId] } },
      );
    } catch (err: any) {
      return json({ ok: false, error: `Remove failed: ${err?.message}` });
    }
    return json({ ok: true, error: null, intent: "remove_product" });
  }

  // ── Remove one or more variants ─────────────────────────────
  if (intent === "remove_variant") {
    const shopifyGroupId = formData.get("shopifyGroupId") as string;
    const variantIds = formData.getAll("variantId[]") as string[];
    if (!variantIds.length) {
      return json({ ok: false, error: "No variants to remove." });
    }
    try {
      await admin.graphql(
        `#graphql
        mutation sellingPlanGroupRemoveProductVariants($id: ID!, $productVariantIds: [ID!]!) {
          sellingPlanGroupRemoveProductVariants(id: $id, productVariantIds: $productVariantIds) {
            removedProductVariantIds
            userErrors { field message }
          }
        }`,
        { variables: { id: shopifyGroupId, productVariantIds: variantIds } },
      );
    } catch (err: any) {
      return json({ ok: false, error: `Remove failed: ${err?.message}` });
    }
    return json({ ok: true, error: null, intent: "remove_variant" });
  }

  // ── Delete ─────────────────────────────────────────────────
  if (intent === "delete") {
    const id = formData.get("id") as string;
    const group = await prisma.sellingPlanGroup.findFirst({
      where: { id, shop: session.shop },
    });
    if (group?.shopifyGroupId) {
      try {
        const res = await admin.graphql(
          `#graphql
          mutation sellingPlanGroupDelete($id: ID!) {
            sellingPlanGroupDelete(id: $id) {
              deletedSellingPlanGroupId
              userErrors { field message }
            }
          }`,
          { variables: { id: group.shopifyGroupId } },
        );
        // Must be read: a userErrors rejection still resolves as HTTP 200, and
        // dropping the local row anyway leaves a live, sellable group on the
        // storefront that this app can no longer see.
        const result     = await res.json();
        const userErrors = result?.data?.sellingPlanGroupDelete?.userErrors ?? [];
        if (userErrors.length > 0) {
          return json({
            ok: false,
            error: `Delete on Shopify failed: ${userErrors.map((e: { message: string }) => e.message).join(", ")}`,
          });
        }
      } catch (err: any) {
        return json({
          ok: false,
          error: `Delete on Shopify failed: ${err?.message}`,
        });
      }
    }
    await prisma.sellingPlanGroup.delete({ where: { id } });
    return json({ ok: true, error: null, intent: "delete" });
  }

  return json({ ok: false, error: `Unknown intent: ${intent}` });
}

// ─── Plan Card ────────────────────────────────────────────────
const PRODUCTS_PER_PAGE = 4;

function PlanCard({
  plan,
  isSubmitting,
  onEdit,
  onAssign,
  onRemove,
  onDelete,
}: {
  plan: PlanGroup;
  isSubmitting: boolean;
  onEdit: (plan: PlanGroup) => void;
  onAssign: (shopifyGroupId: string, localId: string) => void;
  onRemove: (
    shopifyGroupId: string,
    item:
      | { kind: "product"; id: string }
      | { kind: "variant"; ids: string[] },
  ) => void;
  onDelete: (id: string) => void;
}) {
  const [productPage, setProductPage] = useState(0);
  const [productFilter, setProductFilter] = useState("");

  // Which assigned products have their variant dropdown expanded
  const [expandedAssigned, setExpandedAssigned] = useState<Set<string>>(
    new Set(),
  );

  // ── Kebab (⋮) action menu ──
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Reset pagination whenever the filter changes
  useEffect(() => {
    setProductPage(0);
  }, [productFilter]);

  // Close the kebab menu on outside click / Escape
  useEffect(() => {
    if (!menuOpen) return;
    function handlePointer(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  const intervalLabel = formatIntervalLabel(plan.interval, plan.intervalCount);
  const isSynced = !!plan.shopifyGroupId;
  const allProducts = plan.assigned ?? [];
  const hasProducts = allProducts.length > 0;
  const noProducts = (plan.productCount ?? 0) === 0;

  // Filter assigned products by the inline search input (matches product and variant titles)
  const filteredProducts = productFilter.trim()
    ? allProducts.filter((p) => {
        const q = productFilter.trim().toLowerCase();
        return (
          p.title.toLowerCase().includes(q) ||
          p.variants.some((v) => v.title.toLowerCase().includes(q))
        );
      })
    : allProducts;

  function toggleAssignedExpand(productId: string) {
    setExpandedAssigned((prev) => {
      const next = new Set(prev);
      next.has(productId) ? next.delete(productId) : next.add(productId);
      return next;
    });
  }

  const totalPages = Math.max(
    1,
    Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE),
  );
  const safePage = Math.min(productPage, totalPages - 1);
  const pagedProducts = filteredProducts.slice(
    safePage * PRODUCTS_PER_PAGE,
    (safePage + 1) * PRODUCTS_PER_PAGE,
  );

  const detailRow: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 0",
    borderBottom: `0.5px solid var(--p-color-border-secondary)`,
  };
  const detailRowLast: React.CSSProperties = {
    ...detailRow,
    borderBottom: "none",
  };

  const rows = [
    { label: "Interval", value: intervalLabel, special: null },
    {
      label: "Discount",
      value:
        plan.discount > 0
          ? plan.discountType === "fixed_amount"
            ? `${plan.discount} off`
            : `${plan.discount}% off`
          : "None",
      special: "discount",
    },
    {
      label: "Shopify GID",
      value: plan.shopifyGroupId?.split("/").pop() ?? "—",
      special: "muted",
    },
    {
      label: "Products assigned",
      value: String(plan.productCount ?? 0),
      special: noProducts ? "warn" : null,
    },
  ] as const;

  return (
    <div
      onMouseEnter={(e) => applyCardHover(e.currentTarget)}
      onMouseLeave={(e) => clearCardHover(e.currentTarget)}
      style={{
        background: "var(--p-color-bg-surface)",
        border: "0.5px solid var(--p-color-border)",
        borderRadius: "16px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxShadow: "none",
        transition: "transform 0.18s ease, box-shadow 0.18s ease",
      }}
    >
      {/* ── Header ── */}


      <div
        style={{
          padding: "18px 20px 14px",
          borderBottom: "0.5px solid var(--p-color-border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
          <div
            style={{
              width: "38px",
              height: "38px",
              borderRadius: "50px",
              background: T.purpleBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {plan.interval === "DAY" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            ) : plan.interval === "WEEK" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            ) : plan.interval === "YEAR" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                <path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            )}
          </div>
          <div>
            <Text as="h3" variant="headingMd" fontWeight="bold">
              {plan.name}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {intervalLabel}
              {plan.discount > 0
                ? ` · ${plan.discountType === "fixed_amount" ? `${plan.discount} off` : `${plan.discount}% off`}`
                : ""}
            </Text>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexShrink: 0,
          }}
        >
          <div className="plancardsynced">
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                fontSize: "11px",
                fontWeight: 500,
                padding: "4px 10px",
                background: isSynced ? T.greenBg : T.amberBg,
                color: isSynced ? T.greenFg : T.amberFg,
                borderRadius: "20px",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: "5px",
                  height: "5px",
                  borderRadius: "50%",
                  background: isSynced ? T.greenDot : T.amberDot,
                  display: "inline-block",
                }}
                className="syncedindicator"
              />
              {isSynced ? "Synced to Shopify" : "Local only"}
            </div>
          </div>

          {/* ── Kebab (⋮) action menu ── */}
          <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              aria-label="Plan actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              style={{
                width: "30px",
                height: "30px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "8px",
                border: "0.5px solid var(--p-color-border)",
                background: menuOpen
                  ? "var(--p-color-bg-surface-secondary)"
                  : "var(--p-color-bg-surface)",
                color: "var(--p-color-text-subdued)",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            </button>

            {menuOpen && (
              <div
                role="menu"
                style={{
                  position: "absolute",
                  top: "36px",
                  right: 0,
                  minWidth: "170px",
                  background: "var(--p-color-bg-surface)",
                  border: "0.5px solid var(--p-color-border)",
                  borderRadius: "12px",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.14)",
                  padding: "6px",
                  zIndex: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={isSubmitting}
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit(plan);
                  }}
                  style={kebabItemStyle(T.purpleFg, isSubmitting)}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
                  </svg>
                  Edit plan
                </button>

                {isSynced && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isSubmitting}
                    onClick={() => {
                      setMenuOpen(false);
                      onAssign(plan.shopifyGroupId!, plan.id);
                    }}
                    style={kebabItemStyle(T.purpleFg, isSubmitting)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Assign product
                  </button>
                )}

                <button
                  type="button"
                  role="menuitem"
                  disabled={isSubmitting}
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete(plan.id);
                  }}
                  style={kebabItemStyle("#A32D2D", isSubmitting)}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                  Delete plan
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Detail rows ── */}
      <div style={{ padding: "4px 20px" }}>
        {rows.map(({ label, value, special }, i) => (
          <div
            key={label}
            style={i === rows.length - 1 ? detailRowLast : detailRow}
          >
            <Text as="span" variant="bodySm" tone="subdued">
              {label}
            </Text>
            {special === "warn" ? (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 500,
                  color: T.redFg,
                  background: T.redBg,
                  padding: "2px 8px",
                  borderRadius: "20px",
                }}
              >
                0 — assign a product
              </span>
            ) : special === "discount" && plan.discount > 0 ? (
              <span style={{ fontSize: "13px", fontWeight: 500, color: T.greenFg }} className="percent-text">
                {value}
              </span>
            ) : special === "muted" ? (
              <Text as="span" variant="bodySm" tone="subdued">
                {value}
              </Text>
            ) : (
              <Text as="span" variant="bodySm" fontWeight="semibold">
                {value}
              </Text>
            )}
          </div>
        ))}
      </div>

      {/* ── Inline product search (filters assigned products only) ── */}
      {hasProducts && (
        <div
          style={{
            padding: "10px 20px 4px",
          }}
          className="plancard-product-search"
        >
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: "12px",
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--p-color-text-subdued)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="text"
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
              placeholder="Search products..."
              style={{
                width: "100%",
                padding: "8px 12px 8px 34px",
                fontSize: "13px",
                border: "0.5px solid var(--p-color-border)",
                borderRadius: "9px",
                background: "var(--p-color-bg-surface)",
                color: "var(--p-color-text)",
                outline: "none",
              }}
            />
            {productFilter && (
              <button
                onClick={() => setProductFilter("")}
                aria-label="Clear search"
                style={{
                  position: "absolute",
                  right: "8px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--p-color-text-subdued)",
                  fontSize: "16px",
                  lineHeight: 1,
                  padding: "2px 6px",
                  borderRadius: "6px",
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Assigned products with pagination ── */}
      {hasProducts && (
        <>
          <div
            style={{
              padding: "8px 20px 6px",
              background: "var(--p-color-bg-surface-secondary)",
              borderTop: "0.5px solid var(--p-color-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Text as="p" variant="bodySm" tone="subdued">
              Assigned products
              {productFilter && (
                <span style={{ marginLeft: "6px", color: T.purpleFg }}>
                  ({filteredProducts.length} match
                  {filteredProducts.length === 1 ? "" : "es"})
                </span>
              )}
            </Text>
            {totalPages > 1 && (
              <span style={{ fontSize: "11px", color: T.purpleFg, fontWeight: 500 }}>
                {safePage + 1} / {totalPages}
              </span>
            )}
          </div>

          <div
            style={{
              padding: "8px 20px 14px",
              background: "var(--p-color-bg-surface-secondary)",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            {pagedProducts.length === 0 ? (
              <div
                style={{
                  padding: "20px 12px",
                  textAlign: "center",
                  background: "var(--p-color-bg-surface)",
                  border: "0.5px dashed var(--p-color-border)",
                  borderRadius: "10px",
                }}
              >
                <Text as="p" variant="bodySm" tone="subdued">
                  No assigned products match "{productFilter}".
                </Text>
              </div>
            ) : (
              pagedProducts.map((product) => {
                const isExpanded = expandedAssigned.has(product.id);
                const hasVariants =
                  !product.whole && product.variants.length > 0;
                return (
                  <div
                    key={product.id}
                    style={{
                      background: "var(--p-color-bg-surface)",
                      border: "0.5px solid var(--p-color-border)",
                      borderRadius: "10px",
                      overflow: "hidden",
                    }}
                  >
                    {/* Product row */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        padding: "10px 12px",
                      }}
                    >
                      <div
                        style={{
                          width: "34px",
                          height: "34px",
                          borderRadius: "8px",
                          background: T.tealBg,
                          overflow: "hidden",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {product.image ? (
                          <img
                            src={product.image}
                            alt={product.title}
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.tealStroke} strokeWidth="2">
                            <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                            <line x1="3" y1="6" x2="21" y2="6" />
                          </svg>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text as="p" variant="bodySm" fontWeight="semibold">
                          {product.title}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {product.id.split("/").pop()}
                        </Text>
                      </div>

                      {/* Variants dropdown toggle */}
                      {hasVariants && (
                        <button
                          type="button"
                          aria-label={isExpanded ? "Hide variants" : "Show variants"}
                          aria-expanded={isExpanded}
                          onClick={() => toggleAssignedExpand(product.id)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            fontSize: "12px",
                            fontWeight: 500,
                            color: T.purpleFg,
                            background: "var(--p-color-bg-surface)",
                            border: `0.5px solid #C8C3F2`,
                            borderRadius: "8px",
                            padding: "5px 10px",
                            cursor: "pointer",
                            flexShrink: 0,
                          }}
                        >
                          {product.variants.length} variant
                          {product.variants.length > 1 ? "s" : ""}
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{
                              transform: isExpanded ? "rotate(180deg)" : "none",
                              transition: "transform 0.15s ease",
                            }}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      )}

                      <button
                        onClick={() =>
                          onRemove(
                            plan.shopifyGroupId!,
                            product.whole
                              ? { kind: "product", id: product.id }
                              : {
                                  kind: "variant",
                                  ids: product.variants.map((v) => v.id),
                                },
                          )
                        }
                        disabled={isSubmitting}
                        style={{
                          fontSize: "12px",
                          padding: "5px 12px",
                          border: `0.5px solid ${T.redBorder}`,
                          borderRadius: "8px",
                          background: "var(--p-color-bg-surface)",
                          color: "#A32D2D",
                          cursor: "pointer",
                          flexShrink: 0,
                          opacity: isSubmitting ? 0.6 : 1,
                        }}  className="remove-button"
                      >
                        Remove
                      </button>
                    </div>

                    {/* Selected-variant dropdown */}
                    {hasVariants && isExpanded && (
                      <div
                        style={{
                          borderTop: "0.5px solid var(--p-color-border)",
                          background: "var(--p-color-bg-surface-secondary)",
                          padding: "8px 12px 8px 46px",
                          display: "flex",
                          flexDirection: "column",
                          gap: "6px",
                        }}
                      >
                        {product.variants.map((v) => (
                          <div
                            key={v.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              padding: "6px 10px",
                              background: "var(--p-color-bg-surface)",
                              border: "0.5px solid var(--p-color-border)",
                              borderRadius: "8px",
                            }}
                          >
                            <span
                              style={{
                                width: "5px",
                                height: "5px",
                                borderRadius: "50%",
                                background: T.purple,
                                flexShrink: 0,
                              }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Text as="span" variant="bodySm">
                                {v.title}
                              </Text>
                            </div>
                            {v.price && (
                              <Text as="span" variant="bodySm" tone="subdued">
                                {v.price}
                              </Text>
                            )}
                            <button
                              onClick={() =>
                                onRemove(plan.shopifyGroupId!, {
                                  kind: "variant",
                                  ids: [v.id],
                                })
                              }
                              disabled={isSubmitting}
                              aria-label={`Remove ${v.title}`}
                              style={{
                                fontSize: "15px",
                                lineHeight: 1,
                                width: "22px",
                                height: "22px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                border: `0.5px solid ${T.redBorder}`,
                                borderRadius: "6px",
                                background: "var(--p-color-bg-surface)",
                                color: "#A32D2D",
                                cursor: "pointer",
                                flexShrink: 0,
                                opacity: isSubmitting ? 0.6 : 1,
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div style={{ display: "flex", gap: "6px", justifyContent: "center", marginTop: "4px" }}>
                <button
                  onClick={() => setProductPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12px",
                    borderRadius: "8px",
                    border: `0.5px solid #C8C3F2`,
                    background: safePage === 0 ? "var(--p-color-bg-surface-disabled)" : "var(--p-color-bg-surface)",
                    color: safePage === 0 ? "var(--p-color-text-disabled)" : T.purpleFg,
                    cursor: safePage === 0 ? "not-allowed" : "pointer",
                  }}
                >
                  ← Prev
                </button>
                {Array.from({ length: totalPages }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => setProductPage(i)}
                    style={{
                      width: "28px",
                      height: "28px",
                      fontSize: "12px",
                      borderRadius: "8px",
                      border: `0.5px solid ${i === safePage ? T.purple : "#C8C3F2"}`,
                      background: i === safePage ? T.purpleBg : "var(--p-color-bg-surface)",
                      color: i === safePage ? T.purpleFg : "var(--p-color-text-subdued)",
                      cursor: "pointer",
                      fontWeight: i === safePage ? 600 : 400,
                    }}
                  >
                    {i + 1}
                  </button>
                ))}
                <button
                  onClick={() => setProductPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage === totalPages - 1}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12px",
                    borderRadius: "8px",
                    border: `0.5px solid #C8C3F2`,
                    background: safePage === totalPages - 1 ? "var(--p-color-bg-surface-disabled)" : "var(--p-color-bg-surface)",
                    color: safePage === totalPages - 1 ? "var(--p-color-text-disabled)" : T.purpleFg,
                    cursor: safePage === totalPages - 1 ? "not-allowed" : "pointer",
                  }}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Footer action — Assign only (Edit/Delete live in the ⋮ menu) ── */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          padding: "14px 20px",
          borderTop: "0.5px solid var(--p-color-border)",
          marginTop: "auto",
        }}
      >
        {isSynced ? (
          <button
            onClick={() => onAssign(plan.shopifyGroupId!, plan.id)}
            disabled={isSubmitting}
            style={{
              flex: 1,
              background: T.purpleDark,
              color: T.purpleBg,
              border: "none",
              padding: "9px",
              borderRadius: "9px",
              fontSize: "13px",
              fontWeight: 500,
              cursor: "pointer",
              opacity: isSubmitting ? 0.7 : 1,
            }} className="assign-button"
          >
            + Assign product
          </button>
        ) : (
          <button
            onClick={() => onEdit(plan)}
            disabled={isSubmitting}
            style={{
              flex: 1,
              background: "var(--p-color-bg-surface)",
              color: T.purpleFg,
              border: "0.5px solid #C8C3F2",
              padding: "9px 16px",
              borderRadius: "9px",
              fontSize: "13px",
              cursor: "pointer",
              opacity: isSubmitting ? 0.7 : 1,
            }} className="edit-button"
          >
            Edit plan
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Hero + stats row ─────────────────────────────────────────
function StatCell({
  icon,
  value,
  label,
  color,
  bg,
  showDivider,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  color: string;
  bg: string;
  showDivider: boolean;
}) {
  return (
    <div
      style={{
        flex: "1 1 160px",
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "14px 18px",
        borderRight: showDivider ? "0.5px solid var(--p-color-border)" : "none",
      }}
    >
      <div
        style={{
          width: "42px",
          height: "42px",
          borderRadius: "12px",
          background: bg,
          color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "19px", fontWeight: 700, color, lineHeight: 1.2 }}>
          {value}
        </div>
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
      </div>
    </div>
  );
}

function HeroStatsRow({
  planCount,
  planLabel,
  planLimit,
  unlimited,
  activeSubs,
  avgDiscount,
  monthlyRevenue,
}: {
  planCount: number;
  planLabel: string;
  planLimit: number;
  unlimited: boolean;
  activeSubs: number;
  avgDiscount: number;
  monthlyRevenue: number;
}) {
  const heroHeading = unlimited
    ? `Unlimited plans on ${planLabel}`
    : `${planCount} of ${planLimit} plans used`;
  const heroBody = unlimited
    ? "Create unlimited subscription plans and customize them as per your business needs."
    : `You're on the ${planLabel} plan. Upgrade any time to create more selling plans.`;

  return (
    <div
      style={{
        display: "flex",
        gap: "16px",
        flexWrap: "wrap",
        alignItems: "stretch",
      }}
    >
      {/* Left — tier card */}
      <div
        onMouseEnter={(e) => applyCardHover(e.currentTarget)}
        onMouseLeave={(e) => clearCardHover(e.currentTarget)}
        style={{
          flex: "1 1 280px",
          minWidth: 0,
          background: "var(--p-color-bg-surface)",
          border: "0.5px solid var(--p-color-border)",
          borderRadius: "20px",
          padding: "20px",
          display: "flex",
          gap: "14px",
          alignItems: "flex-start",
          boxShadow: "none",
          transition: "transform 0.18s ease, box-shadow 0.18s ease",
        }}
      >
        <div
          style={{
            width: "44px",
            height: "44px",
            borderRadius: "12px",
            background: T.statPurpleBg,
            color: T.statPurple,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" />
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <span
            style={{
              display: "inline-block",
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: T.statGreen,
              background: T.statGreenBg,
              borderRadius: "20px",
              padding: "3px 10px",
              marginBottom: "8px",
            }}
          >
            {planLabel}
          </span>
          <Text as="h3" variant="headingMd" fontWeight="bold">
            {heroHeading}
          </Text>
          <div style={{ marginTop: "4px" }}>
            <Text as="p" variant="bodySm" tone="subdued">
              {heroBody}
            </Text>
          </div>
        </div>
      </div>

      {/* Right — stats card */}
      <div
        onMouseEnter={(e) => applyCardHover(e.currentTarget)}
        onMouseLeave={(e) => clearCardHover(e.currentTarget)}
        style={{
          flex: "2 1 520px",
          minWidth: 0,
          background: "var(--p-color-bg-surface)",
          border: "0.5px solid var(--p-color-border)",
          borderRadius: "20px",
          padding: "6px",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          boxShadow: "none",
          transition: "transform 0.18s ease, box-shadow 0.18s ease",
        }}
      >
        <StatCell
          value={String(planCount)}
          label="Active Plans"
          color={T.statPurple}
          bg={T.statPurpleBg}
          showDivider
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          }
        />
        <StatCell
          value={String(activeSubs)}
          label="Active Subscriptions"
          color={T.statGreen}
          bg={T.statGreenBg}
          showDivider
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 01-9 9M3 12a9 9 0 019-9" />
              <polyline points="21 3 21 8 16 8" />
              <polyline points="3 21 3 16 8 16" />
            </svg>
          }
        />
        <StatCell
          value={`${avgDiscount.toFixed(1)}%`}
          label="Avg. Discount"
          color={T.statAmber}
          bg={T.statAmberBg}
          showDivider
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
              <line x1="7" y1="7" x2="7.01" y2="7" />
            </svg>
          }
        />
        <StatCell
          value={formatCurrency(monthlyRevenue)}
          label="Monthly Revenue"
          color={T.statBlue}
          bg={T.statBlueBg}
          showDivider={false}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="9" y1="13" x2="15" y2="13" />
              <line x1="9" y1="17" x2="13" y2="17" />
            </svg>
          }
        />
      </div>
    </div>
  );
}

// ─── Help sidebar ─────────────────────────────────────────────
function HelpSidebar() {
  const tips = [
    "Offer attractive discounts to increase subscription sign-ups.",
    "Assign relevant products to each plan for better conversion.",
    "Monitor performance in Reports and optimize your plans.",
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Subscription Tips */}
      <div
        onMouseEnter={(e) => applyCardHover(e.currentTarget)}
        onMouseLeave={(e) => clearCardHover(e.currentTarget)}
        style={{
          background: "var(--p-color-bg-surface)",
          border: "0.5px solid var(--p-color-border)",
          borderRadius: "16px",
          padding: "18px 20px",
          boxShadow: "none",
          transition: "transform 0.18s ease, box-shadow 0.18s ease",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "9px",
            marginBottom: "14px",
          }}
        >
          <div
            style={{
              width: "30px",
              height: "30px",
              borderRadius: "9px",
              background: T.statAmberBg,
              color: T.statAmber,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0012 2z" />
            </svg>
          </div>
          <Text as="h3" variant="headingSm" fontWeight="bold">
            Subscription Tips
          </Text>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {tips.map((tip) => (
            <div key={tip} style={{ display: "flex", gap: "9px", alignItems: "flex-start" }}>
              <span
                style={{
                  color: T.statGreen,
                  flexShrink: 0,
                  marginTop: "1px",
                  display: "flex",
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <Text as="p" variant="bodySm" tone="subdued">
                {tip}
              </Text>
            </div>
          ))}
        </div>
      </div>

      {/* Need Help? */}
      <div
        onMouseEnter={(e) => applyCardHover(e.currentTarget)}
        onMouseLeave={(e) => clearCardHover(e.currentTarget)}
        style={{
          background: T.purpleBg,
          border: "0.5px solid #D9D5F7",
          borderRadius: "16px",
          padding: "18px 20px",
          boxShadow: "none",
          transition: "transform 0.18s ease, box-shadow 0.18s ease",
        }}
      >
        <Text as="h3" variant="headingSm" fontWeight="bold">
          <span style={{ color: T.purpleFg }}>Need Help?</span>
        </Text>
        <div style={{ margin: "6px 0 14px" }}>
          <Text as="p" variant="bodySm">
            <span style={{ color: T.purpleMid }}>
              Visit our Help Center or contact our support team.
            </span>
          </Text>
        </div>
        <a
          href="https://help.shopify.com/en/manual/products/purchase-options/shopify-subscriptions"
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            padding: "9px 16px",
            fontSize: "13px",
            fontWeight: 600,
            color: T.purpleFg,
            background: "var(--p-color-bg-surface)",
            border: "0.5px solid #C8C3F2",
            borderRadius: "10px",
            textDecoration: "none",
            boxSizing: "border-box",
          }}
        >
          Go to Help Center
        </a>
      </div>
    </div>
  );
}

// ─── Page component ───────────────────────────────────────────
export default function Plans() {
  const { planGroups, planLimit, planLabel, allProducts, stats } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const activeIntent = navigation.formData?.get("intent");
  const isSavingPlan =
    isSubmitting && (activeIntent === "create" || activeIntent === "update");

  const unlimited = isUnlimitedLimit(planLimit);
  const atLimit = !unlimited && planGroups.length >= planLimit;

  // ── Plan editor modal state ──
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [name, setName] = useState(defaultPlanFormValues().name);
  const [interval, setInterval] = useState(defaultPlanFormValues().interval);
  const [intervalCount, setIntervalCount] = useState(
    defaultPlanFormValues().intervalCount,
  );
  const [discount, setDiscount] = useState(defaultPlanFormValues().discount);
  const [discountType, setDiscountType] = useState(defaultPlanFormValues().discountType);

  // ── Product picker modal state ──
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [pickerTargetGroupId, setPickerTargetGroupId] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(
    new Set(),
  );
  // Individual variant selections (only for products not selected as a whole)
  const [selectedVariantIds, setSelectedVariantIds] = useState<Set<string>>(
    new Set(),
  );
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(
    new Set(),
  );
  const [variantsByProduct, setVariantsByProduct] = useState<
    Record<string, PickerVariant[]>
  >({});
  const [isAssigning, setIsAssigning] = useState(false);

  // Lazy variant loader — fetches a product's variants on demand
  const variantFetcher = useFetcher<{
    intent?: string;
    productId?: string;
    variants?: PickerVariant[];
  }>();

  useEffect(() => {
    const data = variantFetcher.data;
    if (data?.intent === "fetch_variants" && data.productId) {
      setVariantsByProduct((prev) => ({
        ...prev,
        [data.productId as string]: data.variants ?? [],
      }));
    }
  }, [variantFetcher.data]);

  const totalSelected = selectedProductIds.size + selectedVariantIds.size;

  const filteredProducts = allProducts.filter((p: PickerProduct) =>
    p.title.toLowerCase().includes(productSearch.toLowerCase()),
  );

  // ── Plan list toolbar (search / sort / tenure) ──
  const [planSearch, setPlanSearch] = useState("");
  const [planSort, setPlanSort] = useState("newest");
  const [planTenure, setPlanTenure] = useState("all");

  const visiblePlans = useMemo(() => {
    let list = planGroups.slice();

    // Filter by tenure (plan interval)
    if (planTenure !== "all") {
      list = list.filter((p) => p.interval === planTenure);
    }

    // Filter by name search
    const q = planSearch.trim().toLowerCase();
    if (q) {
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }

    // Sort
    list.sort((a, b) => {
      switch (planSort) {
        case "asc":
          return a.name.localeCompare(b.name);
        case "desc":
          return b.name.localeCompare(a.name);
        case "oldest":
          return (
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        case "newest":
        default:
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
      }
    });

    return list;
  }, [planGroups, planSearch, planSort, planTenure]);

  const resetPlanFilters = useCallback(() => {
    setPlanSearch("");
    setPlanSort("newest");
    setPlanTenure("all");
  }, []);

  // ── Toast state ──
  const [toastActive, setToastActive] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [toastIsError, setToastIsError] = useState(false);

  useEffect(() => {
    if (!actionData) return;
    if (!("ok" in actionData)) return;

    if (actionData.error) {
      setToastMsg(actionData.error);
      setToastIsError(true);
      setToastActive(true);
      setIsAssigning(false);
    } else if (actionData.ok) {
      const msgs: Record<string, string> = {
        create: "Selling plan created!",
        update: "Selling plan updated.",
        assign_products_bulk: "Products assigned to plan!",
        remove_product: "Product removed from plan.",
        remove_variant: "Variant removed from plan.",
        delete: "Plan deleted.",
      };
      setToastMsg(msgs[(actionData as any).intent] ?? "Done!");
      setToastIsError(false);
      setToastActive(true);
      setIsAssigning(false);

      if (
        (actionData as any).intent === "create" ||
        (actionData as any).intent === "update"
      ) {
        setEditorOpen(false);
        setEditingPlanId(null);
      }
      if ((actionData as any).intent === "assign_products_bulk") {
        setProductPickerOpen(false);
        clearAllSelections();
      }
    }
  }, [actionData]);

  const clearAllSelections = useCallback(() => {
    setSelectedProductIds(new Set());
    setSelectedVariantIds(new Set());
    setExpandedProducts(new Set());
  }, []);

  const openProductPicker = useCallback(
    (shopifyGroupId: string, _localId: string) => {
      setPickerTargetGroupId(shopifyGroupId);
      setProductSearch("");
      clearAllSelections();
      setProductPickerOpen(true);
    },
    [clearAllSelections],
  );

  function toggleProductSelection(product: PickerProduct) {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(product.id)) {
        next.delete(product.id);
      } else {
        next.add(product.id);
      }
      return next;
    });
    // Selecting a whole product supersedes any individual variant picks for it
    const variantIds = (variantsByProduct[product.id] ?? []).map((v) => v.id);
    if (variantIds.length) {
      setSelectedVariantIds((prev) => {
        const next = new Set(prev);
        variantIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  }

  function toggleProductExpand(product: PickerProduct) {
    setExpandedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(product.id)) {
        next.delete(product.id);
      } else {
        next.add(product.id);
        // Fetch variants the first time this product is expanded
        if (!variantsByProduct[product.id]) {
          const fd = new FormData();
          fd.append("intent", "fetch_variants");
          fd.append("productId", product.id);
          variantFetcher.submit(fd, { method: "post" });
        }
      }
      return next;
    });
  }

  function toggleVariantSelection(productId: string, variantId: string) {
    const allVariantIds = (variantsByProduct[productId] ?? []).map((v) => v.id);
    const wholeSelected = selectedProductIds.has(productId);

    // Effective current variant selection for this product
    const current = new Set(
      wholeSelected
        ? allVariantIds
        : allVariantIds.filter((id) => selectedVariantIds.has(id)),
    );
    current.has(variantId) ? current.delete(variantId) : current.add(variantId);

    const allNowSelected =
      allVariantIds.length > 0 && current.size === allVariantIds.length;

    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      // All variants chosen → consolidate to a whole-product selection
      if (allNowSelected) next.add(productId);
      else next.delete(productId);
      return next;
    });
    setSelectedVariantIds((prev) => {
      const next = new Set(prev);
      // Reset this product's variant picks, then write the individual ones
      allVariantIds.forEach((id) => next.delete(id));
      if (!allNowSelected) current.forEach((id) => next.add(id));
      return next;
    });
  }

  function handleBulkAssign() {
    if (totalSelected === 0) return;
    setIsAssigning(true);
    const fd = new FormData();
    fd.append("intent", "assign_products_bulk");
    fd.append("shopifyGroupId", pickerTargetGroupId);
    selectedProductIds.forEach((id) => fd.append("productId[]", id));
    selectedVariantIds.forEach((id) => fd.append("variantId[]", id));
    submit(fd, { method: "post" });
  }

  function handleCreate() {
    if (!name.trim()) return;
    const fd = new FormData();
    fd.append("intent", editingPlanId ? "update" : "create");
    if (editingPlanId) fd.append("id", editingPlanId);
    fd.append("name", name.trim());
    fd.append("interval", interval);
    fd.append("intervalCount", intervalCount);
    fd.append("discount", discount || "0");
    fd.append("discountType", discountType);
    submit(fd, { method: "post" });
  }

  function handleOpenCreate() {
    if (atLimit) return;
    const defaults = defaultPlanFormValues();
    setEditingPlanId(null);
    setName(defaults.name);
    setInterval(defaults.interval);
    setIntervalCount(defaults.intervalCount);
    setDiscount(defaults.discount);
    setDiscountType(defaults.discountType);
    setEditorOpen(true);
  }

  function handleOpenEdit(plan: PlanGroup) {
    setEditingPlanId(plan.id);
    setName(plan.name);
    setInterval(plan.interval);
    setIntervalCount(plan.intervalCount.toString());
    setDiscount(plan.discount.toString());
    setDiscountType(plan.discountType ?? "percentage");
    setEditorOpen(true);
  }

  function handleCloseEditor() {
    setEditorOpen(false);
    setEditingPlanId(null);
  }

  function handleRemove(
    shopifyGroupId: string,
    item:
      | { kind: "product"; id: string }
      | { kind: "variant"; ids: string[] },
  ) {
    const fd = new FormData();
    fd.append("shopifyGroupId", shopifyGroupId);
    if (item.kind === "variant") {
      if (item.ids.length === 0) return;
      fd.append("intent", "remove_variant");
      item.ids.forEach((id) => fd.append("variantId[]", id));
    } else {
      fd.append("intent", "remove_product");
      fd.append("productId", item.id);
    }
    submit(fd, { method: "post" });
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this selling plan from Shopify?")) return;
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", id);
    submit(fd, { method: "post" });
  }

  return (
    <Frame>
      <Page fullWidth>
        <TitleBar title="Selling Plans" />

        <BlockStack gap="500">
          {/* ── Page header ── */}
          <div className="page-Selling plans">
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h1" variant="headingXl" fontWeight="bold">
                Selling Plans
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Create and manage smart subscription plans for your products
              </Text>
            </BlockStack>

            <div style={{ position: "relative" }}>
              {atLimit ? (
                <button
                  disabled
                  title={`Upgrade from ${planLabel} to create more plans`}
                  style={{
                    background: "var(--p-color-bg-surface-disabled)",
                    color: "var(--p-color-text-disabled)",
                    border: "0.5px solid var(--p-color-border-disabled)",
                    padding: "9px 18px",
                    borderRadius: "9px",
                    fontSize: "13px",
                    fontWeight: 500,
                    cursor: "not-allowed",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                  + Create Plan
                </button>
              ) : (
                <Button variant="primary" onClick={handleOpenCreate}>
                  + Create Plan
                </Button>
              )}
            </div>
          </InlineStack>
      </div>
          {/* ── Hero + stats row ── */}
          <HeroStatsRow
            planCount={planGroups.length}
            planLabel={planLabel}
            planLimit={planLimit}
            unlimited={unlimited}
            activeSubs={stats.activeSubs}
            avgDiscount={stats.avgDiscount}
            monthlyRevenue={stats.monthlyRevenue}
          />

          {/* ── Limit-reached upgrade banner — only shown for non-unlimited plans ── */}

          {atLimit && (
            <div
              style={{
                background: T.redBg,
                border: `0.5px solid ${T.redBorder}`,
                borderRadius: "12px",
                padding: "14px 18px",
                display: "flex",
                gap: "12px",
                alignItems: "flex-start",
              }}
            >
              <div
                style={{
                  width: "20px",
                  height: "20px",
                  borderRadius: "50%",
                  background: "#C94040",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "11px",
                  fontWeight: 700,
                  flexShrink: 0,
                  marginTop: "1px",
                }}
              >
                !
              </div>
              <div style={{ flex: 1 }}>
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  <span style={{ color: T.redFg }}>
                    Plan limit reached ({planGroups.length}/{planLimit})
                  </span>
                </Text>
                <Text as="p" variant="bodySm">
                  <span style={{ color: "#A32D2D" }}>
                    Your <strong>{planLabel}</strong> plan allows up to{" "}
                    <strong>{planLimit}</strong> selling plan
                    {planLimit === 1 ? "" : "s"}. Upgrade to Pro or Advanced to
                    unlock more.
                  </span>
                </Text>
              </div>
              <a
                href="/app/billing"
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: T.redFg,
                  background: "#fff",
                  border: `0.5px solid ${T.redBorder}`,
                  borderRadius: "8px",
                  padding: "6px 14px",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                Upgrade →
              </a>
            </div>
          )}

          {/* Error banner — only for non-limit errors */}
          {actionData &&
            "ok" in actionData &&
            actionData.error &&
            !atLimit && (
              <Banner title="Error" tone="critical">
                <Text as="p">{actionData.error}</Text>
              </Banner>
            )}

          {/* ── Info banner ── */}
          <div
            style={{
              background: T.purpleBg,
              border: `0.5px solid #AFA9EC`,
              borderRadius: "16px",
              padding: "16px 20px",
              display: "flex",
              gap: "14px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                width: "34px",
                height: "34px",
                borderRadius: "10px",
                background: T.statPurple,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: "220px" }}>
              <Text as="p" variant="bodySm" fontWeight="semibold">
                <span style={{ color: T.purpleFg }} className="enable-subs">
                  How to create subscriptions on a product
                </span>
              </Text>
              <Text as="p" variant="bodySm">
                <span style={{ color: T.purpleMid }} className="enable-subs-text">
                  After creating a plan, click "Assign product" on the card below.
                  A product picker will open — that product will immediately show a
                  "Subscribe &amp; Save" option at checkout.
                </span>
              </Text>
            </div>
            <a
              href="https://help.shopify.com/en/manual/products/purchase-options/shopify-subscriptions"
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: T.purpleFg,
                background: "var(--p-color-bg-surface)",
                border: "0.5px solid #C8C3F2",
                borderRadius: "10px",
                padding: "8px 16px",
                textDecoration: "none",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              Learn More
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>
          {/* ── Two-column body: plans (left) + help sidebar (right) ── */}
          <div
            style={{
              display: "flex",
              gap: "20px",
              alignItems: "flex-start",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 600px", minWidth: 0 }}>
              {/* Empty state */}
              {planGroups.length === 0 && (
                <div
                  style={{
                    background: "var(--p-color-bg-surface)",
                    border: "0.5px solid var(--p-color-border)",
                    borderRadius: "16px",
                    padding: "56px 24px",
                    textAlign: "center",
                  }}
                >
                  <BlockStack gap="300" inlineAlign="center">
                    <div
                      style={{
                        width: "48px",
                        height: "48px",
                        borderRadius: "12px",
                        background: T.purpleBg,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        margin: "0 auto",
                      }}
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={T.purple} strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </div>
                    <Text as="p" variant="headingMd" fontWeight="bold">
                      No selling plans yet
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Create your first plan to enable subscriptions at checkout.
                    </Text>
                    <Button variant="primary" onClick={handleOpenCreate}>
                      Create your first plan
                    </Button>
                  </BlockStack>
                </div>
              )}

              {/* Toolbar + plan cards grid */}
              {planGroups.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "16px",
                  }}
                >
                  {/* ── Search / sort / tenure toolbar ── */}
                  <div
                    style={{
                      background: "var(--p-color-bg-surface)",
                      border: "0.5px solid var(--p-color-border)",
                      borderRadius: "14px",
                      padding: "12px 14px",
                      display: "flex",
                      gap: "12px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* Search */}
                    <div
                      style={{
                        position: "relative",
                        display: "flex",
                        alignItems: "center",
                        flex: "1 1 220px",
                        minWidth: "180px",
                      }}
                    >
                      <span
                        style={{
                          position: "absolute",
                          left: "12px",
                          top: "50%",
                          transform: "translateY(-50%)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          pointerEvents: "none",
                        }}
                      >
                        <svg
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="var(--p-color-text-subdued)"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="11" cy="11" r="8" />
                          <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                      </span>
                      <input
                        type="text"
                        value={planSearch}
                        onChange={(e) => setPlanSearch(e.target.value)}
                        placeholder="Search plans..."
                        style={{
                          width: "100%",
                          padding: "9px 30px 9px 36px",
                          fontSize: "13px",
                          border: "0.5px solid var(--p-color-border)",
                          borderRadius: "10px",
                          background: "var(--p-color-bg-surface)",
                          color: "var(--p-color-text)",
                          outline: "none",
                        }}
                      />
                      {planSearch && (
                        <button
                          onClick={() => setPlanSearch("")}
                          aria-label="Clear search"
                          style={{
                            position: "absolute",
                            right: "8px",
                            top: "50%",
                            transform: "translateY(-50%)",
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--p-color-text-subdued)",
                            fontSize: "16px",
                            lineHeight: 1,
                            padding: "2px 6px",
                            borderRadius: "6px",
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>

                    {/* Subscription sort */}
                    <div style={{ minWidth: "170px" }}>
                      <Select
                        label="Subscription"
                        labelInline
                        options={[
                          { label: "Ascending (A–Z)", value: "asc" },
                          { label: "Descending (Z–A)", value: "desc" },
                          { label: "Newest", value: "newest" },
                          { label: "Oldest", value: "oldest" },
                        ]}
                        value={planSort}
                        onChange={setPlanSort}
                      />
                    </div>

                    {/* Tenure filter */}
                    <div style={{ minWidth: "160px" }}>
                      <Select
                        label="Tenure"
                        labelInline
                        options={[
                          { label: "All tenures", value: "all" },
                          { label: "Daily", value: "DAY" },
                          { label: "Weekly", value: "WEEK" },
                          { label: "Monthly", value: "MONTH" },
                          { label: "Yearly", value: "YEAR" },
                        ]}
                        value={planTenure}
                        onChange={setPlanTenure}
                      />
                    </div>
                  </div>

                  {/* Grid or no-results */}
                  {visiblePlans.length > 0 ? (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))",
                        gap: "16px",
                      }}
                    >
                      {visiblePlans.map((g) => (
                        <PlanCard
                          key={g.id}
                          plan={g}
                          isSubmitting={isSubmitting}
                          onEdit={handleOpenEdit}
                          onAssign={openProductPicker}
                          onRemove={handleRemove}
                          onDelete={handleDelete}
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      style={{
                        background: "var(--p-color-bg-surface)",
                        border: "0.5px dashed var(--p-color-border)",
                        borderRadius: "14px",
                        padding: "40px 24px",
                        textAlign: "center",
                      }}
                    >
                      <BlockStack gap="200" inlineAlign="center">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          No plans match your search or filters
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Try a different search term or tenure.
                        </Text>
                        <button
                          onClick={resetPlanFilters}
                          style={{
                            marginTop: "4px",
                            fontSize: "13px",
                            fontWeight: 600,
                            color: T.purpleFg,
                            background: "var(--p-color-bg-surface)",
                            border: "0.5px solid #C8C3F2",
                            borderRadius: "10px",
                            padding: "8px 16px",
                            cursor: "pointer",
                          }}
                        >
                          Clear filters
                        </button>
                      </BlockStack>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right — help sidebar */}
            <div
              style={{
                flex: "1 1 280px",
                minWidth: "260px",
                maxWidth: "360px",
              }}
            >
              <HelpSidebar />
            </div>
          </div>
        </BlockStack>

        {/* ── Create / edit plan modal ── */}
        <Modal
          open={editorOpen}
          onClose={handleCloseEditor}
          title={editingPlanId ? "Edit selling plan" : "Create selling plan"}
          primaryAction={{
            content: editingPlanId ? "Save changes" : "Create plan",
            loading: isSavingPlan,
            onAction: handleCreate,
          }}
          secondaryActions={[
            { content: "Cancel", onAction: handleCloseEditor },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              {actionData && "ok" in actionData && actionData.error && (
                <Banner tone="critical">
                  <Text as="p">{actionData.error}</Text>
                </Banner>
              )}
              <TextField
                label="Plan name"
                value={name}
                onChange={setName}
                autoComplete="off"
                helpText='e.g. "Monthly Coffee Club"'
              />
              <Select
                label="Billing interval"
                options={[...INTERVAL_OPTIONS]}
                value={interval}
                onChange={setInterval}
              />
              <TextField
                label="Every how many intervals?"
                value={intervalCount}
                onChange={setIntervalCount}
                type="number"
                autoComplete="off"
                helpText='"1" = every month, "3" = every 3 months'
              />
              <Select
                label="Discount type"
                options={[
                  { label: "Percentage (%)", value: "percentage" },
                  { label: "Fixed amount", value: "fixed_amount" },
                ]}
                value={discountType}
                onChange={setDiscountType}
              />
              <TextField
                label={discountType === "fixed_amount" ? "Discount (fixed amount)" : "Discount (%)"}
                value={discount}
                onChange={setDiscount}
                type="number"
                autoComplete="off"
                suffix={discountType === "percentage" ? "%" : undefined}
                helpText="Set to 0 for no discount"
              />
            </BlockStack>
          </Modal.Section>
        </Modal>

        {/* ── Multi-product / variant picker modal ── */}
        <Modal
          open={productPickerOpen}
          onClose={() => {
            setProductPickerOpen(false);
            clearAllSelections();
          }}
          title="Add products"
          primaryAction={{
            content:
              totalSelected > 0
                ? `Add ${totalSelected} item${totalSelected > 1 ? "s" : ""}`
                : "Add",
            disabled: totalSelected === 0 || isAssigning,
            loading: isAssigning,
            onAction: handleBulkAssign,
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => {
                setProductPickerOpen(false);
                clearAllSelections();
              },
            },
          ]}
        >
          <Modal.Section>
            <TextField
              label=""
              placeholder="Search products..."
              value={productSearch}
              onChange={(val) => setProductSearch(val)}
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setProductSearch("")}
            />
          </Modal.Section>

          <Modal.Section>
            {filteredProducts.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px 0" }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  {productSearch
                    ? "No products match your search."
                    : "No products found in your store."}
                </Text>
              </div>
            ) : (
              <BlockStack gap="200">
                {totalSelected > 0 && (
                  <div
                    style={{
                      padding: "8px 12px",
                      background: T.purpleBg,
                      border: `0.5px solid #C8C3F2`,
                      borderRadius: "8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      <span style={{ color: T.purpleFg }}>
                        {totalSelected} item{totalSelected > 1 ? "s" : ""} selected
                        {selectedVariantIds.size > 0
                          ? ` (${selectedVariantIds.size} variant${selectedVariantIds.size > 1 ? "s" : ""})`
                          : ""}
                      </span>
                    </Text>
                    <button
                      onClick={clearAllSelections}
                      style={{
                        fontSize: "11px",
                        color: T.purpleFg,
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "0",
                        textDecoration: "underline",
                      }}
                    >
                      Clear all
                    </button>
                  </div>
                )}

                {filteredProducts.map((product: PickerProduct) => {
                  const isSelected = selectedProductIds.has(product.id);
                  const isExpanded = expandedProducts.has(product.id);
                  const variants = variantsByProduct[product.id];
                  const selectedVariantCount = variants
                    ? variants.filter((v) => selectedVariantIds.has(v.id)).length
                    : 0;
                  const isIndeterminate = !isSelected && selectedVariantCount > 0;
                  const isActive = isSelected || isIndeterminate;

                  return (
                    <div
                      key={product.id}
                      style={{
                        borderRadius: "10px",
                        border: `0.5px solid ${isActive ? T.purple : "var(--p-color-border)"}`,
                        background: isActive
                          ? T.purpleBg
                          : "var(--p-color-bg-surface)",
                        overflow: "hidden",
                        transition: "all 0.15s ease",
                      }}
                    >
                      {/* Product header row */}
                      <div
                        onClick={() => toggleProductSelection(product)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                          padding: "10px 12px",
                          cursor: "pointer",
                          userSelect: "none",
                        }}
                      >
                        {/* Checkbox (checked / indeterminate) */}
                        <div
                          style={{
                            width: "18px",
                            height: "18px",
                            borderRadius: "5px",
                            flexShrink: 0,
                            border: `2px solid ${isActive ? T.purple : "var(--p-color-border)"}`,
                            background: isActive ? T.purple : "transparent",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            transition: "all 0.15s ease",
                          }}
                        >
                          {isSelected ? (
                            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                              <path
                                d="M2 6l3 3 5-5"
                                stroke="#fff"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : isIndeterminate ? (
                            <span
                              style={{
                                width: "8px",
                                height: "2px",
                                background: "#fff",
                                borderRadius: "1px",
                              }}
                            />
                          ) : null}
                        </div>

                        {/* Thumbnail */}
                        <div
                          style={{
                            width: "36px",
                            height: "36px",
                            borderRadius: "8px",
                            background: T.tealBg,
                            overflow: "hidden",
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {product.image ? (
                            <img
                              src={product.image}
                              alt={product.title}
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.tealStroke} strokeWidth="2">
                              <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
                              <line x1="3" y1="6" x2="21" y2="6" />
                            </svg>
                          )}
                        </div>

                        {/* Title + meta */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            as="p"
                            variant="bodySm"
                            fontWeight={isActive ? "semibold" : "regular"}
                          >
                            {product.title}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {product.hasVariants
                              ? `${product.variantsCount} variants${
                                  selectedVariantCount > 0
                                    ? ` · ${selectedVariantCount} selected`
                                    : ""
                                }`
                              : product.id.split("/").pop()}
                          </Text>
                        </div>

                        {/* Expand chevron (only when the product has variants) */}
                        {product.hasVariants && (
                          <button
                            type="button"
                            aria-label={isExpanded ? "Hide variants" : "Choose variants"}
                            aria-expanded={isExpanded}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleProductExpand(product);
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "4px",
                              fontSize: "12px",
                              fontWeight: 500,
                              color: T.purpleFg,
                              background: "var(--p-color-bg-surface)",
                              border: `0.5px solid #C8C3F2`,
                              borderRadius: "8px",
                              padding: "5px 10px",
                              cursor: "pointer",
                              flexShrink: 0,
                            }}
                          >
                            Variants
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{
                                transform: isExpanded ? "rotate(180deg)" : "none",
                                transition: "transform 0.15s ease",
                              }}
                            >
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {/* Variant sub-rows */}
                      {isExpanded && (
                        <div
                          style={{
                            padding: "4px 12px 12px 42px",
                            display: "flex",
                            flexDirection: "column",
                            gap: "6px",
                          }}
                        >
                          {!variants ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              Loading variants…
                            </Text>
                          ) : variants.length > 0 ? (
                            <>
                              {isSelected && (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  Whole product selected — uncheck any variant to customize.
                                </Text>
                              )}
                              {variants.map((v) => {
                                const vSelected =
                                  isSelected || selectedVariantIds.has(v.id);
                                return (
                                  <div
                                    key={v.id}
                                    onClick={() =>
                                      toggleVariantSelection(product.id, v.id)
                                    }
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "10px",
                                      padding: "7px 10px",
                                      borderRadius: "8px",
                                      border: `0.5px solid ${
                                        vSelected ? T.purple : "var(--p-color-border)"
                                      }`,
                                      background: "var(--p-color-bg-surface)",
                                      cursor: "pointer",
                                      userSelect: "none",
                                    }}
                                  >
                                    <div
                                      style={{
                                        width: "16px",
                                        height: "16px",
                                        borderRadius: "4px",
                                        flexShrink: 0,
                                        border: `2px solid ${
                                          vSelected ? T.purple : "var(--p-color-border)"
                                        }`,
                                        background: vSelected ? T.purple : "transparent",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                      }}
                                    >
                                      {vSelected && (
                                        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                                          <path
                                            d="M2 6l3 3 5-5"
                                            stroke="#fff"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                          />
                                        </svg>
                                      )}
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <Text as="p" variant="bodySm">
                                        {v.title}
                                      </Text>
                                    </div>
                                    {v.price && (
                                      <Text as="span" variant="bodySm" tone="subdued">
                                        {v.price}
                                      </Text>
                                    )}
                                  </div>
                                );
                              })}
                            </>
                          ) : (
                            <Text as="p" variant="bodySm" tone="subdued">
                              No variants found.
                            </Text>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </BlockStack>
            )}
          </Modal.Section>
        </Modal>

        {toastActive && (
          <Toast
            content={toastMsg}
            error={toastIsError}
            onDismiss={() => setToastActive(false)}
          />
        )}
      </Page>
    </Frame>
  );
}


