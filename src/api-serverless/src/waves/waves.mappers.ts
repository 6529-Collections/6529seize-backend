import { CreateNewWave } from '../generated/models/CreateNewWave';
import { NewWaveEntity } from './waves.api.db';
import { distinct, resolveEnumOrThrow } from '../../../helpers';
import {
  WaveCreditScopeType,
  WaveCreditType,
  WaveEntity,
  WaveScopeType,
  WaveType
} from '../../../entities/IWave';
import { Wave } from '../generated/models/Wave';
import { ProfileMin } from '../generated/models/ProfileMin';
import { Curation } from '../generated/models/Curation';
import { WaveScopeType as WaveScopeTypeApi } from '../generated/models/WaveScopeType';
import { WaveCreditType as WaveCreditTypeApi } from '../generated/models/WaveCreditType';
import { WaveCreditScope as WaveCreditScopeApi } from '../generated/models/WaveCreditScope';
import { WaveType as WaveTypeApi } from '../generated/models/WaveType';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import {
  communityMemberCriteriaService,
  CommunityMemberCriteriaService
} from '../community-members/community-member-criteria.service';

export class WavesMappers {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly curationsService: CommunityMemberCriteriaService
  ) {}

  public createWaveToNewWaveEntity(
    createWaveRequest: CreateNewWave,
    authorId: string
  ): NewWaveEntity {
    return {
      name: createWaveRequest.name,
      description: createWaveRequest.description,
      created_by: authorId,
      voting_scope_type: resolveEnumOrThrow(
        WaveScopeType,
        createWaveRequest.voting.scope.type
      ),
      voting_scope_curation_id: createWaveRequest.voting.scope.curation_id,
      voting_credit_type: resolveEnumOrThrow(
        WaveCreditType,
        createWaveRequest.voting.credit_type
      ),
      voting_credit_scope_type: resolveEnumOrThrow(
        WaveCreditScopeType,
        createWaveRequest.voting.credit_scope
      ),
      voting_credit_category: createWaveRequest.voting.credit_category,
      voting_credit_creditor: createWaveRequest.voting.creditor_id,
      voting_signature_required: createWaveRequest.voting.signature_required,
      voting_period_start: createWaveRequest.voting.period?.min ?? null,
      voting_period_end: createWaveRequest.voting.period?.max ?? null,
      visibility_scope_type: resolveEnumOrThrow(
        WaveScopeType,
        createWaveRequest.visibility.scope.type
      ),
      visibility_scope_curation_id:
        createWaveRequest.visibility.scope.curation_id,
      participation_scope_type: resolveEnumOrThrow(
        WaveScopeType,
        createWaveRequest.participation.scope.type
      ),
      participation_scope_curation_id:
        createWaveRequest.participation.scope.curation_id,
      participation_max_applications_per_participant:
        createWaveRequest.participation
          .no_of_applications_allowed_per_participant,
      participation_required_metadata: JSON.stringify(
        createWaveRequest.participation.required_metadata
      ),
      participation_period_start:
        createWaveRequest.participation.period?.min ?? null,
      participation_period_end:
        createWaveRequest.participation.period?.max ?? null,
      type: resolveEnumOrThrow(WaveType, createWaveRequest.wave.type),
      winning_min_threshold:
        createWaveRequest.wave.winning_thresholds?.min ?? null,
      winning_max_threshold:
        createWaveRequest.wave.winning_thresholds?.max ?? null,
      max_winners: createWaveRequest.wave.max_winners ?? null,
      time_lock_ms: createWaveRequest.wave.time_lock_ms ?? null,
      wave_period_start: createWaveRequest.wave.period?.min ?? null,
      wave_period_end: createWaveRequest.wave.period?.max ?? null,
      outcomes: JSON.stringify(createWaveRequest.outcomes)
    };
  }

  public async waveEntityToApiWave(waveEntity: WaveEntity): Promise<Wave> {
    return this.waveEntitiesToApiWaves([waveEntity]).then((waves) => waves[0]);
  }

  public async waveEntitiesToApiWaves(
    waveEntities: WaveEntity[]
  ): Promise<Wave[]> {
    const curationEntities = await this.curationsService.getCriteriasByIds(
      waveEntities
        .map(
          (waveEntity) =>
            [
              waveEntity.visibility_scope_curation_id,
              waveEntity.participation_scope_curation_id,
              waveEntity.voting_scope_curation_id
            ].filter((id) => id !== null) as string[]
        )
        .flat()
    );
    const profileIds = distinct([
      ...waveEntities
        .map(
          (waveEntity) =>
            [waveEntity.created_by, waveEntity.voting_credit_creditor].filter(
              (id) => id !== null
            ) as string[]
        )
        .flat(),
      ...curationEntities.map((curationEntity) => curationEntity.created_by)
    ]);
    const profileMins: Record<string, ProfileMin> = await this.profilesService
      .getProfileMinsByIds(profileIds)
      .then((profileMins) =>
        profileMins.reduce((acc, profileMin) => {
          acc[profileMin.id] = {
            ...profileMin
          };
          return acc;
        }, {} as Record<string, ProfileMin>)
      );
    const curations: Record<string, Curation> = curationEntities.reduce(
      (acc, curationEntity) => {
        acc[curationEntity.id] = {
          id: curationEntity.id,
          name: curationEntity.name,
          author: profileMins[curationEntity.created_by],
          created_at: new Date(curationEntity.created_at).getTime()
        };
        return acc;
      },
      {} as Record<string, Curation>
    );
    return waveEntities.map<Wave>((waveEntity) => {
      return {
        id: waveEntity.id,
        name: waveEntity.name,
        serial_no: waveEntity.serial_no,
        author: profileMins[waveEntity.created_by],
        description: waveEntity.description,
        created_at: waveEntity.created_at,
        voting: {
          scope: {
            type: resolveEnumOrThrow(
              WaveScopeTypeApi,
              waveEntity.voting_scope_type
            ),
            curation: waveEntity.voting_scope_curation_id
              ? curations[waveEntity.voting_scope_curation_id] ?? null
              : null
          },
          credit_type: resolveEnumOrThrow(
            WaveCreditTypeApi,
            waveEntity.voting_credit_type
          ),
          credit_scope: resolveEnumOrThrow(
            WaveCreditScopeApi,
            waveEntity.voting_credit_scope_type
          ),
          credit_category: waveEntity.voting_credit_category,
          creditor: waveEntity.voting_credit_creditor
            ? profileMins[waveEntity.voting_credit_creditor] ?? null
            : null,
          signature_required: waveEntity.voting_signature_required,
          period: {
            min: waveEntity.voting_period_start,
            max: waveEntity.voting_period_end
          }
        },
        visibility: {
          scope: {
            type: resolveEnumOrThrow(
              WaveScopeTypeApi,
              waveEntity.visibility_scope_type
            ),
            curation: waveEntity.visibility_scope_curation_id
              ? curations[waveEntity.visibility_scope_curation_id] ?? null
              : null
          }
        },
        participation: {
          scope: {
            type: resolveEnumOrThrow(
              WaveScopeTypeApi,
              waveEntity.participation_scope_type
            ),
            curation: waveEntity.participation_scope_curation_id
              ? curations[waveEntity.participation_scope_curation_id] ?? null
              : null
          },
          no_of_applications_allowed_per_participant:
            waveEntity.participation_max_applications_per_participant,
          required_metadata: JSON.parse(
            waveEntity.participation_required_metadata
          ),
          signature_required: waveEntity.voting_signature_required,
          period: {
            min: waveEntity.participation_period_start,
            max: waveEntity.participation_period_end
          }
        },
        wave: {
          type: resolveEnumOrThrow(WaveTypeApi, waveEntity.type),
          winning_thresholds: {
            min: waveEntity.winning_min_threshold,
            max: waveEntity.winning_max_threshold
          },
          max_winners: waveEntity.max_winners,
          time_lock_ms: waveEntity.time_lock_ms,
          period: {
            min: waveEntity.wave_period_start,
            max: waveEntity.wave_period_end
          }
        },
        outcomes: JSON.parse(waveEntity.outcomes)
      };
    });
  }
}

export const wavesMappers = new WavesMappers(
  profilesService,
  communityMemberCriteriaService
);
