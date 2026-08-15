import { AuthenticationContext } from '@/auth-context';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import {
  DropCreationApiService,
  dropCreationService
} from '@/api/drops/drop-creation.api.service';
import { env } from '@/env';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { isReleaseBusGitHubAppActor } from '@/releaseBusV2/release-bus-v2.constants';
import {
  releaseNoteGenerationQueue,
  ReleaseNoteGenerationQueue
} from '@/release-notes/release-note-generation-queue';
import {
  GITHUB_TO_6529_HANDLES,
  isHumanGithubContributorLogin
} from '@/release-notes/release-note-contributors.config';
import { isAllowedReleaseNotesPrompt } from '@/release-notes/release-note-prompts.config';
import { DEVS_6529_MENTION } from '@/constants/mentions';
import {
  ciPipelineAlertTargetStore,
  CiPipelineAlertTargetStore,
  CiPipelineDeployAlertTarget
} from './ci-pipeline-alert-target.store';

export type CiPipelineAlertStatus = 'success' | 'failure';
export type CiPipelineAlertType = 'workflow' | 'deploy' | 'web_e2e';

export interface CiPipelineReleaseNoteGroup {
  readonly release_group_id: string;
  readonly release_group_services: string[];
  readonly pull_request_number: number;
  readonly publish_release_note: boolean;
}

export interface CiPipelineAlertRequest {
  readonly alert_type?: CiPipelineAlertType;
  readonly repo: string;
  readonly workflow: string;
  readonly status: CiPipelineAlertStatus;
  readonly title: string;
  readonly description?: string | null;
  readonly triggered_by_github_login?: string | null;
  readonly run_id: string;
  readonly run_number?: string | null;
  readonly run_url: string;
  readonly sha?: string | null;
  readonly branch?: string | null;
  readonly environment?: string | null;
  readonly service?: string | null;
  readonly run_attempt?: number | null;
  readonly parent_deploy_run_id?: string | null;
  readonly parent_release_train_id?: string | null;
  readonly validation_pack?: string | null;
  readonly release_train_id?: string | null;
  readonly release_operation_key?: string | null;
  readonly contributor_github_logins?: string[];
  readonly contributor_evidence?:
    | 'release-bus-operation'
    | 'manual-pr'
    | 'manual-range'
    | null;
  readonly release_notes_prompt_path?: string | null;
  readonly release_group_id?: string | null;
  readonly release_group_services?: string[];
  readonly pull_request_number?: number | null;
  readonly publish_release_note?: boolean;
  readonly release_note_groups?: CiPipelineReleaseNoteGroup[];
  readonly deployed_at?: string | null;
}

interface NormalizedReleaseNoteGroup {
  readonly releaseGroupId: string;
  readonly releaseGroupServices: string[];
  readonly pullRequestNumber: number | null;
  readonly publishReleaseNote: boolean;
}

interface MentionedProfile {
  readonly profileId: string;
  readonly handle: string;
}

interface AlertMentions {
  readonly triggeredBy: MentionedProfile | null;
  readonly contributors: ReadonlyArray<{
    readonly githubLogin: string;
    readonly profile: MentionedProfile | null;
  }>;
  readonly deployInitiator: MentionedProfile | null;
  readonly all: MentionedProfile[];
}

export interface CiPipelineAlertOutcome {
  readonly ci_drop: 'accepted';
  readonly release_note: 'ineligible' | 'skipped' | 'enqueued' | 'queue-failed';
  readonly release_note_reason?: string;
}

const MAX_DROP_CONTENT_LENGTH = 30000;
const MAX_DROP_TITLE_LENGTH = 250;
const MAX_ALERT_DESCRIPTION_LENGTH = 5000;

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const requestedEnd = maxLength - 3;
  const sliceEnd = /[\uD800-\uDBFF]/.test(value.charAt(requestedEnd - 1))
    ? requestedEnd - 1
    : requestedEnd;
  return `${value.slice(0, sliceEnd)}...`;
}

function normalizeOptionalValue(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function compareInvariant(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requestedReleaseNoteGroups(
  request: CiPipelineAlertRequest
): CiPipelineReleaseNoteGroup[] {
  return (
    request.release_note_groups ?? [
      {
        release_group_id:
          normalizeOptionalValue(request.release_group_id) ?? '',
        release_group_services: request.release_group_services ?? [],
        pull_request_number: request.pull_request_number ?? 0,
        publish_release_note: request.publish_release_note ?? false
      }
    ]
  );
}

function normalizeReleaseNoteGroup(
  group: CiPipelineReleaseNoteGroup,
  service: string | null | undefined,
  requiresPullRequest: boolean
): NormalizedReleaseNoteGroup | null {
  const releaseGroupId = normalizeOptionalValue(group.release_group_id);
  const releaseGroupServices = Array.from(
    new Set(
      group.release_group_services
        .map((groupService) => groupService.trim())
        .filter(Boolean)
    )
  ).sort(compareInvariant);
  const pullRequestNumber = group.pull_request_number || null;
  if (
    !releaseGroupId ||
    !releaseGroupServices.length ||
    (service && !releaseGroupServices.includes(service)) ||
    (requiresPullRequest && pullRequestNumber === null)
  ) {
    return null;
  }
  return {
    releaseGroupId,
    releaseGroupServices,
    pullRequestNumber,
    publishReleaseNote: group.publish_release_note
  };
}

export function normalizeTargetEnvironment(value: string | null | undefined) {
  const normalizedValue = normalizeOptionalValue(value)?.toLowerCase();
  if (normalizedValue === 'staging') {
    return 'staging';
  }
  if (normalizedValue === 'prod' || normalizedValue === 'production') {
    return 'prod';
  }
  return null;
}

export function normalizeContributorGithubLogins(
  values: readonly string[] | null | undefined
): string[] {
  const logins: string[] = [];
  for (const value of values ?? []) {
    const login = value.trim();
    if (
      !isHumanGithubContributorLogin(login) ||
      logins.some((existing) => existing.toLowerCase() === login.toLowerCase())
    )
      continue;
    logins.push(login);
  }
  return logins;
}

function expectedReleaseBusWorkflow(
  repo: string | undefined,
  environment: 'staging' | 'prod'
): string | null {
  if (repo === '6529seize-frontend') {
    return environment === 'staging'
      ? 'Release Bus - Deploy Frontend Staging'
      : 'Release Bus - Deploy Frontend Production';
  }
  if (repo === '6529seize-backend') {
    return 'Deploy a service';
  }
  return null;
}

export function isVerifiedReleaseBusAlert(
  request: CiPipelineAlertRequest
): boolean {
  const trainId = normalizeOptionalValue(request.release_train_id);
  const operationKey = normalizeOptionalValue(request.release_operation_key);
  const environment = normalizeTargetEnvironment(request.environment);
  if (
    !trainId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      trainId
    ) ||
    !operationKey ||
    !environment ||
    !isReleaseBusGitHubAppActor(request.triggered_by_github_login)
  ) {
    return false;
  }
  const repo = request.repo.split('/').pop();
  const expectedWorkflow = expectedReleaseBusWorkflow(repo, environment);
  if (request.workflow !== expectedWorkflow) return false;
  const parts = operationKey.split(':');
  const attempt = parts.at(-1);
  if (!attempt || !/^a[1-9]\d{0,8}$/.test(attempt)) return false;
  if (repo === '6529seize-frontend') {
    return (
      parts.length === 6 &&
      parts[0] === 'rb2' &&
      parts[1] === trainId &&
      parts[2] === 'deploy' &&
      parts[3] === environment &&
      parts[4] === 'frontend'
    );
  }
  const service = normalizeOptionalValue(request.service);
  return (
    repo === '6529seize-backend' &&
    !!service &&
    parts.length === 7 &&
    parts[0] === 'rb2' &&
    parts[1] === trainId &&
    parts[2] === 'deploy' &&
    parts[3] === environment &&
    parts[4] === 'backend' &&
    parts[5] === service
  );
}

export function verifiedContributorGithubLogins(
  request: CiPipelineAlertRequest
): string[] {
  const evidence = request.contributor_evidence;
  if (
    evidence === 'release-bus-operation' &&
    isVerifiedReleaseBusAlert(request)
  ) {
    return normalizeContributorGithubLogins(request.contributor_github_logins);
  }
  if (
    (evidence === 'manual-pr' || evidence === 'manual-range') &&
    !normalizeOptionalValue(request.release_train_id) &&
    !normalizeOptionalValue(request.release_operation_key) &&
    !isReleaseBusGitHubAppActor(request.triggered_by_github_login)
  ) {
    return normalizeContributorGithubLogins(request.contributor_github_logins);
  }
  return [];
}

function formatStatusEmoji(status: CiPipelineAlertStatus): string {
  return status === 'success' ? '✅' : '🚨';
}

function sanitizeAlertText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[[\]<>]/g, (character) => `\\${character}`)
    .trim();
}

function formatAlertHeading(request: CiPipelineAlertRequest): string {
  const environmentPrefix = formatEnvironmentPrefix(request.environment);
  const statusEmoji = formatStatusEmoji(request.status);
  const statusSuffix = ` ${statusEmoji}`;
  const title = sanitizeAlertText(
    normalizeOptionalValue(request.title) ?? request.workflow
  )
    .replace(/✅|❌|🚨/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncatedTitle = truncate(
    title,
    MAX_DROP_TITLE_LENGTH - environmentPrefix.length - statusSuffix.length
  );
  return `${environmentPrefix}${truncatedTitle}${statusSuffix}`;
}

function formatEnvironmentPrefix(value: string | null | undefined): string {
  const targetEnvironment = normalizeTargetEnvironment(value);
  if (targetEnvironment === 'staging') {
    return '[🚧 STAGING] ';
  }
  if (targetEnvironment === 'prod') {
    return '[🚀 PRODUCTION] ';
  }
  return `[${formatEnvironmentLabel(value)}] `;
}

function formatEnvironmentLabel(value: string | null | undefined): string {
  const targetEnvironment = normalizeTargetEnvironment(value);
  return (
    targetEnvironment ??
    normalizeOptionalValue(value) ??
    'ci'
  ).toUpperCase();
}

function formatRepoLabel(repo: string): string {
  const repoName = repo.split('/').pop() ?? repo;
  if (repoName === '6529seize-backend') {
    return 'Backend';
  }
  if (repoName === '6529seize-frontend') {
    return 'Frontend';
  }
  if (repoName === '6529-core') {
    return 'Core';
  }
  return repoName;
}

function formatServiceLabel(request: CiPipelineAlertRequest): string {
  const repoLabel = formatRepoLabel(request.repo);
  const service = normalizeOptionalValue(request.service);
  if (repoLabel === 'Core') {
    if (service?.toLowerCase() === 'desktop') {
      return '6529 Desktop';
    }
    return service ? `${repoLabel} - ${service}` : repoLabel;
  }
  return service ?? repoLabel;
}

function formatInitiator(
  request: CiPipelineAlertRequest,
  mentions: AlertMentions
): string {
  if (isVerifiedReleaseBusAlert(request)) {
    return 'Release Train';
  }
  if (mentions.triggeredBy) {
    return '@[' + mentions.triggeredBy.handle + ']';
  }
  const githubLogin = normalizeOptionalValue(request.triggered_by_github_login);
  return githubLogin && isHumanGithubContributorLogin(githubLogin)
    ? formatMarkdownLink(githubLogin, `https://github.com/${githubLogin}`)
    : 'unknown';
}

function getGithubRepoUrl(request: CiPipelineAlertRequest): string | null {
  try {
    const runUrl = new URL(request.run_url);
    const [owner, repo] = runUrl.pathname.split('/').filter(Boolean);
    if (!owner || !repo) {
      return null;
    }
    return `${runUrl.origin}/${owner}/${repo}`;
  } catch {
    return null;
  }
}

function replaceAllLiteral(
  value: string,
  searchValue: string,
  replaceValue: string
): string {
  return (
    value as string & {
      replaceAll(searchValue: string, replaceValue: string): string;
    }
  ).replaceAll(searchValue, replaceValue);
}

export function formatMarkdownLink(label: string, url: string): string {
  const escapedLabel = replaceAllLiteral(
    replaceAllLiteral(label, '[', String.raw`\[`),
    ']',
    String.raw`\]`
  );
  return `[${escapedLabel}](${url})`;
}

function formatCommit(
  request: CiPipelineAlertRequest,
  shaOverride?: string | null
): string | null {
  const sha = normalizeOptionalValue(shaOverride ?? request.sha);
  if (!sha) {
    return null;
  }
  const shortSha = sha.slice(0, 8);
  const repoUrl = getGithubRepoUrl(request);
  return repoUrl
    ? formatMarkdownLink(shortSha, `${repoUrl}/commit/${sha}`)
    : shortSha;
}

function formatRun(
  request: CiPipelineAlertRequest,
  includeAttempt: boolean
): string {
  const { runLabel, attemptSuffix } = getRunLabelParts(request);
  return `${formatMarkdownLink(runLabel, request.run_url)}${includeAttempt ? attemptSuffix : ''}`;
}

function formatWebE2ESuccessRun(request: CiPipelineAlertRequest): string {
  const { runLabel, attemptSuffix } = getRunLabelParts(request);
  return formatMarkdownLink(`Run ${runLabel}${attemptSuffix}`, request.run_url);
}

function getRunLabelParts(request: CiPipelineAlertRequest): {
  readonly runLabel: string;
  readonly attemptSuffix: string;
} {
  const runNumber = normalizeOptionalValue(request.run_number);
  const attempt = request.run_attempt ?? 1;
  return {
    runLabel: `#${runNumber ?? request.run_id}`,
    attemptSuffix: attempt > 1 ? ` (attempt ${attempt})` : ''
  };
}

function isWebE2EAlert(request: CiPipelineAlertRequest): boolean {
  return request.alert_type === 'web_e2e';
}

function isSuccessfulWebDeployAlert(request: CiPipelineAlertRequest): boolean {
  return (
    request.alert_type === 'deploy' &&
    request.status === 'success' &&
    request.repo === '6529seize-frontend' &&
    normalizeOptionalValue(request.service) === 'web'
  );
}

function isAutomationActor(value: string | null | undefined): boolean {
  const login = normalizeOptionalValue(value)?.toLowerCase();
  return login === 'github-actions[bot]' || isReleaseBusGitHubAppActor(login);
}

function getMappedProfileHandle(githubLogin: string | null): string | null {
  if (!githubLogin || isAutomationActor(githubLogin)) return null;
  return GITHUB_TO_6529_HANDLES[githubLogin.toLowerCase()] ?? null;
}

export class CiPipelineAlertService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly dropCreationApiService: DropCreationApiService,
    private readonly identitiesRepository: IdentitiesDb,
    private readonly releaseNotesQueue: ReleaseNoteGenerationQueue = releaseNoteGenerationQueue,
    private readonly alertTargetStore: CiPipelineAlertTargetStore = ciPipelineAlertTargetStore
  ) {}

  public async postAlert(
    request: CiPipelineAlertRequest,
    ctx: RequestContext
  ): Promise<CiPipelineAlertOutcome> {
    const waveId = this.resolveWaveId(request);
    const botProfileId = env.getStringOrThrow('CI_PIPELINES_BOT_PROFILE_ID');
    const deployTarget = isWebE2EAlert(request)
      ? await this.resolveDeployTarget(request)
      : null;
    const mentions = await this.resolveAlertMentions(request, deployTarget);

    const createDropRequest = this.buildCreateDropRequest({
      request,
      waveId,
      mentions,
      deployTarget
    });
    const authenticationContext =
      AuthenticationContext.fromProfileId(botProfileId);

    const drop = await this.dropCreationApiService.createDrop(
      {
        createDropRequest,
        authorId: botProfileId,
        representativeId: botProfileId,
        hideLinkPreview: true
      },
      {
        ...ctx,
        authenticationContext
      }
    );

    if (isSuccessfulWebDeployAlert(request)) {
      const environment = normalizeTargetEnvironment(request.environment);
      const firstPart = drop.parts?.[0];
      if (!environment) {
        this.logger.warn(
          `Unable to remember WEB deploy reply target for ${request.repo} run ${request.run_id}: unsupported environment ${request.environment ?? 'missing'}`
        );
      } else if (firstPart) {
        await this.alertTargetStore.rememberDeployTarget(
          {
            repo: request.repo,
            environment,
            runId: request.run_id,
            releaseTrainId: request.release_train_id
          },
          {
            dropId: drop.id,
            dropPartId: firstPart.part_id,
            sha: normalizeOptionalValue(request.sha),
            triggeredByGithubLogin: normalizeOptionalValue(
              request.triggered_by_github_login
            )
          }
        );
      } else {
        this.logger.warn(
          `Unable to remember WEB deploy reply target for ${request.repo} run ${request.run_id}: created drop has no parts`
        );
      }
    }

    return {
      ci_drop: 'accepted',
      ...(await this.enqueueReleaseNotesIfEligible(request))
    };
  }

  private async resolveDeployTarget(
    request: CiPipelineAlertRequest
  ): Promise<CiPipelineDeployAlertTarget | null> {
    const environment = normalizeTargetEnvironment(request.environment);
    if (!environment) return null;
    return this.alertTargetStore.resolveDeployTarget({
      repo: request.repo,
      environment,
      runId: normalizeOptionalValue(request.parent_deploy_run_id),
      releaseTrainId: normalizeOptionalValue(request.parent_release_train_id)
    });
  }

  private async enqueueReleaseNotesIfEligible(
    request: CiPipelineAlertRequest
  ): Promise<
    Pick<CiPipelineAlertOutcome, 'release_note' | 'release_note_reason'>
  > {
    const promptPath = normalizeOptionalValue(
      request.release_notes_prompt_path
    );
    const sha = normalizeOptionalValue(request.sha);
    const deployedAt = normalizeOptionalValue(request.deployed_at);
    const isBackendRelease =
      request.repo.split('/').pop() === '6529seize-backend';
    if (
      request.status !== 'success' ||
      normalizeTargetEnvironment(request.environment) !== 'prod' ||
      !promptPath ||
      !sha ||
      !deployedAt
    ) {
      return {
        release_note: 'ineligible',
        release_note_reason: 'not-a-successful-production-release'
      };
    }
    if (!isAllowedReleaseNotesPrompt(request.repo, promptPath)) {
      this.logger.warn(
        `Skipping release notes for unsupported prompt path ${promptPath} in ${request.repo}`
      );
      return {
        release_note: 'skipped',
        release_note_reason: 'unsupported-prompt-path'
      };
    }

    const structuredGroups = request.release_note_groups !== undefined;
    const { enqueued, queueFailures } = await this.enqueueReleaseNoteGroups({
      request,
      promptPath,
      sha,
      deployedAt,
      isBackendRelease,
      structuredGroups
    });
    if (queueFailures > 0) {
      return {
        release_note: 'queue-failed',
        release_note_reason: `${queueFailures}-of-${enqueued + queueFailures}-requests`
      };
    }
    if (enqueued > 0) return { release_note: 'enqueued' };
    return {
      release_note: 'skipped',
      release_note_reason: structuredGroups
        ? 'no-valid-release-note-groups'
        : 'release-note-group-metadata-missing'
    };
  }

  private async enqueueReleaseNoteGroups({
    request,
    promptPath,
    sha,
    deployedAt,
    isBackendRelease,
    structuredGroups
  }: {
    readonly request: CiPipelineAlertRequest;
    readonly promptPath: string;
    readonly sha: string;
    readonly deployedAt: string;
    readonly isBackendRelease: boolean;
    readonly structuredGroups: boolean;
  }): Promise<{ enqueued: number; queueFailures: number }> {
    let enqueued = 0;
    let queueFailures = 0;
    const contributorGithubLogins = verifiedContributorGithubLogins(request);
    for (const group of requestedReleaseNoteGroups(request)) {
      const normalizedGroup = normalizeReleaseNoteGroup(
        group,
        request.service,
        isBackendRelease
      );
      if (!normalizedGroup) {
        if (structuredGroups) {
          throw new Error(
            `Malformed structured release-note group ${group.release_group_id || 'missing'} for ${request.repo} run ${request.run_id}`
          );
        }
        this.logger.warn(
          `Skipping malformed release-note group ${group.release_group_id || 'missing'} for ${request.repo} run ${request.run_id}`
        );
        continue;
      }
      const queueOutcome = await this.releaseNotesQueue.enqueueBestEffort({
        repo: request.repo,
        workflow: request.workflow,
        run_id: request.run_id,
        run_number: request.run_number,
        run_url: request.run_url,
        sha,
        branch: request.branch,
        environment: 'prod',
        service: request.service,
        ...(normalizeOptionalValue(request.release_train_id)
          ? {
              release_train_id: normalizeOptionalValue(request.release_train_id)
            }
          : {}),
        ...(normalizeOptionalValue(request.release_operation_key)
          ? {
              release_operation_key: normalizeOptionalValue(
                request.release_operation_key
              )
            }
          : {}),
        prompt_path: promptPath,
        release_group_id: normalizedGroup.releaseGroupId,
        release_group_services: normalizedGroup.releaseGroupServices,
        pull_request_number: normalizedGroup.pullRequestNumber,
        ...(contributorGithubLogins.length
          ? { contributor_github_logins: contributorGithubLogins }
          : {}),
        publish_release_note: normalizedGroup.publishReleaseNote,
        deployed_at: deployedAt
      });
      if (queueOutcome === 'enqueued') enqueued += 1;
      else queueFailures += 1;
    }
    return { enqueued, queueFailures };
  }

  private async resolveAlertMentions(
    request: CiPipelineAlertRequest,
    deployTarget: CiPipelineDeployAlertTarget | null
  ): Promise<AlertMentions> {
    if (isWebE2EAlert(request) && request.status === 'success') {
      return {
        triggeredBy: null,
        contributors: [],
        deployInitiator: null,
        all: []
      };
    }
    const triggeredByGithubLogin = normalizeOptionalValue(
      request.triggered_by_github_login
    );
    const isReleaseTrain = isVerifiedReleaseBusAlert(request);
    const triggeredByHandle =
      triggeredByGithubLogin && !isReleaseTrain
        ? getMappedProfileHandle(triggeredByGithubLogin)
        : null;
    const deployInitiatorGithubLogin = normalizeOptionalValue(
      deployTarget?.triggeredByGithubLogin
    );
    const deployInitiatorHandle = getMappedProfileHandle(
      deployInitiatorGithubLogin
    );
    if (!triggeredByGithubLogin) {
      this.logger.warn(
        'Unable to resolve CI workflow initiator: GitHub login is missing'
      );
    } else if (
      !isAutomationActor(triggeredByGithubLogin) &&
      !triggeredByHandle
    ) {
      this.logger.warn(
        `Unable to resolve CI workflow initiator ${triggeredByGithubLogin}: 6529 profile mapping is missing`
      );
    }

    const contributorGithubLogins = verifiedContributorGithubLogins(request);
    const contributorHandles = contributorGithubLogins
      .map((login) => GITHUB_TO_6529_HANDLES[login.toLowerCase()])
      .filter((handle): handle is string => Boolean(handle));
    const handlesToResolve = [
      ...(triggeredByHandle ? [triggeredByHandle] : []),
      ...(deployInitiatorHandle ? [deployInitiatorHandle] : []),
      ...contributorHandles
    ].filter(
      (handle, index, handles) =>
        handles.findIndex(
          (candidate) => candidate.toLowerCase() === handle.toLowerCase()
        ) === index
    );
    if (!handlesToResolve.length) {
      return {
        triggeredBy: null,
        contributors: contributorGithubLogins.map((githubLogin) => ({
          githubLogin,
          profile: null
        })),
        deployInitiator: null,
        all: []
      };
    }

    const profileIdsByHandle =
      await this.identitiesRepository.getIdsByHandles(handlesToResolve);
    const mentionsByNormalizedHandle = new Map(
      Object.entries(profileIdsByHandle).map(([handle, profileId]) => [
        handle.toLowerCase(),
        {
          profileId,
          handle
        }
      ])
    );
    const triggeredBy = triggeredByHandle
      ? (mentionsByNormalizedHandle.get(triggeredByHandle.toLowerCase()) ??
        null)
      : null;
    const deployInitiator = deployInitiatorHandle
      ? (mentionsByNormalizedHandle.get(deployInitiatorHandle.toLowerCase()) ??
        null)
      : null;
    if (triggeredByHandle && !triggeredBy) {
      this.logger.warn(
        `Unable to resolve CI workflow initiator ${triggeredByGithubLogin}: 6529 profile ${triggeredByHandle} is missing`
      );
    }
    if (deployInitiatorHandle && !deployInitiator) {
      this.logger.warn(
        `Unable to resolve CI deploy initiator ${deployInitiatorGithubLogin}: 6529 profile ${deployInitiatorHandle} is missing`
      );
    }

    const contributors = contributorGithubLogins.map((githubLogin) => {
      const mappedHandle = GITHUB_TO_6529_HANDLES[githubLogin.toLowerCase()];
      return {
        githubLogin,
        profile: mappedHandle
          ? (mentionsByNormalizedHandle.get(mappedHandle.toLowerCase()) ?? null)
          : null
      };
    });
    // Profile IDs collapse handle aliases while preserving initiator-first order.
    const all = [
      ...(triggeredBy ? [triggeredBy] : []),
      ...(deployInitiator ? [deployInitiator] : []),
      ...contributors
        .map(({ profile }) => profile)
        .filter((profile): profile is MentionedProfile => !!profile)
    ].filter(
      (mention, index, mentions) =>
        mentions.findIndex(
          (candidate) => candidate.profileId === mention.profileId
        ) === index
    );

    return { triggeredBy, contributors, deployInitiator, all };
  }

  private resolveWaveId(request: CiPipelineAlertRequest): string {
    const targetEnvironment = normalizeTargetEnvironment(request.environment);
    if (targetEnvironment === 'staging') {
      return env.getStringOrThrow('CI_PIPELINES_STAGING_WAVE_ID');
    }
    if (targetEnvironment === 'prod') {
      return env.getStringOrThrow('CI_PIPELINES_PROD_WAVE_ID');
    }
    throw new Error(
      `Unsupported CI pipeline alert environment: ${request.environment ?? 'missing'}`
    );
  }

  private buildCreateDropRequest({
    request,
    waveId,
    mentions,
    deployTarget
  }: {
    readonly request: CiPipelineAlertRequest;
    readonly waveId: string;
    readonly mentions: AlertMentions;
    readonly deployTarget: CiPipelineDeployAlertTarget | null;
  }): ApiCreateDropRequest {
    const content = isWebE2EAlert(request)
      ? this.formatWebE2EContent(request, mentions, deployTarget)
      : this.formatContent(request, mentions);
    return {
      title: null,
      ...(deployTarget
        ? {
            reply_to: {
              drop_id: deployTarget.dropId,
              drop_part_id: deployTarget.dropPartId
            }
          }
        : {}),
      drop_type: ApiDropType.Chat,
      parts: [
        {
          content,
          quoted_drop: null,
          media: []
        }
      ],
      mentioned_users: mentions.all.map((mention) => ({
        mentioned_profile_id: mention.profileId,
        handle_in_content: mention.handle
      })),
      // CreateOrUpdateDropUseCase derives global group metadata and recipients
      // from part content; mentioned_users remains for initiator attribution.
      mentioned_groups: [],
      referenced_nfts: [],
      metadata: [],
      signature: null,
      is_safe_signature: false,
      wave_id: waveId
    };
  }

  private formatContent(
    request: CiPipelineAlertRequest,
    mentions: AlertMentions
  ): string {
    const failureMentionLines =
      request.status === 'failure' ? ['', `cc ${DEVS_6529_MENTION}`] : [];

    const branch = normalizeOptionalValue(request.branch);
    const commit = formatCommit(request);
    const description = normalizeOptionalValue(request.description);
    const formattedDescription = description
      ? truncate(sanitizeAlertText(description), MAX_ALERT_DESCRIPTION_LENGTH)
      : null;
    const triggeredBy = formatInitiator(request, mentions);
    const contributors = mentions.contributors
      .map(({ githubLogin, profile }) =>
        profile
          ? `@[${profile.handle}]`
          : formatMarkdownLink(
              githubLogin,
              `https://github.com/${encodeURIComponent(githubLogin)}`
            )
      )
      .join(', ');
    const lines = [
      formatAlertHeading(request),
      '',
      ...(formattedDescription ? [formattedDescription, ''] : []),
      `Service: ${formatServiceLabel(request)}`,
      `Workflow: ${request.workflow}`,
      ...(branch ? [`Branch: ${branch}`] : []),
      ...(commit ? [`Commit: ${commit}`] : []),
      `Initiated by: ${triggeredBy}`,
      ...(contributors ? [`Contributors: ${contributors}`] : []),
      `Run: ${formatRun(request, false)}`,
      ...failureMentionLines
    ];

    return truncate(lines.join('\n'), MAX_DROP_CONTENT_LENGTH);
  }

  private formatWebE2EContent(
    request: CiPipelineAlertRequest,
    mentions: AlertMentions,
    deployTarget: CiPipelineDeployAlertTarget | null
  ): string {
    if (request.status === 'success') {
      return truncate(
        `${formatAlertHeading(request)} ${formatWebE2ESuccessRun(request)}`,
        MAX_DROP_CONTENT_LENGTH
      );
    }
    const automatic = isAutomationActor(request.triggered_by_github_login);
    const manualValidator = mentions.triggeredBy
      ? `@[${mentions.triggeredBy.handle}]`
      : 'unknown';
    const validation = automatic ? 'Automatic' : `Manual by ${manualValidator}`;
    const deployInitiatorIsDistinct =
      mentions.deployInitiator !== null &&
      mentions.deployInitiator.profileId !== mentions.triggeredBy?.profileId;
    const validationPack = normalizeOptionalValue(request.validation_pack);
    const commit = deployTarget
      ? formatCommit(request, deployTarget.sha)
      : null;
    const failureMentionLines =
      request.status === 'failure' ? ['', `cc ${DEVS_6529_MENTION}`] : [];
    const lines = [
      formatAlertHeading(request),
      '',
      `Validation: ${validation}`,
      ...(validationPack && validationPack !== 'all'
        ? [`Pack: ${validationPack}`]
        : []),
      ...(deployInitiatorIsDistinct
        ? [`Deploy initiated by: @[${mentions.deployInitiator!.handle}]`]
        : []),
      ...(commit ? [`Commit: ${commit}`] : []),
      `Run: ${formatRun(request, true)}`,
      ...failureMentionLines
    ];

    return truncate(lines.join('\n'), MAX_DROP_CONTENT_LENGTH);
  }
}

export const ciPipelineAlertService = new CiPipelineAlertService(
  dropCreationService,
  identitiesDb,
  releaseNoteGenerationQueue,
  ciPipelineAlertTargetStore
);
