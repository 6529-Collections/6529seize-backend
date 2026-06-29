import { AiPrompter } from './ai-prompter';
import { getBedrockClient } from '@/bedrock';
import { getConfiguredBedrockAnthropicModelId } from '@/bedrock.config';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput
} from '@aws-sdk/client-bedrock-runtime';
import { TextDecoder } from 'node:util';

export const ABUSIVENESS_BEDROCK_MODEL_ID_ENV = 'ABUSIVENESS_BEDROCK_MODEL_ID';

const MODEL_ID = getConfiguredBedrockAnthropicModelId(
  ABUSIVENESS_BEDROCK_MODEL_ID_ENV
);

function buildOpts(modelId: string, prompt: string): InvokeModelCommandInput {
  return {
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `${prompt}` }] }
      ],
      temperature: 0.7,
      top_p: 0.8,
      top_k: 30
    })
  };
}

class BedrockAiPrompter implements AiPrompter {
  constructor(private readonly getBedrock: () => BedrockRuntimeClient) {}

  public async promptAndGetReply(prompt: string): Promise<string> {
    const response = await this.getBedrock().send(
      new InvokeModelCommand(buildOpts(MODEL_ID, prompt))
    );
    const rawRes = response.body;

    const jsonString = new TextDecoder().decode(rawRes);

    try {
      const parsedResponse = JSON.parse(jsonString) as {
        readonly content?: ReadonlyArray<{ readonly text?: unknown }>;
      };
      const output = parsedResponse.content?.[0]?.text;
      if (typeof output !== 'string') {
        throw new TypeError('Missing text content');
      }
      return output;
    } catch (e) {
      throw new Error(`Unexpected response from Bedrock: ${jsonString}`);
    }
  }
}

export const bedrockAiPrompter = new BedrockAiPrompter(getBedrockClient);
