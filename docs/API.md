# API-Referenz

Basis-URL: `http://<host>:8080/api`

## Authentifizierung

Alle Endpunkte außer `/health`, `/system/info` und `/setup/state` verlangen ein
Zugriffstoken:

```
Authorization: Bearer sh_…
```

Alternativ `X-Access-Token: sh_…` oder – nur für `EventSource`, das keine Header
setzen kann – `?access_token=sh_…`.

Solange noch kein Haushalt existiert, ist die API offen. Das erste Token entsteht
beim Anlegen des Haushalts und wird **einmalig** zurückgegeben.

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
Ohne Token. Version, Node-Version, verfügbare Adapter, aktive Einstellungen.

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
```json
{ "name": "Wohnung Musterstraße", "timezone": "Europe/Berlin", "locale": "de-DE",
  "pricePerKwh": 0.35, "currency": "EUR", "basePricePerMonth": 12.9 }
```
→ `201` mit `{ household, state, accessToken }`. **Das Token wird nur hier
ausgegeben.** Ein zweiter Haushalt wird mit `409` abgelehnt.

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
| `PATCH` | `/household` | `name`, `timezone`, `locale`, `pricePerKwh`, `currency`, `basePricePerMonth`, `autoUpdate`, `autoUpdateFrom`, `autoUpdateTo` |
| `GET` | `/household/summary` | Kennzahlen fürs Dashboard inkl. gestörter Integrationen |
| `GET` | `/household/tokens` | Tokens (ohne Hash) |
| `POST` | `/household/tokens` | `{ "name": "Handy" }` → neues Token |
| `DELETE` | `/household/tokens/:id` | Token widerrufen (das letzte nicht) |

---

## Integrationen

### `GET /integrations/discover?type=hue|shelly&scan=true`
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
| Identifizieren | `{"type":"identify"}` | – |

Bei Rollläden gilt **100 = ganz offen, 0 = ganz zu**. Der Zustand enthält
zusätzlich `coverState` (`open`, `closed`, `opening`, `closing`, `stopped`) –
darauf beruht die Bewegungsanzeige in der Oberfläche.

`setBrightness` mit `0` schaltet aus; alle anderen Helligkeits-, Farb- und
Farbtemperatur-Kommandos schalten das Gerät automatisch ein.

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
  "updatesAvailable": 1,
  "autoUpdate": { "enabled": false, "from": "03:00", "to": "05:00", "timezone": "Europe/Berlin" },
  "lastCheckedAt": "…"
}
```

Die automatische Installation wird über `PATCH /household` gesteuert
(`autoUpdate`, `autoUpdateFrom`, `autoUpdateTo`). Sie greift nur innerhalb des
Zeitfensters; das Gerät startet dabei neu.

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

### Auslöser

```json
{ "type": "sensor", "deviceId": "dev_…", "metric": "temperatureC",
  "operator": "<", "value": 19, "forSeconds": 300 }

{ "type": "deviceState", "deviceId": "dev_…", "property": "motion", "equals": true }

{ "type": "schedule", "at": "07:30", "days": [1,2,3,4,5] }
```
`days`: 0 = Sonntag … 6 = Samstag, leer = täglich. Operatoren: `<`, `<=`, `>`,
`>=`, `==`, `!=`.

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
