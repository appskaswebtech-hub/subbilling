// app/config/theme.ts
//
// The admin app's look, defined once: the brand gradients and the destructive
// button style for pages that style their own <button>s inline. The page
// backdrop and Polaris components get the same look from app/styles/theme.css;
// keep the two in step.

import type { CSSProperties } from "react";

/** Primary buttons and accents: cyan through blue to magenta. */
export const BRAND_GRADIENT = "linear-gradient(90deg, #0EA5F5 0%, #3D5AFE 45%, #E81CD0 100%)";
/** A pale tint of the brand gradient, for quiet buttons. */
export const SOFT_GRADIENT  = "linear-gradient(90deg, #DCEEFD 0%, #E4E2FC 50%, #FADDF4 100%)";

/** Destructive actions: a red outline pill. Spread after the button's own style. */
export const btnDanger: CSSProperties = {
  background:   "transparent",
  color:        "#E03E3E",
  border:       "1px solid #E03E3E",
  borderRadius: 999,
  fontWeight:   600,
  cursor:       "pointer",
};
