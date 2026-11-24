export interface CachedSegment {
  data: Uint8Array;
  headers: Record<string, string>;
  status: number;
  expires: number;
  storedAt?: number;
}

export class SegmentCache {
  private entries = new Map<string, CachedSegment>();
  private bytes = 0;
  private maxBytes: number;
  private maxEntries: number;
  constructor(maxBytes = 16 * 1024 * 1024, maxEntries = 128) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  get(key: string, now = Date.now()): CachedSegment | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    if (entry.expires <= now) {
      this.bytes -= entry.data.byteLength;
      return;
    }
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: CachedSegment): void {
    if (entry.data.byteLength > this.maxBytes) {
      return;
    }
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.data.byteLength;
      this.entries.delete(key);
    }
    for (const [oldKey, value] of this.entries) {
      if (value.expires <= Date.now()) {
        this.entries.delete(oldKey);
        this.bytes -= value.data.byteLength;
      }
    }
    while (
      this.entries.size >= this.maxEntries ||
      this.bytes + entry.data.byteLength > this.maxBytes
    ) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) {
        break;
      }
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].data.byteLength;
    }
    this.entries.set(key, entry);
    this.bytes += entry.data.byteLength;
  }
}

export const segmentCache = new SegmentCache();

export function segmentCacheKey(url: string, headers: Headers): string {
  return JSON.stringify([
    url,
    [...headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

export function cacheLifetime(request: Headers, response: Headers): number {
  if (/\b(no-store|no-cache)\b/i.test(request.get('cache-control') ?? '')) {
    return 0;
  }
  if (
    request.has('cookie') ||
    request.has('authorization') ||
    response.has('set-cookie')
  ) {
    return 0;
  }
  const policy = response.get('cache-control') ?? '';
  if (
    /\b(no-store|private|no-cache)\b/i.test(policy) ||
    response.get('vary')?.includes('*')
  ) {
    return 0;
  }
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(policy);
  const expiry = Date.parse(response.get('expires') ?? '');
  const remaining = maxAge
    ? Number(maxAge[1]) - Number(response.get('age') || 0)
    : Number.isFinite(expiry)
    ? (expiry - Date.now()) / 1000
    : 300;
  return Math.max(0, Math.min(remaining, 300)) * 1000;
}

export function cacheStream(
  body: ReadableStream<Uint8Array>,
  save: (data: Uint8Array) => void,
  limit = 1024 * 1024,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let chunks: Uint8Array[] = [];
  let bytes = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (bytes <= limit) {
            const result = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) {
              result.set(chunk, offset);
              offset += chunk.byteLength;
            }
            save(result);
          }
          chunks = [];
          controller.close();
          reader.releaseLock();
          return;
        }
        bytes += value.byteLength;
        if (bytes <= limit) {
          chunks.push(value.slice());
        } else {
          chunks = [];
        }
        controller.enqueue(value);
      } catch (error) {
        chunks = [];
        controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      chunks = [];
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
}
