import { Form, useNavigate, useNavigation } from "@remix-run/react";
import {
  Card,
  FormLayout,
  TextField,
  Select,
  Checkbox,
  Button,
  InlineStack,
  BlockStack,
  Text,
  Divider,
  Banner,
} from "@shopify/polaris";

export type PlanFormValues = {
  name: string;
  description: string;
  price: string;
  currency: string;
  interval: string;
  intervalCount: string;
  trialDays: string;
  sortOrder: string;
  isActive: boolean;
  merchantNote: string;
};

type Props = {
  defaultValues?: Partial<PlanFormValues>;
  error?: string;
  mode: "create" | "edit";
};

const INTERVAL_OPTIONS = [
  { label: "Weekly", value: "WEEK" },
  { label: "Monthly", value: "MONTH" },
  { label: "Yearly", value: "YEAR" },
];

const CURRENCY_OPTIONS = [
  { label: "USD — US Dollar", value: "USD" },
  { label: "EUR — Euro", value: "EUR" },
  { label: "GBP — British Pound", value: "GBP" },
  { label: "CAD — Canadian Dollar", value: "CAD" },
  { label: "AUD — Australian Dollar", value: "AUD" },
  { label: "INR — Indian Rupee", value: "INR" },
];

const defaults: PlanFormValues = {
  name: "",
  description: "",
  price: "",
  currency: "USD",
  interval: "MONTH",
  intervalCount: "1",
  trialDays: "0",
  sortOrder: "0",
  isActive: true,
  merchantNote: "",
};

export default function PlanForm({ defaultValues, error, mode }: Props) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const values = { ...defaults, ...defaultValues };

  return (
    <Form method="post">
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Error">
            <p>{error}</p>
          </Banner>
        )}

        {/* Basic Info */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Plan Details</Text>
            <FormLayout>
              <TextField
                label="Plan Name"
                name="name"
                defaultValue={values.name}
                placeholder="e.g. Monthly Basic, Annual Pro"
                autoComplete="off"
                requiredIndicator
              />
              <TextField
                label="Description"
                name="description"
                defaultValue={values.description}
                placeholder="What does this plan include?"
                multiline={3}
                autoComplete="off"
              />
              <TextField
                label="Internal Note"
                name="merchantNote"
                defaultValue={values.merchantNote}
                placeholder="Private note for your team (not shown to customers)"
                multiline={2}
                autoComplete="off"
              />
            </FormLayout>
          </BlockStack>
        </Card>

        {/* Pricing */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Pricing</Text>
            <FormLayout>
              <FormLayout.Group>
                <TextField
                  label="Price"
                  name="price"
                  type="number"
                  defaultValue={values.price}
                  placeholder="9.99"
                  prefix="$"
                  autoComplete="off"
                  requiredIndicator
                />
                <Select
                  label="Currency"
                  name="currency"
                  options={CURRENCY_OPTIONS}
                  defaultValue={values.currency}
                />
              </FormLayout.Group>
            </FormLayout>
          </BlockStack>
        </Card>

        {/* Billing Interval */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Billing Cycle</Text>
            <FormLayout>
              <FormLayout.Group>
                <Select
                  label="Billing Interval"
                  name="interval"
                  options={INTERVAL_OPTIONS}
                  defaultValue={values.interval}
                />
                <TextField
                  label="Every N intervals"
                  name="intervalCount"
                  type="number"
                  defaultValue={values.intervalCount}
                  helpText="e.g. 2 = bill every 2 months"
                  autoComplete="off"
                />
              </FormLayout.Group>
              <TextField
                label="Free Trial Days"
                name="trialDays"
                type="number"
                defaultValue={values.trialDays}
                helpText="Set to 0 for no trial"
                autoComplete="off"
              />
            </FormLayout>
          </BlockStack>
        </Card>

        {/* Settings */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Settings</Text>
            <FormLayout>
              <TextField
                label="Sort Order"
                name="sortOrder"
                type="number"
                defaultValue={values.sortOrder}
                helpText="Lower numbers appear first in the list"
                autoComplete="off"
              />
              <Checkbox
                label="Plan is active (visible to customers)"
                name="isActive"
                defaultChecked={values.isActive}
              />
            </FormLayout>
          </BlockStack>
        </Card>

        {/* Actions */}
        <InlineStack gap="300" align="end">
          <Button onClick={() => navigate("/app/plans")} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            submit
            loading={isSubmitting}
          >
            {mode === "create" ? "Create Plan" : "Save Changes"}
          </Button>
        </InlineStack>
      </BlockStack>
    </Form>
  );
}
