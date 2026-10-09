import '@shopify/ui-extensions/preact';
import {render} from 'preact';

/*
 * A "Show N items" dropdown under a recurring bundle's line, listing each item
 * with its image, like Shopify's own bundle lines: in the checkout order
 * summary, on the Thank you page and on the Order status page (new customer
 * accounts). The theme's cart gets the same dropdown from the app embed
 * extensions/subscription/blocks/bundle-cart-items.liquid.
 *
 * A recurring bundle is sold as one product (app/lib/bundles.server.ts), and
 * Shopify won't group items under a line that has a selling plan, so it can't
 * show them itself. The storefront bundle block
 * (extensions/subscription/assets/bundle-offer.js) writes them into the line's
 * hidden `_kas_items` property: [{ t: product, v: variant, q: quantity,
 * i: image URL }]. Lines added before `v` existed carry "Product – Variant" in
 * `t`. Every other line has no such property and renders nothing here.
 *
 * The checkout target only runs on Shopify Plus stores (elsewhere the line
 * keeps its visible "Includes" property); the Thank you and Order status
 * targets run on every plan.
 */

export default function extension() {
  render(<BundleItems />, document.body);
}

const MAX_ITEMS = 20;

/** The items from the line's `_kas_items`, or [] if it has none or it's malformed. */
function readItems(line) {
  const raw = line?.attributes?.find((a) => a.key === '_kas_items')?.value;
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((x) => x && typeof x.t === 'string' && x.t).slice(0, MAX_ITEMS)
      : [];
  } catch {
    return [];
  }
}

function BundleItems() {
  const items = readItems(shopify.target.value);
  if (!items.length) return null;
  const count = items.reduce((sum, item) => sum + (item.q > 0 ? item.q : 1), 0);

  // Collapsed until the buyer opens it, like Shopify's own "Show N items".
  return (
    <s-details>
      <s-summary>{`Show ${count} item${count === 1 ? '' : 's'}`}</s-summary>
      <s-stack direction="block" gap="small-200">
        {items.map((item, idx) => (
          <s-stack key={idx} direction="inline" gap="small-200" alignItems="center">
            <s-product-thumbnail
              src={item.i || undefined}
              alt={item.t}
              size="small"
              totalItems={item.q > 1 ? item.q : undefined}
            ></s-product-thumbnail>
            <s-stack direction="block" gap="none">
              <s-text>{`${item.q > 0 ? item.q : 1} × ${item.t}`}</s-text>
              {typeof item.v === 'string' && item.v ? (
                <s-text type="small" color="subdued">{item.v}</s-text>
              ) : null}
            </s-stack>
          </s-stack>
        ))}
      </s-stack>
    </s-details>
  );
}
