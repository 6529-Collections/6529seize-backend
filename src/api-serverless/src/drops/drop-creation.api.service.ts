import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { DropsApiService, dropsService } from './drops.api.service';
import { CreateDropRequest } from '../generated/models/CreateDropRequest';
import { Drop } from '../generated/models/Drop';
import { AuthenticationContext } from '../../../auth-context';
import { Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
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
import {
  deleteDrop,
  DeleteDropUseCase
} from '../../../drops/delete-drop.use-case';

export class DropCreationApiService {
  constructor(
    private readonly dropsService: DropsApiService,
    private readonly dropsDb: DropsDb,
    private readonly dropsMappers: DropsMappers,
    private readonly createOrUpdateDrop: CreateOrUpdateDropUseCase,
    private readonly deleteDrop: DeleteDropUseCase
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

  public async deleteDropById(
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
      await this.deleteDrop.execute(
        {
          drop_id: id,
          deleter_identity: authenticatedProfileId,
          deleter_id: authenticatedProfileId,
          deletion_purpose: 'DELETE'
        },
        { timer: timer!, connection }
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
}

export const dropCreationService = new DropCreationApiService(
  dropsService,
  dropsDb,
  dropsMappers,
  createOrUpdateDrop,
  deleteDrop
);
