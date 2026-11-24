import test from 'node:test';
import assert from 'node:assert/strict';
import { setting, upstreamTimeout } from '../src/utils/settings.ts';

test('Cloudflare module runtime bindings take precedence over process variables', () => {
  const previous = process.env.UPSTREAM_TIMEOUT_MS;
  try {
    process.env.UPSTREAM_TIMEOUT_MS = '1000';
    const event = {
      context: { cloudflare: { env: { UPSTREAM_TIMEOUT_MS: '2000' } } },
    };
    assert.equal(setting(event, 'UPSTREAM_TIMEOUT_MS'), '2000');
    assert.equal(upstreamTimeout(event), 2000);
    assert.equal(upstreamTimeout({ context: {} }), 1000);
  } finally {
    if (previous === undefined) {
      delete process.env.UPSTREAM_TIMEOUT_MS;
    } else {
      process.env.UPSTREAM_TIMEOUT_MS = previous;
    }
  }
});

test('Cloudflare service-worker global bindings are read without capturing secrets at module load', () => {
  const previous = globalThis.JWT_SECRET;
  try {
    globalThis.JWT_SECRET = 'first';
    assert.equal(setting({ context: {} }, 'JWT_SECRET'), 'first');
    globalThis.JWT_SECRET = 'second';
    assert.equal(setting({ context: {} }, 'JWT_SECRET'), 'second');
  } finally {
    if (previous === undefined) {
      delete globalThis.JWT_SECRET;
    } else {
      globalThis.JWT_SECRET = previous;
    }
  }
});

test('invalid or excessively large upstream timeouts use the bounded default', () => {
  for (const value of ['nope', '-1', '0', '99', '60001']) {
    assert.equal(
      upstreamTimeout({
        context: { cloudflare: { env: { UPSTREAM_TIMEOUT_MS: value } } },
      }),
      15000,
    );
  }
});
