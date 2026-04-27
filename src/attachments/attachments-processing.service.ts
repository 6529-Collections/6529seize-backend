import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getS3 } from '@/s3.client';
import { attachmentsDb, AttachmentsDb } from '@/attachments/attachments.db';
import {
  AttachmentEntity,
  AttachmentKind,
  AttachmentStatus
} from '@/entities/IAttachment';
import {
  ipfsFileUploader,
  IpfsFileUploader
} from '@/attachments/ipfs-file-uploader';
import {
  attachmentsStatusNotifier,
  AttachmentsStatusNotifier
} from '@/attachments/attachments-status-notifier';
import { Logger } from '@/logging';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import {
  getFileExtension,
  slugifyBaseName
} from '@/api/media/sanitize-file-name';

const csvParser = require('csv-parser');
const fileType = require('file-type');

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_CSV_ROWS = 100_000;
const MAX_CSV_COLUMNS = 256;
const MAX_CSV_CELL_LENGTH = 32 * 1024;
const MAX_CSV_LINE_LENGTH = 1024 * 1024;
const DANGEROUS_CSV_PREFIX =
  /^[\uFEFF\s]*[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/;
const PDF_BLOCKLIST_MARKERS = [
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

export class AttachmentsProcessingService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly attachmentsDb: AttachmentsDb,
    private readonly ipfsUploader: IpfsFileUploader,
    private readonly statusNotifier: AttachmentsStatusNotifier
  ) {}

  public async processAttachment(attachmentId: string): Promise<void> {
    const attachment =
      await this.attachmentsDb.findAttachmentById(attachmentId);
    if (!attachment) {
      throw new Error(`Attachment ${attachmentId} not found`);
    }
    if (!attachment.original_bucket || !attachment.original_key) {
      throw new Error(`Attachment ${attachmentId} is missing original storage`);
    }
    await this.attachmentsDb.updateAttachment({
      id: attachmentId,
      patch: {
        status: AttachmentStatus.PROCESSING,
        updated_at: Date.now()
      }
    });
    await this.statusNotifier.notifyStatusTransition({
      ...attachment,
      status: AttachmentStatus.PROCESSING,
      updated_at: Date.now()
    });

    try {
      const fileBuffer = await this.downloadFromS3(
        attachment.original_bucket,
        attachment.original_key
      );
      const detectedMime = await this.detectMimeType(fileBuffer, attachment);
      const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
      const sizeBytes = fileBuffer.byteLength;

      let finalBuffer: Buffer;
      let finalMimeType: string;
      if (attachment.kind === AttachmentKind.PDF) {
        finalBuffer = this.validatePdf(fileBuffer, sizeBytes);
        finalMimeType = 'application/pdf';
      } else {
        finalBuffer = await this.createSafeCsv(fileBuffer, sizeBytes);
        finalMimeType = 'text/csv';
      }

      const publishedFileName = this.getPublishedFileName({
        originalFileName: attachment.original_file_name,
        attachmentKind: attachment.kind
      });
      const metadata = this.buildPublicMetadata({
        attachment,
        publishedFileName,
        detectedMime,
        finalMimeType,
        sha256,
        sizeBytes
      });
      const upload = await this.ipfsUploader.uploadDirectory({
        files: [
          {
            fileName: publishedFileName,
            fileBuffer: finalBuffer,
            contentType: finalMimeType
          },
          {
            fileName: 'metadata.json',
            fileBuffer: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'),
            contentType: 'application/json'
          }
        ]
      });

      const readyPatch = {
        detected_mime: detectedMime,
        size_bytes: sizeBytes,
        sha256,
        verdict: 'SAFE_FOR_PUBLIC_IPFS',
        ipfs_cid: upload.cid,
        ipfs_url: upload.files[publishedFileName] ?? upload.url,
        status: AttachmentStatus.READY,
        error_reason: null,
        updated_at: Date.now()
      };
      await this.attachmentsDb.updateAttachment({
        id: attachment.id,
        patch: readyPatch
      });
      await this.statusNotifier.notifyStatusTransition({
        ...attachment,
        ...readyPatch
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Attachment processing failed';
      this.logger.error(
        `Attachment processing failed ${attachmentId}: ${reason}`
      );
      const blockedPatch = {
        status: AttachmentStatus.BLOCKED,
        error_reason: reason,
        updated_at: Date.now()
      };
      await this.attachmentsDb.updateAttachment({
        id: attachment.id,
        patch: blockedPatch
      });
      await this.statusNotifier.notifyStatusTransition({
        ...attachment,
        ...blockedPatch
      });
      throw error;
    }
  }

  private async downloadFromS3(bucket: string, key: string): Promise<Buffer> {
    const response = await getS3().send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
    if (!response.Body) {
      throw new Error(`Attachment object ${bucket}/${key} has no body`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private async detectMimeType(
    fileBuffer: Buffer,
    attachment: AttachmentEntity
  ): Promise<string> {
    if (attachment.kind === AttachmentKind.PDF) {
      if (!fileBuffer.slice(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new Error('Uploaded file does not have a valid PDF signature');
      }
      return 'application/pdf';
    }

    const detected = await fileType.fromBuffer(fileBuffer);
    if (detected?.mime) {
      throw new Error(`CSV attachment appears to be binary (${detected.mime})`);
    }
    return 'text/csv';
  }

  private validatePdf(fileBuffer: Buffer, sizeBytes: number): Buffer {
    if (sizeBytes > MAX_PDF_BYTES) {
      throw new Error(`PDF exceeds the ${MAX_PDF_BYTES} byte limit`);
    }
    const text = fileBuffer.toString('latin1');
    for (const marker of PDF_BLOCKLIST_MARKERS) {
      if (text.includes(marker)) {
        throw new Error(`PDF contains blocked feature ${marker}`);
      }
    }
    const pageCount = text.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
    if (pageCount > MAX_PDF_PAGES) {
      throw new Error(`PDF exceeds the ${MAX_PDF_PAGES} page limit`);
    }
    return fileBuffer;
  }

  private async createSafeCsv(
    fileBuffer: Buffer,
    sizeBytes: number
  ): Promise<Buffer> {
    if (sizeBytes > MAX_CSV_BYTES) {
      throw new Error(`CSV exceeds the ${MAX_CSV_BYTES} byte limit`);
    }
    if (fileBuffer.includes(0)) {
      throw new Error('CSV contains NUL bytes');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = decoder.decode(fileBuffer);
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.some((line: string) => line.length > MAX_CSV_LINE_LENGTH)) {
      throw new Error(`CSV contains an excessively long line`);
    }
    const rows = await this.parseCsvRows(text);
    if (rows.length > MAX_CSV_ROWS) {
      throw new Error(`CSV exceeds the ${MAX_CSV_ROWS} row limit`);
    }

    const serializedRows = rows.map((row) => {
      if (row.length > MAX_CSV_COLUMNS) {
        throw new Error(`CSV exceeds the ${MAX_CSV_COLUMNS} column limit`);
      }
      return row.map((cell) => this.serializeSafeCsvCell(cell)).join(',');
    });

    return Buffer.from(serializedRows.join('\n'), 'utf8');
  }

  private async parseCsvRows(text: string): Promise<string[][]> {
    return await new Promise<string[][]>((resolve, reject) => {
      const rows: string[][] = [];
      Readable.from([text])
        .pipe(csvParser({ headers: false }))
        .on('data', (row: Record<string, string>) => {
          const cells = Object.keys(row)
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => row[key] ?? '');
          if (cells.some((cell) => cell.length > MAX_CSV_CELL_LENGTH)) {
            reject(
              new Error(`CSV exceeds the ${MAX_CSV_CELL_LENGTH} cell limit`)
            );
            return;
          }
          rows.push(cells);
        })
        .on('error', reject)
        .on('end', () => resolve(rows));
    });
  }

  private serializeSafeCsvCell(value: string): string {
    const cleaned = value
      .replace(/\0/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    const safe = DANGEROUS_CSV_PREFIX.test(cleaned) ? `\t${cleaned}` : cleaned;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  private getPublishedFileName({
    originalFileName,
    attachmentKind
  }: {
    originalFileName: string;
    attachmentKind: AttachmentKind;
  }): string {
    const extension =
      getFileExtension(originalFileName).toLowerCase() ||
      (attachmentKind === AttachmentKind.PDF ? '.pdf' : '.csv');
    const baseName = originalFileName.slice(
      0,
      originalFileName.length - getFileExtension(originalFileName).length
    );
    const slug = slugifyBaseName(baseName) || 'file';
    return `${slug}${extension}`;
  }

  private buildPublicMetadata({
    attachment,
    publishedFileName,
    detectedMime,
    finalMimeType,
    sha256,
    sizeBytes
  }: {
    attachment: AttachmentEntity;
    publishedFileName: string;
    detectedMime: string;
    finalMimeType: string;
    sha256: string;
    sizeBytes: number;
  }) {
    return {
      attachment_id: attachment.id,
      owner_profile_id: attachment.owner_profile_id,
      created_at: attachment.created_at,
      kind: attachment.kind,
      original_file_name: attachment.original_file_name,
      published_file_name: publishedFileName,
      declared_mime: attachment.declared_mime,
      detected_mime: detectedMime,
      published_mime: finalMimeType,
      sha256,
      size_bytes: sizeBytes,
      verdict: 'SAFE_FOR_PUBLIC_IPFS'
    };
  }
}

export const attachmentsProcessingService = new AttachmentsProcessingService(
  attachmentsDb,
  ipfsFileUploader,
  attachmentsStatusNotifier
);
