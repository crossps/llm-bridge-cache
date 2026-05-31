'use strict';

const http = require('http');
const logger = require('./logger');
const { ProviderPool } = require('./providers');
const convert = require('./convert');
const { applyInjection } = require('./inject');
const CacheRefresher = require('./cacheRefresher');

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB (room for base64 images)

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function errObj(message, type = 'invalid_request_error', code = null) {
  return { error: { message, type, code } };
}

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON body: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req, config) {
  if (!config.apiKey) return true;
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m ? m[1] : req.headers['x-api-key'] || '';
  return token === config.apiKey;
}

// ---------------------------------------------------------------------------
// Anthropic SSE byte stream -> parsed event objects
// ---------------------------------------------------------------------------

async function forEachAnthropicEvent(stream, onEvent) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event;
      try { event = JSON.parse(payload); } catch { continue; }
      if (event && event.type) onEvent(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider handlers
// ---------------------------------------------------------------------------

// OpenAI is a near pass-through: the inbound request is already OpenAI-shaped.
async function handleOpenAI(ctx) {
  const { res, body, provider, key } = ctx;
  const url = provider.baseUrl + '/chat/completions';
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  if (!body.stream) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(text);
    return;
  }

  if (upstream.status !== 200 || !upstream.body) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(text);
    return;
  }
  res.writeHead(200, sseHeaders());
  res.flushHeaders && res.flushHeaders();
  for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
  res.end();
}

async function handleAnthropic(ctx) {
  const { res, body, provider, key, config, refresher } = ctx;
  const anthropicBody = convert.openaiToAnthropic(body, {
    defaultMaxTokens: (config.anthropic && config.anthropic.defaultMaxTokens) || 4096,
  });
  const caching = !config.anthropic || config.anthropic.promptCaching !== false;
  if (caching) convert.applyPromptCaching(anthropicBody);

  const url = provider.baseUrl + '/messages';
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': provider.version || '2023-06-01',
  };
  // Prompt caching is GA — no beta header needed; the cache_control fields in
  // the body are sufficient. (The old "prompt-caching-2024-07-31" beta flag is
  // obsolete and intentionally not sent.)

  const post = (payload) =>
    fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });

  // Arm the keepalive against this exact upstream request (Anthropic only).
  const arm = () => {
    if (!refresher.enabled || !caching) return;
    refresher.capture(anthropicBody, async (minimal) => {
      try {
        const r = await post(minimal);
        await r.text();
        return { ok: r.status === 200, status: r.status };
      } catch (e) { return { ok: false, status: 0, error: e.message }; }
    });
  };

  if (!body.stream) {
    const upstream = await post(anthropicBody);
    const text = await upstream.text();
    if (upstream.status !== 200) {
      res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(text);
      return;
    }
    let data;
    try { data = JSON.parse(text); } catch { return sendJson(res, 502, errObj('invalid JSON from upstream', 'upstream_error')); }
    sendJson(res, 200, convert.anthropicToOpenAI(data, body.model));
    arm();
    return;
  }

  // Streaming
  const upstream = await post({ ...anthropicBody, stream: true });
  if (upstream.status !== 200 || !upstream.body) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(text);
    return;
  }
  res.writeHead(200, sseHeaders());
  res.flushHeaders && res.flushHeaders();
  const translator = new convert.AnthropicStreamTranslator(body.model);
  await forEachAnthropicEvent(upstream.body, (event) => {
    for (const chunk of translator.handle(event)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  });
  res.write('data: [DONE]\n\n');
  res.end();
  arm();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleChatCompletions(req, res, deps) {
  const { config, pool, refresher } = deps;
  if (!checkAuth(req, config)) return sendJson(res, 401, errObj('invalid bridge API key', 'authentication_error'));

  let body;
  try { body = await readJson(req); }
  catch (e) { return sendJson(res, 400, errObj(e.message)); }
  if (!body || !Array.isArray(body.messages)) return sendJson(res, 400, errObj('"messages" array is required'));

  applyInjection(body, config.injection);

  const requested = body.model || config.defaultProvider;
  const { providerName, provider, model } = pool.resolve(requested);
  if (!provider) return sendJson(res, 400, errObj(`no provider configured for model "${requested}"`));

  const key = pool.nextKey(providerName);
  if (!key) {
    return sendJson(res, 401, errObj(
      `no API key configured for provider "${providerName}". Set it via env (e.g. ${providerName.toUpperCase()}_API_KEY) or in your config.`,
      'authentication_error'));
  }

  body.model = model; // upstream model (provider prefix stripped)
  const ctx = { req, res, body, provider, providerName, key, config, refresher };
  logger.info(`-> ${providerName}:${model}${body.stream ? ' (stream)' : ''}`);

  try {
    if (providerName === 'anthropic') await handleAnthropic(ctx);
    else await handleOpenAI(ctx);
  } catch (e) {
    logger.error(`upstream call failed (${providerName}):`, e.message);
    if (!res.headersSent) sendJson(res, 502, errObj(`upstream request failed: ${e.message}`, 'upstream_error'));
    else try { res.end(); } catch { /* ignore */ }
  }
}

function handleModels(res, pool) {
  const data = [];
  for (const p of pool.list()) {
    for (const id of p.models) {
      data.push({ id, object: 'model', created: 0, owned_by: p.name });
    }
  }
  sendJson(res, 200, { object: 'list', data });
}

function handleStatus(res, deps) {
  const { config, pool, refresher, startedAt } = deps;
  sendJson(res, 200, {
    service: 'llm-bridge-cache',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    defaultProvider: config.defaultProvider,
    providers: pool.list().map((p) => ({
      name: p.name,
      baseUrl: p.baseUrl,
      models: p.models.length,
      keysConfigured: p.keys.length, // count only — never the keys themselves
    })),
    injection: { enabled: !!(config.injection && config.injection.enabled) },
    cacheRefresh: refresher.getStatus(),
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createServer(config) {
  const deps = {
    config,
    pool: new ProviderPool(config),
    refresher: new CacheRefresher(config.cacheRefresh || {}),
    startedAt: Date.now(),
  };

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (req.method === 'GET' && url === '/status') return handleStatus(res, deps);
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) return handleModels(res, deps.pool);
    if (req.method === 'GET' && url === '/') {
      return sendJson(res, 200, {
        service: 'llm-bridge-cache',
        endpoints: ['POST /v1/chat/completions', 'GET /v1/models', 'GET /status', 'GET /health'],
      });
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
      return handleChatCompletions(req, res, deps).catch((e) => {
        logger.error('handler error:', e);
        if (!res.headersSent) sendJson(res, 500, errObj('internal error', 'internal_error'));
      });
    }

    sendJson(res, 404, errObj(`unknown route: ${req.method} ${url}`, 'not_found'));
  });

  server.deps = deps;
  server.refresher = deps.refresher;
  server.pool = deps.pool;
  return server;
}

module.exports = { createServer };
