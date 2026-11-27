import { cidPath, rawCidHexOf } from '@/chain-gateway/chain-gateway.client';
import { chainWord } from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import { waveDescriptionDropId } from './waves-chain-mirror.ids';
import {
  FilesDocuments,
  KeptHolds,
  KeptHoldsGate
} from './waves-chain-mirror.rebuild';

const W = chainWord('0b');
const E = chainWord('e1');

describe('KeptHoldsGate', () => {
  const gateOf = (hold: { reason: string; retryAt: number | null } | null) => {
    const holds: jest.Mocked<KeptHolds> = {
      entryHold: jest.fn().mockResolvedValue(hold)
    };
    return { gate: new KeptHoldsGate(holds), holds };
  };

  it("reads an entry's kept hold, and allows one with none", async () => {
    const entry = { dropId: E, waveId: W };
    expect(
      await gateOf({ reason: 'moderation', retryAt: null }).gate.check(entry)
    ).toEqual({ kind: 'refused', code: 'moderation' });
    expect(
      await gateOf({ reason: 'moderation_deferred', retryAt: 1 }).gate.check(
        entry
      )
    ).toEqual({ kind: 'deferred', code: 'moderation_deferred' });
    expect(
      await gateOf({ reason: 'manifest_missing', retryAt: 1 }).gate.check(entry)
    ).toEqual({ kind: 'allowed' });
    const { gate, holds } = gateOf(null);
    expect(await gate.check(entry)).toEqual({ kind: 'allowed' });
    expect(holds.entryHold).toHaveBeenCalledWith(E);
  });

  it("reads a wave description's kept hold by its description drop id", async () => {
    const description = { dropId: waveDescriptionDropId(W), waveId: W };
    expect(
      await gateOf({
        reason: 'description_moderation',
        retryAt: null
      }).gate.check(description)
    ).toEqual({ kind: 'refused', code: 'description_moderation' });
    expect(
      await gateOf({
        reason: 'description_moderation_deferred',
        retryAt: 1
      }).gate.check(description)
    ).toEqual({ kind: 'deferred', code: 'description_moderation_deferred' });
    // An imported wave's description drop is its own, not a derived id.
    const imported = { dropId: '0b1c2d3e-0000-4000-8000-0000000000ab' };
    const { gate, holds } = gateOf({
      reason: 'description_moderation',
      retryAt: null
    });
    expect(await gate.check(imported)).toEqual({
      kind: 'refused',
      code: 'description_moderation'
    });
    expect(holds.entryHold).toHaveBeenCalledWith(imported.dropId);
  });
});

describe('FilesDocuments', () => {
  const doc = Buffer.from(JSON.stringify({ v: 1, kind: 'wave' }));
  const cid = rawCidHexOf(doc);
  const other = rawCidHexOf(Buffer.from('another'));
  const filesOf = (answer: (url: string) => Response | Promise<Response>) => {
    const fetchImpl = jest.fn(async (url: string) => answer(url));
    return {
      files: new FilesDocuments(
        'http://files.example/run/',
        fetchImpl as unknown as typeof fetch
      ),
      fetchImpl
    };
  };

  it('reads a document by its CID from the files source, checked against it', async () => {
    const { files, fetchImpl } = filesOf(() => new Response(doc));
    expect(await files.getDocument(cid)).toEqual(doc);
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://files.example/run/${cidPath(cid)}`
    );
    expect(files.missing.size).toBe(0);
  });

  it('reads a document the files source does not hold as none, and counts it', async () => {
    const absent = filesOf(() => new Response(null, { status: 404 }));
    expect(await absent.files.getDocument(cid)).toBeNull();
    expect(await absent.files.getDocument(cid)).toBeNull();
    expect(absent.files.missing).toEqual(new Set([cid]));
    expect(absent.files.failures.size).toBe(0);
  });

  it('throws on any other answer, a failed read or bytes not matching the CID, and keeps each', async () => {
    const wrong = filesOf(() => new Response(doc));
    await expect(wrong.files.getDocument(other)).rejects.toThrow(
      'does not match its CID'
    );
    const failing = filesOf(() => new Response(null, { status: 500 }));
    await expect(failing.files.getDocument(cid)).rejects.toThrow(
      'answered 500'
    );
    const down = filesOf(() => Promise.reject(new Error('refused')));
    await expect(down.files.getDocument(cid)).rejects.toThrow('refused');
    for (const { files } of [wrong, failing, down]) {
      expect(files.failures.size).toBe(1);
      expect(files.missing.size).toBe(0);
    }
  });
});
