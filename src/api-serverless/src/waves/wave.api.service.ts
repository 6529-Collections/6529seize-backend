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

export class WaveApiService {
  constructor(
    private readonly wavesApiDb: WavesApiDb,
    private readonly profilesService: ProfilesService,
    private readonly userGroupsService: UserGroupsService,
    private readonly waveMappers: WavesMappers
  ) {}

  public async createWave({
    createWaveRequest,
    authorId
  }: {
    createWaveRequest: CreateNewWave;
    authorId: string;
  }): Promise<Wave> {
    await this.validateWaveRelations(createWaveRequest);
    const createdWave = await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const newEntity = this.waveMappers.createWaveToNewWaveEntity(
          createWaveRequest,
          authorId
        );
        const id = await this.wavesApiDb.insertWave(newEntity, connection);

        const waveEntity = await this.wavesApiDb.findWaveById(id, connection);

        if (!waveEntity) {
          throw new Error(`Something went wrong while creating wave ${id}`);
        }

        return await this.waveMappers.waveEntityToApiWave(waveEntity);
      }
    );
    await giveReadReplicaTimeToCatchUp();
    return createdWave;
  }

  private async validateWaveRelations(createWaveRequest: CreateNewWave) {
    const referencedCurationIds = distinct(
      [
        createWaveRequest.visibility.scope.curation_id,
        createWaveRequest.participation.scope.curation_id,
        createWaveRequest.voting.scope.curation_id
      ].filter((id) => id !== null) as string[]
    );
    const curationEntities = await this.userGroupsService.getByIds(
      referencedCurationIds
    );
    const missingCurationIds = referencedCurationIds.filter(
      (it) => !curationEntities.find((e) => e.id === it)
    );
    if (missingCurationIds.length) {
      throw new BadRequestException(
        `Curation(s) not found: ${missingCurationIds.join(', ')}`
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
