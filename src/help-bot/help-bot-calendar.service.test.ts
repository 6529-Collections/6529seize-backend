import { HelpBotCalendarService } from './help-bot-calendar.service';

const BASE_URL = 'https://6529.io';

function mintResponse(overrides: Record<string, unknown> = {}) {
  return {
    mint_number: 500,
    mint_date: '2026-10-19',
    mint_start: '2026-10-19T14:40:00.000Z',
    mint_end: '2026-10-20T14:00:00.000Z',
    status: 'upcoming',
    season: 17,
    year: 4,
    epoch: 1,
    period: 1,
    era: 1,
    eon: 1,
    calendar_path: '/meme-calendar',
    mint_path: '/the-memes/500',
    ...overrides
  };
}

function fetchResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body)
  } as unknown as Response;
}

describe('HelpBotCalendarService', () => {
  it('declines non-calendar questions', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const service = new HelpBotCalendarService(fetchImpl);

    await expect(
      service.answer({ question: 'what is TDH?', baseUrl: BASE_URL })
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers next-drop questions from the frontend calendar API', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        fetchResponse(mintResponse())
      ) as unknown as typeof fetch;
    const service = new HelpBotCalendarService(fetchImpl);

    await expect(
      service.answer({ question: 'when is the next drop?', baseUrl: BASE_URL })
    ).resolves.toEqual({
      answer:
        'The next Meme Card drop is Meme #500, scheduled for 2026-10-19 14:40 UTC. The overall mint window runs 2026-10-19 14:40 UTC to 2026-10-20 14:00 UTC. It is in SZN 17, Year 4.\n\nMore info: [Memes Calendar](https://6529.io/meme-calendar)',
      queryId: 'meme_calendar.next'
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://6529.io/api/meme-calendar/next',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('answers explicit Meme Card timing questions', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      fetchResponse(
        mintResponse({
          mint_number: 100,
          mint_date: '2023-05-01',
          mint_start: '2023-05-01T14:40:00.000Z',
          mint_end: '2023-05-02T14:00:00.000Z',
          status: 'past',
          season: 3,
          year: 1,
          mint_path: '/the-memes/100'
        })
      )
    ) as unknown as typeof fetch;
    const service = new HelpBotCalendarService(fetchImpl);

    const answer = await service.answer({
      question: 'when was Meme #100?',
      baseUrl: BASE_URL
    });

    expect(answer?.queryId).toBe('meme_calendar.mint.100');
    expect(answer?.answer).toContain('Meme Card #100 minted on 2023-05-01.');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://6529.io/api/meme-calendar/100',
      expect.any(Object)
    );
  });

  it('answers current-drop questions with the next mint when none is live', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      fetchResponse({
        status: 'none',
        current: null,
        next: mintResponse()
      })
    ) as unknown as typeof fetch;
    const service = new HelpBotCalendarService(fetchImpl);

    await expect(
      service.answer({ question: 'what is minting now?', baseUrl: BASE_URL })
    ).resolves.toEqual({
      answer:
        'Nothing is minting right now. The next Meme Card drop is Meme #500, scheduled for 2026-10-19 14:40 UTC.\n\nMore info: [Memes Calendar](https://6529.io/meme-calendar)',
      queryId: 'meme_calendar.current'
    });
  });
});
