// extensions/customer-subscriptions/src/appApi.js
//
// How this extension talks to the app backend.
//
// Calls the app backend DIRECTLY, not through Shopify's app proxy.
//
// The proxy would be the tidier route, but it goes through the storefront, and
// a password-protected storefront 302s every proxy request to /password before
// it reaches the app — the redirect target carries no CORS header, so the fetch
// is blocked. Development stores created after Aug 2020 cannot turn that
// password off without a paid plan, so the proxy is unusable while developing.
// (This is why the original code called the app URL directly.)
//
// The URL is NOT hardcoded — that broke twice, first as a dead `trycloudflare`
// tunnel and then as a production URL that was stale under `shopify app dev`.
// It comes from SHOPIFY_APP_URL in the environment at bundle time: the CLI's
// extension bundler defines every identifier-named env var as `process.env.X`,
// so esbuild inlines the value. Only vars this file references are emitted, so
// no other .env secret reaches the bundle.
//
// `[app_proxy] url` in shopify.app.toml stays set to the relative path
// "/apps/subscriptions", which is correct and keeps the proxy route working on
// stores without a password page. Switching back is a one-line change here.

// Bump together with APP_BUILD_ID in app/lib/app-version.server.ts whenever the
// extension starts depending on new server behaviour. A mismatch means the app
// server is running an older build than this extension — the exact deploy skew
// that produced an unexplained "Failed to fetch".
export const APP_BUILD_ID = "2026-08-07.payment-intent";

// Route prefix on the app itself. The routes are named apps.subscriptions.*
// because they were originally reached through the proxy; the names are kept so
// the same paths work whichever way a request arrives.
const ROUTE_PREFIX = "/apps/subscriptions";

// Inlined by esbuild at bundle time: `process.env.SHOPIFY_APP_URL` is replaced
// with the literal string, so no `process` object is referenced at runtime.
//
// The reference must be the bare member expression — the define is a syntactic
// substitution, so guarding it with `typeof process !== "undefined"` would leave
// that check in the output, and `process` does not exist in the extension
// sandbox, so it would always take the empty branch. The try/catch covers the
// other case: a bundler that performs no define at all, where the reference
// throws a ReferenceError instead of being replaced.
let injectedAppUrl = "";
try {
  injectedAppUrl = process.env.SHOPIFY_APP_URL || "";
} catch {
  injectedAppUrl = "";
}
const APP_URL = String(injectedAppUrl).replace(/\/+$/, "");

function baseUrl() {
  if (!APP_URL) {
    throw new Error(
      "SHOPIFY_APP_URL was not set when this extension was built, so it does not " +
      "know where the app backend is. Set it in .env (or pass it inline: " +
      "`SHOPIFY_APP_URL=https://… shopify app deploy`) and rebuild the extension."
    );
  }
  return APP_URL;
}

let versionChecked = false;

// Fire-and-forget: warns in the console when the server is older than this
// extension. Never blocks or fails a real request.
function checkVersionOnce(base) {
  if (versionChecked) return;
  versionChecked = true;

  const url = base + ROUTE_PREFIX + "/health";
  fetch(url)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data && data.version && data.version !== APP_BUILD_ID) {
        console.warn(
          "[subscriptions] App server build (" + data.version + ") does not match this " +
          "extension (" + APP_BUILD_ID + "). The server is likely running an older build — " +
          "rebuild and restart it (`npm run build` + restart; `shopify app deploy` alone is not enough)."
        );
      }
    })
    .catch(function () {
      console.warn(
        "[subscriptions] Could not reach the app backend health check at " + url + ". " +
        "That server may be down, or running a build without the /health route."
      );
    });
}

/**
 * Calls the app backend with the customer-account session token attached.
 *
 * The server derives BOTH the shop and the customer from that token, so no
 * `shop` or `customerId` is ever sent — those were client-supplied and
 * therefore untrustworthy.
 *
 * The token travels as a `token` field (query param on GET, body field on POST)
 * rather than an Authorization header, and no Content-Type is set. That keeps
 * every request CORS-"simple", so the browser sends no OPTIONS preflight — one
 * fewer round trip and one fewer thing that can be misconfigured. Session tokens
 * are short-lived (about a minute), so carrying one in a query string is a
 * small, bounded exposure.
 */
export async function appFetch(path, options) {
  const opts   = options || {};
  const method = opts.method || "GET";
  const base   = baseUrl();
  const token  = await shopify.sessionToken.get();

  checkVersionOnce(base);

  let url  = base + ROUTE_PREFIX + path;
  let body = opts.body;

  if (method === "GET") {
    url += (url.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(token);
  } else if (body) {
    try {
      body = JSON.stringify(Object.assign(JSON.parse(body), { token: token }));
    } catch {
      // Body was not JSON — leave it alone. The request will fail auth loudly
      // rather than silently, which is the behaviour we want.
    }
  }

  let res;
  try {
    // No `headers` — a string body makes fetch send `text/plain;charset=UTF-8`,
    // a CORS-safelisted value. Adding any header here reintroduces the preflight.
    res = await fetch(url, { method: method, body: body });
  } catch (err) {
    // A rejected fetch means the request never got a response: unreachable
    // host, DNS failure, or a blocked CORS preflight. The browser's bare
    // "Failed to fetch" says none of that, so replace it with something
    // actionable.
    console.error("[subscriptions] Network failure calling " + url, err);
    throw new Error(
      "Could not reach the app backend at " + url +
      " — it may be undeployed, unreachable, or blocking this origin."
    );
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    // Non-JSON response — fall through to the status-based error below.
  }

  if (!res.ok || data.error) {
    throw new Error(data.error || "Request failed (" + res.status + ")");
  }
  return data;
}
