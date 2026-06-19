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

function splitPhrases(value: string): string[] {
  return value.split('|').map((item) => item.trim());
}

function splitKeywords(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function record(
  id: string,
  title: string,
  canonicalPath: string,
  aliases: string,
  keywords: string,
  facts: readonly string[]
): HelpBotKnowledgeRecord {
  return {
    id,
    title,
    canonicalPath,
    aliases: splitPhrases(aliases),
    keywords: splitKeywords(keywords),
    facts: [...facts]
  };
}

export const HELP_BOT_KNOWLEDGE_RECORDS: HelpBotKnowledgeRecord[] = [
  record(
    'tdh',
    'TDH',
    '/network/tdh',
    'tdh|total days held|total day held',
    'tdh total days held boost boosts unboosted',
    [
      'TDH stands for Total Days Held.',
      'It is the 6529 time-weighted holding metric: NFTs accrue days-held, then edition-size weighting and collection boosters are applied.',
      'TDH is calculated daily at 00:00 UTC.'
    ]
  ),
  record(
    'tdh-definitions',
    'Network definitions',
    '/network/definitions',
    'definitions|network definitions|tdh definitions',
    'definition definitions cards collected unique memes sets tdh',
    [
      'Network definitions explain Cards Collected, Unique Memes, Meme Sets, TDH variants, purchases, sales, and transfers.',
      'Use this page when you need a glossary for network metrics rather than a single metric page.'
    ]
  ),
  record(
    'waves',
    'Waves',
    '/waves',
    'waves|wave|wave thread|wave threads',
    'wave waves thread chat rank approve vote drop drops',
    [
      'Waves are the main social threads for browsing conversations, posting drops, voting, reacting, and managing wave activity.',
      'Standard wave threads live at /waves/{waveId}; direct-message threads live at /messages/{waveId}.'
    ]
  ),
  record(
    'create-wave',
    'Create a wave',
    '/waves/create',
    'create a wave|create wave|new wave|make a wave|start a wave',
    'create new make start wave waves plus + features docs',
    [
      'To create a wave, use the plus button in the Waves left sidebar or go directly to /waves/create.',
      'The create flow supports Chat, Rank, and Approve waves.',
      'Chat waves go through Overview, Groups, and Description; Rank and Approve waves also include Dates, Drops, Voting, and Outcomes.'
    ]
  ),
  record(
    'subscriptions',
    'The Memes subscriptions',
    '/about/subscriptions',
    'subscriptions|subscription minting|meme subscriptions|memes subscriptions',
    'subscription subscriptions subscribe mint minting airdrop top balance eligibility',
    [
      'Subscription Minting is an optional way to mint Meme Cards remotely, with potential gas savings or set-and-forget minting.',
      'Subscriptions are not a mintpass: they respect the same allowlist and phase process you would otherwise be eligible for.',
      'Your profile subscriptions tab shows balance, mode, top-up options, upcoming drops, and history at /{user}/subscriptions.'
    ]
  ),
  record(
    'subscription-eligibility',
    'Subscription eligibility',
    '/about/subscriptions',
    'subscription eligibility|subscriptions eligibility|eligible subscriptions|subscription allowlist|phase eligibility|eligibility',
    'subscription subscriptions eligibility eligible allowlist phase mintpass mint airdrop',
    [
      'Subscriptions do not create extra eligibility.',
      'A subscription can only mint within the phase and allowlist access the profile would otherwise have.',
      'Top-ups must be received by 00:00 UTC the day before a Meme Card mint to be eligible for that mint.'
    ]
  ),
  record(
    'profile-subscriptions-tab',
    'Profile subscriptions tab',
    '/{user}/subscriptions',
    'profile subscriptions|subscriptions tab|my subscriptions',
    'profile subscriptions tab top up balance mode history upcoming',
    [
      'The profile Subscriptions tab shows current balance, airdrop address, manual or automatic mode, edition preference, upcoming drops, and history.',
      'Owner mode can update settings and top up; read-only viewers can inspect the tab without changing settings.'
    ]
  ),
  record(
    'rep-cic',
    'REP and CIC',
    '/rep/categories',
    'rep|cic|reputation|community interaction count',
    'rep cic reputation rate rating categories community interaction',
    [
      'REP is peer-given reputation in categories and waves.',
      'CIC is the community interaction count signal shown on profiles and network surfaces.',
      'REP category analytics live under /rep/categories.'
    ]
  ),
  record(
    'levels',
    'Levels',
    '/network/levels',
    'levels|level',
    'levels level tdh rep network',
    [
      'Levels are an integrated metric that combines TDH and REP.',
      'The Network Levels page explains the current thresholds and how level is derived.'
    ]
  ),
  record(
    'delegation',
    'Delegation',
    '/delegation',
    'delegation|delegate|delegations',
    'delegation delegate delegations airdrop vault wallet mapping',
    [
      'Delegation lets a wallet authorize another wallet for supported uses such as airdrops.',
      'The delegation area and mapping tools help review or configure the wallet relationships used by 6529 features.'
    ]
  ),
  record(
    'the-memes',
    'The Memes',
    '/the-memes',
    'the memes|memes|meme cards|meme card',
    'memes meme card cards mint season szn collection',
    [
      'The Memes is the main Meme Card collection area.',
      'Use The Memes routes to browse cards, individual card pages, distribution details, and minting surfaces.'
    ]
  ),
  record(
    'nextgen',
    'NextGen',
    '/nextgen',
    'nextgen|next gen|nextgen collection',
    'nextgen next gen collection token mint art',
    [
      'NextGen is the generative collection area for NextGen collections, tokens, art, minting, and manager tools.',
      'Collection pages live under /nextgen/collection/{collection}.'
    ]
  )
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
