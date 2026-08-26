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
export const WIDGET_PAYLOAD_VERSION = 5;

/**
 * A single plan's overrides of the shop-wide appearance.
 *
 * Every field is optional in effect: "" (or null for the radius) means "inherit
 * the shop value". The storefront applies these against whichever plan the
 * shopper currently has selected, so a product with several plans attached
 * changes appearance as they switch between them.
 */
export interface PlanWidget {
  design: string;
  chips:  string[];
  primaryColor: string;
  badgeColor:   string;
  /** null = inherit. 0 is a real radius, so it cannot double as "unset". */
  borderRadius: number | null;
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
   * Per-plan overrides, keyed by the BARE NUMERIC SELLING PLAN id — what Liquid
   * emits as `data-plan-id` and what the cart posts as `selling_plan`.
   *
   * Deliberately NOT the selling plan GROUP id. Liquid exposes a group's id only
   * as a hash ("e88ff8fdb3c39c89b564859e34542e0b982076d6"), which can never equal
   * the numeric id we store — keying on it meant every lookup missed, and since a
   * miss reads as "this plan overrides nothing", the whole feature was silently
   * inert. A plan id is numeric on both sides.
   *
   * Only groups that actually override something appear here.
   */
  planWidgets: Record<string, PlanWidget>;
  /**
   * Every selling plan this app still tracks, as bare numeric ids matching
   * `data-plan-id`. The storefront hides any option NOT on this list.
   *
   * Liquid renders `product.selling_plan_groups` — everything Shopify has attached
   * to the product, tracked or not. A group that outlives its local row (an
   * uninstall/reinstall, a reset database) otherwise keeps selling with nothing in
   * the admin able to manage or remove it.
   *
   * `null` means the answer is UNKNOWN and the storefront must not filter at all
   * — either the lookup failed, or the shop has groups whose `shopifySellingPlanId`
   * has not been backfilled yet. An empty array is a real answer — this shop
   * tracks no plans — and does hide everything. The two must never be collapsed:
   * that would turn a momentary database error, or a backfill that has simply not
   * run, into "no subscriptions on any product page".
   */
  knownPlanIds: string[] | null;
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
  knownPlanIds: [],
};

/**
 * `gid://shopify/SellingPlan/12345` → `12345`.
 *
 * Liquid renders a selling plan's id as that bare number, so the map the
 * storefront looks up has to be keyed that way. Anything already bare passes
 * through, so this is safe whichever shape the column holds.
 */
function bareShopifyId(gid: string): string {
  const tail = gid.split("/").pop() ?? gid;
  return tail.trim();
}

/**
 * Per-plan appearance overrides, keyed for storefront lookup.
 *
 * Groups that override nothing are omitted rather than sent as empty entries —
 * this payload is fetched on every product page view.
 *
 * Never throws, for the same reason as getStoredWidgetSettings: a storefront
 * product page must still render when this lookup fails.
 */
async function getPlanData(
  shop: string,
): Promise<{ planWidgets: Record<string, PlanWidget>; knownPlanIds: string[] | null }> {
  let groups: Array<Record<string, any>> = [];
  try {
    groups = await prisma.sellingPlanGroup.findMany({
      where:  { shop },
      select: {
        shopifySellingPlanId: true,
        widgetDesign:       true,
        widgetBenefitChips: true,
        widgetPrimaryColor: true,
        widgetBadgeColor:   true,
        widgetBorderRadius: true,
      },
    }) as any;
  } catch (err) {
    console.error("[widget-settings] plan widgets DB error:", err);
    // null, NOT [] — see the knownPlanIds docstring. "We could not read the
    // database" must never be delivered as "this shop has no plans", which the
    // storefront would act on by hiding every subscription option it has.
    return { planWidgets: {}, knownPlanIds: null };
  }

  const map: Record<string, PlanWidget> = {};
  const ids: string[] = [];
  for (const g of groups) {
    // Without a plan id there is no key the storefront could ever look up. Plans
    // created before this column existed are backfilled by the /app/plans loader,
    // so this skip is transient rather than permanent.
    if (!g.shopifySellingPlanId) continue;

    // Tracked regardless of whether it overrides anything — this list answers
    // "does the app still know about this plan", not "does it restyle it".
    ids.push(bareShopifyId(g.shopifySellingPlanId));

    const design       = (g.widgetDesign       ?? "").trim();
    const primaryColor = (g.widgetPrimaryColor ?? "").trim();
    const badgeColor   = (g.widgetBadgeColor   ?? "").trim();
    const borderRadius = typeof g.widgetBorderRadius === "number" ? g.widgetBorderRadius : null;
    const chips        = parseBenefitChips(g.widgetBenefitChips);

    // Every override must appear in this test. A plan that sets ONLY a colour
    // would otherwise be dropped from the map and its override would never
    // reach the storefront at all.
    const overridesNothing =
      !design && !primaryColor && !badgeColor && borderRadius === null && chips.length === 0;
    if (overridesNothing) continue;

    map[bareShopifyId(g.shopifySellingPlanId)] = { design, chips, primaryColor, badgeColor, borderRadius };
  }

  // Rows exist but not one carries a plan id — the /app/plans backfill has not
  // run yet on this shop. That is "cannot determine", NOT "tracks no plans", and
  // the difference is the whole storefront: `[]` is a real answer that hides
  // every option on the page, so a database still waiting to be backfilled would
  // take down subscriptions it was only ever meant to filter. Only a shop with
  // genuinely no groups may answer `[]`.
  if (groups.length > 0 && ids.length === 0) {
    console.warn(
      `[widget-settings] ${groups.length} selling plan group(s) for ${shop} but none has ` +
      `shopifySellingPlanId — not filtering. Open /app/plans to backfill.`,
    );
    return { planWidgets: map, knownPlanIds: null };
  }

  return { planWidgets: map, knownPlanIds: ids };
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

  const { planWidgets, knownPlanIds } = await getPlanData(shop);

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
    // Also exempt from the stored-only rule, and for a sharper reason: null here
    // already carries its own meaning ("lookup failed, do not filter"), so it must
    // pass through exactly as computed rather than be coalesced.
    knownPlanIds,
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
    // Deliberately NOT defaulted with `??`: null is a meaningful value here, not an
    // unset one, and coalescing it to [] would turn "we could not read the
    // database" into "hide every plan" — the exact inversion this field guards.
    knownPlanIds: s.knownPlanIds,
  };
}
