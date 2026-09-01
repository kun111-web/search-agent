# Search Agent

[![test](https://github.com/kun111-web/search-agent/actions/workflows/test.yml/badge.svg)](https://github.com/kun111-web/search-agent/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A desktop browser that watches pages for you. Keep a few sites open; it picks up new items, asks a language model which ones are worth reading, and files the keepers by day. Shrink the window to a floating orb on the screen edge — new items appear beside it.

- **Collect**: A live probe watches the DOM. Up to two tabs at once, each with its own quota and retries, so one dead site does not stall the other.
- **Filter**: Items go to the model in batches. Judgments are cached per model, so the same item is not paid for twice. If the primary model drops, a fallback takes over.
- **Archive**: Keepers are stored as daily JSONL, one copy per item. Export as Markdown, CSV, or JSON.
- **Orb**: Draggable, resizable, remembers the last size. A two-line status bar shows collection on top and the model below.

## Getting started

Node.js 18 or later.

```bash
npm install
npm start
```

Build a Windows installer:

```bash
npm run dist
```

## Configure a model first

The source ships with **no API URL, model name, or API key**. Open the app, go to the Collect panel on the right → Settings, and fill in all three:

| Field | Notes |
| --- | --- |
| API Base URL | Stop at `/v1`, e.g. `https://api.example.com/v1`. A full path is also fine — the app will not append the suffix twice. |
| Model | The model id from your provider's docs. |
| API Key | Encrypted on disk with Windows DPAPI, bound to the current Windows account. |

A model is only used when all three are set. Leave any one blank and that model stays out of filtering.

### Two API formats

Providers do not all speak the same request shape. Pick the format that matches yours:

| | `chat` | `responses` |
| --- | --- | --- |
| Path | `{base}/chat/completions` | `{base}/responses` |
| Prompt | Everything in `messages` | System text in `instructions`, the rest in `input` |
| Reply | `choices[0].message.content` | Walk the `output` array for `output_text` |

If you are unsure, start with `chat` — most providers accept it. The wrong format comes back as a 4xx; Settings → Test connection will show it immediately.

Two details on `responses`: the text is not guaranteed to sit at `output[0]` (reasoning and tool-call items often come first), so the client walks the array. That API also stores each turn on the server by default; this app sets `store: false` so collected content is not left on someone else's machine.

### Fallback model

Fill in a second set and it becomes the fallback. The app switches on network errors, rate limits, a bad key, or a bad model name. The switch sticks — it will not burn a 60-second timeout on every batch — and retries the primary after a 5-minute cooldown. Each model picks its own format; they do not have to match.

A reply that is not usable JSON does not trigger a switch. The other provider would likely fail the same way, and that would waste another batch of tokens.

## Default sites

`electron/default-sites.js` starts empty. To open your usual sites on launch, add them:

```js
const DEFAULT_SITES = [
  { url: "https://example.com/", label: "Site name" },
];
```

Those pages open automatically and are checked in the collect panel, so you can hit Start collect right away. Leave the list empty and you get a blank tab; pages you open yourself can still be checked for collection.

## Where data lives

Everything sits in Electron's userData directory (`%APPDATA%\Search Agent\` on Windows):

| File | Contents |
| --- | --- |
| `agent-settings.json` | Settings; the key is stored encrypted |
| `pool/*.jsonl` | Collection pool — raw items not yet filtered |
| `archive/*.jsonl` | Daily archive of keepers |
| `filter-cache.json` | Model judgment cache |
| `session.json` | Tabs that were open last time |

The source tree never holds runtime data.

## Tests

```bash
npm test
```

Seven suites, 141 cases. Six run inside Electron (they need `app`, `safeStorage`, and the like); one is plain Node:

| Suite | Covers |
| --- | --- |
| `api-format-test.js` | Request body, path, and reply parsing for both API formats, including a primary and fallback that use different formats (local HTTP server stands in for the model) |
| `bugfix-test.js` | Cache partitioning, error kinds, restart after stop, probe teardown, per-site quotas, corrupt settings, orb geometry |
| `dedup-fix-test.js` | Dedup fingerprints and archive format migration |
| `orb-render-test.js` | Orb scroll position, new-item highlight, mouse pass-through |
| `picks-render-test.js` | Collect-panel checkbox list rebuilds |
| `retry-pace-test.js` | Disconnect backoff pacing and reconnect status |
| `scrape-flow-test.js` | The full path from collect to archive |

On Windows, turn on logging to see Electron suite output:

```powershell
$env:ELECTRON_ENABLE_LOGGING="1"
npx electron bugfix-test.js
```

## Layout

```
electron/            Main process
  main.js            Entry: windows, IPC, startup cleanup
  tabs.js            Tabs and probe injection
  live-probe.js      Probe script injected into the page
  orb.js             Floating orb window
  default-sites.js   Sites opened on a blank launch (empty by default)
  agent/
    scraper.js       Collect loop: polling, quotas, retries, backoff
    llm.js           Model HTTP calls — both API formats live here
    model-pool.js    Primary / fallback switching
    filter.js        Filtering and judgment cache
    archive.js       Daily archive
    settings.js      Settings I/O and key encryption
    dedup.js         Dedup fingerprints
src/                 Renderer: browser chrome, collect panel, orb UI
bundle/              Scripts that pack the installer plus a local config import
```

The script under `bundle/` embeds a **plaintext copy of the key on this machine** into an import script, so you can set up another of your own PCs. Do not hand that folder to anyone who should not see the key.

## License

MIT
