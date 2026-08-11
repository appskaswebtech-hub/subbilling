/**
 * subscription.js — theme-agnostic subscription widget
 * Works across Dawn, Horizon, and other themes: resolves the selected variant
 * from the buy form / URL and polls for changes, so subscription options only
 * show for the variants they're assigned to. AJAX add-to-cart compatible.
 */

(function () {
  'use strict';

  // ── Global variant price cache ────────────────────────────────
  // Populated from window.KAS_PRODUCT_DATA injected by Liquid
  // Falls back to ShopifyAnalytics
  function getAllVariants() {
    if (window.KAS_PRODUCT_DATA?.variants) return window.KAS_PRODUCT_DATA.variants;
    if (window.ShopifyAnalytics?.meta?.product?.variants) {
      return window.ShopifyAnalytics.meta.product.variants;
    }
    // Last resort: parse from JSON in page
    try {
      const el = document.getElementById('product-json') || document.querySelector('[data-product-json]');
      if (el) return JSON.parse(el.textContent).variants;
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

    // Arctic collapses the plan rows into one dropdown, so its options have to
    // be rebuilt whenever variant availability changes.
    refreshFrequencyRow(widget);
  }

  // ─── Arctic design ──────────────────────────────────────────
  // Arctic shows a single "Subscribe & save" row with a "Deliver every"
  // dropdown instead of one row per plan.
  //
  // The original plan rows stay in the DOM and keep their radios — those radios
  // are what drive the hidden selling_plan input and therefore the cart. The
  // dropdown only *selects* one of them. Replacing them would mean
  // reimplementing variant filtering, price sync and cart wiring.

  function availablePlanCards(widget) {
    // applyVariantPlans sets inline display:none on plans the current variant
    // cannot use, so that is the source of truth for what to offer.
    return Array.from(widget.querySelectorAll('.sub-option[data-plan-id]'))
      .filter((card) => card.style.display !== 'none');
  }

  function buildFrequencyRow(widget) {
    if (widget.querySelector('.sub-arctic')) return; // already built

    const row = document.createElement('label');
    row.className = 'sub-option sub-arctic';
    row.innerHTML =
      '<span class="sub-option__inner">' +
        '<span class="sub-option__left">' +
          '<span class="sub-option__dot"></span>' +
          '<span class="sub-arctic__body">' +
            '<span class="sub-option__title">' +
              '<span class="sub-arctic__label">Subscribe &amp; save</span>' +
              '<span class="sub-option__badge sub-arctic__badge" hidden></span>' +
            '</span>' +
            '<span class="sub-arctic__freq">Deliver every ' +
              '<select class="sub-arctic__select" aria-label="Delivery frequency"></select>' +
            '</span>' +
          '</span>' +
        '</span>' +
        '<span class="sub-option__price sub-arctic__price"></span>' +
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

    const checked  = widget.querySelector('.sub-option__radio:checked');
    const checkedId = checked && checked.value ? String(checked.value) : '';

    // Rebuild options only when the available set actually changed, so the
    // merchant's current choice is not reset on every 400ms variant poll.
    const signature = cards.map((c) => c.dataset.planId).join(',');
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
        opt.textContent = title
          ? title.textContent.replace(badge ? badge.textContent : '', '').trim()
          : card.dataset.planId;
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
    if (badgeEl) {
      if (discount > 0) {
        badgeEl.textContent = 'SAVE ' + discount + '%';
        badgeEl.hidden = false;
      } else {
        badgeEl.hidden = true;
      }
    }

    row.classList.toggle('sub-option--active', isPlanChecked);
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
  const WIDGET_BUILD = '2026-08-07.no-dropdown';

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

    // Layout variant. CSS keys off this for `default` and `ribbon`; `arctic`
    // additionally needs the dropdown row built.
    // Overrides whatever Liquid rendered. When the app is unreachable the
    // markup's design simply stands, which is why colours have always worked
    // while the design did not — colours had no such fallback to lose.
    if (s.design) {
      widget.dataset.design = s.design;
      applyDesign(widget);
    }

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
    box.textContent =
      'SUBSCRIPTION WIDGET DEBUG\n' +
      'build          : ' + report.build + '\n' +
      'settings url   : ' + report.url + '\n' +
      'settings status: ' + (report.status === null ? 'pending…' : report.status) + '\n' +
      'design (theme) : ' + (report.designFromTheme || '(none)') + '\n' +
      'design (app)   : ' + (report.design || '(none)') + '\n' +
      'design applied : ' + (w ? (w.dataset.design || '(none)') + '' : '(no widget)') + '\n' +
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
        renderDebug(report);
        if (!s.design) {
          console.log('[KAS] no widget design saved — using the theme\'s own styling.');
        }
        widgets.forEach(function (w) { applySettings(w, s); });
      })
      .catch(function (err) {
        // Styling stays an enhancement — the widget remains fully usable on the
        // theme's own accent colour. But say so rather than failing silently.
        report.status = 'unreachable';
        renderDebug(report);
        console.warn(
          '[KAS] could not reach the app for widget settings at ' + url + ' — ' +
          (err && err.message ? err.message : 'network error') +
          '. The widget falls back to the theme\'s styling.'
        );
      });
  }

  // Designs whose plan rows collapse into a single row with a frequency picker.
  const COLLAPSING_DESIGNS = ['arctic'];

  function applyDesign(widget) {
    if (COLLAPSING_DESIGNS.indexOf(widget.dataset.design) === -1) return;
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

  function formatMoney(cents) {
    if (window.Shopify?.formatMoney) return window.Shopify.formatMoney(cents);
    return detectCurrencySymbol() + (cents / 100).toFixed(2);
  }

  function detectCurrencySymbol() {
    const el = document.querySelector('.price-item, [data-product-price], .product__price');
    if (!el) return '$';
    const match = el.textContent.trim().match(/^[^0-9\s]+/);
    return match ? match[0] : '$';
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

