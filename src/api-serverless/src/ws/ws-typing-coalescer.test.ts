import {
  WS_TYPING_COALESCE_MS_DEFAULT,
  WsTypingCoalescer,
  wsTypingCoalesceMillis
} from './ws-typing-coalescer';

describe('wsTypingCoalesceMillis', () => {
  it('defaults to three seconds, under the client four second send interval', () => {
    expect(WS_TYPING_COALESCE_MS_DEFAULT).toBe(3_000);
    expect(wsTypingCoalesceMillis({})).toBe(3_000);
  });

  it('accepts whole milliseconds up to ten seconds, and zero to disable', () => {
    expect(wsTypingCoalesceMillis({ WS_TYPING_COALESCE_MS: '2500' })).toBe(
      2_500
    );
    expect(wsTypingCoalesceMillis({ WS_TYPING_COALESCE_MS: '0' })).toBe(0);
    expect(wsTypingCoalesceMillis({ WS_TYPING_COALESCE_MS: '60000' })).toBe(
      10_000
    );
    expect(wsTypingCoalesceMillis({ WS_TYPING_COALESCE_MS: '-1' })).toBe(3_000);
    expect(wsTypingCoalesceMillis({ WS_TYPING_COALESCE_MS: 'soon' })).toBe(
      3_000
    );
  });
});

describe('WsTypingCoalescer', () => {
  it('claims through Redis with the window as the key lifetime', async () => {
    const setIfAbsent = jest.fn().mockResolvedValue(true);
    const coalescer = new WsTypingCoalescer(
      setIfAbsent,
      jest.fn(),
      () => 0,
      () => 3_000
    );

    await expect(coalescer.claim('profile', 'wave')).resolves.toBe(true);

    expect(setIfAbsent).toHaveBeenCalledWith('ws_typing:wave:profile', 3_000);
  });

  it('reports a frame covered by an existing Redis claim', async () => {
    const coalescer = new WsTypingCoalescer(
      jest.fn().mockResolvedValue(false),
      jest.fn(),
      () => 0,
      () => 3_000
    );

    await expect(coalescer.claim('profile', 'wave')).resolves.toBe(false);
  });

  describe('without Redis', () => {
    let now = 0;
    const coalescer = () =>
      new WsTypingCoalescer(
        jest.fn().mockResolvedValue(null),
        jest.fn().mockResolvedValue(undefined),
        () => now,
        () => 3_000
      );

    beforeEach(() => {
      now = 0;
    });

    it('sends the client four second cadence and absorbs repeats in between', async () => {
      const c = coalescer();
      const sent: number[] = [];
      for (const at of [0, 1_000, 2_000, 4_000, 4_500, 8_000, 11_000]) {
        now = at;
        if (await c.claim('profile', 'wave')) sent.push(at);
      }
      expect(sent).toEqual([0, 4_000, 8_000, 11_000]);
    });

    it('keeps identities and waves apart', async () => {
      const c = coalescer();
      await expect(c.claim('a', 'wave')).resolves.toBe(true);
      await expect(c.claim('b', 'wave')).resolves.toBe(true);
      await expect(c.claim('a', 'other')).resolves.toBe(true);
      await expect(c.claim('a', 'wave')).resolves.toBe(false);
    });

    it('frees the window on release', async () => {
      const c = coalescer();
      await c.claim('a', 'wave');
      await c.release('a', 'wave');
      await expect(c.claim('a', 'wave')).resolves.toBe(true);
    });
  });

  it('sends every frame when the window is zero', async () => {
    const setIfAbsent = jest.fn();
    const coalescer = new WsTypingCoalescer(
      setIfAbsent,
      jest.fn(),
      () => 0,
      () => 0
    );

    await expect(coalescer.claim('a', 'wave')).resolves.toBe(true);
    await expect(coalescer.claim('a', 'wave')).resolves.toBe(true);
    expect(setIfAbsent).not.toHaveBeenCalled();
  });
});
