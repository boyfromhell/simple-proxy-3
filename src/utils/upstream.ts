import { createError } from 'h3';

export function validateTarget(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid upstream URL',
    });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid upstream URL',
    });
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const parts = host.split('.').map(Number);
  const privateV4 =
    parts.length === 4 &&
    parts.every(Number.isInteger) &&
    (parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] >= 224);
  if (
    privateV4 ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '[::]' ||
    host === '[::1]' ||
    /^\[(?:fc|fd|fe[89ab]|ff)/.test(host) ||
    host.startsWith('[::ffff:')
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Private upstream addresses are not allowed',
    });
  }
  url.hash = '';
  return url;
}

export interface UpstreamResult {
  response: Response;
  finalUrl: string;
}

export async function fetchUpstream(
  input: string,
  options: RequestInit = {},
  timeoutMs = 15000,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<UpstreamResult> {
  let url = validateTarget(input);
  let method = options.method ?? 'GET';
  let body = options.body;
  const headers = new Headers(options.headers);
  headers.set('Accept-Encoding', 'identity');
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    onAbort();
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetcher(url.href, {
        ...options,
        method,
        body,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        return { response, finalUrl: url.href };
      }
      await response.body?.cancel();
      if (redirects === 5) {
        throw createError({
          statusCode: 502,
          statusMessage: 'Too many upstream redirects',
        });
      }
      const next = validateTarget(new URL(location, url).href);
      if (next.origin !== url.origin) {
        headers.delete('authorization');
        headers.delete('cookie');
      }
      if (
        (response.status === 303 && method !== 'HEAD') ||
        ([301, 302].includes(response.status) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
        headers.delete('content-length');
      }
      url = next;
    }
    throw createError({
      statusCode: 502,
      statusMessage: 'Too many upstream redirects',
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      throw error;
    }
    throw createError({
      statusCode: controller.signal.aborted ? 504 : 502,
      statusMessage: controller.signal.aborted
        ? 'Upstream request timed out or was cancelled'
        : 'Upstream connection failed',
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function readLimitedText(
  response: Response,
  limit = 1024 * 1024,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, 15000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (timedOut) {
          throw createError({
            statusCode: 504,
            statusMessage: 'Upstream playlist timed out',
          });
        }
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw createError({
          statusCode: 502,
          statusMessage: 'Upstream playlist is too large',
        });
      }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(result);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
