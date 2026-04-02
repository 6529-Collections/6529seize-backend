import { WaveType } from '@/entities/IWave';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';

export class IdentityWavesService {
  constructor(
    private readonly identitiesDb: IdentitiesDb,
    private readonly wavesApiDb: WavesApiDb
  ) {}

  public async setIdentityWave(
    {
      profileId,
      waveId
    }: {
      profileId: string;
      waveId: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.identitiesDb.updateIdentityWave({ profileId, waveId }, ctx);
  }

  public async clearIdentityWaveByWaveId(
    { waveId }: { waveId: string },
    ctx: RequestContext
  ): Promise<void> {
    await this.identitiesDb.clearIdentityWaveByWaveId(waveId, ctx);
  }

  public async setIdentityWaveIfEligible(
    {
      profileId,
      waveId
    }: {
      profileId: string;
      waveId: string;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    try {
      ctx.timer?.start(`${this.constructor.name}->setIdentityWaveIfEligible`);
      const wave = await this.getLockedWaveById(waveId, ctx);
      if (!wave || !this.isEligibleIdentityWave({ wave, profileId })) {
        return false;
      }
      await this.identitiesDb.updateIdentityWave({ profileId, waveId }, ctx);
      return true;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->setIdentityWaveIfEligible`);
    }
  }

  public async assertWaveCanBeIdentityWave(
    {
      waveId,
      profileId
    }: {
      waveId: string;
      profileId: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->assertWaveCanBeIdentityWave`);
      const wave = await this.getLockedWaveById(waveId, ctx);
      if (!wave) {
        throw new NotFoundException(`Wave ${waveId} not found`);
      }
      if (!this.isEligibleIdentityWave({ wave, profileId })) {
        if (wave.created_by !== profileId) {
          throw new BadRequestException(
            `Identity wave must be created by the authenticated profile`
          );
        }
        if (wave.type !== WaveType.CHAT) {
          throw new BadRequestException(`Identity wave must be of type CHAT`);
        }
        throw new BadRequestException(`Identity wave must be public`);
      }
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->assertWaveCanBeIdentityWave`);
    }
  }

  public async assertWaveCanBeMadePrivate(
    {
      waveId,
      visibilityGroupId
    }: {
      waveId: string;
      visibilityGroupId: string | null;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->assertWaveCanBeMadePrivate`);
      if (visibilityGroupId === null) {
        return;
      }
      const wave = await this.getLockedWaveById(waveId, ctx);
      if (!wave) {
        throw new NotFoundException(`Wave ${waveId} not found`);
      }
      const exists = await this.identitiesDb.existsIdentityWithWaveId(
        { waveId },
        ctx
      );
      if (exists) {
        throw new BadRequestException(
          `A wave used as an identity wave cannot be made private`
        );
      }
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->assertWaveCanBeMadePrivate`);
    }
  }

  private async getLockedWaveById(waveId: string, ctx: RequestContext) {
    if (!ctx.connection) {
      throw new Error(`Identity wave validation requires a transaction`);
    }
    return await this.wavesApiDb.lockById(waveId, ctx);
  }

  private isEligibleIdentityWave({
    wave,
    profileId
  }: {
    wave: {
      created_by: string;
      type: WaveType;
      visibility_group_id: string | null;
    };
    profileId: string;
  }): boolean {
    return (
      wave.created_by === profileId &&
      wave.type === WaveType.CHAT &&
      wave.visibility_group_id === null
    );
  }
}

export const identityWavesService = new IdentityWavesService(
  identitiesDb,
  wavesApiDb
);
