'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const logger = require('../src/logger');
const { createServer } = require('../src/server');
const convert = require('../src/convert');
const { applyInjection } = require('../src/inject');
const { ProviderPool } = require('../src/providers');
const CacheRefresher = require('../src/cacheRefresher');

logger.setLevel('silent');

// --- A mock upstream that mimics OpenAI and Anthropic endpoints ---
let mock, mockPort, bridge, bridgePort;
const captured = {}; // path -> last { headers, body }

const OPENAI_REPLY = {
  id: 'chatcmpl-mock', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from GPT' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const ANTHROPIC_REPLY = {
  id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-mock',
  content: [{ type: 'text', text: 'Hello from Claude' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
};

const OPENAI_RESPONSES_REPLY = {
  id: 'resp_mock', object: 'response', model: 'gpt-4o',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello from Responses' }] }],
  usage: { input_tokens: 1, output_tokens: 1 },
};

const ANTHROPIC_SSE = [
  '{"type":"message_start","message":{"id":"msg_mock","model":"claude-mock","usage":{"input_tokens":10}}}',
  '{"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '{"type":"content_block_stop","index":0}',
  '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  '{"type":"message_stop"}',
];

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
  });
}

before(async () => {
  mock = http.createServer(async (req, res) => {
    const path = req.url;
    const body = await readBody(req);
    captured[path] = { headers: req.headers, body };

    if (path === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(OPENAI_REPLY));
      return;
    }
    if (path === '/v1/messages') {
      if (body && body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const d of ANTHROPIC_SSE) res.write(`event: x\ndata: ${d}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ANTHROPIC_REPLY));
      }
      return;
    }
    if (path === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(OPENAI_RESPONSES_REPLY));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockPort = mock.address().port;

  const config = {
    port: 0, host: '127.0.0.1', logLevel: 'silent', apiKey: '',
    defaultProvider: 'anthropic',
    providers: {
      openai: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKeys: ['test-openai-key'], models: ['gpt-4o'] },
      anthropic: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKeys: ['test-anthropic-key'], version: '2023-06-01', models: ['claude-sonnet-4-6'] },
      glm: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKeys: ['test-glm-key'], models: ['glm-4.6'] },
      kimi: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKeys: ['test-kimi-key'], models: ['kimi-k2-0905-preview'] },
    },
    routing: { rules: [{ match: '^gpt-', provider: 'openai' }, { match: '^claude', provider: 'anthropic' }, { match: '^glm', provider: 'glm' }, { match: '^(kimi|moonshot)', provider: 'kimi' }] },
    injection: { enabled: false },
    anthropic: { promptCaching: true, defaultMaxTokens: 1024 },
    cacheRefresh: { enabled: false },
  };
  bridge = createServer(config);
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  bridgePort = bridge.address().port;
});

after(async () => {
  await new Promise((r) => bridge.close(r));
  await new Promise((r) => mock.close(r));
});

function base() { return `http://127.0.0.1:${bridgePort}`; }

// --------------------------------------------------------------------------

test('GET /health returns ok', async () => {
  const r = await fetch(`${base()}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
});

test('GET /v1/models lists models from both providers', async () => {
  const r = await fetch(`${base()}/v1/models`);
  const j = await r.json();
  const ids = j.data.map((m) => m.id);
  assert.ok(ids.includes('gpt-4o'));
  assert.ok(ids.includes('claude-sonnet-4-6'));
});

test('OpenAI route: passthrough with Bearer auth', async () => {
  const r = await fetch(`${base()}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json();
  assert.equal(j.choices[0].message.content, 'Hello from GPT');
  const up = captured['/v1/chat/completions'];
  assert.equal(up.body.model, 'gpt-4o');
  assert.match(up.headers.authorization, /^Bearer test-openai-key$/);
});

test('GLM route: passthrough with its own key', async () => {
  const r = await fetch(`${base()}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4.6', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json();
  assert.equal(j.choices[0].message.content, 'Hello from GPT'); // mock OpenAI-compatible reply
  const up = captured['/v1/chat/completions'];
  assert.equal(up.body.model, 'glm-4.6');
  assert.match(up.headers.authorization, /^Bearer test-glm-key$/); // routed to GLM with GLM key
});

test('Kimi route: passthrough with its own key', async () => {
  const r = await fetch(`${base()}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kimi-k2-0905-preview', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json();
  assert.equal(j.choices[0].message.content, 'Hello from GPT'); // mock OpenAI-compatible reply
  const up = captured['/v1/chat/completions'];
  assert.equal(up.body.model, 'kimi-k2-0905-preview');
  assert.match(up.headers.authorization, /^Bearer test-kimi-key$/); // routed to Kimi with Kimi key
});

test('Anthropic route: converts request and response', async () => {
  const r = await fetch(`${base()}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }],
    }),
  });
  const j = await r.json();
  // Response converted back to OpenAI shape
  assert.equal(j.object, 'chat.completion');
  assert.equal(j.choices[0].message.content, 'Hello from Claude');
  assert.equal(j.choices[0].finish_reason, 'stop');
  // cache_read folded into prompt tokens + surfaced in details
  assert.equal(j.usage.prompt_tokens, 13); // 10 input + 3 cache_read
  assert.equal(j.usage.prompt_tokens_details.cached_tokens, 3);

  // Upstream received a proper Anthropic request
  const up = captured['/v1/messages'];
  assert.equal(up.headers['x-api-key'], 'test-anthropic-key');
  assert.equal(up.headers['anthropic-version'], '2023-06-01');
  assert.equal(up.body.messages[0].role, 'user'); // system was hoisted out
  assert.ok(up.body.max_tokens > 0);
  // System extracted into top-level system, with a cache breakpoint
  assert.ok(Array.isArray(up.body.system));
  assert.equal(up.body.system[0].text, 'SYS');
  assert.deepEqual(up.body.system[0].cache_control, { type: 'ephemeral' });
});

test('Anthropic route: streaming yields OpenAI chunks + [DONE]', async () => {
  const r = await fetch(`${base()}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
  const text = await r.text();
  assert.ok(text.includes('"role":"assistant"'));
  assert.ok(text.includes('"content":"Hello"'));
  assert.ok(text.includes('"content":" world"'));
  assert.ok(text.includes('"finish_reason":"stop"'));
  assert.ok(text.trimEnd().endsWith('data: [DONE]'));
});

// --------------------------------------------------------------------------
// Unit-level checks for the pure pieces

test('convert: openaiToAnthropic maps tools and roles', () => {
  const out = convert.openaiToAnthropic({
    model: 'claude-x',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get', arguments: '{"q":1}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'sunny' },
    ],
    tools: [{ type: 'function', function: { name: 'get', description: 'd', parameters: { type: 'object' } } }],
  }, { defaultMaxTokens: 100 });

  assert.equal(out.system, 'be brief');
  assert.equal(out.max_tokens, 100);
  assert.equal(out.tools[0].name, 'get');
  assert.equal(out.tools[0].input_schema.type, 'object');
  const toolUse = out.messages[1].content.find((b) => b.type === 'tool_use');
  assert.equal(toolUse.id, 't1');
  assert.deepEqual(toolUse.input, { q: 1 });
  const toolResult = out.messages[2].content.find((b) => b.type === 'tool_result');
  assert.equal(toolResult.tool_use_id, 't1');
});

test('inject: prepend system injection', () => {
  const body = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  applyInjection(body, { enabled: true, systemMode: 'prepend', system: 'INJECTED' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'INJECTED');
});

test('providers: routing precedence (prefix > rule > default)', () => {
  const pool = new ProviderPool({
    defaultProvider: 'anthropic',
    providers: { openai: { apiKeys: ['k'], models: [] }, anthropic: { apiKeys: ['k'], models: [] } },
    routing: { rules: [{ match: '^gpt-', provider: 'openai' }] },
  });
  assert.equal(pool.resolve('gpt-4o').providerName, 'openai');
  assert.equal(pool.resolve('claude-x').providerName, 'anthropic'); // default
  const explicit = pool.resolve('openai/o3');
  assert.equal(explicit.providerName, 'openai');
  assert.equal(explicit.model, 'o3');
});

test('cacheRefresher: capture arms a chat and keepalive fires', async () => {
  const refresher = new CacheRefresher({ enabled: true, maxRefreshes: 2 });
  let calls = 0;
  const body = { model: 'claude-x', system: 'big stable prefix', max_tokens: 500 };
  refresher.capture(body, async (minimal) => {
    calls++;
    assert.equal(minimal.max_tokens, 1); // keepalive minimizes tokens
    assert.equal(minimal.stream, false);
    return { ok: true, status: 200 };
  });

  const st = refresher.getStatus();
  assert.equal(st.activeChats, 1);
  assert.equal(st.refreshesLeft, 2);

  // Fire one keepalive manually (avoids waiting the 30s+ timer)
  const fp = refresher._fingerprint(body);
  await refresher._refresh(fp);
  assert.equal(calls, 1);
  assert.equal(refresher.stats.successfulRefreshes, 1);
  refresher.shutdown();
});

// --------------------------------------------------------------------------
// /v1/messages  (Anthropic-format inbound)

test('/v1/messages -> Anthropic passthrough + cache breakpoint added', async () => {
  const r = await fetch(`${base()}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json();
  assert.equal(j.type, 'message');
  assert.equal(j.content[0].text, 'Hello from Claude'); // passed through untouched

  const up = captured['/v1/messages'];
  assert.equal(up.headers['x-api-key'], 'test-anthropic-key');
  // Bridge added an ephemeral cache breakpoint to the last user message
  assert.ok(Array.isArray(up.body.messages[0].content));
  assert.deepEqual(up.body.messages[0].content[0].cache_control, { type: 'ephemeral' });
});

test('/v1/messages -> Anthropic streaming is relayed as Anthropic SSE', async () => {
  const r = await fetch(`${base()}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
  const text = await r.text();
  assert.ok(text.includes('text_delta'));   // native Anthropic event, not OpenAI chunk
  assert.ok(text.includes('message_stop'));
});

test('/v1/messages -> OpenAI cross-conversion returns Anthropic shape', async () => {
  const r = await fetch(`${base()}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 50, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json();
  assert.equal(j.type, 'message');
  assert.equal(j.content[0].text, 'Hello from GPT');
  assert.equal(j.stop_reason, 'end_turn');

  const up = captured['/v1/chat/completions'];
  assert.equal(up.body.messages[0].role, 'system');
  assert.equal(up.body.messages[0].content, 'be brief');
  assert.equal(up.body.messages[1].content, 'hi');
});

// --------------------------------------------------------------------------
// /v1/responses  (OpenAI Responses inbound)

test('/v1/responses -> OpenAI passthrough', async () => {
  const r = await fetch(`${base()}/v1/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', input: 'hi' }),
  });
  const j = await r.json();
  assert.equal(j.output[0].content[0].text, 'Hello from Responses');
  const up = captured['/v1/responses'];
  assert.match(up.headers.authorization, /^Bearer test-openai-key$/);
  assert.equal(up.body.input, 'hi');
});

test('/v1/responses -> Anthropic model returns a clear 400', async () => {
  const r = await fetch(`${base()}/v1/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', input: 'hi' }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.error.message, /\/v1\/messages|\/v1\/chat\/completions/);
});

// --------------------------------------------------------------------------
// Unit checks for the new converters

test('convert: anthropicToOpenAIRequest maps system, tools, tool_result', () => {
  const out = convert.anthropicToOpenAIRequest({
    model: 'gpt-4o', max_tokens: 100, system: 'sys',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'res' }] },
    ],
    tools: [{ name: 'get', description: 'd', input_schema: { type: 'object' } }],
  });
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[1].content, 'q');
  assert.equal(out.messages[2].tool_calls[0].function.name, 'get');
  assert.equal(out.messages[3].role, 'tool');
  assert.equal(out.messages[3].tool_call_id, 't1');
  assert.equal(out.tools[0].function.name, 'get');
});

test('convert: openAIToAnthropicResponse maps content and stop_reason', () => {
  const a = convert.openAIToAnthropicResponse({
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  }, 'gpt-4o');
  assert.equal(a.type, 'message');
  assert.equal(a.content[0].text, 'hello');
  assert.equal(a.stop_reason, 'max_tokens');
  assert.equal(a.usage.input_tokens, 4);
});

test('convert: OpenAIStreamToAnthropicTranslator emits valid event sequence', () => {
  const t = new convert.OpenAIStreamToAnthropicTranslator('gpt-4o');
  const events = [];
  for (const c of [
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { content: 'Hi' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]) events.push(...t.handle(c));
  events.push(...t.finish());
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'message_start');
  assert.ok(types.includes('content_block_start'));
  assert.ok(events.some((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta' && e.delta.text === 'Hi'));
  assert.ok(types.includes('content_block_stop'));
  assert.ok(events.some((e) => e.type === 'message_delta' && e.delta.stop_reason === 'end_turn'));
  assert.equal(types[types.length - 1], 'message_stop');
});
