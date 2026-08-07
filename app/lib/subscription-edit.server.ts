// app/lib/subscription-edit.server.ts
//
// Turns the edit form's POST into a subscription draft, applies the guards
// that stop a merchant accidentally charging a customer, and mirrors the
// committed result locally.
//
// Lives here rather than in the route because Remix only strips `loader`,
// `action` and `headers` from the client bundle — module-level helpers in a
// route that reach into .server modules break the client build.

import { json } from "@remix-run/node";
import prisma from "../db.server";
import {
  SUBSCRIPTION_CONTRACT_QUERY,
  applyContractToLocal,
  contractLines,
  contractRevision,
  toContractGid,
  type ShopifyContract,
} from "./subscription-sync.server";
import {
  applyContractEdits,
  type ContractEdits,
  type LineEdit,
  type PolicyInput,
  type SellingPlanInterval,
} from "./subscription-draft.server";
import type { AdminGraphQL } from "./subscription-contract.server";

const VALID_INTERVALS: SellingPlanInterval[] = ["DAY", "WEEK", "MONTH", "YEAR"];

function readPolicy(formData: FormData, prefix: string): PolicyInput | undefined {
  const interval = formData.get(`${prefix}Interval`) as string | null;
  const count    = formData.get(`${prefix}IntervalCount`) as string | null;
  if (!interval || !count) return undefined;
  if (!VALID_INTERVALS.includes(interval as SellingPlanInterval)) return undefined;

  const parsed = parseInt(count, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;

  return { interval: interval as SellingPlanInterval, intervalCount: parsed };
}

// The earliest date that will not make the billing cron charge immediately.
function earliestBillingDate(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export async function handleContractEdit({
  graphql, shop, localId, formData, commit,
}: {
  graphql:  AdminGraphQL;
  shop:     string;
  localId:  string;
  formData: FormData;
  commit:   boolean;
}) {
  const sub = await prisma.subscription.findFirst({ where: { id: localId, shop } });
  if (!sub) throw new Response("Not found", { status: 404 });

  const contractGid = toContractGid(sub.shopifyContractId);

  // ── Guard: never edit while a charge is in flight ──────────
  // The cron advances nextBillingDate BEFORE creating the attempt, so an edit
  // landing mid-flight can bill the same cycle twice.
  const pending = await prisma.billingAttempt.count({
    where: { subscriptionId: localId, status: "PENDING" },
  });
  if (pending > 0) {
    return json(
      { error: "A billing attempt is in progress for this subscription. Try again once it settles." },
      { status: 409 },
    );
  }

  // ── Read the live contract: needed for line ids, for diffing, and for the
  //    concurrency check ────────────────────────────────────
  let live: ShopifyContract | null = null;
  try {
    const res    = await graphql(SUBSCRIPTION_CONTRACT_QUERY, { variables: { id: contractGid } });
    const result = await res.json() as any;
    if (result?.errors?.length) {
      return json(
        { error: `Could not read the subscription from Shopify: ${result.errors.map((e: any) => e.message).join(" | ")}` },
        { status: 502 },
      );
    }
    live = result?.data?.subscriptionContract ?? null;
  } catch {
    return json({ error: "Could not reach Shopify. Nothing was changed." }, { status: 502 });
  }
  if (!live) {
    return json({ error: "Shopify no longer returns this subscription contract." }, { status: 404 });
  }

  const submittedRevision = formData.get("revision") as string | null;
  if (submittedRevision && submittedRevision !== contractRevision(live)) {
    return json(
      { error: "This subscription changed since you opened this page. Reload and try again." },
      { status: 409 },
    );
  }

  // ── Collect only what actually changed ────────────────────
  const edits: ContractEdits = {};

  const rawDate = formData.get("nextBillingDate") as string | null;
  if (rawDate) {
    const parsed = new Date(`${rawDate}T00:00:00.000Z`);
    if (isNaN(parsed.getTime())) {
      return json({ error: "That next billing date isn't a valid date." }, { status: 400 });
    }
    if (parsed < earliestBillingDate()) {
      return json(
        { error: "Next billing date must be tomorrow or later — an earlier date would charge the customer on the next billing run." },
        { status: 400 },
      );
    }
    const currentNext = live.nextBillingDate ? new Date(live.nextBillingDate).getTime() : NaN;
    if (parsed.getTime() !== currentNext) edits.nextBillingDate = parsed;
  }

  const billing  = readPolicy(formData, "billing");
  const delivery = readPolicy(formData, "delivery");

  if (billing) {
    const cur = live.billingPolicy;
    if (cur?.interval !== billing.interval || cur?.intervalCount !== billing.intervalCount) {
      edits.billingPolicy = billing;
      // Delivery has to stay compatible with billing, so send both together.
      edits.deliveryPolicy = delivery ?? billing;
    }
  }
  if (!edits.deliveryPolicy && delivery) {
    const cur = live.deliveryPolicy;
    if (cur?.interval !== delivery.interval || cur?.intervalCount !== delivery.intervalCount) {
      edits.deliveryPolicy = delivery;
    }
  }

  const lineEdits: LineEdit[] = [];
  for (const line of contractLines(live)) {
    const edit: LineEdit = { lineId: line.id };

    const rawQty = formData.get(`qty:${line.id}`) as string | null;
    if (rawQty) {
      const qty = parseInt(rawQty, 10);
      if (!Number.isFinite(qty) || qty < 1) {
        return json(
          { error: `Quantity for "${line.title ?? line.id}" must be a whole number of 1 or more.` },
          { status: 400 },
        );
      }
      if (qty !== line.quantity) edit.quantity = qty;
    }

    const rawPrice = formData.get(`price:${line.id}`) as string | null;
    if (rawPrice) {
      const price = Number(rawPrice);
      if (!Number.isFinite(price) || price < 0) {
        return json(
          { error: `Price for "${line.title ?? line.id}" must be zero or more.` },
          { status: 400 },
        );
      }
      const current = Number(line.currentPrice?.amount ?? NaN);
      if (!(Math.abs(price - current) < 0.005)) edit.currentPrice = price.toFixed(2);
    }

    if (edit.quantity !== undefined || edit.currentPrice !== undefined) lineEdits.push(edit);
  }
  if (lineEdits.length > 0) edits.lines = lineEdits;

  if (Object.keys(edits).length === 0) {
    return json({ error: "Nothing changed." }, { status: 400 });
  }

  // ── Apply ─────────────────────────────────────────────────
  const result = await applyContractEdits(graphql, contractGid, edits, { commit });

  if (!result.ok) {
    return json(
      { error: `Shopify rejected the change at the ${result.stage} step: ${result.error}` },
      { status: 502 },
    );
  }

  if (!result.committed) {
    return json({ ok: true, preview: true, projected: result.projected });
  }

  // Mirror ONLY what the commit returned — never the requested values. The
  // subscription_contracts/update webhook re-runs the same write shortly after
  // and converges, because both paths share applyContractToLocal.
  await applyContractToLocal(contractGid, result.contract);

  return json({ ok: true, preview: false });
}
