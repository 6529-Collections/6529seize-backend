import {
  apiDropV2Service,
  ApiDropWithWave
} from '@/api/drops/api-drop-v2.service';
import { ApiDropMedia } from '@/api/generated/models/ApiDropMedia';
import { ApiDropMetadataV2 } from '@/api/generated/models/ApiDropMetadataV2';
import { ApiDropV2 } from '@/api/generated/models/ApiDropV2';
import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { ApiIdentityOverview } from '@/api/generated/models/ApiIdentityOverview';
import { ApiOgMediaAsset } from '@/api/generated/models/ApiOgMediaAsset';
import { ApiOgMetadata } from '@/api/generated/models/ApiOgMetadata';
import { ApiOgMetadataEntityType } from '@/api/generated/models/ApiOgMetadataEntityType';
import { ApiOgMetadataProfile } from '@/api/generated/models/ApiOgMetadataProfile';
import { ApiOgMetadataWave } from '@/api/generated/models/ApiOgMetadataWave';
import { ApiWaveOverview } from '@/api/generated/models/ApiWaveOverview';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import {
  apiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { UUID_REGEX } from '@/constants';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { WaveEntity } from '@/entities/IWave';

const TWITTER_HANDLE_NOT_AVAILABLE = null;
const TITLE_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 300;

export class OgMetadataService {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly wavesApiDb: WavesApiDb,
    private readonly apiWaveOverviewMapper: ApiWaveOverviewMapper,
    private readonly dropV2Service: typeof apiDropV2Service
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
    if (!profile?.id) {
      throw new NotFoundException(
        `Profile not found for identity ${identityKey}`
      );
    }

    const description = await this.findProfileDescription(profile.id, ctx);
    const apiProfile = this.mapFullProfile(profile, description);
    const title = this.buildProfileTitle(apiProfile);
    const previewDescription = this.firstText(
      [description, this.getProfileFallbackDescription(apiProfile)],
      DESCRIPTION_MAX_LENGTH
    );

    return {
      entity_type: ApiOgMetadataEntityType.Profile,
      entity_id: profile.id,
      title,
      description: previewDescription,
      image: this.imageFromUrl(
        apiProfile.pfp ?? null,
        `${title} profile picture`
      ),
      video: null,
      audio: null,
      profile: apiProfile
    };
  }

  public async getWaveMetadata(
    id: string,
    ctx: RequestContext
  ): Promise<ApiOgMetadata> {
    const { entity, overview } = await this.findPublicWaveOverview(id, ctx);
    const creator = await this.findLightProfile(entity.created_by, ctx);
    const wave = this.mapWave(overview, creator);
    const title = this.firstText(
      [overview.name, '6529 Wave'],
      TITLE_MAX_LENGTH
    );
    const description = this.firstText(
      [
        overview.description_drop.contents,
        `Join the ${overview.name} wave on 6529.`
      ],
      DESCRIPTION_MAX_LENGTH
    );
    const descriptionMedia = overview.description_drop.media ?? [];

    return {
      entity_type: ApiOgMetadataEntityType.Wave,
      entity_id: entity.id,
      title,
      description,
      image:
        this.imageFromUrl(wave.picture ?? null, `${title} wave image`) ??
        this.firstMediaAsset(descriptionMedia, 'image', title) ??
        this.imageFromUrl(
          creator?.pfp ?? null,
          `${title} creator profile picture`
        ),
      video: this.firstMediaAsset(descriptionMedia, 'video', title),
      audio: this.firstMediaAsset(descriptionMedia, 'audio', title),
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
    const apiWave = this.mapWave(wave, undefined);
    const title = this.findDropTitle(drop, author);
    const description = this.findDropDescription(drop, author);
    const media = drop.media ?? [];

    return {
      entity_type: ApiOgMetadataEntityType.Drop,
      entity_id: drop.id,
      title,
      description,
      image:
        this.firstMediaAsset(media, 'image', title) ??
        this.imageFromUrl(wave.pfp ?? null, `${wave.name} wave image`) ??
        this.imageFromUrl(
          author?.pfp ?? null,
          `${title} author profile picture`
        ),
      video: this.firstMediaAsset(media, 'video', title),
      audio: this.firstMediaAsset(media, 'audio', title),
      wave: apiWave,
      drop: {
        id: drop.id,
        serial_no: drop.serial_no,
        drop_type: drop.drop_type,
        author,
        wave: apiWave
      }
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
    const profiles = await this.identityFetcher.getApiIdentityOverviewsByIds(
      [profileId],
      ctx
    );
    return this.mapLightProfile(profiles[profileId] ?? { id: profileId });
  }

  private mapFullProfile(
    profile: ApiIdentity,
    description: string | null
  ): ApiOgMetadataProfile {
    return {
      id: profile.id!,
      handle: profile.handle,
      primary_address: profile.primary_wallet,
      pfp: profile.pfp,
      rep: profile.rep,
      level: profile.level,
      tdh: profile.tdh,
      description,
      twitter_handle: TWITTER_HANDLE_NOT_AVAILABLE
    };
  }

  private mapLightProfile(
    profile: Pick<ApiIdentityOverview, 'id' | 'handle' | 'pfp'> & {
      readonly primary_address?: string;
    }
  ): ApiOgMetadataProfile {
    return {
      id: profile.id,
      handle: profile.handle ?? null,
      primary_address: profile.primary_address ?? null,
      pfp: profile.pfp ?? null,
      twitter_handle: TWITTER_HANDLE_NOT_AVAILABLE
    };
  }

  private mapWave(
    wave: Pick<ApiWaveOverview, 'id' | 'name' | 'pfp'>,
    creator: ApiOgMetadataProfile | undefined
  ): ApiOgMetadataWave {
    const result: ApiOgMetadataWave = {
      id: wave.id,
      name: wave.name,
      picture: wave.pfp ?? null
    };
    if (creator) {
      result.creator = creator;
    }
    return result;
  }

  private findDropTitle(
    drop: Pick<ApiDropV2, 'title' | 'content' | 'priority_metadata'>,
    author: ApiOgMetadataProfile
  ): string {
    return this.firstText(
      [
        this.findPriorityMetadataValue(drop.priority_metadata, 'title'),
        drop.title,
        this.firstLine(drop.content),
        author.handle ? `Drop by @${author.handle}` : null,
        'Drop on 6529'
      ],
      TITLE_MAX_LENGTH
    );
  }

  private findDropDescription(
    drop: Pick<ApiDropV2, 'content' | 'priority_metadata'>,
    author: ApiOgMetadataProfile
  ): string {
    return this.firstText(
      [
        this.findPriorityMetadataValue(drop.priority_metadata, 'description'),
        drop.content,
        author.handle ? `View this drop by @${author.handle} on 6529.` : null,
        'View this drop on 6529.'
      ],
      DESCRIPTION_MAX_LENGTH
    );
  }

  private buildProfileTitle(profile: ApiOgMetadataProfile): string {
    if (profile.handle) {
      return this.trimToLimit(`@${profile.handle}`, TITLE_MAX_LENGTH);
    }
    if (profile.primary_address) {
      return this.trimToLimit(profile.primary_address, TITLE_MAX_LENGTH);
    }
    return '6529 Profile';
  }

  private getProfileFallbackDescription(profile: ApiOgMetadataProfile): string {
    return profile.handle
      ? `View @${profile.handle}'s 6529 profile.`
      : 'View this 6529 profile.';
  }

  private findPriorityMetadataValue(
    metadata: ApiDropMetadataV2[] | undefined,
    key: string
  ): string | null {
    return metadata?.find((row) => row.data_key === key)?.data_value ?? null;
  }

  private firstMediaAsset(
    media: ApiDropMedia[],
    kind: 'image' | 'video' | 'audio',
    alt: string
  ): ApiOgMediaAsset | null {
    const item = media.find((candidate) =>
      candidate.mime_type.startsWith(`${kind}/`)
    );
    return item ? this.mediaAsset(item.url, item.mime_type, alt) : null;
  }

  private imageFromUrl(
    url: string | null,
    alt: string
  ): ApiOgMediaAsset | null {
    return url ? this.mediaAsset(url, null, alt) : null;
  }

  private mediaAsset(
    url: string,
    mimeType: string | null,
    alt: string
  ): ApiOgMediaAsset {
    return {
      url,
      mime_type: mimeType,
      width: null,
      height: null,
      alt: this.trimToLimit(this.cleanText(alt) ?? alt, DESCRIPTION_MAX_LENGTH)
    };
  }

  private firstLine(value: string | undefined): string | null {
    return this.cleanText(value?.split('\n')[0]) ?? null;
  }

  private firstText(
    values: (string | null | undefined)[],
    limit: number
  ): string {
    for (const value of values) {
      const cleaned = this.cleanText(value);
      if (cleaned) {
        return this.trimToLimit(cleaned, limit);
      }
    }
    return '';
  }

  private cleanText(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    const replacements: readonly [RegExp, string][] = [
      [/<[^>]*>/g, ' '],
      [/!\[([^\]]*)\]\([^)]+\)/g, '$1'],
      [/\[([^\]]+)\]\([^)]+\)/g, '$1'],
      [/([*_`~>#])/g, ' '],
      [/\s+/g, ' ']
    ];
    const cleaned = replacements
      .reduce(
        (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
        value
      )
      .trim();
    return cleaned.length ? cleaned : null;
  }

  private trimToLimit(value: string, limit: number): string {
    return value.length <= limit
      ? value
      : value.substring(0, limit - 1).trimEnd();
  }
}

export const ogMetadataService = new OgMetadataService(
  identityFetcher,
  wavesApiDb,
  apiWaveOverviewMapper,
  apiDropV2Service
);
