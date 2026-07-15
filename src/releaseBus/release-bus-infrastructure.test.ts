import stateMachine from '@/releaseBus/state-machine.asl.json';
import { e2eSourceRef } from '@/releaseBus/worker';

describe('release bus infrastructure contract', () => {
  it('invokes the worker version pinned into the train execution', () => {
    const advance = stateMachine.States.ADVANCE_TRAIN;
    expect(advance.Parameters['FunctionName.$']).toBe('$.worker_arn');
    expect(advance.Parameters.Payload['worker_arn.$']).toBe('$.worker_arn');
    expect(advance.Retry[0].MaxAttempts).toBeGreaterThan(1);
    expect(advance.Catch[0].Next).toBe('WAIT');
  });

  it('requires staging and production E2E even for backend-only trains', () => {
    expect(e2eSourceRef(null, 'staging', 'release-bus/train')).toBe(
      '1a-staging'
    );
    expect(e2eSourceRef(null, 'prod', 'release-bus/train')).toBe('main');
    expect(
      e2eSourceRef('release-bus/train', 'staging', 'release-bus/train')
    ).toBe('release-bus/train');
  });
});
