'use strict';

const { resolveRef } = require('./config');

// Resolve a provider's apiKeys array (env refs + literals) into concrete keys.
function resolveKeys(apiKeys) {
  const arr = Array.isArray(apiKeys) ? apiKeys : apiKeys ? [apiKeys] : [];
  const out = [];
  for (const entry of arr) {
    const k = resolveRef(entry);
    if (k) out.push(k);
  }
  return out;
}

/**
 * Holds the configured providers and decides which one handles a given model.
 * Also does simple round-robin rotation across multiple keys for one provider.
 */
class ProviderPool {
  constructor(config) {
    this.defaultProvider = config.defaultProvider;
    this.rules = (config.routing && config.routing.rules) || [];
    this.providers = {};
    for (const [name, p] of Object.entries(config.providers || {})) {
      this.providers[name] = {
        name,
        baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
        version: p.version,
        models: Array.isArray(p.models) ? p.models : [],
        keys: resolveKeys(p.apiKeys),
        _rr: 0,
      };
    }
    // Pre-compile routing regexes once.
    this._compiledRules = this.rules
      .map((r) => {
        try { return { re: new RegExp(r.match, 'i'), provider: r.provider }; }
        catch { return null; }
      })
      .filter(Boolean);
  }

  has(name) { return Object.prototype.hasOwnProperty.call(this.providers, name); }
  get(name) { return this.providers[name]; }
  list() { return Object.values(this.providers); }

  /** Next key for a provider (round-robin), or null if none configured. */
  nextKey(name) {
    const p = this.providers[name];
    if (!p || p.keys.length === 0) return null;
    const key = p.keys[p._rr % p.keys.length];
    p._rr = (p._rr + 1) % p.keys.length;
    return key;
  }

  /**
   * Decide the provider + upstream model name for a requested model.
   * Precedence: explicit "provider/model" prefix → routing rules → model lists → default.
   */
  resolve(model) {
    let providerName = null;
    let realModel = model;

    if (typeof model === 'string' && model.includes('/')) {
      const slash = model.indexOf('/');
      const prefix = model.slice(0, slash);
      if (this.has(prefix)) {
        providerName = prefix;
        realModel = model.slice(slash + 1);
      }
    }

    if (!providerName && typeof model === 'string') {
      for (const rule of this._compiledRules) {
        if (rule.re.test(model)) { providerName = rule.provider; break; }
      }
    }

    if (!providerName) {
      for (const p of this.list()) {
        if (p.models.includes(model)) { providerName = p.name; break; }
      }
    }

    if (!providerName || !this.has(providerName)) providerName = this.defaultProvider;

    return { providerName, provider: this.providers[providerName] || null, model: realModel };
  }
}

module.exports = { ProviderPool, resolveKeys };
