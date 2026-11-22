import 'reflect-metadata';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as executor from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aRepRating, withRatings } from '@/tests/fixtures/rating.fixture';
import {
  anAddressConsolidationKeys,
  withAddressConsolidationKeys
} from '@/tests/fixtures/address-consolidation-key.fixture';
import { IDENTITY_TDH_SYNC_STATE_TABLE, TDH_BLOCKS_TABLE } from '@/constants';
import { runCli } from './cli';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const ALICE = '00000000-0000-4000-8000-0000000a11ce';
const BOB = '00000000-0000-4000-8000-000000000b0b';
const HELP_BOT = '00000000-0000-4000-8000-0000000000b0';
const FREEZE = Date.UTC(2026, 10, 24);
const BLOCK = 24_000_000;
const REV = 'c'.repeat(40);

/**
 * The export run as the team runs it: the CLI, unmocked, on the database,
 * through doInDbContext, db-api's read pool and one read-only snapshot.
 */
describeWithSeed(
  'identity:export CLI on the database',
  [
    withIdentities([
      anIdentity(
        // 4 of Alice's REP is the help bot's credit.
        { tdh: 98, rep: 4, level_raw: 102 },
        {
          consolidation_key: W(1),
          profile_id: ALICE,
          primary_address: W(1),
          handle: 'Alice'
        }
      ),
      anIdentity(
        { tdh: 500, rep: 5, level_raw: 505 },
        {
          consolidation_key: W(2),
          profile_id: BOB,
          primary_address: W(2),
          handle: 'bob'
        }
      ),
      anIdentity(
        {},
        {
          consolidation_key: W(3),
          profile_id: HELP_BOT,
          primary_address: W(3),
          handle: 'help6529'
        }
      )
    ] as any),
    withProfiles([
      aProfile({ external_id: ALICE, handle: 'Alice', primary_wallet: W(1) }),
      aProfile({ external_id: BOB, handle: 'bob', primary_wallet: W(2) }),
      aProfile({
        external_id: HELP_BOT,
        handle: 'help6529',
        primary_wallet: W(3)
      })
    ]),
    withRatings([
      aRepRating({
        rater_profile_id: ALICE,
        matter_target_id: BOB,
        matter_category: 'Good',
        rating: 5
      }),
      aRepRating({
        rater_profile_id: HELP_BOT,
        matter_target_id: ALICE,
        matter_category: 'Help6529 Credits',
        rating: 4
      })
    ]),
    withAddressConsolidationKeys([
      ...anAddressConsolidationKeys([W(1)]),
      ...anAddressConsolidationKeys([W(2)]),
      ...anAddressConsolidationKeys([W(3)])
    ]),
    {
      table: TDH_BLOCKS_TABLE,
      // The last block before 00:00 UTC, as 6529.io takes it.
      rows: [{ block_number: BLOCK, timestamp: new Date(FREEZE - 12_000) }]
    },
    {
      table: IDENTITY_TDH_SYNC_STATE_TABLE,
      rows: [
        { id: 'pending', generation: 3, block: BLOCK },
        { id: 'synced', generation: 3, block: BLOCK },
        { id: 'full_announce', generation: 0, block: BLOCK }
      ]
    }
  ],
  () => {
    let dir: string;
    let stdout: jest.SpyInstance;
    let stderr: jest.SpyInstance;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-export-db-'));
      stdout = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      stderr = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
    });
    afterEach(() => {
      stdout.mockRestore();
      stderr.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Runs the CLI, then gives the tests back their own executor. */
    async function run(args: string[]): Promise<number> {
      const tests = executor.sqlExecutor;
      try {
        return await runCli(args);
      } finally {
        executor.setSqlExecutor(tests);
      }
    }

    it('writes a rehearsal export', async () => {
      const out = path.join(dir, 'rehearsal.json');
      expect(
        await run([
          '--out',
          out,
          '--revision',
          REV,
          '--no-freeze',
          '--no-extra-ids'
        ])
      ).toBe(0);
      const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(doc.format).toBe('6529.identity-export.v1');
      expect(doc.identity_sync).toBeUndefined();
      expect(doc.rules.rep).toBe('sum_of_file_ratings');
      expect(doc.tdh_block).toBe(BLOCK);
      const byId = new Map<string, any>(
        doc.identities.map((it: any) => [it.profile_id, it])
      );
      // Alice's REP is the help bot's credit only: none on the chain.
      expect(
        [ALICE, BOB].map((id) => [
          byId.get(id).rep,
          byId.get(id).level_raw,
          byId.get(id).level
        ])
      ).toEqual([
        [0, 98, 2],
        [5, 505, 5]
      ]);
      expect(doc.ratings).toEqual([
        expect.objectContaining({
          rater_profile_id: ALICE,
          target_profile_id: BOB,
          rating: 5
        })
      ]);
      expect(doc.stats.help_bot_credits_left_out).toBe(1);
      expect(doc.stats.over_credit_raters).toBe(0);
    });

    it('writes the export at the freeze, and refuses another day with exit 3', async () => {
      const atFreeze = [
        '--revision',
        REV,
        '--freeze-at',
        new Date(FREEZE).toISOString(),
        '--no-extra-ids'
      ];
      const out = path.join(dir, 'freeze.json');
      expect(
        await run(['--out', out, ...atFreeze, '--expect-tdh-block', `${BLOCK}`])
      ).toBe(0);
      const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(doc.freeze_ms).toBe(FREEZE);
      expect(doc.tdh_block_timestamp_ms).toBe(FREEZE - 12_000);
      expect(doc.stats).toEqual(
        expect.objectContaining({
          identity_sync_full_write_block: BLOCK,
          rating_edits_after_freeze: 0,
          ratings_modified_after_freeze: 0
        })
      );
      const other = path.join(dir, 'other.json');
      expect(
        await run([
          '--out',
          other,
          ...atFreeze,
          '--expect-tdh-block',
          `${BLOCK - 1}`
        ])
      ).toBe(3);
      expect(fs.existsSync(other)).toBe(false);
    });
  }
);
