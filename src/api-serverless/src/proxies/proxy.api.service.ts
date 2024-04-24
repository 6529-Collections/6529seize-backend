import { Profile } from '../../../entities/IProfile';
import { BadRequestException } from '../../../exceptions';
import { Logger } from '../../../logging';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import { Time } from '../../../time';
import { CreateNewProfileProxy } from '../generated/models/CreateNewProfileProxy';
import { ProfileProxyEntity } from '../../../entities/IProfileProxy';
import { randomUUID } from 'crypto';
import {
  ProfileProxiesDb,
  profileProxiesDb
} from '../../../profile-proxies/profile-proxies.db';
import { ConnectionWrapper } from '../../../sql-executor';
import { ProfileAndConsolidations } from '../../../profiles/profile.types';
import { Page } from '../page-request';

export class ProfileProxyApiService {
  private readonly logger = Logger.get(ProfileProxyApiService.name);

  constructor(
    private readonly profilesService: ProfilesService,
    private readonly profileProxiesDb: ProfileProxiesDb
  ) {}

  private async getTargetOrThrow({
    target_id
  }: {
    readonly target_id: string;
  }): Promise<ProfileAndConsolidations> {
    const targetProfile =
      await this.profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        target_id
      );
    if (!targetProfile) {
      throw new BadRequestException(
        `Profile with id ${target_id} does not exist`
      );
    }
    return targetProfile;
  }

  private async targetNotAlreadyProxiedOrThrow({
    target_id,
    created_by_profile_id,
    target_handle
  }: {
    readonly target_id: string;
    readonly created_by_profile_id: string;
    readonly target_handle: string;
  }): Promise<void> {
    const profileProxy =
      await this.profileProxiesDb.findProfileProxyByTargetTypeAndIdAndCreatedByProfileId(
        {
          target_id,
          created_by_profile_id
        }
      );
    if (profileProxy) {
      throw new BadRequestException(
        `Profile proxy for target ${target_handle} already exists`
      );
    }
  }

  public async findProfileProxyByIdOrThrow({
    id,
    connection
  }: {
    readonly id: string;
    readonly connection?: ConnectionWrapper<any>;
  }): Promise<ProfileProxyEntity> {
    const profileProxy = await this.profileProxiesDb.findProfileProxyById({
      id,
      connection
    });
    if (!profileProxy) {
      throw new BadRequestException(
        `Profile proxy with id ${id} does not exist`
      );
    }
    return profileProxy;
  }

  async persistProfileProxy({
    createProfileProxyRequest
  }: {
    readonly createProfileProxyRequest: ProfileProxyEntity;
  }): Promise<ProfileProxyEntity> {
    return await this.profileProxiesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.profileProxiesDb.insertProfileProxy({
          profileProxy: createProfileProxyRequest,
          connection
        });
        return await this.findProfileProxyByIdOrThrow({
          id: createProfileProxyRequest.id,
          connection
        });
      }
    );
  }

  async createProfileProxy({
    params: { target_id },
    grantorProfile: { external_id: created_by_profile_id }
  }: {
    readonly params: CreateNewProfileProxy;
    readonly grantorProfile: Profile;
  }): Promise<ProfileProxyEntity> {
    const target = await this.getTargetOrThrow({
      target_id
    });
    if (!target.profile.handle) {
      throw new BadRequestException(
        `Profile with id ${target_id} does not exist`
      );
    }
    await this.targetNotAlreadyProxiedOrThrow({
      target_id,
      created_by_profile_id,
      target_handle: target.profile.handle
    });

    const createProfileProxyRequest: ProfileProxyEntity = {
      id: randomUUID(),
      target_id,
      created_at: Time.currentMillis(),
      created_by_id: created_by_profile_id
    };
    const profileProxy = await this.persistProfileProxy({
      createProfileProxyRequest
    });
    return profileProxy;
  }

  async getProfileProxyByIdOrThrow({
    proxy_id
  }: {
    readonly proxy_id: string;
  }): Promise<ProfileProxyEntity> {
    return await this.findProfileProxyByIdOrThrow({
      id: proxy_id
    });
  }

  // how to make it infinite scroll
  async getProfileReceivedProfileProxies({
    target_id,
    page,
    page_size,
    sort,
    sort_direction
  }: {
    readonly target_id: string;
    readonly page: number;
    readonly page_size: number;
    readonly sort: string;
    readonly sort_direction: string;
  }): Promise<Page<ProfileProxyEntity>> {
    const [profileProxies, count] = await Promise.all([
      this.profileProxiesDb.findProfileReceivedProfileProxies({
        target_id,
        page,
        page_size,
        sort,
        sort_direction
      }),
      this.profileProxiesDb.countProfileReceivedProfileProxies({
        target_id
      })
    ]);
    return {
      count,
      page: page,
      next: profileProxies.length === page_size,
      data: profileProxies
    };
  }
}

export const profileProxyApiService = new ProfileProxyApiService(
  profilesService,
  profileProxiesDb
);
