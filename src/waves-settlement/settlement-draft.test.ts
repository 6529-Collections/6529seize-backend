import { keccak256, toUtf8Bytes, TypedDataEncoder } from 'ethers';
import { ChainDraft } from '@/chain-gateway/chain-gateway.types';
import {
  checkSettlementDraft,
  CLOCK_SLACK_MS,
  DEFAULT_MAX_FEE,
  settlementDomain,
  SETTLEMENT_TYPES,
  settlementSettingsFromEnv,
  SettlementDraftWant
} from './settlement-draft';

const ZERO32 = '0x' + '00'.repeat(32);
const NETWORK = '0x' + 'ab'.repeat(32);
const SIGNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const NOW = 1_764_000_000_000;
const DECISION = '0x' + '01'.padStart(64, '0');

const WANT: SettlementDraftWant = {
  decisionId: DECISION,
  occurrence: 4,
  maxEntries: 80,
  signer: SIGNER,
  lane: 6,
  networkId: NETWORK,
  maxFee: DEFAULT_MAX_FEE,
  validForMs: 300_000,
  now: NOW
};

function honestHeader(): Record<string, unknown> {
  return {
    ruleVersion: 7,
    principal: ZERO32,
    keyType: 1,
    keyId: '0x' + '00'.repeat(12) + SIGNER.slice(2),
    authRef: ZERO32,
    nonceLane: 6,
    nonce: '12',
    notBefore: String(NOW - 2_000),
    expiresAt: String(NOW + 300_000),
    ethRefNumber: '0',
    ethRefHash: ZERO32,
    feeMode: 3,
    sponsorRef: ZERO32,
    maxFee: '2250000000000000000',
    maxWork: '6000000',
    tipPerRU: '0'
  };
}

function draftOf(
  header: Record<string, unknown>,
  changes: Partial<ChainDraft> = {}
): ChainDraft {
  const message = {
    header,
    body: { decisionId: DECISION, occurrence: 4, maxEntries: 80 }
  };
  let txId = '0x' + '99'.repeat(32);
  try {
    txId = TypedDataEncoder.hash(
      settlementDomain(NETWORK),
      SETTLEMENT_TYPES,
      message
    );
  } catch {
    // A header no encoder reads: the check must refuse it before hashing.
  }
  return {
    txId,
    opType: 0x0609,
    opName: 'SETTLEMENT_REQUEST',
    opVersion: 1,
    typedData: { message },
    unsigned: '0x00',
    envelope: {},
    signatures: [{ role: 0, keyType: 1, signer: SIGNER }],
    fee: {},
    readAt: 1,
    ...changes
  };
}

describe('the settlement request typed data', () => {
  it('is the chain schema: one root, SettlementRequest', () => {
    const encoder = TypedDataEncoder.from(SETTLEMENT_TYPES);
    expect(encoder.primaryType).toBe('SettlementRequest');
    expect(encoder.encodeType('SettlementRequest')).toBe(
      'SettlementRequest(TxHeader header,SettlementRequestBody body)' +
        'SettlementRequestBody(bytes32 decisionId,uint32 occurrence,uint16 maxEntries)' +
        'TxHeader(uint32 ruleVersion,bytes32 principal,uint8 keyType,bytes32 keyId,' +
        'bytes32 authRef,uint32 nonceLane,uint64 nonce,uint64 notBefore,' +
        'uint64 expiresAt,uint64 ethRefNumber,bytes32 ethRefHash,uint8 feeMode,' +
        'bytes32 sponsorRef,uint128 maxFee,uint64 maxWork,uint128 tipPerRU)'
    );
  });

  // The validator's EIP-712 encoding vector, the one its own tests check
  // against its txId: a VoteSet over the same domain and TxHeader. There is
  // no vector for a SETTLEMENT_REQUEST itself.
  it("matches the validator's txId vector for the domain and the TxHeader", () => {
    const networkId =
      '0x53929f81f84ac199d1155e0cff0ae25cc43ca45d7434abdabf675c583f1c02b5';
    const header = {
      ruleVersion: 1,
      principal: keccak256(toUtf8Bytes('example principal')),
      keyType: 1,
      keyId: '0x' + '00'.repeat(12) + '88'.repeat(20),
      authRef: ZERO32,
      nonceLane: 0,
      nonce: 7,
      notBefore: 1_800_000_000_000,
      expiresAt: 1_800_003_600_000,
      ethRefNumber: 0,
      ethRefHash: ZERO32,
      feeMode: 3,
      sponsorRef: ZERO32,
      maxFee: '1000000000000000000',
      maxWork: 100_000,
      tipPerRU: '1000000000000'
    };
    const types = {
      VoteSet: [
        { name: 'header', type: 'TxHeader' },
        { name: 'body', type: 'VoteSetBody' }
      ],
      VoteSetBody: [
        { name: 'decisionId', type: 'bytes32' },
        { name: 'subjectId', type: 'bytes32' },
        { name: 'amount', type: 'int64' },
        { name: 'priorBallotVersion', type: 'uint64' }
      ],
      TxHeader: SETTLEMENT_TYPES.TxHeader
    };
    const body = {
      decisionId: keccak256(toUtf8Bytes('example decision')),
      subjectId: keccak256(toUtf8Bytes('example submission')),
      amount: -1234,
      priorBallotVersion: 3
    };
    const domain = settlementDomain(networkId);
    expect(TypedDataEncoder.hashDomain(domain)).toBe(
      '0x4427b1088ce2c047409473fac8231104b423a6d0cc591039710270c869d1d0b2'
    );
    expect(
      TypedDataEncoder.hashStruct(
        'TxHeader',
        { TxHeader: SETTLEMENT_TYPES.TxHeader },
        header
      )
    ).toBe(
      '0xf063504d469b74d9f62c4a6ec84f20315dfa482ec04ac000ac8f0a71aaa90079'
    );
    expect(TypedDataEncoder.hash(domain, types, { header, body })).toBe(
      '0x94d3601b9f090a13a462ad209b13829541421abf1523f6899aa52cff708d3721'
    );
  });
});

describe('checkSettlementDraft', () => {
  it('passes an honest draft and names the signature to send', () => {
    const draft = draftOf(honestHeader());
    expect(checkSettlementDraft(draft, WANT)).toEqual({
      txId: draft.txId.toLowerCase(),
      role: 0,
      keyType: 1,
      maxFee: BigInt('2250000000000000000')
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['ruleVersion', { ruleVersion: 6 }],
    ['principal', { principal: '0x' + '11'.repeat(32) }],
    ['keyType', { keyType: 2 }],
    ['keyId', { keyId: '0x' + '00'.repeat(12) + 'bb'.repeat(20) }],
    ['authRef', { authRef: '0x' + '22'.repeat(32) }],
    ['nonceLane', { nonceLane: 7 }],
    ['nonce', { nonce: '18446744073709551615' }],
    ['notBefore', { notBefore: String(NOW + CLOCK_SLACK_MS + 1) }],
    ['expiresAt', { expiresAt: String(NOW) }],
    ['expiresAt', { expiresAt: String(NOW + 300_000 + CLOCK_SLACK_MS + 1) }],
    ['ethRef', { ethRefNumber: '5' }],
    ['ethRef', { ethRefHash: '0x' + '33'.repeat(32) }],
    ['feeMode', { feeMode: 1 }],
    ['sponsorRef', { sponsorRef: '0x' + '44'.repeat(32) }],
    ['maxFee', { maxFee: (DEFAULT_MAX_FEE + BigInt(1)).toString() }],
    ['maxWork', { maxWork: '20000001' }],
    ['maxWork', { maxWork: '0' }],
    ['tipPerRU', { tipPerRU: '1' }],
    ["can't be read", { maxFee: '-1' }],
    ["can't be read", { nonce: 'soon' }],
    ["can't be read", { principal: undefined }]
  ])('refuses a header with another %s', (field, change) => {
    const draft = draftOf({ ...honestHeader(), ...change });
    expect(() => checkSettlementDraft(draft, WANT)).toThrow(field);
  });

  it('refuses a draft whose digest is for another body', () => {
    const draft = draftOf(honestHeader());
    expect(() =>
      checkSettlementDraft(draft, { ...WANT, maxEntries: 81 })
    ).toThrow("its txId is not this settlement request's digest");
    expect(() =>
      checkSettlementDraft(draft, {
        ...WANT,
        networkId: '0x' + 'cd'.repeat(32)
      })
    ).toThrow("its txId is not this settlement request's digest");
  });

  it('refuses another operation or version', () => {
    expect(() =>
      checkSettlementDraft(draftOf(honestHeader(), { opType: 0x0901 }), WANT)
    ).toThrow('not a SETTLEMENT_REQUEST');
    expect(() =>
      checkSettlementDraft(draftOf(honestHeader(), { opVersion: 2 }), WANT)
    ).toThrow('not a SETTLEMENT_REQUEST');
  });

  it.each([
    [[]],
    [
      [
        { role: 0, keyType: 1, signer: SIGNER },
        { role: 4, keyType: 1, signer: SIGNER }
      ]
    ],
    [[{ role: 4, keyType: 1, signer: SIGNER }]],
    [[{ role: 0, keyType: 2, signer: SIGNER }]],
    [[{ role: 0, keyType: 1, signer: '0x' + 'bb'.repeat(20) }]]
  ])('refuses another signature list (%j)', (signatures) => {
    expect(() =>
      checkSettlementDraft(draftOf(honestHeader(), { signatures }), WANT)
    ).toThrow('it asks for another signature');
  });

  it('caps maxFee as the settings say', () => {
    const draft = draftOf(honestHeader());
    expect(() =>
      checkSettlementDraft(draft, { ...WANT, maxFee: BigInt(1000) })
    ).toThrow('maxFee (over the cap 1000)');
  });
});

describe('settlementSettingsFromEnv', () => {
  it('defaults to the gateway network and a cap of 100 coins', () => {
    expect(settlementSettingsFromEnv({})).toEqual({
      ok: true,
      settings: { networkId: null, maxFee: BigInt('100000000000000000000') }
    });
  });

  it('reads both settings', () => {
    expect(
      settlementSettingsFromEnv({
        WAVES_SETTLEMENT_NETWORK_ID: ' 0x' + 'AB'.repeat(32) + ' ',
        WAVES_SETTLEMENT_MAX_FEE: '5000'
      })
    ).toEqual({
      ok: true,
      settings: { networkId: NETWORK, maxFee: BigInt(5000) }
    });
  });

  it.each([
    [{ WAVES_SETTLEMENT_NETWORK_ID: '0x1234' }, 'WAVES_SETTLEMENT_NETWORK_ID'],
    [{ WAVES_SETTLEMENT_MAX_FEE: '1e20' }, 'WAVES_SETTLEMENT_MAX_FEE'],
    [{ WAVES_SETTLEMENT_MAX_FEE: '-5' }, 'WAVES_SETTLEMENT_MAX_FEE']
  ])('refuses a malformed setting (%j)', (env, name) => {
    expect(settlementSettingsFromEnv(env)).toEqual({
      ok: false,
      problem: `${name} is malformed`
    });
  });
});
