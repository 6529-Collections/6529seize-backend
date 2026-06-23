import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { AttachmentsProcessingService } from './attachments-processing.service';
import { AttachmentKind } from '@/entities/IAttachment';

type ValidatePdf = (fileBuffer: Buffer) => Promise<Buffer>;
type DetectMimeType = (
  fileBuffer: Buffer,
  attachment: { kind: AttachmentKind }
) => Promise<string>;

describe('AttachmentsProcessingService PDF validation', () => {
  const service = new AttachmentsProcessingService(
    {} as never,
    {} as never,
    {} as never
  );
  const validatePdfMethod = Reflect.get(service, 'validatePdf') as ValidatePdf;
  const detectMimeTypeMethod = Reflect.get(
    service,
    'detectMimeType'
  ) as DetectMimeType;

  async function createPdf(pageCount: number): Promise<Buffer> {
    const document = await PDFDocument.create();
    for (let index = 0; index < pageCount; index++) {
      document.addPage([100, 100]);
    }
    return Buffer.from(await document.save({ useObjectStreams: false }));
  }

  async function createPdfWithObjectStreams(): Promise<Buffer> {
    const document = await PDFDocument.create();
    const page = document.addPage([200, 120]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('object stream smoke', {
      x: 20,
      y: 70,
      size: 12,
      font,
      color: rgb(0, 0, 0)
    });
    return Buffer.from(await document.save());
  }

  async function validatePdf(fileBuffer: Buffer): Promise<Buffer> {
    return await validatePdfMethod.call(service, fileBuffer);
  }

  async function detectPdfMime(fileBuffer: Buffer): Promise<string> {
    return await detectMimeTypeMethod.call(service, fileBuffer, {
      kind: AttachmentKind.PDF
    });
  }

  it('accepts a parseable PDF', async () => {
    const fileBuffer = await createPdf(1);

    await expect(validatePdf(fileBuffer)).resolves.toBe(fileBuffer);
  });

  it('accepts and normalizes parseable PDFs with object streams', async () => {
    const fileBuffer = await createPdfWithObjectStreams();
    // pdf-lib currently emits object streams by default for this document shape;
    // that mirrors the staging compatibility failure this test guards.
    expect(fileBuffer.toString('latin1').toLowerCase()).toContain('/objstm');

    const validated = await validatePdf(fileBuffer);

    expect(validated).not.toBe(fileBuffer);
    expect(validated.toString('latin1').toLowerCase()).not.toContain('/objstm');
    await expect(PDFDocument.load(validated)).resolves.toBeDefined();
  });

  it('rejects when object stream normalization fails', async () => {
    const fileBuffer = await createPdfWithObjectStreams();
    const saveSpy = jest
      .spyOn(PDFDocument.prototype, 'save')
      .mockRejectedValueOnce(new Error('save failed'));

    try {
      await expect(validatePdf(fileBuffer)).rejects.toThrow(
        'PDF object streams could not be normalized safely'
      );
    } finally {
      saveSpy.mockRestore();
    }
  });

  it('rejects when object streams survive normalization', async () => {
    const fileBuffer = await createPdfWithObjectStreams();
    const saveSpy = jest
      .spyOn(PDFDocument.prototype, 'save')
      .mockResolvedValueOnce(fileBuffer);

    try {
      await expect(validatePdf(fileBuffer)).rejects.toThrow(
        'PDF object streams could not be normalized safely'
      );
    } finally {
      saveSpy.mockRestore();
    }
  });

  it('rejects malformed PDFs even when the signature is present', async () => {
    const fileBuffer = Buffer.from('%PDF-1.7\nnot a parseable document');

    await expect(validatePdf(fileBuffer)).rejects.toThrow(
      'PDF could not be parsed safely'
    );
  });

  it('rejects files with an invalid PDF signature', async () => {
    await expect(detectPdfMime(Buffer.from('not a PDF'))).rejects.toThrow(
      'Uploaded file does not have a valid PDF signature'
    );
  });

  it('keeps blocking risky PDF markers before publishing', async () => {
    const fileBuffer = Buffer.concat([
      await createPdf(1),
      Buffer.from('\n/JavaScript')
    ]);

    await expect(validatePdf(fileBuffer)).rejects.toThrow(
      'PDF contains blocked feature /JavaScript'
    );
  });

  it('rejects PDFs over the page limit', async () => {
    const fileBuffer = await createPdf(101);

    await expect(validatePdf(fileBuffer)).rejects.toThrow(
      'PDF exceeds the 100 page limit'
    );
  });
});
