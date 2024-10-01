import { dropsDb, DropsDb } from './drops.db';
import { Time, Timer } from '../time';
import { ConnectionWrapper } from '../sql-executor';
import { DeleteDropModel } from './delete-drop.model';
import { profilesService, ProfilesService } from '../profiles/profiles.service';
import {
  dropRaterService,
  DropRaterService
} from '../api-serverless/src/drops/drop-rater.service';
import { BadRequestException } from '../exceptions';

export class DeleteDropUseCase {
  public constructor(
    private readonly profileService: ProfilesService,
    private readonly dropRaterService: DropRaterService,
    private readonly dropsDb: DropsDb
  ) {}

  public async execute(
    model: DeleteDropModel,
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ): Promise<void> {
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
      if (drop.author_id !== deleterId) {
        throw new BadRequestException('Only the author can delete the drop');
      }
      const waveId = drop.wave_id;
      const wave = await this.dropsDb.findWaveByIdOrNull(waveId, connection);
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
        this.dropsDb.updateWaveDropCounters(waveId, {
          timer,
          connection
        }),
        this.dropRaterService.deleteDropVotes(dropId, { timer, connection }),
        this.dropsDb.deleteDropFeedItems(dropId, { timer, connection }),
        this.dropsDb.deleteDropNotifications(dropId, { timer, connection }),
        this.dropsDb.deleteDropSubscriptions(dropId, { timer, connection })
      ]);
      if (model.deletion_purpose === 'DELETE') {
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
    }
  }
}

export const deleteDrop = new DeleteDropUseCase(
  profilesService,
  dropRaterService,
  dropsDb
);
