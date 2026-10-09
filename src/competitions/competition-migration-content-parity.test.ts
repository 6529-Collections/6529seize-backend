import { compareMigrationContent } from './competition-migration-content-parity';
import {
  CompetitionEntryRepository,
  CompetitionEntryContent
} from './competition-entry.repository';
import { SqlExecutor } from '@/sql-executor';
import { DropEntity } from '@/entities/IDrop';
import { legacyCompetitionEntryId } from './competition-id';

const id = 'ba04bdeb-ffaa-5055-ae25-99a7d71dac80';
const waveId = 'c3018ba0-14e7-4145-8b9e-9e292c09ac4e';
const content: CompetitionEntryContent = {
  wave_id: waveId,
  title: null,
  parts: [],
  metadata: [],
  referenced_nfts: [],
  mentioned_waves: [],
  mentioned_groups: [],
  mentioned_users: [],
  reply_to: null,
  hide_link_preview: false
};

function fixture(count: number) {
  const drops = Array.from(
    { length: count },
    (_, n) => ({ id: `drop-${String(n).padStart(5, '0')}` }) as DropEntity
  );
  const execute = jest.fn(async (_sql: string, params: { cursor: string }) =>
    drops.filter((drop) => drop.id > params.cursor).slice(0, 100)
  );
  const oneOrNull = jest.fn(async () => ({ count }));
  const db = { execute, oneOrNull } as unknown as SqlExecutor;
  jest
    .spyOn(CompetitionEntryRepository.prototype, 'loadDropContent')
    .mockResolvedValue(content);
  const candidate = jest
    .spyOn(CompetitionEntryRepository.prototype, 'getContent')
    .mockResolvedValue(content);
  return { db, execute, oneOrNull, candidate, drops };
}

afterEach(() => jest.restoreAllMocks());

describe('complete paginated migration content comparison', () => {
  it('checks every entry beyond the former 1000-entry stop in the same transaction', async () => {
    const { db, execute, candidate } = fixture(1105);
    const result = await compareMigrationContent(db, id, waveId, {});
    expect(result[0].baselineHash).toBe(result[0].candidateHash);
    expect(execute).toHaveBeenCalledTimes(12);
    expect(candidate).toHaveBeenCalledTimes(1105);
  });
  it('detects changed content on a later page and extra native entries', async () => {
    const { db, candidate, drops, oneOrNull } = fixture(1001);
    candidate.mockImplementation(async (entryId) =>
      entryId === legacyCompetitionEntryId(id, drops[1000].id)
        ? { ...content, title: 'changed' }
        : content
    );
    const mismatch = await compareMigrationContent(db, id, waveId, {});
    expect(mismatch[0].baselineHash).not.toBe(mismatch[0].candidateHash);
    candidate.mockResolvedValue(content);
    oneOrNull.mockResolvedValue({ count: 1002 });
    const extra = await compareMigrationContent(db, id, waveId, {});
    expect(extra[0].baselineHash).not.toBe(extra[0].candidateHash);
  });
});
