import { isAddress, Wallet } from 'ethers';

export const MAIN_STAGE_WAVE_ID = 'b6128077-ea78-4dd9-b381-52c4eadb2077';
export const TEAM_WAVE_IDS = [
  'e933d8d6-0c78-4e8f-aa12-f67d8c11b4dc',
  'bf945b75-2912-4ce6-b1f5-95b5b667b7c9',
  '05b14183-e153-4e47-bc66-42a0f49102d4',
  'da16201a-f4d0-40cf-b888-9f3a4a86a894'
];

export interface NewsletterConfig {
  readonly waveId: string;
  readonly wallet: Wallet;
  readonly modelId: string;
}

export function readNewsletterConfig(
  environment: NodeJS.ProcessEnv = process.env
): NewsletterConfig | null {
  const waveId = environment.NEWSLETTER_TARGET_WAVE_ID?.trim();
  const address = environment.NEWSLETTER_PUBLISHER_WALLET?.trim();
  const privateKey = environment.NEWSLETTER_PUBLISHER_PRIVATE_KEY?.trim();
  // Check all three before validating any value: incomplete setup is a no-op.
  if (!waveId || !address || !privateKey) return null;
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      waveId
    ) ||
    !isAddress(address)
  ) {
    throw new Error('Invalid newsletter target wave or publisher wallet');
  }
  let wallet: Wallet;
  try {
    wallet = new Wallet(privateKey);
  } catch {
    // Ethers errors can include the supplied key. Never propagate that error.
    throw new Error('Invalid newsletter publisher private key');
  }
  if (wallet.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(
      'Newsletter publisher wallet does not match its private key'
    );
  }
  return {
    waveId,
    wallet,
    modelId:
      environment.NEWSLETTER_BEDROCK_MODEL_ID?.trim() ||
      'global.openai.gpt-6-astra'
  };
}

export interface NewsletterWindow {
  readonly start: number;
  readonly end: number;
  readonly scheduled: boolean;
}

export function newsletterWindow(
  event: unknown,
  now = Date.now()
): NewsletterWindow {
  const payload = event as Record<string, unknown> | null;
  const scheduled =
    payload?.source === 'aws.events' &&
    payload['detail-type'] === 'Scheduled Event';
  let end = now;
  if (scheduled) {
    if (typeof payload?.time !== 'string') {
      throw new Error('Scheduled newsletter is missing its event timestamp');
    }
    const time = Date.parse(payload.time);
    if (!Number.isFinite(time)) {
      throw new Error('Scheduled newsletter has an invalid event timestamp');
    }
    // Use the original event time, so delayed delivery/retries cover the same day.
    const date = new Date(time);
    end = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate()
    );
  }
  return { start: end - 24 * 60 * 60 * 1000, end, scheduled };
}
