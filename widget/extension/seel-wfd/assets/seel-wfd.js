/*
 * Seel Worry-Free Delivery widget: DOM and network glue.
 *
 * Every decision lives in seel-wfd-core.js (window.SeelWfdCore). This file
 * fetches, dispatches events into the reducer, and makes the page and the
 * cart follow the resulting state.
 *
 *   cart change -> CART_CHANGED -> quote via the partner proxy
 *     -> QUOTE_RESOLVED | QUOTE_REJECTED | NO_VARIANT_MATCH | CURRENCY_UNSUPPORTED
 *     -> render(state) + one /cart/update.js call from planCartUpdate()
 *
 * Public surface: window.SeelWfd.getState(), window.SeelWfd.refresh(), and a
 * `seel-wfd:state` CustomEvent on document after every transition.
 */
(function () {
  'use strict';

  var core = window.SeelWfdCore;
  var configEl = document.getElementById('seel-wfd-config');
  if (!core || !configEl) return;

  var config;
  try {
    config = JSON.parse(configEl.textContent);
  } catch (e) {
    console.error('[seel-wfd] Config JSON is invalid.', e);
    return;
  }

  // Tags our own cart writes so the cart observer does not re-quote on them.
  var SELF_TAG = 'seel_wfd=1';
  var RECHECK_DEBOUNCE_MS = 400;
  var FALLBACK_ANCHORS = ['[name="checkout"]', '.cart__checkout', '.cart__ctas button', '#checkout'];

  var ladder = core.restrictLadder(core.parseLadder(config.netPriceLadder), config.wfdVariantIds);
  var state = core.initialState(config);
  var cart = null;
  var cycle = 0;
  var firstCycle = true;

  window.SeelWfd = {
    getState: function () {
      return state;
    },
    refresh: runCycle
  };

  if (state.name === 'hidden') {
    log('warn', 'No quote endpoint configured; widget stays hidden.');
    emit();
    return;
  }
  if (!config.serviceType) {
    dispatch({ type: 'FAILED', message: 'serviceType is required' });
    log('error', 'Block setting "Service type" is required; widget disabled.');
    return;
  }

  emit();
  installCartObserver();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runCycle);
  } else {
    runCycle();
  }

  function dispatch(event) {
    var next = core.transition(state, event);
    if (next === state) return;
    log('info', event.type, state.name, '->', next.name, next.reason || '');
    state = next;
    render();
    emit();
  }

  function emit() {
    document.dispatchEvent(new CustomEvent('seel-wfd:state', { detail: state }));
  }

  // ---------------------------------------------------------------------------
  // Quote cycle
  // ---------------------------------------------------------------------------

  async function runCycle() {
    var mine = ++cycle;
    var isCurrent = function () {
      return mine === cycle;
    };
    dispatch({ type: 'CART_CHANGED' });
    if (state.name !== 'quoting') return;

    try {
      var fresh = await fetchJson('/cart.js');
      if (!isCurrent()) return;
      cart = fresh;

      if (firstCycle) {
        firstCycle = false;
        if (cart.items.some(isWfd)) dispatch({ type: 'OPT_IN' });
      }

      if (!cart.items.some(function (item) { return !isWfd(item); })) {
        // Nothing to protect. Treated as a rejection so any WFD line is removed.
        dispatch({ type: 'QUOTE_REJECTED' });
        return await reconcile();
      }

      var source = core.selectPriceSource(ladder, cart.currency, config.pricesIncludeTax);
      if (source.reason) {
        dispatch({ type: 'CURRENCY_UNSUPPORTED' });
        return await reconcile();
      }

      var results = await Promise.all([requestQuote(cart), source.table || fetchProductTable()]);
      if (!isCurrent()) return;
      var quote = results[0];
      var table = results[1];

      if (!quote || quote.status !== 'accepted') {
        dispatch({ type: 'QUOTE_REJECTED' });
      } else {
        var variant = core.matchVariant(table, core.presentmentCents(quote, cart.currency));
        if (variant) {
          dispatch({ type: 'QUOTE_RESOLVED', quote: quote, variant: variant });
        } else {
          log('warn', 'No WFD variant matches quote', quote.price, quote.currency_code, '- hiding.');
          dispatch({ type: 'NO_VARIANT_MATCH' });
        }
      }
      await reconcile();
    } catch (err) {
      if (!isCurrent()) return;
      log('error', 'Quote cycle failed:', err);
      dispatch({ type: 'FAILED', message: err && err.message });
    }
  }

  function requestQuote(currentCart) {
    var body = core.buildQuoteRequest({
      serviceType: config.serviceType,
      adminDomain: config.adminDomain,
      cart: currentCart,
      userId: visitorId(),
      referrer: document.referrer,
      now: Date.now()
    });
    return fetchJson(config.quoteEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  async function fetchProductTable() {
    var product = await fetchJson('/products/' + encodeURIComponent(config.wfdProductHandle) + '.js');
    return core.priceTableFromVariants(product.variants);
  }

  // ---------------------------------------------------------------------------
  // Cart
  // ---------------------------------------------------------------------------

  function isWfd(item) {
    return core.isWfdLine(item, config);
  }

  /** Make the cart match the current state with at most one write. False if the write failed. */
  async function reconcile() {
    var plan = core.planCartUpdate(cart, state, config);
    if (!plan) return true;
    try {
      cart = await fetchJson('/cart/update.js?' + SELF_TAG, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan)
      });
      return true;
    } catch (err) {
      log('error', 'Cart update failed:', err);
      return false;
    }
  }

  async function onToggle(event) {
    var optIn = event.target.checked;
    dispatch({ type: optIn ? 'OPT_IN' : 'OPT_OUT' });
    setBusy(true);
    var ok = await reconcile();
    if (!ok) dispatch({ type: optIn ? 'OPT_OUT' : 'OPT_IN' });
    setBusy(false);
  }

  function installCartObserver() {
    var CART_WRITE = /\/cart\/(add|change|update|clear)(\.js)?/;
    var timer = null;

    function maybeRecheck(url) {
      if (typeof url !== 'string' || url.indexOf(SELF_TAG) !== -1) return;
      if (!CART_WRITE.test(url)) return;
      clearTimeout(timer);
      timer = setTimeout(runCycle, RECHECK_DEBOUNCE_MS);
    }

    var nativeFetch = window.fetch;
    window.fetch = function (input) {
      maybeRecheck(typeof input === 'string' ? input : input && input.url);
      return nativeFetch.apply(this, arguments);
    };

    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      maybeRecheck(String(url));
      return nativeOpen.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render() {
    var el = document.querySelector('[data-seel-wfd]');
    if (state.name === 'quoting' || state.name === 'idle') {
      if (el) el.classList.add('seel-wfd--busy');
      return;
    }
    if (state.name !== 'offered' && state.name !== 'opted_in') {
      if (el) el.parentNode.removeChild(el);
      return;
    }
    if (!el) {
      var anchor = findAnchor();
      if (!anchor) return log('warn', 'No anchor element found for the widget.');
      el = document.createElement('div');
      el.className = 'seel-wfd';
      el.setAttribute('data-seel-wfd', '');
      anchor.parentNode.insertBefore(el, anchor);
    }
    el.classList.remove('seel-wfd--busy');
    el.innerHTML = markup(state.quote, state.name === 'opted_in');
    el.querySelector('[data-seel-wfd-checkbox]').addEventListener('change', onToggle);
  }

  function markup(quote, checked) {
    var info = quote.extra_info || {};
    var i18n = config.i18n || {};
    var amount = core.presentmentCents(quote, cart && cart.currency) / 100;
    var terms = core.safeUrl(info.terms_url);
    var privacy = core.safeUrl(info.privacy_policy_url);

    return (
      '<label class="seel-wfd__row">' +
      '<input type="checkbox" class="seel-wfd__checkbox" data-seel-wfd-checkbox' + (checked ? ' checked' : '') + '>' +
      '<span class="seel-wfd__body">' +
      '<span class="seel-wfd__title">' + esc(info.widget_title || i18n.title || 'Worry-Free Delivery') + '</span>' +
      list('seel-wfd__points', info.display_widget_text) +
      '</span>' +
      '<span class="seel-wfd__price">' + esc(formatMoney(amount, cart && cart.currency)) + '</span>' +
      '</label>' +
      (info.coverage_details_text && info.coverage_details_text.length
        ? '<details class="seel-wfd__coverage"><summary>' + esc(i18n.coverage || "What's covered") + '</summary>' +
          list('seel-wfd__coverage-list', info.coverage_details_text) + '</details>'
        : '') +
      (!checked && info.opt_out_warning_text
        ? '<p class="seel-wfd__warning" data-seel-wfd-warning>' + esc(info.opt_out_warning_text) + '</p>'
        : '') +
      '<div class="seel-wfd__footer">' +
      (terms ? link(terms, i18n.learnMore || 'Learn more', 'data-seel-wfd-learn-more') : '') +
      (privacy ? link(privacy, i18n.privacy || 'Privacy policy', '') : '') +
      '<span class="seel-wfd__powered" data-seel-wfd-powered>Powered by Seel</span>' +
      '</div>'
    );
  }

  function list(className, items) {
    if (!Array.isArray(items) || !items.length) return '';
    return '<ul class="' + className + '">' + items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
  }

  function link(href, text, attr) {
    return '<a class="seel-wfd__link" href="' + esc(href) + '" target="_blank" rel="noopener" ' + attr + '>' + esc(text) + '</a>';
  }

  function setBusy(busy) {
    var el = document.querySelector('[data-seel-wfd]');
    if (!el) return;
    el.classList.toggle('seel-wfd--busy', busy);
    var box = el.querySelector('[data-seel-wfd-checkbox]');
    if (box) box.disabled = busy;
  }

  function findAnchor() {
    var selectors = config.anchorSelector ? [config.anchorSelector].concat(FALLBACK_ANCHORS) : FALLBACK_ANCHORS;
    for (var i = 0; i < selectors.length; i++) {
      var node = document.querySelector(selectors[i]);
      if (node) return node;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  async function fetchJson(url, init) {
    var res = await window.fetch(url, Object.assign({ headers: { Accept: 'application/json' } }, init));
    if (!res.ok) throw new Error(url.split('?')[0] + ' returned HTTP ' + res.status);
    return res.json();
  }

  function visitorId() {
    try {
      var key = 'seel_wfd_visitor_id';
      var id = localStorage.getItem(key);
      if (!id) {
        id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
        localStorage.setItem(key, id);
      }
      return id;
    } catch (e) {
      return '';
    }
  }

  function formatMoney(amount, currency) {
    try {
      return new Intl.NumberFormat(document.documentElement.lang || undefined, {
        style: 'currency',
        currency: currency
      }).format(amount);
    } catch (e) {
      return (currency ? currency + ' ' : '') + amount.toFixed(2);
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function log(level) {
    if (level === 'info' && !config.debug) return;
    var args = Array.prototype.slice.call(arguments, 1);
    args.unshift('[seel-wfd]');
    (console[level] || console.log).apply(console, args);
  }
})();
