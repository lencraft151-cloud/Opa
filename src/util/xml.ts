/**
 * Winziger XML-Leser.
 *
 * Gebraucht wird er für genau einen Zweck: die Geräteliste der FRITZ!Box.
 * Deren AHA-Schnittstelle antwortet in XML, und eine Bibliothek dafür wäre
 * die erste Abhängigkeit, die der Hub sonst nirgends braucht.
 *
 * Der Leser ist bewusst nachsichtig und kennt nur, was in dieser Antwort
 * vorkommt: Elemente, Attribute, Text, Kommentare, CDATA und die fünf
 * vordefinierten Entities. Keine Namensräume, keine DTDs, keine Validierung –
 * für ein vollständiges XML-Dokument aus fremder Hand wäre er zu wenig.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Zusammengefasster Textinhalt der direkten Kinder. */
  text: string;
}

/**
 * Zerlegt ein XML-Dokument. Gibt das Wurzelelement zurück oder wirft, wenn
 * gar keines zu finden ist.
 */
export function parseXml(source: string): XmlNode {
  const root = parseNodes(source);
  const first = root[0];
  if (!first) throw new Error('Die Antwort enthält kein XML-Element');
  return first;
}

/** Wie {@link parseXml}, aber ohne Ausnahme – für optionale Antworten. */
export function tryParseXml(source: string): XmlNode | null {
  try {
    return parseXml(source);
  } catch {
    return null;
  }
}

function parseNodes(source: string): XmlNode[] {
  const stack: XmlNode[] = [];
  const roots: XmlNode[] = [];
  let index = 0;

  const push = (node: XmlNode): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
  };

  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open === -1) break;

    // Text zwischen zwei Elementen gehört zum aktuellen Element.
    if (open > index) {
      const text = source.slice(index, open);
      const current = stack[stack.length - 1];
      if (current && text.trim()) current.text += decodeEntities(text);
    }

    // Kommentare, CDATA und Deklarationen überspringen.
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open);
      const content = source.slice(open + 9, end === -1 ? source.length : end);
      const current = stack[stack.length - 1];
      if (current) current.text += content;
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', open) || source.startsWith('<!', open)) {
      const end = source.indexOf('>', open);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const close = findTagEnd(source, open);
    if (close === -1) break;
    const raw = source.slice(open + 1, close).trim();
    index = close + 1;

    // Schließendes Element
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      // Ein nicht passendes Ende beendet trotzdem – die Alternative wäre,
      // eine sonst brauchbare Antwort ganz zu verwerfen.
      for (let depth = stack.length - 1; depth >= 0; depth--) {
        if (stack[depth]?.name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const space = body.search(/\s/);
    const name = space === -1 ? body : body.slice(0, space);
    const node: XmlNode = {
      name,
      attrs: space === -1 ? {} : parseAttributes(body.slice(space + 1)),
      children: [],
      text: '',
    };

    push(node);
    if (!selfClosing) stack.push(node);
  }

  return roots;
}

/** Sucht das `>`, das den Tag beendet – Anführungszeichen zählen nicht. */
function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const key = match[1];
    if (!key) continue;
    attrs[key] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attrs;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity] ?? whole;
  });
}

// ---------------------------------------------------------------------------
// Bequeme Zugriffe
// ---------------------------------------------------------------------------

/** Erstes direktes Kind mit diesem Namen. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((entry) => entry.name === name);
}

/** Alle direkten Kinder mit diesem Namen. */
export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter((entry) => entry.name === name) ?? [];
}

/** Text eines Kindelements, z. B. `<name>Steckdose</name>`. */
export function childText(node: XmlNode | undefined, name: string): string | undefined {
  const found = child(node, name);
  const text = found?.text.trim();
  return text ? text : undefined;
}

/** Zahl aus einem Kindelement. Leere und unlesbare Werte ergeben `undefined`. */
export function childNumber(node: XmlNode | undefined, name: string): number | undefined {
  const text = childText(node, name);
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}
