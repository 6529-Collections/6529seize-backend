import { DeviceEventKind } from '@/api/device-signing/device-event';
import { WAVES_WORLD_IDS } from '@/rebuild/world/waves/world-ids';
import {
  testGrantProof,
  testSignedEvent
} from '@/tests/fixtures/relay-events.fixture';
import { dropIdOfEvent } from '@/wave-drop-index/drop-index.subscriber';

/**
 * When the world's events claim to be signed. 6529.io's write path refuses
 * a relay event claimed more than 30 days before it was first seen, and a
 * rebuild takes first-seen from the relays' receipts: a recording made
 * within 30 days after this time applies at any later date. Inside the
 * shared test grant's life (18 Oct 2026 to 16 Apr 2027) and before the
 * run's switch-on, so the events are history.
 */
export const RELAY_WORLD_CLAIMED_TIME = Date.parse('2026-11-22T12:00:00Z');

/** A signed event as a client publishes it, with its grant proof. */
export interface RelayWorldEvent {
  readonly event: Record<string, unknown>;
  readonly grant: Record<string, unknown>;
}

/**
 * The waves area's hand-written relay traffic for the rebuild check:
 * drops a client posted only to the relays (6529 Desktop), signed by the
 * shared test device key under the shared test grant (Hardhat's first test
 * account and RFC 8032's first Ed25519 key; never a real wallet or
 * device). Two posts in the public wave, an edit and a reaction; one post
 * in the members-only wave.
 */
export function buildRelayWorld(): RelayWorldEvent[] {
  const wave = WAVES_WORLD_IDS.publicWave;
  const first = testSignedEvent({
    claimedTime: RELAY_WORLD_CLAIMED_TIME,
    wave,
    seq: 1,
    body: { parts: [{ content: 'First post from the relays' }] }
  });
  const second = testSignedEvent({
    claimedTime: RELAY_WORLD_CLAIMED_TIME,
    wave,
    seq: 2,
    body: { parts: [{ content: 'A second post' }] }
  });
  const firstDrop = dropIdOfEvent(String(first.id));
  const secondDrop = dropIdOfEvent(String(second.id));
  const edit = testSignedEvent({
    claimedTime: RELAY_WORLD_CLAIMED_TIME,
    kind: DeviceEventKind.EDIT,
    wave,
    seq: 3,
    refs: [firstDrop],
    body: { parts: [{ content: 'First post from the relays, edited' }] }
  });
  const react = testSignedEvent({
    claimedTime: RELAY_WORLD_CLAIMED_TIME,
    kind: DeviceEventKind.REACT,
    wave,
    seq: 4,
    refs: [secondDrop],
    body: { reaction: ':+1:' }
  });
  const members = testSignedEvent({
    claimedTime: RELAY_WORLD_CLAIMED_TIME,
    wave: WAVES_WORLD_IDS.membersWave,
    seq: 5,
    body: { parts: [{ content: 'A post in the members-only wave' }] }
  });
  const grant = testGrantProof();
  return [first, second, edit, react, members].map((event) => ({
    event,
    grant
  }));
}
