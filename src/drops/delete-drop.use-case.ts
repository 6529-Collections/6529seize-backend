import { dropsDb, DropsDb } from './drops.db';
import { Time, Timer } from '../time';
import { ConnectionWrapper } from '../sql-executor';
import { DeleteDropModel } from './delete-drop.model';
import { profilesService, ProfilesService } from '../profiles/profiles.service';
import { BadRequestException, ForbiddenException } from '../exceptions';
import {
  clappingService,
  ClappingService
} from '../api-serverless/src/drops/clapping.service';
import {
  dropVotingService,
  DropVotingService
} from '../api-serverless/src/drops/drop-voting.service';
import { userGroupsService } from '../api-serverless/src/community-members/user-groups.service';
import { WaveEntity } from '../entities/IWave';
import { DropEntity } from '../entities/IDrop';

export class DeleteDropUseCase {
  public constructor(
    private readonly profileService: ProfilesService,
    private readonly clapsService: ClappingService,
    private readonly dropVotingService: DropVotingService,
    private readonly dropsDb: DropsDb
  ) {}

  public async execute(
    model: DeleteDropModel,
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ): Promise<{
    id: string;
    visibility_group_id: string | null;
    serial_no: number;
    wave_id: string;
  } | null> {
    const deleterId = model.deleter_id;
    if (!deleterId) {
      const deleterIdentity = model.deleter_identity;
      const resolvedDeleterIdentity =
        await this.profileService.resolveIdentityIdOrThrowNotFound(
          deleterIdentity
        );
      return await this.execute(
        { ...model, deleter_id: resolvedDeleterIdentity },
        { timer, connection }
      );
    }
    const dropId = model.drop_id;
    const drop = await this.dropsDb.findDropById(dropId, connection);
    if (drop !== null) {
      const waveId = drop.wave_id;
      const wave = await this.dropsDb.findWaveByIdOrNull(waveId, connection);
      await this.assertDeleterIsAllowedToDeleteDrop({
        drop,
        deleterId,
        wave,
        model,
        timer
      });
      if (
        wave?.description_drop_id === dropId &&
        model.deletion_purpose === 'DELETE'
      ) {
        throw new BadRequestException('Cannot delete the description drop');
      }
      await Promise.all([
        this.dropsDb.deleteDropParts(dropId, { timer, connection }),
        this.dropsDb.deleteDropMentions(dropId, { timer, connection }),
        this.dropsDb.deleteDropMedia(dropId, { timer, connection }),
        this.dropsDb.deleteDropReferencedNfts(dropId, { timer, connection }),
        this.dropsDb.deleteDropMetadata(dropId, { timer, connection }),
        this.dropsDb.deleteDropEntity(dropId, { timer, connection }),
        this.clapsService.deleteClaps(dropId, { timer, connection }),
        this.dropVotingService.deleteVotes(dropId, { timer, connection }),
        this.dropsDb.deleteDropFeedItems(dropId, { timer, connection }),
        this.dropsDb.deleteDropNotifications(dropId, { timer, connection }),
        this.dropsDb.deleteDropSubscriptions(dropId, { timer, connection })
      ]);
      if (model.deletion_purpose === 'DELETE') {
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
            author_id: deleterId,
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
    timer: Timer;
  }) {
    if (drop.author_id !== deleterId) {
      const adminGroupId = wave?.admin_group_id;
      const adminDropDeletionEnabled = !!(
        wave?.admin_drop_deletion_enabled && adminGroupId
      );
      if (!adminDropDeletionEnabled || model.deletion_purpose !== 'DELETE') {
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
  profilesService,
  clappingService,
  dropVotingService,
  dropsDb
);
