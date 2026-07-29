// app/utils/mrr.ts
//
// Shared MRR maths. Kept out of the route modules so resource routes
// (e.g. the customers CSV export) can reuse it without pulling in UI code.

export const MRR_MULTIPLIER: Record<string, number> = {
  DAILY:    30,
  WEEKLY:   4.33,
  BIWEEKLY: 2.17,
  MONTHLY:  1,
  YEARLY:   0.083,
};

export function calcMrr(price: number, frequency: string): number {
  return price * (MRR_MULTIPLIER[frequency] ?? 1);
}
