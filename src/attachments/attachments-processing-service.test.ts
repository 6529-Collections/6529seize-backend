import { PDFDocument, PDFName, PDFRef, rgb, StandardFonts } from 'pdf-lib';
import { AttachmentsProcessingService } from './attachments-processing.service';
import { AttachmentKind } from '@/entities/IAttachment';
import { validatePdfContent } from '@/attachments/pdf-content-validator';

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

  it('normalizes an indirect object-stream Type without changing the archival original', async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const type = document.context.register(PDFName.of('ObjStm'));
    document.context.register(
      document.context.stream('100 0 << /Synthetic 1 >>', {
        Type: type,
        N: 1,
        First: 6
      })
    );
    const original = Buffer.from(
      await document.save({ useObjectStreams: false })
    );
    const before = Buffer.from(original);
    const parsed = await PDFDocument.load(original);
    expect(parsed.context.lookup(PDFRef.of(100))?.toString()).toContain(
      '/Synthetic 1'
    );

    const result = await validatePdfContent(original);

    expect(result.normalized).toBe(true);
    expect(result.displayBytes).not.toEqual(original);
    expect(original).toEqual(before);
    const normalized = await PDFDocument.load(result.displayBytes);
    expect(normalized.context.lookup(PDFRef.of(100))?.toString()).toContain(
      '/Synthetic 1'
    );
    expect((await validatePdfContent(result.displayBytes)).normalized).toBe(
      false
    );
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

  it.each([false, true])(
    'blocks a structurally valid JavaScript action (object streams %s)',
    async (useObjectStreams) => {
      const document = await PDFDocument.create();
      document.addPage([100, 100]);
      document.addJavaScript('blocked-action', 'app.alert("test");');
      const fileBuffer = Buffer.from(await document.save({ useObjectStreams }));
      await expect(PDFDocument.load(fileBuffer)).resolves.toBeDefined();

      await expect(validatePdf(fileBuffer)).rejects.toThrow(
        /PDF contains blocked feature \/(JS|JavaScript)/
      );
    }
  );

  it.each([false, true])(
    'accepts feature-like image bytes, comments, literal strings and name prefixes (object streams %s)',
    async (useObjectStreams) => {
      const document = await PDFDocument.create();
      const page = document.addPage([100, 100]);
      const inert = '/JS /JavaScript /OpenAction /AA /Launch /ObjStm /#4a#53';
      document.setSubject(inert);
      document.catalog.set(
        PDFName.of('JSomething'),
        PDFName.of('JavaScriptExample')
      );
      const contents = document.context.register(
        document.context.stream(`q\n% ${inert}\nQ\n`)
      );
      page.node.addContentStream(contents);
      const image = document.context.register(
        document.context.stream(Buffer.from(inert), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: inert.length,
          Height: 1,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8
        })
      );
      page.node.set(
        PDFName.of('Resources'),
        document.context.obj({ XObject: { Image: image } })
      );
      const fileBuffer = Buffer.from(await document.save({ useObjectStreams }));
      const validated = await validatePdf(fileBuffer);
      const reloaded = await PDFDocument.load(validated);
      expect(reloaded.getSubject()).toBe(inert);
      expect(reloaded.getPageCount()).toBe(1);
      if (!useObjectStreams) expect(validated).toBe(fileBuffer);
    }
  );

  it.each(['#4a#53', '#4A#53'])(
    'blocks hexadecimal-escaped PDF name %s at a dictionary boundary',
    async (name) => {
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
        `<< /${name} (app.alert\\(1\\)) >>`
      ];
      let pdf = '%PDF-1.7\n';
      const offsets = [0];
      objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      });
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
      pdf += offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('');
      pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      const bytes = Buffer.from(pdf);
      await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
      await expect(validatePdf(bytes)).rejects.toThrow(
        'PDF contains blocked feature /JS'
      );
    }
  );
  it('refuses ambiguous structural name escapes instead of skipping their stream contents', async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    document.context.register(
      document.context.stream('opaque content', {
        Type: PDFName.of('#234fbjStm')
      })
    );
    const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
    await expect(validatePdf(bytes)).rejects.toThrow(
      'PDF contains an unsupported escaped name'
    );
  });
  it('rejects oversized PDF names as validation failures before name decoding can exhaust arguments', async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    document.catalog.set(PDFName.of('A'.repeat(200_000)), PDFName.of('Value'));
    const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
    await expect(validatePdf(bytes)).rejects.toThrow(
      'PDF name exceeds the validation limit'
    );
  });

  it('rejects PDFs over the page limit', async () => {
    const fileBuffer = await createPdf(101);

    await expect(validatePdf(fileBuffer)).rejects.toThrow(
      'PDF exceeds the 100 page limit'
    );
  });
});
