'use strict';

// Translation between the OpenAI Chat Completions format and the Anthropic
// Messages format — requests, non-streaming responses, and streaming events.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p.type === 'text' ? p.text || '' : ''))
      .join('');
  }
  return content == null ? '' : String(content);
}

// OpenAI multimodal content parts -> Anthropic content blocks.
function convertContentParts(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
    } else if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text || '' });
    } else if (part.type === 'image_url' && part.image_url) {
      const url = part.image_url.url || '';
      const m = /^data:(.+?);base64,(.*)$/s.exec(url);
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else if (url) blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks;
}

function toBlocks(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

// Anthropic requires alternating roles; merge adjacent same-role messages.
function mergeConsecutive(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = toBlocks(last.content).concat(toBlocks(m.content));
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function mapToolChoice(tc) {
  if (tc === 'auto' || tc == null) return { type: 'auto' };
  if (tc === 'required') return { type: 'any' };
  if (tc === 'none') return { type: 'auto' }; // Anthropic has no "none"; closest no-op
  if (tc && tc.type === 'function' && tc.function) return { type: 'tool', name: tc.function.name };
  return { type: 'auto' };
}

function mapStopReason(reason) {
  switch (reason) {
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence': return 'stop';
    default: return reason ? 'stop' : null;
  }
}

function randId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 12);
}

// ---------------------------------------------------------------------------
// Request: OpenAI -> Anthropic
// ---------------------------------------------------------------------------

function convertMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: contentToText(m.content) };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && prev._toolBatch) {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block], _toolBatch: true });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const text = contentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.type !== 'function' || !tc.function) continue;
          let input = {};
          try { input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
          catch { input = {}; }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : '' });
      continue;
    }
    // user / function / anything else -> user
    const parts = convertContentParts(m.content);
    out.push({ role: 'user', content: parts.length ? parts : contentToText(m.content) });
  }
  for (const m of out) delete m._toolBatch;
  return mergeConsecutive(out);
}

function openaiToAnthropic(body, opts = {}) {
  const out = {
    model: body.model,
    max_tokens: body.max_tokens || body.max_completion_tokens || opts.defaultMaxTokens || 4096,
    messages: [],
  };

  const systemTexts = [];
  const convoMessages = [];
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') systemTexts.push(contentToText(m.content));
    else convoMessages.push(m);
  }
  if (systemTexts.length) out.system = systemTexts.filter(Boolean).join('\n\n');

  out.messages = convertMessages(convoMessages);

  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (typeof body.top_k === 'number') out.top_k = body.top_k;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream) out.stream = true;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t.type === 'function' && t.function)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      }));
    if (body.tool_choice) out.tool_choice = mapToolChoice(body.tool_choice);
  }

  return out;
}

// Add ephemeral cache_control breakpoints to the long, stable prefix: the end
// of the system prompt and the final user message. Cheap, big cache-hit win.
function applyPromptCaching(body) {
  if (typeof body.system === 'string' && body.system.length) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(body.system) && body.system.length) {
    body.system[body.system.length - 1].cache_control = { type: 'ephemeral' };
  }

  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length) {
    let idx = msgs.length - 1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { idx = i; break; }
    }
    const m = msgs[idx];
    if (typeof m.content === 'string') {
      m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(m.content) && m.content.length) {
      const lastBlock = m.content[m.content.length - 1];
      if (lastBlock && typeof lastBlock === 'object') lastBlock.cache_control = { type: 'ephemeral' };
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Response: Anthropic -> OpenAI (non-streaming)
// ---------------------------------------------------------------------------

function usageToOpenAI(usage = {}) {
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const input = (usage.input_tokens || 0) + cacheRead + cacheCreate;
  const output = usage.output_tokens || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

function anthropicToOpenAI(resp, model) {
  const blocks = resp.content || [];
  let text = '';
  const toolCalls = [];
  for (const b of blocks) {
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      });
    }
  }
  const message = { role: 'assistant', content: toolCalls.length && !text ? null : text };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: resp.id || randId('chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || resp.model,
    choices: [{ index: 0, message, finish_reason: mapStopReason(resp.stop_reason) || 'stop' }],
    usage: usageToOpenAI(resp.usage),
  };
}

// ---------------------------------------------------------------------------
// Response: Anthropic stream events -> OpenAI streaming chunks
// ---------------------------------------------------------------------------

class AnthropicStreamTranslator {
  constructor(model) {
    this.model = model;
    this.id = randId('chatcmpl-');
    this.created = Math.floor(Date.now() / 1000);
    this.roleSent = false;
    this.blocks = {}; // anthropic block index -> { type, toolIndex }
    this.toolCount = 0;
    this.finishReason = null;
    this.usage = null;
  }

  _chunk(delta, finish_reason = null) {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason }],
    };
  }

  _ensureRole(out) {
    if (!this.roleSent) {
      out.push(this._chunk({ role: 'assistant', content: '' }));
      this.roleSent = true;
    }
  }

  /** Translate one Anthropic event into zero or more OpenAI chunk objects. */
  handle(event) {
    const out = [];
    switch (event.type) {
      case 'message_start':
        if (event.message && event.message.model && !this.model) this.model = event.message.model;
        if (event.message && event.message.usage) this.usage = event.message.usage;
        break;
      case 'content_block_start': {
        const cb = event.content_block || {};
        this.blocks[event.index] = { type: cb.type };
        this._ensureRole(out);
        if (cb.type === 'tool_use') {
          const ti = this.toolCount++;
          this.blocks[event.index].toolIndex = ti;
          out.push(this._chunk({
            tool_calls: [{ index: ti, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }],
          }));
        }
        break;
      }
      case 'content_block_delta': {
        const d = event.delta || {};
        this._ensureRole(out);
        if (d.type === 'text_delta') {
          out.push(this._chunk({ content: d.text || '' }));
        } else if (d.type === 'input_json_delta') {
          const b = this.blocks[event.index] || {};
          out.push(this._chunk({
            tool_calls: [{ index: b.toolIndex || 0, function: { arguments: d.partial_json || '' } }],
          }));
        }
        break;
      }
      case 'message_delta':
        if (event.delta && event.delta.stop_reason) this.finishReason = mapStopReason(event.delta.stop_reason);
        if (event.usage) this.usage = { ...(this.usage || {}), ...event.usage };
        break;
      case 'message_stop':
        this._ensureRole(out);
        out.push(this._chunk({}, this.finishReason || 'stop'));
        break;
      default:
        break; // ping, etc.
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Request: Anthropic -> OpenAI  (for Anthropic-format clients hitting an OpenAI model)
// ---------------------------------------------------------------------------

function anthropicSystemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n\n');
  return '';
}

function anthropicToOpenAIRequest(body) {
  const out = { model: body.model, messages: [] };
  const sys = anthropicSystemToText(body.system);
  if (sys) out.messages.push({ role: 'system', content: sys });

  for (const m of body.messages || []) {
    const role = m.role;
    const content = m.content;

    if (typeof content === 'string') { out.messages.push({ role, content }); continue; }
    if (!Array.isArray(content)) { out.messages.push({ role, content: '' }); continue; }

    if (role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const b of content) {
        if (b.type === 'text') text += b.text || '';
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
        }
      }
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.messages.push(msg);
    } else {
      // user message: may carry tool_result blocks (-> tool role messages), text, images
      const parts = [];
      const toolResults = [];
      for (const b of content) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' });
        else if (b.type === 'image') {
          const src = b.source || {};
          if (src.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } });
          else if (src.type === 'url') parts.push({ type: 'image_url', image_url: { url: src.url } });
        } else if (b.type === 'tool_result') {
          toolResults.push(b);
        }
      }
      for (const tr of toolResults) {
        const trText = typeof tr.content === 'string'
          ? tr.content
          : Array.isArray(tr.content) ? tr.content.map((x) => x.text || '').join('') : '';
        out.messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: trText });
      }
      if (parts.length) {
        const onlyText = parts.every((p) => p.type === 'text');
        out.messages.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('') : parts });
      } else if (!toolResults.length) {
        out.messages.push({ role: 'user', content: '' });
      }
    }
  }

  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.stream) out.stream = true;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object' } },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response: OpenAI -> Anthropic  (non-streaming)
// ---------------------------------------------------------------------------

function mapFinishToStopReason(fr) {
  switch (fr) {
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'stop':
    case 'content_filter':
    default: return 'end_turn';
  }
}

function openAIToAnthropicResponse(resp, model) {
  const choice = (resp.choices && resp.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: String(msg.content) });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
      catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function && tc.function.name, input });
    }
  }
  const u = resp.usage || {};
  return {
    id: resp.id || randId('msg_'),
    type: 'message',
    role: 'assistant',
    model: model || resp.model,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: mapFinishToStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
  };
}

// ---------------------------------------------------------------------------
// Response: OpenAI stream chunks -> Anthropic stream events
// ---------------------------------------------------------------------------

class OpenAIStreamToAnthropicTranslator {
  constructor(model) {
    this.model = model;
    this.id = randId('msg_');
    this.started = false;
    this.textOpen = false;
    this.textIndex = 0;
    this.tools = new Map(); // openai tool index -> { anthropicIndex }
    this.nextIndex = 0;
    this.finishReason = null;
    this.usage = null;
  }
  _start(out) {
    if (this.started) return;
    this.started = true;
    out.push({ type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  _openText(out) {
    if (this.textOpen) return;
    this._start(out);
    this.textIndex = this.nextIndex++;
    this.textOpen = true;
    out.push({ type: 'content_block_start', index: this.textIndex, content_block: { type: 'text', text: '' } });
  }
  handle(chunk) {
    const out = [];
    const choice = (chunk.choices && chunk.choices[0]) || {};
    const delta = choice.delta || {};
    this._start(out);
    if (typeof delta.content === 'string' && delta.content.length) {
      this._openText(out);
      out.push({ type: 'content_block_delta', index: this.textIndex, delta: { type: 'text_delta', text: delta.content } });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const oaIdx = tc.index != null ? tc.index : 0;
        let entry = this.tools.get(oaIdx);
        if (!entry) {
          entry = { anthropicIndex: this.nextIndex++ };
          this.tools.set(oaIdx, entry);
          out.push({ type: 'content_block_start', index: entry.anthropicIndex, content_block: { type: 'tool_use', id: tc.id || randId('toolu_'), name: (tc.function && tc.function.name) || '', input: {} } });
        }
        const args = tc.function && tc.function.arguments;
        if (args) out.push({ type: 'content_block_delta', index: entry.anthropicIndex, delta: { type: 'input_json_delta', partial_json: args } });
      }
    }
    if (choice.finish_reason) this.finishReason = mapFinishToStopReason(choice.finish_reason);
    if (chunk.usage) this.usage = chunk.usage;
    return out;
  }
  finish() {
    const out = [];
    this._start(out);
    if (this.textOpen) out.push({ type: 'content_block_stop', index: this.textIndex });
    for (const entry of this.tools.values()) out.push({ type: 'content_block_stop', index: entry.anthropicIndex });
    out.push({ type: 'message_delta', delta: { stop_reason: this.finishReason || 'end_turn', stop_sequence: null }, usage: { output_tokens: this.usage ? this.usage.completion_tokens || 0 : 0 } });
    out.push({ type: 'message_stop' });
    return out;
  }
}

// True if a request already carries any cache_control marker (so we don't double-add).
function hasCacheControl(body) {
  const scan = (blocks) => Array.isArray(blocks) && blocks.some((b) => b && typeof b === 'object' && b.cache_control);
  if (scan(body.system)) return true;
  for (const m of body.messages || []) {
    if (m && scan(m.content)) return true;
  }
  return false;
}

module.exports = {
  openaiToAnthropic,
  anthropicToOpenAI,
  applyPromptCaching,
  AnthropicStreamTranslator,
  anthropicToOpenAIRequest,
  openAIToAnthropicResponse,
  OpenAIStreamToAnthropicTranslator,
  hasCacheControl,
  anthropicSystemToText,
  // exported for tests
  _internals: { convertMessages, mapStopReason, mapToolChoice, usageToOpenAI, mapFinishToStopReason },
};
