# CLAUDE.md

Public reference implementation for Shopify partner apps that embed Seel Worry-Free Delivery on Seel's `/v1/shopify/*` API. Seel sends partners a link to this repo, so everything in it ships to people outside Seel.

## Hard rules

- No partner names, API keys, webhook secrets or merchant IDs anywhere in the repo, including tests and examples. Use `acme` placeholders.
- Never use an em dash in code, comments, docs or commits. Use a hyphen.
- Keep the three rules from the README in the code. The cart attribute is `wfp_quote_id`, variant matching is exact on net price with no round-up, and the WFD SKU is one fixed string.
- The server uses Node built-ins only. Do not add npm dependencies.
- Forward Shopify order bodies to Seel byte for byte. Never parse and re-serialize them.

## Layout

- `widget/extension/seel-wfd/` is the theme app extension. Keep pure logic in `assets/seel-wfd-core.js` so `node --test` can load it, and keep DOM and network code in `assets/seel-wfd.js`.
- `server/node/` is the backend. Shopify topics route through `ORDER_TOPIC_ACTIONS` and Seel events through `buildEventHandlers`. Add a topic or event to the table, not a new branch.
- `docs/partner-flow.html` is the diagram source. Regenerate `docs/partner-flow.png` from it with the diagram-design plugin.

## Commands

```bash
cd widget && node --test                      # widget core tests
node --test server/node/test/*.test.js        # server tests (a bare directory fails on Node 21+)
open widget/demo/index.html                   # offline widget demo
```

## Related

- Sibling repo for the direct API: github.com/travisjoseph/seel-direct-integration-reference
- Commits and PR titles use Conventional Commits with a scope: `feat(widget)`, `feat(server)`, `docs(readme)`.
