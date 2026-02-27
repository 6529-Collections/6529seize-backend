import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import fetch, { Response } from 'node-fetch';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '@/env';
import { Logger } from '@/logging';
import { nftLinksDb, NftLinksDb } from '@/nft-links/nft-links.db';
import type { NormalizedNftCard } from '@/nft-links/types';
import type { RequestContext } from '@/request.context';
import { sqs, SQS } from '@/sqs';
import { Time } from '@/time';
import { NftLinkEntity } from '@/entities/INftLink';
import type {
  NftLinkMediaPreviewJobMessage,
  NftLinkMediaPreviewKind
} from '@/nft-links/nft-link-media-preview.types';

interface PreparedPreviewSource {
  readonly canonicalId: string;
  readonly sourceUrl: string;
  readonly sourceHash: string;
  readonly previewKind: NftLinkMediaPreviewKind;
  readonly sourceMediaKind: string | null;
}

interface DownloadedRemoteImage {
  readonly finalUrl: string;
  readonly bytes: Buffer;
  readonly contentType: string | null;
}

type ClassifiedMediaKind = 'image' | 'video' | 'html' | 'model' | 'unknown';
type MimeMediaKind = ClassifiedMediaKind | 'text' | 'json' | 'xml';

interface ClassifiedDownloadedMedia {
  readonly kind: ClassifiedMediaKind;
  readonly mimeType: string | null;
  readonly detector: 'mime' | 'bytes' | 'extension' | 'unknown';
}

interface RenderedPreview {
  readonly card: Buffer;
  readonly thumb: Buffer;
  readonly small: Buffer;
  readonly width: number | null;
  readonly height: number | null;
}

interface PinnedDnsResolution {
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
}

interface PathSegmentSanitizerState {
  sanitized: string;
  lastWasHyphen: boolean;
}

const PREVIEW_VARIANTS = Object.freeze([
  { name: 'thumb', width: 120, height: 120 },
  { name: 'small', width: 320, height: null as number | null },
  { name: 'card', width: 640, height: null as number | null }
]);

const FETCH_USER_AGENT = '6529-nft-link-media-preview/0.1';

export class NftLinkMediaPreviewService {
  private readonly logger = Logger.get(this.constructor.name);
  private s3Client: S3Client | null = null;
  private sharpModule: typeof import('sharp') | null = null;

  constructor(
    private readonly nftLinksDb: NftLinksDb,
    private readonly sqs: SQS
  ) {}

  public async onResolvedCard(
    card: NormalizedNftCard,
    ctx: RequestContext
  ): Promise<void> {
    const prepared = this.preparePreviewSourceFromCard(card);
    if (!prepared) {
      const sourceMediaKind = card.asset.media?.kind ?? 'unknown';
      await this.nftLinksDb.markMediaPreviewSkipped(
        {
          canonicalId: card.identifier.canonicalId,
          kind: this.toPreviewKind(sourceMediaKind),
          message: `No preview source available (media kind: ${sourceMediaKind})`
        },
        ctx
      );
      return;
    }

    const shouldQueue = await this.nftLinksDb.markMediaPreviewPendingIfNeeded(
      {
        canonicalId: prepared.canonicalId,
        sourceHash: prepared.sourceHash,
        kind: prepared.previewKind
      },
      ctx
    );
    if (!shouldQueue) {
      return;
    }

    const queueUrl = env.getStringOrNull('NFT_LINK_MEDIA_PREVIEW_SQS_QUEUE');
    if (!queueUrl) {
      this.logger.warn(
        `NFT_LINK_MEDIA_PREVIEW_SQS_QUEUE is not configured; preview for ${prepared.canonicalId} left in PENDING state`
      );
      return;
    }

    await this.sqs.send({
      queue: queueUrl,
      message: {
        canonicalId: prepared.canonicalId,
        sourceHash: prepared.sourceHash
      } satisfies NftLinkMediaPreviewJobMessage
    });
  }

  public async processQueueMessage(
    messageBody: string,
    ctx: RequestContext
  ): Promise<void> {
    const parsed = this.parseJobMessage(messageBody);
    if (!parsed) {
      return;
    }

    const lockTTL = Time.millis(
      env.getIntOrNull('NFT_LINK_MEDIA_PREVIEW_LOCK_TTL') ??
        Time.minutes(2).toMillis()
    );
    const lockedEntity = await this.nftLinksDb.lockMediaPreviewForProcessing(
      {
        canonicalId: parsed.canonicalId,
        expectedSourceHash: parsed.sourceHash ?? null,
        lockTTL
      },
      ctx
    );
    if (!lockedEntity) {
      this.logger.info(
        `No preview work acquired for ${parsed.canonicalId} (already processing/ready/stale message)`
      );
      return;
    }

    const prepared = this.preparePreviewSourceFromEntity(lockedEntity);
    if (!prepared) {
      await this.nftLinksDb.updateMediaPreviewWithFailure(
        {
          canonicalId: parsed.canonicalId,
          status: 'SKIPPED',
          message: `No preview source available in resolved NFT metadata`
        },
        ctx
      );
      return;
    }

    if (
      parsed.sourceHash &&
      prepared.sourceHash &&
      parsed.sourceHash !== prepared.sourceHash
    ) {
      this.logger.info(
        `Skipping stale preview job for ${parsed.canonicalId}: expected ${parsed.sourceHash}, current ${prepared.sourceHash}`
      );
      await this.nftLinksDb.updateMediaPreviewWithFailure(
        {
          canonicalId: parsed.canonicalId,
          status: 'FAILED',
          message: `Stale preview job source hash mismatch`
        },
        ctx
      );
      return;
    }

    try {
      const downloaded = await this.downloadRemoteImage(prepared.sourceUrl);
      const classified = this.classifyDownloadedMedia(downloaded);
      if (classified.kind === 'video') {
        const uploaded = await this.uploadVideoSource(prepared, downloaded);
        await this.nftLinksDb.updateMediaPreviewWithSuccess(
          {
            canonicalId: prepared.canonicalId,
            kind: 'video',
            sourceHash: prepared.sourceHash,
            cardUrl: uploaded.url,
            thumbUrl: uploaded.url,
            smallUrl: uploaded.url,
            width: null,
            height: null,
            mimeType: classified.mimeType,
            bytes: downloaded.bytes.length
          },
          ctx
        );
        this.logger.info(
          `Stored NFT link video preview source for ${prepared.canonicalId} at ${uploaded.key}`
        );
        return;
      }
      if (classified.kind !== 'image') {
        await this.nftLinksDb.updateMediaPreviewWithFailure(
          {
            canonicalId: prepared.canonicalId,
            status: 'SKIPPED',
            message: `Preview skipped for unsupported media (${classified.kind}, detector=${classified.detector}, mime=${classified.mimeType ?? 'unknown'})`
          },
          ctx
        );
        this.logger.info(
          `Skipped NFT link preview generation for ${prepared.canonicalId}: unsupported media (${classified.kind}, detector=${classified.detector}, mime=${classified.mimeType ?? 'unknown'})`
        );
        return;
      }
      const rendered = await this.renderPreviewVariants(downloaded.bytes);
      const uploadedUrls = await this.uploadPreviewVariants(
        prepared,
        downloaded,
        rendered
      );
      await this.nftLinksDb.updateMediaPreviewWithSuccess(
        {
          canonicalId: prepared.canonicalId,
          kind: 'image',
          sourceHash: prepared.sourceHash,
          cardUrl: uploadedUrls.cardUrl,
          thumbUrl: uploadedUrls.thumbUrl,
          smallUrl: uploadedUrls.smallUrl,
          width: rendered.width,
          height: rendered.height,
          mimeType: 'image/webp',
          bytes: downloaded.bytes.length
        },
        ctx
      );
      this.logger.info(
        `Generated NFT link previews for ${prepared.canonicalId} from ${downloaded.finalUrl}`
      );
    } catch (e: any) {
      const message = this.normalizeErrorMessage(e);
      await this.nftLinksDb.updateMediaPreviewWithFailure(
        {
          canonicalId: prepared.canonicalId,
          message
        },
        ctx
      );
      this.logger.error(
        `Failed to generate NFT link preview for ${prepared.canonicalId}`,
        e
      );
    }
  }

  private parseJobMessage(
    messageBody: string
  ): NftLinkMediaPreviewJobMessage | null {
    if (!messageBody) {
      this.logger.info(`Received empty preview job body`);
      return null;
    }
    try {
      const parsed = JSON.parse(messageBody) as NftLinkMediaPreviewJobMessage;
      if (!parsed?.canonicalId || typeof parsed.canonicalId !== 'string') {
        this.logger.info(`Preview job missing canonicalId; discarding`);
        return null;
      }
      return {
        canonicalId: parsed.canonicalId,
        sourceHash:
          typeof parsed.sourceHash === 'string' ? parsed.sourceHash : null
      };
    } catch {
      this.logger.info(`Failed to parse preview job body; discarding`);
      return null;
    }
  }

  private preparePreviewSourceFromCard(
    card: NormalizedNftCard
  ): PreparedPreviewSource | null {
    const selection = this.selectPreviewSource(card.asset.media, null);
    if (!selection) {
      return null;
    }
    return {
      canonicalId: card.identifier.canonicalId,
      sourceUrl: selection.sourceUrl,
      sourceHash: this.hashSourceUrl(selection.sourceUrl),
      previewKind: selection.previewKind,
      sourceMediaKind: selection.sourceMediaKind
    };
  }

  private preparePreviewSourceFromEntity(
    entity: NftLinkEntity
  ): PreparedPreviewSource | null {
    const selection = this.selectPreviewSource(
      entity.full_data?.asset?.media,
      entity.media_uri
    );
    if (!selection) {
      return null;
    }
    return {
      canonicalId: entity.canonical_id,
      sourceUrl: selection.sourceUrl,
      sourceHash: this.hashSourceUrl(selection.sourceUrl),
      previewKind: selection.previewKind,
      sourceMediaKind: selection.sourceMediaKind
    };
  }

  private selectPreviewSource(
    media: NormalizedNftCard['asset']['media'] | undefined,
    fallbackUrl: string | null
  ): {
    sourceUrl: string;
    previewKind: NftLinkMediaPreviewKind;
    sourceMediaKind: string | null;
  } | null {
    const sourceMediaKind = media?.kind ?? null;
    const sourceUrl =
      sourceMediaKind === 'animation' || sourceMediaKind === 'video'
        ? (media?.animationUrl ?? media?.imageUrl ?? fallbackUrl ?? null)
        : (media?.imageUrl ?? media?.animationUrl ?? fallbackUrl ?? null);
    if (!sourceUrl) {
      return null;
    }

    return {
      sourceUrl,
      previewKind: this.toPreviewKind(sourceMediaKind),
      sourceMediaKind
    };
  }

  private toPreviewKind(sourceKind?: string | null): NftLinkMediaPreviewKind {
    switch (sourceKind) {
      case 'image':
        return 'image';
      case 'video':
        return 'video';
      case 'animation':
        return 'animation';
      default:
        return 'unknown';
    }
  }

  private hashSourceUrl(url: string): string {
    return createHash('sha256').update(url).digest('hex');
  }

  private getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        region: 'eu-west-1'
      });
    }
    return this.s3Client;
  }

  private async uploadVideoSource(
    prepared: PreparedPreviewSource,
    downloaded: DownloadedRemoteImage
  ): Promise<{ url: string; key: string }> {
    const bucket = env.getStringOrThrow('S3_BUCKET');
    const fileServerUrl = this.trimTrailingSlashes(
      env.getStringOrThrow('FILE_SERVER_URL')
    );
    const canonicalHash = createHash('sha256')
      .update(prepared.canonicalId)
      .digest('hex')
      .slice(0, 24);
    const environmentPrefix = this.getPreviewEnvironmentPrefix();
    const mimeType = this.extractMimeType(downloaded.contentType);
    const extension = this.resolveVideoFileExtension(
      downloaded.finalUrl,
      mimeType
    );
    const key = `drops/nftlinkvideos/${environmentPrefix}/${canonicalHash}/${prepared.sourceHash}.${extension}`;

    await this.getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: downloaded.bytes,
        ContentType: mimeType ?? undefined,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: {
          source_url_sha256: prepared.sourceHash,
          source_host: this.safeHostTag(downloaded.finalUrl)
        }
      })
    );

    return {
      key,
      url: `${fileServerUrl}/${key}`
    };
  }

  private async uploadPreviewVariants(
    prepared: PreparedPreviewSource,
    downloaded: DownloadedRemoteImage,
    rendered: RenderedPreview
  ): Promise<{ cardUrl: string; thumbUrl: string; smallUrl: string }> {
    const bucket = env.getStringOrThrow('S3_BUCKET');
    const fileServerUrl = this.trimTrailingSlashes(
      env.getStringOrThrow('FILE_SERVER_URL')
    );
    const canonicalHash = createHash('sha256')
      .update(prepared.canonicalId)
      .digest('hex')
      .slice(0, 24);
    const environmentPrefix = this.getPreviewEnvironmentPrefix();
    const baseKey = `nft-link-previews/${environmentPrefix}/${canonicalHash}/${prepared.sourceHash}`;

    const thumbKey = `${baseKey}/thumb.webp`;
    const smallKey = `${baseKey}/small.webp`;
    const cardKey = `${baseKey}/card.webp`;

    await Promise.all([
      this.getS3Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: thumbKey,
          Body: rendered.thumb,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: {
            source_url_sha256: prepared.sourceHash,
            source_host: this.safeHostTag(downloaded.finalUrl)
          }
        })
      ),
      this.getS3Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: smallKey,
          Body: rendered.small,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: {
            source_url_sha256: prepared.sourceHash,
            source_host: this.safeHostTag(downloaded.finalUrl)
          }
        })
      ),
      this.getS3Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: cardKey,
          Body: rendered.card,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: {
            source_url_sha256: prepared.sourceHash,
            source_host: this.safeHostTag(downloaded.finalUrl)
          }
        })
      )
    ]);

    return {
      thumbUrl: `${fileServerUrl}/${thumbKey}`,
      smallUrl: `${fileServerUrl}/${smallKey}`,
      cardUrl: `${fileServerUrl}/${cardKey}`
    };
  }

  private getPreviewEnvironmentPrefix(): string {
    const raw =
      env.getStringOrNull('NFT_LINK_MEDIA_PREVIEW_S3_PREFIX') ??
      env.getStringOrNull('NODE_ENV') ??
      'default';
    return this.sanitizePathSegment(raw);
  }

  private sanitizePathSegment(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      return 'default';
    }
    const state: PathSegmentSanitizerState = {
      sanitized: '',
      lastWasHyphen: false
    };
    for (const ch of trimmed) {
      this.appendSanitizedPathSegmentChar(ch, state);
    }

    return this.trimTrailingHyphens(state.sanitized) || 'default';
  }

  private appendSanitizedPathSegmentChar(
    ch: string,
    state: PathSegmentSanitizerState
  ): void {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) {
      return;
    }

    if (this.isSafePathSegmentCodePoint(codePoint)) {
      if (ch !== '-') {
        state.lastWasHyphen = false;
        state.sanitized += ch;
        return;
      }
      if (!state.sanitized.length || state.lastWasHyphen) {
        return;
      }
      state.lastWasHyphen = true;
      state.sanitized += '-';
      return;
    }

    if (!state.sanitized.length || state.lastWasHyphen) {
      return;
    }
    state.lastWasHyphen = true;
    state.sanitized += '-';
  }

  private isSafePathSegmentCodePoint(codePoint: number): boolean {
    return (
      (codePoint >= 97 && codePoint <= 122) ||
      (codePoint >= 48 && codePoint <= 57) ||
      codePoint === 46 ||
      codePoint === 95 ||
      codePoint === 45
    );
  }

  private trimTrailingHyphens(value: string): string {
    let end = value.length;
    while (end > 0 && value.codePointAt(end - 1) === 45) {
      end--;
    }
    return end === value.length ? value : value.slice(0, end);
  }

  private trimTrailingSlashes(value: string): string {
    let end = value.length;
    while (end > 0 && value.codePointAt(end - 1) === 47) {
      end--;
    }
    return end === value.length ? value : value.slice(0, end);
  }

  private safeHostTag(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return 'unknown';
    }
  }

  private async renderPreviewVariants(
    sourceBytes: Buffer
  ): Promise<RenderedPreview> {
    const Sharp = this.getSharpModule();
    const limitInputPixels =
      env.getIntOrNull('NFT_LINK_MEDIA_PREVIEW_LIMIT_INPUT_PIXELS') ??
      1_000_000_000;
    const metadata = await Sharp(sourceBytes, {
      failOn: 'none',
      animated: false,
      limitInputPixels
    })
      .rotate()
      .metadata();
    const quality =
      env.getIntOrNull('NFT_LINK_MEDIA_PREVIEW_WEBP_QUALITY') ?? 82;

    const buffers = await Promise.all(
      PREVIEW_VARIANTS.map(async (variant) => {
        const output = await Sharp(sourceBytes, {
          failOn: 'none',
          animated: false,
          limitInputPixels
        })
          .rotate()
          .resize(variant.width, variant.height, {
            withoutEnlargement: true,
            fit: 'inside'
          })
          .webp({ quality })
          .toBuffer();
        return [variant.name, output] as const;
      })
    );

    const byName = buffers.reduce(
      (acc, [name, output]) => {
        acc[name] = output;
        return acc;
      },
      {} as Record<string, Buffer>
    );

    return {
      thumb: byName.thumb,
      small: byName.small,
      card: byName.card,
      width:
        typeof metadata.width === 'number' && Number.isFinite(metadata.width)
          ? metadata.width
          : null,
      height:
        typeof metadata.height === 'number' && Number.isFinite(metadata.height)
          ? metadata.height
          : null
    };
  }

  private getSharpModule(): typeof import('sharp') {
    if (!this.sharpModule) {
      try {
        // Lazy-load sharp so API startup (which imports enqueue-only logic)
        // does not require sharp/native binaries.
        this.sharpModule = require('sharp') as typeof import('sharp');
      } catch (e: any) {
        throw new Error(
          `Failed to load sharp in NFT link media preview processor: ${e?.message ?? e}`
        );
      }
    }
    return this.sharpModule;
  }

  private classifyDownloadedMedia(
    downloaded: DownloadedRemoteImage
  ): ClassifiedDownloadedMedia {
    const mimeType = this.extractMimeType(downloaded.contentType);
    const mimeKind = this.classifyMimeMediaKind(mimeType);
    const sniffedKind = this.sniffMediaKindFromBytes(downloaded.bytes);

    if (
      sniffedKind !== 'unknown' &&
      (mimeKind === 'unknown' ||
        mimeKind === 'text' ||
        mimeKind === 'json' ||
        mimeKind === 'xml' ||
        mimeKind !== sniffedKind)
    ) {
      return {
        kind: sniffedKind,
        mimeType,
        detector: 'bytes'
      };
    }

    if (
      mimeKind === 'image' ||
      mimeKind === 'video' ||
      mimeKind === 'html' ||
      mimeKind === 'model'
    ) {
      return {
        kind: mimeKind,
        mimeType,
        detector: 'mime'
      };
    }

    const pathExtension = this.extractPathExtension(downloaded.finalUrl);
    if (this.isKnownVideoExtension(pathExtension)) {
      return {
        kind: 'video',
        mimeType,
        detector: 'extension'
      };
    }

    return {
      kind: 'unknown',
      mimeType,
      detector: 'unknown'
    };
  }

  private classifyMimeMediaKind(mimeType: string | null): MimeMediaKind {
    if (!mimeType) {
      return 'unknown';
    }
    if (mimeType.startsWith('image/')) {
      return 'image';
    }
    if (mimeType.startsWith('video/')) {
      return 'video';
    }
    if (mimeType.startsWith('model/')) {
      return 'model';
    }
    switch (mimeType) {
      case 'text/html':
      case 'application/xhtml+xml':
        return 'html';
      case 'application/gltf-binary':
      case 'application/gltf+json':
        return 'model';
      case 'application/json':
        return 'json';
      case 'text/plain':
        return 'text';
      case 'application/xml':
      case 'text/xml':
        return 'xml';
      default:
        return 'unknown';
    }
  }

  private sniffMediaKindFromBytes(bytes: Buffer): ClassifiedMediaKind {
    if (!bytes.length) {
      return 'unknown';
    }

    if (
      this.startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
      this.startsWithBytes(bytes, [0xff, 0xd8, 0xff]) ||
      this.hasAsciiAt(bytes, 0, 'GIF87a') ||
      this.hasAsciiAt(bytes, 0, 'GIF89a') ||
      (this.hasAsciiAt(bytes, 0, 'RIFF') &&
        this.hasAsciiAt(bytes, 8, 'WEBP')) ||
      this.hasAsciiAt(bytes, 0, 'BM')
    ) {
      return 'image';
    }

    if (
      this.hasAsciiAt(bytes, 0, 'RIFF') &&
      this.hasAsciiAt(bytes, 8, 'AVI ')
    ) {
      return 'video';
    }

    if (
      this.startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]) &&
      this.bufferContainsAscii(bytes, 'webm')
    ) {
      return 'video';
    }

    if (this.hasAsciiAt(bytes, 0, 'glTF')) {
      return 'model';
    }

    const isoKind = this.sniffIsoBaseMediaKind(bytes);
    if (isoKind) {
      return isoKind;
    }

    const markupKind = this.looksLikeMarkupKind(bytes);
    if (markupKind) {
      return markupKind;
    }

    return 'unknown';
  }

  private sniffIsoBaseMediaKind(bytes: Buffer): 'image' | 'video' | null {
    if (!this.hasAsciiAt(bytes, 4, 'ftyp')) {
      return null;
    }

    const imageBrands = new Set([
      'avif',
      'avis',
      'heic',
      'heix',
      'hevc',
      'hevx',
      'mif1',
      'msf1'
    ]);
    const videoBrands = new Set([
      'isom',
      'iso2',
      'iso3',
      'iso4',
      'iso5',
      'iso6',
      'avc1',
      'hev1',
      'hvc1',
      'mp41',
      'mp42',
      'm4v ',
      'dash',
      'qt  ',
      '3gp4',
      '3gp5',
      '3g2a',
      '3g2b'
    ]);

    const brands: string[] = [];
    const maxOffset = Math.min(bytes.length - 4, 40);
    for (let offset = 8; offset <= maxOffset; offset += 4) {
      brands.push(bytes.subarray(offset, offset + 4).toString('ascii'));
    }

    for (const raw of brands) {
      const brand = raw.toLowerCase();
      if (imageBrands.has(brand)) {
        return 'image';
      }
    }
    for (const raw of brands) {
      const brand = raw.toLowerCase();
      if (videoBrands.has(brand) || brand.startsWith('mp4')) {
        return 'video';
      }
    }

    return null;
  }

  private looksLikeMarkupKind(bytes: Buffer): 'image' | 'html' | null {
    const head = bytes.subarray(0, Math.min(bytes.length, 4096));
    const text = head
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .trimStart();
    if (!text) {
      return null;
    }
    const lower = text.toLowerCase();

    if (
      lower.startsWith('<!doctype html') ||
      lower.startsWith('<html') ||
      lower.includes('<html')
    ) {
      return 'html';
    }

    if (lower.startsWith('<?xml') || lower.startsWith('<svg')) {
      return 'image';
    }

    return null;
  }

  private startsWithBytes(buffer: Buffer, bytes: number[]): boolean {
    if (buffer.length < bytes.length) {
      return false;
    }
    for (let i = 0; i < bytes.length; i++) {
      if (buffer[i] !== bytes[i]) {
        return false;
      }
    }
    return true;
  }

  private hasAsciiAt(
    buffer: Buffer,
    offset: number,
    expected: string
  ): boolean {
    const end = offset + expected.length;
    if (offset < 0 || end > buffer.length) {
      return false;
    }
    return buffer.subarray(offset, end).toString('ascii') === expected;
  }

  private bufferContainsAscii(
    buffer: Buffer,
    expected: string,
    maxBytes = 4096
  ): boolean {
    return buffer
      .subarray(0, Math.min(buffer.length, maxBytes))
      .toString('ascii')
      .toLowerCase()
      .includes(expected.toLowerCase());
  }

  private resolveVideoFileExtension(
    urlString: string,
    mimeType: string | null
  ): string {
    const mimeExtension = this.videoExtensionFromMimeType(mimeType);
    if (mimeExtension) {
      return mimeExtension;
    }
    const pathExtension = this.extractPathExtension(urlString);
    if (this.isKnownVideoExtension(pathExtension)) {
      return pathExtension;
    }
    return 'mp4';
  }

  private videoExtensionFromMimeType(mimeType: string | null): string | null {
    switch (mimeType) {
      case 'video/mp4':
        return 'mp4';
      case 'video/quicktime':
        return 'mov';
      case 'video/x-msvideo':
        return 'avi';
      case 'video/webm':
        return 'webm';
      default:
        return null;
    }
  }

  private extractPathExtension(urlString: string): string | null {
    try {
      const pathname = new URL(urlString).pathname ?? '';
      const lastSegment = pathname.split('/').pop() ?? '';
      const dotIndex = lastSegment.lastIndexOf('.');
      if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) {
        return null;
      }
      return lastSegment.slice(dotIndex + 1).toLowerCase();
    } catch {
      return null;
    }
  }

  private isSafeFileExtension(extension: string | null): extension is string {
    return !!extension && /^[a-z0-9]{1,12}$/i.test(extension);
  }

  private isKnownVideoExtension(extension: string | null): extension is string {
    if (!this.isSafeFileExtension(extension)) {
      return false;
    }
    return [
      'mp4',
      'mov',
      'avi',
      'webm',
      'm4v',
      'mkv',
      'ogv',
      'mpeg',
      'mpg'
    ].includes(extension.toLowerCase());
  }

  private extractMimeType(contentType: string | null): string | null {
    if (!contentType) {
      return null;
    }
    return contentType.split(';')[0]?.trim().toLowerCase() ?? null;
  }

  private normalizeErrorMessage(error: any): string {
    const raw =
      typeof error?.message === 'string'
        ? error.message
        : JSON.stringify(error ?? null);
    return raw.length > 2000 ? `${raw.slice(0, 1997)}...` : raw;
  }

  private async downloadRemoteImage(
    url: string
  ): Promise<DownloadedRemoteImage> {
    const timeoutMs =
      env.getIntOrNull('NFT_LINK_MEDIA_PREVIEW_HTTP_TIMEOUT_MS') ?? 15000;
    const maxBytes =
      env.getIntOrNull('NFT_LINK_MEDIA_PREVIEW_MAX_BYTES') ?? 30_000_000;
    const maxRedirects =
      env.getIntOrNull('NFT_LINK_MEDIA_PREVIEW_MAX_REDIRECTS') ?? 3;

    let currentUrl = url;
    for (let i = 0; i <= maxRedirects; i++) {
      const pinnedDns = await this.resolveSafeRemoteUrl(currentUrl);
      const response = await this.fetchWithTimeout(
        currentUrl,
        timeoutMs,
        pinnedDns
      );
      if (this.isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect without Location header for ${currentUrl}`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${currentUrl}`);
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const parsed = Number(contentLength);
        if (Number.isFinite(parsed) && parsed > maxBytes) {
          throw new Error(
            `Remote media too large (${parsed} bytes > ${maxBytes}) for ${currentUrl}`
          );
        }
      }
      const bytes = await this.readBodyWithLimit(
        response,
        maxBytes,
        currentUrl
      );
      return {
        finalUrl: currentUrl,
        bytes,
        contentType: response.headers.get('content-type')
      };
    }

    throw new Error(`Too many redirects while fetching ${url}`);
  }

  private async fetchWithTimeout(
    url: string,
    timeoutMs: number,
    pinnedDns: PinnedDnsResolution
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': FETCH_USER_AGENT,
          accept: 'image/*,*/*;q=0.8'
        },
        agent: this.createPinnedAgent(url, pinnedDns) as any,
        signal: controller.signal as any
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readBodyWithLimit(
    response: Response,
    maxBytes: number,
    url: string
  ): Promise<Buffer> {
    const body = response.body;
    if (!body) {
      return Buffer.alloc(0);
    }
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      body.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
          (body as any).destroy(new Error(`Remote media too large for ${url}`));
          return;
        }
        chunks.push(Uint8Array.from(buf));
      });
      body.on('end', () => resolve(Buffer.concat(chunks)));
      body.on('error', (err) => reject(err));
    });
  }

  private isRedirect(status: number): boolean {
    return (
      status === 301 ||
      status === 302 ||
      status === 303 ||
      status === 307 ||
      status === 308
    );
  }

  private createPinnedAgent(
    urlString: string,
    pinnedDns: PinnedDnsResolution
  ): http.Agent | https.Agent {
    const parsed = new URL(urlString);
    const lookup = this.createPinnedLookup(pinnedDns);
    if (parsed.protocol === 'https:') {
      return new https.Agent({
        keepAlive: false,
        lookup,
        servername: pinnedDns.hostname
      });
    }
    return new http.Agent({
      keepAlive: false,
      lookup
    } as http.AgentOptions & { lookup: typeof lookup });
  }

  private createPinnedLookup(pinnedDns: PinnedDnsResolution) {
    return (
      hostname: string,
      optionsOrCallback: any,
      maybeCallback?: any
    ): void => {
      const options =
        typeof optionsOrCallback === 'function'
          ? {}
          : (optionsOrCallback ?? {});
      const callback =
        typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : maybeCallback;
      if (typeof callback !== 'function') {
        throw new Error(`Pinned DNS lookup callback is missing`);
      }
      if (hostname !== pinnedDns.hostname) {
        callback(
          new Error(
            `Pinned DNS lookup hostname mismatch: expected ${pinnedDns.hostname}, got ${hostname}`
          )
        );
        return;
      }
      if (
        typeof options.family === 'number' &&
        options.family !== 0 &&
        options.family !== pinnedDns.family
      ) {
        callback(
          new Error(
            `Pinned DNS family mismatch for ${hostname}: requested ${options.family}, pinned ${pinnedDns.family}`
          )
        );
        return;
      }
      if (options.all) {
        callback(null, [
          {
            address: pinnedDns.address,
            family: pinnedDns.family
          }
        ]);
        return;
      }
      callback(null, pinnedDns.address, pinnedDns.family);
    };
  }

  private async resolveSafeRemoteUrl(
    urlString: string
  ): Promise<PinnedDnsResolution> {
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch {
      throw new Error(`Invalid preview source URL: ${urlString}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `Unsupported preview source protocol: ${parsed.protocol}`
      );
    }

    const hostname = parsed.hostname;
    if (!hostname) {
      throw new Error(`Preview source hostname is empty`);
    }

    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!records.length) {
      throw new Error(`Failed to resolve hostname ${hostname}`);
    }
    for (const record of records) {
      if (this.isPrivateOrLocalIp(record.address)) {
        throw new Error(
          `Blocked preview source host ${hostname}; resolves to private/local address ${record.address}`
        );
      }
    }

    const selected = records[0];
    return {
      hostname,
      address: selected.address,
      family: selected.family === 6 ? 6 : 4
    };
  }

  private isPrivateOrLocalIp(address: string): boolean {
    if (address.startsWith('::ffff:')) {
      return this.isPrivateOrLocalIp(address.slice('::ffff:'.length));
    }

    switch (isIP(address)) {
      case 4:
        return this.isPrivateOrLocalIpv4(address);
      case 6:
        return this.isPrivateOrLocalIpv6(address);
      default:
        return true;
    }
  }

  private isPrivateOrLocalIpv4(address: string): boolean {
    const parts = this.parseIpv4Octets(address);
    if (!parts) {
      return true;
    }
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return a >= 224;
  }

  private parseIpv4Octets(address: string): number[] | null {
    const parts = address.split('.').map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)
    ) {
      return null;
    }
    return parts;
  }

  private isPrivateOrLocalIpv6(address: string): boolean {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (this.hasAnyPrefix(lower, ['fc', 'fd'])) return true;
    if (this.hasAnyPrefix(lower, ['fe8', 'fe9', 'fea', 'feb'])) return true;
    return false;
  }

  private hasAnyPrefix(value: string, prefixes: string[]): boolean {
    return prefixes.some((prefix) => value.startsWith(prefix));
  }
}

export const nftLinkMediaPreviewService = new NftLinkMediaPreviewService(
  nftLinksDb,
  sqs
);
