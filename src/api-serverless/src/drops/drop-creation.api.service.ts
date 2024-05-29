import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Logger } from '../../../logging';
import { DropsApiService, dropsService } from './drops.api.service';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../../../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { CreateDropRequest } from '../generated/models/CreateDropRequest';
import { Drop } from '../generated/models/Drop';
import { DropReferencedNFT } from '../generated/models/DropReferencedNFT';
import { QuotedDrop } from '../generated/models/QuotedDrop';
import { DropMediaEntity, DropPartEntity } from '../../../entities/IDrop';
import { waveApiService, WaveApiService } from '../waves/wave.api.service';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { WaveScopeType } from '../generated/models/WaveScopeType';
import { AuthenticationContext } from '../../../auth-context';

export class DropCreationApiService {
  private readonly logger = Logger.get(DropCreationApiService.name);

  constructor(
    private readonly dropsService: DropsApiService,
    private readonly dropsDb: DropsDb,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly waveApiService: WaveApiService,
    private readonly userGroupsService: UserGroupsService
  ) {}

  async createDrop(
    createDropRequest: CreateDropRequest,
    authenticationContext: AuthenticationContext
  ): Promise<Drop> {
    await this.validateReferences(createDropRequest, authenticationContext);
    const dropFull = await this.persistDrop(
      createDropRequest,
      authenticationContext
    );
    await giveReadReplicaTimeToCatchUp();
    this.logger.info(
      `Drop ${dropFull.id} created by user ${dropFull.author.id}`
    );
    return dropFull;
  }

  private async persistDrop(
    createDropRequest: CreateDropRequest,
    authenticationContext: AuthenticationContext
  ) {
    return await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const createDropParts = createDropRequest.parts;
        const authorId = authenticationContext.getActingAsId()!;
        const dropId = await this.dropsDb.insertDrop(
          {
            author_id: authorId,
            title: createDropRequest.title ?? null,
            parts_count: createDropParts.length,
            wave_id: createDropRequest.wave_id
          },
          connection
        );
        await this.profileActivityLogsDb.insert(
          {
            profile_id: authorId,
            target_id: dropId.toString(),
            contents: JSON.stringify({
              drop_id: dropId,
              proxy_id: authenticationContext.isAuthenticatedAsProxy()
                ? authenticationContext.authenticatedProfileId
                : undefined
            }),
            type: ProfileActivityLogType.DROP_CREATED,
            proxy_id: authenticationContext.isAuthenticatedAsProxy()
              ? authenticationContext.authenticatedProfileId!
              : null
          },
          connection
        );
        const mentionEntities = createDropRequest.mentioned_users.map((it) => ({
          drop_id: dropId,
          mentioned_profile_id: it.mentioned_profile_id,
          handle_in_content: it.handle_in_content
        }));
        await this.dropsDb.insertMentions(mentionEntities, connection);
        const referencedNfts = Object.values(
          createDropRequest.referenced_nfts.reduce<
            Record<string, DropReferencedNFT>
          >((acc, it) => {
            acc[JSON.stringify(it)] = it;
            return acc;
          }, {} as Record<string, DropReferencedNFT>)
        );
        await this.dropsDb.insertReferencedNfts(
          referencedNfts.map((it) => ({
            drop_id: dropId,
            contract: it.contract,
            token: it.token,
            name: it.name
          })),
          connection
        );
        const metadata = createDropRequest.metadata.map((it) => ({
          ...it,
          drop_id: dropId
        }));
        await this.dropsDb.insertDropMetadata(metadata, connection);
        const media = createDropParts
          .map((part, index) =>
            part.media.map<Omit<DropMediaEntity, 'id'>>((media) => ({
              ...media,
              drop_id: dropId,
              drop_part_id: index + 1
            }))
          )
          .flat();
        await this.dropsDb.insertDropMedia(media, connection);
        await this.dropsDb.insertDropParts(
          createDropParts.map<DropPartEntity>((part, index) => ({
            drop_id: dropId,
            drop_part_id: index + 1,
            content: part.content ?? null,
            quoted_drop_id: part.quoted_drop?.drop_id ?? null,
            quoted_drop_part_id: part.quoted_drop?.drop_part_id ?? null
          })),
          connection
        );
        return this.dropsService.findDropByIdOrThrow(
          {
            dropId,
            authenticationContext,
            min_part_id: 1,
            max_part_id: Number.MAX_SAFE_INTEGER
          },
          connection
        );
      }
    );
  }

  private async validateReferences(
    createDropRequest: CreateDropRequest,
    authenticationContext: AuthenticationContext
  ) {
    const quotedDrops = createDropRequest.parts
      .map<QuotedDrop | null | undefined>((it) => it.quoted_drop)
      .filter((it) => it !== undefined && it !== null) as QuotedDrop[];
    const criteriaIdsUserIsEligible =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        authenticationContext.getActingAsId()!
      );
    const wave = await this.waveApiService.findWaveByIdOrThrow(
      createDropRequest.wave_id
    );
    if (
      wave.participation.scope.type === WaveScopeType.Curated &&
      !criteriaIdsUserIsEligible.includes(wave.participation.scope.curation!.id)
    ) {
      throw new ForbiddenException(`User is not eligible for this wave`);
    }

    if (quotedDrops.length) {
      const dropIds = quotedDrops.map((it) => it.drop_id);
      const entities = await this.dropsDb.getDropsByIds(dropIds);
      const invalidQuotedDrops = quotedDrops.filter(
        (quotedDrop) =>
          !entities.find((it) => {
            return (
              it.id === quotedDrop.drop_id &&
              quotedDrop.drop_part_id <= it.parts_count
            );
          })
      );
      if (invalidQuotedDrops.length) {
        throw new BadRequestException(
          `Invalid quoted drops: ${invalidQuotedDrops
            .map((it) => `${it.drop_id}/${it.drop_part_id}`)
            .join(', ')}`
        );
      }
    }
  }
}

export const dropCreationService = new DropCreationApiService(
  dropsService,
  dropsDb,
  profileActivityLogsDb,
  waveApiService,
  userGroupsService
);
