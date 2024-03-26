import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

let bedrock: BedrockRuntimeClient;

export function getBedrockClient(): BedrockRuntimeClient {
  if (!bedrock) {
    bedrock = new BedrockRuntimeClient({
      region: process.env.BEDROCK_AWS_REGION ?? 'us-east-1'
    });
  }
  return bedrock;
}
