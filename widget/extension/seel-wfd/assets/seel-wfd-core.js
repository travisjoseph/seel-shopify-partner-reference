/*
 * Seel Worry-Free Delivery widget: pure logic.
 *
 * No DOM, no network. Loaded before seel-wfd.js in the browser
 * (window.SeelWfdCore) and required directly by the node tests.
 */
(function (root, factory) {
  var core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  if (root) root.SeelWfdCore = core;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Seel binds the contract to the quote through this order note attribute.
  var QUOTE_ATTRIBUTE = 'wfp_quote_id';

  // Seel compares the collected premium with the quote at contract creation,
  // so only a variant within rounding distance of the quote is acceptable.
  var MATCH_TOLERANCE_CENTS = 1;

  var HIDDEN_REASONS = Object.freeze({
    QUOTE_REJECTED: 'quote_rejected',
    NO_VARIANT_MATCH: 'no_variant_match',
    CURRENCY_NOT_SUPPORTED: 'currency_not_supported',
    NO_QUOTE_ENDPOINT: 'no_quote_endpoint'
  });

  // ---------------------------------------------------------------------------
  // State machine
  //
  // State: { name, optIn, quote?, variant?, reason?, message? }
  //   idle | quoting | offered {quote, variant} | opted_in {quote, variant}
  //   | hidden {reason} | error {message}
  // `optIn` is the shopper's intent. It survives re-quotes so a cart change
  // lands back in opted_in with the new quote and variant.
  // ---------------------------------------------------------------------------

  function initialState(config) {
    var optIn = Boolean(config && config.defaultOn);
    if (!config || !config.quoteEndpoint) {
      return { name: 'hidden', optIn: optIn, reason: HIDDEN_REASONS.NO_QUOTE_ENDPOINT };
    }
    return { name: 'idle', optIn: optIn };
  }

  function hidden(state, reason) {
    return { name: 'hidden', optIn: state.optIn, reason: reason };
  }

  function quoted(optIn, quote, variant) {
    return { name: optIn ? 'opted_in' : 'offered', optIn: optIn, quote: quote, variant: variant };
  }

  function transition(state, event) {
    if (state.name === 'hidden' && state.reason === HIDDEN_REASONS.NO_QUOTE_ENDPOINT) return state;

    switch (event.type) {
      case 'CART_CHANGED':
        return { name: 'quoting', optIn: state.optIn };

      case 'QUOTE_RESOLVED':
        if (state.name !== 'quoting') return state;
        return quoted(state.optIn, event.quote, event.variant);

      case 'QUOTE_REJECTED':
        return state.name === 'quoting' ? hidden(state, HIDDEN_REASONS.QUOTE_REJECTED) : state;

      case 'NO_VARIANT_MATCH':
        return state.name === 'quoting' ? hidden(state, HIDDEN_REASONS.NO_VARIANT_MATCH) : state;

      case 'CURRENCY_UNSUPPORTED':
        return state.name === 'quoting' ? hidden(state, HIDDEN_REASONS.CURRENCY_NOT_SUPPORTED) : state;

      case 'OPT_IN':
      case 'OPT_OUT': {
        var optIn = event.type === 'OPT_IN';
        if (state.name === 'offered' || state.name === 'opted_in') {
          return quoted(optIn, state.quote, state.variant);
        }
        return Object.assign({}, state, { optIn: optIn });
      }

      case 'FAILED':
        return { name: 'error', optIn: state.optIn, message: String(event.message || 'unknown error') };

      default:
        return state;
    }
  }

  // ---------------------------------------------------------------------------
  // Net price ladder
  //
  // Metafield seel.net_price_ladder on the WFD product:
  //   { "<ISO currency>": { "<variant_id>": <net price, integer cents> } }
  // A price table is one currency's entry: { "<variant_id>": cents }.
  // ---------------------------------------------------------------------------

  function parsePriceTable(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var table = {};
    var count = 0;
    Object.keys(raw).forEach(function (variantId) {
      var cents = raw[variantId];
      if (/^\d+$/.test(variantId) && Number.isInteger(cents) && cents >= 0) {
        table[variantId] = cents;
        count++;
      }
    });
    return count ? table : null;
  }

  /** Returns { CUR: priceTable } with invalid entries dropped, or null. */
  function parseLadder(raw) {
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        return null;
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var ladder = {};
    var count = 0;
    Object.keys(raw).forEach(function (currency) {
      if (!/^[A-Z]{3}$/.test(currency)) return;
      var table = parsePriceTable(raw[currency]);
      if (table) {
        ladder[currency] = table;
        count++;
      }
    });
    return count ? ladder : null;
  }

  /** /products/{handle}.js variants (cents, presentment currency) as a price table. */
  function priceTableFromVariants(variants) {
    if (!Array.isArray(variants)) return null;
    var raw = {};
    variants.forEach(function (v) {
      if (v && v.id != null) raw[String(v.id)] = v.price;
    });
    return parsePriceTable(raw);
  }

  /**
   * Choose the price table to match quotes against for `currency`.
   *   ladder has the currency           -> { table }
   *   ladder present, currency missing  -> { reason: currency_not_supported }
   *   no ladder, prices exclude tax     -> { useProductPrices: true }
   *   no ladder, prices include tax     -> { reason: currency_not_supported }
   * Storefront prices are gross on tax-inclusive stores, so they can only
   * stand in for the net ladder when the store excludes tax.
   */
  function selectPriceSource(ladder, currency, pricesIncludeTax) {
    if (ladder) {
      return ladder[currency]
        ? { table: ladder[currency] }
        : { reason: HIDDEN_REASONS.CURRENCY_NOT_SUPPORTED };
    }
    if (pricesIncludeTax) return { reason: HIDDEN_REASONS.CURRENCY_NOT_SUPPORTED };
    return { useProductPrices: true };
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------

  /**
   * The variant id whose net price is within 1 cent of targetCents, closest
   * first, or null. Never rounds up to a higher tier and never falls back to
   * the top tier: a premium that differs from the quote fails at contract
   * creation, so hiding the widget is the correct outcome.
   */
  function matchVariant(table, targetCents) {
    if (!table || !Number.isInteger(targetCents)) return null;
    var best = null;
    var bestDistance = Infinity;
    Object.keys(table).forEach(function (variantId) {
      var distance = Math.abs(table[variantId] - targetCents);
      if (distance <= MATCH_TOLERANCE_CENTS && distance < bestDistance) {
        best = variantId;
        bestDistance = distance;
      }
    });
    return best;
  }

  /** Numeric value of a formatted amount such as "1,95 € EUR" or "$1.95". */
  function parseAmount(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    var s = value.replace(/[^0-9.,]/g, '');
    if (!s) return null;
    var dec = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    var intPart = dec === -1 ? s : s.slice(0, dec).replace(/[.,]/g, '');
    var fracPart = dec === -1 ? '' : s.slice(dec + 1);
    var n = Number(intPart + (fracPart ? '.' + fracPart : ''));
    return isFinite(n) ? n : null;
  }

  /**
   * The quoted premium in the shopper's presentment currency, integer cents.
   * display_amounts carries it on cross-currency carts; otherwise price is
   * already presentment when the quote currency equals the cart currency.
   */
  function presentmentCents(quote, cartCurrency) {
    if (!quote) return null;
    var amount = null;
    if (quote.display_amounts) amount = parseAmount(quote.display_amounts.price);
    if (amount == null) {
      if (quote.currency_code && cartCurrency && quote.currency_code !== cartCurrency) return null;
      amount = parseAmount(quote.price);
    }
    return amount == null ? null : Math.round(amount * 100);
  }

  // ---------------------------------------------------------------------------
  // Partner quote proxy request
  // ---------------------------------------------------------------------------

  /**
   * Body for POST {quoteEndpoint}. cart_info is the raw /cart.js response.
   * browser_ip is deliberately absent: the proxy sets it from the request.
   */
  function buildQuoteRequest(args) {
    return {
      type: args.serviceType,
      admin_domain: args.adminDomain,
      cart_info: args.cart,
      customer_info: {
        user_id: args.userId || '',
        referrer_url: args.referrer || '',
        timestamp_in_ms: args.now
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Cart reconciliation
  // ---------------------------------------------------------------------------

  /** WFD lines are identified by SKU; the product handle is used only if no SKU is configured. */
  function isWfdLine(item, config) {
    if (!item) return false;
    if (config.wfdSku) return item.sku === config.wfdSku;
    return Boolean(config.wfdProductHandle) && item.handle === config.wfdProductHandle;
  }

  /**
   * The single /cart/update.js payload that makes `cart` match `state`, or
   * null when nothing needs to change (or the state does not own the cart).
   *   opted_in        -> exactly one matched WFD variant at qty 1, quote id set
   *   offered, hidden -> no WFD lines, quote id cleared ("" drops the attribute)
   *   idle, quoting, error -> null (no information to act on)
   */
  function planCartUpdate(cart, state, config) {
    if (!cart || !Array.isArray(cart.items)) return null;
    var desiredVariant = null;
    var desiredQuoteId = '';
    if (state.name === 'opted_in') {
      desiredVariant = String(state.variant);
      desiredQuoteId = state.quote.quote_id;
    } else if (state.name !== 'offered' && state.name !== 'hidden') {
      return null;
    }

    var updates = {};
    var hasDesiredAtOne = false;
    cart.items.forEach(function (item) {
      if (!isWfdLine(item, config)) return;
      var id = String(item.variant_id);
      if (id === desiredVariant && item.quantity === 1 && !hasDesiredAtOne) {
        hasDesiredAtOne = true;
      } else {
        updates[id] = 0;
      }
    });
    if (desiredVariant && !hasDesiredAtOne) updates[desiredVariant] = 1;

    var attributes = {};
    var currentQuoteId = (cart.attributes && cart.attributes[QUOTE_ATTRIBUTE]) || '';
    if (currentQuoteId !== desiredQuoteId) attributes[QUOTE_ATTRIBUTE] = desiredQuoteId;

    if (!Object.keys(updates).length && !Object.keys(attributes).length) return null;
    return { updates: updates, attributes: attributes };
  }

  /** http(s) URL or null. Bare "www." hosts get https. */
  function safeUrl(url) {
    if (typeof url !== 'string') return null;
    var u = url.trim();
    if (/^www\./i.test(u)) u = 'https://' + u;
    return /^https?:\/\//i.test(u) ? u : null;
  }

  return {
    QUOTE_ATTRIBUTE: QUOTE_ATTRIBUTE,
    MATCH_TOLERANCE_CENTS: MATCH_TOLERANCE_CENTS,
    HIDDEN_REASONS: HIDDEN_REASONS,
    initialState: initialState,
    transition: transition,
    parseLadder: parseLadder,
    priceTableFromVariants: priceTableFromVariants,
    selectPriceSource: selectPriceSource,
    matchVariant: matchVariant,
    parseAmount: parseAmount,
    presentmentCents: presentmentCents,
    buildQuoteRequest: buildQuoteRequest,
    isWfdLine: isWfdLine,
    planCartUpdate: planCartUpdate,
    safeUrl: safeUrl
  };
});
