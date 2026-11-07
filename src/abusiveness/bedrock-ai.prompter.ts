import { AiPrompter } from './ai-prompter';
import { getBedrockClient } from '@/bedrock';
import {
  buildBedrockAnthropicBody,
  parseBedrockAnthropicReply
} from '@/bedrock-anthropic';
import {
  DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID,
  getConfiguredBedrockAnthropicModelId
} from '@/bedrock.config';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput
} from '@aws-sdk/client-bedrock-runtime';

export const ABUSIVENESS_BEDROCK_MODEL_ID_ENV = 'ABUSIVENESS_BEDROCK_MODEL_ID';
export const DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID =
  DEFAULT_CLAUDE_SONNET_4_5_BEDROCK_MODEL_ID;

const ABUSIVENESS_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: {
    value: { type: 'string', enum: ['Allowed', 'Disallowed'] },
    self_dox: { type: 'string', enum: ['Yes', 'No'] },
    reason: { type: 'string' }
  }
};

export function getAbusivenessBedrockModelId(): string {
  return getConfiguredBedrockAnthropicModelId(
    ABUSIVENESS_BEDROCK_MODEL_ID_ENV,
    DEFAULT_ABUSIVENESS_BEDROCK_MODEL_ID
  );
}

export function buildAbusivenessBedrockInvokeModelInput(
  modelId: string,
  prompt: string
): InvokeModelCommandInput {
  return {
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: buildBedrockAnthropicBody({
      modelId,
      prompt,
      maxTokens: 1000,
      effort: 'low',
      jsonSchema: ABUSIVENESS_RESPONSE_SCHEMA,
      legacySampling: { temperature: 0.7, top_k: 30 }
    })
  };
}

class BedrockAiPrompter implements AiPrompter {
  constructor(private readonly getBedrock: () => BedrockRuntimeClient) {}

  public async promptAndGetReply(prompt: string): Promise<string> {
    const response = await this.getBedrock().send(
      new InvokeModelCommand(
        buildAbusivenessBedrockInvokeModelInput(
          getAbusivenessBedrockModelId(),
          prompt
        )
      )
    );
    const reply = parseBedrockAnthropicReply(response.body);
    if (reply.stopReason === 'max_tokens') {
      throw new Error('Abusiveness classifier response was truncated');
    }
    if (!reply.text) {
      throw new Error(`Unexpected response from Bedrock: ${reply.raw}`);
    }
    return reply.text;
  }
}

export const bedrockAiPrompter = new BedrockAiPrompter(getBedrockClient);
