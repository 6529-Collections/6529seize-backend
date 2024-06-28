import { SearchWavesParams, wavesApiDb, WavesApiDb } from './waves.api.db';
import { CreateNewWave } from '../generated/models/CreateNewWave';
import { Wave } from '../generated/models/Wave';
import { distinct } from '../../../helpers';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { wavesMappers, WavesMappers } from './waves.mappers';
import { randomUUID } from 'crypto';
import { dropCreationService } from '../drops/drop-creation.api.service';
import { AuthenticationContext } from '../../../auth-context';

export class WaveApiService {
  constructor(
    private readonly wavesApiDb: WavesApiDb,
    private readonly profilesService: ProfilesService,
    private readonly userGroupsService: UserGroupsService,
    private readonly waveMappers: WavesMappers
  ) {}

  public async createWave({
    createWaveRequest,
    authenticationContext
  }: {
    createWaveRequest: CreateNewWave;
    authenticationContext: AuthenticationContext;
  }): Promise<Wave> {
    await this.validateWaveRelations(createWaveRequest);
    const createdWave = await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const id = randomUUID();
        const descriptionDropId = await dropCreationService
          .createWaveDrop(
            id,
            createWaveRequest.description_drop,
            authenticationContext,
            connection
          )
          .then((drop) => drop.id);
        const newEntity = this.waveMappers.createWaveToNewWaveEntity(
          createWaveRequest,
          authenticationContext.getActingAsId()!,
          descriptionDropId
        );
        await this.wavesApiDb.insertWave(id, newEntity, connection);

        const waveEntity = await this.wavesApiDb.findWaveById(id, connection);

        if (!waveEntity) {
          throw new Error(`Something went wrong while creating wave ${id}`);
        }

        return await this.waveMappers.waveEntityToApiWave(
          waveEntity,
          connection
        );
      }
    );
    await giveReadReplicaTimeToCatchUp();
    return createdWave;
  }

  private async validateWaveRelations(createWaveRequest: CreateNewWave) {
    const referencedGroupIds = distinct(
      [
        createWaveRequest.visibility.scope.group_id,
        createWaveRequest.participation.scope.group_id,
        createWaveRequest.voting.scope.group_id
      ].filter((id) => id !== null) as string[]
    );
    const groupEntities = await this.userGroupsService.getByIds(
      referencedGroupIds
    );
    const missingGroupIds = referencedGroupIds.filter(
      (it) => !groupEntities.find((e) => e.id === it)
    );
    if (missingGroupIds.length) {
      throw new BadRequestException(
        `Group(s) not found: ${missingGroupIds.join(', ')}`
      );
    }
    const referencedCreditorId = createWaveRequest.voting.creditor_id;
    if (referencedCreditorId) {
      const creditorProfile = await this.profilesService.getProfileMinsByIds([
        referencedCreditorId
      ]);
      if (!creditorProfile.length) {
        throw new BadRequestException(
          `Creditor not found: ${referencedCreditorId}`
        );
      }
    }
  }

  async searchWaves(params: SearchWavesParams): Promise<Wave[]> {
    const entities = await this.wavesApiDb.searchWaves(params);
    return await this.waveMappers.waveEntitiesToApiWaves(entities);
  }

  async findWaveByIdOrThrow(id: string): Promise<Wave> {
    const entity = await this.wavesApiDb.findWaveById(id);
    if (!entity) {
      throw new NotFoundException(`Wave ${id} not found`);
    }
    return await this.waveMappers.waveEntityToApiWave(entity);
  }
}

export const waveApiService = new WaveApiService(
  wavesApiDb,
  profilesService,
  userGroupsService,
  wavesMappers
);
