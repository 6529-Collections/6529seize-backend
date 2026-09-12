import { FieldDefinition, ValueSchema } from '../artwork-documentation.types';
import { MEDIA_PROFILE_IDS, MediaProfileId } from './museum-record.types';
import {
  assetIds,
  bool,
  choice,
  integer,
  list,
  numeric,
  object,
  text,
  uuid
} from './museum-schema';

const tools = list(
  object({ name: text(300), version: text(100), purpose: text(2000) }, [
    'name',
    'purpose'
  ]),
  100
);
const dependencies = list(
  object(
    {
      name: text(300),
      version: text(300),
      purpose: text(6000),
      kind: choice(
        'library',
        'font',
        'runtime',
        'hardware',
        'data',
        'service',
        'blockchain',
        'other'
      ),
      required: bool,
      bundled: bool,
      asset_id: uuid,
      source: text(2048),
      failure_behavior: text(6000)
    },
    ['name', 'kind', 'purpose', 'required', 'bundled']
  ),
  500
);
const pixels = object({ width: integer(1), height: integer(1) });
const time = object(
  {
    kind: choice('fixed', 'variable', 'continuous'),
    seconds: numeric(),
    note: text(6000)
  },
  ['kind']
);
const media: Record<
  MediaProfileId,
  { label: string; description: string; schema: ValueSchema }
> = {
  photography: {
    label: 'Photography',
    description:
      'The circumstances of capture, the decisions that shaped the image, and the materials needed to preserve its appearance.',
    schema: object(
      {
        capture_process: text(50000),
        equipment: tools,
        source_asset_ids: assetIds,
        editing: text(50000),
        composite: bool,
        dimensions: pixels,
        color_space: text(300),
        bit_depth: numeric(1, 128),
        master_asset_ids: assetIds,
        print_instructions: text(150000),
        proof_asset_ids: assetIds,
        crop_and_color_intent: text(20000)
      },
      ['capture_process', 'editing', 'crop_and_color_intent']
    )
  },
  digital_art: {
    label: 'Digital painting, illustration & collage',
    description:
      'Record the making of the image, its source projects, and how scale, color, texture and transparency should be carried forward.',
    schema: object(
      {
        process: text(50000),
        tools,
        form: choice('raster', 'vector', 'mixed'),
        source_asset_ids: assetIds,
        contributing_material: text(20000),
        layers: text(20000),
        typography: text(12000),
        color_space: text(300),
        transparency: text(6000),
        scaling_and_crop: text(20000),
        master_asset_ids: assetIds,
        dependencies
      },
      ['process', 'form', 'scaling_and_crop']
    )
  },
  video: {
    label: 'Video, animation & motion',
    description:
      'Describe time, motion and sound as experienced, alongside the master and the conditions needed for faithful playback.',
    schema: object(
      {
        process: text(50000),
        duration: time,
        frame_rate: numeric(0.001, 10000),
        dimensions: pixels,
        codec: text(300),
        container: text(300),
        color_and_hdr: text(12000),
        audio_tracks: text(12000),
        playback: text(20000),
        looping: text(12000),
        synchronization: text(12000),
        caption_asset_ids: assetIds,
        master_asset_ids: assetIds,
        source_asset_ids: assetIds,
        acceptable_transcoding: text(20000)
      },
      ['process', 'duration', 'playback', 'looping', 'acceptable_transcoding']
    )
  },
  audio: {
    label: 'Audio, sound & music',
    description:
      'Describe the intended listening experience and retain the technical and creative choices that determine it.',
    schema: object(
      {
        process: text(50000),
        duration: time,
        sample_rate_hz: numeric(1),
        bit_depth: numeric(1, 128),
        channels: numeric(1, 4096),
        spatial_layout: text(12000),
        codec: text(300),
        container: text(300),
        playback: text(20000),
        level: text(6000),
        sequencing_and_looping: text(12000),
        master_asset_ids: assetIds,
        stem_asset_ids: assetIds,
        source_asset_ids: assetIds
      },
      ['process', 'duration', 'playback', 'sequencing_and_looping']
    )
  },
  html: {
    label: 'HTML & web',
    description:
      'Describe the complete web work, its point of entry and its behavior when networks, browsers or services change.',
    schema: object(
      {
        entry_document: text(1024),
        package_asset_ids: assetIds,
        asset_tree: text(50000),
        dependencies,
        browser_requirements: text(20000),
        viewport_behavior: text(20000),
        input_methods: text(12000),
        network_behavior: text(20000),
        offline_behavior: text(20000),
        storage_behavior: text(12000),
        reference_asset_ids: assetIds,
        accessibility: text(20000)
      },
      [
        'entry_document',
        'asset_tree',
        'browser_requirements',
        'viewport_behavior',
        'network_behavior',
        'offline_behavior'
      ]
    )
  },
  generative: {
    label: 'Generative & software',
    description:
      'Identify what makes each realization a realization of this work: code, rules, inputs, randomness and the permitted range of change.',
    schema: object(
      {
        process: text(50000),
        source_asset_ids: assetIds,
        build_instructions: text(50000),
        runtime: text(20000),
        dependencies,
        parameters: text(20000),
        randomness: object({
          kind: choice('deterministic', 'seeded', 'unseeded', 'external'),
          account: text(20000)
        }),
        state: text(20000),
        chain_and_data_inputs: text(20000),
        reference_asset_ids: assetIds,
        permissible_variation: text(20000),
        reexecution_criteria: text(20000)
      },
      [
        'process',
        'runtime',
        'randomness',
        'permissible_variation',
        'reexecution_criteria'
      ]
    )
  },
  interactive: {
    label: 'Interactive work, games & participation',
    description:
      'Explain what a participant can do, how the work responds, and which interactions carry its meaning.',
    schema: object(
      {
        interaction_rules: text(50000),
        controls: text(20000),
        duration: time,
        state_and_reset: text(20000),
        participation: text(20000),
        network_behavior: text(20000),
        failure_modes: text(20000),
        essential_interactions: text(20000),
        optional_interactions: text(12000),
        reference_asset_ids: assetIds,
        accessibility: text(20000)
      },
      [
        'interaction_rules',
        'controls',
        'state_and_reset',
        'essential_interactions'
      ]
    )
  },
  spatial: {
    label: '3D, spatial, AR & VR',
    description:
      'Describe scale, materials and spatial experience, including the devices and environment that make the work legible.',
    schema: object(
      {
        scene_description: text(50000),
        model_asset_ids: assetIds,
        texture_asset_ids: assetIds,
        units_and_coordinates: text(12000),
        materials: text(20000),
        rigging_and_animation: text(20000),
        camera_and_lighting: text(20000),
        engine_and_runtime: text(20000),
        devices_and_controllers: text(20000),
        spatial_audio: text(12000),
        reference_asset_ids: assetIds,
        dependencies
      },
      [
        'scene_description',
        'units_and_coordinates',
        'engine_and_runtime',
        'devices_and_controllers'
      ]
    )
  },
  text: {
    label: 'Text, poetry & publications',
    description:
      'Retain the authoritative text and describe the relationship between language, typography, sequence and the space of reading.',
    schema: object(
      {
        authoritative_text: text(500000),
        source_asset_ids: assetIds,
        languages: list({ ...text(64), format: 'bcp47' }, 30, 1),
        typography: text(20000),
        layout: text(20000),
        reading_order: text(20000),
        pagination: text(6000),
        embedded_media_asset_ids: assetIds,
        presentation: choice('fixed', 'reflowable', 'variable'),
        accessible_text: text(500000),
        dependencies
      },
      ['languages', 'typography', 'layout', 'reading_order', 'presentation']
    )
  },
  installation: {
    label: 'Installation, performance & mixed media',
    description:
      'Describe the work as a whole and the relationships among its components, site, hardware and individual realizations.',
    schema: object(
      {
        account: text(50000),
        component_ids: { ...list(uuid, 500), uniqueItems: true },
        installation_instructions: text(150000),
        hardware: tools,
        site_conditions: text(20000),
        ordering_and_synchronization: text(20000),
        replacement_constraints: text(20000),
        realization_account: text(50000),
        reference_asset_ids: assetIds,
        dependencies
      },
      [
        'account',
        'component_ids',
        'installation_instructions',
        'ordering_and_synchronization',
        'replacement_constraints'
      ]
    )
  }
};

export const MUSEUM_MEDIA_PROFILES = MEDIA_PROFILE_IDS.map((id) => ({
  id,
  label: media[id].label,
  description: media[id].description,
  required_fields: [`process.${id}`]
}));

export const MUSEUM_MEDIA_FIELDS: FieldDefinition[] = MEDIA_PROFILE_IDS.map(
  (id) => ({
    id,
    label: media[id].label,
    guidance: media[id].description,
    chapter: 'making',
    editor: 'structured',
    media_profiles: [id],
    required_for_media: true,
    value_schema: media[id].schema,
    allowed_statuses: ['provided'],
    default_visibility: 'public_record',
    locked_restricted: false
  })
);
