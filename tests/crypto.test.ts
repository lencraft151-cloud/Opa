import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decryptJson, encryptJson, safeEqual, sha256Hex } from '../src/util/crypto.ts';
import { buildDigestHeader, parseDigestChallenge } from '../src/util/digest.ts';

const SECRET = 'test-secret-key-0123456789';

describe('Verschlüsselung der Integrations-Zugangsdaten', () => {
  it('verschlüsselt und entschlüsselt verlustfrei', () => {
    const secrets = { applicationKey: 'abc123', clientKey: 'DEADBEEF' };
    const payload = encryptJson(secrets, SECRET);
    assert.ok(payload.startsWith('v1.'));
    assert.deepEqual(decryptJson(payload, SECRET), secrets);
  });

  it('erzeugt bei gleichem Klartext unterschiedliche Chiffrate', () => {
    const a = encryptJson({ password: 'geheim' }, SECRET);
    const b = encryptJson({ password: 'geheim' }, SECRET);
    assert.notEqual(a, b, 'IV muss zufällig sein');
  });

  it('scheitert mit falschem Schlüssel', () => {
    const payload = encryptJson({ password: 'geheim' }, SECRET);
    assert.throws(() => decryptJson(payload, 'anderer-schluessel'));
  });

  it('erkennt Manipulation am Chiffrat', () => {
    const payload = encryptJson({ password: 'geheim' }, SECRET);
    const parts = payload.split('.');
    const tampered = [parts[0], parts[1], parts[2], 'AAAA' + (parts[3] as string).slice(4)].join('.');
    assert.throws(() => decryptJson(tampered, SECRET));
  });

  it('weist kaputte Formate zurück', () => {
    assert.throws(() => decryptJson('nonsense', SECRET));
    assert.throws(() => decryptJson('v2.a.b.c', SECRET));
  });

  it('vergleicht Hashes zeitkonstant', () => {
    const hash = sha256Hex('token');
    assert.ok(safeEqual(hash, sha256Hex('token')));
    assert.ok(!safeEqual(hash, sha256Hex('anderes-token')));
    assert.ok(!safeEqual(hash, 'kurz'));
  });
});

describe('HTTP-Digest-Authentifizierung (Shelly Gen2)', () => {
  const header =
    'Digest qop="auth", realm="shellyplus1-a8032ab", nonce="1683723", algorithm=SHA-256';

  it('zerlegt die Challenge', () => {
    const challenge = parseDigestChallenge(header);
    assert.ok(challenge);
    assert.equal(challenge?.realm, 'shellyplus1-a8032ab');
    assert.equal(challenge?.nonce, '1683723');
    assert.equal(challenge?.algorithm, 'SHA-256');
    assert.equal(challenge?.qop, 'auth');
  });

  it('ignoriert Nicht-Digest-Header', () => {
    assert.equal(parseDigestChallenge('Basic realm="x"'), null);
    assert.equal(parseDigestChallenge('Digest realm="x"'), null, 'ohne nonce ungültig');
  });

  it('baut einen vollständigen Authorization-Header', () => {
    const challenge = parseDigestChallenge(header);
    assert.ok(challenge);
    const value = buildDigestHeader(challenge, {
      username: 'admin',
      password: 'geheim',
      method: 'POST',
      uri: '/rpc',
    });
    assert.match(value, /^Digest /);
    assert.match(value, /username="admin"/);
    assert.match(value, /uri="\/rpc"/);
    assert.match(value, /algorithm=SHA-256/);
    assert.match(value, /qop=auth/);
    assert.match(value, /nc=00000001/);
    assert.match(value, /response="[a-f0-9]{64}"/, 'SHA-256 liefert 64 Hex-Zeichen');
  });

  it('nutzt MD5, wenn das Gerät kein SHA-256 anbietet', () => {
    const challenge = parseDigestChallenge('Digest realm="shelly", nonce="42"');
    assert.ok(challenge);
    const value = buildDigestHeader(challenge, {
      username: 'admin',
      password: 'pw',
      method: 'GET',
      uri: '/status',
    });
    assert.match(value, /response="[a-f0-9]{32}"/);
  });
});
