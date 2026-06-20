import { getBedrockClient } from '@/bedrock';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput
} from '@aws-sdk/client-bedrock-runtime';
import { TextDecoder } from 'node:util';
import { HelpBotLlmRenderer } from './help-bot.answerer';
import {
  HELP_BOT_BEDROCK_TIMEOUT_MS,
  HELP_BOT_HANDLE
} from './help-bot.config';
import { HelpBotKnowledgeRecord } from './help-bot.knowledge';
import { HelpBotPublicDataQueryPlan } from './help-bot-public-data.service';

interface AnthropicTextBlock {
  readonly type?: string;
  readonly text?: string;
}

interface AnthropicResponse {
  readonly content?: AnthropicTextBlock[];
}

const TONE_GUIDANCE =
  'Mirror the user tone lightly: if the question is casual or playful, you may be a little warmer or more playful; if it is formal, stay formal. Keep it useful, accurate, and not overfamiliar.';
const HELP_BOT_MENTION = `@${HELP_BOT_HANDLE}`;
const NO_SELF_INTRO_GUIDANCE = `Start directly with the answer. Do not begin with ${HELP_BOT_MENTION}, ${HELP_BOT_HANDLE}:, ${HELP_BOT_HANDLE} here, a greeting, or any self-introduction.`;
const MARKDOWN_LINK_GUIDANCE =
  'When including the source URL, use a named Markdown link like [More info](https://example.com). Do not print a bare URL.';

function buildPrompt({
  question,
  previousBotAnswer,
  record,
  canonicalUrl
}: {
  readonly question: string;
  readonly previousBotAnswer?: string | null;
  readonly record: HelpBotKnowledgeRecord;
  readonly canonicalUrl: string;
}): string {
  const factLines = record.facts.map((fact) => `- ${fact}`).join('\n');
  return [
    `You are ${HELP_BOT_MENTION}, a concise helper bot for 6529.io.`,
    'Answer only from the provided facts.',
    'Do not invent details.',
    'Use one or two short paragraphs.',
    TONE_GUIDANCE,
    NO_SELF_INTRO_GUIDANCE,
    MARKDOWN_LINK_GUIDANCE,
    `Include this URL exactly once as a Markdown link target: ${canonicalUrl}`,
    `Use this exact Markdown link label for that URL: ${record.linkLabel}`,
    previousBotAnswer
      ? `Previous bot answer for context:\n${previousBotAnswer}`
      : '',
    `User question:\n${question}`,
    `Topic: ${record.title}`,
    `Facts:\n${factLines}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildPublicDataPlanningPrompt({
  question,
  previousBotAnswer,
  catalog
}: {
  readonly question: string;
  readonly previousBotAnswer?: string | null;
  readonly catalog: string;
}): string {
  return [
    `You are ${HELP_BOT_MENTION} public data planner for 6529.io.`,
    'Return strict JSON only. Do not wrap in Markdown.',
    'If the question is not answerable from the catalog, return {"entity":null}.',
    'Choose one entity, operation, metric, and filter set from the catalog.',
    'Return numeric filter and limit values only.',
    'Do not return SQL, table names, column names, joins, or expressions.',
    'Return this JSON shape:',
    '{"entity":"meme_cards","operation":"count","metric":null,"filters":{"season":1},"limit":1}',
    previousBotAnswer
      ? `Previous bot answer for context:\n${previousBotAnswer}`
      : '',
    `User question:\n${question}`,
    catalog
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildPublicDataAnswerPrompt({
  question,
  title,
  rows,
  canonicalUrl
}: {
  readonly question: string;
  readonly title: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly canonicalUrl: string;
}): string {
  return [
    `You are ${HELP_BOT_MENTION}, a concise helper bot for 6529.io.`,
    'Answer only from the public database result rows.',
    'Do not invent data.',
    'Use one or two short paragraphs.',
    TONE_GUIDANCE,
    NO_SELF_INTRO_GUIDANCE,
    MARKDOWN_LINK_GUIDANCE,
    `Include this URL exactly once as a Markdown link target: ${canonicalUrl}`,
    `Use this exact Markdown link label for that URL: ${title}`,
    `User question:\n${question}`,
    `Answer title:\n${title}`,
    `Public database result rows:\n${JSON.stringify(rows).slice(0, 4000)}`
  ].join('\n\n');
}

function buildInvokeModelInput(
  modelId: string,
  prompt: string,
  maxTokens: number
): InvokeModelCommandInput {
  return {
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }]
        }
      ],
      temperature: 0.2,
      top_p: 0.5,
      top_k: 20
    })
  };
}

function parseAnthropicResponse(jsonString: string): string {
  const parsed = JSON.parse(jsonString) as AnthropicResponse;
  const text = parsed.content
    ?.map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('')
    .trim();
  if (!text) {
    throw new Error(`Unexpected empty response from Bedrock: ${jsonString}`);
  }
  return text;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected JSON object from Bedrock: ${text}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePublicDataQueryPlan(
  text: string
): HelpBotPublicDataQueryPlan | null {
  const parsed = parseJsonObject(text);
  const entity = readString(parsed.entity);
  if (!entity) {
    return null;
  }
  return {
    entity,
    operation: readString(parsed.operation),
    metric: readString(parsed.metric),
    filters: parsed.filters,
    limit: parsed.limit
  };
}

export class HelpBotBedrockRenderer implements HelpBotLlmRenderer {
  constructor(
    private readonly modelId: string,
    private readonly getBedrock: () => BedrockRuntimeClient = getBedrockClient,
    private readonly timeoutMs: number = HELP_BOT_BEDROCK_TIMEOUT_MS
  ) {}

  public async renderAnswer(input: {
    readonly question: string;
    readonly previousBotAnswer?: string | null;
    readonly record: HelpBotKnowledgeRecord;
    readonly canonicalUrl: string;
  }): Promise<string> {
    return this.invokePrompt(buildPrompt(input), 220);
  }

  public async planPublicDataQuery(input: {
    readonly question: string;
    readonly previousBotAnswer?: string | null;
    readonly catalog: string;
  }): Promise<HelpBotPublicDataQueryPlan | null> {
    return parsePublicDataQueryPlan(
      await this.invokePrompt(buildPublicDataPlanningPrompt(input), 320)
    );
  }

  public async renderPublicDataAnswer(input: {
    readonly question: string;
    readonly title: string;
    readonly rows: readonly Record<string, unknown>[];
    readonly canonicalUrl: string;
  }): Promise<string> {
    return this.invokePrompt(buildPublicDataAnswerPrompt(input), 220);
  }

  private async invokePrompt(
    prompt: string,
    maxTokens: number
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const command = new InvokeModelCommand(
      buildInvokeModelInput(this.modelId, prompt, maxTokens)
    );
    try {
      const response = await this.getBedrock().send(command, {
        abortSignal: controller.signal
      });
      if (!response.body) {
        throw new Error('Unexpected empty response body from Bedrock');
      }
      return parseAnthropicResponse(new TextDecoder().decode(response.body));
    } finally {
      clearTimeout(timeout);
    }
  }
}
