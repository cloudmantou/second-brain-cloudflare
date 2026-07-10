/* utils.js — helper functions for the Second Brain UI.
 *
 * In production these are served from the Worker root. This file mirrors
 * them so the UI is fully functional in preview / offline as well.
 * (Path resolves to the same /utils.js when index.html is served at root.)
 */

/* Escape text for safe insertion into HTML. */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Escape text for safe insertion into a single-quoted HTML attribute / inline JS string. */
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');
}

/* yyyy-mm-dd in local time, for day-grouping. */
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* Parse the text returned by the `recall` MCP tool into entry objects.
 * Tolerant of a few shapes: JSON array, or a numbered / bulleted text list
 * with an optional [NN%] score, inline #hashtags, and a trailing (id: …).
 * Returns: [{ score, content, tags: string[], id }]
 */
function parseRecallResult(result) {
  if (!result) return [];

  // 1) JSON payload
  try {
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    const arr = Array.isArray(data) ? data : (data.results || data.memories || data.entries);
    if (Array.isArray(arr)) {
      return arr.map(e => normalizeEntry(e));
    }
  } catch (_) { /* not JSON — fall through to text parsing */ }

  // 2) Text list
  const text = String(result);
  const blocks = text
    .split(/\n(?=\s*(?:\d+[.)]|[-*•]|\[))/)   // split on new list items
    .map(b => b.trim())
    .filter(Boolean);

  const entries = [];
  blocks.forEach(block => {
    let body = block.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '');

    // score like [87%] or (87%)
    let score = null;
    const sm = body.match(/[\[(]\s*(\d{1,3})\s*%\s*[\])]/);
    if (sm) { score = parseInt(sm[1], 10); body = body.replace(sm[0], '').trim(); }

    // trailing (id: xxx)
    let id = null;
    const im = body.match(/\(id:\s*([^)]+)\)\s*$/i);
    if (im) { id = im[1].trim(); body = body.replace(im[0], '').trim(); }

    // hashtags
    const tags = [];
    let tm; const tagRe = /#([a-zA-Z0-9_-]+)/g;
    while ((tm = tagRe.exec(body)) !== null) tags.push(tm[1]);
    const content = body.replace(/#[a-zA-Z0-9_-]+/g, '').replace(/\s{2,}/g, ' ').trim();

    if (content) {
      entries.push({
        score: score == null ? 0 : score,
        content,
        tags,
        id
      });
    }
  });

  return entries;
}

/* Coerce a structured recall entry into the shape the UI expects. */
function normalizeEntry(e) {
  let tags = e.tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch (_) { tags = tags ? [tags] : []; }
  }
  if (!Array.isArray(tags)) tags = [];
  let score = e.score != null ? e.score : (e.similarity != null ? e.similarity : 0);
  if (score > 0 && score <= 1) score = Math.round(score * 100);   // 0–1 → percent
  return {
    score: Math.round(score) || 0,
    content: e.content != null ? e.content : (e.text || ''),
    tags,
    id: e.id != null ? e.id : null
  };
}

/* Incremental parser for the dashboard's `data: {"response":"..."}` SSE stream.
 * Network reads may split an event at any byte boundary, so parsing is deferred
 * until a blank-line event delimiter has arrived.
 */
function createCfSseParser(handlers) {
  const onResponse = handlers && typeof handlers.onResponse === 'function'
    ? handlers.onResponse
    : function () {};
  const onDone = handlers && typeof handlers.onDone === 'function'
    ? handlers.onDone
    : function () {};
  const onError = handlers && typeof handlers.onError === 'function'
    ? handlers.onError
    : function () {};
  let buffer = '';
  let completed = false;

  function consumeEvent(eventText) {
    const data = eventText
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) return;
    if (data === '[DONE]') {
      if (!completed) onDone();
      completed = true;
      return;
    }
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed.response === 'string' && parsed.response) {
        onResponse(parsed.response);
      }
    } catch (error) {
      onError(error);
    }
  }

  function drain(allowRemainder) {
    let match;
    while ((match = buffer.match(/\r?\n\r?\n/))) {
      const end = match.index;
      consumeEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + match[0].length);
    }
    if (allowRemainder && buffer.trim()) {
      consumeEvent(buffer);
      buffer = '';
    }
  }

  return {
    push(text) {
      if (!text) return;
      buffer += text;
      drain(false);
    },
    finish() {
      drain(true);
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escHtml,
    escAttr,
    toDateStr,
    parseRecallResult,
    normalizeEntry,
    createCfSseParser,
  };
}
