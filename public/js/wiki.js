/**
 * Das Wiki im Hub.
 *
 * Warum die Erklärungen *im* Programm stehen und nicht in einer Datei
 * daneben: Wer vor einem Kasten steht, in dem „Anmeldung abgelehnt" steht,
 * schlägt nicht in einer README nach. Er sucht dort, wo er gerade ist.
 *
 * Der Text ist deshalb bewusst als Daten geschrieben und nicht als HTML –
 * so lässt er sich durchsuchen, verlinken und an einer Stelle pflegen. Aus
 * jeder Ansicht heraus kann auf einen Abschnitt gezeigt werden
 * (`openWiki('fritzbox')`).
 */

import { esc } from './format.js';

const $ = (selector) => document.querySelector(selector);

/**
 * Ein Artikel besteht aus Titel, Kurzfassung und Abschnitten.
 *
 * Die Kurzfassung ist Absicht: Sie beantwortet die Frage in einem Satz, für
 * alle, die den Rest nicht lesen wollen. Erst danach kommen die Einzelheiten.
 */
export const ARTICLES = [
  {
    id: 'start',
    title: 'Erste Schritte',
    icon: '🚀',
    summary:
      'Der Hub verbindet Geräte verschiedener Hersteller zu einem Zuhause. Einmal einrichten, danach bedienst du alles an einer Stelle.',
    sections: [
      {
        heading: 'In welcher Reihenfolge?',
        body: [
          'Zuerst **Geräte verbinden** (Einstellungen → „Weitere Bridge oder weiteres Gerät hinzufügen"), dann **Räume anlegen**, dann die Geräte den Räumen **zuordnen**. Alles Weitere – Szenen, Automationen, Auswertung – baut darauf auf.',
          'Die Reihenfolge ist kein Selbstzweck: Ohne Räume gibt es keine Raumkacheln, keine Klimaanzeige und keine Sammelbefehle („alles im Wohnzimmer aus").',
        ],
      },
      {
        heading: 'Was ist was?',
        body: [
          '**Integration** – die Verbindung zu einem Hersteller: deine Hue Bridge, ein einzelner Shelly, die FRITZ!Box. Über sie kommen die Geräte in den Hub.',
          '**Gerät** – alles, was du schaltest oder ablesen kannst. Ein Shelly mit zwei Kanälen ergibt zwei Geräte, damit du sie verschiedenen Räumen zuordnen kannst.',
          '**Fähigkeit** – was ein Gerät kann: schaltbar, dimmbar, Farbe, Rollladen, Heizung, Sensor. Kommandos funktionieren nur mit der passenden Fähigkeit.',
          '**Dienst** – etwas ohne Schalter: Sonos, Spotify, Nextcloud. Sie stehen im eigenen Reiter „Dienste".',
        ],
      },
    ],
  },
  {
    id: 'geraete',
    title: 'Geräte verbinden',
    icon: '🔌',
    summary:
      '„Netzwerk durchsuchen" findet, was im eigenen Netz antwortet. Was dabei nicht auftaucht, trägst du mit seiner IP-Adresse von Hand ein.',
    sections: [
      {
        heading: 'Suchen und verbinden',
        body: [
          'Die normale Suche horcht ins Netz (mDNS und SSDP) und fragt bekannte Adressen ab. Sie dauert wenige Sekunden, und jeder Treffer erscheint sofort – du musst nicht warten, bis alles fertig ist.',
          '**„Gründlich suchen"** klopft zusätzlich jede Adresse im eigenen Netz ab. Das findet Geräte, die auf Suchanfragen nicht antworten, und dauert entsprechend länger.',
          '**„Mit allen verbinden"** übernimmt auf einen Schlag alles, was kein Passwort braucht. Geschützte Geräte bleiben bewusst außen vor – sie fragen einzeln nach ihrem Kennwort.',
        ],
      },
      {
        heading: 'Wenn ein Gerät fehlt',
        body: [
          'Läuft der Hub im selben Netz wie die Geräte? In Docker braucht er `--network host`, sonst sieht er das Heimnetz gar nicht.',
          'Hängt das Gerät im Gastnetz oder hinter einem Repeater? Dann kommen Suchanfragen oft nicht durch – trage die Adresse von Hand ein.',
          'Steht das Gerät in der Liste, aber ohne die erwartete Funktion? Unter Einstellungen → Integrationen → „Erneut verbinden und nachsehen, was fehlt" steht, welcher Kanal warum übersprungen wurde. Und unter „Geräte" lässt sich der Gerätetyp von Hand richtigstellen.',
        ],
      },
    ],
  },
  {
    id: 'hue',
    title: 'Philips Hue',
    icon: '💡',
    summary:
      'Bridge suchen, den runden Knopf drücken, verbinden. Ein Passwort gibt es nicht – der Knopf *ist* der Schlüssel.',
    sections: [
      {
        heading: 'Koppeln',
        body: [
          'Erst den runden Knopf auf der Bridge drücken, **dann** innerhalb von etwa 30 Sekunden auf „Verbinden". Andersherum lehnt die Bridge ab – das ist ihr Schutz dagegen, dass sich jemand aus der Ferne verbindet.',
          'Auch die alte, runde Bridge der ersten Generation (BSB001) funktioniert. Der Hub merkt beim Koppeln, dass sie die neue API nicht kennt, und spricht ab da die alte.',
        ],
      },
      {
        heading: 'Besonderheiten',
        body: [
          'Die Hue Bridge meldet Änderungen von sich aus – Lichter, die du am Schalter oder in der Hue-App bedienst, erscheinen hier fast ohne Verzögerung. Bei allen anderen Herstellern fragt der Hub im eingestellten Takt nach.',
          'Räume aus der Hue-App kann der Hub beim Verbinden übernehmen.',
        ],
      },
    ],
  },
  {
    id: 'shelly',
    title: 'Shelly',
    icon: '⚡',
    summary:
      'Ein Shelly wird direkt verbunden, nicht über eine Bridge. Ein Passwort brauchst du nur, wenn du in seiner App eines vergeben hast.',
    sections: [
      {
        heading: 'Alte und neue Geräte',
        body: [
          'Gen1 (die älteren, mit `/status`) und Gen2/Gen3/Gen4 (mit JSON-RPC) funktionieren beide. Der Hub erkennt beim Verbinden, womit er es zu tun hat.',
          'Ein Shelly 2 oder 2.5 im **Rollladenmodus** erscheint als *ein* Rollladen und nicht als zwei Schalter. Das ist wichtiger, als es klingt: Beide Motorrelais gleichzeitig einzuschalten legt Spannung auf beide Wicklungen.',
        ],
      },
      {
        heading: 'Was sonst noch erkannt wird',
        body: [
          'Heizkörperventile (TRV und BLU TRV), Temperatur-, Feuchte-, Helligkeits- und Bewegungssensoren, Weißton- und Farblampen, Verbrauchsmessung.',
          'Kennt der Hub einen Bauteiltyp nicht, rät er aus den gemeldeten Werten: Solltemperatur ⇒ Heizung, Position und Fahrtrichtung ⇒ Rollladen, `output` ⇒ Schalter. Was übrig bleibt, steht mit Begründung in der Diagnose.',
        ],
      },
    ],
  },
  {
    id: 'fritzbox',
    title: 'FRITZ!Box',
    icon: '📶',
    summary:
      'Es genügt das Kennwort der Box-Oberfläche. Klemmt es trotzdem, liegt es fast immer am Benutzernamen oder an einer fehlenden Berechtigung.',
    sections: [
      {
        heading: 'Verbinden',
        body: [
          'Als Adresse funktioniert meist `fritz.box`. Das Kennwort ist dasselbe, mit dem du die Box im Browser öffnest.',
          'Einen Benutzernamen musst du nur eintragen, wenn unter „System → FRITZ!Box-Benutzer" **mehrere** Konten angelegt sind. Sonst holt sich der Hub den Namen bei der Box selbst.',
        ],
      },
      {
        heading: '„Das Kennwort geht nie"',
        body: [
          '**Der Benutzername.** Auch eine Box, die auf „Anmeldung nur mit Kennwort" steht, hat intern einen Benutzer – sie hat ihn selbst angelegt und nennt ihn etwa `fritz3000`. Wer nichts einträgt, schickte früher eine leere Kennung, und die weist die Box ab: richtiges Kennwort, falscher Benutzer. Der Hub liest den Namen jetzt aus der Antwort der Box.',
          '**Die Berechtigung.** Das verwendete Konto braucht „Smart-Home-Geräte und Automatisierung steuern" (System → FRITZ!Box-Benutzer → Benutzer → Berechtigungen). Fehlt sie, bleibt die Schnittstelle zu.',
          '**Die Sperre.** Nach mehreren Fehlversuchen sperrt die Box die Anmeldung – auch für ihre eigene Oberfläche. Der Hub wartet nach einer Ablehnung deshalb ab, statt weiter anzuklopfen, und sagt, wie lange.',
        ],
      },
      {
        heading: 'Der Notausgang',
        body: [
          'Unter Einstellungen → FRITZ!Box-Oberfläche kannst du die Adresse der Box hinterlegen. Sie erscheint dann im Reiter Dienste → FRITZ!Box, und du bedienst die Box direkt aus dem Hub heraus.',
          'Ob sich die Seite einbetten lässt, entscheidet die Box – viele verbieten das. Der Knopf „In neuem Fenster öffnen" daneben geht immer.',
        ],
      },
    ],
  },
  {
    id: 'homematic',
    title: 'Homematic',
    icon: '🏠',
    summary:
      'CCU2, CCU3 und RaspberryMatic über ihre JSON-Schnittstelle. Benutzername und Passwort sind dieselben wie in der CCU-Oberfläche.',
    sections: [
      {
        heading: 'Verbinden',
        body: [
          'Der Benutzer braucht Administratorrechte. Ohne Eintrag versucht der Hub „Admin".',
          'BidCos (die älteren Funkgeräte) und HmIP werden beide erkannt – auch nebeneinander an derselben Zentrale.',
        ],
      },
      {
        heading: 'Rollläden, Markisen, Tore',
        body: [
          'Für den Hub sind das alles Antriebe mit Position: „auf", „zu", ein Prozentwert. Erkannt werden Rollladen- und Jalousieaktoren ebenso wie Markisen, Garagentore und Screens.',
          'Ein HmIP-Rollladenaktor meldet fünf gleichwertige Empfängerkanäle, die alle denselben Motor fahren. Der Hub fasst sie zu einem Gerät zusammen.',
        ],
      },
    ],
  },
  {
    id: 'dienste',
    title: 'Dienste: Sonos, Spotify, Nextcloud',
    icon: '🎵',
    summary:
      'Dinge ohne Schalter. Sie stehen im Reiter „Dienste", jeder in seinem eigenen Unterreiter.',
    sections: [
      {
        heading: 'Sonos',
        body: [
          'Braucht kein Konto: Der Hub spricht die Lautsprecher direkt im Netz an. Sie werden bei der normalen Netzwerksuche mitgefunden; zur Not trägst du die Adresse von Hand ein (sie steht in der Sonos-App unter Einstellungen → System → Produkte → Netzwerk).',
          '**Gruppen:** Sind zwei Lautsprecher in der Sonos-App zusammengelegt, gelten Play und Pause für die ganze Gruppe – nur der Koordinator nimmt sie an, und der Hub schickt sie dorthin. Die Lautstärke bleibt bei jedem Lautsprecher einzeln.',
        ],
      },
      {
        heading: 'Spotify',
        body: [
          'Einmalige Einrichtung über das Spotify-Dashboard (developer.spotify.com): App anlegen, die vom Hub angezeigte Rückleitungsadresse **zeichengenau** eintragen, Client-ID hier einsetzen. Ein Client-Geheimnis wird nicht gebraucht.',
          'Steuern (Play, Pause, Lautstärke) erlaubt Spotify nur mit Premium. Anzeigen, was läuft, geht auch ohne. Läuft gerade nirgends etwas, muss die Wiedergabe einmal auf Handy oder Rechner gestartet werden – danach kann der Hub übernehmen.',
        ],
      },
      {
        heading: 'Nextcloud',
        body: [
          'Adresse, Benutzername und ein **App-Passwort** (Nextcloud: Einstellungen → Sicherheit → „Neues App-Passwort erstellen"). Das normale Kontopasswort funktioniert bei Zwei-Faktor-Anmeldung ohnehin nicht.',
          'Neue Benachrichtigungen erscheinen als Einblendung, mit einem Verweis auf die Sache selbst. Beim ersten Verbinden bleibt es still – sonst poppen alle offenen Meldungen auf einmal auf.',
        ],
      },
    ],
  },
  {
    id: 'raeume',
    title: 'Räume und Szenen',
    icon: '🛋️',
    summary:
      'Räume fassen Geräte zusammen. Eine Szene hält fest, wie das Zuhause gerade eingestellt ist, und stellt es auf Knopfdruck wieder her.',
    sections: [
      {
        heading: 'Räume',
        body: [
          'Anlegen in den Einstellungen, zuordnen unter „Geräte". Danach zeigt jeder Raum Temperatur, Feuchte und Verbrauch, und du kannst alles darin auf einmal schalten.',
        ],
      },
      {
        heading: 'Szenen',
        body: [
          'Statt Kommandos zusammenzuklicken stellst du dein Zuhause ein, wie du es haben willst, und drückst auf sichern. Der Hub liest die Zustände aus und leitet daraus die Kommandos ab.',
          'Von einer ausgeschalteten Lampe wird nur „aus" gesichert – ihre Helligkeit mitzuschreiben würde sie beim Abrufen kurz aufblitzen lassen.',
        ],
      },
    ],
  },
  {
    id: 'automationen',
    title: 'Automationen',
    icon: '⚙️',
    summary:
      'Wenn-dann-Regeln, die der Hub selbst ausführt. Neun fertige Vorlagen gibt es dazu.',
    sections: [
      {
        heading: 'Was auslösen kann',
        body: [
          'Ein **Messwert** über oder unter einer Schwelle (Temperatur, Feuchte, Helligkeit, Leistung …), optional erst nach einer Weile.',
          'Ein **Gerätezustand** – etwa Bewegung an einem Melder oder eine Lampe, die angeht.',
          'Eine **Uhrzeit** an bestimmten Wochentagen.',
          'Ein **Takt**: alle X Sekunden oder Minuten, optional nur in einem Zeitfenster.',
        ],
      },
      {
        heading: 'Regeln, die von selbst aufhören',
        body: [
          'Jede Aktion kann eine Dauer haben. „Alle 20 Sekunden das Licht für 10 Sekunden an" ist damit *eine* Regel und nicht zwei.',
          'Zurückgenommen wird nur, wo das Gegenteil eindeutig ist – an/aus, auf/zu. Bei einer Helligkeit müsste der Hub den vorherigen Wert raten, und das tut er nicht.',
        ],
      },
      {
        heading: 'Wann eine Regel *nicht* auslöst',
        body: [
          'Regeln lösen flankengesteuert aus: Solange die Bedingung erfüllt bleibt, feuert die Regel einmal. Erst wenn sie zwischendurch nicht mehr zutrifft, ist die Regel wieder scharf. Das verhindert, dass eine Regel bei 20,9 °C im Sekundentakt zuschlägt.',
        ],
      },
    ],
  },
  {
    id: 'auswertung',
    title: 'Auswertung: Verbrauch und Verlauf',
    icon: '📈',
    summary:
      'Was war? Stromkosten je Gerät und Raum, dazu die Messwertkurven von Temperatur, Feuchte und Leistung.',
    sections: [
      {
        heading: 'Woher die Zahlen kommen',
        body: [
          'Geräte mit Verbrauchsmessung melden einen Zählerstand. Der Hub schreibt ihn mit und rechnet die Differenz – deshalb braucht eine belastbare Zahl etwas Vorlauf.',
          '**Abdeckung** heißt: Wie viel des Zeitraums ist wirklich mit Messwerten belegt? Ist sie niedrig, verzichtet der Hub bewusst auf eine Hochrechnung, statt zu raten.',
        ],
      },
      {
        heading: 'Der Strompreis',
        body: [
          'Unter Einstellungen → Stromtarif eintragen. Ohne ihn zeigt der Hub Kilowattstunden, aber keine Kosten.',
        ],
      },
    ],
  },
  {
    id: 'sicherung',
    title: 'Sicherung, Updates, Haushalt löschen',
    icon: '💾',
    summary:
      'Die Sicherung enthält alles außer Passwörtern. Der Hub kann sich selbst aktualisieren. Und löschen geht nur hinter fünf Bestätigungen.',
    sections: [
      {
        heading: 'Sicherung',
        body: [
          'Räume, Gerätenamen, Zuordnungen, Szenen und Automationen als Datei. **Nicht** darin: Zugangsdaten deiner Bridges, Passwörter, Sitzungen. Die Datei darf also auf einem USB-Stick liegen.',
          'Der Preis: Auf einem *anderen* Hub muss jede Verbindung einmal neu hergestellt werden. Auf demselben Hub bleibt alles verbunden.',
        ],
      },
      {
        heading: 'Updates',
        body: [
          '**Firmware** der Geräte: Übersicht und Installation unter Einstellungen, auf Knopfdruck oder automatisch im gewählten Nachtfenster.',
          '**Der Hub selbst:** Unter „Diese Fassung" steht, was eine neue Fassung bringt – *vor* dem Knopf, nicht danach. Läuft der Hub ohne Arbeitskopie, holt er sie sich beim ersten Aktualisieren; Datenbank, Messwerte und Einstellungen bleiben dabei unangetastet.',
        ],
      },
      {
        heading: 'Haushalt löschen',
        body: [
          'Ganz unten in den Einstellungen, hinter fünf Bestätigungen. Jede nennt etwas anderes, das verschwindet; der letzte Schritt verlangt den abgetippten Namen des Haushalts. Danach startet der Hub wieder mit der Einrichtung.',
        ],
      },
    ],
  },
  {
    id: 'fehler',
    title: 'Wenn etwas klemmt',
    icon: '🔧',
    summary:
      'Die häufigsten Fälle und was dann hilft: ein Gerät reagiert nicht, die Anzeige hinkt hinterher, oder du kommst selbst nicht mehr hinein.',
    sections: [
      {
        heading: 'Ein Gerät reagiert nicht',
        body: [
          'Steht bei der Integration „gestört"? Dann Einstellungen → Integrationen → „Testen". Die Meldung nennt den Grund.',
          'Hat sich die IP-Adresse geändert? Router neu gestartet? Über „Erneut verbinden" lässt sich die Adresse berichtigen, ohne Namen, Räume, Szenen und Automationen zu verlieren.',
        ],
      },
      {
        heading: 'Die Anzeige hinkt hinterher',
        body: [
          'Der Hub fragt die Geräte im eingestellten Takt ab (Einstellungen → „Wie oft der Hub nachsieht"). Kürzer heißt: schneller auf dem Bildschirm. Länger heißt: weniger Last für Bridges und Batteriegeräte. Die Hue Bridge meldet ohnehin von selbst.',
        ],
      },
      {
        heading: 'Ich bin ausgesperrt',
        body: [
          'Ein anderer Administrator im Haushalt kann das Passwort zurücksetzen (Einstellungen → Personen).',
          'Gibt es keinen zweiten Zugang mehr, hilft nur das Löschen der Datenbankdatei im Datenverzeichnis – danach startet die Einrichtung neu. Die Sicherung von vorher lässt sich anschließend zurückspielen.',
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Zeichnen
// ---------------------------------------------------------------------------

let openArticle = 'start';
let query = '';

/** Springt aus einer anderen Ansicht heraus zu einem Artikel. */
export function setWikiArticle(id) {
  if (ARTICLES.some((article) => article.id === id)) openArticle = id;
}

/**
 * Sucht in Titeln, Kurzfassungen und Fließtext.
 *
 * Bewusst simpel: kleingeschriebener Teilstring. Für zwölf Artikel ist alles
 * Weitere Aufwand ohne Ertrag – und eine Suche, die nichts findet, weil sie
 * zu klug ist, wäre schlimmer als keine.
 */
export function searchArticles(articles, needle) {
  const term = needle.trim().toLowerCase();
  if (!term) return articles;
  return articles.filter((article) => {
    const haystack = [
      article.title,
      article.summary,
      ...article.sections.flatMap((section) => [section.heading, ...section.body]),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(term);
  });
}

/**
 * Wandelt die schlanke Auszeichnung in HTML.
 *
 * Erlaubt sind `**fett**` und `` `code` `` – mehr braucht der Text nicht, und
 * alles andere wäre eine Einladung, HTML in die Artikel zu schreiben.
 */
export function markup(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function renderWiki() {
  const panel = $('#panel-wiki');
  if (!panel) return;

  const matches = searchArticles(ARTICLES, query);
  if (matches.length > 0 && !matches.some((article) => article.id === openArticle)) {
    openArticle = matches[0].id;
  }
  const article = ARTICLES.find((entry) => entry.id === openArticle) ?? ARTICLES[0];

  panel.innerHTML = `
    <p class="intro">
      Alles erklärt: Begriffe, Einrichtung je Hersteller, Automationen, Sicherung – und
      was zu tun ist, wenn etwas klemmt.
    </p>

    <div class="wiki">
      <aside class="wiki-nav">
        <input id="wiki-search" type="search" placeholder="Im Wiki suchen…"
               value="${esc(query)}" aria-label="Im Wiki suchen" />
        <nav>${
          matches.length
            ? matches
                .map(
                  (entry) =>
                    `<button data-article="${esc(entry.id)}"
                       class="${entry.id === article.id ? 'active' : ''}">
                       <span aria-hidden="true">${entry.icon}</span> ${esc(entry.title)}
                     </button>`,
                )
                .join('')
            : '<p class="muted small">Dazu steht hier nichts. Versuche ein anderes Wort.</p>'
        }</nav>
      </aside>

      <article class="wiki-article card">
        <h2>${article.icon} ${esc(article.title)}</h2>
        <p class="wiki-summary">${markup(article.summary)}</p>
        ${article.sections
          .map(
            (section) => `<section>
              <h3>${esc(section.heading)}</h3>
              ${section.body.map((line) => `<p>${markup(line)}</p>`).join('')}
            </section>`,
          )
          .join('')}
      </article>
    </div>`;

  panel.querySelectorAll('[data-article]').forEach((button) => {
    button.addEventListener('click', () => {
      openArticle = button.dataset.article;
      renderWiki();
      panel.querySelector('.wiki-article')?.scrollIntoView({ block: 'nearest' });
    });
  });

  const search = panel.querySelector('#wiki-search');
  search?.addEventListener('input', () => {
    query = search.value;
    renderWiki();
    // Nach dem Neuzeichnen weitertippen können.
    const field = panel.querySelector('#wiki-search');
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
}
