const counts = new Map();
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'challenges.cloudflare.com') {
    return Response.json({
      success: String(init.body.get('response')) === 'valid-captcha',
    });
  }
  if (!url.hostname.endsWith('.example')) {
    return nativeFetch(input, init);
  }
  const headers = new Headers(init.headers);
  const key = `${url.href}:${headers.get('referer')}:${headers.get('cookie')}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if (url.pathname === '/inspect') {
    return Response.json({
      headers: Object.fromEntries(headers),
      method: init.method,
      body: init.body?.toString(),
      count: counts.get(key),
    });
  }
  if (url.pathname === '/stream') {
    let timer;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first'));
          timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('last'));
            controller.close();
          }, 500);
        },
        cancel() {
          clearTimeout(timer);
        },
      }),
    );
  }
  if (url.pathname === '/start') {
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://cdn.example/final/list.m3u8' },
    });
  }
  if (url.pathname.endsWith('.m3u8')) {
    if (url.searchParams.has('directives')) {
      return new Response(
        `#EXTM3U\n#DIRECTIVES:${url.searchParams.get(
          '_HLS_msn',
        )},${url.searchParams.get('_HLS_part')},${url.searchParams.get(
          '_HLS_skip',
        )}\nseg.ts`,
      );
    }
    return new Response(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg.mp4\n',
      { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } },
    );
  }
  if (url.pathname === '/denied') {
    return new Response('Forbidden', { status: 403 });
  }
  if (url.pathname === '/rate-limit') {
    return new Response('Slow down', {
      status: 429,
      headers: { 'Retry-After': '7' },
    });
  }
  if (url.pathname === '/invalid-playlist') {
    return new Response('<html>captcha</html>');
  }
  if (headers.has('range')) {
    if (headers.get('range') === 'bytes=999-') {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': 'bytes */12' },
      });
    }
    return new Response('2345', {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes 2-5/12',
        'Accept-Ranges': 'bytes',
        'Content-Length': '4',
      },
    });
  }
  const responseHeaders = {
    'Content-Type': url.pathname.endsWith('.key')
      ? 'application/octet-stream'
      : 'video/mp4',
    'Cache-Control':
      url.pathname === '/private' ? 'private, no-store' : 'public, max-age=60',
    'X-Origin-Count': String(counts.get(key)),
  };
  if (url.pathname === '/cookie') {
    responseHeaders['Set-Cookie'] = 'provider-session=abc';
  }
  return new Response(
    `${headers.get('cookie') || headers.get('referer') || 'media'}:${counts.get(
      key,
    )}`,
    { headers: responseHeaders },
  );
};
