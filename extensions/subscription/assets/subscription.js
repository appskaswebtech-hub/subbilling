/**
 * subscription.js — theme-agnostic subscription widget
 * Works across Dawn, Horizon, and other themes: resolves the selected variant
 * from the buy form / URL and polls for changes, so subscription options only
 * show for the variants they're assigned to. AJAX add-to-cart compatible.
 */

(function () {
  'use strict';

  // ── Variant data ──────────────────────────────────────────────
  // Rendered by Liquid into script.sub-product-data, so it is correct on every
  // theme and does not depend on anything the page happens to expose.
  //
  // The fallbacks below are for block instances rendered before that script tag
  // shipped. ShopifyAnalytics in particular is undocumented and simply absent
  // when analytics is disabled or a consent app defers it — relying on it meant
  // variant price updates stopped working with no error at all.
  function getAllVariants() {
    const el = document.querySelector('script.sub-product-data');
    if (el) {
      try {
        const parsed = JSON.parse(el.textContent);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      } catch (e) {
        console.warn('[KAS] could not parse sub-product-data', e);
      }
    }

    if (window.ShopifyAnalytics?.meta?.product?.variants) {
      return window.ShopifyAnalytics.meta.product.variants;
    }
    try {
      const legacy = document.getElementById('product-json') || document.querySelector('[data-product-json]');
      if (legacy) return JSON.parse(legacy.textContent).variants;
    } catch(e) {}
    return [];
  }

  // Theme-agnostic — works on Dawn, Horizon, and other themes.
  function getSelectedVariantId() {
    // 1. The buy form's variant id input — the value actually submitted to
    //    cart, present on every theme (Dawn: #product-form, Horizon: <product-form>).
    const idInput = document.querySelector(
      'form[action*="/cart/add"] [name="id"], product-form [name="id"], form[id*="product"] [name="id"], #product-form [name="id"]'
    );
    if (idInput && idInput.value) return String(idInput.value);

    // 2. URL ?variant= (Horizon and most themes update this on selection)
    try {
      const v = new URLSearchParams(window.location.search).get('variant');
      if (v) return String(v);
    } catch (e) {}

    // 3. Legacy select / checked radio
    const sel = document.querySelector('select[name="id"]');
    if (sel && sel.value) return String(sel.value);
    const radio = document.querySelector('input[name="id"]:checked');
    if (radio && radio.value) return String(radio.value);

    // 4. Last resort: the default (first) variant, so the initial render still
    //    filters instead of showing the subscription on every variant.
    const variants = getAllVariants();
    if (variants.length) return String(variants[0].id);

    return null;
  }

  function getSelectedVariant() {
    const id       = getSelectedVariantId();
    const variants = getAllVariants();
    if (!id || !variants.length) return null;
    return variants.find(v => String(v.id) === String(id)) || null;
  }

  // ── Per-variant selling-plan allocations ──────────────────────
  // Reads the map injected by Liquid: { "<variantId>": { "<planId>": priceCents } }
  function getVariantPlanMap(widget) {
    const el = widget.querySelector('script.sub-variant-plans');
    if (!el) return null; // no map → degrade to showing all (legacy behavior)
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      console.warn('[KAS] could not parse sub-variant-plans', e);
      return null;
    }
  }

  // Show only the subscription plans allocated to the selected variant.
  // Hide the whole widget when the variant has no subscription at all.
  function applyVariantPlans(widget, variantId) {
    const map = getVariantPlanMap(widget);
    if (!map) return; // graceful fallback: leave everything visible
    if (variantId == null || variantId === '') return; // variant unknown → leave as-is
    const plans = map[String(variantId)] || {};

    let anyVisible = false;
    let activeHidden = false;

    widget.querySelectorAll('.sub-option[data-plan-id]').forEach((card) => {
      const pid   = card.dataset.planId;
      const price = plans[pid];
      const allowed = price != null;

      card.style.display = allowed ? '' : 'none';

      if (allowed) {
        anyVisible = true;
        card.dataset.planPrice = price;
        const priceEl = card.querySelector('.sub-option__price');
        if (priceEl) priceEl.textContent = formatMoney(parseInt(price, 10));
      } else if (card.classList.contains('sub-option--active')) {
        activeHidden = true;
      }
    });

    // If the previously selected plan isn't available for this variant,
    // fall back to one-time (this also clears the selling_plan input).
    if (activeHidden) {
      const oneTime = widget.querySelector('.sub-option:first-of-type .sub-option__radio');
      if (oneTime) {
        oneTime.checked = true;
        oneTime.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // No subscription for this variant → hide the entire widget.
    widget.style.display = anyVisible ? '' : 'none';

    // Collapsing designs rebuild their dropdown whenever variant availability
    // changes — and via applyDesign, because a variant change can change which
    // plan is newest and therefore which plan's design wins.
    applyDesign(widget);
  }

  // ─── Arctic design ──────────────────────────────────────────
  // Arctic shows a single "Subscribe & save" row with a "Deliver every"
  // dropdown instead of one row per plan.
  //
  // The original plan rows stay in the DOM and keep their radios — those radios
  // are what drive the hidden selling_plan input and therefore the cart. The
  // dropdown only *selects* one of them. Replacing them would mean
  // reimplementing variant filtering, price sync and cart wiring.

  // ─── Per-plan overrides ─────────────────────────────────────
  // Each plan may carry its own design and chips, delivered as a map keyed by
  // selling plan group id. A product renders ONE widget, so when several plans
  // are attached the NEWEST plan wins — the same plan the dropdown defaults to.

  function planWidgetMap(widget) {
    try {
      return JSON.parse(widget.dataset.planWidgets || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  // The app stores full GIDs while Liquid emits bare numeric ids. Normalising
  // both sides means a mismatch cannot silently resolve to "no override".
  function bareId(value) {
    const raw = String(value == null ? '' : value);
    return (raw.split('/').pop() || raw).trim();
  }

  function planOverride(widget, card) {
    if (!card) return null;
    return planWidgetMap(widget)[bareId(card.dataset.groupId)] || null;
  }

  // Design for the newest plan available on the current variant, falling back to
  // the shop-wide setting and finally to whatever Liquid rendered.
  function resolvePlanDesign(widget) {
    const newest = availablePlanCards(widget)[0];
    const own    = planOverride(widget, newest);
    if (own && own.design) return own.design;
    return widget.dataset.shopDesign || widget.dataset.design || '';
  }

  function availablePlanCards(widget) {
    // applyVariantPlans sets inline display:none on plans the current variant
    // cannot use, so that is the source of truth for what to offer.
    //
    // Newest first: Shopify's numeric resource ids increase over time, so the
    // larger id is the more recently created selling plan. Sorting here rather
    // than in Liquid keeps it correct across all the groups a product may have,
    // whose relative order the theme does not control.
    return Array.from(widget.querySelectorAll('.sub-option[data-plan-id]'))
      .filter((card) => card.style.display !== 'none')
      .sort((a, b) => (parseInt(b.dataset.planId, 10) || 0) - (parseInt(a.dataset.planId, 10) || 0));
  }

  function buildFrequencyRow(widget) {
    if (widget.querySelector('.sub-arctic')) return; // already built

    const row = document.createElement('label');
    row.className = 'sub-option sub-arctic';
    // One template serves every collapsing design. The compare price and the
    // chip row are inert under Arctic — CSS hides them unless the design is
    // `benefits` — so the shared refresh logic below stays single-branch.
    row.innerHTML =
      '<span class="sub-option__inner">' +
        '<span class="sub-option__left">' +
          '<span class="sub-option__dot"></span>' +
          '<span class="sub-arctic__body">' +
            '<span class="sub-option__title">' +
              '<span class="sub-arctic__label">Subscribe &amp; save</span>' +
              '<span class="sub-option__badge sub-arctic__badge" hidden></span>' +
            '</span>' +
            '<span class="sub-arctic__freq">' +
              '<span class="sub-arctic__freq-label">Deliver every </span>' +
              '<span class="sub-arctic__picker">' +
                '<select class="sub-arctic__select" aria-label="Delivery frequency"></select>' +
              '</span>' +
            '</span>' +
            '<span class="sub-arctic__chips"></span>' +
          '</span>' +
        '</span>' +
        '<span class="sub-option__price sub-arctic__price-wrap">' +
          '<span class="sub-arctic__compare"></span>' +
          '<span class="sub-arctic__price"></span>' +
        '</span>' +
      '</span>';

    const options = widget.querySelector('.sub-widget__options');
    if (!options) return;
    options.appendChild(row);

    const select = row.querySelector('.sub-arctic__select');

    // Changing the dropdown selects the matching hidden radio and lets the
    // existing change handlers do the real work (active state, selling_plan).
    select.addEventListener('change', () => selectArcticPlan(widget, select.value));

    // Clicking anywhere else on the row picks whatever the dropdown shows.
    row.addEventListener('click', (e) => {
      if (e.target.closest('.sub-arctic__select')) return;
      e.preventDefault();
      selectArcticPlan(widget, select.value);
    });
  }

  function selectArcticPlan(widget, planId) {
    const card  = widget.querySelector('.sub-option[data-plan-id="' + planId + '"]');
    const radio = card && card.querySelector('.sub-option__radio');
    if (!radio) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    refreshFrequencyRow(widget);
  }

  function refreshFrequencyRow(widget) {
    const row = widget.querySelector('.sub-arctic');
    if (!row) return;

    const select = row.querySelector('.sub-arctic__select');
    const cards  = availablePlanCards(widget);

    // No subscription available for this variant → nothing to offer.
    row.style.display = cards.length ? '' : 'none';
    if (!cards.length) return;

    const isBenefits = widget.dataset.design === 'benefits';

    const checked  = widget.querySelector('.sub-option__radio:checked');
    const checkedId = checked && checked.value ? String(checked.value) : '';

    // Rebuild options only when the available set actually changed, so the
    // merchant's current choice is not reset on every 400ms variant poll.
    // The design is part of the signature because the two designs label their
    // options differently and the design can change after the settings fetch.
    const signature = cards.map((c) => c.dataset.planId).join(',') + '|' + (isBenefits ? 'b' : 'a');
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.innerHTML = '';
      cards.forEach((card) => {
        const opt = document.createElement('option');
        opt.value = card.dataset.planId;
        const title = card.querySelector('.sub-option__title');
        // Strip the badge text so the option reads "Monthly Subscription",
        // not "Monthly Subscription SAVE 20%".
        const badge = title && title.querySelector('.sub-option__badge');
        const planTitle = title
          ? title.textContent.replace(badge ? badge.textContent : '', '').trim()
          : card.dataset.planId;

        // Benefits spells the cadence out in full: the plan carries its own
        // interval label ("Every 10 Weeks"), which reads as "Delivery every 10
        // weeks" — independent of whatever the merchant named the plan.
        if (isBenefits) {
          const interval = card.dataset.planOption || planTitle;
          opt.textContent = 'Delivery ' + String(interval).toLowerCase();
        } else {
          opt.textContent = planTitle;
        }
        select.appendChild(opt);
      });
    }

    // Follow the real selection when it is one of ours; otherwise keep showing
    // the dropdown's current plan so the row still reads sensibly.
    const isPlanChecked = cards.some((c) => c.dataset.planId === checkedId);
    if (isPlanChecked) select.value = checkedId;

    const shownId   = select.value || cards[0].dataset.planId;
    const shownCard = cards.find((c) => c.dataset.planId === shownId) || cards[0];

    const priceEl = row.querySelector('.sub-arctic__price');
    const price   = parseInt(shownCard.dataset.planPrice, 10);
    if (priceEl) priceEl.textContent = isNaN(price) ? '' : formatMoney(price);

    const badgeEl  = row.querySelector('.sub-arctic__badge');
    const discount = parseFloat(shownCard.dataset.discount);
    const hasDiscount = discount > 0;

    // Benefits folds the discount into the title instead of showing a separate
    // pill, so the badge stays hidden there.
    const labelEl = row.querySelector('.sub-arctic__label');
    if (labelEl) {
      labelEl.textContent = (isBenefits && hasDiscount)
        ? 'Subscribe & Save ' + discount + '%'
        : 'Subscribe & save';
    }
    if (badgeEl) {
      if (hasDiscount && !isBenefits) {
        badgeEl.textContent = 'SAVE ' + discount + '%';
        badgeEl.hidden = false;
      } else {
        badgeEl.hidden = true;
      }
    }

    // Compare-at price. Only meaningful when the plan actually costs less than
    // the one-time price — a 0% plan must not show "$40.00 $40.00".
    const compareEl = row.querySelector('.sub-arctic__compare');
    if (compareEl) {
      const base = getBasePrice();
      compareEl.textContent = (hasDiscount && !isNaN(price) && base > price)
        ? formatMoney(base)
        : '';
    }

    renderChips(widget, row, discount, shownCard);

    row.classList.toggle('sub-option--active', isPlanChecked);
  }

  // Merchant-defined benefit chips, configured in the app admin and delivered
  // with the rest of the widget settings.
  //
  // Resolved per plan: the chips belong to whichever plan the dropdown is
  // currently showing, so they change as the shopper changes frequency. A plan
  // that defines none inherits the shop-wide set.
  //
  // `{discount}` is substituted with the active plan's discount; a chip that
  // uses the token is dropped entirely when there is no discount, so no
  // storefront ever renders "0% off each order".
  // Tolerant of anything: an unset attribute, malformed JSON from a hand-edited
  // theme setting, or a non-array. Chips are decoration — a bad value must
  // never take the widget down with it.
  function readChips(raw) {
    try {
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function renderChips(widget, row, discount, shownCard) {
    const wrap = row.querySelector('.sub-arctic__chips');
    if (!wrap) return;

    // Resolution order, most specific first. The theme value is the base layer
    // because it is rendered inline by Liquid and therefore always present —
    // the app layers above it are best-effort, and a chip row that depended on
    // them alone stayed empty whenever the proxy was unreachable or the app was
    // running an older payload.
    let chips = readChips(widget.dataset.themeChips);

    const shopChips = readChips(widget.dataset.benefitChips);
    if (shopChips.length) chips = shopChips;

    const own = planOverride(widget, shownCard);
    if (own && Array.isArray(own.chips) && own.chips.length) chips = own.chips;

    const hasDiscount = discount > 0;
    const resolved = chips
      .filter((text) => typeof text === 'string' && text.trim())
      .filter((text) => hasDiscount || text.indexOf('{discount}') === -1)
      .map((text) => text.replace(/\{discount\}/g, discount).trim());

    // Signature guard for the same reason the options have one: this runs on
    // every variant poll and rebuilding the nodes each time would fight with
    // text selection and CSS transitions.
    const signature = resolved.join('\u0000');
    if (wrap.dataset.signature === signature) return;
    wrap.dataset.signature = signature;

    wrap.innerHTML = '';
    resolved.forEach((text) => {
      const chip = document.createElement('span');
      chip.className   = 'sub-arctic__chip';
      chip.textContent = text;   // textContent, never innerHTML — merchant input
      wrap.appendChild(chip);
    });
  }

  // ─── Admin widget settings ──────────────────────────────────
  // Colours, corner radius and the one-time option are configured in the app's
  // admin (Settings → Subscription widget) and stored in the app's database, so
  // the theme cannot read them at render time — they are fetched here.
  //
  // Requested through Shopify's app proxy on the shop's own domain, which keeps
  // this same-origin (no CORS, no preflight) and means the theme never has to
  // know the app's URL. A hardcoded app URL goes stale every time the dev
  // tunnel rotates.
  // Bump when changing widget behaviour. Logged on init and exposed on
  // window.__subWidget so "is the new code actually live?" is one console line
  // rather than a round of screenshots — the theme asset is CDN-cached and a
  // deploy is easy to believe has landed when it has not.
  const WIDGET_BUILD = '2026-08-18.liquid-sourced-data';

  // The payload shape this build needs. A server running older code answers 200
  // with a silently smaller object — indistinguishable from success unless we
  // check. Keep in step with WIDGET_PAYLOAD_VERSION in widget-settings.server.ts.
  const EXPECTED_PAYLOAD_VERSION = 2;

  // One storefront path — the proxy REPLACES `/apps/subscriptions` with the
  // configured proxy URL and appends the rest, so this same request lands on
  // either `<app>/apps/subscriptions/widget-settings` or `<app>/widget-settings`
  // depending on whether the deployed proxy URL kept its subpath. `shopify app
  // dev` rewrites that URL wholesale and a known CLI bug drops the subpath
  // (Shopify/cli#2905), so the app serves BOTH paths and this works either way.
  const SETTINGS_URL = '/apps/subscriptions/widget-settings';

  function applySettings(widget, s) {
    const style = widget.style;

    if (s.primaryColor) {
      style.setProperty('--sub-accent',        s.primaryColor);
      style.setProperty('--sub-border-active', s.primaryColor);
      // Alpha suffixes match the Liquid template's inline style, so the app
      // settings and the theme setting produce the same visual treatment.
      style.setProperty('--sub-accent-light',  s.primaryColor + '18');
      style.setProperty('--sub-bg-active',     s.primaryColor + '0f');
      style.setProperty('--sub-accent-ring',   s.primaryColor + '26');
      style.setProperty('--sub-shadow-active', '0 0 0 3px ' + s.primaryColor + '26');
    }

    if (s.badgeColor) style.setProperty('--sub-badge', s.badgeColor);

    if (s.borderRadius !== undefined && s.borderRadius !== null) {
      style.setProperty('--sub-radius', s.borderRadius + 'px');
    }

    // The one-time option is the first .sub-option and is the only one without
    // a plan id. Hidden rather than removed so the rest of the widget's logic
    // (which resets to one-time on variant change) still finds it.
    if (s.showOnetime === false) {
      const onetime = widget.querySelector('.sub-option:not([data-plan-id])');
      if (onetime) onetime.style.display = 'none';
    }

    // Benefit chips for the `benefits` design. Stashed before applyDesign so
    // the first render already has them and there is no second reflow.
    if (Array.isArray(s.benefitChips)) {
      widget.dataset.benefitChips = JSON.stringify(s.benefitChips);
    }

    // Per-plan design/chip overrides, keyed by selling plan group id. Must be
    // set before applyDesign, which resolves the winning design from this map.
    if (s.planWidgets && typeof s.planWidgets === 'object') {
      widget.dataset.planWidgets = JSON.stringify(s.planWidgets);
    }

    // Layout variant. CSS keys off this for `default` and `ribbon`; `arctic`
    // and `benefits` additionally need the dropdown row built.
    //
    // The shop-wide value is kept separately as the fallback resolvePlanDesign
    // uses when the newest plan sets no design of its own. Overrides whatever
    // Liquid rendered; when the app is unreachable the markup's design stands,
    // which is why colours have always worked while the design did not —
    // colours had no such fallback to lose.
    if (s.design) widget.dataset.shopDesign = s.design;
    applyDesign(widget);

    // Keep the Arctic row's selected state in step when the shopper picks
    // one-time (or any plan) through the original controls.
    widget.addEventListener('change', function (e) {
      if (e.target.classList && e.target.classList.contains('sub-option__radio')) {
        refreshFrequencyRow(widget);
      }
    });
  }

  // On-page diagnostic, shown ONLY with ?subdebug=1 in the URL so shoppers never
  // see it. Exists because "the design isn't applying" has been unanswerable
  // without devtools: this turns it into a screenshot.
  function renderDebug(report) {
    let on = false;
    try { on = new URLSearchParams(window.location.search).get('subdebug') === '1'; } catch (e) {}
    if (!on) return;

    let box = document.getElementById('sub-debug');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'sub-debug';
      box.style.cssText =
        'position:fixed;bottom:8px;right:8px;z-index:99999;max-width:min(420px,90vw);' +
        'margin:0;padding:10px 12px;background:#111;color:#0f0;font:11px/1.5 monospace;' +
        'border-radius:6px;white-space:pre-wrap;box-shadow:0 4px 16px rgba(0,0,0,.4)';
      document.body.appendChild(box);
    }

    const w = document.querySelector('.sub-widget');

    // Which plan is dictating the design, and what overrides arrived. Without
    // this, "newest plan wins" is invisible and unfalsifiable from a screenshot.
    let newestLine = '(no widget)';
    let overrideLine = '(none)';
    if (w) {
      const newest = availablePlanCards(w)[0];
      newestLine = newest
        ? 'plan ' + newest.dataset.planId + ' / group ' + bareId(newest.dataset.groupId)
        : '(no plans for this variant)';
      const keys = Object.keys(planWidgetMap(w));
      overrideLine = keys.length ? keys.join(', ') : '(none)';
    }

    box.textContent =
      'SUBSCRIPTION WIDGET DEBUG\n' +
      'build          : ' + report.build + '\n' +
      'settings url   : ' + report.url + '\n' +
      'settings status: ' + (report.status === null ? 'pending…' : report.status) + '\n' +
      'payload        : ' + (report.payload
        ? 'v' + report.payload + (report.payload < EXPECTED_PAYLOAD_VERSION
            ? ' ⚠ STALE SERVER (need v' + EXPECTED_PAYLOAD_VERSION + ')'
            : ' ok')
        : '(none yet)') + '\n' +
      'design (theme) : ' + (report.designFromTheme || '(none)') + '\n' +
      'design (shop)  : ' + (report.design || '(none)') + '\n' +
      'design applied : ' + (w ? (w.dataset.design || '(none)') + '' : '(no widget)') + '\n' +
      'newest plan    : ' + newestLine + '\n' +
      'plan overrides : ' + overrideLine + '\n' +
      'frequency row  : ' + (document.querySelector('.sub-arctic') ? 'built' : 'not built');
  }

  function loadSettings(widgets) {
    // Shopify.shop is present on storefront pages; the proxy also appends the
    // shop itself, so this is belt-and-braces for direct calls.
    const shop = (window.Shopify && window.Shopify.shop) || '';
    const url  = SETTINGS_URL + (shop ? '?shop=' + encodeURIComponent(shop) : '');

    // Diagnostics, deliberately. An earlier version swallowed every failure,
    // which made "the design isn't applying" indistinguishable from "the app
    // is unreachable" and cost several rounds of guessing. One console line
    // should now answer it.
    const report = {
      build:        WIDGET_BUILD,
      url:          url,
      status:       null,
      payload:      null,
      settings:     null,
      design:       null,
      designFromTheme: widgets[0] ? widgets[0].dataset.design || null : null,
    };
    window.__subWidget = report;
    console.log('[KAS] subscription widget build ' + WIDGET_BUILD);
    renderDebug(report);

    fetch(url, { credentials: 'same-origin' })
      .then(function (r) {
        report.status = r.status;
        renderDebug(report);
        if (!r.ok) {
          console.warn(
            '[KAS] widget settings request failed (' + r.status + ') at ' + url +
            ' — the app proxy is not reaching the app, so admin colours and the ' +
            'chosen design cannot be applied. Check the App proxy URL in the ' +
            'Partner Dashboard.'
          );
          return null;
        }
        return r.json();
      })
      .then(function (s) {
        if (!s) return;
        if (s.error) {
          console.warn('[KAS] widget settings returned an error: ' + s.error);
          return;
        }
        report.settings = s;
        report.design   = s.design;
        report.payload  = s.apiVersion || 1;
        renderDebug(report);

        // A 200 carrying an older shape is the failure mode that looks exactly
        // like success: fields simply absent, no error anywhere. Name it.
        if (report.payload < EXPECTED_PAYLOAD_VERSION) {
          console.warn(
            '[KAS] the app answered with payload v' + report.payload + ' but this widget build ' +
            'expects v' + EXPECTED_PAYLOAD_VERSION + ' — the server at this app proxy is running ' +
            'OLDER code than the theme extension. Benefit chips and per-plan designs will be ' +
            'missing until it is redeployed (and its database migrated). Falling back to the ' +
            'theme block\'s own settings.'
          );
        }

        if (!s.design) {
          console.log('[KAS] no widget design saved — using the theme\'s own styling.');
        }
        // Applied per widget inside its own try/catch. A .catch() on this chain
        // also swallows anything THROWN here, which previously reported a
        // rendering bug as "could not reach the app" and sent debugging in
        // entirely the wrong direction. One broken widget must also not stop
        // the others from being styled.
        widgets.forEach(function (w) {
          try {
            applySettings(w, s);
          } catch (err) {
            console.error(
              '[KAS] widget settings were fetched successfully but applying them failed — ' +
              'this is a bug in the widget, NOT a connectivity problem.',
              err
            );
          }
        });
      })
      .catch(function (err) {
        // Genuine request failure only: anything thrown while applying settings
        // is caught above and never reaches here.
        report.status = 'unreachable';
        renderDebug(report);
        console.warn(
          '[KAS] the widget settings request failed at ' + url + ' — ' +
          (err && err.message ? err.message : 'network error') +
          '. The widget falls back to the theme\'s styling.'
        );
      });
  }

  // Designs whose plan rows collapse into a single row with a frequency picker.
  const COLLAPSING_DESIGNS = ['arctic', 'benefits'];

  function applyDesign(widget) {
    // Resolve first: which plan is newest can change with the variant, so the
    // design is re-derived here rather than assumed fixed for the page.
    const design = resolvePlanDesign(widget);
    if (design) widget.dataset.design = design;

    if (COLLAPSING_DESIGNS.indexOf(widget.dataset.design) === -1) {
      // Non-collapsing design: the per-plan rows are the UI. Hide the collapsed
      // row if an earlier resolution built one, or it would show alongside them.
      const row = widget.querySelector('.sub-arctic');
      if (row) row.style.display = 'none';
      return;
    }
    buildFrequencyRow(widget);   // idempotent — returns early if already built
    refreshFrequencyRow(widget);
  }

  function init() {
    const widgets = document.querySelectorAll('.sub-widget');
    if (!widgets.length) return;
    widgets.forEach(initWidget);

    // Build from the markup FIRST. Liquid renders data-design at page load, so
    // the layout is right on first paint and does not depend on the app being
    // reachable — the settings fetch below can only override it.
    widgets.forEach(applyDesign);

    loadSettings(widgets);
  }

  function initWidget(widget) {
    const radios    = widget.querySelectorAll('.sub-option__radio');
    const cards     = widget.querySelectorAll('.sub-option');
    const savingsEl = widget.querySelector('.sub-widget__savings');
    if (!radios.length) return;

    radios.forEach((radio) => {
      if (radio.checked) {
        setActive(radio, cards, savingsEl);
        syncSellingPlan(radio.value);
      }
      radio.addEventListener('change', () => {
        setActive(radio, cards, savingsEl);
        updatePagePrice(radio);
        syncSellingPlan(radio.value);
      });
    });

    // Apply variant-specific plan visibility on first paint
    applyVariantPlans(widget, getSelectedVariantId());

    cards.forEach((card) => {
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'radio');
      card.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          const radio = card.querySelector('.sub-option__radio');
          if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
    });

    // ── Listen for ALL variant change patterns ─────────────────

    // 1. Custom event from Dawn or other themes
    document.addEventListener('variant:change', (e) => {
      updatePricesFromVariant(widget, e.detail?.variant);
    });

    // 2. Dawn 9+ theme:variant:change
    document.addEventListener('theme:variant:change', (e) => {
      updatePricesFromVariant(widget, e.detail?.variant);
    });

    // 3. Dawn 9+ variant-selects / variant-radios custom element
    //    These fire a native 'change' event on themselves
    const variantComponent = document.querySelector('variant-selects, variant-radios');
    if (variantComponent) {
      variantComponent.addEventListener('change', () => {
        // Small delay to let Dawn update the hidden #id input
        setTimeout(() => {
          const variant = getSelectedVariant();
          console.log('[KAS] variant-selects change, variant:', variant?.title, variant?.price);
          updatePricesFromVariant(widget, variant);
        }, 50);
      });
    }

    // 4. Direct input[name=id] or select[name=id] change
    document.addEventListener('change', (e) => {
      if (e.target.name === 'id' || e.target.dataset.productSelect) {
        setTimeout(() => {
          const variant = getSelectedVariant();
          updatePricesFromVariant(widget, variant);
        }, 50);
      }
    });

    // 5. Dawn section re-render via MutationObserver
    //    When Dawn re-renders the price block, recalculate
    const priceBlock = document.querySelector('.price, .product__price, [data-product-price]');
    if (priceBlock) {
      const observer = new MutationObserver(() => {
        setTimeout(() => {
          const variant = getSelectedVariant();
          if (variant) updatePricesFromVariant(widget, variant);
        }, 100);
      });
      observer.observe(priceBlock, { childList: true, subtree: true, characterData: true });
    }

    // ── Initial price load ─────────────────────────────────────
    setTimeout(() => {
      const variant = getSelectedVariant();
      if (variant) updatePricesFromVariant(widget, variant);
      else applyVariantPlans(widget, getSelectedVariantId());
    }, 200);
  }

  // ── Sync selling_plan ─────────────────────────────────────────
  function syncSellingPlan(planId) {
    const form = getProductForm();
    if (!form) { console.warn('[KAS] product form not found'); return; }

    document.querySelectorAll('input[name="selling_plan"]').forEach(el => el.remove());

    if (planId) {
      const hidden = document.createElement('input');
      hidden.type  = 'hidden';
      hidden.name  = 'selling_plan';
      hidden.value = planId;
      hidden.id    = 'kas-selling-plan';
      form.insertBefore(hidden, form.firstChild);
      console.log('[KAS] selling_plan set to:', planId);
    } else {
      console.log('[KAS] selling_plan cleared (one-time)');
    }
  }

  function getProductForm() {
    return document.getElementById('product-form')
        || document.querySelector('form[action*="/cart/add"]')
        || document.querySelector('[data-type="add-to-cart-form"]');
  }

  // ── Intercept fetch (Dawn AJAX) ───────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string' && url.includes('/cart/add')) {
      options = options || {};
      const activeCard  = document.querySelector('.sub-option--active');
      const activeRadio = activeCard?.querySelector('.sub-option__radio');
      const planId      = activeRadio ? activeRadio.value : '';

      if (options.body instanceof FormData) {
        options.body.delete('selling_plan');
        if (planId) {
          options.body.append('selling_plan', planId);
          console.log('[KAS] Injected selling_plan into FormData fetch:', planId);
        }
      } else if (typeof options.body === 'string') {
        const params = new URLSearchParams(options.body);
        params.delete('selling_plan');
        if (planId) {
          params.append('selling_plan', planId);
          console.log('[KAS] Injected selling_plan into string fetch:', planId);
        }
        options.body = params.toString();
      }
    }
    return _fetch.apply(this, [url, options]);
  };

  // ── Intercept XHR ─────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._kasUrl = url;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this._kasUrl && this._kasUrl.includes('/cart/add')) {
      const activeCard  = document.querySelector('.sub-option--active');
      const activeRadio = activeCard?.querySelector('.sub-option__radio');
      const planId      = activeRadio ? activeRadio.value : '';

      if (typeof body === 'string' && planId) {
        const params = new URLSearchParams(body);
        params.delete('selling_plan');
        params.append('selling_plan', planId);
        body = params.toString();
        console.log('[KAS] Injected selling_plan into XHR:', planId);
      }
    }
    return _send.call(this, body);
  };

  // ── Reset a widget to a single "One-time purchase" selection ──
  // Used on pageshow / bfcache restore, where the browser may restore the
  // previously-checked subscription radio while the one-time option is also
  // marked active — leaving two options visually selected.
  function resetToOneTime(widget) {
    const radios    = widget.querySelectorAll('.sub-option__radio');
    const cards     = widget.querySelectorAll('.sub-option');
    const savingsEl = widget.querySelector('.sub-widget__savings');
    const oneTime   = widget.querySelector('.sub-option:first-of-type .sub-option__radio');
    if (!oneTime) return;

    // Force exactly one checked radio in the group
    radios.forEach((r) => { r.checked = (r === oneTime); });
    setActive(oneTime, cards, savingsEl);
    syncSellingPlan(''); // drop any leftover selling_plan hidden input
  }

  // ── Set active card ───────────────────────────────────────────
  function setActive(radio, allCards, savingsEl) {
    allCards.forEach((c) => {
      c.classList.remove('sub-option--active');
      c.setAttribute('aria-checked', 'false');
    });
    const activeCard = radio.closest('.sub-option');
    if (activeCard) {
      activeCard.classList.add('sub-option--active');
      activeCard.setAttribute('aria-checked', 'true');
    }
    if (savingsEl) showSavings(savingsEl, radio, activeCard);
  }

  // ── Savings callout ───────────────────────────────────────────
  function showSavings(savingsEl, radio, card) {
    savingsEl.innerHTML = '';
    if (!card || radio.value === '') return;
    const discount = card.dataset.discount;
    if (!discount || parseFloat(discount) <= 0) return;
    const basePrice  = getBasePrice();
    const planPrice  = parseInt(card.dataset.planPrice || '0', 10);
    const savedCents = basePrice - planPrice;
    if (savedCents <= 0) return;
    savingsEl.innerHTML = `
      <div class="sub-widget__savings-inner">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
          <path d="m9 12 2 2 4-4"/>
        </svg>
        <span class="sub-widget__savings-text">
          You save <strong>${formatMoney(savedCents)}</strong> with this subscription!
        </span>
      </div>
    `;
  }

  // ── Update page price ─────────────────────────────────────────
  function updatePagePrice(radio) {
    const card = radio.closest('.sub-option');
    if (!card) return;
    const priceSelectors = [
      '.price__regular .price-item--regular',
      '.price .price-item--regular',
      '.product__price .price-item',
      '[data-product-price]',
      '.price-item--regular',
    ];
    let priceEl = null;
    for (const sel of priceSelectors) {
      priceEl = document.querySelector(sel);
      if (priceEl) break;
    }
    if (!priceEl) return;
    const planPrice = card.dataset.planPrice;
    priceEl.textContent = (radio.value === '' || !planPrice)
      ? formatMoney(getBasePrice())
      : formatMoney(parseInt(planPrice, 10));
  }

  // ── Update prices from variant ────────────────────────────────
  function updatePricesFromVariant(widget, variant) {
    const variantId = variant?.id ?? getSelectedVariantId();

    // Use passed variant price, or look up from selected variant
    let newPrice = null;
    if (variant?.price) {
      newPrice = variant.price;
    } else {
      const selected = getSelectedVariant();
      if (selected?.price) newPrice = selected.price;
    }

    if (newPrice) {
      console.log('[KAS] Updating prices for variant price:', newPrice);

      // Update one-time price
      const onetimeCard  = widget.querySelector('.sub-option:first-of-type');
      const onetimePrice = onetimeCard?.querySelector('.sub-option__price');
      if (onetimePrice) {
        onetimePrice.textContent       = formatMoney(newPrice);
        onetimePrice.dataset.basePrice = newPrice;
      }
      // Store base price on widget for getBasePrice() to find
      widget.dataset.basePrice = newPrice;

      // Fallback plan price (used when no per-variant allocation map exists)
      widget.querySelectorAll('.sub-option[data-plan-id]').forEach((card) => {
        const discount    = parseFloat(card.dataset.discount || '0');
        const discountAmt = Math.round((newPrice * discount) / 100);
        const subPrice    = newPrice - discountAmt;
        card.dataset.planPrice = subPrice;
        const priceEl = card.querySelector('.sub-option__price');
        if (priceEl) priceEl.textContent = formatMoney(subPrice);
      });
    } else {
      console.warn('[KAS] updatePricesFromVariant: no price found');
    }

    // Authoritative: show only the plans allocated to this variant (and use
    // their exact per-variant price), or hide the widget entirely if none.
    applyVariantPlans(widget, variantId);

    // Refresh savings callout for currently active card
    const activeCard  = widget.querySelector('.sub-option--active');
    const activeRadio = activeCard?.querySelector('.sub-option__radio');
    const savingsEl   = widget.querySelector('.sub-widget__savings');
    if (activeRadio && savingsEl) showSavings(savingsEl, activeRadio, activeCard);
  }

  // ── Helpers ───────────────────────────────────────────────────
  function getBasePrice() {
    // Check widget data attribute first (set by updatePricesFromVariant)
    const widget = document.querySelector('.sub-widget');
    if (widget?.dataset.basePrice) return parseInt(widget.dataset.basePrice, 10);

    // Check explicit data-base-price element
    const el = document.querySelector('[data-base-price]');
    if (el?.dataset.basePrice) return parseInt(el.dataset.basePrice, 10);

    // Use currently selected variant
    const variant = getSelectedVariant();
    if (variant?.price) return variant.price;

    return window.ShopifyAnalytics?.meta?.product?.variants?.[0]?.price || 0;
  }

  // Liquid renders the shop's real format onto the widget root. Preferred over
  // Shopify.money_format because plenty of themes never define that global.
  function moneyFormat() {
    const w = document.querySelector('.sub-widget');
    if (w && w.dataset.moneyFormat) return w.dataset.moneyFormat;
    const S = window.Shopify;
    return (S && (S.money_format || (S.currency && S.currency.money_format))) || '';
  }

  function shopCurrency() {
    const w = document.querySelector('.sub-widget');
    if (w && w.dataset.currency) return w.dataset.currency;
    const S = window.Shopify;
    return (S && S.currency && S.currency.active) || '';
  }

  function formatMoney(cents) {
    const fmt = moneyFormat();
    if (fmt && window.Shopify && typeof window.Shopify.formatMoney === 'function') {
      // The format is passed EXPLICITLY. Shopify's helper otherwise falls back
      // to `this.money_format`, which plenty of themes never set — their code
      // then calls .match() on undefined and throws. That throw used to abort
      // refreshFrequencyRow before it reached renderChips, so a theme without a
      // money_format silently lost its benefit chips as well as its prices.
      try { return window.Shopify.formatMoney(cents, fmt); } catch (e) { /* fall through */ }
    }

    // Intl before scraping: it gets the symbol, its position and the decimal
    // and grouping separators right for the locale. The old fallback hardcoded
    // a leading symbol and a "." decimal, so a store showing "1.234,50 €" got
    // "€1234.50" from the widget.
    const currency = shopCurrency();
    if (currency && typeof Intl !== 'undefined' && Intl.NumberFormat) {
      try {
        return new Intl.NumberFormat(document.documentElement.lang || undefined, {
          style: 'currency',
          currency: currency,
        }).format(cents / 100);
      } catch (e) { /* unknown currency code — fall through */ }
    }

    return detectCurrencySymbol() + (cents / 100).toFixed(2);
  }

  // Last resort only — reached when Liquid supplied no format and no currency
  // code, which should not happen on a normally rendered block.
  //
  // Matches a symbol at EITHER end: the leading-only regex this used to have
  // returned nothing for "10,00 €" and fell through to a hardcoded "$", so a
  // euro store rendered dollar prices.
  function detectCurrencySymbol() {
    const el = document.querySelector('.price-item, [data-product-price], .product__price');
    if (!el) return '$';
    const text = (el.textContent || '').trim();
    const lead = text.match(/^[^0-9\s]+/);
    if (lead) return lead[0];
    const trail = text.match(/[^0-9\s]+$/);
    return trail ? trail[0] : '$';
  }

  // ── Universal variant-change detection ────────────────────────
  // The theme-specific events above cover Dawn; polling the selected variant id
  // is the theme-agnostic safety net (Horizon and others update the id input /
  // URL without firing those events). Re-querying widgets each tick also
  // survives themes that re-render the product section.
  let lastVariantId = null;
  function syncAllWidgets() {
    const vid = getSelectedVariantId();
    if (vid == null || vid === lastVariantId) return;
    lastVariantId = vid;
    document.querySelectorAll('.sub-widget').forEach((widget) => {
      updatePricesFromVariant(widget, getSelectedVariant());
    });
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  setInterval(syncAllWidgets, 400);
  window.addEventListener('popstate', syncAllWidgets);

  // Normalize state when returning to the page (back button / bfcache restore).
  // Scripts don't re-run on a bfcache restore, so re-assert a single selection
  // and re-apply variant visibility here.
  window.addEventListener('pageshow', () => {
    lastVariantId = getSelectedVariantId();
    document.querySelectorAll('.sub-widget').forEach((widget) => {
      resetToOneTime(widget);
      applyVariantPlans(widget, getSelectedVariantId());
    });
  });

})();

