/**
 * Typen für den Entwurfsspeicher.
 *
 * Wie bei `wiki.d.ts`: Die Oberfläche bleibt reines JavaScript ohne
 * Build-Schritt, aber die Regel „Kennwörter werden nie gemerkt" ist zu
 * wichtig, um sie ungeprüft zu lassen – und dafür braucht TypeScript diese
 * Beschreibung. Sie wird nirgends ausgeliefert.
 *
 * Die Felder sind bewusst als `any` beschrieben: Die Tests reichen
 * Attrappen herein, keine echten DOM-Knoten.
 */

export function fieldKey(field: any): string | null;
export function rememberField(field: any): void;
export function restoreDrafts(root?: any): number;
export function clearDrafts(form: any): void;
export function forgetDrafts(): void;
export function startDrafts(): void;
