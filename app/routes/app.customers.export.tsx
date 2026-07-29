// app/routes/app.customers.export.tsx
//
// Resource route: downloads every customer (not just the current page) as CSV.
// Mirrors the per-customer stat shape built by the loader in app.customers.tsx.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { calcMrr } from "../utils/mrr";

/** Wrap a CSV field in quotes, doubling any embedded quotes. */
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // All customers for this shop — no skip/take, unlike the paginated list loader.
  const rawCustomers = await prisma.subscription.groupBy({
    by:      ["customerId", "customerEmail"],
    where:   { shop: session.shop },
    _count:  { id: true },
    orderBy: { _count: { id: "desc" } },
  });

  const rows = await Promise.all(
    rawCustomers.map(async (c) => {
      const [activeSubs, lastSub, activePlans, collectedAgg] = await Promise.all([
        prisma.subscription.count({
          where: { shop: session.shop, customerId: c.customerId, status: "ACTIVE" },
        }),
        prisma.subscription.findFirst({
          where:   { shop: session.shop, customerId: c.customerId },
          orderBy: { createdAt: "desc" },
          select:  { createdAt: true },
        }),
        prisma.subscription.findMany({
          where:  { shop: session.shop, customerId: c.customerId, status: "ACTIVE" },
          select: { price: true, frequency: true },
        }),
        prisma.billingAttempt.aggregate({
          where: {
            subscription: { shop: session.shop, customerId: c.customerId },
            status:       "SUCCESS",
          },
          _sum: { amount: true },
        }),
      ]);

      const mrr = activePlans.reduce(
        (sum, s) => sum + calcMrr(s.price, s.frequency),
        0,
      );

      return {
        email:          c.customerEmail ?? "",
        customerId:     c.customerId ?? "",
        totalSubs:      c._count.id,
        activeSubs,
        mrr:            mrr.toFixed(2),
        totalCollected: (collectedAgg._sum.amount ?? 0).toFixed(2),
        lastSubDate:    lastSub?.createdAt
          ? new Date(lastSub.createdAt).toLocaleDateString("en-GB", {
              day: "2-digit", month: "short", year: "numeric",
            })
          : "",
      };
    }),
  );

  const header = [
    "Email",
    "Customer ID",
    "Total subscriptions",
    "Active subscriptions",
    "MRR",
    "Total collected",
    "Last subscription",
  ];

  const csv = [
    header.map(csvField).join(","),
    ...rows.map((r) =>
      [
        r.email,
        r.customerId,
        r.totalSubs,
        r.activeSubs,
        r.mrr,
        r.totalCollected,
        r.lastSubDate,
      ].map(csvField).join(","),
    ),
  ].join("\r\n");

  const filename = `customers-${new Date().toISOString().slice(0, 10)}.csv`;

  // Leading BOM so Excel reads UTF-8 correctly.
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type":        "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control":       "no-store",
    },
  });
}
