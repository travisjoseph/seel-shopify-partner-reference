# Storefront widget

A Shopify theme app extension that offers Seel Worry-Free Delivery (WFD) in the cart. It quotes the cart through your app's quote proxy, shows the offer, and on opt-in adds the matching WFD variant to the cart and writes the quote id to a cart attribute. Shopify copies cart attributes to the order as `note_attributes`, and Seel binds the contract to the quote through that attribute.

The API calls the program WFP (Worry-Free Purchase), so API fields say `wfp` where the product is sold as Worry-Free Delivery.

## Layout

| Path | What it is |
|---|---|
| `extension/seel-wfd/blocks/seel-wfd.liquid` | App embed block. Renders the config as JSON and loads the assets. |
| `extension/seel-wfd/assets/seel-wfd-core.js` | Pure logic: state reducer, ladder parsing, variant matcher, request builder, cart plan. `window.SeelWfdCore` in the browser, `require()` in Node. |
| `extension/seel-wfd/assets/seel-wfd.js` | DOM and network glue. Fetches, dispatches events into the reducer, renders, and writes the cart. |
| `extension/seel-wfd/assets/seel-wfd.css` | Theme-neutral styles. |
| `extension/seel-wfd/locales/en.default.json` | Fallback strings. Quote copy comes from Seel. |
| `demo/index.html` | Offline demo with mocked cart, proxy and ladder. |
| `test/*.test.js` | `node --test` suite for the core. |

## Run the demo and tests

```bash
open widget/demo/index.html
cd widget && node --test
```

The demo needs no keys or server. Pick a scenario and the page fires a theme-style cart write, which the widget observes and re-quotes on. The state name and the cart's WFD lines and `wfp_quote_id` show under the cart.

## Settings

Theme editor, App embeds, **Seel Worry-Free Delivery**.

| Setting | ID | Default | Notes |
|---|---|---|---|
| Quote endpoint | `quote_endpoint` | blank | Your quote proxy URL. Blank keeps the widget hidden (`no_quote_endpoint`). |
| Service type | `service_type` | blank | Required. The quote type Seel issued for your app, such as `acme_shopify-wfp`. |
| WFD product handle | `wfd_product_handle` | `worry-free-delivery` | The block reads the ladder metafield and variant ids from this product. |
| WFD SKU | `wfd_sku` | blank | Identifies WFD lines in the cart. The handle is used only when this is blank. |
| Store prices include tax | `prices_include_tax` | off | On for tax-inclusive stores. The ladder metafield is then required. |
| Opt shoppers in by default | `default_on` | off | |
| Anchor selector | `anchor_selector` | blank | CSS selector the widget is inserted before. Blank uses the checkout button. |
| Verbose console logging | `debug` | off | |

The block also passes `shop.permanent_domain` as `adminDomain`. "Powered by Seel" is rendered by the script and no setting removes it.

## Net price ladder metafield

The quote price is net of tax. Storefront variant prices are gross on tax-inclusive stores, so the widget matches the quote against a net price ladder stored on the WFD product.

- Owner: the WFD product
- Namespace and key: `seel.net_price_ladder`
- Type: `json`
- Value: `{ "<ISO currency>": { "<variant_id>": <net price in integer cents> } }`

```json
{
  "USD": { "44000000000001": 99, "44000000000002": 149, "44000000000003": 199 },
  "EUR": { "44000000000001": 92, "44000000000002": 138, "44000000000003": 184 }
}
```

Your app writes this metafield when it creates the WFD product and its variants, and again when it changes prices. Entries for variants the product no longer has are ignored.

How the widget picks prices for the cart currency:

| Ladder | `prices_include_tax` | Result |
|---|---|---|
| Has the cart currency | any | Match against that currency's entry. |
| Present, currency missing | any | Hide, `currency_not_supported`. |
| Absent | off | Match against `/products/{handle}.js` prices, which are net on tax-exclusive stores. |
| Absent | on | Hide, `currency_not_supported`. |

## Quote proxy contract

The browser never holds a Seel API key. It posts to your proxy, which adds the key and `customer_info.browser_ip`, calls Seel's `POST /v1/shopify/quotes`, and returns Seel's response unchanged.

Request from the widget:

```json
{
  "type": "acme_shopify-wfp",
  "admin_domain": "acme-dev.myshopify.com",
  "cart_info": { "...": "the /cart.js response, unmodified" },
  "customer_info": {
    "user_id": "stable visitor id, or empty string",
    "referrer_url": "document.referrer",
    "timestamp_in_ms": 1760400000000
  }
}
```

Response the widget reads:

```json
{
  "quote_id": "2026101400000000000000000001",
  "status": "accepted",
  "price": "0.98",
  "currency_code": "CAD",
  "display_amounts": null,
  "extra_info": {
    "widget_title": "Worry-Free Delivery",
    "display_widget_text": ["..."],
    "coverage_details_text": ["..."],
    "opt_out_warning_text": "...",
    "terms_url": "https://www.seel.com/terms/worry-free-purchase",
    "privacy_policy_url": "www.seel.com/privacy"
  }
}
```

`price` is net and in the quote currency. On cross-currency carts, `display_amounts.price` carries the presentment amount and the widget uses it instead.

## The three rules

1. **The quote id goes in `wfp_quote_id`.** The widget writes it as a cart attribute on opt-in and sets it to an empty string on opt-out, which drops it. An earlier version wrote `ssp_quote_id`, the wrong key, which silently broke quote binding for every order.
2. **The variant must match the quote's net price exactly.** Seel compares the collected premium with the quote when it creates the contract. The widget accepts a variant within 1 cent of the quoted presentment amount and nothing else. It never rounds up to the next tier and never falls back to the top tier. With no match it hides (`no_variant_match`) rather than sell a premium that fails at contract creation.
3. **WFD lines are identified by a fixed SKU.** Give every WFD variant the same SKU and set `wfd_sku`. The widget removes stale WFD lines, forces the WFD quantity to 1, and makes every change in one `/cart/update.js` call.

## States

`seel-wfd-core.js` exports a pure reducer, `transition(state, event)`. The glue reacts to the resulting state.

| State | Widget | Cart |
|---|---|---|
| `idle`, `quoting` | Unchanged, dimmed while quoting | Untouched |
| `offered {quote, variant}` | Shown, unchecked | WFD lines removed, `wfp_quote_id` cleared |
| `opted_in {quote, variant}` | Shown, checked | One matched WFD line at qty 1, `wfp_quote_id` set |
| `hidden {reason}` | Removed | WFD lines removed, `wfp_quote_id` cleared |
| `error {message}` | Removed | Untouched until the next cart change |

Hidden reasons are `quote_rejected`, `no_variant_match`, `currency_not_supported` and `no_quote_endpoint`. A cart with nothing but WFD lines is treated as `quote_rejected`. The shopper's opt-in choice carries across re-quotes, so a cart change returns an opted-in shopper to `opted_in` with the new quote and variant.

Every transition fires a `seel-wfd:state` event on `document` with the state as `detail`, and `window.SeelWfd.getState()` returns the current one.

## Deploy

1. Copy `extension/seel-wfd/` into your app's `extensions/` directory.
2. Run `shopify app deploy`.
3. In each merchant's store, create the WFD product with one variant per price tier, the fixed SKU on every variant, and the `seel.net_price_ladder` metafield.
4. Turn on the embed under Online Store, Themes, Customize, App embeds, and fill in the settings. You can also link merchants straight to the embed with a theme editor deep link (`/admin/themes/current/editor?context=apps&activateAppId=<api_key>/seel-wfd`).
5. Check a test order's `note_attributes` for `wfp_quote_id`.
