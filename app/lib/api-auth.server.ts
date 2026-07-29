// app/lib/api-auth.server.ts
// Shared authentication for all public API routes
// Usage: const shop = await authenticateApiKey(request);

import prisma from "../db.server";

export async function authenticateApiKey(request: Request): Promise<string> {
  const apiKey = request.headers.get("x-api-key");

  if (!apiKey) {
    throw new Response(
      JSON.stringify({ error: "Missing x-api-key header" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const record = await prisma.apiKey.findUnique({
    where: { key: apiKey },
  });

  if (!record || !record.active) {
    throw new Response(
      JSON.stringify({ error: "Invalid or inactive API key" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  return record.shop;
}
