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

export interface WidgetSettings {
  primaryColor: string;
  badgeColor:   string;
  borderRadius: number;
  showOnetime:  boolean;
  design:       string;
}

export const WIDGET_DEFAULTS: WidgetSettings = {
  primaryColor: "#5B4FCB",
  badgeColor:   "#F5A623",
  borderRadius: 10,
  showOnetime:  true,
  design:       "arctic",
};

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

  return {
    primaryColor: s.widgetPrimaryColor ?? null,
    badgeColor:   s.widgetBadgeColor   ?? null,
    borderRadius: s.widgetBorderRadius ?? null,
    showOnetime:  s.widgetShowOnetime  ?? null,
    design:       s.widgetDesign       ?? null,
  };
}

/** Saved settings with defaults filled in for anything unset. */
export async function getWidgetSettings(shop: string): Promise<WidgetSettings> {
  const s = await getStoredWidgetSettings(shop);
  return {
    primaryColor: s.primaryColor ?? WIDGET_DEFAULTS.primaryColor,
    badgeColor:   s.badgeColor   ?? WIDGET_DEFAULTS.badgeColor,
    borderRadius: s.borderRadius ?? WIDGET_DEFAULTS.borderRadius,
    showOnetime:  s.showOnetime  ?? WIDGET_DEFAULTS.showOnetime,
    design:       s.design       ?? WIDGET_DEFAULTS.design,
  };
}
