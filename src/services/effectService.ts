import { badRequest, errorMessage } from '../core/errors.js';
import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { LIGHT_EFFECT_IDS } from '../core/types.js';
import type {
  Capability,
  CommandOptions,
  Device,
  DeviceCommand,
  DeviceState,
  LightEffect,
} from '../core/types.js';
import type { DeviceService } from './deviceService.js';
import type { Repositories } from '../storage/repositories.js';

const log = createLogger('effects');

/**
 * Lichteffekte: Disco, Farbwechsel, Gruselmodus.
 *
 * Der Reiz ist schnell erklärt – die Lampe soll blinken, die Farbe wechseln,
 * flackern. Die Schwierigkeit liegt woanders, und sie hat drei Namen:
 *
 * 1. **Die Bridge.** Eine Hue Bridge nimmt rund zehn Befehle je Sekunde an;
 *    darüber verwirft sie oder wird langsam. Zehn Lampen im 200-ms-Takt wären
 *    fünfzig Befehle je Sekunde – das ist kein Effekt mehr, sondern eine
 *    Überlastung. Der Takt wird deshalb an der Zahl der Lampen bemessen.
 * 2. **Das Ende.** Ein Effekt, der niemand abschaltet, läuft die ganze Nacht.
 *    Jeder bekommt deshalb eine Laufzeit mit, und danach hört er von selbst
 *    auf.
 * 3. **Der Zustand davor.** Wer eine Disco startet, will danach sein warmes
 *    Wohnzimmerlicht zurück – nicht knallgrün auf 100 %. Vor dem Start wird
 *    gemerkt, wie es war, und beim Beenden wiederhergestellt.
 */

export { LIGHT_EFFECT_IDS as LIGHT_EFFECTS };
export type { LightEffect };

export interface EffectDefinition {
  id: LightEffect;
  label: string;
  icon: string;
  /** Ein Satz, der sagt, was gleich passiert. */
  description: string;
  /** Wunschtakt in Millisekunden. Die Zahl der Lampen kann ihn strecken. */
  stepMs: number;
  /** Was eine Lampe können muss, damit der Effekt etwas taugt. */
  needs: Capability;
  /** Vorgeschlagene Laufzeit in Minuten. */
  defaultMinutes: number;
  /**
   * Wie viel des Takts hinübergeblendet wird – 0 springt, 1 blendet durch.
   *
   * Hier liegt der Unterschied zwischen einem Farb*wechsel* und einem
   * Farb*verlauf*: Dieselben Befehle, einmal hart gesetzt und einmal mit
   * Übergangszeit an die Lampe gegeben, ergeben einmal ein Blinken und einmal
   * ein Wandern. Beim Blitz und bei der Disco ist der Sprung genau richtig,
   * beim Regenbogen wäre er ein Fehler.
   */
  fade: number;
  /**
   * Stellt der Effekt am Ende den vorherigen Zustand wieder her?
   *
   * Ein Schauspiel schon – nach der Disco will man sein Wohnzimmerlicht
   * zurück. Ein *Verlauf* nicht: Wer mit dem Wecklicht aufwacht, möchte nicht,
   * dass es zum Schluss wieder ausgeht, und wer eingeschlafen ist, nicht, dass
   * das Licht wieder angeht.
   */
  restores: boolean;
}

export const EFFECTS: Record<LightEffect, EffectDefinition> = {
  disco: {
    id: 'disco',
    label: 'Disco',
    icon: '🪩',
    description: 'Schnelle, kräftige Farbwechsel – jede Lampe eine andere.',
    stepMs: 450,
    needs: 'color',
    defaultMinutes: 10,
    // Hart auf den Punkt: Eine Disco, die hinüberblendet, ist ein Sonnenaufgang.
    fade: 0,
    restores: true,
  },
  farbwechsel: {
    id: 'farbwechsel',
    label: 'Farbverlauf',
    icon: '🌈',
    description:
      'Die Farbe wandert durch den Regenbogen – fließend, ohne Sprünge, über alle Lampen verteilt.',
    stepMs: 3000,
    needs: 'color',
    defaultMinutes: 60,
    // Durchgehend blenden: Dann ist der Wechsel gar nicht mehr zu sehen,
    // sondern nur noch die Wanderung.
    fade: 1,
    restores: true,
  },
  gruselig: {
    id: 'gruselig',
    label: 'Gruselig',
    icon: '👻',
    description: 'Düster, mit unregelmäßigem Flackern und kaltem Grünstich.',
    stepMs: 700,
    needs: 'dimmer',
    defaultMinutes: 20,
    // Ein sanftes Zucken wäre keins.
    fade: 0,
    restores: true,
  },
  kerze: {
    id: 'kerze',
    label: 'Kerze',
    icon: '🕯️',
    description: 'Warmes Licht, das sanft schwankt wie eine echte Flamme.',
    stepMs: 1200,
    needs: 'dimmer',
    defaultMinutes: 60,
    // Eine Flamme springt nicht, sie wandert – aber schneller, als sie schwankt.
    fade: 0.7,
    restores: true,
  },
  gewitter: {
    id: 'gewitter',
    label: 'Gewitter',
    icon: '⛈️',
    description: 'Dunkel – und dann ein kalter Doppelblitz. Selten, dafür heftig.',
    stepMs: 900,
    needs: 'dimmer',
    defaultMinutes: 15,
    fade: 0,
    restores: true,
  },
  sonnenaufgang: {
    id: 'sonnenaufgang',
    label: 'Sonnenaufgang',
    icon: '🌅',
    description:
      'Wecklicht: fängt tiefrot und fast dunkel an und wird über die volle Zeit hell und warmweiß.',
    // Zwanzig Sekunden je Schritt reichen: Bei zwanzig Minuten Laufzeit sind
    // das sechzig Schritte, und dazwischen blendet die Lampe selbst.
    stepMs: 20_000,
    needs: 'dimmer',
    defaultMinutes: 20,
    fade: 1,
    // Am Ende ist es hell – und das soll es bleiben.
    restores: false,
  },
  einschlafen: {
    id: 'einschlafen',
    label: 'Einschlafen',
    icon: '🌙',
    description: 'Das Gegenstück: Das Licht wird immer wärmer und dunkler und geht am Ende aus.',
    stepMs: 20_000,
    needs: 'dimmer',
    defaultMinutes: 30,
    fade: 1,
    // Wer eingeschlafen ist, will nicht vom wiederhergestellten Licht geweckt werden.
    restores: false,
  },
};

/**
 * Wie viele Befehle je Sekunde ein Effekt losschickt.
 *
 * Zehn ist die Zahl, die Philips für eine Hue Bridge nennt. Andere Hersteller
 * vertragen mehr, aber die Bridge ist hier der schwächste Teilnehmer – und ein
 * Effekt, der die Bridge überfährt, sieht schlechter aus als ein langsamerer,
 * der ankommt.
 *
 * Die Grenze gilt je Effekt, nicht für den ganzen Hub: Zwei Effekte
 * nebeneinander können sie zusammen überschreiten. Das ist in Kauf genommen,
 * weil beide dann in aller Regel auf verschiedenen Lampen laufen – und wer
 * drei Effekte gleichzeitig startet, hat ohnehin anderes im Sinn als Schonung.
 */
const MAX_COMMANDS_PER_SECOND = 10;

/** Obergrenze für die Laufzeit. Auch wer „999" einträgt, bekommt nicht mehr. */
const MAX_MINUTES = 120;

/**
 * Wie lange eine Lampe nach dem Beenden noch als „vom Effekt gesteuert" gilt.
 *
 * Das Wiederherstellen ist die letzte Handlung eines Effekts – und ausgerechnet
 * sie schaltet die Lampe womöglich wieder aus. Eine Regel „wenn das Licht
 * ausgeht, starte den Gruselmodus" würde dadurch von ihrem eigenen Ende erneut
 * ausgelöst und liefe endlos. Die Frist deckt das Nachspiel ab: Was in diesen
 * Sekunden am Schalter passiert, war der Hub selbst.
 */
const RESTORE_GRACE_MS = 15_000;

export interface RunningEffect {
  effect: LightEffect;
  deviceIds: string[];
  startedAt: string;
  endsAt: string;
  /** Tatsächlicher Takt – kann wegen vieler Lampen länger sein als gewünscht. */
  stepMs: number;
}

interface Session {
  effect: LightEffect;
  devices: Device[];
  /** Der Zustand jeder Lampe vor dem Start. */
  before: Map<string, DeviceState>;
  timer: NodeJS.Timeout;
  stopAt: NodeJS.Timeout;
  startedAt: string;
  endsAt: string;
  stepMs: number;
  step: number;
}

export interface StartOptions {
  deviceIds?: string[];
  roomIds?: string[];
  minutes?: number;
}

export class EffectService {
  /** Höchstens eine Sitzung je Effekt – aber mehrere Effekte nebeneinander. */
  private sessions = new Map<LightEffect, Session>();

  /** Gerät → bis wann sein Zustand noch dem Effekt zuzurechnen ist. */
  private readonly settling = new Map<string, number>();

  constructor(
    private readonly repos: Repositories,
    private readonly devices: DeviceService,
  ) {}

  /** Was es gibt und was gerade läuft. */
  overview(householdId: string): {
    effects: EffectDefinition[];
    running: RunningEffect[];
    candidates: number;
  } {
    const lights = this.lightsOf(householdId);
    return {
      effects: Object.values(EFFECTS),
      running: [...this.sessions.values()].map((session) => ({
        effect: session.effect,
        deviceIds: session.devices.map((device) => device.id),
        startedAt: session.startedAt,
        endsAt: session.endsAt,
        stepMs: session.stepMs,
      })),
      candidates: lights.length,
    };
  }

  isRunning(effect: LightEffect): boolean {
    return this.sessions.has(effect);
  }

  /**
   * Steht diese Lampe gerade unter der Fuchtel eines Effekts?
   *
   * Die Automationen fragen danach, bevor sie auf eine Zustandsänderung
   * reagieren. Eine Lampe, die zwanzig Mal je Minute an und aus geht, ist keine
   * Nachricht über die Wohnung – sie ist eine Disco. Und ohne diese Frage
   * würde eine Regel „wenn das Licht ausgeht, starte den Gruselmodus" durch
   * das Aufräumen am Effektende erneut auslösen und nie zur Ruhe kommen.
   */
  controls(deviceId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.devices.some((device) => device.id === deviceId)) return true;
    }
    const until = this.settling.get(deviceId);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.settling.delete(deviceId);
      return false;
    }
    return true;
  }

  /**
   * Startet einen Effekt.
   *
   * Läuft er schon, wird er zuerst sauber beendet – sonst liefen zwei Takte
   * auf denselben Lampen und das Ergebnis wäre Zufall.
   */
  async start(
    householdId: string,
    effect: LightEffect,
    options: StartOptions = {},
  ): Promise<RunningEffect> {
    const definition = EFFECTS[effect];
    await this.stop(effect);

    let chosen = this.pickDevices(householdId, definition, options);
    if (chosen.length === 0) {
      /*
       * Bewusst ein 400 und kein 500: Nicht der Hub ist kaputt, sondern die
       * Auswahl passt nicht. Der Hinweis nennt den Grund, denn „keine Lampe
       * gefunden" beantwortet die naheliegende Rückfrage nicht.
       */
      throw badRequest(
        `Für „${definition.label}" wird mindestens eine Lampe gebraucht, die ` +
          `${definition.needs === 'color' ? 'Farbe' : 'Helligkeit'} kann.`,
        undefined,
        definition.needs === 'color'
          ? 'Farbwechsel und Disco brauchen eine Farblampe – eine dimmbare weiße Lampe reicht dafür nicht.'
          : 'Gebraucht wird eine dimmbare Lampe; an einer Steckdose gäbe es nichts zu sehen.',
      );
    }

    /*
     * Eine Lampe, ein Effekt.
     *
     * Beim Nachmessen an einem echten Gerät liefen versehentlich Gruselmodus
     * und Sonnenaufgang zugleich auf derselben Lampe – heraus kam ein Zucken
     * zwischen grün und orange, das zu keinem von beiden gehörte. Wer einen
     * neuen Effekt startet, meint ihn; die alten geben diese Lampen frei.
     *
     * Danach wird die Auswahl neu gelesen: Der abgelöste Effekt hat beim
     * Aufräumen den ursprünglichen Zustand wiederhergestellt, und genau der
     * gehört gemerkt – nicht das, was mitten im Flackern zu sehen war.
     */
    if (await this.releaseDevices(new Set(chosen.map((device) => device.id)), effect)) {
      chosen = this.pickDevices(householdId, definition, options);
    }

    /*
     * Der Takt richtet sich danach, wie viele Befehle ein Schritt kostet –
     * und das sind nicht so viele wie Lampen: Die Disco schickt je Lampe
     * drei (Schalter, Farbe, Helligkeit). Zwei Lampen im 450-ms-Takt wären
     * also schon dreizehn Befehle je Sekunde, obwohl es nur zwei Lampen sind.
     * Genau so ist es beim Nachmessen an einem echten Gerät auch gewesen.
     */
    const stepMs = Math.max(
      definition.stepMs,
      Math.ceil(((chosen.length * commandsPerStep(effect)) / MAX_COMMANDS_PER_SECOND) * 1000),
    );
    const minutes = Math.min(MAX_MINUTES, Math.max(1, options.minutes ?? definition.defaultMinutes));

    const before = new Map<string, DeviceState>();
    for (const device of chosen) before.set(device.id, { ...device.state });

    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + minutes * 60_000);

    const session: Session = {
      effect,
      devices: chosen,
      before,
      startedAt: startedAt.toISOString(),
      endsAt: endsAt.toISOString(),
      stepMs,
      step: 0,
      timer: setInterval(() => void this.tick(effect), stepMs),
      // Ausgelaufen, nicht abgebrochen – ein Verlauf bekommt hier seinen Schluss.
      stopAt: setTimeout(() => void this.stopSessions([effect], true), minutes * 60_000),
    };
    session.timer.unref?.();
    session.stopAt.unref?.();
    this.sessions.set(effect, session);

    // Einmal sofort, damit es nicht erst nach dem ersten Takt losgeht.
    void this.tick(effect);

    log.info('Effekt gestartet', {
      effekt: effect,
      lampen: chosen.length,
      takt: stepMs,
      minuten: minutes,
    });
    events.emit('notification', {
      householdId,
      message: `${definition.icon} ${definition.label} läuft – ${chosen.length} ${
        chosen.length === 1 ? 'Lampe' : 'Lampen'
      }, ${minutes} Minuten.`,
      level: 'info',
      source: 'effect',
    });

    return {
      effect,
      deviceIds: chosen.map((device) => device.id),
      startedAt: session.startedAt,
      endsAt: session.endsAt,
      stepMs,
    };
  }

  /**
   * Beendet einen Effekt und stellt her, wie es vorher war.
   *
   * Ohne Angabe: alle. Das ist der Panikknopf – „Licht wieder normal".
   */
  async stop(effect?: LightEffect): Promise<number> {
    return this.stopSessions(effect ? [effect] : [...this.sessions.keys()], false);
  }

  /**
   * `expired` unterscheidet „die Zeit ist um" von „jemand hat abgebrochen".
   *
   * Für die Schauspiel-Effekte macht es keinen Unterschied – die stellen so
   * oder so den vorherigen Zustand her. Für einen Verlauf schon: Ein
   * Sonnenaufgang, den jemand nach zwei Minuten abbricht, darf nicht auf volle
   * Helligkeit springen, nur weil das sein Ziel gewesen wäre. Abgebrochen
   * heißt: Das Licht bleibt stehen, wo es gerade ist.
   */
  private async stopSessions(targets: LightEffect[], expired: boolean): Promise<number> {
    let stopped = 0;

    for (const id of targets) {
      const session = this.sessions.get(id);
      if (!session) continue;
      clearInterval(session.timer);
      clearTimeout(session.stopAt);
      this.sessions.delete(id);
      stopped++;

      await this.restore(session, expired);
      log.info('Effekt beendet', { effekt: id, ausgelaufen: expired });
    }
    return stopped;
  }

  /** Beim Herunterfahren: Timer weg, Licht zurück. */
  async shutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Beendet alle Effekte, die eine dieser Lampen bespielen.
   *
   * Beendet wird der ganze Effekt, nicht nur die überschneidenden Lampen: Ein
   * Farbverlauf, dem man die Hälfte seiner Lampen wegnimmt, wäre keiner mehr –
   * und ein halb weitergeführter Effekt ist schwerer zu erklären als ein
   * beendeter. Zurück bleibt überall der Zustand von vorher.
   *
   * @returns Wie viele Effekte dafür beendet wurden.
   */
  private async releaseDevices(deviceIds: Set<string>, except: LightEffect): Promise<number> {
    const betroffen = [...this.sessions.values()]
      .filter(
        (session) =>
          session.effect !== except &&
          session.devices.some((device) => deviceIds.has(device.id)),
      )
      .map((session) => session.effect);

    if (betroffen.length === 0) return 0;
    log.info('Effekt abgelöst', { abgelöst: betroffen, für: except });
    return this.stopSessions(betroffen, false);
  }

  // -------------------------------------------------------------------------

  private lightsOf(householdId: string): Device[] {
    return this.repos.devices
      .listByHousehold(householdId)
      .filter((device) => !device.hidden && device.capabilities.includes('dimmer'));
  }

  private pickDevices(
    householdId: string,
    definition: EffectDefinition,
    options: StartOptions,
  ): Device[] {
    const all = this.repos.devices.listByHousehold(householdId).filter((device) => !device.hidden);

    let chosen = all;
    if (options.deviceIds?.length) {
      const wanted = new Set(options.deviceIds);
      chosen = all.filter((device) => wanted.has(device.id));
    } else if (options.roomIds?.length) {
      const wanted = new Set(options.roomIds);
      chosen = all.filter((device) => device.roomId && wanted.has(device.roomId));
    }

    /*
     * Nur Lampen, die den Effekt auch zeigen können. Einen Farbwechsel an eine
     * Steckdose zu schicken wäre nicht bloß wirkungslos – sie würde bei jedem
     * Takt eine Fehlermeldung erzeugen.
     */
    return chosen.filter((device) => device.capabilities.includes(definition.needs));
  }

  private async tick(effect: LightEffect): Promise<void> {
    const session = this.sessions.get(effect);
    if (!session) return;
    const step = session.step++;

    /*
     * Der Fortschritt wird an der Uhr abgelesen, nicht an der Schrittzahl:
     * Ein Takt, der wegen vieler Lampen gestreckt wurde, soll das Wecklicht
     * nicht in der Hälfte der Zeit stehen lassen. Bei 1 ist Schluss.
     */
    const total = new Date(session.endsAt).getTime() - new Date(session.startedAt).getTime();
    const context: StepContext = {
      progress:
        total > 0
          ? Math.min(1, (Date.now() - new Date(session.startedAt).getTime()) / total)
          : 1,
      count: session.devices.length,
    };

    // Die Lampe blendet selbst hinüber – das ist schöner als viele
    // Zwischenschritte vom Hub aus und kostet einen Befehl statt zwanzig.
    const options: CommandOptions = {
      transitionMs: Math.round(session.stepMs * EFFECTS[effect].fade),
    };

    for (const [index, device] of session.devices.entries()) {
      for (const command of commandsFor(effect, step, index, context)) {
        try {
          await this.devices.execute(device.id, command, options);
        } catch (err) {
          // Eine Lampe, die klemmt, darf den Effekt nicht abbrechen.
          log.debug('Effektschritt fehlgeschlagen', {
            effekt: effect,
            gerät: device.name,
            error: errorMessage(err),
          });
        }
      }
    }
  }

  /**
   * Stellt her, wie es vor dem Effekt war.
   *
   * In dieser Reihenfolge: erst Farbe und Helligkeit, dann der Schalter. Wer
   * zuerst einschaltet, sieht für einen Moment noch die Discofarbe.
   *
   * Verläufe (Wecklicht, Einschlaflicht) übergeht das: Dort *ist* das Ende das
   * Ergebnis. Sie bekommen stattdessen ihren Schlussschritt – beim
   * Einschlaflicht also das Ausschalten, das sonst beim vorzeitigen Beenden
   * ausbliebe.
   */
  private async restore(session: Session, expired: boolean): Promise<void> {
    /*
     * Die Frist gilt ab jetzt für alle beteiligten Lampen – nicht erst nach
     * dem Wiederherstellen. Sonst käme das Schaltereignis der ersten Lampe
     * schon an, während die letzte noch gar nicht dran war.
     */
    for (const device of session.devices) {
      this.settling.set(device.id, Date.now() + RESTORE_GRACE_MS);
    }

    if (!EFFECTS[session.effect].restores) {
      // Abgebrochen: stehen lassen, wo es ist. Ausgelaufen: sauber zu Ende.
      if (expired) await this.finish(session);
      return;
    }

    for (const device of session.devices) {
      const before = session.before.get(device.id);
      if (!before) continue;

      const commands: DeviceCommand[] = [];
      if (typeof before.hue === 'number' && typeof before.saturation === 'number') {
        commands.push({ type: 'setColor', hue: before.hue, saturation: before.saturation });
      } else if (typeof before.colorTemperatureK === 'number') {
        commands.push({ type: 'setColorTemperature', kelvin: before.colorTemperatureK });
      }
      if (typeof before.brightness === 'number') {
        commands.push({ type: 'setBrightness', brightness: before.brightness });
      }
      if (typeof before.on === 'boolean') commands.push({ type: 'setPower', on: before.on });

      for (const command of commands) {
        try {
          await this.devices.execute(device.id, command);
        } catch (err) {
          log.debug('Zustand nicht wiederherstellbar', {
            gerät: device.name,
            error: errorMessage(err),
          });
        }
      }
      // Die Frist läuft ab dem letzten Befehl, nicht ab dem Beginn des Aufräumens.
      this.settling.set(device.id, Date.now() + RESTORE_GRACE_MS);
    }
  }

  /**
   * Der Schlussschritt eines Verlaufs.
   *
   * Beim Einschlaflicht ist das der wichtigste überhaupt: Ohne ihn bliebe die
   * Lampe auf einem Prozent stehen – nachts hell genug, um zu ärgern. Wer
   * vorzeitig beendet, bekommt denselben Schluss, nur früher.
   */
  private async finish(session: Session): Promise<void> {
    for (const [index, device] of session.devices.entries()) {
      for (const command of commandsFor(session.effect, session.step, index, {
        progress: 1,
        count: session.devices.length,
      })) {
        try {
          await this.devices.execute(device.id, command, { transitionMs: 2000 });
        } catch (err) {
          log.debug('Schlussschritt fehlgeschlagen', {
            gerät: device.name,
            error: errorMessage(err),
          });
        }
      }
      this.settling.set(device.id, Date.now() + RESTORE_GRACE_MS);
    }
  }
}

/**
 * Woran sich ein Schritt außer an sich selbst noch orientieren kann.
 *
 * Zwei Arten von Verlauf brauchen mehr als die Schrittnummer: einer über die
 * **Zeit** (das Wecklicht muss wissen, wie weit es ist) und einer über den
 * **Raum** (der Regenbogen soll sich auf die vorhandenen Lampen verteilen,
 * nicht auf eine gedachte Zahl).
 */
export interface StepContext {
  /** Zwischen 0 (gerade begonnen) und 1 (gleich vorbei). */
  progress: number;
  /** Wie viele Lampen mitmachen. Mindestens 1. */
  count: number;
}

/**
 * Was ein Effekt in diesem Schritt an diese Lampe schickt.
 *
 * Rein und ohne Seiteneffekte, damit sich jeder Effekt prüfen lässt, ohne eine
 * Lampe im Raum zu haben. `index` ist die Nummer der Lampe – daran hängt, dass
 * bei der Disco nicht alle dieselbe Farbe zeigen.
 */
export function commandsFor(
  effect: LightEffect,
  step: number,
  index: number,
  context: StepContext = { progress: 0, count: 1 },
): DeviceCommand[] {
  switch (effect) {
    case 'disco': {
      /*
       * Kein Zufall, sondern ein Sprung um den goldenen Winkel (137,5°). Echter
       * Zufall trifft zu oft dieselbe Ecke des Farbkreises; so liegen
       * aufeinanderfolgende Farben immer weit auseinander – und die Lampen
       * untereinander auch.
       */
      const hue = Math.round((step * 137.5 + index * 90) % 360);
      return [
        { type: 'setPower', on: true },
        { type: 'setColor', hue, saturation: 100 },
        { type: 'setBrightness', brightness: step % 2 === 0 ? 100 : 55 },
      ];
    }

    case 'farbwechsel': {
      /*
       * Ein Verlauf über den Raum: Die Lampen teilen sich den Farbkreis
       * gleichmäßig auf und wandern gemeinsam weiter. Bei drei Lampen liegen
       * 120° dazwischen, bei sechs 60° – zusammen ergeben sie einen
       * Regenbogen, nicht sechs zufällige Farben.
       */
      const spread = 360 / Math.max(1, context.count);
      const hue = Math.round((step * 12 + index * spread) % 360);
      return [
        { type: 'setPower', on: true },
        { type: 'setColor', hue, saturation: 85 },
      ];
    }

    case 'gruselig': {
      /*
       * Das Unheimliche liegt in der Unregelmäßigkeit. Ein gleichmäßiges
       * Blinken wirkt technisch; ein Licht, das meist matt vor sich hin
       * brennt und *manchmal* zuckt, wirkt falsch – und darum geht es.
       */
      const flicker = pseudoRandom(step, index);
      const bright = flicker > 0.82 ? 70 : flicker > 0.7 ? 4 : 12 + Math.round(flicker * 10);
      return [
        { type: 'setPower', on: true },
        // Grünlich-kalt: die Farbe, die Filme für „hier stimmt etwas nicht" nehmen.
        { type: 'setColor', hue: flicker > 0.9 ? 105 : 130, saturation: 60 },
        { type: 'setBrightness', brightness: bright },
      ];
    }

    case 'kerze': {
      const wobble = pseudoRandom(step, index);
      return [
        { type: 'setPower', on: true },
        { type: 'setColorTemperature', kelvin: 2000 + Math.round(wobble * 200) },
        { type: 'setBrightness', brightness: 30 + Math.round(wobble * 22) },
      ];
    }

    case 'gewitter': {
      /*
       * Der Blitz kommt selten und dann doppelt – ein einzelner heller Moment
       * sieht nach einem Fehler aus, zwei kurz hintereinander nach einem
       * Gewitter.
       */
      const roll = pseudoRandom(step, index);
      if (roll > 0.88) {
        return [
          { type: 'setPower', on: true },
          { type: 'setColorTemperature', kelvin: 6500 },
          { type: 'setBrightness', brightness: 100 },
        ];
      }
      if (roll > 0.84) {
        return [{ type: 'setBrightness', brightness: 80 }];
      }
      return [
        { type: 'setPower', on: true },
        { type: 'setBrightness', brightness: 3 },
      ];
    }

    case 'sonnenaufgang': {
      /*
       * Ein Sonnenaufgang ist kein Dimmer, der gleichmäßig aufdreht. Zwei
       * Dinge geschehen zugleich: Die Helligkeit steigt **beschleunigt** (das
       * Auge nimmt Helligkeit logarithmisch wahr – linear hochgedreht wäre es
       * gefühlt nach einer Minute hell und danach passierte nichts mehr), und
       * die Farbe wandert von tiefrot über orange nach warmweiß.
       */
      const eased = context.progress * context.progress;
      const brightness = Math.max(1, Math.round(eased * 100));

      // Die erste Viertelstunde der Strecke bleibt farbig, danach Weißtöne.
      if (context.progress < 0.25) {
        const hue = Math.round(5 + (context.progress / 0.25) * 25); // 5° rot → 30° orange
        return [
          { type: 'setPower', on: true },
          { type: 'setColor', hue, saturation: 100 },
          { type: 'setBrightness', brightness },
        ];
      }
      const kelvin = Math.round(2000 + ((context.progress - 0.25) / 0.75) * 2000);
      return [
        { type: 'setPower', on: true },
        { type: 'setColorTemperature', kelvin },
        { type: 'setBrightness', brightness },
      ];
    }

    case 'einschlafen': {
      /*
       * Rückwärts, und mit derselben Beugung: Am Anfang geht es fast unmerklich
       * abwärts, zum Schluss zügig. Am Ende wird wirklich ausgeschaltet – eine
       * Lampe, die auf 1 % stehen bleibt, ist nachts hell genug zum Ärgern.
       */
      if (context.progress >= 1) return [{ type: 'setPower', on: false }];

      const rest = 1 - context.progress;
      const brightness = Math.max(1, Math.round(rest * rest * 60));
      return [
        { type: 'setPower', on: true },
        // Immer wärmer: 2700 K herunter bis 1800 K, wo kein Blau mehr stört.
        { type: 'setColorTemperature', kelvin: Math.round(2700 - context.progress * 900) },
        { type: 'setBrightness', brightness },
      ];
    }

    default:
      return [];
  }
}

/**
 * Wie viele Befehle ein Schritt je Lampe höchstens kostet.
 *
 * Nachgezählt statt in einer Tabelle gepflegt: Wer einen Effekt um einen
 * Befehl erweitert, soll nicht daran denken müssen, den Takt anzupassen –
 * sonst überfährt der Hub die Bridge, und niemand weiß, warum.
 *
 * Acht Schritte reichen zum Nachsehen: Effekte mit Verzweigungen (Gewitter)
 * durchlaufen darin beide Zweige, und genommen wird ohnehin der größte.
 */
function commandsPerStep(effect: LightEffect): number {
  let most = 1;
  for (let step = 0; step < 8; step++) {
    most = Math.max(most, commandsFor(effect, step, 0).length);
  }
  return most;
}

/**
 * Immer dieselbe Folge „zufälliger" Zahlen zwischen 0 und 1.
 *
 * Bewusst berechenbar statt `Math.random()`: Ein Effekt, der sich prüfen
 * lässt, ist mehr wert als einer, der bei jedem Testlauf anders flackert.
 * Fürs Auge macht es keinen Unterschied.
 */
export function pseudoRandom(step: number, index: number): number {
  const value = Math.sin(step * 12.9898 + index * 78.233) * 43758.5453;
  return value - Math.floor(value);
}
