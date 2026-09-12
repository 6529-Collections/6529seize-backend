import { createHash } from 'node:crypto';
import { validateStartUpload } from '../assets/artwork-assets.policy';
import { answerValue } from '../artwork-documentation.validation';
import { ModuleId } from '../artwork-documentation.types';
import { buildLinkedArtExport } from './export/linked-art';
import { compileDossier } from './export/dossier';
import { OCFL_BAG_PREFIX, wrapDossierInOcfl } from './export/ocfl';
import { reconstructDossier } from './export/reconstruct';
import {
  museumRecordIssues,
  museumRequired,
  validateMuseumDraft
} from './museum-validation';
import {
  AN_ALTERATION_PREVIEW_SHA256,
  AN_ALTERATION_SOURCE_SHA256,
  CAPTURE_CASES,
  Corpus,
  alterationCorpus,
  corpusId,
  mediaCorpus
} from './fixtures/museum-corpus';

async function reconstruct(corpus: Corpus) {
  const compiled = compileDossier(corpus.snapshot);
  const ocfl = wrapDossierInOcfl(corpus.snapshot, compiled);
  const files = new Map(ocfl.files.map((file) => [file.path, file.bytes]));
  for (const entry of compiled.manifest)
    if ('asset_id' in entry && typeof entry.asset_id === 'string')
      files.set(
        OCFL_BAG_PREFIX + entry.path,
        corpus.originals.get(entry.asset_id)!
      );
  const restored = await reconstructDossier({
    async *read(path: string) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`Missing fixture payload ${path}`);
      yield bytes;
    }
  });
  return { compiled, restored };
}

describe('Complete museum capture and archival corpus', () => {
  it.each(CAPTURE_CASES.map((media) => [media.join(' + '), media] as const))(
    'accepts every required answer and reconstructs the complete %s record',
    async (_name, media) => {
      const corpus = mediaCorpus(media);
      const context = corpus.snapshot.context;
      validateMuseumDraft(context);
      expect(museumRecordIssues(context)).toEqual([]);
      for (const path of [
        ...context.profile.required_for_review,
        ...museumRequired(context.modules)
      ]) {
        const [module, field] = path.split('.') as [ModuleId, string];
        expect(context.modules[module][field]?.status).toBe('provided');
      }
      for (const asset of corpus.snapshot.assets)
        expect(
          validateStartUpload(
            {
              filename: asset.filename,
              size_bytes: asset.size_bytes,
              declared_mime: asset.declared_mime,
              role: asset.role,
              intended_visibility: 'public_record'
            },
            { mediaProfiles: media, publicationOnlyV3: true }
          )
        ).toBe(asset.extension);
      const linked = buildLinkedArtExport(context);
      expect(linked.validation.issues).toEqual([]);
      for (const profile of media)
        expect(
          linked.coverage.some(
            (entry) =>
              entry.source_pointer === `/modules/process/${profile}/value`
          )
        ).toBe(true);
      const { compiled, restored } = await reconstruct(corpus);
      expect(restored.record.modules).toEqual(context.modules);
      expect(restored.record.asset_links).toEqual(context.asset_links);
      expect(restored.permissions_restored).toBe(false);
      expect(
        compiled.files.some((file) => file.path === 'data/metadata/lido.xml')
      ).toBe(true);
      expect(
        compiled.files.some((file) => file.path === 'data/metadata/premis.xml')
      ).toBe(true);
      expect(
        compiled.issues.some(
          (issue) => issue.code === 'XML_SOURCE_CHARACTER_UNSUPPORTED'
        )
      ).toBe(false);
    }
  );

  it('round-trips the exact AN ALTERATION paragraphs and actual preview without fabricating its named master or print receipts', async () => {
    const corpus = alterationCorpus();
    const context = corpus.snapshot.context;
    validateMuseumDraft(context);
    expect(museumRecordIssues(context)).toEqual([]);
    expect(
      createHash('sha256')
        .update(corpus.originals.get(corpusId(101))!)
        .digest('hex')
    ).toBe(AN_ALTERATION_SOURCE_SHA256);
    expect(
      createHash('sha256')
        .update(corpus.originals.get(corpusId(102))!)
        .digest('hex')
    ).toBe(AN_ALTERATION_PREVIEW_SHA256);
    const { compiled, restored } = await reconstruct(corpus);
    expect(restored.record.modules).toEqual(context.modules);
    const records = restored.record.modules as typeof context.modules;
    const documents = answerValue<{ id: string; text: string }[]>(
      records.context.documents
    )!;
    expect(
      documents.find((document) => document.id === corpusId(30))?.text
    ).toBe(corpus.source.replace(/\r\n?/g, '\n').normalize('NFC'));
    corpus.sections.forEach((section, index) =>
      expect(
        documents.find((document) => document.id === corpusId(31 + index))?.text
      ).toBe(section.replace(/\r\n?/g, '\n').normalize('NFC'))
    );
    expect(
      answerValue<string>(records.preservation.print_preferences)!.length
    ).toBeGreaterThan(6500);
    const interviews = answerValue<
      {
        transcript_text: string;
        recording_asset_ids?: string[];
        instrument: { questions: unknown[] };
      }[]
    >(records.interview.sessions)!;
    expect(interviews[0].transcript_text.length).toBeGreaterThan(12000);
    expect(interviews[0].instrument.questions.length).toBeGreaterThan(20);
    expect(interviews[0].recording_asset_ids).toBeUndefined();
    expect(context.asset_links.map((link) => link.role)).toEqual([
      'other_supporting',
      'display_derivative'
    ]);
    expect(records.artwork.canonical_asset_id).toBeUndefined();
    const declared = answerValue<{ name: string; availability: string }[]>(
      records.files.described_materials
    )!;
    expect(declared).toHaveLength(11);
    expect(declared.every((item) => item.availability === 'expected')).toBe(
      true
    );
    expect(
      (restored.record.assets as { filename: string }[]).map(
        (asset) => asset.filename
      )
    ).toEqual([
      'AN_ALTERATION-user-original.txt',
      'AN_ALTERATION-user-supplied-preview.png'
    ]);
    const linked = buildLinkedArtExport(context);
    expect(
      [...linked.resources, ...linked.crm_extensions].some(
        (entity) =>
          entity.id === `urn:uuid:${corpusId(60)}` &&
          entity.type === 'DigitalObject'
      )
    ).toBe(false);
    expect(linked.validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'artwork.canonical_asset_id',
          code: 'ANSWER_REQUIRED'
        })
      ])
    );
    expect(restored.museum_records).toEqual([]);
    expect(restored.record.confirmation).toBeNull();
    expect(
      compiled.issues.some(
        (issue) => issue.code === 'XML_SOURCE_CHARACTER_UNSUPPORTED'
      )
    ).toBe(false);
  });
});
