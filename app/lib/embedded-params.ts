// app/lib/embedded-params.ts
//
// Keeps the Shopify admin's store details (embedded, shop, host) in the app
// frame's address. The admin opens the app with them, but in-app navigation
// drops them: after a click or two the address is just /app/billing. Any full
// reload of that address then reaches authenticate.admin() without knowing the
// store, and the merchant lands on the "Log in · Shop domain" form, or, with
// `shop` but not `embedded`, on "accounts.shopify.com refused to connect".
//
// Such reloads happen: Remix reloads the page when a page file of an older
// build is gone (a deploy while the app is open), and a merchant can reload
// the frame. With the details in the address, a reload takes the library's
// normal embedded path (its session-token bounce page) back to the same page.
//
// Browser-only; app.tsx calls it after every navigation.

const STORAGE_KEY = "kas-embedded-params";

export interface EmbeddedParams { shop: string; host: string }

type Store = Pick<Storage, "getItem" | "setItem">;

// Also kept in memory: sessionStorage can be unavailable in a third-party frame.
let remembered: EmbeddedParams | null = null;

/** For tests: forget what was remembered in memory. */
export function forgetEmbedded(): void {
  remembered = null;
}

/**
 * Remembers `shop` and `host` when the address has both (the admin's first
 * load), and returns whatever is remembered for this tab.
 */
export function rememberEmbedded(search: string, storage: Store | null): EmbeddedParams | null {
  const q    = new URLSearchParams(search);
  const shop = q.get("shop");
  const host = q.get("host");
  if (shop && host) {
    remembered = { shop, host };
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(remembered)); } catch { /* storage blocked */ }
    return remembered;
  }

  if (!remembered) {
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
      if (saved && typeof saved.shop === "string" && typeof saved.host === "string" && saved.shop && saved.host) {
        remembered = { shop: saved.shop, host: saved.host };
      }
    } catch { /* storage blocked or garbled */ }
  }
  return remembered;
}

/**
 * The address with `embedded`, `shop` and `host` added where missing, keeping
 * the page's own query and hash. Null when nothing needs adding. The admin's
 * `id_token` is never added: it expires within a minute, and the bounce page
 * fetches a fresh one.
 */
export function withEmbedded(
  location: { pathname: string; search: string; hash: string },
  params: EmbeddedParams | null,
): string | null {
  if (!params) return null;
  const q = new URLSearchParams(location.search);
  if (q.get("embedded") === "1" && q.get("shop") && q.get("host")) return null;

  q.set("embedded", "1");
  if (!q.get("shop")) q.set("shop", params.shop);
  if (!q.get("host")) q.set("host", params.host);
  return `${location.pathname}?${q.toString()}${location.hash}`;
}
