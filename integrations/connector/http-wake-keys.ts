import { createPublicKey, type KeyObject } from 'node:crypto';

export const WAKE_KEY_FETCH_TIMEOUT_MS = 3000;
export const WAKE_KEY_SET_MAX_BYTES = 65_536;
const keyIdPattern = /^[A-Za-z0-9._-]{1,64}$/;

export interface WakeVerificationKey {
  key: KeyObject;
  notAfter?: number;
}

export interface WakeKeysOptions {
  origin: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseKeys(value: unknown): Map<string, WakeVerificationKey> {
  if (!record(value) || !Array.isArray(value.keys) || value.keys.length > 32) throw new Error('Invalid wake key set');
  const keys = new Map<string, WakeVerificationKey>();
  for (const candidate of value.keys) {
    if (!record(candidate)) throw new Error('Invalid wake key set');
    if (candidate.kty !== 'OKP' || candidate.crv !== 'Ed25519' || candidate.alg !== 'EdDSA') continue;
    if (typeof candidate.kid !== 'string' || !keyIdPattern.test(candidate.kid) || keys.has(candidate.kid)
      || candidate.use !== 'sig' || typeof candidate.status !== 'string' || !['active', 'next', 'retired'].includes(candidate.status)
      || typeof candidate.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(candidate.x)
      || Buffer.from(candidate.x, 'base64url').toString('base64url') !== candidate.x
      || (candidate.status === 'retired' && typeof candidate.notAfter !== 'string')
      || (candidate.notAfter !== undefined && (typeof candidate.notAfter !== 'string' || !Number.isFinite(Date.parse(candidate.notAfter))))) {
      throw new Error('Invalid wake key set');
    }
    keys.set(candidate.kid, {
      key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: candidate.x }, format: 'jwk' }),
      ...(typeof candidate.notAfter === 'string' ? { notAfter: Date.parse(candidate.notAfter) } : {})
    });
  }
  return keys;
}

function cacheLifetime(headers: Headers): number {
  const control = headers.get('cache-control') ?? '';
  if (/(?:^|,)\s*(?:no-store|no-cache)(?:\s|,|$)/i.test(control)) return 0;
  const matches = [...control.matchAll(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?=,|$)/gi)];
  const age = headers.get('age') ?? '0';
  if (matches.length !== 1 || !/^\d+$/.test(age)) return 0;
  const maximum = Number(matches[0][1]);
  const elapsed = Number(age);
  if (!Number.isSafeInteger(maximum) || !Number.isSafeInteger(elapsed)) return 0;
  return Math.max(0, Math.min(300, maximum) - elapsed) * 1000;
}

export class HttpWakeKeys {
  readonly url: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private cache?: { keys: Map<string, WakeVerificationKey>; expiresAt: number };
  private refreshing?: Promise<boolean>;
  private nextUnknownRefresh = -Infinity;
  private retryRefreshAt = -Infinity;

  constructor(options: WakeKeysOptions) {
    if (typeof options.origin !== 'string' || (options.fetch !== undefined && typeof options.fetch !== 'function')
      || (options.now !== undefined && typeof options.now !== 'function')) throw new Error('Invalid wake key configuration');
    const origin = new URL(options.origin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.href !== `${origin.origin}/`) {
      throw new Error('Wake keys require a configured HTTPS origin');
    }
    this.url = `${origin.origin}/.well-known/envoi-wake-keys.json`;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async get(keyId: string): Promise<WakeVerificationKey | undefined> {
    const current = this.now();
    const known = this.cache?.keys.get(keyId);
    if (known && current < this.cache!.expiresAt) return known;
    if (this.refreshing) {
      if (!await this.refreshing) return undefined;
      return this.cache?.keys.get(keyId);
    }
    if (current < this.retryRefreshAt || (!known && current < this.nextUnknownRefresh)) return undefined;
    if (!known) this.nextUnknownRefresh = current + 60_000;
    const operation = this.refresh();
    this.refreshing = operation;
    try {
      if (!await operation) return undefined;
      return this.cache?.keys.get(keyId);
    } finally {
      if (this.refreshing === operation) this.refreshing = undefined;
    }
  }

  private async refresh(): Promise<boolean> {
    const controller = new AbortController();
    const startedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const timeout = new Promise<never>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Wake key fetch timed out'));
      }, WAKE_KEY_FETCH_TIMEOUT_MS);
    });
    const download = async () => {
      const response = await this.fetcher(this.url, {
        method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/json' }, signal: controller.signal
      });
      if (controller.signal.aborted) throw new Error('Wake key fetch cancelled');
      const length = response.headers.get('content-length');
      if (response.status !== 200 || response.redirected || !response.body
        || (length !== null && (!/^\d+$/.test(length) || Number(length) > WAKE_KEY_SET_MAX_BYTES))) {
        await response.body?.cancel();
        throw new Error('Wake key fetch failed');
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (controller.signal.aborted) throw new Error('Wake key fetch cancelled');
        if (part.done) break;
        size += part.value.byteLength;
        if (size > WAKE_KEY_SET_MAX_BYTES) throw new Error('Wake key set too large');
        chunks.push(part.value);
      }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      return { keys: parseKeys(JSON.parse(body)), expiresAt: startedAt + cacheLifetime(response.headers) };
    };
    try {
      const result = await Promise.race([download(), timeout]);
      this.cache = result;
      this.retryRefreshAt = -Infinity;
      return true;
    } catch {
      this.retryRefreshAt = this.now() + 60_000;
      return false;
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
}
