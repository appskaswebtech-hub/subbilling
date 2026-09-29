// app/lib/bundle-metafield.server.ts
//
// Stores the shop's product bundles IN SHOPIFY, on this app's own
// installation, where the "Product bundles" theme block reads them directly:
//
//   {{ app.metafields.kas_bundles.config.value }}
//
// Why: the block used to learn its bundles only by calling the app through the
// /apps/subscriptions app proxy, and that failed whenever the store didn't
// route the proxy path to this app — another app holding the same path
// (smartsavings-7424 → a 302 from staging), or no proxy route at all
// (subscription-testiing → a 404 from the store). Reading the bundles from
// Shopify removes the proxy from the path entirely. Same approach as the
// widget config in widget-metafield.server.ts.
//
// ─── Merge, don't replace ──────────────────────────────────────────────────
// Local dev and the live server can share one store, each with its own
// database. Bundles are keyed by id, so each environment replaces only the
// bundles it knows; deleted ones are removed explicitly.
//
// This module only reads, merges and writes. bundles.server.ts builds the
// entries (syncBundleMetafield), so the dependency runs one way.
//
// Never throws: a failure here must not fail the save that triggered it.

import type { AdminGraphQL } from "./subscription-contract.server";

export const BUNDLE_METAFIELD_NAMESPACE = "kas_bundles";
export const BUNDLE_METAFIELD_KEY       = "config";

const CONFIG_READ = `#graphql
  query BundleConfigRead {
    currentAppInstallation {
      id
      metafield(namespace: "kas_bundles", key: "config") { jsonValue }
    }
  }
`;

const CONFIG_WRITE = `#graphql
  mutation BundleConfigWrite($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

/** What the theme block reads. Bump `v` only for an incompatible change. */
export interface BundleConfigDoc {
  v:       1;
  bundles: Record<string, unknown>;
}

function asDoc(raw: unknown): BundleConfigDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<BundleConfigDoc>;
  if (!r.bundles || typeof r.bundles !== "object") return null;
  return r as BundleConfigDoc;
}

/**
 * Merges this database's bundles into the stored document and writes it.
 * Skips the write when nothing changed, so it is cheap on page loads.
 */
export async function writeBundleMetafield(
  graphql: AdminGraphQL,
  shop: string,
  local: Record<string, unknown>,
  removedBundleIds: string[] = [],
): Promise<void> {
  try {
    const res  = await graphql(CONFIG_READ);
    const body = await res.json() as {
      errors?: Array<{ message: string }>;
      data?: { currentAppInstallation?: { id: string; metafield?: { jsonValue?: unknown } | null } };
    };
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(" | "));
    const installationId = body.data?.currentAppInstallation?.id;
    if (!installationId) throw new Error("No app installation returned");

    const existing = asDoc(body.data?.currentAppInstallation?.metafield?.jsonValue);
    const removed  = new Set(removedBundleIds);

    const bundles: Record<string, unknown> = {};
    for (const [id, entry] of Object.entries(existing?.bundles ?? {})) {
      if (!removed.has(id)) bundles[id] = entry;
    }
    for (const [id, entry] of Object.entries(local)) {
      if (!removed.has(id)) bundles[id] = entry;
    }

    const doc: BundleConfigDoc = { v: 1, bundles };
    if (existing && JSON.stringify(existing) === JSON.stringify(doc)) return;

    const write     = await graphql(CONFIG_WRITE, {
      variables: {
        metafields: [{
          ownerId:   installationId,
          namespace: BUNDLE_METAFIELD_NAMESPACE,
          key:       BUNDLE_METAFIELD_KEY,
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

    console.log(`[bundle-metafield] ${shop}: stored ${Object.keys(bundles).length} bundle(s) in Shopify`);
  } catch (err) {
    console.error(`[bundle-metafield] ${shop}: could not store bundles in Shopify:`,
      err instanceof Error ? err.message : err);
  }
}
