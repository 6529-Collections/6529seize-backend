import { FrontendHelpBotKnowledgeSource } from './help-bot.knowledge';

function response(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body)
  };
}

describe('FrontendHelpBotKnowledgeSource', () => {
  it('loads snake_case frontend help index records', async () => {
    const source = new FrontendHelpBotKnowledgeSource(async () =>
      response({
        schema_version: 1,
        generated_at: '2026-06-19T00:00:00.000Z',
        commit_sha: 'test',
        base_url: 'https://6529.io',
        records: [
          {
            id: 'network.tdh',
            kind: 'glossary',
            title: 'TDH',
            canonical_path: '/network/tdh',
            aliases: ['tdh', 'total days held'],
            keywords: ['tdh', 'total', 'days', 'held'],
            facts: ['TDH stands for Total Days Held.'],
            related_paths: ['/network/definitions'],
            tags: ['network'],
            source_refs: ['ops/help/help-index.json']
          }
        ]
      })
    );

    const match = await source.findMatch('what is tdh?');

    expect(match?.record.id).toBe('network.tdh');
    expect(match?.record.canonicalPath).toBe('/network/tdh');
    expect(match?.record.relatedPaths).toEqual(['/network/definitions']);
    expect(match?.record.sourceRefs).toEqual(['ops/help/help-index.json']);
  });

  it('returns null when the frontend help index cannot be loaded', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(response('missing', false, 404));
    const source = new FrontendHelpBotKnowledgeSource(fetcher);

    await expect(source.findMatch('what is tdh?')).resolves.toBeNull();
    await expect(source.findMatch('what is tdh?')).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
