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
import { Readable, Transform } from 'node:stream';
import { TextDecoder } from 'node:util';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import {
  getFileExtension,
  slugifyBaseName
} from '@/api/media/sanitize-file-name';
import { Time } from '@/time';

const csvParser = require('csv-parser');

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_CSV_BYTES = 50 * 1024 * 1024;
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
  '/Encrypt',
  '/ObjStm'
];

function formatByteLimit(byteLimit: number): string {
  return byteLimit.toLocaleString();
}

class ContentViolationError extends Error {}

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
    if (attachment.status !== AttachmentStatus.VERIFYING) {
      this.logger.info(
        `Skipping attachment ${attachmentId} processing because status is ${attachment.status}`
      );
      return;
    }
    const processingAt = Time.currentMillis();
    const transitioned = await this.attachmentsDb.transitionAttachmentStatus({
      id: attachmentId,
      fromStatus: AttachmentStatus.VERIFYING,
      toStatus: AttachmentStatus.PROCESSING,
      updatedAt: processingAt
    });
    if (!transitioned) {
      this.logger.info(
        `Skipping attachment ${attachmentId} processing because another worker claimed it`
      );
      return;
    }
    await this.statusNotifier.notifyStatusTransition({
      ...attachment,
      status: AttachmentStatus.PROCESSING,
      updated_at: processingAt
    });

    try {
      const fileBuffer = await this.downloadFromS3(attachment);
      const detectedMime = await this.detectMimeType(fileBuffer, attachment);

      let finalBuffer: Buffer;
      let finalMimeType: string;
      if (attachment.kind === AttachmentKind.PDF) {
        finalBuffer = this.validatePdf(fileBuffer);
        finalMimeType = 'application/pdf';
      } else {
        finalBuffer = await this.createSafeCsv(fileBuffer);
        finalMimeType = 'text/csv';
      }
      const sha256 = createHash('sha256').update(finalBuffer).digest('hex');
      const sizeBytes = finalBuffer.byteLength;

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
        verdict: 'VALIDATED_FOR_PUBLIC_IPFS',
        ipfs_cid: upload.cid,
        ipfs_url: upload.files[publishedFileName] ?? upload.url,
        status: AttachmentStatus.READY,
        error_reason: null,
        updated_at: Time.currentMillis()
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
      const status = this.isContentViolationError(error)
        ? AttachmentStatus.BLOCKED
        : AttachmentStatus.VERIFYING;
      const blockedPatch = {
        status,
        error_reason: reason,
        updated_at: Time.currentMillis()
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

  private async downloadFromS3(attachment: AttachmentEntity): Promise<Buffer> {
    const bucket = attachment.original_bucket!;
    const key = attachment.original_key!;
    const maxBytes = this.getMaxBytes(attachment.kind);
    const response = await getS3().send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
    if (!response.Body) {
      throw new Error(`Attachment object ${bucket}/${key} has no body`);
    }
    if (
      typeof response.ContentLength === 'number' &&
      response.ContentLength > maxBytes
    ) {
      throw new ContentViolationError(
        `${attachment.kind} exceeds the ${formatByteLimit(maxBytes)} byte limit`
      );
    }
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    for await (const chunk of response.Body as any) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.byteLength;
      if (bytesRead > maxBytes) {
        throw new ContentViolationError(
          `${attachment.kind} exceeds the ${formatByteLimit(maxBytes)} byte limit`
        );
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  private async detectMimeType(
    fileBuffer: Buffer,
    attachment: AttachmentEntity
  ): Promise<string> {
    if (attachment.kind === AttachmentKind.PDF) {
      if (!fileBuffer.slice(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new ContentViolationError(
          'Uploaded file does not have a valid PDF signature'
        );
      }
      return 'application/pdf';
    }

    const detected = await fileTypeFromBuffer(fileBuffer);
    if (detected?.mime) {
      throw new ContentViolationError(
        `CSV attachment appears to be binary (${detected.mime})`
      );
    }
    return 'text/csv';
  }

  private validatePdf(fileBuffer: Buffer): Buffer {
    const sizeBytes = fileBuffer.byteLength;
    if (sizeBytes > MAX_PDF_BYTES) {
      throw new ContentViolationError(
        `PDF exceeds the ${formatByteLimit(MAX_PDF_BYTES)} byte limit`
      );
    }
    const text = this.normalizePdfText(fileBuffer);
    for (const marker of PDF_BLOCKLIST_MARKERS) {
      if (text.includes(marker.toLowerCase())) {
        throw new ContentViolationError(
          `PDF contains blocked feature ${marker}`
        );
      }
    }
    const pageCount = text.match(/\/type\s*\/page\b/g)?.length ?? 0;
    if (pageCount > MAX_PDF_PAGES) {
      throw new ContentViolationError(
        `PDF exceeds the ${MAX_PDF_PAGES} page limit`
      );
    }
    return fileBuffer;
  }

  private async createSafeCsv(fileBuffer: Buffer): Promise<Buffer> {
    const sizeBytes = fileBuffer.byteLength;
    if (sizeBytes > MAX_CSV_BYTES) {
      throw new ContentViolationError(
        `CSV exceeds the ${formatByteLimit(MAX_CSV_BYTES)} byte limit`
      );
    }
    return await this.serializeSafeCsvRows(fileBuffer);
  }

  private async serializeSafeCsvRows(fileBuffer: Buffer): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const outputChunks: Buffer[] = [];
      let rowCount = 0;

      Readable.from([fileBuffer])
        .pipe(this.createCsvInputValidator())
        .pipe(csvParser({ headers: false, maxRowBytes: MAX_CSV_LINE_LENGTH }))
        .on('data', (row: Record<string, string>) => {
          rowCount++;
          if (rowCount > MAX_CSV_ROWS) {
            reject(
              new ContentViolationError(
                `CSV exceeds the ${MAX_CSV_ROWS} row limit`
              )
            );
            return;
          }
          const cells = Object.keys(row)
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => row[key] ?? '');
          if (cells.length > MAX_CSV_COLUMNS) {
            reject(
              new ContentViolationError(
                `CSV exceeds the ${MAX_CSV_COLUMNS} column limit`
              )
            );
            return;
          }
          if (cells.some((cell) => cell.length > MAX_CSV_CELL_LENGTH)) {
            reject(
              new ContentViolationError(
                `CSV exceeds the ${MAX_CSV_CELL_LENGTH} cell limit`
              )
            );
            return;
          }
          outputChunks.push(
            Buffer.from(
              `${cells.map((cell) => this.serializeSafeCsvCell(cell)).join(',')}\n`,
              'utf8'
            )
          );
        })
        .on('error', (error: Error) => {
          if (error.message.includes('Row exceeds the maximum size')) {
            reject(
              new ContentViolationError('CSV contains an excessively long line')
            );
            return;
          }
          reject(error);
        })
        .on('end', () => {
          if (outputChunks.length === 0) {
            resolve(Buffer.alloc(0));
            return;
          }
          outputChunks[outputChunks.length - 1] = Buffer.from(
            outputChunks[outputChunks.length - 1].toString('utf8').slice(0, -1),
            'utf8'
          );
          resolve(Buffer.concat(outputChunks));
        });
    });
  }

  private createCsvInputValidator(): Transform {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (chunk.includes(0)) {
          callback(new ContentViolationError('CSV contains NUL bytes'));
          return;
        }
        try {
          decoder.decode(chunk, { stream: true });
          callback(null, chunk);
        } catch {
          callback(new ContentViolationError('CSV must be valid UTF-8'));
        }
      },
      flush(callback) {
        try {
          decoder.decode();
          callback();
        } catch {
          callback(new ContentViolationError('CSV must be valid UTF-8'));
        }
      }
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

  private getMaxBytes(attachmentKind: AttachmentKind): number {
    return attachmentKind === AttachmentKind.PDF
      ? MAX_PDF_BYTES
      : MAX_CSV_BYTES;
  }

  private isContentViolationError(error: unknown): boolean {
    return error instanceof ContentViolationError;
  }

  private normalizePdfText(fileBuffer: Buffer): string {
    return fileBuffer
      .toString('latin1')
      .replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16))
      )
      .toLowerCase();
  }

  private getPublishedFileName({
    originalFileName,
    attachmentKind
  }: {
    originalFileName: string;
    attachmentKind: AttachmentKind;
  }): string {
    const extension = attachmentKind === AttachmentKind.PDF ? '.pdf' : '.csv';
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
      verdict: 'VALIDATED_FOR_PUBLIC_IPFS'
    };
  }
}

export const attachmentsProcessingService = new AttachmentsProcessingService(
  attachmentsDb,
  ipfsFileUploader,
  attachmentsStatusNotifier
);
