import 'reflect-metadata';
import {
  NFT_OWNERS_CONSOLIDATION_TABLE,
  TRANSFER_RECONCILIATIONS_TABLE
} from '@/constants';
import { consolidationTools } from '@/consolidation-tools';
import { connect, disconnect, getDataSource } from '@/db';
import { AddressConsolidationKey } from '@/entities/IAddressConsolidationKey';
import { ConsolidatedNFTOwner, NFTOwner } from '@/entities/INFTOwner';
import { TransferReconciliationEntity } from '@/entities/ITransferReconciliation';
import { consolidateNftOwners } from '@/nftOwnersLoop/nft_owners';
import { Time } from '@/time';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import { deferGroupsThatDoNotFit } from './consolidation-key-fit';

const CONTRACT = `0x${'a'.padStart(40, '0')}`;

function wallet(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

function owner(walletAddress: string, tokenId: number, balance: number) {
  const o = new NFTOwner();
  o.wallet = walletAddress;
  o.contract = CONTRACT;
  o.token_id = tokenId;
  o.balance = balance;
  o.block_reference = 100;
  return o;
}

async function setKeyWidth(width: number) {
  await getDataSource().query(
    `ALTER TABLE ${NFT_OWNERS_CONSOLIDATION_TABLE} MODIFY COLUMN consolidation_key VARCHAR(${width}) NOT NULL`
  );
}

async function consolidatedRows() {
  const rows = await getDataSource().getRepository(ConsolidatedNFTOwner).find();
  return rows
    .map((row) => ({
      key: row.consolidation_key,
      token: Number(row.token_id),
      balance: row.balance
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe('consolidated NFT owners before the key columns are widened', () => {
  const members = [1, 2, 3, 4, 5].map(wallet);
  const loner = wallet(99);
  const fiveKey = consolidationTools.buildConsolidationKey(members);
  const oldKey = consolidationTools.buildConsolidationKey(members.slice(0, 4));

  beforeAll(async () => {
    await connect(
      [
        NFTOwner,
        ConsolidatedNFTOwner,
        AddressConsolidationKey,
        TransferReconciliationEntity
      ],
      true
    );
  });

  afterAll(async () => {
    await setKeyWidth(700);
    for (const entity of [
      NFTOwner,
      ConsolidatedNFTOwner,
      AddressConsolidationKey,
      TransferReconciliationEntity
    ]) {
      await getDataSource().getRepository(entity).clear();
    }
    await disconnect();
    jest.restoreAllMocks();
  });

  it('keeps the old rows and requeues a group whose key does not fit, then writes it once the column is wide', async () => {
    const dataSource = getDataSource();
    for (const entity of [
      NFTOwner,
      ConsolidatedNFTOwner,
      AddressConsolidationKey,
      TransferReconciliationEntity
    ]) {
      await dataSource.getRepository(entity).clear();
    }
    await setKeyWidth(200);
    await dataSource
      .getRepository(NFTOwner)
      .insert([...members.map((w) => owner(w, 1, 1)), owner(loner, 2, 3)]);
    await dataSource
      .getRepository(AddressConsolidationKey)
      .insert(
        members.map((address) => ({ address, consolidation_key: fiveKey }))
      );
    await dataSource.getRepository(ConsolidatedNFTOwner).insert({
      consolidation_key: oldKey,
      contract: CONTRACT,
      token_id: 1,
      balance: 4
    });

    await consolidateNftOwners(new Set([...members, loner]));

    expect(fiveKey.length).toBeGreaterThan(200);
    expect(await consolidatedRows()).toEqual(
      [
        { key: oldKey, token: 1, balance: 4 },
        { key: loner, token: 2, balance: 3 }
      ].sort((a, b) => a.key.localeCompare(b.key))
    );
    const queued: { consumer: string; wallet: string }[] =
      await dataSource.query(
        `SELECT consumer, wallet FROM ${TRANSFER_RECONCILIATIONS_TABLE} ORDER BY wallet`
      );
    expect(queued).toEqual(
      members.map((w) => ({ consumer: 'owners', wallet: w }))
    );

    await setKeyWidth(700);
    const later = Time.currentMillis() + Time.minutes(11).toMillis();
    jest.spyOn(Time, 'currentMillis').mockReturnValue(later);

    await consolidateNftOwners(new Set(members));

    expect(await consolidatedRows()).toEqual(
      [
        { key: fiveKey, token: 1, balance: 5 },
        { key: loner, token: 2, balance: 3 }
      ].sort((a, b) => a.key.localeCompare(b.key))
    );
  });

  it('moves more than a batch of deferred wallets behind the wallets queued after them', async () => {
    const dataSource = getDataSource();
    await dataSource.getRepository(TransferReconciliationEntity).clear();
    await dataSource.getRepository(ConsolidatedNFTOwner).clear();
    await setKeyWidth(200);
    jest
      .spyOn(Time, 'currentMillis')
      .mockReturnValue(Date.now() + Time.minutes(30).toMillis());
    // 20 identities of 15 wallets: 300 deferred wallets, more than the 250
    // a loop takes per run.
    const groups = new Map<string, string[]>();
    for (let g = 0; g < 20; g++) {
      const groupWallets = Array.from({ length: 15 }, (_, i) =>
        wallet(1000 + g * 15 + i)
      );
      groups.set(
        consolidationTools.buildConsolidationKey(groupWallets),
        groupWallets
      );
    }
    const deferred = Array.from(groups.values()).flat();
    const later = wallet(5000);
    await transferReconciliationDb.enqueueRepair(deferred);
    await transferReconciliationDb.enqueueRepair([later]);

    const fitting = await deferGroupsThatDoNotFit(
      groups,
      [NFT_OWNERS_CONSOLIDATION_TABLE],
      'owners'
    );

    expect(fitting.size).toBe(0);
    const firstRun = await transferReconciliationDb.pending('owners');
    expect(firstRun).toHaveLength(250);
    expect(firstRun[0].wallet).toBe(later);
    const queued: { wallet: string }[] = await dataSource.query(
      `SELECT wallet FROM ${TRANSFER_RECONCILIATIONS_TABLE} WHERE consumer = 'owners'`
    );
    expect(queued).toHaveLength(deferred.length + 1);
  });
});
