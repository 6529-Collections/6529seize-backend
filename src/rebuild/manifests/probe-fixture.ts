import { MEMES_CONTRACT } from '@/constants';
import { ProbeCaller } from '@/rebuild/manifest.types';

/**
 * The values the probes ask about. A manifest's seed writes rows for them
 * (through the code's own write path, not straight into its INDEX tables);
 * until it does, those probes answer with no data and the report lists them
 * as unproven. Fake wallets only.
 */
export const PROBE_WALLETS = [
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002'
];

/** A one-wallet consolidation's key is its wallet. */
export const PROBE_CONSOLIDATION_KEYS = PROBE_WALLETS;

/** The signed-in caller of the probes that need one. */
export const PROBE_CALLER: ProbeCaller = { wallet: PROBE_WALLETS[0] };

/** Meme card ids the probes ask about. */
export const PROBE_MEME_IDS = ['1', '2'];

/**
 * A meme card that hasn't dropped: after the newest card the fixture mints
 * (the holdings seed mints cards 1 to 4), for routes about upcoming cards.
 */
export const PROBE_UPCOMING_MEME_ID = '5';

export const PROBE_MEMES_CONTRACT = MEMES_CONTRACT.toLowerCase();

/** A fixed window, so both passes ask for the same rows. */
export const PROBE_SINCE_MS = 1767225600000;
export const PROBE_TO_MS = 1767830400000;
