import { XMP_SIGNATURE } from './jpeg-structure';

/**
 * Reads the HDR gain map properties out of a JPEG XMP packet and writes a
 * fresh packet holding only those properties. Nothing else from the original
 * packet is copied: every kept value must match a numeric, boolean, version
 * or fixed-URN pattern, so free text (names, places, tools, history) cannot
 * survive. Recognised vocabularies:
 *
 * - Adobe/Google gain map (`hdrgm:*`, Ultra HDR v1).
 * - Google container directory (`Container:Directory` of `Item:Semantic`,
 *   `Item:Mime`, `Item:Length`, `Item:Padding`), kept for Primary and GainMap
 *   items only.
 * - Apple HDR gain map (`HDRGainMap:*` and the `apdi:*` auxiliary image type
 *   `urn:com:apple:photo:2020:aux:hdrgainmap`).
 */

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const X_NS = 'adobe:ns:meta/';
export const HDRGM_NS = 'http://ns.adobe.com/hdr-gain-map/1.0/';
export const CONTAINER_NS = 'http://ns.google.com/photos/1.0/container/';
export const CONTAINER_ITEM_NS =
  'http://ns.google.com/photos/1.0/container/item/';
export const APPLE_HDR_GAIN_MAP_NS = 'http://ns.apple.com/HDRGainMap/1.0/';
export const APPLE_PIXEL_DATA_NS = 'http://ns.apple.com/pixeldatainfo/1.0/';
export const APPLE_GAIN_MAP_AUXILIARY_TYPE =
  'urn:com:apple:photo:2020:aux:hdrgainmap';

const MAX_XML_DEPTH = 32;
const MAX_XML_ELEMENTS = 4096;

// ----- XML ------------------------------------------------------------------

interface XmlName {
  readonly ns: string;
  readonly local: string;
}

interface XmlAttribute extends XmlName {
  readonly value: string;
}

interface XmlElement extends XmlName {
  readonly attributes: readonly XmlAttribute[];
  readonly children: (XmlElement | string)[];
}

interface OpenElement {
  readonly qname: string;
  readonly element: XmlElement;
  readonly scope: Map<string, string>;
}

interface StartTag {
  readonly qname: string;
  readonly attributes: readonly [string, string][];
  readonly selfClosing: boolean;
  readonly end: number;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'"
};
const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]{2,4});/g;
const NAME_TERMINATORS = ' \t\r\n/>="\'<';
const WHITESPACE = ' \t\r\n';

function decodeEntity(body: string): string | null {
  if (body[0] !== '#') return NAMED_ENTITIES[body] ?? null;
  const code =
    body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
}

/** Decodes the predefined and numeric entities; anything else is refused. */
function decodeText(raw: string): string | null {
  if (raw.indexOf('&') < 0) return raw;
  if (raw.replace(ENTITY, '').indexOf('&') >= 0) return null;
  let valid = true;
  const decoded = raw.replace(ENTITY, (_, body: string) => {
    const value = decodeEntity(body);
    if (value === null) valid = false;
    return value ?? '';
  });
  return valid ? decoded : null;
}

function scan(text: string, from: number, stopAt: string): number {
  let index = from;
  while (index < text.length && stopAt.indexOf(text[index]) < 0) index++;
  return index;
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && WHITESPACE.indexOf(text[index]) >= 0) index++;
  return index;
}

function readAttribute(
  text: string,
  from: number
): { name: string; value: string; end: number } | null {
  const nameEnd = scan(text, from, NAME_TERMINATORS);
  if (nameEnd === from) return null;
  let index = skipWhitespace(text, nameEnd);
  if (text[index] !== '=') return null;
  index = skipWhitespace(text, index + 1);
  const quote = text[index];
  if (quote !== '"' && quote !== "'") return null;
  const close = text.indexOf(quote, index + 1);
  const value = close < 0 ? null : decodeText(text.slice(index + 1, close));
  if (value === null) return null;
  return { name: text.slice(from, nameEnd), value, end: close + 1 };
}

function readStartTag(text: string, open: number): StartTag | null {
  const nameEnd = scan(text, open + 1, NAME_TERMINATORS);
  if (nameEnd === open + 1) return null;
  const qname = text.slice(open + 1, nameEnd);
  const attributes: [string, string][] = [];
  let index = nameEnd;
  for (;;) {
    index = skipWhitespace(text, index);
    if (text[index] === '>') {
      return { qname, attributes, selfClosing: false, end: index + 1 };
    }
    if (text.startsWith('/>', index)) {
      return { qname, attributes, selfClosing: true, end: index + 2 };
    }
    const attribute = readAttribute(text, index);
    if (!attribute) return null;
    attributes.push([attribute.name, attribute.value]);
    index = attribute.end;
  }
}

function resolveName(
  qname: string,
  scope: Map<string, string>,
  attribute: boolean
): XmlName {
  const colon = qname.indexOf(':');
  if (colon < 0) {
    return { ns: attribute ? '' : (scope.get('') ?? ''), local: qname };
  }
  const prefix = qname.slice(0, colon);
  const local = qname.slice(colon + 1);
  if (prefix === 'xml') return { ns: XML_NS, local };
  // An undeclared prefix never matches a recognised namespace.
  return { ns: scope.get(prefix) ?? `undeclared:${prefix}`, local };
}

function isNamespaceDeclaration(name: string): boolean {
  return name === 'xmlns' || name.startsWith('xmlns:');
}

/**
 * A small namespace-aware XML reader for XMP packets: elements, attributes,
 * text, CDATA, comments and processing instructions. DOCTYPE and entity
 * declarations, unknown entities, mismatched tags, deep nesting and very
 * large documents are refused (null).
 */
class XmlReader {
  private readonly stack: OpenElement[] = [];
  private root: XmlElement | null = null;
  private elements = 0;
  private index = 0;

  constructor(private readonly text: string) {}

  read(): XmlElement | null {
    while (this.index < this.text.length) {
      if (!this.step()) return null;
    }
    return this.stack.length === 0 ? this.root : null;
  }

  private step(): boolean {
    const open = this.text.indexOf('<', this.index);
    const textEnd = open < 0 ? this.text.length : open;
    if (!this.addText(this.text.slice(this.index, textEnd))) return false;
    if (open < 0) {
      this.index = this.text.length;
      return true;
    }
    return this.markup(open);
  }

  private markup(open: number): boolean {
    const text = this.text;
    if (text.startsWith('<?', open)) return this.skipPast('?>', open + 2);
    if (text.startsWith('<!--', open)) return this.skipPast('-->', open + 4);
    if (text.startsWith('<![CDATA[', open)) return this.cdata(open);
    if (text.startsWith('<!', open)) return false;
    if (text.startsWith('</', open)) return this.endTag(open);
    return this.startTag(open);
  }

  private skipPast(terminator: string, from: number): boolean {
    const end = this.text.indexOf(terminator, from);
    if (end < 0) return false;
    this.index = end + terminator.length;
    return true;
  }

  private addText(raw: string): boolean {
    if (!raw.length) return true;
    const top = this.stack[this.stack.length - 1];
    if (!top) return raw.trim().length === 0;
    const decoded = decodeText(raw);
    if (decoded === null) return false;
    top.element.children.push(decoded);
    return true;
  }

  private cdata(open: number): boolean {
    const end = this.text.indexOf(']]>', open + 9);
    const top = this.stack[this.stack.length - 1];
    if (end < 0 || !top) return false;
    top.element.children.push(this.text.slice(open + 9, end));
    this.index = end + 3;
    return true;
  }

  private endTag(open: number): boolean {
    const close = this.text.indexOf('>', open + 2);
    const top = this.stack.pop();
    if (close < 0 || !top) return false;
    if (this.text.slice(open + 2, close).trim() !== top.qname) return false;
    this.index = close + 1;
    return true;
  }

  private startTag(open: number): boolean {
    const tag = readStartTag(this.text, open);
    const parent = this.stack[this.stack.length - 1];
    if (
      !tag ||
      ++this.elements > MAX_XML_ELEMENTS ||
      this.stack.length >= MAX_XML_DEPTH ||
      (!parent && this.root)
    ) {
      return false;
    }
    const scope = new Map(parent?.scope ?? []);
    tag.attributes.forEach(([name, value]) => {
      if (isNamespaceDeclaration(name)) scope.set(name.slice(6), value);
    });
    const element: XmlElement = {
      ...resolveName(tag.qname, scope, false),
      attributes: tag.attributes
        .filter(([name]) => !isNamespaceDeclaration(name))
        .map(([name, value]) => ({ ...resolveName(name, scope, true), value })),
      children: []
    };
    if (parent) parent.element.children.push(element);
    else this.root = element;
    if (!tag.selfClosing) this.stack.push({ qname: tag.qname, element, scope });
    this.index = tag.end;
    return true;
  }
}

// ----- RDF ------------------------------------------------------------------

type RdfValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'array'; readonly items: readonly RdfValue[] }
  | { readonly kind: 'struct'; readonly properties: readonly RdfProperty[] };

interface RdfProperty extends XmlName {
  readonly value: RdfValue;
}

function isElement(node: XmlElement | string): node is XmlElement {
  return typeof node !== 'string';
}

function isRdf(name: XmlName, local: string): boolean {
  return name.ns === RDF_NS && name.local === local;
}

function rdfAttribute(element: XmlElement, local: string): string | undefined {
  return element.attributes.find((attribute) => isRdf(attribute, local))?.value;
}

function isPropertyName(name: XmlName): boolean {
  return name.ns !== RDF_NS && name.ns !== XML_NS && name.ns !== '';
}

function textContent(element: XmlElement): string {
  return element.children
    .filter((child): child is string => typeof child === 'string')
    .join('')
    .trim();
}

function nodeProperties(node: XmlElement): RdfProperty[] {
  const fromAttributes = node.attributes.filter(isPropertyName).map(
    (attribute): RdfProperty => ({
      ns: attribute.ns,
      local: attribute.local,
      value: { kind: 'text', text: attribute.value.trim() }
    })
  );
  const fromChildren = node.children.filter(isElement).map(
    (child): RdfProperty => ({
      ns: child.ns,
      local: child.local,
      value: propertyValue(child)
    })
  );
  return fromAttributes.concat(fromChildren);
}

function containerValue(element: XmlElement, only: XmlElement): RdfValue {
  if (isRdf(only, 'Seq') || isRdf(only, 'Bag') || isRdf(only, 'Alt')) {
    return {
      kind: 'array',
      items: only.children
        .filter(isElement)
        .filter((item) => isRdf(item, 'li'))
        .map(propertyValue)
    };
  }
  if (isRdf(only, 'Description')) {
    return { kind: 'struct', properties: nodeProperties(only) };
  }
  return { kind: 'struct', properties: nodeProperties(element) };
}

/** Simple text, an rdf:Seq/Bag/Alt array, or a struct in any RDF spelling. */
function propertyValue(element: XmlElement): RdfValue {
  if (rdfAttribute(element, 'parseType') === 'Resource') {
    return { kind: 'struct', properties: nodeProperties(element) };
  }
  const children = element.children.filter(isElement);
  if (children.length === 1 && children[0].ns === RDF_NS) {
    return containerValue(element, children[0]);
  }
  if (children.length || element.attributes.some(isPropertyName)) {
    return { kind: 'struct', properties: nodeProperties(element) };
  }
  return { kind: 'text', text: textContent(element) };
}

function topLevelProperties(root: XmlElement): RdfProperty[] {
  const rdfRoots = isRdf(root, 'RDF')
    ? [root]
    : root.children.filter(isElement).filter((child) => isRdf(child, 'RDF'));
  const properties: RdfProperty[] = [];
  for (const rdfRoot of rdfRoots) {
    for (const child of rdfRoot.children.filter(isElement)) {
      if (isRdf(child, 'Description')) {
        properties.push(...nodeProperties(child));
      }
    }
  }
  return properties;
}

function findProperty(
  properties: readonly RdfProperty[],
  ns: string,
  local: string
): RdfProperty | undefined {
  return properties.find(
    (property) => property.ns === ns && property.local === local
  );
}

// ----- Gain map vocabulary ----------------------------------------------------

type ValueKind = 'number' | 'numbers' | 'integer' | 'version' | 'boolean';

interface PropertySpec {
  readonly ns: string;
  readonly prefix: string;
  readonly name: string;
  readonly kind: ValueKind | 'apple-auxiliary-type';
  /** Adobe writes simple values as attributes; Apple writes elements. */
  readonly form: 'attribute' | 'element';
}

export interface GainMapXmpProperty {
  readonly spec: PropertySpec;
  readonly value: string | readonly string[];
}

export interface ContainerItem {
  readonly semantic: string;
  readonly mime: string;
  readonly length: number | undefined;
  readonly padding: number;
}

export interface GainMapXmp {
  /** Allowlisted properties with validated values, in a fixed order. */
  readonly properties: readonly GainMapXmpProperty[];
  /** Every container item in file order (for layout); null when absent. */
  readonly directory: readonly ContainerItem[] | null;
  /** A directory is present but its items cannot be laid out. */
  readonly directoryMalformed: boolean;
}

export interface OutputDirectoryItem {
  readonly semantic: 'Primary' | 'GainMap';
  readonly length?: number;
}

const hdrgm = (name: string, kind: ValueKind): PropertySpec => ({
  ns: HDRGM_NS,
  prefix: 'hdrgm',
  name,
  kind,
  form: 'attribute'
});
const appleGainMap = (name: string, kind: ValueKind): PropertySpec => ({
  ns: APPLE_HDR_GAIN_MAP_NS,
  prefix: 'HDRGainMap',
  name,
  kind,
  form: 'element'
});
const applePixelData = (
  name: string,
  kind: PropertySpec['kind']
): PropertySpec => ({
  ns: APPLE_PIXEL_DATA_NS,
  prefix: 'apdi',
  name,
  kind,
  form: 'element'
});

const PROPERTY_SPECS: readonly PropertySpec[] = [
  hdrgm('Version', 'version'),
  hdrgm('BaseRenditionIsHDR', 'boolean'),
  hdrgm('GainMapMin', 'numbers'),
  hdrgm('GainMapMax', 'numbers'),
  hdrgm('Gamma', 'numbers'),
  hdrgm('OffsetSDR', 'numbers'),
  hdrgm('OffsetHDR', 'numbers'),
  hdrgm('HDRCapacityMin', 'number'),
  hdrgm('HDRCapacityMax', 'number'),
  appleGainMap('HDRGainMapVersion', 'integer'),
  appleGainMap('HDRGainMapHeadroom', 'number'),
  applePixelData('AuxiliaryImageType', 'apple-auxiliary-type'),
  applePixelData('NativeFormat', 'integer'),
  applePixelData('StoredFormat', 'integer')
];

const NAMESPACE_PREFIXES: readonly [string, string][] = [
  ['hdrgm', HDRGM_NS],
  ['Container', CONTAINER_NS],
  ['Item', CONTAINER_ITEM_NS],
  ['HDRGainMap', APPLE_HDR_GAIN_MAP_NS],
  ['apdi', APPLE_PIXEL_DATA_NS]
];

const NUMBER =
  /^[+-]?(?:\d{1,12}(?:\.\d{0,12})?|\.\d{1,12})(?:[eE][+-]?\d{1,3})?$/;
const SCALAR_PATTERNS: Readonly<Record<PropertySpec['kind'], RegExp>> = {
  number: NUMBER,
  numbers: NUMBER,
  integer: /^[+-]?\d{1,12}$/,
  version: /^\d{1,4}(?:\.\d{1,4}){0,3}$/,
  boolean: /^(?:True|False|true|false)$/,
  'apple-auxiliary-type': /^urn:com:apple:photo:2020:aux:hdrgainmap$/
};
const COUNT = /^\d{1,10}$/;

function validScalar(spec: PropertySpec, value: RdfValue): string | null {
  return value.kind === 'text' && SCALAR_PATTERNS[spec.kind].test(value.text)
    ? value.text
    : null;
}

/** Per-channel values are one number or an rdf:Seq of one or three. */
function validValue(
  spec: PropertySpec,
  value: RdfValue
): string | readonly string[] | null {
  if (spec.kind !== 'numbers' || value.kind !== 'array') {
    return validScalar(spec, value);
  }
  const items = value.items.map((item) => validScalar(spec, item));
  const valid = items.filter((item): item is string => item !== null);
  return valid.length === items.length &&
    (valid.length === 1 || valid.length === 3)
    ? valid
    : null;
}

function itemText(
  properties: readonly RdfProperty[],
  local: string
): string | undefined {
  const property = findProperty(properties, CONTAINER_ITEM_NS, local);
  return property?.value.kind === 'text' ? property.value.text : undefined;
}

function containerItem(value: RdfValue): ContainerItem | null {
  if (value.kind !== 'struct') return null;
  const wrapped = findProperty(value.properties, CONTAINER_NS, 'Item');
  const fields =
    wrapped?.value.kind === 'struct'
      ? wrapped.value.properties
      : value.properties;
  const length = itemText(fields, 'Length');
  const padding = itemText(fields, 'Padding');
  if (
    (length !== undefined && !COUNT.test(length)) ||
    (padding !== undefined && !COUNT.test(padding))
  ) {
    return null;
  }
  return {
    semantic: itemText(fields, 'Semantic') ?? '',
    mime: itemText(fields, 'Mime') ?? '',
    length: length === undefined ? undefined : Number(length),
    padding: padding === undefined ? 0 : Number(padding)
  };
}

function readDirectory(
  properties: readonly RdfProperty[]
): Pick<GainMapXmp, 'directory' | 'directoryMalformed'> {
  const directory = findProperty(properties, CONTAINER_NS, 'Directory');
  if (!directory) return { directory: null, directoryMalformed: false };
  if (directory.value.kind !== 'array') {
    return { directory: null, directoryMalformed: true };
  }
  const items = directory.value.items.map(containerItem);
  const valid = items.filter((item): item is ContainerItem => item !== null);
  return valid.length === items.length && valid.length > 0
    ? { directory: valid, directoryMalformed: false }
    : { directory: null, directoryMalformed: true };
}

/** Null when the packet is not well-formed XML. */
export function parseGainMapXmp(packet: Buffer): GainMapXmp | null {
  const root = new XmlReader(packet.toString('utf8')).read();
  if (!root) return null;
  const properties = topLevelProperties(root);
  const kept: GainMapXmpProperty[] = [];
  for (const spec of PROPERTY_SPECS) {
    const property = findProperty(properties, spec.ns, spec.name);
    const value = property ? validValue(spec, property.value) : null;
    if (value !== null) kept.push({ spec, value });
  }
  return { properties: kept, ...readDirectory(properties) };
}

export function hasGainMapProperty(
  xmp: GainMapXmp | null,
  ns: string,
  name: string
): boolean {
  return Boolean(
    xmp?.properties.some(
      (property) => property.spec.ns === ns && property.spec.name === name
    )
  );
}

/** Ultra HDR v1 gain map image metadata (the required `hdrgm` values). */
export function hasHdrgmGainMapMetadata(xmp: GainMapXmp | null): boolean {
  return ['Version', 'GainMapMax', 'HDRCapacityMax'].every((name) =>
    hasGainMapProperty(xmp, HDRGM_NS, name)
  );
}

/** Apple marks its gain map as an auxiliary image of a fixed type. */
export function isAppleGainMapXmp(xmp: GainMapXmp | null): boolean {
  return hasGainMapProperty(xmp, APPLE_PIXEL_DATA_NS, 'AuxiliaryImageType');
}

// ----- Writing ----------------------------------------------------------------

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function propertyXml(property: GainMapXmpProperty): string {
  const qname = `${property.spec.prefix}:${property.spec.name}`;
  const value =
    typeof property.value === 'string'
      ? escapeXml(property.value)
      : `<rdf:Seq>${property.value
          .map((item) => `<rdf:li>${escapeXml(item)}</rdf:li>`)
          .join('')}</rdf:Seq>`;
  return `<${qname}>${value}</${qname}>`;
}

function isAttributeProperty(property: GainMapXmpProperty): boolean {
  return (
    property.spec.form === 'attribute' && typeof property.value === 'string'
  );
}

function directoryXml(items: readonly OutputDirectoryItem[]): string {
  const entries = items.map((item) => {
    const length =
      item.length === undefined ? '' : ` Item:Length="${item.length}"`;
    return (
      '<rdf:li rdf:parseType="Resource"><Container:Item ' +
      `Item:Semantic="${item.semantic}" Item:Mime="image/jpeg"${length}/>` +
      '</rdf:li>'
    );
  });
  return `<Container:Directory><rdf:Seq>${entries.join('')}</rdf:Seq></Container:Directory>`;
}

/**
 * A complete XMP APP1 payload (identifier included) holding only the given
 * gain map properties and directory, in the layout libultrahdr writes and
 * Skia, libultrahdr and ImageIO read; null when there is nothing to keep.
 */
export function serializeGainMapXmp(
  properties: readonly GainMapXmpProperty[],
  directory: readonly OutputDirectoryItem[] | null
): Buffer | null {
  if (!properties.length && !directory) return null;
  const used = new Set(properties.map((property) => property.spec.ns));
  if (directory) {
    used.add(CONTAINER_NS);
    used.add(CONTAINER_ITEM_NS);
  }
  const namespaces = NAMESPACE_PREFIXES.filter(([, ns]) => used.has(ns))
    .map(([prefix, ns]) => ` xmlns:${prefix}="${ns}"`)
    .join('');
  const attributes = properties
    .filter(isAttributeProperty)
    .map(
      (property) =>
        ` ${property.spec.prefix}:${property.spec.name}="${escapeXml(
          property.value as string
        )}"`
    )
    .join('');
  const elements = properties
    .filter((property) => !isAttributeProperty(property))
    .map(propertyXml)
    .join('');
  const xml =
    `<x:xmpmeta xmlns:x="${X_NS}"><rdf:RDF xmlns:rdf="${RDF_NS}">` +
    `<rdf:Description rdf:about=""${namespaces}${attributes}>` +
    `${elements}${directory ? directoryXml(directory) : ''}` +
    '</rdf:Description></rdf:RDF></x:xmpmeta>';
  return Buffer.concat([XMP_SIGNATURE, Buffer.from(xml, 'utf8')]);
}
