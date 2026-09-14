/** Museum draft identities remain stable when later bound to Stream subjects. */
export const MEDIA_PROFILE_IDS = [
  'photography',
  'digital_art',
  'video',
  'audio',
  'html',
  'generative',
  'interactive',
  'spatial',
  'text',
  'installation'
] as const;
export type MediaProfileId = (typeof MEDIA_PROFILE_IDS)[number];
export type MuseumDate = {
  precision: 'day' | 'month' | 'year' | 'range';
  endpoint_precision?: 'day' | 'month' | 'year';
  start: string;
  end?: string;
  approximate: boolean;
  note?: string;
};
export type MuseumAttribution = {
  agent_id: string;
  role: string;
  credit?: string;
};
export type MuseumExternalIdentifier = {
  id: string;
  namespace: string;
  identifier: string;
  uri?: string;
  note?: string;
  source_ids?: string[];
};
export type MuseumPresentationScene = {
  id: string;
  title: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  resources: {
    asset_id: string;
    role: 'painting' | 'supplementary';
    start_seconds?: number;
    end_seconds?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    source_start_seconds?: number;
    source_end_seconds?: number;
    time_mode?: 'trim' | 'loop' | 'scale';
  }[];
  annotations?: {
    id: string;
    kind: 'caption' | 'transcript' | 'description';
    language: string;
    text?: string;
    asset_id?: string;
    start_seconds?: number;
    end_seconds?: number;
  }[];
};
export type MuseumTokenReference = {
  id: string;
  chain_namespace: 'eip155';
  chain_id: string;
  contract_address: string;
  token_id: string;
  token_standard: 'erc721' | 'erc1155';
  relationship: 'represents_work' | 'prior_mint' | 'related_token';
  source_url?: string;
  note?: string;
};
export type MuseumAuthority = {
  authority: 'AAT' | 'ULAN' | 'TGN' | 'VIAF' | 'Wikidata' | 'PRONOM' | 'other';
  identifier: string;
  uri: string;
  label: string;
  match:
    | 'suggested'
    | 'exact'
    | 'close'
    | 'broader'
    | 'narrower'
    | 'unresolved';
  evidence: string;
  source_url?: string;
  retrieved_at?: string;
};
export type MuseumAgent = {
  id: string;
  kind: 'person' | 'organization' | 'software';
  name: string;
  biography?: string;
  profile_id?: string;
  authorities?: MuseumAuthority[];
  version?: string;
  note?: string;
};
export type MuseumPlace = {
  id: string;
  name: string;
  language?: string;
  role:
    | 'capture'
    | 'depicted'
    | 'creation'
    | 'production'
    | 'exhibition'
    | 'custody'
    | 'other';
  date?: MuseumDate;
  certainty: 'known' | 'approximate' | 'uncertain';
  latitude?: number;
  longitude?: number;
  note?: string;
  authorities?: MuseumAuthority[];
};
export type MuseumComponent = {
  id: string;
  kind:
    | 'visual_content'
    | 'text_content'
    | 'sound_content'
    | 'moving_image_content'
    | 'software'
    | 'realization'
    | 'component';
  name: string;
  description: string;
  asset_ids?: string[];
  media_profiles?: MediaProfileId[];
  creators?: MuseumAttribution[];
};
export type MuseumPhysicalObject = {
  id: string;
  kind:
    | 'print'
    | 'proof'
    | 'negative'
    | 'hardware'
    | 'carrier'
    | 'installation_component'
    | 'other';
  name: string;
  materials: string;
  date?: MuseumDate;
  creators?: MuseumAttribution[];
  source_asset_ids?: string[];
  custody_note?: string;
  status: 'described' | 'received' | 'not_located';
  note?: string;
};
export type MuseumMeasurement = {
  id: string;
  subject_id: string;
  kind:
    | 'width'
    | 'height'
    | 'depth'
    | 'diameter'
    | 'duration'
    | 'weight'
    | 'resolution'
    | 'frame_rate'
    | 'sample_rate'
    | 'bit_depth'
    | 'channels'
    | 'scale'
    | 'other';
  scope:
    | 'image'
    | 'sheet'
    | 'frame'
    | 'object'
    | 'digital_file'
    | 'playback'
    | 'installation'
    | 'other';
  value: number;
  unit:
    | 'px'
    | 'mm'
    | 'cm'
    | 'm'
    | 'in'
    | 's'
    | 'ms'
    | 'kg'
    | 'g'
    | 'ppi'
    | 'fps'
    | 'Hz'
    | 'bit'
    | 'channel'
    | 'ratio'
    | 'other';
  unit_label?: string;
  precision?: string;
  note?: string;
};
export type MuseumRelationship = {
  id: string;
  subject_id: string;
  object_id: string;
  relation:
    | 'component_of'
    | 'version_of'
    | 'derived_from'
    | 'realization_of'
    | 'depicts'
    | 'documents'
    | 'transcript_of'
    | 'translation_of'
    | 'reference_for'
    | 'related_work'
    | 'part_of_series';
  note?: string;
  source_ids?: string[];
};
export type MuseumDocument = {
  id: string;
  kind:
    | 'artist_statement'
    | 'production_account'
    | 'installation'
    | 'care'
    | 'printing'
    | 'research'
    | 'transcript'
    | 'translation'
    | 'reference'
    | 'other';
  title: string;
  language: string;
  text?: string;
  asset_id?: string;
  authors: MuseumAttribution[];
  authorship:
    | 'original'
    | 'translation'
    | 'machine_transcript'
    | 'machine_translation';
  review_status: 'draft' | 'author_reviewed';
  source_ids?: string[];
};
export type MuseumEvent = {
  id: string;
  kind:
    | 'capture'
    | 'creation'
    | 'completion'
    | 'production'
    | 'interview'
    | 'exhibition'
    | 'publication'
    | 'award'
    | 'prior_mint'
    | 'other';
  title: string;
  date?: MuseumDate;
  subject_ids: string[];
  participants?: MuseumAttribution[];
  place_id?: string;
  input_asset_ids?: string[];
  output_asset_ids?: string[];
  source_ids?: string[];
  account: string;
};
export type MuseumInterviewSession = {
  id: string;
  title: string;
  date: MuseumDate;
  language: string;
  mode: 'written' | 'audio' | 'video' | 'mixed';
  participants: MuseumAttribution[];
  instrument: {
    id: string;
    title: string;
    version: string;
    questions: { id: string; text: string }[];
    asset_id?: string;
  };
  transcript_text?: string;
  transcript_document_id?: string;
  transcript_asset_id?: string;
  recording_asset_ids?: string[];
  caption_asset_ids?: string[];
  segments?: {
    speaker_agent_id: string;
    start_seconds?: number;
    end_seconds?: number;
    question_id?: string;
    text: string;
  }[];
  publication_permission: 'intended_public_record';
  note?: string;
};
