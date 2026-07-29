import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { useState } from "react";
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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createSellingPlanGroup } from "../shopify/sellingPlans.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

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

  // Validation
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Plan name is required";
  if (isNaN(price) || price <= 0) errors.price = "Price must be greater than 0";
  if (!["WEEK", "MONTH", "YEAR"].includes(interval))
    errors.interval = "Please select a valid billing interval";
  if (intervalCount < 1) errors.intervalCount = "Interval count must be at least 1";
  if (trialDays < 0) errors.trialDays = "Trial days cannot be negative";

  if (Object.keys(errors).length > 0) {
    return json({ errors, values: Object.fromEntries(formData) }, { status: 422 });
  }

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return json({ errors: { form: "Shop not found" } }, { status: 404 });

  // 1. Create in DB first
  const plan = await prisma.subscriptionPlan.create({
    data: {
      shopId: shop.id,
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

  try {
    const { groupId, sellingPlanId } = await createSellingPlanGroup(admin.graphql, {
      name,
      description,
      price,
      currency,
      interval: interval as any,
      intervalCount,
      trialDays,
      maxCycles,
    });

    // 3. Persist both Shopify GIDs back to DB
    await prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: {
        shopifySellingPlanGroupId: groupId,
        shopifySellingPlanId: sellingPlanId,
      },
    });
  } catch (err: any) {
    // Non-fatal: plan exists in DB, surface warning on edit page
    console.error("SellingPlanGroup create failed:", err.message);
    return redirect(`/app/edit-plans/${plan.id}?created=true&spg_error=${encodeURIComponent(err.message)}`);
  }

  return redirect(`/app/edit-plans/${plan.id}?created=true`);
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

export default function NewPlanPage() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const vals = (actionData as any)?.values ?? {};
  const errors = (actionData as any)?.errors ?? {};

  const [name, setName] = useState(vals.name ?? "");
  const [description, setDescription] = useState(vals.description ?? "");
  const [price, setPrice] = useState(vals.price ?? "");
  const [currency, setCurrency] = useState(vals.currency ?? "USD");
  const [interval, setInterval] = useState(vals.interval ?? "MONTH");
  const [intervalCount, setIntervalCount] = useState(vals.intervalCount ?? "1");
  const [trialDays, setTrialDays] = useState(vals.trialDays ?? "0");
  const [maxCycles, setMaxCycles] = useState(vals.maxCycles ?? "");
  const [merchantNote, setMerchantNote] = useState(vals.merchantNote ?? "");
  const [sortOrder, setSortOrder] = useState(vals.sortOrder ?? "0");

  return (
    <Page
      title="Create Subscription Plan"
      backAction={{ content: "Plans", url: "/app/plans" }}
    >
      <TitleBar title="Create Subscription Plan" />

      <Layout>
        <Layout.Section>
          {errors.form && (
            <Box paddingBlockEnd="400">
              <Banner tone="critical">{errors.form}</Banner>
            </Box>
          )}

          <form method="POST">
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
                      placeholder="e.g. Monthly Basic, Annual Pro"
                      autoComplete="off"
                      requiredIndicator
                    />
                    <TextField
                      label="Description"
                      name="description"
                      value={description}
                      onChange={setDescription}
                      multiline={3}
                      placeholder="Describe what's included in this plan..."
                      autoComplete="off"
                    />
                    <TextField
                      label="Internal Note"
                      name="merchantNote"
                      value={merchantNote}
                      onChange={setMerchantNote}
                      placeholder="Only visible to you — notes about this plan"
                      helpText="This note is not visible to customers."
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
                        placeholder="9.99"
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
                        onChange={setInterval}
                        error={errors.interval}
                      />
                      <TextField
                        label="Every (cycles)"
                        name="intervalCount"
                        type="number"
                        value={intervalCount}
                        onChange={setIntervalCount}
                        error={errors.intervalCount}
                        min="1"
                        helpText='e.g. "2" with Monthly = billing every 2 months'
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
                        error={errors.trialDays}
                        min="0"
                        helpText="0 = no trial period"
                        autoComplete="off"
                      />
                      <TextField
                        label="Max Billing Cycles"
                        name="maxCycles"
                        type="number"
                        value={maxCycles}
                        onChange={setMaxCycles}
                        min="1"
                        placeholder="Leave blank for unlimited"
                        helpText="Leave blank for ongoing subscriptions"
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
                      helpText="Lower number = shown first in plan list"
                      autoComplete="off"
                    />
                  </FormLayout>
                </BlockStack>
              </Card>

              {/* Actions */}
              <InlineStack align="end" gap="300">
                <Button url="/app/plans">Cancel</Button>
                <Button
                  variant="primary"
                  submit
                  loading={isSubmitting}
                >
                  Create Plan
                </Button>
              </InlineStack>
            </BlockStack>
          </form>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Tips
              </Text>
              <Divider />
              <Text as="p" variant="bodySm" tone="subdued">
                <strong>Billing Interval</strong> — Choose how often customers
                are charged. Use "Every (cycles)" to bill every N intervals,
                e.g. every 3 months.
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <strong>Trial Days</strong> — Customers won't be charged until
                the trial period ends.
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                <strong>Max Cycles</strong> — Use this for finite subscriptions
                like a 6-month program. Leave blank for ongoing.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
