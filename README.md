# simple-proxy

Simple reverse proxy to bypass CORS, used by [movie-web](https://movie-web.app)/[P-Stream](https://pstream.mov).
Read the docs at https://docs.pstream.mov/proxy/introduction

---

### features:

- Deployable on many platforms - thanks to nitro
- header rewrites - read and write protected headers
- bypass CORS - always allows browser to send requests through it
- secure it with turnstile - prevent bots from using your proxy
- parse and bypass m3u8 stream restrictions - make sure the IP is not blocked by the CDN, may need to be on a VPS.
- Optional bounded caching of public media segments (`ENABLE_CACHE=true`, disabled by default).

> [!WARNING]
> Turnstile integration only works properly with cloudflare workers as platform

### supported platforms:

- cloudflare workers
- AWS lambda
- nodejs
- netlify edge functions

### Media proxy behavior

Existing clients keep the same endpoints and header protocol:

- `/?destination=<encoded-url>` forwards API/page requests, including POST bodies and Range headers. `X-Cookie`, `X-Referer`, `X-Origin` and `X-User-Agent` override upstream headers. `X-Set-Cookie` and `X-Final-Destination` expose upstream metadata.
- `/m3u8-proxy?url=<encoded-url>&headers=<encoded-json-object>` rewrites HLS variants, audio/subtitle playlists, relative encryption keys, initialization maps, low latency parts and rendition reports. Relative paths use the final URL after redirects. `_HLS_msn`, `_HLS_part` and `_HLS_skip` are forwarded.
- `/ts-proxy?url=<encoded-url>&headers=<encoded-json-object>` streams segments, keys, subtitles or MP4 data with their original media type and status. GET/HEAD, byte ranges, 206/416 and Retry-After are preserved.

Media responses stream without buffering the complete file. On Node, downstream backpressure and disconnection are propagated. Playlist rewriting has a 1 MiB limit and a 15 second body timeout. No playlist-wide prefetch is performed.

Optional environment variables (also supported as Cloudflare runtime bindings):

| Variable                          | Default | Behavior                                                                                                                                                                  |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTREAM_TIMEOUT_MS`             | `15000` | Timeout until upstream response headers, including redirects; accepted range 100–60000 ms.                                                                                |
| `ENABLE_CACHE`                    | `false` | Cache consumed public GET responses, at most 1 MiB each, 128 entries and 16 MiB total per process/isolate. Maximum lifetime 5 minutes, shortened by upstream max-age/Age. |
| `DISABLE_M3U8`                    | `false` | Disable both media endpoints.                                                                                                                                             |
| `TURNSTILE_SECRET` / `JWT_SECRET` | unset   | Set both to enable existing Turnstile/JWT authentication on API and media routes. A partial configuration fails closed.                                                   |
| `REQ_DEBUG`                       | `false` | Log request method and upstream origin, without credentials, headers or signed URLs.                                                                                      |

Cookie/Authorization requests, Set-Cookie responses, private/no-store/no-cache responses and authenticated media are excluded from shared caching. No private data is cached. Cache entries are populated during playback, expire lazily, and require no background timers. The cache is an optimization, not persistent storage.

When proxy authentication is enabled, send `X-Token: turnstile|<captcha-token>` or `X-Token: jwt|<jwt>`. The response's `X-Token` contains the raw JWT as before. Rewritten HLS URLs carry an IP-bound JWT in `proxy_token` so native players can request nested files. JWTs expire after 10 minutes; clients must renew authorization and reload the playlist for longer sessions. Never log authenticated media URLs. Both secrets unset preserves unauthenticated deployments.

Only HTTP(S) URLs without embedded credentials are accepted. Private IP literals and localhost names are rejected on every redirect; Cookie/Authorization headers are removed when a redirect changes origin. This does not resolve DNS or prevent DNS rebinding. Restrict egress on self-hosted deployments and protect public proxy access as appropriate for your environment.

### Development checks

Install the existing lockfile with `pnpm@10.11.0 install --frozen-lockfile`. Use Node 22.18+ for tests (native TypeScript stripping); no new test dependencies are required.

```sh
npm test
npm run lint
npm run build:cloudflare
```

Tests include mocked upstream HTTP integration against the built Node server, streaming, Range/HEAD, HLS rewriting, bounded cache isolation, redirects, errors and optional authentication. They do not contact or modify real streaming accounts.
