import { chainWord } from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import { waveDescriptionDropId } from './waves-chain-mirror.ids';
import { KeptHolds, KeptHoldsGate } from './waves-chain-mirror.rebuild';

const W = chainWord('0b');
const E = chainWord('e1');

describe('KeptHoldsGate', () => {
  const gateOf = (
    entry: { reason: string; retryAt: number | null } | null,
    wave: string | null
  ) => {
    const holds: jest.Mocked<KeptHolds> = {
      entryHold: jest.fn().mockResolvedValue(entry),
      waveHold: jest.fn().mockResolvedValue(wave)
    };
    return { gate: new KeptHoldsGate(holds), holds };
  };

  it("reads an entry's kept hold, and allows one with none", async () => {
    const entry = { dropId: E, waveId: W };
    expect(
      await gateOf({ reason: 'moderation', retryAt: null }, null).gate.check(
        entry
      )
    ).toEqual({ kind: 'refused', code: 'moderation' });
    expect(
      await gateOf(
        { reason: 'moderation_deferred', retryAt: 1 },
        null
      ).gate.check(entry)
    ).toEqual({ kind: 'deferred', code: 'moderation_deferred' });
    expect(
      await gateOf({ reason: 'manifest_missing', retryAt: 1 }, null).gate.check(
        entry
      )
    ).toEqual({ kind: 'allowed' });
    const { gate, holds } = gateOf(null, 'description_moderation');
    expect(await gate.check(entry)).toEqual({ kind: 'allowed' });
    expect(holds.entryHold).toHaveBeenCalledWith(E);
    expect(holds.waveHold).not.toHaveBeenCalled();
  });

  it("reads a wave description's kept hold from the wave's record", async () => {
    const description = { dropId: waveDescriptionDropId(W), waveId: W };
    expect(
      await gateOf(null, 'description_moderation').gate.check(description)
    ).toEqual({ kind: 'refused', code: 'description_moderation' });
    expect(
      await gateOf(null, 'description_moderation_deferred').gate.check(
        description
      )
    ).toEqual({ kind: 'deferred', code: 'description_moderation_deferred' });
    const { gate, holds } = gateOf(
      { reason: 'moderation', retryAt: null },
      'wave_document_missing'
    );
    expect(await gate.check(description)).toEqual({ kind: 'allowed' });
    expect(holds.waveHold).toHaveBeenCalledWith(W);
    expect(holds.entryHold).not.toHaveBeenCalled();
  });
});
