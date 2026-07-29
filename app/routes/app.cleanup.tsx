// app/routes/app.cleanup.tsx

import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { authenticate } from "../shopify.server";
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
type SellingPlanGroup = { id: string; name: string; createdAt: string };
type LoaderData = { groups: SellingPlanGroup[]; error?: string };
type ActionData = { id: string; success: boolean; error?: string };

// ─── Loader ──────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const response  = await admin.graphql(`
    query GetAllSellingPlanGroups {
      sellingPlanGroups(first: 50) {
        edges { node { id name createdAt } }
      }
    }
  `);
  const data = await response.json() as unknown as { errors?: { message: string }[]; data: { sellingPlanGroups: { edges: { node: SellingPlanGroup }[] } } };
  if (data.errors) {
    return json<LoaderData>({ groups: [], error: data.errors[0]?.message ?? "Failed to fetch" });
  }
  const groups: SellingPlanGroup[] = data.data.sellingPlanGroups.edges.map(
    ({ node }: { node: SellingPlanGroup }) => ({ id: node.id, name: node.name, createdAt: node.createdAt })
  );
  groups.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return json<LoaderData>({ groups });
}

// ─── Action ──────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const formData  = await request.formData();
  const id        = formData.get("id") as string;
  if (!id) return json<ActionData>({ id: "", success: false, error: "No ID provided" });
  try {
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
    return json<ActionData>({ id, success: true });
  } catch (err) {
    return json<ActionData>({ id, success: false, error: err instanceof Error ? err.message : "Unknown error" });
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

// ─── Page ─────────────────────────────────────────────────────
export default function AdminCleanup() {
  const { groups, error } = useLoaderData<LoaderData>();
  const revalidator       = useRevalidator();
  const newestId          = groups.length > 0 ? groups[groups.length - 1].id : null;
  const likelyDuplicates  = groups.length > 1 ? groups.length - 1 : 0;
  const keepThis          = groups.length > 0 ? 1 : 0;

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
                Plans sorted oldest → newest. Oldest ones are likely dev duplicates — safe to delete.
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
              Review and clean up duplicate plan groups to keep your app data organized.
            </Text>
          </div>
          <div style={{ display: "flex", gap: "32px", flexShrink: 0 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 700, color: T.redFg, lineHeight: 1 }}>{likelyDuplicates}</div>
              <div style={{ fontSize: "10px", fontWeight: 600, color: T.redFg, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: "4px" }}>Likely Duplicates</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 700, color: "var(--p-color-text-subdued)", lineHeight: 1 }}>0</div>
              <div style={{ fontSize: "10px", fontWeight: 600, color: "var(--p-color-text-subdued)", textTransform: "uppercase", letterSpacing: "0.04em", marginTop: "4px" }}>Old / Unused</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "26px", fontWeight: 700, color: T.greenFg, lineHeight: 1 }}>{keepThis}</div>
              <div style={{ fontSize: "10px", fontWeight: 600, color: T.greenFg, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: "4px" }}>Keep This</div>
            </div>
          </div>
        </div>

        {/* ── Section header ───────────────────────────────────── */}
        {groups.length > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              Selling Plan Groups (Oldest → Newest)
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
                index={index}
                total={groups.length}
                isNewest={g.id === newestId}
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
  group, index, total, isNewest, isLast,
}: {
  group: SellingPlanGroup;
  index: number;
  total: number;
  isNewest: boolean;
  isLast: boolean;
}) {
  const fetcher    = useFetcher<ActionData>();
  const isDeleting = fetcher.state === "submitting";
  const isDeleted  = fetcher.state === "idle" && fetcher.data?.success === true;
  const deleteError = fetcher.state === "idle" && fetcher.data?.success === false ? fetcher.data.error : null;
  const isOldest   = index === 0 && total > 1;

  const T = {
    greenBg: "#EAF3DE", greenFg: "#27500A",
    redBg:   "#FCEBEB", redFg:   "#791F1F",
    blueBg:  "#E6F1FB", blueFg:  "#185FA5",
  };

  const borderColor = isOldest ? "#F09595" : isNewest && total > 1 ? "#3B6D11" : "transparent";
  const iconBg      = isOldest ? T.redBg   : isNewest && total > 1 ? T.greenBg : T.blueBg;
  const iconFg      = isOldest ? T.redFg   : isNewest && total > 1 ? T.greenFg : T.blueFg;

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
          {isOldest && (
            <span style={{
              fontSize: "10px", fontWeight: 700, padding: "2px 8px",
              borderRadius: "4px", background: T.redBg, color: T.redFg,
              textTransform: "uppercase", letterSpacing: "0.04em",
            }}>
              Likely Duplicate
            </span>
          )}
          {isNewest && total > 1 && (
            <span style={{
              fontSize: "10px", fontWeight: 700, padding: "2px 8px",
              borderRadius: "4px", background: T.greenBg, color: T.greenFg,
              textTransform: "uppercase", letterSpacing: "0.04em",
            }}>
              Newest → Keep This
            </span>
          )}
          {total === 1 && (
            <span style={{
              fontSize: "10px", fontWeight: 700, padding: "2px 8px",
              borderRadius: "4px", background: T.blueBg, color: T.blueFg,
            }}>
              Only plan
            </span>
          )}
        </div>
        <div style={{ fontSize: "11px", color: "var(--p-color-text-subdued)", fontFamily: "monospace", marginTop: "2px" }}>
          {group.id}
        </div>
        <div style={{ fontSize: "11px", color: "var(--p-color-text-subdued)", marginTop: "2px" }}>
          🗓 Created: {formatDate(group.createdAt)}
        </div>
        {deleteError && (
          <div style={{ fontSize: "11px", color: T.redFg, marginTop: "4px" }}>❌ {deleteError}</div>
        )}
      </div>

      {/* Delete */}
      <fetcher.Form method="post" style={{ flexShrink: 0 }}>
        <input type="hidden" name="id" value={group.id} />
        <button
          type="submit"
          disabled={isDeleting}
          style={{
            fontSize: "12px", fontWeight: 500,
            padding: "6px 12px", borderRadius: "7px",
            background: "none",
            border: `0.5px solid ${T.redFg}`,
            color: T.redFg, cursor: isDeleting ? "not-allowed" : "pointer",
            display: "inline-flex", alignItems: "center", gap: "4px",
            opacity: isDeleting ? 0.6 : 1,
          }}
        >
          🗑️ {isDeleting ? "Deleting…" : "Delete"}
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

