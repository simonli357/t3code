# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity) and serves web, desktop (Electron, bundles the server) and mobile (React Native) clients. This repository is a private fork; its maintenance workflows live in `~/t3-workflows`.

Never leave this repository or `~/t3-workflows` out of sync: before finishing, either discard or commit and push every local change and branch, and bring each host's checkout to the pushed commit without overwriting active work. Deploy only from pushed commits.

Prefer the smallest change that makes the correct behavior obvious; do not add machinery or keep complexity for its own sake. Protect performance: no excess websocket data, no continuously repainting animations, no heavy list rendering.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID found by matching a name, path, or worktree string. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the real T3 database, in use while you work. Reading and copying are fine; never start a server against it, open it read-write, or clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`.

## Hit every surface

Before calling a feature done, say which of these applied: other entry points (Settings, command palette, keybindings); web, desktop and mobile clients (shared client code is in `packages/client-runtime`); each provider adapter; MCP tools for agents (so features are service methods, not handler code); contracts in `packages/contracts`; the reverse state (close needs reopen); local, remote and tunnel connections; and docs the change makes inaccurate.

## Dev servers

- `vp i` installs. `vp run dev` starts server and web with state in the worktree's gitignored `.t3`. Read the real ports from the `[dev-runner]` line.
- To share over the tailnet, run `vp run dev --share` and give the printed `pairingUrl:` to an unpaired browser; mint another with `node apps/server/src/bin.ts pair`. Never commit or publish tokens or startup URLs. See [development](docs/operations/development.md).
- Stop what you started, by the PID you tracked.

## Test data

Seed the worktree's `.t3` with a copy of real data from `~/.t3/userdata`, never live state. Snapshot with `VACUUM INTO`, which is safe while a server has the source open; a plain `cp` of a live database is corrupt.

```bash
mkdir -p .t3/userdata
rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
```

Copy `secrets` and `settings.json` only if the flow needs them. Copy in, never symlink.

## Verifying

- Smallest proof: `vp test run <files>` plus targeted lint and typecheck. No repo-wide `vp check`, `vp run -r test` or `vp run -r typecheck` unless asked.
- Backend behavior changes ship with focused tests. Test behavior, not rendered markup or callback wiring.
- The server is event-sourced: wait on receipts and worker drains, never sleeps or polling.
- Real-client checks (`test-t3-app`, `test-t3-mobile`) only on request; ask before using browsers or computer use. For mobile, `node scripts/mobile-native-client.ts ensure <ios|android> <device-id>` builds a missing native client.

## Commits and pull requests

- Conventional commit titles in plain language: `fix(web): new threads no longer spike CPU`.
- Never open a PR unless asked. A PR body states the problem, the fix, and the model and harness; UI changes include before/after images; one concern per PR.
- Do not commit plans, research notes or scratch files.

## Documentation

Most changes need no doc change. `docs/internals/` records decisions and cross-component traps, not feature catalogs; `docs/user/` helps users complete tasks; `docs/operations/` holds maintainer procedures. Rewrite outdated text instead of appending to it.

## How it works

Clients send typed WebSocket requests. The server turns them into commands, a pure decider turns commands into persisted events, and a projector derives the read model. Provider adapters translate each CLI's protocol into orchestration events. Side effects run in queue-backed reactors that emit receipts. Each turn ends with a checkpoint, a hidden git ref. Glossary: [docs/internals/glossary.md](docs/internals/glossary.md).

## Where code lives

- `apps/server`: WebSocket, orchestration, providers, checkpointing. Read [Effect services](docs/internals/effect-services.md) before adding server code.
- `apps/web` (React/Vite), `apps/desktop` (wraps web), `apps/mobile` (React Native).
- `packages/contracts`: Effect/Schema contracts, no heavy runtime logic. `packages/shared`: runtime utils via subpath exports. `packages/client-runtime`: code shared by web and mobile.
- `.repos/`: vendored read-only references. Follow their patterns; never edit or import from them.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Transports stay thin: a `ws.ts` handler, HTTP route or MCP tool decodes input, calls one service method, and maps errors.
- `apps/web/src/components/ui` components own their look: choose a `variant` or `size`, never restyle with `className`; layout classes go on the parent.
- Inferred types over annotations. No `any`.
- If a rule here fights the task, say so and get sign-off before breaking it.
