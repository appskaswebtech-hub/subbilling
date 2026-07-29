// app/routes/api.v1.apikey.ts
//
// GET    /api/v1/apikey  → get current API key (merchant dashboard)
// POST   /api/v1/apikey  → generate new API key
// DELETE /api/v1/apikey  → revoke API key
//
// This route uses Shopify session auth (not API key auth)
// so merchants can manage their own keys from the dashboard

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import crypto from "crypto";

function generateApiKey(): string {
  return `sk_${crypto.randomBytes(32).toString("hex")}`;
}

// GET — fetch current API key
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const apiKey = await prisma.apiKey.findUnique({
    where: { shop },
    select: { key: true, active: true, createdAt: true },
  });

  if (!apiKey) {
    return json({ apiKey: null });
  }

  // Mask key for display: sk_xxxx...xxxx (show first 8 + last 4)
  const masked = `${apiKey.key.substring(0, 11)}${"*".repeat(20)}${apiKey.key.slice(-4)}`;

  return json({
    apiKey: {
      key:       masked,
      active:    apiKey.active,
      createdAt: apiKey.createdAt,
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // POST — generate new API key
  if (request.method === "POST") {
    const key = generateApiKey();

    const apiKey = await prisma.apiKey.upsert({
      where:  { shop },
      update: { key, active: true },
      create: { shop, key, active: true },
    });

    return json({
      apiKey: {
        key:       apiKey.key, // show full key ONCE on generation
        active:    apiKey.active,
        createdAt: apiKey.createdAt,
      },
      message: "API key generated. Save this key — it won't be shown again in full.",
    });
  }

  // DELETE — revoke API key
  if (request.method === "DELETE") {
    await prisma.apiKey.updateMany({
      where: { shop },
      data:  { active: false },
    });

    return json({ message: "API key revoked successfully" });
  }

  return json({ error: "Method not allowed" }, { status: 405 });
}

