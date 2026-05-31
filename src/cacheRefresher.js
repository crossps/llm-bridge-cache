'use strict';

const logger = require('./logger');

/**
 * Cache Refresher — keeps a provider's prompt cache warm by replaying the last
 * request with max_tokens=1 on a timer.
 *
 * Anthropic's prompt cache has a ~5-minute TTL. If you pause longer than that,
 * the next real request re-pays full price to re-cache the whole prefix. This
 * module prevents that at negligible cost.
 *
 * Provider-agnostic: the server supplies a `sendKeepalive(minimalBody)` function
 * when it captures a request, so this class never needs to know how to talk to a
 * given backend. (Only providers with TTL'd prompt caches benefit — i.e. Anthropic.
 * OpenAI's automatic caching needs no keepalive, so the server simply doesn't arm
 * the refresher for it.)
 *
 * Multi-chat: each unique (model + system-prefix) gets its own independent cycle,
 * so concurrent conversations don't stomp on each other.
 *
 * Inspired by: https://github.com/OneinfinityN7/Cache-Refresh-SillyTavern
 */
class CacheRefresher {
  constructor(cfg = {}) {
    this.enabled = cfg.enabled !== false;
    this.intervalMs = Math.max(30, (parseFloat(cfg.intervalMinutes) || 4.5) * 60) * 1000;
    this.maxRefreshes = parseInt(cfg.maxRefreshes, 10) || 3;
    this.maxTokens = parseInt(cfg.maxTokens, 10) || 1;
    this.maxChats = parseInt(cfg.maxChats, 10) || 5;
    this.staleTtlMs = 30 * 60 * 1000;

    this.chats = new Map(); // fingerprint -> chat entry
    this.globalCycleId = 0;
    this.stats = { totalCycles: 0, successfulRefreshes: 0, failedRefreshes: 0, recent: [] };
  }

  logConfig() {
    if (!this.enabled) { logger.info('Cache Refresher: DISABLED'); return; }
    logger.info(`Cache Refresher: ENABLED - every ${(this.intervalMs / 1000).toFixed(0)}s, ` +
      `${this.maxRefreshes} pings/cycle, up to ${this.maxChats} chats`);
  }

  // djb2 hash of model + first 500 chars of system text -> 8 hex chars.
  _fingerprint(body) {
    const model = body.model || 'unknown';
    let systemText = '';
    if (typeof body.system === 'string') systemText = body.system;
    else if (Array.isArray(body.system)) systemText = body.system.map((b) => b.text || '').join('');
    systemText = systemText.slice(0, 500);
    let hash = 5381;
    const str = model + '::' + systemText;
    for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    return hash.toString(16).padStart(8, '0');
  }

  _label(body, fp) {
    const parts = (body.model || '??').split('-');
    return parts[parts.length - 1].slice(0, 8) + ':' + fp.slice(0, 4);
  }

  /**
   * Capture a successfully-processed upstream request and (re)start its cycle.
   * @param {object} upstreamBody  the provider request body (e.g. Anthropic Messages)
   * @param {(minimalBody: object) => Promise<{ok: boolean, status: number}>} sendKeepalive
   */
  capture(upstreamBody, sendKeepalive) {
    if (!this.enabled || typeof sendKeepalive !== 'function') return;

    let cloned;
    try { cloned = JSON.parse(JSON.stringify(upstreamBody)); }
    catch (e) { logger.warn('Cache Refresher: could not clone body:', e.message); return; }

    const fp = this._fingerprint(upstreamBody);
    const label = this._label(upstreamBody, fp);

    let chat = this.chats.get(fp);
    if (chat) {
      this._stop(chat);
      chat.body = cloned;
      chat.send = sendKeepalive;
      chat.lastActivity = Date.now();
    } else {
      this._evictStale();
      if (this.chats.size >= this.maxChats) this._evictStalest();
      chat = { fp, label, body: cloned, send: sendKeepalive, timer: null, left: 0, inProgress: false, nextAt: null, cycleId: 0, lastActivity: Date.now() };
      this.chats.set(fp, chat);
      logger.info(`Cache Refresher: [${label}] tracking new chat (${this.chats.size} active)`);
    }

    this.globalCycleId++;
    chat.cycleId = this.globalCycleId;
    chat.left = this.maxRefreshes;
    this._schedule(fp);
  }

  _schedule(fp) {
    const chat = this.chats.get(fp);
    if (!chat) return;
    if (!this.enabled || chat.left <= 0 || !chat.body) { this._stop(chat); return; }

    chat.nextAt = Date.now() + this.intervalMs;
    const cycleId = chat.cycleId;
    chat.timer = setTimeout(() => {
      const c = this.chats.get(fp);
      if (!c || c.cycleId !== cycleId) return;
      this._refresh(fp);
    }, this.intervalMs);
    if (chat.timer.unref) chat.timer.unref(); // never keep the process alive just for keepalives
  }

  async _refresh(fp) {
    const chat = this.chats.get(fp);
    if (!chat || !chat.body || chat.inProgress) return;
    chat.inProgress = true;
    const start = Date.now();
    let status = 0;
    let ok = false;

    try {
      const minimal = JSON.parse(JSON.stringify(chat.body));
      minimal.max_tokens = this.maxTokens;
      minimal.stream = false;
      delete minimal.thinking;
      logger.debug(`Cache Refresher: [${chat.label}] sending keepalive...`);
      const res = await chat.send(minimal);
      status = (res && res.status) || 0;
      ok = !!(res && res.ok);
      if (ok) logger.info(`Cache Refresher: [${chat.label}] keepalive ok (${chat.left - 1} left)`);
      else logger.warn(`Cache Refresher: [${chat.label}] keepalive failed (status ${status})`);
    } catch (e) {
      logger.error(`Cache Refresher: [${chat.label}] keepalive error: ${e.message}`);
    } finally {
      chat.inProgress = false;
      chat.left--;
      if (ok) this.stats.successfulRefreshes++; else this.stats.failedRefreshes++;
      this.stats.recent.push({ at: Date.now(), ok, status, ms: Date.now() - start, chat: chat.label });
      if (this.stats.recent.length > 20) this.stats.recent.shift();

      if (chat.left > 0) {
        this._schedule(fp);
      } else {
        this.stats.totalCycles++;
        logger.info(`Cache Refresher: [${chat.label}] cycle complete`);
        this._stop(chat);
      }
    }
  }

  _stop(chat) {
    if (chat.timer) { clearTimeout(chat.timer); chat.timer = null; }
    chat.nextAt = null;
    chat.inProgress = false;
  }

  _evictStale() {
    const now = Date.now();
    for (const [fp, chat] of this.chats) {
      if (now - chat.lastActivity > this.staleTtlMs) {
        this._stop(chat);
        this.chats.delete(fp);
        logger.info(`Cache Refresher: evicted stale chat ${chat.label}`);
      }
    }
  }

  _evictStalest() {
    let oldest = null, oldestTime = Infinity;
    for (const [fp, chat] of this.chats) {
      if (chat.lastActivity < oldestTime) { oldestTime = chat.lastActivity; oldest = fp; }
    }
    if (oldest) {
      const chat = this.chats.get(oldest);
      this._stop(chat);
      this.chats.delete(oldest);
      logger.info(`Cache Refresher: evicted oldest chat ${chat.label} to make room`);
    }
  }

  getStatus() {
    let active = false, refreshesLeft = 0, earliest = null;
    const chats = [];
    for (const [fp, c] of this.chats) {
      if (c.left > 0) active = true;
      refreshesLeft += c.left;
      if (c.nextAt && (!earliest || c.nextAt < earliest)) earliest = c.nextAt;
      chats.push({ fingerprint: fp, label: c.label, refreshesLeft: c.left, nextRefreshAt: c.nextAt ? new Date(c.nextAt).toISOString() : null, inProgress: c.inProgress });
    }
    return {
      enabled: this.enabled,
      active,
      activeChats: this.chats.size,
      refreshesLeft,
      nextRefreshAt: earliest ? new Date(earliest).toISOString() : null,
      intervalMs: this.intervalMs,
      maxRefreshes: this.maxRefreshes,
      stats: this.stats,
      chats,
    };
  }

  shutdown() {
    for (const chat of this.chats.values()) this._stop(chat);
    this.chats.clear();
  }
}

module.exports = CacheRefresher;
