# Änderungen

Was sich von Fassung zu Fassung getan hat. Der Hub liest diese Datei selbst
und zeigt den Abschnitt der neuen Fassung an, bevor er sie installiert – man
soll wissen, worauf man sich einlässt.

Das Format ist bewusst schlicht: eine Überschrift `## <Version> – <Datum>`,
darunter Absätze und Listen. Nichts davon wird ausgewertet außer der Version
in der Überschrift.

## 1.3.2 – 2026-08-09

**Die Netzwerksuche dauerte lange und sah aus, als hinge sie.** Beides ist
behoben, und zwar getrennt voneinander.

*Schneller:* Beim gründlichen Suchen klopfte jeder der vier Hersteller dasselbe
Subnetz einzeln mit einer HTTP-Anfrage ab – vier mal 254 Adressen, gemessene
**54 Sekunden**. Jetzt stellt der Hub einmal per TCP-Verbindungsversuch fest,
welche Adressen überhaupt belegt sind, und gibt die Liste allen Herstellern:
**5,9 Sekunden**. Eine mDNS-Suche hört außerdem auf zu warten, sobald die
Antwortwelle abgeebbt ist – lief vorher immer die vollen fünf Sekunden aus.
Meldet sich niemand, wird weiterhin voll gewartet: Ein schlafender
Batteriesensor darf sich auch spät noch melden.

*Sichtbar:* Der Rest der Wartezeit lässt sich nicht wegoptimieren – er lässt
sich aber zeigen. Jeder Treffer erscheint jetzt sofort, statt am Ende
gesammelt; darunter läuft eine Uhr und steht, auf welchen Hersteller noch
gewartet wird. Und es gibt einen Abbrechen-Knopf. Ein Kasten, in dem fünf
Sekunden lang nichts passiert, sieht aus wie ein Fehler – genau so wurde es
auch gemeldet.

## 1.3.1 – 2026-08-09

**Behoben: Der Hub konnte sich beim Einrichten selbst aussperren.** Wurde das
Passwort abgelehnt – etwa weil es den Anmeldenamen enthielt –, war der Haushalt
trotzdem schon angelegt, ein Zugang aber nicht. Ab da verlangte der Hub eine
Anmeldung, für die es kein Konto gab; jeder weitere Versuch endete in „Nicht
angemeldet". Jetzt wird das Passwort geprüft, bevor irgendetwas entsteht, und
ein Haushalt ohne Zugang lässt sich weiterhin einrichten. Bestehende
Datenstände in diesem Zustand retten sich beim nächsten Aufruf selbst.

**Behoben: Nach der Anmeldung landete man im Dashboard, obwohl die Einrichtung
unfertig war** – ohne Weg zurück in den Assistenten. Jetzt entscheidet der
Stand der Einrichtung, wohin es geht.

**Behoben: Drei einander widersprechende Meldungen auf der Anmeldemaske.** Der
Assistent startete, ohne zu prüfen, ob überhaupt jemand angemeldet ist; seine
erste Anfrage lief in einen Fehler, der die Maske öffnete – mitsamt „Die
Anmeldung ist abgelaufen", obwohl es nie eine gab.

**Behoben: „Winterabend-77" war als Passwort für „ben" nicht erlaubt.** Der
Name steckt in „WinterABENd" – dem Angreifer sagt das nichts, dem Bewohner
schon: Er suchte ratlos nach einem Passwort, das angenommen wird. Geprüft wird
jetzt der Name als Baustein (am Anfang, am Ende, bei längeren Namen auch
mittendrin), nicht als zufällige Buchstabenfolge.

**Haushalt löschen.** Unter Einstellungen, hinter fünf Bestätigungen – die
allerdings nicht fünfmal dasselbe fragen, sondern jeweils etwas anderes nennen,
das gleich verschwindet, mit den tatsächlichen Zahlen dieses Haushalts. Der
letzte Schritt lässt sich nicht wegklicken: Dort muss der Name des Haushalts
abgetippt werden.

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
