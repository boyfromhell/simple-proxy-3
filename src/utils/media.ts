import {
  assertMethod,
  createError,
  getQuery,
  getRequestURL,
  handleCors,
  type H3Event,
} from 'h3';
import { getProxyHeaders, parseMediaHeaders } from './headers';
import { setting } from './settings';
import { validateTarget } from './upstream';

export function prepareMediaRequest(event: H3Event):
  | {
      url: URL;
      headers: Headers;
      overrides: Record<string, string>;
      proxyOrigin: string;
    }
  | undefined {
  const preflight = handleCors(event, {
    origin: '*',
    allowHeaders: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    exposeHeaders: '*',
  });
  if (preflight) {
    return;
  }
  assertMethod(event, ['GET', 'HEAD']);
  if (setting(event, 'DISABLE_M3U8') === 'true') {
    throw createError({
      statusCode: 404,
      statusMessage: 'Media proxying is disabled',
    });
  }
  const query = getQuery(event);
  if (typeof query.url !== 'string') {
    throw createError({
      statusCode: 400,
      statusMessage: 'URL parameter is required',
    });
  }
  const url = validateTarget(query.url);
  const overrides = parseMediaHeaders(query.headers);
  const headers = getProxyHeaders(new Headers());
  for (const [key, value] of Object.entries(overrides)) {
    headers.set(key, value);
  }
  for (const name of [
    'range',
    'if-range',
    'if-none-match',
    'if-modified-since',
  ]) {
    const value = event.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return { url, headers, overrides, proxyOrigin: getRequestURL(event).origin };
}

export function mediaResponseHeaders(
  response: Response,
  request: Headers,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of [
    'content-type',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'retry-after',
    'cache-control',
    'expires',
    'vary',
    'age',
  ]) {
    const value = response.headers.get(name);
    if (value !== null) {
      headers[name] = value;
    }
  }
  if (
    !response.headers.has('content-encoding') &&
    response.headers.has('content-length')
  ) {
    headers['content-length'] = response.headers.get('content-length')!;
  }
  if (
    request.has('cookie') ||
    request.has('authorization') ||
    response.headers.has('set-cookie')
  ) {
    headers['cache-control'] = 'private, no-store';
  } else if (!headers['cache-control']) {
    headers['cache-control'] = 'no-store';
  }
  return headers;
}
