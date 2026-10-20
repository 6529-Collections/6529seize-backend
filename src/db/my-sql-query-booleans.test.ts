import * as mysql from 'mysql';
import {
  withLegacyCompetitionGetFacade,
  withoutLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { env } from '@/env';
import { CustomTypeCaster, execSQLWithParams } from './my-sql.helpers';

function openConnection(pool: mysql.Pool): Promise<mysql.PoolConnection> {
  return new Promise((resolve, reject) => {
    pool.getConnection((error, connection) => {
      if (error) reject(error);
      else resolve(connection);
    });
  });
}

function closePool(pool: mysql.Pool): Promise<void> {
  return new Promise((resolve, reject) => {
    pool.end((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('query-scoped compatibility booleans on reused MySQL connections', () => {
  it.each([
    { socketStartsInFacade: false, negativeVotes: 0 },
    { socketStartsInFacade: false, negativeVotes: 1 },
    { socketStartsInFacade: true, negativeVotes: 0 },
    { socketStartsInFacade: true, negativeVotes: 1 }
  ])(
    'preserves query contracts with initial facade scope $socketStartsInFacade and flag $negativeVotes',
    async ({ socketStartsInFacade, negativeVotes }) => {
      const pool = mysql.createPool({
        host: env.getStringOrThrow('DB_HOST'),
        port: env.getIntOrThrow('DB_PORT'),
        user: env.getStringOrThrow('DB_USER'),
        password: env.getStringOrThrow('DB_PASS'),
        database: env.getStringOrThrow('DB_NAME'),
        connectionLimit: 1,
        typeCast: CustomTypeCaster
      });
      const initialScope = socketStartsInFacade
        ? withLegacyCompetitionGetFacade
        : withoutLegacyCompetitionGetFacade;
      try {
        const connection = await initialScope(() => openConnection(pool));
        try {
          for (const useFacade of [false, true, false, true]) {
            const queryScope = useFacade
              ? withLegacyCompetitionGetFacade
              : withoutLegacyCompetitionGetFacade;
            const rows = await queryScope(() =>
              execSQLWithParams(
                `SELECT CAST(:negativeVotes AS SIGNED) AS forbid_negative_votes,
                        CAST(1 AS SIGNED) AS voting_signature_required,
                        CAST(NULL AS SIGNED) AS participation_signature_required,
                        CAST(7 AS SIGNED) AS credit`,
                connection,
                false,
                { negativeVotes }
              )
            );
            expect(rows).toEqual([
              {
                forbid_negative_votes: useFacade
                  ? negativeVotes === 1
                  : negativeVotes,
                voting_signature_required: useFacade ? true : 1,
                participation_signature_required: null,
                credit: 7
              }
            ]);
          }
        } finally {
          connection.release();
        }
      } finally {
        await closePool(pool);
      }
    }
  );
});
