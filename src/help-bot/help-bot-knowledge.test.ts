import {
  FrontendHelpBotKnowledgeSource,
  HelpBotKnowledgeIndex,
  HelpBotKnowledgeUnavailableError,
  isAmbiguousWalletManagementQuestion,
  isMultiWalletLimitQuestion,
  isMultiWalletRemovalQuestion,
  isMultiWalletReplacementQuestion,
  isMultiWalletSetupQuestion,
  StaticHelpBotKnowledgeSource
} from './help-bot.knowledge';

function response(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body)
  };
}

describe('multi-wallet intent boundaries', () => {
  it.each([
    'how many wallets can i connect to metamask?',
    'what is the metamask wallet limit?',
    'how do i replace my hardware wallet?',
    'how do i remove a delegate wallet?',
    'how do i change my wallet architecture?'
  ])('does not classify unrelated wallet wording in "%s"', (question) => {
    expect(
      [
        isMultiWalletSetupQuestion(question),
        isMultiWalletLimitQuestion(question),
        isMultiWalletRemovalQuestion(question),
        isMultiWalletReplacementQuestion(question)
      ].some(Boolean)
    ).toBe(false);
  });

  it.each([
    'how do i remove a wallet?',
    'how do i replace a wallet?',
    'where do i connect an additional wallet?',
    'how many wallets can i connect?'
  ])(
    'treats ambiguous wallet-management wording in "%s" as clarification',
    (question) => {
      expect(isMultiWalletRemovalQuestion(question)).toBe(false);
      expect(isMultiWalletReplacementQuestion(question)).toBe(false);
      expect(isAmbiguousWalletManagementQuestion(question)).toBe(true);
    }
  );

  it('does not use "together" alone as a consolidation-limit signal', () => {
    expect(isMultiWalletLimitQuestion('how many wallets work together?')).toBe(
      false
    );
  });
});

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
            suppress_source_links: true,
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
    expect(match?.record.suppressSourceLinks).toBe(true);
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

  it('matches pluralized product terms against singular aliases', async () => {
    const source = new FrontendHelpBotKnowledgeSource(async () =>
      response({
        schema_version: 1,
        generated_at: '2026-06-19T00:00:00.000Z',
        commit_sha: 'test',
        base_url: 'https://6529.io',
        records: [
          {
            id: 'network.definitions',
            title: 'Network Definitions',
            canonical_path: '/network/definitions',
            aliases: ['genesis set'],
            keywords: ['genesis', 'set'],
            facts: ['Genesis Set is a TDH boost definition.']
          }
        ]
      })
    );

    const match = await source.findMatch('what are Genesis Sets?');

    expect(match?.record.id).toBe('network.definitions');
  });

  it.each(['what is stream?', 'what is 6529 stream?'])(
    'routes %s to the Stream summary instead of an alphabetically earlier FAQ',
    async (question) => {
      const source = new FrontendHelpBotKnowledgeSource(async () =>
        response({
          schema_version: 1,
          generated_at: '2026-07-27T00:00:00.000Z',
          commit_sha: 'test',
          base_url: 'https://6529.io',
          records: [
            {
              id: 'about.faq',
              title: 'About FAQ',
              canonical_path: '/about/faq',
              aliases: ['6529'],
              keywords: ['6529', 'stream'],
              facts: ['Generic FAQ facts.']
            },
            {
              id: 'public-reviews.stream',
              title: '6529 Stream',
              canonical_path: '/reviews/6529-stream',
              aliases: ['stream', '6529 stream', 'stream contract'],
              keywords: ['stream', 'contract', 'review'],
              facts: ['Stream is a public contract review.']
            }
          ]
        })
      );

      const match = await source.findMatch(question);

      expect(match?.record.id).toBe('public-reviews.stream');
    }
  );

  it('does not generate unsafe trailing-s singular variants', async () => {
    const source = new FrontendHelpBotKnowledgeSource(async () =>
      response({
        schema_version: 1,
        generated_at: '2026-06-19T00:00:00.000Z',
        commit_sha: 'test',
        base_url: 'https://6529.io',
        records: [
          {
            id: 'debug.bad-stem',
            title: 'Bad Stem',
            canonical_path: '/debug/bad-stem',
            aliases: ['statu'],
            keywords: ['statu'],
            facts: ['This record should not match status.']
          }
        ]
      })
    );

    const match = await source.findMatch('what is status?');

    expect(match).toBeNull();
  });

  it('routes wallet consolidation questions to consolidation records', async () => {
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
            aliases: ['wallet architecture'],
            keywords: ['wallet', 'architecture', 'vault'],
            facts: ['Separate vault, transaction, and minting wallets.']
          },
          {
            id: 'delegation.register-consolidation-doc',
            title: 'Register Consolidation Guide',
            canonical_path: '/delegation/delegation-faq/register-consolidation',
            aliases: ['register consolidation guide'],
            keywords: ['register', 'consolidation'],
            facts: ['Register Consolidation connects wallets you control.']
          },
          {
            id: 'delegation.register-consolidation',
            title: 'Register Consolidation',
            canonical_path: '/delegation/register-consolidation',
            aliases: ['register consolidation'],
            keywords: ['register', 'consolidation'],
            facts: ['Use the Register Consolidation form.']
          },
          {
            id: 'delegation.consolidation-use-cases',
            title: 'Consolidation Use Cases',
            canonical_path: '/delegation/consolidation-use-cases',
            aliases: ['consolidation use cases'],
            keywords: ['consolidation', 'wallet'],
            facts: [
              '6529 recognizes up to three addresses as one consolidation group.'
            ]
          }
        ]
      })
    );

    const matches = await source.findMatches(
      "i have four wallets i'd like to consolidate. how do i do that?",
      4
    );

    const matchIds = matches.map((match) => match.record.id);
    expect(matchIds[0]).toBe('delegation.consolidation-use-cases');
    expect(new Set(matchIds)).toEqual(
      new Set([
        'delegation.register-consolidation-doc',
        'delegation.register-consolidation',
        'delegation.wallet-architecture',
        'delegation.consolidation-use-cases'
      ])
    );
  });

  it.each([
    'how do i add a second wallet?',
    'can i link another address to my setup?',
    'how can i pair two wallets?',
    'how do i set up multiple wallets?',
    'how do i link my wallet with another wallet?',
    'how do i add my other wallet?',
    'where can i link my wallets?',
    'i have another wallet; how do i add it?',
    'there are two wallets i need to link',
    'can i add three wallets?',
    'where can i add more wallets?'
  ])('routes natural multi-wallet wording in "%s"', async (question) => {
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
            aliases: ['wallet architecture'],
            keywords: ['wallet', 'architecture', 'vault'],
            facts: ['Separate vault, transaction, and minting wallets.']
          },
          {
            id: 'delegation.register-consolidation-doc',
            title: 'Register Consolidation Guide',
            canonical_path: '/delegation/delegation-faq/register-consolidation',
            aliases: ['register consolidation guide'],
            keywords: ['register', 'consolidation'],
            facts: ['Register Consolidation connects wallets you control.']
          },
          {
            id: 'delegation.register-consolidation',
            title: 'Register Consolidation',
            canonical_path: '/delegation/register-consolidation',
            aliases: ['register consolidation'],
            keywords: ['register', 'consolidation'],
            facts: ['Use the Register Consolidation form.']
          },
          {
            id: 'delegation.consolidation-use-cases',
            title: 'Consolidation Use Cases',
            canonical_path: '/delegation/consolidation-use-cases',
            aliases: ['consolidation use cases'],
            keywords: ['consolidation', 'wallet'],
            facts: [
              '6529 recognizes up to three addresses as one consolidation group.'
            ]
          }
        ]
      })
    );

    const matches = await source.findMatches(question, 4);

    const matchIds = matches.map((match) => match.record.id);

    expect(matchIds.slice(0, 2)).toEqual([
      'delegation.register-consolidation-doc',
      'delegation.register-consolidation'
    ]);
    expect(matchIds.slice(2)).toEqual(
      expect.arrayContaining([
        'delegation.consolidation-use-cases',
        'delegation.wallet-architecture'
      ])
    );
  });

  it.each([
    'how many wallets can i add?',
    'what is the maximum number of wallets i can link?',
    'is there a limit to the addresses i can pair?',
    'what is the wallet capacity for one consolidation?',
    'how many addresses can 6529 treat together?',
    'what is the max wallets?',
    'is there a wallet limit?',
    'how many wallets are allowed?'
  ])('routes natural consolidation-limit wording in "%s"', async (question) => {
    const source = new FrontendHelpBotKnowledgeSource(async () =>
      response({
        schema_version: 1,
        generated_at: '2026-06-19T00:00:00.000Z',
        commit_sha: 'test',
        base_url: 'https://6529.io',
        records: [
          {
            id: 'delegation.register-consolidation-doc',
            title: 'Register Consolidation Guide',
            canonical_path: '/delegation/delegation-faq/register-consolidation',
            aliases: ['register consolidation guide'],
            keywords: ['register', 'consolidation', 'wallet'],
            facts: ['Register Consolidation connects wallets you control.']
          },
          {
            id: 'delegation.consolidation-use-cases',
            title: 'Consolidation Use Cases',
            canonical_path: '/delegation/consolidation-use-cases',
            aliases: ['consolidation use cases'],
            keywords: ['consolidation', 'wallet', 'limit'],
            facts: [
              '6529 recognizes up to three addresses as one consolidation group.'
            ]
          },
          {
            id: 'delegation.wallet-architecture',
            title: 'Wallet Architecture',
            canonical_path: '/delegation/wallet-architecture',
            aliases: ['wallet architecture'],
            keywords: ['wallet', 'architecture'],
            facts: ['Separate vault, transaction, and minting wallets.']
          }
        ]
      })
    );

    const matches = await source.findMatches(question, 3);

    expect(matches[0]?.record.id).toBe('delegation.consolidation-use-cases');
    expect(matches.map((match) => match.record.id)).toEqual(
      expect.arrayContaining([
        'delegation.consolidation-use-cases',
        'delegation.wallet-architecture'
      ])
    );
  });

  it.each([
    'how do i remove one of my wallets?',
    'can i unlink my other address?',
    'how do i detach a wallet from consolidation?',
    'how do i delete a consolidated wallet?'
  ])('routes consolidation removal wording in "%s"', async (question) => {
    const source = new FrontendHelpBotKnowledgeSource(async () =>
      response({
        schema_version: 1,
        generated_at: '2026-06-19T00:00:00.000Z',
        commit_sha: 'test',
        base_url: 'https://6529.io',
        records: [
          {
            id: 'delegation.manage-revoke-doc',
            title: 'How to Revoke a Delegation or Consolidation',
            canonical_path: '/delegation/delegation-faq/manage-revoke',
            aliases: ['revoke consolidation'],
            keywords: ['revoke', 'remove', 'wallet', 'consolidation'],
            facts: ['Use View/Manage to revoke a consolidation record.']
          },
          {
            id: 'delegation.register-consolidation-doc',
            title: 'Register Consolidation Guide',
            canonical_path: '/delegation/delegation-faq/register-consolidation',
            aliases: ['register consolidation'],
            keywords: ['register', 'wallet', 'consolidation'],
            facts: ['Register Consolidation connects wallets you control.']
          }
        ]
      })
    );

    const match = await source.findMatch(question);

    expect(match?.record.id).toBe('delegation.manage-revoke-doc');
  });

  it.each([
    'how do i replace one of my wallets?',
    'can i swap my other address?',
    'how do i change a wallet in my consolidation?',
    'how do i update a consolidated address?',
    'how do i replace a wallet in consolidation from the delegation center?'
  ])('routes consolidation replacement wording in "%s"', async (question) => {
    const source = new FrontendHelpBotKnowledgeSource(async () =>
      response({
        schema_version: 1,
        generated_at: '2026-06-19T00:00:00.000Z',
        commit_sha: 'test',
        base_url: 'https://6529.io',
        records: [
          {
            id: 'delegation.manage-update-doc',
            title: 'How to Update a Delegation or Consolidation',
            canonical_path: '/delegation/delegation-faq/manage-update',
            aliases: ['update consolidation'],
            keywords: ['update', 'replace', 'wallet', 'consolidation'],
            facts: ['Use View/Manage to update a consolidation record.']
          },
          {
            id: 'delegation.manage-revoke-doc',
            title: 'How to Revoke a Delegation or Consolidation',
            canonical_path: '/delegation/delegation-faq/manage-revoke',
            aliases: ['revoke consolidation'],
            keywords: ['revoke', 'remove', 'wallet', 'consolidation'],
            facts: ['Use View/Manage to revoke a consolidation record.']
          }
        ]
      })
    );

    const match = await source.findMatch(question);

    expect(match?.record.id).toBe('delegation.manage-update-doc');
  });

  it.each([
    'how do i remove a wallet?',
    'how do i replace a wallet?',
    'where do i connect an additional wallet?',
    'how do i connect two wallets?'
  ])(
    'routes ambiguous wallet-management wording in "%s" to clarification',
    async (question) => {
      const source = new FrontendHelpBotKnowledgeSource(async () =>
        response({
          schema_version: 1,
          generated_at: '2026-06-19T00:00:00.000Z',
          commit_sha: 'test',
          base_url: 'https://6529.io',
          records: [
            {
              id: 'delegation.wallet-management-clarification',
              title: 'Wallet Management Clarification',
              canonical_path: '/delegation/delegation-center',
              aliases: ['wallet management clarification'],
              keywords: ['wallet', 'management', 'consolidation'],
              facts: [
                'Clarify whether the user means their connected wallet or a consolidation record.'
              ]
            },
            {
              id: 'delegation.manage-revoke-doc',
              title: 'How to Revoke a Delegation or Consolidation',
              canonical_path: '/delegation/delegation-faq/manage-revoke',
              aliases: ['revoke consolidation'],
              keywords: ['revoke', 'remove', 'wallet', 'consolidation'],
              facts: ['Use View/Manage to revoke a consolidation record.']
            },
            {
              id: 'delegation.manage-update-doc',
              title: 'How to Update a Delegation or Consolidation',
              canonical_path: '/delegation/delegation-faq/manage-update',
              aliases: ['update consolidation'],
              keywords: ['update', 'replace', 'wallet', 'consolidation'],
              facts: ['Use View/Manage to update a consolidation record.']
            }
          ]
        })
      );

      const match = await source.findMatch(question);

      expect(match?.record.id).toBe(
        'delegation.wallet-management-clarification'
      );
    }
  );

  it.each([
    'how do i replace wallet in consolidation using metamask?',
    'how do i remove wallet from consolidation in metamask?',
    'what is the metamask wallet consolidation limit?',
    'how do i replace my hardware wallet in a consolidation?',
    'how do i remove a delegate wallet from consolidation?'
  ])('does not bypass wallet-context exclusions in "%s"', async (question) => {
    const consolidationRecordIds = [
      'delegation.wallet-management-clarification',
      'delegation.register-consolidation-doc',
      'delegation.consolidation-use-cases',
      'delegation.manage-revoke-doc',
      'delegation.manage-update-doc'
    ];
    const source = new FrontendHelpBotKnowledgeSource(async () =>
      response({
        schema_version: 1,
        generated_at: '2026-06-19T00:00:00.000Z',
        commit_sha: 'test',
        base_url: 'https://6529.io',
        records: [
          {
            id: 'delegation.wallet-management-clarification',
            title: 'Wallet Management Clarification',
            canonical_path: '/delegation/delegation-center',
            aliases: ['wallet management clarification'],
            keywords: ['wallet', 'management'],
            facts: ['Clarify the wallet-management context.']
          },
          {
            id: 'delegation.register-consolidation-doc',
            title: 'Register Consolidation Guide',
            canonical_path: '/delegation/delegation-faq/register-consolidation',
            aliases: ['register consolidation guide'],
            keywords: ['register', 'consolidation', 'wallet'],
            facts: ['Register Consolidation connects wallets you control.']
          },
          {
            id: 'delegation.consolidation-use-cases',
            title: 'Consolidation Use Cases',
            canonical_path: '/delegation/consolidation-use-cases',
            aliases: ['wallet consolidation limit'],
            keywords: ['consolidation', 'wallet', 'limit'],
            facts: ['Only the last three addresses count.']
          },
          {
            id: 'delegation.manage-revoke-doc',
            title: 'How to Revoke a Consolidation',
            canonical_path: '/delegation/delegation-faq/manage-revoke',
            aliases: ['remove wallet from consolidation'],
            keywords: ['remove', 'wallet', 'consolidation'],
            facts: ['Use View/Manage to revoke a consolidation record.']
          },
          {
            id: 'delegation.manage-update-doc',
            title: 'How to Update a Consolidation',
            canonical_path: '/delegation/delegation-faq/manage-update',
            aliases: ['replace wallet in consolidation'],
            keywords: ['replace', 'wallet', 'consolidation'],
            facts: ['Use View/Manage to update a consolidation record.']
          }
        ]
      })
    );

    const matches = await source.findMatches(question, 5);

    expect(matches.map((match) => match.record.id)).toEqual(
      expect.not.arrayContaining(consolidationRecordIds)
    );
  });

  it.each([
    'how do i add another profile statement?',
    'how do i connect my hardware wallet?',
    'can i use more than one wallet?',
    'can i use two wallets?',
    'how do i link wallets?',
    'how do i add a delegate wallet?',
    'how many wallets exist?',
    'how many hardware wallets can this device connect?',
    'how many delegate wallets can i add?',
    'what is the metamask wallet limit?',
    'how many wallets can i connect to metamask?'
  ])(
    'does not misroute unrelated wallet/addition wording in "%s"',
    async (question) => {
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
              aliases: ['wallet architecture', 'hardware wallet setup'],
              keywords: ['wallet', 'architecture', 'vault'],
              facts: ['Separate vault, transaction, and minting wallets.']
            },
            {
              id: 'delegation.faq',
              title: 'Delegation FAQ',
              canonical_path: '/delegation/delegation-faq',
              aliases: ['set up delegation', 'delegate wallet'],
              keywords: ['delegation', 'delegate', 'wallet'],
              facts: ['Delegation grants scoped rights to another wallet.']
            },
            {
              id: 'delegation.register-consolidation-doc',
              title: 'Register Consolidation Guide',
              canonical_path:
                '/delegation/delegation-faq/register-consolidation',
              aliases: ['register consolidation guide'],
              keywords: ['register', 'consolidation', 'wallet'],
              facts: ['Register Consolidation connects wallets you control.']
            }
          ]
        })
      );

      const matches = await source.findMatches(question, 4);

      expect(matches.map((match) => match.record.id)).not.toContain(
        'delegation.register-consolidation-doc'
      );
    }
  );

  it('does not route generic transaction display questions as wallet architecture', async () => {
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
            aliases: ['wallet architecture'],
            keywords: ['transaction'],
            facts: ['Separate vault, transaction, and minting wallets.']
          },
          {
            id: 'delegation.wallet-checker',
            title: 'Wallet Checker',
            canonical_path: '/delegation/wallet-checker',
            aliases: ['wallet checker'],
            keywords: ['wallet'],
            facts: ['Wallet Checker reviews wallet setup.']
          }
        ]
      })
    );

    const match = await source.findMatch('show me my transaction history');

    expect(match).toBeNull();
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
          aliases: ['wallet architecture'],
          keywords: ['wallet', 'architecture', 'vault'],
          facts: ['Separate vault, transaction, and minting wallets.'],
          relatedPaths: [],
          tags: ['delegation'],
          sourceRefs: []
        },
        {
          id: 'delegation.consolidation-use-cases',
          kind: 'workflow',
          title: 'Consolidation Use Cases',
          linkLabel: 'Consolidation Use Cases',
          canonicalPath: '/delegation/consolidation-use-cases',
          aliases: ['consolidation use cases'],
          keywords: ['consolidation', 'wallet', 'limit'],
          facts: [
            '6529 recognizes up to three addresses as one consolidation group.'
          ],
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
      3
    );

    expect(matches.map((match) => match.record.id)).toEqual([
      'delegation.wallet-architecture',
      'delegation.consolidation-use-cases',
      'delegation.faq'
    ]);
  });

  it.each([
    {
      question: 'what is Genesis Set',
      expectedRecordIds: ['network.definitions.genesis-sets']
    },
    {
      question: 'what are Genesis Sets',
      expectedRecordIds: ['network.definitions.genesis-sets']
    },
    {
      question: 'what is Meme Set',
      expectedRecordIds: ['network.definitions.meme-sets']
    },
    {
      question: 'what is TDH unweighted',
      expectedRecordIds: ['network.definitions.tdh-unweighted']
    },
    {
      question: 'how can I check my architecture',
      expectedRecordIds: [
        'delegation.wallet-checker',
        'delegation.wallet-architecture'
      ]
    },
    {
      question: 'what is wallet architecture',
      expectedRecordIds: ['delegation.wallet-architecture']
    },
    {
      question: 'how do I check delegations/consolidations',
      expectedRecordIds: ['delegation.wallet-checker']
    },
    {
      question: 'how many wallets can be in one consolidation group',
      expectedRecordIds: ['delegation.consolidation-use-cases']
    },
    {
      question: 'what is Nakamoto Set',
      expectedRecordIds: ['network.tdh.nakamoto-set']
    },
    {
      question: 'how can i check my architecture and view delegations',
      expectedRecordIds: [
        'delegation.wallet-checker',
        'delegation.wallet-architecture'
      ]
    }
  ])(
    'routes "$question" to explicit help bot concept records',
    async ({ question, expectedRecordIds }) => {
      const source = new StaticHelpBotKnowledgeSource({
        ...index,
        records: index.records.concat([
          {
            id: 'network.definitions',
            kind: 'glossary',
            title: 'Network definitions',
            linkLabel: 'Network definitions',
            canonicalPath: '/network/definitions',
            aliases: ['network definitions', 'genesis set'],
            keywords: ['definitions', 'network', 'genesis'],
            facts: ['Network definitions explain metric terms.'],
            relatedPaths: ['/network/tdh'],
            tags: ['network', 'glossary'],
            sourceRefs: []
          },
          {
            id: 'network.definitions.genesis-sets',
            kind: 'concept',
            title: 'Genesis Sets',
            linkLabel: 'Genesis Sets',
            canonicalPath: '/network/definitions',
            aliases: ['genesis set', 'genesis sets'],
            keywords: ['genesis', 'set', 'sets', 'tdh'],
            facts: [
              'Genesis Sets are complete sets of the first three Meme NFTs.'
            ],
            relatedPaths: ['/network/tdh'],
            tags: ['network', 'concept'],
            sourceRefs: []
          },
          {
            id: 'network.definitions.meme-sets',
            kind: 'concept',
            title: 'Meme Sets',
            linkLabel: 'Meme Sets',
            canonicalPath: '/network/definitions',
            aliases: ['meme set', 'meme sets'],
            keywords: ['meme', 'memes', 'set', 'sets'],
            facts: ['Meme Sets are complete sets of The Memes.'],
            relatedPaths: ['/network/tdh'],
            tags: ['network', 'concept'],
            sourceRefs: []
          },
          {
            id: 'network.definitions.tdh-unweighted',
            kind: 'concept',
            title: 'TDH (unweighted)',
            linkLabel: 'TDH unweighted',
            canonicalPath: '/network/definitions',
            aliases: ['tdh unweighted', 'unweighted tdh', 'raw tdh'],
            keywords: ['tdh', 'unweighted', 'raw'],
            facts: ['TDH unweighted is one unit per NFT per day held.'],
            relatedPaths: ['/network/tdh'],
            tags: ['network', 'tdh', 'concept'],
            sourceRefs: []
          },
          {
            id: 'network.tdh',
            kind: 'glossary',
            title: 'TDH',
            linkLabel: 'TDH',
            canonicalPath: '/network/tdh',
            aliases: ['tdh', 'total days held'],
            keywords: ['tdh', 'boost', 'genesis', 'nakamoto'],
            facts: ['TDH means Total Days Held.'],
            relatedPaths: ['/network/definitions'],
            tags: ['network', 'tdh'],
            sourceRefs: []
          },
          {
            id: 'network.tdh.nakamoto-set',
            kind: 'concept',
            title: 'Nakamoto Set',
            linkLabel: 'Nakamoto Set',
            canonicalPath: '/network/tdh',
            aliases: ['nakamoto set', 'nakamoto sets'],
            keywords: ['nakamoto', 'set', 'sets', 'tdh', 'boost'],
            facts: ['Nakamoto Set is a SZN1 Category B TDH boost term.'],
            relatedPaths: ['/network/definitions'],
            tags: ['network', 'tdh', 'concept'],
            sourceRefs: []
          },
          {
            id: 'delegation.wallet-architecture',
            kind: 'workflow',
            title: 'Wallet Architecture',
            linkLabel: 'Wallet Architecture',
            canonicalPath: '/delegation/wallet-architecture',
            aliases: ['wallet architecture', 'architecture'],
            keywords: ['wallet', 'architecture', 'vault'],
            facts: [
              'Wallet architecture separates vault, transaction, and minting wallets.'
            ],
            relatedPaths: ['/delegation/wallet-checker'],
            tags: ['delegation', 'wallet'],
            sourceRefs: []
          },
          {
            id: 'delegation.wallet-checker',
            kind: 'route',
            title: 'Wallet Checker',
            linkLabel: 'Wallet Checker',
            canonicalPath: '/delegation/wallet-checker',
            aliases: ['wallet checker', 'check wallet architecture'],
            keywords: [
              'wallet',
              'checker',
              'check',
              'view',
              'delegations',
              'consolidations',
              'architecture'
            ],
            facts: [
              'Wallet Checker reviews active delegations and consolidations.'
            ],
            relatedPaths: ['/delegation/wallet-architecture'],
            tags: ['delegation', 'wallet'],
            sourceRefs: []
          },
          {
            id: 'delegation.consolidation-use-cases',
            kind: 'workflow',
            title: 'Consolidation Use Cases',
            linkLabel: 'Consolidation Use Cases',
            canonicalPath: '/delegation/consolidation-use-cases',
            aliases: ['consolidation use cases'],
            keywords: ['consolidation', 'wallet', 'limit'],
            facts: [
              '6529 recognizes up to three addresses as one consolidation group.'
            ],
            relatedPaths: ['/delegation/wallet-architecture'],
            tags: ['delegation', 'wallet'],
            sourceRefs: []
          }
        ])
      });

      const matches = await source.findMatches!(
        question,
        expectedRecordIds.length
      );

      expect(matches.map((match) => match.record.id)).toEqual(
        expectedRecordIds
      );
    }
  );
});
