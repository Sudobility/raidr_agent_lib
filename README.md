# raidr_agent_lib

`@sudobility/raidr_agent_lib` — business logic shared by the raidr_agent apps and
backend. It holds Zustand stores and React hooks (composed from
`raidr_agent_client` hooks; no direct network calls) plus the **agent runner**:
the request → intent → sites → results flow. Published to GitHub Packages;
license BUSL-1.1.

Part of **raidr_agent**, a native agent app that turns a plain-language request
into an intent (via the hosted **shapeshyft** AI endpoint), picks matching
**raidr** MCP servers by label, signs the user in to those sites in a web view
(site tokens stay on the device), calls them through raidr's hosted MCP, and
renders the results with the Vercel AI SDK.

Layering:

```
raidr_agent_types -> raidr_agent_client -> raidr_agent_lib -> raidr_agent_app_rn
raidr_agent_types ------------------------------------------> raidr_agent_api
```

## Package exports

- `@sudobility/raidr_agent_lib` — stores, hooks, agent (WebView capture) and the
  full runner. Pulls in React / Zustand / TanStack Query.
- `@sudobility/raidr_agent_lib/runner` — the agent runner only. Imports just
  `zod`, `@sudobility/raidr_types` and types (no React), so `raidr_agent_api`
  can use it server-side.

## Requirements

- **Bun only** — never npm, yarn or pnpm.
- The `@sudobility/*` dependencies live on **GitHub Packages**
  (`.npmrc` points `@sudobility` at `https://npm.pkg.github.com`). `bun install`
  needs a GitHub token with `read:packages`; make it available to the registry
  (e.g. `NPM_CONFIG_//npm.pkg.github.com/:_authToken=<token>` or a `~/.npmrc`
  auth line). CI reads it from the `GH_PACKAGES_READ_TOKEN` secret.

## Development

```bash
bun install
bun run typecheck     # tsc --noEmit
bun run lint          # eslint src/
bun run test:unit     # vitest (jsdom), run once
bun run test:watch    # vitest watch
bun run build         # tsc -p tsconfig.build.json -> dist/ (+ fix-esm-imports)
bun run verify        # typecheck + lint + test:unit + build
```

This is a library, not an app — there is nothing to "run"; consumers import it.
`bun run build` compiles ESM + `.d.ts` into `dist/`, then
`scripts/fix-esm-imports.mjs` rewrites relative specifiers to fully-qualified
paths so Node's native ESM loader can resolve the output.

## Project structure

```
src/
├── index.ts                         # re-exports ./business
└── business/
    ├── stores/                      # Zustand stores (app-side state only)
    │   ├── apiStatusStore.ts        # useApiStatusStore (last health check)
    │   └── selectionStore.ts        # useSelectionStore (site selection screen)
    ├── hooks/
    │   └── useApiStatus.ts          # useApiStatus (client useHealth + store)
    ├── agent/                       # sign-in WebView token capture
    │   ├── captureScript.ts         # buildCaptureScript (injected JS)
    │   └── tokenWatcher.ts          # TokenWatcher (detects signed-in + token)
    └── runner/                      # the agent flow (also the ./runner subpath)
```

## The agent runner (`src/business/runner/`)

Shared by `raidr_agent_api` (cloud runs) and the app (local runs); RN-safe (no
Node imports, no `URL` class). The pipeline, each step a hosted shapeshyft
endpoint called through `AiTransport.invoke`:

`understandIntent` → `planSites` / `planSearch` → `classifySiteRegions` →
`rankSites` → `prepareSites` (build a form) → `runSites` (call sites' MCP tools,
follow paging, extract results) → `pickBest` for single/best intents.

See `src/business/runner/index.ts` for the exported surface and `CLAUDE.md` for
the architecture and gotchas.

## License

BUSL-1.1
