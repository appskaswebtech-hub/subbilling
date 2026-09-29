// app/lib/widget-metafield.server.ts
//
// Stores the storefront widget's configuration (per-plan design, benefit chips
// and colours, plus the shop-wide values) IN SHOPIFY, on this app's own
// installation, where the theme block reads it directly with Liquid:
//
//   {{ app.metafields.kas_widget.config.value }}
//
// Why: the widget otherwise learns a plan's chips only by asking an app server
// through the /apps/subscriptions proxy, and that proxy reaches exactly ONE
// server and its database. A plan saved anywhere else (local dev, staging) was
// invisible to the store: it was hidden as "untracked" and its chips never
// showed. With the configuration stored in Shopify, whatever the app saves is
// what the block renders, whichever server the proxy happens to reach.
//
// ─── Merge, don't replace ──────────────────────────────────────────────────
// Several environments of the same app can share one store (local dev and
// the live server did on smartsavings-7424), each with its own database. Plans
// are keyed by their Shopify selling plan id, which is unique across all of
// them, so each environment replaces only the plans it knows and leaves the
// rest alone. Deleted plans are removed explicitly (removedPlanIds); a stale
// entry would be harmless anyway, since a deleted plan is no longer on any
// product for the block to render.
//
// Never throws: a failure here must not fail the save that triggered it. The
// proxy keeps working as before; this is the layer on top.

import { buildWidgetConfig, type PlanWidget, type ShopWidget } from "./widget-settings.server";
import type { AdminGraphQL } from "./subscription-contract.server";

export const WIDGET_METAFIELD_NAMESPACE = "kas_widget";
export const WIDGET_METAFIELD_KEY       = "config";

const CONFIG_READ = `#graphql
  query WidgetConfigRead {
    currentAppInstallation {
      id
      metafield(namespace: "kas_widget", key: "config") { jsonValue }
    }
  }
`;

const CONFIG_WRITE = `#graphql
  mutation WidgetConfigWrite($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

/** What the theme block reads. Bump `v` only for an incompatible change. */
export interface WidgetConfigDoc {
  v:     1;
  shop:  ShopWidget;
  plans: Record<string, PlanWidget>;
}

function asDoc(raw: unknown): WidgetConfigDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WidgetConfigDoc>;
  if (!r.plans || typeof r.plans !== "object") return null;
  return r as WidgetConfigDoc;
}

/**
 * Writes this database's widget configuration into Shopify, merged with what
 * other environments of the app have stored. Skips the write when nothing
 * changed, so it is cheap enough to call on page loads.
 */
export async function syncWidgetMetafield(
  graphql: AdminGraphQL,
  shop: string,
  opts: { removedPlanIds?: string[] } = {},
): Promise<void> {
  try {
    const local = await buildWidgetConfig(shop);

    const res  = await graphql(CONFIG_READ);
    const body = await res.json() as {
      errors?: Array<{ message: string }>;
      data?: { currentAppInstallation?: { id: string; metafield?: { jsonValue?: unknown } | null } };
    };
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(" | "));
    const installationId = body.data?.currentAppInstallation?.id;
    if (!installationId) throw new Error("No app installation returned");

    const existing = asDoc(body.data?.currentAppInstallation?.metafield?.jsonValue);
    const removed  = new Set((opts.removedPlanIds ?? []).map((id) => id.split("/").pop() ?? id));

    const plans: Record<string, PlanWidget> = {};
    for (const [id, widget] of Object.entries(existing?.plans ?? {})) {
      if (!removed.has(id)) plans[id] = widget;
    }
    for (const [id, widget] of Object.entries(local.plans)) {
      if (!removed.has(id)) plans[id] = widget;
    }

    const doc: WidgetConfigDoc = { v: 1, shop: local.shop, plans };
    if (existing && JSON.stringify(existing) === JSON.stringify(doc)) return;

    const write     = await graphql(CONFIG_WRITE, {
      variables: {
        metafields: [{
          ownerId:   installationId,
          namespace: WIDGET_METAFIELD_NAMESPACE,
          key:       WIDGET_METAFIELD_KEY,
          type:      "json",
          value:     JSON.stringify(doc),
        }],
      },
    });
    const writeBody = await write.json() as {
      errors?: Array<{ message: string }>;
      data?: { metafieldsSet?: { userErrors?: Array<{ message: string }> } };
    };
    if (writeBody.errors?.length) throw new Error(writeBody.errors.map((e) => e.message).join(" | "));
    const userErrors = writeBody.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length) throw new Error(userErrors.map((e) => e.message).join(" | "));

    console.log(`[widget-metafield] ${shop}: stored config for ${Object.keys(plans).length} plan(s)`);
  } catch (err) {
    console.error(`[widget-metafield] ${shop}: could not store widget config in Shopify:`,
      err instanceof Error ? err.message : err);
  }
}
