# Smart-Home-Hub

Ein Hub, der **Philips Hue** und **Shelly** unter einer Oberfläche und einer API
zusammenführt – statt zwei Apps für Licht, Steckdosen, Rollläden und
Temperaturmessung. Geschrieben in generischem Node.js mit TypeScript, ohne
native Abhängigkeiten und ohne Cloud-Zwang.

Beim ersten Start führt ein **Einrichtungsassistent** durch das Anlegen eines
Haushalts, das Koppeln der Hue Bridge (Knopfdruck), das Hinzufügen von
Shelly-Geräten, das Anlegen von Räumen und die Zuordnung der Geräte.

---

## Was der Hub kann

| Bereich | Funktion |
| --- | --- |
| **Haushalt** | Ersteinrichtung per Assistent, Räume, Zugriffstoken |
| **Philips Hue** | Bridge-Discovery (mDNS + Cloud + Subnetz-Scan), Pairing über Link-Button, CLIP-API v2, Live-Updates über den Eventstream |
| **Shelly** | Gen1 (REST, Basic-Auth) und Gen2/3/4 (JSON-RPC, Digest-Auth SHA-256), Relais, Dimmer, Rollläden, Verbrauchsmessung, H&T-Sensoren, Add-On-Fühler |
| **Geräte** | Einheitliches Modell mit Fähigkeiten (`switch`, `dimmer`, `color`, `cover`, `sensor.*`) – herstellerunabhängig steuerbar |
| **Messwerte** | Temperatur, Luftfeuchte, Helligkeit, Leistung, Energie, Batterie – dauerhaft archiviert, mit Verlaufsdiagramm |
| **Automationen** | Sensorschwellen, Gerätezustände und Zeitpläne mit Bedingungen, Sperrzeiten und Aktionen (schalten, Webhook, Meldung) |
| **Oberfläche** | Dashboard mit Live-Updates (SSE), Raum- und Geräteansicht, Verlauf, Einstellungen |

---

## Schnellstart

```bash
npm install

# Schlüssel zum Verschlüsseln der Gerätezugangsdaten erzeugen
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → Ausgabe in .env als SECRET_KEY eintragen

npm run dev          # Entwicklung mit automatischem Neustart
# oder
npm run build && npm start
```

Danach `http://localhost:8080` im Browser öffnen – der Assistent startet
automatisch.

> **Wichtig:** Der Hub muss im **selben Netzwerk** laufen wie Hue Bridge und
> Shellys. In Docker heißt das `--network host`, sonst funktionieren weder mDNS
> noch der Subnetz-Scan.

### Voraussetzungen

- Node.js ≥ 20.11 (getestet mit Node 22)
- Hue Bridge V2 (eckig) für die CLIP-API v2
- Shelly Gen1 oder Gen2/3/4 mit erreichbarer lokaler HTTP-API

---

## Die Einrichtung Schritt für Schritt

1. **Haushalt anlegen** – Name und Zeitzone. Danach zeigt der Hub **einmalig**
   ein Zugriffstoken an. Die Oberfläche speichert es im Browser; für externe
   Zugriffe wird es als `Authorization: Bearer <token>` mitgesendet.
2. **Geräte verbinden** –
   *Netzwerk durchsuchen* findet Hue Bridges (mDNS/Cloud) und Shellys (mDNS).
   *Gründlich suchen* scannt zusätzlich das Subnetz – nötig für Batteriegeräte
   wie den Shelly H&T, die die meiste Zeit schlafen.
   Bei Hue muss **vor** dem Klick auf „Verbinden“ der runde Knopf auf der Bridge
   gedrückt werden; sonst antwortet der Hub mit `link_button_required`.
   Passwortgeschützte Shellys fragen nach dem Passwort.
3. **Räume anlegen** – aus Vorschlägen oder frei benannt.
4. **Geräte zuordnen** – aus Hue übernommene Räume sind bereits vorausgewählt.
5. **Abschließen** – ab jetzt laufen Polling, Messwertarchiv und Automationen.

Ein abgebrochener Assistent macht beim nächsten Aufruf an der richtigen Stelle
weiter; der Fortschritt steckt im Haushalt (`setupStep`).

---

## Architektur

```
src/
├── core/          Domänenmodell, Farbraum-Umrechnung, Event-Bus, Logger, Fehler
├── util/          HTTP-Client, mDNS, Digest-Auth, Krypto, Netzwerk-Hilfen
├── storage/       JSON-Datenbank (atomar), Repositories, Messwert-Ablage
├── adapters/      Integrationen
│   ├── hue/       Client (CLIP v2 + V1-Pairing), Discovery, Mapping, Adapter
│   └── shelly/    Client (Gen1 REST + Gen2 RPC), Discovery, Mapping, Adapter
├── services/      Haushalt, Räume, Integrationen, Geräte, Telemetrie,
│                  Polling, Automationen, Einrichtung
├── server/        Express-App, Auth, Fehlerbehandlung, Routen
└── index.ts       Start, Signalbehandlung
public/            Oberfläche (reines HTML/CSS/JS, kein Build-Schritt)
```

Die Abhängigkeiten fließen nur in eine Richtung: **Storage → Services → HTTP**.
Adapter kennen weder Datenbank noch HTTP-Schicht.

### Ein Adapter, mehrere Hersteller

Jede Integration implementiert dasselbe Interface
(`src/adapters/types.ts`):

```ts
interface IntegrationAdapter {
  discover(options): Promise<DiscoveredIntegration[]>;
  link(request): Promise<LinkResult>;
  test(ctx): Promise<void>;
  listDevices(ctx): Promise<AdapterDevice[]>;
  readStates(ctx): Promise<Map<string, DeviceState>>;
  execute(ctx, externalId, command): Promise<DeviceState>;
  subscribe?(ctx, onUpdate): Promise<() => void>;   // optionaler Push-Kanal
}
```

Der Rest des Systems arbeitet nur noch mit `Device`, `Capability` und
`DeviceCommand`. Eine weitere Plattform (Tasmota, Zigbee2MQTT, …) braucht damit
genau eine neue Datei plus einen Eintrag in `createAdapterRegistry()` – nichts
anderes ändert sich.

### Wie Geräte abgebildet werden

- **Hue:** ein Hub-Gerät je Hue-*Device*. Die einzelnen Services (`light`,
  `temperature`, `motion`, `light_level`, `device_power`) werden zu Fähigkeiten
  zusammengefasst. Die Bridge selbst taucht nicht als Gerät auf.
- **Shelly:** ein Hub-Gerät je *Komponente* (`switch:0`, `switch:1`,
  `temperature:0`, `cover:0` …). So lässt sich Kanal 1 eines Doppelrelais dem
  Wohnzimmer und Kanal 2 dem Flur zuordnen.

### Aktualisierung der Zustände

- **Hue** liefert Änderungen über den Eventstream (SSE) – nahezu verzögerungsfrei.
  Der Hub fragt zusätzlich alle acht Zyklen ab, falls ein Event verloren geht.
- **Shelly** wird alle `POLL_INTERVAL_SECONDS` (Standard 15 s) abgefragt.
- Alle zehn Minuten läuft ein voller Abgleich, der neue und entfernte Geräte
  erkennt. Selbst vergebene Namen und Raumzuordnungen bleiben dabei erhalten.

### Messwertarchiv

Messwerte landen als JSON-Lines pro Tag unter `data/telemetry/2026-08-07.jsonl`.
Geschrieben wird nur bei relevanter Änderung (z. B. 0,3 °C), mindestens aber alle
15 Minuten – das hält die Dateien klein, ohne Lücken im Diagramm zu erzeugen.
Dateien älter als `TELEMETRY_RETENTION_DAYS` werden automatisch gelöscht.

---

## Sicherheit

- **Zugangsdaten** (Hue Application Key, Shelly-Passwörter) liegen mit
  AES-256-GCM verschlüsselt in der Datenbank. Der Schlüssel wird per scrypt aus
  `SECRET_KEY` abgeleitet und steht nie in der Datenbank.
  → Geht `SECRET_KEY` verloren, müssen die Integrationen neu verbunden werden.
- **API-Token** werden nur als SHA-256-Hash gespeichert und genau einmal im
  Klartext ausgegeben.
- Offen ohne Token bleiben nur `/api/health`, `/api/system/info` und
  `/api/setup/state`. Solange noch kein Haushalt existiert, ist die API
  entsperrt – anders käme man nicht durch die Ersteinrichtung.
- Hue Bridges verwenden ein selbstsigniertes Zertifikat. Die Verbindung ist
  verschlüsselt, die Zertifikatskette wird aber nicht gegen die System-CAs
  geprüft (anders geht es bei Hue nicht).
- Der Hub gehört **nicht** ungeschützt ins Internet. Für Zugriff von unterwegs
  ein VPN oder einen Reverse-Proxy mit TLS davorsetzen.

---

## Konfiguration

Alle Werte kommen aus Umgebungsvariablen oder `.env` (siehe `.env.example`):

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Adresse des Webservers |
| `DATA_DIR` | `./data` | Datenbank und Messwerte |
| `SECRET_KEY` | – | **Pflicht.** Schlüssel für die Zugangsdaten |
| `AUTH_DISABLED` | `false` | Token-Prüfung abschalten (nur lokal) |
| `POLL_INTERVAL_SECONDS` | `15` | Abfrageintervall der Geräte |
| `TELEMETRY_RETENTION_DAYS` | `90` | Aufbewahrung der Messwerte |
| `TELEMETRY_MIN_INTERVAL_SECONDS` | `60` | Mindestabstand zweier Messwerte je Sensor |
| `ALLOW_CLOUD_DISCOVERY` | `true` | `discovery.meethue.com` nutzen |
| `DISCOVERY_TIMEOUT_MS` | `5000` | Timeout der Gerätesuche |
| `LOG_LEVEL` | `info` | `trace`…`error`, `silent` |

---

## API

Vollständige Referenz: [`docs/API.md`](docs/API.md). Kurzfassung:

```bash
TOKEN=sh_…

# Alle Geräte
curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/devices

# Lampe dimmen
curl -X POST localhost:8080/api/devices/dev_abc/command \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"setBrightness","brightness":30}'

# Alles im Bad ausschalten
curl -X POST localhost:8080/api/rooms/room_bad/command \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"setPower","on":false}'

# Temperaturverlauf der letzten Woche
curl -H "Authorization: Bearer $TOKEN" \
  "localhost:8080/api/telemetry/series?deviceId=dev_xyz&metric=temperatureC&hours=168"
```

---

## Automationen

Beispiel: Heizlüfter einschalten, wenn es im Bad fünf Minuten lang unter 19 °C
ist – aber nur tagsüber, und höchstens alle 15 Minuten neu:

```json
{
  "name": "Bad heizen",
  "trigger": {
    "type": "sensor", "deviceId": "dev_badsensor",
    "metric": "temperatureC", "operator": "<", "value": 19, "forSeconds": 300
  },
  "conditions": [{ "type": "timeRange", "from": "06:00", "to": "22:00" }],
  "actions": [{
    "type": "command",
    "target": { "deviceIds": ["dev_heizluefter"] },
    "command": { "type": "setPower", "on": true }
  }],
  "cooldownSeconds": 900
}
```

Regeln lösen **flankengesteuert** aus: solange die Bedingung erfüllt bleibt,
feuert die Regel nur einmal. Erst wenn sie zwischendurch nicht mehr zutrifft,
ist die Regel wieder scharf. Zeitpläne werden in der Zeitzone des Haushalts
ausgewertet – inklusive Sommerzeitwechsel.

---

## Tests

```bash
npm test        # 117 Tests, node:test
npm run typecheck
```

Abgedeckt sind unter anderem:

- Farbraum-Umrechnungen (HSV ↔ RGB ↔ CIE-xy, Mired ↔ Kelvin)
- Verschlüsselung inklusive Manipulationserkennung
- HTTP-Digest-Auth gegen eine unabhängig nachgerechnete Referenz
- Auswertung echter Hue- und Shelly-Statusantworten (Gen1 und Gen2)
- Zeitzonenlogik der Automationen (inkl. Fenster über Mitternacht)
- Datenbank unter parallelen Schreibzugriffen
- Der komplette Einrichtungsfluss über HTTP
- Hue- und Shelly-Adapter gegen simulierte Geräte – inklusive Link-Button-Ablauf
  und Digest-Authentifizierung

---

## Bekannte Grenzen

- Ein Hub verwaltet **einen** Haushalt. Er läuft typischerweise in genau dieser
  Wohnung; mehrere Haushalte würden Discovery und Rechte unnötig verkomplizieren.
- Shelly bietet keinen Push-Kanal in dieser Implementierung – Zustände kommen per
  Polling. (Shellys Outbound-WebSocket wäre der nächste Ausbauschritt.)
- Batteriebetriebene Sensoren melden sich nur beim Aufwachen; zwischen zwei
  Meldungen zeigt der Hub den letzten bekannten Wert.
- Die JSON-Datenbank ist für Haushaltsgrößen ausgelegt (einige hundert Geräte).
  Für deutlich mehr wäre SQLite der richtige nächste Schritt – die
  Repository-Schicht ist dafür bereits abstrahiert.
