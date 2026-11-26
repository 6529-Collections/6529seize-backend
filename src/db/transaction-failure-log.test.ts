import { Logger } from '@/logging';
import * as operationalErrors from '@/operational-errors';
import {
  isRetriedConflict,
  logTransactionFailure
} from '@/db/transaction-failure-log';
import { XTdhIdentitySnapshotChangedError } from '@/xtdh/xtdh-identity-snapshot-changed-error';

function fakeLogger() {
  return { warn: jest.fn(), error: jest.fn() };
}

describe('transaction failure log', () => {
  beforeEach(() => jest.clearAllMocks());

  it('logs the xTDH snapshot conflict as a warning, not an error', () => {
    const logger = fakeLogger();
    logTransactionFailure(new XTdhIdentitySnapshotChangedError(), logger);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Database transaction hit a retried conflict; rolling back [XTdhIdentitySnapshotChangedError: Identity consolidation changed during xTDH calculation; retry the universe]'
    );
  });

  it.each([
    new Error('deadlock'),
    { retriedConflict: 'true' },
    { retriedConflict: 1 },
    null,
    undefined,
    'text'
  ])('logs any other failure (%p) as an error, as before', (failure) => {
    const logger = fakeLogger();
    logTransactionFailure(failure, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      `Database transaction failed [${failure}]`
    );
  });

  it('marks only errors that say they are a retried conflict', () => {
    expect(isRetriedConflict(new XTdhIdentitySnapshotChangedError())).toBe(
      true
    );
    expect(isRetriedConflict(new Error('x'))).toBe(false);
    expect(isRetriedConflict({ retriedConflict: true })).toBe(true);
    expect(isRetriedConflict(undefined)).toBe(false);
  });

  it('writes no operational error for a retried conflict, and one for any other failure', () => {
    // A spy on the module's export, not jest.mock: the logger may already be
    // loaded (the shared per-test setup loads it first), and it reads the
    // export when it logs.
    const operationalError = jest
      .spyOn(operationalErrors, 'operationalError')
      .mockImplementation(() => undefined);
    try {
      const logger = Logger.get('DB');
      logTransactionFailure(new XTdhIdentitySnapshotChangedError(), logger);
      expect(operationalError).not.toHaveBeenCalled();
      logTransactionFailure(new Error('deadlock'), logger);
      expect(operationalError).toHaveBeenCalledTimes(1);
      expect(operationalError).toHaveBeenCalledWith(
        'DB',
        ['Database transaction failed [Error: deadlock]'],
        undefined
      );
    } finally {
      operationalError.mockRestore();
    }
  });
});
