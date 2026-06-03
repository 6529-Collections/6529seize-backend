import {
  apiDropV2Service,
  ApiDropWithWave
} from '@/api/drops/api-drop-v2.service';
import { ApiDropMedia } from '@/api/generated/models/ApiDropMedia';
import { ApiDropMetadataV2 } from '@/api/generated/models/ApiDropMetadataV2';
import { ApiDropV2 } from '@/api/generated/models/ApiDropV2';
import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { ApiOgMediaAsset } from '@/api/generated/models/ApiOgMediaAsset';
import { ApiOgMetadata } from '@/api/generated/models/ApiOgMetadata';
import { ApiOgMetadataDrop } from '@/api/generated/models/ApiOgMetadataDrop';
import { ApiOgMetadataEntityType } from '@/api/generated/models/ApiOgMetadataEntityType';
import { ApiOgMetadataProfile } from '@/api/generated/models/ApiOgMetadataProfile';
import { ApiOgMetadataProfileBanner } from '@/api/generated/models/ApiOgMetadataProfileBanner';
import { ApiOgMetadataWave } from '@/api/generated/models/ApiOgMetadataWave';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { ApiWaveOverview } from '@/api/generated/models/ApiWaveOverview';
import { Logger } from '@/logging';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '@/api/identity-subscriptions/identity-subscriptions.db';
import {
  apiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { UUID_REGEX } from '@/constants';
import { ActivityEventTargetType } from '@/entities/IActivityEvent';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { WaveEntity } from '@/entities/IWave';
import { normalizeIpfsUri } from '@/nft-links/lib/uri';
import { profilesDb, ProfilesDb } from '@/profiles/profiles.db';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';

const TWITTER_HANDLE_NOT_AVAILABLE = null;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

type ApiIdentityWithId = ApiIdentity & {
  readonly id: string;
};

type OgIdentityFetcher = Pick<
  IdentityFetcher,
  | 'getIdentityAndConsolidationsByIdentityKey'
  | 'getDropResolvedIdentityProfilesV2ByIds'
  | 'getOverviewsByIds'
>;
type OgWavesApiDb = Pick<WavesApiDb, 'findWavesByIdsEligibleForRead'>;
type OgWaveOverviewMapper = Pick<ApiWaveOverviewMapper, 'mapWaves'>;
type OgDropV2Service = Pick<
  typeof apiDropV2Service,
  'findWithWaveByIdOrThrow' | 'findDrops'
>;
type OgProfilesDb = Pick<ProfilesDb, 'getProfileById'>;
type OgIdentitySubscriptionsDb = Pick<
  IdentitySubscriptionsDb,
  'countDistinctSubscriberIdsForTarget'
>;

type ProfileEnrichment = {
  readonly description: string | null;
  readonly profileEnabledAt: number | null;
  readonly followersCount: number;
};

export class OgMetadataService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly identityFetcher: OgIdentityFetcher,
    private readonly wavesApiDb: OgWavesApiDb,
    private readonly apiWaveOverviewMapper: OgWaveOverviewMapper,
    private readonly dropV2Service: OgDropV2Service,
    private readonly profilesDb: OgProfilesDb,
    private readonly identitySubscriptionsDb: OgIdentitySubscriptionsDb
  ) {}

  public async getProfileMetadata(
    identityKey: string,
    ctx: RequestContext
  ): Promise<ApiOgMetadata> {
    const profile =
      await this.identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey },
        ctx
      );
    if (!this.hasProfileId(profile)) {
      throw new NotFoundException(
        `Profile not found for identity ${identityKey}`
      );
    }

    const { description, profileEnabledAt, followersCount } =
      await this.findProfileEnrichment(profile.id, ctx);
    const apiProfile = this.mapFullProfile(
      profile,
      description,
      profileEnabledAt,
      followersCount
    );

    return {
      entity_type: ApiOgMetadataEntityType.Profile,
      entity_id: profile.id,
      profile: apiProfile
    };
  }

  public async getWaveMetadata(
    id: string,
    ctx: RequestContext
  ): Promise<ApiOgMetadata> {
    const { entity, overview } = await this.findPublicWaveOverview(id, ctx);
    const author = await this.findLightProfile(entity.created_by, ctx);
    const descriptionDrop = overview.description_drop;
    const wave = this.mapWave(
      overview,
      this.cleanText(descriptionDrop?.contents),
      descriptionDrop?.media ?? []
    );

    return {
      entity_type: ApiOgMetadataEntityType.Wave,
      entity_id: entity.id,
      author,
      wave
    };
  }

  public async getDropMetadata(
    dropIdentifier: string,
    ctx: RequestContext
  ): Promise<ApiOgMetadata> {
    const dropWithWave = await this.findDrop(dropIdentifier, ctx);
    const { drop, wave } = dropWithWave;
    const author = await this.findLightProfile(drop.author.id, ctx);
    const descriptionDrop = wave.description_drop;
    const apiWave = this.mapWave(
      wave,
      this.cleanText(descriptionDrop?.contents),
      descriptionDrop?.media ?? []
    );

    return {
      entity_type: ApiOgMetadataEntityType.Drop,
      entity_id: drop.id,
      author,
      wave: apiWave,
      drop: this.mapDrop(drop)
    };
  }

  private async findDrop(
    dropIdentifier: string,
    ctx: RequestContext
  ): Promise<ApiDropWithWave> {
    if (UUID_REGEX.exec(dropIdentifier)) {
      return this.dropV2Service.findWithWaveByIdOrThrow(dropIdentifier, ctx);
    }
    if (!/^\d+$/.exec(dropIdentifier)) {
      throw new BadRequestException(
        `Invalid drop identifier ${dropIdentifier}`
      );
    }
    const serialNo = Number(dropIdentifier);
    if (!Number.isSafeInteger(serialNo) || serialNo < 1) {
      throw new BadRequestException(
        `Invalid drop identifier ${dropIdentifier}`
      );
    }
    const page = await this.dropV2Service.findDrops(
      {
        parent_drop_id: null,
        serial_nos: [serialNo],
        ids: null,
        page_size: 1,
        page: 1
      },
      ctx
    );
    const drop = page.data[0];
    if (!drop?.wave) {
      throw new NotFoundException(`Drop ${dropIdentifier} not found`);
    }
    return {
      drop,
      wave: drop.wave
    };
  }

  private async findPublicWaveOverview(
    id: string,
    ctx: RequestContext
  ): Promise<{ entity: WaveEntity; overview: ApiWaveOverview }> {
    const waves = await this.wavesApiDb.findWavesByIdsEligibleForRead(
      [id],
      [],
      ctx.connection
    );
    const entity = waves[0];
    if (!entity) {
      throw new NotFoundException(`Wave ${id} not found`);
    }
    const overviews = await this.apiWaveOverviewMapper.mapWaves([entity], ctx);
    const overview = overviews[id];
    if (!overview) {
      throw new NotFoundException(`Wave ${id} not found`);
    }
    return { entity, overview };
  }

  private async findProfileDescription(
    profileId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    const profiles =
      await this.identityFetcher.getDropResolvedIdentityProfilesV2ByIds(
        { ids: [profileId] },
        ctx
      );
    return this.cleanText(profiles[profileId]?.bio ?? null);
  }

  private async findProfileEnrichment(
    profileId: string,
    ctx: RequestContext
  ): Promise<ProfileEnrichment> {
    const [description, profileRecord, followersCount] = await Promise.all([
      this.failOpen(
        () => this.findProfileDescription(profileId, ctx),
        null,
        `Failed to load profile description for ${profileId}`
      ),
      this.failOpen(
        () => this.profilesDb.getProfileById(profileId, ctx.connection),
        null,
        `Failed to load profile created_at for ${profileId}`
      ),
      this.failOpen(
        () => this.countProfileFollowers(profileId),
        0,
        `Failed to count profile followers for ${profileId}`
      )
    ]);
    return {
      description,
      profileEnabledAt: this.toTimestamp(profileRecord?.created_at),
      followersCount
    };
  }

  private async findLightProfile(
    profileId: string,
    ctx: RequestContext
  ): Promise<ApiOgMetadataProfile> {
    const emptyProfiles: Record<string, ApiProfileMin> = {};
    const [profiles, enrichment] = await Promise.all([
      this.failOpen(
        () => this.identityFetcher.getOverviewsByIds([profileId], ctx),
        emptyProfiles,
        `Failed to load profile overview for ${profileId}`
      ),
      this.findProfileEnrichment(profileId, ctx)
    ]);
    return this.mapLightProfile(
      profiles[profileId] ?? { id: profileId, handle: null, pfp: null },
      enrichment.profileEnabledAt,
      enrichment.followersCount
    );
  }

  private mapFullProfile(
    profile: ApiIdentityWithId,
    description: string | null,
    profileEnabledAt: number | null,
    followersCount: number
  ): ApiOgMetadataProfile {
    return {
      id: profile.id,
      handle: profile.handle,
      primary_address: profile.primary_wallet,
      profile_enabled_at: profileEnabledAt,
      classification: profile.classification,
      sub_classification: profile.sub_classification,
      followers_count: followersCount,
      has_active_submissions: this.hasItems(
        profile.active_main_stage_submission_ids
      ),
      has_winning_submissions: this.hasItems(
        profile.winner_main_stage_drop_ids
      ),
      cic: profile.cic,
      rep: profile.rep,
      level: profile.level,
      tdh: profile.tdh,
      description,
      twitter_handle: TWITTER_HANDLE_NOT_AVAILABLE,
      media: this.singleUrlMedia(profile.pfp),
      banner: this.mapBanner(profile.banner1, profile.banner2)
    };
  }

  private mapLightProfile(
    profile: Pick<ApiProfileMin, 'id' | 'handle' | 'pfp'> & {
      readonly primary_address?: string;
      readonly classification?: ApiProfileMin['classification'];
      readonly sub_classification?: string | null;
      readonly cic?: number;
      readonly level?: number;
      readonly active_main_stage_submission_ids?: string[];
      readonly winner_main_stage_drop_ids?: string[];
    },
    profileEnabledAt: number | null,
    followersCount: number
  ): ApiOgMetadataProfile {
    return {
      id: profile.id,
      handle: profile.handle ?? null,
      primary_address: profile.primary_address ?? null,
      profile_enabled_at: profileEnabledAt,
      classification: profile.classification,
      sub_classification: profile.sub_classification ?? null,
      followers_count: followersCount,
      has_active_submissions: this.hasItems(
        profile.active_main_stage_submission_ids
      ),
      has_winning_submissions: this.hasItems(
        profile.winner_main_stage_drop_ids
      ),
      cic: profile.cic ?? null,
      level: profile.level ?? null,
      twitter_handle: TWITTER_HANDLE_NOT_AVAILABLE,
      media: this.singleUrlMedia(profile.pfp)
    };
  }

  private mapBanner(
    banner1: string | null | undefined,
    banner2: string | null | undefined
  ): ApiOgMetadataProfileBanner {
    return {
      primary: this.isHexColor(banner1) ? banner1 : null,
      secondary: this.isHexColor(banner2) ? banner2 : null,
      media: this.isBannerMediaUrl(banner1) ? this.singleUrlMedia(banner1) : []
    };
  }

  private mapWave(
    wave: Pick<
      ApiWaveOverview,
      'id' | 'name' | 'pfp' | 'subscribers_count' | 'total_drops_count'
    >,
    description: string | null,
    media: ApiDropMedia[]
  ): ApiOgMetadataWave {
    return {
      id: wave.id,
      name: wave.name,
      description,
      subscribers_count: wave.subscribers_count,
      drops_count: wave.total_drops_count,
      media: [...this.singleUrlMedia(wave.pfp), ...this.mapMedia(media)]
    };
  }

  private mapDrop(
    drop: Pick<
      ApiDropV2,
      | 'id'
      | 'serial_no'
      | 'drop_type'
      | 'title'
      | 'content'
      | 'priority_metadata'
      | 'submission_context'
      | 'media'
    >
  ): ApiOgMetadataDrop {
    return {
      id: drop.id,
      serial_no: drop.serial_no,
      drop_type: drop.drop_type,
      title: this.cleanText(
        this.findPriorityMetadataValue(drop.priority_metadata, 'title') ??
          drop.title ??
          null
      ),
      description: this.cleanText(
        this.findPriorityMetadataValue(drop.priority_metadata, 'description')
      ),
      content: this.cleanText(drop.content),
      votes: drop.submission_context?.voting,
      media: this.mapMedia(drop.media ?? [])
    };
  }

  private findPriorityMetadataValue(
    metadata: ApiDropMetadataV2[] | undefined,
    key: string
  ): string | null {
    return metadata?.find((row) => row.data_key === key)?.data_value ?? null;
  }

  private mapMedia(media: ApiDropMedia[]): ApiOgMediaAsset[] {
    return media.map((item) => this.mediaAsset(item.url, item.mime_type));
  }

  private singleUrlMedia(url: string | null | undefined): ApiOgMediaAsset[] {
    return url ? [this.mediaAsset(url, null)] : [];
  }

  private mediaAsset(url: string, mimeType: string | null): ApiOgMediaAsset {
    return {
      url: this.gatewayMediaUrl(url) ?? url,
      mime_type: mimeType,
      width: null,
      height: null
    };
  }

  private isHexColor(value: string | null | undefined): value is string {
    return typeof value === 'string' && HEX_COLOR_REGEX.test(value);
  }

  private isBannerMediaUrl(value: string | null | undefined): value is string {
    return (
      typeof value === 'string' && value.length > 0 && !this.isHexColor(value)
    );
  }

  private cleanText(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const withoutTags = this.stripHtmlTags(value);
    const cleaned =
      this.removeMarkdownMarkersAndCollapseWhitespace(withoutTags);
    return cleaned.length ? cleaned : null;
  }

  private stripHtmlTags(value: string): string {
    let result = '';
    let insideTag = false;
    let pendingSpace = false;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (insideTag) {
        if (char === '>') {
          insideTag = false;
          pendingSpace = result.length > 0;
        }
        continue;
      }
      if (char === '<' && this.isLikelyHtmlTagStart(value[i + 1])) {
        insideTag = true;
        pendingSpace = result.length > 0;
        continue;
      }
      if (pendingSpace) {
        result += ' ';
        pendingSpace = false;
      }
      result += char;
    }
    return result;
  }

  private isLikelyHtmlTagStart(char: string | undefined): boolean {
    return (
      char !== undefined &&
      ((char >= 'a' && char <= 'z') ||
        (char >= 'A' && char <= 'Z') ||
        char === '/' ||
        char === '!' ||
        char === '?')
    );
  }

  private removeMarkdownMarkersAndCollapseWhitespace(value: string): string {
    const withoutMarkdown = this.replaceMarkdownLinks(value)
      .replace(/(^|\n)[ \t]{0,3}#{1,6}[ \t]+/g, '$1')
      .replace(/(^|\n)[ \t]{0,3}>[ \t]?/g, '$1')
      .replace(/\\([\\`*_[\]()#+\-.!>])/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/(\*{1,3})(\w(?:[^*\n]*?\w)?)\1/g, '$2')
      .replace(/(^|[^\w])(_{1,3})(\w(?:[^_\n]*?\w)?)\2($|[^\w])/g, '$1$3$4')
      .replace(/```/g, '');
    return this.collapseWhitespace(withoutMarkdown);
  }

  private replaceMarkdownLinks(value: string): string {
    let result = '';
    let index = 0;

    while (index < value.length) {
      const imageTextStart =
        value[index] === '!' && value[index + 1] === '[' ? index + 2 : null;
      const textStart =
        imageTextStart ?? (value[index] === '[' ? index + 1 : null);

      if (textStart === null) {
        result += value[index];
        index++;
        continue;
      }

      const textEnd = this.findMarkdownDelimiter(value, textStart, ']');
      if (textEnd === null) {
        result += value.slice(index);
        break;
      }
      if (value[textEnd + 1] !== '(') {
        result += value.slice(index, textEnd + 1);
        index = textEnd + 1;
        continue;
      }

      const urlEnd = this.findMarkdownDelimiter(value, textEnd + 2, ')');
      if (urlEnd === null) {
        result += value.slice(index);
        break;
      }

      result += value.slice(textStart, textEnd);
      index = urlEnd + 1;
    }

    return result;
  }

  private findMarkdownDelimiter(
    value: string,
    start: number,
    delimiter: string
  ): number | null {
    for (let index = start; index < value.length; index++) {
      const char = value[index];
      if (char === '\n' || char === '\r') {
        return null;
      }
      if (char === delimiter) {
        return index;
      }
    }
    return null;
  }

  private collapseWhitespace(value: string): string {
    let result = '';
    let pendingSpace = false;
    for (const char of value) {
      if (char.trim().length === 0) {
        pendingSpace = result.length > 0;
        continue;
      }
      if (pendingSpace) {
        result += ' ';
        pendingSpace = false;
      }
      result += char;
    }
    return result.trim();
  }

  private gatewayMediaUrl(url: string | null | undefined): string | null {
    return normalizeIpfsUri(url) ?? null;
  }

  private countProfileFollowers(profileId: string): Promise<number> {
    return this.identitySubscriptionsDb.countDistinctSubscriberIdsForTarget({
      target_id: profileId,
      target_type: ActivityEventTargetType.IDENTITY
    });
  }

  private hasItems(value: readonly unknown[] | null | undefined): boolean {
    return (value?.length ?? 0) > 0;
  }

  private toTimestamp(
    value: Date | string | number | null | undefined
  ): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'number') {
      return Time.millis(value).toMillis();
    }
    if (value instanceof Date) {
      return Time.fromDate(value).toMillis();
    }
    return Time.fromString(value).toMillis();
  }

  private hasProfileId(
    profile: ApiIdentity | null
  ): profile is ApiIdentityWithId {
    return typeof profile?.id === 'string' && profile.id.length > 0;
  }

  private async failOpen<T>(
    fn: () => Promise<T>,
    fallback: T,
    message: string
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.logger.warn(message, error);
      return fallback;
    }
  }
}

export const ogMetadataService = new OgMetadataService(
  identityFetcher,
  wavesApiDb,
  apiWaveOverviewMapper,
  apiDropV2Service,
  profilesDb,
  identitySubscriptionsDb
);
