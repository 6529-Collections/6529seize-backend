import * as shortUuid from 'short-uuid';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  legacyCompetitionDecisionId,
  legacyCompetitionEntryId,
  stableUuid
} from '@/competitions/competition-id';
import {
  chainExecutionKey,
  chainExecutionKeyPrefix,
  chainIdOf,
  competitionIdOf,
  entryDropIdOf,
  groupListId,
  groupShortIdOf,
  legacyUuidOfGroupId,
  waveDescriptionDropId,
  isChainExecutionKey,
  legacyIdOf,
  nativeCompetitionId,
  nativeEntryRowId,
  NS_CHAIN_DECISION,
  resultDecisionId
} from './waves-chain-mirror.ids';

const D = `0x${'ab'.repeat(32)}`;
const E = `0x${'cd'.repeat(32)}`;
const UUID = '0b1c2d3e-0000-4000-8000-00000000000a';

describe('waves chain mirror ids', () => {
  it('keeps an imported decision under its competition id', () => {
    expect(competitionIdOf({ decisionId: D, legacyId: UUID })).toBe(UUID);
  });

  it('names a decision made on the chain by a UUIDv5 of its chain id', () => {
    const id = competitionIdOf({ decisionId: D, legacyId: null });
    expect(id).toBe(stableUuid(NS_CHAIN_DECISION, D));
    expect(id).toBe(nativeCompetitionId(D.toUpperCase().replace('0X', '0x')));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe(nativeCompetitionId(E));
  });

  it('gives an entry made on the chain its chain id as drop id', () => {
    expect(entryDropIdOf({ entryId: E, legacyId: null })).toBe(E);
    expect(entryDropIdOf({ entryId: E, legacyId: UUID })).toBe(UUID);
    expect(nativeEntryRowId(UUID, E)).toBe(legacyCompetitionEntryId(UUID, E));
  });

  it('names a result as the runtime does', () => {
    expect(resultDecisionId(UUID, 1_764_000_000_000)).toBe(
      legacyCompetitionDecisionId(UUID, 1_764_000_000_000)
    );
  });

  it('reads chain ids and legacy ids strictly', () => {
    expect(chainIdOf(D.toUpperCase().replace('0X', '0x'))).toBe(D);
    expect(chainIdOf('0x12')).toBeNull();
    expect(chainIdOf(null)).toBeNull();
    expect(legacyIdOf(UUID.toUpperCase())).toBe(UUID);
    expect(legacyIdOf(UUID.replace(/-/g, ''))).toBe(UUID);
    expect(legacyIdOf('not-a-uuid')).toBeNull();
    expect(legacyIdOf(null)).toBeNull();
  });

  it('keys a chain result by network, decision and time, within 160 characters', () => {
    expect(chainExecutionKey('net-1', D, 5)).toBe(`chain:net-1:${D}:5`);
    const long = chainExecutionKey('n'.repeat(100), D, 1_764_000_000_000);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).toMatch(/^chain:h[0-9a-f]{32}:0x/);
    expect(chainExecutionKey('a b', D, 1)).toMatch(/^chain:h[0-9a-f]{32}:/);
    expect(chainExecutionKey(null, D, 1)).toBe(`chain::${D}:1`);
    expect(isChainExecutionKey(chainExecutionKey('x', D, 1))).toBe(true);
    expect(isChainExecutionKey(`native:${UUID}:1`)).toBe(false);
    expect(isChainExecutionKey(null)).toBe(false);
  });

  it("starts each of a network's keys with that network's prefix, and no other's", () => {
    for (const network of ['net-1', 'n'.repeat(100), 'a b', null]) {
      const key = chainExecutionKey(network, D, 1_764_000_000_000);
      expect(key.startsWith(chainExecutionKeyPrefix(network))).toBe(true);
    }
    expect(
      chainExecutionKey('net-10', D, 1).startsWith(
        chainExecutionKeyPrefix('net-1')
      )
    ).toBe(false);
  });

  it("writes a group's UUID as 6529.io's short ids end, and reads it back", () => {
    const translator = shortUuid.createTranslator();
    for (const uuid of [
      '00000000-0000-0000-0000-000000000001',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      UUID
    ]) {
      const short = groupShortIdOf(uuid)!;
      expect(short).toBe(translator.fromUUID(uuid));
      expect(short).toHaveLength(22);
      expect(legacyUuidOfGroupId(`my-group-${short}`)).toBe(uuid);
      expect(legacyUuidOfGroupId(`-${short}`)).toBe(uuid);
    }
    expect(groupShortIdOf('not a uuid')).toBeNull();
  });

  it('reads a group id with no short id as the import hashed it', () => {
    const id = 'an-old-group-id';
    const hex = keccak256(toUtf8Bytes(id)).slice(2, 34);
    expect(legacyUuidOfGroupId(id)).toBe(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    );
  });

  it("derives a native wave's description drop and a group version's lists", () => {
    expect(waveDescriptionDropId(D)).toBe(
      waveDescriptionDropId(D.toUpperCase().replace('0X', '0x'))
    );
    expect(waveDescriptionDropId(D)).not.toBe(waveDescriptionDropId(E));
    expect(groupListId(D, 1, 'include')).not.toBe(groupListId(D, 2, 'include'));
    expect(groupListId(D, 1, 'include')).not.toBe(groupListId(D, 1, 'exclude'));
  });
});
