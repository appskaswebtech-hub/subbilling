// app/routes/app.subscriptions_.new.tsx
//
// "Create prepaid subscription": the merchant sets one up for a customer, and
// the customer is emailed a link to confirm and pay for the first delivery.
// Nothing exists in Shopify until they pay; then the contract is created
// (app/lib/prepaid.server.ts, createInitialInvoice → markInvoicePaid).
//
// Only PREPAID plans and bundles are offered. A postpaid subscription needs a
// saved card to charge, and a payment link (a draft order) can't save one.
//
// The trailing underscore in the file name keeps this page out of the
// Subscriptions list's layout, while its URL is still /app/subscriptions/new.

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useFetcher, useLoaderData, useNavigate, useNavigation, useSubmit } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Page,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  Banner,
  RadioButton,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { collapseBundleItems, listPrepaidBundles } from "../lib/bundles.server";
import { parseTiers, tierPercent } from "../config/bundle-pricing";
import { createInitialInvoice, roundMoney, type InitialSetup, type InvoiceAddress, type InvoiceLine } from "../lib/prepaid.server";

const CUSTOMER_QUERY = `#graphql
  query PrepaidSetupCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      defaultEmailAddress { emailAddress }
      defaultAddress {
        firstName lastName company phone
        address1 address2 city provinceCode countryCodeV2 zip
      }
    }
  }
`;

const VARIANT_PRICES_QUERY = `#graphql
  query PrepaidSetupVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id price title product { title } }
    }
    shop { currencyCode }
  }
`;

type CustomerInfo = {
  id: string;
  name: string;
  email: string;
  address: InvoiceAddress | null;
};

async function loadCustomer(graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response>, id: string): Promise<CustomerInfo | null> {
  const res  = await graphql(CUSTOMER_QUERY, { variables: { id } });
  const body = await res.json() as { data?: { customer?: any } };
  const c    = body.data?.customer;
  if (!c) return null;
  const a = c.defaultAddress;
  return {
    id:    c.id,
    name:  [c.firstName, c.lastName].filter(Boolean).join(" "),
    email: c.defaultEmailAddress?.emailAddress ?? "",
    address: a ? {
      firstName: a.firstName, lastName: a.lastName, company: a.company, phone: a.phone,
      address1: a.address1, address2: a.address2, city: a.city,
      provinceCode: a.provinceCode, countryCode: a.countryCodeV2, zip: a.zip,
    } : null,
  };
}

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  // The same loader answers the customer lookup (useFetcher below), so the
  // address can be prefilled without a separate route.
  const customerId = url.searchParams.get("customerId");
  const customer   = customerId?.startsWith("gid://shopify/Customer/")
    ? await loadCustomer(admin.graphql, customerId)
    : null;

  const [bundles, plans] = await Promise.all([
    listPrepaidBundles(session.shop),
    prisma.sellingPlanGroup.findMany({
      where:   { shop: session.shop, paymentMode: "PREPAID", shopifySellingPlanId: { not: null } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return json({
    customer,
    bundles: bundles.map((b) => ({
      id: b.id, name: b.name, discountPercent: b.discountPercent,
      interval: b.interval, intervalCount: b.intervalCount,
      items: collapseBundleItems(b.items).map((i) => ({ title: i.variantChoice ? i.title.split(" – ")[0] : i.title, quantity: i.quantity })),
    })),
    plans: plans.map((p) => ({
      id: p.id, name: p.name, interval: p.interval, intervalCount: p.intervalCount,
      discount: p.discount, discountType: p.discountType,
    })),
  });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();

  const customerId = String(form.get("customerId") ?? "");
  if (!customerId.startsWith("gid://shopify/Customer/")) return json({ ok: false, error: "Choose a customer." });

  const customer = await loadCustomer(admin.graphql, customerId);
  if (!customer) return json({ ok: false, error: "That customer couldn't be found." });
  if (!customer.email) return json({ ok: false, error: "This customer has no email address, so the payment link can't be sent." });

  // ── What they're subscribing to ────────────────────────────
  const source = form.get("source") === "plan" ? "plan" : "bundle";
  let wanted: Array<{ variantId: string; quantity: number }> = [];
  let adjust: (price: number) => number;
  let interval: string, intervalCount: number, sellingPlanId: string | null, bundleId: string | null, label: string;

  if (source === "bundle") {
    const bundle = await prisma.productBundle.findFirst({
      where:   { id: String(form.get("bundleId") ?? ""), shop: session.shop, type: "RECURRING", paymentMode: "PREPAID", kind: "SET" },
      include: { items: true },
    });
    if (!bundle?.shopifySellingPlanId) return json({ ok: false, error: "Choose a prepaid bundle." });
    wanted        = collapseBundleItems(bundle.items).map((i) => ({ variantId: i.variantId, quantity: i.quantity }));

    // A tiered bundle uses the tier its full quantity reaches, and that tier's
    // own selling plan; other pricing uses the bundle percentage (for a fixed
    // price, its matching percentage) on the base plan.
    const tiers   = bundle.pricingMode === "TIERED" ? parseTiers(bundle.tiersJson) : [];
    const units   = wanted.reduce((s, w) => s + w.quantity, 0);
    const reached = [...tiers].reverse().find((t) => units >= t.minItems) ?? null;
    const percent = bundle.pricingMode === "TIERED" ? tierPercent(tiers, units) : bundle.discountPercent;
    adjust        = (p) => p * (1 - percent / 100);
    interval      = bundle.interval;
    intervalCount = bundle.intervalCount;
    sellingPlanId = reached?.sellingPlanId ?? bundle.shopifySellingPlanId;
    bundleId      = bundle.id;
    label         = bundle.name;
  } else {
    const plan = await prisma.sellingPlanGroup.findFirst({
      where: { id: String(form.get("planId") ?? ""), shop: session.shop, paymentMode: "PREPAID" },
    });
    if (!plan?.shopifySellingPlanId) return json({ ok: false, error: "Choose a prepaid plan." });
    try {
      wanted = (JSON.parse(String(form.get("items") ?? "[]")) as Array<{ variantId: string; quantity: number }>)
        .filter((i) => typeof i.variantId === "string" && i.variantId.startsWith("gid://shopify/ProductVariant/"))
        .map((i) => ({ variantId: i.variantId, quantity: Math.max(1, Math.min(99, Number(i.quantity) || 1)) }));
    } catch {
      wanted = [];
    }
    if (!wanted.length) return json({ ok: false, error: "Add at least one product." });
    adjust = plan.discountType === "fixed_amount"
      ? (p) => p - plan.discount
      : (p) => p * (1 - plan.discount / 100);
    interval      = plan.interval;
    intervalCount = plan.intervalCount;
    sellingPlanId = plan.shopifySellingPlanId;
    bundleId      = null;
    label         = plan.name;
  }

  // ── Prices: the variant's current price with the plan or bundle discount ──
  const res  = await admin.graphql(VARIANT_PRICES_QUERY, { variables: { ids: wanted.map((w) => w.variantId) } });
  const body = await res.json() as {
    data?: { nodes: Array<{ id: string; price: string; title: string; product: { title: string } } | null>; shop: { currencyCode: string } };
  };
  const byId = new Map((body.data?.nodes ?? []).filter(Boolean).map((n) => [n!.id, n!]));

  const lines: InvoiceLine[] = [];
  for (const w of wanted) {
    const v = byId.get(w.variantId);
    if (!v) return json({ ok: false, error: "One of the products no longer exists. Pick the products again." });
    const onlyDefault = /default title/i.test(v.title);
    lines.push({
      variantId: v.id,
      quantity:  w.quantity,
      unitPrice: Math.max(0, roundMoney(adjust(parseFloat(v.price)))),
      title:     onlyDefault ? v.product.title : `${v.product.title} – ${v.title}`,
    });
  }

  // ── Shipping ────────────────────────────────────────────────
  const shippingAddress: InvoiceAddress = {
    firstName:    String(form.get("firstName") ?? "").trim(),
    lastName:     String(form.get("lastName") ?? "").trim(),
    company:      String(form.get("company") ?? "").trim(),
    phone:        String(form.get("phone") ?? "").trim(),
    address1:     String(form.get("address1") ?? "").trim(),
    address2:     String(form.get("address2") ?? "").trim(),
    city:         String(form.get("city") ?? "").trim(),
    provinceCode: String(form.get("provinceCode") ?? "").trim().toUpperCase(),
    countryCode:  String(form.get("countryCode") ?? "").trim().toUpperCase(),
    zip:          String(form.get("zip") ?? "").trim(),
  };
  if (!shippingAddress.address1 || !shippingAddress.city || !/^[A-Z]{2}$/.test(shippingAddress.countryCode ?? "")) {
    return json({ ok: false, error: "Enter a shipping address with at least a street, a city and a 2-letter country code." });
  }
  const shippingPrice = Math.max(0, roundMoney(parseFloat(String(form.get("shippingPrice") ?? "0")) || 0));

  const setup: InitialSetup = {
    customerId:    customer.id,
    email:         customer.email,
    currencyCode:  body.data?.shop.currencyCode ?? "USD",
    interval,
    intervalCount,
    sellingPlanId,
    bundleId,
    label,
    lines,
    shippingAddress,
    shippingPrice,
  };

  const result = await createInitialInvoice(admin.graphql, session.shop, setup);
  if (!result.ok) {
    return json({ ok: false, error: `The subscription was saved, but the payment email couldn't be sent: ${result.error}. You can retry it from the Subscriptions page.` });
  }

  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) + shippingPrice;
  return json({
    ok: true,
    message: `Payment link sent to ${customer.email} for ${setup.currencyCode} ${subtotal.toFixed(2)} (before tax). The subscription starts once they pay.`,
  });
}

// ─── Component ────────────────────────────────────────────────
type PickedItem = { variantId: string; title: string; quantity: string };

const EMPTY_ADDRESS = {
  firstName: "", lastName: "", company: "", phone: "",
  address1: "", address2: "", city: "", provinceCode: "", countryCode: "", zip: "",
};

export default function NewPrepaidSubscription() {
  const { bundles, plans } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { ok: boolean; error?: string; message?: string } | undefined;
  const navigation = useNavigation();
  const submit     = useSubmit();
  const navigate   = useNavigate();
  const shopify    = useAppBridge();

  const searchFetcher   = useFetcher<{ customers: Array<{ shopifyCustomerId: string; email: string; firstName: string | null; lastName: string | null }> }>();
  const customerFetcher = useFetcher<typeof loader>();

  const [query,    setQuery]    = useState("");
  const [customer, setCustomer] = useState<{ id: string; label: string } | null>(null);
  const [source,   setSource]   = useState<"bundle" | "plan">(bundles.length ? "bundle" : "plan");
  const [bundleId, setBundleId] = useState(bundles[0]?.id ?? "");
  const [planId,   setPlanId]   = useState(plans[0]?.id ?? "");
  const [items,    setItems]    = useState<PickedItem[]>([]);
  const [address,  setAddress]  = useState(EMPTY_ADDRESS);
  const [shipping, setShipping] = useState("0");

  const busy = navigation.state !== "idle";

  // Search as the merchant types, from two characters.
  useEffect(() => {
    if (customer || query.trim().length < 2) return;
    const t = setTimeout(() => searchFetcher.load(`/app/api/customers?q=${encodeURIComponent(query.trim())}`), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, customer]);

  // Prefill the shipping address from the chosen customer's default address.
  useEffect(() => {
    const c = customerFetcher.data?.customer;
    if (c?.address) {
      const a = c.address;
      setAddress({
        firstName: a.firstName ?? "", lastName: a.lastName ?? "", company: a.company ?? "", phone: a.phone ?? "",
        address1: a.address1 ?? "", address2: a.address2 ?? "", city: a.city ?? "",
        provinceCode: a.provinceCode ?? "", countryCode: a.countryCode ?? "", zip: a.zip ?? "",
      });
    }
  }, [customerFetcher.data]);

  function chooseCustomer(c: { shopifyCustomerId: string; email: string; firstName: string | null; lastName: string | null }) {
    const id = `gid://shopify/Customer/${c.shopifyCustomerId}`;
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
    setCustomer({ id, label: name ? `${name} · ${c.email}` : c.email });
    setAddress(EMPTY_ADDRESS);
    customerFetcher.load(`/app/subscriptions/new?customerId=${encodeURIComponent(id)}`);
  }

  async function pickProducts() {
    const selection = await shopify.resourcePicker({
      type: "product", multiple: true, action: "select",
      filter: { variants: true, draft: false, archived: false },
    });
    if (!selection) return;
    const kept = new Map(items.map((i) => [i.variantId, i.quantity]));
    const next: PickedItem[] = [];
    for (const product of selection as any[]) {
      for (const v of (product.variants ?? []) as any[]) {
        if (!v?.id) continue;
        const onlyDefault = (product.variants?.length ?? 0) === 1 && /default title/i.test(v.title ?? "");
        next.push({
          variantId: v.id,
          title:     onlyDefault || !v.title ? product.title : `${product.title} – ${v.title}`,
          quantity:  kept.get(v.id) ?? "1",
        });
      }
    }
    setItems(next);
  }

  function send() {
    if (!customer) return;
    const fd = new FormData();
    fd.append("customerId", customer.id);
    fd.append("source", source);
    fd.append("bundleId", bundleId);
    fd.append("planId", planId);
    fd.append("items", JSON.stringify(items.map((i) => ({ variantId: i.variantId, quantity: Number(i.quantity) || 1 }))));
    Object.entries(address).forEach(([k, v]) => fd.append(k, v));
    fd.append("shippingPrice", shipping || "0");
    submit(fd, { method: "post" });
  }

  const nothingToSell = !bundles.length && !plans.length;
  const canSend =
    !!customer &&
    (source === "bundle" ? !!bundleId : !!planId && items.length > 0) &&
    !!address.address1 && !!address.city && !!address.countryCode;

  const card: React.CSSProperties = {
    background: "var(--p-color-bg-surface)", border: "0.5px solid var(--p-color-border)",
    borderRadius: "14px", padding: "18px 20px",
  };

  function setAddr(key: keyof typeof EMPTY_ADDRESS) {
    return (v: string) => setAddress((a) => ({ ...a, [key]: v }));
  }

  return (
    <Page
      title="Create prepaid subscription"
      subtitle="The customer gets an email to confirm and pay. The subscription starts once they pay, and they're emailed again before each delivery."
      backAction={{ content: "Subscriptions", onAction: () => navigate("/app/subscriptions") }}
    >
      <TitleBar title="Create prepaid subscription" />
      <BlockStack gap="400">

        {actionData?.ok && actionData.message && (
          <Banner tone="success" title="Payment link sent" action={{ content: "Back to subscriptions", onAction: () => navigate("/app/subscriptions") }}>
            <Text as="p">{actionData.message}</Text>
          </Banner>
        )}
        {actionData && !actionData.ok && actionData.error && (
          <Banner tone="critical"><Text as="p">{actionData.error}</Text></Banner>
        )}
        {nothingToSell && (
          <Banner tone="warning" title="No prepaid plans or bundles yet">
            <Text as="p">
              Set a plan's payment type to Prepaid on Subscription Plans, or create a recurring prepaid bundle on Bundles, then come back.
            </Text>
          </Banner>
        )}

        {/* ── Customer ── */}
        <div style={card}>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Customer</Text>
            {customer ? (
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p">{customer.label}</Text>
                <Button variant="plain" onClick={() => { setCustomer(null); setQuery(""); }}>Change</Button>
              </InlineStack>
            ) : (
              <BlockStack gap="200">
                <TextField
                  label="Find a customer"
                  labelHidden
                  value={query}
                  onChange={setQuery}
                  placeholder="Search by name or email"
                  autoComplete="off"
                />
                {(searchFetcher.data?.customers ?? []).map((c) => (
                  <button
                    key={c.shopifyCustomerId}
                    onClick={() => chooseCustomer(c)}
                    style={{
                      textAlign: "left", padding: "8px 10px", borderRadius: "8px", cursor: "pointer",
                      border: "0.5px solid var(--p-color-border-secondary)", background: "var(--p-color-bg-surface)",
                    }}
                  >
                    <Text as="span" variant="bodySm">
                      {[c.firstName, c.lastName].filter(Boolean).join(" ") || "(no name)"} · {c.email || "no email"}
                    </Text>
                  </button>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </div>

        {/* ── What to subscribe to ── */}
        <div style={card}>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Subscription</Text>
            <InlineStack gap="400">
              <RadioButton label="A prepaid bundle" checked={source === "bundle"} disabled={!bundles.length} onChange={() => setSource("bundle")} id="src-bundle" name="source" />
              <RadioButton label="A prepaid plan with products" checked={source === "plan"} disabled={!plans.length} onChange={() => setSource("plan")} id="src-plan" name="source" />
            </InlineStack>

            {source === "bundle" ? (
              <Select
                label="Bundle"
                options={bundles.map((b) => ({ label: `${b.name}${b.discountPercent ? ` (${b.discountPercent}% off)` : ""}`, value: b.id }))}
                value={bundleId}
                onChange={setBundleId}
                helpText={(() => {
                  const b = bundles.find((x) => x.id === bundleId);
                  return b ? b.items.map((i) => (i.quantity > 1 ? `${i.title} × ${i.quantity}` : i.title)).join(", ") : undefined;
                })()}
              />
            ) : (
              <BlockStack gap="300">
                <Select
                  label="Plan"
                  options={plans.map((p) => ({
                    label: `${p.name}${p.discount ? ` (${p.discountType === "fixed_amount" ? p.discount : `${p.discount}%`} off)` : ""}`,
                    value: p.id,
                  }))}
                  value={planId}
                  onChange={setPlanId}
                />
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" fontWeight="medium">Products</Text>
                  <Button size="slim" onClick={pickProducts}>{items.length ? "Change products" : "Select products"}</Button>
                </InlineStack>
                {items.map((item, idx) => (
                  <InlineStack key={item.variantId} gap="300" blockAlign="center" wrap={false}>
                    <div style={{ flex: 1, minWidth: 0 }}><Text as="p" variant="bodySm" truncate>{item.title}</Text></div>
                    <div style={{ width: "90px" }}>
                      <TextField
                        label="Quantity" labelHidden type="number" min={1} autoComplete="off"
                        value={item.quantity}
                        onChange={(v) => setItems(items.map((it, i) => (i === idx ? { ...it, quantity: v.replace(/\D/g, "") } : it)))}
                      />
                    </div>
                    <Button size="slim" variant="plain" tone="critical" onClick={() => setItems(items.filter((_, i) => i !== idx))}>Remove</Button>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </div>

        {/* ── Shipping ── */}
        <div style={card}>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Shipping</Text>
            {customer && customerFetcher.state === "loading" && (
              <Text as="p" tone="subdued" variant="bodySm">Loading the customer's address…</Text>
            )}
            <InlineStack gap="300" wrap={false}>
              <div style={{ flex: 1 }}><TextField label="First name" value={address.firstName} onChange={setAddr("firstName")} autoComplete="off" /></div>
              <div style={{ flex: 1 }}><TextField label="Last name" value={address.lastName} onChange={setAddr("lastName")} autoComplete="off" /></div>
            </InlineStack>
            <TextField label="Address" value={address.address1} onChange={setAddr("address1")} autoComplete="off" />
            <TextField label="Apartment, suite, etc." value={address.address2} onChange={setAddr("address2")} autoComplete="off" />
            <InlineStack gap="300" wrap={false}>
              <div style={{ flex: 2 }}><TextField label="City" value={address.city} onChange={setAddr("city")} autoComplete="off" /></div>
              <div style={{ flex: 1 }}><TextField label="Postal code" value={address.zip} onChange={setAddr("zip")} autoComplete="off" /></div>
            </InlineStack>
            <InlineStack gap="300" wrap={false}>
              <div style={{ flex: 1 }}>
                <TextField label="Country code" value={address.countryCode} onChange={(v) => setAddr("countryCode")(v.toUpperCase().slice(0, 2))} placeholder="e.g. IN" autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <TextField label="State / province code" value={address.provinceCode} onChange={(v) => setAddr("provinceCode")(v.toUpperCase())} placeholder="e.g. MH" autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}><TextField label="Phone" value={address.phone} onChange={setAddr("phone")} autoComplete="off" /></div>
            </InlineStack>
            <TextField
              label="Shipping price per delivery"
              type="number"
              min={0}
              value={shipping}
              onChange={(v) => setShipping(v.replace(/[^\d.]/g, ""))}
              helpText="Charged on every payment link, including renewals."
              autoComplete="off"
            />
          </BlockStack>
        </div>

        <InlineStack align="end" gap="200">
          <Button onClick={() => navigate("/app/subscriptions")}>Cancel</Button>
          <Button variant="primary" onClick={send} loading={busy} disabled={!canSend || busy || nothingToSell}>
            Send payment link
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
