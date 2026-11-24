import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

const children = [];
async function start(auth = false) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    ['--import', './tests/fetch-fixture.mjs', '.output/server/index.mjs'],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        ENABLE_CACHE: 'true',
        TURNSTILE_SECRET: auth ? 'test-secret' : '',
        JWT_SECRET: auth ? 'local-test-signing-key' : '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let logs = '';
  child.stdout.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(base)).ok) {
        return base;
      }
    } catch {}
    if (child.exitCode !== null) {
      throw new Error(logs);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${logs}`);
}
let base;
let protectedBase;
before(async () => {
  base = await start();
  protectedBase = await start(true);
});
after(async () => {
  await Promise.all(
    children.map(async (child) => {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }),
  );
});
const path = (route, upstream, headers) =>
  `${route}?${new URLSearchParams({
    url: `https://cdn.example${upstream}`,
    ...(headers ? { headers: JSON.stringify(headers) } : {}),
  })}`;

test('SDK destination API preserves overrides, response cookie and final destination', async () => {
  const result = await fetch(
    `${base}/?destination=${encodeURIComponent('https://cdn.example/inspect')}`,
    {
      method: 'POST',
      body: 'payload',
      headers: {
        'X-Referer': 'https://source.example/',
        'X-Cookie': 'user=1',
        'X-Token': 'never-forward',
        'CF-Connecting-IP': '1.2.3.4',
      },
    },
  );
  assert.equal(result.status, 200);
  assert.equal(
    result.headers.get('x-final-destination'),
    'https://cdn.example/inspect',
  );
  const data = await result.json();
  assert.equal(data.method, 'POST');
  assert.equal(data.body, 'payload');
  assert.equal(data.headers.referer, 'https://source.example/');
  assert.equal(data.headers.cookie, 'user=1');
  assert.equal(data.headers['x-token'], undefined);
  assert.equal(data.headers['cf-connecting-ip'], undefined);
  const cookie = await fetch(
    `${base}/?destination=${encodeURIComponent('https://cdn.example/cookie')}`,
  );
  assert.equal(cookie.headers.get('x-set-cookie'), 'provider-session=abc');
  assert.equal(cookie.headers.get('set-cookie'), null);
  assert.equal(cookie.headers.get('cache-control'), 'private, no-store');
});

test('playlist redirects resolve every nested resource against the final upstream path', async () => {
  const response = await fetch(
    base +
      path('/m3u8-proxy', '/start', { Referer: 'https://source.example/' }),
  );
  assert.equal(response.status, 200);
  const playlist = await response.text();
  const resources = [...playlist.matchAll(/https?:\/\/[^"\s]+/g)].map(
    ([url]) => new URL(url),
  );
  assert.equal(resources.length, 3);
  assert.deepEqual(
    resources.map((url) => url.searchParams.get('url')),
    [
      'https://cdn.example/final/key',
      'https://cdn.example/final/init.mp4',
      'https://cdn.example/final/seg.mp4',
    ],
  );
  assert.ok(
    resources.every(
      (url) => url.origin === base && url.pathname === '/ts-proxy',
    ),
  );
  const binary = await fetch(resources[0]);
  assert.match(await binary.text(), /https:\/\/source.example\/:1/);
});

test('low latency query directives are forwarded to the upstream playlist', async () => {
  const response = await fetch(
    base +
      path('/m3u8-proxy', '/list.m3u8?directives=1') +
      '&_HLS_msn=12&_HLS_part=2&_HLS_skip=v2',
  );
  assert.match(await response.text(), /#DIRECTIVES:12,2,v2/);
});

test('range requests retain 206, media type, content range, HEAD and 416 behavior', async () => {
  const url = base + path('/ts-proxy', '/movie.mp4');
  const response = await fetch(url, {
    headers: { Range: 'bytes=2-5', 'If-Range': 'etag' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/12');
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(await response.text(), '2345');
  const head = await fetch(url, {
    method: 'HEAD',
    headers: { Range: 'bytes=2-5' },
  });
  assert.equal(head.status, 206);
  assert.equal(await head.text(), '');
  const invalid = await fetch(url, { headers: { Range: 'bytes=999-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */12');
  const root = await fetch(
    `${base}/?destination=${encodeURIComponent(
      'https://cdn.example/movie.mp4',
    )}`,
    { headers: { Range: 'bytes=2-5' } },
  );
  assert.equal(root.status, 206);
  assert.equal(await root.text(), '2345');
});

test('public cache reuses consumed data but separates headers and excludes private data', async () => {
  const url =
    base + path('/ts-proxy', '/cache.mp4', { Referer: 'https://a.example/' });
  assert.equal(await (await fetch(url)).text(), 'https://a.example/:1');
  assert.equal(await (await fetch(url)).text(), 'https://a.example/:1');
  assert.equal(
    await (
      await fetch(
        base +
          path('/ts-proxy', '/cache.mp4', { Referer: 'https://b.example/' }),
      )
    ).text(),
    'https://b.example/:1',
  );
  for (const endpoint of [
    path('/ts-proxy', '/private'),
    path('/ts-proxy', '/user', { Cookie: 'user=1' }),
  ]) {
    const first = await fetch(base + endpoint);
    const text = await first.text();
    assert.match(first.headers.get('cache-control'), /private|no-store/);
    assert.notEqual(await (await fetch(base + endpoint)).text(), text);
  }
});

test('upstream errors keep their status and expose CORS and Retry-After', async () => {
  for (const route of ['/m3u8-proxy', '/ts-proxy']) {
    const denied = await fetch(base + path(route, '/denied'));
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), '*');
    const limited = await fetch(base + path(route, '/rate-limit'));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '7');
    const malformed = await fetch(
      `${base}${route}?url=https://cdn.example/a&headers=[]`,
    );
    assert.equal(malformed.status, 400);
  }
  assert.equal(
    (await fetch(base + path('/m3u8-proxy', '/invalid-playlist'))).status,
    502,
  );
});

test('media authorization is enforced and validated JWTs propagate to nested resources', async () => {
  const endpoint = path('/m3u8-proxy', '/protected.m3u8');
  assert.equal((await fetch(protectedBase + endpoint)).status, 401);
  assert.equal(
    (await fetch(protectedBase + path('/ts-proxy', '/segment'))).status,
    401,
  );
  assert.equal(
    (
      await fetch(protectedBase + endpoint + '&proxy_token=jwt%7Cinvalid', {
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
      })
    ).status,
    401,
  );
  const response = await fetch(protectedBase + endpoint, {
    headers: {
      'CF-Connecting-IP': '1.2.3.4',
      'X-Token': 'turnstile|valid-captcha',
    },
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('x-token'));
  const playlist = await response.text();
  assert.doesNotMatch(playlist, /valid-captcha/);
  const resource = playlist.split('\n').find((line) => line.startsWith('http'));
  assert.match(new URL(resource).searchParams.get('proxy_token'), /^jwt\|/);
  const allowed = await fetch(resource, {
    headers: { 'CF-Connecting-IP': '1.2.3.4' },
  });
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers.get('cache-control'), /private, no-store/);
  assert.equal(
    (await fetch(resource, { headers: { 'CF-Connecting-IP': '9.8.7.6' } }))
      .status,
    401,
  );
});

test('preflight succeeds independently of authorization and never fetches upstream', async () => {
  const response = await fetch(protectedBase + path('/ts-proxy', '/segment'), {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://site.example',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'range,x-token',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('video bytes arrive before the upstream finishes, with downstream cancellation', async () => {
  for (const endpoint of [
    path('/ts-proxy', '/stream'),
    `/?destination=${encodeURIComponent('https://cdn.example/stream')}`,
  ]) {
    const response = await fetch(base + endpoint);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'first');
    await reader.cancel();
  }
});
