import { EncryptedPDFError, PDFDocument } from 'pdf-lib';

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

function checkBytes(bytes: Buffer): string {
  if (bytes.byteLength > MAX_PDF_BYTES)
    throw new PdfContentViolationError(
      `PDF exceeds the ${MAX_PDF_BYTES.toLocaleString()} byte limit`
    );
  const text = normalizedText(bytes);
  for (const marker of BLOCKED_MARKERS) {
    if (text.includes(marker.toLowerCase()))
      throw new PdfContentViolationError(
        `PDF contains blocked feature ${marker}`
      );
  }
  return text;
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
  const text = checkBytes(original);
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(original, {
      ignoreEncryption: false,
      updateMetadata: false
    });
  } catch (error) {
    throw new PdfContentViolationError(
      error instanceof EncryptedPDFError
        ? 'Encrypted PDFs are not supported'
        : 'PDF could not be parsed safely'
    );
  }
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
  if (!text.includes('/objstm'))
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
  if (checkBytes(displayBytes).includes('/objstm'))
    throw new PdfContentViolationError(
      'PDF object streams could not be normalized safely'
    );
  return { pageCount, displayBytes, normalized: true };
}
