'use strict';

const fs = require('fs');
const path = require('path');

// Built-in defaults. A user config file is deep-merged on top, then a few
// well-known environment variables override the result.
const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  logLevel: 'info',
  apiKey: '', // if set, clients must authenticate to the bridge with this token
  defaultProvider: 'anthropic',
  providers: {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKeys: ['env:OPENAI_API_KEY'],
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3', 'o4-mini'],
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeys: ['env:ANTHROPIC_API_KEY'],
      version: '2023-06-01',
      models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    },
    // Zhipu / Z.ai GLM models — OpenAI-compatible. Use the coding-plan base
    // URL "https://api.z.ai/api/coding/paas/v4" instead if you're on that plan,
    // or "https://open.bigmodel.cn/api/paas/v4" for the mainland-China endpoint.
    glm: {
      baseUrl: 'https://api.z.ai/api/paas/v4',
      apiKeys: ['env:GLM_API_KEY'],
      models: ['glm-4.6', 'glm-4.5', 'glm-4.5-flash'],
    },
    // Moonshot AI "Kimi" models — OpenAI-compatible. Swap to the mainland-China
    // endpoint "https://api.moonshot.cn/v1" if your key was issued there. Either
    // MOONSHOT_API_KEY (Moonshot's own name) or KIMI_API_KEY works.
    kimi: {
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKeys: ['env:MOONSHOT_API_KEY', 'env:KIMI_API_KEY'],
      models: ['kimi-k2-0905-preview', 'kimi-k2-0711-preview', 'kimi-latest', 'moonshot-v1-128k'],
    },
  },
  routing: {
    rules: [
      { match: '^(gpt-|o[0-9]|chatgpt)', provider: 'openai' },
      { match: '^claude', provider: 'anthropic' },
      { match: '^glm', provider: 'glm' },
      { match: '^(kimi|moonshot)', provider: 'kimi' },
    ],
  },
  injection: {
    enabled: false,
    systemMode: 'prepend', // prepend | append | replace
    system: '',
    depth: [], // [{ role: 'user', content: '...', depth: 2 }]
  },
  anthropic: {
    promptCaching: true,
    defaultMaxTokens: 4096,
  },
  cacheRefresh: {
    enabled: true,
    intervalMinutes: 4.5,
    maxRefreshes: 3,
    maxTokens: 1,
    maxChats: 5,
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge plain objects; arrays and scalars from `over` replace `base`.
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

// Resolve an "env:NAME" reference to its environment value; pass literals through.
// Returns null if an env reference is unset/empty.
function resolveRef(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('env:')) {
    const v = process.env[value.slice(4)];
    return v && v.trim() ? v.trim() : null;
  }
  return value.trim() ? value.trim() : null;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Load configuration.
 * @param {object} [opts]
 * @param {string} [opts.configPath] explicit path to a JSON config file
 * @param {object} [opts.overrides] values applied last (e.g. from CLI flags)
 * @returns {object} resolved config
 */
function loadConfig(opts = {}) {
  let config = clone(DEFAULTS);

  const configPath = opts.configPath || process.env.LLM_BRIDGE_CONFIG || findDefaultConfig();
  if (configPath && fs.existsSync(configPath)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to parse config file "${configPath}": ${e.message}`);
    }
    config = deepMerge(config, raw);
    config._configPath = configPath;
  }

  // Environment overrides for common top-level settings.
  if (process.env.PORT) config.port = parseInt(process.env.PORT, 10) || config.port;
  if (process.env.HOST) config.host = process.env.HOST;
  if (process.env.LOG_LEVEL) config.logLevel = process.env.LOG_LEVEL;

  // CLI overrides (highest precedence).
  if (opts.overrides) config = deepMerge(config, opts.overrides);

  // Resolve the bridge's own auth key (may be an env: reference).
  config.apiKey = resolveRef(config.apiKey) || '';

  return config;
}

// Look for a config file in the current working directory.
function findDefaultConfig() {
  const candidates = ['llm-bridge.config.json', 'llm-bridge-cache.config.json'];
  for (const c of candidates) {
    const p = path.resolve(process.cwd(), c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = { loadConfig, DEFAULTS, resolveRef, deepMerge };
