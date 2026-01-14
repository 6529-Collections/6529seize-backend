import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { DropsApiService, dropsService } from './drops.api.service';
import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { ApiDrop } from '../generated/models/ApiDrop';
import { AuthenticationContext } from '../../../auth-context';
import { Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { ApiUpdateDropRequest } from '../generated/models/ApiUpdateDropRequest';
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
import { ApiDropType } from '../generated/models/ApiDropType';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '../ws/ws-listeners-notifier';
import { enums } from '../../../enums';

export class DropCreationApiService {
  constructor(
    private readonly dropsService: DropsApiService,
    private readonly dropsDb: DropsDb,
    private readonly dropsMappers: DropsMappers,
    private readonly createOrUpdateDrop: CreateOrUpdateDropUseCase,
    private readonly deleteDrop: DeleteDropUseCase,
    private readonly wsListenersNotifier: WsListenersNotifier
  ) {}

  public async createDrop(
    {
      createDropRequest,
      authorId,
      representativeId
    }: {
      createDropRequest: ApiCreateDropRequest;
      authorId: string;
      representativeId: string;
    },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const drop = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        return await this.createDropWithGivenConnection(
          { createDropRequest, authorId, representativeId },
          { timer: ctx.timer!, connection }
        );
      }
    );
    await this.wsListenersNotifier.notifyAboutDropUpdate(drop, ctx);
    return drop;
  }

  private async createDropWithGivenConnection(
    {
      createDropRequest,
      authorId,
      representativeId
    }: {
      createDropRequest: ApiCreateDropRequest;
      authorId: string;
      representativeId: string;
    },
    { timer, connection }: { timer: Timer; connection: ConnectionWrapper<any> }
  ): Promise<ApiDrop> {
    const proxyId =
      authorId === representativeId ? undefined : representativeId;
    const model = this.dropsMappers.createDropApiToUseCaseModel({
      request: createDropRequest,
      authorId,
      proxyId
    });
    const { drop_id } = await this.createOrUpdateDrop.execute(model, false, {
      timer,
      connection
    });
    return this.dropsService.findDropByIdOrThrow(
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
    const deleteResponse = await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        return await this.deleteDrop.execute(
          {
            drop_id: id,
            deleter_identity: authenticatedProfileId,
            deleter_id: authenticatedProfileId,
            deletion_purpose: 'DELETE'
          },
          { timer: timer!, connection }
        );
      }
    );
    if (deleteResponse) {
      await this.wsListenersNotifier.notifyAboutDropDelete(
        {
          drop_id: deleteResponse.id,
          drop_serial: deleteResponse.serial_no,
          wave_id: deleteResponse.wave_id
        },
        deleteResponse.visibility_group_id,
        { timer, authenticationContext }
      );
    }
    timer?.stop('dropCreationApiService->deleteDrop');
  }

  async toggleHideLinkPreview(
    { dropId }: { dropId: string },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    ctx.timer?.start('dropCreationApiService->toggleHideLinkPreview');
    const authenticatedProfileId = ctx.authenticationContext?.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (ctx.authenticationContext?.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(
        `Proxy is not allowed to toggle hide link preview`
      );
    }
    const drop = await this.dropsDb.findDropById(dropId);
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    if (drop.author_id !== authenticatedProfileId) {
      throw new ForbiddenException(
        `Only the author can toggle hide link preview`
      );
    }
    const newValue = !drop.hide_link_preview;
    await this.dropsDb.updateHideLinkPreview(
      { drop_id: dropId, hide_link_preview: newValue },
      ctx
    );
    const apiDrop = await this.dropsService.findDropByIdOrThrow(
      { dropId, skipEligibilityCheck: true },
      ctx
    );
    await this.wsListenersNotifier.notifyAboutDropUpdate(apiDrop, ctx);
    ctx.timer?.stop('dropCreationApiService->toggleHideLinkPreview');
    return apiDrop;
  }

  async updateDrop(
    {
      dropId,
      request,
      authorId,
      representativeId
    }: {
      dropId: string;
      request: ApiUpdateDropRequest;
      authorId: string;
      representativeId: string;
    },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const drop = await this.dropsDb.findDropById(dropId);
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    const waveId = drop.wave_id;
    const apiDrop = await this.dropsDb.executeNativeQueriesInTransaction(
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
        const dropType = drop.drop_type
          ? enums.resolveOrThrow(ApiDropType, drop.drop_type)
          : ApiDropType.Chat;
        const model: CreateOrUpdateDropModel =
          this.dropsMappers.updateDropApiToUseCaseModel({
            request: {
              ...request,
              drop_type: dropType
            },
            authorId,
            proxyId,
            replyTo,
            waveId,
            dropId
          });
        const { drop_id } = await this.createOrUpdateDrop.execute(
          model,
          false,
          {
            timer: ctx.timer!,
            connection
          }
        );
        return await this.dropsService.findDropByIdOrThrow(
          {
            dropId: drop_id,
            skipEligibilityCheck: true
          },
          {
            ...ctx,
            connection
          }
        );
      }
    );
    await this.wsListenersNotifier.notifyAboutDropUpdate(apiDrop, ctx);
    return apiDrop;
  }
}

export const dropCreationService = new DropCreationApiService(
  dropsService,
  dropsDb,
  dropsMappers,
  createOrUpdateDrop,
  deleteDrop,
  wsListenersNotifier
);
