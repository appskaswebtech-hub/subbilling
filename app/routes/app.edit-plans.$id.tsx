import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  Button,
  FormLayout,
  Banner,
  InlineStack,
  Box,
  Divider,
  InlineGrid,
  Badge,
  Modal,
  List,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  updateSellingPlanGroup,
  deleteSellingPlanGroup,
  getFirstSellingPlanId,
} from "../shopify/sellingPlans.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const planId = params.id as string;

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const plan = await prisma.subscriptionPlan.findFirst({
    where: { id: planId, shopId: shop.id },
    include: {
      _count: { select: { subscriptions: true } },
    },
  });

  if (!plan) throw new Response("Plan not found", { status: 404 });

  return json({ plan });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const planId = params.id as string;
  const formData = await request.formData();
  const actionType = formData.get("_action") as string;

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return json({ errors: { form: "Shop not found" } }, { status: 404 });

  const existingPlan = await prisma.subscriptionPlan.findFirst({
    where: { id: planId, shopId: shop.id },
  });
  if (!existingPlan) return json({ errors: { form: "Plan not found" } }, { status: 404 });

  // ── DELETE (soft) ──────────────────────────────────────────────────────────
  if (actionType === "delete") {
    // 1. Soft-delete in DB
    await prisma.subscriptionPlan.update({
      where: { id: planId },
      data: { isActive: false },
    });

    // 2. Delete SellingPlanGroup in Shopify (best-effort)
    if (existingPlan.shopifySellingPlanGroupId) {
      try {
        await deleteSellingPlanGroup(admin.graphql, existingPlan.shopifySellingPlanGroupId);
      } catch (err: any) {
        console.error("SellingPlanGroup delete failed (non-fatal):", err.message);
      }
    }

    return redirect("/app/plans?deleted=true");
  }

  // ── UPDATE ─────────────────────────────────────────────────────────────────
  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const price = parseFloat(formData.get("price") as string);
  const currency = (formData.get("currency") as string) || "USD";
  const interval = formData.get("interval") as string;
  const intervalCount = parseInt(formData.get("intervalCount") as string) || 1;
  const trialDays = parseInt(formData.get("trialDays") as string) || 0;
  const maxCycles = formData.get("maxCycles")
    ? parseInt(formData.get("maxCycles") as string)
    : null;
  const merchantNote = (formData.get("merchantNote") as string)?.trim();
  const sortOrder = parseInt(formData.get("sortOrder") as string) || 0;

  const errors: Record<string, string> = {};
  if (!name) errors.name = "Plan name is required";
  if (isNaN(price) || price <= 0) errors.price = "Price must be greater than 0";
  if (!["WEEK", "MONTH", "YEAR"].includes(interval))
    errors.interval = "Please select a valid billing interval";

  if (Object.keys(errors).length > 0) {
    return json({ errors }, { status: 422 });
  }

  // 1. Update DB
  await prisma.subscriptionPlan.update({
    where: { id: planId },
    data: {
      name,
      description: description || null,
      price,
      currency,
      interval: interval as any,
      intervalCount,
      trialDays,
      maxCycles,
      merchantNote: merchantNote || null,
      sortOrder,
    },
  });

  // 2. Update SellingPlanGroup in Shopify (best-effort)
  let spgWarning: string | null = null;
  if (existingPlan.shopifySellingPlanGroupId) {
    try {
      // Fetch the existing SellingPlan ID so we can update it (not create a duplicate)
      const existingSellingPlanId = existingPlan.shopifySellingPlanId
        ?? await getFirstSellingPlanId(admin.graphql, existingPlan.shopifySellingPlanGroupId);

      await updateSellingPlanGroup(
        admin.graphql,
        existingPlan.shopifySellingPlanGroupId,
        { name, description, price, currency, interval: interval as any, intervalCount, trialDays, maxCycles },
        existingSellingPlanId
      );
    } catch (err: any) {
      console.error("SellingPlanGroup update failed (non-fatal):", err.message);
      spgWarning = err.message;
    }
  }

  return json({
    success: true,
    message: "Plan updated successfully.",
    spgWarning,
  });
};

const intervalOptions = [
  { label: "Weekly", value: "WEEK" },
  { label: "Monthly", value: "MONTH" },
  { label: "Yearly", value: "YEAR" },
];

const currencyOptions = [
  { label: "USD — US Dollar", value: "USD" },
  { label: "EUR — Euro", value: "EUR" },
  { label: "GBP — British Pound", value: "GBP" },
  { label: "CAD — Canadian Dollar", value: "CAD" },
  { label: "AUD — Australian Dollar", value: "AUD" },
];

export default function EditPlanPage() {
  const { plan } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const isSubmitting = navigation.state === "submitting";

  const errors = (actionData as any)?.errors ?? {};
  const isSuccess = (actionData as any)?.success;
  const spgWarning = (actionData as any)?.spgWarning;
  const justCreated = searchParams.get("created") === "true";
  const spgError = searchParams.get("spg_error");

  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? "");
  const [price, setPrice] = useState(plan.price.toString());
  const [currency, setCurrency] = useState(plan.currency);
  const [interval, setInterval] = useState(plan.interval);
  const [intervalCount, setIntervalCount] = useState(plan.intervalCount.toString());
  const [trialDays, setTrialDays] = useState(plan.trialDays.toString());
  const [maxCycles, setMaxCycles] = useState(plan.maxCycles?.toString() ?? "");
  const [merchantNote, setMerchantNote] = useState(plan.merchantNote ?? "");
  const [sortOrder, setSortOrder] = useState(plan.sortOrder.toString());
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  return (
    <Page
      title={plan.name}
      backAction={{ content: "Plans", url: "/app/plans" }}
      titleMetadata={
        <Badge tone={plan.isActive ? "success" : "enabled"}>
          {plan.isActive ? "Active" : "Inactive"}
        </Badge>
      }
    >
      <TitleBar title={`Edit: ${plan.name}`} />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {(justCreated || isSuccess) && (
              <Banner tone="success" onDismiss={() => {}}>
                {justCreated
                  ? "Plan created successfully!"
                  : (actionData as any)?.message}
              </Banner>
            )}

            {(spgError || spgWarning) && (
              <Banner tone="warning" title="Shopify sync issue">
                The plan was saved locally but could not be synced to Shopify's
                SellingPlanGroup API:{" "}
                <strong>{spgError ?? spgWarning}</strong>. You can retry by
                saving the plan again.
              </Banner>
            )}

            {errors.form && (
              <Banner tone="critical">{errors.form}</Banner>
            )}
          </BlockStack>

          <Box paddingBlockStart="400">
            <form method="POST">
              <input type="hidden" name="_action" value="update" />
              <BlockStack gap="500">
                {/* Basic Info */}
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Plan Details
                    </Text>
                    <Divider />
                    <FormLayout>
                      <TextField
                        label="Plan Name"
                        name="name"
                        value={name}
                        onChange={setName}
                        error={errors.name}
                        autoComplete="off"
                        requiredIndicator
                      />
                      <TextField
                        label="Description"
                        name="description"
                        value={description}
                        onChange={setDescription}
                        multiline={3}
                        autoComplete="off"
                      />
                      <TextField
                        label="Internal Note"
                        name="merchantNote"
                        value={merchantNote}
                        onChange={setMerchantNote}
                        helpText="Only visible to you — not shown to customers."
                        autoComplete="off"
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>

                {/* Pricing */}
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Pricing & Billing
                    </Text>
                    <Divider />
                    <FormLayout>
                      <InlineGrid columns={2} gap="400">
                        <TextField
                          label="Price"
                          name="price"
                          type="number"
                          value={price}
                          onChange={setPrice}
                          error={errors.price}
                          prefix="$"
                          autoComplete="off"
                          requiredIndicator
                        />
                        <Select
                          label="Currency"
                          name="currency"
                          options={currencyOptions}
                          value={currency}
                          onChange={setCurrency}
                        />
                      </InlineGrid>

                      <InlineGrid columns={2} gap="400">
                        <Select
                          label="Billing Interval"
                          name="interval"
                          options={intervalOptions}
                          value={interval}
                          onChange={(v) => setInterval(v as any)}
                          error={errors.interval}
                        />
                        <TextField
                          label="Every (cycles)"
                          name="intervalCount"
                          type="number"
                          value={intervalCount}
                          onChange={setIntervalCount}
                          min="1"
                          autoComplete="off"
                        />
                      </InlineGrid>
                    </FormLayout>
                  </BlockStack>
                </Card>

                {/* Trial & Limits */}
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Trial & Limits
                    </Text>
                    <Divider />
                    <FormLayout>
                      <InlineGrid columns={2} gap="400">
                        <TextField
                          label="Trial Days"
                          name="trialDays"
                          type="number"
                          value={trialDays}
                          onChange={setTrialDays}
                          min="0"
                          autoComplete="off"
                        />
                        <TextField
                          label="Max Billing Cycles"
                          name="maxCycles"
                          type="number"
                          value={maxCycles}
                          onChange={setMaxCycles}
                          min="1"
                          placeholder="Unlimited"
                          autoComplete="off"
                        />
                      </InlineGrid>
                      <TextField
                        label="Sort Order"
                        name="sortOrder"
                        type="number"
                        value={sortOrder}
                        onChange={setSortOrder}
                        min="0"
                        autoComplete="off"
                      />
                    </FormLayout>
                  </BlockStack>
                </Card>

                {/* Actions */}
                <InlineStack align="space-between">
                  <Button
                    tone="critical"
                    variant="plain"
                    onClick={() => setDeleteModalOpen(true)}
                  >
                    Deactivate Plan
                  </Button>
                  <InlineStack gap="300">
                    <Button url="/app/plans">Cancel</Button>
                    <Button variant="primary" submit loading={isSubmitting}>
                      Save Changes
                    </Button>
                  </InlineStack>
                </InlineStack>
              </BlockStack>
            </form>
          </Box>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Plan Stats
              </Text>
              <Divider />
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">Total Subscribers</Text>
                <Text as="span" fontWeight="semibold">
                  {plan._count.subscriptions}
                </Text>
              </InlineStack>
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">Plan ID</Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {plan.id.slice(0, 8)}…
                </Text>
              </InlineStack>
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">Created</Text>
                <Text as="span" variant="bodySm">
                  {new Date(plan.createdAt).toLocaleDateString()}
                </Text>
              </InlineStack>
              <InlineStack align="space-between">
                <Text as="span" tone="subdued">Shopify Sync</Text>
                <Badge tone={plan.shopifySellingPlanGroupId ? "success" : "attention"}>
                  {plan.shopifySellingPlanGroupId ? "Synced" : "Not synced"}
                </Badge>
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Products
              </Text>
              <Divider />
              <Text as="p" variant="bodySm" tone="subdued">
                Associate products with this plan so customers can subscribe
                to them at checkout.
              </Text>
              <Button
                url={`/app/plans/${plan.id}/products`}
                disabled={!plan.shopifySellingPlanGroupId}
              >
                Manage Products →
              </Button>
              {!plan.shopifySellingPlanGroupId && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Save the plan first to enable product association.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      {/* Deactivate Confirm Modal */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Deactivate this plan?"
        primaryAction={{
          content: "Deactivate",
          destructive: true,
          onAction: () => {
            const form = document.createElement("form");
            form.method = "POST";
            const input = document.createElement("input");
            input.type = "hidden";
            input.name = "_action";
            input.value = "delete";
            form.appendChild(input);
            document.body.appendChild(form);
            form.submit();
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteModalOpen(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              This plan will be marked as inactive and hidden from new customers.
              Existing subscribers will not be affected.
            </Text>
            {plan._count.subscriptions > 0 && (
              <Banner tone="warning">
                This plan has {plan._count.subscriptions} active subscriber(s).
              </Banner>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
