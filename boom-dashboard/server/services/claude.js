/**
 * Single entry point for every Claude API call in this server.
 *
 * Why this file exists: previously, 13 call sites across 5 files each
 * reinstantiated `Anthropic`, detected mediaType from filename, built the
 * `[document|image, text]` content array, parsed JSON with the same
 * fence-stripping regex, and decided what to do on failure. This collapses
 * that into one place so cost tracking, retries, kill-switch, and model
 * swaps live in one diff.
 *
 * Caller still owns the fail-open *shape* — the wrapper just returns a
 * consistent `{ ok, data, raw, usage, error }` object so callers can
 * dispatch on `.ok` and produce whatever fallback their UX requires.
 */

const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function mediaTypeFromFilename(filename) {
  if (!filename) return 'application/pdf';
  if (/\.png$/i.test(filename)) return 'image/png';
  if (/\.jpe?g$/i.test(filename)) return 'image/jpeg';
  return 'application/pdf';
}

function stripJsonFences(text) {
  return String(text || '').trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '');
}

function buildContent({ buffer, base64, filename, mimeType, prompt, cacheDocument }) {
  const items = [];
  const data = base64 || (buffer ? buffer.toString('base64') : null);
  if (data) {
    const mt = mimeType || mediaTypeFromFilename(filename);
    const block = /^image\//.test(mt)
      ? { type: 'image', source: { type: 'base64', media_type: mt, data } }
      // Treat anything non-image (incl. unknown) as PDF — matches prior behavior.
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    // Opt-in ephemeral cache: same document hit repeatedly within ~5min reads
    // at ~10% the input price. One-time documents pay a 25% write premium —
    // only enable on call sites that repeat (e.g. vendor-submit's parse →
    // invoice-number gate → discrepancy-scan sequence).
    if (cacheDocument) block.cache_control = { type: 'ephemeral' };
    items.push(block);
  }
  items.push({ type: 'text', text: prompt });
  return items;
}

function logUsage({ model, usage, ms, ok, parseOk }) {
  if (!usage) return;
  // Structured stdout — cheap to ship to a metrics service later.
  console.log(JSON.stringify({
    event: 'claude_call',
    model,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    ms,
    ok,
    parse_ok: parseOk,
  }));
}

/**
 * @param {Object} opts
 * @param {string} opts.prompt              - Required. The text portion of the prompt.
 * @param {Buffer} [opts.buffer]            - Optional file bytes. Omit for text-only calls.
 * @param {string} [opts.base64]            - Alternative to `buffer` when caller already has base64
 *                                            (skips a needless encode round-trip). If both set, base64 wins.
 * @param {string} [opts.filename]          - Used to detect mediaType (.pdf/.png/.jpg).
 * @param {string} [opts.mimeType]          - Overrides filename-based detection. Use when you
 *                                            already have the mime (e.g. multer's req.file.mimetype).
 * @param {number} [opts.maxTokens=1024]
 * @param {string} [opts.model]             - Defaults to env CLAUDE_MODEL || 'claude-sonnet-4-6'.
 * @param {boolean} [opts.parseJson=false]  - If true, the wrapper strips JSON fences and JSON.parses
 *                                            the response. Set `data` on success; on parse failure
 *                                            returns ok:false with `error: 'JSON parse failed: ...'`.
 * @param {boolean} [opts.cacheDocument=false] - Mark the document/image block as ephemeral-cached
 *                                            (5-min TTL). Only enable when the same document is
 *                                            sent again soon — one-shot calls pay a 25% write
 *                                            premium for no benefit.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   data: any | null,        // parsed JSON when parseJson=true, raw text otherwise
 *   raw: string | null,      // raw model output (always populated when API call succeeded)
 *   usage: object | null,    // Anthropic usage block (input/output/cache tokens)
 *   error: string | null,    // populated when ok=false
 *   disabled?: boolean,      // true when CLAUDE_DISABLED env is set or no API key
 * }>}
 */
async function callClaude(opts) {
  const {
    prompt,
    buffer,
    base64,
    filename,
    mimeType,
    maxTokens = 1024,
    model = DEFAULT_MODEL,
    parseJson = false,
    cacheDocument = false,
  } = opts || {};

  if (!prompt) {
    return { ok: false, data: null, raw: null, usage: null, error: 'prompt is required' };
  }

  // Kill switch — useful for incidents and for offline development.
  if (process.env.CLAUDE_DISABLED === 'true') {
    return { ok: false, data: null, raw: null, usage: null, error: 'CLAUDE_DISABLED', disabled: true };
  }

  const client = getClient();
  if (!client) {
    return { ok: false, data: null, raw: null, usage: null, error: 'NO_API_KEY', disabled: true };
  }

  const content = buildContent({ buffer, base64, filename, mimeType, prompt, cacheDocument });
  const startedAt = Date.now();

  let message;
  try {
    if (maxTokens > 8192) {
      // The SDK refuses non-streaming requests it estimates could exceed
      // 10 minutes (large max_tokens). Stream and accumulate instead —
      // finalMessage() returns the same Message shape as create().
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      });
      message = await stream.finalMessage();
    } else {
      message = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      });
    }
  } catch (err) {
    const ms = Date.now() - startedAt;
    console.warn(`Claude API call failed (${ms}ms):`, err.message);
    return { ok: false, data: null, raw: null, usage: null, error: err.message };
  }

  const ms = Date.now() - startedAt;
  const raw = message.content?.[0]?.text ?? '';
  const usage = message.usage || null;

  if (!parseJson) {
    logUsage({ model, usage, ms, ok: true, parseOk: null });
    return { ok: true, data: raw, raw, usage, error: null };
  }

  try {
    const data = JSON.parse(stripJsonFences(raw));
    logUsage({ model, usage, ms, ok: true, parseOk: true });
    return { ok: true, data, raw, usage, error: null };
  } catch (parseErr) {
    logUsage({ model, usage, ms, ok: false, parseOk: false });
    return {
      ok: false,
      data: null,
      raw,
      usage,
      error: `JSON parse failed: ${parseErr.message}`,
    };
  }
}

module.exports = {
  callClaude,
  stripJsonFences,
  mediaTypeFromFilename,
  DEFAULT_MODEL,
};
