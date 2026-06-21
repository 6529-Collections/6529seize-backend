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
        'The next Meme Card drop is Meme #500. It opens 2026-10-19 14:40 UTC and closes 2026-10-20 14:00 UTC. It is in SZN 17, Year 4.\n\nLinks: [Meme #500](https://6529.io/the-memes/500) | [Memes Calendar](https://6529.io/meme-calendar)',
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
    expect(answer?.answer).toContain(
      'It opened 2023-05-01 14:40 UTC and closed 2023-05-02 14:00 UTC.'
    );
    expect(answer?.answer).toContain(
      'Links: [Meme #100](https://6529.io/the-memes/100) | [Memes Calendar](https://6529.io/meme-calendar)'
    );
    expect(answer?.answer).not.toContain('overall');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://6529.io/api/meme-calendar/100',
      expect.any(Object)
    );
  });

  it('answers explicit drop-number timing questions', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        fetchResponse(mintResponse())
      ) as unknown as typeof fetch;
    const service = new HelpBotCalendarService(fetchImpl);

    const answer = await service.answer({
      question: 'when does drop #500 open?',
      baseUrl: `${BASE_URL}/`
    });

    expect(answer?.queryId).toBe('meme_calendar.mint.500');
    expect(answer?.answer).toContain(
      'Meme Card #500 opens 2026-10-19 14:40 UTC and closes 2026-10-20 14:00 UTC.'
    );
    expect(answer?.answer).not.toContain('overall');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://6529.io/api/meme-calendar/500',
      expect.any(Object)
    );
  });

  it('answers card-number phrasing as a specific Meme Card request', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      fetchResponse(
        mintResponse({
          mint_number: 6529,
          mint_date: '2064-11-28',
          mint_start: '2064-11-28T15:40:00.000Z',
          mint_end: '2064-11-29T15:00:00.000Z',
          status: 'upcoming',
          season: 169,
          year: 42,
          mint_path: '/the-memes/6529'
        })
      )
    ) as unknown as typeof fetch;
    const service = new HelpBotCalendarService(fetchImpl);

    await expect(
      service.answer({
        question: 'when will card number 6529 drop',
        baseUrl: BASE_URL
      })
    ).resolves.toEqual({
      answer:
        'Meme Card #6529 opens 2064-11-28 15:40 UTC and closes 2064-11-29 15:00 UTC. It is in SZN 169, Year 42.\n\nLinks: [Meme #6529](https://6529.io/the-memes/6529) | [Memes Calendar](https://6529.io/meme-calendar)',
      queryId: 'meme_calendar.mint.6529'
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://6529.io/api/meme-calendar/6529',
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
        'Nothing is minting right now. The next Meme Card drop is Meme #500, which opens 2026-10-19 14:40 UTC and closes 2026-10-20 14:00 UTC.\n\nLinks: [Meme #500](https://6529.io/the-memes/500) | [Memes Calendar](https://6529.io/meme-calendar)',
      queryId: 'meme_calendar.current'
    });
  });
});
