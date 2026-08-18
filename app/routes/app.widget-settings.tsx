// app/routes/app.widget-settings.tsx
// Live subscription widget preview + customization settings

import { useState, useEffect } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { Page, BlockStack, InlineStack, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
// Pure helpers, not the .server module — MAX_BENEFIT_CHIPS is used in the
// component below and a .server import there would break the client bundle.
import {
  DEFAULT_BENEFIT_CHIPS,
  MAX_BENEFIT_CHIPS,
  parseBenefitChips,
  serializeBenefitChips,
} from "../config/widget-chips";
import dashboardStyles from "../styles/dashboard.css?url";
export const links = () => [{ rel: "stylesheet", href: dashboardStyles }];

// ─── Design tokens ───────────────────────────────────────────
const T = {
  purple:     "#7F77DD",
  purpleBg:   "#EEEDFE",
  purpleDark: "#26215C",
  purpleFg:   "#3C3489",
  greenBg:    "#EAF3DE",
  greenFg:    "#27500A",
  amberBg:    "#FAEEDA",
  amberFg:    "#633806",
  blueBg:     "#E6F1FB",
  blueFg:     "#185FA5",
};

const APP_URL = process.env.SHOPIFY_APP_URL ?? "https://subscription.kaswebtechsolutions.com";

// ─── Loader ───────────────────────────────────────────────────
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [plans, settings] = await Promise.all([
    // Newest first, matching the storefront dropdown's order so the preview
    // does not show plans in the reverse of what the shopper sees.
    prisma.sellingPlanGroup.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "desc" } }),
    prisma.appSettings.findUnique({ where: { shop: session.shop } }),
  ]);
  // Empty means unset, so the editor opens on the standard chips rather than an
  // empty list — matching exactly what the storefront would render today.
  const storedChips = parseBenefitChips((settings as any)?.widgetBenefitChips);

  return json({
    plans,
    appUrl: APP_URL,
    saved: {
      primaryColor:  (settings as any)?.widgetPrimaryColor  ?? "#5B4FCB",
      badgeColor:    (settings as any)?.widgetBadgeColor    ?? "#F5A623",
      borderRadius:  (settings as any)?.widgetBorderRadius  ?? 10,
      showOnetime:   (settings as any)?.widgetShowOnetime   ?? true,
      design:        (settings as any)?.widgetDesign        ?? "arctic",
      benefitChips:  storedChips.length ? storedChips : DEFAULT_BENEFIT_CHIPS,
    },
  });
}

// ─── Action ───────────────────────────────────────────────────
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  // This upsert overwrites every widget column, so each one has to be present
  // here — a field left out is silently wiped on the next save.
  const data = {
    widgetPrimaryColor:  (form.get("primaryColor")  as string) || "#5B4FCB",
    widgetBadgeColor:    (form.get("badgeColor")    as string) || "#F5A623",
    widgetBorderRadius:  parseInt(form.get("borderRadius") as string, 10) || 10,
    widgetShowOnetime:   form.get("showOnetime") === "true",
    widgetDesign:        (form.get("design") as string) || "arctic",
    widgetBenefitChips:  serializeBenefitChips(form.getAll("benefitChip") as string[]),
  };

  await prisma.appSettings.upsert({
    where:  { shop: session.shop },
    update: data,
    create: { shop: session.shop, ...data },
  });

  return json({ ok: true });
}

type TabKey = "widget" | "designs" | "advanced";

const TABS: { key: TabKey; label: string }[] = [
  { key: "widget",   label: "Subscription widget" },
  { key: "designs",  label: "Widget designs"       },
  { key: "advanced", label: "Advanced"             },
];

const DESIGNS = [
  {
    key: "default",
    label: "Default",
    desc:  "Standard Shopify-style option list",
    preview: (color: string, radius: number) => (
      <div style={{ border: "1px solid #e5e7eb", borderRadius: "8px", overflow: "hidden", fontSize: "13px" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "16px", height: "16px", borderRadius: "50%", border: "2px solid #ccc", display: "flex", alignItems: "center", justifyContent: "center" }} />
            <span>One-time purchase</span>
          </div>
          <span>$41.00</span>
        </div>
        <div style={{ padding: "10px 14px", background: "#f9fafb" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "16px", height: "16px", borderRadius: "50%", border: `2px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: color }} />
              </div>
              <span>Subscribe &amp; save</span>
            </div>
            <span>$36.90</span>
          </div>
        </div>
      </div>
    ),
  },
  {
    key: "arctic",
    label: "Arctic",
    desc:  "Cleaner look with save badge inline",
    preview: (color: string, radius: number) => (
      <div style={{ border: "1px solid #e5e7eb", borderRadius: `${radius}px`, overflow: "hidden", fontSize: "13px" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "16px", height: "16px", borderRadius: "50%", border: "2px solid #ccc" }} />
            <span>One-time purchase</span>
          </div>
          <span>$41.00</span>
        </div>
        <div style={{ padding: "10px 14px", border: `1.5px solid ${color}`, borderRadius: `${radius}px`, margin: "6px", background: `${color}10` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "16px", height: "16px", borderRadius: "50%", border: `2px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: color }} />
              </div>
              <span>Subscribe &amp; save</span>
              <span style={{ background: "#F5A623", color: "#fff", fontSize: "10px", fontWeight: 700, padding: "1px 6px", borderRadius: "4px" }}>SAVE 10%</span>
            </div>
            <span style={{ color, fontWeight: 600 }}>$36.90</span>
          </div>
          <div style={{ marginLeft: "24px", marginTop: "6px", fontSize: "12px", color: "#666" }}>
            Deliver every <select style={{ fontSize: "11px", border: "1px solid #ccc", borderRadius: "4px", padding: "1px 4px" }}><option>month</option></select>
          </div>
        </div>
      </div>
    ),
  },
  {
    key: "ribbon",
    label: "Ribbon",
    desc:  "Save badge on top-left corner ribbon",
    preview: (color: string, radius: number) => (
      <div style={{ border: "1px solid #e5e7eb", borderRadius: "8px", overflow: "hidden", fontSize: "13px" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "16px", height: "16px", borderRadius: "50%", border: "2px solid #ccc" }} />
            <span>One-time purchase</span>
          </div>
          <span>$41.00</span>
        </div>
        <div style={{ position: "relative", padding: "10px 14px", border: `1.5px solid ${color}`, margin: "6px", borderRadius: `${radius}px` }}>
          <div style={{ position: "absolute", top: "-1px", left: "10px", background: "#F5A623", color: "#fff", fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "0 0 6px 6px" }}>SAVE 10%</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "6px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "16px", height: "16px", borderRadius: "50%", border: `2px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: color }} />
              </div>
              <span style={{ fontWeight: 600 }}>Subscribe &amp; save</span>
            </div>
            <div>
              <span style={{ textDecoration: "line-through", color: "#999", marginRight: "6px", fontSize: "11px" }}>$41.00</span>
              <span style={{ color, fontWeight: 700 }}>$36.90</span>
            </div>
          </div>
        </div>
      </div>
    ),
  },
  {
    key: "benefits",
    label: "Benefits",
    desc:  "Full-width frequency picker with benefit chips",
    preview: (color: string, radius: number) => (
      <div style={{ border: "1px solid #e5e7eb", borderRadius: "8px", overflow: "hidden", fontSize: "13px" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "16px", height: "16px", borderRadius: "50%", border: "2px solid #ccc" }} />
            <span>One-time purchase</span>
          </div>
          <span>$41.00</span>
        </div>
        <div style={{ padding: "12px 14px", border: `1.5px solid ${color}`, borderRadius: `${radius}px`, margin: "6px", background: `${color}10` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ width: "16px", height: "16px", borderRadius: "50%", border: `2px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: color }} />
              </div>
              <span style={{ fontWeight: 600 }}>Subscribe &amp; Save 10%</span>
            </div>
            <div>
              <span style={{ textDecoration: "line-through", color: "#999", marginRight: "6px", fontSize: "11px" }}>$41.00</span>
              <span style={{ color, fontWeight: 700 }}>$36.90</span>
            </div>
          </div>
          <div style={{
            marginTop: "8px", padding: "7px 10px", fontSize: "12px",
            border: "1.5px solid #e5e7eb", borderRadius: `${radius}px`, background: "#fff",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span>Delivery every 1 month</span>
            <span style={{ color: "#6b7280", fontSize: "10px" }}>▾</span>
          </div>
          <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {["10% off each order", "Manage subscriptions easily"].map((c) => (
              <span key={c} style={{ background: "#f3f4f6", color: "#6b7280", fontSize: "11px", padding: "4px 8px", borderRadius: "6px" }}>{c}</span>
            ))}
          </div>
        </div>
      </div>
    ),
  },
];

// ─── Live Widget Preview ──────────────────────────────────────
function WidgetPreview({
  primaryColor,
  saveBadgeColor,
  borderRadius,
  showOneTime,
  textColor,
  selectedBg,
  design,
  samplePrice,
  plans,
  benefitChips,
}: {
  primaryColor:   string;
  saveBadgeColor: string;
  borderRadius:   number;
  showOneTime:    boolean;
  textColor:      string;
  selectedBg:     string;
  design:         string;
  samplePrice:    number;
  plans:          Array<{ id: string; name: string; discount: number; interval: string; intervalCount: number }>;
  benefitChips:   string[];
}) {
  const [selected,         setSelected]         = useState<"onetime" | "subscribe">("onetime");
  const [selectedPlanIdx,  setSelectedPlanIdx]  = useState(0);

  const planList = plans.length > 0 ? plans : [
    { id: "demo1", name: "Every 1 Month (10% off)", discount: 10, interval: "MONTH", intervalCount: 1 },
    { id: "demo2", name: "Every 2 Months (15% off)", discount: 15, interval: "MONTH", intervalCount: 2 },
  ];

  const activePlan      = planList[selectedPlanIdx] ?? planList[0];
  const activeDiscount  = activePlan?.discount ?? 0;
  const activePrice     = activeDiscount > 0
    ? samplePrice * (1 - activeDiscount / 100)
    : samplePrice;

  const isBenefits = design === "benefits";

  // Extract dropdown label from plan name: "Every 1 Month (10% off)" → "1 Month"
  const getPlanLabel = (plan: typeof planList[0]) => {
    const m = plan.name.match(/Every (.+?)(\s*\(|$)/);
    if (m) return m[1];
    const map: Record<string, string> = { DAY: "Day", WEEK: "Week", MONTH: "Month", YEAR: "Year" };
    const unit = map[plan.interval] ?? "Month";
    return plan.intervalCount > 1 ? `${plan.intervalCount} ${unit}s` : `1 ${unit}`;
  };

  // Benefits spells the cadence out in the option itself, matching the
  // storefront's "Delivery every 10 weeks".
  const getOptionLabel = (plan: typeof planList[0]) =>
    isBenefits ? `Delivery every ${getPlanLabel(plan).toLowerCase()}` : getPlanLabel(plan);

  // Same rules the storefront applies: {discount} is substituted, and a chip
  // that uses the token disappears when there is no discount.
  const resolvedChips = benefitChips
    .filter((t) => t.trim())
    .filter((t) => activeDiscount > 0 || !t.includes("{discount}"))
    .map((t) => t.replace(/\{discount\}/g, String(activeDiscount)).trim());

  return (
    <div className="hover-card" style={{
      background: "var(--p-color-bg-surface)",
      border: "0.5px solid var(--p-color-border)",
      borderRadius: "14px", overflow: "hidden", position: "sticky", top: "20px",
    }}>
      {/* Preview header */}
      <div style={{
        padding: "12px 16px",
        borderBottom: "0.5px solid var(--p-color-border)",
        background: "var(--p-color-bg-surface-secondary)",
        display: "flex", alignItems: "center", gap: "8px",
      }}>
        <div style={{ display: "flex", gap: "5px" }}>
          {["#FF5F57","#FFBD2E","#28CA41"].map(c => (
            <div key={c} style={{ width: "10px", height: "10px", borderRadius: "50%", background: c }} />
          ))}
        </div>
        <Text as="p" variant="bodySm" tone="subdued">Widget preview</Text>
      </div>

      {/* Simulated product page */}
      <div style={{ padding: "20px" }}>
        {/* Product info */}
        <div style={{ marginBottom: "16px" }}>
          <div style={{ width: "120px", height: "8px", background: "var(--p-color-border)", borderRadius: "4px", marginBottom: "6px" }} />
          <Text as="p" variant="headingLg" fontWeight="bold">
            <span style={{ color: textColor }}>${samplePrice.toFixed(2)}</span>
          </Text>
        </div>

        {/* Purchase options label */}
        <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", color: "#888", textTransform: "uppercase", marginBottom: "10px" }}>
          Purchase options
        </div>

        {/* Options */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>

          {/* One-time purchase */}
          {showOneTime && (
            <div
              onClick={() => setSelected("onetime")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "12px 14px", cursor: "pointer",
                borderRadius: `${borderRadius}px`,
                border: selected === "onetime"
                  ? `1.5px solid ${primaryColor}`
                  : "1px solid #e5e7eb",
                background: selected === "onetime" ? selectedBg : "#fff",
                transition: "all 0.15s",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div style={{
                  width: "18px", height: "18px", borderRadius: "50%", flexShrink: 0,
                  border: selected === "onetime" ? `2px solid ${primaryColor}` : "2px solid #ccc",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {selected === "onetime" && (
                    <div style={{ width: "9px", height: "9px", borderRadius: "50%", background: primaryColor }} />
                  )}
                </div>
                <span style={{ fontSize: "14px", color: textColor, fontWeight: selected === "onetime" ? 600 : 400 }}>
                  One-time purchase
                </span>
              </div>
              <span style={{ fontSize: "14px", color: textColor, fontWeight: 500 }}>
                ${samplePrice.toFixed(2)}
              </span>
            </div>
          )}

          {/* Single Subscribe & save option with interval dropdown */}
          {planList.length > 0 && (
            <div
              onClick={() => setSelected("subscribe")}
              style={{
                cursor: "pointer", position: "relative",
                borderRadius: `${borderRadius}px`,
                border: selected === "subscribe" ? `1.5px solid ${primaryColor}` : "1px solid #e5e7eb",
                background: selected === "subscribe" ? selectedBg : "#fff",
                transition: "all 0.15s",
                overflow: "hidden",
              }}
            >
              {/* Ribbon badge */}
              {design === "ribbon" && activeDiscount > 0 && (
                <div style={{
                  position: "absolute", top: 0, left: "12px",
                  background: saveBadgeColor, color: "#fff",
                  fontSize: "10px", fontWeight: 700,
                  padding: "2px 8px", borderRadius: "0 0 6px 6px",
                }}>
                  SAVE {activeDiscount}%
                </div>
              )}

              {/* Header row */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: design === "ribbon" && activeDiscount > 0 ? "18px 14px 12px" : "12px 14px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{
                    width: "18px", height: "18px", borderRadius: "50%", flexShrink: 0,
                    border: selected === "subscribe" ? `2px solid ${primaryColor}` : "2px solid #ccc",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {selected === "subscribe" && (
                      <div style={{ width: "9px", height: "9px", borderRadius: "50%", background: primaryColor }} />
                    )}
                  </div>
                  <div>
                    <span style={{ fontSize: "14px", color: textColor, fontWeight: selected === "subscribe" ? 600 : 400 }}>
                      {isBenefits && activeDiscount > 0
                        ? `Subscribe & Save ${activeDiscount}%`
                        : "Subscribe & save"}
                    </span>
                    {/* Arctic only: inline badge. Dropdown puts its badge after
                        the price instead, so the frequency picker leads. */}
                    {design === "arctic" && activeDiscount > 0 && (
                      <span style={{
                        marginLeft: "8px", fontSize: "10px", fontWeight: 700,
                        background: saveBadgeColor, color: "#fff",
                        padding: "2px 6px", borderRadius: "4px",
                      }}>
                        SAVE {activeDiscount}%
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  {/* Strikethrough price — Arctic and Ribbon only, not Default */}
                  {activeDiscount > 0 && design !== "default" && (
                    <div style={{ fontSize: "11px", color: "#aaa", textDecoration: "line-through" }}>
                      ${samplePrice.toFixed(2)}
                    </div>
                  )}
                  <span style={{ fontSize: "14px", color: selected === "subscribe" ? primaryColor : textColor, fontWeight: 600 }}>
                    {/* Default shows full price, others show discounted */}
                    ${design === "default" ? samplePrice.toFixed(2) : activePrice.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Frequency picker — shown when the subscribe option is selected.
                  Benefits gives it the full width of the card and drops the
                  "Deliver every" prefix, since each option already reads in full. */}
              {selected === "subscribe" && (
                <div
                  style={
                    isBenefits
                      ? { padding: "0 14px 12px" }
                      : { marginLeft: "28px", marginBottom: "12px", display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#666" }
                  }
                  onClick={(e) => e.stopPropagation()}
                >
                  {!isBenefits && "Deliver every"}
                  <select
                    value={selectedPlanIdx}
                    onChange={(e) => setSelectedPlanIdx(Number(e.target.value))}
                    style={{
                      fontSize: "13px", fontWeight: 500,
                      padding: isBenefits ? "8px 10px" : "4px 8px",
                      width: isBenefits ? "100%" : undefined,
                      border: `${isBenefits ? 1.5 : 1}px solid #d1d5db`,
                      borderRadius: `${isBenefits ? borderRadius : 6}px`,
                      background: "#fff", color: textColor, cursor: "pointer",
                      appearance: "auto",
                    }}
                  >
                    {planList.map((p, i) => (
                      <option key={p.id} value={i}>{getOptionLabel(p)}</option>
                    ))}
                  </select>

                  {isBenefits && resolvedChips.length > 0 && (
                    <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {resolvedChips.map((c, i) => (
                        <span key={i} style={{
                          background: "#f3f4f6", color: "#6b7280", fontSize: "11px",
                          padding: "4px 8px", borderRadius: "6px",
                        }}>
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ marginTop: "14px", fontSize: "11px", color: "#999", textAlign: "center" }}>
          You can further customize the widget in Settings &gt; Subscription widget.
        </div>
      </div>
    </div>
  );
}

// ─── Setting row helper ───────────────────────────────────────
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "14px 0", borderBottom: "0.5px solid var(--p-color-border-secondary)" }}>
      <div style={{ marginBottom: "8px" }}>
        <Text as="p" variant="bodySm" fontWeight="medium">{label}</Text>
        {hint && <Text as="p" variant="bodySm" tone="subdued">{hint}</Text>}
      </div>
      {children}
    </div>
  );
}


// ─── Page ─────────────────────────────────────────────────────
export default function WidgetSettingsPage() {
  const { plans, saved } = useLoaderData<typeof loader>();
  const actionData        = useActionData<typeof action>();
  const navigation        = useNavigation();
  const isSaving          = navigation.state === "submitting";

  const [activeTab,   setActiveTab]   = useState<TabKey>("widget");
  const [design,      setDesign]      = useState(saved.design);
  const [chips,       setChips]       = useState<string[]>(saved.benefitChips);
  const [savedBanner, setSavedBanner] = useState(false);

  // Preview-only constants (not editable — controlled by theme block)
  const primaryColor  = saved.primaryColor;
  const saveBadge     = saved.badgeColor;
  const borderRadius  = saved.borderRadius;
  const showOneTime   = saved.showOnetime;
  const textColor     = "#1A1A1A";
  const selectedBg    = "#F5F3FF";
  const samplePrice   = 39.99;

  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.ok) {
      setSavedBanner(true);
      const t = setTimeout(() => setSavedBanner(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const submitFn = useSubmit();

  function handleSave() {
    const fd = new FormData();
    fd.append("primaryColor",  primaryColor);
    fd.append("badgeColor",    saveBadge);
    fd.append("borderRadius",  String(borderRadius));
    fd.append("showOnetime",   String(showOneTime));
    fd.append("design",        design);
    // Repeated key — the action reads them back with form.getAll("benefitChip").
    chips.forEach((c) => fd.append("benefitChip", c));
    submitFn(fd, { method: "post" });
  }

  const card: React.CSSProperties = {
    background: "var(--p-color-bg-surface)",
    border: "0.5px solid var(--p-color-border)",
    borderRadius: "14px", padding: "20px 22px",
  };

  return (
    <Page>
      <TitleBar title="Subscription Widget" />
      <BlockStack gap="500">

        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <BlockStack gap="100">
            <InlineStack gap="150" blockAlign="center">
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: T.purple, display: "inline-block", flexShrink: 0 }} />
              <div className="breadcrumbs-dashboard">
                <Text as="span" variant="bodySm" tone="subdued">
                  Smart Subscriptions › <span className="subscription">Widget Settings</span>
                </Text>
              </div>
            </InlineStack>
            <div className="varient-section">
              <Text as="h1" variant="headingXl" fontWeight="bold">Subscription Widget</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Customize how the subscription options appear on your product pages.
              </Text>
            </div>
          </BlockStack>
          <button
            onClick={handleSave}
            disabled={isSaving}
            style={{
              fontSize: "13px", padding: "8px 18px", borderRadius: "9px",
              background: savedBanner ? T.greenFg : T.purpleDark,
              color: "#fff", border: "none",
              cursor: isSaving ? "not-allowed" : "pointer",
              fontWeight: 500, marginTop: "4px",
              opacity: isSaving ? 0.7 : 1,
              transition: "background 0.3s",
            }}
          >
            {isSaving ? "Saving…" : savedBanner ? "✓ Saved!" : "Save settings"}
          </button>
        </div>

        {/* ── Tabs ─────────────────────────────────────────────── */}
        <div style={{ borderBottom: "0.5px solid var(--p-color-border)", display: "flex", gap: "2px" }}>
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: "10px 18px", background: "none", border: "none", cursor: "pointer",
                fontWeight: 500, fontSize: "13px",
                color: activeTab === tab.key ? T.purpleFg : "var(--p-color-text-subdued)",
                borderBottom: activeTab === tab.key ? `2px solid ${T.purple}` : "2px solid transparent",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Two-column body ──────────────────────────────────── */}
        <div style={{ display: "flex", gap: "20px", alignItems: "flex-start" }}>

          {/* ─ Left: settings panel ────────────────────────────── */}
          <div style={{ flex: 1 }}>

            {/* Subscription widget tab */}
            {activeTab === "widget" && (
              <div className="hover-card" style={card}>
                <Text as="h2" variant="headingMd" fontWeight="semibold">Subscription widget</Text>
                <Text as="p" variant="bodySm" tone="subdued" >
                  These settings are applied to the subscription widget on product pages.
                </Text>

                <div style={{ marginTop: "16px" }}>
                  {/* Widget enable/disable info */}
                  <div style={{
                    background: T.blueBg, border: "0.5px solid #A8CFEC",
                    borderRadius: "10px", padding: "12px 14px", marginBottom: "16px",
                    display: "flex", gap: "10px", alignItems: "flex-start",
                  }}>
                    <span style={{ fontSize: "16px", flexShrink: 0 }}>ℹ️</span>
                    <div>
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        Widget visibility is controlled by your theme
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        To show or hide the subscription widget, go to{" "}
                        <strong>Shopify Admin → Online Store → Themes → Customize</strong>,
                        then add or remove the <strong>"Subscription Options"</strong> block from your product page.
                      </Text>
                    </div>
                  </div>

                  <div style={{
                    background: T.greenBg, border: "0.5px solid #3B6D11",
                    borderRadius: "10px", padding: "12px 14px",
                    display: "flex", gap: "10px", alignItems: "flex-start",
                  }}>
                    <span style={{ fontSize: "16px", flexShrink: 0 }}>🎨</span>
                    <div>
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        Colors &amp; styling are set in your theme
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Go to <strong>Shopify Admin → Online Store → Themes → Customize</strong>,
                        select the <strong>"Subscription Options"</strong> block, and change
                        accent color, badge color, and border radius from there.
                      </Text>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Widget designs tab */}
            {activeTab === "designs" && (
              <div className="hover-card" style={card}>
                <Text as="h2" variant="headingMd" fontWeight="semibold">Widget designs</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Choose how the subscription options look on your product page.
                </Text>
                <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
                  {DESIGNS.map((d) => (
                    <label key={d.key} style={{ cursor: "pointer" }}>
                      <div style={{
                        border: design === d.key
                          ? `1.5px solid ${T.purple}`
                          : "0.5px solid var(--p-color-border)",
                        borderRadius: "12px", padding: "14px 16px",
                        background: design === d.key ? T.purpleBg : "var(--p-color-bg-surface)",
                        transition: "all 0.15s",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                          <input
                            type="radio"
                            name="design"
                            value={d.key}
                            checked={design === d.key}
                            onChange={() => setDesign(d.key)}
                            style={{ accentColor: T.purple, width: "15px", height: "15px" }}
                          />
                          <div>
                            <Text as="p" variant="bodyMd" fontWeight="semibold">{d.label}</Text>
                            <Text as="p" variant="bodySm" tone="subdued">{d.desc}</Text>
                          </div>
                        </div>
                        <div style={{ pointerEvents: "none" }}>
                          {d.preview(primaryColor, borderRadius)}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>

                {/* Chip editor — only the Benefits design renders chips, so it
                    only appears once that design is selected. */}
                {design === "benefits" && (
                  <div style={{ marginTop: "20px", borderTop: "0.5px solid var(--p-color-border)" }}>
                    <SettingRow
                      label="Benefit chips"
                      hint={`Short selling points shown under the frequency picker. Write {discount} to insert the plan's discount — that chip is hidden automatically when a plan has none. Up to ${MAX_BENEFIT_CHIPS}.`}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        {chips.map((chip, i) => (
                          <div key={i} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <input
                              type="text"
                              value={chip}
                              placeholder="e.g. Free shipping every order"
                              onChange={(e) => {
                                const next = [...chips];
                                next[i] = e.target.value;
                                setChips(next);
                              }}
                              style={{
                                flex: 1, fontSize: "13px", padding: "8px 10px",
                                border: "0.5px solid var(--p-color-border-secondary)",
                                borderRadius: "8px", background: "var(--p-color-bg-surface)",
                                color: "var(--p-color-text)", outline: "none", boxSizing: "border-box",
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => setChips(chips.filter((_, j) => j !== i))}
                              aria-label={`Remove chip ${i + 1}`}
                              style={{
                                border: "0.5px solid var(--p-color-border-secondary)",
                                background: "var(--p-color-bg-surface)", cursor: "pointer",
                                borderRadius: "8px", width: "32px", height: "34px",
                                fontSize: "15px", lineHeight: 1, color: "var(--p-color-text-subdued)",
                                flexShrink: 0,
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}

                        <button
                          type="button"
                          onClick={() => setChips([...chips, ""])}
                          disabled={chips.length >= MAX_BENEFIT_CHIPS}
                          style={{
                            alignSelf: "flex-start", marginTop: "4px",
                            fontSize: "12px", padding: "7px 14px", borderRadius: "8px",
                            border: "0.5px solid var(--p-color-border-secondary)",
                            background: "var(--p-color-bg-surface)",
                            cursor: chips.length >= MAX_BENEFIT_CHIPS ? "not-allowed" : "pointer",
                            opacity: chips.length >= MAX_BENEFIT_CHIPS ? 0.5 : 1,
                            fontWeight: 500,
                          }}
                        >
                          + Add chip
                        </button>
                      </div>
                    </SettingRow>
                  </div>
                )}
              </div>
            )}

            {/* Advanced tab */}
            {activeTab === "advanced" && (
              <div className="hover-card" style={card}>
                <Text as="h2" variant="headingMd" fontWeight="semibold">Advanced settings</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Fine-tune widget behavior.
                </Text>
                <div style={{ marginTop: "16px" }}>
                  <SettingRow label="Auto-select subscription option" hint="Automatically select the first subscription option when the page loads.">
                    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                      <input type="checkbox" style={{ accentColor: T.purple, width: "15px", height: "15px" }} />
                      <Text as="span" variant="bodySm">Auto-select first subscription option</Text>
                    </label>
                  </SettingRow>
                  <SettingRow label="Show subscription details link" hint="Show a 'Subscription details' link below the options.">
                    <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                      <input type="checkbox" defaultChecked style={{ accentColor: T.purple, width: "15px", height: "15px" }} />
                      <Text as="span" variant="bodySm">Show subscription details link</Text>
                    </label>
                  </SettingRow>
                  <SettingRow label="Custom CSS" hint="Add custom CSS to further style the widget.">
                    <textarea
                      placeholder="/* your custom CSS here */"
                      style={{
                        width: "100%", minHeight: "80px", fontSize: "12px",
                        fontFamily: "monospace", padding: "8px 10px",
                        border: "0.5px solid var(--p-color-border-secondary)",
                        borderRadius: "8px", background: "var(--p-color-bg-surface-secondary)",
                        color: "var(--p-color-text)", outline: "none", resize: "vertical",
                        boxSizing: "border-box",
                      }}
                    />
                  </SettingRow>
                </div>
              </div>
            )}

          </div>

          {/* ─ Right: widget preview ───────────────────────────── */}
          <div style={{ width: "300px", flexShrink: 0 }}>
            <WidgetPreview
              primaryColor={primaryColor}
              saveBadgeColor={saveBadge}
              borderRadius={borderRadius}
              showOneTime={true}
              textColor={textColor}
              selectedBg={selectedBg}
              design={design}
              samplePrice={samplePrice}
              plans={plans}
              benefitChips={chips}
            />
          </div>
        </div>

      </BlockStack>
    </Page>
  );
}

