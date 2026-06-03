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

const TWITTER_HANDLE_NOT_AVAILABLE = null;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const MARKDOWN_TEXT_MARKERS = new Set([
  '!',
  '#',
  '(',
  ')',
  '*',
  '>',
  '[',
  ']',
  '_',
  '`',
  '~'
]);

type ApiIdentityWithId = ApiIdentity & {
  readonly id: string;
};

export class OgMetadataService {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly wavesApiDb: WavesApiDb,
    private readonly apiWaveOverviewMapper: ApiWaveOverviewMapper,
    private readonly dropV2Service: typeof apiDropV2Service,
    private readonly profilesDb: ProfilesDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
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

    const [description, profileRecord, followersCount] = await Promise.all([
      this.findProfileDescription(profile.id, ctx),
      this.profilesDb.getProfileById(profile.id, ctx.connection),
      this.countProfileFollowers(profile.id)
    ]);
    const apiProfile = this.mapFullProfile(
      profile,
      description,
      this.toTimestamp(profileRecord?.created_at),
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
    const descriptionMedia = overview.description_drop.media ?? [];
    const wave = this.mapWave(
      overview,
      this.cleanText(overview.description_drop.contents),
      descriptionMedia
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
    const apiWave = this.mapWave(
      wave,
      this.cleanText(wave.description_drop.contents),
      wave.description_drop.media ?? []
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

  private async findLightProfile(
    profileId: string,
    ctx: RequestContext
  ): Promise<ApiOgMetadataProfile> {
    const [profiles, profileRecord, followersCount] = await Promise.all([
      this.identityFetcher.getOverviewsByIds([profileId], ctx),
      this.profilesDb.getProfileById(profileId, ctx.connection),
      this.countProfileFollowers(profileId)
    ]);
    return this.mapLightProfile(
      profiles[profileId] ?? { id: profileId },
      this.toTimestamp(profileRecord?.created_at),
      followersCount
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
      cic: profile.cic ?? null,
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
    for (const char of value) {
      if (insideTag) {
        if (char === '>') {
          insideTag = false;
          pendingSpace = result.length > 0;
        }
        continue;
      }
      if (char === '<') {
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

  private removeMarkdownMarkersAndCollapseWhitespace(value: string): string {
    let result = '';
    let pendingSpace = false;
    for (const char of value) {
      if (MARKDOWN_TEXT_MARKERS.has(char) || char.trim().length === 0) {
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

  private toTimestamp(
    value: Date | string | number | null | undefined
  ): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    const date = value instanceof Date ? value : new Date(value);
    const timestamp = date.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  private hasProfileId(
    profile: ApiIdentity | null
  ): profile is ApiIdentityWithId {
    return typeof profile?.id === 'string' && profile.id.length > 0;
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
