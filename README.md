# 6529SEIZE-BACKEND

Contents

1. [Infra](#1-infra)

2. [Clone Repository](#2-clone-repository)

3. [Build](#3-build)

4. [Set Environment](#4-set-environment)

5. [Restore](#5-restore)

6. [Run Services](#6-run-services)

## 1. INFRA

...

## 2. Clone Repository

Clone repository "6529seize-backend" at branch `seize-lite`

```
git clone --branch seize-lite git@github.com:6529-Collections/6529seize-backend.git
```

## 3. Build

### 3.1 Install

```
npm i
```

### 3.2 Build

```
npm run build
```

## 4. Set Environment

To run the project you need a file to hold environment variable. The following script with run you through the process of creating this file.

Notes:

- you will be asked to provide database credentials

  - host
  - port
  - admin user and password (used to create database and new users for the services but not saved in .env file)
  - new database user/password

- you will be asked to provide Alchemy API key (get one <a href="https://docs.alchemy.com/docs/alchemy-quickstart-guide" target="_blank" rel="noopener noreferrer">here</a>)

- at the end of this process:
  - new database created
  - new read and write users created
  - database tables created (empty)
  - a new file will be created `.env.lite`

```
npm run set_env
```

<a href="https://github.com/6529-Collections/6529seize-backend/blob/seize-lite/.env.sample" target="_blank" rel="noopener noreferrer">Sample .env file</a>

## 5. Restore

Restore database from the latest snapshot using the following

```
npm run restore
```

## 6. Run Services

Run services using <a href="https://pm2.keymetrics.io/" target="_blank" rel="noopener noreferrer">PM2</a>

### 6.1 Run Backend

```
pm2 start npm --name=6529backend -- run backend
```

- **CRON:** When starting the service, there are several scheduled cron jobs running at specific intervals which will consume data from the chain, process and save the result to the database.
  e.g. discovering Transactions - there is a scheduled cron job to run every 2 minutes which detects new transactions on the chain and saves them in the database

### 6.1 Run API

PORT: 3000

```
pm2 start npm --name=6529api -- run api:env
```
