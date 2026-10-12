import { AuthenticationContext } from '@/auth-context';
import {
  DropCreationApiService,
  dropCreationService
} from '@/api/drops/drop-creation.api.service';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import {
  ReleaseDigestEntity,
  ReleaseDigestEntryEntity,
  ReleaseDigestStatus
} from '@/entities/IReleaseDigest';
import { env } from '@/env';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { randomUUID } from 'node:crypto';
import {
  ReleaseDigestContributor,
  releaseDigestDb,
  ReleaseDigestDb
} from './release-digest.db';
import {
  ReleaseDigestCredit,
  renderFallbackReleaseDigest,
  renderReleaseDigest,
  RenderedReleaseDigest
} from './release-digest.renderer';
import {
  ReleaseDigestSourceEntry,
  ReleaseDigestWriter
} from './release-digest.writer';

export const RELEASE_DIGEST_ID_METADATA_KEY = 'release_digest_id';
const RELEASE_DIGEST_KEY_METADATA_KEY = 'release_digest_key';
const RELEASE_DIGEST_MAX_ENTRIES = 200;
const RELEASE_DIGEST_WRITE_ATTEMPTS = 2;
const WAVES_WEB_BASE_URL = 'https://6529.io/waves';
const DIGEST_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9]{1,16})?$/;

export type ReleaseDigestOutcome =
  | { readonly status: 'nothing-to-publish' }
  | { readonly status: 'already-published'; readonly dropId: string | null }
  | { readonly status: 'published'; readonly dropId: string }
  | { readonly status: 'dry-run'; readonly content: string };

export interface ReleaseDigestRequest {
  readonly digestKey: string;
  readonly cutoff: number;
  readonly dryRun: boolean;
}

interface ReleaseDigestWriterLike {
  write: ReleaseDigestWriter['write'];
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function assertReleaseDigestKey(digestKey: string): string {
  if (!DIGEST_KEY_PATTERN.test(digestKey)) {
    throw new Error(`Invalid release digest key ${digestKey}`);
  }
  return digestKey;
}

/**
 * Keeps the latest record of each pull request and assigns short prompt ids.
 */
export function toReleaseDigestSourceEntries(
  rows: readonly ReleaseDigestEntryEntity[]
): ReleaseDigestSourceEntry[] {
  const latestByPullRequest = new Map<string, ReleaseDigestEntryEntity>();
  for (const row of rows) {
    const key = `${row.repository.toLowerCase()}#${row.pull_request_number}`;
    const existing = latestByPullRequest.get(key);
    if (!existing || Number(existing.deployed_at) <= Number(row.deployed_at)) {
      latestByPullRequest.set(key, row);
    }
  }
  return Array.from(latestByPullRequest.values())
    .sort(
      (a, b) =>
        Number(a.deployed_at) - Number(b.deployed_at) ||
        a.id.localeCompare(b.id)
    )
    .map((row, index) => ({
      key: `E${index + 1}`,
      repository: row.repository,
      services: parseJsonArray<string>(row.services),
      title: row.pull_request_title,
      summary: row.summary,
      body: row.pull_request_body
    }));
}

export function toReleaseDigestCredits(
  rows: readonly ReleaseDigestEntryEntity[]
): ReleaseDigestCredit[] {
  return rows.flatMap((row) =>
    parseJsonArray<ReleaseDigestContributor>(row.contributors)
      .filter((contributor) => typeof contributor?.github_login === 'string')
      .map((contributor) => ({
        githubLogin: contributor.github_login,
        handle: contributor.handle ?? null,
        profileId: contributor.profile_id ?? null
      }))
  );
}

export class ReleaseDigestService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly digestDb: ReleaseDigestDb,
    private readonly writer: ReleaseDigestWriterLike,
    private readonly dropCreationApiService: DropCreationApiService,
    private readonly dropsRepository: Pick<DropsDb, 'findDropIdByMetadata'>
  ) {}

  public async publish(
    request: ReleaseDigestRequest,
    ctx: RequestContext
  ): Promise<ReleaseDigestOutcome> {
    const digestKey = assertReleaseDigestKey(request.digestKey);
    if (request.dryRun) {
      return this.preview(digestKey, request.cutoff, ctx);
    }
    // Finish any earlier digest that claimed entries but failed to post.
    const unfinished = await this.digestDb.findPendingDigests(digestKey, ctx);
    for (const pending of unfinished) {
      await this.publishClaimedDigest(pending, ctx);
    }
    const digest = await this.digestDb.claimDigest(
      {
        digestId: randomUUID(),
        digestKey,
        cutoff: request.cutoff,
        limit: RELEASE_DIGEST_MAX_ENTRIES,
        now: Date.now()
      },
      ctx
    );
    if (!digest) {
      this.logger.info(`No production changes to digest for ${digestKey}`);
      return { status: 'nothing-to-publish' };
    }
    if (digest.status === ReleaseDigestStatus.Published) {
      return { status: 'already-published', dropId: digest.drop_id };
    }
    return this.publishClaimedDigest(digest, ctx);
  }

  private async preview(
    digestKey: string,
    cutoff: number,
    ctx: RequestContext
  ): Promise<ReleaseDigestOutcome> {
    const rows = await this.digestDb.findUnclaimedEntries(
      cutoff,
      RELEASE_DIGEST_MAX_ENTRIES,
      ctx
    );
    if (!rows.length) {
      return { status: 'nothing-to-publish' };
    }
    const rendered = await this.compose(rows, digestKey);
    return { status: 'dry-run', content: rendered.content };
  }

  private async publishClaimedDigest(
    digest: ReleaseDigestEntity,
    ctx: RequestContext
  ): Promise<ReleaseDigestOutcome> {
    const waveId = env.getStringOrThrow('CI_RELEASES_WAVE_ID');
    const existingDropId = await this.dropsRepository.findDropIdByMetadata(
      {
        waveId,
        dataKey: RELEASE_DIGEST_ID_METADATA_KEY,
        dataValue: digest.id
      },
      ctx
    );
    if (existingDropId) {
      await this.digestDb.markPublished(
        digest.id,
        existingDropId,
        Date.now(),
        ctx
      );
      return { status: 'already-published', dropId: existingDropId };
    }
    const rows = await this.digestDb.findEntriesForDigest(digest.id, ctx);
    const rendered = await this.compose(rows, digest.digest_key);
    const dropId = await this.postDrop(rendered, digest, waveId, ctx);
    await this.digestDb.markPublished(digest.id, dropId, Date.now(), ctx);
    this.logger.info('Published release digest', {
      digest_key: digest.digest_key,
      entry_count: rows.length,
      drop_id: dropId
    });
    return { status: 'published', dropId };
  }

  private async compose(
    rows: readonly ReleaseDigestEntryEntity[],
    digestKey: string
  ): Promise<RenderedReleaseDigest> {
    const entries = toReleaseDigestSourceEntries(rows);
    const renderInput = {
      digestDate: digestKey.slice(0, 10),
      credits: toReleaseDigestCredits(rows),
      detailsUrl: `${WAVES_WEB_BASE_URL}/${env.getStringOrThrow('CI_PIPELINES_PROD_WAVE_ID')}`
    };
    for (let attempt = 1; attempt <= RELEASE_DIGEST_WRITE_ATTEMPTS; attempt++) {
      try {
        const draft = await this.writer.write(entries);
        return renderReleaseDigest(draft, renderInput);
      } catch (error) {
        this.logger.warn(
          `Release digest generation attempt ${attempt} failed: ${error}`
        );
      }
    }
    return renderFallbackReleaseDigest(entries, renderInput);
  }

  private async postDrop(
    rendered: RenderedReleaseDigest,
    digest: ReleaseDigestEntity,
    waveId: string,
    ctx: RequestContext
  ): Promise<string> {
    const botProfileId = env.getStringOrThrow('CI_PIPELINES_BOT_PROFILE_ID');
    const drop = await this.dropCreationApiService.createDrop(
      {
        createDropRequest: {
          title: null,
          drop_type: ApiDropType.Chat,
          parts: [{ content: rendered.content, quoted_drop: null, media: [] }],
          mentioned_users: rendered.mentionedProfiles.map((profile) => ({
            mentioned_profile_id: profile.profileId,
            handle_in_content: profile.handle
          })),
          mentioned_groups: [],
          referenced_nfts: [],
          metadata: [
            { data_key: RELEASE_DIGEST_ID_METADATA_KEY, data_value: digest.id },
            {
              data_key: RELEASE_DIGEST_KEY_METADATA_KEY,
              data_value: digest.digest_key
            }
          ],
          signature: null,
          is_safe_signature: false,
          wave_id: waveId
        },
        authorId: botProfileId,
        representativeId: botProfileId,
        hideLinkPreview: true
      },
      {
        ...ctx,
        authenticationContext: AuthenticationContext.fromProfileId(botProfileId)
      }
    );
    if (!drop?.id) {
      throw new Error('Release digest drop creation returned no drop id');
    }
    return drop.id;
  }
}

export const releaseDigestService = new ReleaseDigestService(
  releaseDigestDb,
  new ReleaseDigestWriter(),
  dropCreationService,
  dropsDb
);
