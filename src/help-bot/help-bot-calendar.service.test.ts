import { HelpBotCalendarService } from './help-bot-calendar.service';

const BASE_URL = 'https://6529.io';
const at = (iso: string) => new HelpBotCalendarService(() => new Date(iso));

describe('HelpBotCalendarService', () => {
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const fetchSpy = jest
    .fn()
    .mockRejectedValue(new Error('Network unavailable'));
  beforeEach(() => {
    fetchSpy.mockClear();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchSpy
    });
  });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    if (originalFetch)
      Object.defineProperty(globalThis, 'fetch', originalFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
  });

  it('declines non-calendar questions without reading the clock', async () => {
    const now = jest.fn();
    await expect(
      new HelpBotCalendarService(now).answer({
        question: 'what is TDH?',
        baseUrl: BASE_URL
      })
    ).resolves.toBeNull();
    expect(now).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-01-02T10:00:00Z', '2026-01-02 15:40 UTC', '2026-01-03 15:00 UTC'],
    ['2026-07-01T10:00:00Z', '2026-07-01 14:40 UTC', '2026-07-02 14:00 UTC'],
    ['2026-03-29T10:00:00Z', '2026-03-30 14:40 UTC', '2026-03-31 14:00 UTC'],
    ['2026-10-25T10:00:00Z', '2026-10-26 15:40 UTC', '2026-10-27 15:00 UTC'],
    ['2026-12-31T10:00:00Z', '2027-01-01 15:40 UTC', '2027-01-02 15:00 UTC']
  ])('answers next-drop timing locally at %s', async (clock, start, end) => {
    const answer = await at(clock).answer({
      question: 'when is the next drop?',
      baseUrl: BASE_URL
    });
    expect(answer?.queryId).toBe('meme_calendar.next');
    expect(answer?.answer).toContain(`It opens ${start} and closes ${end}.`);
    expect(answer?.answer).toMatch(
      /Links: \[Meme #\d+\]\(https:\/\/6529.io\/the-memes\/\d+\)/
    );
    expect(answer?.answer).toContain(
      '[Memes Calendar](https://6529.io/meme-calendar)'
    );
  });

  it('answers historical mint questions using the rescheduled date', async () => {
    const answer = await at('2026-01-02T10:00:00Z').answer({
      question: 'when was Meme #415?',
      baseUrl: BASE_URL
    });
    expect(answer?.queryId).toBe('meme_calendar.mint.415');
    expect(answer?.answer).toContain('Meme Card #415 minted on 2025-10-21.');
    expect(answer?.answer).toContain(
      'It opened 2025-10-21 14:40 UTC and closed 2025-10-22 14:00 UTC.'
    );
    expect(answer?.answer).toContain(
      'Links: [Meme #415](https://6529.io/the-memes/415)'
    );
    expect(answer?.answer).not.toContain('overall');
  });

  it.each([
    ['when does drop #500 open?', 500],
    ['when will card number 6529 drop', 6529],
    ['when is card 1234 dropping', 1234]
  ])('keeps specific-mint question parsing for %s', async (question, id) => {
    const answer = await at('2026-01-02T10:00:00Z').answer({
      question,
      baseUrl: `${BASE_URL}/`
    });
    expect(answer?.queryId).toBe(`meme_calendar.mint.${id}`);
    expect(answer?.answer).toContain(`Meme Card #${id} opens `);
    expect(answer?.answer).toContain(
      `[Meme #${id}](https://6529.io/the-memes/${id})`
    );
    expect(answer?.answer).not.toContain('overall');
  });

  it('answers current-drop questions after midnight during the previous day mint', async () => {
    const answer = await at('2026-10-20T10:00:00Z').answer({
      question: 'what is minting now?',
      baseUrl: BASE_URL
    });
    expect(answer?.queryId).toBe('meme_calendar.current');
    expect(answer?.answer).toContain(
      'is minting now. It opened 2026-10-19 14:40 UTC and closes 2026-10-20 14:00 UTC.'
    );
  });

  it('shows no live mint at the exact closing instant', async () => {
    const answer = await at('2026-10-20T14:00:00Z').answer({
      question: 'what is minting now?',
      baseUrl: BASE_URL
    });
    expect(answer?.answer).toContain('Nothing is minting right now.');
    expect(answer?.answer).toContain('opens 2026-10-21 14:40 UTC');
  });

  it('shows a live mint at the exact opening instant', async () => {
    const answer = await at('2026-10-26T15:40:00Z').answer({
      question: 'what is minting now?',
      baseUrl: 'https://staging.6529.io'
    });
    expect(answer?.answer).toContain(
      'is minting now. It opened 2026-10-26 15:40 UTC'
    );
    expect(answer?.answer).toContain('https://staging.6529.io/the-memes/');
  });

  it('retains prior-answer context for follow-up timing questions', async () => {
    const answer = await at('2026-07-01T10:00:00Z').answer({
      question: 'what time?',
      previousBotAnswer: 'The next Meme Card drop is coming.',
      baseUrl: BASE_URL
    });
    expect(answer?.queryId).toBe('meme_calendar.next');
  });

  it('fails closed for out-of-range mint numbers and invalid clocks', async () => {
    await expect(
      at('2026-07-01T10:00:00Z').answer({
        question: 'when is Meme #100001?',
        baseUrl: BASE_URL
      })
    ).rejects.toThrow('Mint number must');
    await expect(
      at('invalid').answer({
        question: 'when is the next mint?',
        baseUrl: BASE_URL
      })
    ).rejects.toThrow('Invalid calendar time');
  });
});
