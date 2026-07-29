// app/routes/api.widget-settings.ts
// Public endpoint — returns widget settings for a shop (used by extension JS)

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

const DEFAULTS = {
  primaryColor:  "#5B4FCB",
  badgeColor:    "#F5A623",
  borderRadius:  10,
  showOnetime:   true,
  design:        "arctic",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control":                "public, max-age=300", // 5-min CDN cache
};

export async function loader({ request }: LoaderFunctionArgs) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url  = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return json({ error: "Missing ?shop= parameter" }, { status: 400, headers: CORS_HEADERS });
  }

  let s: Record<string, any> = {};
  try {
    s = (await prisma.appSettings.findUnique({ where: { shop } }) as any) ?? {};
  } catch (err) {
    console.error("[widget-settings] DB error:", err);
  }

  return json(
    {
      primaryColor:  s.widgetPrimaryColor  ?? DEFAULTS.primaryColor,
      badgeColor:    s.widgetBadgeColor    ?? DEFAULTS.badgeColor,
      borderRadius:  s.widgetBorderRadius  ?? DEFAULTS.borderRadius,
      showOnetime:   s.widgetShowOnetime   ?? DEFAULTS.showOnetime,
      design:        s.widgetDesign        ?? DEFAULTS.design,
    },
    { headers: CORS_HEADERS },
  );
}

