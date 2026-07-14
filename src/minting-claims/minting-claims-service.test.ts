import { DropsDb } from '@/drops/drops.db';
import { RequestContext } from '@/request.context';
import { MemeCardDropMappingsDb } from './meme-card-drop-mappings.db';
import { MintingClaimsDb } from './minting-claims.db';
import { MintingClaimsService } from './minting-claims.service';

type MappingInvoker = {
  saveMemeCardMappingIfMainStageWinner(
    dropId: string,
    memeCardId: number,
    ctx: RequestContext
  ): Promise<void>;
};

describe('MintingClaimsService Main Stage mapping', () => {
  it('resolves the Main Stage wave after runtime configuration loads', async () => {
    let mainStageWaveId: string | null = null;
    const mappingsDb = {
      isMainStageWinnerDrop: jest.fn().mockResolvedValue(true),
      setMemeCardIdForDrop: jest.fn().mockResolvedValue(undefined)
    } as unknown as MemeCardDropMappingsDb;
    const service = new MintingClaimsService(
      {} as DropsDb,
      {} as MintingClaimsDb,
      mappingsDb,
      () => mainStageWaveId
    ) as unknown as MappingInvoker;
    const ctx = { connection: {} } as RequestContext;

    await service.saveMemeCardMappingIfMainStageWinner('drop-1', 521, ctx);
    expect(mappingsDb.isMainStageWinnerDrop).not.toHaveBeenCalled();

    mainStageWaveId = 'main-stage-wave';
    await service.saveMemeCardMappingIfMainStageWinner('drop-1', 521, ctx);

    expect(mappingsDb.isMainStageWinnerDrop).toHaveBeenCalledWith(
      'drop-1',
      'main-stage-wave',
      ctx
    );
    expect(mappingsDb.setMemeCardIdForDrop).toHaveBeenCalledWith(
      'drop-1',
      521,
      'main-stage-wave',
      ctx
    );
  });
});
