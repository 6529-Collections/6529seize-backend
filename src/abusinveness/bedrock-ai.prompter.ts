import { AiPrompter } from './ai-prompter';
import { getBedrockClient } from '../bedrock';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput
} from '@aws-sdk/client-bedrock-runtime';

const MODEL = 'claude';
const buildOpts: (modelId: string, prompt: string) => any = (
  modelId: string,
  prompt: string
) => {
  if (modelId === 'claude') {
    return {
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
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
  } else if (modelId === 'mixtral') {
    return {
      modelId: 'mistral.mixtral-8x7b-instruct-v0:1',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        prompt: `<s>[INST] ${prompt} [/INST]`,
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.8,
        top_k: 30
      })
    };
  }
};

declare let TextDecoder: any;

class BedrockAiPrompter implements AiPrompter {
  constructor(private readonly getBedrock: () => BedrockRuntimeClient) {}

  public async promptAndGetReply(prompt: string): Promise<string> {
    const opts = buildOpts(MODEL, prompt);
    const input: InvokeModelCommandInput = opts;
    const response = await this.getBedrock().send(
      new InvokeModelCommand(input)
    );
    const rawRes = response.body;

    const jsonString = new TextDecoder().decode(rawRes);

    const parsedResponse = JSON.parse(jsonString);
    try {
      const output = MODEL === 'claude' ? JSON.parse(parsedResponse.content[0].text) : parsedResponse.outputs[0].text;
      return output ?? '';
    } catch (e) {
      throw new Error(`Unexpexted response from Bedrock: ${jsonString}`);
    }
  }
}

export const bedrockAiPrompter = new BedrockAiPrompter(getBedrockClient);
