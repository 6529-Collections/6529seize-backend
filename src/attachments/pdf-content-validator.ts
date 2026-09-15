import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFParser,
  PDFStream
} from 'pdf-lib';

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const BLOCKED_MARKERS = [
  '/JS',
  '/JavaScript',
  '/OpenAction',
  '/AA',
  '/Launch',
  '/SubmitForm',
  '/EmbeddedFile',
  '/RichMedia',
  '/XFA',
  '/Encrypt'
];

/** Shared website/documentation policy. Never replace an archival original with the returned derivative. */
export class PdfContentViolationError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function normalizedText(bytes: Buffer): string {
  return bytes
    .toString('latin1')
    .replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .toLowerCase();
}

function checkSize(bytes: Buffer): void {
  if (bytes.byteLength > MAX_PDF_BYTES)
    throw new PdfContentViolationError(
      `PDF exceeds the ${MAX_PDF_BYTES.toLocaleString()} byte limit`
    );
}

const blockedNames = new Map(
  BLOCKED_MARKERS.map((marker) => [marker.slice(1).toLowerCase(), marker])
);

function checkName(object: PDFName): void {
  // decodeText expands name bytes as function arguments in the pinned library.
  if (object.asString().length > 4096)
    throw new PdfContentViolationError('PDF name exceeds the validation limit');
  const name = object.decodeText();
  // pdf-lib decodes only uppercase hex in source names. Remaining lowercase
  // escapes are ambiguous with literal names and cannot be trusted structurally
  // (including names such as ObjStm). Refuse them rather than reinterpret bytes.
  const ambiguous = /#(?:[a-f][0-9a-fA-F]|[0-9A-Fa-f][a-f])/.test(name);
  const candidate = ambiguous
    ? name.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16))
      )
    : name;
  const marker = blockedNames.get(candidate.toLowerCase());
  if (marker)
    throw new PdfContentViolationError(
      `PDF contains blocked feature ${marker}`
    );
  if (ambiguous)
    throw new PdfContentViolationError(
      'PDF contains an unsupported escaped name'
    );
}

/** Inspect PDF names, including decoded object streams, never image/content bytes or literal strings. */
function checkObjects(document: PDFDocument): void {
  const pending = document.context
    .enumerateIndirectObjects()
    .map(([, object]) => object);
  const seen = new Set<PDFObject>();
  while (pending.length) {
    const object = pending.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);
    if (object instanceof PDFName) {
      checkName(object);
    } else if (object instanceof PDFStream) {
      pending.push(object.dict);
    } else if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) pending.push(key, value);
    } else if (object instanceof PDFArray) {
      for (let index = 0; index < object.size(); index++)
        pending.push(object.get(index));
    }
  }
}

/** The parser consumes ObjStm containers before exposing its context. Observe the public parse hook. */
class ObjectStreamDetector extends PDFParser {
  hasObjectStreams = false;

  override parseObject(): PDFObject {
    const object = super.parseObject();
    if (
      object instanceof PDFStream &&
      object.dict.lookup(PDFName.of('Type')) === PDFName.of('ObjStm')
    )
      this.hasObjectStreams = true;
    return object;
  }
}

async function hasObjectStreams(bytes: Buffer): Promise<boolean> {
  // This is only a cheap candidate filter; the parser makes the structural decision.
  if (!normalizedText(bytes).includes('/objstm')) return false;
  const parser = new ObjectStreamDetector(bytes, 100, true);
  try {
    await parser.parseDocument();
  } catch {
    throw new PdfContentViolationError('PDF could not be parsed safely');
  }
  return parser.hasObjectStreams;
}

export async function validatePdfContent(original: Buffer): Promise<{
  pageCount: number;
  displayBytes: Buffer;
  normalized: boolean;
}> {
  if (!original.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new PdfContentViolationError(
      'Uploaded file does not have a valid PDF signature'
    );
  checkSize(original);
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(original, {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: true
    });
  } catch (error) {
    throw new PdfContentViolationError(
      error instanceof EncryptedPDFError
        ? 'Encrypted PDFs are not supported'
        : 'PDF could not be parsed safely'
    );
  }
  checkObjects(document);
  let pageCount: number;
  try {
    pageCount = document.getPageCount();
  } catch {
    throw new PdfContentViolationError('PDF could not be parsed safely');
  }
  if (!pageCount)
    throw new PdfContentViolationError('PDF must contain at least one page');
  if (pageCount > MAX_PDF_PAGES)
    throw new PdfContentViolationError(
      `PDF exceeds the ${MAX_PDF_PAGES} page limit`
    );
  if (!(await hasObjectStreams(original)))
    return { pageCount, displayBytes: original, normalized: false };
  let displayBytes: Buffer;
  try {
    displayBytes = Buffer.from(
      await document.save({ useObjectStreams: false })
    );
  } catch {
    throw new PdfContentViolationError(
      'PDF object streams could not be normalized safely'
    );
  }
  checkSize(displayBytes);
  if (await hasObjectStreams(displayBytes))
    throw new PdfContentViolationError(
      'PDF object streams could not be normalized safely'
    );
  return { pageCount, displayBytes, normalized: true };
}
