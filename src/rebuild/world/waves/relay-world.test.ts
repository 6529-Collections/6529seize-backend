import { REBUILD_LIVE_FROM } from '@/rebuild/steps/waves-drop-index.steps';
import {
  testGrantProof,
  TEST_CLAIMED_TIME
} from '@/tests/fixtures/relay-events.fixture';
import { buildRelayWorld, RELAY_WORLD_CLAIMED_TIME } from './relay-world';

describe('the relay world', () => {
  it('claims every event at its fixed time, inside the grant and before switch-on', () => {
    const world = buildRelayWorld();
    expect(world).toHaveLength(5);
    for (const { event } of world) {
      expect(event.claimed_time).toBe(RELAY_WORLD_CLAIMED_TIME);
    }
    expect(RELAY_WORLD_CLAIMED_TIME).toBe(Date.UTC(2026, 10, 22, 12));
    // The shared fixture's time is an hour into the grant's life.
    expect(RELAY_WORLD_CLAIMED_TIME).toBeGreaterThan(TEST_CLAIMED_TIME);
    expect(RELAY_WORLD_CLAIMED_TIME).toBeLessThan(
      Number(testGrantProof().expires_at)
    );
    expect(RELAY_WORLD_CLAIMED_TIME).toBeLessThan(
      Date.parse(REBUILD_LIVE_FROM)
    );
  });
});
