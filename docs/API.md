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
{ "error": { "code": "bad_request", "message": "…", "details": [ … ] } }
```

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
{ "name": "Wohnung Musterstraße", "timezone": "Europe/Berlin", "locale": "de-DE" }
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
| `PATCH` | `/household` | `name`, `timezone`, `locale` ändern |
| `GET` | `/household/summary` | Kennzahlen fürs Dashboard |
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
| Identifizieren | `{"type":"identify"}` | – |

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
