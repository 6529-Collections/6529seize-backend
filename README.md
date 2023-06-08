# 6529SEIZE-BACKEND

This is a 2-part repository for

1. [6529 Backend](#backend)

2. [6529 API](#api)

## 1. Backend

### Install

```
npm i
```

### Build

```
npm run build
```

### Environment

To run the project you need a .env file.

The name of your .env file must include the environment you want to run like `.env.local` / `.env.development` / `.env.production`

[Sample .env file](https://github.com/6529-Collections/6529seize-backend/tree/main/.env.sample)

### Run

```
npm run backend:env
```

\* Note: env can be one of: `local` / `dev` / `prod`

### Database and ORM

Backend service is using [TYPEORM](https://www.npmjs.com/package/typeorm). When starting a service, if the database is successful then the ORM will take care of synchronising the schema for the database and creating the necessary tables. \* Note: You will need to create the database and user and provide them in the .env file.

### CRON

When starting the service, there are several scheduled cron jobs running at specific intervals which will consume data from the chain, process and save the result to the database.

e.g. discovering NFTs - there is a scheduled cron job to run every 3 minutes which detects new nfts minted on the chain or any changes to existing nfts.

### Additional Setup

s3.tsx video compression requires ffmpeg installed on the running machine

Download instructions at: https://ffmpeg.org/

### RUN USING PM2

```
pm2 start npm --name=6529backend -- run backend:env
```

\* Note: env can be one of: `local` / `dev` / `prod`

### RUN USING AWS Lambda

This repository is configured to be runnable through AWS Lambdas. Each 'loop' folder in the code represents a lambda function and can be built and deployed on AWS individually. \* Note: additional setup is required within AWS in order to configure environment variables and triggers for each lambda.

## 2. API

PORT: 3000

PATH: [src/api-serverless](https://github.com/6529-Collections/6529seize-backend/tree/main/src/api-serverless)

### Install

```
cd src/api-serverless
npm i
```

### Build

```
cd src/api-serverless
npm run build
```

### Environment

To run the project you need a .env file.

The name of your .env file must include the environment you want to run like `.env.local` / `.env.development` / `.env.production`

[Sample .env file](https://github.com/6529-Collections/6529seize-backend/tree/main/src/api-serverless/.env.sample)

### Run

In project root directory:

```
npm run api:env
```

\* Note: env can be one of: local / dev / prod

### RUN USING PM2

```
pm2 start npm --name=6529api -- run api:env
```

\* Note: env can be one of: `local` / `dev` / `prod`

### RUN USING AWS Lambda

The API is also configured to run as an AWS lambda and can be built and deployed on AWS on its own. \* Note: additional setup is required within AWS in order to configure environment variables and API Gateway.
