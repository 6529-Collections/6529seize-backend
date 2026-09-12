import { AbusivenessCheckService } from '../profiles/abusiveness-check.service';
import { ConnectionWrapper } from '../sql-executor';
import { CicStatementGroup } from '../entities/ICICStatement';
import { CicDb } from './cic.db';
import { CicService } from './cic.service';
import { MAX_ART_LINK_LENGTH } from './cic-statement-validation';

jest.mock('../profileActivityLogs/profile-activity-logs.db', () => ({
  profileActivityLogsDb: {
    insert: jest.fn().mockResolvedValue(undefined)
  }
}));

describe('CicService', () => {
  it('serializes profile validation and accepts a custom art URL at the contract limit', async () => {
    const connection: ConnectionWrapper<unknown> = { connection: {} };
    const lockProfileForCicStatementMutation = jest
      .fn()
      .mockResolvedValue(undefined);
    const getCicStatementsByProfileId = jest.fn().mockResolvedValue([]);
    const insertCicStatement = jest.fn().mockImplementation((statement) => ({
      ...statement,
      id: 'statement-id',
      crated_at: new Date(0)
    }));
    const cicDb = {
      executeNativeQueriesInTransaction: jest.fn((executable) =>
        executable(connection)
      ),
      lockProfileForCicStatementMutation,
      getCicStatementsByProfileId,
      insertCicStatement
    } as unknown as CicDb;
    const service = new CicService(cicDb, {} as AbusivenessCheckService);
    const urlPrefix = 'https://example.art/';
    const statementValue =
      urlPrefix + 'a'.repeat(MAX_ART_LINK_LENGTH - urlPrefix.length);

    await expect(
      service.addCicStatement({
        statement: {
          profile_id: 'profile-id',
          statement_group: CicStatementGroup.NFT_ACCOUNTS,
          statement_type: 'LINK',
          statement_comment: 'AOTM',
          statement_value: statementValue
        },
        profile: {
          handle: 'artist',
          profile_id: 'profile-id',
          classification: null
        }
      })
    ).resolves.toMatchObject({ statement_value: statementValue });

    expect(lockProfileForCicStatementMutation).toHaveBeenCalledWith(
      'profile-id',
      connection
    );
    expect(
      lockProfileForCicStatementMutation.mock.invocationCallOrder[0]
    ).toBeLessThan(getCicStatementsByProfileId.mock.invocationCallOrder[0]!);
  });
});
