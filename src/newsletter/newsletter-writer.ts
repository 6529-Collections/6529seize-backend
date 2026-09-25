import {
  BedrockRuntimeClient,
  ConverseCommand
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Logger } from '@/logging';
import { NewsletterMaterial, NewsletterSource } from './newsletter-collector';
import {
  NEWSLETTER_PROMPT,
  NEWSLETTER_RESEARCH_PROMPT
} from './newsletter-prompt';

const FINAL_INPUT_BYTES = 800_000;
const RESEARCH_BATCH_BYTES = 400_000;
const MAX_RESEARCH_BATCHES = 24;
const logger = Logger.get('NEWSLETTER_WRITER');

export function sourceBatches(
  sources: NewsletterSource[]
): NewsletterSource[][] {
  const batches: NewsletterSource[][] = [];
  let current: NewsletterSource[] = [];
  let size = 2;
  for (const source of sources) {
    const bytes = Buffer.byteLength(JSON.stringify(source), 'utf8') + 1;
    if (bytes > RESEARCH_BATCH_BYTES)
      throw new Error('Newsletter source exceeds model batch budget');
    if (current.length && size + bytes > RESEARCH_BATCH_BYTES) {
      batches.push(current);
      current = [];
      size = 2;
    }
    current.push(source);
    size += bytes;
  }
  if (current.length) batches.push(current);
  if (batches.length > MAX_RESEARCH_BATCHES) {
    throw new Error(
      'Newsletter source volume exceeds one Lambda run; refusing incomplete coverage'
    );
  }
  return batches;
}

export class NewsletterWriter {
  constructor(
    private readonly modelId: string,
    private readonly client = new BedrockRuntimeClient({
      region: process.env.BEDROCK_AWS_REGION ?? 'us-east-1',
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5_000,
        socketTimeout: 240_000
      })
    })
  ) {}

  async write(material: NewsletterMaterial): Promise<string> {
    // Bound the whole editorial pipeline, leaving time for API login/publication
    // and cleanup inside the Lambda's 15-minute execution limit.
    const deadline = Date.now() + 600_000;
    let input = JSON.stringify(material);
    if (Buffer.byteLength(input, 'utf8') > FINAL_INPUT_BYTES) {
      const batches = sourceBatches(material.sources);
      const briefs: string[] = [];
      for (let i = 0; i < batches.length; i += 3) {
        briefs.push(
          ...(await Promise.all(
            batches
              .slice(i, i + 3)
              .map((sources) =>
                this.complete(
                  NEWSLETTER_RESEARCH_PROMPT,
                  JSON.stringify({ window: material.window, sources }),
                  12_000,
                  deadline
                )
              )
          ))
        );
      }
      input = JSON.stringify({
        ...material,
        sources: undefined,
        editorial_briefs: briefs
      });
    }
    if (Buffer.byteLength(input, 'utf8') > FINAL_INPUT_BYTES) {
      throw new Error(
        'Newsletter editorial material exceeds final model budget'
      );
    }
    return this.complete(NEWSLETTER_PROMPT, input, 16_000, deadline);
  }

  private async complete(
    system: string,
    input: string,
    maxTokens: number,
    deadline: number
  ): Promise<string> {
    const remaining = Math.min(240_000, deadline - Date.now());
    if (remaining <= 0)
      throw new Error('Newsletter editorial time budget exhausted');
    const result = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: system }],
        messages: [{ role: 'user', content: [{ text: input }] }],
        inferenceConfig: { maxTokens }
      }),
      { abortSignal: AbortSignal.timeout(remaining) }
    );
    logger.info('Newsletter model usage', {
      modelId: this.modelId,
      usage: result.usage,
      stopReason: result.stopReason
    });
    if (result.stopReason !== 'end_turn') {
      throw new Error(
        `Newsletter model did not finish: ${result.stopReason ?? 'unknown'}`
      );
    }
    const text = result.output?.message?.content
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('Newsletter model returned an empty edition');
    return text;
  }
}
