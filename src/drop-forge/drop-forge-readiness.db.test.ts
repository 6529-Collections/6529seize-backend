import { randomUUID } from 'node:crypto';
import { recordReadinessCheck } from '@/drop-forge/drop-forge.readiness.repository';

it('commits a single readiness alert when a checkpoint is delivered twice', async () => {
  const id = randomUUID();
  const post = jest.fn().mockResolvedValue({
    drop_id: randomUUID(),
    pending_push_notification_ids: [123]
  });
  const deliveries = await Promise.all([
    recordReadinessCheck(id, post),
    recordReadinessCheck(id, post)
  ]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(deliveries.flat()).toEqual([123]);
});
