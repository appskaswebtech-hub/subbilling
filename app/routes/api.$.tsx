// app/routes/api.$.tsx
//
// Unmatched /api/* paths. A resource route — no default export — so Remix
// returns this response verbatim instead of rendering an HTML document, which
// is what the root splat would otherwise do to a JSON client.
//
// Real API routes are more specific than this splat and still win.

import { json } from "@remix-run/node";

const notFound = () => json({ error: "Not found" }, { status: 404 });

export const loader = notFound;
export const action = notFound;
