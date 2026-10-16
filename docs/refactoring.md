# Project structure and upgrade notes

The refactor is developed on `refactor/project-structure`. The preceding TUI
selection fix is a separate commit. No production rollout is implied by the
staging deployment.

## Responsibilities

| Module | Responsibility |
| --- | --- |
| `server.js` | WebSocket roles, registration, message routing and server startup |
| `server-http.js` | Explicit static asset routes and HTTP APIs |
| `terminal-replay.js` | Delta/snapshot replay, canonical size ownership and snapshot cancellation |
| `pending-requests.js` | Update/pull request timeout and disconnected-owner cleanup |
| `client.js` | Agent identity, Screen/PTY lifetime, registration and reconnect |
| `file-transfer.js` | Per-connection upload/download streams and backpressure |
| `file-update.js` | Shared hashing, full-batch validation and unique temporary file installation |
| `managed-files.js` | One inventory for broker, agent, version badges and scp deployment |
| `service-runtime.sh` | Exact Screen names, Node runtime probing and quoted service launch |
| `service-restart.js` | Detached client/server restart and server rollback orchestration |
| `config-loader.js` | Shared CLI configuration parsing for all three entry points |
| `claude-detector.js` | Shared pure state detector for agent and phone structured view |
| `public/connection.js` | Connection, terminal identity and protocol dispatch |
| `public/terminal-session.js` | Shared terminal creation, input and disposable view work |
| `public/terminal-view.js`, `multi-terminal.js` | Single/multi view layout, size handling and selection |
| `public/file-browser.js`, `management.js`, `notifications.js`, `mobile.js` | Independent UI features |
| `public/dashboard.js`, `bootstrap.js`, `app.css` | Dashboard, final startup and styles |

The browser still needs no build. Explicit ordered classic `defer` scripts
share the existing page state; this is a gradual separation by responsibility,
not a rewrite into a framework. Bootstrap starts saved-login reconnect only
after all feature scripts have loaded. Static serving is an explicit allowlist;
it does not expose arbitrary project/config files.

## First upgrade across the old update allowlist

Old agents only accept the original fixed filenames. They cannot install the
new modules through the old web updater: validation rejects the batch before
writing it. Upgrade the complete checkout on each server/agent using Git or
`deploy.sh`, install dependencies, and restart the monitor services. The
updated `deploy.sh` includes every runtime module and the service scripts.
After this initial upgrade, web pull/push includes all split runtime assets.

Configuration, credentials and task Screen sessions are not part of the update
inventory. Scripts/package files are scp/Git deployment files, not arbitrary
web-updater targets. Merely extracting a browser script must include that file
in `managed-files.js`, or the contract test fails.

## Behavior fixes accompanying the refactor

- Supervisor startup is idempotent; shutdown cancels the delayed initial check
  as well as recurring timers. The broker starts the supervisor once.
- Closed terminal views cancel resize timers, delayed redraw and animation
  callbacks. Mobile listeners belong to the view that installed them. The
  pinned xterm 5.3 Viewport also needs its queued refresh callbacks neutralized
  before its renderer is disposed; rapid-close browser tests cover this.
- Update/pull requests expire at the broker and release disconnected browsers.
  Snapshot requests cancel their timers when either endpoint disconnects.
- Downloads poll WebSocket buffered bytes instead of waiting for a `drain`
  event that WebSocket does not emit. Polling and streams stop on disconnect.
  Upload acknowledgments wait for stream drain when necessary.
- Self-restart passes paths/configuration as positional arguments and uses the
  shared Screen primitives. Explicit external config paths are preserved.
- `/api/action` now requires `Authorization: Bearer <agent-token>` and targets
  only that token's user. Unauthenticated requests return 401. Public status
  endpoints retain their existing behavior.
- Unreferenced `doPaste`, duplicated browser detector rules, copied file lists,
  hashing implementations and obsolete restart variables were removed. Private
  configuration patterns are ignored for every session name; Git backup also
  recognizes linked worktrees.

## Preserved boundaries

Legacy replay, Screen compatibility and phone structured view remain supported.
Supervisor recommendations and autonomous AI Overseer execution remain separate.
No model request is made by the regression suite's Codex fixtures. Real Claude,
physical mobile touch/IME and whole-machine reboot still require separate
validation. Multi-file updates validate and stage all contents before rename;
individual file replacement is atomic, the whole batch is not a filesystem
transaction. Uploads continue writing their destination as before.

The known terminal snapshot gaps in `../KNOWN_TERMINAL_STATE_GAPS.md` are not
filled by this refactor. xterm remains pinned to 5.3.0; selection and parser-state
restoration rely on its private APIs and must be rechecked before an upgrade.

## Verification of this change

All 23 local test files passed in their groups: 9 unit/contract, 7 protocol,
3 Screen/process, 3 browser, and 1 real Codex test. The browser scenarios cover
single/multi selection and right-click copying, rapid view teardown, synthetic
phone IME commit, canonical size handoff, reconnect, mode switching, shell
history, and 7000 redraw updates with a concurrent snapshot. Restart tests use
isolated Screen sockets for server rollback and quoted external config paths.
This records the tested revision, not a promise that future changes pass.
