import { ExemptUntil, overdueLine } from '@/rebuild/run/exempt-until';

/**
 * A running rebuilder's plan of planned rows (seeded rows only a later
 * change rebuilds), as a run found it.
 */
export interface PlannedRowsPlan {
  readonly step: string;
  readonly where: string;
  readonly reason: string;
  /** The plan's last day, YYYY-MM-DD. */
  readonly until: string;
  /** The later change that brings the rows' source. */
  readonly change: string;
  /**
   * Seeded rows the plan's condition matched; null when the run didn't
   * read them (its table isn't in the schema, its step didn't run, or the
   * run stopped first).
   */
  readonly seeded: number | null;
  /**
   * Of those, rows missing from the rebuild; null when the run stopped
   * before the rows were compared.
   */
  readonly missing: number | null;
  /** The run's day is past `until`. */
  readonly overdue: boolean;
  /**
   * A column plan's columns: its matched rows must come back, and may
   * differ only in these. Absent on a plan of whole rows.
   */
  readonly columns?: readonly string[];
  /**
   * A column plan's matched rows that came back changed in any of its
   * columns, and how many differ in each of its columns; null before the
   * rows were compared.
   */
  readonly differing?: number | null;
  /**
   * Of those, the rows left out of the differences: changed only in
   * columns their plans name.
   */
  readonly excused?: number | null;
  readonly differingByColumn?: Readonly<Record<string, number>>;
}

/** A step skipped as planned: a table it needs isn't in the schema. */
export interface WaitingStep {
  readonly step: string;
  readonly table: string;
  readonly reason: string;
}

/** What a run found, for the verdict. */
export interface VerdictInput {
  readonly final: boolean;
  /** Connections steps tried outside the sources. */
  readonly stepViolations: number;
  /** Connections the API tried outside the sources while answering. */
  readonly apiViolations: number;
  /** Command steps that don't run Node, so the guard can't watch them. */
  readonly unguardedSteps: readonly string[];
  /** Probes that failed or answer differently. */
  readonly differences: number;
  /** Probes whose answers match but prove nothing. */
  readonly unproven: number;
  /** INDEX tables no rebuilder writes. */
  readonly pending: number;
  /** Rebuilt tables no probe read, unless waived. */
  readonly unreadTables: readonly string[];
  /** Rebuilt tables that differ row by row outside their volatile columns. */
  readonly differingTables: number;
  /** Rebuilt tables with no rows after the seeds, unless waived. */
  readonly unseededTables: readonly string[];
  readonly exemptTables: number;
  /** EXEMPT tables exempt only until a day. */
  readonly exemptUntil: readonly ExemptUntil[];
  /** Problems the sources report (an unrecorded request, a bad file). */
  readonly sourceProblems: readonly string[];
  readonly provisionalSources: readonly string[];
  /** Planned tables whose code isn't in the tree. */
  readonly plannedTables: number;
  /** Planned steps skipped because their module isn't in the tree. */
  readonly plannedSteps: readonly string[];
  /** Steps marked planned whose code is in the tree, so they ran. */
  readonly plannedStepsHere: readonly string[];
  /**
   * Planned rebuilders whose module isn't in the tree, each with the
   * tables it writes: the order checks left those writes out.
   */
  readonly orderLeftOut: readonly string[];
  /**
   * Order edges to another area's step this tree doesn't have, each as
   * "<step> <field> <id>".
   */
  readonly unresolvedEdges: readonly string[];
  /** Steps skipped as planned, one entry per table they need and lack. */
  readonly waitingSteps: readonly WaitingStep[];
  /** Needs on tables the schema already has, each naming its step. */
  readonly staleNeeds: readonly string[];
  /** Partitioned tables with rows no writer's partition owns. */
  readonly unownedRows: readonly string[];
  /** Owned columns left out because their owner doesn't run here. */
  readonly unrunOwnedColumns: readonly string[];
  /** Every plan of planned rows of the running rebuilders. */
  readonly plannedRows: readonly (PlannedRowsPlan & { table: string })[];
  /** Planned probes held because a table they read isn't in the schema. */
  readonly heldProbes: readonly string[];
  /** Tables a manifest keeps or rebuilds that a fresh schema lacks. */
  readonly notInSchema: readonly string[];
  /** Documented GET routes with no probe and no waiver. */
  readonly openRoutes: number;
}

export interface Verdict {
  readonly failures: string[];
  readonly notes: string[];
}

/**
 * What fails a run and what is only noted. Some findings fail every run;
 * the rest are notes, and failures with `final`.
 */
export function judge(input: VerdictInput): Verdict {
  const failures: string[] = [];
  const notes: string[] = [];
  /** A failure in a final run, a note otherwise. */
  const finalOnly = (text: string) =>
    (input.final ? failures : notes).push(text);

  if (input.stepViolations) {
    failures.push(
      `${input.stepViolations} connections to sources outside the list (see Source violations)`
    );
  }
  if (input.unguardedSteps.length) {
    finalOnly(
      `${input.unguardedSteps.length} command steps don't run Node, so the source guard can't watch them: ${input.unguardedSteps.join(', ')}`
    );
  }
  if (input.apiViolations) {
    notes.push(
      `The API tried ${input.apiViolations} connections outside the list while answering probes.`
    );
  }
  if (input.differences) {
    failures.push(`${input.differences} probes failed or answer differently`);
  }
  if (input.unproven) {
    finalOnly(
      `${input.unproven} probes answered 4xx or with no data in the first pass, so they prove nothing yet${input.final ? '' : '; a final run fails them'}.`
    );
  }
  if (input.pending) {
    finalOnly(
      input.final
        ? `${input.pending} INDEX tables have no rebuilder`
        : `${input.pending} INDEX tables have no rebuilder yet; this run kept them, so they are not proven.`
    );
  }
  if (input.final && input.unreadTables.length) {
    failures.push(
      `${input.unreadTables.length} rebuilt tables were read by no probe`
    );
  }
  if (input.differingTables) {
    finalOnly(
      input.differences
        ? `${input.differingTables} rebuilt tables differ row by row (outside their volatile columns), and the probes differ too.`
        : `${input.differingTables} rebuilt tables differ row by row (outside their volatile columns) while the probes match; look for a missing probe.`
    );
  }
  if (input.unseededTables.length) {
    finalOnly(
      `${input.unseededTables.length} rebuilt tables had no rows after the seeds, so their rebuild proves nothing: ${input.unseededTables.join(', ')}`
    );
  }
  if (input.exemptTables) {
    notes.push(
      `${input.exemptTables} EXEMPT tables are kept and not covered by this proof.`
    );
  }
  if (input.exemptUntil.length) {
    finalOnly(
      `${input.exemptUntil.length} EXEMPT tables are exempt only until a day, so a final run fails on them: ${input.exemptUntil
        .map((e) => `${e.table} until ${e.until} (${e.why})`)
        .join('; ')}`
    );
  }
  const overdue = overdueLine(input.exemptUntil, input.plannedRows);
  // Past its day an exemption or a plan is overdue: noted, not failed, so
  // a run never turns red because the clock moved; a final run fails on
  // every one of them, whatever the day.
  if (overdue) notes.push(overdue);
  failures.push(...input.sourceProblems);
  if (input.provisionalSources.length) {
    finalOnly(
      `Provisional sources, which a final run can't count: ${input.provisionalSources.join(', ')}`
    );
  }
  if (input.plannedTables) {
    finalOnly(
      `${input.plannedTables} planned tables are not in this tree's code`
    );
  }
  // A normal run keeps a skipped rebuilder's tables; a final run drops
  // them, and nothing rebuilds them.
  const skippedTables = input.final
    ? "their rebuilders' tables were not rebuilt"
    : "their rebuilders' tables were kept";
  if (input.plannedSteps.length) {
    finalOnly(
      `${input.plannedSteps.length} planned steps were skipped because their code is not in this tree, and ${skippedTables}: ${input.plannedSteps.join(', ')}`
    );
  }
  // Nothing planned passes a final run, even a step whose code is here.
  if (input.plannedStepsHere.length) {
    finalOnly(
      `${input.plannedStepsHere.length} steps are marked planned though their code is in this tree; drop origin 'planned': ${input.plannedStepsHere.join(', ')}`
    );
  }
  if (input.unresolvedEdges.length) {
    finalOnly(
      `${input.unresolvedEdges.length} unresolved cross-area edges, of every area: order edges to another area's step that isn't in this tree, which a final run fails on: ${input.unresolvedEdges.join('; ')}`
    );
  }
  if (input.orderLeftOut.length) {
    notes.push(
      `${input.orderLeftOut.length} planned rebuilders, of every area, had their writes left out of the order check while their module is not in this tree: ${input.orderLeftOut.join('; ')}`
    );
  }
  if (input.waitingSteps.length) {
    const steps = new Set(input.waitingSteps.map((w) => w.step));
    finalOnly(
      `${steps.size} steps were skipped as planned because a table they need is not in the schema yet, and ${skippedTables}: ${input.waitingSteps
        .map((w) => `${w.step} needs ${w.table} (${w.reason})`)
        .join('; ')}`
    );
  }
  if (input.staleNeeds.length) {
    finalOnly(
      `${input.staleNeeds.length} needs name tables the schema already has, so they hold nothing back: ${input.staleNeeds.join('; ')}`
    );
  }
  if (input.unownedRows.length) {
    finalOnly(
      `${input.unownedRows.length} partitioned tables hold rows no rebuilder owns after the seeds: ${input.unownedRows.join(', ')}`
    );
  }
  if (input.plannedRows.length) {
    finalOnly(
      `${input.plannedRows.length} plans of planned rows, seeded rows only a later change rebuilds; a final run fails on every plan: ${input.plannedRows
        .map(
          (p) =>
            `${p.table}${p.columns ? ` columns ${p.columns.join(', ')}` : ''} by ${p.step}: seeded ${p.seeded ?? 'not read'}, ${p.columns ? `differing ${p.differing ?? 'not compared'}, excused ${p.excused ?? 'not compared'}, ` : ''}missing ${p.missing ?? 'not compared'}, until ${p.until} (${p.change})`
        )
        .join('; ')}`
    );
  }
  for (const p of input.plannedRows) {
    if (p.seeded === 0) {
      notes.push(
        `Planned rows of ${p.table} by ${p.step}: plan matched no seeded rows`
      );
    } else if (p.columns) {
      if (p.differing === 0 && p.missing === 0) {
        notes.push(
          `Planned columns of ${p.table} by ${p.step}: the rebuild writes these columns now: drop the plan`
        );
      }
    } else if (p.seeded !== null && p.missing === 0) {
      notes.push(
        `Planned rows of ${p.table} by ${p.step}: the rebuild writes these rows now: drop the plan`
      );
    }
  }
  if (input.unrunOwnedColumns.length) {
    finalOnly(
      `${input.unrunOwnedColumns.length} owned columns were left out of the row comparison because their owner doesn't run here (another area, or skipped); a full run with every owner compares them: ${input.unrunOwnedColumns.join(', ')}`
    );
  }
  if (input.heldProbes.length) {
    finalOnly(
      `${input.heldProbes.length} planned probes were held because a table they read is not in the schema yet: ${input.heldProbes.join(', ')}`
    );
  }
  if (input.notInSchema.length) {
    finalOnly(
      `${input.notInSchema.length} tables are not in a fresh schema, so code that reads them fails on a rebuilt database: ${input.notInSchema.join(', ')}`
    );
  }
  if (input.final && input.openRoutes) {
    failures.push(
      `${input.openRoutes} documented GET routes have no probe and no waiver`
    );
  }
  return { failures, notes };
}
