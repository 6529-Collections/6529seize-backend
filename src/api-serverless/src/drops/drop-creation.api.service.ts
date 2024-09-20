import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { DropsApiService, dropsService } from './drops.api.service';
import { CreateDropRequest } from '../generated/models/CreateDropRequest';
import { Drop } from '../generated/models/Drop';
import { AuthenticationContext } from '../../../auth-context';
import { Time, Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { dropRaterService } from './drop-rater.service';
import { UpdateDropRequest } from '../generated/models/UpdateDropRequest';
import {
  createOrUpdateDrop,
  CreateOrUpdateDropUseCase
} from '../../../drops/create-or-update-drop.use-case';
import {
  CreateOrUpdateDropModel,
  DropPartIdentifierModel
} from '../../../drops/create-or-update-drop.model';
import { ConnectionWrapper } from '../../../sql-executor';
import { dropsMappers, DropsMappers } from './drops.mappers';

export class DropCreationApiService {
  constructor(
    private readonly dropsService: DropsApiService,
    private readonly dropsDb: DropsDb,
    private readonly dropsMappers: DropsMappers,
    private readonly createOrUpdateDrop: CreateOrUpdateDropUseCase
  ) {}

  public async createDrop(
    {
      createDropRequest,
      authorId,
      representativeId
    }: {
      createDropRequest: CreateDropRequest;
      authorId: string;
      representativeId: string;
    },
    timer: Timer
  ): Promise<Drop> {
    return this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        return await this.createDropWithGivenConnection(
          { createDropRequest, authorId, representativeId },
          { timer, connection }
        );
      }
    );
  }

  private async createDropWithGivenConnection(
    {
      createDropRequest,
      authorId,
      representativeId
    }: {
      createDropRequest: CreateDropRequest;
      authorId: string;
      representativeId: string;
    },
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ): Promise<Drop> {
    const proxyId =
      authorId === representativeId ? undefined : representativeId;
    const model = this.dropsMappers.createDropApiToUseCaseModel({
      request: createDropRequest,
      authorId,
      proxyId
    });
    const { drop_id } = await this.createOrUpdateDrop.execute(model, {
      timer,
      connection
    });
    return await this.dropsService.findDropByIdOrThrow(
      {
        dropId: drop_id,
        skipEligibilityCheck: true
      },
      {
        connection,
        authenticationContext: AuthenticationContext.fromProfileId(authorId),
        timer
      }
    );
  }

  public async deleteDrop(
    { id }: { id: string },
    { timer, authenticationContext }: RequestContext
  ) {
    timer?.start('dropCreationApiService->deleteDrop');
    const authenticatedProfileId = authenticationContext?.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (authenticationContext?.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxy is not allowed to delete drops`);
    }
    await this.dropsDb.executeNativeQueriesInTransaction(async (connection) => {
      const ctxWithConnection = { timer, connection, authenticationContext };
      const dropEntity = await this.dropsDb.findDropByIdAndAuthor(
        { id, author_id: authenticatedProfileId },
        ctxWithConnection
      );
      if (!dropEntity) {
        throw new NotFoundException(
          `Drop ${id} not found or you are not the author`
        );
      }
      const waveId = dropEntity.wave_id;
      const wave = await this.dropsDb.findWaveByIdOrThrow(
        waveId,
        ctxWithConnection.connection
      );
      if (id === wave.description_drop_id) {
        throw new BadRequestException(
          `Cannot delete the description drop of a wave`
        );
      }
      await this.deleteAllDropComponentsById({ id, waveId }, ctxWithConnection);
      await this.dropsDb.markDropDeletedInRelations(id, ctxWithConnection);
      await this.dropsDb.insertDeletedDrop(
        {
          id,
          wave_id: waveId,
          author_id: dropEntity.author_id,
          created_at: dropEntity.created_at,
          deleted_at: Time.currentMillis()
        },
        ctxWithConnection
      );
    });
    timer?.stop('dropCreationApiService->deleteDrop');
  }

  async updateDrop(
    {
      dropId,
      request,
      authorId,
      representativeId
    }: {
      dropId: string;
      request: UpdateDropRequest;
      authorId: string;
      representativeId: string;
    },
    timer: Timer
  ): Promise<Drop> {
    const drop = await this.dropsDb.findDropById(dropId);
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    const waveId = drop.wave_id;
    return this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const replyTo: DropPartIdentifierModel | null =
          drop.reply_to_drop_id !== null
            ? {
                drop_id: drop.reply_to_drop_id,
                drop_part_id: drop.reply_to_part_id!
              }
            : null;
        const proxyId =
          authorId === representativeId ? undefined : representativeId;
        const model: CreateOrUpdateDropModel =
          this.dropsMappers.updateDropApiToUseCaseModel({
            request,
            authorId,
            proxyId,
            replyTo,
            waveId,
            dropId
          });
        const { drop_id } = await this.createOrUpdateDrop.execute(model, {
          timer,
          connection
        });
        return await this.dropsService.findDropByIdOrThrow(
          {
            dropId: drop_id,
            skipEligibilityCheck: true
          },
          {
            connection,
            authenticationContext:
              AuthenticationContext.fromProfileId(authorId),
            timer
          }
        );
      }
    );
  }

  private async deleteAllDropComponentsById(
    { id, waveId }: { id: string; waveId: string },
    ctxWithConnection: RequestContext
  ) {
    await Promise.all([
      this.dropsDb.deleteDropParts(id, ctxWithConnection),
      this.dropsDb.deleteDropMentions(id, ctxWithConnection),
      this.dropsDb.deleteDropMedia(id, ctxWithConnection),
      this.dropsDb.deleteDropReferencedNfts(id, ctxWithConnection),
      this.dropsDb.deleteDropMetadata(id, ctxWithConnection),
      this.dropsDb.deleteDropEntity(id, ctxWithConnection),
      this.dropsDb.updateWaveDropCounters(waveId, ctxWithConnection),
      dropRaterService.deleteDropVotes(id, ctxWithConnection),
      this.dropsDb.deleteDropFeedItems(id, ctxWithConnection),
      this.dropsDb.deleteDropNotifications(id, ctxWithConnection),
      this.dropsDb.deleteDropSubscriptions(id, ctxWithConnection)
    ]);
  }
}

export const dropCreationService = new DropCreationApiService(
  dropsService,
  dropsDb,
  dropsMappers,
  createOrUpdateDrop
);
