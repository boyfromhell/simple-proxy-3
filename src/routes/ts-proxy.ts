import { defineEventHandler, setResponseHeaders, setResponseStatus } from 'h3';
import { prepareMediaRequest, mediaResponseHeaders } from '@/utils/media';
import { authorizeMedia } from '@/utils/turnstile';
import {
  cacheLifetime,
  cacheStream,
  segmentCache,
  segmentCacheKey,
} from '@/utils/segment-cache';
import { setting, upstreamTimeout } from '@/utils/settings';
import { fetchUpstream } from '@/utils/upstream';
import { sendBody } from '@/utils/streaming';

export default defineEventHandler(async (event) => {
  const request = prepareMediaRequest(event);
  if (!request) {
    return;
  }
  const token = await authorizeMedia(event);
  const cacheEnabled =
    setting(event, 'ENABLE_CACHE') === 'true' &&
    !token &&
    !request.headers.has('cookie') &&
    !request.headers.has('authorization') &&
    event.method === 'GET';
  const key = segmentCacheKey(request.url.href, request.headers);
  const cached = cacheEnabled ? segmentCache.get(key) : undefined;
  if (cached) {
    setResponseStatus(event, cached.status);
    setResponseHeaders(event, {
      ...cached.headers,
      age:
        Number(cached.headers.age || 0) +
        Math.max(
          0,
          Math.floor((Date.now() - (cached.storedAt ?? Date.now())) / 1000),
        ),
    });
    return cached.data;
  }
  const { response } = await fetchUpstream(
    request.url.href,
    {
      method: event.method,
      headers: request.headers,
    },
    upstreamTimeout(event),
  );
  const headers = mediaResponseHeaders(response, request.headers);
  if (token) {
    headers['cache-control'] = 'private, no-store';
  }
  setResponseHeaders(event, headers);
  setResponseStatus(event, response.status);
  if (!response.body || event.method === 'HEAD') {
    await response.body?.cancel();
    return '';
  }
  const lifetime =
    cacheEnabled && response.status === 200
      ? cacheLifetime(request.headers, response.headers)
      : 0;
  const expires = Date.now() + lifetime;
  const body = lifetime
    ? cacheStream(response.body, (data) => {
        segmentCache.set(key, {
          data,
          headers,
          status: response.status,
          expires,
          storedAt: Date.now(),
        });
      })
    : response.body;
  return sendBody(event, body);
});
