import { wavesApiDb, WavesApiDb } from './waves.api.db';
import { CreateNewWave } from '../generated/models/CreateNewWave';
import { Wave } from '../generated/models/Wave';
import { distinct } from '../../../helpers';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import {
  communityMemberCriteriaService,
  CommunityMemberCriteriaService
} from '../community-members/community-member-criteria.service';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { BadRequestException } from '../../../exceptions';
import { wavesMappers, WavesMappers } from './waves.mappers';

export class WaveApiService {
  constructor(
    private readonly wavesApiDb: WavesApiDb,
    private readonly profilesService: ProfilesService,
    private readonly curationsService: CommunityMemberCriteriaService,
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
    const curationEntities = await this.curationsService.getCriteriasByIds(
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
}

export const waveApiService = new WaveApiService(
  wavesApiDb,
  profilesService,
  communityMemberCriteriaService,
  wavesMappers
);