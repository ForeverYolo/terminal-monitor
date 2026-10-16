# Testing

Use Node 20 and install development dependencies with `npm ci`. Browser tests
use pinned xterm/fit and Playwright packages from this checkout, with no
external CDN requests. Run `npm run test:setup` once to install Chromium.
`CHROMIUM_EXECUTABLE` can select an existing browser instead.

| Command | Coverage / prerequisites |
| --- | --- |
| `npm test` | Unit and mock-agent protocol tests; no model calls |
| `npm run test:unit` | Detectors, filters, snapshots, supervisor, HTTP/update contracts and stream lifecycle |
| `npm run test:protocol` | Broker/client registration, reconnect, updates |
| `npm run test:screen` | Disposable real GNU Screen sessions, restart/rollback and quoted-path fixtures |
| `npm run test:browser` | Chromium, real Screen, terminal selection, paging, redraw |
| `npm run test:codex` | Logged-in Codex, isolated synthetic history; no new prompts |
| `npm run test:all` | All local groups, including real Codex |
| `npm run test:staging` | Existing public staging platform; see staging-platform.md |

Groups run sequentially and stop on failure. Browser helpers own the asset
routing and browser launch settings. Existing `PLAYWRIGHT_MODULE` and
`XTERM_FIT_JS` overrides remain available for external dependency installations.
Staging recovery tests are explicit; the default local suite never deploys or
restarts production services.
