# AGENTS.md

## Deployment

- Follow `ops/skills/deploy-6529/SKILL.md` for authorized staging and production
  work, using ordinary Git merges and the existing GitHub Actions workflows.
- For staging, merge the development branch into the latest `1a-staging` and
  push. Frontend changes automatically start `Web Deploy - STAGING`; backend
  changes require dispatching `Deploy a service` for the required services.
- For production, merge the development branch into `main`, then dispatch
  `Web Deploy - PROD` for frontend or `Deploy a service` with `environment=prod`
  for backend. A staging request alone does not authorize production.
- Run backend service deployments sequentially in dependency order. Wait for
  each run to succeed, then continue the next service in the same task without
  asking for repeated authorization already covered by the requested phase.
- Deploy backend dependencies before merging or deploying dependent frontend
  changes in each environment. Read the backend service catalog and the change
  to determine the units and order; avoid deploying unrelated services.
- Fetch shared refs before merging. Preserve other developers' changes, resolve
  conflicts normally, and never force-push or overwrite a moved shared ref.
  Do not cancel another developer's deployment; coordinate through GitHub run
  visibility and wait when the work would conflict.
- Follow each deployment through its existing health and automatic E2E checks.
  Fix failures on the development branch and repeat the authorized sequence.
  Keep ordinary CI, artifact integrity, and runtime version checks intact.
- CI wave notifications carry deploy run IDs through E2E and reruns. The
  backend alone resolves the drop reply target; notification failures remain
  best effort. Keep receiver and sender contracts compatible during rollout.
- Never author or post release notes manually. Preserve the autonomous bot's
  PR/service grouping metadata and final publication signal; use the explicit
  release-note opt-out for authorized internal operations.

# Commiting to Git

Use DCO signoff commits. Before committing, verify `git config user.name` and `git config user.email`; for GitHub commits, `user.email` should be the matching `accountcode+username@users.noreply.github.com` address unless the user explicitly wants another verified email. Commit with `git commit -s -m "<message>"` so Git appends `Signed-off-by: <user.name> <user.email>`.

# Writing unit tests

1. Put the tests next to file being tested.
2. Test file name should always end with `.test.ts`
3. Words in test file names should always be separated with dashes (except for the suffix `.test.ts`) and be all lowercase. For example if you test function doThis then the test file should be `do-this.test.ts`
4. Use fast-check where reasonable
5. When doing DB/Repository tests take example from file src/profiles/abusiveness-check.db.test.ts

# Linting

After you do your changes then run `6529 run lint`. Make sure you fix all errors and warnings.

# Sonar

When writing or changing code, keep predictable SonarCloud findings in mind before opening a PR:

1. Always pass an explicit compare function to `Array.prototype.sort`, even when sorting strings.
2. Avoid long chains of `String.prototype.replace` calls for literal replacements. Prefer `replaceAll` when available, or use a single regex/callback replacement when TypeScript library support makes `replaceAll` unsuitable.
3. Keep cognitive complexity low. Split nested parsing/validation logic into small helper functions before it reaches Sonar thresholds.
4. Avoid adding broad `any` types, duplicated branches, deep nesting, and large functions when a local typed helper would keep intent clearer.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package Command Boundary

All project installs, package scripts, and local package binaries must run
through the repo-local `6529` wrapper. Do not use npm, npx, or Corepack npm
directly. Run `./bin/6529 bootstrap` once when `direnv` is unavailable; with
`direnv`, `direnv allow` exposes the same repo-scoped command. See
`docs/package-commands.md` for the complete contract.

## Project Overview

This is the 6529 SEIZE Backend repository, a Web3 NFT platform backend that handles NFT indexing, community features (drops, waves, ratings), user profiles, delegations, and comprehensive REST API services. It consists of two main components:

1. **Backend Services** - Scheduled loop processes (Lambdas/cron jobs) that index blockchain data, process transactions, and update aggregated metrics
2. **API Services** - Express-based REST API with JWT authentication, rate limiting, WebSocket support, and comprehensive endpoints for NFT and community data

## Commands

### Development

```bash
# Install dependencies
6529 ci

# Build the project (includes tests)
6529 run build

# Format code
6529 run format

# Lint code
6529 run lint

# Run tests
6529 run test
```

### Backend Services

```bash
# Run backend locally
6529 run backend:local

# Run backend in development
6529 run backend:dev

# Run backend in production
6529 run backend:prod
```

### API Services

```bash
# Run API in development from its package directory
cd src/api-serverless && 6529 run dev

# Build API separately
cd src/api-serverless && 6529 run build
```

### Database Migrations

```bash
# Run migrations up (apply new migrations)
6529 run migrate:up

# Run migrations down (rollback)
6529 run migrate:down

# Create new migration
6529 run migrate:new name-of-the-migration

# Local development migrations
6529 run migrate-local:up
6529 run migrate-local:down
```

After creating a migration, edit the generated SQL files in the `migrations` folder (write SQL in the "up" file, and just delete the "down" file, also replace the down implementation in js file with "do nothing" implementation).

### Testing

```bash
# Run all tests
6529 run test

# Run specific test file
6529 run test -- path/to/test.spec.ts
```

The test configuration uses:

- Jest with ts-jest preset
- Testcontainers for MySQL integration tests
- Global setup/teardown in `src/tests/_setup/`
- 30-second timeout for database operations

## Architecture

Keep `docs/architecture.md` up to date when changing the system shape. Update it in the same change whenever you add, remove, rename, or materially rewire a Lambda, API boundary, SQS/SNS queue or topic, EventBridge trigger, DB/runtime pattern, media/edge flow, deployable service, or major external integration. If a development touches those areas but does not require a docs update, say that explicitly in the final response.

## 6529 Help Bot Knowledge Maintenance

When changing backend-owned product behavior that users may ask `@help6529`
about, update the help bot knowledge in the same PR. The canonical bot handle is
`help6529` (`@help6529` in user-facing wave text), matching
`HELP_BOT_HANDLE` in `src/help-bot/help-bot.config.ts`; do not replace it with
any alternate spelling. This includes changes to subscriptions, eligibility
rules, wave or drop permissions, posting limits, profile/business-rule
terminology, and canonical backend-owned URLs.

For V1, frontend product knowledge is owned by the frontend repository in
`ops/help/help-index.json` and published as `/help-index.json`. The backend help
bot runtime should consume and cache that artifact instead of hardcoding
frontend routes, controls, or product navigation. Keep
`specs/6529-help-bot-runtime.md` aligned with any runtime, provider, source,
failure-mode, or coverage change. If a backend behavior is user-visible but the
frontend corpus is not updated in the same release set, state the gap in the PR
or final handoff.

Backend public-data answers are backend-owned. When changing table names,
columns, query semantics, or whitelisted public-data surfaces used by
`src/help-bot/help-bot-public-data.catalog.ts`, update the catalog and its
validator/query tests in the same PR.

### Loop-Based Services (Backend)

The backend consists of independent "loop" services that run as AWS Lambda functions or cron jobs. Each loop is self-contained in `src/*Loop/` directories:

**Key Loops:**

- `nftsLoop` - Discovers and indexes NFTs from blockchain
- `nftOwnersLoop` - Tracks NFT ownership changes
- `nftHistoryLoop` - Maintains NFT ownership history
- `transactionsProcessingLoop` - Processes blockchain transactions
- `tdhHistoryLoop` - Calculates TDH (Total Days Held) scores
- `delegationsLoop` - Processes delegation.cash delegations
- `marketStatsLoop` - Aggregates NFT market statistics
- `aggregatedActivityLoop` - Calculates aggregated activity metrics
- `ownersBalancesLoop` - Maintains owner balance snapshots
- `nextgenContractLoop` - Indexes NextGen NFT contracts
- `externalCollectionSnapshottingLoop` / `externalCollectionLiveTailingLoop` - Indexes external NFT collections
- `refreshEnsLoop` / `discoverEnsLoop` - Manages ENS name resolution
- `s3Loop` - Uploads and compresses media to S3
- `mediaResizerLoop` - Resizes images for different display sizes
- `waveDecisionExecutionLoop` - Executes wave voting decisions
- `overRatesRevocationLoop` - Handles reputation rate revocations

Each loop follows the pattern:

1. Entry point in `index.ts` with `handler` function
2. Uses `doInDbContext()` to initialize database and Redis
3. Wrapped with `sentryContext.wrapLambdaHandler()` for error tracking
4. Can be deployed independently as Lambda functions

### API Structure

The API (`src/api-serverless/src/`) is an Express application with:

**Core Files:**

- `app.ts` - Main Express app configuration with routes, middleware, authentication
- `handler.ts` - AWS Lambda handler wrapper for serverless deployment
- `async.router.ts` - Async-aware Express router wrapper

**Feature Routes (in subdirectories):**

- `drops/` - Social content drops (posts/content) with voting and reactions
- `waves/` - Community waves (voting periods/campaigns)
- `profiles/` - User profiles, reputation, and activity logs
- `ratings/` - Reputation rating system
- `identities/` - User identity management
- `community-members/` - Community groups and membership
- `notifications/` - User notifications system
- `delegations/` - Delegation.cash integration
- `distributions/` - NFT distributions and allowlists
- `nextgen/` - NextGen NFT contract integration
- `feed/` - Activity feed aggregation
- `xtdh/` - Extended TDH calculations

**Architecture Patterns:**

- **Routes** (`*.routes.ts`) - Define endpoints and validation
- **API Services** (`*.api.service.ts`) - Business logic for API endpoints
- **DB Services** (`*.db.ts` in `src/`) - Database access layer extending `LazyDbAccessCompatibleService`
- **Generated API** (`generated/models/`, `generated/routes/`) - TypeScript API
  models plus generated route wiring and operation types

### Database Layer

**Connection Management:**

- Separate read/write connection pools configured in `src/db-api.ts`
- `read_pool` for SELECT queries, `write_pool` for INSERT/UPDATE/DELETE
- Environment variables: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_PORT` (write) and `DB_HOST_READ`, `DB_USER_READ`, `DB_PASS_READ` (read)

**Query Execution:**

- `SqlExecutor` interface in `src/sql-executor.ts` provides abstraction
- Services extend `LazyDbAccessCompatibleService` to access `this.db`
- Use parameterized queries with named parameters: `execute(sql, { param: value })`
- Transaction support via `executeNativeQueriesInTransaction()`

**ORM:**

- TypeORM for schema synchronization (entities in `src/entities/`)
- Entities files are prefixed with `I` (e.g., `IIdentity.ts`, `IDrop.ts`) but the entity classes in them don't have this prefix. Instead they have `Entity` suffix (e.g., `IdentityEntiy`, `ProfileEntity`)
- Schema auto-syncs on startup; migrations are only used for data migrations (and rarely for views).
- Every time a new Entity is added it also needs to be exported in `entities.ts`.

**Constants:**

- All table names defined in `src/constants.ts` (e.g., `NFTS_TABLE`, `DROPS_TABLE`, `PROFILES_TABLE`)
- Use constants instead of hardcoded strings

**Important:**

- Never use foreign keys in database schemas
- Avoid fancy db level constraints (like enum validation for example)
- Be careful with changing preexisting entity classes as there is a high chance of accidentally deleting data. This includes changing data types.

### Key Domain Models

**NFTs:**

- Primary contracts: MEMES (`0x33FD426905F149f8376e227d0C9D3340AaD17aF1`), MEME LAB, GRADIENT, NextGen
- Tables: `nfts`, `nfts_meme_lab`, `nft_owners`, `nfts_history`
- Extended data: `memes_extended_data`, `lab_extended_data`

**Community Features:**

- **Drops** - Social posts/content with voting, reactions, and metadata
- **Waves** - Social channels with all kinds of metadata like voting periods with participation requirements and outcomes
- **Ratings** - Reputation system with categories (CIC, REP)
- **Identities** - User profiles with proxy support

**TDH (Total Days Held):**

- Scoring system based on eligible NFT ownership duration
- Per-wallet calculations and consolidated calculations across wallet consolidations
- Historical tracking in `tdh_history` and `tdh_global_history`

**Delegations:**

- Integration with delegations protocol
- Allows delegating wallet permissions to other addresses

### Authentication & Authorization

**Authorization**:

- Uses a sequence of API calls and Ethereum wallet signatures to figure out who the user is. If successful, releases a JWT. (`openapi.yaml` `/auth` endpoints)

**JWT Authentication:**

- Passport.js with JWT strategy in `src/api-serverless/src/app.ts`
- JWT secret from `getJwtSecret()` in `src/api-serverless/src/auth/auth.ts`
- Routes can use `passport.authenticate('jwt')` or `passport.authenticate(['jwt', 'anonymous'])`
- User identity in `request.user`

**Rate Limiting:**

- Redis-based rate limiting middleware in `src/api-serverless/src/rate-limiting/`
- Two-tier: burst limit (requests/second) and sustained limit (requests over time window)
- Different limits for authenticated vs unauthenticated users
- Internal request signing for SSR requests (bypasses rate limiting)
- Requires Redis to be available; automatically disabled if Redis unavailable

### Environment Configuration

**Environment Files:**

- Use `.env.local` to set them
- Ignore the one in `src/api-serverless/`

**Environment Loading:**

- `loadLocalConfig()` and `loadSecrets()`(works only in prod) in `src/env.ts`
- `doInDbContext()` wrapper in `src/secrets.ts` handles full initialization

### External Integrations

- **Alchemy SDK** - Primary Ethereum node provider
- **Etherscan API** - Transaction and contract verification
- **AWS S3** - Media storage and CDN via CloudFront
- **AWS MediaConvert** - Video transcoding
- **AWS SQS/SNS** - Message queuing
- **Redis** - Caching and rate limiting
- **OpenAI** - AI features
- **Firebase Admin** - Push notifications
- **Arweave** - Decentralized storage
- **Discord.js** - Discord bot integration

### Development Notes

**Running Locally:**

1. Set up MySQL database (or use Docker: `docker-compose up -d`)
2. Create `.env.local` with database credentials
3. Run migrations: `6529 run migrate-local:up`
4. Start backend: `6529 run backend:local` (optional)
5. Start API: `cd src/api-serverless && 6529 run dev`

**Database Setup:**

- Create database and user via docker-compose
- TypeORM creates tables automatically
- Migrations create views and complex structures

**Video Compression:**

- S3Loop requires ffmpeg installed locally
- Only runs in `prod` mode by default

**Lambda Deployment:**

- Each loop folder represents a deployable Lambda
- Serverless Framework configuration in `serverless-config/`
- Most loops have their own serverless.yaml files in their roots. Those are used to set up lambdas (via Github Actions). All new lambdas should also use serverless.yaml and make sure they are wired in build scripts and `.github/workflows/deploy.yaml`
- API deployable as single Lambda with API Gateway
- **memorySize:** Use a multiple of 512 (MB), e.g. 512, 1024, 1536, 2048, 3072, 4096, 5120

### Code Patterns

**Error Handling:**

- Use `ApiCompliantException` or one of its specific subclasses from `src/exceptions` for API errors
- Sentry integration via `sentryContext.wrapLambdaHandler()`

**Logging:**

- `Logger.get('COMPONENT_NAME')` pattern (in classes use the pattern `private readonly logger = Logger.get(this.constructor.name);`)
- Request-scoped logging with `loggerContext` in API
- Each request gets unique `requestId`

**Timing:**

- `Time` utility in `src/time.ts` for time operations
- `Timer` class for performance measurement

**Validation:**

- Joi schemas for request validation
- `getValidatedByJoiOrThrow()` in `src/api-serverless/src/validation.ts`

**Caching:**

- Redis-based caching via `src/redis.ts`
- Request-level caching via `request-cache.ts`
- `cacheKey()` helper for consistent cache key generation

**WebSockets:**

- WebSocket server in `src/api-serverless/src/ws/`
- JWT authentication for WebSocket connections
- Notification system for real-time updates

**API schemas**

- API endpoints are described in `openapi.yaml` file.
- Any time you change this file run `cd src/api-serverless && 6529 run generate:openapi`
- `generate:openapi` runs `restructure-openapi` and then `generate`. The latter
  refreshes models under `src/api-serverless/src/generated/models` and generated
  route wiring plus operation types under
  `src/api-serverless/src/generated/routes`.
- Every change to `src/api-serverless/openapi.yaml` must also be propagated to
  `6529seize-frontend` in the same task, even when no frontend call site changes.
  Direct copy is valid only from the task's backend worktree on the backend
  feature branch containing the final spec: copy
  `src/api-serverless/openapi.yaml` to the frontend worktree's root
  `openapi.yaml`. If that backend worktree is unavailable, first commit and push
  the final spec, then run `bash scripts/refresh-api.sh <backend_feature_branch>`
  from the frontend worktree. The argument must be the exact backend branch
  containing the OpenAPI change, never the frontend branch. Never omit it for
  unmerged feature work: omission defaults to backend `main`, which may not
  contain the change. Then run `6529 run generate` in the frontend repo and
  commit its `openapi.yaml` and `generated/` changes. Do not report the backend
  OpenAPI work complete while this frontend synchronization is missing; if it
  cannot be completed, report it as an explicit blocker.
- Prefer `x-6529-router` generated routes for new endpoints. Manual `.routes.ts`
  files are legacy/escape-hatch wiring for route shapes the generator does not
  support.
- Generated API models and operation types must be used by generated handlers.

### Imports and path aliases

Use path aliases for **new** imports where applicable. Do not change existing imports to aliases just for consistency, to avoid unnecessary noise and large diffs.

- In **api-serverless** (see `src/api-serverless/tsconfig.paths.json`): Use `@/` for repo `src/` (e.g. `@/constants`, `@/numbers`, `@/sql-executor`). Use `@/api/*` for files under api-serverless `src/` (e.g. `@/api/memes-minting/allowlist-merkle`, `@/api/memes-minting/api.memes-minting.db`). New code in api-serverless must use these aliases, not relative paths for cross-folder imports.
- In **root** (e.g. loops, src outside api-serverless): root `tsconfig.json` has `@/*` → `src/*`; use `@/constants`, `@/entities`, etc. when adding new code.

# API types and OpenAPI (api-serverless)

All API request/response types must be defined via OpenAPI and the generated models. Do not hand-roll response types for API endpoints unless explicitly asked not to.

1. **Define in OpenAPI**: Add the endpoint and its request/response schemas in `src/api-serverless/openapi.yaml` (paths and `components/schemas`).
2. **Generate**: From `src/api-serverless` run `6529 run generate:openapi`.
   This runs `restructure-openapi` and `generate`, refreshing models under
   `src/api-serverless/src/generated/models/` and generated routes plus
   operation types under `src/api-serverless/src/generated/routes/`.
3. **Synchronize frontend**: Propagate the final backend `openapi.yaml` to the
   frontend and run frontend `6529 run generate`, following the mandatory
   cross-repository procedure under **API schemas** above. Commit the frontend
   spec and generated artifacts in the same task.
4. **Use generated types**: Import models from `@/api/generated/models/...` and
   operation request/query/path/body/response types from
   `@/api/generated/routes/operations`. Map DB/service output to the generated
   model shape (for example, snake_case properties) before returning.

# Database schema and migrations

Do **not** create new migrations for table creation or schema changes unless the user explicitly asks for them. Assume migrations are not needed.

- **New tables**: Add TypeORM entities and export them in `src/entities/entities.ts`. The dbMigrations loop runs with `sync=true`, which creates and updates tables from entities. Do not add migration files for new tables.
- **Schema changes**: Prefer updating the entity definition; sync will apply changes. Only add or edit migrations when the user explicitly requests a migration (e.g. for a one-off data migration or a view).

# Deployment plan

Any time you finish a development, list all the lambdas that need to be redeployed and their deployment order.
