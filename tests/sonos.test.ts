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
  cdudnFor,
  didlFor,
  groupOf,
  isZonePlayer,
  parseBrowseItems,
  parseDeviceDescription,
  parseDuration,
  parseTrackMetadata,
  parseTransportState,
  parseUpnpError,
  parseZoneGroups,
  queueUri,
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

/*
 * Echte Antwortformate der `Browse`-Aktion.
 *
 * Die drei Listen sehen verschieden aus, und die Unterschiede sind genau
 * das, worauf es ankommt: Eine gespeicherte Wiedergabeliste ist ein
 * `<container>` ohne `r:resMD`, ein Radiosender ein `<item>` mit
 * Stream-Adresse, ein Favorit ein `<item>`, das die Beschreibung seiner
 * Quelle in `r:resMD` mitbringt.
 */
const DIDL_HEAD =
  '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
  'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
  'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">';

const EMPTY_DIDL = `${DIDL_HEAD}</DIDL-Lite>`;

const PLAYLISTS_DIDL =
  `${DIDL_HEAD}` +
  '<container id="SQ:3" parentID="SQ:" restricted="true">' +
  '<dc:title>Abendessen</dc:title>' +
  '<upnp:class>object.container.playlistContainer</upnp:class>' +
  '<res protocolInfo="x-rincon-playlist:*:*:*">file:///jffs/settings/savedqueues.rsq#3</res>' +
  '</container>' +
  '<container id="SQ:5" parentID="SQ:" restricted="true">' +
  '<dc:title>Aufräumen</dc:title>' +
  '<upnp:class>object.container.playlistContainer</upnp:class>' +
  '<res protocolInfo="x-rincon-playlist:*:*:*">file:///jffs/settings/savedqueues.rsq#5</res>' +
  '</container></DIDL-Lite>';

const RADIO_DIDL =
  `${DIDL_HEAD}` +
  '<item id="R:0/0/1" parentID="R:0/0" restricted="true">' +
  '<dc:title>Deutschlandfunk</dc:title>' +
  '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>' +
  '<res protocolInfo="x-rincon-mp3radio:*:*:*">x-rincon-mp3radio://st01.dlf.de/dlf/01/high/stream.mp3</res>' +
  '</item>' +
  '<item id="R:0/0/2" parentID="R:0/0" restricted="true">' +
  '<dc:title>FluxFM</dc:title>' +
  '<upnp:class>object.item.audioItem.audioBroadcast</upnp:class>' +
  '<res protocolInfo="x-rincon-mp3radio:*:*:*">x-rincon-mp3radio://streams.fluxfm.de/live/mp3-320</res>' +
  '</item></DIDL-Lite>';

const FAVORITES_DIDL =
  `${DIDL_HEAD}` +
  '<item id="FV:2/12" parentID="FV:2" restricted="false">' +
  '<dc:title>Deep Focus</dc:title>' +
  '<dc:creator>Spotify</dc:creator>' +
  '<upnp:class>object.itemobject.item.sonos-favorite</upnp:class>' +
  '<upnp:albumArtURI>/getaa?u=x-sonos-spotify%3aabc&amp;v=1</upnp:albumArtURI>' +
  '<res protocolInfo="x-rincon-cpcontainer:*:*:*">x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9</res>' +
  /*
   * So sieht ein echtes `r:resMD` aus – mitsamt `<desc id="cdudn">`. Genau
   * deshalb liefen Favoriten schon vorher: Sie bringen die vollständige
   * Beschreibung mit. Die Radiosender taten es nicht.
   */
  '<r:resMD>&lt;DIDL-Lite xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot; ' +
  'xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot; ' +
  'xmlns:r=&quot;urn:schemas-rinconnetworks-com:metadata-1-0/&quot; ' +
  'xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot;&gt;' +
  '&lt;container id=&quot;1006206cspotify%3aplaylist%3a37i9&quot; parentID=&quot;0&quot; ' +
  'restricted=&quot;true&quot;&gt;&lt;dc:title&gt;Deep Focus&lt;/dc:title&gt;' +
  '&lt;upnp:class&gt;object.container.playlistContainer&lt;/upnp:class&gt;' +
  '&lt;desc id=&quot;cdudn&quot; nameSpace=&quot;urn:schemas-rinconnetworks-com:metadata-1-0/&quot;&gt;' +
  'SA_RINCON2311_X_#Svc2311-0-Token&lt;/desc&gt;&lt;/container&gt;&lt;/DIDL-Lite&gt;</r:resMD>' +
  '</item></DIDL-Lite>';

const BROWSE_RESULTS: Record<string, string> = {
  'SQ:': PLAYLISTS_DIDL,
  'R:0/0': RADIO_DIDL,
  'FV:2': FAVORITES_DIDL,
};

describe('Listen lesen', () => {
  it('liest gespeicherte Wiedergabelisten als Behälter', () => {
    const items = parseBrowseItems(PLAYLISTS_DIDL);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.title, 'Abendessen');
    assert.equal(items[0]?.id, 'SQ:3');
    assert.equal(items[0]?.container, true);
    assert.equal(items[0]?.uri, 'file:///jffs/settings/savedqueues.rsq#3');
    // Ohne `r:resMD` bleibt sie leer – der Lautsprecher kennt die Liste selbst.
    assert.equal(items[0]?.metadata, null);
  });

  it('liest Radiosender als einzelne Stücke', () => {
    const items = parseBrowseItems(RADIO_DIDL);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.container, false);
    assert.match(items[0]?.uri ?? '', /^x-rincon-mp3radio:/);
  });

  it('behält bei Favoriten die Beschreibung der Quelle', () => {
    const items = parseBrowseItems(FAVORITES_DIDL);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.title, 'Deep Focus');
    assert.equal(items[0]?.subtitle, 'Spotify');
    // Genau daran hängt es: Ohne `resMD` weiß der Lautsprecher nicht, welcher
    // Dienst gemeint ist, und lehnt die Playlist ab.
    assert.match(items[0]?.metadata ?? '', /Deep Focus/);
  });

  it('kommt mit einer leeren Liste zurecht', () => {
    assert.deepEqual(parseBrowseItems(EMPTY_DIDL), []);
    assert.deepEqual(parseBrowseItems(''), []);
    assert.deepEqual(parseBrowseItems('kein XML'), []);
  });

  it('baut eine Beschreibung, wo der Lautsprecher keine mitliefert', () => {
    const [playlist] = parseBrowseItems(PLAYLISTS_DIDL);
    const didl = didlFor(playlist!);
    assert.match(didl, /object\.container\.playlistContainer/);
    assert.match(didl, /Abendessen/);
  });

  it('reicht eine vorhandene Beschreibung unverändert durch', () => {
    const [favorite] = parseBrowseItems(FAVORITES_DIDL);
    assert.equal(didlFor(favorite!), favorite?.metadata);
  });

  it('nennt die Warteschlange des Koordinators', () => {
    assert.equal(queueUri('RINCON_WOHN'), 'x-rincon-queue:RINCON_WOHN#0');
  });

  /*
   * Der Fehler aus dem echten Haushalt.
   *
   * Radiosender ließen sich nicht abspielen: „Der Lautsprecher konnte mit der
   * Angabe nichts anfangen" (UPnP 402), immer wieder. Ursache war die selbst
   * gebaute Beschreibung – ihr fehlten drei Dinge, die Sonos verlangt.
   */
  it('beschreibt einen Behälter als Behälter, nicht als Stück', () => {
    const [playlist] = parseBrowseItems(PLAYLISTS_DIDL);
    const didl = didlFor(playlist!);
    assert.match(didl, /<container /);
    assert.equal(/<item /.test(didl), false, 'ein Behälter ist kein <item>');
  });

  it('nennt den Behälter, in dem der Eintrag steht', () => {
    const [playlist] = parseBrowseItems(PLAYLISTS_DIDL);
    assert.equal(playlist?.parentId, 'SQ:');
    // Ein leerer parentID ist genau das, was Sonos mit 402 ablehnt.
    assert.match(didlFor(playlist!), /parentID="SQ:"/);
  });

  it('setzt den cdudn-Marker – ohne ihn lehnt Sonos ab', () => {
    const [sender] = parseBrowseItems(RADIO_DIDL);
    const didl = didlFor(sender!);
    assert.match(didl, /<desc id="cdudn"/);
    assert.match(didl, /nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0\/"/);
  });

  it('unterscheidet TuneIn von eigenen Inhalten', () => {
    // Sonos' eigene Radiosender laufen über TuneIn und haben einen anderen
    // Marker als alles, was dem Haushalt selbst gehört.
    assert.equal(cdudnFor('x-sonosapi-stream:s12345?sid=254'), 'SA_RINCON65031_');
    assert.equal(cdudnFor('x-rincon-mp3radio://stream.example/live'), 'RINCON_AssociatedZPUDN');
    assert.equal(cdudnFor(null), 'RINCON_AssociatedZPUDN');
  });

  it('gibt einem Radiosender die Klasse, die Sonos erwartet', () => {
    const [sender] = parseBrowseItems(RADIO_DIDL);
    assert.match(didlFor(sender!), /object\.item\.audioItem\.audioBroadcast/);
  });

  it('lässt eine fertige Beschreibung unangetastet', () => {
    // Favoriten bringen ihre eigene mit – daran wird nichts gebastelt.
    const [favorite] = parseBrowseItems(FAVORITES_DIDL);
    assert.equal(didlFor(favorite!), favorite?.metadata);
  });
});

describe('Fehlermeldungen des Lautsprechers', () => {
  const fault = (code: string, description = ''): string =>
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError>' +
    `<errorCode>${code}</errorCode>` +
    (description ? `<errorDescription>${description}</errorDescription>` : '') +
    '</UPnPError></detail></s:Fault></s:Body></s:Envelope>';

  it('übersetzt bekannte Codes in Sätze', () => {
    assert.match(parseUpnpError(fault('402'))?.message ?? '', /nichts anfangen/);
    assert.match(parseUpnpError(fault('701'))?.message ?? '', /läuft nichts/);
  });

  it('bleibt bei einem unbekannten Code nicht stumm', () => {
    /*
     * Im Protokoll stand „WARN [http]" und sonst nichts – eine Meldung ohne
     * Text. Grund: `errorDescription` ist nach dem Trimmen ein *leerer
     * String*, kein `undefined`, und `??` greift darauf nicht.
     */
    const message = parseUpnpError(fault('714'))?.message ?? '';
    assert.notEqual(message.trim(), '');
  });

  it('nennt den Code, wenn es keinen fertigen Satz gibt', () => {
    const message = parseUpnpError(fault('9999'))?.message ?? '';
    assert.match(message, /9999/);
  });

  it('lässt die Erklärung des Lautsprechers gelten, wenn er eine hat', () => {
    const message = parseUpnpError(fault('9999', 'Zone nicht bereit'))?.message ?? '';
    assert.equal(message, 'Zone nicht bereit');
  });
});

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
  /** Was per AddURIToQueue in der Warteschlange gelandet ist. */
  queue: Array<{ uri: string; metadata: string }>;
  /** Die zuletzt aufgelegte Quelle. */
  avUri: string | null;
  /** Die Beschreibung, die dazu geschickt wurde. */
  avMetadata: string | null;
}

/**
 * Wie streng ein echter Sonos die Beschreibung nimmt.
 *
 * Das ist keine Erfindung für den Test, sondern der Grund, warum im echten
 * Haushalt kein Radiosender lief: Eine leere Angabe nimmt der Lautsprecher an,
 * eine *unvollständige* nicht. Fehlt der `cdudn`-Marker, ist der `parentID`
 * leer, oder wird ein Behälter als `<item>` ausgegeben, antwortet er mit
 * Fehler 402 – „Der Lautsprecher konnte mit der Angabe nichts anfangen".
 */
function acceptsMetadata(escaped: string): boolean {
  if (!escaped.trim()) return true;
  // `&amp;` zuletzt – sonst würde aus `&amp;lt;` fälschlich `<`.
  const didl = escaped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
  if (!/<desc[^>]+id="cdudn"/.test(didl)) return false;
  if (/parentID=""/.test(didl)) return false;
  if (/<upnp:class>object\.container/.test(didl) && !/<container/.test(didl)) return false;
  return true;
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
    queue: [],
    avUri: null,
    avMetadata: null,
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
      /** So antwortet ein echter Sonos auf eine Angabe, die er ablehnt. */
      const refuse = (code: number): void => {
        res
          .writeHead(500, { 'content-type': 'text/xml' })
          .end(
            soapBody(
              '<s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError>' +
                `<errorCode>${code}</errorCode></UPnPError></detail></s:Fault>`,
            ),
          );
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
        case 'Browse': {
          const objectId = body.match(/<ObjectID>([^<]*)<\/ObjectID>/)?.[1] ?? '';
          const didl = BROWSE_RESULTS[objectId] ?? EMPTY_DIDL;
          xml(
            `<u:BrowseResponse><Result>${escapeXml(didl)}</Result>` +
              '<NumberReturned>2</NumberReturned><TotalMatches>2</TotalMatches>' +
              '</u:BrowseResponse>',
          );
          return;
        }
        case 'AddURIToQueue': {
          const meta = body.match(/<EnqueuedURIMetaData>([\s\S]*?)<\/EnqueuedURIMetaData>/)?.[1] ?? '';
          if (!acceptsMetadata(meta)) return refuse(402);
          state.queue.push({
            uri: body.match(/<EnqueuedURI>([^<]*)<\/EnqueuedURI>/)?.[1] ?? '',
            metadata: meta,
          });
          xml('<u:AddURIToQueueResponse><FirstTrackNumberEnqueued>1</FirstTrackNumberEnqueued></u:AddURIToQueueResponse>');
          return;
        }
        case 'RemoveAllTracksFromQueue':
          state.queue = [];
          xml('<u:RemoveAllTracksFromQueueResponse/>');
          return;
        case 'SetAVTransportURI': {
          const meta = body.match(/<CurrentURIMetaData>([\s\S]*?)<\/CurrentURIMetaData>/)?.[1] ?? '';
          if (!acceptsMetadata(meta)) return refuse(402);
          state.avUri = body.match(/<CurrentURI>([^<]*)<\/CurrentURI>/)?.[1] ?? null;
          state.avMetadata = meta;
          xml('<u:SetAVTransportURIResponse/>');
          return;
        }
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
  fritzboxUrl: '',
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

  it('zählt einen Lautsprecher einmal, auch wenn er unter zwei Adressen antwortet', async () => {
    // Über die Gruppenauskunft kommt derselbe Lautsprecher ein zweites Mal
    // herein. „2 Lautsprecher gefunden" wäre dann schlicht falsch.
    const players = await service.discover('hh_1', {
      hosts: [`127.0.0.1:${speaker.port}`, `localhost:${speaker.port}`],
      scan: false,
      ssdpTimeoutMs: 50,
    });
    assert.equal(players.length, 1);
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
 * Sonos in der allgemeinen Netzwerksuche.
 *
 * Der Fehler, um den es hier geht, war einfach: Wer „Netzwerk durchsuchen"
 * drückte, fand alles außer Lautsprechern – Sonos wurde schlicht nicht
 * mitgesucht. Jetzt meldet der Dienst seine Treffer in derselben Form wie ein
 * Adapter, und die Suche nimmt ihn als Mitsucher auf.
 */
describe('Sonos in der Netzwerksuche', () => {
  let dir: string;
  let speaker: FakeSonos;
  let service: SonosService;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-sonos-suche-'));
    speaker = await startFakeSonos();
    const db = new Database(path.join(dir, 'db.json'));
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

  it('meldet sich mit Kennung und Namen wie ein Adapter', () => {
    assert.equal(service.type, 'sonos');
    assert.equal(service.displayName, 'Sonos');
  });

  it('macht aus einem gefundenen Lautsprecher einen Treffer der Suche', async () => {
    // Bereits übernommene Lautsprecher werden immer mitgefragt – so stehen
    // sie in der Trefferliste, statt dort zu fehlen.
    await service.discover('hh_1', {
      hosts: [`127.0.0.1:${speaker.port}`],
      scan: false,
      ssdpTimeoutMs: 50,
    });

    const candidates = await service.findAsCandidates({
      timeoutMs: 100,
      allowCloud: false,
      allowScan: false,
    });

    const entry = candidates.find((candidate) => candidate.host === `127.0.0.1:${speaker.port}`);
    assert.ok(entry, 'der Lautsprecher steht in der Trefferliste');
    // Schon übernommen – die Liste sagt das, statt einen Knopf anzubieten,
    // der nichts Neues tut.
    assert.equal(entry.alreadyLinked, true);
    assert.equal(entry.type, 'sonos');
    assert.match(entry.name, /Küche/);
    // Kein Passwort, kein Knopfdruck – deshalb kann „Mit allen verbinden"
    // ihn ohne Rückfrage übernehmen.
    assert.equal(entry.authRequired, false);
    assert.equal(entry.requiresLinkButton, false);
    assert.equal(entry.externalId, 'RINCON_B8E93758A1E001400');
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

  // -------------------------------------------------------------------------
  // Playlists und Radiosender
  // -------------------------------------------------------------------------

  const kuecheId = (): string => {
    const player = service.list('hh_1').find((entry) => entry.roomName === 'Küche');
    assert.ok(player, 'Die Küche muss bekannt sein');
    return player.id;
  };

  it('holt Playlists, Radiosender und Favoriten', async () => {
    const library = await service.library(kuecheId());
    assert.equal(library.error, null);
    assert.deepEqual(
      library.playlists.map((item) => item.title),
      ['Abendessen', 'Aufräumen'],
    );
    assert.deepEqual(
      library.radio.map((item) => item.title),
      ['Deutschlandfunk', 'FluxFM'],
    );
    assert.equal(library.favorites[0]?.title, 'Deep Focus');
  });

  it('legt eine Playlist in die Warteschlange des Koordinators', async () => {
    wohnzimmer.actions.length = 0;
    wohnzimmer.queue = [];
    kueche.actions.length = 0;

    await service.playFromList(kuecheId(), 'playlists', 'SQ:3');

    /*
     * Der ganze Vorgang gehört dem Koordinator: Er führt die Warteschlange.
     * Ginge er ans Mitglied, bekäme man UPnP-Fehler 701 – oder, schlimmer,
     * eine zweite Warteschlange, die niemand hört.
     */
    assert.equal(kueche.actions.includes('AddURIToQueue'), false);
    assert.deepEqual(wohnzimmer.actions.slice(0, 5), [
      'Browse',
      'RemoveAllTracksFromQueue',
      'AddURIToQueue',
      'SetAVTransportURI',
      'Play',
    ]);
    assert.equal(wohnzimmer.queue[0]?.uri, 'file:///jffs/settings/savedqueues.rsq#3');
    // Und danach wird auf ebendiese Warteschlange umgeschaltet.
    assert.equal(wohnzimmer.avUri, 'x-rincon-queue:RINCON_WOHN#0');
  });

  it('legt einen Radiosender unmittelbar auf, ohne Warteschlange', async () => {
    wohnzimmer.actions.length = 0;
    wohnzimmer.queue = [];

    await service.playFromList(kuecheId(), 'radio', 'R:0/0/2');

    // Ein Sender hat keinen nächsten Titel – eine Warteschlange wäre sinnlos.
    assert.equal(wohnzimmer.actions.includes('AddURIToQueue'), false);
    assert.equal(wohnzimmer.actions.includes('RemoveAllTracksFromQueue'), false);
    assert.equal(wohnzimmer.avUri, 'x-rincon-mp3radio://streams.fluxfm.de/live/mp3-320');
    assert.equal(wohnzimmer.queue.length, 0);
  });

  it('erkennt einen Favoriten mit Playlist dahinter als Behälter', () => {
    // Er steht als `<item>` da und ist trotzdem eine ganze Playlist. Wer nur
    // auf den Knotennamen sieht, legt ihn direkt auf – und der Lautsprecher
    // lehnt ab.
    const [favorite] = parseBrowseItems(FAVORITES_DIDL);
    assert.equal(favorite?.container, true);
  });

  it('schickt bei einem Favoriten die Beschreibung der Quelle mit', async () => {
    wohnzimmer.queue = [];
    await service.playFromList(kuecheId(), 'favorites', 'FV:2/12');

    // Ohne diese Beschreibung weiß der Lautsprecher nicht, welcher Dienst
    // gemeint ist, und lehnt die Playlist ab.
    assert.match(wohnzimmer.queue[0]?.metadata ?? '', /Deep Focus/);
  });

  it('sagt es, wenn der Eintrag nicht mehr da ist', async () => {
    await assert.rejects(
      () => service.playFromList(kuecheId(), 'playlists', 'SQ:999'),
      /nicht mehr in der Liste/,
    );
  });
});
