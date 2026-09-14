import {
  CONTENT_MODERATION_RETENTION_BATCH_SIZE,
  CONTENT_MODERATION_RETENTION_MAX_BATCHES,
  deleteExpiredContentModerationChecksInBatches,
  isScheduledInvocation
} from './index';

describe('dbMigrationsLoop scheduled invocation detection', () => {
  it('recognizes EventBridge scheduled events', () => {
    expect(
      isScheduledInvocation({
        source: 'aws.events',
        'detail-type': 'Scheduled Event'
      })
    ).toBe(true);
  });

  it.each([
    undefined,
    {},
    { source: 'aws.events' },
    { source: 'manual', 'detail-type': 'Scheduled Event' }
  ])('keeps manual deployment invocations in migration mode', (event) => {
    expect(isScheduledInvocation(event)).toBe(false);
  });

  it('deletes expired moderation checks in bounded batches', async () => {
    const deleteExpiredPrePublicationChecks = jest
      .fn()
      .mockResolvedValueOnce(CONTENT_MODERATION_RETENTION_BATCH_SIZE)
      .mockResolvedValueOnce(17);

    await expect(
      deleteExpiredContentModerationChecksInBatches(1234, {
        deleteExpiredPrePublicationChecks
      })
    ).resolves.toBe(CONTENT_MODERATION_RETENTION_BATCH_SIZE + 17);
    expect(deleteExpiredPrePublicationChecks).toHaveBeenNthCalledWith(
      1,
      1234,
      CONTENT_MODERATION_RETENTION_BATCH_SIZE
    );
    expect(deleteExpiredPrePublicationChecks).toHaveBeenNthCalledWith(
      2,
      1234,
      CONTENT_MODERATION_RETENTION_BATCH_SIZE
    );
  });

  it('caps retention work per invocation', async () => {
    const deleteExpiredPrePublicationChecks = jest
      .fn()
      .mockResolvedValue(CONTENT_MODERATION_RETENTION_BATCH_SIZE);

    await expect(
      deleteExpiredContentModerationChecksInBatches(1234, {
        deleteExpiredPrePublicationChecks
      })
    ).resolves.toBe(
      CONTENT_MODERATION_RETENTION_BATCH_SIZE *
        CONTENT_MODERATION_RETENTION_MAX_BATCHES
    );
    expect(deleteExpiredPrePublicationChecks).toHaveBeenCalledTimes(
      CONTENT_MODERATION_RETENTION_MAX_BATCHES
    );
  });
});
