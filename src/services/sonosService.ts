import { badRequest, errorSummary } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { MediaCommand, SonosPlayer, SonosPlayerState } from '../core/types.js';
import type { Repositories } from '../storage/repositories.js';
import { mapWithConcurrency } from '../util/http.js';
import { reachableHosts, scannableHosts } from '../util/net.js';
import { search, SONOS_SEARCH_TARGET } from '../util/ssdp.js';
import { createId, nowIso } from '../util/id.js';
import { SonosClient, SONOS_PORT } from './sonos/client.js';
import {
  groupOf,
  hostFromLocation,
  isZonePlayer,
  parseDeviceDescription,
  type ZoneGroup,
} from './sonos/mapping.js';

const log = createLogger('sonos');

export interface DiscoveredPlayer {
  host: string;
  uuid: string;
  roomName: string;
  model: string | null;
  softwareVersion: string | null;
}

export interface DiscoverOptions {
  /** Zusätzlich das Subnetz auf Port 1400 abklopfen, wenn SSDP nichts bringt. */
  scan?: boolean;
  /** Adressen, die auf jeden Fall gefragt werden – etwa von Hand eingetragene. */
  hosts?: string[];
  /** Wie lange auf SSDP-Antworten gewartet wird. */
  ssdpTimeoutMs?: number;
}

export interface SonosOverview {
  players: Array<SonosPlayer & { state: SonosPlayerState }>;
  /** Wie viele Lautsprecher zu einer Gruppe zusammengefasst sind. */
  groups: number;
}

/**
 * Sonos.
 *
 * Zwei Dinge unterscheiden diese Anbindung von den übrigen:
 *
 * 1. **Sie kommt ohne Konto aus.** Sonos spricht UPnP im eigenen Netz – kein
 *    Schlüssel, kein Token, nichts, was ablaufen kann. Gefunden wird per
 *    SSDP; hilft das nicht, klopft der Hub Port 1400 im Subnetz ab.
 * 2. **Gruppen sind Pflicht, nicht Kür.** Zwei gruppierte Lautsprecher
 *    nehmen Play und Pause nur beim Koordinator an. Ein Hub, der das nicht
 *    beachtet, funktioniert genau so lange, bis jemand in der Sonos-App zwei
 *    Räume zusammenlegt.
 */
export class SonosService {
  constructor(private readonly repos: Repositories) {}

  list(householdId: string): SonosPlayer[] {
    return this.repos.sonos
      .listByHousehold(householdId)
      .sort((a, b) => a.roomName.localeCompare(b.roomName, 'de'));
  }

  /**
   * Alle Lautsprecher mit ihrem aktuellen Zustand.
   *
   * Die Gruppenaufteilung wird **einmal** geholt und für alle verwendet:
   * Jeder Lautsprecher kennt die Aufteilung des ganzen Haushalts, es reicht
   * also, einen zu fragen.
   */
  async overview(householdId: string): Promise<SonosOverview> {
    const players = this.list(householdId);
    if (players.length === 0) return { players: [], groups: 0 };

    const groups = await this.zoneGroups(players);
    const states = await mapWithConcurrency(players, 4, (player) =>
      this.stateOf(player, groups),
    );

    return {
      players: players.map((player, index) => ({
        ...player,
        state: states[index] as SonosPlayerState,
      })),
      groups: groups.filter((group) => group.members.length > 1).length,
    };
  }

  /**
   * Sucht Lautsprecher im Netz und übernimmt sie.
   *
   * Der Ablauf hat eine Abkürzung, die viel Zeit spart: Ist erst *ein*
   * Lautsprecher gefunden, kennt der bereits alle anderen – die
   * Gruppenauskunft nennt jeden Mitspieler samt Adresse. Das Subnetz
   * abzuklopfen ist deshalb nur der letzte Ausweg, wenn SSDP nichts bringt
   * (in manchen Netzen wird Multicast schlicht nicht weitergereicht).
   */
  async discover(
    householdId: string,
    options: DiscoverOptions = {},
  ): Promise<SonosPlayer[]> {
    const hosts = new Set<string>();

    // Von Hand genannte Adressen zuerst: In Netzen, in denen Multicast nicht
    // über den Router kommt (WLAN-Repeater, getrennte Gäste-Netze), ist das
    // der einzige Weg.
    for (const host of options.hosts ?? []) hosts.add(host.trim());

    for (const response of await search(SONOS_SEARCH_TARGET, {
      timeoutMs: options.ssdpTimeoutMs ?? 3000,
    })) {
      const host = hostFromLocation(response.location) ?? response.address;
      if (host) hosts.add(host);
    }
    log.debug('SSDP-Suche beendet', { gefunden: hosts.size });

    // Bereits bekannte Lautsprecher immer mitfragen: Sie sind der schnellste
    // Weg zurück zur Gruppenauskunft, wenn Multicast gerade nicht durchkommt.
    for (const player of this.list(householdId)) hosts.add(player.host);

    if (hosts.size === 0 && options.scan !== false) {
      const candidates = await reachableHosts(scannableHosts(), {
        ports: [SONOS_PORT],
        timeoutMs: 300,
      });
      log.debug('Subnetz abgeklopft', { erreichbar: candidates.length });
      for (const host of candidates) hosts.add(host);
    }

    // Die Abkürzung: einer verrät alle.
    for (const host of [...hosts]) {
      try {
        const groups = await new SonosClient(host).zoneGroups();
        for (const group of groups) {
          for (const member of group.members) {
            if (member.host) hosts.add(member.host);
          }
        }
        break;
      } catch (err) {
        log.debug('Gruppenauskunft fehlgeschlagen', { host, error: errorSummary(err) });
      }
    }

    const found = (
      await mapWithConcurrency([...hosts], 8, (host) => this.describe(host))
    ).filter((entry): entry is DiscoveredPlayer => entry !== null);

    const saved: SonosPlayer[] = [];
    for (const entry of found) saved.push(await this.upsert(householdId, entry));

    log.info('Sonos-Suche abgeschlossen', { gefunden: saved.length });
    return saved.sort((a, b) => a.roomName.localeCompare(b.roomName, 'de'));
  }

  /** Führt einen Befehl aus – Transportbefehle gehen an den Koordinator. */
  async execute(playerId: string, command: MediaCommand): Promise<SonosPlayerState> {
    const player = this.require(playerId);

    /*
     * Lautstärke und Stummschaltung gelten immer für genau diesen
     * Lautsprecher – auch in einer Gruppe will man die Küche leiser stellen
     * können, ohne das Wohnzimmer mitzunehmen. Play, Pause und Titelwechsel
     * gelten dagegen für die ganze Gruppe und nimmt nur ihr Koordinator an.
     */
    const groups = await this.zoneGroups([player]);
    const target =
      command.type === 'setVolume' || command.type === 'setMute'
        ? player
        : this.coordinatorFor(player, groups);

    const client = new SonosClient(target.host);
    switch (command.type) {
      case 'play':
        await client.play();
        break;
      case 'pause':
        await client.pause();
        break;
      case 'next':
        await client.next();
        break;
      case 'previous':
        await client.previous();
        break;
      case 'setVolume':
        await client.setVolume(command.volume);
        break;
      case 'setMute':
        await client.setMute(command.muted);
        break;
    }

    await this.repos.sonos.patch(
      player.id,
      { lastSeenAt: nowIso(), lastError: null },
      'Lautsprecher',
    );
    return this.stateOf(this.require(playerId), groups);
  }

  async rename(playerId: string, roomId: string | null): Promise<SonosPlayer> {
    this.require(playerId);
    return this.repos.sonos.patch(playerId, { roomId }, 'Lautsprecher');
  }

  async remove(playerId: string): Promise<void> {
    this.require(playerId);
    await this.repos.sonos.remove(playerId);
  }

  // -------------------------------------------------------------------------

  private require(playerId: string): SonosPlayer {
    const player = this.repos.sonos.find(playerId);
    if (!player) {
      throw badRequest(
        'Diesen Lautsprecher gibt es nicht (mehr).',
        undefined,
        'Unter „Dienste“ noch einmal nach Lautsprechern suchen.',
      );
    }
    return player;
  }

  /**
   * Wer führt die Gruppe an, in der dieser Lautsprecher hängt?
   *
   * Ist die Gruppenauskunft nicht zu bekommen, bleibt der Lautsprecher selbst
   * das Ziel: In einem Haushalt ohne Gruppen ist das richtig, und in einem mit
   * Gruppen ist eine Fehlermeldung von Sonos besser als gar kein Versuch.
   */
  private coordinatorFor(player: SonosPlayer, groups: readonly ZoneGroup[]): SonosPlayer {
    const group = groupOf(groups, player.uuid);
    if (!group || group.coordinatorUuid === player.uuid) return player;

    const known = this.repos.sonos
      .listByHousehold(player.householdId)
      .find((entry) => entry.uuid === group.coordinatorUuid);
    if (known) return known;

    // Der Koordinator steht in der Gruppenauskunft, ist dem Hub aber noch
    // nicht bekannt – dann genügt seine Adresse.
    const member = group.members.find((entry) => entry.uuid === group.coordinatorUuid);
    return member?.host ? { ...player, host: member.host } : player;
  }

  private async zoneGroups(players: readonly SonosPlayer[]): Promise<ZoneGroup[]> {
    for (const player of players) {
      try {
        return await new SonosClient(player.host).zoneGroups();
      } catch (err) {
        log.debug('Gruppenauskunft fehlgeschlagen', {
          host: player.host,
          error: errorSummary(err),
        });
      }
    }
    return [];
  }

  private async stateOf(
    player: SonosPlayer,
    groups: readonly ZoneGroup[],
  ): Promise<SonosPlayerState> {
    const group = groupOf(groups, player.uuid);
    const base: SonosPlayerState = {
      playerId: player.id,
      reachable: false,
      transport: null,
      volume: null,
      muted: false,
      title: null,
      artist: null,
      album: null,
      artworkUrl: null,
      durationSeconds: null,
      positionSeconds: null,
      coordinatorUuid: group?.coordinatorUuid ?? null,
      groupMembers: group?.members.map((member) => member.roomName) ?? [player.roomName],
      error: null,
    };

    try {
      const own = new SonosClient(player.host);
      /*
       * Was läuft, weiß der Koordinator – ein gruppiertes Mitglied meldet
       * selbst „STOPPED", obwohl aus ihm Musik kommt. Die Lautstärke dagegen
       * hat jeder für sich.
       */
      const coordinator = this.coordinatorFor(player, groups);
      const transportClient =
        coordinator.host === player.host ? own : new SonosClient(coordinator.host);

      const [transport, playing, volume, muted] = await Promise.all([
        transportClient.transportState(),
        transportClient.nowPlaying(),
        own.volume(),
        own.muted(),
      ]);

      return {
        ...base,
        reachable: true,
        transport,
        volume,
        muted,
        title: playing.title,
        artist: playing.artist,
        album: playing.album,
        artworkUrl: playing.artworkUrl,
        durationSeconds: playing.durationSeconds,
        positionSeconds: playing.positionSeconds,
      };
    } catch (err) {
      const message = errorSummary(err);
      void this.repos.sonos
        .patch(player.id, { lastError: message }, 'Lautsprecher')
        .catch(() => undefined);
      return { ...base, error: message };
    }
  }

  private async describe(host: string): Promise<DiscoveredPlayer | null> {
    try {
      const xml = await new SonosClient(host).description();
      if (!isZonePlayer(xml)) return null;
      const description = parseDeviceDescription(xml);
      if (!description) return null;
      return { host, ...description };
    } catch (err) {
      log.debug('Keine Sonos-Beschreibung', { host, error: errorSummary(err) });
      return null;
    }
  }

  /**
   * Bekannt wird ein Lautsprecher über seine UUID, nicht über seine Adresse.
   *
   * Nach einem Neustart des Routers hat er womöglich eine andere IP – ein
   * zweiter Eintrag für denselben Lautsprecher wäre die Folge, und einer der
   * beiden wäre für immer tot.
   */
  private async upsert(householdId: string, found: DiscoveredPlayer): Promise<SonosPlayer> {
    const existing = this.repos.sonos.findByUuid(householdId, found.uuid);
    if (existing) {
      return this.repos.sonos.patch(
        existing.id,
        {
          host: found.host,
          roomName: found.roomName,
          model: found.model,
          softwareVersion: found.softwareVersion,
          lastSeenAt: nowIso(),
          lastError: null,
        },
        'Lautsprecher',
      );
    }

    return this.repos.sonos.insert({
      id: createId('snp'),
      householdId,
      host: found.host,
      uuid: found.uuid,
      roomName: found.roomName,
      model: found.model,
      softwareVersion: found.softwareVersion,
      roomId: null,
      lastSeenAt: nowIso(),
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }
}
