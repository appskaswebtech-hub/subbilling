// app/routes/app.bundles.tsx
//
// Product bundles: create, edit, switch off and delete, with a live storefront
// preview on the right. The logic, including everything that touches Shopify,
// lives in app/lib/bundles.server.ts; the preview in
// app/components/BundlePreview.tsx mirrors the storefront block's four themes.
//
// A bundle holds ONE item per product. When a product has several variants,
// the shopper picks size/colour on the storefront (variantChoice). Bundles saved
// before that listed every variant as its own item; opening one in the editor
// collapses it to one item per product, and saving keeps that.
//
// A bundle is a fixed SET (shoppers can untick items) or a build-your-own BOX
// (shoppers pick at least N units from a pool). It's priced at % off, a fixed
// price for the full set (sets only) or in tiers by quantity; the rules are in
// app/config/bundle-pricing.ts.

import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Button,
  Badge,
  Banner,
  TextField,
  Thumbnail,
  EmptyState,
  Link,
} from "@shopify/polaris";
import { Select } from "../components/AppSelect";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  deleteBundle,
  listBundles,
  parseBundleInput,
  saveBundle,
  setBundleActive,
  syncBundleMetafield,
} from "../lib/bundles.server";
import {
  EMAIL_SENDER_OPTIONS,
  PAYMENT_MODE_OPTIONS,
  parseEmailSender,
  parsePaymentMode,
  prepaidLeadOptionsFor,
  type EmailSender,
  type PaymentMode,
} from "../config/payment";
import {
  BUNDLE_DESIGNS,
  bundleDesignLabel,
  parseBundleDesign,
  type BundleDesign,
} from "../config/bundle-designs";
import {
  MAX_TIERS,
  parseBundleKind,
  parsePricingMode,
  parseTiers,
  pricingSummary,
  type BundleKind,
  type PricingMode,
} from "../config/bundle-pricing";
import { BundlePreview, MiniBundlePreview, type PreviewItem } from "../components/BundlePreview";
import { BRAND_GRADIENT } from "../config/theme";
import { WITHOUT_BUNDLE_PRODUCTS } from "../config/bundle-product";

const ACCENT = "#5B4FCB";

const INTERVAL_OPTIONS = [
  { label: "Day",   value: "DAY" },
  { label: "Week",  value: "WEEK" },
  { label: "Month", value: "MONTH" },
  { label: "Year",  value: "YEAR" },
];

// ─── Product data for previews ────────────────────────────────
// Live images and prices, so the preview shows what shoppers will actually see.

const PRODUCTS_QUERY = `#graphql
  query BundlePreviewProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        # When it was published to the Online Store; null when it isn't.
        publishedAt
        featuredMedia { preview { image { url } } }
        variants(first: 100) { nodes { id title price availableForSale } }
      }
    }
    shop { currencyCode }
  }
`;

type VariantInfo = { id: string; title: string; price: number; available: boolean };
type ProductInfo = {
  title: string; handle: string; imageUrl: string | null; variants: VariantInfo[];
  /**
   * Published to the Online Store. The storefront block can't load a product
   * that isn't, so a set containing one shows as unavailable. Undefined while
   * unknown (just picked, not yet reloaded): treated as fine.
   */
  onStore?: boolean;
};

async function loadProducts(
  graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response>,
  ids: string[],
): Promise<{ products: Record<string, ProductInfo>; currency: string }> {
  const products: Record<string, ProductInfo> = {};
  let currency = "USD";
  try {
    // At least one request even with no products, for the shop currency.
    const chunks = ids.length ? [] as string[][] : [[]];
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

    for (const chunk of chunks) {
      const res  = await graphql(PRODUCTS_QUERY, { variables: { ids: chunk } });
      const body = await res.json() as { data?: { nodes: any[]; shop: { currencyCode: string } } };
      currency = body.data?.shop?.currencyCode ?? currency;
      for (const p of body.data?.nodes ?? []) {
        if (!p?.id) continue;
        products[p.id] = {
          title:    p.title,
          handle:   p.handle,
          imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
          variants: (p.variants?.nodes ?? []).map((v: any) => ({
            id: v.id, title: v.title, price: parseFloat(v.price), available: !!v.availableForSale,
          })),
          onStore:  !!p.publishedAt,
        };
      }
    }
  } catch (err) {
    // Previews fall back to names without images or prices.
    console.error("[bundles] could not load product previews:", err);
  }
  return { products, currency };
}

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  // Keep the copy of the bundles stored in Shopify (which the storefront block
  // reads) in step with this database, and backfill bundles saved before it
  // existed. Writes only when something differs; never fails the page.
  await syncBundleMetafield(admin.graphql, session.shop);
  const bundles = await listBundles(session.shop);
  // Items and base products alike, for thumbnails and titles.
  const ids = [...new Set(bundles.flatMap((b) => [
    ...b.items.map((i) => i.productId),
    ...b.baseProducts.map((p) => p.productId),
  ]))];
  const { products, currency } = await loadProducts(admin.graphql, ids);
  return json({ bundles, products, currency });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form   = await request.formData();
  const intent = form.get("intent");
  const id     = (form.get("id") as string) || null;

  if (intent === "save") {
    const parsed = parseBundleInput({
      name:               form.get("name"),
      type:               form.get("type"),
      design:             form.get("design"),
      discountPercent:    form.get("discountPercent"),
      active:             form.get("active"),
      interval:           form.get("interval"),
      intervalCount:      form.get("intervalCount"),
      paymentMode:        form.get("paymentMode"),
      paymentEmailSender: form.get("paymentEmailSender"),
      prepaidLeadHours:   form.get("prepaidLeadHours"),
      items:              form.get("items"),
      showOn:             form.get("showOn"),
      baseProducts:       form.get("baseProducts"),
      kind:               form.get("kind"),
      pricingMode:        form.get("pricingMode"),
      fixedPrice:         form.get("fixedPrice"),
      minItems:           form.get("minItems"),
      tiers:              form.get("tiers"),
    });
    if (!parsed.ok) return json({ intent, ok: false, error: parsed.error });

    const result = await saveBundle(admin.graphql, session.shop, id, parsed.value);
    if (!result.ok) return json({ intent, ok: false, error: result.error });
    return json({ intent, ok: true, id: result.id, warning: result.warning, message: id ? "Bundle saved" : "Bundle created" });
  }

  if (intent === "toggle" && id) {
    const result = await setBundleActive(admin.graphql, session.shop, id, form.get("active") === "true");
    return json({ intent, ok: result.ok, error: result.error, warning: result.warning ?? null, message: "Bundle updated" });
  }

  if (intent === "delete" && id) {
    const result = await deleteBundle(admin.graphql, session.shop, id);
    return json({ intent, ok: result.ok, error: result.error, warning: result.warning ?? null, message: "Bundle deleted" });
  }

  return json({ intent, ok: false, error: "Unknown action." }, { status: 400 });
}

// ─── Editor state ─────────────────────────────────────────────
type EditorItem = {
  productId:     string;
  variantId:     string;
  handle:        string;
  title:         string;          // the PRODUCT title
  variantTitle:  string | null;   // fixed variant's name; null when the shopper picks
  quantity:      string;          // a string for the TextField
  variantChoice: boolean;
};

type BaseProduct = { productId: string; handle: string; title: string };

/** Strings for the TextFields. */
type EditorTier = { minItems: string; percent: string };

type EditorState = {
  id:                 string | null;
  name:               string;
  type:               "RECURRING" | "ONE_TIME";
  design:             BundleDesign;
  /** "ITEMS": every product in the bundle shows it. "BASE": only baseProducts. */
  showOn:             "ITEMS" | "BASE";
  baseProducts:       BaseProduct[];
  kind:               BundleKind;
  pricingMode:        PricingMode;
  discountPercent:    string;
  fixedPrice:         string;
  /** Boxes: shoppers pick at least this many. */
  minItems:           string;
  tiers:              EditorTier[];
  active:             boolean;
  interval:           string;
  intervalCount:      string;
  paymentMode:        PaymentMode;
  paymentEmailSender: EmailSender;
  /** A prepaid lead choice in hours (app/config/payment.ts); "" = the shop setting. */
  prepaidLeadHours:   string;
  items:              EditorItem[];
};

const DEFAULT_TIERS: EditorTier[] = [{ minItems: "2", percent: "10" }, { minItems: "3", percent: "15" }];

function emptyEditor(): EditorState {
  return {
    id: null, name: "", type: "RECURRING", design: "classic", showOn: "ITEMS", baseProducts: [],
    kind: "SET", pricingMode: "PERCENT", discountPercent: "10", fixedPrice: "", minItems: "3", tiers: DEFAULT_TIERS,
    active: true,
    interval: "MONTH", intervalCount: "1", paymentMode: "POSTPAID", paymentEmailSender: "SHOPIFY", prepaidLeadHours: "",
    items: [],
  };
}

/**
 * The "Send the payment link" choices for the bundle's cycle, and the one in
 * effect. Only times that fit the cycle are offered; one chosen before the
 * interval was shortened no longer fits and falls back to the shop setting.
 */
function leadChoice(editor: EditorState): { options: Array<{ label: string; value: string }>; value: string } {
  const options = prepaidLeadOptionsFor(editor.interval, editor.intervalCount);
  return { options, value: options.some((o) => o.value === editor.prepaidLeadHours) ? editor.prepaidLeadHours : "" };
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** "$" for USD, "€" for EUR; the code itself when there's no symbol. */
function currencySymbol(currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).formatToParts(0)
      .find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

/** The fixed price as a percentage off `listTotal`, as the server stores it. */
function matchingPercent(fixedPrice: number, listTotal: number): number {
  if (!(fixedPrice > 0) || !(listTotal > fixedPrice)) return 0;
  return Math.round((1 - fixedPrice / listTotal) * 10000) / 100;
}

function isDefaultTitle(title: string | null | undefined) {
  return !title || /^default title$/i.test(title);
}

/** "Shown on: Snowboard, Bindings + 1 more", or the every-item wording. */
function shownOnText(
  showOn: string,
  baseProducts: BaseProduct[],
  products: Record<string, ProductInfo>,
): string {
  if (showOn !== "BASE") return "Shown on the page of every product in this bundle";
  if (!baseProducts.length) return "Shown on: no base products picked yet";
  const names = baseProducts.map((p) => products[p.productId]?.title ?? p.title);
  return `Shown on: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` + ${names.length - 2} more` : ""}`;
}

/**
 * Whether a product from the resource picker is on the Online Store: from its
 * publishedAt when the picker sends it, else what was already known.
 */
function pickedOnStore(picked: any, known: ProductInfo | undefined): boolean | undefined {
  if (picked && "publishedAt" in picked) return !!picked.publishedAt;
  return known?.onStore;
}

/** Titles of the products known not to be on the Online Store. */
function offStoreTitles(
  list: Array<{ productId: string; title: string }>,
  products: Record<string, ProductInfo>,
): string[] {
  return list
    .filter((p) => products[p.productId]?.onStore === false)
    .map((p) => products[p.productId]?.title ?? p.title);
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Why shoppers won't see (all of) this bundle: its products that aren't on
 * the Online Store, or null when there's nothing to say.
 */
function offStoreWarning(
  kind: string,
  items: Array<{ productId: string; title: string }>,
  products: Record<string, ProductInfo>,
): string | null {
  const names = offStoreTitles(items, products);
  if (!names.length) return null;
  const are = names.length === 1 ? "isn't" : "aren't";
  return kind === "BOX"
    ? `${joinNames(names)} ${are} on your Online Store, so ${names.length === 1 ? "it's" : "they're"} left out of the box.`
    : `${joinNames(names)} ${are} on your Online Store, so this bundle shows as unavailable.`;
}

function intervalText(interval: string, count: number) {
  const unit = interval.charAt(0) + interval.slice(1).toLowerCase();
  return count > 1 ? `Every ${count} ${unit}s` : `Every ${unit}`;
}

type StoredItem = { productId: string; variantId: string; handle: string; title: string; quantity: number; variantChoice: boolean };

/**
 * One editor item per product. Older bundles listed every variant as its own
 * item; those collapse to one item where the shopper picks the variant.
 */
function toEditorItems(stored: StoredItem[], products: Record<string, ProductInfo>): { items: EditorItem[]; collapsed: boolean } {
  const byProduct = new Map<string, EditorItem>();
  let collapsed = false;
  for (const i of stored) {
    const existing = byProduct.get(i.productId);
    if (existing) {
      collapsed = true;
      existing.variantChoice = true;
      existing.variantTitle  = null;
      continue;
    }
    const info    = products[i.productId];
    const variant = info?.variants.find((v) => v.id === i.variantId);
    byProduct.set(i.productId, {
      productId:     i.productId,
      variantId:     i.variantId,
      handle:        i.handle,
      // Stored titles of old per-variant items read "Product – Variant".
      title:         info?.title ?? i.title.split(" – ")[0],
      variantTitle:  i.variantChoice || isDefaultTitle(variant?.title) ? null : (variant?.title ?? null),
      quantity:      String(i.quantity),
      variantChoice: i.variantChoice,
    });
  }
  return { items: [...byProduct.values()], collapsed };
}

/**
 * `fixedVariants`: a recurring bundle, sold as one product, where every item
 * is the variant picked here and the shopper chooses nothing.
 */
function toPreviewItems(items: EditorItem[], products: Record<string, ProductInfo>, fixedVariants = false): PreviewItem[] {
  return items.map((i) => {
    const info    = products[i.productId];
    const variant = info?.variants.find((v) => v.id === i.variantId) ?? info?.variants[0];
    const choice  = i.variantChoice && !fixedVariants;
    return {
      key:           i.productId,
      title:         info?.title ?? i.title,
      imageUrl:      info?.imageUrl ?? null,
      price:         variant ? variant.price : null,
      quantity:      Math.max(1, Number(i.quantity) || 1),
      variantChoice: choice,
      variantLabel:  choice || fixedVariants
        ? (isDefaultTitle(variant?.title) ? null : variant?.title ?? null)
        : i.variantTitle,
    };
  });
}

// ─── Small pieces ─────────────────────────────────────────────
function ThumbStack({ items }: { items: PreviewItem[] }) {
  const shown = items.slice(0, 3);
  const extra = items.length - shown.length;
  return (
    <div style={{ display: "flex", flexShrink: 0 }}>
      {shown.map((item, idx) => (
        <div key={item.key} style={{
          marginLeft: idx ? -14 : 0, width: 48, height: 48, borderRadius: 12, overflow: "hidden",
          border: "2px solid var(--p-color-bg-surface)", background: "var(--p-color-bg-surface-secondary)",
          boxShadow: "0 1px 3px rgba(0,0,0,.08)", display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 600, color: "var(--p-color-text-subdued)",
        }}>
          {item.imageUrl
            ? <img src={item.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : item.title.charAt(0).toUpperCase()}
        </div>
      ))}
      {extra > 0 && (
        <div style={{
          marginLeft: -14, width: 48, height: 48, borderRadius: 12, border: "2px solid var(--p-color-bg-surface)",
          background: "#EEEDFE", color: "#3C3489", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 13, fontWeight: 700,
        }}>+{extra}</div>
      )}
    </div>
  );
}

function StatTile({ label, value, tint }: { label: string; value: number; tint: string }) {
  return (
    <div style={{
      background: "var(--p-color-bg-surface)", border: "1px solid var(--p-color-border)", borderRadius: 14,
      padding: "14px 16px", display: "flex", alignItems: "center", gap: 12,
    }}>
      <span style={{ width: 10, height: 10, borderRadius: "50%", background: tint, flexShrink: 0 }} />
      <BlockStack gap="050">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="headingLg">{String(value)}</Text>
      </BlockStack>
    </div>
  );
}

function OptionTile({ selected, title, description, onClick, disabled = false }: {
  selected: boolean; title: string; description: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        textAlign: "left", cursor: disabled ? "not-allowed" : "pointer", padding: "12px 14px", borderRadius: 12, width: "100%",
        border: selected ? `2px solid ${ACCENT}` : "1px solid var(--p-color-border)",
        background: selected ? "#F5F3FF" : "var(--p-color-bg-surface)",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <BlockStack gap="100">
        <Text as="span" variant="bodyMd" fontWeight="semibold">{title}</Text>
        <Text as="span" variant="bodySm" tone="subdued">{description}</Text>
      </BlockStack>
    </button>
  );
}

// ─── Component ────────────────────────────────────────────────
export default function Bundles() {
  const loaded      = useLoaderData<typeof loader>();
  const { bundles, currency } = loaded;
  const actionData  = useActionData<typeof action>() as
    | { intent: string; ok: boolean; id?: string; error?: string; warning?: string | null; message?: string }
    | undefined;
  const navigation  = useNavigation();
  const submit      = useSubmit();
  const shopify     = useAppBridge();
  const busy        = navigation.state !== "idle";

  // Product info from the loader, plus whatever the picker adds while editing.
  const [products, setProducts]     = useState<Record<string, ProductInfo>>(loaded.products);
  useEffect(() => { setProducts((p) => ({ ...p, ...loaded.products })); }, [loaded.products]);

  const [selectedId, setSelectedId] = useState<string | null>(bundles[0]?.id ?? null);
  const [peekDesign, setPeekDesign] = useState<BundleDesign | null>(null);
  const [editor, setEditor]         = useState<EditorState | null>(null);
  const [collapsedNotice, setCollapsedNotice] = useState(false);

  // After a save: back to the list, showing the bundle just saved.
  useEffect(() => {
    if (actionData?.intent === "save" && actionData.ok) {
      setEditor(null);
      if (actionData.id) setSelectedId(actionData.id);
      setPeekDesign(null);
    }
    if (actionData?.ok && actionData.message && !actionData.warning) shopify.toast.show(actionData.message);
  }, [actionData, shopify]);

  // Keep a valid selection as bundles come and go.
  useEffect(() => {
    if (!bundles.some((b) => b.id === selectedId)) setSelectedId(bundles[0]?.id ?? null);
  }, [bundles, selectedId]);

  const stats = useMemo(() => ({
    total:     bundles.length,
    active:    bundles.filter((b) => b.active).length,
    recurring: bundles.filter((b) => b.type === "RECURRING").length,
    oneTime:   bundles.filter((b) => b.type === "ONE_TIME").length,
  }), [bundles]);

  // ── Editor actions ─────────────────────────────────────────
  function update<K extends keyof EditorState>(key: K, value: EditorState[K]) {
    setEditor((e) => (e ? { ...e, [key]: value } : e));
  }

  function openCreate() {
    setCollapsedNotice(false);
    setEditor(emptyEditor());
  }

  function openEdit(b: (typeof bundles)[number]) {
    const { editor: state, collapsed } = editorFrom(b);
    setCollapsedNotice(collapsed);
    setEditor(state);
  }

  /**
   * A new bundle prefilled from `b`, saved only when the merchant presses
   * Create. A recurring bundle's copy is one-time: the only kind Shopify shows
   * as one bundle with its items (and their images) in cart and checkout.
   */
  function openDuplicate(b: (typeof bundles)[number]) {
    const { editor: state, collapsed } = editorFrom(b);
    const recurring = state.type === "RECURRING";
    setCollapsedNotice(collapsed);
    setEditor({
      ...state,
      id:   null,
      name: `${b.name} (${recurring ? "one-time" : "copy"})`,
      type: recurring ? "ONE_TIME" : state.type,
    });
  }

  /** The editor state for a saved bundle. */
  function editorFrom(b: (typeof bundles)[number]): { editor: EditorState; collapsed: boolean } {
    const { items, collapsed } = toEditorItems(b.items, products);
    return { collapsed, editor: {
      id:                 b.id,
      name:               b.name,
      type:               b.type === "ONE_TIME" ? "ONE_TIME" : "RECURRING",
      design:             parseBundleDesign(b.design),
      showOn:             b.showOn === "BASE" ? "BASE" : "ITEMS",
      baseProducts:       b.baseProducts.map((p) => ({ productId: p.productId, handle: p.handle, title: p.title })),
      kind:               parseBundleKind(b.kind),
      pricingMode:        parsePricingMode(b.pricingMode),
      // For a fixed price, its matching percentage: a starting point if the
      // merchant switches to % off.
      discountPercent:    String(b.discountPercent),
      fixedPrice:         b.fixedPrice ? String(b.fixedPrice) : "",
      minItems:           b.minItems > 0 ? String(b.minItems) : "3",
      tiers:              (() => {
        const tiers = parseTiers(b.tiersJson);
        return tiers.length ? tiers.map((t) => ({ minItems: String(t.minItems), percent: String(t.percent) })) : DEFAULT_TIERS;
      })(),
      active:             b.active,
      interval:           b.interval,
      intervalCount:      String(b.intervalCount),
      paymentMode:        parsePaymentMode(b.paymentMode),
      paymentEmailSender: parseEmailSender(b.paymentEmailSender),
      prepaidLeadHours:   typeof b.prepaidLeadHours === "number" ? String(b.prepaidLeadHours) : "",
      items,
    } };
  }

  async function pickProducts() {
    if (!editor) return;
    const selection = await shopify.resourcePicker({
      type:     "product",
      multiple: true,
      action:   "select",
      filter:   { variants: true, draft: false, archived: false, query: WITHOUT_BUNDLE_PRODUCTS },
      // Re-open with the bundle ticked: whole products where the shopper picks,
      // the one variant where it is fixed.
      selectionIds: editor.items.map((i) =>
        i.variantChoice ? { id: i.productId } : { id: i.productId, variants: [{ id: i.variantId }] }),
    });
    if (!selection) return;

    const kept = new Map(editor.items.map((i) => [i.productId, i]));
    const next: EditorItem[] = [];
    const info: Record<string, ProductInfo> = {};

    for (const product of selection as any[]) {
      const variants: any[] = (product.variants ?? []).filter((v: any) => v?.id);
      const first = variants[0];
      if (!first) continue;

      // Several variants picked → the shopper chooses among them on the
      // storefront. Exactly one → that variant, fixed.
      const choice = variants.length > 1;
      next.push({
        productId:     product.id,
        variantId:     first.id,
        handle:        product.handle ?? "",
        title:         product.title,
        variantTitle:  choice || isDefaultTitle(first.title) ? null : first.title,
        quantity:      kept.get(product.id)?.quantity ?? "1",
        variantChoice: choice,
      });

      const image = product.images?.[0];
      info[product.id] = {
        title:    product.title,
        handle:   product.handle ?? "",
        imageUrl: image?.originalSrc ?? image?.url ?? products[product.id]?.imageUrl ?? null,
        variants: variants.map((v) => ({
          id: v.id, title: v.title ?? "", price: parseFloat(v.price ?? "0"), available: true,
        })),
        onStore:  pickedOnStore(product, products[product.id]),
      };
    }

    setProducts((p) => ({ ...p, ...info }));
    update("items", next);
  }

  // Products whose pages show the bundle. Whole products only: a page belongs
  // to a product, not a variant.
  async function pickBaseProducts() {
    if (!editor) return;
    const selection = await shopify.resourcePicker({
      type:         "product",
      multiple:     true,
      action:       "select",
      filter:       { variants: false, draft: false, archived: false, query: WITHOUT_BUNDLE_PRODUCTS },
      selectionIds: editor.baseProducts.map((p) => ({ id: p.productId })),
    });
    if (!selection) return;

    const info: Record<string, ProductInfo> = {};
    const next: BaseProduct[] = (selection as any[]).map((product) => {
      const image = product.images?.[0];
      info[product.id] = {
        title:    product.title,
        handle:   product.handle ?? "",
        imageUrl: image?.originalSrc ?? image?.url ?? products[product.id]?.imageUrl ?? null,
        // Keep variant data already loaded; base products don't need their own.
        variants: products[product.id]?.variants ?? [],
        onStore:  pickedOnStore(product, products[product.id]),
      };
      return { productId: product.id, handle: product.handle ?? "", title: product.title };
    });

    setProducts((p) => ({ ...p, ...info }));
    update("baseProducts", next);
  }

  function save() {
    if (!editor) return;
    const fd = new FormData();
    fd.append("intent", "save");
    if (editor.id) fd.append("id", editor.id);
    fd.append("name", editor.name);
    fd.append("type", editor.type);
    fd.append("design", editor.design);
    fd.append("showOn", editor.showOn);
    fd.append("baseProducts", JSON.stringify(editor.baseProducts));
    fd.append("kind", editor.kind);
    fd.append("pricingMode", editor.pricingMode);
    fd.append("discountPercent", editor.discountPercent || "0");
    fd.append("fixedPrice", editor.fixedPrice);
    fd.append("minItems", editor.minItems);
    fd.append("tiers", JSON.stringify(editor.tiers.map((t) => ({ minItems: Number(t.minItems), percent: Number(t.percent) }))));
    fd.append("active", String(editor.active));
    fd.append("interval", editor.interval);
    fd.append("intervalCount", editor.intervalCount || "1");
    fd.append("paymentMode", editor.paymentMode);
    fd.append("paymentEmailSender", editor.paymentEmailSender);
    fd.append("prepaidLeadHours", leadChoice(editor).value);
    fd.append("items", JSON.stringify(editor.items.map((i) => ({
      productId:     i.productId,
      variantId:     i.variantId,
      handle:        i.handle,
      title:         i.title,
      quantity:      Number(i.quantity) || 1,
      // A recurring bundle is one product with fixed contents: each item is
      // the variant picked in the editor.
      variantChoice: editor.type === "RECURRING" ? false : i.variantChoice,
    }))));
    submit(fd, { method: "post" });
  }

  // A recurring bundle is sold as one product with fixed contents: a fixed set
  // (no box) at % off or a fixed price (no tiers).
  function setType(type: "RECURRING" | "ONE_TIME") {
    setEditor((e) => (e ? {
      ...e,
      type,
      ...(type === "RECURRING" ? { kind: "SET" as const, pricingMode: e.pricingMode === "TIERED" ? "PERCENT" as const : e.pricingMode } : {}),
    } : e));
  }

  /** A recurring bundle's item: which variant goes in it. */
  function setItemVariant(idx: number, variantId: string) {
    setEditor((e) => {
      if (!e) return e;
      return {
        ...e,
        items: e.items.map((it, i) => {
          if (i !== idx) return it;
          const variant = products[it.productId]?.variants.find((v) => v.id === variantId);
          return { ...it, variantId, variantTitle: isDefaultTitle(variant?.title) ? null : variant?.title ?? null };
        }),
      };
    });
  }

  // A box can't have a fixed price: switching to a box moves it to % off.
  function setKind(kind: BundleKind) {
    setEditor((e) => (e ? {
      ...e,
      kind,
      pricingMode: kind === "BOX" && e.pricingMode === "FIXED_PRICE" ? "PERCENT" : e.pricingMode,
    } : e));
  }

  function updateTier(idx: number, patch: Partial<EditorTier>) {
    setEditor((e) => (e ? { ...e, tiers: e.tiers.map((t, i) => (i === idx ? { ...t, ...patch } : t)) } : e));
  }

  // The next tier: one more item, 5% more off.
  function addTier() {
    setEditor((e) => {
      if (!e || e.tiers.length >= MAX_TIERS) return e;
      const last = e.tiers[e.tiers.length - 1];
      const next = last
        ? { minItems: String((Number(last.minItems) || 1) + 1), percent: String(Math.min(100, (Number(last.percent) || 0) + 5)) }
        : { minItems: "2", percent: "10" };
      return { ...e, tiers: [...e.tiers, next] };
    });
  }

  function toggle(id: string, active: boolean) {
    const fd = new FormData();
    fd.append("intent", "toggle");
    fd.append("id", id);
    fd.append("active", String(active));
    submit(fd, { method: "post" });
  }

  function remove(id: string, name: string) {
    if (!confirm(`Delete the bundle "${name}"? Existing subscriptions from it keep renewing.`)) return;
    const fd = new FormData();
    fd.append("intent", "delete");
    fd.append("id", id);
    submit(fd, { method: "post" });
  }

  const banners = (
    <>
      {actionData && !actionData.ok && actionData.error && (
        <Banner tone="critical"><Text as="p">{actionData.error}</Text></Banner>
      )}
      {actionData?.warning && (
        <Banner tone="warning" title="Saved, but not everything worked">
          <Text as="p">{actionData.warning}</Text>
        </Banner>
      )}
    </>
  );

  // ═══ Editor view ═══════════════════════════════════════════
  if (editor) {
    const recurring    = editor.type === "RECURRING";
    const box          = editor.kind === "BOX";
    const mode         = editor.pricingMode;
    const lead         = leadChoice(editor);
    const previewItems = toPreviewItems(editor.items, products, recurring);
    // Today's price of the set: the default / fixed variants at their quantities.
    const listKnown    = previewItems.length > 0 && previewItems.every((i) => i.price !== null);
    const listTotal    = previewItems.reduce((s, i) => s + (i.price ?? 0) * i.quantity, 0);
    const fixedPrice   = Number(editor.fixedPrice) || 0;
    const matching     = matchingPercent(fixedPrice, listTotal);
    const itemsWarning = offStoreWarning(editor.kind, editor.items, products);
    const offStoreThem = offStoreTitles(editor.items, products).length === 1 ? "it" : "them";
    const previewProps = {
      name:            editor.name,
      discountPercent: mode === "FIXED_PRICE" ? matching : mode === "PERCENT" ? Number(editor.discountPercent) || 0 : 0,
      items:           previewItems,
      frequency:       recurring ? intervalText(editor.interval, Math.max(1, Number(editor.intervalCount) || 1)) : null,
      prepaid:         recurring && editor.paymentMode === "PREPAID",
      currency,
      kind:            editor.kind,
      pricingMode:     mode,
      fixedPrice:      fixedPrice || null,
      minItems:        Number(editor.minItems) || 0,
      tiers:           parseTiers(editor.tiers),
      // Recurring: sold as one product, contents fixed.
      locked:          recurring,
    };

    return (
      <Page
        title={editor.id ? `Edit “${editor.name || "bundle"}”` : "Create bundle"}
        backAction={{ content: "Bundles", onAction: () => setEditor(null) }}
        primaryAction={{ content: editor.id ? "Save bundle" : "Create bundle", onAction: save, loading: busy }}
        secondaryActions={[{ content: "Cancel", onAction: () => setEditor(null) }]}
      >
        <TitleBar title="Bundles" />
        <BlockStack gap="400">
          {banners}
          {collapsedNotice && (
            <Banner tone="info" title="Now one item per product" onDismiss={() => setCollapsedNotice(false)}>
              <Text as="p">
                This bundle listed every variant as its own item. It's now one item per product, and shoppers choose the
                size or colour. Save to keep it this way.
              </Text>
            </Banner>
          )}

          <Layout>
            <Layout.Section>
              <BlockStack gap="400">

                {/* ── Details ── */}
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Bundle details</Text>
                    <TextField
                      label="Bundle name"
                      value={editor.name}
                      onChange={(v) => update("name", v)}
                      placeholder="e.g. Snowboard starter kit"
                      helpText="Shoppers see this above the bundle."
                      autoComplete="off"
                    />
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      <OptionTile
                        selected={recurring}
                        title="Recurring"
                        description="Sold as one product that renews as one subscription line."
                        onClick={() => setType("RECURRING")}
                      />
                      <OptionTile
                        selected={!recurring}
                        title="One-time"
                        description="Bought once at the bundle price."
                        onClick={() => setType("ONE_TIME")}
                      />
                    </InlineGrid>
                    <Text as="h3" variant="headingSm">Bundle type</Text>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      <OptionTile
                        selected={!box}
                        title="Fixed set"
                        description={recurring
                          ? "The products you choose, always together."
                          : "The products you choose, together. Shoppers can untick what they don't want."}
                        onClick={() => setKind("SET")}
                      />
                      <OptionTile
                        selected={box}
                        title="Build-your-own box"
                        description={recurring
                          ? "One-time bundles only: a recurring bundle is one product with fixed contents."
                          : "Shoppers pick any mix of your products, at least a set number."}
                        onClick={() => setKind("BOX")}
                        disabled={recurring}
                      />
                    </InlineGrid>
                  </BlockStack>
                </Card>

                {/* ── Products ── */}
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="050">
                        <Text as="h2" variant="headingMd">{box ? "Product pool" : "Products"}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {box
                            ? "Shoppers fill their box from these, in any mix, and can take the same product more than once. Pick whole products to let them choose size and colour."
                            : recurring
                            ? "Choose the size or colour of each product below. Shoppers get exactly this set."
                            : "Pick whole products to let shoppers choose size and colour, or tick one variant to fix it. Shoppers can untick items they don't want; the discount applies to what they keep."}
                        </Text>
                      </BlockStack>
                      <Button onClick={pickProducts}>{editor.items.length ? "Change products" : "Select products"}</Button>
                    </InlineStack>

                    {recurring ? (
                      <Banner tone="info" title="Sold as one product">
                        <Text as="p">
                          Saving creates a product for this bundle in Shopify. It's unlisted, so it stays out of your catalog,
                          collections and search. Customers subscribe to it as one line in the cart, at checkout and on every
                          order, with an "Includes" note listing these items.
                        </Text>
                      </Banner>
                    ) : (
                      <Banner tone="info" title="One bundle in cart and checkout">
                        <Text as="p">
                          Saving creates an unlisted product for this bundle in Shopify. In the cart and at checkout, the items
                          the shopper picks are grouped under it as one bundle, each with its own image. Each item is still
                          ordered, stocked and shipped on its own.
                        </Text>
                      </Banner>
                    )}

                    {itemsWarning && (
                      <Banner tone="critical">
                        <Text as="p">
                          {`${itemsWarning} Publish ${offStoreThem} to the Online Store sales channel in Shopify, or remove ${offStoreThem} here.`}
                        </Text>
                      </Banner>
                    )}

                    {editor.items.length === 0 ? (
                      <div style={{
                        border: "1px dashed var(--p-color-border)", borderRadius: 12, padding: "24px 16px", textAlign: "center",
                      }}>
                        <Text as="p" tone="subdued">Add at least two products to build a bundle.</Text>
                      </div>
                    ) : (
                      <BlockStack gap="0">
                        {editor.items.map((item, idx) => {
                          const info = products[item.productId];
                          return (
                            <div key={item.productId} style={{
                              display: "flex", alignItems: "center", gap: 12, padding: "10px 0",
                              borderTop: idx ? "1px solid var(--p-color-border-secondary)" : "none",
                            }}>
                              <Thumbnail source={info?.imageUrl ?? ""} alt="" size="small" />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <Text as="p" fontWeight="medium" truncate>{info?.title ?? item.title}</Text>
                                <InlineStack gap="150" blockAlign="center">
                                  {recurring && (info?.variants.length ?? 0) > 1
                                    // Fixed contents: the merchant picks the variant.
                                    ? (
                                      <div style={{ minWidth: 160, marginTop: 4 }}>
                                        <Select
                                          label="Variant"
                                          labelHidden
                                          options={info!.variants.map((v) => ({ label: v.title, value: v.id }))}
                                          value={item.variantId}
                                          onChange={(v) => setItemVariant(idx, v)}
                                        />
                                      </div>
                                    )
                                    : item.variantChoice && !recurring
                                    ? <Badge tone="info">Shopper picks size / colour</Badge>
                                    : item.variantTitle
                                    ? <Text as="p" variant="bodySm" tone="subdued">{item.variantTitle}</Text>
                                    : null}
                                  {info?.onStore === false && <Badge tone="critical">Not on Online Store</Badge>}
                                </InlineStack>
                              </div>
                              {/* A box's quantities are the shopper's to choose. */}
                              {!box && (
                                <div style={{ width: 84 }}>
                                  <TextField
                                    label="Quantity"
                                    labelHidden
                                    type="number"
                                    min={1}
                                    prefix="×"
                                    value={item.quantity}
                                    onChange={(v) => update("items", editor.items.map((it, i) => (i === idx ? { ...it, quantity: v.replace(/\D/g, "") } : it)))}
                                    autoComplete="off"
                                  />
                                </div>
                              )}
                              <Button
                                variant="plain"
                                tone="critical"
                                onClick={() => update("items", editor.items.filter((_, i) => i !== idx))}
                              >
                                Remove
                              </Button>
                            </div>
                          );
                        })}
                      </BlockStack>
                    )}

                    {box && (
                      <div style={{ maxWidth: 260 }}>
                        <TextField
                          label="Shoppers pick at least"
                          type="number"
                          min={1}
                          max={99}
                          suffix={Number(editor.minItems) === 1 ? "item" : "items"}
                          value={editor.minItems}
                          onChange={(v) => update("minItems", v.replace(/\D/g, ""))}
                          helpText="They can add more; everything they pick gets the discount."
                          autoComplete="off"
                        />
                      </div>
                    )}
                  </BlockStack>
                </Card>

                {/* ── Where it shows ── */}
                <Card>
                  <BlockStack gap="300">
                    <BlockStack gap="050">
                      <Text as="h2" variant="headingMd">Where it shows</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Choose the product pages that offer this bundle.
                      </Text>
                    </BlockStack>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      <OptionTile
                        selected={editor.showOn === "ITEMS"}
                        title="Every product in this bundle"
                        description="Shown on the page of each product it contains."
                        onClick={() => update("showOn", "ITEMS")}
                      />
                      <OptionTile
                        selected={editor.showOn === "BASE"}
                        title="Only on base products"
                        description="Shown only on the product pages you pick below."
                        onClick={() => update("showOn", "BASE")}
                      />
                    </InlineGrid>

                    {editor.showOn === "BASE" && (
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="p" variant="bodySm" tone="subdued">
                            The bundle appears on these product pages. They don't have to be in the bundle, and aren't added to the cart with it.
                          </Text>
                          <Button onClick={pickBaseProducts}>
                            {editor.baseProducts.length ? "Change base products" : "Select base products"}
                          </Button>
                        </InlineStack>

                        {editor.baseProducts.length === 0 ? (
                          <div style={{
                            border: "1px dashed var(--p-color-border)", borderRadius: 12, padding: "18px 16px", textAlign: "center",
                          }}>
                            <Text as="p" tone="subdued">Pick at least one product page to show the bundle on.</Text>
                          </div>
                        ) : (
                          <BlockStack gap="0">
                            {editor.baseProducts.map((base, idx) => {
                              const info = products[base.productId];
                              const inBundle = editor.items.some((i) => i.productId === base.productId);
                              return (
                                <div key={base.productId} style={{
                                  display: "flex", alignItems: "center", gap: 12, padding: "10px 0",
                                  borderTop: idx ? "1px solid var(--p-color-border-secondary)" : "none",
                                }}>
                                  <Thumbnail source={info?.imageUrl ?? ""} alt="" size="small" />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <Text as="p" fontWeight="medium" truncate>{info?.title ?? base.title}</Text>
                                    <InlineStack gap="150" blockAlign="center">
                                      {inBundle && <Text as="p" variant="bodySm" tone="subdued">Also in this bundle</Text>}
                                      {/* A page shoppers can't open can't show the bundle. */}
                                      {info?.onStore === false && <Badge tone="critical">Not on Online Store</Badge>}
                                    </InlineStack>
                                  </div>
                                  <Button
                                    variant="plain"
                                    tone="critical"
                                    onClick={() => update("baseProducts", editor.baseProducts.filter((_, i) => i !== idx))}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              );
                            })}
                          </BlockStack>
                        )}
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>

                {/* ── Pricing ── */}
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Pricing</Text>
                    {/* Boxes can't have a fixed price; recurring bundles (fixed
                        contents, so a fixed count) can't have tiers. */}
                    <InlineGrid columns={{ xs: 1, sm: box || recurring ? 2 : 3 }} gap="300">
                      <OptionTile
                        selected={mode === "PERCENT"}
                        title="% off"
                        description="One discount on every item."
                        onClick={() => update("pricingMode", "PERCENT")}
                      />
                      {!box && (
                        <OptionTile
                          selected={mode === "FIXED_PRICE"}
                          title="Fixed price"
                          description={`One price for the set, like "all 3 for ${money(99, currency)}".`}
                          onClick={() => update("pricingMode", "FIXED_PRICE")}
                        />
                      )}
                      {!recurring && (
                        <OptionTile
                          selected={mode === "TIERED"}
                          title="Tiered by quantity"
                          description="The more items, the bigger the discount."
                          onClick={() => update("pricingMode", "TIERED")}
                        />
                      )}
                    </InlineGrid>

                    {mode === "PERCENT" && (
                      <BlockStack gap="200">
                        <div style={{ maxWidth: 200 }}>
                          <TextField
                            label="Bundle discount"
                            type="number"
                            suffix="%"
                            value={editor.discountPercent}
                            onChange={(v) => update("discountPercent", v.replace(/[^\d.]/g, ""))}
                            autoComplete="off"
                          />
                        </div>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {box
                            ? `Applied to everything in the box once the shopper has picked at least ${Number(editor.minItems) || 1}.`
                            : recurring
                            ? "Taken off the bundle's price on every delivery."
                            : "Applied at checkout to every item the shopper keeps ticked, in any size or colour."}
                        </Text>
                      </BlockStack>
                    )}

                    {mode === "FIXED_PRICE" && (
                      <BlockStack gap="200">
                        <div style={{ maxWidth: 220 }}>
                          <TextField
                            label="Price for the whole set"
                            type="number"
                            min={0}
                            prefix={currencySymbol(currency)}
                            value={editor.fixedPrice}
                            onChange={(v) => update("fixedPrice", v.replace(/[^\d.]/g, ""))}
                            autoComplete="off"
                          />
                        </div>
                        {listKnown && (
                          <Text as="p" variant="bodySm" tone={fixedPrice > 0 && !matching ? "critical" : undefined}>
                            {`List total ${money(listTotal, currency)}`}
                            {fixedPrice > 0
                              ? matching ? ` · about ${matching}% off` : " · the price must be below this"
                              : ""}
                          </Text>
                        )}
                        <Text as="p" variant="bodySm" tone="subdued">
                          {recurring
                            ? "Charged exactly, on every delivery. The bundle's product is priced at today's list total when you save, so save again if the items' prices change."
                            : "Charged exactly at checkout when the shopper keeps the whole set. If they untick items, what they keep gets the matching percentage."}
                        </Text>
                      </BlockStack>
                    )}

                    {mode === "TIERED" && (
                      <BlockStack gap="200">
                        {editor.tiers.map((tier, idx) => (
                          <InlineStack key={idx} gap="200" blockAlign="end" wrap={false}>
                            <div style={{ width: 150 }}>
                              <TextField
                                label="Items"
                                labelHidden={idx > 0}
                                type="number"
                                min={1}
                                suffix="or more"
                                value={tier.minItems}
                                onChange={(v) => updateTier(idx, { minItems: v.replace(/\D/g, "") })}
                                autoComplete="off"
                              />
                            </div>
                            <div style={{ width: 130 }}>
                              <TextField
                                label="Discount"
                                labelHidden={idx > 0}
                                type="number"
                                suffix="% off"
                                value={tier.percent}
                                onChange={(v) => updateTier(idx, { percent: v.replace(/[^\d.]/g, "") })}
                                autoComplete="off"
                              />
                            </div>
                            <div style={{ paddingBottom: 6 }}>
                              <Button
                                variant="plain"
                                tone="critical"
                                disabled={editor.tiers.length <= 1}
                                onClick={() => update("tiers", editor.tiers.filter((_, i) => i !== idx))}
                              >
                                Remove
                              </Button>
                            </div>
                          </InlineStack>
                        ))}
                        <InlineStack>
                          <Button onClick={addTier} disabled={editor.tiers.length >= MAX_TIERS}>Add tier</Button>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {`The highest tier reached applies to every ${box ? "item in the box" : "item the shopper keeps ticked"}, at checkout. Up to ${MAX_TIERS} tiers.`}
                        </Text>
                      </BlockStack>
                    )}
                  </BlockStack>
                </Card>

                {/* ── Renewal & payment ── */}
                {recurring && (
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">Renewal & payment</Text>
                      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                        <TextField
                          label="Renews every"
                          type="number"
                          min={1}
                          value={editor.intervalCount}
                          onChange={(v) => update("intervalCount", v.replace(/\D/g, ""))}
                          autoComplete="off"
                          connectedRight={
                            <Select label="Unit" labelHidden options={INTERVAL_OPTIONS} value={editor.interval} onChange={(v) => update("interval", v)} />
                          }
                        />
                        <Select
                          label="Payment type"
                          options={PAYMENT_MODE_OPTIONS}
                          value={editor.paymentMode}
                          onChange={(v) => update("paymentMode", parsePaymentMode(v))}
                        />
                      </InlineGrid>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {editor.paymentMode === "PREPAID"
                          ? "Nothing is charged automatically. Before each delivery the customer is emailed a link to confirm and pay. Changing this affects new subscribers only."
                          : "The customer's saved card is charged automatically each cycle."}
                      </Text>
                      {editor.paymentMode === "PREPAID" && (
                        <Select
                          label="Payment email sent by"
                          options={EMAIL_SENDER_OPTIONS}
                          value={editor.paymentEmailSender}
                          onChange={(v) => update("paymentEmailSender", parseEmailSender(v))}
                        />
                      )}
                      {editor.paymentMode === "PREPAID" && (
                        <Select
                          label="Send the payment link"
                          options={lead.options}
                          value={lead.value}
                          onChange={(v) => update("prepaidLeadHours", v)}
                          helpText="How long before each billing date the customer is emailed the link. Links go out every 15 minutes, so it can arrive up to 15 minutes after this point."
                        />
                      )}
                    </BlockStack>
                  </Card>
                )}

                {/* ── Theme ── (a box has one layout of its own) */}
                {!box && <Card>
                  <BlockStack gap="300">
                    <BlockStack gap="050">
                      <Text as="h2" variant="headingMd">Storefront theme</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        How this bundle looks on product pages. Colours follow the "Product bundles" block's accent colour.
                      </Text>
                    </BlockStack>
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                      {BUNDLE_DESIGNS.map((d) => {
                        const selected = editor.design === d.value;
                        return (
                          <button
                            key={d.value}
                            type="button"
                            onClick={() => update("design", d.value)}
                            style={{
                              textAlign: "left", cursor: "pointer", borderRadius: 14, padding: 12,
                              border: selected ? `2px solid ${ACCENT}` : "1px solid var(--p-color-border)",
                              background: selected ? "#F5F3FF" : "var(--p-color-bg-surface)",
                            }}
                          >
                            <div style={{ background: "#fafafa", borderRadius: 10, padding: 8, marginBottom: 10 }}>
                              <MiniBundlePreview {...previewProps} design={d.value} height={132} />
                            </div>
                            <InlineStack gap="200" blockAlign="center">
                              <span style={{
                                width: 16, height: 16, borderRadius: "50%", flexShrink: 0,
                                border: selected ? `5px solid ${ACCENT}` : "2px solid var(--p-color-border)",
                              }} />
                              <Text as="span" fontWeight="semibold">{d.label}</Text>
                            </InlineStack>
                            <div style={{ marginTop: 4 }}>
                              <Text as="p" variant="bodySm" tone="subdued">{d.description}</Text>
                            </div>
                          </button>
                        );
                      })}
                    </InlineGrid>
                  </BlockStack>
                </Card>}
              </BlockStack>
            </Layout.Section>

            {/* ── Live preview ── */}
            <Layout.Section variant="oneThird">
              <div style={{ position: "sticky", top: 16 }}>
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">Live preview</Text>
                      <Badge tone="info">{box ? "Box layout" : bundleDesignLabel(editor.design)}</Badge>
                    </InlineStack>
                    <div style={{ background: "#f6f6f7", borderRadius: 12, padding: 14 }}>
                      <BundlePreview {...previewProps} design={editor.design} />
                    </div>
                    <Text as="p" variant="bodySm" fontWeight="medium">
                      {shownOnText(editor.showOn, editor.baseProducts, products)}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {box
                        ? `Shown with ${Math.max(1, Number(editor.minItems) || 1)} picked. On the storefront every product starts at 0. Prices are today's product prices.`
                        : "Prices are today's product prices. On the storefront the discount is applied at checkout."}
                    </Text>
                  </BlockStack>
                </Card>
              </div>
            </Layout.Section>
          </Layout>
        </BlockStack>
      </Page>
    );
  }

  // ═══ List view ═════════════════════════════════════════════
  const selected       = bundles.find((b) => b.id === selectedId) ?? null;
  const selectedLocked = selected?.type === "RECURRING" && !!selected.bundleVariantId;
  const selectedItems  = selected ? toPreviewItems(toEditorItems(selected.items, products).items, products, selectedLocked) : [];
  const previewDesign  = peekDesign ?? (selected ? parseBundleDesign(selected.design) : "classic");
  const selectedIsBox  = selected?.kind === "BOX";

  return (
    <Page
      title="Bundles"
      subtitle="Sell a set of products together at a discount, once or as a subscription."
      primaryAction={{ content: "Create bundle", onAction: openCreate }}
    >
      <TitleBar title="Bundles" />
      <BlockStack gap="400">
        {banners}

        <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
          <StatTile label="Bundles"   value={stats.total}     tint={ACCENT} />
          <StatTile label="Active"    value={stats.active}    tint="#3B6D11" />
          <StatTile label="Recurring" value={stats.recurring} tint="#185FA5" />
          <StatTile label="One-time"  value={stats.oneTime}   tint="#BA7517" />
        </InlineGrid>

        <Layout>
          <Layout.Section>
            {bundles.length === 0 ? (
              <Card>
                <EmptyState
                  heading="Create your first bundle"
                  action={{ content: "Create bundle", onAction: openCreate }}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    Group products at a discount, sold once or as a subscription. Each bundle shows on the page of every
                    product in it. Add the "Product bundles" block to your product template in the theme editor.
                  </p>
                </EmptyState>
              </Card>
            ) : (
              <BlockStack gap="300">
                {bundles.map((b) => {
                  const grouped    = toEditorItems(b.items, products).items;
                  // Its product is live: a recurring bundle is sold as it, a
                  // one-time bundle's lines are grouped under it in the cart.
                  const hasProduct = !!b.bundleVariantId;
                  const asProduct  = b.type === "RECURRING" && hasProduct;
                  const items      = toPreviewItems(grouped, products, asProduct);
                  const isSelected = b.id === selectedId;
                  const notLive    = b.type === "RECURRING" && !b.shopifySellingPlanId;
                  // Saved before bundles had their own product, or it isn't live yet.
                  const perItem    = !hasProduct && (b.type === "ONE_TIME" || !!b.shopifySellingPlanId);
                  const isBox      = b.kind === "BOX";
                  const offStore   = offStoreWarning(b.kind, grouped, products);
                  const offBases   = b.showOn === "BASE" ? offStoreTitles(b.baseProducts, products) : [];
                  const names      = items.map((i) => (!isBox && i.quantity > 1 ? `${i.title} × ${i.quantity}` : i.title));
                  const pricing    = pricingSummary({
                    kind:            b.kind,
                    pricingMode:     b.pricingMode,
                    discountPercent: b.discountPercent,
                    fixedPrice:      b.fixedPrice,
                    minItems:        b.minItems,
                    tiers:           parseTiers(b.tiersJson),
                    itemCount:       items.reduce((s, i) => s + i.quantity, 0),
                  }, (amount) => money(amount, currency));
                  return (
                    <div
                      key={b.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => { setSelectedId(b.id); setPeekDesign(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { setSelectedId(b.id); setPeekDesign(null); } }}
                      style={{
                        background: "var(--p-color-bg-surface)", borderRadius: 16, cursor: "pointer",
                        border: isSelected ? `2px solid ${ACCENT}` : "1px solid var(--p-color-border)",
                        padding: isSelected ? 17 : 18,
                        boxShadow: isSelected ? "0 6px 18px rgba(91,79,203,.14)" : "0 1px 2px rgba(0,0,0,.04)",
                        opacity: b.active ? 1 : 0.7,
                        transition: "box-shadow .15s, border-color .15s",
                      }}
                    >
                      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                        <ThumbStack items={items} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <BlockStack gap="150">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="h2" variant="headingMd">{b.name}</Text>
                              <Badge tone={b.type === "RECURRING" ? "info" : undefined}>
                                {b.type === "RECURRING" ? "Recurring" : "One-time"}
                              </Badge>
                              {b.type === "RECURRING" && (
                                <Badge tone={b.paymentMode === "PREPAID" ? "attention" : undefined}>
                                  {b.paymentMode === "PREPAID" ? "Prepaid" : "Postpaid"}
                                </Badge>
                              )}
                              {isBox ? <Badge tone="success">Build-your-own box</Badge> : <Badge>{bundleDesignLabel(b.design)}</Badge>}
                              {!b.active && <Badge tone="warning">Off</Badge>}
                              {notLive && <Badge tone="critical">Not live</Badge>}
                            </InlineStack>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {pricing}
                              {b.type === "RECURRING" ? ` · ${intervalText(b.interval, b.intervalCount).toLowerCase()}` : ""}
                              {` · ${items.length} product${items.length === 1 ? "" : "s"}${isBox ? " to pick from" : ""}`}
                            </Text>
                            <Text as="p" variant="bodySm" tone={b.showOn === "BASE" && !b.baseProducts.length ? "critical" : "subdued"}>
                              {b.showOn === "BASE" ? "📍 " : ""}{shownOnText(b.showOn, b.baseProducts, products)}
                            </Text>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {names.slice(0, 4).map((n) => (
                                <span key={n} style={{
                                  fontSize: 12, padding: "3px 10px", borderRadius: 999, maxWidth: 220,
                                  background: "var(--p-color-bg-surface-secondary)", color: "var(--p-color-text)",
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}>{n}</span>
                              ))}
                              {names.length > 4 && (
                                <span style={{ fontSize: 12, padding: "3px 10px", borderRadius: 999, background: "#EEEDFE", color: "#3C3489" }}>
                                  +{names.length - 4} more
                                </span>
                              )}
                            </div>
                            {notLive && (
                              <Text as="p" tone="critical" variant="bodySm">
                                Its subscription plan isn't set up in Shopify yet, so it isn't on the storefront. Open it and save again.
                              </Text>
                            )}
                            {hasProduct && b.bundleProductId && (
                              <Text as="p" variant="bodySm" tone="subdued">
                                {asProduct
                                  ? "Sold as one product, one line in the cart and on orders."
                                  : "Shown as one bundle in cart and checkout, with its items underneath."}{" "}
                                <Link url={`shopify://admin/products/${b.bundleProductId.split("/").pop()}`} target="_top">
                                  View it in Shopify
                                </Link>
                              </Text>
                            )}
                            {perItem && (
                              <Text as="p" tone="caution" variant="bodySm">
                                {`${b.type === "RECURRING" ? "Adds one cart line per item" : "Shows as separate lines in the cart"}. `}
                                {b.bundleProductId
                                  // Created, but publishing it to the Online Store failed:
                                  // usually a permission not approved yet.
                                  ? "Its product exists but isn't on your Online Store yet. Approve the app's updated permissions, then open the bundle and save again; if it still fails, the message says why."
                                  : b.type === "RECURRING"
                                  ? "Open it and save to sell it as one product."
                                  : "Open it and save to group it into one bundle."}
                              </Text>
                            )}
                            {offStore && <Text as="p" tone="critical" variant="bodySm">{offStore}</Text>}
                            {offBases.length > 0 && (
                              <Text as="p" tone="critical" variant="bodySm">
                                {`${joinNames(offBases)} ${offBases.length === 1 ? "isn't" : "aren't"} on your Online Store, so shoppers can't see the bundle there.`}
                              </Text>
                            )}
                          </BlockStack>
                        </div>
                        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
                          <InlineStack gap="200" wrap={false}>
                            <Button size="slim" onClick={() => openEdit(b)} disabled={busy}>Edit</Button>
                            <Button size="slim" onClick={() => openDuplicate(b)} disabled={busy}>Duplicate</Button>
                            <Button size="slim" onClick={() => toggle(b.id, !b.active)} disabled={busy}>
                              {b.active ? "Turn off" : "Turn on"}
                            </Button>
                            <Button size="slim" variant="plain" tone="critical" onClick={() => remove(b.id, b.name)} disabled={busy}>
                              Delete
                            </Button>
                          </InlineStack>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </BlockStack>
            )}
          </Layout.Section>

          {/* ── Storefront preview ── */}
          <Layout.Section variant="oneThird">
            <div style={{ position: "sticky", top: 16 }}>
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Storefront preview</Text>
                    {selected && <Button variant="plain" onClick={() => openEdit(selected)}>Edit</Button>}
                  </InlineStack>

                  {/* Try the other themes without saving. A box has one layout. */}
                  {!selectedIsBox && <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {BUNDLE_DESIGNS.map((d) => {
                      const on = previewDesign === d.value;
                      return (
                        <button
                          key={d.value}
                          type="button"
                          onClick={() => setPeekDesign(d.value)}
                          style={{
                            fontSize: 12, padding: "5px 10px", borderRadius: 999, cursor: "pointer",
                            border: on ? "1px solid transparent" : "1px solid var(--p-color-border)",
                            background: on ? BRAND_GRADIENT : "var(--p-color-bg-surface)",
                            color: on ? "#fff" : "var(--p-color-text)", fontWeight: on ? 600 : 400,
                          }}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>}

                  <div style={{ background: "#f6f6f7", borderRadius: 12, padding: 14 }}>
                    <BundlePreview
                      design={previewDesign}
                      name={selected?.name ?? "Snowboard starter kit"}
                      discountPercent={selected?.discountPercent ?? 10}
                      items={selected ? selectedItems : [
                        { key: "a", title: "Snowboard",  imageUrl: null, price: 499, quantity: 1, variantChoice: true, variantLabel: "Blue / 152cm" },
                        { key: "b", title: "Bindings",   imageUrl: null, price: 149, quantity: 1, variantChoice: false },
                        { key: "c", title: "Board wax",  imageUrl: null, price: 12,  quantity: 2, variantChoice: false },
                      ]}
                      frequency={selected && selected.type === "RECURRING" ? intervalText(selected.interval, selected.intervalCount) : null}
                      prepaid={!!selected && selected.type === "RECURRING" && selected.paymentMode === "PREPAID"}
                      currency={currency}
                      kind={selected ? parseBundleKind(selected.kind) : "SET"}
                      pricingMode={selected ? parsePricingMode(selected.pricingMode) : "PERCENT"}
                      fixedPrice={selected?.fixedPrice ?? null}
                      minItems={selected?.minItems ?? 0}
                      tiers={selected ? parseTiers(selected.tiersJson) : []}
                      locked={selectedLocked}
                    />
                  </div>

                  <Text as="p" variant="bodySm" tone="subdued">
                    {selected
                      ? peekDesign && peekDesign !== parseBundleDesign(selected.design)
                        ? `Previewing ${bundleDesignLabel(peekDesign)}. Edit the bundle to use this theme.`
                        : `${shownOnText(selected.showOn, selected.baseProducts, products)}.`
                      : "An example bundle. Create one to see yours here."}
                  </Text>
                </BlockStack>
              </Card>
            </div>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
