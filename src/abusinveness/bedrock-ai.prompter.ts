import { AiPrompter } from './ai-prompter';
import { getBedrockClient } from '../bedrock';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput
} from '@aws-sdk/client-bedrock-runtime';

const LLM = {
  'claudeId': 'anthropic.claude-3-sonnet-20240229-v1:0',
  'mixtralId': 'mistral.mixtral-8x7b-instruct-v0:1',
}

declare let TextDecoder: any;

class BedrockAiPrompter implements AiPrompter {
  constructor(private readonly getBedrock: () => BedrockRuntimeClient) {}

  public async promptAndGetReply(prompt: string): Promise<string> {
    const input: InvokeModelCommandInput = {
      modelId: LLM.claudeId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        prompt: `{"messages":[{"role":"user","content":[{"type": "text", "text": "${prompt}"}]}]}`,
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.8,
        top_k: 30
      })
    };
    const response = await this.getBedrock().send(
      new InvokeModelCommand(input)
    );
    const rawRes = response.body;

    const jsonString = new TextDecoder().decode(rawRes);

    const parsedResponse = JSON.parse(jsonString);
    try {
      return parsedResponse.outputs[0].text ?? '';
    } catch (e) {
      throw new Error(`Unexpexted response from Bedrock: ${jsonString}`);
    }
  }
}

export const bedrockAiPrompter = new BedrockAiPrompter(getBedrockClient);
