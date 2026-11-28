import { loggerContext } from '@/logger-context';
import { Logger } from '@/logging';
import { IdentityReadsShadow, SHADOW_MAX_KEYS } from './identity-reads-shadow';

const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
/** 10:41:00 UTC on a day: the start of a minute. */
const MINUTE = Date.UTC(2026, 10, 28, 10, 41);

function setup({ ttl = 2_000, flag = false } = {}) {
  let now = MINUTE;
  const lines: { line: string; requestId: string | undefined }[] = [];
  const info = jest
    .spyOn(Logger.get('IDENTITY_READS_SHADOW'), 'info')
    .mockImplementation((line: string) => {
      lines.push({ line, requestId: loggerContext.get()?.requestId });
    });
  const shadow = new IdentityReadsShadow(
    () => now,
    () => ttl,
    () => flag
  );
  return {
    shadow,
    lines,
    info,
    at: (ms: number) => {
      now = MINUTE + ms;
    }
  };
}

/** The key=value pairs of a shadow line. */
function fields(line: string): Record<string, string> {
  return Object.fromEntries(
    line
      .replace('[IDENTITY READS SHADOW] ', '')
      .split(' ')
      .map((pair) => pair.split('=') as [string, string])
  );
}

describe('IdentityReadsShadow', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes a minute when the next note comes after it, as key=value pairs', () => {
    const { shadow, lines, at } = setup();
    shadow.note('login', W(1));
    shadow.note('by_handle', 'alice');
    shadow.note('availability', 'free');
    shadow.mirrorFallback();
    shadow.mirror503();
    at(59_999);
    shadow.note('by_profile_id', '00000000-0000-4000-8000-000000000001');
    expect(lines).toEqual([]);
    at(60_000);
    shadow.note('by_wallet', W(2));
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe(
      '[IDENTITY READS SHADOW] window_start=2026-11-28T10:41:00.000Z window_s=60 flag=off login=1 by_wallet=0 by_handle=1 by_profile_id=1 availability=1 would_send=6 head_reads=2 head_ttl_ms=2000 mirror_fallbacks=1 mirror_503=1'
    );
    // Written outside any request's log context.
    expect(lines[0].requestId).toBeUndefined();
  });

  it('counts a would-send once per (kind, key) in a head window, with one head read', () => {
    const { shadow, lines, at } = setup({ ttl: 15_000 });
    for (let i = 0; i < 3; i++) shadow.note('by_wallet', W(1));
    // Another kind with the same key, and the same key in other case.
    shadow.note('login', W(1));
    shadow.note('by_handle', 'Alice');
    shadow.note('by_handle', 'alice');
    // A placeholder handle: its handle, then its owner.
    shadow.note('by_handle', `id-${W(3)}`);
    // The next head window: all again, one more head read.
    at(15_000);
    shadow.note('by_wallet', W(1));
    at(60_000);
    shadow.note('login', W(9));
    expect(fields(lines[0].line)).toMatchObject({
      by_wallet: '4',
      login: '1',
      by_handle: '3',
      // by_wallet + login + alice + placeholder (2) + head read, then
      // by_wallet + head read.
      would_send: '8',
      head_reads: '2',
      head_ttl_ms: '15000'
    });
  });

  it('says the flag as it is when the line is written', () => {
    const flag = { on: false };
    const lines: string[] = [];
    jest
      .spyOn(Logger.get('IDENTITY_READS_SHADOW'), 'info')
      .mockImplementation((line: string) => {
        lines.push(line);
      });
    let now = MINUTE;
    const shadow = new IdentityReadsShadow(
      () => now,
      () => 2_000,
      () => flag.on
    );
    shadow.note('login', W(1));
    flag.on = true;
    now += 60_000;
    shadow.note('login', W(1));
    expect(fields(lines[0])).toMatchObject({ flag: 'on' });
  });

  it('starts a fresh minute after each line, and skips minutes without lookups', () => {
    const { shadow, lines, at } = setup();
    shadow.note('login', W(1));
    at(5 * 60_000 + 30_000);
    shadow.note('login', W(1));
    at(6 * 60_000);
    shadow.mirrorFallback();
    expect(lines.map((it) => fields(it.line).window_start)).toEqual([
      '2026-11-28T10:41:00.000Z',
      '2026-11-28T10:46:00.000Z'
    ]);
    expect(fields(lines[1].line)).toMatchObject({
      login: '1',
      would_send: '2',
      mirror_fallbacks: '0'
    });
  });

  it('never fails a lookup: a failure is logged once', () => {
    const warn = jest
      .spyOn(Logger.get('IDENTITY_READS_SHADOW'), 'warn')
      .mockImplementation(() => undefined);
    const broken = new IdentityReadsShadow(() => {
      throw new Error('no clock');
    });
    expect(() => broken.note('login', W(1))).not.toThrow();
    expect(() => broken.mirrorFallback()).not.toThrow();
    expect(() => broken.mirror503()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    // A flag that can't be read: the line says so, and the count goes on.
    const { lines } = setup();
    let now = MINUTE;
    const noFlag = new IdentityReadsShadow(
      () => now,
      () => 2_000,
      () => {
        throw new Error('no flag');
      }
    );
    noFlag.note('login', W(1));
    now += 60_000;
    noFlag.note('login', W(1));
    now += 60_000;
    noFlag.note('login', W(1));
    expect(lines.map((it) => fields(it.line).flag)).toEqual([
      'unknown',
      'unknown'
    ]);
  });

  it('clears its keys past the cap, counting high after that', () => {
    const { shadow, lines, at } = setup({ ttl: 60_000 });
    for (let i = 0; i < SHADOW_MAX_KEYS; i++) {
      shadow.note('by_wallet', W(i));
    }
    // Cleared: W(0) counts again.
    shadow.note('by_wallet', W(SHADOW_MAX_KEYS));
    shadow.note('by_wallet', W(0));
    at(60_000);
    shadow.note('login', W(1));
    expect(fields(lines[0].line)).toMatchObject({
      by_wallet: String(SHADOW_MAX_KEYS + 2),
      would_send: String(SHADOW_MAX_KEYS + 3)
    });
  });
});
