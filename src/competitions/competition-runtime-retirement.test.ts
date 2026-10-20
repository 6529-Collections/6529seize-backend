import { createHash } from 'node:crypto';
import type { SqlExecutor } from '@/sql-executor';
import { transferCompetitionRetirementHistory } from './competition-retirement-history';
import {
  LEGACY_GET_SOURCE_TABLES,
  legacyCompetitionGetViewDefinition,
  legacyGetView
} from './legacy-competition-get-facade';
import {
  disableRetiredCompetitionCapture,
  retireLegacyCompetitionRuntime
} from './competition-runtime-retirement';

jest.mock('./competition-retirement-history', () => ({
  transferCompetitionRetirementHistory: jest.fn()
}));
jest.mock('./competition-schema', () => ({
  withCompetitionSchemaConnection: jest.fn(
    async (
      _db: unknown,
      action: (ctx: { connection: object }) => Promise<unknown>
    ) => action({ connection: {} })
  )
}));

describe('explicit competition runtime retirement safety', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails before copying or changing views when a live primary is missing native ownership', async () => {
    const execute = jest.fn().mockResolvedValue([{ id: 'untransferred-wave' }]);
    const db = { execute } as unknown as SqlExecutor;
    await expect(retireLegacyCompetitionRuntime(db)).rejects.toThrow(
      'Live original competition is not native'
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain('c.id is null');
    expect(transferCompetitionRetirementHistory).not.toHaveBeenCalled();
  });

  it('requires pending legacy effects to drain before any transfer', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'pending-effect' }]);
    await expect(
      retireLegacyCompetitionRuntime({ execute } as unknown as SqlExecutor)
    ).rejects.toThrow('Drain pending legacy execution effects');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(transferCompetitionRetirementHistory).not.toHaveBeenCalled();
  });

  it('rejects noncanonical retained chat values before changing their permanent GET projection', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'historic-chat-settings' }]);
    await expect(
      retireLegacyCompetitionRuntime({ execute } as unknown as SqlExecutor)
    ).rejects.toThrow(
      'Retained chat configuration requires native compatibility preservation'
    );
    expect(transferCompetitionRetirementHistory).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('does not reimport retained sources after every native view has switched', async () => {
    const execute = jest.fn(async (sql: string) =>
      sql.includes('information_schema.VIEWS')
        ? LEGACY_GET_SOURCE_TABLES.map((table) => ({
            name: legacyGetView(table),
            definition: legacyCompetitionGetViewDefinition(table)
          }))
        : []
    );
    const result = await retireLegacyCompetitionRuntime({
      execute,
      oneOrNull: jest.fn().mockResolvedValue({ timeout: 5 }),
      executeNativeQueriesInTransaction: (
        action: (connection: object) => Promise<unknown>
      ) => action({})
    } as unknown as SqlExecutor);
    expect(result.already_retired).toBe(true);
    expect(result.history).toEqual([]);
    expect(transferCompetitionRetirementHistory).not.toHaveBeenCalled();
    expect(
      execute.mock.calls.filter(([sql]) => sql.startsWith('create or replace'))
    ).toHaveLength(LEGACY_GET_SOURCE_TABLES.length);
    expect(execute.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(
      false
    );
  });

  it('validates the entire capture namespace before dropping any trigger', async () => {
    const known =
      'competition_capture_' +
      createHash('sha256')
        .update('legacy-migration-capture-v1:drops:UPDATE')
        .digest('hex')
        .slice(0, 16);
    const execute = jest
      .fn()
      .mockResolvedValue([
        { TRIGGER_NAME: known },
        { TRIGGER_NAME: 'competition_capture_unrecognized' }
      ]);
    await expect(
      disableRetiredCompetitionCapture({ execute } as unknown as SqlExecutor)
    ).rejects.toThrow('Unrecognized competition capture trigger');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
