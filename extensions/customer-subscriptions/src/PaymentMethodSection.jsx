// extensions/customer-subscriptions/src/PaymentMethodSection.jsx
//
// Shows which saved card THIS subscription bills — the thing Shopify's own
// Profile → Payment methods page does not tell you — and lets the customer
// point it at a different saved card or update the card's details.
//
// Card details are never entered here: "Update card details" hands off to a
// Shopify-hosted page, so no PCI data touches this extension or the app.
//
// Shared by SubscriptionDetailPage (its own section) and MyCustomPage (inline
// inside an existing subscription card) so the two cannot drift. Pass
// `wrap={false}` to drop the <s-section> chrome when the caller already
// provides it — the same shape BillingAttemptsPanel uses.

import "@shopify/ui-extensions/preact";
import { useState, useEffect } from "preact/compat";
import { appFetch } from "./appApi";

// The Intents API needs a full GID. Both call sites already pass one, but the
// component should not depend on that.
function toContractGid(raw) {
  var id = String(raw || "");
  return id.indexOf("gid://") === 0
    ? id
    : "gid://shopify/SubscriptionContract/" + id;
}

export default function PaymentMethodSection({ contractId, wrap = true }) {
  var stateArr   = useState("loading");   // loading | done | error
  var currentArr = useState(null);
  var availArr   = useState([]);
  var revokedArr = useState(false);
  var msgArr     = useState("");
  var busyArr    = useState(null);        // null | "switch" | "update-url"

  var getState   = stateArr[0];   var setState   = stateArr[1];
  var getCurrent = currentArr[0]; var setCurrent = currentArr[1];
  var getAvail   = availArr[0];   var setAvail   = availArr[1];
  var getRevoked = revokedArr[0]; var setRevoked = revokedArr[1];
  var getMsg     = msgArr[0];     var setMsg     = msgArr[1];
  var getBusy    = busyArr[0];    var setBusy    = busyArr[1];

  // Wraps content in <s-section> only when the caller isn't already one.
  function shell(children) {
    return wrap
      ? <s-section heading="Payment method">{children}</s-section>
      : children;
  }

  function load() {
    return appFetch("/payment-method?contractId=" + encodeURIComponent(contractId))
      .then(function (data) {
        setCurrent(data.current || null);
        setAvail(data.available || []);
        setRevoked(Boolean(data.currentRevoked));
        setState("done");
      })
      .catch(function (err) {
        setMsg(err && err.message ? err.message : "Could not load payment method.");
        setState("error");
      });
  }

  useEffect(function () {
    if (contractId) load();
  }, [contractId]);

  function switchTo(paymentMethodId) {
    setBusy("switch");
    setMsg("");
    appFetch("/payment-method", {
      method: "POST",
      body: JSON.stringify({ intent: "switch", contractId: contractId, paymentMethodId: paymentMethodId }),
    })
      .then(function (data) {
        setBusy(null);
        setMsg("Payment method updated.");
        setCurrent(data.current || null);
        return load();
      })
      .catch(function (err) {
        setBusy(null);
        setMsg("Error: " + (err && err.message ? err.message : "could not switch payment method"));
      });
  }

  // Opens Shopify's own payment-method replacement flow.
  //
  // This used to call the app, which called customerPaymentMethodGetUpdateUrl —
  // but Shopify supports that mutation for Shop Pay ONLY and returns
  // INVALID_INSTRUMENT for everything else, so the button could never work for
  // an ordinary card. The Intents API exists for precisely this, and replacing a
  // subscription contract's payment method is currently the only thing it does.
  async function openUpdatePage() {
    if (!shopify.intents || typeof shopify.intents.invoke !== "function") {
      setMsg(
        "Error: this store's customer accounts do not support the Intents API, " +
        "which is required to change card details here."
      );
      return;
    }

    setBusy("update-url");
    setMsg("");

    try {
      const activity = await shopify.intents.invoke({
        action: "open",
        type:   "shopify/SubscriptionContract",
        value:  toContractGid(contractId),
        data:   { field: "paymentMethod" },
      });

      // Resolves when the customer finishes, cancels, or the flow fails.
      const res = await activity.complete;
      setBusy(null);

      if (res && res.code === "ok") {
        setMsg("Payment method updated.");
        // Re-read from the server rather than assuming what changed.
        await load();
      } else if (res && res.code === "closed") {
        // Dismissed without completing — not an error, so say nothing.
      } else {
        setMsg("Error: " + ((res && res.message) || "could not update the payment method"));
      }
    } catch (err) {
      setBusy(null);
      setMsg("Error: " + (err && err.message ? err.message : "could not open the update flow"));
    }
  }

  if (getState === "loading") {
    return shell(
      <s-box padding="base">
        <s-stack block-align="center" direction="inline" gap="base">
          <s-spinner />
          <s-paragraph>Loading payment method…</s-paragraph>
        </s-stack>
      </s-box>
    );
  }

  if (getState === "error") {
    return shell(
      <s-box padding="base">
        <s-banner tone="critical">
          <s-paragraph>{getMsg}</s-paragraph>
        </s-banner>
      </s-box>
    );
  }

  return shell(
    <s-box padding="base">
      <s-stack gap="base">

        {getMsg
          ? (
            <s-banner tone={getMsg.indexOf("Error") === 0 ? "critical" : "success"}>
              <s-paragraph>{getMsg}</s-paragraph>
            </s-banner>
          )
          : null
        }

        {getRevoked
          ? (
            <s-banner tone="warning">
              <s-paragraph>
                This card can no longer be charged. Update it or choose another to
                avoid a failed payment.
              </s-paragraph>
            </s-banner>
          )
          : null
        }

        {/* Current card */}
        <s-stack gap="extraTight">
          <s-text subdued>Billing this subscription</s-text>
          {getCurrent
            ? (
              <s-text type="strong">
                {getCurrent.label}
                {getCurrent.expiryMonth && getCurrent.expiryYear
                  ? " · expires " + String(getCurrent.expiryMonth).padStart(2, "0") + "/" + getCurrent.expiryYear
                  : ""}
              </s-text>
            )
            : <s-text>No payment method on file.</s-text>
          }
        </s-stack>

        <s-divider />

        {/* Other saved cards */}
        {getAvail.length > 0
          ? (
            <s-stack gap="tight">
              <s-text subdued>Use a different saved card</s-text>
              {getAvail.map(function (card) {
                return (
                  <s-grid key={card.id} gridTemplateColumns="1fr auto" alignItems="center" gap="base">
                    <s-text>
                      {card.label}
                      {card.expiryMonth && card.expiryYear
                        ? " · expires " + String(card.expiryMonth).padStart(2, "0") + "/" + card.expiryYear
                        : ""}
                    </s-text>
                    <s-button
                      variant="secondary"
                      disabled={getBusy !== null}
                      onClick={function () { switchTo(card.id); }}
                    >
                      {getBusy === "switch" ? "Switching…" : "Use this card"}
                    </s-button>
                  </s-grid>
                );
              })}
            </s-stack>
          )
          : <s-text subdued>No other saved cards on this account.</s-text>
        }

        <s-button
          variant="secondary"
          disabled={getBusy !== null || !getCurrent}
          onClick={openUpdatePage}
        >
          {getBusy === "update-url" ? "Opening…" : "Update card details"}
        </s-button>

      </s-stack>
    </s-box>
  );
}
