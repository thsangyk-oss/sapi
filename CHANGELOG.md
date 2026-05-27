# v0.1.3 (2026-05-27)

## Features
- Preemptive token renewal: every hourly tick now sweeps every codex account across all groups (G1/G2/G3/G4/G5/groupError) plus the live DB G1 pool and refreshes any access token whose `expiresAt` is within 90 minutes. Only the OAuth refresh-token RPC is called (no quota fetch), so this is cheap and safe to run frequently. Tokens in `group2` and `groupError` — which used to sit dormant for days and silently die — are now kept fresh automatically.
- `groupError` auto-retry: the scheduler re-checks every account in `groupError` on each tick. The full refresh-token + quota flow runs again, so accounts whose token revocation was transient (or who were dumped there by a one-off 401) get promoted back to `group2`/`group3`/`group4`/`group5` automatically. Previously `groupError` was a one-way trap — only manual UI retry could rescue an account.
- New exported helper `refreshAccountInMemory()` in `codex-data/check.js` for callers that need just the refresh-token RPC without a quota fetch.

## Improvements
- `runCycle` step order documented + reordered to: `renewSoonToExpire` → `retryErrorGroup` → `reclassifyResetGroups` → `cycleGroup1`. Newly-recovered accounts can flow `groupError` → `group2` → `group1` within a single tick.
- `lastResult` payload now includes `renew` and `retryError` summaries (additive; existing UI consumers are unaffected).

# v0.1.2 (2026-05-26)

## Fixes
- Tunnel was stuck in a permanent "Reconnecting" loop on restricted networks (corporate DNS, split-horizon resolvers) because the watchdog probed the public hostname via the local resolver — which often can't see the freshly-added CNAME even though the tunnel works fine from the internet. The watchdog now trusts the cloudflared process: if it's alive, the tunnel is considered healthy. The unreliable post-spawn `waitForHealth` is dropped from `restartTunnel` for the same reason.
- `killCloudflared` could not reap named-tunnel processes because their command line no longer contains `:20128` (Quick Tunnels passed the port via `--url`; Named Tunnels do not). Result: each failed watchdog probe spawned another cloudflared without cleaning up the old one, accumulating duplicate connectors on Cloudflare's edge and producing reconnect churn. Now matches by `ExecutablePath == <DATA_DIR>/bin/cloudflared.exe` so it reaps all SAPI-owned processes without ever touching a user's system-wide cloudflared.
- `isCloudflaredRunning` recovers from a stale pidfile (e.g. after Next hot-reload) by scanning Win32_Process / `pgrep` for the SAPI binary and re-syncing the pidfile when a match is found.
- Removed unused `waitForHealth` / `probeUrlAlive` imports from the tunnel manager and watchdog.

# v0.1.1 (2026-05-26)

## Features
- System tray launcher (Windows): PowerShell + WinForms NotifyIcon runs the SAPI server in the background with hidden console; menu has Open / Restart / Show status / Open log folder / Quit; single-instance via global mutex; double-click opens the dashboard
- Quick-launch icon: multi-size `sapi.ico` generated from `public/icons/icon-192.png`; `install-shortcut.cmd` installs Desktop + Start Menu shortcuts and supports `/autostart` (Windows Startup folder) and `/remove`
- API Keys redesigned as cards: per-key card with inline rename (click name to edit, Enter to save, Esc to cancel), always-visible Copy / Show-Hide / Delete buttons, prominent token-and-request counter over the last 24 hours, and a relative "last-used" label
- Live activity glow: a key card pulses yellow when it served (or is currently serving) a request within the last 2 minutes; backed by a new per-key heartbeat (`touchApiKey` in `extractApiKey`) plus a new `GET /api/keys/stats` endpoint
- API key rename: `PUT /api/keys/[id]` now accepts a `name` field (≤80 chars, trimmed)
- Cloudflare Tunnel redesigned as a Named-Tunnel + user-domain flow:
  - **Authorize**: button runs `cloudflared tunnel login`, surfaces the Cloudflare dashboard URL in a modal (copy / open) and auto-detects the zone(s) once `cert.pem` exists
  - **Authorized badge**: shows the resolved zone name(s)
  - **Multi-subdomain ingress**: "+" button adds subdomains inline (with zone dropdown when multiple zones authorized); each subdomain row has Copy, Open, Delete; one tunnel routes many hostnames via a generated `config.yml`
  - **Revoke** button: stops the SAPI tunnel and deletes the Cloudflare tunnel registration (leaves `~/.cloudflared/cert.pem` so it can be shared with manual cloudflared use)
- New API routes: `POST/GET/DELETE /api/tunnel/authorize`, `POST /api/tunnel/revoke`, `POST /api/tunnel/subdomains`, `DELETE /api/tunnel/subdomains/[host]`

## Improvements
- Watchdog auto-resume now uses the new tunnel state schema (`{tunnelId, subdomains[]}`) and probes the primary subdomain for liveness
- Tunnel status endpoint exposes `{authorized, zones, subdomains, login, running, reconnecting, ...}`; `dashboardGuard` reads `settings.tunnelHosts` (multi-host) instead of a single tunnel URL
- Tray launcher reaps node children from prior abnormal exits via pidfile on next startup; Job Object kill-on-close set as best-effort belt-and-suspenders

## Fixes
- `cert.pem` path: cloudflared 2026.5.1 ignored `--origincert` for the `tunnel login` pre-check (always tested the OS default); switched to `~/.cloudflared/cert.pem` everywhere and dropped `--origincert` from all CLI calls
- Modern cert format support: the cert.pem produced by cloudflared 2026+ is just an `ARGO TUNNEL TOKEN` block (base64 JSON with `zoneID`/`accountID`/`apiToken`) — added a parser that resolves zone names via `GET https://api.cloudflare.com/client/v4/zones/<zoneID>` with 24h in-memory cache, plus an X.509 fallback for older cert formats
- Authorize fast-path: if `cert.pem` already exists, return `alreadyAuthorized:true` immediately instead of running login again
- Surface cloudflared stderr on login failure so the UI shows the real reason instead of "Login failed before producing cert"

## Removals
- Tailscale support removed completely: `src/lib/tunnel/tailscale.js`, related lifecycle/state/settings, the entire Tailscale UI section (state, handlers, install/connect/disable modals) and the dead `/api/tunnel/tailscale-*` references
- Quick Tunnel flow (`*.trycloudflare.com` via `r<shortId>.9router.com` worker) removed in favor of Named Tunnels on the user's own domain; `POST /api/tunnel/enable` route dropped

# v0.4.18 (2026-05-05)

## Features
- Speech-to-Text: full pipeline with sttCore + /v1/audio/transcriptions; configs for OpenAI, Gemini, Groq, Deepgram, AssemblyAI, HuggingFace, NVIDIA Parakeet; new 9router-stt skill
- Gemini TTS: dedicated provider with 30 prebuilt voices
- Usage quotas: GLM (intl/cn) and MiniMax (intl/cn) fetchers; Gemini CLI usage via retrieveUserQuota per-model buckets
- Disabled models: lowdb-backed disabledModelsDb + /api/models/disabled route
- Header search: reusable Zustand store wired into Header
- CLI tools: Claude Cowork tool card + cowork-settings API
- Providers: mediaPriority sorting in getProvidersByKind, add Kimi K2.6

## Improvements
- Expand media-providers/[kind]/[id] page; enhance OAuthModal, ModelSelectModal, ProviderTopology, ProxyPools, ProviderLimits
- Refresh provider icons (alicode, byteplus, cloudflare-ai, nvidia, ollama, vertex, volcengine-ark); add aws-polly, fal-ai, jina-ai, recraft, runwayml, stability-ai, topaz, black-forest-labs
- Reorder hermes provider, drop qwen STT kind

## Fixes
- Fix skills metadata/text in 9router, chat, embeddings, image, tts, web-fetch, web-search SKILL.md and skills page

# v0.4.16 (2026-05-04)

## Features
- Skills system: manage and execute custom AI skills

## Fixes
- Fix input fields in tool cards

# v0.4.14 (2026-05-03)

## Improvements
- Token refresh: in-flight request caching to prevent race conditions & reduce duplicate API calls
- Token refresh: handle unrecoverable errors with token reuse/invalidation
- MITM server: handle port 443 conflicts (kill occupying process before start)
- Better UX feedback in MitmServerCard for port conflicts & admin privileges
- Refactor ComboList for streamlined media provider combos display

# v0.4.13 (2026-05-03)

## Features
- Add Azure OpenAI as dedicated provider (endpoint/deployment/API version/organization config)
- Add browser-local endpoint presets for CLI tools (Claude, Codex, OpenCode, Droid, OpenClaw, Hermes, Copilot)
- Add Codex review model quota support
- Add DNS tool state persistence in MITM manager

## Improvements
- New brand color palette with better light/dark theme consistency
- Improve mobile layouts and restore Cloudflare provider
- Improve zh-CN translations
- Better admin privilege feedback in MitmServerCard
- Refined APIPageClient layout
- Filter LLM combos to show only relevant data

## Fixes
- Include alias-backed models in /v1/models listing
- Improve cloudflared exit code error messages
- Redirect ~/.9router to DATA_DIR in Docker (persist usage across updates)
- Prevent SSE listener leak in console-logs stream
- Gate MITM sudo prompts on server platform
- Fix Azure validation and persistence (providerSpecificData, Organization required)

# v0.4.12 (2026-05-01)

## Features
- Add Xiaomi MiMo provider support
- Add sticky round-robin strategy for combos

## Improvements
- Refactor proxyFetch and enhance MediaProviderDetailPage layout
- Improve dashboard responsive layouts
- Update provider models list

## Fixes
- Fix custom provider prefix conflicts with built-in alias
- Strip output_config for MiniMax requests

# v0.4.11 (2026-04-30)

## Features
- Add Caveman feature: terse-style system prompts to reduce output token usage with configurable compression levels
- Add Caveman settings UI in Endpoint dashboard (enable/disable, compression level)

## Improvements
- Consolidate AntigravityExecutor function declarations for Gemini compatibility
- Clean up translator initialization logs across API routes

# v0.4.10 (2026-04-29)

## Features
- Add new embedding models and Voyage AI provider support
- Add Coqui, Inworld, Tortoise TTS providers
- Add Deepgram and Inworld TTS voices API endpoints

## Improvements
- Enhance MITM Antigravity handler with improved cert install and DNS config
- Refactor TTS handling to support additional providers
- Improve API key validation for media providers
- Enhance MITM logger with better diagnostics
- Add Windows elevated permissions support for MITM

## Fixes
- Fix Antigravity MITM connection and handler issues
- Fix cloudflared tunnel integration with MITM

# v0.4.8 (2026-04-28)

## Features
- Add Web Search & Web Fetch providers with Combo support — chain multiple search/fetch providers as a single virtual provider
- Add Cloudflare AI provider support
- Add provider filter and expiry sorting to quota dashboard (#769)

## Improvements
- Proxy-aware token refresh across executors (Antigravity, Base, Default, Github, Kiro)

## Fixes
- Fix granular `reasoning_effort` handling for Claude models on Copilot & Anthropic backend (#791)
- Fix Antigravity INVALID_ARGUMENT errors and Copilot agent mode parity
- Fix quota reset timestamp parsing (#768)

# v0.4.6 (2026-04-25)

## Features
- Add BytePlus Provider
- Add Codex support to image providers
- Enhance image and embedding provider support

## Improvements
- Cap maximum cooldown for rate limit handling in account unavailability and single-model chat flows
- Dynamic custom model fetching for model selection

# v0.4.5 (2026-04-24)

## Improvements
- Cap maximum cooldown for rate limit handling in account unavailability and single-model chat flows
- Dynamic custom model fetching for model selection

# v0.4.3 (2026-04-24)

## Improvements
- Improve in-app download/update UX on dashboard
- Improve Codex provider rate limit handling with precise cooldown (`resetsAtMs`) and email backfill for OAuth accounts

# v0.4.2 (2026-04-24)

## Features
- Add Azure OpenAI provider support
- Add built-in Volcengine Ark provider support (#741)
- Add GPT 5.5 model

## Fixes
- Enhance retry logic and configuration for HTTP status codes

# v0.4.1 (2026-04-23)

## Features
- Add Hermes CLI tool with settings management and integration
- Add in-app version update mechanism (appUpdater + /api/version/update)

## Improvements
- Strengthen CLI token validation for enhanced security
- Enhance Sidebar layout for CLI tools
- Update executors and runtime config

# v0.3.98 (2026-04-22)

## Features
- Add RTK — filter context (ls/grep/find/.....) before sending to LLM to save tokens

# v0.3.97 (2026-04-22)

## Features
- Add OpenCode Go provider and support for custom models
- Add Text To Image provider
- Support custom host URL for remote Ollama servers

## Fixes
- Fix copy to clipboard issue

# v0.3.96 (2026-04-17)

## Features
- Add marked package for Markdown rendering
- Enhance changelog styles

## Improvements
- Refactor error handling to config-driven approach with centralized error rules
- Refactor localDb structure
- Update Qwen executor for OAuth handling
- Enhance error formatting to include low-level cause details
- Refactor HeaderMenu to use MenuItem component
- Improve LanguageSwitcher to support controlled open state
- Update backoff configuration and improve CLI detection messages
- Add installation guides for manual configuration in tool cards (Droid, Claude, OpenClaw)

## Fixes
- Fix Codex image URL fetches to await before sending upstream (#575)
- Strip thinking/reasoning_effort for GitHub Copilot chat completions (#623)
- Enable Codex Apply/Reset buttons when CLI is installed (#591)
- Show manual config option when Claude CLI detection fails (#589)
- Show manual config option when OpenClaw detection fails (#579)
- Ensure LocalMutex acquire returns release callback correctly (#569)
- Strip enumDescriptions from tool schema in antigravity-to-openai (#566)
- Strip temperature parameter for gpt-5.4 model (#536)
- Add Blackbox AI as a supported provider (#599)
- Add multi-model support for Factory Droid CLI tool (#521)
- Add GLM-5 and MiniMax-M2.5 models to Kiro provider (#580)
- Fix usage tracking bug

# v0.3.91 (2026-04-15)

## Features
- Add Kiro AWS Identity Center device flow for provider OAuth
- Add TTS (Text-to-Speech) core handler and TTS models config
- Add media providers dashboard page
- Add suggested models API endpoint

## Improvements
- Refactor error handling to config-driven approach with centralized error rules
- Refactor localDb and usageDb for cleaner structure

## Fixes
- Fix usage tracking bug

# v0.3.90 (2026-04-14)

## Features
- Add proactive token refresh lead times for providers and Codex proxy management
- Enhance CodexExecutor with compact URL support

## Improvements
- Enhance Windows Tailscale installation with curl support and fallback to well-known Windows path
- Refactor execSync and spawn calls with windowsHide option for better Windows compatibility

## Fixes
- Fix noAuth support for providers and adjusted MITM restart settings
- Bug fixes

# v0.3.89 (2026-04-13)

## Improvements
- Improved dashboard access control by blocking tunnel/Tailscale access when disabled

# v0.3.87 (2026-04-13)

## Fixes
- Fix codex cache session id

# v0.3.86 (2026-04-13)

## Features
- Add provider models and thinking configurations for enhanced chat handling
- Add Vercel relay support to proxy functionality
- Add Vercel deploy endpoint for proxy pools management

## Improvements
- Enhance proxy functionality with new relay capabilities
- Streamline GitHub Actions Docker publish workflow
- Update Docker configuration and package management

## Fixes
- Remove obsolete 9remote installation/management APIs

# v0.3.83 (2026-04-08)

## Fixes
- Fix OpenRouter custom models not showing after being added

# Unreleased

## Features
- Added API key visibility toggle (eye icon) to Endpoint dashboard page for improved UX and security.

# v0.2.66 (2026-02-06)

## Features
- Added Cursor provider end-to-end support, including OAuth import flow and translator/executor integration (`137f315`, `0a026c7`).
- Enhanced auth/settings flow with `requireLogin` control and `hasPassword` state handling in dashboard/login APIs (`249fc28`).
- Improved usage/quota UX with richer provider limit cards, new quota table, and clearer reset/countdown display (`32aefe5`).
- Added model support for custom providers in UI/combos/model selection (`a7a52be`).
- Expanded model/provider catalog:
  - Codex updates: GPT-5.3 support, translation fixes, thinking levels (`127475d`)
  - Added Claude Opus 4.6 model (`e8aa3e2`)
  - Added MiniMax Coding (CN) provider (`7c609d7`)
  - Added iFlow Kimi K2.5 model (`9e357a7`)
  - Updated CLI tools with Droid/OpenClaw cards and base URL visibility improvements (`a2122e3`)
- Added auto-validation for provider API keys when saving settings (`b275dfd`).
- Added Docker/runtime deployment docs and architecture documentation updates (`5e4a15b`).

## Fixes
- Improved local-network compatibility by allowing auth cookie flow over HTTP deployments (`0a394d0`).
- Improved Antigravity quota/stream handling and Droid CLI compatibility behavior (`3c65e0c`, `c612741`, `8c6e3b8`).
- Fixed GitHub Copilot model mapping/selection issues (`95fd950`).
- Hardened local DB behavior with corrupt JSON recovery and schema-shape migration safeguards (`e6ef852`).
- Fixed logout/login edge cases:
  - Prevent unintended auto-login after logout (`49df3dc`)
  - Avoid infinite loading on failed `/api/settings` responses (`01c9410`)

# v0.2.56 (2026-02-04)

## Features
- Added Anthropic-compatible provider support across providers API/UI flow (`da5bdef`).
- Added provider icons to dashboard provider pages/lists (`60bd686`, `8ceb8f2`).
- Enhanced usage tracking pipeline across response handlers/streams with buffered accounting improvements (`a33924b`, `df0e1d6`, `7881db8`).

## Fixes
- Fixed usage conversion and related provider limits presentation issues (`e6e44ac`).

# v0.2.52 (2026-02-02)

## Features
- Implemented Codex Cursor compatibility and Next.js 16 proxy migration updates (`e9b0a73`, `7b864a9`, `1c6dd6d`).
- Added OpenAI-compatible provider nodes with CRUD/validation/test coverage in API and UI (`0a28f9f`).
- Added token expiration and key-validity checks in provider test flow (`686585d`).
- Added Kiro token refresh support in shared token refresh service (`f2ca6f0`).
- Added non-streaming response translation support for multiple formats (`63f2da8`).
- Updated Kiro OAuth wiring and auth-related UI assets/components (`31cc79a`).

## Fixes
- Fixed cloud translation/request compatibility path (`c7219d0`).
- Fixed Kiro auth modal/flow issues (`85b7bb9`).
- Included Antigravity stability fixes in translator/executor flow (`2393771`, `8c37b39`).

# v0.2.43 (2026-01-27)

## Fixes
- Fixed CLI tools model selection behavior (`a015266`).
- Fixed Kiro translator request handling (`d3dd868`).

# v0.2.36 (2026-01-19)

## Features
- Added the Usage dashboard page and related usage stats components (`3804357`).
- Integrated outbound proxy support in Open SSE fetch pipeline (`0943387`).
- Improved OpenAI compatibility and build stability across endpoint/profile/providers flows (`d9b8e48`).

## Fixes
- Fixed combo fallback behavior (`e6ca119`).
- Resolved SonarQube findings, Next.js image warnings, and build/lint cleanups (`7058b06`, `0848dd5`).

# v0.2.31 (2026-01-18)

## Fixes
- Fixed Kiro token refresh and executor behavior (`6b22b1f`, `1d481c2`).
- Fixed Kiro request translation handling (`eff52f7`, `da15660`).

# v0.2.27 (2026-01-15)

## Features
- Added Kiro provider support with OAuth flow (`26b61e5`).

## Fixes
- Fixed Codex provider behavior (`26b61e5`).

# v0.2.21 (2026-01-12)

## Changes
- README updates.
- Antigravity bug fixes.
