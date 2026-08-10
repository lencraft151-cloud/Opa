import type { TransportState } from '../../core/types.js';
import { child, children, childText, parseXml, tryParseXml, type XmlNode } from '../../util/xml.js';

/**
 * Auswertung der Sonos-Antworten.
 *
 * Alles hier ist rein: XML rein, Werte raus. Der Netzzugriff steckt in
 * `client.ts` – so lässt sich das Format gegen echte Antwortbeispiele prüfen,
 * ohne einen Lautsprecher im Raum zu haben.
 */

/**
 * Sucht ein Element am Namen, ohne auf den Namensraum-Präfix zu achten.
 *
 * Nötig, weil dieselbe Antwort je nach Firmware `s:Body`, `SOAP-ENV:Body`
 * oder schlicht `Body` heißt. Der kleine XML-Leser des Hubs kennt keine
 * Namensräume – hier wird der Präfix deshalb abgeschnitten und verglichen,
 * was übrig bleibt.
 */
export function findNode(node: XmlNode | undefined, localName: string): XmlNode | undefined {
  if (!node) return undefined;
  if (localOf(node.name) === localName) return node;
  for (const kid of node.children) {
    const hit = findNode(kid, localName);
    if (hit) return hit;
  }
  return undefined;
}

/** Alle Elemente mit diesem lokalen Namen, beliebig tief. */
export function findAll(node: XmlNode | undefined, localName: string): XmlNode[] {
  if (!node) return [];
  const result: XmlNode[] = [];
  if (localOf(node.name) === localName) result.push(node);
  for (const kid of node.children) result.push(...findAll(kid, localName));
  return result;
}

/** Text eines Elements, am lokalen Namen gesucht. */
export function findText(node: XmlNode | undefined, localName: string): string | undefined {
  const hit = findNode(node, localName);
  return hit ? hit.text : undefined;
}

function localOf(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

// ---------------------------------------------------------------------------
// Gerätebeschreibung
// ---------------------------------------------------------------------------

export interface SonosDescription {
  uuid: string;
  roomName: string;
  model: string | null;
  softwareVersion: string | null;
}

/**
 * Liest `/xml/device_description.xml`.
 *
 * Der `roomName` ist die interessante Angabe: Er ist das, was in der
 * Sonos-App steht („Küche"), während `friendlyName` „192.168.1.5 - Sonos One"
 * lautet – eine Adresse, die niemand als Namen erkennt.
 */
export function parseDeviceDescription(xml: string): SonosDescription | null {
  const root = tryParseXml(xml);
  const device = findNode(root ?? undefined, 'device');
  if (!device) return null;

  const udn = childText(device, 'UDN') ?? '';
  const uuid = udn.replace(/^uuid:/i, '').trim();
  if (!uuid) return null;

  const roomName = (childText(device, 'roomName') ?? '').trim();
  const friendly = (childText(device, 'friendlyName') ?? '').trim();

  return {
    uuid,
    // Ohne `roomName` (sehr alte Firmware) bleibt der `friendlyName`; er ist
    // hässlich, aber immer noch besser als ein leeres Feld.
    roomName: roomName || friendly || uuid,
    model: (childText(device, 'modelName') ?? '').trim() || null,
    softwareVersion:
      (childText(device, 'displayVersion') ?? childText(device, 'softwareVersion') ?? '').trim() ||
      null,
  };
}

/** Ist das überhaupt ein Sonos? */
export function isZonePlayer(xml: string): boolean {
  const root = tryParseXml(xml);
  const type = findText(root ?? undefined, 'deviceType') ?? '';
  return /ZonePlayer/i.test(type) || /Sonos/i.test(findText(root ?? undefined, 'manufacturer') ?? '');
}

// ---------------------------------------------------------------------------
// Wiedergabe
// ---------------------------------------------------------------------------

const TRANSPORT_MAP: Record<string, TransportState> = {
  PLAYING: 'playing',
  PAUSED_PLAYBACK: 'paused',
  STOPPED: 'stopped',
  TRANSITIONING: 'transitioning',
  NO_MEDIA_PRESENT: 'stopped',
};

export function parseTransportState(value: string | undefined): TransportState | null {
  if (!value) return null;
  return TRANSPORT_MAP[value.trim().toUpperCase()] ?? null;
}

/**
 * `0:03:45` → 225 Sekunden.
 *
 * `NOT_IMPLEMENTED` liefern Radiostreams; dort gibt es keine Länge, und `0`
 * wäre gelogen – eine Fortschrittsanzeige, die immer am Anfang steht, ist
 * schlechter als gar keine.
 */
export function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'NOT_IMPLEMENTED') return null;
  const parts = trimmed.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? Math.round(seconds) : null;
}

export interface TrackInfo {
  title: string | null;
  artist: string | null;
  album: string | null;
  artworkUrl: string | null;
}

/**
 * Liest die DIDL-Lite-Beschreibung des laufenden Titels.
 *
 * Zwei Fälle, die sich unterscheiden müssen: Bei einer Datei stehen Titel und
 * Interpret ordentlich in `dc:title` und `dc:creator`. Bei einem Radiostream
 * steht in `dc:title` der Sendername, und was gerade läuft, kommt als
 * `r:streamContent` – oft im Format „Interpret - Titel".
 */
export function parseTrackMetadata(didl: string | undefined, baseUrl?: string): TrackInfo {
  const empty: TrackInfo = { title: null, artist: null, album: null, artworkUrl: null };
  if (!didl || !didl.trim()) return empty;

  let root: XmlNode;
  try {
    root = parseXml(didl);
  } catch {
    return empty;
  }

  const item = findNode(root, 'item') ?? root;
  const title = clean(findText(item, 'title'));
  const creator = clean(findText(item, 'creator'));
  const album = clean(findText(item, 'album'));
  const stream = clean(findText(item, 'streamContent'));

  let finalTitle = title;
  let finalArtist = creator;

  if (stream && !creator) {
    // „Interpret - Titel" ist die verbreitete Schreibweise im Stream-Text.
    const dash = stream.indexOf(' - ');
    if (dash > 0) {
      finalArtist = stream.slice(0, dash).trim();
      finalTitle = stream.slice(dash + 3).trim() || title;
    } else {
      finalTitle = stream;
    }
  }

  const art = clean(findText(item, 'albumArtURI'));

  return {
    title: finalTitle,
    artist: finalArtist,
    album,
    artworkUrl: art ? absoluteUrl(art, baseUrl) : null,
  };
}

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

/**
 * Das Bild liefert der Lautsprecher selbst aus, und zwar unter einem relativen
 * Pfad (`/getaa?…`). Ohne diese Ergänzung zeigte der Browser auf den Hub statt
 * auf den Lautsprecher – und dort liegt kein Titelbild.
 */
export function absoluteUrl(value: string, baseUrl?: string): string | null {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listen: Playlists, Radiosender, Favoriten
// ---------------------------------------------------------------------------

/**
 * Die Behälter, in denen ein Sonos-Haushalt seine Listen führt.
 *
 * Das sind keine Pfade, die sich jemand ausgedacht hat, sondern die festen
 * Kennungen aus Sonos' ContentDirectory. Sie sehen kryptisch aus und sind es
 * auch – aber sie sind seit über zehn Jahren dieselben.
 */
export const SONOS_CONTAINERS = {
  /** In der Sonos-App gespeicherte Wiedergabelisten. */
  playlists: 'SQ:',
  /** Sender aus „Meine Radiosender". */
  radio: 'R:0/0',
  /** Alles, was jemand mit dem Herz-Symbol markiert hat. */
  favorites: 'FV:2',
} as const;

export type SonosListName = keyof typeof SONOS_CONTAINERS;

export interface SonosBrowseItem {
  /** Kennung im ContentDirectory – damit lässt sich der Eintrag wiederfinden. */
  id: string;
  title: string;
  /** Interpret, Sender-Beschreibung – was eben dabeisteht. */
  subtitle: string | null;
  /** Die Adresse, die der Lautsprecher abspielen soll. */
  uri: string | null;
  /**
   * Die Beschreibung der Quelle, wie Sonos sie selbst mitliefert.
   *
   * Bei Favoriten steckt sie in `r:resMD` und ist unverzichtbar: Ohne sie
   * nimmt der Lautsprecher eine Playlist eines Musikdienstes nicht an – er
   * weiß dann nicht, welcher Dienst gemeint ist.
   */
  metadata: string | null;
  artworkUrl: string | null;
  /**
   * Behälter oder einzelner Titel?
   *
   * Das entscheidet über den Weg: Ein Behälter (Playlist, Album) wandert in
   * die Warteschlange, ein Stream wird direkt aufgelegt.
   */
  container: boolean;
  /** `object.container.playlistContainer`, `object.item.audioItem.audioBroadcast` … */
  upnpClass: string | null;
}

/**
 * Liest das Ergebnis einer `Browse`-Anfrage.
 *
 * Die Antwort ist DIDL-Lite – dasselbe Format wie beim laufenden Titel, nur
 * mit vielen Einträgen statt einem. Behälter stehen als `<container>`, einzelne
 * Stücke als `<item>`; unterschieden werden muss beides, weil sie verschieden
 * abgespielt werden.
 */
export function parseBrowseItems(didl: string | undefined): SonosBrowseItem[] {
  if (!didl || !didl.trim()) return [];
  const root = tryParseXml(didl);
  if (!root) return [];

  const nodes = [...findAll(root, 'container'), ...findAll(root, 'item')];
  const items: SonosBrowseItem[] = [];

  for (const node of nodes) {
    const id = node.attrs['id'] ?? '';
    const title = clean(findText(node, 'title'));
    if (!id || !title) continue;

    const upnpClass = clean(findText(node, 'class'));
    const uri = clean(findText(node, 'res'));

    /*
     * Behälter oder einzelnes Stück?
     *
     * Zwei Merkmale genügen nicht. Ein **Favorit** steht immer als `<item>`
     * und trägt die Klasse `object.itemobject.item.sonos-favorite` – auch
     * dann, wenn dahinter eine ganze Playlist eines Musikdienstes steckt.
     * Was er wirklich ist, verrät erst seine Adresse: `x-rincon-cpcontainer:`
     * ist ein Behälter und muss über die Warteschlange laufen. Direkt
     * aufgelegt lehnt der Lautsprecher ihn ab.
     */
    const container =
      localOf(node.name) === 'container' ||
      (upnpClass ?? '').startsWith('object.container') ||
      (uri ?? '').startsWith('x-rincon-cpcontainer:');

    items.push({
      id,
      title,
      subtitle: clean(findText(node, 'creator')) ?? clean(findText(node, 'album')),
      uri,
      // `r:resMD` heißt im Baum nur `resMD` – der Präfix ist abgeschnitten.
      metadata: clean(findText(node, 'resMD')),
      artworkUrl: clean(findText(node, 'albumArtURI')),
      container,
      upnpClass,
    });
  }

  return items;
}

/**
 * Baut eine DIDL-Beschreibung für einen Eintrag, der keine mitbringt.
 *
 * Gespeicherte Wiedergabelisten (`SQ:`) haben kein `r:resMD` – der
 * Lautsprecher kennt sie ja selbst. Er will trotzdem *etwas* haben, und zwar
 * mit der richtigen Klasse; eine leere Angabe lehnt er mit Fehler 402 ab.
 */
export function didlFor(item: SonosBrowseItem): string {
  if (item.metadata) return item.metadata;
  const cls = item.upnpClass ?? (item.container ? 'object.container' : 'object.item.audioItem');
  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="${escapeXml(item.id)}" parentID="" restricted="true">` +
    `<dc:title>${escapeXml(item.title)}</dc:title>` +
    `<upnp:class>${escapeXml(cls)}</upnp:class>` +
    '</item></DIDL-Lite>'
  );
}

/**
 * Die Adresse der eigenen Warteschlange.
 *
 * Eine Playlist wird nicht „abgespielt", sondern in die Warteschlange gelegt;
 * danach schaltet der Lautsprecher auf ebendiese Warteschlange um. Das ist der
 * Umweg, den auch die Sonos-App geht.
 */
export function queueUri(coordinatorUuid: string): string {
  return `x-rincon-queue:${coordinatorUuid}#0`;
}

// ---------------------------------------------------------------------------
// Gruppen
// ---------------------------------------------------------------------------

export interface ZoneGroup {
  /** UUID des Lautsprechers, der für die Gruppe entscheidet. */
  coordinatorUuid: string;
  members: Array<{ uuid: string; roomName: string; host: string | null }>;
}

/**
 * Liest die Gruppenstruktur aus `GetZoneGroupState`.
 *
 * Das ist die Angabe, ohne die eine Sonos-Steuerung falsch wird: Sind zwei
 * Lautsprecher gruppiert, nimmt nur der Koordinator Play und Pause an – der
 * andere antwortet mit UPnP-Fehler 701. Wer also „Küche" drückt, während die
 * Küche im Wohnzimmer-Verbund hängt, muss den Befehl ans Wohnzimmer schicken.
 */
export function parseZoneGroups(xml: string | undefined): ZoneGroup[] {
  if (!xml || !xml.trim()) return [];
  const root = tryParseXml(xml);
  if (!root) return [];

  const groups: ZoneGroup[] = [];
  for (const group of findAll(root, 'ZoneGroup')) {
    const coordinatorUuid = group.attrs['Coordinator'] ?? '';
    if (!coordinatorUuid) continue;
    const members = findAll(group, 'ZoneGroupMember')
      .map((member) => ({
        uuid: member.attrs['UUID'] ?? '',
        roomName: member.attrs['ZoneName'] ?? '',
        host: hostFromLocation(member.attrs['Location']),
      }))
      .filter((member) => member.uuid);
    // Unsichtbare Mitglieder sind die zweite Box eines Stereopaars oder ein
    // Subwoofer – sie einzeln anzuzeigen wäre nur verwirrend.
    const visible = members.filter((member) => member.roomName);
    groups.push({ coordinatorUuid, members: visible.length ? visible : members });
  }
  return groups;
}

/**
 * Die Adresse aus einer `Location`-Angabe.
 *
 * Der Standardport 1400 fällt weg – er steht in jeder dieser Adressen und
 * würde in der Oberfläche nur Platz kosten. Ein abweichender Port bleibt
 * dagegen erhalten, sonst zeigte die Adresse ins Leere.
 */
export function hostFromLocation(location: string | undefined): string | null {
  if (!location) return null;
  try {
    const url = new URL(location);
    return url.port && url.port !== '1400' ? url.host : url.hostname;
  } catch {
    return null;
  }
}

/** Zu welcher Gruppe gehört dieser Lautsprecher? */
export function groupOf(groups: readonly ZoneGroup[], uuid: string): ZoneGroup | undefined {
  return groups.find((group) => group.members.some((member) => member.uuid === uuid));
}

// ---------------------------------------------------------------------------
// SOAP
// ---------------------------------------------------------------------------

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Baut den SOAP-Umschlag für eine UPnP-Aktion. */
export function soapEnvelope(
  serviceType: string,
  action: string,
  args: Record<string, string | number>,
): string {
  const body = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body>` +
    '</s:Envelope>'
  );
}

/**
 * Fehlercodes, die Sonos wirklich schickt – übersetzt in Sätze, mit denen
 * jemand etwas anfangen kann.
 */
export const UPNP_ERRORS: Record<string, string> = {
  '402': 'Der Lautsprecher konnte mit der Angabe nichts anfangen.',
  '501': 'Der Lautsprecher hat den Befehl abgelehnt.',
  '701': 'Gerade läuft nichts, was man abspielen könnte.',
  '702': 'Die Warteschlange ist leer.',
  '711': 'Die angegebene Stelle gibt es in diesem Titel nicht.',
  '714': 'Diese Quelle kann der Lautsprecher nicht abspielen.',
  '800': 'Der Befehl gilt nur für den Lautsprecher, der die Gruppe anführt.',
};

/** Liest den UPnP-Fehlercode aus einer SOAP-Fehlerantwort. */
export function parseUpnpError(xml: string): { code: string; message: string } | null {
  const root = tryParseXml(xml);
  if (!root) return null;
  const fault = findNode(root, 'Fault');
  if (!fault) return null;
  const code = (findText(fault, 'errorCode') ?? '').trim();
  const description = (findText(fault, 'errorDescription') ?? '').trim();
  return {
    code,
    message: UPNP_ERRORS[code] ?? description ?? 'Der Lautsprecher hat den Befehl abgelehnt.',
  };
}

/** Der erste Kindknoten der SOAP-Antwort – dort stehen die Rückgabewerte. */
export function soapResult(xml: string): XmlNode | undefined {
  const root = tryParseXml(xml);
  const body = findNode(root ?? undefined, 'Body');
  return body?.children[0];
}

/** Kleiner Helfer, damit die Aufrufer nicht `child`/`children` importieren müssen. */
export const xml = { child, children, childText };
