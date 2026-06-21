import { HELP_BOT_CALENDAR_FETCH_TIMEOUT_MS } from './help-bot.config';
import {
  ensureCanonicalMarkdownLink,
  formatHelpBotMarkdownLink
} from './help-bot-response-text';

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

interface MemeCalendarMintResponse {
  readonly mint_number: number;
  readonly mint_date: string;
  readonly mint_start: string;
  readonly mint_end: string;
  readonly status: 'past' | 'live' | 'upcoming';
  readonly season: number;
  readonly year: number;
  readonly epoch: number;
  readonly period: number;
  readonly era: number;
  readonly eon: number;
  readonly calendar_path: string;
  readonly mint_path: string;
}

interface MemeCalendarCurrentResponse {
  readonly status: 'live' | 'none';
  readonly current: MemeCalendarMintResponse | null;
  readonly next?: MemeCalendarMintResponse;
}

const CALENDAR_LINK_LABEL = 'Memes Calendar';

const CALENDAR_TIME_PATTERN =
  /\b(?:when|what\s+(?:time|date|day)|schedule|calendar|next|current|upcoming|live|past|minting\s+window|mint\s+window)\b/i;
const CALENDAR_CONTEXT_PATTERN =
  /\b(?:meme(?:s)?|meme\s+card(?:s)?|card(?:s)?|mint(?:ing)?|calendar|drop(?:s|ped|ping)?)\b/i;
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

function readMintNumber(question: string): number | null {
  const tokens = tokenizeQuestion(question);
  for (const token of tokens) {
    if (token.startsWith('#')) {
      const parsedHashToken = parsePositiveIntegerToken(token);
      if (parsedHashToken !== null) {
        return parsedHashToken;
      }
    }
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!MINT_NUMBER_PREFIXES.has(tokens[i])) {
      continue;
    }
    for (let j = i + 1; j < Math.min(tokens.length, i + 4); j++) {
      const parsedToken = parsePositiveIntegerToken(tokens[j]);
      if (parsedToken !== null) {
        return parsedToken;
      }
      if (!MINT_NUMBER_FILLER_TOKENS.has(tokens[j])) {
        break;
      }
    }
  }
  return null;
}

function isCalendarTimingQuestion(
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
    CALENDAR_CONTEXT_PATTERN.test(contextText) ||
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

function buildUrl(baseUrl: string, endpoint: CalendarEndpoint): string {
  const root = trimTrailingSlashes(baseUrl);
  if (endpoint.kind === 'mint') {
    return `${root}/api/meme-calendar/${endpoint.mintNumber}`;
  }
  return `${root}/api/meme-calendar/${endpoint.kind}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readMintStatus(
  value: unknown
): MemeCalendarMintResponse['status'] | null {
  return value === 'past' || value === 'live' || value === 'upcoming'
    ? value
    : null;
}

function parseMintResponse(value: unknown): MemeCalendarMintResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  const mintNumber = readNumber(value.mint_number);
  const mintDate = readString(value.mint_date);
  const mintStart = readString(value.mint_start);
  const mintEnd = readString(value.mint_end);
  const status = readMintStatus(value.status);
  const season = readNumber(value.season);
  const year = readNumber(value.year);
  const epoch = readNumber(value.epoch);
  const period = readNumber(value.period);
  const era = readNumber(value.era);
  const eon = readNumber(value.eon);
  const calendarPath = readString(value.calendar_path);
  const mintPath = readString(value.mint_path);
  if (
    mintNumber === null ||
    !mintDate ||
    !mintStart ||
    !mintEnd ||
    !status ||
    season === null ||
    year === null ||
    epoch === null ||
    period === null ||
    era === null ||
    eon === null ||
    !calendarPath ||
    !mintPath
  ) {
    return null;
  }
  return {
    mint_number: mintNumber,
    mint_date: mintDate,
    mint_start: mintStart,
    mint_end: mintEnd,
    status,
    season,
    year,
    epoch,
    period,
    era,
    eon,
    calendar_path: calendarPath,
    mint_path: mintPath
  };
}

function parseCurrentResponse(
  value: unknown
): MemeCalendarCurrentResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.status === 'live') {
    const current = parseMintResponse(value.current);
    return current ? { status: 'live', current } : null;
  }
  if (value.status === 'none') {
    const next = parseMintResponse(value.next);
    return next ? { status: 'none', current: null, next } : null;
  }
  return null;
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

function withCalendarLink(text: string, baseUrl: string): string {
  return ensureCanonicalMarkdownLink({
    text,
    canonicalUrl: calendarUrl(baseUrl),
    label: CALENDAR_LINK_LABEL
  });
}

function withMintAndCalendarLinks(
  text: string,
  mint: MemeCalendarMintResponse,
  baseUrl: string
): string {
  return withLinks(text, [
    {
      label: `Meme #${mint.mint_number}`,
      url: absoluteSiteUrl(baseUrl, mint.mint_path)
    },
    { label: CALENDAR_LINK_LABEL, url: calendarUrl(baseUrl) }
  ]);
}

function divisionText(mint: MemeCalendarMintResponse): string {
  return `SZN ${mint.season}, Year ${mint.year}`;
}

function mintOpenCloseText(
  mint: MemeCalendarMintResponse,
  openVerb: 'opens' | 'opened',
  closeVerb: 'closes' | 'closed'
): string {
  return `${openVerb} ${formatUtcTimestamp(
    mint.mint_start
  )} and ${closeVerb} ${formatUtcTimestamp(mint.mint_end)}`;
}

function buildMintAnswer(
  mint: MemeCalendarMintResponse,
  baseUrl: string
): string {
  const window = mintOpenCloseText(mint, 'opens', 'closes');
  const division = divisionText(mint);
  if (mint.status === 'live') {
    return withMintAndCalendarLinks(
      `Meme Card #${mint.mint_number} is minting now. It ${mintOpenCloseText(
        mint,
        'opened',
        'closes'
      )}. It is in ${division}.`,
      mint,
      baseUrl
    );
  }
  if (mint.status === 'past') {
    return withMintAndCalendarLinks(
      `Meme Card #${mint.mint_number} minted on ${mint.mint_date}. It ${mintOpenCloseText(
        mint,
        'opened',
        'closed'
      )}. It is in ${division}.`,
      mint,
      baseUrl
    );
  }
  return withMintAndCalendarLinks(
    `Meme Card #${mint.mint_number} ${window}. It is in ${division}.`,
    mint,
    baseUrl
  );
}

function buildNextAnswer(
  mint: MemeCalendarMintResponse,
  baseUrl: string
): string {
  return withMintAndCalendarLinks(
    `The next Meme Card drop is Meme #${mint.mint_number}. It ${mintOpenCloseText(
      mint,
      'opens',
      'closes'
    )}. It is in ${divisionText(mint)}.`,
    mint,
    baseUrl
  );
}

function buildCurrentAnswer(
  response: MemeCalendarCurrentResponse,
  baseUrl: string
): string {
  if (response.status === 'live' && response.current) {
    return buildMintAnswer(response.current, baseUrl);
  }
  const next = response.next;
  if (!next) {
    return withCalendarLink('Nothing is minting right now.', baseUrl);
  }
  return withMintAndCalendarLinks(
    `Nothing is minting right now. The next Meme Card drop is Meme #${
      next.mint_number
    }, which ${mintOpenCloseText(next, 'opens', 'closes')}.`,
    next,
    baseUrl
  );
}

async function fetchJsonWithTimeout(
  url: string,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    HELP_BOT_CALENDAR_FETCH_TIMEOUT_MS
  );
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Help bot calendar fetch failed: ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export class HelpBotCalendarService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  public async answer(
    request: HelpBotCalendarAnswerRequest
  ): Promise<HelpBotCalendarAnswer | null> {
    const endpoint = resolveCalendarEndpoint(request);
    if (!endpoint) {
      return null;
    }
    const raw = await fetchJsonWithTimeout(
      buildUrl(request.baseUrl, endpoint),
      this.fetchImpl
    );

    if (endpoint.kind === 'current') {
      const current = parseCurrentResponse(raw);
      if (!current) {
        throw new Error('Invalid Help6529 calendar current response');
      }
      return {
        answer: buildCurrentAnswer(current, request.baseUrl),
        queryId: 'meme_calendar.current'
      };
    }

    const mint = parseMintResponse(raw);
    if (!mint) {
      throw new Error('Invalid Help6529 calendar mint response');
    }
    return {
      answer:
        endpoint.kind === 'next'
          ? buildNextAnswer(mint, request.baseUrl)
          : buildMintAnswer(mint, request.baseUrl),
      queryId:
        endpoint.kind === 'next'
          ? 'meme_calendar.next'
          : `meme_calendar.mint.${endpoint.mintNumber}`
    };
  }
}
