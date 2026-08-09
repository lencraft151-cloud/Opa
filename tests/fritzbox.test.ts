/**
 * FRITZ!Box: XML-Leser, Anmeldeaufgabe und die Abbildung der Geräteliste.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { FritzboxAdapter } from '../src/adapters/fritzbox/adapter.ts';
import { FritzboxClient, solveChallenge } from '../src/adapters/fritzbox/client.ts';
import {
  celsiusToHalfDegrees,
  FUNCTION,
  halfDegreesToCelsius,
  has,
  parseDevice,
} from '../src/adapters/fritzbox/mapping.ts';
import { child, childNumber, childText, children, parseXml } from '../src/util/xml.ts';
import { setLogLevel } from '../src/core/logger.ts';
import type { IntegrationContext } from '../src/adapters/types.ts';

setLogLevel('silent');

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

describe('XML lesen', () => {
  it('liest Elemente, Attribute und Text', () => {
    const root = parseXml(`
      <devicelist version="1" fwversion="7.57">
        <device identifier="08761 0000434" id="17" productname="FRITZ!DECT 200">
          <name>Steckdose Wohnzimmer</name>
          <switch><state>1</state></switch>
        </device>
      </devicelist>`);

    assert.equal(root.name, 'devicelist');
    assert.equal(root.attrs['version'], '1');
    const device = child(root, 'device');
    assert.equal(device?.attrs['identifier'], '08761 0000434');
    assert.equal(childText(device, 'name'), 'Steckdose Wohnzimmer');
    assert.equal(childText(child(device, 'switch'), 'state'), '1');
  });

  it('kommt mit selbstschließenden Elementen zurecht', () => {
    const root = parseXml('<a><b x="1"/><c>text</c></a>');
    assert.equal(children(root, 'b').length, 1);
    assert.equal(childText(root, 'c'), 'text');
  });

  it('überspringt Deklaration, Kommentare und CDATA', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- Kommentar --><a><b><![CDATA[<roh>]]></b></a>`,
    );
    assert.equal(childText(root, 'b'), '<roh>');
  });

  it('löst Entities auf', () => {
    const root = parseXml('<a name="Bad &amp; Flur"><b>1 &lt; 2</b></a>');
    assert.equal(root.attrs['name'], 'Bad & Flur');
    assert.equal(childText(root, 'b'), '1 < 2');
  });

  it('lässt sich von einem `>` im Attribut nicht täuschen', () => {
    const root = parseXml('<a title="a > b"><b>x</b></a>');
    assert.equal(root.attrs['title'], 'a > b');
    assert.equal(childText(root, 'b'), 'x');
  });

  it('gibt für fehlende Kinder undefined statt zu werfen', () => {
    const root = parseXml('<a></a>');
    assert.equal(childText(root, 'gibtesnicht'), undefined);
    assert.equal(childNumber(root, 'gibtesnicht'), undefined);
  });

  it('meldet fehlendes XML als Fehler', () => {
    assert.throws(() => parseXml('kein xml'), /kein XML-Element/);
  });
});

// ---------------------------------------------------------------------------
// Anmeldeaufgabe
// ---------------------------------------------------------------------------

describe('Anmeldeaufgabe der FRITZ!Box lösen', () => {
  it('rechnet das alte MD5-Verfahren in UTF-16LE', async () => {
    // Genau dieses UTF-16LE ist die Stelle, an der Nachbauten scheitern.
    const challenge = '1234567z';
    const password = 'äbc';
    const expected = createHash('md5')
      .update(Buffer.from(`${challenge}-${password}`, 'utf16le'))
      .digest('hex');

    assert.equal(await solveChallenge(challenge, password), `${challenge}-${expected}`);
  });

  it('rechnet das neue PBKDF2-Verfahren', async () => {
    // Beispiel aus der AVM-Dokumentation (Aufbau, nicht der Wert).
    const challenge = '2$10000$5A1711$2000$5A1722';
    const response = await solveChallenge(challenge, 'geheim');

    const [salt, hash] = response.split('$');
    assert.equal(salt, '5A1722', 'die Antwort beginnt mit dem zweiten Salz');
    assert.match(hash ?? '', /^[0-9a-f]{64}$/, 'danach folgt ein SHA-256-Wert');
  });

  it('liefert für dasselbe Passwort immer dieselbe Antwort', async () => {
    const challenge = '2$10000$5A1711$2000$5A1722';
    assert.equal(await solveChallenge(challenge, 'geheim'), await solveChallenge(challenge, 'geheim'));
    assert.notEqual(
      await solveChallenge(challenge, 'geheim'),
      await solveChallenge(challenge, 'anders'),
    );
  });
});

// ---------------------------------------------------------------------------
// Geräteliste
// ---------------------------------------------------------------------------

describe('Geräte der FRITZ!Box abbilden', () => {
  const device = (xml: string) => parseDevice(parseXml(xml));

  it('erkennt eine Schaltsteckdose mit Verbrauchsmessung', () => {
    // Auszug aus der Antwort einer FRITZ!DECT 200.
    const result = device(`
      <device identifier="08761 0000434" functionbitmask="35712" fwversion="04.16"
              manufacturer="AVM" productname="FRITZ!DECT 200">
        <present>1</present>
        <name>Steckdose Wohnzimmer</name>
        <switch><state>1</state><mode>manuell</mode></switch>
        <powermeter><voltage>231864</voltage><power>45230</power><energy>1080</energy></powermeter>
        <temperature><celsius>235</celsius><offset>0</offset></temperature>
      </device>`);

    assert.ok(result);
    assert.equal(result.ain, '08761 0000434');
    assert.equal(result.name, 'Steckdose Wohnzimmer');
    assert.equal(result.present, true);
    assert.deepEqual(
      [...result.capabilities].sort(),
      ['sensor.energy', 'sensor.power', 'sensor.temperature', 'switch'],
    );
    assert.equal(result.state.on, true);
    assert.equal(result.state.powerW, 45.23, 'Milliwatt werden zu Watt');
    assert.equal(result.state.energyWh, 1080);
    assert.equal(result.state.temperatureC, 23.5, 'Zehntelgrad werden zu Grad');
  });

  it('erkennt einen Heizkörperregler', () => {
    const result = device(`
      <device identifier="09995 0123456" functionbitmask="320" productname="FRITZ!DECT 301">
        <present>1</present>
        <name>Heizung Bad</name>
        <battery>78</battery>
        <batterylow>0</batterylow>
        <temperature><celsius>210</celsius></temperature>
        <hkr><tist>42</tist><tsoll>44</tsoll><komfort>42</komfort><absenk>34</absenk></hkr>
      </device>`);

    assert.ok(result);
    assert.ok(result.capabilities.includes('thermostat'));
    assert.equal(result.state.targetTemperatureC, 22, '44 halbe Grad sind 22 °C');
    assert.equal(result.state.temperatureC, 21);
    assert.equal(result.state.batteryPercent, 78);
  });

  it('versteht die Sonderwerte des Heizkörperreglers', () => {
    // 253 heißt „aus“, 254 „dauerhaft auf“ – keine Temperaturen.
    assert.equal(halfDegreesToCelsius(253), 8);
    assert.equal(halfDegreesToCelsius(254), 28);
    assert.equal(halfDegreesToCelsius(44), 22);
    assert.equal(halfDegreesToCelsius(2), null, 'außerhalb des Bereichs');

    assert.equal(celsiusToHalfDegrees(22), 44);
    assert.equal(celsiusToHalfDegrees(4), 16, 'unter 8 °C kann die Box nicht');
    assert.equal(celsiusToHalfDegrees(35), 56, 'über 28 °C auch nicht');
  });

  it('erkennt eine Lampe mit Farbe', () => {
    const result = device(`
      <device identifier="13077 0000123" functionbitmask="237572" productname="FRITZ!DECT 500">
        <present>1</present>
        <name>Stehlampe</name>
        <simpleonoff><state>1</state></simpleonoff>
        <levelcontrol><level>128</level><levelpercentage>50</levelpercentage></levelcontrol>
        <colorcontrol supported_modes="5" current_mode="1">
          <hue>35</hue><saturation>214</saturation><temperature>2700</temperature>
        </colorcontrol>
      </device>`);

    assert.ok(result);
    assert.ok(result.capabilities.includes('dimmer'));
    assert.ok(result.capabilities.includes('color'));
    assert.equal(result.state.brightness, 50);
    assert.equal(result.state.hue, 35);
    assert.equal(result.state.saturation, 83.9, 'AVM zählt Sättigung in 0..255');
  });

  it('nimmt im Weißton-Modus die Farbtemperatur', () => {
    const result = device(`
      <device identifier="1" functionbitmask="237572">
        <present>1</present><name>Decke</name>
        <colorcontrol current_mode="4"><temperature>3000</temperature></colorcontrol>
      </device>`);
    assert.equal(result?.state.colorTemperatureK, 3000);
    assert.equal(result?.state.hue, undefined);
  });

  it('dreht die Zählrichtung eines Rollladens um', () => {
    /*
     * AVM zählt wie die Rollladenhöhe: 0 = offen, 100 = geschlossen. Der Hub
     * zählt umgekehrt, wie überall sonst auch – sonst führe der Regler in
     * der Oberfläche in die falsche Richtung.
     */
    const result = device(`
      <device identifier="13077 0000999" functionbitmask="335888" productname="Rollotron 1213">
        <present>1</present>
        <name>Rollladen Küche</name>
        <levelcontrol><level>77</level><levelpercentage>30</levelpercentage></levelcontrol>
        <blind><endpositionsset>1</endpositionsset><mode>manuell</mode></blind>
      </device>`);

    assert.ok(result);
    assert.deepEqual(result.capabilities, ['cover']);
    assert.equal(result.state.position, 70, '30 % geschlossen sind 70 % offen');
  });

  it('macht aus einem Rollladen keinen Schalter', () => {
    // Ein Rollladen meldet auch das „switchable“-Bit; als Schalter wäre er
    // in der Oberfläche eine Lampe mit Kippschalter.
    const result = device(`
      <device identifier="1" functionbitmask="335888">
        <present>1</present><name>Rollladen</name>
        <switch><state>0</state></switch>
        <levelcontrol><levelpercentage>0</levelpercentage></levelcontrol>
        <blind><endpositionsset>1</endpositionsset></blind>
      </device>`);
    assert.deepEqual(result?.capabilities, ['cover']);
    assert.equal(result?.state.position, 100);
    assert.equal(result?.state.coverState, 'open');
  });

  it('meldet ein abwesendes Gerät als nicht erreichbar', () => {
    const result = device(`
      <device identifier="1" functionbitmask="35712">
        <present>0</present><name>Steckdose Keller</name>
        <switch><state>0</state></switch>
      </device>`);
    assert.equal(result?.present, false);
  });

  it('lässt Geräte ohne verwertbare Fähigkeit weg', () => {
    // Ein DECT-Repeater kann nichts, was auf eine Gerätekarte gehört.
    const result = device(`
      <device identifier="1" functionbitmask="1024"><present>1</present><name>Repeater</name></device>`);
    assert.equal(result, null);
  });

  it('liest die Fähigkeiten aus der Bitmaske', () => {
    // 35712 = Steckdose + Temperatur + Energie + schaltbar
    assert.equal(has(35712, FUNCTION.outlet), true);
    assert.equal(has(35712, FUNCTION.temperatureSensor), true);
    assert.equal(has(35712, FUNCTION.switchable), true);
    assert.equal(has(35712, FUNCTION.blind), false);
    assert.equal(has(335888, FUNCTION.blind), true);
  });
});

// ---------------------------------------------------------------------------
// Adapter gegen eine simulierte Box
// ---------------------------------------------------------------------------

const PASSWORD = 'fritz-geheim';
const CHALLENGE = 'abcdef12';
const SID = 'a1b2c3d4e5f60718';

interface MockState {
  switchOn: boolean;
  targetHalfDegrees: number;
  blindPercentClosed: number;
  calls: string[];
}

function createMockFritzbox(state: MockState): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const xml = (body: string, status = 200): void => {
      res.writeHead(status, { 'content-type': 'text/xml' });
      res.end(body);
    };

    if (url.pathname === '/login_sid.lua') {
      const response = url.searchParams.get('response');
      if (!response) {
        return xml(
          `<SessionInfo><SID>0000000000000000</SID><Challenge>${CHALLENGE}</Challenge>` +
            `<BlockTime>0</BlockTime><BoxInfo>FRITZ!Box 7590</BoxInfo><Version>7.57</Version></SessionInfo>`,
        );
      }
      const expected = await solveChallenge(CHALLENGE, PASSWORD);
      const sid = response === expected ? SID : '0000000000000000';
      return xml(
        `<SessionInfo><SID>${sid}</SID><Challenge>${CHALLENGE}</Challenge>` +
          `<BlockTime>0</BlockTime><BoxInfo>FRITZ!Box 7590</BoxInfo><Version>7.57</Version></SessionInfo>`,
      );
    }

    if (url.pathname === '/webservices/homeautoswitch.lua') {
      if (url.searchParams.get('sid') !== SID) {
        res.writeHead(403);
        return res.end('0');
      }
      const cmd = url.searchParams.get('switchcmd') ?? '';
      state.calls.push(`${cmd}?${url.searchParams.get('param') ?? url.searchParams.get('level') ?? url.searchParams.get('target') ?? ''}`);

      switch (cmd) {
        case 'setswitchon':
          state.switchOn = true;
          break;
        case 'setswitchoff':
          state.switchOn = false;
          break;
        case 'sethkrtsoll':
          state.targetHalfDegrees = Number(url.searchParams.get('param'));
          break;
        case 'setlevelpercentage':
          state.blindPercentClosed = Number(url.searchParams.get('level'));
          break;
        default:
          break;
      }

      if (cmd !== 'getdevicelistinfos') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('1');
      }

      return xml(`<devicelist version="1" fwversion="7.57">
        <device identifier="08761 0000434" functionbitmask="35712" productname="FRITZ!DECT 200"
                manufacturer="AVM" fwversion="04.16">
          <present>1</present><name>Steckdose Wohnzimmer</name>
          <switch><state>${state.switchOn ? 1 : 0}</state></switch>
          <powermeter><power>45230</power><energy>1080</energy></powermeter>
          <temperature><celsius>235</celsius></temperature>
        </device>
        <device identifier="09995 0123456" functionbitmask="320" productname="FRITZ!DECT 301">
          <present>1</present><name>Heizung Bad</name><battery>78</battery>
          <temperature><celsius>210</celsius></temperature>
          <hkr><tist>42</tist><tsoll>${state.targetHalfDegrees}</tsoll></hkr>
        </device>
        <device identifier="13077 0000999" functionbitmask="335888" productname="Rollotron">
          <present>1</present><name>Rollladen Küche</name>
          <levelcontrol><levelpercentage>${state.blindPercentClosed}</levelpercentage></levelcontrol>
          <blind><endpositionsset>1</endpositionsset></blind>
        </device>
        <group identifier="grp1" functionbitmask="35712" productname="Gruppe">
          <present>1</present><name>Alle Steckdosen</name>
          <switch><state>0</state></switch>
        </group>
      </devicelist>`);
    }

    res.writeHead(404);
    res.end();
  });
}

describe('FRITZ!Box-Adapter gegen eine simulierte Box', () => {
  const adapter = new FritzboxAdapter();
  const state: MockState = {
    switchOn: false,
    targetHalfDegrees: 44,
    blindPercentClosed: 30,
    calls: [],
  };
  let server: http.Server;
  let host = '';

  before(async () => {
    server = createMockFritzbox(state);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const context = (): IntegrationContext =>
    ({
      config: { host, username: 'hub' },
      secrets: { password: PASSWORD },
    }) as unknown as IntegrationContext;

  it('erkennt die Box an der Anmeldeseite', async () => {
    const info = await FritzboxClient.probe(host);
    assert.equal(info.model, 'FRITZ!Box 7590');
    assert.equal(info.firmware, '7.57');
  });

  it('verbindet sich und meldet ein falsches Passwort verständlich', async () => {
    const result = await adapter.link({ host, username: 'hub', password: PASSWORD });
    assert.equal(result.externalId, `fritzbox-${host}`);
    assert.equal((result.config as { username: string }).username, 'hub');

    await assert.rejects(
      () => adapter.link({ host, username: 'hub', password: 'falsch' }),
      /fehlgeschlagen/,
    );
  });

  it('verlangt ein Passwort und sagt, wo es herkommt', async () => {
    await assert.rejects(
      () => adapter.link({ host, username: 'hub' }),
      (err: Error & { hint?: string }) => {
        assert.match(err.hint ?? '', /FRITZ!Box-Benutzer/);
        return true;
      },
    );
  });

  it('liest alle Geräte samt Gruppen', async () => {
    const devices = await adapter.listDevices(context());
    const names = devices.map((device) => device.name).sort();
    assert.deepEqual(names, [
      'Alle Steckdosen',
      'Heizung Bad',
      'Rollladen Küche',
      'Steckdose Wohnzimmer',
    ]);

    const outlet = devices.find((device) => device.name === 'Steckdose Wohnzimmer');
    assert.equal(outlet?.model, 'FRITZ!DECT 200');
    assert.equal(outlet?.state.powerW, 45.23);
  });

  it('schaltet eine Steckdose', async () => {
    const result = await adapter.execute(context(), '08761 0000434', {
      type: 'setPower',
      on: true,
    });
    assert.equal(result.on, true);
    assert.equal(state.switchOn, true);
  });

  it('stellt die Solltemperatur in halben Grad', async () => {
    await adapter.execute(context(), '09995 0123456', {
      type: 'setTargetTemperature',
      targetTemperatureC: 21.5,
    });
    assert.equal(state.targetHalfDegrees, 43, '21,5 °C sind 43 halbe Grad');
  });

  it('dreht die Rollladenposition beim Schreiben zurück', async () => {
    await adapter.execute(context(), '13077 0000999', { type: 'setPosition', position: 80 });
    assert.equal(state.blindPercentClosed, 20, '80 % offen sind 20 % geschlossen');

    const devices = await adapter.listDevices(context());
    const blind = devices.find((device) => device.name === 'Rollladen Küche');
    assert.equal(blind?.state.position, 80, 'und beim Lesen wieder zurück');
  });

  it('erklärt, was die Box nicht kann', async () => {
    await assert.rejects(
      () => adapter.execute(context(), '13077 0000999', { type: 'setTilt', tilt: 50 }),
      /Lamellen/,
    );
    await assert.rejects(
      () => adapter.execute(context(), '08761 0000434', { type: 'identify' }),
      /blinken/,
    );
  });

  it('meldet sich nach einer abgelaufenen Sitzung neu an', async () => {
    // Eine neue Client-Instanz mit ungültiger Sitzung: Der erste Aufruf
    // bekommt 403, danach wird neu angemeldet.
    const fresh = new FritzboxAdapter();
    const devices = await fresh.listDevices(context());
    assert.ok(devices.length > 0);
  });
});

describe('Anmeldung ohne Benutzernamen', () => {
  /*
   * Viele Boxen sind auf „Anmeldung nur mit Passwort" eingestellt – dort gibt
   * es gar keinen Namen einzutragen. Der Adapter verlangte trotzdem einen,
   * und die Oberfläche fragte danach: ein Pflichtfeld, das niemand ausfüllen
   * konnte.
   */
  it('schickt eine leere Kennung mit, statt sie zu erzwingen', async () => {
    const challenge = '1234567z';
    const password = 'boxkennwort';
    let seenUsername: string | null = null;

    const box = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://box');
      if (url.pathname === '/login_sid.lua') {
        const response = url.searchParams.get('response');
        if (!response) {
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(
            `<?xml version="1.0"?><SessionInfo><SID>0000000000000000</SID>` +
              `<Challenge>${challenge}</Challenge><BoxInfo>FRITZ!Box 7590</BoxInfo>` +
              `<Version>7.57</Version></SessionInfo>`,
          );
          return;
        }
        seenUsername = url.searchParams.get('username');
        const expected = await solveChallenge(challenge, password);
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(
          `<?xml version="1.0"?><SessionInfo>` +
            `<SID>${response === expected ? 'abcdef0123456789' : '0000000000000000'}</SID>` +
            `<BoxInfo>FRITZ!Box 7590</BoxInfo><Version>7.57</Version></SessionInfo>`,
        );
        return;
      }
      if (url.pathname === '/webservices/homeautoswitch.lua') {
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end('<devicelist version="1"></devicelist>');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const port = await new Promise<number>((resolve) => {
      box.listen(0, '127.0.0.1', () => resolve((box.address() as AddressInfo).port));
    });

    try {
      const client = new FritzboxClient(`127.0.0.1:${port}`, '', password);
      await client.deviceList();
      assert.equal(seenUsername, '', 'die Box bekommt eine leere Kennung und nimmt ihren Standard');
    } finally {
      box.close();
    }
  });

  /**
   * Der Hub darf sich nicht selbst aussperren.
   *
   * Eine FRITZ!Box zählt Fehlversuche und sperrt danach die Anmeldung – für
   * die Weboberfläche gleich mit. Ein Hub, der im Abfragetakt mit einem
   * falschen Kennwort anklopft, erzeugt genau diese Sperre und hält sie
   * danach am Leben. Nach einer Ablehnung wird deshalb gewartet, und zwar
   * ohne die Box überhaupt anzufassen.
   */
  it('klopft nach einer abgelehnten Anmeldung nicht weiter an', async () => {
    let loginAttempts = 0;

    const box = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://box');
      if (url.pathname !== '/login_sid.lua') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      if (!url.searchParams.get('response')) {
        res.end(
          `<?xml version="1.0"?><SessionInfo><SID>0000000000000000</SID>` +
            `<Challenge>1234567z</Challenge><BlockTime>0</BlockTime></SessionInfo>`,
        );
        return;
      }
      // Jede beantwortete Aufgabe wird abgelehnt – falsches Kennwort.
      loginAttempts += 1;
      res.end(
        `<?xml version="1.0"?><SessionInfo><SID>0000000000000000</SID>` +
          `<BlockTime>8</BlockTime></SessionInfo>`,
      );
    });

    const port = await new Promise<number>((resolve) => {
      box.listen(0, '127.0.0.1', () => resolve((box.address() as AddressInfo).port));
    });

    try {
      const client = new FritzboxClient(`127.0.0.1:${port}`, '', 'falsches-kennwort');

      await assert.rejects(
        () => client.deviceList(),
        (err: Error) => {
          assert.match(err.message, /sperrt weitere Anmeldeversuche noch 8 Sekunden/);
          return true;
        },
      );
      assert.equal(loginAttempts, 1);

      // Der zweite Aufruf erreicht die Box gar nicht mehr.
      await assert.rejects(
        () => client.deviceList(),
        (err: Error) => {
          assert.match(err.message, /versucht es in \d+ Sekunden wieder/);
          return true;
        },
      );
      assert.equal(loginAttempts, 1, 'kein zweiter Anmeldeversuch an der Box');

      // Auch ein dritter und vierter nicht.
      await assert.rejects(() => client.deviceList(), /versucht es in/);
      await assert.rejects(() => client.deviceList(), /versucht es in/);
      assert.equal(loginAttempts, 1);
    } finally {
      box.close();
    }
  });

  /**
   * Meldet die Box schon in der Anmeldeaufgabe eine laufende Sperre, wird sie
   * gar nicht erst beantwortet – jeder Versuch währenddessen verlängert sie.
   */
  it('beantwortet die Aufgabe nicht, solange die Box gesperrt meldet', async () => {
    let answered = 0;

    const box = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://box');
      res.writeHead(200, { 'content-type': 'text/xml' });
      if (url.searchParams.get('response')) {
        answered += 1;
        res.end('<?xml version="1.0"?><SessionInfo><SID>0000000000000000</SID></SessionInfo>');
        return;
      }
      res.end(
        `<?xml version="1.0"?><SessionInfo><SID>0000000000000000</SID>` +
          `<Challenge>1234567z</Challenge><BlockTime>30</BlockTime></SessionInfo>`,
      );
    });

    const port = await new Promise<number>((resolve) => {
      box.listen(0, '127.0.0.1', () => resolve((box.address() as AddressInfo).port));
    });

    try {
      const client = new FritzboxClient(`127.0.0.1:${port}`, '', 'egal');
      await assert.rejects(() => client.deviceList(), /noch 30 Sekunden/);
      assert.equal(answered, 0, 'die Aufgabe wurde nicht beantwortet');
    } finally {
      box.close();
    }
  });
});
