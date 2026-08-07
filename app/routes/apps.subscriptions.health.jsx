// app/routes/apps.subscriptions.health.jsx
//
// Reports which build of the app server is answering, so the extension can
// detect that it is talking to an older server than it was built against.
//
// Deliberately unauthenticated: it exposes nothing but a build string, and it
// has to work in exactly the situation where auth is failing.

import { json } from "@remix-run/node";
import { APP_BUILD_ID } from "../lib/app-version.server";
import { corsHeaders } from "../lib/customer-auth.server";

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders("GET, OPTIONS") });
  }
  return json({ ok: true, version: APP_BUILD_ID }, { headers: corsHeaders("GET, OPTIONS") });
}
