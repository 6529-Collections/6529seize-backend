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
  /** Problems the sources report (an unrecorded request, a bad file). */
  readonly sourceProblems: readonly string[];
  readonly provisionalSources: readonly string[];
  /** Planned tables whose code isn't in the tree. */
  readonly plannedTables: number;
  /** Planned steps skipped because their module isn't in the tree. */
  readonly plannedSteps: readonly string[];
  /** Steps skipped as planned, one entry per table they need and lack. */
  readonly waitingSteps: readonly WaitingStep[];
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
  if (input.waitingSteps.length) {
    const steps = new Set(input.waitingSteps.map((w) => w.step));
    finalOnly(
      `${steps.size} steps were skipped as planned because a table they need is not in the schema yet, and ${skippedTables}: ${input.waitingSteps
        .map((w) => `${w.step} needs ${w.table} (${w.reason})`)
        .join('; ')}`
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
