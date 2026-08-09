import { badRequest, errorMessage } from '../core/errors.js';
import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type {
  AutomationRule,
  ComparisonOperator,
  Device,
  Metric,
  DeviceCommand,
  RuleAction,
  RuleCondition,
  RuleTrigger,
} from '../core/types.js';
import { request } from '../util/http.js';
import { createId, nowIso } from '../util/id.js';
import type { Repositories } from '../storage/repositories.js';
import {
  resolveTemplates,
  templateById,
  type ResolvedTemplate,
  type TemplateValues,
} from './automationTemplates.js';
import type { DeviceService } from './deviceService.js';
import type { HouseholdService } from './householdService.js';

const log = createLogger('automations');

/** Taktrate für Zeitpläne und Haltedauern (`forSeconds`). */
/*
 * Takt der Regelprüfung.
 *
 * Fünf Sekunden statt der früheren dreißig: Ein Intervall von zwanzig
 * Sekunden lässt sich mit einem Dreißig-Sekunden-Takt schlicht nicht
 * einhalten. Die Prüfung selbst ist billig – sie sieht auf die Uhr und
 * vergleicht Zahlen; teuer wird nur das Ausführen, und das passiert
 * ohnehin nur, wenn eine Regel greift.
 */
const TICK_MS = 5_000;

interface RuleRuntimeState {
  /** Seit wann ist die Trigger-Bedingung ununterbrochen erfüllt? */
  satisfiedSince: number | null;
  /** Wurde für die aktuelle Episode bereits ausgelöst? */
  firedForEpisode: boolean;
  lastTriggeredMs: number;
  /** Letzter ausgelöster Zeitplan als `YYYY-MM-DDTHH:MM`. */
  lastScheduleSlot: string | null;
  /** Letzte Ausführung eines wiederholenden Auslösers. */
  lastIntervalMs: number;
}

export interface CreateRuleInput {
  name: string;
  trigger: RuleTrigger;
  conditions?: RuleCondition[];
  actions: RuleAction[];
  enabled?: boolean;
  cooldownSeconds?: number;
}

/**
 * Regelwerk für Automationen: „Wenn die Temperatur im Bad unter 19 °C fällt,
 * schalte die Steckdose mit dem Heizlüfter ein.“
 *
 * Sensorregeln werden ereignisgetrieben ausgewertet (sobald ein neuer Messwert
 * eintrifft), Zeitpläne über einen 30-Sekunden-Takt.
 */
export class AutomationService {
  private readonly runtime = new Map<string, RuleRuntimeState>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Laufende Rücknahmen aus `forSeconds` – siehe `scheduleUndo`. */
  private readonly pendingUndos = new Set<NodeJS.Timeout>();
  private householdId: string | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly devices: DeviceService,
    private readonly households: HouseholdService,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  list(householdId: string): AutomationRule[] {
    return this.repos.rules.listByHousehold(householdId);
  }

  get(id: string): AutomationRule {
    return this.repos.rules.get(id, 'Automation');
  }

  async create(householdId: string, input: CreateRuleInput): Promise<AutomationRule> {
    const name = input.name.trim();
    if (!name) throw badRequest('Die Automation braucht einen Namen');
    if (input.actions.length === 0) throw badRequest('Mindestens eine Aktion ist erforderlich');

    this.validateReferences(householdId, input.trigger, input.conditions ?? [], input.actions);

    const rule: AutomationRule = {
      id: createId('rule'),
      householdId,
      name,
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      conditions: input.conditions ?? [],
      actions: input.actions,
      cooldownSeconds: Math.max(0, input.cooldownSeconds ?? 60),
      lastTriggeredAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.rules.insert(rule);
    return rule;
  }

  async update(id: string, changes: Partial<CreateRuleInput>): Promise<AutomationRule> {
    const rule = this.get(id);
    const patch: Partial<AutomationRule> = {};

    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name) throw badRequest('Der Name darf nicht leer sein');
      patch.name = name;
    }
    if (changes.trigger !== undefined) patch.trigger = changes.trigger;
    if (changes.conditions !== undefined) patch.conditions = changes.conditions;
    if (changes.actions !== undefined) {
      if (changes.actions.length === 0) throw badRequest('Mindestens eine Aktion ist erforderlich');
      patch.actions = changes.actions;
    }
    if (changes.enabled !== undefined) patch.enabled = changes.enabled;
    if (changes.cooldownSeconds !== undefined) {
      patch.cooldownSeconds = Math.max(0, changes.cooldownSeconds);
    }

    this.validateReferences(
      rule.householdId,
      patch.trigger ?? rule.trigger,
      patch.conditions ?? rule.conditions,
      patch.actions ?? rule.actions,
    );

    this.runtime.delete(id);
    return this.repos.rules.patch(id, patch, 'Automation');
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    await this.repos.rules.remove(id);
    this.runtime.delete(id);
  }

  // -------------------------------------------------------------------------
  // Vorlagen
  // -------------------------------------------------------------------------

  /** Vorlagen inklusive Vorbelegung aus dem tatsächlichen Gerätebestand. */
  templates(householdId: string): ResolvedTemplate[] {
    return resolveTemplates(
      this.repos.devices.listByHousehold(householdId),
      this.repos.rooms.listByHousehold(householdId),
    );
  }

  /** Legt aus einer Vorlage eine fertige Regel an. */
  async createFromTemplate(
    householdId: string,
    templateId: string,
    values: TemplateValues,
    name?: string,
  ): Promise<AutomationRule> {
    const template = templateById(templateId);

    // Fehlende Felder aus der Vorbelegung ergänzen, damit ein Klick auf
    // „Übernehmen“ ohne weitere Eingaben genügt.
    const resolved = this.templates(householdId).find((entry) => entry.id === templateId);
    const merged: TemplateValues = { ...(resolved?.defaults ?? {}), ...values };

    const input = template.build(merged);
    if (name?.trim()) input.name = name.trim();
    return this.create(householdId, input);
  }

  // -------------------------------------------------------------------------
  // Ausführung
  // -------------------------------------------------------------------------

  start(householdId: string): void {
    if (this.timer) return;
    this.householdId = householdId;

    this.unsubscribe = events.on('device.updated', ({ device }) => {
      void this.evaluateForDevice(device).catch((err) => {
        log.warn('Auswertung fehlgeschlagen', { error: errorMessage(err) });
      });
    });

    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        log.warn('Zeitplan-Auswertung fehlgeschlagen', { error: errorMessage(err) });
      });
    }, TICK_MS);
    this.timer.unref?.();

    log.info('Automationen aktiv', { rules: this.repos.rules.listEnabled(householdId).length });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    // Sonst schaltete nach dem Herunterfahren noch eine Rücknahme.
    for (const undo of this.pendingUndos) clearTimeout(undo);
    this.pendingUndos.clear();
  }

  /** Führt eine Regel unabhängig vom Trigger aus (Test-Knopf in der UI). */
  async run(id: string): Promise<{ executed: number }> {
    const rule = this.get(id);
    const results = await this.executeActions(rule);
    return { executed: results };
  }

  private async tick(): Promise<void> {
    if (!this.householdId) return;
    const household = this.households.current();
    if (!household) return;

    const now = new Date();
    const slot = localSlot(now, household.timezone);
    const weekday = localWeekday(now, household.timezone);

    for (const rule of this.repos.rules.listEnabled(this.householdId)) {
      if (rule.trigger.type === 'schedule') {
        const state = this.stateFor(rule.id);
        if (state.lastScheduleSlot === slot.key) continue;
        if (rule.trigger.at !== slot.time) continue;
        if (rule.trigger.days.length > 0 && !rule.trigger.days.includes(weekday)) continue;
        state.lastScheduleSlot = slot.key;
        await this.fire(rule);
        continue;
      }

      if (rule.trigger.type === 'interval') {
        if (this.shouldFireInterval(rule.id, rule.trigger, now, household.timezone, weekday)) {
          this.stateFor(rule.id).lastIntervalMs = now.getTime();
          await this.fire(rule);
        }
        continue;
      }

      // Haltedauern (`forSeconds`) laufen auch ohne neuen Messwert weiter.
      if (rule.trigger.type === 'sensor' && rule.trigger.forSeconds) {
        const device = this.repos.devices.find(rule.trigger.deviceId);
        if (device) await this.evaluateRule(rule, device);
      }
    }
  }

  private shouldFireInterval(
    ruleId: string,
    trigger: Extract<RuleTrigger, { type: 'interval' }>,
    now: Date,
    timezone: string,
    weekday: number,
  ): boolean {
    return isIntervalDue(trigger, this.stateFor(ruleId).lastIntervalMs, now, timezone, weekday);
  }

  private async evaluateForDevice(device: Device): Promise<void> {
    if (!this.householdId) return;
    for (const rule of this.repos.rules.listEnabled(this.householdId)) {
      const triggerDeviceId =
        rule.trigger.type === 'sensor' || rule.trigger.type === 'deviceState'
          ? rule.trigger.deviceId
          : null;
      if (triggerDeviceId !== device.id) continue;
      await this.evaluateRule(rule, device);
    }
  }

  private async evaluateRule(rule: AutomationRule, device: Device): Promise<void> {
    const satisfied = this.isTriggerSatisfied(rule.trigger, device);
    const state = this.stateFor(rule.id);
    const now = Date.now();

    if (!satisfied) {
      // Flanke zurückgesetzt – die Regel darf erneut auslösen.
      state.satisfiedSince = null;
      state.firedForEpisode = false;
      return;
    }

    state.satisfiedSince ??= now;
    if (state.firedForEpisode) return;

    const holdSeconds =
      rule.trigger.type === 'sensor' && rule.trigger.forSeconds ? rule.trigger.forSeconds : 0;
    if (holdSeconds > 0 && (now - state.satisfiedSince) / 1000 < holdSeconds) return;

    if (!this.areConditionsMet(rule)) return;

    if (rule.cooldownSeconds > 0 && now - state.lastTriggeredMs < rule.cooldownSeconds * 1000) {
      return;
    }

    state.firedForEpisode = true;
    await this.fire(rule);
  }

  private async fire(rule: AutomationRule): Promise<void> {
    const state = this.stateFor(rule.id);
    state.lastTriggeredMs = Date.now();

    log.info('Automation ausgelöst', { rule: rule.name });
    events.emit('automation.triggered', {
      ruleId: rule.id,
      ruleName: rule.name,
      householdId: rule.householdId,
    });

    await this.repos.rules.patch(rule.id, { lastTriggeredAt: nowIso() }, 'Automation');
    await this.executeActions(rule);
  }

  /**
   * Nimmt ein Kommando nach der eingestellten Zeit wieder zurück.
   *
   * Das Gegenteil wird aus dem Kommando selbst abgeleitet – nur dort, wo es
   * eindeutig ist: Einschalten wird Ausschalten, Auffahren wird Zufahren.
   * Für eine Helligkeit gibt es kein Gegenteil, ohne den vorherigen Wert zu
   * kennen; solche Kommandos laufen ohne Rücknahme, und die Oberfläche bietet
   * die Dauer dort gar nicht erst an.
   *
   * Die Zeitgeber liegen in einer Liste, damit `stop()` sie mitnimmt – sonst
   * schaltete nach dem Herunterfahren noch etwas.
   */
  private scheduleUndo(
    rule: AutomationRule,
    action: Extract<RuleAction, { type: 'command' }>,
  ): void {
    const undo = undoCommand(action.command);
    if (!undo) return;

    const timer = setTimeout(
      () => {
        this.pendingUndos.delete(timer);
        void this.devices
          .executeMany(rule.householdId, action.target, undo)
          .catch((err) =>
            log.warn('Rücknahme fehlgeschlagen', { rule: rule.name, error: errorMessage(err) }),
          );
      },
      (action.forSeconds ?? 0) * 1000,
    );
    timer.unref?.();
    this.pendingUndos.add(timer);
  }

  private async executeActions(rule: AutomationRule): Promise<number> {
    let executed = 0;
    for (const action of rule.actions) {
      try {
        switch (action.type) {
          case 'command': {
            const results = await this.devices.executeMany(
              rule.householdId,
              action.target,
              action.command,
            );
            executed += results.filter((result) => result.ok).length;
            const failed = results.filter((result) => !result.ok);
            if (failed.length > 0) {
              log.warn('Teil der Aktion fehlgeschlagen', {
                rule: rule.name,
                failed: failed.map((f) => f.error),
              });
            }
            if (action.forSeconds) this.scheduleUndo(rule, action);
            break;
          }
          case 'webhook': {
            await request(action.url, {
              method: action.method ?? 'POST',
              json: action.body ?? { rule: rule.name, triggeredAt: nowIso() },
              timeoutMs: 5000,
            });
            executed++;
            break;
          }
          case 'notify': {
            events.emit('notification', {
              householdId: rule.householdId,
              message: action.message,
              level: 'info',
            });
            executed++;
            break;
          }
          default:
            break;
        }
      } catch (err) {
        log.warn('Aktion fehlgeschlagen', { rule: rule.name, error: errorMessage(err) });
      }
    }
    return executed;
  }

  // -------------------------------------------------------------------------
  // Bedingungslogik
  // -------------------------------------------------------------------------

  private isTriggerSatisfied(trigger: RuleTrigger, device: Device): boolean {
    switch (trigger.type) {
      case 'sensor': {
        const value = device.state[trigger.metric];
        if (typeof value !== 'number') return false;
        return compare(value, trigger.operator, trigger.value);
      }
      case 'deviceState': {
        const value = device.state[trigger.property];
        return typeof value === 'boolean' && value === trigger.equals;
      }
      case 'schedule':
      case 'interval':
        return false; // beides wird im Takt ausgewertet
      default:
        return false;
    }
  }

  private areConditionsMet(rule: AutomationRule): boolean {
    const household = this.households.current();
    const timezone = household?.timezone ?? 'Europe/Berlin';

    return rule.conditions.every((condition) => {
      switch (condition.type) {
        case 'timeRange':
          return isWithinTimeRange(new Date(), timezone, condition.from, condition.to);
        case 'deviceState': {
          const device = this.repos.devices.find(condition.deviceId);
          const value = device?.state[condition.property];
          return typeof value === 'boolean' && value === condition.equals;
        }
        case 'sensor': {
          const device = this.repos.devices.find(condition.deviceId);
          const value = device?.state[condition.metric as Metric];
          return typeof value === 'number' && compare(value, condition.operator, condition.value);
        }
        default:
          return true;
      }
    });
  }

  private stateFor(ruleId: string): RuleRuntimeState {
    let state = this.runtime.get(ruleId);
    if (!state) {
      state = {
        satisfiedSince: null,
        firedForEpisode: false,
        lastTriggeredMs: 0,
        lastScheduleSlot: null,
        lastIntervalMs: 0,
      };
      this.runtime.set(ruleId, state);
    }
    return state;
  }

  private validateReferences(
    householdId: string,
    trigger: RuleTrigger,
    conditions: RuleCondition[],
    actions: RuleAction[],
  ): void {
    const assertDevice = (deviceId: string): void => {
      const device = this.repos.devices.find(deviceId);
      if (!device || device.householdId !== householdId) {
        throw badRequest(`Gerät ${deviceId} gehört nicht zu diesem Haushalt`);
      }
    };

    if (trigger.type === 'sensor' || trigger.type === 'deviceState') assertDevice(trigger.deviceId);
    if (trigger.type === 'schedule' && !/^\d{2}:\d{2}$/.test(trigger.at)) {
      throw badRequest('Die Uhrzeit muss im Format HH:MM angegeben werden');
    }
    if (trigger.type === 'interval') {
      if (trigger.everySeconds === undefined && trigger.everyMinutes === undefined) {
        throw badRequest('Für eine Wiederholung wird ein Abstand gebraucht.');
      }
      if (trigger.everySeconds !== undefined && trigger.everySeconds < 5) {
        throw badRequest(
          'Der Abstand muss mindestens fünf Sekunden betragen.',
          undefined,
          'Darunter käme der Hub mit dem Fragen und Schalten nicht hinterher.',
        );
      }
      if ((trigger.from && !trigger.to) || (!trigger.from && trigger.to)) {
        throw badRequest(
          'Für ein Zeitfenster werden Start- und Endzeit gebraucht.',
          undefined,
          'Gib beide an – oder keine, dann gilt die Regel rund um die Uhr.',
        );
      }
    }

    for (const condition of conditions) {
      if (condition.type === 'deviceState' || condition.type === 'sensor') {
        assertDevice(condition.deviceId);
      }
    }

    for (const action of actions) {
      if (action.type !== 'command') continue;
      for (const deviceId of action.target.deviceIds ?? []) assertDevice(deviceId);
      for (const roomId of action.target.roomIds ?? []) {
        const room = this.repos.rooms.find(roomId);
        if (!room || room.householdId !== householdId) {
          throw badRequest(`Raum ${roomId} gehört nicht zu diesem Haushalt`);
        }
      }
    }
  }
}

export function compare(value: number, operator: ComparisonOperator, reference: number): boolean {
  switch (operator) {
    case '<':
      return value < reference;
    case '<=':
      return value <= reference;
    case '>':
      return value > reference;
    case '>=':
      return value >= reference;
    case '==':
      return value === reference;
    case '!=':
      return value !== reference;
    default:
      return false;
  }
}

/** Lokale Uhrzeit `HH:MM` in der Zeitzone des Haushalts. */
export function localTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function localSlot(date: Date, timezone: string): { time: string; key: string } {
  const time = localTime(date, timezone);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return { time, key: `${day}T${time}` };
}

/**
 * Ist eine wiederholende Regel wieder dran?
 *
 * Der Abstand wird ab der letzten Ausführung gemessen, nicht an festen
 * Uhrzeiten. Nach einem Neustart läuft die Regel damit einmal sofort und
 * danach im gewünschten Takt – das ist bei „alle zwei Stunden lüften
 * erinnern" das erwartete Verhalten.
 *
 * Zeitfenster und Wochentage schränken zusätzlich ein: Außerhalb passiert
 * nichts, und die verstrichene Zeit läuft trotzdem weiter. Nach dem Fenster
 * wird also nicht alles Versäumte nachgeholt, sondern einmal ausgelöst.
 */
export function isIntervalDue(
  trigger: Extract<RuleTrigger, { type: 'interval' }>,
  lastRunMs: number,
  now: Date,
  timezone: string,
  weekday: number,
): boolean {
  if (trigger.days && trigger.days.length > 0 && !trigger.days.includes(weekday)) return false;
  if (trigger.from && trigger.to && !isWithinTimeRange(now, timezone, trigger.from, trigger.to)) {
    return false;
  }
  const seconds = trigger.everySeconds ?? (trigger.everyMinutes ?? 0) * 60;
  return (now.getTime() - lastRunMs) / 1000 >= seconds;
}

/** Wochentag 0 = Sonntag … 6 = Samstag, in der Zeitzone des Haushalts. */
export function localWeekday(date: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(
    date,
  );
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[name] ?? new Date(date).getDay();
}

/** Prüft ein Zeitfenster; `from > to` bedeutet "über Mitternacht". */
export function isWithinTimeRange(
  date: Date,
  timezone: string,
  from: string,
  to: string,
): boolean {
  const now = localTime(date, timezone);
  if (from <= to) return now >= from && now <= to;
  return now >= from || now <= to;
}

/**
 * Das Gegenteil eines Kommandos – oder nichts, wenn es keins gibt.
 *
 * Bewusst nur die eindeutigen Fälle. Für „Helligkeit 40 %" wäre das Gegenteil
 * der vorherige Wert, und den müsste man raten; lieber gar keine Rücknahme
 * als eine falsche.
 */
export function undoCommand(command: DeviceCommand): DeviceCommand | null {
  switch (command.type) {
    case 'setPower':
      return { type: 'setPower', on: !command.on };
    case 'openCover':
      return { type: 'closeCover' };
    case 'closeCover':
      return { type: 'openCover' };
    default:
      return null;
  }
}
