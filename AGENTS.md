# Commiting to Git

**NEVER commit unless explicitly asked to by the user.** Do not assume the user wants you to commit. Wait for explicit instructions like "commit" or "commit this".

When you DO commit (only when explicitly asked), add a DCO signature to footer with my name and the corresponding accountcode+username@users.noreply.github.com email address. Example:

```
Add tests for address comparison
Signed-off-by: IAmAUser <1234567+IAmAUser@users.noreply.github.com>
```

# Writing unit tests

1. Put the tests next to file being tested.
2. Test file name should always end with `.test.ts`
3. Words in test file names should always be separated with dashes (except for the suffix `.test.ts`) and be all lowercase. For example if you test function doThis then the test file should be `do-this.test.ts`
4. Use fast-check where reasonable
5. When doing DB/Repository tests take example from file src/profiles/abusiveness-check.db.test.ts

# Linting

After you do your changes then run `npm run lint`. Make sure you fix all errors and warnings.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the 6529 SEIZE Backend repository, a Web3 NFT platform backend that handles NFT indexing, community features (drops, waves, ratings), user profiles, delegations, and comprehensive REST API services. It consists of two main components:

1. **Backend Services** - Scheduled loop processes (Lambdas/cron jobs) that index blockchain data, process transactions, and update aggregated metrics
2. **API Services** - Express-based REST API with JWT authentication, rate limiting, WebSocket support, and comprehensive endpoints for NFT and community data

## Commands

### Development

```bash
# Install dependencies
npm i

# Build the project (includes tests)
npm run build

# Format code
npm run format

# Lint code
npm run lint

# Run tests
npm test
```

### Backend Services

```bash
# Run backend locally
npm run backend:local

# Run backend in development
npm run backend:dev

# Run backend in production
npm run backend:prod
```

### API Services

```bash
# Run API in development
cd src/api-serverless && npm run api:local

# Build API separately
cd src/api-serverless && npm run build
```

### Database Migrations

```bash
# Run migrations up (apply new migrations)
npm run migrate:up

# Run migrations down (rollback)
npm run migrate:down

# Create new migration
npm run migrate:new name-of-the-migration

# Local development migrations
npm run migrate-local:up
npm run migrate-local:down
```

After creating a migration, edit the generated SQL files in the `migrations` folder (write SQL in the "up" file, and just delete the "down" file, also replace the down implementation in js file with "do nothing" implementation).

### Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test path/to/test.spec.ts
```

The test configuration uses:
- Jest with ts-jest preset
- Testcontainers for MySQL integration tests
- Global setup/teardown in `src/tests/_setup/`
- 30-second timeout for database operations

## Architecture

### Loop-Based Services (Backend)

The backend consists of independent "loop" services that run as AWS Lambda functions or cron jobs. Each loop is self-contained in `src/*Loop/` directories:

**Key Loops:**
- `nftsLoop` - Discovers and indexes NFTs from blockchain
- `nftOwnersLoop` - Tracks NFT ownership changes
- `nftHistoryLoop` - Maintains NFT ownership history
- `transactionsProcessingLoop` - Processes blockchain transactions
- `tdhHistoryLoop` - Calculates TDH (The Destructive Hemisphere) scores
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
- **Generated Models** (`generated/models/`) - TypeScript API response models

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
- Every time a new Entity is added it also needs to be exported in `entitites.ts`.

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

**TDH (The Destructive Hemisphere):**
- Scoring system based on NFT ownership and community participation
- Consolidated calculations across wallet consolidations
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
3. Run migrations: `npm run migrate-local:up`
4. Start backend: `npm run backend:local` (optional)
5. Start API: `cd src/api-serverless && npm run dev`

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
- Any time you change this file run `cd src/api-serverless && npm run restructure-openapi && npm run generate`
- This will generate response models to `src/api-serverless/src/generated/models`, but only response models and POST/DELETE request bodies, not routes and query param models.
- Routes themselves are manually created into `api-serverless` into files ending with `.routes.ts` and are wired in `app.ts` file.
- Generated API models are used in those routes. For query param based requests, types are created manually.

### Imports and path aliases

Use path aliases for **new** imports where applicable. Do not change existing imports to aliases just for consistency, to avoid unnecessary noise and large diffs.

- In **api-serverless** (see `src/api-serverless/tsconfig.paths.json`): Use `@/` for repo `src/` (e.g. `@/constants`, `@/numbers`, `@/sql-executor`). Use `@/api/*` for files under api-serverless `src/` (e.g. `@/api/memes-minting/allowlist-merkle`, `@/api/memes-minting/api.memes-minting.db`). New code in api-serverless must use these aliases, not relative paths for cross-folder imports.
- In **root** (e.g. loops, src outside api-serverless): root `tsconfig.json` has `@/*` → `src/*`; use `@/constants`, `@/entities`, etc. when adding new code.

# API types and OpenAPI (api-serverless)

All API request/response types must be defined via OpenAPI and the generated models. Do not hand-roll response types for API endpoints unless explicitly asked not to.

1. **Define in OpenAPI**: Add the endpoint and its request/response schemas in `src/api-serverless/openapi.yaml` (paths and `components/schemas`).
2. **Generate**: From `src/api-serverless` run `npm run restructure-openapi` then `npm run generate`. This creates/updates types under `src/api-serverless/src/generated/models/`.
3. **Use in routes**: Import from `@/api/generated/models/...` (or `../generated/models/...`) and use the generated classes for responses (and for POST/PUT bodies where applicable). Map your DB/service output to the generated model shape (e.g. snake_case properties) before returning.

# Database schema and migrations

Do **not** create new migrations for table creation or schema changes unless the user explicitly asks for them. Assume migrations are not needed.

- **New tables**: Add TypeORM entities and export them in `src/entities/entities.ts`. The dbMigrations loop runs with `sync=true`, which creates and updates tables from entities. Do not add migration files for new tables.
- **Schema changes**: Prefer updating the entity definition; sync will apply changes. Only add or edit migrations when the user explicitly requests a migration (e.g. for a one-off data migration or a view).
