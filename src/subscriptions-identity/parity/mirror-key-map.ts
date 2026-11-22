import { compareText } from '../engine/text-order';
import { LegacySubscriptionsApi } from './legacy-api';
import { ParitySnapshot } from './snapshot';

export interface MirrorKeyMap {
  /** Snapshot key to the key its wallets have now, where they differ. */
  readonly keyMap: Record<string, string>;
  /** Snapshot keys whose wallets now sit under more than one key. */
  readonly splits: Record<string, string[]>;
}

/**
 * Reads, for every key in the snapshot, the consolidation key each of its
 * wallets has now (the identity mirror re-keys wallets from the chain from
 * about 01:00 on Wednesday). A key whose wallets all moved to one new key
 * maps to it; a key split across keys is listed, since no single identity
 * explains it.
 */
export async function readMirrorKeyMap(
  api: LegacySubscriptionsApi,
  snapshot: ParitySnapshot
): Promise<MirrorKeyMap> {
  const keyMap: Record<string, string> = {};
  const splits: Record<string, string[]> = {};
  for (const subscriber of snapshot.subscribers) {
    const now = new Set<string>();
    for (const wallet of subscriber.key.split('-')) {
      const identity = await api.identityByWallet(wallet);
      now.add((identity?.consolidation_key ?? wallet).toLowerCase());
    }
    const keys = Array.from(now).sort(compareText);
    if (keys.length > 1) {
      splits[subscriber.key] = keys;
    } else if (keys[0] !== subscriber.key) {
      keyMap[subscriber.key] = keys[0];
    }
  }
  return { keyMap, splits };
}
