import { dropsDb, DropsDb } from './drops.db';
import { Time, Timer } from '../time';
import { ConnectionWrapper } from '../sql-executor';
import { DeleteDropModel } from './delete-drop.model';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../exceptions';
import {
  reactionsService,
  ReactionsService
} from '../api-serverless/src/drops/reactions.service';
import {
  dropVotingService,
  DropVotingService
} from '../api-serverless/src/drops/drop-voting.service';
import {
  dropBookmarksDb,
  DropBookmarksDb
} from '../api-serverless/src/drops/drop-bookmarks.db';
import {
  CurationsDb,
  curationsDb
} from '../api-serverless/src/curations/curations.db';
import { userGroupsService } from '../api-serverless/src/community-members/user-groups.service';
import { WaveEntity } from '../entities/IWave';
import { DropEntity } from '../entities/IDrop';
import { identityFetcher } from '../api-serverless/src/identities/identity.fetcher';
import {
  artCurationTokenWatchService,
  ArtCurationTokenWatchService
} from '@/art-curation/art-curation-token-watch.service';

export class DeleteDropUseCase {
  public constructor(
    private readonly reactionsService: ReactionsService,
    private readonly dropVotingService: DropVotingService,
    private readonly dropsDb: DropsDb,
    private readonly dropBookmarksDb: DropBookmarksDb,
    private readonly curationsDb: CurationsDb,
    private readonly artCurationTokenWatchService: ArtCurationTokenWatchService
  ) {}

  private async resolveDeleterId(
    model: DeleteDropModel,
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<string | undefined> {
    const deleterId = model.deleter_id;
    if (model.deletion_purpose === 'SYSTEM_DELETE' || deleterId) {
      return deleterId;
    }

    const deleterIdentity = model.deleter_identity;
    if (!deleterIdentity) {
      throw new BadRequestException(`deleter_identity is required`);
    }
    const resolvedDeleterIdentity =
      await identityFetcher.getProfileIdByIdentityKey(
        {
          identityKey: deleterIdentity
        },
        { timer, connection }
      );
    if (!resolvedDeleterIdentity) {
      throw new NotFoundException(`${deleterIdentity} doesn't have a profile`);
    }
    return resolvedDeleterIdentity;
  }

  public async execute(
    model: DeleteDropModel,
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ): Promise<{
    id: string;
    visibility_group_id: string | null;
    serial_no: number;
    wave_id: string;
  } | null> {
    const isBackendDelete = model.deletion_purpose === 'SYSTEM_DELETE';
    const isPermanentDelete = model.deletion_purpose !== 'UPDATE';
    const deleterId = await this.resolveDeleterId(model, {
      timer,
      connection
    });
    if (!isBackendDelete && !model.deleter_id) {
      return await this.execute(
        { ...model, deleter_id: deleterId },
        { timer, connection }
      );
    }
    if (!isBackendDelete && !deleterId) {
      throw new Error('Expected deleter_id to be resolved');
    }
    const resolvedDeleterId = deleterId ?? null;
    const dropId = model.drop_id;
    const drop = await this.dropsDb.findDropById(dropId, connection);
    if (drop !== null) {
      const waveId = drop.wave_id;
      const wave = await this.dropsDb.findWaveByIdOrNull(waveId, connection);
      if (!isBackendDelete) {
        if (!resolvedDeleterId) {
          throw new Error('Expected deleter_id to be resolved');
        }
        await this.assertDeleterIsAllowedToDeleteDrop({
          drop,
          deleterId: resolvedDeleterId,
          wave,
          model,
          timer
        });
      }
      if (wave?.description_drop_id === dropId && isPermanentDelete) {
        throw new BadRequestException('Cannot delete the description drop');
      }
      await Promise.all([
        this.dropsDb.deleteDropParts(dropId, { timer, connection }),
        this.dropsDb.deleteDropMentions(dropId, { timer, connection }),
        this.dropsDb.deleteDropMentionedWaves(dropId, { timer, connection }),
        this.dropsDb.deleteDropGroupMentions(dropId, { timer, connection }),
        this.dropsDb.deleteDropMedia(dropId, { timer, connection }),
        this.dropsDb.deleteDropReferencedNfts(dropId, { timer, connection }),
        this.dropsDb.deleteDropMetadata(dropId, { timer, connection }),
        this.dropsDb.deleteDropEntity(dropId, { timer, connection }),
        this.reactionsService.deleteReactionsByDrop(dropId, {
          timer,
          connection
        }),
        this.dropVotingService.deleteVotes(dropId, { timer, connection }),
        this.curationsDb.deleteDropCurationsByDropId(dropId, {
          timer,
          connection
        }),
        ...(isPermanentDelete
          ? [
              this.artCurationTokenWatchService.unregisterDrop(dropId, {
                timer,
                connection
              })
            ]
          : []),
        this.dropsDb.deleteDropFeedItems(dropId, { timer, connection }),
        this.dropsDb.deleteDropNotifications(dropId, { timer, connection }),
        this.dropsDb.deleteDropSubscriptions(dropId, { timer, connection }),
        this.dropBookmarksDb.deleteBookmarksByDropId(dropId, connection)
      ]);
      if (isPermanentDelete) {
        await this.dropsDb.resyncParticipatoryDropCountsForWaves(
          [drop.wave_id],
          {
            timer,
            connection
          }
        );
        await this.dropsDb.insertDeletedDrop(
          {
            id: dropId,
            wave_id: waveId,
            author_id: drop.author_id,
            created_at: drop.created_at,
            deleted_at: Time.currentMillis()
          },
          { timer, connection }
        );
      }
      return {
        id: dropId,
        serial_no: drop.serial_no,
        visibility_group_id: wave?.visibility_group_id ?? null,
        wave_id: drop.wave_id
      };
    }
    return null;
  }

  private async assertDeleterIsAllowedToDeleteDrop({
    drop,
    deleterId,
    wave,
    model,
    timer
  }: {
    drop: DropEntity;
    deleterId: string;
    wave: WaveEntity | null;
    model: DeleteDropModel;
    timer?: Timer;
  }) {
    if (drop.author_id !== deleterId) {
      if (
        !wave?.admin_drop_deletion_enabled ||
        model.deletion_purpose !== 'DELETE'
      ) {
        throw new ForbiddenException('User is not allowed to delete this drop');
      }
      if (wave.created_by === deleterId) {
        return;
      }
      const adminGroupId = wave?.admin_group_id;
      if (!adminGroupId) {
        throw new ForbiddenException('User is not allowed to delete this drop');
      }
      const groupsUserIsEligibleIn =
        await userGroupsService.getGroupsUserIsEligibleFor(deleterId, timer);
      if (!groupsUserIsEligibleIn.includes(adminGroupId)) {
        throw new ForbiddenException('User is not allowed to delete this drop');
      }
    }
  }
}

export const deleteDrop = new DeleteDropUseCase(
  reactionsService,
  dropVotingService,
  dropsDb,
  dropBookmarksDb,
  curationsDb,
  artCurationTokenWatchService
);
