jest.mock('@/loop-health', () => ({ reportLoopHealth: jest.fn() }));
import { reportLoopHealth } from '@/loop-health';
import {
  DECISION_PASS_CURSOR,
  NativeCompetitionRuntimeService
} from './native-competition-runtime.service';

const IDS = ['a', 'b', 'c', 'd', 'e'];

function fixture(storedCursor = '') {
  let cursor = storedCursor;
  const repository = {
    discoverCompetitions: jest.fn(
      async (
        afterId: string,
        limit: number,
        _ctx: unknown,
        throughId?: string
      ) =>
        IDS.filter(
          (id) => id > afterId && (throughId === undefined || id <= throughId)
        ).slice(0, limit)
    )
  };
  const cursors = {
    read: jest.fn(async () => cursor),
    save: jest.fn(async (_worker: string, id: string) => {
      cursor = id;
    })
  };
  const service = new NativeCompetitionRuntimeService(
    repository as never,
    {} as never,
    {} as never,
    cursors
  );
  const started: string[] = [];
  const process = jest
    .spyOn(service, 'processCompetition')
    .mockImplementation(async (id: string) => {
      started.push(id);
    });
  return {
    service,
    repository,
    cursors,
    process,
    started,
    cursor: () => cursor
  };
}

describe('decision pass bounds', () => {
  afterEach(() => jest.restoreAllMocks());

  it('visits every competition once, starting after the stored cursor', async () => {
    const f = fixture('b');

    await f.service.processDueCompetitions({ now: 1 });

    expect(f.started).toEqual(['c', 'd', 'e', 'a', 'b']);
    expect(f.cursors.read).toHaveBeenCalledWith(DECISION_PASS_CURSOR);
    // Everything fitted, so the next pass starts at the same place.
    expect(f.cursor()).toBe('b');
    expect(reportLoopHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'native_execution', pending: false })
    );
  });

  it('visits in id order from the start without a cursor', async () => {
    const f = fixture();

    await f.service.processDueCompetitions({ now: 1 });

    expect(f.started).toEqual(IDS);
    expect(f.repository.discoverCompetitions).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.any(String)
    );
  });

  it('stops at its budget and lets the next pass continue after the last started competition', async () => {
    let clock = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const f = fixture();
    f.process.mockImplementation(async (id: string) => {
      f.started.push(id);
      clock += 100;
    });

    await f.service.processDueCompetitions({ now: 1, budgetMs: 250 });

    expect(f.started).toEqual(['a', 'b', 'c']);
    expect(f.cursor()).toBe('c');
    expect(reportLoopHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ pending: true })
    );

    f.started.length = 0;
    await f.service.processDueCompetitions({ now: 1, budgetMs: 250 });

    expect(f.started).toEqual(['d', 'e', 'a']);
  });

  it('starts nothing more when the invocation is down to its reserve', async () => {
    let remaining = 1_000;
    const f = fixture();
    f.process.mockImplementation(async (id: string) => {
      f.started.push(id);
      remaining -= 400;
    });

    await f.service.processDueCompetitions({
      now: 1,
      remainingMillis: () => remaining,
      reserveMillis: 300
    });

    expect(f.started).toEqual(['a', 'b']);
  });

  it('moves on from a competition past its deadline and waits for it before returning', async () => {
    const f = fixture();
    let releaseSlow: () => void = () => undefined;
    let slowFinished = false;
    f.process.mockImplementation(async (id: string) => {
      f.started.push(id);
      if (id === 'b') {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        slowFinished = true;
      }
      if (id === 'e') releaseSlow();
    });

    await f.service.processDueCompetitions({
      now: 1,
      competitionDeadlineMs: 10
    });

    expect(f.started).toEqual(IDS);
    expect(slowFinished).toBe(true);
    expect(reportLoopHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ pending: false })
    );
  });

  it('counts a competition that fails after its deadline as failed', async () => {
    const f = fixture();
    f.process.mockImplementation(async (id: string) => {
      f.started.push(id);
      if (id === 'a') {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('failed late');
      }
    });

    await f.service.processDueCompetitions({
      now: 1,
      competitionDeadlineMs: 5
    });

    expect(f.started).toEqual(IDS);
    expect(reportLoopHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({ pending: true })
    );
  });

  it('runs at most two overrunning competitions at a time', async () => {
    const f = fixture();
    let running = 0;
    let peak = 0;
    f.process.mockImplementation(async (id: string) => {
      f.started.push(id);
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 25));
      running--;
    });

    await f.service.processDueCompetitions({
      now: 1,
      competitionDeadlineMs: 5
    });

    expect(f.started).toEqual(IDS);
    expect(peak).toBeLessThanOrEqual(2);
    expect(running).toBe(0);
  });

  it.each([undefined, 60_000])(
    'attempts every competition each pass, including one that always fails (budget %p)',
    async (budgetMs) => {
      const f = fixture('b');
      f.process.mockImplementation(async (id: string) => {
        f.started.push(id);
        if (id === 'c') throw new Error('always fails');
      });

      for (let pass = 0; pass < 3; pass++) {
        f.started.length = 0;
        await f.service.processDueCompetitions({
          now: 1,
          budgetMs,
          competitionDeadlineMs: 1_000
        });
        expect([...f.started].sort((a, b) => a.localeCompare(b))).toEqual(IDS);
        expect(f.started.filter((id) => id === 'c')).toHaveLength(1);
        expect(reportLoopHealth).toHaveBeenLastCalledWith(
          expect.objectContaining({ pending: true })
        );
      }
      // A full rotation leaves the starting point where it was.
      expect(f.cursor()).toBe('b');
    }
  );

  it('retries a failed competition no later than the next full rotation when the budget runs out', async () => {
    let clock = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const f = fixture();
    const attemptsOfC: number[] = [];
    let pass = 0;
    f.process.mockImplementation(async (id: string) => {
      f.started.push(id);
      clock += 100;
      if (id === 'c') {
        attemptsOfC.push(pass);
        throw new Error('always fails');
      }
    });

    // Two competitions fit in a pass; five passes cover two rotations.
    for (pass = 0; pass < 5; pass++) {
      await f.service.processDueCompetitions({ now: 1, budgetMs: 150 });
    }

    expect(f.started).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'a',
      'b',
      'c',
      'd',
      'e'
    ]);
    expect(attemptsOfC).toEqual([1, 3]);
  });

  it('keeps passes unbounded without bounds, as before', async () => {
    let clock = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const f = fixture();
    f.process.mockImplementation(async (id: string) => {
      f.started.push(id);
      clock += 1_000_000;
    });

    await f.service.processDueCompetitions({ now: 1 });

    expect(f.started).toEqual(IDS);
  });
});
