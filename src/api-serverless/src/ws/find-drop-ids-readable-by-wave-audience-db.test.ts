import 'reflect-metadata';
import { DROPS_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';

const publicWave = aWave({});
const groupWave = aWave({ visibility_group_id: 'group-a' });
const sameGroupWave = aWave({ visibility_group_id: 'group-a' });
const otherGroupWave = aWave({ visibility_group_id: 'group-b' });
const publicChildOfGroupWave = aWave({ parent_wave_id: groupWave.id });
const otherChildOfGroupWave = aWave({
  visibility_group_id: 'group-b',
  parent_wave_id: groupWave.id
});
const grandchildWave = aWave({ parent_wave_id: publicChildOfGroupWave.id });

function aDropRow(id: string, waveId: string, serialNo: number) {
  return {
    id,
    serial_no: serialNo,
    wave_id: waveId,
    author_id: 'author-1',
    created_at: serialNo,
    title: null,
    parts_count: 1,
    drop_type: DropType.CHAT,
    reply_to_drop_id: null
  };
}

const drops = [
  aDropRow('in-public', publicWave.id, 1),
  aDropRow('in-group', groupWave.id, 2),
  aDropRow('in-same-group', sameGroupWave.id, 3),
  aDropRow('in-other-group', otherGroupWave.id, 4),
  aDropRow('in-public-child', publicChildOfGroupWave.id, 5),
  aDropRow('in-other-child', otherChildOfGroupWave.id, 6),
  aDropRow('in-grandchild', grandchildWave.id, 7)
];
const allDropIds = [...drops.map((drop) => drop.id), 'missing-drop'];

describeWithSeed(
  'WsConnectionRepository.findDropIdsReadableByWaveAudience',
  [
    withWaves([
      publicWave,
      groupWave,
      sameGroupWave,
      otherGroupWave,
      publicChildOfGroupWave,
      otherChildOfGroupWave,
      grandchildWave
    ]),
    { table: DROPS_TABLE, rows: drops }
  ],
  () => {
    const repo = new WsConnectionRepository(
      () => sqlExecutor,
      {} as never,
      () => false
    );
    const ctx: RequestContext = { timer: undefined };

    async function readable(waveId: string): Promise<string[]> {
      const ids = await repo.findDropIdsReadableByWaveAudience(
        { waveId, dropIds: allDropIds },
        ctx
      );
      return Array.from(ids).sort((a, b) => a.localeCompare(b));
    }

    it('limits a public wave audience to public quoted drops', async () => {
      await expect(readable(publicWave.id)).resolves.toEqual(['in-public']);
    });

    it('allows quoted drops whose required groups the audience already has', async () => {
      await expect(readable(groupWave.id)).resolves.toEqual([
        'in-group',
        'in-public',
        'in-public-child',
        'in-same-group'
      ]);
      await expect(readable(publicChildOfGroupWave.id)).resolves.toEqual([
        'in-group',
        'in-public',
        'in-public-child',
        'in-same-group'
      ]);
    });

    it('requires every group of a quoted subwave and its parent', async () => {
      await expect(readable(otherGroupWave.id)).resolves.toEqual([
        'in-other-group',
        'in-public'
      ]);
      await expect(readable(otherChildOfGroupWave.id)).resolves.toEqual([
        'in-group',
        'in-other-child',
        'in-other-group',
        'in-public',
        'in-public-child',
        'in-same-group'
      ]);
    });

    it('returns nothing for an unknown audience wave', async () => {
      await expect(readable('missing-wave')).resolves.toEqual([]);
    });

    it('returns nothing for an audience wave deeper than the supported hierarchy', async () => {
      await expect(readable(grandchildWave.id)).resolves.toEqual([]);
    });
  }
);
