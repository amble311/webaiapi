# webaiapi (command: `webapi`)

[中文文档](https://github.com/amble311/webaiapi/blob/main/README.md) | **English**

Wrap an **AI chat web UI** (currently **ChatGLM**) into an **OpenAI-compatible API**.
Pure browser automation (Playwright Firefox) — **no API key, no reverse-engineered signatures**.
You just log in once, in a real browser window.

Use it from any OpenAI-protocol client (CodeBuddy, Trae, Cursor, any SDK) and spend your
existing web account quota instead of paying per token.

---

## Install

```bash
npm i -g webaiapi
```

The browser (Playwright Firefox, ~80 MB) is downloaded **automatically — no manual step**:

- `postinstall` tries once at install time;
- ⚠️ **npm 11+ blocks lifecycle scripts by default**, so on the first run of
  `webapi start` / `webapi login` / `webapi doctor` it checks again and installs it on demand;
- you only need the manual command below if your network policy blocks the download, or if you
  set `WEBAIAPI_SKIP_BROWSER_INSTALL` / `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`:

```bash
npx playwright install firefox
```

Then log in and capture the credentials (a visible browser opens; you log in by hand):

```bash
webapi login
```

Without arguments it asks **interactively** which platform (`↑/↓` + Enter, or type the number),
then whether to add an account or re-login. Skip the menu by naming the platform:
`webapi login chatglm`.

> Not sure your environment is OK? Run the self-check:

```bash
webapi doctor
```

It checks the Node version, the Firefox binary, credentials and the port, and prints
copy-pasteable fixes.

> **Skip the automatic download**: set `WEBAIAPI_SKIP_BROWSER_INSTALL=1` (or Playwright's own
> `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`). Common in CI.

## Start

```bash
webapi start
```

The server listens on `http://0.0.0.0:8631` by default; the OpenAI-compatible endpoints live under `/v1`:

```bash
# health check
curl -s http://localhost:8631/v1/health

# chat (non-streaming)
curl -s -X POST http://localhost:8631/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatglm","messages":[{"role":"user","content":"hello"}]}'

# streaming
curl -N -X POST http://localhost:8631/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatglm","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

In your client set the base URL to `http://localhost:8631/v1`, put any string as the API key
(when key checking is disabled), and use `chatglm` or `mix` as the model name.

## Commands

| Command | Description |
|---|---|
| `webapi start` | Start the server (foreground, Ctrl-C to quit) |
| `webapi doctor` | Self-check: Node / Firefox / credentials / port |
| `webapi status` | Runtime state: accounts, roles, auxiliary channel, request pool |
| `webapi accounts` | Accounts and roles only (the authoritative view for multi-account) |
| `webapi health` | Per-platform login status |
| `webapi login [<platform>] [--account <id>]` | Log in and capture credentials (interactive if no args) |
| `webapi logout [<platform>] [--account <id>]` | Delete an account's credentials (interactive if no args) |

Non-interactive usage for scripts / CI (`--yes` skips the confirmation):

```bash
webapi login chatglm --account acc2 --yes
webapi logout chatglm --account acc2 --yes
```

## Models

| Model | Description |
|---|---|
| `mix` | Pick any available platform automatically (currently chatglm) |
| `chatglm` | Platform-level model: rotates accounts, never switches platform |
| `glm-4` / `glm-3` | Concrete ChatGLM model aliases |

## Multiple accounts (optional, recommended)

With a second account the server enables the **auxiliary channel**: background work
(history compaction, tool-call conversion) runs on a separate page under the other account and
truly runs **in parallel** with your main conversation instead of queueing behind it.

Run `webapi login` again and pick “add a new account”. **Account names are derived from the
logged-in identity** (username → uid), so you don't invent them:

```bash
webapi login
#   Which platform?        → ChatGLM
#   What do you want to do? → ➕ Add a new account
#   ...log in with the other account...
#   ✔ credentials saved    account: alice
```

You can always back out: the second-level menu has `← Back (choose platform again)` and the
platform menu has `✗ Quit`; `Esc` / `Ctrl+C` cancel at any time.
(When you name the platform explicitly, `webapi login <platform>`, the menu offers `✗ Cancel` —
there is no previous step to return to.)

> ⚠️ **The two accounts must belong to different people.** The system browser very likely still
> holds the previous account's session; if it captures the same identity, the server would think
> it has two accounts, run both channels in parallel against one account, and immediately get
> “please wait for the other conversation to finish”. That is why it **verifies the identity and
> cookies**:
> - same session as an existing account → it asks you to *update that account / save as a new one / cancel*;
> - non-interactively (scripts) it **updates the existing account** and never silently creates a duplicate.

Check identities and role assignment with `webapi accounts`. The main/aux roles are assigned
**randomly at startup** to spread quota usage; pin them with an environment variable:

```bash
CHATGLM_MAIN_ACCOUNT=acc2 webapi start
```

## Configuration

Put these in a `.env` in the project directory, or pass them as environment variables:

| Variable | Default | Description |
|---|---|---|
| `API_HOST` / `API_PORT` | `0.0.0.0` / `8631` | Listen address and port |
| `API_PREFIX` | `/v1` | Route prefix |
| `REQUEST_TIMEOUT` | `300` | Request timeout (seconds) |
| `RATE_LIMIT_ENABLED` | `false` | Enable rate limiting |
| `RATE_LIMIT_PER_MINUTE` | `60` | Requests per client per minute |
| `API_KEYS` | empty | Comma-separated key list |
| `API_KEY_REQUIRED` | `false` | **Enforce** key checking (only effective once keys are set) |
| `DEBUG_LOGS` | `false` | Write `~/.ai-api/logs/debug_*.log` |
| `AUTH_DIR` | `~/.ai-api/auth` | Credentials directory |
| `LOG_DIR` | `logs` | Runtime logs and API records |
| `CHATGLM_MAIN_ACCOUNT` | random | Pin the main-channel account |
| `BROWSER_HEADLESS` | see implementation | `true` runs headless (for server deployments) |
| `WEBAIAPI_SKIP_BROWSER_INSTALL` | — | Set to 1 to skip the install-time browser download |

Credentials, the history database and debug logs all live under `~/.ai-api/`.

## FAQ

**“请求过于频繁，请稍后再试” (too many requests)**
Usually it means **you are not logged in** (the guest quota is exhausted). Log in again:
`webapi login chatglm`.

**The captured account is not the one I wanted**
The system browser often still holds the previous account's session. Log out on that page first,
then log in with the target account.

**The first conversation is slow (20s+)**
The first request has to launch the browser, navigate and probe the login state. Later requests
reuse the page and the preparation phase drops to 0–3s.

**The task stops halfway and files were not changed**
The web model sometimes writes a plan without calling any tool. The server automatically drives
one more round; if it keeps happening, split the task into smaller pieces (e.g. one file per request).

**How do I see what actually happened**
- `logs/api_requests.log` — requests/responses recorded **verbatim, unprocessed**; reset on every start
- `logs/chatglm_sse_last.txt` — the raw SSE stream of the most recent round (for diagnosing upstream format changes)

## Development

```bash
npm install        # builds automatically (the prepare script in package.json)
npm run dev        # run tsx src/cli.ts directly, no build needed
npm run typecheck
npm test
npm run build      # emits dist/
```

## License

MIT
