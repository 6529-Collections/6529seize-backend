import { WaveType } from '@/entities/IWave';

export type ApproveWaveDecisionCounts = {
  total_no_of_decisions: number | null;
  no_of_decisions_done: number | null;
  no_of_decisions_left: number | null;
};

export function getApproveWaveDecisionCounts({
  waveType,
  maxWinners,
  decisionsDone
}: {
  waveType: WaveType;
  maxWinners: number | null;
  decisionsDone: number;
}): ApproveWaveDecisionCounts {
  if (waveType !== WaveType.APPROVE) {
    return {
      total_no_of_decisions: null,
      no_of_decisions_done: null,
      no_of_decisions_left: null
    };
  }

  return {
    total_no_of_decisions: maxWinners,
    no_of_decisions_done: decisionsDone,
    no_of_decisions_left:
      maxWinners === null ? null : Math.max(maxWinners - decisionsDone, 0)
  };
}

export function isApproveWaveClosed({
  waveType,
  maxWinners,
  decisionsDone
}: {
  waveType: WaveType;
  maxWinners: number | null;
  decisionsDone: number;
}): boolean {
  return (
    waveType === WaveType.APPROVE &&
    maxWinners !== null &&
    decisionsDone >= maxWinners
  );
}
