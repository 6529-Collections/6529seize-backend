import { getBedrockClient } from '@/bedrock';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput
} from '@aws-sdk/client-bedrock-runtime';
import { TextDecoder } from 'node:util';
import { HelpBotLlmRenderer } from './help-bot.answerer';
import { HelpBotKnowledgeRecord } from './help-bot.knowledge';

interface AnthropicTextBlock {
  readonly type?: string;
  readonly text?: string;
}

interface AnthropicResponse {
  readonly content?: AnthropicTextBlock[];
}

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
    'You are @6529help, a concise helper bot for 6529.io.',
    'Answer only from the provided facts.',
    'Do not invent details.',
    'Use one or two short paragraphs.',
    `Include this URL exactly once: ${canonicalUrl}`,
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

function buildInvokeModelInput(
  modelId: string,
  prompt: string
): InvokeModelCommandInput {
  return {
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 220,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }]
        }
      ],
      temperature: 0.7,
      top_p: 0.8,
      top_k: 30
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

export class HelpBotBedrockRenderer implements HelpBotLlmRenderer {
  constructor(
    private readonly modelId: string,
    private readonly getBedrock: () => BedrockRuntimeClient = getBedrockClient
  ) {}

  public async renderAnswer(input: {
    readonly question: string;
    readonly previousBotAnswer?: string | null;
    readonly record: HelpBotKnowledgeRecord;
    readonly canonicalUrl: string;
  }): Promise<string> {
    const response = await this.getBedrock().send(
      new InvokeModelCommand(
        buildInvokeModelInput(this.modelId, buildPrompt(input))
      )
    );
    if (!response.body) {
      throw new Error('Unexpected empty response body from Bedrock');
    }
    return parseAnthropicResponse(new TextDecoder().decode(response.body));
  }
}
