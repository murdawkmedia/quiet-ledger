// Bounded HTTPS transport for explicit Cashu recovery.
//
// One instance performs at most one request. The endpoint is an exact match for
// one of the three recovery paths on the operator-configured HTTPS origin, with
// no redirects, a hard wall-clock deadline, a bounded request and a bounded
// JSON response. Nothing is retried here; the journal owns the one-request-per-
// phase rule. Authorization headers are refused because this tool has no
// provider credential boundary.

export class CashuTransportError extends Error {
  constructor(code, message = code, cause) {
    super(`${code}: ${message}`, cause ? {cause} : undefined);
    this.name = 'CashuTransportError';
    this.code = code;
  }
}

export const RECOVERY_PATHS = Object.freeze(['/v1/restore', '/v1/checkstate', '/v1/swap']);
export const DEFAULT_TIMEOUT_MS = 15000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const MIN_RESPONSE_BYTES = 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const ALLOWED_HEADERS = new Set(['accept', 'content-type']);

function originOf(value) {
  if (typeof value !== 'string' || value.length > 512) {
    throw new CashuTransportError('INVALID_MINT', 'mint URL is missing or too long');
  }
  let url;
  try { url = new URL(value); } catch (error) { throw new CashuTransportError('INVALID_MINT', 'mint URL is invalid', error); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new CashuTransportError('INVALID_MINT', 'mint must be HTTPS without credentials, query or fragment');
  }
  return {origin: url.origin, path: url.pathname.replace(/\/+$/, '')};
}

function integerOption(value, {label, min, max}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CashuTransportError('INVALID_TRANSPORT_CONFIG', `${label} must be an integer in ${min}..${max}`);
  }
  return value;
}

async function boundedBody(response, maxBytes, signal) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new CashuTransportError('RESPONSE_TOO_LARGE');
    return bytes;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) {
      try { await reader.cancel(); } catch {}
      throw new CashuTransportError('REQUEST_TIMEOUT', 'mint response exceeded its deadline');
    }
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new CashuTransportError('RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export function createBoundedHttpsTransport({
  mintUrl, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const {origin, path: basePath} = originOf(mintUrl);
  integerOption(timeoutMs, {label: 'timeoutMs', min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS});
  integerOption(maxResponseBytes, {label: 'maxResponseBytes', min: MIN_RESPONSE_BYTES, max: MAX_RESPONSE_BYTES});
  if (typeof fetchImpl !== 'function') throw new CashuTransportError('INVALID_FETCH');
  let used = false;

  return async function transport(args) {
    if (used) throw new CashuTransportError('TRANSPORT_REPLAY', 'one transport instance performs one request');
    used = true;
    if (!args || typeof args !== 'object' || args.method !== 'POST') {
      throw new CashuTransportError('UNEXPECTED_TRANSPORT', 'only POST requests are allowed');
    }
    let endpoint;
    try { endpoint = new URL(args.endpoint); }
    catch (error) { throw new CashuTransportError('UNEXPECTED_ENDPOINT', 'endpoint is not a URL', error); }
    const allowed = RECOVERY_PATHS.find(candidate => basePath + candidate === endpoint.pathname);
    if (endpoint.protocol !== 'https:' || endpoint.origin !== origin || !allowed ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new CashuTransportError('UNEXPECTED_ENDPOINT', 'endpoint is not an allowed recovery path on the configured mint');
    }
    if (!args.requestBody || typeof args.requestBody !== 'object' || Array.isArray(args.requestBody)) {
      throw new CashuTransportError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    let payload;
    try { payload = JSON.stringify(args.requestBody); }
    catch (error) { throw new CashuTransportError('INVALID_REQUEST', 'request body is not JSON-safe', error); }
    if (Buffer.byteLength(payload, 'utf8') > MAX_REQUEST_BYTES) {
      throw new CashuTransportError('REQUEST_TOO_LARGE');
    }
    if (args.headers != null) {
      if (typeof args.headers !== 'object' || Array.isArray(args.headers)) {
        throw new CashuTransportError('UNSUPPORTED_HEADERS', 'headers must be a plain object');
      }
      for (const name of Object.keys(args.headers)) {
        if (!ALLOWED_HEADERS.has(name.toLowerCase())) {
          throw new CashuTransportError('UNSUPPORTED_HEADERS', 'only accept/content-type headers are supported');
        }
      }
    }

    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CashuTransportError('REQUEST_TIMEOUT', 'mint request exceeded its deadline'));
      }, timeoutMs);
    });
    const work = (async () => {
      const response = await fetchImpl(endpoint.toString(), {
        method: 'POST',
        headers: {'content-type': 'application/json', accept: 'application/json'},
        body: payload,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response || typeof response !== 'object') throw new CashuTransportError('INVALID_RESPONSE');
      if (response.redirected) throw new CashuTransportError('REDIRECT_REFUSED');
      if (response.status !== 200) throw new CashuTransportError('HTTP_STATUS', 'mint did not return HTTP 200');
      const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
      if (!contentType.includes('application/json')) {
        throw new CashuTransportError('INVALID_CONTENT_TYPE', 'mint response is not JSON');
      }
      const bytes = await boundedBody(response, maxResponseBytes, controller.signal);
      let parsed;
      try { parsed = JSON.parse(bytes.toString('utf8')); }
      catch (error) { throw new CashuTransportError('INVALID_JSON', 'mint response is not valid JSON', error); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new CashuTransportError('INVALID_JSON', 'mint response is not a JSON object');
      }
      return parsed;
    })();
    work.catch(() => {}); // the deadline may win; never leave an unhandled rejection
    try {
      return await Promise.race([work, deadline]);
    } catch (error) {
      if (error instanceof CashuTransportError) throw error;
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        throw new CashuTransportError('REQUEST_TIMEOUT', 'mint request was aborted at its deadline');
      }
      throw new CashuTransportError('NETWORK_ERROR', 'mint request failed');
    } finally { clearTimeout(timer); }
  };
}
