import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { writeWorldActorsForTests } from '@/tests/fixtures/world-actors.fixture';
import {
  PLACEHOLDER_REFERENCES,
  plantPlaceholderReferences
} from './placeholder-references';
import {
  IDENTITY_WORLD_LEGACY_IDS,
  IDENTITY_WORLD_PLACEHOLDER_IDS
} from './world-ids';

describeWithSeed('the placeholder references, planted', [], () => {
  it("name the probes by the world's ids", async () => {
    await writeWorldActorsForTests(['probe-1', 'probe-2']);
    expect(await plantPlaceholderReferences()).toBe(
      PLACEHOLDER_REFERENCES.length
    );
    const [follow] = await sqlExecutor.execute<{ target_id: string }>(
      `select target_id from identity_subscriptions where subscriber_id = :id`,
      { id: IDENTITY_WORLD_PLACEHOLDER_IDS.untaken }
    );
    expect(follow.target_id).toBe(IDENTITY_WORLD_LEGACY_IDS.probe1);
    const [mute] = await sqlExecutor.execute<{ muter_id: string }>(
      `select muter_id from identity_mutes where muted_identity_id = :id`,
      { id: IDENTITY_WORLD_PLACEHOLDER_IDS.untaken }
    );
    expect(mute.muter_id).toBe(IDENTITY_WORLD_LEGACY_IDS.probe2);
  });
});
