// extensions/customer-subscriptions/src/MyCustomPage.jsx

import '@shopify/ui-extensions/preact';
import { render, useState, useEffect } from "preact/compat";
import { appFetch } from "./appApi";
// Extension required — see the note in SubscriptionDetailPage.jsx: the CLI's
// bundler does not list ".jsx" in resolveExtensions.
import PaymentMethodSection from "./PaymentMethodSection.jsx";

const ENDPOINT = "shopify://customer-account/api/2026-04/graphql.json";

const QUERY = `{
  customer {
    id
    subscriptionContracts(first: 10) {
      edges {
        node {
          id
          status
          nextBillingDate
          lines(first: 5) {
            edges {
              node {
                id
                title
                name
                quantity
                image { url altText }
                currentPrice { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────
function normalizeStatus(status) {
  if (!status) return "UNKNOWN";
  return status.toString().toUpperCase().trim();
}

function titleCase(s) {
  if (!s) return "";
  var n = normalizeStatus(s);
  var map = { ACTIVE: "Active", PAUSED: "Paused", CANCELLED: "Cancelled", FAILED: "Failed", EXPIRED: "Expired" };
  return map[n] || (s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusTone(s) {
  var st = normalizeStatus(s);
  if (st === "ACTIVE")    return "success";
  if (st === "PAUSED")    return "warning";
  if (st === "CANCELLED") return "critical";
  if (st === "FAILED")    return "critical";
  return "info";
}

function attemptTone(s) {
  var st = normalizeStatus(s);
  if (st === "SUCCESS") return "success";
  if (st === "FAILED")  return "critical";
  if (st === "PENDING") return "warning";
  return "info";
}

// ─── BillingAttempts inline panel ─────────────────────────────
function BillingAttemptsPanel({ contractId }) {
  var loadingArr  = useState(true);
  var attemptsArr = useState([]);
  var errorArr    = useState("");

  var isLoading   = loadingArr[0];  var setLoading   = loadingArr[1];
  var getAttempts = attemptsArr[0]; var setAttempts  = attemptsArr[1];
  var getError    = errorArr[0];    var setError     = errorArr[1];

  useEffect(function() {
    if (!contractId) return;

    // No shop param: the server reads it from the session token.
    appFetch("/billing-history?contractId=" + encodeURIComponent(contractId))
      .then(function(data) {
        setLoading(false);
        setAttempts(data.attempts || []);
      })
      .catch(function(err) {
        setLoading(false);
        setError(err.message || "Failed to load");
      });
  }, [contractId]);

  if (isLoading) {
    return (
      <s-box padding="base">
        <s-stack direction="inline" gap="tight" block-align="center">
          <s-spinner />
          <s-paragraph>Loading payment history…</s-paragraph>
        </s-stack>
      </s-box>
    );
  }

  if (getError) {
    return (
      <s-box padding="base">
        <s-banner tone="warning">
          <s-paragraph>Could not load payment history: {getError}</s-paragraph>
        </s-banner>
      </s-box>
    );
  }

  if (getAttempts.length === 0) {
    return (
      <s-box padding="base">
        <s-banner tone="info">
          <s-paragraph>No payment attempts recorded yet.</s-paragraph>
        </s-banner>
      </s-box>
    );
  }

  return (
    <s-box padding="base">
      <s-stack gap="base">
        {getAttempts.map(function(attempt, idx) {
          return (
            <s-box key={attempt.id || idx}>
              <s-grid gridTemplateColumns="1fr auto" alignItems="center" gap="base">
                {/* Left: date + error message */}
                <s-stack gap="extraTight">
                  <s-text type="strong">{fmtDateTime(attempt.createdAt)}</s-text>
                  {attempt.errorMessage
                    ? <s-text subdued>{attempt.errorMessage}</s-text>
                    : null
                  }
                </s-stack>

                {/* Right: amount + status */}
                <s-stack direction="inline" gap="tight" block-align="center">
                  <s-text type="strong">
                    {attempt.currency || "USD"} {parseFloat(attempt.amount).toFixed(2)}
                  </s-text>
                  <s-badge tone={attemptTone(attempt.status)}>
                    {titleCase(attempt.status)}
                  </s-badge>
                </s-stack>
              </s-grid>

              {/* Divider between rows except last */}
              {idx < getAttempts.length - 1 ? <s-divider /> : null}
            </s-box>
          );
        })}
      </s-stack>
    </s-box>
  );
}

// ─── SubscriptionCard ─────────────────────────────────────────
function SubscriptionCard({ sub, onStatusChange }) {
  var loadingArr  = useState(null);
  var msgArr      = useState("");
  var showHistArr = useState(false);
  var showPayArr  = useState(false);

  var getLoading  = loadingArr[0];  var setLoading  = loadingArr[1];
  var getMsg      = msgArr[0];      var setMsg      = msgArr[1];
  var showHistory = showHistArr[0]; var setShowHistory = showHistArr[1];
  var showPayment = showPayArr[0];  var setShowPayment = showPayArr[1];

  async function doAction(intent) {
    setLoading(intent);
    setMsg("");

    try {
      // No shop or customerId in the body — the server takes both from the
      // verified session token.
      var data = await appFetch("/action", {
        method: "POST",
        body:   JSON.stringify({ contractId: sub.gid, intent: intent }),
      });
      setLoading(null);
      var labels = { pause: "Paused successfully.", resume: "Resumed.", cancel: "Cancelled." };
      setMsg(labels[intent] || "Done.");
      onStatusChange(sub.id, normalizeStatus(data.status));
    } catch(err) {
      setLoading(null);
      setMsg("Failed: " + (err && err.message ? err.message : "unknown"));
    }
  }

  var status = normalizeStatus(sub.status);

  var productRows = sub.lines.map(function(line) {
    return (
      <s-box key={line.id} padding-block-end="base">
        <s-grid gridTemplateColumns="56px 1fr" gap="base" alignItems="center">
          {line.imgUrl
            ? <s-image src={line.imgUrl} alt={line.imgAlt} aspectRatio="1/1" objectFit="cover" borderRadius="base" inlineSize="fill" />
            : <s-box padding="large" border-radius="base" background="surface-secondary" />
          }
          <s-stack gap="extraTight">
            <s-text type="strong">{line.title}</s-text>
            <s-paragraph>Qty: {line.qty}</s-paragraph>
            <s-paragraph>{line.currency} {(line.price * line.qty).toFixed(2)}</s-paragraph>
          </s-stack>
        </s-grid>
      </s-box>
    );
  });

  return (
    <s-section heading={"Subscription #" + sub.id} padding="none">

      {/* Status */}
      <s-box padding="base">
        <s-stack direction="inline" gap="base" block-align="center">
          <s-badge tone={statusTone(status)}>{titleCase(status)}</s-badge>
          {status === "ACTIVE" && sub.next
            ? <s-paragraph>Next billing: <s-text type="strong">{fmtDate(sub.next)}</s-text></s-paragraph>
            : null
          }
          {status === "PAUSED"
            ? <s-paragraph>Subscription is paused</s-paragraph>
            : null
          }
        </s-stack>
      </s-box>

      <s-divider />

      {/* Products */}
      <s-box padding="base">{productRows}</s-box>

      <s-divider />

      {/* Total */}
      <s-box padding="base">
        <s-stack direction="inline" block-align="center" gap="base">
          <s-paragraph>Total value</s-paragraph>
          <s-text type="strong">{sub.currency} {sub.total.toFixed(2)}</s-text>
        </s-stack>
      </s-box>

      <s-divider />

      {/* Actions */}
      <s-box padding="base">
        <s-stack gap="base">

          {getMsg
            ? (
              <s-banner tone={getMsg.startsWith("Error") || getMsg.startsWith("Failed") ? "critical" : "success"}>
                <s-paragraph>{getMsg}</s-paragraph>
              </s-banner>
            ) : null
          }

          {status !== "CANCELLED" && status !== "EXPIRED"
            ? (
              <s-stack gap="tight">
                {(status === "ACTIVE" || status === "PAUSED" || status === "FAILED")
                  ? (
                    <s-button-group>
                      {status === "ACTIVE"
                        ? (
                          <s-button
                            variant="secondary"
                            tone="default"
                            loading={getLoading === "pause"}
                            disabled={getLoading !== null}
                            onClick={function() { doAction("pause"); }}
                          >
                            Pause
                          </s-button>
                        ) : null
                      }
                      {(status === "PAUSED" || status === "FAILED")
                        ? (
                          <s-button
                            variant="primary"
                            tone="success"
                            loading={getLoading === "resume"}
                            disabled={getLoading !== null}
                            onClick={function() { doAction("resume"); }}
                          >
                            Resume
                          </s-button>
                        ) : null
                      }
                    </s-button-group>
                  ) : null
                }

                <s-button
                  variant="secondary"
                  tone="critical"
                  loading={getLoading === "cancel"}
                  disabled={getLoading !== null}
                  onClick={function() { doAction("cancel"); }}
                >
                  Cancel Subscription
                </s-button>
              </s-stack>
            ) : null
          }

          {/* Toggle payment method — loads lazily, since each open costs two
              Admin API calls and this page can list many subscriptions.
              Hidden once cancelled: there is nothing left to bill. */}
          {status !== "CANCELLED" && status !== "EXPIRED"
            ? (
              <s-button
                variant="plain"
                onClick={function() { setShowPayment(!showPayment); }}
              >
                {showPayment ? "Hide payment method ↑" : "Change payment method ↓"}
              </s-button>
            ) : null
          }

          {/* Toggle billing history */}
          <s-button
            variant="plain"
            onClick={function() { setShowHistory(!showHistory); }}
          >
            {showHistory ? "Hide payment history ↑" : "View payment history ↓"}
          </s-button>

        </s-stack>
      </s-box>

      {/* Payment method panel — shown inline when toggled */}
      {showPayment
        ? (
          <s-box>
            <s-divider />
            <s-box padding-inline="base" padding-block-start="none">
              <s-text type="strong">Payment Method</s-text>
            </s-box>
            <PaymentMethodSection contractId={sub.gid} wrap={false} />
          </s-box>
        ) : null
      }

      {/* Billing attempts panel — shown inline when toggled */}
      {showHistory
        ? (
          <s-box>
            <s-divider />
            <s-box padding-inline="base" padding-block-start="none">
              <s-text type="strong">Payment History</s-text>
            </s-box>
            <BillingAttemptsPanel contractId={sub.id} />
          </s-box>
        ) : null
      }

    </s-section>
  );
}

// ─── Main Extension ───────────────────────────────────────────
function Extension() {
  var stateArr    = useState("loading");
  var subsArr     = useState([]);
  var msgArr      = useState("");
  var customerArr = useState(null);

  var getState    = stateArr[0];    var setState    = stateArr[1];
  var getSubs     = subsArr[0];     var setSubs     = subsArr[1];
  var getMsg      = msgArr[0];      var setMsg      = msgArr[1];
  var getCustomer = customerArr[0]; var setCustomer = customerArr[1];

  useEffect(function() {
    fetch(ENDPOINT, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ query: QUERY }),
    })
    .then(function(res) { return res.json(); })
    .then(function(json) {
      if (json.errors && json.errors.length) {
        setMsg(json.errors[0].message);
        setState("error");
        return;
      }
      var customer = json.data && json.data.customer;
      if (!customer) { setState("empty"); return; }
      setCustomer(customer.id);
      var edges = (customer.subscriptionContracts && customer.subscriptionContracts.edges) || [];
      if (!edges.length) { setState("empty"); return; }
      var shaped = edges.map(function(e) {
        var node      = e.node;
        var lineEdges = node.lines.edges;
        var total     = 0;
        var currency  = "USD";
        var lines     = lineEdges.map(function(le) {
          var l     = le.node;
          var price = parseFloat(l.currentPrice.amount);
          currency  = l.currentPrice.currencyCode;
          total    += price * (l.quantity || 1);
          return {
            id:       l.id,
            title:    l.name || l.title,
            qty:      l.quantity || 1,
            price:    price,
            currency: l.currentPrice.currencyCode,
            imgUrl:   l.image ? l.image.url : null,
            imgAlt:   l.image ? (l.image.altText || l.title) : l.title,
          };
        });
        return {
          id:       node.id.split("/").pop(),
          gid:      node.id,
          status:   normalizeStatus(node.status),
          next:     node.nextBillingDate,
          total:    total,
          currency: currency,
          lines:    lines,
        };
      });
      setSubs(shaped);
      setState("done");
    })
    .catch(function(err) {
      setMsg(err && err.message ? err.message : "fetch failed");
      setState("error");
    });
  }, []);

  function handleStatusChange(contractId, newStatus) {
    setSubs(function(prev) {
      return prev.map(function(s) {
        return s.id === contractId
          ? Object.assign({}, s, { status: normalizeStatus(newStatus) })
          : s;
      });
    });
  }

  if (getState === "loading") {
    return <s-page heading="My Subscriptions"><s-section><s-spinner /></s-section></s-page>;
  }
  if (getState === "error") {
    return <s-page heading="My Subscriptions"><s-section><s-banner tone="critical"><s-paragraph>{getMsg}</s-paragraph></s-banner></s-section></s-page>;
  }
  if (getState === "empty" || getSubs.length === 0) {
    return <s-page heading="My Subscriptions"><s-section><s-banner tone="info"><s-paragraph>You have no active subscriptions.</s-paragraph></s-banner></s-section></s-page>;
  }

  return (
    <s-page heading="My Subscriptions">
      <s-stack gap="base">
        {getSubs.map(function(sub) {
          return (
            <SubscriptionCard
              key={sub.id}
              sub={sub}
              onStatusChange={handleStatusChange}
            />
          );
        })}
      </s-stack>
    </s-page>
  );
}

export default function() {
  render(<Extension />, document.body);
}
