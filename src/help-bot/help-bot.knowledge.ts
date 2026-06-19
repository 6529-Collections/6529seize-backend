import { HELP_BOT_KNOWLEDGE_VERSION } from './help-bot.config';

export interface HelpBotKnowledgeRecord {
  readonly id: string;
  readonly title: string;
  readonly canonicalPath: string;
  readonly aliases: string[];
  readonly keywords: string[];
  readonly facts: string[];
}

export interface HelpBotKnowledgeMatch {
  readonly record: HelpBotKnowledgeRecord;
  readonly score: number;
}

const MINIMUM_MATCH_SCORE = 2;

export const HELP_BOT_KNOWLEDGE_RECORDS: HelpBotKnowledgeRecord[] = [
  {
    id: 'tdh',
    title: 'TDH',
    canonicalPath: '/network/tdh',
    aliases: ['tdh', 'total days held', 'total day held'],
    keywords: ['tdh', 'total', 'days', 'held', 'boost', 'boosts', 'unboosted'],
    facts: [
      'TDH stands for Total Days Held.',
      'It is the 6529 time-weighted holding metric: NFTs accrue days-held, then edition-size weighting and collection boosters are applied.',
      'TDH is calculated daily at 00:00 UTC.'
    ]
  },
  {
    id: 'tdh-definitions',
    title: 'Network definitions',
    canonicalPath: '/network/definitions',
    aliases: ['definitions', 'network definitions', 'tdh definitions'],
    keywords: [
      'definition',
      'definitions',
      'cards',
      'collected',
      'unique',
      'memes',
      'sets',
      'tdh'
    ],
    facts: [
      'Network definitions explain Cards Collected, Unique Memes, Meme Sets, TDH variants, purchases, sales, and transfers.',
      'Use this page when you need a glossary for network metrics rather than a single metric page.'
    ]
  },
  {
    id: 'waves',
    title: 'Waves',
    canonicalPath: '/waves',
    aliases: ['waves', 'wave', 'wave thread', 'wave threads'],
    keywords: [
      'wave',
      'waves',
      'thread',
      'chat',
      'rank',
      'approve',
      'vote',
      'drop',
      'drops'
    ],
    facts: [
      'Waves are the main social threads for browsing conversations, posting drops, voting, reacting, and managing wave activity.',
      'Standard wave threads live at /waves/{waveId}; direct-message threads live at /messages/{waveId}.'
    ]
  },
  {
    id: 'create-wave',
    title: 'Create a wave',
    canonicalPath: '/waves/create',
    aliases: [
      'create a wave',
      'create wave',
      'new wave',
      'make a wave',
      'start a wave'
    ],
    keywords: [
      'create',
      'new',
      'make',
      'start',
      'wave',
      'waves',
      'plus',
      '+',
      'features',
      'docs'
    ],
    facts: [
      'To create a wave, use the plus button in the Waves left sidebar or go directly to /waves/create.',
      'The create flow supports Chat, Rank, and Approve waves.',
      'Chat waves go through Overview, Groups, and Description; Rank and Approve waves also include Dates, Drops, Voting, and Outcomes.'
    ]
  },
  {
    id: 'subscriptions',
    title: 'The Memes subscriptions',
    canonicalPath: '/about/subscriptions',
    aliases: [
      'subscriptions',
      'subscription minting',
      'meme subscriptions',
      'memes subscriptions'
    ],
    keywords: [
      'subscription',
      'subscriptions',
      'subscribe',
      'mint',
      'minting',
      'airdrop',
      'top',
      'balance',
      'eligibility'
    ],
    facts: [
      'Subscription Minting is an optional way to mint Meme Cards remotely, with potential gas savings or set-and-forget minting.',
      'Subscriptions are not a mintpass: they respect the same allowlist and phase process you would otherwise be eligible for.',
      'Your profile subscriptions tab shows balance, mode, top-up options, upcoming drops, and history at /{user}/subscriptions.'
    ]
  },
  {
    id: 'subscription-eligibility',
    title: 'Subscription eligibility',
    canonicalPath: '/about/subscriptions',
    aliases: [
      'subscription eligibility',
      'subscriptions eligibility',
      'eligible subscriptions',
      'subscription allowlist',
      'phase eligibility',
      'eligibility'
    ],
    keywords: [
      'subscription',
      'subscriptions',
      'eligibility',
      'eligible',
      'allowlist',
      'phase',
      'mintpass',
      'mint',
      'airdrop'
    ],
    facts: [
      'Subscriptions do not create extra eligibility.',
      'A subscription can only mint within the phase and allowlist access the profile would otherwise have.',
      'Top-ups must be received by 00:00 UTC the day before a Meme Card mint to be eligible for that mint.'
    ]
  },
  {
    id: 'profile-subscriptions-tab',
    title: 'Profile subscriptions tab',
    canonicalPath: '/{user}/subscriptions',
    aliases: ['profile subscriptions', 'subscriptions tab', 'my subscriptions'],
    keywords: [
      'profile',
      'subscriptions',
      'tab',
      'top',
      'up',
      'balance',
      'mode',
      'history',
      'upcoming'
    ],
    facts: [
      'The profile Subscriptions tab shows current balance, airdrop address, manual or automatic mode, edition preference, upcoming drops, and history.',
      'Owner mode can update settings and top up; read-only viewers can inspect the tab without changing settings.'
    ]
  },
  {
    id: 'rep-cic',
    title: 'REP and CIC',
    canonicalPath: '/rep/categories',
    aliases: ['rep', 'cic', 'reputation', 'community interaction count'],
    keywords: [
      'rep',
      'cic',
      'reputation',
      'rate',
      'rating',
      'categories',
      'community',
      'interaction'
    ],
    facts: [
      'REP is peer-given reputation in categories and waves.',
      'CIC is the community interaction count signal shown on profiles and network surfaces.',
      'REP category analytics live under /rep/categories.'
    ]
  },
  {
    id: 'levels',
    title: 'Levels',
    canonicalPath: '/network/levels',
    aliases: ['levels', 'level'],
    keywords: ['levels', 'level', 'tdh', 'rep', 'network'],
    facts: [
      'Levels are an integrated metric that combines TDH and REP.',
      'The Network Levels page explains the current thresholds and how level is derived.'
    ]
  },
  {
    id: 'delegation',
    title: 'Delegation',
    canonicalPath: '/delegation',
    aliases: ['delegation', 'delegate', 'delegations'],
    keywords: [
      'delegation',
      'delegate',
      'delegations',
      'airdrop',
      'vault',
      'wallet',
      'mapping'
    ],
    facts: [
      'Delegation lets a wallet authorize another wallet for supported uses such as airdrops.',
      'The delegation area and mapping tools help review or configure the wallet relationships used by 6529 features.'
    ]
  },
  {
    id: 'the-memes',
    title: 'The Memes',
    canonicalPath: '/the-memes',
    aliases: ['the memes', 'memes', 'meme cards', 'meme card'],
    keywords: [
      'memes',
      'meme',
      'card',
      'cards',
      'mint',
      'season',
      'szn',
      'collection'
    ],
    facts: [
      'The Memes is the main Meme Card collection area.',
      'Use The Memes routes to browse cards, individual card pages, distribution details, and minting surfaces.'
    ]
  },
  {
    id: 'nextgen',
    title: 'NextGen',
    canonicalPath: '/nextgen',
    aliases: ['nextgen', 'next gen', 'nextgen collection'],
    keywords: ['nextgen', 'next', 'gen', 'collection', 'token', 'mint', 'art'],
    facts: [
      'NextGen is the generative collection area for NextGen collections, tokens, art, minting, and manager tools.',
      'Collection pages live under /nextgen/collection/{collection}.'
    ]
  }
];

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#/{}]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenize(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(' ')
      .filter((token) => token.length > 1 || token === '+')
  );
}

function phraseScore(question: string, record: HelpBotKnowledgeRecord): number {
  return record.aliases.reduce((score, alias) => {
    const normalizedAlias = normalizeText(alias);
    return question.includes(normalizedAlias) ? score + 3 : score;
  }, 0);
}

function keywordScore(
  questionTokens: Set<string>,
  record: HelpBotKnowledgeRecord
): number {
  return record.keywords.reduce((score, keyword) => {
    return questionTokens.has(normalizeText(keyword)) ? score + 1 : score;
  }, 0);
}

export function findHelpBotKnowledgeRecord(
  question: string
): HelpBotKnowledgeMatch | null {
  const normalizedQuestion = normalizeText(question);
  if (!normalizedQuestion) {
    return null;
  }
  const questionTokens = tokenize(question);
  const matches = HELP_BOT_KNOWLEDGE_RECORDS.map((record) => ({
    record,
    score:
      phraseScore(normalizedQuestion, record) +
      keywordScore(questionTokens, record)
  }))
    .filter((match) => match.score >= MINIMUM_MATCH_SCORE)
    .sort(
      (a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id)
    );

  return matches[0] ?? null;
}

export function getKnowledgeVersion(): string {
  return HELP_BOT_KNOWLEDGE_VERSION;
}
