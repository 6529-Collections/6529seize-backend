import { parseJson } from '../../artwork-documentation.db';
import { answerValue } from '../../artwork-documentation.validation';
import { AssetTechnicalMetadata } from '../../assets/artwork-assets.types';
import {
  MuseumAgent,
  MuseumComponent,
  MuseumDate,
  MuseumDocument,
  MuseumEvent,
  MuseumMeasurement,
  MuseumPhysicalObject,
  MuseumPlace
} from '../museum-record.types';
import { DossierSnapshot } from './dossier.types';
import { element as e, xml } from './xml';

type Description = {
  id?: string;
  kind: string;
  text: string;
  language?: string;
  source?: string;
};
type RecordInput = {
  id: string;
  title: string;
  title_language?: string;
  types: string[];
  descriptions: Description[];
  events: MuseumEvent[];
  measurements: MuseumMeasurement[];
  depicted_places?: MuseumPlace[];
  materials?: string;
};
const term = (name: string, value: unknown) =>
  `<lido:${name}>${e('lido:term', value)}</lido:${name}>`;
const lang = (value?: string) => (value ? ` xml:lang="${xml(value)}"` : '');
const value = (name: string, text: unknown, language?: string) =>
  `<lido:${name}${lang(language)}>${xml(text)}</lido:${name}>`;
const identifier = (name: string, id: string) =>
  `<lido:${name} lido:type="URI">${xml(id)}</lido:${name}>`;
const dateLabel = (date: MuseumDate) =>
  `${date.approximate ? 'approximately ' : ''}${date.start}${date.end ? `–${date.end}` : ''}${date.note ? `; ${date.note}` : ''}`;

function place(place: MuseumPlace): string {
  // Artist authority suggestions are not reconciled place identities. Geometry
  // and geographic hierarchy remain in the source rather than being inferred.
  const display = `${place.name}${place.certainty === 'known' ? '' : ` (${place.certainty})`}${place.note ? `; ${place.note}` : ''}`;
  return `${value('displayPlace', display, place.language)}<lido:place>${identifier('placeID', `urn:uuid:${place.id}`)}<lido:namePlaceSet>${value('appellationValue', place.name, place.language)}</lido:namePlaceSet></lido:place>`;
}
function date(date: MuseumDate): string {
  // Exact partial dates retain their supplied precision. Approximate dates get
  // no invented earliest/latest tolerance window.
  const structured = date.approximate
    ? ''
    : `<lido:date>${e('lido:earliestDate', date.start)}${e('lido:latestDate', date.end ?? date.start)}</lido:date>`;
  return `<lido:eventDate>${e('lido:displayDate', dateLabel(date))}${structured}</lido:eventDate>`;
}
function event(
  item: MuseumEvent,
  agents: Map<string, MuseumAgent>,
  places: Map<string, MuseumPlace>,
  owner: string
): string {
  const actors = (item.participants ?? [])
    .filter((credit) => agents.has(credit.agent_id))
    .map((credit) => {
      const agent = agents.get(credit.agent_id)!;
      if (agent.kind === 'software')
        return `<lido:eventActor>${e('lido:displayActorInRole', `${credit.credit ?? agent.name} (${credit.role}; software)`)}</lido:eventActor>`;
      return `<lido:eventActor>${credit.credit ? e('lido:displayActorInRole', credit.credit) : ''}<lido:actorInRole><lido:actor lido:type="${xml(agent.kind)}">${identifier('actorID', `urn:uuid:${credit.agent_id}`)}<lido:nameActorSet>${e('lido:appellationValue', agent.name)}</lido:nameActorSet></lido:actor>${term('roleActor', credit.role)}</lido:actorInRole></lido:eventActor>`;
    })
    .join('');
  const location = item.place_id ? places.get(item.place_id) : undefined;
  return `<lido:eventSet>${e('lido:displayEvent', item.account)}<lido:event>${identifier('eventID', `urn:uuid:${item.id}`)}${term('eventType', item.kind)}<lido:eventName>${e('lido:appellationValue', item.title)}</lido:eventName>${actors}${item.date ? date(item.date) : ''}${location ? `<lido:eventPlace lido:type="${xml(location.role)}">${place(location)}</lido:eventPlace>` : ''}<lido:eventDescriptionSet>${e('lido:descriptiveNoteValue', item.account)}${e('lido:sourceDescriptiveNote', `Artist-supplied account in record owned by 6529 profile ${owner}. Event ${item.id}.${item.source_ids?.length ? ` Source records: ${item.source_ids.join(', ')}.` : ''}`)}</lido:eventDescriptionSet></lido:event></lido:eventSet>`;
}
function description(item: Description): string {
  return `<lido:objectDescriptionSet lido:type="${xml(item.kind)}">${item.id ? identifier('descriptiveNoteID', `urn:uuid:${item.id}`) : ''}${value('descriptiveNoteValue', item.text, item.language)}${item.source ? e('lido:sourceDescriptiveNote', item.source) : ''}</lido:objectDescriptionSet>`;
}
function measurement(item: MuseumMeasurement): string {
  const unit =
    item.unit === 'other' ? (item.unit_label ?? 'unit unspecified') : item.unit;
  const display = `${item.scope} ${item.kind}: ${item.value} ${unit}${item.precision ? ` (${item.precision})` : ''}${item.note ? `; ${item.note}` : ''}`;
  return `<lido:objectMeasurementsSet lido:measurementsGroup="${xml(item.id)}">${e('lido:displayObjectMeasurements', display)}<lido:objectMeasurements><lido:measurementsSet>${e('lido:measurementType', item.kind)}${e('lido:measurementUnit', unit)}${e('lido:measurementValue', item.value)}</lido:measurementsSet>${e('lido:extentMeasurements', item.scope)}${item.precision ? e('lido:qualifierMeasurements', item.precision) : ''}</lido:objectMeasurements></lido:objectMeasurementsSet>`;
}
function record(
  input: RecordInput,
  snapshot: DossierSnapshot,
  agents: Map<string, MuseumAgent>,
  places: Map<string, MuseumPlace>
): string {
  const recordId = `urn:6529:lido:${snapshot.context.id}:${input.id}`;
  const recordLanguage =
    answerValue<string>(snapshot.context.modules.identity.record_language) ??
    'und';
  const descriptions = input.descriptions.length
    ? `<lido:objectDescriptionWrap>${input.descriptions.map(description).join('')}</lido:objectDescriptionWrap>`
    : '';
  const measurements = input.measurements.length
    ? `<lido:objectMeasurementsWrap>${input.measurements.map(measurement).join('')}</lido:objectMeasurementsWrap>`
    : '';
  const events = input.events
    .map((item) =>
      event(item, agents, places, snapshot.context.owner_profile_id)
    )
    .join('');
  const subjects = input.depicted_places?.length
    ? `<lido:objectRelationWrap><lido:subjectWrap>${input.depicted_places.map((location) => `<lido:subjectSet><lido:subject><lido:subjectPlace>${place(location)}</lido:subjectPlace></lido:subject></lido:subjectSet>`).join('')}</lido:subjectWrap></lido:objectRelationWrap>`
    : '';
  return `<lido:lido>${identifier('lidoRecID', recordId)}${identifier('objectPublishedID', `urn:uuid:${input.id}`)}<lido:descriptiveMetadata xml:lang="${xml(recordLanguage)}"><lido:objectClassificationWrap><lido:objectWorkTypeWrap>${(input.types.length ? input.types : ['Artwork']).map((type) => term('objectWorkType', type)).join('')}</lido:objectWorkTypeWrap></lido:objectClassificationWrap><lido:objectIdentificationWrap><lido:titleWrap><lido:titleSet>${value('appellationValue', input.title, input.title_language)}</lido:titleSet></lido:titleWrap>${descriptions}${measurements}${input.materials ? `<lido:objectMaterialsTechWrap><lido:objectMaterialsTechSet>${e('lido:displayMaterialsTech', input.materials)}</lido:objectMaterialsTechSet></lido:objectMaterialsTechWrap>` : ''}</lido:objectIdentificationWrap>${events ? `<lido:eventWrap>${events}</lido:eventWrap>` : ''}${subjects}</lido:descriptiveMetadata><lido:administrativeMetadata xml:lang="en"><lido:recordWrap>${identifier('recordID', recordId)}${term('recordType', 'item')}<lido:recordSource><lido:legalBodyName>${e('lido:appellationValue', '6529 artwork documentation')}</lido:legalBodyName></lido:recordSource></lido:recordWrap></lido:administrativeMetadata></lido:lido>`;
}

/** LIDO 1.1 descriptive interchange; original accounts and unprojected details remain in the dossier. */
export function buildLido(snapshot: DossierSnapshot): string {
  const { context } = snapshot;
  const agents = new Map(
    (answerValue<MuseumAgent[]>(context.modules.identity.agents) ?? []).map(
      (agent) => [agent.id, agent]
    )
  );
  const places = new Map(
    (answerValue<MuseumPlace[]>(context.modules.artwork.places) ?? []).map(
      (location) => [location.id, location]
    )
  );
  const events =
    answerValue<MuseumEvent[]>(context.modules.context.events) ?? [];
  const measurements =
    answerValue<MuseumMeasurement[]>(context.modules.artwork.measurements) ??
    [];
  const documents =
    answerValue<MuseumDocument[]>(context.modules.context.documents) ?? [];
  const source = `Artist-supplied record owned by 6529 profile ${context.owner_profile_id}; confirmation state: ${snapshot.confirmation}.`;
  const descriptions: Description[] = [];
  for (const field of ['caption', 'artist_statement']) {
    const writing = answerValue<{
      versions: {
        language: string;
        text: string;
        authorship: string;
        approved_by_artist: boolean;
      }[];
    }>(context.modules.context[field]);
    for (const version of writing?.versions ?? [])
      descriptions.push({
        kind: version.approved_by_artist ? field : `unapproved_${field}`,
        text: version.text,
        language: version.language,
        source: `${source} ${version.authorship}; artist approval recorded: ${version.approved_by_artist}.`
      });
  }
  for (const [moduleId, field, kind] of [
    ['artwork', 'description', 'artwork_description'],
    ['context', 'making_context', 'making_context']
  ] as const) {
    const text = answerValue<string>(context.modules[moduleId][field]);
    if (typeof text === 'string') descriptions.push({ kind, text, source });
  }
  const documentDescription = (document: MuseumDocument): Description => ({
    id: document.id,
    kind:
      document.authorship.startsWith('machine_') &&
      document.review_status !== 'author_reviewed'
        ? `unreviewed_${document.authorship}`
        : document.kind,
    text: document.text!,
    language: document.language,
    source: `${document.title}; ${document.authorship}; ${document.review_status}. Credited contributors: ${document.authors.map((credit) => `${agents.get(credit.agent_id)?.name ?? credit.agent_id} (${credit.role})`).join('; ')}. ${source}`
  });
  descriptions.push(
    ...documents
      .filter(
        (document) =>
          !!document.text &&
          [
            'artist_statement',
            'production_account',
            'installation',
            'care',
            'printing',
            'translation'
          ].includes(document.kind) &&
          (!document.authorship.startsWith('machine_') ||
            document.review_status === 'author_reviewed')
      )
      .map(documentDescription)
  );
  const extent = answerValue<{ kind: string; account?: string }>(
    context.modules.artwork.extent
  );
  if (extent)
    descriptions.push({
      kind: 'extent',
      text: `${extent.kind}${extent.account ? `: ${extent.account}` : ''}`,
      source
    });
  const common = (id: string) => ({
    events: events.filter((item) => item.subject_ids.includes(id)),
    measurements: measurements.filter((item) => item.subject_id === id)
  });
  const inputs: RecordInput[] = [
    {
      id: context.work_id,
      title:
        answerValue<string>(context.modules.artwork.title) ??
        'Title not supplied in draft',
      title_language: answerValue<string>(
        context.modules.artwork.title_language
      ),
      types: answerValue<string[]>(context.modules.artwork.media_profiles) ?? [
        'Artwork'
      ],
      descriptions,
      depicted_places: Array.from(places.values()).filter(
        (location) => location.role === 'depicted'
      ),
      ...common(context.work_id)
    }
  ];
  for (const object of answerValue<MuseumPhysicalObject[]>(
    context.modules.artwork.physical_objects
  ) ?? [])
    inputs.push({
      id: object.id,
      title: object.name,
      types: [object.kind],
      materials: object.materials,
      descriptions: [
        { kind: 'artist_reported_status', text: object.status, source },
        ...(object.note
          ? [{ kind: 'artist_note', text: object.note, source }]
          : []),
        ...(object.custody_note
          ? [
              {
                kind: 'artist_custody_account',
                text: object.custody_note,
                source
              }
            ]
          : []),
        ...(object.date
          ? [
              {
                kind: 'artist_reported_production_date',
                text: dateLabel(object.date),
                source
              }
            ]
          : [])
      ],
      ...common(object.id)
    });
  for (const component of answerValue<MuseumComponent[]>(
    context.modules.artwork.components
  ) ?? [])
    inputs.push({
      id: component.id,
      title: component.name,
      types: [component.kind],
      descriptions: [
        { kind: 'component_description', text: component.description, source }
      ],
      ...common(component.id)
    });
  for (const document of documents)
    inputs.push({
      id: document.id,
      title: document.title,
      title_language: document.language,
      types: ['Supporting document', document.kind],
      descriptions: document.text ? [documentDescription(document)] : [],
      ...common(document.id)
    });
  for (const asset of snapshot.assets) {
    const metadata = asset.technical_metadata_json
      ? parseJson<AssetTechnicalMetadata>(asset.technical_metadata_json)
      : null;
    const fileMeasurements = [...common(asset.id).measurements];
    const measured: [
      MuseumMeasurement['kind'],
      unknown,
      MuseumMeasurement['unit']
    ][] = [
      ['width', asset.width, 'px'],
      ['height', asset.height, 'px'],
      ['duration', metadata?.properties.duration_seconds, 's'],
      ['sample_rate', metadata?.properties.sample_rate_hz, 'Hz']
    ];
    for (const [kind, measuredValue, unit] of measured)
      if (
        typeof measuredValue === 'number' &&
        Number.isFinite(measuredValue) &&
        measuredValue > 0
      )
        fileMeasurements.push({
          id: `urn:6529:file-measurement:${asset.id}:${kind}`,
          subject_id: asset.id,
          kind,
          value: measuredValue,
          unit,
          scope: 'digital_file',
          note: 'Measured during uploaded-file characterization; separate from artist-supplied dimensions.'
        });
    inputs.push({
      id: asset.id,
      title: asset.filename,
      types: ['Digital file', asset.role],
      descriptions: [
        {
          kind: 'file_format',
          text: asset.detected_mime ?? 'Format not established',
          source: 'Uploaded-file inspection.'
        },
        ...(asset.sha256
          ? [
              {
                kind: 'file_fixity',
                text: `SHA-256 ${asset.sha256}`,
                source: 'Exact uploaded original bytes.'
              }
            ]
          : [])
      ],
      events: common(asset.id).events,
      measurements: fileMeasurements
    });
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<lido:lidoWrap xmlns:lido="http://www.lido-schema.org" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.lido-schema.org schemas/lido-v1.1.xsd">${inputs.map((input) => record(input, snapshot, agents, places)).join('')}</lido:lidoWrap>\n`;
}
