import { mirrorIdentityDirectory } from '../identity/identity-directory';
import {
  closeSubscriptionWrites,
  openSubscriptionWrites,
  scheduleIdentitySwitch,
  SWITCH_CUT_WINDOW_MS
} from '../identity/identity-switch';
import { shadowReportsMatch } from '../writers/identity-reports';
import { cutOpeningFiles } from './opening-build';
import { compareAndMarkVerified } from './opening-compare';
import { loadOpeningFiles, parseOpeningFiles } from './opening-load';
import { verifyOpening } from './opening-verify';
import { FileUploader, publishOpeningFiles } from './published-chain';

/** Stop with time to spare before the cut stops counting (STALE_CUT). */
const WINDOW_MARGIN_MS = 60 * 1000;

export interface GoLiveResult {
  readonly switched: boolean;
  readonly steps: string[];
  readonly openingSha256: string | null;
}

/**
 * The switch in one step. It refuses unless signed subscription writes are
 * live and the shadow comparisons match on the last minted card. Then it
 * pauses the unsigned write routes (they answer 503), cuts, verifies,
 * loads, compares, publishes the files and sets the switch time, and
 * reopens the routes, which from then on answer 409 to unsigned writes.
 * Each step checks that the cut is still within the switch window, so a
 * slow day stops early instead of loading tables that would not count. On
 * any failure the routes reopen and the legacy tables stay the truth.
 */
export async function goLive(params: {
  readonly signedWritesLive: boolean;
  readonly acceptReportDiffs: boolean;
  readonly mintedCard: number;
  readonly saveFile?: (name: string, text: string) => void;
  readonly uploader?: FileUploader;
  readonly now?: () => number;
}): Promise<GoLiveResult> {
  const now = params.now ?? (() => Date.now());
  const steps: string[] = [];
  const refuse = (why: string): GoLiveResult => {
    steps.push(`refused: ${why}`);
    return { switched: false, steps, openingSha256: null };
  };
  if (!params.signedWritesLive) {
    return refuse(
      'signed subscription writes are not live; without them every change gets a 409'
    );
  }
  const reports = await shadowReportsMatch(params.mintedCard);
  steps.push(...reports.checked.map((c) => `checked ${c}`));
  if (!reports.ok) {
    steps.push(...reports.problems.map((p) => `problem: ${p}`));
    if (!params.acceptReportDiffs) {
      return refuse('the shadow comparisons do not match');
    }
  }

  await closeSubscriptionWrites(now());
  steps.push('unsigned writes paused');
  let openingSha256: string | null = null;
  try {
    const cutStartedMs = now();
    const step = (name: string) => {
      const elapsed = now() - cutStartedMs;
      steps.push(`${name}: ${Math.round(elapsed / 1000)} s after the cut`);
      if (elapsed > SWITCH_CUT_WINDOW_MS - WINDOW_MARGIN_MS) {
        throw new Error(
          `${name} ended ${Math.round(elapsed / 1000)} s after the cut, too late for the switch window`
        );
      }
    };
    const files = await cutOpeningFiles(mirrorIdentityDirectory, cutStartedMs);
    params.saveFile?.(
      `history-${files.historySha256}.json`,
      files.historyBytes
    );
    params.saveFile?.(
      `opening-${files.openingSha256}.json`,
      files.openingBytes
    );
    step('cut');
    const parsed = parseOpeningFiles(files.openingBytes, files.historyBytes);
    openingSha256 = parsed.openingSha256;
    const failed = verifyOpening(parsed).checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      return refuse(`the cut fails ${failed.map((c) => c.name).join(', ')}`);
    }
    step('verify');
    await loadOpeningFiles(parsed);
    step('load');
    const g4 = await compareAndMarkVerified(parsed, mirrorIdentityDirectory);
    if (!g4.ok) {
      return refuse('the opening comparison differs; the legacy tables stay the truth');
    }
    step('compare');
    const published = await publishOpeningFiles(files, params.uploader);
    steps.push(
      `published opening ${published.openingUri}, history ${published.historyUri}`
    );
    step('publish');
    if (!(await scheduleIdentitySwitch(now(), parsed.openingSha256))) {
      return refuse('the switch time could not be set on this load');
    }
    steps.push(`switched to opening ${parsed.openingSha256}`);
    return { switched: true, steps, openingSha256 };
  } catch (error) {
    return refuse((error as Error).message);
  } finally {
    await openSubscriptionWrites();
    steps.push('unsigned write routes reopened');
  }
}
