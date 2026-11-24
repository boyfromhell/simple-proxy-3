import test from 'node:test';
import assert from 'node:assert/strict';
import { rewritePlaylist } from '../src/utils/hls.ts';
import {
  SegmentCache,
  cacheStream,
  cacheLifetime,
  segmentCacheKey,
} from '../src/utils/segment-cache.ts';
import {
  fetchUpstream,
  readLimitedText,
  validateTarget,
} from '../src/utils/upstream.ts';
import {
  parseMediaHeaders,
  getBlacklistedHeaders,
} from '../src/utils/headers.ts';

const rewrite = (text) =>
  rewritePlaylist(
    text,
    'https://cdn.example/redirected/master.m3u8',
    'https://proxy.example',
    { Referer: 'https://source.example/' },
    'jwt|signed',
  );
const urls = (text) =>
  [...text.matchAll(/https:\/\/proxy\.example[^"\s]+/g)].map(
    ([url]) => new URL(url),
  );

test('master variants without RESOLUTION and alternate audio use playlist routes', () => {
  const result = rewrite(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900\nvideo/list.m3u8\n',
  );
  const targets = urls(result);
  assert.equal(targets.length, 2);
  assert.ok(targets.every((url) => url.pathname === '/m3u8-proxy'));
  assert.equal(
    targets[0].searchParams.get('url'),
    'https://cdn.example/redirected/audio/list.m3u8',
  );
  assert.equal(targets[1].searchParams.get('proxy_token'), 'jwt|signed');
  assert.deepEqual(JSON.parse(targets[1].searchParams.get('headers')), {
    Referer: 'https://source.example/',
  });
});

test('relative encryption keys, initialization files and byte ranges survive rewriting', () => {
  const result = rewrite(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key?id=42"\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"\n#EXT-X-BYTERANGE:200@100\nsegment.mp4\n',
  );
  assert.deepEqual(
    urls(result).map((url) => url.searchParams.get('url')),
    [
      'https://cdn.example/key?id=42',
      'https://cdn.example/redirected/init.mp4',
      'https://cdn.example/redirected/segment.mp4',
    ],
  );
  assert.ok(urls(result).every((url) => url.pathname === '/ts-proxy'));
  assert.match(result, /BYTERANGE="100@0"/);
  assert.match(result, /#EXT-X-BYTERANGE:200@100/);
});

test('low latency parts, preload hints, rendition reports and session keys are routed correctly', () => {
  const result = rewrite(
    '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"\n#EXT-X-PART:DURATION=0.3,URI="part.mp4"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.mp4"\n#EXT-X-RENDITION-REPORT:URI="other.m3u8"\n',
  );
  assert.deepEqual(
    urls(result).map((url) => url.pathname),
    ['/ts-proxy', '/ts-proxy', '/ts-proxy', '/m3u8-proxy'],
  );
});

test('data and DRM key identifiers remain intact; HTML never becomes a playlist', () => {
  assert.match(
    rewrite(
      '#EXTM3U\n#EXT-X-KEY:URI="skd://identifier"\n#EXT-X-KEY:URI="data:abc"',
    ),
    /URI="skd:\/\/identifier"/,
  );
  assert.throws(() => rewrite('<html>denied</html>'), { statusCode: 502 });
  assert.throws(() => rewrite('#EXTM3U\nfile:///etc/passwd'), {
    statusCode: 502,
  });
});

test('only valid JSON header objects are accepted and local control headers are stripped', () => {
  assert.deepEqual(
    parseMediaHeaders(
      '{"Referer":"https://source.example/","X-Token":"secret","CF-Connecting-IP":"1.2.3.4"}',
    ),
    { referer: 'https://source.example/' },
  );
  for (const value of [
    '{',
    'null',
    '[]',
    '"str"',
    '{"Cookie":123}',
    '{"Cookie":"invalid\\nheader"}',
  ]) {
    assert.throws(() => parseMediaHeaders(value), { statusCode: 400 });
  }
  assert.ok(getBlacklistedHeaders().includes('x-token'));
});

test('cache expires and evicts by total bytes and LRU order', () => {
  const cache = new SegmentCache(6, 2);
  const entry = (length) => ({
    data: new Uint8Array(length),
    headers: {},
    status: 200,
    expires: Date.now() + 5000,
  });
  cache.set('a', entry(3));
  cache.set('b', entry(3));
  cache.get('a');
  cache.set('c', entry(3));
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.get('a'));
  cache.set('large', entry(7));
  assert.equal(cache.get('large'), undefined);
  assert.equal(cache.get('a', Date.now() + 6000), undefined);
});

test('cache keys isolate headers and ranges and never cache private responses', () => {
  assert.notEqual(
    segmentCacheKey(
      'https://cdn.example/a',
      new Headers({ Range: 'bytes=0-2' }),
    ),
    segmentCacheKey(
      'https://cdn.example/a',
      new Headers({ Range: 'bytes=3-5' }),
    ),
  );
  assert.equal(
    segmentCacheKey('a', new Headers({ A: '1', B: '2' })),
    segmentCacheKey('a', new Headers({ B: '2', A: '1' })),
  );
  for (const headers of [
    { Cookie: 'user=1' },
    { Authorization: 'Bearer private' },
  ]) {
    assert.equal(cacheLifetime(new Headers(headers), new Headers()), 0);
  }
  for (const headers of [
    { 'Cache-Control': 'private' },
    { 'Cache-Control': 'no-store' },
    { 'Set-Cookie': 'a=b' },
    { Vary: '*' },
  ]) {
    assert.equal(cacheLifetime(new Headers(), new Headers(headers)), 0);
  }
  assert.equal(
    cacheLifetime(
      new Headers(),
      new Headers({ 'Cache-Control': 'max-age=60', Age: '50' }),
    ),
    10000,
  );
  assert.equal(
    cacheLifetime(new Headers({ 'Cache-Control': 'no-cache' }), new Headers()),
    0,
  );
  assert.equal(
    cacheLifetime(
      new Headers(),
      new Headers({ Expires: 'Thu, 01 Jan 1970 00:00:00 GMT' }),
    ),
    0,
  );
});

test('stream cache is filled only on consumption and respects the entry byte limit', async () => {
  let cached;
  const stream = cacheStream(
    new Response('abcdef').body,
    (data) => {
      cached = data;
    },
    6,
  );
  assert.equal(cached, undefined);
  assert.equal(await new Response(stream).text(), 'abcdef');
  assert.equal(new TextDecoder().decode(cached), 'abcdef');
  cached = undefined;
  assert.equal(
    await new Response(
      cacheStream(
        new Response('abcdefg').body,
        (data) => {
          cached = data;
        },
        6,
      ),
    ).text(),
    'abcdefg',
  );
  assert.equal(cached, undefined);
});

test('cancelling downstream cancels the origin stream without caching partial data', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const reader = cacheStream(body, () =>
    assert.fail('partial data cached'),
  ).getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
});

test('invalid protocols, embedded credentials and private literals are rejected', () => {
  for (const url of [
    'not a url',
    'file:///etc/passwd',
    'https://user:pass@example.com',
    'http://127.1/',
    'http://0x7f000001/',
    'http://169.254.169.254/',
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost/',
  ]) {
    assert.throws(() => validateTarget(url), { statusCode: 400 });
  }
  assert.equal(
    validateTarget('https://cdn.example/file#ignored').href,
    'https://cdn.example/file',
  );
});

test('redirects use the final base URL and strip credentials when origins change', async () => {
  const calls = [];
  const result = await fetchUpstream(
    'https://a.example/start',
    { headers: { Cookie: 'secret', Authorization: 'private' } },
    1000,
    async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { Location: 'https://b.example/final' },
          })
        : new Response('ok');
    },
  );
  assert.equal(result.finalUrl, 'https://b.example/final');
  assert.equal(calls[0].headers.get('cookie'), 'secret');
  assert.equal(calls[1].headers.has('cookie'), false);
  assert.equal(calls[1].headers.has('authorization'), false);
});

test('redirect hops cannot target private addresses or loop forever', async () => {
  await assert.rejects(
    fetchUpstream(
      'https://a.example',
      {},
      1000,
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1/' },
        }),
    ),
    { statusCode: 400 },
  );
  let calls = 0;
  await assert.rejects(
    fetchUpstream('https://a.example', {}, 1000, async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: '/loop' },
      });
    }),
    { statusCode: 502 },
  );
  assert.equal(calls, 6);
});

test('temporary network failures and timeouts produce distinct errors with no retries', async () => {
  let calls = 0;
  await assert.rejects(
    fetchUpstream('https://a.example', {}, 1000, async () => {
      calls++;
      throw new Error('sensitive upstream error');
    }),
    { statusCode: 502, statusMessage: 'Upstream connection failed' },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchUpstream(
      'https://a.example',
      {},
      5,
      async (_url, init) =>
        new Promise((_, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    ),
    { statusCode: 504 },
  );
});

test('playlist response reading enforces its byte budget', async () => {
  assert.equal(await readLimitedText(new Response('#EXTM3U')), '#EXTM3U');
  await assert.rejects(readLimitedText(new Response('too large'), 4), {
    statusCode: 502,
  });
});
