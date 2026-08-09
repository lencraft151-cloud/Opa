/**
 * Sonos: SSDP-Antworten, die Auswertung echter UPnP-Formate und der ganze
 * Weg gegen einen nachgebauten Lautsprecher – inklusive der Gruppenlogik,
 * ohne die eine Sonos-Steuerung falsche Befehle schickt.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setLogLevel } from '../src/core/logger.ts';
import type { Household } from '../src/core/types.ts';
import { DEFAULT_APPEARANCE, DEFAULT_PRESENCE } from '../src/core/types.ts';
import { SonosClient } from '../src/services/sonos/client.ts';
import {
  absoluteUrl,
  groupOf,
  isZonePlayer,
  parseDeviceDescription,
  parseDuration,
  parseTrackMetadata,
  parseTransportState,
  parseUpnpError,
  parseZoneGroups,
  soapEnvelope,
} from '../src/services/sonos/mapping.ts';
import { SonosService } from '../src/services/sonosService.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories } from '../src/storage/repositories.ts';
import { nowIso } from '../src/util/id.ts';
import { parseSsdpResponse } from '../src/util/ssdp.ts';

setLogLevel('silent');

// ---------------------------------------------------------------------------
// SSDP
// ---------------------------------------------------------------------------

describe('SSDP-Antworten', () => {
  it('liest die Kopfzeilen einer Suchantwort', () => {
    const message = [
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age = 1800',
      'LOCATION: http://192.168.1.42:1400/xml/device_description.xml',
      'ST: urn:schemas-upnp-org:device:ZonePlayer:1',
      'USN: uuid:RINCON_B8E93758A1E001400::urn:schemas-upnp-org:device:ZonePlayer:1',
      '',
      '',
    ].join('\r\n');

    const parsed = parseSsdpResponse(message, '192.168.1.42');
    assert.equal(parsed?.location, 'http://192.168.1.42:1400/xml/device_description.xml');
    assert.equal(parsed?.searchTarget, 'urn:schemas-upnp-org:device:ZonePlayer:1');
    assert.match(parsed?.usn ?? '', /RINCON_B8E93758A1E001400/);
  });

  it('ist bei den Namen der Kopfzeilen nicht wählerisch', () => {
    // Manche Geräte schreiben `Location`, Sonos schreibt `LOCATION`.
    const parsed = parseSsdpResponse(
      'HTTP/1.1 200 OK\r\nLocation: http://10.0.0.5:1400/xml/device_description.xml\r\n\r\n',
      '10.0.0.5',
    );
    assert.equal(parsed?.location, 'http://10.0.0.5:1400/xml/device_description.xml');
  });

  it('nimmt auch unaufgeforderte Ankündigungen an', () => {
    const parsed = parseSsdpResponse(
      'NOTIFY * HTTP/1.1\r\nLOCATION: http://10.0.0.6:1400/xml/device_description.xml\r\nNT: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n',
      '10.0.0.6',
    );
    assert.equal(parsed?.searchTarget, 'urn:schemas-upnp-org:device:ZonePlayer:1');
  });

  it('verwirft, was keine Adresse nennt', () => {
    assert.equal(parseSsdpResponse('HTTP/1.1 200 OK\r\nST: irgendwas\r\n\r\n', '10.0.0.7'), null);
    assert.equal(parseSsdpResponse('völliger Unsinn', '10.0.0.8'), null);
  });
});

// ---------------------------------------------------------------------------
// Gerätebeschreibung
// ---------------------------------------------------------------------------

const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
    <friendlyName>192.168.1.42 - Sonos One</friendlyName>
    <manufacturer>Sonos, Inc.</manufacturer>
    <modelName>Sonos One</modelName>
    <displayVersion>15.9</displayVersion>
    <roomName>Küche</roomName>
    <UDN>uuid:RINCON_B8E93758A1E001400</UDN>
  </device>
</root>`;

describe('Gerätebeschreibung', () => {
  it('nimmt den Raumnamen, nicht den Anzeigenamen', () => {
    const parsed = parseDeviceDescription(DESCRIPTION);
    // `friendlyName` wäre „192.168.1.42 - Sonos One" – eine Adresse, die
    // niemand als Namen erkennt.
    assert.equal(parsed?.roomName, 'Küche');
    assert.equal(parsed?.uuid, 'RINCON_B8E93758A1E001400');
    assert.equal(parsed?.model, 'Sonos One');
    assert.equal(parsed?.softwareVersion, '15.9');
  });

  it('erkennt einen Sonos als solchen', () => {
    assert.equal(isZonePlayer(DESCRIPTION), true);
    assert.equal(
      isZonePlayer('<root><device><deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType><manufacturer>Irgendwer</manufacturer></device></root>'),
      false,
    );
  });

  it('gibt bei fremdem XML nichts zurück, statt zu werfen', () => {
    assert.equal(parseDeviceDescription('<html>Router-Oberfläche</html>'), null);
    assert.equal(parseDeviceDescription(''), null);
  });
});

// ---------------------------------------------------------------------------
// Wiedergabe
// ---------------------------------------------------------------------------

describe('Zustand und Titel', () => {
  it('übersetzt die Transportzustände', () => {
    assert.equal(parseTransportState('PLAYING'), 'playing');
    assert.equal(parseTransportState('PAUSED_PLAYBACK'), 'paused');
    assert.equal(parseTransportState('NO_MEDIA_PRESENT'), 'stopped');
    assert.equal(parseTransportState('WAS_AUCH_IMMER'), null);
    assert.equal(parseTransportState(undefined), null);
  });

  it('rechnet Zeitangaben in Sekunden um', () => {
    assert.equal(parseDuration('0:03:45'), 225);
    assert.equal(parseDuration('1:00:00'), 3600);
    // Radiostreams haben keine Länge – `0` wäre eine erfundene Angabe.
    assert.equal(parseDuration('NOT_IMPLEMENTED'), null);
    assert.equal(parseDuration('0:00:00'), null);
    assert.equal(parseDuration(undefined), null);
  });

  it('liest Titel, Interpret und Bild einer Datei', () => {
    const didl =
      '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
      '<item><dc:title>Wish You Were Here</dc:title><dc:creator>Pink Floyd</dc:creator>' +
      '<upnp:album>Wish You Were Here</upnp:album>' +
      '<upnp:albumArtURI>/getaa?u=x&amp;v=1</upnp:albumArtURI></item></DIDL-Lite>';

    const track = parseTrackMetadata(didl, 'http://192.168.1.42:1400');
    assert.equal(track.title, 'Wish You Were Here');
    assert.equal(track.artist, 'Pink Floyd');
    assert.equal(track.album, 'Wish You Were Here');
    // Das Bild liefert der Lautsprecher selbst aus – relativ zu ihm, nicht
    // zum Hub.
    assert.equal(track.artworkUrl, 'http://192.168.1.42:1400/getaa?u=x&v=1');
  });

  it('zerlegt bei einem Radiostream „Interpret - Titel"', () => {
    const didl =
      '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">' +
      '<item><dc:title>ByteFM</dc:title><r:streamContent>Portishead - Roads</r:streamContent></item></DIDL-Lite>';

    const track = parseTrackMetadata(didl);
    assert.equal(track.artist, 'Portishead');
    assert.equal(track.title, 'Roads');
  });

  it('nimmt bei einem Stream ohne Trennzeichen den ganzen Text als Titel', () => {
    const didl =
      '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">' +
      '<item><dc:title>Deutschlandfunk</dc:title><r:streamContent>Nachrichten</r:streamContent></item></DIDL-Lite>';
    assert.equal(parseTrackMetadata(didl).title, 'Nachrichten');
  });

  it('bleibt bei leeren Angaben ruhig', () => {
    assert.deepEqual(parseTrackMetadata(''), {
      title: null,
      artist: null,
      album: null,
      artworkUrl: null,
    });
    assert.equal(parseTrackMetadata('kein xml').title, null);
  });

  it('verwirft Bildadressen, die kein http sind', () => {
    assert.equal(absoluteUrl('javascript:alert(1)', 'http://192.168.1.42:1400'), null);
  });
});

// ---------------------------------------------------------------------------
// Gruppen
// ---------------------------------------------------------------------------

const ZONE_GROUP_STATE = `<ZoneGroupState><ZoneGroups>
  <ZoneGroup Coordinator="RINCON_WOHN" ID="RINCON_WOHN:2">
    <ZoneGroupMember UUID="RINCON_WOHN" ZoneName="Wohnzimmer" Location="http://192.168.1.42:1400/xml/device_description.xml"/>
    <ZoneGroupMember UUID="RINCON_KUECHE" ZoneName="Küche" Location="http://192.168.1.43:1400/xml/device_description.xml"/>
  </ZoneGroup>
  <ZoneGroup Coordinator="RINCON_BAD" ID="RINCON_BAD:7">
    <ZoneGroupMember UUID="RINCON_BAD" ZoneName="Bad" Location="http://192.168.1.44:1400/xml/device_description.xml"/>
  </ZoneGroup>
</ZoneGroups></ZoneGroupState>`;

describe('Gruppen', () => {
  it('liest Koordinator, Mitglieder und deren Adressen', () => {
    const groups = parseZoneGroups(ZONE_GROUP_STATE);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.coordinatorUuid, 'RINCON_WOHN');
    assert.deepEqual(
      groups[0]?.members.map((member) => member.roomName),
      ['Wohnzimmer', 'Küche'],
    );
    assert.equal(groups[0]?.members[1]?.host, '192.168.1.43');
  });

  it('findet die Gruppe eines Lautsprechers', () => {
    const groups = parseZoneGroups(ZONE_GROUP_STATE);
    assert.equal(groupOf(groups, 'RINCON_KUECHE')?.coordinatorUuid, 'RINCON_WOHN');
    assert.equal(groupOf(groups, 'RINCON_GIBTESNICHT'), undefined);
  });

  it('kommt mit leerer oder kaputter Auskunft zurecht', () => {
    assert.deepEqual(parseZoneGroups(''), []);
    assert.deepEqual(parseZoneGroups('kein xml'), []);
  });
});

// ---------------------------------------------------------------------------
// SOAP
// ---------------------------------------------------------------------------

describe('SOAP', () => {
  it('baut einen Umschlag mit maskierten Werten', () => {
    const envelope = soapEnvelope('urn:test:1', 'SetVolume', {
      InstanceID: 0,
      Channel: 'Master & Co',
      DesiredVolume: 30,
    });
    assert.match(envelope, /<u:SetVolume xmlns:u="urn:test:1">/);
    assert.match(envelope, /<Channel>Master &amp; Co<\/Channel>/);
    assert.match(envelope, /<DesiredVolume>30<\/DesiredVolume>/);
  });

  it('übersetzt UPnP-Fehlercodes in Sätze', () => {
    const fault = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
      <faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
      <detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>701</errorCode></UPnPError></detail>
    </s:Fault></s:Body></s:Envelope>`;
    const parsed = parseUpnpError(fault);
    assert.equal(parsed?.code, '701');
    assert.match(parsed?.message ?? '', /nichts, was man abspielen könnte/);
  });
});

// ---------------------------------------------------------------------------
// Der ganze Weg gegen einen nachgebauten Lautsprecher
// ---------------------------------------------------------------------------

interface FakeSonos {
  server: http.Server;
  port: number;
  /** Alle empfangenen SOAP-Aktionen in der Reihenfolge des Eintreffens. */
  actions: string[];
  volume: number;
  transport: string;
  /** Wird für die Gruppenauskunft genutzt; änderbar, wenn Ports feststehen. */
  zoneState: string;
}

interface FakeOptions {
  uuid?: string;
  roomName?: string;
  zoneState?: string;
}

function soapBody(inner: string): string {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;
}

async function startFakeSonos(options: FakeOptions = {}): Promise<FakeSonos> {
  const uuid = options.uuid ?? 'RINCON_B8E93758A1E001400';
  const roomName = options.roomName ?? 'Küche';

  const state: FakeSonos = {
    server: null as unknown as http.Server,
    port: 0,
    actions: [],
    volume: 25,
    transport: 'PLAYING',
    zoneState: options.zoneState ?? ZONE_GROUP_STATE,
  };

  const description = DESCRIPTION.replace('RINCON_B8E93758A1E001400', uuid).replace(
    '<roomName>Küche</roomName>',
    `<roomName>${roomName}</roomName>`,
  );

  state.server = http.createServer((req, res) => {
    if (req.url === '/xml/device_description.xml') {
      res.writeHead(200, { 'content-type': 'text/xml' }).end(description);
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const action = (req.headers['soapaction'] as string | undefined)?.split('#')[1]?.replace(/"/g, '') ?? '';
      state.actions.push(action);
      const xml = (inner: string): void => {
        res.writeHead(200, { 'content-type': 'text/xml' }).end(soapBody(inner));
      };

      switch (action) {
        case 'GetZoneGroupState':
          // Sonos liefert die Gruppenauskunft als maskiertes XML in einem Feld.
          xml(
            `<u:GetZoneGroupStateResponse><ZoneGroupState>${escapeXml(state.zoneState)}</ZoneGroupState></u:GetZoneGroupStateResponse>`,
          );
          return;
        case 'GetTransportInfo':
          xml(
            `<u:GetTransportInfoResponse><CurrentTransportState>${state.transport}</CurrentTransportState></u:GetTransportInfoResponse>`,
          );
          return;
        case 'GetPositionInfo':
          xml(
            '<u:GetPositionInfoResponse><TrackDuration>0:03:45</TrackDuration><RelTime>0:01:02</RelTime>' +
              `<TrackMetaData>${escapeXml(
                '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"><item><dc:title>Roads</dc:title><dc:creator>Portishead</dc:creator></item></DIDL-Lite>',
              )}</TrackMetaData></u:GetPositionInfoResponse>`,
          );
          return;
        case 'GetVolume':
          xml(
            `<u:GetVolumeResponse><CurrentVolume>${state.volume}</CurrentVolume></u:GetVolumeResponse>`,
          );
          return;
        case 'GetMute':
          xml('<u:GetMuteResponse><CurrentMute>0</CurrentMute></u:GetMuteResponse>');
          return;
        case 'SetVolume': {
          const match = body.match(/<DesiredVolume>(\d+)<\/DesiredVolume>/);
          state.volume = Number(match?.[1] ?? state.volume);
          xml('<u:SetVolumeResponse/>');
          return;
        }
        case 'Play':
          state.transport = 'PLAYING';
          xml('<u:PlayResponse/>');
          return;
        case 'Pause':
          state.transport = 'PAUSED_PLAYBACK';
          xml('<u:PauseResponse/>');
          return;
        case 'Next':
        case 'Previous':
          xml(`<u:${action}Response/>`);
          return;
        case 'SetMute':
          // Der Nachbau spielt hier den Fehlerfall durch.
          res
            .writeHead(500, { 'content-type': 'text/xml' })
            .end(
              soapBody(
                '<s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError><errorCode>701</errorCode></UPnPError></detail></s:Fault>',
              ),
            );
          return;
        default:
          res
            .writeHead(500, { 'content-type': 'text/xml' })
            .end(
              soapBody(
                '<s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError><errorCode>401</errorCode></UPnPError></detail></s:Fault>',
              ),
            );
      }
    });
  });

  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  state.port = (state.server.address() as AddressInfo).port;
  return state;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const household = (id: string): Household => ({
  id,
  name: 'Testhaushalt',
  timezone: 'Europe/Berlin',
  locale: 'de-DE',
  setupStep: 'done',
  setupCompletedAt: nowIso(),
  pollIntervalSeconds: 15,
  pricePerKwh: 0.35,
  currency: 'EUR',
  basePricePerMonth: 0,
  autoUpdate: false,
  autoUpdateFrom: '03:00',
  autoUpdateTo: '05:00',
  appearance: { ...DEFAULT_APPEARANCE },
  presence: { ...DEFAULT_PRESENCE },
  createdAt: nowIso(),
  updatedAt: nowIso(),
});

describe('Lautsprecher ansprechen', () => {
  let cloud: FakeSonos;

  before(async () => {
    cloud = await startFakeSonos();
  });

  after(async () => {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()));
  });

  it('liest Zustand, Titel und Lautstärke', async () => {
    const client = new SonosClient('127.0.0.1', cloud.port);
    assert.equal(await client.transportState(), 'playing');
    assert.equal(await client.volume(), 25);
    assert.equal(await client.muted(), false);

    const playing = await client.nowPlaying();
    assert.equal(playing.title, 'Roads');
    assert.equal(playing.artist, 'Portishead');
    assert.equal(playing.durationSeconds, 225);
    assert.equal(playing.positionSeconds, 62);
  });

  it('stellt die Lautstärke ein', async () => {
    const client = new SonosClient('127.0.0.1', cloud.port);
    await client.setVolume(42);
    assert.equal(cloud.volume, 42);
    // Über 100 wird begrenzt statt durchgereicht.
    await client.setVolume(300);
    assert.equal(cloud.volume, 100);
  });

  it('erklärt einen UPnP-Fehler statt „HTTP 500" zu melden', async () => {
    const client = new SonosClient('127.0.0.1', cloud.port);
    await assert.rejects(
      () => client.setMute(true),
      (err: Error) => {
        assert.match(err.message, /nichts, was man abspielen könnte/);
        return true;
      },
    );
  });

  it('nimmt einen Port in der Adresse an', async () => {
    const client = new SonosClient(`127.0.0.1:${cloud.port}`);
    assert.equal(client.baseUrl, `http://127.0.0.1:${cloud.port}`);
    assert.equal(await client.transportState(), 'playing');
  });

  it('liest die Gruppenauskunft aus dem maskierten Feld', async () => {
    const groups = await new SonosClient('127.0.0.1', cloud.port).zoneGroups();
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.coordinatorUuid, 'RINCON_WOHN');
  });
});

describe('Sonos-Dienst', () => {
  let dir: string;
  let speaker: FakeSonos;
  let service: SonosService;
  let db: Database;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-sonos-'));
    speaker = await startFakeSonos();
    db = new Database(path.join(dir, 'db.json'));
    await db.load();
    await db.update((data) => {
      data.households.push(household('hh_1'));
    });
    service = new SonosService(createRepositories(db));
  });

  after(async () => {
    await new Promise<void>((resolve) => speaker.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it('übernimmt einen von Hand genannten Lautsprecher', async () => {
    const players = await service.discover('hh_1', {
      hosts: [`127.0.0.1:${speaker.port}`],
      scan: false,
      ssdpTimeoutMs: 50,
    });
    assert.equal(players.length, 1);
    assert.equal(players[0]?.roomName, 'Küche');
    assert.equal(players[0]?.uuid, 'RINCON_B8E93758A1E001400');
  });

  it('legt denselben Lautsprecher nach einem Adresswechsel nicht doppelt an', async () => {
    // Erkannt wird über die UUID – sonst stünde nach jedem Neustart des
    // Routers ein zweiter, toter Eintrag in der Liste.
    await service.discover('hh_1', {
      hosts: [`127.0.0.1:${speaker.port}`],
      scan: false,
      ssdpTimeoutMs: 50,
    });
    assert.equal(db.read().sonos.length, 1);
  });

  it('meldet den Zustand samt Gruppe', async () => {
    const overview = await service.overview('hh_1');
    const player = overview.players[0];
    assert.equal(player?.state.reachable, true);
    assert.equal(player?.state.title, 'Roads');
    assert.equal(player?.state.volume, 25);
  });

  it('führt Befehle aus', async () => {
    const player = service.list('hh_1')[0];
    assert.ok(player);
    speaker.actions.length = 0;

    await service.execute(player.id, { type: 'pause' });
    assert.ok(speaker.actions.includes('Pause'));

    await service.execute(player.id, { type: 'setVolume', volume: 15 });
    assert.equal(speaker.volume, 15);
  });

  it('meldet einen unerreichbaren Lautsprecher, statt die Liste zu verlieren', async () => {
    await new Promise<void>((resolve) => speaker.server.close(() => resolve()));
    const overview = await service.overview('hh_1');
    assert.equal(overview.players.length, 1);
    assert.equal(overview.players[0]?.state.reachable, false);
    assert.match(overview.players[0]?.state.error ?? '', /.+/);
  });

  it('erklärt einen Befehl an einen entfernten Lautsprecher', async () => {
    await assert.rejects(() => service.execute('snp_gibtesnicht', { type: 'play' }), /nicht \(mehr\)/);
  });
});

/**
 * Die Gruppenregel, an der eine Sonos-Steuerung sonst scheitert.
 *
 * Zwei Lautsprecher, zu einer Gruppe zusammengefasst: „Pause" auf der Küche
 * muss beim Wohnzimmer landen, denn nur der Koordinator nimmt es an. Die
 * Lautstärke dagegen gehört der Küche allein – wer sie leiser stellt, will
 * nicht das Wohnzimmer mitnehmen.
 */
describe('Gruppierte Lautsprecher', () => {
  let dir: string;
  let wohnzimmer: FakeSonos;
  let kueche: FakeSonos;
  let service: SonosService;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-sonos-gruppe-'));
    wohnzimmer = await startFakeSonos({ uuid: 'RINCON_WOHN', roomName: 'Wohnzimmer' });
    kueche = await startFakeSonos({ uuid: 'RINCON_KUECHE', roomName: 'Küche' });

    const zoneState = `<ZoneGroupState><ZoneGroups><ZoneGroup Coordinator="RINCON_WOHN" ID="RINCON_WOHN:2">
      <ZoneGroupMember UUID="RINCON_WOHN" ZoneName="Wohnzimmer" Location="http://127.0.0.1:${wohnzimmer.port}/xml/device_description.xml"/>
      <ZoneGroupMember UUID="RINCON_KUECHE" ZoneName="Küche" Location="http://127.0.0.1:${kueche.port}/xml/device_description.xml"/>
    </ZoneGroup></ZoneGroups></ZoneGroupState>`;
    wohnzimmer.zoneState = zoneState;
    kueche.zoneState = zoneState;

    const db = new Database(path.join(dir, 'db.json'));
    await db.load();
    await db.update((data) => {
      data.households.push(household('hh_1'));
    });
    service = new SonosService(createRepositories(db));

    await service.discover('hh_1', {
      hosts: [`127.0.0.1:${kueche.port}`],
      scan: false,
      ssdpTimeoutMs: 50,
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => wohnzimmer.server.close(() => resolve()));
    await new Promise<void>((resolve) => kueche.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it('findet über einen Lautsprecher gleich den zweiten mit', () => {
    // Die Abkürzung: Wer einen hat, hat alle – die Gruppenauskunft nennt
    // jeden Mitspieler samt Adresse.
    assert.deepEqual(
      service.list('hh_1').map((player) => player.roomName),
      ['Küche', 'Wohnzimmer'],
    );
  });

  it('schickt Pause an den Koordinator, nicht an das Gruppenmitglied', async () => {
    const kuechePlayer = service.list('hh_1').find((player) => player.roomName === 'Küche');
    assert.ok(kuechePlayer);

    wohnzimmer.actions.length = 0;
    kueche.actions.length = 0;
    await service.execute(kuechePlayer.id, { type: 'pause' });

    assert.ok(wohnzimmer.actions.includes('Pause'), 'Der Koordinator hat Pause bekommen');
    assert.equal(kueche.actions.includes('Pause'), false, 'Das Mitglied bekommt kein Pause');
  });

  it('stellt die Lautstärke am Lautsprecher selbst ein', async () => {
    const kuechePlayer = service.list('hh_1').find((player) => player.roomName === 'Küche');
    assert.ok(kuechePlayer);

    wohnzimmer.actions.length = 0;
    await service.execute(kuechePlayer.id, { type: 'setVolume', volume: 12 });

    assert.equal(kueche.volume, 12);
    assert.equal(wohnzimmer.actions.includes('SetVolume'), false);
  });

  it('zeigt beim Mitglied den Titel des Koordinators und die eigene Lautstärke', async () => {
    const overview = await service.overview('hh_1');
    const kuechePlayer = overview.players.find((player) => player.roomName === 'Küche');
    assert.equal(kuechePlayer?.state.title, 'Roads');
    assert.equal(kuechePlayer?.state.volume, 12);
    assert.equal(kuechePlayer?.state.coordinatorUuid, 'RINCON_WOHN');
    assert.deepEqual(kuechePlayer?.state.groupMembers, ['Wohnzimmer', 'Küche']);
    assert.equal(overview.groups, 1);
  });
});
