# Smart-Home-Hub

Ein Hub, der **Philips Hue**, **Shelly**, **Homematic** und die
**FRITZ!Box** unter einer Oberfläche und einer API zusammenführt – statt vier
Apps für Licht, Steckdosen, Rollläden, Heizung und Temperaturmessung. Geschrieben in
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
| **Haushalt** | Ersteinrichtung per Assistent in sechs Schritten – bis hin zum Sortieren aller Geräte nach Gattung –, Räume, mehrere Personen mit eigenem Zugang |
| **Anmeldung** | Benutzername und Passwort statt Zugriffstoken; Sitzungen als HttpOnly-Cookie, Rollen (Administrator/Mitbewohner), Sperre gegen Durchprobieren |
| **Szenen** | Den jetzigen Zustand als Szene sichern und mit einem Tipp wiederherstellen – Licht, Farbe, Rollläden, Heizung |
| **Urlaubsmodus** | Im gewählten Zeitfenster gehen unregelmäßig Lichter an und aus, damit die Wohnung bewohnt wirkt |
| **Philips Hue** | Bridge-Discovery (mDNS + Cloud + Subnetz-Scan), Pairing über Link-Button, CLIP-API v2 – und automatischer Rückfall auf die API v1 für die runde Bridge (BSB001) |
| **Shelly** | Gen1 (REST, Basic-Auth) und Gen2/3/4 (JSON-RPC, Digest-Auth SHA-256), Relais, Dimmer, Rollläden, Heizkörperventil (TRV), Verbrauchsmessung, H&T-Sensoren, Add-On-Fühler |
| **Homematic** | CCU2, CCU3 und RaspberryMatic über die JSON-API: Rollläden mit Lamellen, Heizkörperthermostate, Wandthermostate, Klima- und Bewegungsmelder, BidCos wie HmIP |
| **FRITZ!Box** | DECT-Geräte an der Box: Schaltsteckdosen mit Verbrauchsmessung, Heizkörperregler, Lampen mit Farbe und Rollläden über HAN-FUN |
| **Rollläden** | Auf/Zu/Stop, Position, Lamellenverstellung bei Jalousien, Fahrzustand mit animierter Anzeige, Sammelbefehle je Raum – von Shelly und von Homematic |
| **Heizung** | Solltemperatur per Regler oder Plus/Minus, gemessene Temperatur, Ventilstellung – für Shelly TRV, Homematic-Thermostate und Shelly Wall Display |
| **Farbe** | Farbrad mit ziehbarem Griff für Maus, Finger und Tastatur, dazu Farb- und Weißton-Vorlagen |
| **Geräte** | Einheitliches Modell mit Fähigkeiten (`switch`, `dimmer`, `color`, `cover`, `cover.tilt`, `sensor.*`) – herstellerunabhängig steuerbar |
| **Messwerte** | Temperatur, Luftfeuchte, Helligkeit, Leistung, Energie, Batterie – dauerhaft archiviert, mit Verlaufsdiagramm |
| **Stromverbrauch** | Verbrauch und Kosten je Gerät, Raum und Zeitraum, Hochrechnung auf Monat/Jahr, Erkennung von Dauerverbrauchern |
| **Firmware-Updates** | Prüfung für Hue Bridge und Shelly, Übersicht über **alle** Geräte samt Firmwarestand, Installation auf Knopfdruck oder automatisch im gewählten Nachtfenster |
| **Automationen** | Neun fertige Vorlagen mit vorausgewählten Geräten, dazu frei baubare Regeln aus Sensorschwellen, Gerätezuständen, Uhrzeiten und **Wiederholungen** mit Zeitfenster und Wochentagen |
| **Darstellung** | Schriftgröße, Akzentfarben, hell/dunkel, „Bewegung reduzieren“ und die Lichtvorschau – am Haushalt gespeichert und damit auf jedem Gerät gleich |
| **Lichtvorschau** | Beim Verstellen zeigt die Gerätekarte sofort, wie das Licht aussehen wird – abschaltbar |
| **Kein Gerät geht verloren** | Unbekannte Kanäle werden aus ihren Werten erkannt; was übrig bleibt, steht mit Begründung in der Diagnose, und der Gerätetyp lässt sich von Hand richtigstellen |
| **Erneut verbinden** | Zugangsdaten erneuern oder den Knopf an der Hue Bridge noch einmal drücken – ohne Geräte, Räume, Szenen und Automationen zu verlieren |
| **Wiki im Hub** | Zwölf durchsuchbare Artikel zu allem – Begriffe, Einrichtung je Hersteller, Automationen, Fehlersuche – mit Verweisen aus der Oberfläche heraus |
| **Alles verbinden** | Ein Knopf übernimmt alle gefundenen Geräte, die kein Passwort brauchen – mit Bericht, was ging und was nicht |
| **Sonos** | Lautsprecher im eigenen Netz finden und bedienen: Titel, Titelbild, Play/Pause/Weiter und Lautstärke – gruppenfest, ohne Konto |
| **Spotify** | Was gerade läuft, samt Steuerung und Gerätewechsel; Anmeldung mit PKCE, ohne Client-Geheimnis |
| **Nextcloud** | Benachrichtigungen der eigenen Nextcloud – Talk, Freigaben, Kalender – als Einblendung im Hub, mit Verweis auf die Sache selbst |
| **Sicherung** | Einstellungen, Räume, Geräte, Szenen und Automationen als Datei sichern und zurückspielen – ohne Passwörter in der Datei |
| **Fassung des Hubs** | Änderungsprotokoll in der Oberfläche, Prüfung auf eine neuere Fassung und Aktualisierung auf Knopfdruck |
| **Haushalt löschen** | Alles zurücksetzen – hinter fünf Bestätigungen, von denen die letzte den abgetippten Namen verlangt |
| **Angefangene Eingaben** | Was getippt ist, überlebt ein Neuladen der Oberfläche – Kennwörter und Token ausdrücklich nicht |
| **Oberfläche** | Installierbare Web-App (PWA) mit Live-Updates (SSE), Dashboard, „Räume & Geräte“ in einem Reiter, Energie- und Verlaufsansicht; aktualisiert sich nach einem Update des Hubs selbst |

---

## Schnellstart

```bash
npm install

npm run dev          # Entwicklung mit automatischem Neustart
# oder
npm run build && npm start
```

Mehr ist nicht nötig: Der Hub legt seinen Datenordner und den Schlüssel für
die Zugangsdaten beim ersten Start selbst an.

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
- FRITZ!Box mit FRITZ!OS 6.0 oder neuer. Das Kennwort der Box-Oberfläche
  genügt; ein Benutzername ist nur nötig, wenn unter *System →
  FRITZ!Box-Benutzer* mehrere Konten angelegt sind – dann braucht das gewählte
  die Berechtigung „Smart-Home-Geräte steuern“

---

## Die Einrichtung Schritt für Schritt

1. **Haushalt anlegen** – Name, Zeitzone und dein Zugang: Anmeldename und
   Passwort. Damit meldest du dich künftig an, auf jedem Gerät. Der erste
   Zugang ist immer Administrator; weitere Personen kommen später in den
   Einstellungen dazu.
2. **Geräte verbinden** –
   *Netzwerk durchsuchen* findet Hue Bridges (mDNS/Cloud), Shellys (mDNS) und
   Homematic-Zentralen (mDNS).
   *Gründlich suchen* scannt zusätzlich das Subnetz – nötig für Batteriegeräte
   wie den Shelly H&T, die die meiste Zeit schlafen, und für die CCU2, die kein
   mDNS kennt. Jede Adresse, die beim ersten Anklopfen schweigt, wird ein
   zweites Mal mit mehr Geduld gefragt, und die Trefferliste wächst über
   mehrere Durchgänge hinweg, statt jedes Mal neu anzufangen (siehe
   [Warum manche Geräte früher nicht gefunden wurden](#warum-manche-geräte-früher-nicht-gefunden-wurden)).
   Bei Hue muss **vor** dem Klick auf „Verbinden“ der runde Knopf auf der Bridge
   gedrückt werden; sonst antwortet der Hub mit `link_button_required`.
   Passwortgeschützte Shellys fragen nach dem Passwort, die Homematic-Zentrale
   nach Benutzername und Passwort der CCU-Weboberfläche.
3. **Räume anlegen** – aus Vorschlägen oder frei benannt.
4. **Geräte zuordnen** – aus Hue übernommene Räume sind bereits vorausgewählt.
5. **Nach Gruppen sortieren** – alle Lichter, alle Rollläden, alle Heizungen
   auf einen Blick. Eine ganze Gruppe lässt sich mit einem Griff einem Raum
   zuweisen oder ausblenden. Freiwillig: Wer in Schritt 4 schon alles
   zugeordnet hat, klickt weiter.
6. **Abschließen** – ab jetzt laufen Polling, Messwertarchiv und Automationen.

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
│   ├── homematic/ Client (JSON-RPC der CCU), Kanal-Abbildung, Adapter
│   └── fritzbox/  Client (AHA-Schnittstelle), Bitmasken-Abbildung, Adapter
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

### FRITZ!Box

An der Box hängen DECT-Geräte: Schaltsteckdosen mit Verbrauchsmessung,
Heizkörperregler, Lampen und – über HAN-FUN – Rollläden. Angesprochen wird
die AHA-Schnittstelle (`/webservices/homeautoswitch.lua`).

Drei Eigenheiten von AVM sind der Grund für den eigenen Adapter:

- **Anmeldung per Aufgabe.** Die Box stellt eine „Challenge“, der Client
  rechnet daraus mit dem Passwort eine Antwort. Es gibt zwei Verfahren –
  PBKDF2 ab FRITZ!OS 7.24 und davor MD5 über die Zeichenkette in **UTF-16LE**.
  Genau dieses UTF-16LE ist die Stelle, an der Nachbauten reihenweise
  scheitern; der Hub beherrscht beide Verfahren.
- **Fähigkeiten als Bitmaske.** Jedes Gerät meldet eine Zahl
  (`functionbitmask`), in der jedes Bit für eine Fähigkeit steht. Das ist über
  alle Modelle hinweg gleich – eine FRITZ!DECT 200 von 2013 und eine DECT 500
  von heute melden sich nach demselben Schema.
- **Umgekehrte Zählrichtung bei Rollläden.** AVM zählt die *Höhe des
  Behangs*: 0 ist offen, 100 ist geschlossen. Der Hub zählt wie überall
  sonst (100 = offen) und dreht beim Lesen wie beim Schreiben um. Ohne das
  führe der Regler in der Oberfläche in die falsche Richtung.

**Wenn das Kennwort „nie geht".** Der häufigste Grund ist der Benutzername.
Auch eine Box, die auf „Anmeldung nur mit Kennwort" steht, hat intern einen –
sie hat ihn selbst angelegt und nennt ihn etwa `fritz3000`. Wer nichts
einträgt, schickte bisher eine leere Kennung, und die weist die Box ab:
richtiges Kennwort, falscher (weil gar kein) Benutzer. Den richtigen Namen
nennt die Box in derselben Antwort, in der auch die Anmeldeaufgabe steht – der
Hub liest ihn dort und verwendet ihn.

Der zweite Grund ist die Berechtigung: Ohne das Recht „Smart-Home-Geräte und
Automatisierung steuern" bleibt die Schnittstelle zu. Der Hub sagt das jetzt
im Klartext, statt einen HTTP 403 durchzureichen.

**Und wenn es trotzdem nicht geht:** Unter *Einstellungen → FRITZ!Box-Oberfläche*
lässt sich die Adresse der Box eintragen. Der Hub zeigt ihre Oberfläche dann
direkt an – dort funktioniert alles, was die Box kann. Ob sich die Seite
einbetten lässt, entscheidet die Box selbst (viele verbieten das per
`X-Frame-Options`); der Knopf „In neuem Fenster öffnen" daneben geht immer.

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

### Wie lange die Suche dauert

Zwei Dinge machten sie langsam, und sie brauchten verschiedene Antworten.

**Der gründliche Scan lief viermal.** Jeder Hersteller klopfte dasselbe Subnetz
einzeln mit einer HTTP-Anfrage ab: vier mal 254 Adressen, gemessene 54 Sekunden.
Jetzt stellt der Hub einmal per TCP-Verbindungsversuch fest, welche Adressen
überhaupt belegt sind – das dauert unter einer Sekunde –, und gibt diese Liste
allen Herstellern. Aus 54 Sekunden werden knapp 6.

**Der Rest ist Physik.** Eine mDNS-Suche muss lauschen, und wenn auf einen
Diensttyp niemand antwortet, muss sie die volle Zeit lauschen: Ein schlafender
Batteriesensor darf sich auch spät noch melden. Verkürzt wird deshalb nur der
Fall, in dem tatsächlich jemand geantwortet hat – ebbt die Antwortwelle ab,
ist die Suche fertig.

Was bleibt, wird gezeigt statt versteckt: Treffer erscheinen sofort, darunter
läuft eine Uhr und steht, auf welchen Hersteller noch gewartet wird. Ein
Kasten, in dem fünf Sekunden lang nichts passiert, sieht aus wie ein Fehler –
und wurde auch als einer gemeldet.

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

**Und warum man trotzdem manchmal mehrfach suchen musste.** Der Subnetz-Scan
klopft jede der 254 Adressen mit einer TCP-Verbindung ab und gibt ihr dafür
400 ms. Das ist reichlich für ein Gerät am Kabel und knapp für einen Shelly im
WLAN, der gerade aus dem Stromsparmodus kommt: Mal war er da, mal nicht. Da
jeder Suchlauf zudem bei null anfing, verschwanden beim zweiten Versuch die
Funde des ersten – deshalb der Eindruck, man müsse fünfmal suchen.

Drei Änderungen, jede an einer der Ursachen:

- `reachableHosts()` macht einen **zweiten Durchgang** über alles, was
  geschwiegen hat, mit deutlich längerer Frist (`retryTimeoutMs`, mindestens
  1200 ms). Adressen, hinter denen niemand ist, kosten dabei nur diese eine
  zusätzliche Frist – die Durchgänge laufen mit 128 Verbindungen parallel.
- Beim gründlichen Suchlauf bekommen **mDNS und SSDP** die doppelte Zeit,
  mindestens acht Sekunden. Hue Bridge und Sonos melden sich darüber.
- Die Oberfläche **sammelt** die Treffer über Durchgänge hinweg, statt die
  Liste zu ersetzen. Zweimal suchen addiert sich.

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

### Szenen

Eine Szene merkt sich, wie das Zuhause gerade ist. Der Kniff steckt in der
Aufnahme: Statt Kommandos zusammenzuklicken, stellt man sein Zuhause so ein,
wie man es haben will, und drückt auf sichern – der Hub liest die Zustände aus
und leitet daraus die Kommandos ab, die sie wiederherstellen.

Zwei Kleinigkeiten machen den Unterschied zwischen „funktioniert“ und „fühlt
sich richtig an“:

- **Reihenfolge.** Erst Farbe und Helligkeit, dann einschalten. Umgekehrt sähe
  man beim Herstellen der Szene kurz die alte Farbe.
- **Ausgeschaltet heißt ausgeschaltet.** Von einer dunklen Lampe wird nur
  „aus“ gesichert; ihre Helligkeit mitzuschreiben würde sie beim Abrufen der
  Szene aufblitzen lassen.

Ein Gerät, das gerade nicht antwortet, hält die anderen nicht auf – die
Antwort sagt, welcher Teil angekommen ist.

### Urlaubsmodus

Eine Wohnung, in der zwei Wochen lang abends kein Licht angeht, ist von der
Straße aus als leer zu erkennen. Im gewählten Zeitfenster schaltet der Hub
deshalb einzelne Lampen an und aus. Die Abstände streuen zufällig um den
eingestellten Mittelwert – ein festes Muster („alle 30 Minuten“) wäre von
außen schneller zu erkennen als gar kein Licht. Beim Abschalten bleibt kein
Licht an, das die Simulation eingeschaltet hat.

### Lichtvorschau

Kommandos gehen erst beim Loslassen an das Gerät – sonst löste jede
Fingerbewegung eine Anfrage aus. Zwischen „Regler bewegen“ und „Lampe
reagiert“ lägen damit ein bis zwei Sekunden, in denen man nur eine Zahl
sieht.

Die Gerätekarte schließt diese Lücke: Sie trägt einen farbigen Schein, dessen
Farbe der eingestellten Farbe folgt und dessen Stärke der Helligkeit – und
zwar sofort beim Ziehen, nicht erst nach der Antwort des Geräts. Eine
ausgeschaltete Lampe leuchtet dabei nicht, eine auf 5 % gedimmte bleibt
trotzdem sichtbar (der Schein wächst nicht linear mit der Helligkeit, sonst
wäre er bei wenig Licht praktisch unsichtbar).

Abschaltbar unter *Einstellungen → Darstellung*: Auf einem alten Tablet
kostet ein weichgezeichneter Schein spürbar Rechenzeit.

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

### Wenn ein Gerät fehlt

Der häufigste Fall ist der ärgerlichste: Ein Rollladen ist da, der Hub zeigt ihn
aber nicht. Drei Dinge greifen dagegen ineinander.

**Erstens wird geraten, statt aufzugeben.** Kennt der Hub einen Kanaltyp nicht,
sieht er sich an, welche Werte der Kanal führt. Ein Kanal mit Niveau und
Fahrtrichtung ist ein Rollladen, egal wie sein Typ heißt. Homematic ist seit
2010 gewachsen, es gibt Fremdgeräte über HmIP und Zusatzpakete mit eigenen
Kanaltypen – eine Namensliste kann das nicht abdecken.

**Zweitens gibt es eine Diagnose.** *Einstellungen → Integrationen → Erneut
verbinden und nachsehen, was fehlt* zeigt alle Geräte dieser Verbindung und
darunter, was übersprungen wurde und warum. „Rollladen fehlt“ ist keine
Auskunft, mit der man etwas anfangen kann; „Kanal 4 übersprungen, weil Typ
MAINTENANCE“ schon.

**Drittens hat der Mensch das letzte Wort.** Unter *Geräte → Erkennt der Hub ein
Gerät falsch?* lässt sich der Typ richtigstellen. Die Angabe gilt ab sofort
überall – auf der Karte, in Automationen und in Szenen. Was das Gerät selbst
meldet, bleibt daneben gespeichert: Ein Firmware-Update kann so neue Fähigkeiten
mitbringen, ohne die Korrektur zu überschreiben.

### Erneut verbinden

Zugangsdaten ändern sich, Bridges vergessen ihre Kopplung, Geräte bekommen eine
neue Adresse. Bisher blieb dafür nur „löschen und neu anlegen“ – und damit
verlor man Gerätenamen, Raumzuordnungen, Szenen und Automationen, weil die neuen
Geräte neue IDs bekommen.

*Erneut verbinden* behält die ID der Integration. Nur die Zugangsdaten werden
erneuert, danach liest der Hub die Geräteliste neu ein; die Geräte werden über
ihre `externalId` wiedererkannt. Bei Hue heißt das: Knopf drücken, „Erneut
verbinden“ wählen, fertig.

### Wo die Daten liegen – und warum das für Updates entscheidend ist

Alles, was du einrichtest, liegt in **einem Ordner außerhalb des
Projektordners**:

| System | Ort |
| --- | --- |
| Linux | `~/.local/share/smarthome-hub` (bzw. `$XDG_DATA_HOME`) |
| macOS | `~/Library/Application Support/smarthome-hub` |
| Windows | `%APPDATA%\smarthome-hub` |

Darin: `smarthome.json` (Haushalt, Räume, Geräte, Szenen, Automationen),
`telemetry/` (das Messwertarchiv) und `secret.key` – der Schlüssel, mit dem
die Zugangsdaten deiner Bridges verschlüsselt sind.

**Das ist der Grund, warum du dir jederzeit die neueste Fassung holen
kannst.** `git pull`, ein neues Archiv, ein frisch ausgepackter Ordner – die
Einrichtung liegt woanders und bleibt, wie sie ist. Zum Sichern oder Umziehen
genügt es, diesen einen Ordner zu kopieren. Den genauen Pfad zeigt der Hub
unter *Einstellungen → Wo deine Daten liegen*.

Drei Feinheiten:

- **Eine ausdrückliche Angabe gewinnt.** Wer `DATA_DIR` setzt – Docker-Volume,
  eigene Platte –, wird nicht umgezogen.
- **Ein alter Bestand kommt mit.** Liegt noch `./data` aus früheren Fassungen
  im Projektordner und am neuen Ort nichts, wandert er beim ersten Start
  einmalig um. Liegt an *beiden* Orten etwas, wird nichts angefasst: Einen
  echten Bestand mit einem vergessenen Rest zu überschreiben wäre nicht
  rückgängig zu machen.
- **Der Schlüssel gehört zu den Daten.** Er lag früher in der `.env` neben dem
  Quelltext – und damit genau dort, wo beim Aktualisieren aufgeräumt wird. Ist
  er weg, ist die Datenbank zwar da, aber jede Bridge müsste neu gekoppelt
  werden. Deshalb liegt er jetzt im Datenordner. Ehrlich dazugesagt: Er
  schützt die Sicherungsdatei und die Datenbank für sich genommen, nicht gegen
  jemanden, der ohnehin Zugriff auf den ganzen Ordner hat. Für einen Hub im
  eigenen Haushalt ist das der richtige Tausch – die Alternative wäre eine
  Passworteingabe bei jedem Start.

### Wiki im Hub

Ein eigener Reiter mit zwölf Artikeln: Erste Schritte, Geräte verbinden, je
einer zu Hue, Shelly, FRITZ!Box und Homematic, dazu Dienste, Räume und Szenen,
Automationen, Auswertung, Sicherung – und „Wenn etwas klemmt". Durchsuchbar
über den ganzen Fließtext.

Die Erklärungen stehen bewusst **im Programm** und nicht nur in dieser Datei:
Wer vor einem Kasten steht, in dem „Anmeldung abgelehnt" steht, schlägt nicht
in einer README nach – er sucht dort, wo er gerade ist. Aus den Ansichten
heraus führen deshalb Verweise direkt in den passenden Artikel.

Dazu trägt jede Karte einen Satz, der sagt, worum es geht, und an den
erklärungsbedürftigen Stellen sitzt ein Fragezeichen mit dem Rest. Es reagiert
auf Maus *und* Tastatur; der Browser-Tooltip allein wäre zu langsam und ohne
Maus gar nicht erreichbar.

### Sonos und Spotify

*Dienste → Sonos* sucht die Lautsprecher im eigenen Netz. Ein Konto braucht es
dafür nicht: Sonos spricht UPnP, alles bleibt im Haus. Gefunden wird per SSDP;
kommt dort nichts an – hinter einem Repeater, in einem Gastnetz –, klopft der
Hub Port 1400 im Subnetz ab, und zur Not trägt man die Adresse von Hand ein.
Ist erst einer gefunden, kennt der bereits alle anderen.

Zu sehen sind Titel, Interpret, Titelbild und Restlaufzeit; zu bedienen sind
Play, Pause, vor, zurück und die Lautstärke.

**Gruppen sind dabei der eigentliche Punkt.** Legt man in der Sonos-App zwei
Räume zusammen, nimmt nur einer der beiden – der Koordinator – Play und Pause
an; der andere lehnt ab. Wer also „Küche" drückt, während die Küche im
Wohnzimmer-Verbund hängt, dessen Befehl schickt der Hub ans Wohnzimmer. Die
Lautstärke bleibt beim einzelnen Lautsprecher: Wer die Küche leiser stellt,
will nicht das Wohnzimmer mitnehmen.

*Dienste → Spotify* zeigt, was gerade läuft, und steuert es. Die Einrichtung
ist einmalig und läuft über das Spotify-Dashboard: dort eine App anlegen, die
angezeigte Rückleitungsadresse zeichengenau eintragen, die Client-ID hier
einsetzen. Ein **Client-Geheimnis wird nicht gebraucht** – der Hub meldet sich
mit PKCE an. Steuern erlaubt Spotify nur mit Premium; anzeigen, was läuft, geht
auch ohne.

### Nextcloud

*Einstellungen → Nextcloud* verbindet den Hub mit der eigenen Nextcloud. Danach
erscheinen deren Benachrichtigungen – eine neue Talk-Nachricht, eine geteilte
Datei, eine Kalendererinnerung – als Einblendung, mit einem Verweis auf die
Sache selbst. Der Hub hängt ohnehin an der Wand und ist die Stelle, auf die man
im Vorbeigehen schaut; das spart den Griff zum Telefon.

Nötig sind drei Angaben: die Adresse, der Benutzername und ein
**App-Passwort**. Letzteres ist kein Umweg. Es wird in Nextcloud unter
*Einstellungen → Sicherheit → „Neues App-Passwort erstellen"* erzeugt,
funktioniert auch bei Zwei-Faktor-Anmeldung und lässt sich einzeln widerrufen,
ohne dass jemand sein Konto anfassen muss. Der Hub legt es verschlüsselt ab und
gibt es nie wieder heraus.

Zwei Feinheiten, die den Unterschied machen:

- **Beim Verbinden bleibt es still.** Der erste Abruf zählt nur, was offen ist,
  und meldet nichts. Sonst poppen dreißig alte Benachrichtigungen auf einmal auf.
- **Ein Neustart fängt nicht von vorn an.** Der Hub merkt sich, was er schon
  gezeigt hat. Fängt die Nextcloud selbst neu zu zählen an – weil sie neu
  aufgesetzt wurde –, übernimmt er den neuen Stand stillschweigend, statt Altes
  als Neues auszugeben.

Wie oft nachgesehen wird, ist einstellbar (15 Sekunden bis 5 Minuten). Ist die
Nextcloud gerade nicht erreichbar, steht das in der Karte – und nicht als
Fehler-Popup alle 30 Sekunden auf dem Bildschirm.

Die Nextcloud steht bewusst hier und nicht bei den Integrationen: Sie ist kein
Gerät. Es gibt nichts zu schalten und nichts zu messen.

### Sicherung

*Einstellungen → Sicherung* lädt Haushalt, Räume, Geräte, Szenen und
Automationen als JSON-Datei herunter.

Was **nicht** darin steht, ist die eigentliche Entscheidung: keine Zugangsdaten
zu Bridges, keine Passwörter, keine Sitzungen. Eine Sicherung landet am Ende in
einem Download-Ordner, auf einem USB-Stick oder in einer Cloud – an Orten also,
die man nicht mehr überblickt. Eine Datei, aus der jemand das Bridge-Konto und
die Anmeldedaten aller Bewohner ziehen kann, gehört dort nicht hin.

Der Preis ist eine Minute Arbeit nach dem Umzug auf neue Hardware: Jede
Verbindung muss einmal über *Erneut verbinden* hergestellt werden. Der Hub sagt
nach dem Zurückspielen, welche das sind. Auf **demselben** Hub entfällt das –
bestehende Zugangsdaten werden nicht angefasst, wenn Typ und Adresse passen.

Benutzerkonten bleiben beim Zurückspielen unangetastet. Wer die
Wiederherstellung anstößt, soll danach nicht ausgesperrt sein.

### Haushalt löschen

Ganz unten in den Einstellungen, hinter fünf Bestätigungen. Die fragen
allerdings nicht fünfmal dasselbe: Fünf gleichlautende „Bist du sicher?" klickt
man in fünf Sekunden weg, sie erziehen nur dazu, nicht mehr hinzusehen. Jeder
Schritt nennt deshalb etwas anderes, das gleich verschwindet – mit den
tatsächlichen Zahlen aus diesem Haushalt: so viele Geräte, so viele
Automationen, alle Konten einschließlich des eigenen. Der letzte Schritt lässt
sich überhaupt nicht klicken, sondern nur tippen: Dort muss der Name des
Haushalts abgetippt werden.

Danach ist der Hub wie frisch installiert – der Assistent startet wieder, der
Dienst läuft weiter.

### Die Fassung des Hubs

*Einstellungen → Diese Fassung* zeigt, was läuft, und liest dazu `CHANGELOG.md`
aus dem eigenen Verzeichnis. Steht eine neuere Fassung bereit, stehen deren
Änderungen **vor** dem Knopf, nicht dahinter – eine Aktualisierung, deren Inhalt
man erst danach erfährt, ist eine Zumutung.

**Fehlt die Arbeitskopie, holt er sie sich.** Läuft der Hub aus einem entpackten
Archiv oder einem Abbild ohne `.git`, macht der erste Aktualisierungsknopfdruck
zunächst eine Arbeitskopie daraus: `git init`, `git fetch`, `git checkout -f`.

Der Punkt dabei ist, was dabei *nicht* passiert. Git fasst nur an, was es selbst
führt – die Datenbank, die Messwerte, `.env` und `node_modules` sind unverfolgt
und bleiben unberührt liegen. Deshalb wird auch nicht woandershin geklont und
zurückkopiert: Was nicht bewegt wird, kann nicht verlorengehen. Vorher prüft der
Hub zusätzlich, ob das Repository einen Pfad führt, unter dem `DATA_DIR` liegt;
wäre das so, bricht er ab, statt die Daten zu überschreiben.

Woher der Quelltext kommt, steht in `HUB_REPO_URL` (mit sinnvoller Vorgabe),
welcher Zweig in `HUB_BRANCH`.

Drei Dinge tut der Hub bewusst nicht:

- **Ungefragt nach Hause telefonieren.** Ohne gesetztes `HUB_UPDATE_CHECK_URL`
  fragt er niemanden.
- **Heimlich aktualisieren.** Die Aktualisierung läuft nur auf Knopfdruck. Sind
  am Quelltext selbst Änderungen offen, lehnt er ab und nennt die Dateien –
  eigene Anpassungen werden nicht überschrieben. Unverfolgtes stört dabei nicht:
  `data/`, `.env` und `node_modules/` liegen auf jeder Installation herum und
  werden von einem `git pull` gar nicht angefasst.
- **Behaupten, er sei fertig.** Nach `git pull`, `npm install` und `npm run
  build` sagt er, dass ein Neustart des Dienstes fehlt. Den erledigt systemd,
  Docker oder pm2 – nicht er selbst.

Und einen Fall kann er nicht lösen: Ist `git` auf dem System gar nicht
installiert, sagt er das und nennt den Befehl, der es nachholt.

---

## Anmeldung

Angemeldet wird sich mit **Anmeldename und Passwort**. Ein Zugriffstoken war
dafür der falsche Schlüssel: einmal angezeigt, nicht zu merken, nicht zu
ändern, und für mehrere Personen im Haushalt gar nicht gedacht.

- **Passwörter** liegen als scrypt-Ableitung in der Datenbank – nie im
  Klartext. Die Parameter stehen mit im Hash, damit sie später erhöht werden
  können, ohne alte Passwörter ungültig zu machen. Mindestlänge sind zehn
  Zeichen; Zeichenklassen-Pflichten gibt es bewusst nicht, weil sie zu
  `Passwort1!` führen und Passwörter nicht besser machen.
- **Sitzungen** liegen als `HttpOnly`-Cookie im Browser: JavaScript kommt
  nicht an sie heran, und der Ereignisstrom funktioniert ohne Token in der
  Adresszeile. Sie gelten 30 Tage und verlängern sich bei Nutzung; unter
  „Angemeldete Geräte“ lässt sich jede einzeln beenden.
- **Rollen:** `admin` verwaltet Personen und Integrationen, `member` bedient
  das Zuhause. Der letzte Administrator lässt sich weder löschen noch
  herabstufen – sonst käme niemand mehr an die Verwaltung.
- **Nach fünf Fehlversuchen** ist ein Konto 15 Minuten gesperrt. Ob Name oder
  Passwort falsch war, sagt der Hub nicht: Sonst ließe sich mit der
  Anmeldemaske herausfinden, welche Konten es gibt.
- **Zugriffstoken** gibt es weiterhin – aber nur noch für das, wofür sie
  taugen: Skripte und andere Programme. Sie gehören keinem Benutzer und
  reichen deshalb nicht für die Kontenverwaltung.

Kommt ein Hub aus einer früheren Fassung, hat er einen Haushalt, aber noch
kein Konto. Wer dort mit dem alten Token hereinkommt, legt genau einmal einen
Zugang an; danach wird das Token nicht mehr gebraucht.

---

## Sicherheit

- **Zugangsdaten** (Hue Application Key, Shelly-Passwörter) liegen mit
  AES-256-GCM verschlüsselt in der Datenbank. Der Schlüssel wird per scrypt aus
  `SECRET_KEY` abgeleitet und steht nie in der Datenbank.
  → Geht `SECRET_KEY` verloren, müssen die Integrationen neu verbunden werden.
- **API-Token** werden nur als SHA-256-Hash gespeichert und genau einmal im
  Klartext ausgegeben.
- Offen ohne Anmeldung bleiben nur `/api/health`, `/api/system/info`,
  `/api/setup/state` und `/api/auth/login`. Solange noch kein Haushalt
  existiert, ist die API entsperrt – anders käme man nicht durch die
  Ersteinrichtung.
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
| `DATA_DIR` | Datenordner des Systems | Datenbank, Messwerte, Schlüssel. Leer lassen – siehe unten |
| `SECRET_KEY` | wird angelegt | Schlüssel für die Zugangsdaten. Nur setzen, wenn er von außen kommen soll |
| `AUTH_DISABLED` | `false` | Token-Prüfung abschalten (nur lokal) |
| `POLL_INTERVAL_SECONDS` | `15` | Abfrageintervall der Geräte (Startwert; änderbar in den Einstellungen) |
| `TELEMETRY_RETENTION_DAYS` | `90` | Aufbewahrung der Messwerte |
| `TELEMETRY_MIN_INTERVAL_SECONDS` | `60` | Mindestabstand zweier Messwerte je Sensor |
| `ALLOW_CLOUD_DISCOVERY` | `true` | `discovery.meethue.com` nutzen |
| `DISCOVERY_TIMEOUT_MS` | `5000` | Timeout der Gerätesuche |
| `HUB_UPDATE_CHECK_URL` | – | Adresse für die Prüfung auf eine neuere Fassung des Hubs. Leer heißt: gar nicht fragen |
| `HUB_REPO_URL` | Projekt-Repository | Woher der Quelltext kommt, wenn keine Arbeitskopie da ist |
| `HUB_BRANCH` | `main` | Zweig, der dabei gezogen wird |
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

# Szene herstellen
curl -X POST localhost:8080/api/scenes/scn_abc/apply \
  -H "Authorization: Bearer $TOKEN"

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
npm test        # 527 Tests, node:test
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
- FRITZ!Box: eigener XML-Leser, beide Anmeldeverfahren (inklusive UTF-16LE),
  die Bitmaske, die Sonderwerte des Heizkörperreglers und die umgekehrte
  Zählrichtung des Rollladens – dazu der Adapter gegen eine simulierte Box
- Lichtvorschau: dass eine ausgeschaltete Lampe nicht leuchtet, eine schwach
  gedimmte trotzdem sichtbar bleibt und warmes Licht warm aussieht
- Passwörter: scrypt-Ableitung, zeitunabhängiger Vergleich, zusammengesetzte
  Umlaute, manipulierte Hashes, Sperre nach fünf Fehlversuchen und die Frage,
  ob die Fehlermeldung verrät, welcher Teil falsch war
- Nextcloud: Adressen in allen Schreibweisen, OCS-Antworten samt Fehlercodes,
  der Sonderfall einer neu aufgesetzten Instanz, und der ganze Weg gegen eine
  nachgebaute Nextcloud – vom Verbinden über das Ereignis, aus dem die
  Oberfläche ihre Einblendung baut, bis zum „gelesen“
- Sonos: SSDP-Antworten, Gerätebeschreibung, DIDL-Lite (Datei *und* Radiostream
  mit „Interpret - Titel"), Gruppenauskunft – und gegen zwei nachgebaute
  Lautsprecher die Regel, an der es sonst scheitert: Pause landet beim
  Koordinator, die Lautstärke beim angesprochenen Gerät
- Spotify: die PKCE-Anmeldung (der mitgeschickte Verifier muss zur vorher
  gezeigten Prüfsumme passen), das Erneuern abgelaufener Token samt der Frage,
  was passiert, wenn Spotify kein neues Erneuerungstoken mitschickt, und die
  Übersetzung von 403 und 404 in Sätze
- FRITZ!Box-Sperre: dass nach einer abgelehnten Anmeldung **kein zweiter
  Versuch** bei der Box ankommt, und dass eine gemeldete Sperrzeit die Aufgabe
  gar nicht erst beantworten lässt
- FRITZ!Box-Anmeldung: dass der Hub den Standardbenutzer nimmt, den die Box in
  ihrer Anmeldeaufgabe selbst nennt (`fritz3000` statt leerer Kennung), und
  dass eine fehlende Smart-Home-Berechtigung beim Namen genannt wird statt als
  HTTP 403 durchgereicht
- Datenordner: dass eine ausdrückliche Angabe gewinnt, dass ein alter Bestand
  samt Messwertarchiv mitkommt, dass ein vorhandener Bestand am Zielort **nicht**
  überschrieben wird, dass ein misslungener Umzug den Start nicht verhindert –
  und dass der Schlüssel beim zweiten Start derselbe ist
- **Das Neu-Herunterladen von Hand durchgespielt:** Hub aufgesetzt, Haushalt und
  Nextcloud-Konto angelegt, Projektordner weggeworfen und ohne `.env` neu
  ausgepackt. Danach derselbe Haushalt, Anmeldung mit demselben Passwort, und
  der Nextcloud-Abruf lief durch – der braucht das entschlüsselte App-Passwort
- Wiki: dass es zu jedem Bereich einen Artikel gibt, dass die Suche über den
  Fließtext findet und bei Unbekanntem ehrlich nichts zurückgibt, dass die
  Auszeichnung kein HTML durchreicht – und dass die Stolpersteine, die wirklich
  auftreten (Benutzername der Box, Smart-Home-Berechtigung, App-Passwort,
  Premium, Sonos-Gruppen, `--network host`), tatsächlich erklärt werden
- Sonos in der allgemeinen Suche: dass ein Lautsprecher als Treffer erscheint,
  ohne Passwort und ohne Knopfdruck übernommen werden kann, als „bereits
  verbunden" markiert wird – und einmal gezählt wird, auch wenn er unter zwei
  Adressen antwortet
- Szenen: was aus einem Zustand an Kommandos wird (und was bewusst nicht),
  Reihenfolge, ein stummes Gerät mitten in der Szene
- Unbekannte Kanäle: dass ein Rollladen an Niveau und Fahrtrichtung erkannt wird,
  wie Rollladen und Dimmer unterschieden werden, wenn nur `LEVEL` da ist, und
  dass der Hub aufgibt, statt zu raten, wenn gar nichts vorliegt
- Richtiggestellte Gerätetypen: dass die Korrektur überall gilt, dass die
  Meldung des Geräts daneben erhalten bleibt und dass eine leere Liste keine
  Korrektur ist
- Fassungen und Änderungsprotokoll: dass `1.10.0` neuer ist als `1.9.0` (als
  Text wäre es umgekehrt), und dass das Vorwort keiner Fassung zugeschlagen wird
- Sicherung: dass keine Zugangsdaten in der Datei landen, dass eine fremde Datei
  erkannt wird, dass dieselbe Bridge verbunden bleibt, dass eine umgezogene
  ehrlich als „neu zu verbinden“ gemeldet wird – und dass niemand ausgesperrt
  wird

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
