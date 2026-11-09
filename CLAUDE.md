> **Git policy — never auto-commit or auto-push.** Leave work in the working tree. Run git commit, git push, gh pr create or a release script only when the user explicitly asks in that turn.

# raidr_agent_lib

Business logic shared by the apps and the backend: Zustand stores, React hooks
(composed from `raidr_agent_client` hooks — no direct network calls here), the
sign-in WebView token capture, and the **agent runner**.

**Package**: `@sudobility/raidr_agent_lib` (published to GitHub Packages).

## What raidr_agent is

A native agent app. It takes a plain-language request and: (1) finds the intent
via **shapeshyft** (a hosted structured-AI endpoint); (2) filters the **raidr**
catalog of MCP servers by label to sites that can serve it; (3) signs the user
in to those sites in an in-app **web view** — site session tokens stay on the
device and are never sent to the raidr_agent backend; (4) calls the sites
through **raidr's hosted MCP** (raidr_api); (5) renders with the Vercel AI SDK.

## Layering

```
raidr_agent_types -> raidr_agent_client -> raidr_agent_lib -> raidr_agent_app_rn
raidr_agent_types ------------------------------------------> raidr_agent_api
```

- `raidr_agent_types` — shared types + response helpers (no runtime deps).
- `raidr_agent_client` — `RaidrAgentClient` HTTP class + TanStack Query hooks.
- `raidr_agent_lib` — this repo.
- `raidr_agent_api` — Hono + Postgres (Drizzle) backend; uses `./runner`.
- `raidr_agent_app_rn` — the React Native app (separate repo).

## Stack & tooling

- **Bun only** — never npm, yarn, pnpm.
- TypeScript (strict, `module: ESNext`, `moduleResolution: bundler`), `jsx: react`.
- Build = `tsc -p tsconfig.build.json` then `scripts/fix-esm-imports.mjs`, which
  rewrites relative specifiers to fully-qualified paths so Node's native ESM
  loader resolves the `dist/` output. Required after every build.
- Tests: Vitest + jsdom (`vitest.config.ts`, globals on). 16 files / 152 tests.
- `zod` (^4), `react`, `zustand`, `@tanstack/react-query` are peer deps.

## Commands (all verified)

```bash
bun install        # needs GitHub Packages auth (see Install auth)
bun run typecheck  # tsc --noEmit
bun run lint       # eslint src/  (passes with a few non-null-assertion warnings)
bun run test:unit  # vitest run
bun run build      # -> dist/
bun run verify     # typecheck + lint + test:unit + build
```

### Install auth

`.npmrc` points `@sudobility` at `https://npm.pkg.github.com`. `bun install`
fails without a GitHub token that has `read:packages`; supply it via env/registry
auth. CI uses the `GH_PACKAGES_READ_TOKEN` secret. (Secret names starting with
`GITHUB_` are rejected by Actions.)

## Package exports

- `.` — stores, hooks, agent, runner (`src/index.ts` → `./business`).
- `./runner` — the runner only; imports just `zod`, `@sudobility/raidr_types`
  and types (no React), so the API can use it server-side. **Keep it
  React-free.**

## Project structure

```
src/business/
├── stores/      apiStatusStore (useApiStatusStore), selectionStore (useSelectionStore)
├── hooks/       useApiStatus (client useHealth + store)
├── agent/       captureScript (buildCaptureScript), tokenWatcher (TokenWatcher)
└── runner/      the agent flow (also the ./runner subpath)
```

- Stores hold **app-side state only**; data fetching stays in client hooks.
- `apiStatusStore` / `useApiStatus` are placeholder examples of the store+hook
  pattern. `selectionStore` is real (site-selection screen state).

## Sign-in WebView capture (`src/business/agent/`)

- `buildCaptureScript(apiHost)` — JS injected into the sign-in WebView. The
  site loads as itself; the script wraps `fetch`/`XMLHttpRequest` and posts
  `{ url, method, status, headers }` for requests to `apiHost` back to the app
  via `ReactNativeWebView.postMessage`. Only headers the page set are visible;
  cookies are read natively. `apiHost` is JSON-interpolated (cannot break out).
- `TokenWatcher` — decides when the user is signed in and what the token is.
  A token counts only once a request carrying it to a signed-in-only endpoint
  returns 2xx (any 2xx if no such endpoints are known) — this stops a pre-login
  guest token being mistaken for a real one. Uses `extractCredential` /
  `matchesPathTemplate` from raidr_types so the logic is shared across callers.
  `query`-style auth is narrowed to `none` (token is in the URL, not observable
  via headers/cookies).

## The agent runner (`src/business/runner/`)

RN-safe (no Node imports, no `URL` class). Each step is a hosted shapeshyft
endpoint, called through `AiTransport.invoke(step, input)`. `AgentStep` =
`understand | plan-search | rank-sites | prepare | plan | extract | pick-best |
dedupe | site-regions`. Exported surface is in `runner/index.ts` — read it
rather than relying on signatures here.

Pipeline: `understandIntent` → `planSites`/`planSearch` → `classifySiteRegions`
→ `rankSites` → `prepareSites` → `runSites` → `pickBest` (single/best intents).

Key non-obvious behaviors and contracts:

- **Intent** (`understandIntent`): six W's + `selection`, normalised by
  `toAgentIntent`. `language` is the BCP 47 tag of the request's language
  (`languageTag` normalises case: `en`, `pt-BR`, `zh-Hant`). Every model step
  that writes user-facing text (ranking reasons, prepare/extract labels and
  summaries, pick-best reason) writes in that language, keeping site titles/names
  as given.
- **Tolerant zod** schemas in `./schemas` parse model output; strict
  `agentIntentSchema` validates intents sent back by clients. An unusable answer
  degrades gracefully (e.g. rank keeps candidate order; planSearch → null).
- **STEP_SCHEMAS / STEP_ENDPOINTS** (`./stepSchemas`) are the JSON Schemas +
  hosted names for each endpoint. `stepSchemas.test.ts` asserts they match the
  zod schemas; `raidr_agent_api`'s `shapeshyft/endpoints/*.json` must carry them
  verbatim — keep all three in sync.
- **Service area** (`./serviceArea`): ccTLD → country, but generic-use TLDs
  (.io/.fm) are not treated as country signals.
- **runSites**: calls MCP tools per site; results in site order. A site whose
  every call was 401/403 gets `needsSignIn: true`. GraphQL tools are
  introspected once (cached ~1h per endpoint) so the planner sees the schema
  (`./graphql`). After a success the runner follows paging itself — cursor, page
  number, or offset — until done or caps (`MAX_AUTO_PAGES` 10 / `MAX_AUTO_ITEMS`
  500) (`./paging`). A bot-protection page (Akamai/PerimeterX/Cloudflare/
  Imperva/DataDome) is a failed call whatever its HTTP status (`isBotChallenge`).
- **condense** (`./condense`): trims bodies to what models see (`EXCERPT_BYTES`
  16 000); extraction reads every page via `condenseChunks`, deduping items and
  capping per site.
- **buildPageUrl** (`./pageUrl`): derives each result's `pageUrl` per the
  CONTRACTS_V2 rules (urlFields, route templates, then `itemLink`); host must be
  a site origin/subdomain. Returns `''` when nothing resolves.
- **DirectSiteConnector**: calls a site from the device using raidr_types'
  `buildUpstreamRequest` + `assertSafeUpstream`; `redirect: 'manual'`, followed
  by hand only for same-site GET (apex↔www, http→https; ≤3). A redirect/response
  from another site is a failed call; body cut at `MAX_UPSTREAM_BYTES`.
  **Never throws from `callTool`.**
- `createLocalRunRecorder` turns a local run into a `RunImportRequest` for upload
  (unfinished sites → failed, lists capped, `best` kept only if its result is
  uploaded).

## Conventions & gotchas

- **Device-token privacy**: site session tokens from the WebView belong on the
  device; never attach them to API calls to raidr_agent_api.
- Keep `./runner` React-free and RN-safe (no `URL`, no Node builtins).
- Keep STEP_SCHEMAS ↔ zod schemas ↔ the API's endpoint JSON in agreement.
- This is a library; there is no app to run.

## CI/CD

`.github/workflows/ci-cd.yml` calls
`johnqh/workflows/.github/workflows/unified-cicd.yml@main` on push/PR to `main`
and `develop`; publishes to GitHub Packages (`publish-target: github`).

## Origin

Scaffolded from the mogulgame repos (a copy of the company "starter" template),
with the game domain removed.
