import type { H3Event } from 'h3';

export function setting(event: H3Event, name: string): string | undefined {
  const value =
    event.context.cloudflare?.env?.[name] ??
    (globalThis as Record<string, unknown>)[name] ??
    process.env[name];
  return typeof value === 'string' ? value : undefined;
}

export function upstreamTimeout(event: H3Event): number {
  const value = Number(setting(event, 'UPSTREAM_TIMEOUT_MS'));
  return Number.isFinite(value) && value >= 100 && value <= 60000
    ? value
    : 15000;
}
