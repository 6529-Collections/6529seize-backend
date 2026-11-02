import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  NFT_OWNERS_CONSOLIDATION_TABLE
} from '@/constants';
import { ConsolidatedOwnerBalancesMemes } from '@/entities/IOwnerBalances';
import { ConsolidatedNFTOwner } from '@/entities/INFTOwner';
import { deleteConsolidations } from '@/orm_helpers';
import { describeWithSeed } from '@/tests/_setup/seed';

const address = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const [a, b, c, d, e] = [1, 2, 3, 4, 5].map(address);
const keys = [
  a,
  `${a}-${b}`,
  `${b}-${a}-${c}`,
  `${b}-${c}-${d}-${a}`,
  `${d}-${e}`,
  `${a}0`
];

const dataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  entities: [ConsolidatedOwnerBalancesMemes, ConsolidatedNFTOwner],
  synchronize: false
});

beforeAll(async () => {
  await dataSource.initialize();
});
afterAll(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});

function deleteMemeConsolidations(wallets: Set<string>) {
  return dataSource.transaction((manager) =>
    deleteConsolidations(
      manager.getRepository(ConsolidatedOwnerBalancesMemes),
      wallets
    )
  );
}

describeWithSeed(
  'persisted consolidation cleanup',
  [
    {
      table: CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
      rows: keys.flatMap((consolidation_key) =>
        [1, 2].map((season) => ({
          consolidation_key,
          season,
          balance: 1,
          unique: 1,
          sets: 0
        }))
      )
    },
    {
      table: NFT_OWNERS_CONSOLIDATION_TABLE,
      rows: keys.flatMap((consolidation_key) =>
        [1, 2].map((token_id) => ({
          consolidation_key,
          token_id,
          contract: address(100),
          balance: 1
        }))
      )
    }
  ],
  () => {
    it('removes all seasons for old groups containing a changed member at any position', async () => {
      const repo = dataSource.getRepository(ConsolidatedOwnerBalancesMemes);
      expect(
        await dataSource.transaction((manager) =>
          deleteConsolidations(
            manager.getRepository(ConsolidatedOwnerBalancesMemes),
            new Set([a.toUpperCase(), b])
          )
        )
      ).toBe(8);
      const remaining = await repo.find();
      expect(remaining).toHaveLength(4);
      expect(new Set(remaining.map((row) => row.consolidation_key))).toEqual(
        new Set([`${d}-${e}`, `${a}0`])
      );
    });

    it('cleans every token row using the same shared helper', async () => {
      const repo = dataSource.getRepository(ConsolidatedNFTOwner);
      expect(
        await dataSource.transaction((manager) =>
          deleteConsolidations(
            manager.getRepository(ConsolidatedNFTOwner),
            new Set([a])
          )
        )
      ).toBe(8);
      expect(await repo.count()).toBe(4);
    });

    it('keeps deletion and replacement atomic after a consolidation changes', async () => {
      const repo = dataSource.getRepository(ConsolidatedOwnerBalancesMemes);
      await expect(
        dataSource.transaction(async (manager) => {
          await deleteConsolidations(
            manager.getRepository(ConsolidatedOwnerBalancesMemes),
            new Set([a])
          );
          throw new Error('replacement failed');
        })
      ).rejects.toThrow('replacement failed');
      expect(await repo.count()).toBe(12);

      await dataSource.transaction(async (manager) => {
        const txRepo = manager.getRepository(ConsolidatedOwnerBalancesMemes);
        await deleteConsolidations(txRepo, new Set([a]));
        await txRepo.insert({
          consolidation_key: `${a}-${c}`,
          season: 3,
          balance: 1,
          unique: 1,
          sets: 0
        });
      });
      expect(await repo.count()).toBe(5);
      expect(
        await repo.findOneBy({ consolidation_key: `${a}-${c}`, season: 3 })
      ).not.toBeNull();
    });

    it('deletes a group spanning pages while preserving siblings and seeking past bigint and mixed-case text keys', async () => {
      const repo = dataSource.getRepository(ConsolidatedNFTOwner);
      expect(
        new Set(
          repo.metadata.primaryColumns.map((column) => column.propertyPath)
        )
      ).toEqual(new Set(['token_id', 'contract', 'consolidation_key']));
      const base = BigInt('9007199254740993');
      const contract = `0x${'a'.repeat(40)}`;
      const rows = Array.from({ length: 1001 }, (_, i) => [
        (base + BigInt(i)).toString(),
        contract,
        a,
        1
      ]);
      rows.push([
        (base + BigInt(987)).toString(),
        contract.toUpperCase(),
        c,
        1
      ]);
      rows.push([(base + BigInt(1500)).toString(), contract, e, 1]);
      rows.push([(base + BigInt(2000)).toString(), contract, b, 1]);
      await dataSource.query(
        `INSERT INTO ${NFT_OWNERS_CONSOLIDATION_TABLE} (token_id, contract, consolidation_key, balance) VALUES ${rows.map(() => '(?, ?, ?, ?)').join(', ')}`,
        rows.flat()
      );
      expect(
        await repo
          .createQueryBuilder('owners')
          .select('owners.token_id', 'token_id')
          .where('owners.token_id = :tokenId', { tokenId: base.toString() })
          .getRawOne()
      ).toEqual({ token_id: base.toString() });
      const boundary = await repo
        .createQueryBuilder('owners')
        .select('owners.consolidation_key', 'key')
        .orderBy('owners.token_id', 'ASC')
        .addOrderBy('owners.contract', 'ASC')
        .addOrderBy('owners.consolidation_key', 'ASC')
        .limit(1001)
        .getRawMany<{ key: string }>();
      expect(boundary.slice(-2)).toEqual([{ key: a }, { key: c }]);
      expect(
        await dataSource.transaction((manager) =>
          deleteConsolidations(
            manager.getRepository(ConsolidatedNFTOwner),
            new Set([a, b])
          )
        )
      ).toBe(1010);
      expect(await repo.count()).toBe(6);
      expect(await repo.countBy({ consolidation_key: a })).toBe(0);
      expect(await repo.countBy({ consolidation_key: b })).toBe(0);
      expect(await repo.countBy({ consolidation_key: c })).toBe(1);
      expect(await repo.countBy({ consolidation_key: e })).toBe(1);
    });

    it('leaves all persisted keys intact for empty or unmatched changes', async () => {
      const repo = dataSource.getRepository(ConsolidatedOwnerBalancesMemes);
      expect(await deleteMemeConsolidations(new Set())).toBe(0);
      expect(await deleteMemeConsolidations(new Set([address(999)]))).toBe(0);
      expect(await repo.count()).toBe(12);
    });

    it('deletes more than one batch of unique groups and counts actual season rows', async () => {
      const repo = dataSource.getRepository(ConsolidatedOwnerBalancesMemes);
      const extraKeys = Array.from({ length: 1001 }, (_, i) =>
        address(i + 1000)
      );
      await repo.insert(
        extraKeys.flatMap((consolidation_key) =>
          [1, 2].map((season) => ({
            consolidation_key,
            season,
            balance: 1,
            unique: 1,
            sets: 0
          }))
        )
      );
      await expect(
        dataSource.transaction(async (manager) => {
          expect(
            await deleteConsolidations(
              manager.getRepository(ConsolidatedOwnerBalancesMemes),
              new Set(extraKeys)
            )
          ).toBe(2002);
          throw new Error('later replacement failed');
        })
      ).rejects.toThrow('later replacement failed');
      expect(await repo.count()).toBe(2014);
      expect(await deleteMemeConsolidations(new Set(extraKeys))).toBe(2002);
      expect(await repo.count()).toBe(12);
    });

    it('finds a late match across composite primary-key pages without deleting other rows', async () => {
      const repo = dataSource.getRepository(ConsolidatedOwnerBalancesMemes);
      const extraKeys = Array.from({ length: 1001 }, (_, i) =>
        address(i + 1000)
      );
      await repo.insert(
        extraKeys.flatMap((consolidation_key) =>
          [1, 2].map((season) => ({
            consolidation_key,
            season,
            balance: 1,
            unique: 1,
            sets: 0
          }))
        )
      );
      expect(await deleteMemeConsolidations(new Set([extraKeys[1000]]))).toBe(
        2
      );
      expect(await repo.count()).toBe(2012);
      expect(await repo.findBy({ consolidation_key: extraKeys[1000] })).toEqual(
        []
      );
    });
  }
);
