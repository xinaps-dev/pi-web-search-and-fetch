# pi-web-scout 🌐⚡

[![npm version](https://img.shields.io/npm/v/pi-web-scout?color=blue&logo=npm)](https://www.npmjs.com/package/pi-web-scout)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://pi.dev)

> **Empower your [pi](https://pi.dev) coding agent with real-time web intelligence: instant neural search, clean Markdown page extraction, and autonomous deep research.**

`pi-web-scout` transforms your **pi** coding agent into an autonomous web researcher. Say goodbye to outdated training cutoffs and missing documentation — equip your LLM with enterprise-grade web search, high-fidelity webpage retrieval, and multi-query deep synthesis. Built with a modular multi-provider engine, an interactive `/ws` terminal dashboard, and seamless zero-conflict integration with `pi-requesty-provider`.

---

## ⚡ Superpowers & Features

- 🔍 **Real-Time Neural Web Search (`web_search`)** — Search the live web with semantic and category filtering (`news`, `github`, `research paper`, `pdf`, `company`, `tweet`, `financial report`) to break past knowledge cutoffs.
- 📄 **High-Fidelity Web Fetch (`web_fetch`)** — Instantly retrieve live documentation, articles, and repositories, converting raw HTML into clean, token-optimized Markdown.
- 🧠 **Autonomous Deep Research (`web_deep_search`)** — Multi-angle iterative exploration that executes parallel queries and synthesizes multi-source findings for complex inquiries.
- 🎛️ **Interactive TUI Control Hub (`/ws`)** — Full-featured terminal dashboard to toggle tools on the fly, switch provider backends, and configure API keys with smooth keyboard controls.
- 🚀 **Zero-Config Instant Start** — Works immediately out of the box with Exa's public MCP endpoint (no API key required) or plug in your own `EXA_API_KEY` for unlimited bandwidth and deep search.
- 🔌 **Decoupled Multi-Provider Architecture** — Independent capability interfaces (`SearchProvider`, `FetchProvider`, `DeepSearchProvider`). Mix and match providers freely or implement custom engines with minimal boilerplate.
- 🤝 **Smart `pi-requesty-provider` Synergy** — Automatically coordinates with `pi-requesty-provider` to detect native server-side search models, preventing duplicate searches while keeping markdown extraction active.
- 🔒 **Secure Credential Management** — Stores API keys safely in `~/.pi/agent/auth.json` with strict `0o600` file permissions.

---

## 🚀 Quick Installation

### From npm (Recommended)

```bash
pi install npm:pi-web-scout
```

### From GitHub

```bash
pi install git:github.com/xinaps-dev/pi-web-scout
```

### Local Development

```bash
# Clone and build
git clone https://github.com/xinaps-dev/pi-web-scout.git
cd pi-web-scout
pnpm install

# Run locally in pi
pi -e ./
```

---

## 🎮 Getting Started & The `/ws` Control Hub

Managing your web tools is effortless with the unified `/ws` command.

### Interactive Hub Dashboard

Run `/ws` inside `pi` to open the interactive TUI Control Panel:

```text
┌───────────────────────────────────────────────────────────┐
│  🌐 Web Scout - Control Panel                             │
├───────────────────────────────────────────────────────────┤
│  [✓] Search (web_search)          : ON  (Provider: exa)   │
│  [✓] Fetch (web_fetch)           : ON  (Provider: exa)   │
│  [ ] Deep Search (deep)          : OFF (Provider: exa)   │
│                                                           │
│  Actions:                                                 │
│  > Assign Providers (3-tool wizard)                       │
│  > Configure Active Provider (Exa API Key / Mode)         │
│  > View Detailed Status                                   │
│  > Exit                                                   │
└───────────────────────────────────────────────────────────┘
```

- **Navigate:** Use `↑` / `↓` arrow keys to browse options.
- **Toggle / Select:** Press `Space` or `Enter` to toggle tools or trigger configuration wizards.
- **Close:** Press `Esc` or select `Exit`.

---

## 🛠️ Standardized LLM Tools

`pi-web-scout` registers 3 powerful tools with the Pi agent harness:

### 1. `web_search` *(Enabled by default)*
Performs real-time web searches and returns structured results with titles, URLs, snippets, publication dates, and citations.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `query` | `string` | **Yes** | Search keywords or natural language question |
| `numResults` | `number` | No | Number of results to return (default: `8`) |
| `category` | `string` | No | Content category (`company`, `research paper`, `news`, `github`, `pdf`, `tweet`, `financial report`) |

### 2. `web_fetch` *(Enabled by default)*
Fetches full web page content from a known URL and converts it into clean, LLM-ready Markdown.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | **Yes** | Full HTTP/HTTPS URL to retrieve |
| `maxCharacters` | `number` | No | Maximum character limit for extracted text (default: `15,000`) |

### 3. `web_deep_search` *(Optional)*
Agentic multi-query web search for complex questions requiring parallel queries and comprehensive multi-source synthesis.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `query` | `string` | **Yes** | Primary research question |
| `numResults` | `number` | No | Results per query (default: `10`) |
| `category` | `string` | No | Content filter category |
| `additionalQueries`| `string[]` | No | Supplementary parallel sub-queries |

---

## ⚙️ Configuration & Key Storage

### Extension Configuration: `~/.pi/agent/pi-web-scout.json`

Persistent settings are stored cleanly in your agent directory:

```json
{
  "search": {
    "enabled": true,
    "provider": "exa"
  },
  "fetch": {
    "enabled": true,
    "provider": "exa"
  },
  "deepSearch": {
    "enabled": false,
    "provider": "exa"
  },
  "providers": {
    "exa": {
      "useApiKey": true
    }
  }
}
```

### Authentication & API Keys: `~/.pi/agent/auth.json`

API keys are read and stored using Pi's standard authentication store (`~/.pi/agent/auth.json`) with strict `0o600` file permissions:

```json
{
  "exa": {
    "type": "api_key",
    "key": "your-exa-api-key-here"
  }
}
```

**Key Resolution Hierarchy for Exa:**
1. **Public MCP Tier:** If `useApiKey: false`, uses Exa's public endpoint (free, no key required).
2. **Authenticated Tier:** If `useApiKey: true`:
   - Checks `~/.pi/agent/auth.json` (`exa.key`).
   - Falls back to `EXA_API_KEY` environment variable.

---

## 🧩 Provider Architecture

`pi-web-scout` is designed with a fully decoupled capability model:

```text
┌────────────────────────────────────────────────────────┐
│                   ProviderRegistry                     │
├────────────────────────────────────────────────────────┤
│  SearchProvider      │  FetchProvider   │ DeepSearch   │
│  - exa               │  - exa           │ - exa        │
│  - (custom search)   │  - (custom fetch)│ - (custom)   │
└────────────────────────────────────────────────────────┘
```

### Implementing a Custom Provider

Easily create and register custom providers conforming to `ProviderModule`:

```typescript
import type {
  ProviderModule,
  SearchProvider,
  FetchProvider,
  DeepSearchProvider,
  SearchResponse,
  FetchResponse,
} from "pi-web-scout";

export const myCustomProvider: ProviderModule = {
  id: "custom",
  name: "My Custom Provider",
  description: "Custom web search and scraper",
  capabilities: ["search", "fetch"],

  searchProvider: {
    id: "custom",
    name: "My Custom Provider",
    description: "Search via Custom API",
    supportsApiKey: true,
    requiresApiKey: true,
    async search(query, options, signal): Promise<SearchResponse> {
      // Implement search logic...
      return {
        query,
        provider: "custom",
        results: [
          { title: "Example", url: "https://example.com", snippet: "..." }
        ],
      };
    },
  },

  fetchProvider: {
    id: "custom",
    name: "My Custom Provider",
    description: "Fetch via Custom Scraper",
    supportsApiKey: false,
    requiresApiKey: false,
    async fetch(url, options, signal): Promise<FetchResponse> {
      // Implement fetch logic...
      return {
        url,
        provider: "custom",
        content: "# Example Page Content\n\n...",
      };
    },
  },
};
```

---

## 🤝 `pi-requesty-provider` Smart Synergy

When used alongside [`pi-requesty-provider`](https://github.com/xinaps-dev/pi-requesty-provider):
1. `pi-web-scout` inspects `~/.pi/agent/pi-requesty.json` and evaluates the active session model on `session_start` and `model_select`.
2. If Requesty has native search enabled (`nativeSearch: true`) in `pi-requesty-provider` and the active model supports server-side search grounding, `pi-web-scout` automatically suppresses `web_search` to prevent duplicate web queries and token waste.
3. `web_fetch` remains **fully active**, allowing your agent to extract and inspect complete web pages on demand.

---

## 🧪 Development & Testing

```bash
# Run all unit and integration tests
pnpm test

# Run TypeScript typecheck
pnpm typecheck
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE) © [xinaps](https://github.com/xinaps-dev).
