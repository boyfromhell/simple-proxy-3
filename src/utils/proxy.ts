import {
  H3Event,
  Duplex,
  ProxyOptions,
  getProxyRequestHeaders,
  RequestHeaders,
  readRawBody,
  getRequestWebStream,
  setResponseStatus,
  setResponseHeader,
} from 'h3';
import { fetchUpstream, validateTarget } from './upstream';
import { upstreamTimeout, setting } from './settings';
import { sendBody } from './streaming';

const PayloadMethods = new Set(['PATCH', 'POST', 'PUT', 'DELETE']);

export interface ExtraProxyOptions {
  blacklistedHeaders?: string[];
}

function mergeHeaders(
  defaults: HeadersInit,
  ...inputs: (HeadersInit | RequestHeaders | undefined)[]
) {
  const _inputs = inputs.filter(Boolean) as HeadersInit[];
  if (_inputs.length === 0) {
    return defaults;
  }
  const merged = new Headers(defaults);
  for (const input of _inputs) {
    if (input.entries) {
      for (const [key, value] of (input.entries as any)()) {
        if (value !== undefined) {
          merged.set(key, value);
        }
      }
    } else {
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
          merged.set(key, value);
        }
      }
    }
  }
  return merged;
}

export async function specificProxyRequest(
  event: H3Event,
  target: string,
  opts: ProxyOptions & ExtraProxyOptions = {},
) {
  validateTarget(target);
  let body;
  let duplex: Duplex | undefined;
  if (PayloadMethods.has(event.method)) {
    if (opts.streamRequest) {
      body = getRequestWebStream(event);
      duplex = 'half';
    } else {
      body = await readRawBody(event, false).catch(() => undefined);
    }
  }

  const method = opts.fetchOptions?.method || event.method;
  const oldHeaders = getProxyRequestHeaders(event);

  // netlify seems to be changing the content-encoding header to gzip when the reponse is encoded in zstd
  // so as temp fix just not sending zstd in accept encoding
  if (oldHeaders['accept-encoding']?.includes('zstd'))
    oldHeaders['accept-encoding'] = oldHeaders['accept-encoding']
      .split(',')
      .map((x: string) => x.trim())
      .filter((x: string) => x !== 'zstd')
      .join(', ');

  opts.blacklistedHeaders?.forEach((header) => {
    const keys = Object.keys(oldHeaders).filter(
      (v) => v.toLowerCase() === header.toLowerCase(),
    );
    keys.forEach((k) => delete oldHeaders[k]);
  });

  const fetchHeaders = mergeHeaders(
    oldHeaders,
    opts.fetchOptions?.headers,
    opts.headers,
  );
  if (setting(event, 'REQ_DEBUG') === 'true') {
    console.log({
      type: 'request',
      method,
      origin: new URL(target).origin,
    });
  }

  const { response, finalUrl } = await fetchUpstream(
    target,
    {
      method,
      body,
      duplex,
      ...opts.fetchOptions,
      headers: fetchHeaders,
    } as RequestInit,
    upstreamTimeout(event),
  );
  event.context.proxyFinalUrl = finalUrl;
  setResponseStatus(event, response.status);
  for (const [name, value] of response.headers) {
    if (
      [
        'content-encoding',
        'content-length',
        'connection',
        'transfer-encoding',
        'keep-alive',
        'set-cookie',
      ].includes(name)
    ) {
      continue;
    }
    setResponseHeader(event, name, value);
  }
  await opts.onResponse?.(event, response);
  if (event.method === 'HEAD' || !response.body) {
    await response.body?.cancel();
    return '';
  }
  return sendBody(event, response.body);
}
