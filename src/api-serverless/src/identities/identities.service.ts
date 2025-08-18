import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import { ApiIdentitySubscriptionTargetAction } from '../generated/models/ApiIdentitySubscriptionTargetAction';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import {
  userNotifier,
  UserNotifier
} from '../../../notifications/user.notifier';
import { IdentityFetcher, identityFetcher } from './identity.fetcher';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { profileActivityLogsDb } from '../../../profileActivityLogs/profile-activity-logs.db';
import { ConnectionWrapper } from '../../../sql-executor';
import path from 'path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import {
  getDelegationPrimaryAddressForConsolidation,
  getHighestTdhAddressForConsolidationKey
} from '../../../delegationsLoop/db.delegations';
import { Alchemy } from 'alchemy-sdk';
import { getAlchemyInstance } from '../../../alchemy';
import { RequestContext } from '../../../request.context';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { userGroupsService } from '../community-members/user-groups.service';
import { wavesApiDb } from '../waves/waves.api.db';
import { ApiProfileClassification } from '../generated/models/ApiProfileClassification';
import { getLevelFromScore } from '../../../profiles/profile-level';
import { equalIgnoreCase } from '../../../strings';
import { enums } from '../../../enums';
import { text } from '../../../text';

export class IdentitiesService {
  constructor(
    private readonly identitiesDb: IdentitiesDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly userNotifier: UserNotifier,
    private readonly identityFetcher: IdentityFetcher,
    private readonly supplyAlchemy: () => Alchemy
  ) {}

  async addIdentitySubscriptionActions({
    subscriber,
    identityAddress,
    actions
  }: {
    subscriber: string;
    identityAddress: string;
    actions: ApiIdentitySubscriptionTargetAction[];
  }): Promise<ApiIdentitySubscriptionTargetAction[]> {
    const acceptedActions = actions.filter(
      (it) => it !== ApiIdentitySubscriptionTargetAction.DropVoted
    );
    return await this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const identityId = await this.identitiesDb
          .getEverythingRelatedToIdentitiesByAddresses(
            [identityAddress],
            connection
          )
          .then((it) => it[identityAddress]?.identity?.profile_id ?? null);
        if (!identityId) {
          throw new NotFoundException(`Identity ${identityAddress} not found`);
        }
        const proposedActions = Object.values(acceptedActions).map((it) =>
          enums.resolveOrThrow(ActivityEventAction, it)
        );

        const existingActions =
          await this.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY
            },
            connection
          );
        const actionsToAdd = proposedActions.filter(
          (it) => !existingActions.includes(it)
        );
        if (!existingActions.length) {
          await this.userNotifier.notifyOfIdentitySubscription(
            {
              subscriber_id: subscriber,
              subscribed_to: identityId
            },
            connection
          );
        }
        for (const action of actionsToAdd) {
          await this.identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY,
              target_action: action,
              wave_id: null,
              subscribed_to_all_drops: false
            },
            connection
          );
        }
        return await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              enums.resolveOrThrow(ApiIdentitySubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  async removeIdentitySubscriptionActions({
    subscriber,
    identityAddress,
    actions
  }: {
    subscriber: string;
    identityAddress: string;
    actions: ApiIdentitySubscriptionTargetAction[];
  }): Promise<ApiIdentitySubscriptionTargetAction[]> {
    return this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const identityId = await this.identitiesDb
          .getEverythingRelatedToIdentitiesByAddresses(
            [identityAddress],
            connection
          )
          .then((it) => it[identityAddress]?.identity?.profile_id ?? null);
        if (!identityId) {
          throw new NotFoundException(`Identity ${identityAddress} not found`);
        }
        for (const action of actions) {
          await this.identitySubscriptionsDb.deleteIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY,
              target_action: enums.resolveOrThrow(ActivityEventAction, action)
            },
            connection
          );
        }
        return await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: identityId,
              target_type: ActivityEventTargetType.IDENTITY
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              enums.resolveOrThrow(ApiIdentitySubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  public async updateProfilePfp({
    authenticatedWallet,
    identity,
    memeOrFile
  }: {
    authenticatedWallet: string;
    identity: string;
    memeOrFile: { file?: Express.Multer.File; meme?: number };
  }): Promise<{ pfp_url: string }> {
    const { meme, file } = memeOrFile;
    if (!meme && !file) {
      throw new BadRequestException('No PFP provided');
    }
    return await this.identitiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const profile = await this.identityFetcher
          .getIdentityAndConsolidationsByIdentityKey(
            { identityKey: identity },
            { connection }
          )
          .then((it) => {
            if (it?.handle) {
              const wallets = it.wallets!;
              if (wallets.some((it) => it.wallet === authenticatedWallet)) {
                return it;
              }
              throw new BadRequestException(`Not authorised to update profile`);
            }
            throw new BadRequestException(`Profile for ${identity} not found`);
          });
        const thumbnailUri = await this.getOrCreatePfpFileUri(
          { meme, file },
          connection
        );

        await this.identitiesDb.updateProfilePfpUri(
          thumbnailUri,
          profile.id!,
          connection
        );
        if ((thumbnailUri ?? null) !== profile.pfp) {
          await profileActivityLogsDb.insert(
            {
              profile_id: profile.id!,
              target_id: null,
              type: ProfileActivityLogType.PFP_EDIT,
              contents: JSON.stringify({
                authenticated_wallet: authenticatedWallet,
                old_value: profile.pfp,
                new_value: thumbnailUri
              }),
              proxy_id: null,
              additional_data_1: null,
              additional_data_2: null
            },
            connection
          );
        }
        return { pfp_url: thumbnailUri };
      }
    );
  }

  private async getOrCreatePfpFileUri(
    {
      meme,
      file
    }: {
      file?: Express.Multer.File;
      meme?: number;
    },
    connection: ConnectionWrapper<any>
  ): Promise<string> {
    if (meme) {
      return await this.identitiesDb
        .getMemeThumbnailUriById(meme, connection)
        .then((uri) => {
          if (uri) {
            return uri;
          }
          throw new BadRequestException(`Meme ${meme} not found`);
        });
    } else if (file) {
      const extension = path.extname(file.originalname)?.toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) {
        throw new BadRequestException('Invalid file type');
      }
      return await this.uploadPfpToS3(file, extension);
    } else {
      throw new BadRequestException('No PFP provided');
    }
  }

  private async uploadPfpToS3(file: any, fileExtension: string) {
    const s3 = new S3Client({ region: 'eu-west-1' });

    const myBucket = process.env.AWS_6529_IMAGES_BUCKET_NAME!;

    const keyExtension: string = fileExtension !== '.gif' ? 'webp' : 'gif';

    const key = `pfp/${process.env.NODE_ENV}/${randomUUID()}.${keyExtension}`;

    const uploadedScaledImage = await s3.send(
      new PutObjectCommand({
        Bucket: myBucket,
        Key: key,
        Body: file.buffer,
        ContentType: `image/${keyExtension}`
      })
    );
    if (uploadedScaledImage.$metadata.httpStatusCode == 200) {
      return `https://d3lqz0a4bldqgf.cloudfront.net/${key}?d=${Date.now()}`;
    }
    throw new Error('Failed to upload image');
  }

  public async updatePrimaryAddresses(addresses: Set<string>) {
    for (const address of Array.from(addresses)) {
      const identity =
        await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
          {
            identityKey: address
          },
          {}
        );
      if (identity?.id) {
        const consolidationKey =
          await this.identitiesDb.getConsolidationKeyFromTdhConsolidations(
            address
          );
        if (consolidationKey) {
          const wallets = consolidationKey.split('-');
          const newPrimaryAddress = await this.determinePrimaryAddress(
            wallets,
            consolidationKey
          );
          const oldPrimaryAddress = identity.consolidation_key;
          if (!equalIgnoreCase(newPrimaryAddress, oldPrimaryAddress)) {
            const ensName =
              await this.supplyAlchemy().core.lookupAddress(newPrimaryAddress);
            await this.identitiesDb.executeNativeQueriesInTransaction(
              async (connection) => {
                await this.identitiesDb.updatePrimaryAddress(
                  {
                    profileId: identity.id!,
                    primaryAddress: newPrimaryAddress
                  },
                  connection
                );
                await this.identitiesDb.updateWalletsEnsName(
                  {
                    wallet: newPrimaryAddress,
                    ensName: ensName ? text.replaceEmojisWithHex(ensName) : null
                  },
                  connection
                );
              }
            );
          }
        }
      }
    }
  }

  async determinePrimaryAddress(
    wallets: string[],
    consolidationKey: string
  ): Promise<string> {
    if (wallets.length === 1) {
      return wallets[0];
    }

    const delegationPrimaryAddress =
      await getDelegationPrimaryAddressForConsolidation(consolidationKey);
    if (delegationPrimaryAddress) {
      return delegationPrimaryAddress;
    }

    const highestTdhAddress =
      await getHighestTdhAddressForConsolidationKey(consolidationKey);
    if (highestTdhAddress) {
      return highestTdhAddress;
    }

    return wallets[0];
  }

  async searchIdentities(
    param: {
      limit: number;
      handle: string;
      wave_id: string | null;
      group_id: string | null;
    },
    ctx: RequestContext
  ): Promise<ApiIdentity[]> {
    let context_group_id: string | null = null;
    if (param.wave_id || param.group_id) {
      const authenticationContext = ctx.authenticationContext;
      const eligibleGroups = authenticationContext?.hasRightsTo(
        ProfileProxyActionType.READ_WAVE
      )
        ? await userGroupsService.getGroupsUserIsEligibleFor(
            authenticationContext?.authenticatedProfileId ?? null,
            ctx.timer
          )
        : [];
      if (param.wave_id) {
        const givenWave = await wavesApiDb
          .findWavesByIds([param.wave_id], eligibleGroups, ctx.connection)
          .then((it) => it.at(0) ?? null);
        if (!givenWave) {
          throw new NotFoundException(`Wave ${param.wave_id} not found`);
        }
        context_group_id = givenWave.visibility_group_id;
      } else if (param.group_id) {
        if (eligibleGroups.includes(param.group_id)) {
          context_group_id = param.group_id;
        } else {
          throw new ForbiddenException(
            `You are not eligible to access this group`
          );
        }
      }
    }
    const base = await userGroupsService.getSqlAndParamsByGroupId(
      context_group_id,
      ctx
    );
    const identityEntities = await identitiesDb.searchIdentitiesWithDisplays(
      param,
      base,
      ctx
    );
    const identityIds = identityEntities
      .map((it) => it.profile_id)
      .filter((it) => !!it) as string[];
    const [mainStageSubmissions, mainStageWins, tdhRates] = await Promise.all([
      this.identitiesDb.getActiveMainStageDropIds(identityIds, ctx),
      this.identitiesDb.getMainStageWinnerDropIds(identityIds, ctx),
      this.identitiesDb.getTdhRates(identityIds, ctx)
    ]);
    return identityEntities.map<ApiIdentity>((it) => {
      const classification = it.classification
        ? (enums.resolve(
            ApiProfileClassification,
            it.classification as string
          ) ?? ApiProfileClassification.Pseudonym)
        : ApiProfileClassification.Pseudonym;
      return {
        id: it.profile_id,
        handle: it.handle,
        normalised_handle: it.normalised_handle,
        pfp: it.pfp,
        primary_wallet: it.primary_address,
        rep: it.rep,
        cic: it.cic,
        level: getLevelFromScore(it.level_raw),
        tdh: it.tdh,
        tdh_rate: it.profile_id ? (tdhRates[it.profile_id] ?? 0) : 0,
        display: it.display ?? it.primary_address,
        banner1: it.banner1,
        banner2: it.banner2,
        consolidation_key: it.consolidation_key,
        classification,
        sub_classification: it.sub_classification,
        active_main_stage_submission_ids: it.profile_id
          ? (mainStageSubmissions[it.profile_id] ?? [])
          : [],
        winner_main_stage_drop_ids: it.profile_id
          ? (mainStageWins[it.profile_id] ?? [])
          : []
      };
    });
  }
}

export const identitiesService = new IdentitiesService(
  identitiesDb,
  identitySubscriptionsDb,
  userNotifier,
  identityFetcher,
  getAlchemyInstance
);
