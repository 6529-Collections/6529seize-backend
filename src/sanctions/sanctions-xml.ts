import * as sax from 'sax';

/** A small, order-preserving XML element tree (namespace prefixes removed). */
export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  /** Concatenated direct text and CDATA content, unmodified. */
  text: string;
}

export interface XmlRecordScan {
  readonly rootName: string;
  readonly rootAttrs: Readonly<Record<string, string>>;
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function localAttributes(
  attributes: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(attributes)) {
    if (key !== 'xmlns' && key.indexOf('xmlns:') !== 0) {
      result[localName(key)] = attributes[key];
    }
  }
  return result;
}

/** Decodes UTF-8 bytes, dropping a leading byte-order mark. */
export function decodeUtf8(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Streams an XML document and hands every element whose local name is in
 * `recordNames` (and which is not inside another record) to `onRecord` as a
 * small tree. Only records are kept in memory, so 100 MB files are fine.
 * The parser is strict: malformed XML throws.
 */
export function scanXmlRecords(
  xml: string,
  recordNames: ReadonlyArray<string>,
  onRecord: (record: XmlElement) => void
): XmlRecordScan {
  const parser = sax.parser(true, { trim: false, normalize: false });
  const stack: XmlElement[] = [];
  let rootName = '';
  let rootAttrs: Record<string, string> = {};
  let depth = 0;

  parser.onopentag = (tag) => {
    const name = localName(tag.name);
    const attrs = localAttributes(tag.attributes as Record<string, string>);
    if (depth === 0) {
      rootName = name;
      rootAttrs = attrs;
    }
    depth++;
    if (stack.length > 0 || recordNames.indexOf(name) !== -1) {
      const element: XmlElement = { name, attrs, children: [], text: '' };
      if (stack.length > 0) {
        stack[stack.length - 1].children.push(element);
      }
      stack.push(element);
    }
  };
  const appendText = (text: string) => {
    if (stack.length > 0) {
      stack[stack.length - 1].text += text;
    }
  };
  parser.ontext = appendText;
  parser.oncdata = appendText;
  parser.onclosetag = () => {
    depth--;
    const element = stack.pop();
    if (element && stack.length === 0) {
      onRecord(element);
    }
  };
  parser.onerror = (error: Error) => {
    throw error;
  };
  parser.write(xml).close();
  if (depth !== 0 || rootName === '') {
    throw new Error('XML document is incomplete');
  }
  return { rootName, rootAttrs };
}

export function childElements(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export function firstChild(
  element: XmlElement,
  name: string
): XmlElement | null {
  for (const child of element.children) {
    if (child.name === name) {
      return child;
    }
  }
  return null;
}

/** Text of the first child with `name`, or null when absent. */
export function childText(element: XmlElement, name: string): string | null {
  const child = firstChild(element, name);
  return child ? child.text : null;
}

/** Follows a path of child names, returning every match. */
export function elementsAtPath(
  element: XmlElement,
  path: ReadonlyArray<string>
): XmlElement[] {
  let current: XmlElement[] = [element];
  for (const name of path) {
    const next: XmlElement[] = [];
    for (const node of current) {
      for (const child of childElements(node, name)) {
        next.push(child);
      }
    }
    current = next;
  }
  return current;
}

/** Every descendant element (depth-first, document order), excluding `element`. */
export function descendants(element: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  const visit = (node: XmlElement) => {
    for (const child of node.children) {
      result.push(child);
      visit(child);
    }
  };
  visit(element);
  return result;
}
