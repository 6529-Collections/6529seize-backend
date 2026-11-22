const mockRecordSent = jest.fn();
jest.mock('@/collecting/collecting-rules.service', () => ({
  collectingRulesService: { recordSent: mockRecordSent }
}));
const mockError = jest.fn();
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      error: mockError,
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn()
    })
  }
}));

import { ForbiddenException } from '@/exceptions';
import { keepRuleSentHash } from './marketplace.service';

const HASH = `0x${'5'.repeat(64)}`;

describe("a rule's copy of a sent hash", () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps the hash the market kept', async () => {
    mockRecordSent.mockResolvedValue(undefined);
    await keepRuleSentHash('op-1', HASH);
    expect(mockRecordSent).toHaveBeenCalledWith('op-1', HASH);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('never fails the submit: a refusal is an alert', async () => {
    mockRecordSent.mockRejectedValue(
      new ForbiddenException(
        "The transaction is not this rule's purchase: it does not pay the reviewed cost."
      )
    );
    await expect(keepRuleSentHash('op-1', HASH)).resolves.toBeUndefined();
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('did not keep the sent hash of operation op-1')
    );
  });
});
