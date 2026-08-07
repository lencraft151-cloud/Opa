import { createHash, randomBytes } from 'node:crypto';

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  algorithm?: string;
  opaque?: string;
}

/**
 * Zerlegt einen `WWW-Authenticate: Digest ...` Header.
 * Shelly Gen2+ verwendet SHA-256 mit `qop=auth`.
 */
export function parseDigestChallenge(header: string): DigestChallenge | null {
  const match = /^\s*Digest\s+(.*)$/i.exec(header);
  if (!match) return null;
  const params: Record<string, string> = {};
  const regex = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(match[1] as string)) !== null) {
    const key = (m[1] as string).toLowerCase();
    params[key] = (m[2] ?? m[3] ?? '') as string;
  }
  if (!params['realm'] || !params['nonce']) return null;
  const challenge: DigestChallenge = { realm: params['realm'], nonce: params['nonce'] };
  if (params['qop']) challenge.qop = params['qop'];
  if (params['algorithm']) challenge.algorithm = params['algorithm'];
  if (params['opaque']) challenge.opaque = params['opaque'];
  return challenge;
}

function hash(algorithm: string, value: string): string {
  const algo = algorithm.toUpperCase().startsWith('SHA-256') ? 'sha256' : 'md5';
  return createHash(algo).update(value, 'utf8').digest('hex');
}

export interface DigestCredentials {
  username: string;
  password: string;
  method: string;
  uri: string;
  nc?: number;
}

/**
 * Baut den `Authorization: Digest ...` Header nach RFC 7616 (qop=auth).
 */
export function buildDigestHeader(challenge: DigestChallenge, creds: DigestCredentials): string {
  const algorithm = challenge.algorithm ?? 'MD5';
  const cnonce = randomBytes(8).toString('hex');
  const nc = (creds.nc ?? 1).toString(16).padStart(8, '0');

  const ha1 = hash(algorithm, `${creds.username}:${challenge.realm}:${creds.password}`);
  const ha2 = hash(algorithm, `${creds.method.toUpperCase()}:${creds.uri}`);

  const qop = challenge.qop?.split(',').map((v) => v.trim()).includes('auth') ? 'auth' : undefined;
  const response = qop
    ? hash(algorithm, `${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(algorithm, `${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${creds.username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${creds.uri}"`,
    `algorithm=${algorithm}`,
    `response="${response}"`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export function buildBasicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}
