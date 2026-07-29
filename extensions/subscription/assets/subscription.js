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
  }

  function init() {
    const widgets = document.querySelectorAll('.sub-widget');
    if (!widgets.length) return;
    widgets.forEach(initWidget);
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

