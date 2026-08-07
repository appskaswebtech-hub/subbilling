// app/routes/$.tsx
//
// Root splat — matches only paths no other route claims, so /app/*, /webhooks*
// and /api/* are unaffected.
//
// Without this, an unmatched URL falls through to Remix's built-in error page:
// bare, unstyled, and rendered inside the Shopify admin frame. That is what a
// merchant saw when the admin deep-linked to a path this app doesn't serve.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link } from "@remix-run/react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Unmatched /api/* is handled by the api.$ resource route, which can return
  // raw JSON — a route with a component always renders HTML for a document
  // request, whatever its loader returns.

  // A shop param means the request came from the Shopify admin, so this is
  // most likely a deep link to a path we don't serve. Send it to the app home
  // rather than a dead end, keeping the embedded session params intact.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return json(null, { status: 404 });
};

// This route sits outside the /app layout, so Polaris is not available here.
export default function NotFound() {
  return (
    <div
      style={{
        minHeight:      "100vh",
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        justifyContent: "center",
        gap:            "12px",
        padding:        "24px",
        textAlign:      "center",
        fontFamily:     "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color:          "#202223",
      }}
    >
      <p style={{ margin: 0, fontSize: "13px", fontWeight: 600, letterSpacing: "0.04em", color: "#6D7175" }}>
        404
      </p>
      <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>
        Page not found
      </h1>
      <p style={{ margin: 0, fontSize: "14px", color: "#6D7175", maxWidth: "42ch" }}>
        The page you're looking for doesn't exist or may have moved.
      </p>
      <Link
        to="/app"
        style={{
          marginTop:    "8px",
          fontSize:     "13px",
          fontWeight:   500,
          padding:      "8px 16px",
          borderRadius: "8px",
          border:       "1px solid #8A8A8A",
          color:        "#202223",
          textDecoration: "none",
        }}
      >
        Back to Smart Subscriptions
      </Link>
    </div>
  );
}
