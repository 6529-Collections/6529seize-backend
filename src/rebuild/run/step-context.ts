import { RebuildContext, RebuildSource } from '@/rebuild/manifest.types';

/**
 * What a seed or rebuilder is told about its run: its area and id, the
 * sources' URLs, where a seed writes files (only when the run has a files
 * source), the mark, and whether this is a final run.
 */
export function stepContext(input: {
  readonly area: string;
  readonly stepId: string;
  readonly kind: 'seed' | 'rebuilder';
  readonly sources: Readonly<Record<RebuildSource, string | null>>;
  /** Where the run's seeds write files for its files source. */
  readonly seedFilesDir: string;
  readonly mark: RebuildContext['mark'];
  readonly final: boolean;
}): RebuildContext {
  return {
    area: input.area,
    stepId: input.stepId,
    sources: input.sources,
    seedFilesDir:
      input.kind === 'seed' && input.sources.files ? input.seedFilesDir : null,
    mark: input.mark,
    final: input.final
  };
}
