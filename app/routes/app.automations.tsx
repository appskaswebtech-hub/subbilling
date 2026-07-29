// app/routes/app.automations.tsx

import { Page, BlockStack, InlineStack, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { Link } from "@remix-run/react";
import dashboardStyles from "../styles/dashboard.css?url";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];

const T = {
  purple:    "#7F77DD",
  purpleBg:  "#EEEDFE",
  purpleFg:  "#3C3489",
  purpleDark:"#26215C",
  greenBg:   "#EAF3DE",
  greenFg:   "#27500A",
  amberBg:   "#FAEEDA",
  amberFg:   "#633806",
  blueBg:    "#E6F1FB",
  blueFg:    "#185FA5",
  redBg:     "#FCEBEB",
  redFg:     "#791F1F",
};

const AUTOMATIONS = [
  {
    key:   "loyalty",
    title: "Loyalty",
    desc:  "Give discounts to your loyal customers",
    icon:  "🎁",
    bg:    T.purpleBg,
    fg:    T.purpleFg,
    route: "/app/loyalty",
    available: true,
  },
  {
    key:   "bulk",
    title: "Bulk actions",
    desc:  "Perform actions on multiple subscriptions at the same time",
    icon:  "⚡",
    bg:    T.blueBg,
    fg:    T.blueFg,
    route: "/app/automations/bulk",
    available: false,
  },
  {
    key:   "interval",
    title: "Automated interval changes",
    desc:  "Configure automated interval flow",
    icon:  "🔄",
    bg:    T.greenBg,
    fg:    T.greenFg,
    route: "/app/automations/interval",
    available: false,
  },
  {
    key:   "upsells",
    title: "Product upsells",
    desc:  "Configure product recommendation upsells",
    icon:  "📈",
    bg:    T.amberBg,
    fg:    T.amberFg,
    route: "/app/automations/upsells",
    available: false,
  },
];

export default function AutomationsPage() {
  return (
    <Page>
      <TitleBar title="Automations" />
      <BlockStack gap="500">

        {/* ── Header ─────────────────────────────────────────── */}
        <BlockStack gap="100">
          <InlineStack gap="150" blockAlign="center">
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: T.purple, display: "inline-block", flexShrink: 0 }} />
            <div className="breadcrumbs-dashboard">
              <Text as="span" variant="bodySm" tone="subdued">
                Smart Subscriptions › <span className="subscription">Automations</span>
              </Text>
            </div>
          </InlineStack>
          <div className="varient-section">
            <Text as="h1" variant="headingXl" fontWeight="bold">Automations</Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Automate subscription management and reward your loyal customers.
            </Text>
          </div>
        </BlockStack>

        {/* ── Automation cards grid ─────────────────────────── */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "16px",
        }}>
          {AUTOMATIONS.map((item) => {
            const cardContent = (
              <>
                {/* Coming soon badge */}
                {!item.available && (
                  <div style={{
                    position: "absolute", top: "12px", right: "12px",
                    fontSize: "10px", fontWeight: 600,
                    padding: "2px 8px", borderRadius: "20px",
                    background: "var(--p-color-bg-surface-secondary)",
                    color: "var(--p-color-text-subdued)",
                  }}>
                    Coming soon
                  </div>
                )}
                {/* Icon */}
                <div style={{
                  width: "44px", height: "44px", borderRadius: "12px",
                  background: item.bg, display: "flex",
                  alignItems: "center", justifyContent: "center",
                  fontSize: "20px",
                }}>
                  {item.icon}
                </div>
                {/* Text */}
                <div>
                  <Text as="p" variant="bodyMd" fontWeight="semibold">{item.title}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">{item.desc}</Text>
                </div>
                {/* Arrow */}
                {item.available && (
                  <div style={{ marginTop: "auto", color: item.fg, fontSize: "13px", fontWeight: 500 }}>
                    Configure →
                  </div>
                )}
              </>
            );

            const cardStyle: React.CSSProperties = {
              background: "var(--p-color-bg-surface)",
              border: "0.5px solid var(--p-color-border)",
              borderRadius: "14px", padding: "22px",
              opacity: item.available ? 1 : 0.55,
              position: "relative",
              display: "flex", flexDirection: "column", gap: "12px",
              transition: "box-shadow 0.15s, transform 0.15s",
              textDecoration: "none", color: "inherit",
            };

            return item.available ? (
              <Link
                key={item.key}
                to={item.route}
                className="hover-card"
                style={{ ...cardStyle, cursor: "pointer" }}
                prefetch="intent"
              >
                {cardContent}
              </Link>
            ) : (
              <div key={item.key} className="hover-card" style={{ ...cardStyle, cursor: "default" }}>
                {cardContent}
              </div>
            );
          })}
        </div>

      </BlockStack>
    </Page>
  );
}

