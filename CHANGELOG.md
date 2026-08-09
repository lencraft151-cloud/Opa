# Änderungen

Was sich von Fassung zu Fassung getan hat. Der Hub liest diese Datei selbst
und zeigt den Abschnitt der neuen Fassung an, bevor er sie installiert – man
soll wissen, worauf man sich einlässt.

Das Format ist bewusst schlicht: eine Überschrift `## <Version> – <Datum>`,
darunter Absätze und Listen. Nichts davon wird ausgewertet außer der Version
in der Überschrift.

## 1.3.0 – 2026-08-09

**FRITZ!Box (experimentell).** Vierte Integration: DECT-Schaltsteckdosen mit
Verbrauchsmessung, Heizkörperregler, Lampen mit Farbe und Weißton sowie
Rollläden über HAN-FUN. Anmeldung per Challenge-Response in beiden Verfahren
(PBKDF2 ab FRITZ!OS 7.24, davor MD5 in UTF-16LE).

**Lichtvorschau.** Beim Verstellen zeigt die Gerätekarte sofort, wie das Licht
aussehen wird – Farbe und Helligkeit als Schein hinter der Karte. Schließt die
ein bis zwei Sekunden zwischen „Regler bewegen" und „Lampe reagiert".
Abschaltbar unter Einstellungen → Darstellung.

**Kein Gerät geht mehr verloren.** Ein Kanal, dessen Typ der Hub nicht kennt,
verschwand bisher wortlos. Jetzt wird er aus seinen Werten erkannt: Ein Kanal
mit Niveau und Fahrtrichtung ist ein Rollladen, egal wie sein Typ heißt. Was
trotzdem übrig bleibt, steht in der Diagnose mit Begründung – und der Gerätetyp
lässt sich von Hand richtigstellen.

**Erneut verbinden.** Zugangsdaten erneuern oder den Knopf an der Hue Bridge
noch einmal drücken, ohne Geräte, Räume und Automationen zu verlieren.

**Sicherung.** Einstellungen, Räume, Szenen und Automationen als Datei sichern
und zurückspielen.

**Diese Übersicht.** Der Hub prüft, ob eine neuere Fassung vorliegt, und zeigt
die Änderungen an, bevor er sie installiert. Fehlt die Arbeitskopie – etwa weil
der Hub aus einem entpackten Archiv läuft –, holt er sie sich beim ersten Mal
selbst. Datenbank, Messwerte, `.env` und `node_modules` bleiben dabei liegen:
Git fasst nur an, was es selbst führt.

**Behoben:** Die Aktualisierung verweigerte sich auf jeder gewöhnlichen
Installation. Sie wertete jede Zeile von `git status` als Hindernis – auch die
unverfolgten Verzeichnisse `data/`, `node_modules/` und `.env`, die ein
`git pull` gar nicht anfasst. Jetzt zählen nur geänderte verfolgte Dateien, und
die Meldung nennt sie beim Namen.

## 1.2.0 – 2026-08-08

**Anmeldung mit Name und Passwort.** Das Zugriffstoken war für Menschen der
falsche Schlüssel: einmal angezeigt, nicht zu merken, nicht zu ändern. Jetzt
gibt es Benutzerkonten mit Rollen, Sitzungen als HttpOnly-Cookie und eine
Sperre nach fünf Fehlversuchen. Token bleiben für Skripte.

**Szenen.** Den jetzigen Zustand sichern und mit einem Tipp wiederherstellen –
Licht, Farbe, Rollläden, Heizung.

**Urlaubsmodus.** Im gewählten Zeitfenster gehen unregelmäßig Lichter an und
aus, damit die Wohnung bewohnt wirkt.

**Behoben:** HmIP-Rollläden wurden gar nicht erkannt (sie melden sich als
`SHUTTER_VIRTUAL_RECEIVER`, nicht als `BLIND`); ein Shelly 2.5 im
Rollladenmodus bot seine Motorrelais als Schalter an; die Oberfläche baute
alle 15 Sekunden die ganze Ansicht neu auf und riss dabei halb ausgefüllte
Formulare weg.

## 1.1.0 – 2026-08-08

**Heizungen** als eigene Gerätegattung mit Solltemperatur, gemessener
Temperatur und Ventilstellung.

**Homematic.** CCU2, CCU3 und RaspberryMatic über die JSON-API.

**Alte Geräte.** Die runde Hue Bridge von 2012 (API v1), Shelly der ersten
Generation samt Heizkörperventil, Homematic BidCos neben HmIP.

**Automationen mit Wiederholungen**, Firmware-Übersicht über alle Geräte,
anpassbare Darstellung (Schriftgröße, Akzentfarben, hell/dunkel), und eine
Oberfläche, die sich nach einem Update selbst neu lädt.

## 1.0.0 – 2026-08-07

Erste Fassung: Philips Hue und Shelly unter einer Oberfläche, mit
Einrichtungsassistent, Räumen, Automationen, Messwertarchiv, Rollladensteuerung,
Stromverbrauchsrechnung und Farbrad.
