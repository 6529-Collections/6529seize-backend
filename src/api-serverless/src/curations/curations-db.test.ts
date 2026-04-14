import { DropCurationEntity } from '@/entities/IDropCuration';
import { CurationsDb } from './curations.db';

describe('CurationsDb', () => {
  it('locks drop curations in deterministic curation order when deleting by drop id', async () => {
    const repo = new CurationsDb(() => ({}) as any);
    const ctx = {
      timer: undefined,
      connection: { connection: 'tx' }
    } as any;
    const targetCurations: DropCurationEntity[] = [
      {
        drop_id: 'drop-1',
        curation_id: 'curation-c',
        wave_id: 'wave-a',
        curated_by: 'profile-1',
        created_at: 1,
        updated_at: 1,
        priority_order: 1
      },
      {
        drop_id: 'drop-1',
        curation_id: 'curation-a',
        wave_id: 'wave-b',
        curated_by: 'profile-1',
        created_at: 1,
        updated_at: 1,
        priority_order: 1
      },
      {
        drop_id: 'drop-1',
        curation_id: 'curation-b',
        wave_id: 'wave-a',
        curated_by: 'profile-1',
        created_at: 1,
        updated_at: 1,
        priority_order: 1
      }
    ];
    const lockOrder: string[] = [];

    jest
      .spyOn(repo, 'findDropCurationsForDropId')
      .mockResolvedValue(targetCurations);
    jest
      .spyOn(repo, 'lockWaveCurationById')
      .mockImplementation(async ({ id, wave_id }) => {
        lockOrder.push(`wave:${id}:${wave_id}`);
        return null;
      });
    jest
      .spyOn(repo, 'lockDropCurationsByCurationId')
      .mockImplementation(async (curationId) => {
        lockOrder.push(`drops:${curationId}`);
        return targetCurations.filter(
          (curation) => curation.curation_id === curationId
        );
      });
    jest.spyOn(repo, 'deleteDropCuration').mockResolvedValue(undefined);
    jest
      .spyOn(repo, 'decrementDropCurationPriorityOrderRange')
      .mockResolvedValue(undefined);

    await repo.deleteDropCurationsByDropId('drop-1', ctx);

    expect(lockOrder).toEqual([
      'wave:curation-a:wave-b',
      'drops:curation-a',
      'wave:curation-b:wave-a',
      'drops:curation-b',
      'wave:curation-c:wave-a',
      'drops:curation-c'
    ]);
  });
});
