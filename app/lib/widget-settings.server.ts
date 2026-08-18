// app/lib/widget-settings.server.ts
//
// The storefront widget's appearance settings, as saved by the admin
// "Subscription widget" page.
//
// Shared by two endpoints so their payloads cannot drift:
//   /api/widget-settings                 — direct, CORS-enabled
//   /apps/subscriptions/widget-settings  — through the app proxy, which is what
//                                          the theme extension actually calls
//                                          (same-origin, so no CORS and no
//                                          hardcoded app URL).

import prisma from "../db.server";
import { DEFAULT_BENEFIT_CHIPS, parseBenefitChips } from "../config/widget-chips";

/**
 * Bump whenever a FIELD IS ADDED to the payload.
 *
 * A server running older code answers 200 with a silently smaller object, which
 * is indistinguishable from success at the call site — that cost an afternoon of
 * chasing a "CSS bug" that was really an undeployed server. The widget compares
 * this against the version its own build expects and says so.
 */
export const WIDGET_PAYLOAD_VERSION = 2;

/** A single plan's overrides of the shop-wide appearance. */
export interface PlanWidget {
  design: string;
  chips:  string[];
}

export interface WidgetSettings {
  /** See WIDGET_PAYLOAD_VERSION — lets the storefront detect a stale server. */
  apiVersion:   number;
  primaryColor: string;
  badgeColor:   string;
  borderRadius: number;
  showOnetime:  boolean;
  design:       string;
  /** Chip labels for the "benefits" design. `{discount}` is substituted at render. */
  benefitChips: string[];
  /**
   * Per-plan overrides, keyed by the BARE NUMERIC selling plan group id — that
   * is what Liquid emits as `data-group-id`, whereas we store the full GID.
   * Only groups that actually override something appear here.
   */
  planWidgets: Record<string, PlanWidget>;
}

export const WIDGET_DEFAULTS: WidgetSettings = {
  apiVersion:   WIDGET_PAYLOAD_VERSION,
  primaryColor: "#5B4FCB",
  badgeColor:   "#F5A623",
  borderRadius: 10,
  showOnetime:  true,
  design:       "arctic",
  benefitChips: DEFAULT_BENEFIT_CHIPS,
  planWidgets:  {},
};

/**
 * `gid://shopify/SellingPlanGroup/12345` → `12345`.
 *
 * Liquid exposes the group as a bare numeric id, so the map the storefront
 * looks up has to be keyed that way. Anything already bare passes through, so
 * this is safe whichever shape the column holds.
 */
function bareGroupId(gid: string): string {
  const tail = gid.split("/").pop() ?? gid;
  return tail.trim();
}

/**
 * Per-plan design and chips, keyed for storefront lookup.
 *
 * Groups that override nothing are omitted rather than sent as empty entries —
 * this payload is fetched on every product page view.
 *
 * Never throws, for the same reason as getStoredWidgetSettings: a storefront
 * product page must still render when this lookup fails.
 */
async function getPlanWidgets(shop: string): Promise<Record<string, PlanWidget>> {
  let groups: Array<Record<string, any>> = [];
  try {
    groups = await prisma.sellingPlanGroup.findMany({
      where:  { shop },
      select: { shopifyGroupId: true, widgetDesign: true, widgetBenefitChips: true },
    }) as any;
  } catch (err) {
    console.error("[widget-settings] plan widgets DB error:", err);
    return {};
  }

  const map: Record<string, PlanWidget> = {};
  for (const g of groups) {
    if (!g.shopifyGroupId) continue;               // never pushed to Shopify
    const design = (g.widgetDesign ?? "").trim();
    const chips  = parseBenefitChips(g.widgetBenefitChips);
    if (!design && chips.length === 0) continue;   // inherits everything
    map[bareGroupId(g.shopifyGroupId)] = { design, chips };
  }
  return map;
}

/** Only what the merchant has actually saved; `null` for anything unset. */
export type StoredWidgetSettings = {
  [K in keyof WidgetSettings]: WidgetSettings[K] | null;
};

/**
 * Reads a shop's saved widget settings verbatim — no defaults applied.
 *
 * The storefront needs the distinction: a shop that has never opened the
 * settings page must keep whatever accent colour its theme sets, so the widget
 * can only override fields the merchant actually chose. Coalescing to defaults
 * here would silently repaint every existing widget.
 *
 * Never throws: a storefront product page must still render if this lookup
 * fails, so a database error degrades to "nothing configured".
 */
export async function getStoredWidgetSettings(shop: string): Promise<StoredWidgetSettings> {
  let s: Record<string, any> = {};
  try {
    s = (await prisma.appSettings.findUnique({ where: { shop } }) as any) ?? {};
  } catch (err) {
    console.error("[widget-settings] DB error:", err);
  }

  const planWidgets = await getPlanWidgets(shop);

  // An empty string counts as unset, not as "the merchant wants no chips" — it
  // is also what the column defaults to for every row that predates the field,
  // and those shops should get the standard chips rather than a bare widget.
  const chips = parseBenefitChips(s.widgetBenefitChips);

  return {
    // Always concrete, never null: it describes the SERVER, not the merchant's
    // choices, so it must survive the stored-only contract below.
    apiVersion:   WIDGET_PAYLOAD_VERSION,
    primaryColor: s.widgetPrimaryColor ?? null,
    badgeColor:   s.widgetBadgeColor   ?? null,
    borderRadius: s.widgetBorderRadius ?? null,
    showOnetime:  s.widgetShowOnetime  ?? null,
    design:       s.widgetDesign       ?? null,
    // Chips are the exception to the stored-only rule above. A colour left unset
    // must stay null so the theme's own accent survives — but there is no
    // theme-side chip setting to preserve, so null here just means "render
    // nothing", which is never what a design whose whole point is chips should
    // do. The theme only ever calls the proxy endpoints, which return this
    // function verbatim, so without the fallback the defaults never ship.
    benefitChips: chips.length ? chips : DEFAULT_BENEFIT_CHIPS,
    // Always a concrete object: an empty map is a real answer ("no plan
    // overrides anything"), not an unset value the caller should default.
    planWidgets,
  };
}

/** Saved settings with defaults filled in for anything unset. */
export async function getWidgetSettings(shop: string): Promise<WidgetSettings> {
  const s = await getStoredWidgetSettings(shop);
  return {
    apiVersion:   WIDGET_PAYLOAD_VERSION,
    primaryColor: s.primaryColor ?? WIDGET_DEFAULTS.primaryColor,
    badgeColor:   s.badgeColor   ?? WIDGET_DEFAULTS.badgeColor,
    borderRadius: s.borderRadius ?? WIDGET_DEFAULTS.borderRadius,
    showOnetime:  s.showOnetime  ?? WIDGET_DEFAULTS.showOnetime,
    design:       s.design       ?? WIDGET_DEFAULTS.design,
    benefitChips: s.benefitChips ?? WIDGET_DEFAULTS.benefitChips,
    planWidgets:  s.planWidgets  ?? WIDGET_DEFAULTS.planWidgets,
  };
}
