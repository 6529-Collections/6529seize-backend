I'm working on an app. You are a top of the line Silicon Valley software developer coming to help me with this project starting today. Let me first onboard you. Here is the onboarding manual:

===== Start of the onboarding manual =====

# Back-End Onboarding & Reference Guide

## 1. Introduction & Tech Stack

### 1.1 Overview of the Project

The project, called **6529**, is a web application primarily for a community of NFT enthusiasts. Its back end consists of multiple microservices, each packaged as an AWS Lambda function:

- **API Lambda**: A REST API consumed by a React frontend.
- **Background worker Lambdas**: Handle various tasks in the background (e.g., transactions monitoring, NFT minting, data processing, and so on).

In broad terms, the application offers the following major features:

1. **NFT Collections**: The app focuses on 4–5 NFT collections, offering capabilities such as minting and monitoring blockchain transactions.
2. **Custom Ethereum Contracts**: Beyond NFT contracts, there are other Ethereum contracts handling custom logic. The app includes functionality to interact with these.
3. **Social Network (Brain)**: A substantial part of the app is a social network where users (linked to Ethereum wallets) create profiles, join chat rooms (“waves”), share media, vote on content, etc.

Your primary responsibility is the backend, so this guide focuses on those microservices and how they are structured and deployed.

### 1.2 Core Technologies

All backend lambdas are contained in a single monorepo. This monorepo is a large Node.js/TypeScript project divided into multiple submodules. Below is an overview of the stack and tools used:

- **GitHub Actions** for CI
- **AWS Lambdas** with the **Serverless Framework** (using `serverless.yaml` files)
- **Node.js/TypeScript**
- **Express.js** for serving the API
- **OpenAPI 3** for generating API request/response models and documentation
- **Joi** for API validations
- **Winston** for logging
- **Sentry** for production error monitoring
- **MySQL** for the database
- **TypeORM** for schema management
- **db-migrate-mysql** for more complex migrations
- **API microservice** uses only native SQL queries; other microservices use both TypeORM and native queries
- **memory-cache** for caching (each microservice manages its own cache, so Redis is not used)
- **Alchemy** as the Ethereum RPC service provider (and other APIs where needed)
- Other miscellaneous utility libraries (e.g., for file uploads, external API integration, etc.)

---

## 2. Folder Structure

At the root of the repository, you will find:

```
.git/
.github/
dockerfiles/
migrations/
serverless-config/
src/
.env.local
.env.sample
.eslintrc.js
.gitignore
.prettierrc
LICENSE
README.md
database.json
docker-compose.yml
ffmpeg-installer.js
jest.config.js
nodemon.json
package-lock.json
package.json
settings.json
tsconfig.json
```

### Important Directories and Files

- **.github**  
  Contains GitHub Actions workflow files for building and deploying each Lambda, as well as pull request verification builds.

- **dockerfiles & docker-compose.yml**  
  Used for local MySQL development setup. Not used in production.

- **serverless-config**  
  Contains environment-specific (staging/production) configuration for the Serverless Framework. Includes security group IDs, subnet IDs, etc.

- **.env.local**  
  Environment variables and configuration for local development.  
  **.env.sample** is a reference file that should be kept updated with new configuration variables.

- **package.json**  
  Common NPM configuration shared across all submodules.

- **migrations**  
  Database migrations (using **db-migrate-mysql**) are deployed by the `dbMigrationsLoop` Lambda.

- **src**  
  Contains all submodules and Lambda functions.

---

## 3. Deployment Through CI

A single GitHub Actions workflow, **.github/workflows/deploy.yml**, handles deploying all Lambdas to both staging and production. Most Lambdas rely on their own `serverless.yaml` to specify deployment details, though some have custom deployment steps in `deploy.yml`.

If you add a new Lambda, ensure you:

1. Create a new folder under `src/` for it.
2. Add a `serverless.yaml` file (unless there is a custom approach in `deploy.yml`).
3. Register the Lambda in `.github/workflows/deploy.yml` so it can be deployed automatically.

Below is a **truncated** example of the deployment YAML (comments added for clarity):

```yaml
name: Deploy a service

on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        description: 'Environment'
        required: true
        default: staging
        options:
          - staging
          - prod
      service:
        type: choice
        description: 'Service'
        required: true
        default: api
        options:
          - api
          - nftsLoop
          - overRatesRevocationLoop
          - ownersBalancesLoop

env:
  SENTRY_DSN: ${{ secrets.SENTRY_DSN }}
  SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}

run-name: Deploy ${{ github.event.inputs.service }} to ${{ github.event.inputs.environment }}

jobs:
  build-and-deploy:
    name: Build and deploy ${{ github.event.inputs.service }} to ${{ github.event.inputs.environment }}
    runs-on: ubuntu-latest

    steps:
      - name: Extract branch name
        shell: bash
        run: echo "branch=${GITHUB_HEAD_REF:-${GITHUB_REF#refs/heads/}}" >> $GITHUB_OUTPUT
        id: extract_branch

      - name: Checkout
        uses: actions/checkout@v3
        with:
          ref: ${{ steps.extract_branch.outputs.branch }}

      - name: Install root dependencies
        run: npm i

      - name: Install lambda dependencies
        if: github.event.inputs.service != 'api'
        run: |
          npm i
          pushd src/${{ github.event.inputs.service }}
          npm i
          popd

      - name: Install API dependencies
        if: github.event.inputs.service == 'api'
        run: |
          pushd src/api-serverless
          npm i
          popd

      - name: Build service
        if: github.event.inputs.service != 'api'
        run: |
          pushd src/${{ github.event.inputs.service }}
          npm run build
          popd

      - name: Build API
        if: github.event.inputs.service == 'api'
        run: |
          pushd src/api-serverless
          npm run build
          popd

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@13d241b293754004c80624b5567555c4a39ffbe3
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ github.event.inputs.environment == 'prod' && 'us-east-1' || 'eu-west-1' }}

      - name: Deploy service
        if: github.event.inputs.service != 'api'
        run: |
          export VERSION_DESCRIPTION="$(date) - $(git rev-parse --abbrev-ref HEAD) - $(git show -s --format=%s)"
          pushd src/${{ github.event.inputs.service }}
          npm run sls-deploy:${{ github.event.inputs.environment }}
          popd

      - name: Deploy API
        if: github.event.inputs.service == 'api'
        run: |
          aws lambda update-function-code --function-name seizeAPI --zip-file fileb://src/api-serverless/dist/index.zip
          sleep 10
          aws lambda update-function-configuration --function-name seizeAPI --description "$(date) - $(git rev-parse --abbrev-ref HEAD) - $(git show -s --format=%s)"

      - name: Notify about failure
        uses: sarisia/actions-status-discord@v1
        if: failure()
        env:
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
        with:
          title: Seize-Lambda ${{ github.event.inputs.environment }} ${{ github.event.inputs.service }} DEPLOY CI pipeline is broken!!!
          content: '@everyone'
          color: 0xff0000

      - name: Notify about success
        uses: sarisia/actions-status-discord@v1
        if: success()
        env:
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
        with:
          title: Seize-Lambda ${{ github.event.inputs.environment }} ${{ github.event.inputs.service }} DEPLOY CI pipeline complete
          color: 0x00ff00
```

## 4. Modules and Lambdas

In the `src/` folder, each subfolder typically represents one of the following:
• A standalone Lambda (often suffixed with `Loop` for background processes)
• Shared/common code (e.g., `helpers/`, `entities/`, `logging.ts`)

Below is a snapshot of what the `src/` folder contains:

```
abis/
abusiveness/
activity/
aggregatedActivityLoop/
aggregations/
api-serverless/
cic/
cloudwatchAlarmsToDiscordLoop/
customReplayLoop/
dbDumpsDaily/
dbMigrationsLoop/
delegationsLoop/
discoverEnsLoop/
dropMediaResizerLoop/
drops/
entities/
ethPriceLoop/
events/
helpers/
identities/
marketStatsLoop/
mediaResizerLoop/
nextgen/
nextgenContractLoop/
nextgenMediaImageResolutions/
nextgenMediaProxyInterceptor/
nextgenMediaUploader/
nextgenMetadataLoop/
nftHistoryLoop/
nftOwnersLoop/
nftsLoop/
notifications/
overRatesRevocationLoop/
ownersBalancesLoop/
profile-proxies/
profileActivityLogs/
profiles/
pushNotificationsHandler/
rateEventProcessingLoop/
rates/
refreshEnsLoop/
rememesLoop/
royaltiesLoop/
s3Loop/
subscriptionsDaily/
subscriptionsTopUpLoop/
tdhConsolidationsLoop/
tdhHistoryLoop/
tdhLoop/
teamLoop/
tests/
transactions/
transactionsLoop/
transactionsProcessingLoop/
user-groups/
.prettierrc
alchemy.ts
artists.ts
arweave.ts
auth-context.ts
backend.ts
bedrock.ts
constants.ts
db-api.ts
db-query.options.ts
db.ts
delegations.ts
discord.ts
ens.ts
env.ts
etherscan.ts
exceptions.ts
helpers.ts
identity.ts
logging.ts
meme_lab.ts
merkle_proof.ts
nft_history.ts
notifier-discord.ts
notifier.ts
openai.ts
orm_helpers.ts
redis.ts
request.context.ts
royalties.ts
s3.client.ts
s3.ts
s3_rememes.ts
secrets.ts
sentry.context.ts
sql-executor.ts
sql_helpers.ts
time.ts
transaction_values.ts
```

### 4.1 Database Entities

- Database: A MySQL/Aurora instance.
- Schema: Managed by TypeORM.
- Each table maps to a TypeScript class (an “entity”) annotated with TypeORM decorators.
- `dbMigrationsLoop` runs with synchronize=true to sync all entities
- Each “Loop” Lambda (background process) other than `dbMigrationsLoop` loads TypeORM with synchronize=false. This means these background loops cannot edit the db schema.
- API Lambda: Does not use TypeORM. It relies solely on native SQL queries.

Naming Conventions:

- Table names are singular.
- The entity’s file name begins with I and uses PascalCase (e.g., IEthPrice.ts).
- The entity class itself is also singular and typically matches the table name.
- Table names are also added to `src/constants.ts` as a constant.

Example entity (`src/entities/IEthPrice.ts`):

```
import { Entity, Column, PrimaryColumn } from 'typeorm';
import { ETH_PRICE_TABLE } from '../constants';

@Entity(ETH_PRICE_TABLE)
export class EthPrice {
  @PrimaryColumn({ type: 'bigint' })
  timestamp_ms!: number;

  @Column({ type: 'datetime' })
  date!: Date;

  @Column({ type: 'double' })
  usd_price!: number;
}
```

## 4.2 Creating New Background Lambdas

Folders ending with the suffix Loop represent background Lambdas (indexing, normalization, or various recurring tasks). To create a new background Lambda:

1. Create a new folder under `src/` with a name ending in `Loop`.
2. Add a `serverless.yaml` for deployment details.
3. Register the new folder in `.github/workflows/deploy.yml`.
4. Create an `index.ts` entry point with the required TypeORM entities (if needed) and logic.

Example: `src/ethPriceLoop/serverless.yaml`:

```
service: ethPriceLoop

package:
  artifact: dist/index.zip

plugins:
  - serverless-offline

provider:
  name: aws
  runtime: nodejs22.x
  memorySize: 1028
  timeout: 900

functions:
  ethPriceLoop:
    handler: index.handler
    name: ethPriceLoop
    role: arn:aws:iam::987989283142:role/lambda-vpc-role
    reservedConcurrency: 1
    events:
      - schedule: rate(2 minutes)
    vpc:
      securityGroupIds: ${file(../../serverless-config/${opt:stage, self:provider.stage}/vpc.js):security}
      subnetIds: ${file(../../serverless-config/${opt:stage, self:provider.stage}/vpc.js):subnets}
    environment:
      SENTRY_DSN: ${env:SENTRY_DSN}
      SENTRY_ENVIRONMENT: 'ethPriceLoop_${opt:stage, self:provider.stage}'
      ETH_PRICE_RESET: false

Example: src/ethPriceLoop/index.ts

import { syncEthUsdPrice } from './eth_usd_price';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { EthPrice } from '../entities/IEthPrice';
import { doInDbContext } from '../secrets';

const logger = Logger.get('ETH_PRICE_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const reset = process.env.ETH_PRICE_RESET == 'true';
      await syncEthUsdPrice(reset);
    },
    { entities: [EthPrice], logger }
  );
});
```

Example: `src/ethPriceLoop/package.json`

```
{
  "name": "ethpriceloop",
  "version": "1.0.0",
  "description": "",
  "main": "index.ts",
  "scripts": {
    "prebuild": "rm -rf dist",
    "build": "esbuild index.ts --bundle --sourcemap --platform=node --target=es2020 --outfile=dist/index.js",
    "postbuild": "cd dist && zip -r index.zip index.js*",
    "sls-deploy:prod": "node ../../node_modules/serverless/bin/serverless.js deploy --stage=prod --region=us-east-1",
    "sls-deploy:staging": "node ../../node_modules/serverless/bin/serverless.js deploy --stage=staging --region=eu-west-1"
  },
  "author": "",
  "license": "ISC",
  "devDependencies": {
    "@types/aws-lambda": "^8.10.110",
    "esbuild": "^0.17.5"
  }
}
```

# 5. API

The API resides in src/api-serverless. It is also deployed as a Lambda, but it is not controlled by the Serverless Framework. Instead, it is an Express.js application exposing a JSON REST interface. The API follows a three-layer architecture:

1. Routes (files ending in `.routes.ts`)
2. Services (files ending in `.service.ts`)
3. DBs (files ending in `.db.ts`)

## 5.1 Routes

- Each business domain or logical component has its own file with one or more route definitions (e.g., `profiles.routes.ts`).
- Some routes require JWT authentication:
  - `needsAuthenticatedUser()`: route requires a valid authenticated user.
  - `maybeAuthenticatedUser()`: route can be accessed publicly but behaves differently if the caller is authenticated.
- Request/response TypeScript interfaces are auto-generated by OpenAPI 3 definitions found in `src/api-serverless/openapi.yaml`.
- These generated interfaces are placed in `src/api-serverless/src/generated` and their names are prefixed with `Api` (e.g., `ApiArtistsNft`).
- Validation is handled via Joi.
- Custom Exceptions are thrown for specific status codes, handled by a shared Express error middleware:
  - NotFoundException → HTTP 404
  - ForbiddenException → HTTP 403
  - UnauthorizedException → HTTP 401
- Route-level authentication helpers:
  - `getAuthenticatedWalletOrNull(req)`
  - `getAuthenticationContext(req)`
  - `getAuthenticatedProfileIdOrNull(req)`

Example: `src/api-serverless/src/drops/drops-media.routes.ts`:

```
import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import {
  getAuthenticatedProfileIdOrNull,
  needsAuthenticatedUser
} from '../auth/auth';
import { ForbiddenException } from '../../../exceptions';
import { uploadMediaService } from '../media/upload-media.service';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { ApiCreateMediaUrlResponse } from '../generated/models/ApiCreateMediaUrlResponse';
import { ApiCreateMediaUploadUrlRequest } from '../generated/models/ApiCreateMediaUploadUrlRequest';

const router = asyncRouter();

router.post(
  '/prep',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateMediaUploadUrlRequest, any, any>,
    res: Response<ApiResponse<ApiCreateMediaUrlResponse>>
  ) => {
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (!authenticatedProfileId) {
      throw new ForbiddenException('Please create a profile first');
    }

    // Validate
    const createMediaUploadUrlRequest: ApiCreateMediaUploadUrlRequest & {
      author: string;
    } = getValidatedByJoiOrThrow(
      {
        ...req.body,
        author: authenticatedProfileId
      },
      MediaPrepRequestSchema
    );

    // Invoke service
    const response = await uploadMediaService.createSingedDropMediaUploadUrl(
      createMediaUploadUrlRequest
    );
    res.send(response);
  }
);

const MediaPrepRequestSchema: Joi.ObjectSchema<
  ApiCreateMediaUploadUrlRequest & { author: string }
> = Joi.object({
  author: Joi.string().required(),
  content_type: Joi.string()
    .required()
    .allow(
      ...[
        'image/png',
        'image/jpeg',
        'image/gif',
        'video/mp4',
        'video/x-msvideo',
        'audio/mpeg',
        'audio/mpeg3',
        'audio/ogg',
        'audio/mp3',
        'audio/wav',
        'audio/aac',
        'audio/x-aac',
        'model/gltf-binary'
      ]
    ),
  file_name: Joi.string().required(),
  file_size: Joi.number().integer().required().min(1).max(500000000) // 500MB
});

export default router;
```

In `src/api-serverless/src/app.ts`, these routes are mounted:

```
apiRouter.use('/drop-media', dropsMediaRoutes);
```

## 5.2 Services

- Services contain the bulk of the business logic.
- Typically, they use dependency injection to integrate with DB classes or other external services.
- Service files end with .service.ts.
- If the same logic is needed by other Lambdas, it may reside outside of api-serverless.

Example: `src/api-serverless/src/notifications/notifications.api.service.ts`:

```
import {
  userNotificationReader,
  UserNotificationsReader
} from '../../../notifications/user-notifications.reader';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { UserNotification } from '../../../notifications/user-notification.types';
import {
  assertUnreachable,
  distinct,
} from '../../../helpers';
import { enumns } from '../../../enumns';
import { IdentityNotificationCause } from '../../../entities/IIdentityNotification';
import {
  profilesApiService,
  ProfilesApiService
} from '../profiles/profiles.api.service';
import { DropsApiService, dropsService } from '../drops/drops.api.service';
import { AuthenticationContext } from '../../../auth-context';
import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiNotificationsResponse } from '../generated/models/ApiNotificationsResponse';
import { ApiNotification } from '../generated/models/ApiNotification';
import { ApiNotificationCause } from '../generated/models/ApiNotificationCause';
import {
  identityNotificationsDb,
  IdentityNotificationsDb
} from '../../../notifications/identity-notifications.db';

export class NotificationsApiService {
  constructor(
    private readonly notificationsReader: UserNotificationsReader,
    private readonly userGroupsService: UserGroupsService,
    private readonly profilesApiService: ProfilesApiService,
    private readonly dropsService: DropsApiService,
    private readonly identityNotificationsDb: IdentityNotificationsDb
  ) {}

  // Marking notifications as read
  public async markNotificationAsRead(param: { id: number; identity_id: string }) {
    await this.identityNotificationsDb.markNotificationAsRead(param);
  }

  public async markAllNotificationsAsRead(identityId: string) {
    await this.identityNotificationsDb.markAllNotificationsAsRead(identityId);
  }

  // Getting notifications for a user
  public async getNotifications(
    param: { id_less_than: number | null; limit: number },
    authenticationContext: AuthenticationContext
  ): Promise<ApiNotificationsResponse> {
    const eligible_group_ids =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        authenticationContext.getActingAsId()
      );

    const notifications =
      await this.notificationsReader.getNotificationsForIdentity({
        ...param,
        identity_id: authenticationContext.getActingAsId()!,
        eligible_group_ids
      });

    const apiNotifications = await this.mapToApiNotifications(
      notifications.notifications,
      authenticationContext
    );

    return {
      notifications: apiNotifications,
      unread_count: notifications.total_unread
    };
  }

  // Mapping logic
  private async mapToApiNotifications(
    notifications: UserNotification[],
    authenticationContext: AuthenticationContext
  ): Promise<ApiNotification[]> {
    const { profileIds, dropIds } = this.getAllRelatedIds(notifications);

    const [drops, profiles] = await Promise.all([
      this.dropsService.findDropsByIdsOrThrow(dropIds, authenticationContext),
      this.profilesApiService.getProfileMinsByIds({
        ids: profileIds,
        authenticatedProfileId: authenticationContext.getActingAsId()
      })
    ]);

    return notifications.map((notification) =>
      this.mapToApiNotification({ notification, drops, profiles })
    );
  }

  private getAllRelatedIds(notifications: UserNotification[]): {
    profileIds: string[];
    dropIds: string[];
  } {
    const profileIds: string[] = [];
    const dropIds: string[] = [];

    for (const notification of notifications) {
      const notificationCause = notification.cause;

      switch (notificationCause) {
        case IdentityNotificationCause.IDENTITY_SUBSCRIBED: {
          const data = notification.data;
          profileIds.push(data.subscriber_id);
          break;
        }
        case IdentityNotificationCause.IDENTITY_MENTIONED: {
          const data = notification.data;
          profileIds.push(data.mentioner_identity_id);
          dropIds.push(data.drop_id);
          break;
        }
        case IdentityNotificationCause.DROP_VOTED: {
          const data = notification.data;
          profileIds.push(data.voter_id);
          dropIds.push(data.drop_id);
          break;
        }
        case IdentityNotificationCause.DROP_QUOTED: {
          const data = notification.data;
          profileIds.push(data.quote_drop_author_id);
          dropIds.push(data.quoted_drop_id, data.quote_drop_id);
          break;
        }
        case IdentityNotificationCause.DROP_REPLIED: {
          const data = notification.data;
          profileIds.push(data.reply_drop_author_id);
          dropIds.push(data.replied_drop_id, data.reply_drop_id);
          break;
        }
        default: {
          assertUnreachable(notificationCause);
        }
      }
    }

    return { profileIds: distinct(profileIds), dropIds: distinct(dropIds) };
  }

  private mapToApiNotification({
    notification,
    drops,
    profiles
  }: {
    notification: UserNotification;
    drops: Record<string, ApiDrop>;
    profiles: Record<string, ApiProfileMin>;
  }): ApiNotification {
    const notificationCause = notification.cause;

    switch (notificationCause) {
      case IdentityNotificationCause.IDENTITY_SUBSCRIBED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.subscriber_id],
          related_drops: [],
          additional_context: {}
        };
      }
      case IdentityNotificationCause.IDENTITY_MENTIONED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.mentioner_identity_id],
          related_drops: [drops[data.drop_id]],
          additional_context: {}
        };
      }
      case IdentityNotificationCause.DROP_VOTED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.voter_id],
          related_drops: [drops[data.drop_id]],
          additional_context: { vote: data.vote }
        };
      }
      case IdentityNotificationCause.DROP_QUOTED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.quote_drop_author_id],
          related_drops: [drops[data.quote_drop_id], drops[data.quoted_drop_id]],
          additional_context: {
            quote_drop_id: data.quote_drop_id,
            quote_drop_part: data.quote_drop_part,
            quoted_drop_id: data.quoted_drop_id,
            quoted_drop_part: data.quoted_drop_part
          }
        };
      }
      case IdentityNotificationCause.DROP_REPLIED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.reply_drop_author_id],
          related_drops: [drops[data.replied_drop_id], drops[data.reply_drop_id]],
          additional_context: {
            reply_drop_id: data.reply_drop_id,
            replied_drop_id: data.replied_drop_id,
            replied_drop_part: data.replied_drop_part
          }
        };
      }
      default: {
        return assertUnreachable(notificationCause);
      }
    }
  }
}

export const notificationsApiService = new NotificationsApiService(
  userNotificationReader,
  userGroupsService,
  profilesApiService,
  dropsService,
  identityNotificationsDb
);
```

## 5.3 DBs

- Db Classes encapsulate all database interactions.
- Typically named Something.db.ts (e.g., identity-notifications.db.ts) and extend LazyDbAccessCompatibleService.
- Use prepared statements, transactions where needed, and only native SQL queries within these classes.
- For a transaction, you can call executeNativeQueriesInTransaction<T>(...) on the DB service.

Example: `src/events/events.db.ts`:

```
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { EventStatus, EventType, ProcessableEvent } from '../entities/IEvent';
import { EVENTS_TABLE, LISTENER_PROCESSED_EVENTS_TABLE } from '../constants';
import { Time } from '../time';

const mysql = require('mysql');

export class EventsDb extends LazyDbAccessCompatibleService {
  async getListenerKeysAlreadyProcessedByEventIds(
    eventIds: number[],
    connection: ConnectionWrapper<any>
  ): Promise<Record<number, string[]>> {
    const result = await this.db.execute<{
      event_id: number;
      listener_key: string;
    }>(
      `
      SELECT event_id, listener_key
      FROM ${LISTENER_PROCESSED_EVENTS_TABLE}
      WHERE event_id IN (:eventIds)
    `,
      { eventIds },
      { wrappedConnection: connection }
    );

    return result.reduce((acc, it) => {
      acc[it.event_id] = [...(acc[it.event_id] ?? []), it.listener_key];
      return acc;
    }, {} as Record<number, string[]>);
  }

  async markEventsDoneForListener(
    event_ids: number[],
    listener_key: string,
    connection: ConnectionWrapper<any>
  ) {
    for (const event_id of event_ids) {
      await this.db.execute(
        `
        INSERT INTO ${LISTENER_PROCESSED_EVENTS_TABLE} (event_id, listener_key)
        VALUES (:event_id, :listener_key)
      `,
        { event_id, listener_key },
        { wrappedConnection: connection }
      );
    }
  }

  async insertNewEvent(event: NewEvent, connection: ConnectionWrapper<any>) {
    await this.db.execute(
      `
      INSERT INTO ${EVENTS_TABLE} (type, data, status, created_at)
      VALUES (:type, :data, :status, :created_at)
    `,
      { ...event, status: EventStatus.NEW, created_at: Time.now().toMillis() },
      { wrappedConnection: connection }
    );
  }

  async lockNewEvents(
    numberOfEventsToLock: number,
    eventTypes: EventType[],
    connection: ConnectionWrapper<any>
  ): Promise<ProcessableEvent[]> {
    if (numberOfEventsToLock === 0 || eventTypes.length === 0) {
      return [];
    }
    return await this.db.execute<ProcessableEvent>(
      `
      SELECT *
      FROM ${EVENTS_TABLE}
      WHERE type IN (:eventTypes)
        AND status = '${EventStatus.NEW}'
      ORDER BY created_at ASC
      LIMIT :numberOfEventsToLock
      FOR UPDATE SKIP LOCKED
    `,
      { numberOfEventsToLock, eventTypes },
      { wrappedConnection: connection }
    );
  }

  async markEventsAsProcessed(
    events: ProcessableEvent[],
    connection: ConnectionWrapper<any>
  ) {
    if (!events.length) {
      return;
    }
    await this.db.execute(
      `
      UPDATE ${EVENTS_TABLE}
      SET status = '${EventStatus.PROCESSED}', processed_at = :processed_at
      WHERE id IN (:ids)
    `,
      {
        ids: events.map((it) => it.id),
        processed_at: Time.now().toMillis()
      },
      { wrappedConnection: connection }
    );
  }

  async insertBulk(events: NewBulkEvent[], connection: ConnectionWrapper<any>) {
    if (!events.length) {
      return;
    }
    const sql = `
      INSERT INTO ${EVENTS_TABLE} (type, data, status, created_at)
      VALUES ${events
        .map(
          (event) =>
            `(${[event.type, event.data, event.status, event.created_at]
              .map(mysql.escape)
              .join(', ')})`
        )
        .join(', ')}
    `;
    await this.db.execute(sql, undefined, { wrappedConnection: connection });
  }
}

export type NewEvent = Omit<
  ProcessableEvent,
  'id' | 'status' | 'processed_at' | 'created_at'
>;

export type NewBulkEvent = Omit<ProcessableEvent, 'id'>;

export const eventsDb = new EventsDb(dbSupplier);
```

===== End of the onboarding manual =====

Now that you've read this I need you to do your first task. Before you start with this task lay out a plan what you are going to do.

Task: <-put the task description here->
