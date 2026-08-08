# API-Referenz

Basis-URL: `http://<host>:8080/api`

## Anmeldung

Zwei Wege führen herein.

**Menschen** melden sich mit Name und Passwort an; das Ergebnis ist eine
Sitzung, die als `HttpOnly`-Cookie (`sh_session`) zurückkommt und bei jedem
weiteren Aufruf automatisch mitreist.

```bash
curl -c cookies.txt -X POST localhost:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"anna","password":"drei zufaellige woerter"}'

curl -b cookies.txt localhost:8080/api/devices
```

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `POST` | `/auth/login` | `{ username, password }` → setzt das Sitzungs-Cookie |
| `POST` | `/auth/logout` | Beendet die eigene Sitzung |
| `GET` | `/auth/me` | Wer angemeldet ist (`{ user: null }`, wenn niemand) – ohne Anmeldung erreichbar |
| `POST` | `/auth/password` | `{ currentPassword, newPassword }`; meldet alle anderen Geräte ab |
| `GET` | `/auth/sessions` | Angemeldete Geräte, `current` markiert das eigene |
| `DELETE` | `/auth/sessions/:id` | Ein Gerät abmelden |
| `POST` | `/auth/sessions/end-others` | Alle außer dem eigenen abmelden |
| `GET` | `/auth/users` | Personen im Haushalt |
| `POST` | `/auth/users` | Person anlegen (nur Administratoren) |
| `PATCH` | `/auth/users/:id` | `displayName`, `role` (nur Administratoren) |
| `POST` | `/auth/users/:id/password` | Passwort zurücksetzen (nur Administratoren) |
| `DELETE` | `/auth/users/:id` | Person entfernen (nur Administratoren) |

Regeln, die der Hub durchsetzt:

- Anmeldenamen sind klein geschrieben und eindeutig; erlaubt sind Buchstaben,
  Ziffern, Punkt, Bindestrich und Unterstrich.
- Passwörter brauchen mindestens 10 Zeichen, dürfen nicht auf der Liste der
  meistgenutzten stehen und nicht den Anmeldenamen enthalten.
- Nach fünf Fehlversuchen ist das Konto 15 Minuten gesperrt. Ob Name oder
  Passwort falsch war, sagt die Antwort nicht.
- Der letzte Administrator lässt sich weder löschen noch herabstufen.
- Ein **Zugriffstoken** (siehe unten) gehört einem Programm, nicht einer
  Person. Es hat keine Rolle und reicht für `/auth/users` nicht.

---

## Authentifizierung für Programme

Skripte und andere Programme, die sich nicht anmelden können, nehmen ein
Zugriffstoken:

```
Authorization: Bearer sh_…
```

Alternativ `X-Access-Token: sh_…` oder `?access_token=sh_…`.

Token werden unter **Einstellungen → Zugänge für Programme** erstellt
(`POST /household/tokens`) und **einmalig** im Klartext ausgegeben; gespeichert
wird nur ihr SHA-256-Hash. Sie gehören keinem Benutzer und reichen deshalb nicht
für `/auth/users`. Jedes Token lässt sich einzeln widerrufen – auch das letzte,
denn ausgesperrt ist damit niemand mehr.

Offen ohne Anmeldung sind `/health`, `/system/info`, `/setup/state` und
`/auth/login`. Solange noch kein Haushalt existiert, ist die API entsperrt –
anders käme man nicht durch die Ersteinrichtung.

## Fehlerformat

```json
{
  "error": {
    "code": "upstream_error",
    "message": "192.168.1.42 ist im Netzwerk nicht erreichbar.",
    "hint": "Prüfe, ob Hub und Gerät im selben Netz hängen. In Docker braucht der Hub \"--network host\".",
    "details": { "code": "EHOSTUNREACH" }
  }
}
```

`message` sagt, **was** nicht geht, `hint` sagt, **was jetzt zu tun ist**. Rohe
Fehlercodes wie `ECONNREFUSED` tauchen nie in der Meldung auf – sie stehen
allenfalls unter `details`.

| Code | Status | Bedeutung |
| --- | --- | --- |
| `bad_request` | 400 | Ungültige Eingabe (`details` nennt die Felder) |
| `unauthorized` | 401 | Token fehlt oder ist ungültig |
| `device_auth_required` | 401 | Das Gerät verlangt ein Passwort |
| `not_found` | 404 | Objekt existiert nicht |
| `conflict` | 409 | Doppelter Name, bereits verbundenes Gerät |
| `link_button_required` | 428 | Knopf auf der Hue Bridge drücken |
| `upstream_error` | 502 | Gerät/Bridge antwortet nicht wie erwartet |
| `timeout` | 504 | Zeitüberschreitung zum Gerät |

---

## System

### `GET /health`
Ohne Token. `{ status, uptimeSeconds, polling }`

### `GET /system/info`
Ohne Token. Version, Node-Version, verfügbare Adapter, aktive Einstellungen –
und `build`: eine Kennung aller ausgelieferten Dateien unter `public/`.

Die Weboberfläche fragt sie regelmäßig ab; ändert sie sich, verwirft sie ihren
Zwischenspeicher und lädt sich neu. Gleicher Stand ⇒ gleiche Kennung, jede
Änderung ⇒ neue Kennung. Der Wert wird 15 Sekunden lang zwischengespeichert.

```json
{ "name": "Smart-Home-Hub", "version": "1.0.0", "build": "9617df2505a1",
  "node": "v22.22.0", "hasHousehold": true, "setupCompleted": true,
  "authRequired": true,
  "adapters": [ { "type": "homematic", "displayName": "Homematic",
                  "supportsPush": false } ] }
```

### `GET /events`
Server-Sent-Events-Strom. Ereignisse: `device.added`, `device.updated`,
`device.removed`, `integration.updated`, `room.updated`, `telemetry.sample`,
`automation.triggered`, `notification`.

```js
const source = new EventSource('/api/events?access_token=' + token);
source.addEventListener('device.updated', (e) => console.log(JSON.parse(e.data)));
```

---

## Einrichtung

### `GET /setup/state`
Ohne Token. Aktueller Schritt, Fortschritt, Kennzahlen und Hinweise.

### `POST /setup/household`
Legt Haushalt und erstes Benutzerkonto zusammen an – beides gehört zusammen:
Ein Haushalt ohne Konto wäre für niemanden erreichbar.

```json
{ "name": "Wohnung Musterstraße", "timezone": "Europe/Berlin", "locale": "de-DE",
  "pricePerKwh": 0.35, "currency": "EUR", "basePricePerMonth": 12.9,
  "username": "anna", "password": "drei zufaellige woerter", "displayName": "Anna" }
```
→ `201` mit `{ household, state, user }` und einem gesetzten Sitzungs-Cookie:
Man ist direkt angemeldet. Der erste Benutzer ist immer Administrator. Ein
zweiter Haushalt wird mit `409` abgelehnt.

### `POST /setup/step`
`{ "step": "rooms" }` – springt im Assistenten. Erlaubt: `household`,
`integrations`, `rooms`, `assign`, `done`.

### `GET /setup/suggested-rooms`
Liste typischer Raumnamen für den Assistenten.

### `POST /setup/rooms`
`{ "names": ["Wohnzimmer", "Bad"] }` – legt fehlende Räume an (idempotent).

### `POST /setup/assign`
```json
{ "assignments": [ { "deviceId": "dev_a", "roomId": "room_x" },
                   { "deviceId": "dev_b", "roomId": null } ] }
```

### `POST /setup/complete`
Schließt die Einrichtung ab. `400`, solange keine Integration verbunden ist.

---

## Haushalt

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/household` | Stammdaten |
| `PATCH` | `/household` | `name`, `timezone`, `locale`, `pricePerKwh`, `currency`, `basePricePerMonth`, `autoUpdate`, `autoUpdateFrom`, `autoUpdateTo`, `appearance` |
| `GET` | `/household/summary` | Kennzahlen fürs Dashboard inkl. gestörter Integrationen |
| `GET` | `/household/tokens` | Tokens (ohne Hash) |
| `POST` | `/household/tokens` | `{ "name": "Handy" }` → neues Token |
| `DELETE` | `/household/tokens/:id` | Token widerrufen (das letzte nicht) |

### Darstellung

`appearance` gehört zum Haushalt und gilt damit auf jedem Gerät, auf dem der
Hub geöffnet wird. Übergebene Felder werden mit den gespeicherten
zusammengeführt – wer nur die Schriftgröße ändert, verliert seine Farben nicht.

```json
{ "appearance": { "fontScale": 1.3, "accentColor": "#1f8a4c",
                  "accentColorAlt": "#7cc242", "theme": "dark",
                  "reduceMotion": false } }
```

| Feld | Werte | Bedeutung |
| --- | --- | --- |
| `fontScale` | `0.85` – `1.6` | Skalierung der gesamten Oberfläche, nicht nur des Textes |
| `accentColor` | `#rrggbb` oder `null` | `null` = mitgelieferte Farbe (getrennt für hell und dunkel abgestimmt) |
| `accentColorAlt` | `#rrggbb` oder `null` | Zweite Farbe für Verläufe |
| `theme` | `auto`, `light`, `dark` | `auto` folgt der Systemeinstellung |
| `reduceMotion` | `true`/`false` | Animationen abschalten |

Werte außerhalb der Grenzen und Farben, die keine sind, werden mit `400`
abgewiesen – eine ungültige Farbe würde der Browser stillschweigend verwerfen
und die Einstellung sähe aus, als täte sie nichts.

---

## Integrationen

### `GET /integrations/discover?type=hue|shelly|homematic&scan=true`
Sucht im Netzwerk. `scan=true` scannt zusätzlich das Subnetz (langsamer, findet
aber schlafende Geräte). Antwort:

```json
{ "found": [ {
  "type": "hue", "host": "192.168.1.42", "externalId": "001788FFFE…",
  "name": "Hue Bridge", "model": "BSB002", "requiresLinkButton": true,
  "source": "mdns", "alreadyLinked": false
} ], "scanned": false }
```

### `POST /integrations`
```json
{ "type": "hue", "host": "192.168.1.42", "name": "Bridge", "importRooms": true }
```
Für Shelly zusätzlich `password` (und bei Gen1 optional `username`).

Bei Hue **vorher den Knopf auf der Bridge drücken**, sonst `428
link_button_required`. Antwort `201` mit Integration, übernommenen Geräten und
`summary`.

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/integrations` | Liste inkl. Gerätezahl (nie mit Zugangsdaten) |
| `GET` | `/integrations/:id` | Details inkl. Geräten |
| `PATCH` | `/integrations/:id` | `name`, `enabled` |
| `POST` | `/integrations/:id/sync` | Geräteliste neu einlesen |
| `POST` | `/integrations/:id/test` | Verbindung prüfen |
| `DELETE` | `/integrations/:id` | Integration und deren Geräte entfernen |

---

## Räume

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/rooms` | Räume inkl. `climate` und `deviceCount` |
| `GET` | `/rooms/:id` | Raum inkl. Geräteliste |
| `POST` | `/rooms` | `{ name, icon?, targetTemperatureC? }` |
| `PATCH` | `/rooms/:id` | dieselben Felder |
| `DELETE` | `/rooms/:id` | Geräte bleiben erhalten (ohne Raum) |
| `POST` | `/rooms/reorder` | `{ "order": ["room_a", "room_b"] }` |
| `POST` | `/rooms/:id/command` | Kommando an alle passenden Geräte des Raums |

---

## Geräte

### `GET /devices`
Filter: `roomId`, `unassigned=true`, `integrationId`, `capability`, `search`,
`includeHidden=true`.

```json
{
  "id": "dev_…", "name": "Stehlampe", "vendor": "hue", "roomId": "room_…",
  "capabilities": ["switch", "dimmer", "color_temperature", "color"],
  "state": { "on": true, "brightness": 62.5, "colorTemperatureK": 2703,
             "updatedAt": "2026-08-07T17:20:00.000Z" },
  "reachable": true
}
```

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/devices/:id` | Einzelnes Gerät |
| `PATCH` | `/devices/:id` | `name`, `roomId`, `hidden` |
| `DELETE` | `/devices/:id` | Entfernen (kommt beim nächsten Sync wieder) |
| `POST` | `/devices/:id/command` | Kommando ausführen |
| `POST` | `/devices/command` | Kommando an mehrere Geräte |

### Kommandos

| Kommando | Body | Benötigte Fähigkeit |
| --- | --- | --- |
| Ein/Aus | `{"type":"setPower","on":true}` | `switch` |
| Umschalten | `{"type":"toggle"}` | `switch` |
| Dimmen | `{"type":"setBrightness","brightness":0…100}` | `dimmer` |
| Farbtemperatur | `{"type":"setColorTemperature","kelvin":1500…10000}` | `color_temperature` |
| Farbe | `{"type":"setColor","hue":0…360,"saturation":0…100}` | `color` |
| Position | `{"type":"setPosition","position":0…100}` | `cover` |
| Auffahren | `{"type":"openCover"}` | `cover` |
| Zufahren | `{"type":"closeCover"}` | `cover` |
| Anhalten | `{"type":"stopCover"}` | `cover` |
| Lamellen | `{"type":"setTilt","tilt":0…100}` | `cover.tilt` |
| Solltemperatur | `{"type":"setTargetTemperature","targetTemperatureC":4…35}` | `thermostat` |
| Identifizieren | `{"type":"identify"}` | – |

Bei Rollläden gilt **100 = ganz offen, 0 = ganz zu**. Der Zustand enthält
zusätzlich `coverState` (`open`, `closed`, `opening`, `closing`, `stopped`) –
darauf beruht die Bewegungsanzeige in der Oberfläche.

`setBrightness` mit `0` schaltet aus; alle anderen Helligkeits-, Farb- und
Farbtemperatur-Kommandos schalten das Gerät automatisch ein.

Geräte mit `thermostat` melden im Zustand `targetTemperatureC` (Sollwert),
`temperatureC` (gemessen, falls das Gerät misst) und `valvePosition` (0–100 %,
falls es die Ventilstellung kennt). Alte Bauformen sind eingeschlossen: das
Shelly TRV, Homematic-Heizkörperthermostate (BidCos wie HmIP) und
Wandthermostate.

### Sammelkommando

```json
{
  "target": { "roomIds": ["room_bad"], "allWithCapability": "switch" },
  "command": { "type": "setPower", "on": false }
}
```
Ziele können `deviceIds`, `roomIds` und `allWithCapability` kombinieren; Geräte
ohne passende Fähigkeit werden übersprungen. Antwort enthält Einzelergebnisse
sowie `succeeded` / `failed`.

---

## Messwerte

Gemeinsame Parameter: `deviceId`, `metric`, `from`/`to` (ISO 8601) oder `hours`
(Standard 24), `limit`.

Messgrößen: `temperatureC`, `humidity`, `illuminanceLux`, `powerW`, `energyWh`,
`batteryPercent`, `brightness`.

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/telemetry` | Rohe Messwerte (bei Überlänge gleichmäßig ausgedünnt) |
| `GET` | `/telemetry/series` | Verdichtet zu Zeitfenstern (`bucketMinutes`, Standard 15) mit `min`/`max`/`avg` |
| `GET` | `/telemetry/aggregate` | `min`, `max`, `avg`, `count` je Gerät und Messgröße |
| `GET` | `/telemetry/climate` | Aktuelles Klima je Raum inkl. einzelner Sensoren |

---

## Stromverbrauch

Gemeinsame Parameter: `period` (`today`, `yesterday`, `week`, `month`, `year`,
`custom`), bei `custom` zusätzlich `from` und `to` (ISO 8601).

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/energy/summary` | Vollständige Auswertung (siehe unten) |
| `GET` | `/energy/devices` | Nur die Geräteliste – für Ranglisten |
| `GET` | `/energy/rooms` | Verbrauch je Raum |

```json
{
  "period": { "key": "today", "label": "Heute", "hours": 8.2, "from": "…", "to": "…" },
  "currency": "EUR", "pricePerKwh": 0.42,
  "totalKwh": 2.14, "energyCost": 0.9, "baseCost": 0.16, "totalCost": 1.06,
  "currentPowerW": 142.5,
  "coverage": 0.87,
  "devices": [ { "deviceId": "dev_…", "name": "Waschmaschine", "roomName": "Bad",
                 "energyKwh": 1.8, "cost": 0.76, "share": 84.1,
                 "averagePowerW": 220.4, "currentPowerW": 0,
                 "method": "counter", "coverage": 0.87 } ],
  "rooms": [ { "roomId": "room_…", "roomName": "Bad", "energyKwh": 1.8, "share": 84.1 } ],
  "projection": { "perDayKwh": 5.9, "perMonthKwh": 177, "perMonthCost": 88.9,
                  "perYearKwh": 2153, "perYearCost": 1078 },
  "standby": { "devices": [ … ], "totalPowerW": 12.4, "costPerYear": 45.6 },
  "unmeteredDeviceCount": 3
}
```

`method` sagt, woraus der Wert stammt: `counter` (Energiezähler des Geräts),
`power` (integrierte Leistungskurve) oder `none` (keine Daten).

`coverage` ist der Anteil des Zeitraums mit Messwerten. **`projection` ist
`null`, solange die Abdeckung unter 20 % liegt** – dann wäre jede Hochrechnung
geraten. Die Oberfläche zeigt in dem Fall einen Hinweis statt einer Zahl.

---

## Firmware-Updates

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/updates` | Übersicht inklusive Auto-Update-Einstellungen |
| `POST` | `/updates/check` | Alle Integrationen sofort prüfen |
| `POST` | `/updates/:integrationId/check` | Eine Integration prüfen |
| `POST` | `/updates/:integrationId/install` | Installation starten (`202`) |

```json
{
  "integrations": [ { "integrationId": "int_…", "name": "Hue Bridge", "type": "hue",
                      "supported": true,
                      "updateInfo": { "currentVersion": "1965111030",
                                      "availableVersion": "bereit zur Installation",
                                      "updateAvailable": true, "installable": true,
                                      "checkedAt": "…" } } ],
  "devices": [ { "deviceId": "dev_…", "name": "Stehlampe", "vendor": "hue",
                 "model": "LCT001", "firmware": "5.50.1", "reachable": true,
                 "integrationId": "int_…", "integrationName": "Hue Bridge",
                 "updatedBy": "bridge", "updateAvailable": true,
                 "supported": true } ],
  "updatesAvailable": 1,
  "autoUpdate": { "enabled": false, "from": "03:00", "to": "05:00", "timezone": "Europe/Berlin" },
  "lastCheckedAt": "…"
}
```

`devices` listet **jedes sichtbare Gerät** mit seinem Firmwarestand, alphabetisch.
`updatedBy` sagt, wo die Aktualisierung tatsächlich passiert: `device` bei
Shellys, die sich selbst aktualisieren, `bridge` bei Hue-Lampen und
Homematic-Aktoren, deren Zentrale die Firmware verteilt. `supported` ist
`false`, wenn der Adapter gar nicht nach Firmware sehen kann – die Oberfläche
bietet dann keinen Knopf an, der ins Leere liefe (Homematic aktualisiert sich
über die eigene Weboberfläche der CCU).

Die automatische Installation wird über `PATCH /household` gesteuert
(`autoUpdate`, `autoUpdateFrom`, `autoUpdateTo`). Sie greift nur innerhalb des
Zeitfensters; das Gerät startet dabei neu.

---

## Szenen

Eine Szene sichert den *aktuellen* Zustand der genannten Geräte. Der Hub liest
ihn aus und leitet die Kommandos ab, die ihn wiederherstellen.

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/scenes` | Alle Szenen |
| `GET` | `/scenes/:id` | Eine Szene inklusive ihrer Kommandos |
| `POST` | `/scenes` | `{ name, emoji?, roomId?, deviceIds[] }` – sichert den jetzigen Zustand |
| `PATCH` | `/scenes/:id` | `name`, `emoji`, `roomId` |
| `POST` | `/scenes/:id/restamp` | Zustände neu aufnehmen („so wie es jetzt ist“) |
| `POST` | `/scenes/:id/apply` | Szene herstellen |
| `DELETE` | `/scenes/:id` | Szene löschen |
| `POST` | `/scenes/preview` | `{ deviceIds[] }` → was gesichert würde, ohne zu speichern |

```json
{
  "id": "scn_…", "name": "Fernsehabend", "emoji": "📺", "roomId": null,
  "entries": [
    { "deviceId": "dev_lampe",
      "commands": [
        { "type": "setColorTemperature", "kelvin": 2700 },
        { "type": "setBrightness", "brightness": 25 },
        { "type": "setPower", "on": true }
      ] },
    { "deviceId": "dev_rollladen", "commands": [{ "type": "setPosition", "position": 35 }] }
  ],
  "lastAppliedAt": "…"
}
```

Die Reihenfolge ist Absicht: erst Farbe und Helligkeit, dann schalten – sonst
sähe man beim Herstellen kurz die alte Farbe. Von einer ausgeschalteten Lampe
wird nur `setPower: false` gesichert; ihre Helligkeit mitzuschreiben würde sie
beim Abrufen aufblitzen lassen.

`POST /scenes/:id/apply` antwortet mit Einzelergebnissen:

```json
{ "sceneId": "scn_…", "name": "Fernsehabend", "applied": 2, "failed": 1,
  "results": [ { "deviceId": "dev_…", "ok": false, "error": "Gerät antwortet nicht" } ] }
```

Ein stummes Gerät hält die anderen nicht auf.

---

## Urlaubsmodus

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/presence` | Einstellungen und aktueller Zustand |
| `PATCH` | `/presence` | `enabled`, `from`, `to`, `roomIds[]`, `averageIntervalMinutes` |

```json
{
  "settings": { "enabled": true, "from": "17:30", "to": "22:45",
                "roomIds": [], "averageIntervalMinutes": 25 },
  "active": true, "devicesOn": 2, "candidates": 6
}
```

`active` heißt: eingeschaltet **und** gerade im Zeitfenster. Die Abstände
zwischen zwei Schaltvorgängen streuen zufällig zwischen der Hälfte und dem
Anderthalbfachen des Mittelwerts – ein festes Muster wäre von außen schneller
zu erkennen als gar kein Licht. Erlaubt sind 10 bis 120 Minuten. Beim
Abschalten geht alles wieder aus, was die Simulation eingeschaltet hat.

---

## Automationen

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| `GET` | `/automations` | Alle Regeln |
| `GET` | `/automations/:id` | Einzelne Regel |
| `POST` | `/automations` | Anlegen |
| `PATCH` | `/automations/:id` | Ändern (z. B. `{"enabled":false}`) |
| `DELETE` | `/automations/:id` | Löschen |
| `POST` | `/automations/:id/run` | Aktionen sofort ausführen (Test) |
| `GET` | `/automations/templates` | Fertige Vorlagen inkl. Vorbelegung |
| `POST` | `/automations/templates/:templateId` | Regel aus einer Vorlage anlegen |

### Vorlagen

`GET /automations/templates` liefert die Vorlagen bereits auf den vorhandenen
Gerätebestand angepasst:

```json
{
  "templates": [{
    "id": "motion-light", "emoji": "🚶",
    "name": "Licht an, wenn sich jemand bewegt",
    "summary": "Wenn der Bewegungsmelder auslöst, geht das Licht an.",
    "explanation": "Praktisch für Flur, Keller oder Bad. …",
    "fields": [ { "key": "sensor", "label": "Bewegungsmelder", "type": "device",
                  "capability": "sensor.motion", "help": "Das Gerät, das die Bewegung meldet." } ],
    "applicable": true,
    "missing": [],
    "defaults": { "sensor": "dev_…", "lights": ["dev_…"], "cooldownMinutes": 5 },
    "options": { "sensor": [ { "id": "dev_…", "label": "Melder Flur (Flur)" } ] }
  }],
  "applicable": 6
}
```

Sensor und Aktor werden nach Möglichkeit aus demselben Raum gepaart. Ist
`applicable` false, nennt `missing` in Alltagssprache, was fehlt.

Zum Anlegen genügt ein leerer Body – dann greifen die Vorgaben:

```bash
curl -X POST localhost:8080/api/automations/templates/motion-light \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
```

Eigene Werte überschreiben einzelne Felder:
`{"values": {"cooldownMinutes": 10, "lights": ["dev_a","dev_b"]}, "name": "Flurlicht"}`

### Auslöser

```json
{ "type": "sensor", "deviceId": "dev_…", "metric": "temperatureC",
  "operator": "<", "value": 19, "forSeconds": 300 }

{ "type": "deviceState", "deviceId": "dev_…", "property": "motion", "equals": true }

{ "type": "schedule", "at": "07:30", "days": [1,2,3,4,5] }

{ "type": "interval", "everyMinutes": 120,
  "from": "08:00", "to": "20:00", "days": [1,2,3,4,5] }
```
`days`: 0 = Sonntag … 6 = Samstag, leer = täglich. Operatoren: `<`, `<=`, `>`,
`>=`, `==`, `!=`.

`interval` wiederholt sich im angegebenen Takt (`everyMinutes`, mindestens 5,
höchstens 1440). `from`/`to` sind optional, müssen aber gemeinsam angegeben
werden; ohne sie läuft die Regel rund um die Uhr. Gemessen wird der Abstand ab
der letzten Ausführung, nicht an festen Uhrzeiten: Nach einem Neustart des Hubs
läuft die Regel einmal sofort und danach im gewünschten Takt. Außerhalb des
Zeitfensters passiert nichts, und beim nächsten Eintritt wird einmal ausgelöst
statt alles Versäumte nachgeholt.

### Bedingungen (alle müssen zutreffen)

```json
{ "type": "timeRange", "from": "22:00", "to": "06:00" }
{ "type": "deviceState", "deviceId": "dev_…", "property": "on", "equals": false }
{ "type": "sensor", "deviceId": "dev_…", "metric": "humidity", "operator": ">", "value": 60 }
```
`from > to` bedeutet „über Mitternacht“.

### Aktionen

```json
{ "type": "command", "target": { "roomIds": ["room_…"] },
  "command": { "type": "setPower", "on": true } }
{ "type": "webhook", "url": "https://…", "method": "POST", "body": { } }
{ "type": "notify", "message": "Fenster im Bad noch offen" }
```

`cooldownSeconds` verhindert zu häufiges Auslösen. Sensorregeln sind
flankengesteuert: sie feuern einmal pro erfüllter Episode.
