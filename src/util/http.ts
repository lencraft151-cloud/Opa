import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { timeout as timeoutError, upstreamError } from '../core/errors.js';

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  json?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  /**
   * Hue Bridges liefern ein selbstsigniertes Zertifikat aus. Die Verbindung
   * bleibt transportverschlüsselt, die Kette wird aber nicht gegen die
   * System-CAs geprüft.
   */
  insecureTLS?: boolean;
  /** Maximale Antwortgröße in Bytes (Schutz gegen Endlos-Streams). */
  maxBodyBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  url: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BODY = 4 * 1024 * 1024;

/** TLS-Agent für Geräte mit selbstsigniertem Zertifikat (Hue Bridge). */
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 8 });
const secureAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });

export function buildUrl(base: string, query?: RequestOptions['query']): string {
  if (!query) return base;
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Führt eine HTTP(S)-Anfrage aus. Bewusst auf `node:http` statt `fetch`
 * aufgebaut: nur so lässt sich pro Anfrage ein TLS-Agent für die
 * selbstsignierten Zertifikate der Hue Bridge setzen und der Response-Stream
 * für Server-Sent-Events offen halten.
 */
export async function request(rawUrl: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const res = await openStream(rawUrl, options);
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const body = await readBody(res, maxBytes);
  return { status: res.statusCode ?? 0, headers: res.headers, body, url: rawUrl };
}

/** Wie `request`, gibt aber den offenen Stream zurück (für SSE/Eventstream). */
export function openStream(rawUrl: string, options: RequestOptions = {}): Promise<IncomingMessage> {
  const url = new URL(buildUrl(rawUrl, options.query));
  const isHttps = url.protocol === 'https:';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let payload: string | Buffer | undefined = options.body;
  if (options.json !== undefined) {
    payload = JSON.stringify(options.json);
    headers['content-type'] ??= 'application/json';
  }
  if (payload !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  headers['accept'] ??= 'application/json, text/plain, */*';
  headers['user-agent'] ??= 'smarthome-hub/1.0';

  const agent = isHttps ? (options.insecureTLS ? insecureAgent : secureAgent) : httpAgent;

  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers,
        agent,
        ...(isHttps && options.insecureTLS ? { rejectUnauthorized: false } : {}),
      },
      (res) => resolve(res),
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(timeoutError(`Zeitüberschreitung nach ${timeoutMs} ms bei ${url.host}`));
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(translateNetworkError(err, url.host));
    });

    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function readBody(res: IncomingMessage, maxBytes = DEFAULT_MAX_BODY): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      res.destroy();
      throw upstreamError('Antwort des Geräts ist zu groß');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function requestJson<T>(rawUrl: string, options: RequestOptions = {}): Promise<T> {
  const res = await request(rawUrl, options);
  if (res.status >= 400) {
    throw upstreamError(`HTTP ${res.status} von ${new URL(rawUrl).host}`, {
      status: res.status,
      body: res.body.slice(0, 500),
    });
  }
  return parseJson<T>(res.body, rawUrl);
}

export function parseJson<T>(body: string, source: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw upstreamError(`Ungültige JSON-Antwort von ${source}`, { body: body.slice(0, 200) });
  }
}

function translateNetworkError(err: NodeJS.ErrnoException, host: string): Error {
  switch (err.code) {
    case 'ECONNREFUSED':
      return upstreamError(`Verbindung zu ${host} abgelehnt – ist das Gerät erreichbar?`);
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return upstreamError(`${host} ist im Netzwerk nicht erreichbar`);
    case 'ENOTFOUND':
      return upstreamError(`Hostname ${host} konnte nicht aufgelöst werden`);
    case 'ETIMEDOUT':
      return timeoutError(`Zeitüberschreitung bei ${host}`);
    default:
      return err;
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

/** Führt eine Operation mit exponentiellem Backoff erneut aus. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 250;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      options.onRetry?.(attempt, err);
      await sleep(base * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Führt viele Aufgaben mit begrenzter Parallelität aus – wichtig beim
 * Subnetz-Scan, damit nicht 254 Sockets gleichzeitig geöffnet werden.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}
