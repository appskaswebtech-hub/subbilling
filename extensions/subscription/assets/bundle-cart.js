/*
 * "Show N items" dropdown under recurring bundle lines in the theme's cart
 * (app embed blocks/bundle-cart-items.liquid), like Shopify's own bundle lines.
 *
 * A recurring bundle is one subscription line, and Shopify can't group items
 * under a line with a selling plan. The bundle block (bundle-offer.js) writes
 * the items into the line's hidden `_kas_items` property as
 * [{ t: product, v: variant, q: quantity, i: image URL }] (lines added before
 * `v` existed carry "Product – Variant" in `t`); this reads them from /cart.js
 * and adds a collapsible list under that line on the cart page and in the cart
 * drawer. Checkout gets the same list from the app's checkout extension
 * (extensions/bundle-checkout-items).
 *
 * The theme draws the cart, so rows are found by Dawn's ids (CartItem-N and
 * CartDrawer-Item-N, in /cart.js order), else by the row that links to the
 * line's variant inside a cart container. Themes re-render the cart after
 * every change, so the dropdown is added again whenever a cart container
 * changes. Anything unexpected just leaves the cart as the theme drew it.
 */
(function () {
  'use strict';

  var MAX_ITEMS = 20;
  var MARK = 'kasBundleItems';   // data-kas-bundle-items on a decorated row
  var CART_CONTAINERS = [
    'cart-items', 'cart-drawer', 'cart-drawer-items', '#main-cart-items', '#CartDrawer',
    'form[action*="/cart"]', '.cart-drawer', '.drawer--cart', '[data-cart-items]',
  ].join(', ');
  // A cart line's row in common themes. Not `[class*="cart-item"]`: Dawn's
  // product name link is `.cart-item__name`.
  var ROW = [
    'tr', 'li', '.cart-item', '.cart__item', '.CartItem', '.cart-drawer__item', '.cart-drawer-item',
    '[data-cart-item]', '[data-cart-item-key]', '[data-line-item]', '[data-line-item-key]',
  ].join(', ');

  function settings() {
    var node = document.getElementById('kas-bundle-cart');
    return {
      root: String((node && node.dataset.root) || '/').replace(/\/?$/, '/'),
      hideIncludes: !node || node.dataset.hideIncludes !== 'false',
    };
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent, never innerHTML: item names are merchant text.
    if (text != null) node.textContent = text;
    return node;
  }

  /** The bundle's items from a cart line's properties, or [] if it has none or they're malformed. */
  function readItems(properties) {
    var raw = properties && properties._kas_items;
    if (!raw || typeof raw !== 'string') return [];
    try {
      var list = JSON.parse(raw);
      return Array.isArray(list)
        ? list.filter(function (x) { return x && typeof x.t === 'string' && x.t; }).slice(0, MAX_ITEMS)
        : [];
    } catch (e) {
      return [];
    }
  }

  function summaryText(open, count) {
    return (open ? 'Hide ' : 'Show ') + count + ' item' + (count === 1 ? '' : 's');
  }

  function buildDropdown(items) {
    var count = items.reduce(function (sum, item) { return sum + (item.q > 0 ? item.q : 1); }, 0);
    var details = el('details', 'kas-cart-bundle');
    var summary = el('summary', null, summaryText(false, count));
    details.appendChild(summary);

    var list = el('ul', 'kas-cart-bundle__list');
    items.forEach(function (item) {
      var row = el('li', 'kas-cart-bundle__item');
      if (typeof item.i === 'string' && /^https:\/\//.test(item.i)) {
        var img = el('img', 'kas-cart-bundle__img');
        img.src = item.i;
        img.alt = '';
        img.loading = 'lazy';
        img.width = 40;
        img.height = 40;
        row.appendChild(img);
      }
      var text = el('span', 'kas-cart-bundle__text');
      text.appendChild(el('span', null, (item.q > 0 ? item.q : 1) + ' × ' + item.t));
      if (typeof item.v === 'string' && item.v) text.appendChild(el('span', 'kas-cart-bundle__variant', item.v));
      row.appendChild(text);
      list.appendChild(row);
    });
    details.appendChild(list);

    details.addEventListener('toggle', function () {
      summary.textContent = summaryText(details.open, count);
    });
    return details;
  }

  /** Where the dropdown goes in a row: after its properties, else after the product name. */
  function place(row, dropdown) {
    var details = row.querySelector('.cart-item__details') || row;
    var anchor = details.querySelector('dl') ||
      details.querySelector('.cart-item__name') ||
      details.querySelector('a[href*="/products/"]');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(dropdown, anchor.nextSibling);
    else details.appendChild(dropdown);
  }

  /** Hides the line's visible "Includes" property, which the dropdown replaces. */
  function hideIncludes(row) {
    var terms = row.querySelectorAll('dt');
    for (var i = 0; i < terms.length; i++) {
      var dt = terms[i];
      if (!/^\s*includes\s*:?\s*$/i.test(dt.textContent || '')) continue;
      var option = dt.closest('.product-option');
      if (option && row.contains(option)) {
        option.classList.add('kas-cart-bundle__hidden');
      } else {
        dt.classList.add('kas-cart-bundle__hidden');
        if (dt.nextElementSibling && dt.nextElementSibling.tagName === 'DD') {
          dt.nextElementSibling.classList.add('kas-cart-bundle__hidden');
        }
      }
    }
  }

  function linksToVariant(link, variantId) {
    var href = link.getAttribute('href') || '';
    return new RegExp('[?&]variant=' + variantId + '(?:&|#|$)').test(href);
  }

  /**
   * [row, line] pairs for every bundle line: Dawn's row ids first, else the
   * rows inside a cart container that link to the line's variant, shared out
   * in page order among the lines with that variant.
   */
  function pairs(lines) {
    var out = [];
    var fallback = {};   // variant id → [line, …] still needing rows
    lines.forEach(function (entry) {
      var found = false;
      ['CartItem-', 'CartDrawer-Item-'].forEach(function (prefix) {
        var row = document.getElementById(prefix + (entry.index + 1));
        if (row) { out.push([row, entry]); found = true; }
      });
      if (!found) (fallback[entry.line.variant_id] = fallback[entry.line.variant_id] || []).push(entry);
    });

    Object.keys(fallback).forEach(function (variantId) {
      var rows = [];
      document.querySelectorAll(CART_CONTAINERS).forEach(function (container) {
        container.querySelectorAll('a[href*="variant="]').forEach(function (link) {
          if (!linksToVariant(link, variantId)) return;
          var row = link.parentElement && link.parentElement.closest(ROW);
          if (row && container.contains(row) && rows.indexOf(row) === -1) rows.push(row);
        });
      });
      var wanting = fallback[variantId];
      rows.forEach(function (row, i) { out.push([row, wanting[i % wanting.length]]); });
    });
    return out;
  }

  function decorate(cart, opts) {
    var lines = [];
    (cart.items || []).forEach(function (line, index) {
      var items = readItems(line.properties);
      if (items.length) lines.push({ line: line, index: index, items: items });
    });

    pairs(lines).forEach(function (pair) {
      var row = pair[0];
      var entry = pair[1];
      if (row.dataset[MARK] === entry.line.key) return;   // already done for this line
      // The row now shows another line: drop the old dropdown first.
      var old = row.querySelectorAll('.kas-cart-bundle');
      for (var i = 0; i < old.length; i++) old[i].remove();

      place(row, buildDropdown(entry.items));
      if (opts.hideIncludes) hideIncludes(row);
      row.dataset[MARK] = entry.line.key;
    });
  }

  // ── Running it ───────────────────────────────────────────────
  var opts = settings();
  var busy = false;
  var again = false;
  var timer = null;

  function hasCart() {
    return !!document.querySelector(CART_CONTAINERS);
  }

  function apply() {
    if (!hasCart()) return;
    if (busy) { again = true; return; }
    busy = true;
    fetch(opts.root + 'cart.js', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (cart) { if (cart && Array.isArray(cart.items)) decorate(cart, opts); })
      .catch(function () { /* the cart stays as the theme drew it */ })
      .then(function () {
        busy = false;
        if (again) { again = false; schedule(); }
      });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  }

  function isOurs(node) {
    return node.nodeType === 1 && node.classList && node.classList.contains('kas-cart-bundle');
  }

  // Themes re-render cart rows after every change (quantity, remove, add from
  // the drawer). React only to changes inside a cart, and not to our own nodes.
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      var target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!target || !target.closest || !target.closest(CART_CONTAINERS)) continue;
      // Inside our dropdown (its summary text flips on open/close).
      if (target.closest('.kas-cart-bundle')) continue;
      var added = Array.prototype.slice.call(m.addedNodes);
      if (added.length && added.every(isOurs)) continue;
      schedule();
      return;
    }
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    ['cart:refresh', 'cart:updated', 'cart:change'].forEach(function (name) {
      document.addEventListener(name, schedule);
    });
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
