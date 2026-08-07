// app/lib/app-version.server.ts
//
// Identifies which build of the app server is running.
//
// Extensions and the Node server deploy separately — `shopify app deploy`
// pushes extensions but does NOT rebuild or restart the server. That skew is
// invisible at runtime and previously surfaced as an unexplained
// "Failed to fetch" in the customer account page.
//
// Bump this together with APP_BUILD_ID in
// extensions/customer-subscriptions/src/appApi.js whenever the extension starts
// depending on new server behaviour. The extension compares the two and warns
// when they differ.
export const APP_BUILD_ID = "2026-08-06.proxy-path";
