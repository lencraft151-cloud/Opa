# Smart-Home-Hub

Ein Hub, der **Philips Hue**, **Shelly** und **Homematic** unter einer
Oberfläche und einer API zusammenführt – statt drei Apps für Licht,
Steckdosen, Rollläden, Heizung und Temperaturmessung. Geschrieben in
generischem Node.js mit TypeScript, ohne native Abhängigkeiten und ohne
Cloud-Zwang.

Ausdrücklich mitgedacht sind **alte Geräte**: die runde Hue Bridge von 2012
(API v1), Shellys der ersten Generation samt Heizkörperventil, und Homematic
BidCos neben HmIP. Was in seiner Hersteller-App noch funktioniert, soll auch
hier funktionieren.

Beim ersten Start führt ein **Einrichtungsassistent** durch das Anlegen eines
Haushalts, das Koppeln der Hue Bridge (Knopfdruck), das Hinzufügen von
Shelly- und Homematic-Geräten, das Anlegen von Räumen und die Zuordnung der
Geräte.

---

## Was der Hub kann

| Bereich | Funktion |
| --- | --- |
| **Haushalt** | Ersteinrichtung per Assistent, Räume, Zugriffstoken |
| **Philips Hue** | Bridge-Discovery (mDNS + Cloud + Subnetz-Scan), Pairing über Link-Button, CLIP-API v2 – und automatischer Rückfall auf die API v1 für die runde Bridge (BSB001) |
| **Shelly** | Gen1 (REST, Basic-Auth) und Gen2/3/4 (JSON-RPC, Digest-Auth SHA-256), Relais, Dimmer, Rollläden, Heizkörperventil (TRV), Verbrauchsmessung, H&T-Sensoren, Add-On-Fühler |
| **Homematic** | CCU2, CCU3 und RaspberryMatic über die JSON-API: Rollläden mit Lamellen, Heizkörperthermostate, Wandthermostate, Klima- und Bewegungsmelder, BidCos wie HmIP |
| **Rollläden** | Auf/Zu/Stop, Position, Lamellenverstellung bei Jalousien, Fahrzustand mit animierter Anzeige, Sammelbefehle je Raum – von Shelly und von Homematic |
| **Heizung** | Solltemperatur per Regler oder Plus/Minus, gemessene Temperatur, Ventilstellung – für Shelly TRV, Homematic-Thermostate und Shelly Wall Display |
| **Farbe** | Farbrad mit ziehbarem Griff für Maus, Finger und Tastatur, dazu Farb- und Weißton-Vorlagen |
| **Geräte** | Einheitliches Modell mit Fähigkeiten (`switch`, `dimmer`, `color`, `cover`, `cover.tilt`, `sensor.*`) – herstellerunabhängig steuerbar |
| **Messwerte** | Temperatur, Luftfeuchte, Helligkeit, Leistung, Energie, Batterie – dauerhaft archiviert, mit Verlaufsdiagramm |
| **Stromverbrauch** | Verbrauch und Kosten je Gerät, Raum und Zeitraum, Hochrechnung auf Monat/Jahr, Erkennung von Dauerverbrauchern |
| **Firmware-Updates** | Prüfung für Hue Bridge und Shelly, Übersicht über **alle** Geräte samt Firmwarestand, Installation auf Knopfdruck oder automatisch im gewählten Nachtfenster |
| **Automationen** | Neun fertige Vorlagen mit vorausgewählten Geräten, dazu frei baubare Regeln aus Sensorschwellen, Gerätezuständen, Uhrzeiten und **Wiederholungen** mit Zeitfenster und Wochentagen |
| **Darstellung** | Schriftgröße, Akzentfarben, hell/dunkel und „Bewegung reduzieren“ – am Haushalt gespeichert und damit auf jedem Gerät gleich |
| **Oberfläche** | Installierbare Web-App (PWA) mit Live-Updates (SSE), Dashboard, Raum-, Geräte-, Energie- und Verlaufsansicht; aktualisiert sich nach einem Update des Hubs selbst |

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
- Hue Bridge V1 (rund) oder V2 (eckig) – der Hub wählt die passende API selbst
- Shelly Gen1 oder Gen2/3/4 mit erreichbarer lokaler HTTP-API
- Homematic CCU2, CCU3 oder RaspberryMatic mit aktivierter JSON-API und einem
  Benutzer mit Administratorrechten

---

## Die Einrichtung Schritt für Schritt

1. **Haushalt anlegen** – Name und Zeitzone. Danach zeigt der Hub **einmalig**
   ein Zugriffstoken an. Die Oberfläche speichert es im Browser; für externe
   Zugriffe wird es als `Authorization: Bearer <token>` mitgesendet.
2. **Geräte verbinden** –
   *Netzwerk durchsuchen* findet Hue Bridges (mDNS/Cloud), Shellys (mDNS) und
   Homematic-Zentralen (mDNS).
   *Gründlich suchen* scannt zusätzlich das Subnetz – nötig für Batteriegeräte
   wie den Shelly H&T, die die meiste Zeit schlafen, und für die CCU2, die kein
   mDNS kennt.
   Bei Hue muss **vor** dem Klick auf „Verbinden“ der runde Knopf auf der Bridge
   gedrückt werden; sonst antwortet der Hub mit `link_button_required`.
   Passwortgeschützte Shellys fragen nach dem Passwort, die Homematic-Zentrale
   nach Benutzername und Passwort der CCU-Weboberfläche.
3. **Räume anlegen** – aus Vorschlägen oder frei benannt.
4. **Geräte zuordnen** – aus Hue übernommene Räume sind bereits vorausgewählt.
5. **Abschließen** – ab jetzt laufen Polling, Messwertarchiv und Automationen.

Ein abgebrochener Assistent macht beim nächsten Aufruf an der richtigen Stelle
weiter; der Fortschritt steckt im Haushalt (`setupStep`).

Später kommt eine Bridge dazu? Unter **Einstellungen → Integrationen →
„Weitere Bridge oder weiteres Gerät hinzufügen“** stehen dieselbe Netzwerksuche
und derselbe Bogen für die Eingabe von Hand wie im Assistenten.

---

## Architektur

```
src/
├── core/          Domänenmodell, Farbraum-Umrechnung, Event-Bus, Logger, Fehler
├── util/          HTTP-Client, mDNS, Digest-Auth, Krypto, Netzwerk-Hilfen
├── storage/       JSON-Datenbank (atomar), Repositories, Messwert-Ablage
├── adapters/      Integrationen
│   ├── hue/       Client (CLIP v2 + API v1), Discovery, Mapping, Adapter
│   ├── shelly/    Client (Gen1 REST + Gen2 RPC), Discovery, Mapping, Adapter
│   └── homematic/ Client (JSON-RPC der CCU), Kanal-Abbildung, Adapter
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
  checkForUpdate?(ctx): Promise<UpdateInfo>;        // optionale Firmwareprüfung
  installUpdate?(ctx): Promise<void>;
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
  `temperature:0`, `cover:0`, `thermostat:0` …). So lässt sich Kanal 1 eines
  Doppelrelais dem Wohnzimmer und Kanal 2 dem Flur zuordnen.
- **Homematic:** ein Hub-Gerät je *Kanal*. Die CCU beschreibt Geräte über
  Kanäle mit sprechenden Typnamen (`BLIND_VIRTUAL_RECEIVER`,
  `CLIMATECONTROL_RT_TRANSCEIVER`, `WEATHER`), und diese Namen sind über CCU2,
  CCU3 und RaspberryMatic hinweg stabil – auch bei Geräten von 2012.

### Alte Geräte

Der Hub geht nicht davon aus, dass ein Gerät neu ist:

- **Hue Bridge V1 (rund, BSB001).** Sie kennt die CLIP-API v2 nicht. Beim
  Koppeln probiert der Hub `/clip/v2/resource/bridge`; antwortet die Bridge mit
  einem Fehler, merkt er sich `protocol: 'v1'` und spricht ab da die alte API.
  Dort läuft Helligkeit von 0..254 statt in Prozent, Temperaturen kommen in
  Hundertstelgrad, und die drei Sensoren eines Bewegungsmelders erscheinen
  einzeln – sie werden über den MAC-Teil ihrer `uniqueid` wieder zu einem Gerät
  zusammengefasst.
- **Shelly Gen1.** Das Heizkörperventil TRV meldet Soll- und Isttemperatur
  sowie die Ventilstellung unter `thermostats`, der 2.5 im Rollladenmodus unter
  `rollers`. Beide bekommen keine neue Firmware mehr; ohne eigene Zweige wären
  sie unsichtbar. Auch der selbst vergebene Gerätename steht bei Gen1 nur in
  `/settings` – der Hub liest ihn beim Verbinden mit, damit nicht jedes Gerät
  nach seiner Typnummer heißt.
- **Homematic BidCos.** Die alten Aktoren melden die Fahrtrichtung in
  `DIRECTION` statt in `ACTIVITY_STATE`, ihre Thermostate den Sollwert als
  `SET_TEMPERATURE` statt `SET_POINT_TEMPERATURE`, und Batterien nur als
  „schwach ja/nein“ statt als Prozentwert. Welcher Wertename gilt, entscheidet
  der Hub anhand der gelesenen Werte – nicht anhand einer Modellliste, die bei
  unbekannten Geräten versagen würde.

### Warum manche Geräte früher nicht gefunden wurden

Antworten auf eine mDNS-Anfrage gehen per Multicast an `224.0.0.251:5353`. Ein
Socket auf einem zufälligen Port sieht davon nichts – er hört nur die Geräte,
die das „unicast response“-Bit beachten, und das tun längst nicht alle (Shellys
etwa nicht). Der Hub bindet deshalb auf Port 5353 mit `reuseAddr`, teilt ihn
sich also mit einem laufenden Avahi/Bonjour. Klappt das nicht, fällt er auf
einen zufälligen Port samt Unicast-Bit zurück.

Zwei weitere Lücken sind geschlossen: Der Subnetz-Scan für Hue lief bisher nur,
wenn gar keine Bridge gefunden wurde – wer zwei hat, sah die zweite nie. Und
Gen1-Shellys wurden nur erkannt, wenn „shelly“ im mDNS-Namen stand; umbenannte
Geräte fielen durchs Raster. Jetzt entscheidet das Gerät selbst über `/shelly`.

### Fertige Automationen

Neun Vorlagen decken ab, wofür die meisten überhaupt einen Hub aufsetzen:
Licht bei Bewegung, Heizen bei Kälte, Rollläden morgens und abends, nachts
alles aus, Batteriewarnung, Lüften bei Feuchte, Lüftungserinnerung im Takt und
Nachtabsenkung der Heizung.

Der Hub schlägt dabei die passenden Geräte selbst vor und paart Sensor und
Aktor aus demselben Raum – ein Bewegungsmelder im Flur schaltet das Flurlicht,
nicht das im Schlafzimmer. Fehlt für eine Vorlage das nötige Gerät, steht das
in Alltagssprache dabei („Es ist kein Bewegungsmelder eingebunden.“) statt sie
kommentarlos auszugrauen.

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

### Stromverbrauch: woher die Zahlen kommen

Der Hub rechnet auf zwei Wegen, je nachdem was das Gerät liefert:

- **Energiezähler** (`sensor.energy`, z. B. Shelly PM): Es werden die Zuwächse
  zwischen den Messpunkten summiert. Läuft ein Zähler nach einem Stromausfall
  wieder bei null los, wird der Rückwärtssprung als Reset gewertet statt als
  negativer Verbrauch.
- **Leistungskurve** (`sensor.power`): Die Kurve wird nach der Trapezregel
  integriert. Lücken über 30 Minuten – dort lief der Hub nicht – werden
  übersprungen statt hochgerechnet.

Damit die Anzeige ehrlich bleibt, weist jede Auswertung eine **Abdeckung** aus:
den Anteil des Zeitraums, für den überhaupt Messwerte vorliegen. Liegt sie unter
20 %, gibt es **keine** Hochrechnung auf Monat oder Jahr – aus fünf Minuten
Messdaten eine Jahresprognose zu bilden hieße, die Zahl um das
Hunderttausendfache zu strecken.

Kosten ergeben sich aus `pricePerKwh` plus anteiliger `basePricePerMonth`; beides
lässt sich in den Einstellungen ändern.

### Firmware-Updates

Der Hub prüft zweimal täglich, ob für Bridge oder Gerät eine neue Firmware
bereitliegt:

- **Hue**: über `swupdate2` der V1-API. Die Bridge sucht nur auf Aufforderung,
  deshalb stößt der Hub die Suche an und liest das Ergebnis aus.
- **Shelly**: `Shelly.CheckForUpdate` (Gen2+) bzw. `/status` → `has_update` (Gen1).
- **Homematic**: Die CCU aktualisiert sich und ihre Geräte über die eigene
  Weboberfläche. Der Hub bietet dafür bewusst keinen Knopf an, der ins Leere
  liefe – in der Übersicht steht dann „nicht unterstützt“.

In den Einstellungen steht neben den Bridges auch **jedes einzelne Gerät** mit
seinem Firmwarestand. Daneben steht, wer es aktualisiert: Ein Shelly ist sein
eigenes Gerät, Hue-Lampen und Homematic-Aktoren hängen an ihrer Zentrale.

Ist die automatische Installation aktiv, werden bereitstehende Updates nur im
eingestellten Zeitfenster installiert – standardmäßig nachts zwischen 03:00 und
05:00, damit ein Neustart der Bridge niemanden im Dunkeln stehen lässt. Nach
einer angestoßenen Installation bleibt dieselbe Integration eine Stunde
unangetastet, weil das Gerät währenddessen neu startet und noch die alte Version
meldet.

### Als App auf dem Handy

Die Oberfläche ist eine installierbare Web-App: Im Browser auf dem Handy über
„Zum Startbildschirm hinzufügen“ landet sie mit eigenem Icon im App-Raster und
startet ohne Browserleiste. Ein Service Worker hält HTML, CSS und JavaScript
vor, damit die App auch bei hakendem WLAN sofort erscheint.

**Gerätedaten werden bewusst nicht zwischengespeichert.** Ein veralteter
Schaltzustand wäre schlimmer als eine ehrliche Fehlermeldung – deshalb gehen
alle `/api/`-Anfragen immer ans Netz.

Auf kleinen Bildschirmen wechselt die Navigation auf eine untere Leiste mit
großen Bedienflächen; die selteneren Bereiche liegen hinter „Mehr“.

### Die Oberfläche aktualisiert sich selbst

Genau der Zwischenspeicher, der die App schnell startet, würde nach einem
Update des Hubs die alte Fassung festhalten – „Cache leeren“ findet auf dem
Handy kaum jemand. Deshalb liefert `/api/system/info` eine Kennung (`build`)
aller Dateien unter `public/`. Ändert sie sich, verwirft die Seite den
Zwischenspeicher und lädt neu: still, während sie im Hintergrund liegt, mit
acht Sekunden Vorwarnung, wenn jemand davorsitzt – und gar nicht, solange
gerade getippt wird.

### Darstellung

Schriftgröße (85 – 160 %), Akzentfarbe, hell/dunkel und „Bewegung reduzieren“
stehen in den Einstellungen und gehören zum **Haushalt**, nicht zum Browser:
Wer die Schrift größer stellt, will das auf dem Küchentablet genauso wie auf
dem Handy. Alle Maße im Stylesheet sind relativ, die Schriftgröße skaliert
deshalb die ganze Oberfläche und nicht nur den Text.

Die Akzentfarbe darf auch leer bleiben – dann gelten die mitgelieferten Farben,
die für hellen und dunklen Hintergrund getrennt abgestimmt sind. Bei einer
eigenen Farbe rechnet die Oberfläche die Textfarbe darauf nach der
WCAG-Leuchtdichteformel aus, damit die Beschriftung lesbar bleibt.

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

# Heizung auf 21,5 °C stellen
curl -X POST localhost:8080/api/devices/dev_heizung/command \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"setTargetTemperature","targetTemperatureC":21.5}'

# Rollladen halb öffnen
curl -X POST localhost:8080/api/devices/dev_rollladen/command \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"setPosition","position":50}'

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

### Wiederholungen

Neben Messwerten, Gerätezuständen und festen Uhrzeiten gibt es Regeln, die sich
in einem Takt wiederholen – mit optionalem Zeitfenster und Wochentagen:

```json
{
  "name": "Ans Lüften erinnern",
  "trigger": {
    "type": "interval", "everyMinutes": 120,
    "from": "08:00", "to": "20:00", "days": [1, 2, 3, 4, 5]
  },
  "actions": [{ "type": "notify", "message": "Kurz durchlüften?" }]
}
```

Gemessen wird der Abstand ab der letzten Ausführung, nicht an festen Uhrzeiten:
Nach einem Neustart läuft die Regel einmal sofort und danach im gewünschten
Takt. Außerhalb des Fensters passiert nichts, und beim nächsten Eintritt wird
einmal ausgelöst statt alles Versäumte nachgeholt. Kürzer als fünf Minuten
lässt der Hub nicht zu – häufiger wäre nur Last ohne Nutzen.

---

## Tests

```bash
npm test        # 266 Tests, node:test
npm run typecheck   # prüft Quellen und Tests
```

Abgedeckt sind unter anderem:

- Farbraum-Umrechnungen (HSV ↔ RGB ↔ CIE-xy, Mired ↔ Kelvin)
- Verschlüsselung inklusive Manipulationserkennung
- HTTP-Digest-Auth gegen eine unabhängig nachgerechnete Referenz
- Auswertung echter Hue- und Shelly-Statusantworten (Gen1 und Gen2)
- Rollladen-Fahrzustände – inklusive der Falle, dass Gen1 und Gen2 mit `open`
  Unterschiedliches meinen
- Verbrauchsrechnung mit Zählerreset, Messlücken und Zeitzonengrenzen
- Netzwerkfehler-Übersetzung: keine rohen Fehlercodes in Meldungen
- mDNS: Anfrageaufbau, Antwort-Parser und ein Gerät, das nur per Multicast
  antwortet – genau der Fall, der vorher übersehen wurde
- Automations-Vorlagen: Gerätevorschläge, Vorgabewerte und Fehlermeldungen
- Farbsteuerung: gemeldete Fähigkeit und ausführbares Kommando bleiben synchron
- Zeitzonenlogik der Automationen (inkl. Fenster über Mitternacht)
- Datenbank unter parallelen Schreibzugriffen
- Der komplette Einrichtungsfluss über HTTP
- Hue- und Shelly-Adapter gegen simulierte Geräte – inklusive Link-Button-Ablauf,
  Digest-Authentifizierung, Rollladenfahrten und Update-Erkennung
- Alte Geräte gegen echte Antwortformate: Hue V1 (Helligkeit 0..254,
  Hundertstelgrad, zusammengesetzte Sensoren), Shelly TRV und 2.5 im
  Rollladenmodus, Homematic BidCos neben HmIP
- Wiederholende Automationen: Takt, Zeitfenster, Wochentage und die Frage, was
  nach einem Neustart passiert
- Darstellung: Grenzen für Schriftgröße, ungültige Farben, und dass ein
  Haushalt aus einer früheren Fassung die neuen Felder nachgerüstet bekommt
- Kennung der Oberfläche: gleich bei gleichem Stand, anders nach einer Änderung

---

## Bekannte Grenzen

- Ein Hub verwaltet **einen** Haushalt. Er läuft typischerweise in genau dieser
  Wohnung; mehrere Haushalte würden Discovery und Rechte unnötig verkomplizieren.
- Shelly und Homematic bieten in dieser Implementierung keinen Push-Kanal –
  Zustände kommen per Polling. (Shellys Outbound-WebSocket und die
  XML-RPC-Rückrufe der CCU wären die nächsten Ausbauschritte.)
- Die Firmware einzelner Homematic-Geräte meldet die CCU nicht über
  `Device.listAllDetail`; dort steht in der Übersicht „Firmware unbekannt“.
- Batteriebetriebene Sensoren melden sich nur beim Aufwachen; zwischen zwei
  Meldungen zeigt der Hub den letzten bekannten Wert.
- Die JSON-Datenbank ist für Haushaltsgrößen ausgelegt (einige hundert Geräte).
  Für deutlich mehr wäre SQLite der richtige nächste Schritt – die
  Repository-Schicht ist dafür bereits abstrahiert.
