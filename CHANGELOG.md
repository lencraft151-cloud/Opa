# Änderungen

Was sich von Fassung zu Fassung getan hat. Der Hub liest diese Datei selbst
und zeigt den Abschnitt der neuen Fassung an, bevor er sie installiert – man
soll wissen, worauf man sich einlässt.

Das Format ist bewusst schlicht: eine Überschrift `## <Version> – <Datum>`,
darunter Absätze und Listen. Nichts davon wird ausgewertet außer der Version
in der Überschrift.

## 1.12.1 – 2026-08-10

**Das Aktualisieren zog den falschen Zweig – und warf den Hub damit auf einen
älteren Stand zurück.** Ohne gesetztes `HUB_BRANCH` holte der Hub fest
`main`. Wer seine Installation von einem anderen Zweig aufgesetzt und dann
„aktualisieren" gedrückt hat, bekam deshalb kein Update, sondern einen
Zweigwechsel – und hinterher sah es aus, als sei die halbe Anwendung
verschwunden.

Drei Änderungen:

- **Ohne Angabe wird der eigene Zweig fortgeschrieben.** Der Hub liest, auf
  welchem Zweig seine Arbeitskopie steht, und zieht diesen. `main` bleibt die
  Vorgabe nur dort, wo es gar keine Arbeitskopie gibt. Eine ausdrückliche
  Angabe in `HUB_BRANCH` gewinnt weiterhin – wer den Zweig selbst setzt, weiß,
  was er tut.
- **Unter Einstellungen → Diese Fassung steht jetzt, worauf man läuft:** Zweig
  und Commit, neben Fassung und Node-Version. Ohne diese Angabe war „warum ist
  alles weg?" nicht zu beantworten.
- **Und eine Warnung, bevor es passiert:** Zeigt der eingestellte Zweig
  woandershin als die Arbeitskopie, sagt der Hub das deutlich, statt es
  stillschweigend zu tun.

## 1.12.0 – 2026-08-10

**Der Hub sagt Bescheid, wenn eine neue Fassung da ist.** Bisher musste man
danach fragen: Einstellungen aufschlagen, „Jetzt nachsehen" drücken. Wer das
nicht tat, lief womöglich monatelang auf einem alten Stand.

Jetzt sieht der Hub von selbst nach – eine Minute nach dem Start und danach
einmal am Tag. Findet er etwas, blendet er es ein: mit der Fassungsnummer,
der eigenen zum Vergleich und dem ersten Satz aus dem Änderungsprotokoll,
damit die eigentliche Frage beantwortet ist – ob es sich lohnt. Ein Klick
auf die Meldung führt dorthin, wo man sie einspielt.

Drei Feinheiten, die den Unterschied machen:

- **Sie bleibt stehen.** Andere Einblendungen verschwinden nach acht
  Sekunden; diese wartet, bis man sie wegklickt. Wer nicht davorsitzt, soll
  sie nicht verpassen.
- **Sie kommt einmal.** Dieselbe Fassung wird nicht täglich neu angepriesen –
  eine Meldung, die man dreimal weggeklickt hat, liest niemand mehr.
- **Ein Punkt bleibt am Reiter „Einstellungen".** Auch wenn die Einblendung
  weg ist und auch nach einem Neuladen der Seite.

Und die Grundregel bleibt: **Ohne eingestellte Prüfadresse
(`HUB_UPDATE_CHECK_URL`) telefoniert der Hub gar nicht erst nach draußen.**
Wer das nicht will, bekommt keine Prüfung – und keine Meldung.

**Räume und Geräte sind jetzt wirklich eine Ansicht.** In 1.10.0 waren sie
ein Reiter mit zwei Unterreitern – also immer noch zwei Seiten, zwei
Suchfelder, zwei Filter. Dabei ist „Räume" keine andere Sache als „Geräte":
Es ist dieselbe Liste, nur gruppiert.

Jetzt gibt es **eine** Werkzeugleiste, die für beides gilt:

- **Eine Suche für alles.** Sie greift auf Gerätenamen, **Raumnamen**,
  Hersteller und Modell. Wer „Wohnzimmer" tippt, bekommt die Geräte des
  Wohnzimmers; wer „shelly" tippt, alle Shellys – auch die, die nicht so
  heißen. Mit `/` springt man von überall in das Feld.
- **Räume oder Liste** ist ein Umschalter in dieser Leiste, keine zweite
  Seite: gruppiert mit Raumkopf, Klimawerten und „alles an/aus" – oder alles
  am Stück.
- **Filter für Raum und Fähigkeit**, dazu **Sortierung** nach Raum, Name,
  Verbrauch oder zuletzt gesehen.
- **Schnellfilter** für die Fragen, die man wirklich stellt: ⭐ Favoriten,
  💡 An, 🌙 Aus, 🚪 Ohne Raum, ⚠️ Offline.
- **Eine Zeile sagt, was gerade zu sehen ist** („3 Geräte von 30 · 2 an") –
  und daneben steht der Weg zurück zu allem.

**Neu dabei: Favoriten.** Von dreißig Geräten bedient man täglich vier. Ein
Klick auf den Stern heftet eines an; angeheftete Geräte stehen immer oben,
egal wie sortiert wird. Die Anheftung überlebt Umbenennen, Neustarts und
erneute Geräteabfragen.

**Und Sammelaktionen.** Jede Kachel hat ein Häkchen; sobald etwas ausgewählt
ist, erscheint eine Leiste, die beim Scrollen oben stehen bleibt: **alle an,
alle aus, in einen Raum verschieben, anheften, ausblenden**. Wer zwölf
Lampen umräumt, klickt nicht mehr zwölfmal durch Einzelformulare.

Nachgeprüft, nicht nur behauptet: Im Browser steht eine Suchleiste statt
zwei, es gibt keine Unterreiter mehr, die Suche nach einem Raumnamen und
nach „shelly" findet jeweils das Richtige, `/` setzt den Fokus in das Feld,
der Stern schaltet die Anheftung am Server um, zwei ausgewählte Geräte
wandern mit einem Griff in einen Raum – und die Update-Einblendung erschien
mit „Fassung 9.9.9 ist da – du hast 1.12.0", samt Punkt an den Einstellungen
und Sprung dorthin beim Anklicken.

## 1.11.0 – 2026-08-10

**Sonos zeigt Playlists, Radiosender und Favoriten.** Bisher konnte der Hub
steuern, was gerade lief – anfangen konnte er nichts. Unter Dienste → Sonos
steht jetzt, was in der Sonos-App gespeichert ist: Wiedergabelisten, „Meine
Radiosender" und alles mit dem Herz-Symbol. Ein Klick legt es auf dem
gewählten Lautsprecher auf; in einer Gruppe für die ganze Gruppe.

Dahinter stecken zwei verschiedene Wege, und sie zu verwechseln ist der
übliche Fehler: Eine **Playlist** wird nicht abgespielt, sondern in die
Warteschlange gelegt – erst danach schaltet der Lautsprecher auf ebendiese
Warteschlange um. Ein **Radiosender** wird unmittelbar aufgelegt; eine
Warteschlange gäbe es dafür gar nicht, ein Sender hat keinen nächsten Titel.
Und ein **Favorit** sieht aus wie ein einzelnes Stück, ist aber oft eine
ganze Playlist eines Musikdienstes – erkennbar nur an seiner Adresse.

**Spotifys Oberfläche ist eingebettet.** Unter Dienste → Spotify steht
Spotifys eigener Player mit Titelbild und Titelliste, und zwar für die
Quelle, aus der gerade gespielt wird – die Playlist oder das Album, nicht
nur den einen Titel.

Ehrlich dazugesagt: Der **volle** Web-Player von `open.spotify.com` lässt
sich nicht einbetten. Spotify verbietet es ausdrücklich; ein Rahmen darum
bliebe leer. Eingebettet ist deshalb Spotifys offizieller
Einbettungs-Player, der genau dafür gemacht ist. Wer den vollen Player
will, kommt mit einem Knopf darunter hin.

**Die FRITZ!Box wird jetzt mit ihrer Adresse verbunden, nicht mit ihrem
Namen.** Die Suche klopft mehrere Adressen an – `fritz.box`, AVMs
Werksadresse, den tatsächlichen Router. Antworten mehrere, ist es fast
immer dieselbe Box. Zusammengefasst wurde bisher nach der Faustregel „ein
Name schlägt jede IP", und das ging zweifach schief:

- Im Eintrag stand danach `fritz.box`, und unter diesem Namen versuchte der
  Hub sich anzumelden. Der Name muss dafür im Netz auflösbar sein – im
  Container mit eigenem DNS, hinter einem VPN oder an einem Router, der die
  Namensauflösung nicht anbietet, ist er das nicht. Die Box stand in der
  Trefferliste und ließ sich trotzdem nicht verbinden.
- Stand ein *zweiter* Router im Netz, verschwand er ganz – seine Adresse
  fiel weg, weil irgendwo schon ein Name in der Liste stand.

Beides behebt dieselbe Änderung: Zusammengefasst wird nach der aufgelösten
**Adresse**, und mit ihr wird auch verbunden. Der Name bleibt daneben
sichtbar, damit man die Box wiedererkennt. Antworten, die ins Internet
zeigen, werden verworfen – sonst könnte ein Provider-DNS, das unbekannte
Namen auf eine eigene Seite auflöst, das FRITZ!Box-Kennwort dorthin lenken.

**Geräte ohne Raum lassen sich an Ort und Stelle geraderücken.** Ein frisch
gefundenes Gerät heißt „Shelly 1PM 34AB9F", steckt in keinem Raum, gilt als
Schalter und ist in Wahrheit der Rollladen im Bad. Die vier Handgriffe
dagegen lagen an vier verschiedenen Stellen der Oberfläche.

Jetzt stehen sie beieinander: **Name ändern, Raum wählen, Gruppe
richtigstellen, Gerät entfernen** – unter „Ohne Raum" offen sichtbar, denn
wer dort landet, will genau das erledigen. Wer nur einen Raum angelegt hat,
bekommt einen Knopf statt einer Auswahlliste mit einem Eintrag. Und für
jedes andere Gerät sitzt derselbe Bogen unter „Alle Geräte" hinter einem
Aufklapper, damit sich auch später Raum, Name oder Gruppe ändern lassen.
Sensorfähigkeiten bleiben bei einer Richtigstellung erhalten: Ein Shelly,
der als Rollladen gilt, misst weiterhin Strom.

Nachgeprüft, nicht nur behauptet: Gegen einen nachgebauten Lautsprecher
erscheinen alle drei Listen mit Anzahl; eine Playlist kommt als
`RemoveAllTracksFromQueue → AddURIToQueue → SetAVTransportURI → Play` an
und schaltet auf `x-rincon-queue:…` um, ein Radiosender wird direkt
aufgelegt und rührt die Warteschlange nicht an. Ein Gerät wurde im Browser
umbenannt, einem Raum zugewiesen, als dimmbares Licht richtiggestellt
(Verbrauchsmessung blieb erhalten) und anschließend entfernt.

## 1.10.0 – 2026-08-10

**Räume und Geräte sind jetzt ein Reiter.** Die Trennung war künstlich: Wer
ein Gerät suchte, wusste selten, ob es schon in einem Raum steckt, und
klickte zwischen beiden Ansichten hin und her. Unter **„Räume & Geräte"**
liegen sie nebeneinander – „🛋️ Nach Räumen" und „🔌 Alle Geräte" als
Unterreiter, mit der Anzahl gleich daneben. Die Hauptleiste wird dadurch um
einen Eintrag kürzer.

**Ein Einrichtungsschritt „Nach Gruppen sortieren".** Nach dem Zuordnen
kommt jetzt eine Ansicht, die alle Geräte nach Gattung bündelt: Licht,
Rollläden, Heizung, Schalter und Steckdosen, Sensoren. Eine ganze Gruppe
lässt sich mit einem Griff einem Raum zuweisen oder ausblenden – wer zwölf
Lampen hat, klickt nicht mehr zwölfmal. Der Schritt ist ein Angebot, keine
Pflicht: Wer vorher schon alles zugeordnet hat, klickt weiter.

**„Gründlich durchsuchen" findet beim ersten Mal, was da ist.** Bisher
musste man den Suchlauf gelegentlich vier-, fünfmal starten, bis alle Geräte
auftauchten – und jeder Durchgang fing bei null an, sodass Fundstücke des
vorigen wieder verschwanden. Drei Ursachen, drei Änderungen:

- **Ein zweiter, geduldiger Durchgang.** Die Netzsuche klopft jede Adresse
  mit 400 ms ab. Das genügt einem Gerät am Kabel mühelos – ein Shelly im
  WLAN, der gerade aus dem Stromsparmodus kommt, braucht gelegentlich das
  Dreifache und fehlte dann. Jetzt werden alle Adressen, die geschwiegen
  haben, ein zweites Mal mit deutlich mehr Zeit gefragt. Das kostet nichts
  für Adressen, hinter denen ohnehin niemand ist.
- **Mehr Zeit für Bridges und Lautsprecher.** Beim gründlichen Suchlauf
  bekommen mDNS und SSDP – über die sich Hue Bridge und Sonos melden – die
  doppelte Frist, mindestens acht Sekunden.
- **Die Liste wächst, statt neu anzufangen.** Was ein Durchgang gefunden
  hat, bleibt sichtbar, wenn der nächste startet. Zweimal suchen addiert
  sich jetzt, statt sich zu ersetzen.

**Nichts geht mehr verloren, wenn die Oberfläche neu lädt.** Was man
eintippt, wird sofort mitgeschrieben und nach dem Neuladen wieder eingesetzt
– ein halb ausgefüllter Raumname, eine angefangene Automation, eine
Box-Adresse. **Kennwörter, App-Passwörter und Token ausdrücklich nicht:** Ein
Formular, das man einmal neu ausfüllt, ist besser als ein Kennwort, das im
Browser liegen bleibt. Gerätezustände – ein Helligkeitsregler etwa – bleiben
ebenfalls unangetastet; sie zeigen, was die Lampe *tut*.

Dazu merkt die Oberfläche eine neue Fassung schneller: Sie sieht alle zwei
Minuten statt alle zehn nach, und vor allem sofort, wenn der Ereignisstrom
nach einem Neustart des Hubs wieder steht. Genau dann ist fast immer eine
neue Fassung da – vorher stand die alte Oberfläche bis zu zehn Minuten vor
einem Server, der schon etwas anderes ausliefert.

**Und die Daten bleiben, auch wenn der Ordner ganz weg ist.** Was 1.9.0
begonnen hat, ist jetzt für den härtesten Fall nachgeprüft: Projektordner
gelöscht, frisch von GitHub geklont, neu gebaut, gestartet – derselbe
Haushalt, dieselben Räume, dieselben Zugangsdaten.

Nachgeprüft, nicht nur behauptet: Der Einrichtungsassistent zeigt sechs
Schritte, die Gruppenansicht ordnet zwei Geräte mit einem Griff zu, die
Unterreiter zählen richtig, und „Wintergarten" sowie „http://fritz.box"
stehen nach einem Neuladen wieder im Formular – während im Entwurfsspeicher
kein Kennwort auftaucht.

## 1.9.0 – 2026-08-10

**Deine Einrichtung überlebt jede Aktualisierung.** Datenbank, Messwerte und
der Verschlüsselungsschlüssel liegen jetzt in einem Ordner **außerhalb** des
Programmordners – unter Linux `~/.local/share/smarthome-hub`, unter macOS in
`~/Library/Application Support`, unter Windows in `%APPDATA%`.

Vorher lag beides im Projektordner: die Daten in `./data`, der Schlüssel in
der `.env` daneben. Wer sich die neueste Fassung von GitHub holte und den
Ordner dabei austauschte, stand danach wieder vor dem
Einrichtungsassistenten – oder, schlimmer, vor einer Datenbank, deren
Zugangsdaten sich ohne den alten Schlüssel nicht mehr entschlüsseln ließen.

Drei Dinge machen das jetzt aus:

- **Der Ort.** Ohne `DATA_DIR` wählt der Hub den üblichen Datenordner des
  Systems. Wer den Ort selbst bestimmt hat – Docker-Volume, eigene Platte –,
  wird nicht umgezogen: Eine ausdrückliche Angabe gewinnt immer.
- **Der Umzug.** Liegt noch ein alter `./data`-Bestand im Projektordner und am
  neuen Ort nichts, wandert er beim ersten Start einmalig um – mitsamt
  Messwertarchiv. Liegt an beiden Orten etwas, wird **nichts** angefasst;
  einen echten Bestand mit einem vergessenen Rest zu überschreiben wäre nicht
  rückgängig zu machen. Scheitert der Umzug, läuft der Hub am alten Ort weiter
  und sagt, was zu tun ist.
- **Der Schlüssel.** `SECRET_KEY` muss nicht mehr gesetzt werden: Der Hub legt
  beim ersten Start selbst einen an und bewahrt ihn als `secret.key` **im
  Datenordner** auf – also dort, wo auch die Daten liegen, die er schützt. Ein
  Schlüssel aus der Umgebung hat weiterhin Vorrang und wird zusätzlich dorthin
  gerettet, damit er auch dann noch da ist, wenn die `.env` einmal fehlt.

Unter Einstellungen steht jetzt **„Wo deine Daten liegen"** mit dem Pfad und
der Auskunft, ob er außerhalb des Programmordners liegt. Das ist die eine
Angabe, die man zum Sichern und Umziehen braucht – und die man sonst erst
beim nächsten Update vermisst.

Nachgeprüft, nicht nur behauptet: Hub aufgesetzt, Haushalt und Nextcloud-Konto
angelegt, den Projektordner **weggeworfen** und neu ausgepackt – ohne `.env`.
Danach: derselbe Haushalt, Anmeldung mit demselben Passwort, und der
Nextcloud-Abruf lief durch. Der braucht das entschlüsselte App-Passwort; er
ist damit der Beleg, dass auch die Zugangsdaten den Wechsel überstanden haben.

## 1.8.0 – 2026-08-09

**Ein Wiki im Hub.** Zwölf Artikel, durchsuchbar, mit Verweisen aus der
Oberfläche heraus: Erste Schritte, Geräte verbinden, je ein Artikel zu Hue,
Shelly, FRITZ!Box und Homematic, dazu Dienste, Räume und Szenen,
Automationen, Auswertung, Sicherung – und „Wenn etwas klemmt".

Warum die Erklärungen *im* Programm stehen und nicht in einer Datei daneben:
Wer vor einem Kasten steht, in dem „Anmeldung abgelehnt" steht, schlägt nicht
in einer README nach. Er sucht dort, wo er gerade ist. Deshalb führen aus den
Ansichten heraus Verweise direkt in den passenden Artikel – ein Klick, kein
Satz „siehe Dokumentation".

**„Dienste" hat jetzt Unterreiter:** Sonos, Spotify, Nextcloud – und
FRITZ!Box, sobald eine verbunden ist. Vorher standen alle Karten untereinander
auf einer langen Seite; jetzt sieht man eine Sache auf einmal.

**Der FRITZ!Box-Reiter zeigt, was die Box tut.** Verbindungszustand mit
„Verbindung prüfen" und „Geräte neu einlesen", darunter alle Geräte, die per
DECT an ihr hängen – mit voller Steuerung, zusammen an einem Ort statt
verstreut zwischen Hue und Shelly. Ganz unten die Oberfläche der Box selbst.

**Erklärungen und Hinweise beim Überfahren.** Jede Karte hat einen Satz, der
sagt, worum es geht, und an den erklärungsbedürftigen Stellen sitzt ein
Fragezeichen mit dem Rest. Es reagiert auf Maus *und* Tastatur – der
Browser-Tooltip lässt eine Sekunde verstreichen und ist ohne Maus gar nicht
erreichbar; wer unsicher ist, hat da schon weitergeklickt.

## 1.7.1 – 2026-08-09

**Sonos wird jetzt überall gesucht.** „Netzwerk durchsuchen" kannte bisher nur
Hue, Shelly, Homematic und die FRITZ!Box – Lautsprecher fand es nie, weil gar
nicht nach ihnen gesucht wurde. Sonos sucht jetzt mit und meldet seine Treffer
in derselben Liste; übernommen wird ein Lautsprecher mit demselben Knopf wie
eine Bridge, nur ohne Passwortfrage. Auch die Auswahl unter „Von Hand
eintragen" kennt Sonos jetzt.

Kommt Multicast im Netz nicht durch – in Containern, hinter Repeatern, in
manchen Router-Konfigurationen –, klopft der Hub zusätzlich Port 1400 ab.
Bereits übernommene Lautsprecher werden immer mitgefragt und stehen als
„bereits verbunden" in der Liste, statt zu fehlen. Und wer unter zwei Adressen
antwortet, wird einmal gezählt: „2 Lautsprecher gefunden" für einen einzigen
war schlicht falsch.

**„Mit allen verbinden".** Sind mehrere Geräte gefunden, die kein Passwort
brauchen, gibt es einen Knopf, der sie alle auf einmal übernimmt. Geschützte
Geräte bleiben bewusst außen vor – ein Sammelknopf, der fünfmal nacheinander
nach Kennwörtern fragt, ist keiner. Am Ende steht, was geklappt hat und was
nicht; bei einer Hue Bridge hängt das daran, ob jemand rechtzeitig den Knopf
gedrückt hat, und ein stilles „fertig" wäre dort gelogen.

**Die FRITZ!Box nimmt das Kennwort jetzt an.** Der Grund für „geht nie" war
der Benutzername: Auch eine Box mit „Anmeldung nur mit Kennwort" hat intern
einen – sie hat ihn selbst angelegt und nennt ihn etwa `fritz3000`. Wer nichts
eintrug, schickte eine **leere** Kennung, und die weist die Box ab: richtiges
Kennwort, falscher Benutzer. Den richtigen Namen nennt die Box in derselben
Antwort, in der auch die Anmeldeaufgabe steht – der Hub liest ihn dort und
verwendet ihn.

Der zweite Stolperstein war die Berechtigung. Ohne das Recht „Smart-Home-Geräte
und Automatisierung steuern" bleibt die Schnittstelle zu, und bisher kam das
als nackter HTTP 403 zurück – ein Fehler, aus dem niemand auf ein fehlendes
Häkchen schließt. Jetzt steht es im Klartext, mitsamt dem Weg dorthin. Sind
mehrere Benutzer angelegt, nennt die Fehlermeldung sie beim Namen.

Das „experimentell" ist damit weg.

**Und wenn es trotzdem klemmt:** Unter *Einstellungen → FRITZ!Box-Oberfläche*
lässt sich die Adresse der Box eintragen; der Hub zeigt ihre Oberfläche dann
direkt an. Ob sich die Seite einbetten lässt, entscheidet die Box (viele
verbieten es) – der Knopf „In neuem Fenster öffnen" daneben geht immer.

## 1.7.0 – 2026-08-09

**Sonos und Spotify – im eigenen Reiter „Dienste".** Dort stehen jetzt die
Dinge, die kein Gerät sind: Lautsprecher, Musik und die Nextcloud, die aus den
Einstellungen dorthin umgezogen ist. Bei einer Lampe gibt es an, aus und eine
Helligkeit; bei einem Lautsprecher einen Titel, eine Warteschlange und eine
Gruppe. Beides in dieselbe Kachel zu pressen hätte beiden geschadet.

**Sonos** findet der Hub selbst (SSDP, sonst Port 1400 im Subnetz, sonst von
Hand eingetragen) und braucht dafür kein Konto – Sonos spricht UPnP im eigenen
Netz. Angezeigt werden Titel, Interpret, Titelbild und Lautstärke, bedienbar
sind Play, Pause, vor, zurück und die Lautstärke.

Ein Detail, an dem eine Sonos-Steuerung sonst scheitert: **Gruppen.** Sind zwei
Lautsprecher zusammengefasst, nimmt nur der Koordinator Play und Pause an – der
andere antwortet mit Fehler 701. Wer „Küche" drückt, während die Küche im
Wohnzimmer-Verbund hängt, dessen Befehl geht deshalb ans Wohnzimmer. Die
Lautstärke bleibt beim einzelnen Lautsprecher, denn dort will man sie auch
einzeln haben.

**Spotify** meldet sich mit Authorization Code + **PKCE** an: Der Hub braucht
nur die Client-ID, kein Client-Geheimnis. Ein Geheimnis, das bei jedem Nutzer
derselben Anwendung auf der Platte liegt, ist keines. Angezeigt wird, was
gerade läuft; steuern erlaubt Spotify nur mit Premium – das ist deren Regel,
der Hub sagt es nur deutlich, statt einen 403 durchzureichen.

**Die Seite blitzt nicht mehr im Abfragetakt.** Nach jeder Geräteabfrage wurde
bisher die ganze Ansicht neu geschrieben – auch wenn kein einziger Wert anders
war. Zwei Dinge gingen dabei kaputt: angefangene Eingaben verschwanden, und
jede neu eingesetzte Karte startete ihre Einblendung von vorn, die bei
Deckkraft 0 beginnt. Auf hellem Hintergrund sah das aus, als würde die Seite
kurz weiß. Jetzt wird verglichen, bevor geschrieben wird: Ändert sich nichts,
passiert auch nichts. Gemessen bei einem Takt von drei Sekunden: **null
DOM-Änderungen in zwanzig Sekunden** statt sieben vollständiger Neuaufbauten.
Und wenn sich doch etwas ändert, läuft die Einstiegsanimation nicht erneut –
die gehört zum Betreten einer Ansicht, nicht zu einem neuen Messwert.

**Die FRITZ!Box sperrt keine Anmeldeversuche mehr aus.** Eine abgelehnte
Anmeldung wurde bisher im Abfragetakt wiederholt. Genau das erzeugt die Sperre,
die AVM gegen Durchprobieren eingebaut hat – und die dann auch die
Weboberfläche der Box aussperrt. Nach einer Ablehnung wartet der Hub jetzt: die
von der Box genannte Sperrzeit, sonst 30 Sekunden, danach jeweils doppelt so
lang bis zu einer Viertelstunde. Meldet die Box beim Abholen der Anmeldeaufgabe
bereits eine laufende Sperre, wird die Aufgabe gar nicht erst beantwortet.
Ebenfalls berichtigt: Nach einem „Erneut verbinden" mit anderem Kennwort lief
der Hub weiter mit dem alten – die Sitzung wird jetzt verworfen, sobald sich
Adresse, Benutzername oder Kennwort ändern.

**Anfragen an tote Adressen hängen nicht mehr.** `req.setTimeout` in Node wirkt
erst, wenn die Verbindung *steht*. Eine Adresse, an der niemand ist und deren
Pakete stillschweigend verworfen werden – jede unbenutzte IP im Subnetz –, lief
deshalb nicht in den eingestellten Timeout, sondern in den des Betriebssystems:
gut zwei Minuten. Jetzt läuft eine zweite Uhr ab dem Absenden.

## 1.6.0 – 2026-08-09

**Die eigene Nextcloud meldet sich.** Neue Talk-Nachricht, geteilte Datei,
Kalendererinnerung: Der Hub holt die Benachrichtigungen aus der eigenen
Nextcloud und blendet sie ein – auf dem Tablet an der Wand ebenso wie auf dem
Handy. Ein Klick auf „Öffnen" führt zur Sache selbst. Eingerichtet wird das
unter Einstellungen → Nextcloud mit Adresse, Benutzername und einem
**App-Passwort**; das normale Kontopasswort funktioniert bei
Zwei-Faktor-Anmeldung ohnehin nicht und wäre hier auch zu viel des Guten.

Zwei Dinge tut der Hub dabei bewusst nicht: Beim ersten Verbinden meldet er
nichts – sonst poppen alle offenen Benachrichtigungen auf einmal auf. Und
nach einem Neustart fängt er nicht von vorn an: Er merkt sich, was er schon
gezeigt hat.

Die Nextcloud steht dabei nicht bei den Integrationen, sondern in den
Einstellungen. Sie ist kein Gerät – es gibt nichts zu schalten und nichts zu
messen. Sie in dieselbe Liste wie eine Hue Bridge zu stellen, würde beide
Begriffe verwischen.

## 1.5.0 – 2026-08-09

**Markisen, Tore und andere Motoren.** Für den Hub sind sie dasselbe wie ein
Rollladen: ein Antrieb mit Position, „auf", „zu" und einem Prozentwert. Dass
eine Markise waagerecht ausfährt und ein Rollladen senkrecht, ändert daran
nichts. Erkannt werden jetzt `AWNING`, `GARAGE_DOOR`, `WINDOW_DRIVE`, `SCREEN`
und Verwandte – und über die Werte-Erkennung auch alles, was im Modellnamen
„Markise", „Garage" oder „Tor" führt.

**Automationen im Sekundentakt, die von selbst wieder aufhören.** Bisher war
der kürzeste Abstand fünf Minuten, und ein Kommando blieb, bis eine zweite
Regel es zurücknahm. Jetzt gibt es Abstände ab fünf Sekunden und eine Dauer:
„alle 20 Sekunden das Licht für 10 Sekunden an" ist eine Regel, keine zwei.
Zurückgenommen wird nur, wo das Gegenteil eindeutig ist – Ein/Aus, Auf/Zu; für
eine Helligkeit müsste man den vorherigen Wert raten, und das tut der Hub
nicht.

**Energie und Verlauf sind ein Reiter.** Sie beantworten dieselbe Frage aus
zwei Richtungen: „Was war?" Wer den Stromverbrauch ansieht, will meist die
Temperaturkurve daneben. Der Reiter heißt jetzt „Auswertung".

## 1.4.2 – 2026-08-09

**Shelly-Lampen können jetzt Weißtöne.** Die Shelly Duo meldet sich als
Bauteiltyp `cct` – den kannte der Hub gar nicht. Die Lampe war da, ließ sich
aber nur dimmen; warm und kalt blieben unerreichbar. Auch Farblampen (RGBW2,
Bulb) führen einen Weißkanal, der bisher unter den Tisch fiel. Beide bekommen
die Fähigkeit „Weißtöne" samt Regler, und der Befehl geht an das Gerät –
`CCT.Set` bzw. `Light.Set` bei Gen2, `temp` an `/light/N` bei Gen1.

**Die FRITZ!Box braucht keinen Benutzernamen mehr.** Viele Boxen sind auf
„Anmeldung nur mit Passwort" eingestellt; dort gibt es gar keinen Namen
einzutragen. Der Hub verlangte trotzdem einen und die Oberfläche fragte danach
– ein Pflichtfeld, das niemand ausfüllen konnte. Jetzt genügt das Kennwort der
Box-Oberfläche; das Namensfeld bleibt für den Fall, dass unter „System →
FRITZ!Box-Benutzer" mehrere Konten angelegt sind.

## 1.4.1 – 2026-08-09

**Die FRITZ!Box wurde nicht gefunden – und mit ihr keiner ihrer Rollläden.**
Die normale Suche kannte nur `fritz.box` und AVMs Werksadresse
`192.168.178.1`. Wer sein Netz auf `192.168.1.x` umgestellt hat oder einen
Provider-Router betreibt, fand seine Box nie – außer über den gründlichen
Scan. Dabei ist die Antwort einfach: Die FRITZ!Box *ist* in aller Regel der
Router. Der Hub liest jetzt die Standardroute des Systems und fragt sie mit
ab; dazu die üblichen `.1` und `.254` jedes lokalen Netzes und der
mDNS-Dienst `_fritzbox._tcp`, unter dem AVM-Boxen sich melden.

Damit erscheinen auch die Rollläden an der Box – sie waren nie falsch
abgebildet, es fehlte schlicht die Box.

**Shelly-Temperaturfühler verschwanden, wenn der Messwert gerade fehlte.**
Ein abgezogener Add-on-Fühler oder ein noch nicht gemessener Wert ließ das
ganze Gerät aus der Liste fallen. Jetzt bleibt es sichtbar und meldet nur
keinen Wert. Gelesen wird der Wert außerdem unter allen Namen, unter denen
Shelly ihn schreibt – `tC`, `value`, und in Fahrenheit, wenn das Gerät so
eingestellt ist.

## 1.4.0 – 2026-08-09

**Shelly: Heizungen und Sensoren, die vorher fehlten.** Ein BLU TRV hängt per
Bluetooth an einem Gen3-Shelly und kommt als eigener Bauteiltyp herein – der
Hub kannte ihn nicht, also fehlte im Haushalt schlicht die Heizung. Ebenso die
BLU-Sensoren (Temperatur, Luftfeuchte, Batterie, Bewegung) und
Helligkeitsmesser. Solltemperaturen gehen jetzt auch an ein BLU TRV, eingepackt
über den Zugang, an dem es hängt.

**Und was Shelly morgen herausbringt.** Ein unbekannter Bauteiltyp verschwand
bisher wortlos – dieselbe Falle, die bei Homematic schon zugeschlagen hatte.
Jetzt entscheiden die Werte statt des Namens: Solltemperatur ⇒ Heizung,
Position mit Fahrzustand ⇒ Rollladen, schaltbarer Ausgang ⇒ Schalter. Was
trotzdem übrig bleibt, steht mit Begründung in der Diagnose.

**Der Abfragetakt lässt sich einstellen.** Bisher stand er nur in der
Umgebungsvariable `POLL_INTERVAL_SECONDS`, also außerhalb der Reichweite des
Bewohners. Jetzt steht er unter Einstellungen: 3 bis 300 Sekunden, mit ein paar
Vorschlägen. Kurz heißt, dass ein von Hand bewegter Rollladen schneller auf dem
Bildschirm steht; lang heißt weniger Last für Bridges und Batteriegeräte. Der
neue Takt gilt sofort, ohne Neustart.

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
