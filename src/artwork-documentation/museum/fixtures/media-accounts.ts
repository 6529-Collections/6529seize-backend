import { Json } from '../../artwork-documentation.types';
export const INSTALLATION_COMPONENT_ID = '00000000-0000-4000-8000-000000000004';
export const MEDIA_CAPTURE_ACCOUNTS: Record<string, Json> = {
  photography: {
    capture_process:
      'A single exposure at the public passage, made in available light.',
    editing:
      'White balance, tonal work and dust removal; no added or removed architectural elements.',
    crop_and_color_intent:
      'Retain the complete 3:2 composition and the separation between the pale stone and the sea.'
  },
  digital_art: {
    process:
      'The composition was drawn in vector layers; the paper grain is an original scan.',
    form: 'mixed',
    scaling_and_crop:
      'Scale proportionally, keeping the complete field and transparent margins.'
  },
  video: {
    process: 'Hand-drawn frames assembled with a synchronous soundtrack.',
    duration: { kind: 'fixed', seconds: 120 },
    playback: 'Play at 24 frames per second with stereo sound.',
    looping: 'Return to the beginning after two seconds of black.',
    acceptable_transcoding:
      'Container conversion is acceptable if frame timing, color and sound remain unchanged.'
  },
  audio: {
    process:
      'A composition of field recordings and sustained electronic tones.',
    duration: { kind: 'fixed', seconds: 185.5 },
    playback: 'Four matched speakers surrounding a seated listener.',
    sequencing_and_looping:
      'Play the complete four-channel sequence once, with no crossfade.'
  },
  html: {
    entry_document: 'index.html',
    asset_tree: 'index.html, app.js, style.css and the assets directory.',
    browser_requirements:
      'A browser with WebGL 2; the included fallback explains an unavailable rendering context.',
    viewport_behavior:
      'The full composition scales to the viewport while controls retain readable size.',
    network_behavior: 'No network service is needed after initial delivery.',
    offline_behavior:
      'All assets are included; the work functions without a connection.'
  },
  generative: {
    process:
      'A seeded field of lines develops according to a fixed set of rules.',
    runtime: 'The archived JavaScript module runs in the documented browser.',
    randomness: {
      kind: 'seeded',
      account:
        'The token hash supplies the seed; pseudorandom draws follow the archived implementation.'
    },
    permissible_variation:
      'Timing may vary, but geometry from a given seed must match the reference.',
    reexecution_criteria:
      'Compare fixed reference seeds at the documented checkpoints.'
  },
  interactive: {
    interaction_rules:
      'Dragging a point changes the path of a recurring phrase.',
    controls: 'Pointer dragging or arrow keys.',
    state_and_reset:
      'Reloading returns the phrase and point to their original positions.',
    essential_interactions:
      'Moving the point must change the phrase continuously, without discrete jumps.'
  },
  spatial: {
    scene_description:
      'A room-scale arrangement of translucent geometric forms.',
    units_and_coordinates:
      'Meters; Y is up; the origin is at the center of the floor.',
    engine_and_runtime:
      'The included glTF scene is interpreted using the documented PBR renderer.',
    devices_and_controllers:
      'A six-degree-of-freedom headset, with seated access supported.'
  },
  text: {
    authoritative_text:
      'The door remembers every hand.\nThe wall remembers none.',
    languages: ['en'],
    typography: 'Use the supplied typeface and its original spacing.',
    layout: 'Two lines aligned to the left edge of the central field.',
    reading_order: 'Read from the first line to the second.',
    presentation: 'fixed'
  },
  installation: {
    account:
      'A photographic print faces a speaker across an otherwise empty room.',
    component_ids: [INSTALLATION_COMPONENT_ID],
    installation_instructions:
      'Hang the image at eye level and position the speaker three meters opposite it.',
    ordering_and_synchronization:
      'The photograph remains visible throughout the sound sequence.',
    replacement_constraints:
      'Replace hardware with equivalents that preserve the documented frequency range and placement.'
  }
};
