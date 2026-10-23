import {
  getMintTimelineDetails,
  getNextMintTimelineDetails,
  getCurrentMintTimelineDetails,
  getMintTimelineStatus
} from '@/memes-calendar';
import { formatHelpBotMarkdownLink } from './help-bot-response-text';

export interface HelpBotCalendarAnswerRequest {
  readonly question: string;
  readonly baseUrl: string;
  readonly previousBotAnswer?: string | null;
}

export interface HelpBotCalendarAnswer {
  readonly answer: string;
  readonly queryId: string;
}

type CalendarEndpoint =
  | { readonly kind: 'mint'; readonly mintNumber: number }
  | { readonly kind: 'next' }
  | { readonly kind: 'current' };

type CalendarMint = ReturnType<typeof getMintTimelineDetails>;

const CALENDAR_LINK_LABEL = 'Memes Calendar';

const CALENDAR_TIME_PATTERN =
  /\b(?:when|what\s+(?:time|date|day)|schedule|calendar|next|current|upcoming|live|past|minting\s+window|mint\s+window)\b/i;
const CALENDAR_CONTEXT_PATTERNS = [
  /\bmemes?\b/i,
  /\bcards?\b/i,
  /\bmint(?:ing)?\b/i,
  /\bcalendar\b/i,
  /\bdrops?\b/i,
  /\bdropped\b/i,
  /\bdropping\b/i
];
const NEXT_DROP_PATTERN = /\bnext\s+drop\b/i;
const CURRENT_DROP_PATTERN =
  /\b(?:current|live)\s+drop\b|\bnow\s+minting\b|\bminting\s+now\b/i;
const MINT_NUMBER_PREFIXES = new Set(['meme', 'card', 'drop', 'mint']);
const MINT_NUMBER_FILLER_TOKENS = new Set([
  'id',
  'no',
  'num',
  'number',
  'numbered',
  'with'
]);

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function tokenizeQuestion(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  const pushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = '';
    }
  };

  for (const char of text.toLowerCase()) {
    const isLowercaseLetter = char >= 'a' && char <= 'z';
    const isDigit = char >= '0' && char <= '9';
    if (char === '#') {
      pushCurrent();
      current = '#';
      continue;
    }
    if (isLowercaseLetter || isDigit) {
      current += char;
      continue;
    }
    pushCurrent();
  }
  pushCurrent();

  return tokens;
}

function parsePositiveIntegerToken(token: string): number | null {
  const raw = token.startsWith('#') ? token.slice(1) : token;
  if (!raw || raw.startsWith('0')) {
    return null;
  }
  for (const char of raw) {
    if (char < '0' || char > '9') {
      return null;
    }
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function readHashMintNumber(tokens: ReadonlyArray<string>): number | null {
  for (const token of tokens) {
    if (!token.startsWith('#')) {
      continue;
    }
    const parsedHashToken = parsePositiveIntegerToken(token);
    if (parsedHashToken !== null) {
      return parsedHashToken;
    }
  }
  return null;
}

function readMintNumberAfterPrefix(
  tokens: ReadonlyArray<string>,
  prefixIndex: number
): number | null {
  const end = Math.min(tokens.length, prefixIndex + 4);
  for (let tokenIndex = prefixIndex + 1; tokenIndex < end; tokenIndex++) {
    const parsedToken = parsePositiveIntegerToken(tokens[tokenIndex]);
    if (parsedToken !== null) {
      return parsedToken;
    }
    if (!MINT_NUMBER_FILLER_TOKENS.has(tokens[tokenIndex])) {
      return null;
    }
  }
  return null;
}

function readPrefixedMintNumber(tokens: ReadonlyArray<string>): number | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!MINT_NUMBER_PREFIXES.has(tokens[i])) {
      continue;
    }
    const parsedMintNumber = readMintNumberAfterPrefix(tokens, i);
    if (parsedMintNumber !== null) {
      return parsedMintNumber;
    }
  }
  return null;
}

function readMintNumber(question: string): number | null {
  const tokens = tokenizeQuestion(question);
  return readHashMintNumber(tokens) ?? readPrefixedMintNumber(tokens);
}

function hasCalendarContext(value: string): boolean {
  return CALENDAR_CONTEXT_PATTERNS.some((pattern) => pattern.test(value));
}

export function isCalendarTimingQuestion(
  question: string,
  previousBotAnswer?: string | null
): boolean {
  const text = normalizeText(question);
  const contextText = `${text}\n${normalizeText(previousBotAnswer)}`;
  const hasTimeIntent = CALENDAR_TIME_PATTERN.test(text);
  const hasCurrentIntent = CURRENT_DROP_PATTERN.test(text);
  if (!hasTimeIntent && !hasCurrentIntent && readMintNumber(text) === null) {
    return false;
  }
  return (
    hasCalendarContext(contextText) ||
    NEXT_DROP_PATTERN.test(text) ||
    hasCurrentIntent
  );
}

function resolveCalendarEndpoint(
  request: HelpBotCalendarAnswerRequest
): CalendarEndpoint | null {
  if (!isCalendarTimingQuestion(request.question, request.previousBotAnswer)) {
    return null;
  }
  const mintNumber = readMintNumber(request.question);
  if (mintNumber !== null) {
    return { kind: 'mint', mintNumber };
  }
  if (CURRENT_DROP_PATTERN.test(request.question)) {
    return { kind: 'current' };
  }
  return { kind: 'next' };
}

function formatUtcTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end--;
  }
  return value.slice(0, end);
}

function calendarUrl(baseUrl: string): string {
  return `${trimTrailingSlashes(baseUrl)}/meme-calendar`;
}

function absoluteSiteUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimTrailingSlashes(baseUrl)}${normalizedPath}`;
}

function withLinks(
  text: string,
  links: ReadonlyArray<{ readonly label: string; readonly url: string }>
): string {
  const renderedLinks = links.map((link) =>
    formatHelpBotMarkdownLink({ label: link.label, url: link.url })
  );
  return `${text}\n\nLinks: ${renderedLinks.join(' | ')}`;
}

function withMintAndCalendarLinks(
  text: string,
  mint: CalendarMint,
  baseUrl: string
): string {
  return withLinks(text, [
    {
      label: `Meme #${mint.mintNumber}`,
      url: absoluteSiteUrl(baseUrl, `/the-memes/${mint.mintNumber}`)
    },
    { label: CALENDAR_LINK_LABEL, url: calendarUrl(baseUrl) }
  ]);
}

function divisionText(mint: CalendarMint): string {
  return `SZN ${mint.seasonNumber}, Year ${mint.yearNumber}`;
}

function mintOpenCloseText(
  mint: CalendarMint,
  openVerb: 'opens' | 'opened',
  closeVerb: 'closes' | 'closed'
): string {
  return `${openVerb} ${formatUtcTimestamp(
    mint.instantUtc.toISOString()
  )} and ${closeVerb} ${formatUtcTimestamp(mint.mintEndUtc.toISOString())}`;
}

function buildMintAnswer(
  mint: CalendarMint,
  baseUrl: string,
  now: Date
): string {
  const status = getMintTimelineStatus(mint, now);
  const window = mintOpenCloseText(mint, 'opens', 'closes');
  const division = divisionText(mint);
  if (status === 'live') {
    return withMintAndCalendarLinks(
      `Meme Card #${mint.mintNumber} is minting now. It ${mintOpenCloseText(
        mint,
        'opened',
        'closes'
      )}. It is in ${division}.`,
      mint,
      baseUrl
    );
  }
  if (status === 'past') {
    return withMintAndCalendarLinks(
      `Meme Card #${mint.mintNumber} minted on ${mint.instantUtc.toISOString().slice(0, 10)}. It ${mintOpenCloseText(
        mint,
        'opened',
        'closed'
      )}. It is in ${division}.`,
      mint,
      baseUrl
    );
  }
  return withMintAndCalendarLinks(
    `Meme Card #${mint.mintNumber} ${window}. It is in ${division}.`,
    mint,
    baseUrl
  );
}

function buildNextAnswer(mint: CalendarMint, baseUrl: string): string {
  return withMintAndCalendarLinks(
    `The next Meme Card drop is Meme #${mint.mintNumber}. It ${mintOpenCloseText(
      mint,
      'opens',
      'closes'
    )}. It is in ${divisionText(mint)}.`,
    mint,
    baseUrl
  );
}

function buildCurrentAnswer(now: Date, baseUrl: string): string {
  const current = getCurrentMintTimelineDetails(now);
  if (current) return buildMintAnswer(current, baseUrl, now);
  const next = getNextMintTimelineDetails(now);
  return withMintAndCalendarLinks(
    `Nothing is minting right now. The next Meme Card drop is Meme #${next.mintNumber}, which ${mintOpenCloseText(next, 'opens', 'closes')}.`,
    next,
    baseUrl
  );
}

export class HelpBotCalendarService {
  constructor(private readonly now: () => Date = () => new Date()) {}

  public async answer(
    request: HelpBotCalendarAnswerRequest
  ): Promise<HelpBotCalendarAnswer | null> {
    const endpoint = resolveCalendarEndpoint(request);
    if (!endpoint) return null;
    const now = this.now();
    if (endpoint.kind === 'current') {
      return {
        answer: buildCurrentAnswer(now, request.baseUrl),
        queryId: 'meme_calendar.current'
      };
    }
    const mint =
      endpoint.kind === 'next'
        ? getNextMintTimelineDetails(now)
        : getMintTimelineDetails(endpoint.mintNumber);
    return {
      answer:
        endpoint.kind === 'next'
          ? buildNextAnswer(mint, request.baseUrl)
          : buildMintAnswer(mint, request.baseUrl, now),
      queryId:
        endpoint.kind === 'next'
          ? 'meme_calendar.next'
          : `meme_calendar.mint.${endpoint.mintNumber}`
    };
  }
}
