import 'reflect-metadata';
import nextgenRoutes, {
  nextgenWriteSpec,
  persistAllowlist,
  persistCollectionBurn
} from '@/api/nextgen/nextgen.routes';
import { MINT_LOG_HEAD_TABLE } from '@/constants';
import {
  NEXTGEN_ALLOWLIST_BURN_TABLE,
  NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
  NEXTGEN_ALLOWLIST_TABLE,
  NEXTGEN_BURN_COLLECTIONS_TABLE
} from '@/nextgen/nextgen_constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { allOk, apiAnswers } from './mint-log-api-answers.test-utils';
import { mintStateReader } from './mint-log-capture';
import { differingParts } from './mint-log-diff';
import { MintContentPort, runMintGenesis } from './mint-log-genesis';
import { mintCard } from './mint-log-parts';
import type { MintRecordLogEntry, MintRecordLogPort } from './mint-log-ports';
import { MintLogRebuilder } from './mint-log-rebuild';
import { MintLogRecorder } from './mint-log-recorder';
import { MintLogEntryBody, NEXTGEN_CARD_CONTRACT } from './mint-log.types';

const COLLECTION = 3;
const CARD = mintCard(NEXTGEN_CARD_CONTRACT, COLLECTION);
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const ROOT = (c: string) => `0x${c.repeat(64)}`;
const ADMIN = W(9);

const signed = {
  wallet: ADMIN,
  signature: '0xsignature',
  signature_message: 'signed message',
  payload: { collection_id: COLLECTION, uuid: 'u1' }
};

function allowlistUpload(root: string, wallets: number[], phase = 'Phase 1') {
  return {
    collection_id: COLLECTION,
    added_by: ADMIN,
    al_type: 'allowlist',
    phase,
    start_time: 1700000000,
    end_time: 1700003600,
    mint_price: 0.05,
    allowlist_sha256: 'a'.repeat(64),
    signed,
    merkle: {
      merkle_root: root,
      // As merkletreejs serializes its leaves: Buffers of each keccak.
      merkle_tree: {
        leaves: wallets.map((n) => ({
          type: 'Buffer',
          data: Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'))
        }))
      },
      allowlist: wallets.map((n) => ({
        address: W(n),
        spots: n,
        info: `info-${n}`,
        keccak: `0x${n.toString(16).padStart(64, '0')}`
      }))
    }
  };
}

async function capture() {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    mintStateReader.capture(CARD, connection)
  );
}

describeWithSeed('mint log on MySQL: NextGen', [], () => {
  const entries: MintLogEntryBody[] = [];
  const log: MintRecordLogPort = {
    append: async (queued: readonly MintRecordLogEntry[]) => {
      for (const entry of queued) {
        if (entry.t === 'entry') {
          entries.push(entry.body as unknown as MintLogEntryBody);
        }
      }
    }
  };
  const recorder = new MintLogRecorder(
    {
      isMintLogShadowEnabled: () => false,
      // Primary: a wallet-signed NextGen upload needs no device record.
      isMintLogPrimaryEnabled: () => true,
      isMintLogReplayCheckEnabled: () => true
    },
    () => ({ records: null, log })
  );
  const files = new Map<string, Buffer>();
  const content: MintContentPort = {
    put: async (name, bytes) => {
      files.set(name, bytes);
      return name;
    },
    get: async (cid) => files.get(cid)!
  };

  it('logs allowlist uploads and burn registrations, and rebuilds them', async () => {
    await runMintGenesis({ content, log, chains: ['mint'] });
    const first = allowlistUpload(ROOT('1'), [1, 2]);
    await recorder.write(
      nextgenWriteSpec(
        'nextgen.allowlist',
        'POST /nextgen/create_allowlist',
        first
      ),
      () => persistAllowlist(first)
    );
    // A new upload for the same phase replaces the first one.
    const second = allowlistUpload(ROOT('2'), [2, 3, 4]);
    await recorder.write(
      nextgenWriteSpec(
        'nextgen.allowlist',
        'POST /nextgen/create_allowlist',
        second
      ),
      () => persistAllowlist(second)
    );
    const burn = {
      collection_id: COLLECTION,
      burn_collection: W(7),
      burn_collection_id: 1,
      min_token_index: 0,
      max_token_index: 99,
      burn_address: W(8),
      status: true,
      signed
    };
    await recorder.write(
      nextgenWriteSpec(
        'nextgen.burn',
        'POST /nextgen/register_burn_collection',
        burn
      ),
      () => persistCollectionBurn(burn)
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      'mint.genesis',
      'nextgen.allowlist',
      'nextgen.allowlist',
      'nextgen.burn'
    ]);
    for (const entry of entries.slice(1)) {
      expect(entry.checks).toEqual({
        undeclared: [],
        merkle_raw: [],
        replay: 'match',
        replay_mismatches: []
      });
      expect(entry.actor).toEqual({
        type: 'admin',
        wallet: ADMIN,
        authority: 'ethereum:nextgen-admin'
      });
      expect(entry.intent.body).toEqual(signed);
    }
    expect(entries[2].inputs).toEqual({
      allowlist_sha256: 'a'.repeat(64),
      merkle_root: ROOT('2')
    });
    expect(entries[2].effects.nextgen_allowlist_rows?.delete).toHaveLength(2);
    expect(entries[2].effects.nextgen_allowlist_rows?.upsert).toHaveLength(3);

    const live = await capture();
    expect(live.nextgen_allowlists).toHaveLength(1);
    expect(live.nextgen_burn_collection).toHaveLength(1);
    // The public allowlist and proof endpoints, through the real router.
    const endpoints = () =>
      apiAnswers(
        [['/nextgen', nextgenRoutes]],
        [
          `/nextgen/merkle_roots/${ROOT('2')}`,
          `/nextgen/${COLLECTION}/allowlist_merkle/${ROOT('2')}`,
          `/nextgen/${COLLECTION}/allowlist_merkle`,
          `/nextgen/proofs/${ROOT('2')}/${W(3)}`,
          `/nextgen/proofs?address=${W(4)}`,
          `/nextgen/allowlist_phases`,
          `/nextgen/allowlist_phases/${COLLECTION}`
        ]
      );
    const answers = await endpoints();
    expect(allOk(answers)).toEqual([]);
    expect(answers[`/nextgen/proofs/${ROOT('2')}/${W(3)}`].body).not.toEqual(
      []
    );

    for (const table of [
      NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE,
      NEXTGEN_ALLOWLIST_TABLE,
      NEXTGEN_ALLOWLIST_BURN_TABLE,
      NEXTGEN_BURN_COLLECTIONS_TABLE,
      MINT_LOG_HEAD_TABLE
    ]) {
      await sqlExecutor.execute(`delete from ${table}`);
    }
    await new MintLogRebuilder(content).rebuild(entries);
    expect(differingParts(await capture(), live)).toEqual([]);
    expect(await endpoints()).toEqual(answers);
  });
});
