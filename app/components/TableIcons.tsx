import React from "react";

// ─── Deterministic per-row accent colour (mirrors app._index.tsx) ────────────
export const ROW_COLORS = [
  "#7F77DD", "#3B82F6", "#14B8A6", "#22C55E", "#F59E0B",
  "#EC4899", "#06B6D4", "#8B5CF6", "#EF4444", "#0EA5E9",
];

function hash(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function rowColorFor(seed: string) {
  return ROW_COLORS[hash(seed) % ROW_COLORS.length];
}

// Avatar palette (deterministic by email) — mirrors app.subscriptions.tsx
export const AVATAR_PALETTE = [
  { bg: "#F4E1FD", fg: "#6A2A8C" },
  { bg: "#DEF2FB", fg: "#0F5F8A" },
  { bg: "#FBE2DE", fg: "#8C3522" },
  { bg: "#E4F4DC", fg: "#345E16" },
  { bg: "#FBEED2", fg: "#7A521A" },
  { bg: "#E6E2FA", fg: "#3C3489" },
];

export function avatarFor(seed: string) {
  return AVATAR_PALETTE[hash(seed) % AVATAR_PALETTE.length];
}

// ─── Inline SVG icons ────────────────────────────────────────────────────────
export const IconCalendar = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

export const IconBox = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
);

// ─── Tinted rounded-square icon badge ────────────────────────────────────────
export function CellIcon({
  icon,
  color,
  size = 26,
}: {
  icon: React.ReactNode;
  color: string;
  size?: number;
}) {
  return (
    <span
      style={{
        display:        "inline-flex",
        alignItems:     "center",
        justifyContent: "center",
        width:          `${size}px`,
        height:         `${size}px`,
        borderRadius:   "6px",
        background:     `${color}22`,
        color,
        flexShrink:     0,
      }}
    >
      {icon}
    </span>
  );
}

// ─── Circular avatar with initial ────────────────────────────────────────────
export function CellAvatar({ seed, label, size = 32 }: { seed: string; label?: string; size?: number }) {
  const av      = avatarFor(seed);
  const initial = (label?.[0] ?? seed?.[0] ?? "?").toUpperCase();
  return (
    <div
      style={{
        width:          `${size}px`,
        height:         `${size}px`,
        borderRadius:   "50%",
        background:     av.bg,
        color:          av.fg,
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        fontSize:       "14px",
        fontWeight:     600,
        flexShrink:     0,
      }}
    >
      {initial}
    </div>
  );
}

// ─── Leading-icon cell wrapper: icon + truncating content ────────────────────
export function IconCell({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        display:    "inline-flex",
        alignItems: "center",
        gap:        "6px",
        overflow:   "hidden",
        maxWidth:   "100%",
      }}
    >
      {icon}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {children}
      </span>
    </span>
  );
}
