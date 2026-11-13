import {
  DELEGATIONS_TABLE,
  MEMES_CONTRACT,
  USE_CASE_MINTING
} from '@/constants';
import { writeDelegations } from '@/delegation-row';
import { Delegation, DelegationEvent, EventType } from '@/entities/IDelegation';
import { describeWithSeed } from '@/tests/_setup/seed';
import { DataSource, EntityManager } from 'typeorm';

const COLD = '0xc01d000000000000000000000000000000000c01';
const HOT_1 = '0x1111111111111111111111111111111111111111';
const HOT_2 = '0x2222222222222222222222222222222222222222';
const HOT_3 = '0x3333333333333333333333333333333333333333';

function seedRow(block: number, to: string) {
  return {
    block,
    from_address: COLD,
    to_address: to,
    collection: MEMES_CONTRACT,
    use_case: USE_CASE_MINTING,
    expiry: 100,
    all_tokens: true,
    token_id: 0
  };
}

function event(
  type: EventType,
  block: number,
  to: string,
  values: Partial<DelegationEvent> = {}
): DelegationEvent {
  return {
    block,
    type,
    wallet1: COLD,
    wallet2: to,
    collection: MEMES_CONTRACT,
    use_case: USE_CASE_MINTING,
    ...values
  };
}

const seeded = [seedRow(3, HOT_1), seedRow(3, HOT_2), seedRow(6, HOT_3)];

describeWithSeed(
  'writeDelegations',
  [{ table: DELEGATIONS_TABLE, rows: seeded }],
  () => {
    const dataSource = new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      entities: [Delegation],
      synchronize: false,
      logging: false,
      charset: 'utf8mb4',
      timezone: 'Etc/UTC'
    });

    beforeAll(async () => {
      await dataSource.initialize();
    });

    afterAll(async () => {
      await dataSource.destroy();
    });

    async function storedRows() {
      const rows: Record<string, unknown>[] = await dataSource.query(
        `SELECT block, to_address, expiry, all_tokens, token_id FROM ${DELEGATIONS_TABLE} ORDER BY block, to_address`
      );
      return rows.map((row) => [
        Number(row.block),
        row.to_address,
        Number(row.expiry),
        Boolean(Number(row.all_tokens)),
        Number(row.token_id)
      ]);
    }

    const write = (manager: EntityManager) =>
      writeDelegations(
        manager.getRepository(Delegation),
        5,
        [
          event(EventType.REGISTER, 10, HOT_1, {
            expiry: 1000,
            all_tokens: false,
            token_id: 7
          }),
          event(EventType.REGISTER, 10, HOT_1, {
            expiry: 1500,
            all_tokens: false,
            token_id: 8
          }),
          event(EventType.REGISTER, 13, HOT_1, {
            expiry: 2000,
            all_tokens: true,
            token_id: 0
          })
        ],
        [event(EventType.REVOKE, 9, HOT_1)]
      );

    it('replays from the start block, keeps token scope and applies revocations', async () => {
      await dataSource.transaction(write);

      expect(await storedRows()).toEqual([
        [3, HOT_2, 100, true, 0],
        [10, HOT_1, 1500, false, 8],
        [13, HOT_1, 2000, true, 0]
      ]);
    });

    it('leaves every row unchanged when the transaction fails', async () => {
      await expect(
        dataSource.transaction(async (manager) => {
          await write(manager);
          throw new Error('injected failure after the writes');
        })
      ).rejects.toThrow('injected failure after the writes');

      expect(await storedRows()).toEqual([
        [3, HOT_1, 100, true, 0],
        [3, HOT_2, 100, true, 0],
        [6, HOT_3, 100, true, 0]
      ]);
    });
  }
);
