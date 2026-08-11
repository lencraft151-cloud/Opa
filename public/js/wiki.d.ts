/**
 * Typen für das Wiki.
 *
 * Wie bei der Lichtvorschau: Die Oberfläche ist reines JavaScript ohne
 * Build-Schritt, aber die Tests prüfen die Suche und die Auszeichnung mit –
 * und dafür braucht TypeScript diese Beschreibung. Sie wird nirgends
 * ausgeliefert und nirgends übersetzt.
 */

export interface WikiSection {
  heading: string;
  /** Absätze in schlanker Auszeichnung: `**fett**` und `` `code` ``. */
  body: string[];
}

export interface WikiArticle {
  id: string;
  title: string;
  icon: string;
  /** Die Antwort in einem Satz – für alle, die den Rest nicht lesen. */
  summary: string;
  sections: WikiSection[];
}

export const ARTICLES: WikiArticle[];

export function setWikiArticle(id: string): void;
export function searchArticles(articles: WikiArticle[], needle: string): WikiArticle[];
export function markup(text: string): string;
export function renderWiki(): void;
