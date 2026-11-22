import { compareFinalList } from './compare-list';
import { comparePhases } from './compare-phases';
import { compareRedemptions } from './compare-redemptions';
import { ParityParams } from './parity-inputs';
import { ParityReport } from './parity-report';

/**
 * All three comparisons for one run: the final list, each phase, and the
 * redemptions once the card's airdrop mints exist.
 */
export function runParity(params: ParityParams): ParityReport[] {
  const list = compareFinalList(params);
  const reports = [list.report, ...comparePhases(params, list)];
  if ((params.transfers ?? params.legacy.airdropTransfers).length > 0) {
    reports.push(compareRedemptions(params, list));
  }
  return reports;
}
