export interface AiPrompter {
  promptAndGetReply(prompt: string): Promise<string>;
}
