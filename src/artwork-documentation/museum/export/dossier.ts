import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { parseJson } from '../../artwork-documentation.db';
import { digest, normalizeJson } from '../../artwork-documentation.validation';
import {
  AssetTechnicalMetadata,
  StoredAsset
} from '../../assets/artwork-assets.types';
import { buildLinkedArtExport } from './linked-art';
import { buildPremis } from './premis';
import { buildLido } from './lido';
import { buildIiif } from './iiif';
import {
  DossierIssue,
  DossierSnapshot,
  DossierTextFile
} from './dossier.types';
import schemaBundle from './schemas/schema-bundle.json';
import { publicationHistory } from './dossier-history';
import { UnsupportedXmlCharacter } from './xml';

const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => canonicalizeJson(normalizeJson(value)) + '\n';
const textFile = (
  path: string,
  media_type: string,
  content: string | Buffer
): DossierTextFile => {
  const bytes = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, 'utf8');
  return { path, media_type, bytes, sha256: hash(bytes) };
};
export const originalPath = (asset: StoredAsset): string =>
  `data/originals/${asset.id}.${asset.extension}`;
export const dossierSourceHash = (snapshot: DossierSnapshot): string =>
  digest(snapshot);

function technical(asset: StoredAsset): AssetTechnicalMetadata | null {
  return asset.technical_metadata_json
    ? parseJson<AssetTechnicalMetadata>(asset.technical_metadata_json)
    : null;
}
function reports(snapshot: DossierSnapshot) {
  return snapshot.assets.flatMap((asset) => {
    const c2pa = technical(asset)?.c2pa;
    return asset.validation_report_key &&
      c2pa?.report_sha256 &&
      c2pa.report_size_bytes
      ? [
          {
            path: `data/validation/${asset.id}-c2pa.json`,
            media_type: 'application/json',
            size_bytes: c2pa.report_size_bytes,
            sha256: c2pa.report_sha256,
            bucket: asset.bucket,
            key: asset.validation_report_key
          }
        ]
      : [];
  });
}

function xmlFiles(
  snapshot: DossierSnapshot,
  issues: DossierIssue[]
): DossierTextFile[] {
  const files: DossierTextFile[] = [];
  for (const [name, build] of [
    ['premis', buildPremis],
    ['lido', buildLido]
  ] as const) {
    try {
      files.push(
        textFile(
          `data/metadata/${name}.xml`,
          'application/xml',
          build(snapshot)
        )
      );
    } catch (error) {
      if (!(error instanceof UnsupportedXmlCharacter)) throw error;
      issues.push({
        code: 'XML_SOURCE_CHARACTER_UNSUPPORTED',
        path: name,
        severity: 'warning',
        message:
          'Some writing contains a character unavailable in XML 1.0. The complete source remains in the Stream JSON; this XML projection is omitted.'
      });
    }
  }
  return files;
}

export function compileDossier(snapshot: DossierSnapshot) {
  const context = snapshot.context;
  const issues: DossierIssue[] = [
    {
      code: 'PERMANENT_PUBLICATION_PENDING',
      path: 'publication',
      severity: 'information',
      message:
        'This is a database draft. No on-chain registration, publication transaction or finality is asserted.'
    }
  ];
  const linked = buildLinkedArtExport(context, snapshot.museum_records);
  const iiif = buildIiif(
    context,
    snapshot.assets,
    `https://example.invalid/stream-draft/${context.id}`
  );
  issues.push(
    ...iiif.issues,
    ...linked.validation.issues.map((issue) => ({
      code: issue.code,
      path: issue.field,
      severity: 'warning' as const,
      message: `The draft needs review: ${issue.code}.`
    }))
  );
  const assets = snapshot.assets.map((asset) => ({
    id: asset.id,
    filename: asset.filename,
    path: originalPath(asset),
    role: asset.role,
    size_bytes: Number(asset.size_bytes),
    sha256: asset.sha256,
    detected_mime: asset.detected_mime,
    technical_metadata: technical(asset)
  }));
  const history = publicationHistory(snapshot, issues);
  const confirmed =
    history.artist_revisions.find(
      (revision) => revision.id === snapshot.confirmed_revision?.id
    ) ?? null;
  const source = {
    schema: 'STREAM_ARTWORK_DOSSIER_DRAFT_V1',
    profile: context.profile,
    work_id: context.work_id,
    context_id: context.id,
    owner_profile_id: context.owner_profile_id,
    program_id: context.program_id,
    draft_version: context.draft_version,
    modules: context.modules,
    asset_links: context.asset_links,
    assets,
    source_receipts: snapshot.source_receipts,
    confirmation: confirmed,
    ...history,
    publication_state: 'database_draft'
  };
  const records = snapshot.museum_records.map((row) => ({
    ...row,
    payload_json: parseJson<unknown>(row.payload_json)
  }));
  const files = [
    textFile('data/record.json', 'application/json', json(source)),
    textFile('data/museum-records.json', 'application/json', json(records)),
    textFile(
      'data/metadata/linked-art.json',
      'application/ld+json',
      json({
        '@context': linked.pinned_context['@context'],
        '@graph': [...linked.resources, ...linked.crm_extensions]
      })
    ),
    textFile(
      'data/metadata/linked-art-mapping.json',
      'application/json',
      json(linked)
    ),
    textFile(
      'data/metadata/linked-art-context.json',
      'application/ld+json',
      json(linked.pinned_context)
    ),
    textFile(
      'data/metadata/iiif-manifest.json',
      'application/ld+json',
      json(iiif.manifest)
    ),
    textFile(
      'data/metadata/iiif-local-bindings.json',
      'application/json',
      json({
        status: 'publication_binding_required',
        note: 'example.invalid is an explicit unserved publication base. Bind permanent HTTP URLs before publishing the IIIF manifest; the map resolves its media to exact files in this bag.',
        bindings: iiif.bindings
      })
    ),
    ...xmlFiles(snapshot, issues)
  ];
  for (const [name, base64] of Object.entries(schemaBundle.files))
    files.push(
      textFile(
        `data/metadata/schemas/${name}`,
        name.endsWith('.json') ? 'application/json' : 'application/xml',
        Buffer.from(base64, 'base64')
      )
    );
  files.push(
    textFile(
      'data/metadata/schemas/schema-lock.json',
      'application/json',
      json(schemaBundle.lock)
    )
  );
  files.push(
    textFile(
      'data/metadata/mapping-report.json',
      'application/json',
      json({
        source_sha256: dossierSourceHash(snapshot),
        source_complete: true,
        linked_art: {
          profile: linked.profile_lock,
          coverage: linked.coverage,
          validation: linked.validation
        },
        lido: {
          version: '1.1',
          scope:
            'Work, component, physical object, document and digital file descriptions; scoped dimensions, attributed writing, participant roles, dates and event places. Institutional assertions remain separately attributed.'
        },
        premis: {
          version: '3.0',
          scope:
            'Intellectual objects, files, agents, measured fixity and format identification, attributed technical and institutional events, scoped rights and significant properties; planned actions remain distinct from completed events.'
        },
        iiif: {
          version: '3.0',
          scope:
            'Ordered image/audio/video scenes, spatial layouts, source clips, time modes, transcripts and multilingual annotations. Original files remain available as renderings; permanent publication bindings are pending.'
        },
        issues
      })
    )
  );
  const reportFiles = reports(snapshot);
  const manifest = [
    ...files.map((file) => ({
      path: file.path,
      media_type: file.media_type,
      size_bytes: file.bytes.length,
      sha256: file.sha256
    })),
    ...assets.map((asset) => ({
      path: asset.path,
      media_type: asset.detected_mime ?? 'application/octet-stream',
      size_bytes: asset.size_bytes,
      sha256: asset.sha256!,
      asset_id: asset.id
    })),
    ...reportFiles.map(({ path, media_type, size_bytes, sha256 }) => ({
      path,
      media_type,
      size_bytes,
      sha256
    }))
  ].sort((a, b) => a.path.localeCompare(b.path));
  const tags = [
    textFile(
      'bagit.txt',
      'text/plain',
      'BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n'
    ),
    textFile(
      'bag-info.txt',
      'text/plain',
      `Bagging-Date: ${new Date(Number(context.updated_at)).toISOString().slice(0, 10)}\nBag-Software-Agent: 6529 artwork dossier v1\nExternal-Identifier: urn:uuid:${context.work_id}\nPayload-Oxum: ${manifest.reduce((sum, file) => sum + file.size_bytes, 0)}.${manifest.length}\n`
    ),
    textFile(
      'manifest-sha256.txt',
      'text/plain',
      manifest.map((file) => `${file.sha256}  ${file.path}\n`).join('')
    ),
    textFile(
      'README.txt',
      'text/plain',
      `Artwork dossier\n\nThis BagIt 1.0 package contains the artwork record, attributed museum records, standards projections and the actual original files. Original filenames and their safe package paths appear in data/record.json. Verify manifest-sha256.txt and tagmanifest-sha256.txt before relying on any file. Source SHA-256: ${dossierSourceHash(snapshot)}.\n\nThis is a database draft; it is not a mint, token ownership proof or on-chain signature. Read data/metadata/mapping-report.json for the supported mappings and any review issues. The complete source is retained even when a standard has no equivalent field. Questions to the team are not publication content and are excluded.\n\nIIIF URLs use example.invalid until permanent publication bindings exist. The local binding map relates every media URL to its original in this package. Linked Art context bytes and XML schema imports are included for offline interpretation and validation.\n`
    )
  ];
  tags.push(
    textFile(
      'tagmanifest-sha256.txt',
      'text/plain',
      tags.map((file) => `${file.sha256}  ${file.path}\n`).join('')
    )
  );
  return { files: [...files, ...tags], reports: reportFiles, manifest, issues };
}
