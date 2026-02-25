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
          message: `No image preview source available (media kind: ${sourceMediaKind})`
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
          message: `No image preview source available in resolved NFT metadata`
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
      this.assertResponseLooksImage(downloaded);
      const rendered = await this.renderPreviewVariants(downloaded.bytes);
      const uploadedUrls = await this.uploadPreviewVariants(
        prepared,
        downloaded,
        rendered
      );
      await this.nftLinksDb.updateMediaPreviewWithSuccess(
        {
          canonicalId: prepared.canonicalId,
          kind: prepared.previewKind,
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
    const sourceUrl = card.asset.media?.imageUrl ?? null;
    if (!sourceUrl) {
      return null;
    }
    return {
      canonicalId: card.identifier.canonicalId,
      sourceUrl,
      sourceHash: this.hashSourceUrl(sourceUrl),
      previewKind: 'image',
      sourceMediaKind: card.asset.media?.kind ?? null
    };
  }

  private preparePreviewSourceFromEntity(
    entity: NftLinkEntity
  ): PreparedPreviewSource | null {
    const sourceUrl =
      entity.full_data?.asset?.media?.imageUrl ?? entity.media_uri ?? null;
    if (!sourceUrl) {
      return null;
    }
    return {
      canonicalId: entity.canonical_id,
      sourceUrl,
      sourceHash: this.hashSourceUrl(sourceUrl),
      previewKind: 'image',
      sourceMediaKind: entity.full_data?.asset?.media?.kind ?? null
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

  private assertResponseLooksImage(downloaded: DownloadedRemoteImage): void {
    const mimeType = this.extractMimeType(downloaded.contentType);
    if (!mimeType) {
      return;
    }
    if (mimeType.startsWith('image/')) {
      return;
    }
    if (mimeType.startsWith('video/')) {
      throw new Error(
        `Remote media is video (${mimeType}), skipping image preview`
      );
    }
    if (
      mimeType.startsWith('text/html') ||
      mimeType === 'application/json' ||
      mimeType === 'text/plain'
    ) {
      throw new Error(`Remote media is not image-like (${mimeType})`);
    }
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
