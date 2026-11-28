import { keepConsolidationKeysThatFit } from './tdh-key-width';

jest.mock('@/priority-alerts.context', () => ({
  sendPriorityAlertIfConfigured: jest.fn()
}));

const alerts = jest.requireMock('@/priority-alerts.context')
  .sendPriorityAlertIfConfigured as jest.Mock;

describe('keepConsolidationKeysThatFit', () => {
  const short = { consolidation_key: 'a'.repeat(171) };
  const long = { consolidation_key: 'b'.repeat(214) };

  beforeEach(() => alerts.mockReset());

  it('keeps every row while the keys fit', async () => {
    expect(
      await keepConsolidationKeysThatFit([short], async () => 200)
    ).toEqual([short]);
    expect(alerts).not.toHaveBeenCalled();
  });

  it('leaves out a key that does not fit and alerts', async () => {
    expect(
      await keepConsolidationKeysThatFit([short, long], async () => 200)
    ).toEqual([short]);
    expect(alerts).toHaveBeenCalledTimes(1);
  });

  it('keeps it once the columns are wider', async () => {
    expect(
      await keepConsolidationKeysThatFit([short, long], async () => 700)
    ).toEqual([short, long]);
  });

  it('assumes the width before the migration when it cannot read it', async () => {
    const read = async () => {
      throw new Error('no database');
    };
    expect(await keepConsolidationKeysThatFit([short, long], read)).toEqual([
      short
    ]);
  });
});
