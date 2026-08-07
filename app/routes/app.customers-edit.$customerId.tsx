// app/routes/app.customers.$customerId.tsx

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import dashboardStyles from "../styles/dashboard.css?url";
import { IconCell, CellIcon, IconCalendar, IconBox, rowColorFor } from "../components/TableIcons";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];
// ─── Design tokens ───────────────────────────────────────────
const T = {
  purple:     "#7F77DD",
  purpleBg:   "#EEEDFE",
  purpleDark: "#26215C",
  purpleFg:   "#3C3489",
  greenBg:    "#EAF3DE",
  greenFg:    "#27500A",
  greenDot:   "#3B6D11",
  amberBg:    "#FAEEDA",
  amberFg:    "#633806",
  amberDot:   "#BA7517",
  redBg:      "#FCEBEB",
  redFg:      "#791F1F",
  redBorder:  "#F09595",
  tealBg:     "#E1F5EE",
  tealFg:     "#085041",
};

// ─── Shopify GraphQL ──────────────────────────────────────────
const CUSTOMER_QUERY = `
  query GetCustomer($id: ID!) {
    customer(id: $id) {
      id firstName lastName email phone
      numberOfOrders
      amountSpent { amount currencyCode }
      createdAt
      defaultAddress { city province country }
    }
  }
`;

// ─── Helpers ─────────────────────────────────────────────────
function toMonthlyValue(price: number, frequency: string): number {
  switch (frequency.toUpperCase()) {
    case "DAILY":    return price * 30;
    case "WEEKLY":   return price * 4.33;
    case "BIWEEKLY": return price * 2.17;
    case "MONTHLY":  return price;
    case "YEARLY":   return price / 12;
    default:         return price;
  }
}

function fmt$(n: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n);
}

function fmt(date: string | Date) {
  return new Date(date).toLocaleDateString("en-GB", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function fmtDateTime(date: string | Date) {
  return new Date(date).toLocaleString("en-GB", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

type BadgeTone = "success" | "warning" | "critical" | "info";

function badgeTone(status: string): BadgeTone {
  const map: Record<string, BadgeTone> = {
    ACTIVE: "success", PAUSED: "warning", CANCELLED: "critical",
    FAILED: "critical", PENDING: "info", SUCCESS: "success",
  };
  return map[status] ?? "info";
}

function statusPill(status: string) {
  const styles: Record<string, { bg: string; color: string; dot: string }> = {
    ACTIVE:    { bg: T.greenBg, color: T.greenFg, dot: T.greenDot },
    PAUSED:    { bg: T.amberBg, color: T.amberFg, dot: T.amberDot },
    CANCELLED: { bg: T.redBg,   color: T.redFg,   dot: "#E24B4A"  },
    FAILED:    { bg: T.redBg,   color: T.redFg,   dot: "#E24B4A"  },
    PENDING:   { bg: T.purpleBg,color: T.purpleFg,dot: T.purple   },
    SUCCESS:   { bg: T.greenBg, color: T.greenFg, dot: T.greenDot },
  };
  const s = styles[status] ?? styles.PENDING;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "5px",
      fontSize: "11px", fontWeight: 500,
      padding: "4px 10px", background: s.bg, color: s.color, borderRadius: "20px",
    }} className="top-pills">
      <span className="bottom-pills" style={{ width: "5px", height: "5px", borderRadius: "50%", background: s.dot, display: "inline-block" }} />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);

  const rawParam = decodeURIComponent(params.customerId ?? "");

  // ── KEY FIX: always resolve to a full GID for the DB query ──
  // URL param can be:
  //   "10660783784213"               ← numeric ID (from customers list .split("/").pop())
  //   "gid://shopify/Customer/123"   ← full GID (legacy / direct link)
  //   "user@email.com"               ← email fallback
  const isEmail = rawParam.includes("@");
  const isGid   = rawParam.startsWith("gid://");

  // Reconstruct the full GID — this is what's stored in customerId column
  const fullGid = isGid
    ? rawParam
    : isEmail
    ? null
    : `gid://shopify/Customer/${rawParam}`;

  console.log("[CustomerDetail] rawParam:", rawParam);
  console.log("[CustomerDetail] fullGid:", fullGid);

  // Build where clause — ALWAYS has a customer filter
  const customerWhere = fullGid
    ? { customerId: fullGid }
    : { customerEmail: rawParam };

  const subscriptions = await prisma.subscription.findMany({
    where: {
      shop: session.shop,
      ...customerWhere,           // ← always filters to one customer
    },
    include: {
      billingAttempts: { orderBy: { createdAt: "desc" } },
    },
    orderBy: { createdAt: "desc" },
  });

  console.log("[CustomerDetail] subscriptions found:", subscriptions.length);

  if (subscriptions.length === 0) {
    throw new Response("Customer not found", { status: 404 });
  }

  const firstSub      = subscriptions[0];
  const shopifyGid    = fullGid ?? firstSub.customerId;
  const customerEmail = firstSub.customerEmail;

  // Fetch Shopify customer profile
  let shopifyCustomer: any = null;
  if (shopifyGid?.startsWith("gid://shopify/Customer/")) {
    try {
      const res    = await admin.graphql(CUSTOMER_QUERY, { variables: { id: shopifyGid } });
      const result = await res.json();
      shopifyCustomer = result?.data?.customer ?? null;
    } catch (err) {
      console.warn("[CustomerDetail] Could not fetch Shopify profile:", err);
    }
  }

  // Aggregate billing across THIS customer's subscriptions only
  const allAttempts = subscriptions.flatMap((s) =>
    s.billingAttempts.map((a) => ({
      id:           a.id,
      createdAt:    a.createdAt,
      amount:       a.amount,
      status:       a.status,
      errorMessage: a.errorMessage,
      productTitle: s.productTitle,
      subId:        s.id,
    })),
  );

  const successAttempts = allAttempts.filter((a) => a.status === "SUCCESS");
  const failedAttempts  = allAttempts.filter((a) => a.status === "FAILED");
  const totalRevenue    = successAttempts.reduce((acc, a) => acc + a.amount, 0);

  const activeSubs = subscriptions.filter((s) => s.status === "ACTIVE");
  const mrr        = activeSubs.reduce(
    (acc, sub) => acc + toMonthlyValue(sub.price, sub.frequency),
    0,
  );

  const shopifyAdminCustomerUrl = shopifyGid
    ? `https://${session.shop}/admin/customers/${shopifyGid.split("/").pop()}`
    : `https://${session.shop}/admin/customers?email=${encodeURIComponent(customerEmail)}`;

  return json({
    subscriptions,
    shopifyCustomer,
    customerEmail,
    shopifyGid,
    shopifyAdminCustomerUrl,
    stats: {
      totalSubs:       subscriptions.length,
      activeSubs:      activeSubs.length,
      totalRevenue,
      mrr,
      totalAttempts:   allAttempts.length,
      successAttempts: successAttempts.length,
      failedAttempts:  failedAttempts.length,
    },
    recentAttempts: allAttempts
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20),
  });
}

// ─── Section card ─────────────────────────────────────────────
function SectionCard({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <div className="section-card" style={{
      background: "var(--p-color-bg-surface)",
      border: "0.5px solid var(--p-color-border)",
      borderRadius: "14px", overflow: "visible",
    }}>
      <div style={{
        padding: "16px 20px",
        borderBottom: "0.5px solid var(--p-color-border)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <Text as="h2" variant="headingMd" fontWeight="bold">{title}</Text>
        {subtitle && <Text as="p" variant="bodySm" tone="subdued">{subtitle}</Text>}
      </div>
      <div style={{ padding: "4px 20px 8px" }}>{children}</div>
    </div>
  );
}

// ─── Detail row ───────────────────────────────────────────────
function Row({ label, children, last }: {
  label: string; children: React.ReactNode; last?: boolean;
}) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "10px 0",
      borderBottom: last ? "none" : "0.5px solid var(--p-color-border-secondary)",
    }}>
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      <div style={{ textAlign: "right" }}>{children}</div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────
export default function CustomerDetail() {
  const {
    subscriptions, shopifyCustomer, customerEmail,
    shopifyAdminCustomerUrl, stats, recentAttempts,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const sc = shopifyCustomer;

  // Display name
  let displayName = customerEmail;
  if (sc) {
    const full = `${sc.firstName ?? ""} ${sc.lastName ?? ""}`.trim();
    if (full) displayName = full;
  }

  // Avatar initials
  const parts    = displayName.split(" ").filter(Boolean);
  const initials = parts.length >= 2
    ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
    : displayName.slice(0, 2).toUpperCase();

  // Table styles
  const th: React.CSSProperties = {
    padding: "10px 16px 10px 0", textAlign: "left",
    fontSize: "11px", fontWeight: 500,
    color: "var(--p-color-text-subdued)",
    letterSpacing: "0.06em", textTransform: "uppercase",
    borderBottom: "0.5px solid var(--p-color-border)", whiteSpace: "nowrap",
  };
  const td: React.CSSProperties = {
    padding: "13px 16px 13px 0", fontSize: "13px",
    color: "var(--p-color-text)",
    borderBottom: "0.5px solid var(--p-color-border-secondary)",
    verticalAlign: "middle", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  };

  return (
    <Page fullWidth>
      <TitleBar title={displayName} />

      <BlockStack gap="600">

        {/* ── Page header ─────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" }}>
          <BlockStack gap="100">
           <div className="top-customer">
            <InlineStack gap="150" blockAlign="center">
              <span style={{
                width: "6px", height: "6px", borderRadius: "50%",
                background: T.purple, display: "inline-block",
              }} />
              <div className="breadcrumbs-dashboard">
              <Text as="span" variant="bodySm" tone="subdued">
                <span className="subscription">Smart Subscriptions</span> ›   <span className="subscription">Customers</span> › Detail
              </Text>
              </div>
            </InlineStack>
            </div>

          </BlockStack>

        </div>
        <div className="tow-bottom-cust">
             <div className="bottom-customer">
            {/* Avatar + name row */}
            <InlineStack gap="300" blockAlign="center">
              <div style={{
                width: "44px", height: "44px", borderRadius: "50%",
                background: T.purpleBg, color: T.purpleFg,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "16px", fontWeight: 500, flexShrink: 0,
              }}>
                {initials}
              </div>
              <BlockStack gap="025">
                <Text as="h1" variant="headingXl" fontWeight="bold">{displayName}</Text>
                <Text as="p" variant="bodySm" tone="subdued">{customerEmail}</Text>
              </BlockStack>
            </InlineStack>
            </div>
          <div className="btn-customer">
          {/* Actions */}
          <InlineStack gap="200" blockAlign="center">
            <button
              onClick={() => navigate("/app/customers")}
              style={{
                fontSize: "13px", padding: "9px 16px",
                border: "0.5px solid var(--p-color-border-secondary)",
                borderRadius: "10px", background: "var(--p-color-bg-surface)",
                color: "var(--p-color-text-subdued)", cursor: "pointer",
              }}
            >
              ← All customers
            </button>
            <button
              onClick={() => window.open(shopifyAdminCustomerUrl, "_blank")}
              style={{
                fontSize: "13px", padding: "9px 16px",
                border: `0.5px solid #AFA9EC`,
                borderRadius: "10px", background: T.purpleBg,
                color: T.purpleFg, cursor: "pointer", fontWeight: 500,
              }}
            >
              Shopify Admin ↗
            </button>
          </InlineStack>
          </div>
          </div>
        {!sc && (
          <Banner tone="info">
            <Text as="p">Shopify profile unavailable — showing local subscription data only.</Text>
          </Banner>
        )}

        {/* ── Stat pills row ──────────────────────────── */}
        <div style={{ display: "flex", gap: "14px" }}>
          {[
            { label: "Active subs",     value: stats.activeSubs,           accent: T.greenDot, bg: T.greenBg,  color: T.greenFg  },
            { label: "Total subs",      value: stats.totalSubs,            accent: T.purple,   bg: T.purpleBg, color: T.purpleFg },
            { label: "MRR",             value: fmt$(stats.mrr),            accent: "#1D9E75",  bg: T.tealBg,   color: T.tealFg   },
            { label: "Total collected", value: fmt$(stats.totalRevenue),   accent: T.amberDot, bg: T.amberBg,  color: T.amberFg  },
          ].map(({ label, value, accent, bg, color }) => (
            <div key={label} style={{
              flex: 1, background: "var(--p-color-bg-surface)",
              border: "0.5px solid var(--p-color-border)",
              borderRadius: "14px", padding: "22px 20px",
              position: "relative", overflow: "hidden",
            }}>
              <div style={{
                position: "absolute", bottom: 0, left: 0, right: 0,
                height: "3px", background: accent, borderRadius: "14px 14px 0 0",
              }} />
              <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
              <Text as="p" variant="headingLg" fontWeight="bold">{String(value)}</Text>
            </div>
          ))}
        </div>

        {/* ── Main 2-col layout ───────────────────────── */}
        <div  className="layout-main-grid" >

          {/* Left column */}
          <div className="layout-left main-card-item">
          <BlockStack gap="400">

            {/* Subscriptions table */}
            <SectionCard
              title="Subscriptions"
              subtitle={`${stats.activeSubs} active / ${stats.totalSubs} total`}
           >
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Product", "Plan", "Status", "Price", "Frequency", "Next billing", ""].map((h, i) => (
                        <th key={i} style={th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {subscriptions.map((s, i) => {
                      const isLast = i === subscriptions.length - 1;
                      const cell   = isLast ? { ...td, borderBottom: "none" } : td;
                      return (
                        <tr
                          key={s.id}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--p-color-bg-surface-hover)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                          style={{ transition: "background 0.1s", cursor: "pointer" }}
                          onClick={() => navigate(`/app/subscriptions-edit/${s.id}`)}
                        >
                          <td style={{ ...cell, fontWeight: 500 }}>
                            <IconCell icon={<CellIcon icon={IconBox} color={rowColorFor(s.id)} />}>
                              {s.productTitle}
                            </IconCell>
                          </td>
                          <td style={{ ...cell, color: "var(--p-color-text-subdued)", fontSize: "12px" }}>
                            <IconCell icon={<CellIcon icon={IconCalendar} color={rowColorFor(s.id)} />}>
                              {s.planName}
                            </IconCell>
                          </td>
                          <td style={cell}>{statusPill(s.status)}</td>
                          <td style={{ ...cell, fontWeight: 500 }} className="price-section">{fmt$(s.price)}</td>
                          <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>{titleCase(s.frequency)}</td>
                          <td style={{ ...cell, color: "var(--p-color-text-subdued)" }}>
                            <IconCell icon={<CellIcon icon={IconCalendar} color={rowColorFor(s.id)} />}>
                              {fmt(s.nextBillingDate)}
                            </IconCell>
                          </td>
                          <td style={{ ...cell, overflow: "visible" }} onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => navigate(`/app/subscriptions-edit/${s.id}`)}
                              style={{
                                fontSize: "12px", padding: "5px 10px",
                                border: "0.5px solid var(--p-color-border-secondary)",
                                borderRadius: "7px", background: "var(--p-color-bg-surface)",
                                color: "var(--p-color-text)", cursor: "pointer",
                              }}
                            >
                              Edit →
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            {/* Billing history table */}
            <SectionCard
              title="Recent billing history"
              subtitle={`Last ${recentAttempts.length} attempts`}
            >
              {recentAttempts.length === 0 ? (
                <div style={{ padding: "16px 0" }}>
                  <Text as="p" tone="subdued">No billing attempts yet.</Text>
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {["Date", "Product", "Amount", "Status", "Error"].map((h, i) => (
                          <th key={i} style={th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {recentAttempts.map((a, i) => {
                        const isLast = i === recentAttempts.length - 1;
                        const cell   = isLast ? { ...td, borderBottom: "none" } : td;
                        return (
                          <tr key={a.id}>
                            <td style={{ ...cell, color: "var(--p-color-text-subdued)", fontSize: "12px" }}>
                              <IconCell icon={<CellIcon icon={IconCalendar} color={rowColorFor(a.id)} />}>
                                {fmtDateTime(a.createdAt)}
                              </IconCell>
                            </td>
                            <td style={cell}>
                              <IconCell icon={<CellIcon icon={IconBox} color={rowColorFor(a.id)} />}>
                                {a.productTitle}
                              </IconCell>
                            </td>
                            <td style={{ ...cell, fontWeight: 500 }}>{fmt$(a.amount)}</td>
                            <td style={cell}>{statusPill(a.status)}</td>
                            <td style={{ ...cell, color: "var(--p-color-text-subdued)", fontSize: "11px" }}>
                              {a.errorMessage ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

          </BlockStack></div>
<div className="layout-right">
          {/* Right column */}
          <BlockStack gap="400">

            {/* Customer profile */}
            <SectionCard title="Customer profile">
              {/* Avatar header */}
              <div style={{
                display: "flex", alignItems: "center", gap: "12px",
                padding: "14px 0", borderBottom: "0.5px solid var(--p-color-border-secondary)",
              }}>
                <div style={{
                  width: "40px", height: "40px", borderRadius: "50%",
                  background: T.purpleBg, color: T.purpleFg,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "15px", fontWeight: 500, flexShrink: 0,
                }}>
                  {initials}
                </div>
                <div>
                  <Text as="p" variant="bodySm" fontWeight="semibold">{displayName}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{customerEmail}</Text>
                </div>
              </div>

              {sc ? (
                <>
                  {sc.phone && (
                    <Row label="Phone">
                      <Text as="span" variant="bodySm">{sc.phone}</Text>
                    </Row>
                  )}
                  {sc.defaultAddress && (
                    <Row label="Location">
                      <Text as="span" variant="bodySm">
                        {[sc.defaultAddress.city, sc.defaultAddress.province, sc.defaultAddress.country]
                          .filter(Boolean).join(", ")}
                      </Text>
                    </Row>
                  )}
                  <Row label="Shopify orders">
                    <Text as="span" variant="bodySm" fontWeight="semibold">{sc.numberOfOrders}</Text>
                  </Row>

                  <Row label="Total Shopify spend">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      {fmt$(parseFloat(sc.amountSpent?.amount ?? "0"))}
                    </Text>
                  </Row>

                  <Row label="Customer since" last>
                    <Text as="span" variant="bodySm" tone="subdued">{fmt(sc.createdAt)}</Text>
                  </Row>
                </>
              ) : (
                <div style={{ padding: "12px 0" }}>
                  <Text as="p" variant="bodySm" tone="subdued">Profile details unavailable from Shopify.</Text>
                </div>
              )}

              <div style={{ paddingBottom: "12px" }}>
                <button
                  onClick={() => window.open(shopifyAdminCustomerUrl, "_blank")}
                  style={{
                    width: "100%", fontSize: "12px", padding: "8px",
                    border: "0.5px solid var(--p-color-border-secondary)",
                    borderRadius: "8px", background: "var(--p-color-bg-surface)",
                    color: "var(--p-color-text-subdued)", cursor: "pointer",
                  }}
                >
                  Open in Shopify Admin ↗
                </button>
              </div>
            </SectionCard>

            {/* Billing stats */}
            <SectionCard title="Billing stats">
              <Row label="Successful charges">
                <span style={{
                  fontSize: "12px", fontWeight: 500,
                  color: T.greenFg, background: T.greenBg,
                  padding: "2px 8px", borderRadius: "20px",
                }}>
                  {stats.successAttempts}
                </span>
              </Row>
              <Row label="Failed charges">
                <span style={{
                  fontSize: "12px", fontWeight: 500,
                  color: T.redFg, background: T.redBg,
                  padding: "2px 8px", borderRadius: "20px",
                }}>
                  {stats.failedAttempts}
                </span>
              </Row>

              <Row label="Total attempts">
                <Text as="span" variant="bodySm" fontWeight="semibold">{stats.totalAttempts}</Text>
              </Row>
               <div className="total-spend">
              <Row label="Total collected" last>
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  {fmt$(stats.totalRevenue)}
                </Text>
              </Row>
              </div>
            </SectionCard>

          </BlockStack>
          </div>
        </div>

      </BlockStack>
    </Page>
  );
}

