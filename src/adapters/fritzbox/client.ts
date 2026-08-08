import { createHash, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { upstreamError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { request } from '../../util/http.js';
import { child, childText, parseXml, type XmlNode } from '../../util/xml.js';
import { AuthenticationRequiredError } from '../types.js';

const log = createLogger('fritzbox:client');
const pbkdf2Async = promisify(pbkdf2);

/**
 * Client für die FRITZ!Box.
 *
 * Angesprochen wird die AHA-Schnittstelle („Automation Home Api“) unter
 * `/webservices/homeautoswitch.lua`. Sie steuert alles, was per DECT an der
 * Box hängt: Schaltsteckdosen, Heizkörperregler, Lampen und Rollläden.
 *
 * Der Anmeldeweg ist eine Eigenheit von AVM: Die Box stellt eine Aufgabe
 * („Challenge“), der Client rechnet daraus mit dem Passwort eine Antwort und
 * bekommt dafür eine Sitzungs-ID (SID). Es gibt zwei Verfahren – das neuere
 * mit PBKDF2 (ab FRITZ!OS 7.24) und das alte mit MD5. Der Hub beherrscht
 * beide, weil ältere Boxen weiterhin laufen und laufen und laufen.
 */

const AHA_PATH = '/webservices/homeautoswitch.lua';
const LOGIN_PATH = '/login_sid.lua';
/** Eine SID verfällt nach 20 Minuten Untätigkeit; vorher erneuern. */
const SESSION_TTL_MS = 15 * 60 * 1000;
/** Diese SID bedeutet „nicht angemeldet“. */
const INVALID_SID = '0000000000000000';

export interface FritzboxInfo {
  /** Modellname, z. B. „FRITZ!Box 7590“. */
  model: string;
  firmware: string;
}

export class FritzboxClient {
  private sid: string | null = null;
  private sidAt = 0;

  constructor(
    private readonly host: string,
    private readonly username: string,
    private readonly password: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private url(path: string): string {
    return `http://${this.host}${path}`;
  }

  // -------------------------------------------------------------------------
  // Anmeldung
  // -------------------------------------------------------------------------

  /**
   * Prüft, ob unter der Adresse eine FRITZ!Box antwortet. Die Anmeldeseite
   * ist ohne Zugangsdaten erreichbar und nennt bereits das Modell.
   */
  static async probe(host: string, timeoutMs = 5000): Promise<FritzboxInfo> {
    const response = await request(`http://${host}${LOGIN_PATH}?version=2`, { timeoutMs });
    if (response.status >= 400) {
      throw upstreamError(`${host} antwortet mit HTTP ${response.status} auf ${LOGIN_PATH}`);
    }

    const root = parseXml(response.body);
    if (root.name !== 'SessionInfo') {
      throw upstreamError(
        `Unter ${host} antwortet keine FRITZ!Box.`,
        undefined,
        'Erwartet wird eine FRITZ!Box mit aktivierter Smart-Home-Funktion.',
      );
    }

    return {
      model: childText(root, 'BoxInfo') ?? 'FRITZ!Box',
      firmware: childText(root, 'Version') ?? 'unbekannt',
    };
  }

  private async ensureSession(): Promise<string> {
    if (this.sid && Date.now() - this.sidAt < SESSION_TTL_MS) return this.sid;

    const start = await this.fetchSessionInfo();
    const challenge = childText(start, 'Challenge');
    if (!challenge) {
      throw upstreamError('Die FRITZ!Box hat keine Anmeldeaufgabe geschickt.');
    }

    const response = await solveChallenge(challenge, this.password);
    const query = new URLSearchParams({ username: this.username, response });
    const result = await this.fetchSessionInfo(`?version=2&${query.toString()}`);

    const sid = childText(result, 'SID');
    if (!sid || sid === INVALID_SID) {
      const blockedFor = Number(childText(result, 'BlockTime') ?? '0');
      throw new AuthenticationRequiredError(
        blockedFor > 0
          ? `Die FRITZ!Box sperrt weitere Versuche noch ${blockedFor} Sekunden.`
          : `Anmeldung an der FRITZ!Box ${this.host} fehlgeschlagen.`,
      );
    }

    this.sid = sid;
    this.sidAt = Date.now();
    log.debug('An der FRITZ!Box angemeldet', { host: this.host });
    return sid;
  }

  private async fetchSessionInfo(query = '?version=2'): Promise<XmlNode> {
    const response = await request(this.url(`${LOGIN_PATH}${query}`), {
      timeoutMs: this.timeoutMs,
    });
    if (response.status >= 400) {
      throw upstreamError(`Die FRITZ!Box antwortet mit HTTP ${response.status} beim Anmelden.`);
    }
    return parseXml(response.body);
  }

  /** Meldet die Sitzung ab. Die Box erlaubt nur eine Handvoll gleichzeitig. */
  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      await request(this.url(`${LOGIN_PATH}?logout=1&sid=${this.sid}`), {
        timeoutMs: this.timeoutMs,
      });
    } catch {
      /* beim Beenden nicht weiter wichtig */
    }
    this.sid = null;
  }

  // -------------------------------------------------------------------------
  // AHA-Schnittstelle
  // -------------------------------------------------------------------------

  /**
   * Ruft ein Kommando auf. Bei einer abgelaufenen Sitzung (HTTP 403) wird
   * genau einmal neu angemeldet – das ist der Normalfall, kein Fehler.
   */
  async command(switchcmd: string, params: Record<string, string> = {}): Promise<string> {
    const send = async (sid: string): Promise<{ status: number; body: string }> => {
      const query = new URLSearchParams({ ...params, switchcmd, sid });
      return request(this.url(`${AHA_PATH}?${query.toString()}`), { timeoutMs: this.timeoutMs });
    };

    let response = await send(await this.ensureSession());
    if (response.status === 403) {
      log.debug('Sitzung abgelaufen – melde erneut an', { host: this.host });
      this.sid = null;
      response = await send(await this.ensureSession());
    }

    if (response.status === 400) {
      throw upstreamError(
        'Die FRITZ!Box lehnt den Befehl ab.',
        { switchcmd },
        'Das Gerät unterstützt diese Funktion vermutlich nicht.',
      );
    }
    if (response.status >= 400) {
      throw upstreamError(
        `Die FRITZ!Box antwortet mit HTTP ${response.status}.`,
        { switchcmd },
        response.status === 403
          ? 'Hat der Benutzer die Berechtigung "Smart Home"? Ohne sie bleibt die Schnittstelle zu.'
          : undefined,
      );
    }
    return response.body.trim();
  }

  /** Die vollständige Geräteliste als XML-Baum. */
  async deviceList(): Promise<XmlNode> {
    const body = await this.command('getdevicelistinfos');
    const root = parseXml(body);
    if (root.name !== 'devicelist') {
      throw upstreamError('Die FRITZ!Box hat keine Geräteliste geschickt.');
    }
    return root;
  }

  /** Modell und Firmware – für die Anzeige und die Update-Prüfung. */
  async info(): Promise<FritzboxInfo> {
    const root = await this.fetchSessionInfo();
    return {
      model: childText(root, 'BoxInfo') ?? 'FRITZ!Box',
      firmware: childText(root, 'Version') ?? 'unbekannt',
    };
  }
}

// ---------------------------------------------------------------------------
// Anmeldeaufgabe lösen
// ---------------------------------------------------------------------------

/**
 * Beantwortet die Aufgabe der FRITZ!Box.
 *
 * Neu (ab FRITZ!OS 7.24): `2$<runden1>$<salz1>$<runden2>$<salz2>`. Aus dem
 * Passwort wird zweimal PBKDF2-SHA256 gerechnet; die Antwort ist
 * `<salz2>$<ergebnis>`.
 *
 * Alt: eine einfache Zeichenkette. Die Antwort ist
 * `<aufgabe>-<md5(aufgabe-passwort in UTF-16LE)>`. Das UTF-16LE ist die
 * Stelle, an der fremde Implementierungen üblicherweise scheitern.
 */
export async function solveChallenge(challenge: string, password: string): Promise<string> {
  if (challenge.startsWith('2$')) {
    const [, rounds1, salt1, rounds2, salt2] = challenge.split('$');
    if (!rounds1 || !salt1 || !rounds2 || !salt2) {
      throw upstreamError('Die Anmeldeaufgabe der FRITZ!Box ist unvollständig.');
    }
    const first = await pbkdf2Async(
      Buffer.from(password, 'utf8'),
      Buffer.from(salt1, 'hex'),
      Number(rounds1),
      32,
      'sha256',
    );
    const second = await pbkdf2Async(first, Buffer.from(salt2, 'hex'), Number(rounds2), 32, 'sha256');
    return `${salt2}$${second.toString('hex')}`;
  }

  const digest = createHash('md5')
    .update(Buffer.from(`${challenge}-${password}`, 'utf16le'))
    .digest('hex');
  return `${challenge}-${digest}`;
}

/** Nur für Tests und Fehlersuche. */
export function isValidSid(sid: string | undefined): boolean {
  return Boolean(sid) && sid !== INVALID_SID;
}

export { child, AHA_PATH, LOGIN_PATH };
