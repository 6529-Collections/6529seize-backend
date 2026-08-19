import { isScheduledInvocation } from './index';

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
});
