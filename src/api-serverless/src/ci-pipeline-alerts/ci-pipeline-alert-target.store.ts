import * as crypto from 'node:crypto';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';

const CI_PIPELINE_DEPLOY_TARGET_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface CiPipelineDeployAlertTarget {
  readonly dropId: string;
  readonly dropPartId: number;
  readonly sha: string | null;
  readonly triggeredByGithubLogin: string | null;
}

export interface CiPipelineDeployTargetIdentity {
  readonly repo: string;
  readonly environment: 'staging' | 'prod';
  readonly runId?: string | null;
  readonly releaseTrainId?: string | null;
}

export interface CiPipelineAlertTargetStore {
  rememberDeployTarget(
    identity: CiPipelineDeployTargetIdentity,
    target: CiPipelineDeployAlertTarget
  ): Promise<void>;
  resolveDeployTarget(
    identity: CiPipelineDeployTargetIdentity
  ): Promise<CiPipelineDeployAlertTarget | null>;
}

function targetKey(
  identity: CiPipelineDeployTargetIdentity,
  kind: 'run' | 'train',
  value: string
): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify([identity.repo, identity.environment, kind, value]))
    .digest('hex');
  return `ci-pipeline-deploy-target:${digest}`;
}

function identityKeys(identity: CiPipelineDeployTargetIdentity): string[] {
  return [
    ...(identity.runId ? [targetKey(identity, 'run', identity.runId)] : []),
    ...(identity.releaseTrainId
      ? [targetKey(identity, 'train', identity.releaseTrainId)]
      : [])
  ];
}

function parseTarget(value: string): CiPipelineDeployAlertTarget | null {
  try {
    const parsed = JSON.parse(value) as Partial<CiPipelineDeployAlertTarget>;
    const dropPartId = parsed.dropPartId;
    if (
      typeof parsed.dropId !== 'string' ||
      !parsed.dropId ||
      typeof dropPartId !== 'number' ||
      !Number.isInteger(dropPartId) ||
      dropPartId < 0 ||
      (parsed.sha !== null && typeof parsed.sha !== 'string') ||
      (parsed.triggeredByGithubLogin !== null &&
        typeof parsed.triggeredByGithubLogin !== 'string')
    ) {
      return null;
    }
    return {
      dropId: parsed.dropId,
      dropPartId,
      sha: parsed.sha ?? null,
      triggeredByGithubLogin: parsed.triggeredByGithubLogin ?? null
    };
  } catch {
    return null;
  }
}

function sameTarget(
  left: CiPipelineDeployAlertTarget,
  right: CiPipelineDeployAlertTarget
): boolean {
  return left.dropId === right.dropId && left.dropPartId === right.dropPartId;
}

export class RedisCiPipelineAlertTargetStore implements CiPipelineAlertTargetStore {
  private readonly logger = Logger.get(this.constructor.name);

  public async rememberDeployTarget(
    identity: CiPipelineDeployTargetIdentity,
    target: CiPipelineDeployAlertTarget
  ): Promise<void> {
    const redis = getRedisClient();
    const keys = identityKeys(identity);
    if (!redis || !keys.length) return;

    try {
      const value = JSON.stringify(target);
      // Resolution requires every supplied identity key to exist and match,
      // so a partial best-effort write safely falls back to a standalone post.
      await Promise.all(
        keys.map((key) =>
          redis.set(key, value, {
            EX: CI_PIPELINE_DEPLOY_TARGET_TTL_SECONDS
          })
        )
      );
    } catch (error) {
      this.logger.warn(
        `Unable to remember CI deploy alert target; E2E results will fall back to standalone posts: ${error}`
      );
    }
  }

  public async resolveDeployTarget(
    identity: CiPipelineDeployTargetIdentity
  ): Promise<CiPipelineDeployAlertTarget | null> {
    const redis = getRedisClient();
    const keys = identityKeys(identity);
    if (!redis || !keys.length) return null;

    try {
      const values = await Promise.all(keys.map((key) => redis.get(key)));
      const targets = values
        .filter((value): value is string => typeof value === 'string')
        .map(parseTarget);
      if (
        targets.length !== keys.length ||
        targets.some((target) => target === null)
      ) {
        return null;
      }
      const resolvedTargets = targets as CiPipelineDeployAlertTarget[];
      return resolvedTargets.every((target) =>
        sameTarget(target, resolvedTargets[0])
      )
        ? resolvedTargets[0]
        : null;
    } catch (error) {
      this.logger.warn(
        `Unable to resolve CI deploy alert target; posting E2E result standalone: ${error}`
      );
      return null;
    }
  }
}

export const ciPipelineAlertTargetStore = new RedisCiPipelineAlertTargetStore();
