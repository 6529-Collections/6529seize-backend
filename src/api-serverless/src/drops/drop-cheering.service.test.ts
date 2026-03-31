jest.mock('../api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));

import { mock } from 'ts-jest-mocker';
import { DropsDb } from '@/drops/drops.db';
import { ReactionsService } from '@/api/drops/reactions.service';
import { VoteForDropUseCase } from '@/drops/vote-for-drop.use-case';
import { WaveQuickVoteDb } from '@/api/waves/wave-quick-vote.db';
import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { DropsApiService } from '@/api/drops/drops.api.service';
import { DropEntity, DropType } from '@/entities/IDrop';
import { DropCheeringService } from './drop-cheering.service';

describe('DropCheeringService', () => {
  let dropsDb: DropsDb;
  let reactionsService: ReactionsService;
  let voteForDrop: VoteForDropUseCase;
  let waveQuickVoteDb: WaveQuickVoteDb;
  let wsListenersNotifier: WsListenersNotifier;
  let dropsService: DropsApiService;
  let service: DropCheeringService;

  const connection = {} as any;
  const dropEntity: DropEntity = {
    serial_no: 1,
    id: 'drop-1',
    wave_id: 'wave-1',
    author_id: 'author-1',
    created_at: 100,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.PARTICIPATORY,
    signature: null,
    hide_link_preview: false
  };

  beforeEach(() => {
    dropsDb = mock();
    reactionsService = mock();
    voteForDrop = mock();
    waveQuickVoteDb = mock();
    wsListenersNotifier = mock();
    dropsService = mock();

    service = new DropCheeringService(
      dropsDb,
      reactionsService,
      voteForDrop,
      waveQuickVoteDb,
      wsListenersNotifier,
      dropsService
    );

    (dropsDb.executeNativeQueriesInTransaction as jest.Mock).mockImplementation(
      async (fn) => await fn(connection)
    );
    (dropsDb.findDropByIdWithEligibilityCheck as jest.Mock).mockResolvedValue(
      dropEntity
    );
    (voteForDrop.execute as jest.Mock).mockResolvedValue(true);
    (waveQuickVoteDb.insertSkip as jest.Mock).mockResolvedValue(undefined);
    (waveQuickVoteDb.findNextUndiscoveredDrop as jest.Mock).mockResolvedValue({
      id: 'another-drop'
    });
    (waveQuickVoteDb.clearSkips as jest.Mock).mockResolvedValue(undefined);
    (dropsService.findDropByIdOrThrow as jest.Mock).mockResolvedValue({
      id: dropEntity.id
    });
    (
      wsListenersNotifier.notifyAboutDropRatingUpdate as jest.Mock
    ).mockResolvedValue(undefined);
  });

  it('registers a skip when a quick vote submits a 0 rating', async () => {
    await service.updateCheers(
      {
        drop_id: dropEntity.id,
        rater_profile_id: 'identity-1',
        groupIdsUserIsEligibleFor: [],
        cheersChange: 0
      },
      {}
    );

    expect(voteForDrop.execute).toHaveBeenCalledWith(
      {
        drop_id: dropEntity.id,
        voter_id: 'identity-1',
        votes: 0,
        wave_id: dropEntity.wave_id,
        proxy_id: null
      },
      { connection }
    );
    expect(waveQuickVoteDb.insertSkip).toHaveBeenCalledWith(
      {
        identity_id: 'identity-1',
        wave_id: dropEntity.wave_id,
        drop_id: dropEntity.id
      },
      { connection }
    );
  });

  it('only registers a skip when a 0 rating is a no-op', async () => {
    (voteForDrop.execute as jest.Mock).mockResolvedValue(false);

    await service.updateCheers(
      {
        drop_id: dropEntity.id,
        rater_profile_id: 'identity-1',
        groupIdsUserIsEligibleFor: [],
        cheersChange: 0
      },
      {}
    );

    expect(waveQuickVoteDb.insertSkip).toHaveBeenCalledWith(
      {
        identity_id: 'identity-1',
        wave_id: dropEntity.wave_id,
        drop_id: dropEntity.id
      },
      { connection }
    );
    expect(waveQuickVoteDb.findNextUndiscoveredDrop).not.toHaveBeenCalled();
    expect(waveQuickVoteDb.clearSkips).not.toHaveBeenCalled();
    expect(dropsService.findDropByIdOrThrow).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropRatingUpdate
    ).not.toHaveBeenCalled();
  });

  it('does nothing extra when a non-zero rating is a no-op', async () => {
    (voteForDrop.execute as jest.Mock).mockResolvedValue(false);

    await service.updateCheers(
      {
        drop_id: dropEntity.id,
        rater_profile_id: 'identity-1',
        groupIdsUserIsEligibleFor: [],
        cheersChange: 1
      },
      {}
    );

    expect(waveQuickVoteDb.insertSkip).not.toHaveBeenCalled();
    expect(waveQuickVoteDb.findNextUndiscoveredDrop).not.toHaveBeenCalled();
    expect(waveQuickVoteDb.clearSkips).not.toHaveBeenCalled();
    expect(dropsService.findDropByIdOrThrow).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropRatingUpdate
    ).not.toHaveBeenCalled();
  });

  it('clears quick-vote skips when the action completes the last undiscovered drop', async () => {
    (waveQuickVoteDb.findNextUndiscoveredDrop as jest.Mock).mockResolvedValue(
      null
    );

    await service.updateCheers(
      {
        drop_id: dropEntity.id,
        rater_profile_id: 'identity-1',
        groupIdsUserIsEligibleFor: [],
        cheersChange: 1
      },
      {}
    );

    expect(waveQuickVoteDb.clearSkips).toHaveBeenCalledWith(
      {
        identity_id: 'identity-1',
        wave_id: dropEntity.wave_id
      },
      { connection }
    );
  });

  it('does not clear quick-vote skips while undiscovered drops remain', async () => {
    await service.updateCheers(
      {
        drop_id: dropEntity.id,
        rater_profile_id: 'identity-1',
        groupIdsUserIsEligibleFor: [],
        cheersChange: 1
      },
      {}
    );

    expect(waveQuickVoteDb.clearSkips).not.toHaveBeenCalled();
  });

  it('does not register a skip for a non-zero rating', async () => {
    await service.updateCheers(
      {
        drop_id: dropEntity.id,
        rater_profile_id: 'identity-1',
        groupIdsUserIsEligibleFor: [],
        cheersChange: 1
      },
      {}
    );

    expect(waveQuickVoteDb.insertSkip).not.toHaveBeenCalled();
  });

  it('still checks for reset after a non-zero rating', async () => {
    await service.updateCheers(
      {
        drop_id: dropEntity.id,
        rater_profile_id: 'identity-1',
        groupIdsUserIsEligibleFor: [],
        cheersChange: 1
      },
      {}
    );

    expect(waveQuickVoteDb.findNextUndiscoveredDrop).toHaveBeenCalledWith(
      {
        identity_id: 'identity-1',
        wave_id: dropEntity.wave_id
      },
      { connection }
    );
  });
});
