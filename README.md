# 6529SEIZE-BACKEND

This is a 2-part repository for

1. [6529 Backend](#user-content-1-backend)

2. [6529 API](#user-content-2-api)

## 0. Repo Helpers

This repo includes a `.envrc` for `direnv`.

It is only used for repo-local shell helpers. Right now it adds the repo `bin/` directory to your `PATH`, which makes commands like `ghruns` and `ghdeploy` available anywhere inside this repository.

It does not load `.env.local` and it does not set `NODE_ENV`.

### 0.1 Setup direnv

1. Install `direnv` on your machine.
2. Enable the `direnv` shell hook.

For `zsh`, add this to `~/.zshrc`:

```bash
eval "$(direnv hook zsh)"
```

For `bash`, add this to `~/.bashrc`:

```bash
eval "$(direnv hook bash)"
```

Then reload your shell config, for example:

```bash
source ~/.zshrc
```

### 0.2 Allow this repo

From the repo root, run:

```bash
direnv allow
```

If `.envrc` changes later, run:

```bash
direnv allow
```

again to approve the updated file.

### 0.3 Verify

From the repo root, you should be able to run:

```bash
which ghruns
ghruns
```

`ghruns` is a shortcut for:

```bash
gh run list -R "6529-Collections/6529seize-backend"
```

In an interactive terminal, `ghruns` opens a live dashboard instead of printing a one-time snapshot. It refreshes automatically every 5 seconds, keeps the same repo scope, and still accepts the usual `gh run list` filters like `--branch`, `--workflow`, `--status`, and `-L`.

`ghruns` controls:

- `Up` / `Down` moves through the recent runs

The dashboard falls back to plain `gh run list` output in non-interactive shells and when you use output-formatting flags like `--json`, `--jq`, or `--template`.

### 0.4 Deploy Helper

`ghdeploy` triggers the GitHub Actions deploy workflow for this repo.

You can run it from anywhere inside this repository, but it only works in these locations:

- In the repo root, it opens an interactive multi-select list of all deployable workflow services, including `api`.
- In `src/<service>`, it uses the folder name as the deploy service.
- In `src/api-serverless`, it maps to service `api`.

The single source of truth for deployable services is `src/config/deploy-services.json`.
`.github/workflows/deploy.yml` is generated from it, and the API deploy UI reads the same JSON directly.

Before it triggers the GitHub workflow, it checks that:

- the current branch is not detached
- the working tree is fully clean, including no untracked files
- the current branch has an upstream
- the current branch is exactly in sync with its upstream after a fetch

### 0.4.1 Use `ghdeploy` from repo root

From the repo root, run:

```bash
ghdeploy
```

This opens:

- a single-select environment picker for `staging` or `prod`
- then a multi-select service picker with all deployable services

Environment picker controls:

- `Up` / `Down` moves between `staging` and `prod`
- `Enter` confirms the highlighted environment
- `q` cancels

Service picker controls:

- `Up` / `Down` moves through the service list
- `Space` toggles the current service
- `Enter` confirms the selected services
- `q` cancels

The list scrolls automatically as you move beyond the visible items. `j` / `k` and `x` also work as fallback keys if your terminal handles arrows or space oddly.

Root mode prompts once for `staging` or `prod`, uses that environment for the whole batch, then dispatches one GitHub workflow run per selected service. If one dispatch fails, it asks whether to continue with the remaining services and prints a success/failure/skipped summary at the end.

### 0.4.2 Use `ghdeploy` from a service folder

If you only want to deploy one service, `cd` into that service folder and run:

```bash
cd src/tdhLoop
ghdeploy
```

Single-service mode opens the same environment picker, resolves the service from the current folder, and then triggers:

```bash
gh workflow run "Deploy a service" \
  --ref <current-branch> \
  -f environment=<selected-environment> \
  -f service=<resolved-service> \
  -R 6529-Collections/6529seize-backend
```

Examples:

- `src/tdhLoop` deploys service `tdhLoop`
- `src/api-serverless` deploys service `api`

If you run `ghdeploy` from an unsupported folder, it fails with a clear error instead of guessing.

## 1. Backend

### 1.1 Install

```
npm i
```

### 1.2 Build

```
npm run build
```

### 1.3 Environment

To run the project you need a .env file.

The name of your .env file must include the environment you want to run like `.env.local` / `.env.development` / `.env.production`

[Sample .env file](https://github.com/6529-Collections/6529seize-backend/tree/main/.env.sample)

### 1.4 Run

Before running anything, either manually run `npm run migrate:up` or make sure `dbMigrationsLoop` is run.

#### 1.4.1 using npm

```
npm run backend:env
```

#### 1.4.2 using PM2

```
pm2 start npm --name=6529backend -- run backend:env
```

\* Note: env can be one of: `local` / `dev` / `prod`

#### 1.4.3 using AWS Lambda

This repository is configured to be runnable through AWS Lambdas. Each 'loop' folder in the code represents a lambda function and can be built and deployed on AWS individually. \* Note: additional setup is required within AWS in order to configure environment variables and triggers for each lambda.

\* Note: env can be one of: `local` / `dev` / `prod`

### 1.5 Notes

- **Running database for development:** You can use docker and docker-compose for this. Run `docker-compose up -d` in project root and configure your `.env` exactly as DB part in `.env.sample`.

- **Database and ORM:** Backend service is using [TYPEORM](https://www.npmjs.com/package/typeorm). When starting a service, if the database is successful then the ORM will take care of synchronising the schema for the database and creating the necessary tables. \* Note: You will need to create the database and user and provide them in the .env file. Only thing TypeORM doesn't take care of, are views. Those are created with migrations. So you should either run `npm run migrate:up` or make sure `dbMigrationsLoop` is run to be sure that all migrations are applied.

- **CRON:** When starting the service, there are several scheduled cron jobs running at specific intervals which will consume data from the chain, process and save the result to the database.
  e.g. discovering NFTs - there is a scheduled cron job to run every 3 minutes which detects new nfts minted on the chain or any changes to existing nfts.

- **S3 and Video Compression:** [S3Uploader](https://github.com/6529-Collections/6529seize-backend/tree/main/src/s3Uploader). The s3Uploader persists compressed versions of the nft images and videos on AWS S3. This worker is configured to only run in `prod` mode. Video compression requires ffmpeg installed on the running machine.
  Download instructions at: https://ffmpeg.org/

- Creating new migrations: Run `npm run migrate:new name-of-the-migration`. Three new files are created in `migrations folder`. A javascript file and 2 SQL files. Find the "up" SQL file and write the SQL for new migration there. Then run `npm run migrate:up` to apply the new migration. You can write reverse migration if you wish in the "down" SQL file.

## 2. API

PORT: 3000

PATH: [src/api-serverless](https://github.com/6529-Collections/6529seize-backend/tree/main/src/api-serverless)

### 2.1 Install

```
cd src/api-serverless
npm i
```

### 2.2 Build

```
cd src/api-serverless
npm run build
```

### 2.3 Environment

To run the project you need a .env file.

The name of your .env file must include the environment you want to run like `.env.local` / `.env.development` / `.env.production`

[Sample .env file](https://github.com/6529-Collections/6529seize-backend/tree/main/src/api-serverless/.env.sample)

### 2.4 Run

In project root directory:

```
npm run api:env
```

\* Note: env can be one of: local / dev / prod

### 2.5 RUN USING PM2

```
pm2 start npm --name=6529api -- run api:env
```

\* Note: env can be one of: `local` / `dev` / `prod`

### 2.6 RUN USING AWS Lambda

The API is also configured to run as an AWS lambda and can be built and deployed on AWS on its own. \* Note: additional setup is required within AWS in order to configure environment variables and API Gateway.

### 2.7 Rate Limiting

The API implements rate limiting to protect against abuse and ensure fair usage. Rate limiting is applied to all API requests and uses Redis for distributed rate limit tracking.

**Important:** Rate limiting requires Redis to be available. If Redis is not available, rate limiting will be automatically disabled even if `API_RATE_LIMIT_ENABLED` is set to `true`.

#### 2.7.1 How It Works

Rate limiting uses a two-tier approach:

1. **Burst Limit**: Maximum requests per second (short-term burst protection)
2. **Sustained Limit**: Maximum requests per second averaged over a time window (long-term protection)

Both limits are checked for each request. If either limit is exceeded, the request is rejected with a `429 Too Many Requests` response.

#### 2.7.2 User Identification Priority

The rate limiter identifies users in the following priority order:

1. **Authenticated Wallet** (highest priority)

   - Uses the wallet address from JWT authentication
   - Gets higher rate limits (authenticated config)
   - Format: `wallet:{walletAddress}`

2. **Signed Internal Request** (for SSR requests)

   - Used for server-side requests from the web app (e.g., AWS Elastic Beanstalk)
   - Requires signed headers to prevent spoofing
   - **Skips rate limiting entirely** (bypasses all rate limit checks)
   - The signature ensures only the web app (with the secret) can generate valid requests

3. **IP Address** (fallback)
   - Used when no authentication or internal request headers are present
   - Uses unauthenticated rate limits
   - Format: `ip:{ipAddress}`

#### 2.7.3 Internal Request Signing (SSR Requests)

For server-side requests from the web app, you can bypass IP-based rate limiting by sending signed headers. This is necessary when all requests appear to come from the same IP (e.g., AWS Elastic Beanstalk).

**Required Headers:**

- `X-6529-Internal-Id`: The internal ID (must match `API_RATE_LIMIT_INTERNAL_ID` env var)
- `X-6529-Internal-Timestamp`: Unix timestamp in seconds
- `X-6529-Internal-Signature`: HMAC-SHA256 signature

**Signature Generation:**
The signature is calculated as:

```
HMAC-SHA256(secret, `${internalId}\n${timestamp}\n${method}\n${path}`)
```

Where:

- `secret` = `API_RATE_LIMIT_INTERNAL_SECRET` (shared secret)
- `internalId` = `API_RATE_LIMIT_INTERNAL_ID` (from env)
- `timestamp` = Current Unix timestamp in seconds
- `method` = HTTP method (GET, POST, etc.)
- `path` = Request path (e.g., `/api/nfts`)

**Security Features:**

- Timestamp tolerance: 5 minutes (prevents replay attacks)
- Timing-safe comparison (prevents timing attacks)
- Request method and path included in signature (prevents signature reuse)

**Example (Node.js):**

```javascript
const crypto = require('crypto');

const internalId = process.env.API_RATE_LIMIT_INTERNAL_ID;
const secret = process.env.API_RATE_LIMIT_INTERNAL_SECRET;
const method = 'GET';
const path = '/api/nfts';
const timestamp = Math.floor(Date.now() / 1000);

const payload = `${internalId}\n${timestamp}\n${method}\n${path}`;
const signature = crypto
  .createHmac('sha256', secret)
  .update(payload)
  .digest('hex');

// Send headers
headers: {
  'X-6529-Internal-Id': internalId,
  'X-6529-Internal-Timestamp': timestamp.toString(),
  'X-6529-Internal-Signature': signature
}
```

#### 2.7.4 Configuration

Rate limiting is configured via environment variables (see `.env.sample`):

**Enable/Disable:**

- `API_RATE_LIMIT_ENABLED`: Must be set to `'true'` to enable rate limiting (default: disabled)
  - Rate limiting also requires Redis to be available
  - If Redis is not available, rate limiting will be disabled even if this is set to `'true'`

**Authenticated Users:**

- `API_RATE_LIMIT_AUTH_BURST`: Burst limit per second (default: 30)
- `API_RATE_LIMIT_AUTH_SUSTAINED_RPS`: Sustained requests per second (default: 10)
- `API_RATE_LIMIT_AUTH_SUSTAINED_WINDOW_SECONDS`: Time window for sustained limit (default: 60)

**Unauthenticated Users:**

- `API_RATE_LIMIT_UNAUTH_BURST`: Burst limit per second (default: 20)
- `API_RATE_LIMIT_UNAUTH_SUSTAINED_RPS`: Sustained requests per second (default: 5)
- `API_RATE_LIMIT_UNAUTH_SUSTAINED_WINDOW_SECONDS`: Time window for sustained limit (default: 60)

**Internal Requests (SSR):**

- `API_RATE_LIMIT_INTERNAL_ID`: Internal ID for signed requests (required)
- `API_RATE_LIMIT_INTERNAL_SECRET`: Shared secret for signing requests (required)

#### 2.7.5 Response Headers

All responses include rate limit headers:

- `X-RateLimit-Limit`: Maximum requests allowed
- `X-RateLimit-Remaining`: Remaining requests in current window
- `X-RateLimit-Reset`: Unix timestamp when the rate limit resets

When rate limited (429 response):

- `Retry-After`: Seconds to wait before retrying

#### 2.7.6 Implementation Details

- **Storage**: Uses Redis sorted sets for efficient sliding window tracking
- **Redis Required**: Rate limiting requires Redis to be available. If Redis is not available, rate limiting is automatically disabled at startup
- **Fail Open**: If rate limiting middleware encounters an error during request processing, requests are allowed (fail open behavior)
- **Distributed**: Works across multiple API instances using shared Redis
- **Efficient**: Uses sorted sets with automatic expiration for memory management

## 3. Admin Panel (Optional)

Currently 6529.io uses an Admin Panel to manage:

- distribution lists and presentations
- team members
- royalties

The admin panel repo is located [here](https://github.com/6529-Collections/6529seize-admin).

\* Note: Please bear in mind that in the near future the admin panel will be deprecated and all functionality will be moved to the 6529SEIZE-BACKEND repo.
