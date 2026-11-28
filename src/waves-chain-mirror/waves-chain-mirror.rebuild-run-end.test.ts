import { emptyObjectsReport } from './waves-chain-mirror.objects';
import { rebuildRunEnd, rebuildRunStop } from './waves-chain-mirror.rebuild';
import { WavesChainMirrorReport } from './waves-chain-mirror.service';

/** A rebuild run that read the log to its end and finished its pass. */
function aRun(
  fields: Partial<WavesChainMirrorReport> = {}
): WavesChainMirrorReport {
  return {
    mode: 'write',
    height: 60,
    network: 'net-1',
    events: 0,
    cursor: null,
    full: { running: false, started: null, completed: true, after: null },
    decisions: { mirrored: 0, unchanged: 0, skipped: {}, failed: 0, left: 0 },
    changes: {},
    waiting: {},
    notes: {},
    objects: emptyObjectsReport(),
    invalidLegacyIds: 0,
    differences: [],
    ...fields
  };
}

describe('rebuildRunStop', () => {
  it('stops the rebuild at a run with no groups and waves report, saying where to look', () => {
    expect(rebuildRunStop(aRun({ objects: null }), 'rebuild', 1)).toBe(
      "The mirror's rebuild had no groups and waves report in run 1: that pass failed. Its error is logged above ([WAVES CHAIN MIRROR] groups and waves failed); fix that, then run the rebuild again"
    );
    // Whatever else the run left.
    expect(
      rebuildRunStop(aRun({ objects: null, events: 3 }), 'seed', 4)
    ).toContain("The mirror's seed had no groups and waves report in run 4");
  });

  it('never stops the rebuild at a run with a groups and waves report', () => {
    const pending = emptyObjectsReport();
    pending.remap.imported.pending = 2;
    const capped = emptyObjectsReport();
    capped.remap.imported.capped = true;
    for (const run of [
      aRun(),
      aRun({ events: 3 }),
      aRun({ objects: pending }),
      aRun({ objects: capped })
    ]) {
      expect(rebuildRunStop(run, 'rebuild', 1)).toBeNull();
    }
  });
});

describe('rebuildRunEnd', () => {
  it('ends the rebuild only with a groups and waves report and no imported group pending', () => {
    expect(rebuildRunEnd(aRun())).toBe('done');
    // A capped report is a finished one.
    const capped = emptyObjectsReport();
    capped.remap.imported.groups = 3;
    capped.remap.imported.capped = true;
    expect(rebuildRunEnd(aRun({ objects: capped }))).toBe('done');
  });

  it("doesn't read a run with no groups and waves report as done", () => {
    expect(rebuildRunEnd(aRun({ objects: null }))).toBe('no_objects');
  });

  it('goes on while an imported group waits to be matched', () => {
    const pending = emptyObjectsReport();
    pending.remap.imported.pending = 1;
    expect(rebuildRunEnd(aRun({ objects: pending }))).toBe('again');
  });

  it('goes on while the log, the full pass or a decision is left', () => {
    expect(rebuildRunEnd(aRun({ events: 3 }))).toBe('again');
    expect(
      rebuildRunEnd(
        aRun({
          full: { running: true, started: null, completed: false, after: null }
        })
      )
    ).toBe('again');
    expect(
      rebuildRunEnd(
        aRun({
          decisions: {
            mirrored: 0,
            unchanged: 0,
            skipped: {},
            failed: 0,
            left: 1
          }
        })
      )
    ).toBe('again');
    // Left before the groups and waves report is even looked at.
    expect(rebuildRunEnd(aRun({ events: 3, objects: null }))).toBe('again');
  });
});
