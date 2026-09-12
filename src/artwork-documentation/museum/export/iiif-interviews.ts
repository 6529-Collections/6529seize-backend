import { ContextRecord } from '../../artwork-documentation.types';
import { answerValue } from '../../artwork-documentation.validation';
import {
  MuseumAgent,
  MuseumDocument,
  MuseumInterviewSession,
  MuseumPresentationScene
} from '../museum-record.types';
import {
  annotation,
  contentResource,
  fragment,
  IiifEnvironment,
  iiifIssue,
  IiifResource,
  mediaFacts,
  SceneResource,
  textBody
} from './iiif-resources';

function translatedTime(
  segment: NonNullable<MuseumInterviewSession['segments']>[number],
  resource: SceneResource,
  env: IiifEnvironment
) {
  if (
    segment.start_seconds === undefined ||
    segment.end_seconds === undefined ||
    resource.time_mode === 'loop'
  )
    return null;
  const asset = env.assets.get(resource.asset_id);
  if (!asset) return null;
  const sourceStart = resource.source_start_seconds ?? 0;
  const sourceEnd = resource.source_end_seconds ?? mediaFacts(asset).duration;
  const targetStart = resource.start_seconds ?? 0;
  const targetEnd =
    resource.end_seconds ?? targetStart + sourceEnd - sourceStart;
  if (segment.start_seconds < sourceStart || segment.end_seconds > sourceEnd)
    return null;
  const scale =
    resource.time_mode === 'scale'
      ? (targetEnd - targetStart) / (sourceEnd - sourceStart)
      : 1;
  const start = targetStart + (segment.start_seconds - sourceStart) * scale;
  const end = targetStart + (segment.end_seconds - sourceStart) * scale;
  return end <= targetEnd ? { start_seconds: start, end_seconds: end } : null;
}
function sessionAnnotations(
  session: MuseumInterviewSession,
  scene: MuseumPresentationScene,
  context: ContextRecord,
  env: IiifEnvironment
): IiifResource[] {
  const resources = scene.resources.filter((resource) =>
    session.recording_asset_ids?.includes(resource.asset_id)
  );
  if (!resources.length) return [];
  const target = `${env.prefix}/canvas/${scene.id}`;
  const id = `${env.prefix}/annotation/${scene.id}/interview-${session.id}`;
  const result: IiifResource[] = [];
  const documents =
    answerValue<MuseumDocument[]>(context.modules.context.documents) ?? [];
  const document = documents.find(
    (item) => item.id === session.transcript_document_id
  );
  const transcript = session.transcript_text ?? document?.text;
  if (transcript)
    result.push(
      annotation(
        `${id}/transcript`,
        target,
        textBody(transcript, session.language)
      )
    );
  const files = [
    session.transcript_asset_id,
    document?.asset_id,
    ...(session.caption_asset_ids ?? [])
  ].filter((file): file is string => !!file);
  for (const assetId of Array.from(new Set(files))) {
    const body = contentResource(env, assetId);
    if (body)
      result.push(
        annotation(`${id}/file-${assetId}`, target, {
          ...body,
          language: session.language
        })
      );
  }
  const agents = new Map(
    (answerValue<MuseumAgent[]>(context.modules.identity.agents) ?? []).map(
      (agent) => [agent.id, agent]
    )
  );
  for (const [index, segment] of Array.from(
    (session.segments ?? []).entries()
  )) {
    // A multi-recording session has no declared per-segment source. Never invent alignment.
    const region =
      session.recording_asset_ids?.length === 1 && resources.length === 1
        ? translatedTime(segment, resources[0], env)
        : null;
    if (!region && segment.start_seconds !== undefined)
      iiifIssue(
        env,
        `interview:${session.id}/segment:${index}`,
        'This transcript segment has no unambiguous timing in the selected scene. Its text and original timecodes remain in the record.'
      );
    const speaker = agents.get(segment.speaker_agent_id)?.name;
    result.push({
      ...annotation(
        `${id}/segment-${index}`,
        fragment(target, region ?? {}),
        textBody(segment.text, session.language)
      ),
      ...(speaker ? { label: { none: [speaker] } } : {})
    });
  }
  return result;
}
export function interviewAnnotations(
  context: ContextRecord,
  scene: MuseumPresentationScene,
  env: IiifEnvironment
): IiifResource[] {
  return (
    answerValue<MuseumInterviewSession[]>(context.modules.interview.sessions) ??
    []
  ).flatMap((session) => sessionAnnotations(session, scene, context, env));
}
