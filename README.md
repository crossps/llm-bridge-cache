# LLM Bridge & Cache

> One OpenAI-compatible endpoint in front of **OpenAI**, **Anthropic**, **GLM (Z.ai)**, and **Kimi (Moonshot AI)** — with **prompt injection** and a **prompt-cache keepalive** that most proxies don't have.

[![npm version](https://img.shields.io/npm/v/llm-bridge-cache.svg)](https://www.npmjs.com/package/llm-bridge-cache)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![dependencies: none](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

`llm-bridge-cache` is a tiny, **zero-dependency** local server. Point any app that speaks the OpenAI Chat Completions API (SillyTavern, OpenCode, Cline, your own scripts) at it, and it routes each request to the right backend by model name — translating formats on the fly. **Bring your own keys; nothing is bundled.**

```
   OpenAI-compatible client                 LLM Bridge & Cache                upstream
  (SillyTavern / OpenCode / …) ──► POST /v1/chat/completions ──┬──► OpenAI   /v1/chat/completions
                                                               └──► Anthropic /v1/messages  (+ cache keepalive)
```

## Why it exists

- **One endpoint, many providers.** Stop reconfiguring your client every time you switch models. `gpt-4o` goes to OpenAI, `claude-sonnet-4-5` to Anthropic, `glm-4.6` to GLM (Z.ai), `kimi-k2-0905-preview` to Kimi (Moonshot AI) — automatically. Any OpenAI-compatible backend can be added by dropping in a `baseUrl`.
- **Prompt-cache keepalive** ⭐ Anthropic's prompt cache expires after ~5 minutes. Pause to think, and your next message re-pays full price to re-cache a huge system prompt. This bridge quietly replays the last request with `max_tokens=1` on a timer to keep the cache warm — saving up to ~90% on input tokens for long, stable prompts (RP cards, agent system prompts, big lorebooks).
- **Prompt injection.** Inject or override a system prompt, or insert messages at a chosen depth — without touching your client.
- **Zero dependencies, BYO key.** Pure Node standard library. Your keys live in your environment, never in the package.

## Features

| | |
|---|---|
| 🗣️ **Three inbound formats** | OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses — reply comes back in the format you sent. |
| 🔀 **Multi-provider routing** | Model-name rules, explicit `provider/model` syntax, and per-provider model lists. |
| 🔑 **Bring-your-own-key + rotation** | Read keys from env or config; list several to round-robin across them. |
| ♻️ **Prompt-cache keepalive** | Per-conversation, multi-chat, auto-evicting. Anthropic-aware. |
| 💉 **Prompt injection** | System prepend/append/replace + depth injection. |
| 🌊 **Streaming** | Full SSE streaming for both providers, translated to OpenAI chunks. |
| 🧰 **Tools & vision** | Function-calling and image inputs converted between formats. |
| 📊 **Status endpoint** | `/status` shows providers, cache-refresh activity, and usage — never your keys. |

## Accepted input formats

The bridge speaks **three** inbound API dialects, so almost any client works as-is. Each request is routed to a provider by model name; the reply comes back in the **same format you sent**.

| You send… | → Anthropic provider | → OpenAI provider |
|---|---|---|
| **`/v1/chat/completions`** (OpenAI Chat) | converted to Anthropic, response converted back | passthrough |
| **`/v1/messages`** (Anthropic Messages) | **passthrough** + prompt-cache breakpoints + keepalive | converted to OpenAI, response converted back |
| **`/v1/responses`** (OpenAI Responses) | *not yet — returns a clear 400* | passthrough |

So Claude Code / the Anthropic SDK can keep speaking Anthropic on `/v1/messages` (and finally get the cache keepalive), Codex / the Agents SDK can speak Responses on `/v1/responses`, and everything else uses `/v1/chat/completions`. Responses→Anthropic translation is on the [roadmap](https://github.com/crossps/llm-bridge-cache/issues/1).

## Quick start

Requires **Node ≥ 18.17**.

```bash
# 1. set your keys (bring your own)
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

# 2. run it (no install needed)
npx llm-bridge-cache
```

That's it — the bridge is now at `http://127.0.0.1:8787/v1`. Point your client there.

Prefer a config file?

```bash
npx llm-bridge-cache init       # writes ./llm-bridge.config.json
# edit it, then:
npx llm-bridge-cache
```

Global install also works: `npm i -g llm-bridge-cache` then `llm-bridge-cache` (or the short alias `llmbc`).

## Connect your client

Use base URL `http://127.0.0.1:8787/v1` and any non-empty API key (unless you set a bridge key — see below).

<details>
<summary><b>SillyTavern</b></summary>

API → Chat Completion → Custom (OpenAI-compatible).
- **Custom Endpoint:** `http://127.0.0.1:8787/v1`
- **API Key:** anything (e.g. `local`), unless you enabled a bridge key.
- **Model:** `claude-sonnet-4-5`, `gpt-4o`, etc.
</details>

<details>
<summary><b>OpenCode</b></summary>

Add a custom OpenAI-compatible provider pointing at the bridge:

```json
{
  "provider": {
    "bridge": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8787/v1" },
      "models": { "claude-sonnet-4-5": {}, "gpt-4o": {} }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code / Anthropic SDK (via /v1/messages)</b></summary>

Point the Anthropic base URL at the bridge — it accepts the native Messages format and adds the cache keepalive:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787   # SDK appends /v1/messages
```
The bridge forwards to Anthropic untouched (plus cache breakpoints + keepalive), or cross-converts to OpenAI if you target a `gpt-*` model.
</details>

<details>
<summary><b>Codex / OpenAI Agents SDK (via /v1/responses)</b></summary>

Set the OpenAI base URL to the bridge; the Responses API is passed through to OpenAI:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1   # SDK appends /responses
```
</details>

<details>
<summary><b>Generic / curl</b></summary>

```bash
# OpenAI Chat Completions in
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}'

# Anthropic Messages in
curl http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```
</details>

## Configuration

`llm-bridge-cache init` writes a `llm-bridge.config.json` you can edit. Every field is optional and overlays the built-in defaults.

```jsonc
{
  "port": 8787,
  "host": "127.0.0.1",
  "apiKey": "env:LLM_BRIDGE_API_KEY",   // require clients to send this; "" = open
  "defaultProvider": "anthropic",        // fallback when no rule matches

  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKeys": ["env:OPENAI_API_KEY"], // list several to round-robin
      "models": ["gpt-4o", "o3"]
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKeys": ["env:ANTHROPIC_API_KEY"],
      "version": "2023-06-01",
      "models": ["claude-opus-4-5", "claude-sonnet-4-5"]
    },
    "glm": {                                  // Zhipu / Z.ai — OpenAI-compatible
      "baseUrl": "https://api.z.ai/api/paas/v4",
      "apiKeys": ["env:GLM_API_KEY"],
      "models": ["glm-4.6", "glm-4.5", "glm-4.5-flash"]
    },
    "kimi": {                                 // Moonshot AI / Kimi — OpenAI-compatible
      "baseUrl": "https://api.moonshot.ai/v1",
      "apiKeys": ["env:MOONSHOT_API_KEY", "env:KIMI_API_KEY"],
      "models": ["kimi-k2-0905-preview", "kimi-k2-0711-preview", "kimi-latest", "moonshot-v1-128k"]
    }
  },

  "routing": {
    "rules": [
      { "match": "^(gpt-|o[0-9]|chatgpt)", "provider": "openai" },
      { "match": "^claude", "provider": "anthropic" },
      { "match": "^glm", "provider": "glm" },
      { "match": "^(kimi|moonshot)", "provider": "kimi" }
    ]
  },

  "injection": {
    "enabled": false,
    "systemMode": "prepend",             // prepend | append | replace
    "system": "",
    "depth": [{ "role": "user", "content": "(stay in character)", "depth": 1 }]
  },

  "anthropic": { "promptCaching": true, "defaultMaxTokens": 4096 },

  "cacheRefresh": {
    "enabled": true,
    "intervalMinutes": 4.5,              // < Anthropic's 5-min TTL
    "maxRefreshes": 3,                   // pings per cycle after each real turn
    "maxTokens": 1,
    "maxChats": 5
  }
}
```

- **Keys** can be `"env:VAR_NAME"` (read from the environment — recommended) or a literal string.
- **`baseUrl`** is overridable, so any OpenAI- or Anthropic-compatible gateway works too.
- **Routing** precedence: explicit `provider/model` (e.g. `openai/o3`) → first matching rule → provider `models` list → `defaultProvider`.

### How the cache keepalive works

After each real Anthropic turn, the bridge fingerprints the request (model + system prefix) and starts a per-conversation timer. Every `intervalMinutes` it replays that request with `max_tokens=1`, refreshing the cached prefix for pennies. It tracks several chats at once, stops after `maxRefreshes` pings of inactivity, and evicts stale conversations. OpenAI caches automatically (no keepalive needed), so the refresher is armed only for Anthropic.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions in (streaming + non-streaming). |
| `POST` | `/v1/messages` | Anthropic Messages in (streaming + non-streaming). |
| `POST` | `/v1/responses` | OpenAI Responses in (streaming + non-streaming). |
| `GET` | `/v1/models` | Lists configured models in OpenAI format. |
| `GET` | `/status` | Providers, cache-refresh activity, usage (no keys). |
| `GET` | `/health` | `{ "status": "ok" }`. |

## Securing the bridge

By default the bridge listens only on `127.0.0.1` and accepts any client key. To require auth, set `apiKey` (or `LLM_BRIDGE_API_KEY`); clients must then send `Authorization: Bearer <key>`. If you bind to `0.0.0.0`, set a bridge key.

## CLI

```
llm-bridge-cache [options]
llm-bridge-cache init                 # write a starter config

  -c, --config <path>    JSON config file
  -p, --port <n>         port (default 8787)
  -H, --host <addr>      host (default 127.0.0.1)
  -l, --log-level <lv>   trace|debug|info|warn|error
  -h, --help             help
  -v, --version          version
```

## Development

```bash
git clone https://github.com/crossps/llm-bridge-cache
cd llm-bridge-cache
node --test            # runs the smoke + unit suite (no API keys needed)
node bin/cli.js        # run locally
```

The test suite spins up a mock upstream, so it verifies routing, format conversion, streaming, prompt-cache breakpoints, and the keepalive without any real credentials.

## FAQ

**Does it store my keys?** No. Keys are read from your environment (or a config file you control) at runtime and used only for outbound requests. `/status` reports key *counts*, never values.

**Is this affiliated with OpenAI or Anthropic?** No. It's an independent, unofficial format bridge.

**Can I add more providers?** Anything OpenAI-compatible works today by adding a provider with its `baseUrl`. Native adapters for more backends are on the roadmap — PRs welcome.

## License

[MIT](LICENSE) © crossps
