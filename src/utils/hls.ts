import { createError } from 'h3';

const playlistTags = new Set([
  '#EXT-X-MEDIA',
  '#EXT-X-I-FRAME-STREAM-INF',
  '#EXT-X-RENDITION-REPORT',
]);
const resourceTags = new Set([
  '#EXT-X-KEY',
  '#EXT-X-SESSION-KEY',
  '#EXT-X-MAP',
  '#EXT-X-PART',
  '#EXT-X-PRELOAD-HINT',
  '#EXT-X-SESSION-DATA',
]);

export function rewritePlaylist(
  content: string,
  upstreamUrl: string,
  proxyOrigin: string,
  headers: Record<string, string>,
  token?: string,
): string {
  const text = content.replace(/^\uFEFF/, '');
  if (!/^#EXTM3U(?:\r?\n|$)/.test(text)) {
    throw createError({
      statusCode: 502,
      statusMessage: 'Upstream did not return an HLS playlist',
    });
  }
  const proxied = (uri: string, playlist: boolean): string => {
    if (/^(data|skd):/i.test(uri)) {
      return uri;
    }
    let upstream: URL;
    try {
      upstream = new URL(uri, upstreamUrl);
    } catch {
      throw createError({
        statusCode: 502,
        statusMessage: 'Invalid HLS resource URL',
      });
    }
    if (!['http:', 'https:'].includes(upstream.protocol)) {
      throw createError({
        statusCode: 502,
        statusMessage: 'Unsupported HLS resource protocol',
      });
    }
    const result = new URL(playlist ? '/m3u8-proxy' : '/ts-proxy', proxyOrigin);
    result.searchParams.set('url', upstream.href);
    if (Object.keys(headers).length) {
      result.searchParams.set('headers', JSON.stringify(headers));
    }
    if (token) {
      result.searchParams.set('proxy_token', token);
    }
    return result.href;
  };
  let nextIsPlaylist = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }
      if (!trimmed.startsWith('#')) {
        const result = proxied(trimmed, nextIsPlaylist);
        nextIsPlaylist = false;
        return result;
      }
      const tag = trimmed.split(':', 1)[0];
      if (tag === '#EXT-X-STREAM-INF') {
        nextIsPlaylist = true;
      }
      if (!playlistTags.has(tag) && !resourceTags.has(tag)) {
        return line;
      }
      return line.replace(
        /([:,])URI="([^"]*)"/g,
        (_match, separator, uri) =>
          `${separator}URI="${proxied(uri, playlistTags.has(tag))}"`,
      );
    })
    .join('\n');
}
