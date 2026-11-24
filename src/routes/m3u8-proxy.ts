import {
  defineEventHandler,
  getQuery,
  setResponseHeaders,
  setResponseStatus,
} from 'h3';
import { rewritePlaylist } from '@/utils/hls';
import { prepareMediaRequest, mediaResponseHeaders } from '@/utils/media';
import { authorizeMedia } from '@/utils/turnstile';
import { fetchUpstream, readLimitedText } from '@/utils/upstream';
import { upstreamTimeout } from '@/utils/settings';
import { sendBody } from '@/utils/streaming';

export default defineEventHandler(async (event) => {
  const request = prepareMediaRequest(event);
  if (!request) {
    return;
  }
  const token = await authorizeMedia(event);
  const query = getQuery(event);
  for (const name of ['_HLS_msn', '_HLS_part', '_HLS_skip']) {
    if (typeof query[name] === 'string') {
      request.url.searchParams.set(name, query[name]);
    }
  }
  // A range or validator describes the original bytes, not the rewritten playlist.
  for (const name of [
    'range',
    'if-range',
    'if-none-match',
    'if-modified-since',
  ]) {
    request.headers.delete(name);
  }
  const { response, finalUrl } = await fetchUpstream(
    request.url.href,
    {
      method: event.method,
      headers: request.headers,
    },
    upstreamTimeout(event),
  );
  setResponseStatus(event, response.status);
  if (!response.ok || event.method === 'HEAD') {
    setResponseHeaders(event, mediaResponseHeaders(response, request.headers));
    if (event.method === 'HEAD') {
      await response.body?.cancel();
      return '';
    }
    return response.body ? sendBody(event, response.body) : '';
  }
  const content = await readLimitedText(response);
  const rewritten = rewritePlaylist(
    content,
    finalUrl,
    request.proxyOrigin,
    request.overrides,
    token,
  );
  setResponseHeaders(event, {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  return rewritten;
});
