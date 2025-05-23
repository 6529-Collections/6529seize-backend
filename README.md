# 6529SEIZE-BACKEND

This is a 2-part repository for

1. [6529 Backend](#user-content-1-backend)

2. [6529 API](#user-content-2-api)

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

- **S3 and Video Compression:** [S3Loop](https://github.com/6529-Collections/6529seize-backend/tree/main/src/s3Loop). The s3Loop persists compressed versions of the nft images and videos on AWS S3. This loop is configured to only run in `prod` mode. Video compression requires ffmpeg installed on the running machine.
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

## 3. Admin Panel (Optional)

Currently 6529.io uses an Admin Panel to manage:

- distribution lists and presentations
- team members
- royalties

The admin panel repo is located [here](https://github.com/6529-Collections/6529seize-admin).

\* Note: Please bear in mind that in the near future the admin panel will be deprecated and all functionality will be moved to the 6529SEIZE-BACKEND repo.
