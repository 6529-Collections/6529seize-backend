import { Wallet } from 'ethers';
import { ChainTypedData, typedDataDigest } from './chain-relay.service';

/**
 * Test support: an identity join's typed data as the node drafts it (an
 * IdentityJoin of a TxHeader and an IdentityJoinBody, uint64 values as
 * decimal strings), and its txId.
 */

export const JOIN_PRINCIPAL = '0x' + 'ab'.repeat(32);
const ZERO32 = '0x' + '00'.repeat(32);

/** A wallet's 32-byte key id: 12 zero bytes, then its address. */
export const addressWord = (address: string) =>
  '0x' + '00'.repeat(12) + address.slice(2).toLowerCase();

export interface JoinTerms {
  readonly principal?: string;
  /** The identity's wallet, signing in role 0. */
  readonly signer: string;
  /** The joining wallet, signing in role 4. */
  readonly joiner: string;
  readonly expiresAt: number;
}

export function joinTypedData(terms: JoinTerms): ChainTypedData {
  return {
    domain: {
      name: '6529 Network',
      version: '1',
      salt: '0x' + '65'.repeat(32)
    },
    primaryType: 'IdentityJoin',
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'salt', type: 'bytes32' }
      ],
      IdentityJoin: [
        { name: 'header', type: 'TxHeader' },
        { name: 'body', type: 'IdentityJoinBody' }
      ],
      TxHeader: [
        { name: 'ruleVersion', type: 'uint32' },
        { name: 'principal', type: 'bytes32' },
        { name: 'keyType', type: 'uint8' },
        { name: 'keyId', type: 'bytes32' },
        { name: 'authRef', type: 'bytes32' },
        { name: 'nonceLane', type: 'uint32' },
        { name: 'nonce', type: 'uint64' },
        { name: 'notBefore', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
        { name: 'ethRefNumber', type: 'uint64' },
        { name: 'ethRefHash', type: 'bytes32' },
        { name: 'feeMode', type: 'uint8' },
        { name: 'sponsorRef', type: 'bytes32' },
        { name: 'maxFee', type: 'uint128' },
        { name: 'maxWork', type: 'uint64' },
        { name: 'tipPerRU', type: 'uint128' }
      ],
      IdentityJoinBody: [{ name: 'wallet', type: 'address' }]
    },
    message: {
      header: {
        ruleVersion: 6,
        principal: terms.principal ?? JOIN_PRINCIPAL,
        keyType: 1,
        keyId: addressWord(terms.signer),
        authRef: ZERO32,
        nonceLane: 0,
        nonce: '7',
        notBefore: String(Math.max(0, terms.expiresAt - 3_660_000)),
        expiresAt: String(terms.expiresAt),
        ethRefNumber: '0',
        ethRefHash: ZERO32,
        feeMode: 0,
        sponsorRef: ZERO32,
        maxFee: '1000000',
        maxWork: '500000',
        tipPerRU: '0'
      },
      body: { wallet: terms.joiner.toLowerCase() }
    }
  };
}

/** A join's typed data and txId, and each wallet's signature of it. */
export function join(terms: JoinTerms) {
  const typedData = joinTypedData(terms);
  const txId = typedDataDigest(typedData)!;
  return {
    typedData,
    txId,
    sign: (wallet: Wallet) => wallet.signingKey.sign(txId).serialized
  };
}
