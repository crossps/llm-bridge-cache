'use strict';

// Prompt injection operates on the OpenAI-format request (before any provider
// conversion), so it works uniformly for every backend.

/**
 * Apply system-prompt and depth injections to an OpenAI chat request body.
 * Mutates and returns `body`.
 *
 * @param {object} body  OpenAI chat.completions request
 * @param {object} inj   injection config: { enabled, system, systemMode, depth }
 */
function applyInjection(body, inj) {
  if (!inj || !inj.enabled) return body;
  let messages = Array.isArray(body.messages) ? body.messages.slice() : [];

  // --- System injection ---
  if (inj.system && String(inj.system).trim()) {
    const mode = inj.systemMode || 'prepend';
    const text = String(inj.system);

    if (mode === 'replace') {
      messages = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
      messages.unshift({ role: 'system', content: text });
    } else {
      const idx = messages.findIndex((m) => m.role === 'system' || m.role === 'developer');
      if (idx >= 0) {
        const existing = typeof messages[idx].content === 'string'
          ? messages[idx].content
          : stringifyContent(messages[idx].content);
        const merged = mode === 'append' ? `${existing}\n\n${text}` : `${text}\n\n${existing}`;
        messages[idx] = { ...messages[idx], content: merged };
      } else {
        messages.unshift({ role: 'system', content: text });
      }
    }
  }

  // --- Depth injection ---
  messages = applyDepth(messages, inj.depth);

  body.messages = messages;
  return body;
}

// Insert messages at a given depth counting back from the end of the array.
// depth 0 = appended at the very end, depth 1 = before the last message, etc.
// Use role "user"/"assistant" for positional effect; a "system" role will be
// hoisted to the top-level system prompt by the Anthropic converter.
function applyDepth(messages, depthInjections) {
  if (!Array.isArray(depthInjections) || depthInjections.length === 0) return messages;
  const out = messages.slice();
  for (const d of depthInjections) {
    if (!d || !d.content) continue;
    const role = d.role || 'user';
    const depth = Math.max(0, parseInt(d.depth, 10) || 0);
    const pos = Math.max(0, out.length - depth);
    out.splice(pos, 0, { role, content: String(d.content) });
  }
  return out;
}

function stringifyContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p.type === 'text' ? p.text || '' : '')).join('');
  }
  return content == null ? '' : String(content);
}

module.exports = { applyInjection, applyDepth };
