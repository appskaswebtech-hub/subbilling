// app/routes/app.tsx

import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError, useNavigate, useLocation } from "@remix-run/react";
import { boundary }    from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu }     from "@shopify/app-bridge-react";
import polarisStyles   from "@shopify/polaris/build/esm/styles.css?url";
import { Text, List }  from "@shopify/polaris";
import { authenticate }      from "../shopify.server";
import { getShopPlanFromDB } from "../utils/planUtils";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

const PAID_PLANS     = ["basic", "pro", "advanced"];
const NO_POPUP_PATHS = ["/app/billing", "/app/billing-return"];

// ─── LOADER ───────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const record      = await getShopPlanFromDB(session.shop);
  const hasPlan     = PAID_PLANS.includes(record.plan);

  return {
    apiKey:   process.env.SHOPIFY_API_KEY || "",
    hasPlan,
    planName: record.plan,
  };
};

// ─── PLAN GATE POPUP ──────────────────────────────────────────
function PlanGatePopup() {
  const navigate = useNavigate();

  const plans = [
    {
      key:     "basic",
      label:   "Basic",
      price:   9.99,
      color:   "#f6f6f7",
      popular: false,
      features: [
        "Up to 50 Subscription Products",
        "Limited Subscription Plans",
        "Weekly, Monthly & Yearly Billing",
        "Email Support",
      ],
    },
    {
      key:     "pro",
      label:   "Pro",
      price:   30,
      color:   "#f0f4ff",
      popular: true,
      features: [
        "Up to 500 Subscription Products",
        "Unlimited Subscription Plans",
        "Weekly, Monthly & Yearly Billing",
        "Priority Support",
      ],
    },
    {
      key:     "advanced",
      label:   "Advanced",
      price:   40,
      color:   "#f3f0ff",
      popular: false,
      features: [
        "Unlimited Everything",
        "Unlimited Subscription Products",
        "API & Webhook Access",
        "Weekly, Monthly & Yearly Billing",
      ],
    },
  ];

  return (
    // Single wrapper — handles both backdrop and centering
    // pointerEvents on wrapper, NOT blocking the modal itself
    <div
      style={{
        position:       "fixed",
        inset:          0,
        zIndex:         9999,
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        padding:        "16px",
        // Backdrop via pseudo-approach using background on wrapper
        background:     "rgba(0, 0, 0, 0.55)",
        backdropFilter: "blur(3px)",
        // ✅ Critical: wrapper receives pointer events but passes them to children
        pointerEvents:  "auto",
      }}
    >
      {/* Modal — explicitly set pointerEvents so clicks always register */}
      <div
        style={{
          background:    "#ffffff",
          borderRadius:  "16px",
          boxShadow:     "0 24px 64px rgba(0,0,0,0.18)",
          width:         "100%",
          maxWidth:      "860px",
          overflow:      "hidden",
          position:      "relative",
          pointerEvents: "auto", // ✅ ensure modal is always clickable
        }}
      >
        {/* Header */}
        <div
          style={{
            background: "linear-gradient(135deg, #26215C 0%, #4F46E5 100%)",
            padding:    "28px 32px",
            textAlign:  "center",
          }}
        >
          <div style={{ marginBottom: "8px" }}>
            <span
              style={{
                display:       "inline-block",
                background:    "rgba(255,255,255,0.15)",
                borderRadius:  "20px",
                padding:       "4px 14px",
                fontSize:      "12px",
                color:         "#e0ddff",
                fontWeight:    500,
                letterSpacing: "0.05em",
              }}
            >
              GET STARTED
            </span>
          </div>
          <Text as="h2" variant="headingXl" fontWeight="bold">
            <span style={{ color: "#ffffff" }}>Choose a plan to continue</span>
          </Text>
        </div>

        {/* Plan cards */}
        <div
          style={{
            display:             "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            borderTop:           "1px solid #e1e3e5",
          }}
        >
          {plans.map((plan, idx) => (
            <div
              key={plan.key}
              style={{
                borderRight:   idx < plans.length - 1 ? "1px solid #e1e3e5" : "none",
                display:       "flex",
                flexDirection: "column",
                position:      "relative",
              }}
            >
              {/* Popular ribbon */}
              {plan.popular && (
                <div
                  style={{
                    position:      "absolute",
                    top:           0,
                    left:          "50%",
                    transform:     "translateX(-50%)",
                    background:    "#4F46E5",
                    color:         "#ffffff",
                    fontSize:      "11px",
                    fontWeight:    600,
                    padding:       "3px 14px",
                    borderRadius:  "0 0 8px 8px",
                    letterSpacing: "0.04em",
                    zIndex:        1,
                  }}
                >
                  MOST POPULAR
                </div>
              )}

              {/* Card header */}
              <div
                style={{
                  background:   plan.color,
                  padding:      plan.popular ? "28px 24px 16px" : "20px 24px 16px",
                  borderBottom: "1px solid #e1e3e5",
                  textAlign:    "center",
                }}
              >
                <Text as="h3" variant="headingMd" fontWeight="bold">
                  {plan.label}
                </Text>
                <div style={{ marginTop: "8px" }}>
                  <Text as="p" variant="heading2xl" fontWeight="bold">
                    ${plan.price}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    / month
                  </Text>
                </div>
              </div>

              {/* Features */}
              <div style={{ padding: "20px 24px", flexGrow: 1 }}>
                <List type="bullet">
                  {plan.features.map((f, i) => (
                    <List.Item key={i}>
                      <Text as="span" variant="bodySm">{f}</Text>
                    </List.Item>
                  ))}
                </List>
              </div>

              {/* CTA */}
              <div style={{ padding: "16px 24px", borderTop: "1px solid #e1e3e5" }}>
                <button
                  onClick={() => navigate("/app/billing")}
                  style={{
                    width:         "100%",
                    padding:       "10px 0",
                    borderRadius:  "8px",
                    border:        "none",
                    background:    plan.popular ? "#4F46E5" : "#26215C",
                    color:         "#ffffff",
                    fontSize:      "14px",
                    fontWeight:    600,
                    cursor:        "pointer",
                    transition:    "opacity 0.15s",
                    pointerEvents: "auto", // ✅ explicit on every button
                    position:      "relative",
                    zIndex:        10000,  // ✅ above everything
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.88")}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                >
                  Start with {plan.label} →
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            padding:    "14px 32px",
            borderTop:  "1px solid #e1e3e5",
            background: "#fafafa",
            textAlign:  "center",
          }}
        >
          <Text as="p" variant="bodySm" tone="subdued">
            Cancel anytime from your Shopify admin · Billed in USD · Secure payment via Shopify
          </Text>
        </div>
      </div>
    </div>
  );
}

// ─── APP SHELL ────────────────────────────────────────────────
export default function App() {
  const { apiKey, hasPlan } = useLoaderData<typeof loader>();
  const { pathname }        = useLocation();

  const isBillingPage = NO_POPUP_PATHS.some((p) => pathname.startsWith(p));
  const showPopup     = !hasPlan && !isBillingPage;

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Home</Link>
        <Link to="/app/plans">Subscription Plans</Link>
        <Link to="/app/subscriptions">Subscriptions</Link>
        <Link to="/app/customers">Customers</Link>
        <Link to="/app/api-key">API Key</Link>
        <Link to="/app/automations">Automations</Link>
        <Link to="/app/loyalty">Loyalty Discount</Link>
        <Link to="/app/settings">Settings</Link>
        <Link to="/app/widget-settings">Widget Settings</Link>
        <Link to="/app/cleanup">Clean Plans</Link>
        <Link to="/app/billing">Upgrade Plans</Link>
      </NavMenu>

      {showPopup && <PlanGatePopup />}

      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
