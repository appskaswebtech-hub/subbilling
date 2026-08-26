// app/routes/app.cleanup.tsx

import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { Page, BlockStack, InlineStack, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import dashboardStyles from "../styles/dashboard.css?url";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];

// ─── Design tokens ───────────────────────────────────────────
const T = {
  purple:    "#7F77DD",
  purpleBg:  "#EEEDFE",
  purpleDark:"#26215C",
  purpleFg:  "#3C3489",
  greenBg:   "#EAF3DE",
  greenFg:   "#27500A",
  greenDot:  "#3B6D11",
  redBg:     "#FCEBEB",
  redFg:     "#791F1F",
  amberBg:   "#FAEEDA",
  amberFg:   "#633806",
  blueBg:    "#E6F1FB",
  blueFg:    "#185FA5",
};

// ─── Types ───────────────────────────────────────────────────
type GroupProduct = { id: string; title: string };

type SellingPlanGroup = {
  id: string;
  name: string;
  createdAt: string;
  /** false = live in Shopify but absent from this app's database. */
  tracked: boolean;
  /**
   * Whether THIS installation can delete it.
   *
   * Shopify scopes selling plan WRITES to the installation that created the
   * group. Reads are not scoped, so a foreign group is fully visible here while
   * every mutation against it is refused. Verified against a live shop: both
   * `sellingPlanGroupDelete` and `sellingPlanGroupRemoveProducts` answer
   * "Selling plan group does not exist" for a group this app does not own.
   * Rendering a Delete button for one would only produce that error.
   *
   * `sellingPlanGroups` defaults to `app_id:CURRENT`, so membership of that list
   * IS the ownership test.
   */
  removable: boolean;
  /**
   * Products it is attached to — the admin pages where it can be removed by hand.
   *
   * Union of two associations: whole products, and individual variants rolled up
   * to their parent product. A variant-only attachment is invisible on the
   * group's `products` connection, so querying just that one under-reports —
   * a Gift Card attached by variant showed as "on no products" while it was
   * still selling.
   */
  products: GroupProduct[];
  /** Raw Shopify counts, which can exceed what `products` lists (see truncation). */
  attachedProducts: number;
  attachedVariants: number;
  /** Live subscription contracts using its plans; the basis for deleting safely. */
  contractCount: number;
};
type LoaderData = {
  groups: SellingPlanGroup[];
  error?: string;
  /** True when Shopify had more groups than one page — say so rather than imply completeness. */
  truncated?: boolean;
};
type ActionData = { id: string; success: boolean; error?: string };

// ─── Loader ──────────────────────────────────────────────────
// Groups this app's own database still knows about. NOT an ownership test —
// see the loader for why the two must not be conflated.
async function trackedGroupIds(shop: string): Promise<Set<string>> {
  const rows = await prisma.sellingPlanGroup.findMany({
    where:  { shop, shopifyGroupId: { not: null } },
    select: { shopifyGroupId: true },
  });
  return new Set(rows.map((r) => r.shopifyGroupId as string));
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  type PlanEdges = { edges: { node: { id: string } }[] };
  type GroupNode = {
    id: string;
    name: string;
    createdAt: string;
    productsCount:        { count: number } | null;
    productVariantsCount: { count: number } | null;
    products:        { edges: { node: { id: string; title: string } }[] };
    productVariants: { edges: { node: { product: { id: string; title: string } } }[] };
    sellingPlans: PlanEdges;
  };
  type Data = {
    errors?: { message: string }[];
    data: {
      owned:      { edges: { node: { id: string } }[] };
      everyGroup: { pageInfo: { hasNextPage: boolean }; edges: { node: GroupNode }[] };
    };
  };

  // TWO aliases of the SAME query, because they answer different questions.
  //
  // `sellingPlanGroups` defaults to `app_id:CURRENT` — only groups THIS
  // INSTALLATION created — which is precisely the ownership test `removable`
  // needs, and equally the reason it cannot be used to enumerate. Passing
  // `app_id:ALL` lifts that scope and returns every group on the shop.
  //
  // This replaces an earlier `products(first: 100)` walk that inferred the group
  // list from whatever was attached to a product. That under-reported badly: on
  // a real shop it found 1 group where `app_id:ALL` finds 6, because a group
  // attached to NO product is invisible from the product side — and those are
  // exactly the ones nothing else will ever surface. It is also far cheaper
  // (actual query cost 13 against a real shop, versus walking 100 products).
  let data: Data;
  try {
    const response = await admin.graphql(`
      query CleanupSellingPlanGroups {
        owned: sellingPlanGroups(first: 50) {
          edges { node { id } }
        }
        everyGroup: sellingPlanGroups(first: 50, query: "app_id:ALL") {
          pageInfo { hasNextPage }
          edges { node {
            id name createdAt
            productsCount { count }
            productVariantsCount { count }
            products(first: 25) { edges { node { id title } } }
            productVariants(first: 25) { edges { node { product { id title } } } }
            sellingPlans(first: 20) { edges { node { id } } }
          } }
        }
      }
    `);
    data = await response.json() as unknown as Data;
  } catch (err) {
    // The request never reached Shopify, so there is no HTTP response to read an
    // error out of — a dropped TCP connection arrives here as the bare "fetch
    // failed". Uncaught, it throws out of the loader and Remix replaces the whole
    // page with a raw stack trace, which is what a merchant saw. The same
    // principle is already applied to the contract-count lookup below; the main
    // query was simply never given it.
    //
    // `error` is rendered as a banner and Refresh re-runs the loader, so a
    // momentary blip degrades to a retry instead of a crash.
    console.error("[cleanup] selling plan group lookup failed:", err);
    return json<LoaderData>({
      groups: [],
      error: `Could not reach Shopify — ${err instanceof Error ? err.message : "network error"}. Press Refresh to try again.`,
    });
  }

  if (data.errors) {
    return json<LoaderData>({ groups: [], error: data.errors[0]?.message ?? "Failed to fetch" });
  }

  const tracked = await trackedGroupIds(session.shop);

  // Membership here is the ownership test — see the query comment above.
  const ownedIds = new Set(data.data.owned.edges.map(({ node }) => node.id));

  const byId = new Map<string, SellingPlanGroup & { planIds: Set<string> }>();
  for (const { node } of data.data.everyGroup.edges) {
    // Both association shapes, de-duplicated to one row per product. A group can
    // be attached to a whole product OR to individual variants, and a variant
    // attachment does not appear on the group's `products` connection — reading
    // only that one reported "no products" for a Gift Card that was still
    // selling through two of its variants.
    const byProductId = new Map<string, GroupProduct>();
    for (const e of node.products.edges) {
      byProductId.set(e.node.id, { id: e.node.id, title: e.node.title });
    }
    for (const e of node.productVariants.edges) {
      const p = e.node.product;
      if (!byProductId.has(p.id)) byProductId.set(p.id, { id: p.id, title: p.title });
    }

    byId.set(node.id, {
      id:        node.id,
      name:      node.name,
      createdAt: node.createdAt,
      tracked:   tracked.has(node.id),
      removable: ownedIds.has(node.id),
      products:  Array.from(byProductId.values()),
      attachedProducts: node.productsCount?.count ?? 0,
      attachedVariants: node.productVariantsCount?.count ?? 0,
      contractCount: 0,
      planIds:   new Set((node.sellingPlans?.edges ?? []).map((e) => e.node.id)),
    });
  }

  // Contract usage per group. This number is the whole basis for whether deleting
  // is safe, and the page previously left the merchant to guess it.
  const planToGroup = new Map<string, string>();
  for (const g of byId.values()) for (const pid of g.planIds) planToGroup.set(pid, g.id);

  if (planToGroup.size > 0) {
    try {
      let cursor: string | null = null;
      do {
        const res: Response = await admin.graphql(`
          query ContractPlans($after: String) {
            subscriptionContracts(first: 50, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { lines(first: 5) { edges { node { sellingPlanId } } } } }
            }
          }
        `, { variables: { after: cursor } });
        const cj = await res.json() as any;
        const conn = cj?.data?.subscriptionContracts;
        if (!conn) break;
        for (const e of conn.edges) {
          for (const l of e.node.lines.edges) {
            const gid = l.node.sellingPlanId ? planToGroup.get(l.node.sellingPlanId) : undefined;
            if (gid) byId.get(gid)!.contractCount++;
          }
        }
        cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      } while (cursor);
    } catch (err) {
      // A count we could not fetch must not take the page down — the rows still
      // render, just without the reassurance the number provides.
      console.error("[cleanup] contract usage lookup failed:", err);
    }
  }

  const groups: SellingPlanGroup[] = Array.from(byId.values()).map(
    ({ planIds, ...g }) => g,
  );

  // Untracked first: they are the ones the merchant came here to remove.
  groups.sort((a, b) => {
    if (a.tracked !== b.tracked) return a.tracked ? 1 : -1;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  return json<LoaderData>({
    groups,
    truncated: data.data.everyGroup.pageInfo.hasNextPage,
  });
}

// ─── Action ──────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData  = await request.formData();
  const id        = formData.get("id") as string;
  if (!id) return json<ActionData>({ id: "", success: false, error: "No ID provided" });

  // EVERY Shopify call below sits inside one try. An uncaught throw in an action
  // does not merely fail the delete — Remix replaces the whole page with a raw
  // stack trace. The visibility pre-check used to sit outside the try and did
  // exactly that the first time a connection was dropped mid-submit.
  try {
    // Re-check server-side — the client can post any GID. Deliberately NOT
    // "has a local row": an untracked group is precisely what this page exists to
    // remove. The guard is that Shopify must return the group to this app, and
    // sellingPlanGroupDelete itself rejects groups this app did not create,
    // surfacing as the userErrors handled below.
    const visible = await admin.graphql(`
      query GroupExists($id: ID!) {
        sellingPlanGroup(id: $id) { id }
      }
    `, { variables: { id } });
    const seen = await visible.json();
    if (!seen?.data?.sellingPlanGroup?.id) {
      return json<ActionData>({ id, success: false, error: "That selling plan group is not visible to this app." });
    }

    const res  = await admin.graphql(`
      mutation DeleteSellingPlanGroup($id: ID!) {
        sellingPlanGroupDelete(id: $id) {
          deletedSellingPlanGroupId
          userErrors { field message }
        }
      }
    `, { variables: { id } });
    const d          = await res.json();
    const userErrors = d.data?.sellingPlanGroupDelete?.userErrors ?? [];
    if (userErrors.length > 0)
      return json<ActionData>({ id, success: false, error: userErrors.map((e: { message: string }) => e.message).join(", ") });

    // Keep the local mirror in step — deleting only in Shopify orphans this row.
    await prisma.sellingPlanGroup.deleteMany({
      where: { shop: session.shop, shopifyGroupId: id },
    });

    return json<ActionData>({ id, success: true });
  } catch (err) {
    // A transport failure has no HTTP response behind it, so the bare message is
    // "fetch failed" — meaningless next to a row that just refused to delete.
    // Name it, and say plainly that nothing changed, because the merchant's real
    // question is whether the group is half-deleted.
    console.error("[cleanup] delete action failed:", err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    const unreachable = /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i.test(msg);
    return json<ActionData>({
      id,
      success: false,
      error: unreachable
        ? `Could not reach Shopify (${msg}). Nothing was deleted — try again.`
        : msg,
    });
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

// ─── Page ─────────────────────────────────────────────────────
export default function AdminCleanup() {
  const { groups, error, truncated } = useLoaderData<LoaderData>();
  const revalidator       = useRevalidator();

  // Counted from the data, not from position in the list. The previous version
  // derived these from ordering alone — "everything but the newest is a likely
  // duplicate, the newest is the one to keep" — which was already wrong for a
  // single orphaned group (it reported "1 Keep This" for a row the page itself
  // labelled Orphaned), and became actively misleading once `app_id:ALL` started
  // returning every group on the shop: unrelated groups from other apps are not
  // duplicates of each other, and the newest is not automatically the keeper.
  const orphaned   = groups.filter((g) => !g.tracked).length;
  const unattached = groups.filter((g) => g.products.length === 0).length;
  const trackedCount = groups.length - orphaned;
  // Every row disabled means the app owns nothing here — worth saying once at the
  // top instead of leaving it to be inferred from a column of dead buttons.
  const noneRemovable = groups.length > 0 && groups.every((g) => !g.removable);

  const btn: React.CSSProperties = {
    fontSize: "12px", padding: "7px 14px", borderRadius: "8px",
    cursor: "pointer", fontWeight: 500, whiteSpace: "nowrap",
    display: "inline-flex", alignItems: "center", gap: "6px",
    border: "0.5px solid var(--p-color-border-secondary)",
    background: "var(--p-color-bg-surface)",
  };

  return (
    <Page>
      <TitleBar title="Clean Plans" />
      <BlockStack gap="500">

        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <BlockStack gap="100">
            <InlineStack gap="150" blockAlign="center">
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: T.purple, display: "inline-block", flexShrink: 0 }} />
              <div className="breadcrumbs-dashboard">
                <Text as="span" variant="bodySm" tone="subdued">
                  Smart Subscriptions › <span className="subscription">Clean Plans</span>
                </Text>
              </div>
            </InlineStack>
            <div className="varient-section">
              <Text as="h1" variant="headingXl" fontWeight="bold">Selling Plan Groups Cleanup</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Every selling plan group on this shop, whichever app created it. Orphaned ones first.
              </Text>
            </div>
          </BlockStack>
          <button
            onClick={() => revalidator.revalidate()}
            disabled={revalidator.state === "loading"}
            style={{
              ...btn, marginTop: "4px",
              opacity: revalidator.state === "loading" ? 0.6 : 1,
              cursor:  revalidator.state === "loading" ? "not-allowed" : "pointer",
            }}
          >
            {revalidator.state === "loading" ? "⏳ Refreshing…" : "🔄 Refresh"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div style={{ background: T.redBg, border: "0.5px solid #F09595", borderRadius: "10px", padding: "12px 16px" }}>
            <Text as="p" variant="bodySm">❌ {error}</Text>
          </div>
        )}

        {/* ── Summary card ─────────────────────────────────────── */}
        <div className="hover-card" style={{
          background: "var(--p-color-bg-surface)",
          border: "0.5px solid var(--p-color-border)",
          borderRadius: "14px", padding: "18px 20px",
          display: "flex", alignItems: "center", gap: "16px",
        }}>
          <div style={{
            width: "44px", height: "44px", borderRadius: "50%",
            background: T.purpleBg, display: "flex",
            alignItems: "center", justifyContent: "center",
            fontSize: "20px", flexShrink: 0,
          }}>
            🛡️
          </div>
          <div style={{ flex: 1 }}>
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {groups.length} selling plan group{groups.length !== 1 ? "s" : ""} found
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Includes groups created by other apps and by earlier installs of this one.
              {orphaned > 0 && (
                <>
                  {" "}Ones marked <strong>Orphaned</strong> are live in Shopify but missing from this
                  app's records — they keep appearing on your product pages while attached.
                </>
              )}
              {unattached > 0 && (
                <>
                  {" "}<strong>Not attached</strong> ones sell nothing today; they are only clutter.
                </>
              )}
            </Text>
            {/*
              Answer "why can't I delete any of these?" once, here, rather than
              leaving the merchant to infer it from a column of identical disabled
              buttons. It is the normal state after an uninstall/reinstall: write
              access is scoped to the INSTALLATION that created a group, and a new
              installation does not inherit it.
            */}
            {noneRemovable && (
              <Text as="p" variant="bodySm" tone="caution">
                🔒 This app created none of these groups, so Shopify refuses every change
                to all of them. Reinstalling the app is enough to lose write access to
                groups an earlier install made. Uninstalling the owning app clears its
                groups after about 48 hours; nothing here can delete them.
              </Text>
            )}
            {truncated && (
              <Text as="p" variant="bodySm" tone="caution">
                ⚠ Shopify returned more than one page — this list is the first 50 only.
              </Text>
            )}
          </div>
          <div style={{ display: "flex", gap: "32px", flexShrink: 0 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 700, color: T.amberFg, lineHeight: 1 }}>{orphaned}</div>
              <div style={{ fontSize: "10px", fontWeight: 600, color: T.amberFg, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: "4px" }}>Orphaned</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 700, color: "var(--p-color-text-subdued)", lineHeight: 1 }}>{unattached}</div>
              <div style={{ fontSize: "10px", fontWeight: 600, color: "var(--p-color-text-subdued)", textTransform: "uppercase", letterSpacing: "0.04em", marginTop: "4px" }}>Not Attached</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 700, color: T.greenFg, lineHeight: 1 }}>{trackedCount}</div>
              <div style={{ fontSize: "10px", fontWeight: 600, color: T.greenFg, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: "4px" }}>Tracked</div>
            </div>
          </div>
        </div>

        {/* ── Section header ───────────────────────────────────── */}
        {groups.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              Selling Plan Groups ({groups.length}) — orphaned first, then oldest → newest
            </Text>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--p-color-text-subdued)" }}>
              Sort:
              <select style={{
                fontSize: "12px", border: "0.5px solid var(--p-color-border-secondary)",
                borderRadius: "6px", padding: "4px 8px",
                background: "var(--p-color-bg-surface)", cursor: "pointer",
                color: "var(--p-color-text)",
              }}>
                <option>Oldest first</option>
                <option>Newest first</option>
              </select>
            </div>
          </div>
        )}

        {/* ── Plan list ────────────────────────────────────────── */}
        {groups.length === 0 ? (
          <div style={{
            background: "var(--p-color-bg-surface)",
            border: "0.5px solid var(--p-color-border)",
            borderRadius: "14px", padding: "40px",
            textAlign: "center",
          }}>
            <Text as="p" tone="subdued">✅ No selling plan groups found. Nothing to delete.</Text>
          </div>
        ) : (
          <div className="hover-card" style={{
            border: "0.5px solid var(--p-color-border)",
            borderRadius: "14px", overflow: "hidden",
          }}>
            {groups.map((g, index) => (
              <PlanRow
                key={g.id}
                group={g}
                isLast={index === groups.length - 1}
              />
            ))}
          </div>
        )}

        {/* ── Warning footer ───────────────────────────────────── */}
        <div style={{
          background: T.amberBg, border: "0.5px solid #DEB96A",
          borderRadius: "10px", padding: "12px 16px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span>⚠️</span>
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>Warning:</strong> Deletion is irreversible.
            </Text>
          </div>
        </div>

      </BlockStack>
    </Page>
  );
}

// ─── Plan Row ─────────────────────────────────────────────────
function PlanRow({
  group, isLast,
}: {
  group: SellingPlanGroup;
  isLast: boolean;
}) {
  const fetcher    = useFetcher<ActionData>();
  const isDeleting = fetcher.state === "submitting";
  const isDeleted  = fetcher.state === "idle" && fetcher.data?.success === true;
  const deleteError = fetcher.state === "idle" && fetcher.data?.success === false ? fetcher.data.error : null;

  // Nothing here keys off position any more. A row's emphasis now follows what is
  // actually true of it — orphaned and still attached is the state worth the
  // merchant's attention, because that is the one selling on the storefront.
  const unattached = group.products.length === 0;
  const needsAttention = !group.tracked && !unattached;

  // Shadows the module-level T deliberately — this row only needs these. Amber
  // carries the "cannot be removed from here" note, matching the Orphaned pill.
  const T = {
    greenBg: "#EAF3DE", greenFg: "#27500A",
    redBg:   "#FCEBEB", redFg:   "#791F1F",
    blueBg:  "#E6F1FB", blueFg:  "#185FA5",
    amberFg: "#633806",
  };

  const borderColor = needsAttention ? "#F09595" : "transparent";
  const iconBg      = needsAttention ? T.redBg : unattached ? "var(--p-color-bg-surface-secondary)" : T.blueBg;
  const iconFg      = needsAttention ? T.redFg : unattached ? "var(--p-color-text-subdued)" : T.blueFg;

  if (isDeleted) {
    return (
      <div style={{
        padding: "14px 18px",
        background: T.greenBg,
        borderBottom: isLast ? "none" : "0.5px solid var(--p-color-border-secondary)",
        display: "flex", alignItems: "center", gap: "10px",
      }}>
        <span style={{ fontSize: "16px" }}>✅</span>
        <Text as="p" variant="bodySm" tone="subdued">{group.name} — Deleted successfully</Text>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "14px",
      padding: "14px 18px",
      background: "var(--p-color-bg-surface)",
      borderLeft: `3px solid ${borderColor}`,
      borderBottom: isLast ? "none" : "0.5px solid var(--p-color-border-secondary)",
    }}>
      {/* Icon */}
      <div style={{
        width: "36px", height: "36px", borderRadius: "8px",
        background: iconBg, color: iconFg,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "16px", flexShrink: 0,
      }}>
        🗓
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <Text as="span" variant="bodyMd" fontWeight="semibold">{group.name}</Text>
          {!group.tracked && (
            <span
              title="Live in Shopify but missing from this app's records — it keeps selling on the storefront and cannot be managed from the Plans page."
              style={{
                fontSize: "10px", fontWeight: 700, padding: "2px 8px",
                borderRadius: "4px", background: "#FAEEDA", color: "#633806",
                textTransform: "uppercase", letterSpacing: "0.04em",
              }}
            >
              Orphaned
            </span>
          )}
          {unattached && (
            <span
              title="Attached to no product or variant, so it sells nothing right now. Clutter rather than a problem."
              style={{
                fontSize: "10px", fontWeight: 700, padding: "2px 8px",
                borderRadius: "4px",
                background: "var(--p-color-bg-surface-secondary)",
                color: "var(--p-color-text-subdued)",
                textTransform: "uppercase", letterSpacing: "0.04em",
              }}
            >
              Not attached
            </span>
          )}
          {group.tracked && (
            <span
              title="This app's database has a row for this group, so the Plans page can manage it."
              style={{
                fontSize: "10px", fontWeight: 700, padding: "2px 8px",
                borderRadius: "4px", background: T.greenBg, color: T.greenFg,
                textTransform: "uppercase", letterSpacing: "0.04em",
              }}
            >
              Tracked
            </span>
          )}
        </div>
        <div style={{ fontSize: "11px", color: "var(--p-color-text-subdued)", fontFamily: "monospace", marginTop: "2px" }}>
          {group.id}
        </div>
        <div style={{ fontSize: "11px", color: "var(--p-color-text-subdued)", marginTop: "2px" }}>
          🗓 Created: {formatDate(group.createdAt)}
          {group.products.length > 0 ? (
            <>
              {" "}· 🛍 On {group.products.length} product{group.products.length === 1 ? "" : "s"}:{" "}
              {group.products.map((p) => p.title).join(", ")}
              {/* Spelled out because a variant-level attachment is invisible on the
                  product itself — the merchant has to open the variant to find it. */}
              {group.attachedVariants > 0 && (
                <> · {group.attachedVariants} attached at variant level</>
              )}
            </>
          ) : (
            <> · 🛍 Not attached to any product or variant — sells nothing</>
          )}
        </div>

        {/* The number that decides whether deleting is safe. Without it the
            merchant is being asked to remove something with no idea what depends
            on it. */}
        <div style={{ fontSize: "11px", marginTop: "2px", color: group.contractCount > 0 ? T.redFg : T.greenFg }}>
          {group.contractCount > 0
            ? `⚠ ${group.contractCount} live subscription contract${group.contractCount === 1 ? "" : "s"} use this — deleting affects them`
            /* "safe to delete" next to a disabled Delete button reads as a
               contradiction, so only promise that where deleting is possible. */
            : group.removable
              ? "✓ No subscription contracts use this — safe to delete"
              : "✓ No subscription contracts use this — nothing depends on it"}
        </div>

        {/*
          This block used to end "Remove it from each product's purchase options in
          the Shopify admin" and link the products. That instruction cannot be
          followed: Shopify delegates the selling-plan lifecycle to the owning app,
          so a product's Purchase options card offers only an edit pencil that
          deep-links into that app — there is no remove control. Merchants followed
          the links, found nothing to click, and came back none the wiser.

          Association removal is `sellingPlanGroupRemoveProducts` /
          `…RemoveProductVariants`, which are owner-scoped exactly like the delete
          and were verified refused here. Uninstalling is genuinely the only route,
          and Shopify documents it as covering the product and variant
          associations too, so that is what this now says.
        */}
        {!group.removable && (
          <div style={{ fontSize: "11px", color: T.amberFg, marginTop: "4px", lineHeight: 1.5 }}>
            🔒 Created by a different app installation, so Shopify refuses every
            change to it from here — delete and detach both answer “Selling plan
            group does not exist”. Only the app that created it can remove it, and
            the Shopify admin offers no remove control either: a product’s Purchase
            options card only links back to that app.
            <div style={{ marginTop: "3px" }}>
              To clear it, uninstall the app that created it — Shopify deletes its
              selling plan groups, and their product and variant associations, about
              48 hours after uninstall.
            </div>
            {group.products.length > 0 && (
              <div style={{ marginTop: "3px" }}>
                Currently selling on:{" "}
                {group.products.map((p) => (
                  <a
                    key={p.id}
                    href={`shopify://admin/products/${p.id.split("/").pop()}`}
                    target="_top"
                    style={{ color: T.blueFg, marginRight: "10px", textDecoration: "underline" }}
                  >
                    {p.title}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {deleteError && (
          <div style={{ fontSize: "11px", color: T.redFg, marginTop: "4px" }}>❌ {deleteError}</div>
        )}
      </div>

      {/* Delete — offered only when Shopify will actually accept it from this
          app. A button that always errors is worse than no button. */}
      <fetcher.Form method="post" style={{ flexShrink: 0 }}>
        <input type="hidden" name="id" value={group.id} />
        <button
          type="submit"
          disabled={isDeleting || !group.removable}
          title={group.removable ? undefined : "Owned by a different app installation — remove it from the product in the Shopify admin."}
          style={{
            fontSize: "12px", fontWeight: 500,
            padding: "6px 12px", borderRadius: "7px",
            background: "none",
            border: `0.5px solid ${group.removable ? T.redFg : "var(--p-color-border)"}`,
            color: group.removable ? T.redFg : "var(--p-color-text-subdued)",
            cursor: (isDeleting || !group.removable) ? "not-allowed" : "pointer",
            display: "inline-flex", alignItems: "center", gap: "4px",
            opacity: (isDeleting || !group.removable) ? 0.6 : 1,
          }}
        >
          🗑️ {!group.removable ? "Not removable" : isDeleting ? "Deleting…" : "Delete"}
        </button>
      </fetcher.Form>

      {/* Three-dot menu */}
      <button style={{
        width: "28px", height: "28px", borderRadius: "6px",
        background: "none",
        border: "0.5px solid var(--p-color-border-secondary)",
        cursor: "pointer", display: "flex",
        alignItems: "center", justifyContent: "center",
        fontSize: "14px", color: "var(--p-color-text-subdued)",
        flexShrink: 0,
      }}>
        ⋮
      </button>
    </div>
  );
}

