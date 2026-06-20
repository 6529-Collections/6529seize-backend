import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import { profilesDb, ProfilesDb } from '@/profiles/profiles.db';
import { RequestContext } from '@/request.context';
import { HELP_BOT_HANDLE } from './help-bot.config';

const CACHE_TTL_MS = 300_000;
const MISSING_CACHE_TTL_MS = 30_000;

interface HelpBotProfileCache {
  readonly profileId: string | null;
  readonly expiresAt: number;
}

export class HelpBotProfileResolver {
  private readonly logger = Logger.get(this.constructor.name);
  private cache: HelpBotProfileCache | null = null;

  constructor(
    private readonly identitiesDb: Pick<IdentitiesDb, 'getIdentityByHandle'>,
    private readonly profilesDb: Pick<ProfilesDb, 'getProfileByHandle'>,
    private readonly now: () => number = () => Date.now()
  ) {}

  public async resolveBotProfileId(
    ctx: RequestContext
  ): Promise<string | null> {
    const cachedProfileId = this.getCachedProfileId();
    if (cachedProfileId !== undefined) {
      return cachedProfileId;
    }

    const identity = await this.identitiesDb.getIdentityByHandle(
      HELP_BOT_HANDLE,
      ctx
    );
    const profileId =
      identity?.profile_id ?? (await this.resolveProfileIdFromProfile(ctx));
    if (!profileId) {
      this.cache = {
        profileId: null,
        expiresAt: this.now() + MISSING_CACHE_TTL_MS
      };
      this.logger.warn(
        `Help bot profile handle ${HELP_BOT_HANDLE} could not be resolved`
      );
      return null;
    }

    this.cache = {
      profileId,
      expiresAt: this.now() + CACHE_TTL_MS
    };
    return profileId;
  }

  private async resolveProfileIdFromProfile(
    ctx: RequestContext
  ): Promise<string | null> {
    const profile = await this.profilesDb.getProfileByHandle(
      HELP_BOT_HANDLE,
      ctx.connection
    );
    if (!profile?.external_id) {
      return null;
    }
    this.logger.warn(
      `Help bot profile handle ${HELP_BOT_HANDLE} resolved through profiles fallback`
    );
    return profile.external_id;
  }

  private getCachedProfileId(): string | null | undefined {
    if (!this.cache || this.cache.expiresAt <= this.now()) {
      return undefined;
    }
    return this.cache.profileId;
  }
}

export const helpBotProfileResolver = new HelpBotProfileResolver(
  identitiesDb,
  profilesDb
);
