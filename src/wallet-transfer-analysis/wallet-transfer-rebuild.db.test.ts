import 'reflect-metadata';
import {
  MEMES_CONTRACT,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE,
  WALLET_TRANSFER_ANALYSIS_STATES_TABLE,
  WALLET_TRANSFER_PAIR_DAYS_TABLE,
  WALLET_TRANSFER_WALLET_DAYS_TABLE
} from '@/constants';
import { connect, disconnect, getDataSource } from '@/db';
import * as Entities from '@/entities/entities';
import { Transaction } from '@/entities/ITransaction';
import { buildTransaction } from '@/tests/test.transactions.helpers';
import { walletTransferAnalysisService } from './wallet-transfer-analysis.service';
import { rebuildWalletTransferAnalysis } from './wallet-transfer-rebuild';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const TABLES = [
  WALLET_TRANSFER_PAIR_DAYS_TABLE,
  WALLET_TRANSFER_WALLET_DAYS_TABLE,
  WALLET_TRANSFER_ANALYSIS_STATES_TABLE
];

/** Memes transfers in three 1,000-block buckets, and a mint. */
function transfers(): Transaction[] {
  const at = (block: number, from: number, to: number, hour: number) => ({
    ...buildTransaction(
      from ? wallet(from) : NULL_ADDRESS,
      wallet(to),
      MEMES_CONTRACT.toLowerCase(),
      1
    ),
    block,
    transaction_date: new Date(Date.UTC(2026, 0, 2, hour))
  });
  return [
    at(1_200, 0, 1, 1),
    at(1_300, 1, 2, 2),
    at(1_301, 2, 1, 3),
    at(5_400, 1, 3, 30),
    at(9_999, 3, 2, 60)
  ];
}

async function analysis() {
  const rows = async (table: string, order: string) =>
    getDataSource().query(`SELECT * FROM ${table} ORDER BY ${order}`);
  return {
    pairs: await rows(
      WALLET_TRANSFER_PAIR_DAYS_TABLE,
      'bucket_start, day_start, from_address, to_address'
    ),
    wallets: await rows(
      WALLET_TRANSFER_WALLET_DAYS_TABLE,
      'bucket_start, day_start, wallet'
    ),
    states: (await rows(WALLET_TRANSFER_ANALYSIS_STATES_TABLE, 'contract')).map(
      ({ updated_at: _written, ...state }: Record<string, unknown>) => state
    )
  };
}

async function emptyAnalysis() {
  for (const table of TABLES) {
    await getDataSource().query(`DELETE FROM ${table}`);
  }
}

describe('the wallet transfer analysis rebuilt from empty', () => {
  beforeAll(async () => {
    await connect(
      Object.values(Entities).filter((e) => typeof e === 'function'),
      false
    );
    await getDataSource().query(`DELETE FROM ${TRANSACTIONS_TABLE}`);
    await getDataSource().getRepository(Transaction).save(transfers());
  });

  afterAll(async () => {
    await emptyAnalysis();
    await getDataSource().query(`DELETE FROM ${TRANSACTIONS_TABLE}`);
    await disconnect();
  });

  it('writes what the analysis writes one bucket at a time', async () => {
    // As an operator runs it: one bucket per invocation until caught up.
    await emptyAnalysis();
    for (let call = 0; call < 10; call++) {
      await walletTransferAnalysisService.update({
        maxBatches: 1,
        maxRows: 1_000
      });
    }
    const stepwise = await analysis();

    await emptyAnalysis();
    await rebuildWalletTransferAnalysis();
    const rebuilt = await analysis();

    expect(rebuilt).toEqual(stepwise);
    expect(
      rebuilt.pairs.map(
        (p: Record<string, unknown>) =>
          `${Number(p.bucket_start)} ${p.from_address}->${p.to_address}`
      )
    ).toEqual([
      `1000 ${wallet(1)}->${wallet(2)}`,
      `1000 ${wallet(2)}->${wallet(1)}`,
      `5000 ${wallet(1)}->${wallet(3)}`,
      `9000 ${wallet(3)}->${wallet(2)}`
    ]);
    expect(rebuilt.states).toEqual([
      expect.objectContaining({
        contract: MEMES_CONTRACT.toLowerCase(),
        last_block: 9_999
      })
    ]);
  });

  it('changes nothing when run again over the same transfers', async () => {
    const before = await analysis();
    await rebuildWalletTransferAnalysis();
    expect(await analysis()).toEqual(before);
  });
});
