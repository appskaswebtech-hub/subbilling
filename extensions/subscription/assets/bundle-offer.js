/*
 * Product bundles block (blocks/bundle-offer.liquid).
 *
 * Fetches the bundles this product belongs to from the app proxy, shows live
 * prices from /products/<handle>.js, and adds a whole bundle to the cart in one
 * /cart/add.js call. Every line carries the hidden `_kas_bundle` property; a
 * recurring bundle's lines also carry its selling plan, so they renew together.
 *
 * Each bundle renders in the theme chosen for it in the app:
 *   classic   stacked rows, total and a full-width button
 *   together  product tiles joined by "+" ("frequently bought together")
 *   compact   one slim bar: stacked thumbnails, savings, price, small button
 *   savings   a ribbon card with a checklist and a big price
 * The app's live preview (app/components/BundlePreview.tsx) mirrors these.
 *
 * Items where the shopper picks size/colour (variantChoice) get a dropdown of
 * the product's variants; the image, prices and cart line follow the choice.
 *
 * Every item has a tick. Shoppers can untick products they don't want; the
 * totals, savings and cart follow what stays ticked, and the bundle discount
 * applies to every ticked item.
 *
 * Build-your-own boxes (kind BOX) have their own layout whatever the theme: a
 * grid of the pool's products with − / + steppers. Nothing can be added until
 * the shopper has picked at least `minItems` units; repeats are allowed.
 *
 * Pricing follows app/config/bundle-pricing.ts, and the checkout function
 * (extensions/bundle-discount) charges the same: % off, a fixed price for the
 * full set, or tiers by the number of units. Recurring tiered bundles add every
 * line on the reached tier's own selling plan.
 */
(function () {
  'use strict';

  var BUNDLE_PROPERTY = '_kas_bundle';
  var DESIGNS = ['classic', 'together', 'compact', 'savings'];
  // Most of one product a box will take.
  var MAX_PER_ITEM = 99;

  // ── Money ────────────────────────────────────────────────────
  // Shopify's money_format, e.g. "${{amount}}" or "{{amount_with_comma_separator}} €".
  function formatMoney(cents, format) {
    var value = Number(cents) || 0;
    function withDelimiters(number, precision, thousands, decimal) {
      var parts = (number / 100).toFixed(precision).split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
      return parts.join(decimal);
    }
    return String(format || '{{amount}}').replace(/\{\{\s*(\w+)\s*\}\}/, function (_, key) {
      switch (key) {
        case 'amount_no_decimals':                      return withDelimiters(value, 0, ',', '.');
        case 'amount_with_comma_separator':             return withDelimiters(value, 2, '.', ',');
        case 'amount_no_decimals_with_comma_separator': return withDelimiters(value, 0, '.', ',');
        case 'amount_with_apostrophe_separator':        return withDelimiters(value, 2, "'", '.');
        default:                                        return withDelimiters(value, 2, ',', '.');
      }
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent, never innerHTML: bundle and product names are merchant text.
    if (text != null) node.textContent = text;
    return node;
  }

  function rootPath(root) {
    return String(root || '/').replace(/\/?$/, '/');
  }

  function isDefaultTitle(title) {
    return !title || /^default title$/i.test(title);
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  // ── Pricing ──────────────────────────────────────────────────
  // Display only: checkout applies the real discount (the selling plan for
  // recurring bundles, the bundle discount function for one-time ones).

  // Shop currency → the shopper's. A fixed bundle price is in the shop currency.
  function currencyRate() {
    var rate = Number(window.Shopify && window.Shopify.currency && window.Shopify.currency.rate);
    return rate > 0 ? rate : 1;
  }

  function isBox(bundle) {
    return bundle.kind === 'BOX';
  }

  function tiersOf(bundle) {
    return bundle.pricingMode === 'TIERED' && Array.isArray(bundle.tiers) ? bundle.tiers : [];
  }

  /** The highest tier `units` reaches, or null. Tiers come sorted from the app. */
  function tierReached(bundle, units) {
    var reached = null;
    tiersOf(bundle).forEach(function (t) { if (units >= t.minItems) reached = t; });
    return reached;
  }

  /** The percentage off for `units` units (a fixed price's matching percentage). */
  function percentAt(bundle, units) {
    if (isBox(bundle) && units < (bundle.minItems || 0)) return 0;
    if (bundle.pricingMode === 'TIERED') {
      var t = tierReached(bundle, units);
      return t ? t.percent : 0;
    }
    return bundle.discountPercent || 0;
  }

  /** The exact fixed price in the shopper's currency (cents), for one-time full sets. */
  function fixedPriceCents(bundle) {
    if (bundle.pricingMode !== 'FIXED_PRICE' || !(bundle.fixedPrice > 0) || bundle.type === 'RECURRING' || isBox(bundle)) return null;
    return Math.round(bundle.fixedPrice * currencyRate() * 100);
  }

  /**
   * What `total` cents of `units` ticked units cost with the bundle's pricing.
   * `fullSet` is true when every item of a set is ticked.
   */
  function discountedTotal(bundle, total, units, fullSet) {
    var fixed = fixedPriceCents(bundle);
    if (fixed != null && fullSet) return Math.min(total, fixed);
    return Math.round(total * (1 - percentAt(bundle, units) / 100));
  }

  /**
   * "Save 15%", "Save up to 20%", or '' when there's no discount. A fixed
   * price's matching percentage is rounded; a chosen % is shown as set.
   */
  function badgeText(bundle) {
    var tiers = tiersOf(bundle);
    if (tiers.length) return 'Save up to ' + tiers[tiers.length - 1].percent + '%';
    if (!(bundle.discountPercent > 0)) return '';
    return 'Save ' + (bundle.pricingMode === 'FIXED_PRICE' ? Math.round(bundle.discountPercent) : bundle.discountPercent) + '%';
  }

  /** The selling plan for `units` units: the reached tier's, else the bundle's. */
  function sellingPlanFor(bundle, units) {
    if (!bundle.sellingPlanId) return null;
    var t = tierReached(bundle, units);
    return (t && t.sellingPlanId) || bundle.sellingPlanId;
  }

  /**
   * The next saving within reach: "Add 1 more item to save 15%", or a partial
   * set's "Keep all 3 items for the bundle price of $80.00". `spare` is how many
   * more units could still be added (unticked set items; unlimited for a box).
   */
  function nudgeText(bundle, units, spare, allTicked, format) {
    var fixed = fixedPriceCents(bundle);
    if (fixed != null) {
      return allTicked ? '' : 'Keep all ' + plural(bundle.items.length, 'item') + ' for the bundle price of ' + formatMoney(fixed, format);
    }
    var now = percentAt(bundle, units);
    for (var more = 1; more <= Math.min(spare, 100); more++) {
      var next = percentAt(bundle, units + more);
      if (next > now) return (isBox(bundle) ? 'Pick ' : 'Add ') + plural(more, 'more item') + ' to save ' + next + '%';
    }
    return '';
  }

  // ── Data ─────────────────────────────────────────────────────
  var productCache = {};

  function loadProduct(root, handle) {
    if (!productCache[handle]) {
      productCache[handle] = fetch(rootPath(root) + 'products/' + encodeURIComponent(handle) + '.js', {
        credentials: 'same-origin',
      }).then(function (res) {
        if (!res.ok) throw new Error('product ' + handle + ' ' + res.status);
        return res.json();
      });
    }
    return productCache[handle];
  }

  function imageFor(product, variant) {
    var src = (variant && variant.featured_image && variant.featured_image.src) || product.featured_image || '';
    return src ? String(src).replace(/^\/\//, 'https://') : '';
  }

  /**
   * Each bundle item with its live product, or null if it can't be sold at all
   * (deleted product, not on the Online Store, fixed variant gone). Says which
   * and why in the console, since a set with a missing item shows as
   * unavailable.
   */
  function resolveItems(root, bundle) {
    function missing(item, why) {
      console.warn('[KAS bundles] "' + bundle.name + '": can\'t offer "' + item.title + '" (' + item.handle + '): ' + why +
        (isBox(bundle) ? '. It is left out of the box.' : '. The bundle shows as unavailable until it can.'));
      return null;
    }

    return Promise.all(bundle.items.map(function (item) {
      return loadProduct(root, item.handle).then(function (product) {
        var variants = product.variants || [];
        var byId = function (id) {
          return variants.filter(function (v) { return String(v.id) === String(id); })[0];
        };
        var preferred = byId(item.variantId);
        var selected;
        if (item.variantChoice) {
          // Start on the merchant's default if it can be bought, else the first
          // variant that can.
          selected = (preferred && preferred.available) ? preferred
            : variants.filter(function (v) { return v.available; })[0] || preferred || variants[0];
        } else {
          selected = preferred;
        }
        if (!selected) return missing(item, 'its variant ' + item.variantId + ' no longer exists');
        return {
          product:  product,
          title:    product.title || item.title,
          quantity: item.quantity,
          choice:   !!item.variantChoice && variants.length > 1,
          variants: variants,
          selected: selected,
          // Shoppers can untick items they don't want; everything starts ticked.
          included: true,
          // Filled in while rendering: what to update when the variant or the
          // tick changes. `rows` are dimmed while the item is unticked; a box's
          // `cells` are highlighted while picked, `steppers` show the count.
          nodes:    { images: [], prices: [], rows: [], toggles: [], cells: [], steppers: [] },
        };
      }).catch(function (err) {
        var notFound = err && / 404$/.test(err.message);
        return missing(item, notFound
          ? 'the product page returned 404. It is probably not published to the Online Store sales channel, or was deleted'
          : 'it could not be loaded (' + (err && err.message) + ')');
      });
    }));
  }

  // ── Shared building blocks ───────────────────────────────────
  function itemImage(item, className) {
    var img = el('img', 'kas-bundle__img' + (className ? ' ' + className : ''));
    img.alt = '';
    img.loading = 'lazy';
    var src = imageFor(item.product, item.selected);
    if (src) img.src = src;
    item.nodes.images.push(img);
    return img;
  }

  function itemPrice(item, format, className) {
    var node = el('span', className || 'kas-bundle__tile-price', formatMoney(item.selected.price, format));
    item.nodes.prices.push(node);
    return node;
  }

  /** The size/colour dropdown, or the fixed variant's name, or nothing. */
  function variantControl(item, onChange) {
    if (item.choice) {
      var select = el('select', 'kas-bundle__select');
      select.setAttribute('aria-label', 'Choose ' + item.title + ' option');
      item.variants.forEach(function (v) {
        var option = el('option', null, v.available ? v.title : v.title + ' (sold out)');
        option.value = String(v.id);
        option.disabled = !v.available;
        if (String(v.id) === String(item.selected.id)) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener('change', function () {
        var next = item.variants.filter(function (v) { return String(v.id) === select.value; })[0];
        if (!next) return;
        item.selected = next;
        onChange();
      });
      return select;
    }
    if (!isDefaultTitle(item.selected.title)) return el('div', 'kas-bundle__variant', item.selected.title);
    return null;
  }

  /**
   * The tick that keeps an item in the bundle or leaves it out. `circle` is
   * the savings card's round check.
   */
  function itemToggle(item, onChange, circle) {
    var input = el('input', 'kas-bundle__toggle' + (circle ? ' kas-bundle__toggle--circle' : ''));
    input.type = 'checkbox';
    input.checked = item.included;
    input.setAttribute('aria-label', 'Include ' + item.title);
    input.addEventListener('change', function () {
      item.included = input.checked;
      onChange();
    });
    item.nodes.toggles.push(input);
    return input;
  }

  /**
   * Everything that changes when a variant, a tick or a box count changes.
   * Prices and totals count only the ticked (or picked) items;
   * `labelFor({ ticked, all, units })` gives the button text.
   */
  function makeTotals(container, bundle, items, labelFor) {
    var format = container.dataset.moneyFormat;
    var nodes = {
      was:  el('span', 'kas-bundle__was'),
      now:  el('span', 'kas-bundle__now'),
      save: el('span', 'kas-bundle__save'),
      // Tier ladder and "Add 1 more item to save 15%"; each theme places it.
      pricing: el('div', 'kas-bundle__pricing'),
      ladder:  el('div', 'kas-bundle__ladder'),
      nudge:   el('p', 'kas-bundle__nudge'),
      saveBadge: null,
      count: null,     // the compact bar's "3 items" line
      counter: null,   // a box's "2 of 3 picked" and progress bar
    };
    nodes.pricing.appendChild(nodes.ladder);
    nodes.pricing.appendChild(nodes.nudge);

    function refresh(button) {
      var total = 0;
      var sellable = true;
      var ticked = 0;
      var units = 0;
      var spare = 0;   // units of unticked set items: what ticking could still add
      items.forEach(function (item) {
        var src = imageFor(item.product, item.selected);
        item.nodes.images.forEach(function (img) { if (src) img.src = src; });
        item.nodes.prices.forEach(function (p) { p.textContent = formatMoney(item.selected.price, format); });
        item.nodes.toggles.forEach(function (t) { t.checked = item.included; });
        item.nodes.rows.forEach(function (r) { r.classList.toggle('kas-bundle__off', !item.included); });
        item.nodes.cells.forEach(function (c) { c.classList.toggle('kas-bundle__cell--on', item.quantity > 0); });
        item.nodes.steppers.forEach(function (s) {
          s.count.textContent = String(item.quantity);
          s.minus.disabled = item.quantity <= 0;
          s.plus.disabled  = !item.selected.available || item.quantity >= MAX_PER_ITEM;
        });
        if (!item.included) {
          spare += item.quantity;
          return;
        }
        ticked += 1;
        units  += item.quantity;
        total  += item.selected.price * item.quantity;
        if (!item.selected.available) sellable = false;
      });

      var box = isBox(bundle);
      var min = box ? Math.max(1, bundle.minItems || 0) : 0;
      var short = box ? Math.max(0, min - units) : 0;
      var allTicked = ticked === items.length;

      var discounted = discountedTotal(bundle, total, units, !box && allTicked);
      var saving = total - discounted;
      nodes.was.textContent  = discounted < total ? formatMoney(total, format) : '';
      nodes.was.hidden       = !(discounted < total);
      nodes.now.textContent  = formatMoney(discounted, format);
      nodes.save.textContent = saving > 0 ? 'You save ' + formatMoney(saving, format) : '';
      if (nodes.saveBadge) {
        nodes.saveBadge.textContent = saving > 0 ? 'SAVE ' + formatMoney(saving, format) : badgeText(bundle).toUpperCase();
      }
      if (nodes.count) {
        var sub = plural(units, 'item');
        var badge = badgeText(bundle);
        if (badge) sub += ' · ' + badge;
        if (bundle.frequency) sub += ' · ' + bundle.frequency;
        nodes.count.textContent = sub;
      }

      // Tier ladder: every tier, the reached one highlighted.
      var tiers = tiersOf(bundle);
      var reached = short ? null : tierReached(bundle, units);
      nodes.ladder.textContent = '';
      nodes.ladder.hidden = !tiers.length;
      tiers.forEach(function (t) {
        var step = el('span', 'kas-bundle__tier' + (t === reached ? ' kas-bundle__tier--on' : ''), t.minItems + '+ · ' + t.percent + '% off');
        nodes.ladder.appendChild(step);
      });
      nodes.nudge.textContent = nudgeText(bundle, units, box ? Infinity : spare, allTicked, format);
      nodes.nudge.hidden = !nodes.nudge.textContent;
      nodes.pricing.hidden = nodes.ladder.hidden && nodes.nudge.hidden;

      if (nodes.counter) {
        nodes.counter.text.textContent = short
          ? units + ' of ' + min + ' picked · pick at least ' + min
          : plural(units, 'item') + ' picked ✓';
        nodes.counter.fill.style.width = Math.min(100, Math.round((units / min) * 100)) + '%';
      }

      if (button) {
        button.dataset.label = labelFor({ ticked: ticked, all: items.length, units: units });
        button.disabled = !ticked || !sellable || short > 0;
        if (!button.dataset.busy) {
          button.textContent = box && !units ? 'Pick at least ' + plural(min, 'item')
            : short ? 'Pick ' + short + ' more'
            : !ticked ? 'Select at least one item'
            : sellable ? button.dataset.label : 'Choose available options';
        }
      }
    }

    return { nodes: nodes, refresh: refresh };
  }

  function metaText(bundle) {
    if (!bundle.frequency) return '';
    var meta = bundle.frequency + ' · renews together';
    if (bundle.prepaid) meta += ". You'll get an email with a link to pay before each delivery.";
    return meta;
  }

  function makeButton(container, label) {
    var button = el('button', 'kas-bundle__button', label);
    button.type = 'button';
    button.dataset.label = label;
    return button;
  }

  /** Title and "Save 15%" / "Save up to 20%" badge. */
  function bundleHead(bundle) {
    var head = el('div', 'kas-bundle__head');
    head.appendChild(el('p', 'kas-bundle__title', bundle.name));
    var badge = badgeText(bundle);
    if (badge) head.appendChild(el('span', 'kas-bundle__badge', badge));
    return head;
  }

  /** A box item's − count + control. Picking any makes the item part of the order. */
  function itemStepper(item, onChange) {
    var wrap  = el('div', 'kas-bundle__stepper');
    var minus = el('button', 'kas-bundle__step', '−');
    var count = el('span', 'kas-bundle__step-count', '0');
    var plus  = el('button', 'kas-bundle__step', '+');
    minus.type = plus.type = 'button';
    minus.setAttribute('aria-label', 'Remove one ' + item.title);
    plus.setAttribute('aria-label', 'Add one ' + item.title);
    count.setAttribute('aria-live', 'polite');

    function set(quantity) {
      item.quantity = Math.max(0, Math.min(MAX_PER_ITEM, quantity));
      item.included = item.quantity > 0;
      onChange();
    }
    minus.addEventListener('click', function () { set(item.quantity - 1); });
    plus.addEventListener('click', function () { set(item.quantity + 1); });

    item.nodes.steppers.push({ minus: minus, count: count, plus: plus });
    wrap.appendChild(minus);
    wrap.appendChild(count);
    wrap.appendChild(plus);
    return wrap;
  }

  // ── Themes ───────────────────────────────────────────────────
  function renderClassic(ctx) {
    var card = el('div', 'kas-bundle kas-bundle--classic');
    card.appendChild(bundleHead(ctx.bundle));

    var list = el('ul', 'kas-bundle__items');
    ctx.items.forEach(function (item) {
      var row = el('li', 'kas-bundle__item');
      row.appendChild(itemToggle(item, ctx.changed));
      row.appendChild(itemImage(item));
      var name = el('div', 'kas-bundle__name');
      name.appendChild(el('div', null, item.title));
      var control = variantControl(item, ctx.changed);
      if (control) name.appendChild(control);
      row.appendChild(name);
      if (item.quantity > 1) row.appendChild(el('span', 'kas-bundle__qty', '× ' + item.quantity));
      item.nodes.rows.push(row);
      list.appendChild(row);
    });
    card.appendChild(list);

    if (ctx.meta) card.appendChild(el('p', 'kas-bundle__meta', ctx.meta));
    var total = el('div', 'kas-bundle__total');
    total.appendChild(ctx.totals.nodes.was);
    total.appendChild(ctx.totals.nodes.now);
    card.appendChild(total);
    card.appendChild(ctx.totals.nodes.pricing);
    card.appendChild(ctx.button);
    card.appendChild(ctx.error);
    return card;
  }

  function renderTogether(ctx) {
    var card = el('div', 'kas-bundle kas-bundle--together');
    card.appendChild(el('p', 'kas-bundle__title', ctx.bundle.name));

    var tiles = el('div', 'kas-bundle__tiles');
    ctx.items.forEach(function (item, idx) {
      if (idx > 0) tiles.appendChild(el('div', 'kas-bundle__plus', '+'));
      var tile = el('div', 'kas-bundle__tile');
      // The tick sits on the image's corner.
      var media = el('div', 'kas-bundle__tile-media');
      media.appendChild(itemImage(item));
      media.appendChild(itemToggle(item, ctx.changed));
      tile.appendChild(media);
      tile.appendChild(el('div', 'kas-bundle__tile-name', (item.quantity > 1 ? item.quantity + ' × ' : '') + item.title));
      tile.appendChild(itemPrice(item, ctx.format));
      var control = variantControl(item, ctx.changed);
      if (control) tile.appendChild(control);
      item.nodes.rows.push(tile);
      tiles.appendChild(tile);
    });
    card.appendChild(tiles);

    var total = el('div', 'kas-bundle__total');
    total.appendChild(el('span', 'kas-bundle__variant', 'Total price:'));
    total.appendChild(ctx.totals.nodes.was);
    total.appendChild(ctx.totals.nodes.now);
    total.appendChild(ctx.totals.nodes.save);
    card.appendChild(total);
    card.appendChild(ctx.totals.nodes.pricing);
    if (ctx.meta) card.appendChild(el('p', 'kas-bundle__meta', ctx.meta));
    card.appendChild(ctx.button);
    card.appendChild(ctx.error);
    return card;
  }

  function renderCompact(ctx) {
    var card = el('div', 'kas-bundle kas-bundle--compact');
    var bar = el('div', 'kas-bundle__bar');

    var stack = el('div', 'kas-bundle__stack');
    ctx.items.slice(0, 4).forEach(function (item) {
      var img = itemImage(item);
      item.nodes.rows.push(img);   // an unticked item's thumbnail dims
      stack.appendChild(img);
    });
    if (ctx.items.length > 4) stack.appendChild(el('div', 'kas-bundle__more', '+' + (ctx.items.length - 4)));
    bar.appendChild(stack);

    var summary = el('div', 'kas-bundle__summary');
    summary.appendChild(el('p', 'kas-bundle__title', ctx.bundle.name));
    // Filled in by refresh, since it counts the ticked items.
    ctx.totals.nodes.count = el('div', 'kas-bundle__sub');
    summary.appendChild(ctx.totals.nodes.count);
    bar.appendChild(summary);

    var prices = el('div', 'kas-bundle__price-stack');
    prices.appendChild(ctx.totals.nodes.was);
    prices.appendChild(ctx.totals.nodes.now);
    bar.appendChild(prices);
    bar.appendChild(ctx.button);
    card.appendChild(bar);
    card.appendChild(ctx.totals.nodes.pricing);

    // Ticks and options tucked away so the bar stays one line until wanted.
    var details = el('details', 'kas-bundle__options');
    details.appendChild(el('summary', null, 'Customize bundle'));
    ctx.items.forEach(function (item) {
      var row = el('div', 'kas-bundle__item');
      row.appendChild(itemToggle(item, ctx.changed));
      var name = el('div', 'kas-bundle__name');
      name.appendChild(el('div', null, (item.quantity > 1 ? item.quantity + ' × ' : '') + item.title));
      if (item.choice) name.appendChild(variantControl(item, ctx.changed));
      row.appendChild(name);
      item.nodes.rows.push(row);
      details.appendChild(row);
    });
    card.appendChild(details);
    if (ctx.bundle.prepaid) card.appendChild(el('div', 'kas-bundle__sub', "You'll pay by email link before each delivery."));
    card.appendChild(ctx.error);
    return card;
  }

  function renderSavings(ctx) {
    var card = el('div', 'kas-bundle kas-bundle--savings');
    var ribbon = el('div', 'kas-bundle__ribbon');
    ribbon.appendChild(el('p', 'kas-bundle__title', ctx.bundle.name));
    if (badgeText(ctx.bundle)) {
      var badge = el('span', 'kas-bundle__badge', badgeText(ctx.bundle).toUpperCase());
      ctx.totals.nodes.saveBadge = badge;
      ribbon.appendChild(badge);
    }
    card.appendChild(ribbon);

    var body = el('div', 'kas-bundle__body');
    var list = el('ul', 'kas-bundle__items');
    ctx.items.forEach(function (item) {
      var row = el('li', 'kas-bundle__item');
      // The card's round check is the tick itself.
      row.appendChild(itemToggle(item, ctx.changed, true));
      row.appendChild(itemImage(item));
      var name = el('div', 'kas-bundle__name');
      name.appendChild(el('div', null, (item.quantity > 1 ? item.quantity + ' × ' : '') + item.title));
      var control = variantControl(item, ctx.changed);
      if (control) name.appendChild(control);
      row.appendChild(name);
      item.nodes.rows.push(row);
      list.appendChild(row);
    });
    body.appendChild(list);

    var total = el('div', 'kas-bundle__total');
    total.appendChild(ctx.totals.nodes.now);
    total.appendChild(ctx.totals.nodes.was);
    body.appendChild(total);
    body.appendChild(ctx.totals.nodes.pricing);
    if (ctx.meta) body.appendChild(el('p', 'kas-bundle__meta', ctx.meta));
    body.appendChild(ctx.button);
    body.appendChild(ctx.error);
    card.appendChild(body);
    return card;
  }

  /**
   * Build-your-own box: the pool as a grid, every product starting at 0. The
   * shopper steps each one up; the counter and bar fill toward the minimum.
   */
  function renderBox(ctx) {
    var card = el('div', 'kas-bundle kas-bundle--box');
    card.appendChild(bundleHead(ctx.bundle));

    var progress = el('div', 'kas-bundle__progress');
    var counter  = el('div', 'kas-bundle__counter');
    var track    = el('div', 'kas-bundle__track');
    var fill     = el('div', 'kas-bundle__fill');
    track.appendChild(fill);
    progress.appendChild(counter);
    progress.appendChild(track);
    ctx.totals.nodes.counter = { text: counter, fill: fill };
    card.appendChild(progress);

    var grid = el('div', 'kas-bundle__grid');
    ctx.items.forEach(function (item) {
      item.quantity = 0;
      item.included = false;
      var cell = el('div', 'kas-bundle__cell');
      cell.appendChild(itemImage(item));
      cell.appendChild(el('div', 'kas-bundle__tile-name', item.title));
      cell.appendChild(itemPrice(item, ctx.format));
      var control = variantControl(item, ctx.changed);
      if (control) cell.appendChild(control);
      cell.appendChild(itemStepper(item, ctx.changed));
      item.nodes.cells.push(cell);
      grid.appendChild(cell);
    });
    card.appendChild(grid);

    var total = el('div', 'kas-bundle__total');
    total.appendChild(ctx.totals.nodes.was);
    total.appendChild(ctx.totals.nodes.now);
    total.appendChild(ctx.totals.nodes.save);
    card.appendChild(total);
    card.appendChild(ctx.totals.nodes.pricing);
    if (ctx.meta) card.appendChild(el('p', 'kas-bundle__meta', ctx.meta));
    card.appendChild(ctx.button);
    card.appendChild(ctx.error);
    return card;
  }

  var RENDERERS = {
    classic:  renderClassic,
    together: renderTogether,
    compact:  renderCompact,
    savings:  renderSavings,
  };

  function renderBundle(container, bundle, resolved) {
    var box = isBox(bundle);
    var items = resolved.filter(Boolean);
    // An item that can't be sold makes a set unsellable; say so rather than
    // silently adding a partial set. A box just offers what's left of its pool.
    var complete = items.length > 0 && (box || items.length === resolved.length);
    if (!complete) {
      var card = el('div', 'kas-bundle kas-bundle--classic');
      card.appendChild(el('p', 'kas-bundle__title', bundle.name));
      card.appendChild(el('p', 'kas-bundle__meta', 'This bundle is currently unavailable.'));
      return card;
    }

    var design = DESIGNS.indexOf(bundle.design) !== -1 ? bundle.design : 'classic';
    // Button text for what's ticked (a set) or picked (a box).
    var labelFor = function (state) {
      if (box) return 'Add ' + plural(state.units, 'item') + ' to cart';
      if (design === 'compact') return 'Add';
      if (design === 'together') return state.ticked === state.all ? 'Add all ' + state.all + ' to cart' : 'Add ' + state.ticked + ' to cart';
      var base = container.dataset.button || 'Add bundle to cart';
      return state.ticked === state.all ? base : 'Add ' + plural(state.ticked, 'item') + ' to cart';
    };

    var button = makeButton(container, labelFor({ ticked: items.length, all: items.length, units: 0 }));
    var error = el('p', 'kas-bundle__error');
    error.hidden = true;
    var totals = makeTotals(container, bundle, items, labelFor);

    var ctx = {
      bundle:  bundle,
      items:   items,
      format:  container.dataset.moneyFormat,
      meta:    metaText(bundle),
      totals:  totals,
      button:  button,
      error:   error,
      changed: function () { totals.refresh(button); },
    };

    var node = box ? renderBox(ctx) : RENDERERS[design](ctx);
    totals.refresh(button);
    liveBundles.push({ button: button, refresh: ctx.changed });

    button.addEventListener('click', function () {
      addBundle(container, bundle, items, button, error, ctx.changed);
    });
    return node;
  }

  // ── Add to cart ──────────────────────────────────────────────
  function addBundle(container, bundle, items, button, error, refresh) {
    button.disabled = true;
    button.dataset.busy = '1';
    button.textContent = 'Adding…';
    error.hidden = true;

    // Back to whatever the current ticks say: the shopper may have unticked
    // items while "Added ✓" was showing, so don't just re-enable the button.
    function done() {
      delete button.dataset.busy;
      refresh();
    }

    // Only what the shopper kept ticked (or picked, in a box).
    var chosen = items.filter(function (item) { return item.included && item.quantity > 0; });
    var units = chosen.reduce(function (sum, item) { return sum + item.quantity; }, 0);
    if (!chosen.length || (isBox(bundle) && units < (bundle.minItems || 1))) {
      done();
      return;
    }

    // Recurring tiered bundles: every line on the reached tier's plan.
    var plan = sellingPlanFor(bundle, units);
    var payload = {
      items: chosen.map(function (item) {
        var line = { id: Number(item.selected.id), quantity: item.quantity, properties: {} };
        line.properties[BUNDLE_PROPERTY] = bundle.id;
        if (plan) line.selling_plan = Number(plan);
        return line;
      }),
    };

    // Never leave the button on "Adding…": a request that hasn't answered in
    // 15 s is abandoned (where the browser supports that) and says so.
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 15000) : null;

    // Sent as a Blob, not a string: subscription.js wraps window.fetch and
    // rewrites string /cart/add bodies as form data, which would mangle JSON.
    fetch(rootPath(container.dataset.root) + 'cart/add.js', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      body: new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error((data && (data.description || data.message)) || 'Could not add the bundle.');
          return data;
        });
      })
      .then(function () {
        if (timer) clearTimeout(timer);
        button.textContent = 'Added ✓';

        if (container.dataset.afterAdd === 'stay') {
          refreshCartCount(container);
          document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
          setTimeout(done, 2000);
          return;
        }

        // Going to the cart. Put the button back FIRST: the browser may keep
        // this page and show it again on Back, exactly as it was left.
        setTimeout(function () {
          done();
          window.location.href = rootPath(container.dataset.root) + 'cart';
        }, 600);
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        error.textContent = err && err.name === 'AbortError'
          ? 'This is taking longer than usual. Please check your cart.'
          : (err.message || 'Could not add the bundle.');
        error.hidden = false;
        done();
      });
  }

  // Updates the header cart count on themes that render it as a section
  // (Dawn and themes built on it). Anywhere else there's nothing to update and
  // this does nothing.
  function refreshCartCount(container) {
    var bubble = document.getElementById('cart-icon-bubble');
    if (!bubble) return;
    fetch(rootPath(container.dataset.root) + '?sections=cart-icon-bubble', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (sections) {
        var html = sections && sections['cart-icon-bubble'];
        if (!html) return;
        var parsed = new DOMParser().parseFromString(html, 'text/html');
        var fresh = parsed.getElementById('cart-icon-bubble') || parsed.body.firstElementChild;
        if (fresh) bubble.innerHTML = fresh.innerHTML;
      })
      .catch(function () { /* the count just stays as it was */ });
  }

  // Bundles on this page, so a page restored from the browser's back/forward
  // cache (pressing Back after going to the cart) can put any button still
  // showing "Adding…" or "Added ✓" back to normal.
  var liveBundles = [];

  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    liveBundles.forEach(function (b) {
      if (b.button.dataset.busy) {
        delete b.button.dataset.busy;
        b.refresh();
      }
    });
  });

  // ── Where the bundles come from ──────────────────────────────
  // First choice: the copy the app stores in Shopify, rendered into
  // data-app-bundles by Liquid. No network request, and it can't be broken by
  // how the store routes the app proxy.
  //
  // Returns the bundles for this product, or null when there is no stored copy
  // yet (an app that hasn't synced), in which case the proxy is asked instead.
  function storedBundlesFor(container) {
    var doc = null;
    try { doc = JSON.parse(container.dataset.appBundles || 'null'); } catch (e) { doc = null; }
    if (!doc || typeof doc !== 'object' || !doc.bundles || typeof doc.bundles !== 'object') return null;

    var productId = String(container.dataset.productId || '');
    var list = [];
    Object.keys(doc.bundles).forEach(function (id) {
      var b = doc.bundles[id];
      if (!b || !b.active || !Array.isArray(b.items) || !b.items.length) return;
      var ids = b.showOn === 'BASE' ? b.baseProductIds : b.productIds;
      if (Array.isArray(ids) && ids.map(String).indexOf(productId) !== -1) list.push(b);
    });
    return list;
  }

  // Fallback: the app proxy. Says plainly when the store sends the request
  // somewhere that isn't this app, which otherwise looks like "no bundles".
  function proxyBundles(container) {
    // No locale prefix here, same as subscription.js's widget-settings call:
    // the app proxy lives at /apps/... on every storefront.
    var url = '/apps/subscriptions/bundles'
      + '?productId=' + encodeURIComponent(container.dataset.productId)
      + '&shop=' + encodeURIComponent(container.dataset.shop);

    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      var type = res.headers.get('content-type') || '';
      if (!res.ok || res.redirected || type.indexOf('json') === -1) {
        console.warn(
          '[KAS bundles] ' + url + ' answered ' + res.status + (res.redirected ? ' (redirected)' : '') +
          ' instead of bundle data. The store\'s app proxy is not reaching this app. Open the app\'s ' +
          'Bundles page once so it stores the bundles in Shopify, and the block will stop needing the proxy.'
        );
        return [];
      }
      return res.json().then(function (data) { return (data && data.bundles) || []; });
    });
  }

  // ── Boot ─────────────────────────────────────────────────────
  function init(container) {
    if (container.dataset.kasReady) return;
    container.dataset.kasReady = '1';

    var stored = storedBundlesFor(container);
    var source = stored ? Promise.resolve(stored) : proxyBundles(container);

    source
      .then(function (bundles) {
        if (!bundles.length) return;

        return Promise.all(bundles.map(function (b) {
          return resolveItems(container.dataset.root, b).then(function (items) {
            return { bundle: b, items: items };
          });
        })).then(function (resolved) {
          if (container.dataset.heading) {
            container.appendChild(el('p', 'kas-bundles__heading', container.dataset.heading));
          }
          resolved.forEach(function (r) {
            try {
              container.appendChild(renderBundle(container, r.bundle, r.items));
            } catch (err) {
              // One broken bundle must not take the others (or the page) down.
              console.warn('[KAS bundles] could not render bundle ' + r.bundle.id + ':', err);
            }
          });
          container.hidden = false;
        });
      })
      .catch(function (err) {
        // A product page must never break over an optional upsell.
        console.warn('[KAS bundles] could not load bundles:', err);
      });
  }

  function initAll() {
    document.querySelectorAll('.kas-bundles').forEach(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
  // Theme editor: blocks are re-rendered in place.
  document.addEventListener('shopify:section:load', initAll);
})();
