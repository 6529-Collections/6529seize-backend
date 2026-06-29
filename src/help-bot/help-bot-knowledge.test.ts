import {
  FrontendHelpBotKnowledgeSource,
  HelpBotKnowledgeIndex,
  HelpBotKnowledgeUnavailableError,
  StaticHelpBotKnowledgeSource
} from './help-bot.knowledge';

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
            link_label: 'TDH page',
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
    expect(match?.record.linkLabel).toBe('TDH page');
    expect(match?.record.canonicalPath).toBe('/network/tdh');
    expect(match?.record.relatedPaths).toEqual(['/network/definitions']);
    expect(match?.record.sourceRefs).toEqual(['ops/help/help-index.json']);
  });

  it('returns bounded sorted matches from frontend help index records', async () => {
    const source = new FrontendHelpBotKnowledgeSource(async () =>
      response({
        schema_version: 1,
        generated_at: '2026-06-19T00:00:00.000Z',
        commit_sha: 'test',
        base_url: 'https://6529.io',
        records: [
          {
            id: 'delegation.wallet-architecture',
            title: 'Wallet Architecture',
            canonical_path: '/delegation/wallet-architecture',
            aliases: ['wallet architecture', '4 wallet architecture'],
            keywords: ['wallet', 'architecture', 'vault'],
            facts: ['Separate vault, transaction, and minting wallets.']
          },
          {
            id: 'delegation.faq',
            title: 'Delegation FAQ',
            canonical_path: '/delegation/delegation-faq',
            aliases: ['delegation faq'],
            keywords: ['delegation', 'wallet', 'architecture'],
            facts: ['The Delegation FAQ has setup guides.']
          },
          {
            id: 'network.tdh',
            title: 'TDH',
            canonical_path: '/network/tdh',
            aliases: ['tdh'],
            keywords: ['tdh'],
            facts: ['TDH stands for Total Days Held.']
          }
        ]
      })
    );

    const matches = await source.findMatches(
      'how do i set up a 4 wallet architecture with delegation docs',
      2
    );

    expect(matches.map((match) => match.record.id)).toEqual([
      'delegation.wallet-architecture',
      'delegation.faq'
    ]);
  });

  it('throws and negative-caches when the frontend help index cannot be loaded', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(response('missing', false, 404));
    const source = new FrontendHelpBotKnowledgeSource(fetcher);

    await expect(source.findMatch('what is tdh?')).rejects.toThrow(
      HelpBotKnowledgeUnavailableError
    );
    await expect(source.findMatch('what is tdh?')).rejects.toThrow(
      HelpBotKnowledgeUnavailableError
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('StaticHelpBotKnowledgeSource', () => {
  const index: HelpBotKnowledgeIndex = {
    schemaVersion: 1,
    generatedAt: '2026-06-19T00:00:00.000Z',
    commitSha: 'test',
    baseUrl: 'https://6529.io',
    records: [
      {
        id: 'rep.cic',
        kind: 'glossary',
        title: 'REP and CIC',
        linkLabel: 'REP',
        canonicalPath: '/rep/categories',
        aliases: ['rep'],
        keywords: ['rep', 'cic'],
        facts: ['REP is peer-given reputation.'],
        relatedPaths: [],
        tags: ['rep'],
        sourceRefs: []
      },
      {
        id: 'realtime.live-updates',
        kind: 'troubleshooting',
        title: 'Authenticated live updates',
        linkLabel: 'Realtime Connectivity',
        canonicalPath: '/waves',
        aliases: ['reply notification but no chat message'],
        keywords: ['reply', 'notification', 'chat'],
        facts: ['Live wave updates use websocket events.'],
        relatedPaths: [],
        tags: ['realtime'],
        sourceRefs: []
      }
    ]
  };

  it('does not match aliases inside larger words', async () => {
    const source = new StaticHelpBotKnowledgeSource(index);

    const match = await source.findMatch(
      'why did i get a reply notification but not see the chat message'
    );

    expect(match?.record.id).toBe('realtime.live-updates');
  });

  it('returns bounded sorted matches for richer answer context', async () => {
    const source = new StaticHelpBotKnowledgeSource({
      ...index,
      records: index.records.concat([
        {
          id: 'delegation.wallet-architecture',
          kind: 'workflow',
          title: 'Wallet Architecture',
          linkLabel: 'Wallet Architecture',
          canonicalPath: '/delegation/wallet-architecture',
          aliases: ['wallet architecture', '4 wallet architecture'],
          keywords: ['wallet', 'architecture', 'vault'],
          facts: ['Separate vault, transaction, and minting wallets.'],
          relatedPaths: [],
          tags: ['delegation'],
          sourceRefs: []
        },
        {
          id: 'delegation.faq',
          kind: 'route',
          title: 'Delegation FAQ',
          linkLabel: 'Delegation FAQ',
          canonicalPath: '/delegation/delegation-faq',
          aliases: ['delegation faq'],
          keywords: ['delegation', 'wallet', 'architecture'],
          facts: ['The Delegation FAQ has setup guides.'],
          relatedPaths: [],
          tags: ['delegation'],
          sourceRefs: []
        }
      ])
    });

    const matches = await source.findMatches!(
      'how do i set up a 4 wallet architecture with delegation docs',
      2
    );

    expect(matches.map((match) => match.record.id)).toEqual([
      'delegation.wallet-architecture',
      'delegation.faq'
    ]);
  });
});
