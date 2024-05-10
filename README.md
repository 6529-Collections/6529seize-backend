# SEIZE-LITE

1. [Infra](#1-infra)

2. [Clone Repository](#2-clone-repository)

3. [Build](#3-build)

4. [Set Environment](#4-set-environment)

5. [Restore](#5-restore)

6. [Get PM2](#6-get-pm2)

7. [Run Services](#6-run-services)

## 1. INFRA

**Prerequisites:**

- you have an AWS EC2 instance configured (<a href="https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html" target="_blank" rel="noopener noreferrer">Read More</a>)

- you have an AWS RDS instance configured (<a href="https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html" target="_blank" rel="noopener noreferrer">Read More</a>)

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

**Note:**

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

## 6. Get PM2

Services run using <a href="https://pm2.keymetrics.io/" target="_blank" rel="noopener noreferrer">PM2</a>

### 6.1 Install

```
npm install pm2@latest -g
```

### 6.1 Configure to Auto-restart on System Reboot

To ensure your application starts on system boot, you can use PM2’s startup script generator. Run the following command and follow the instructions provided:

```
pm2 startup
```

### 6.2 Set Up Log Rotation

PM2 can also manage log rotation, which is critical for ensuring that logs do not consume all available disk space.

### 6.2.1 Install the PM2 log rotation module

```
pm2 install pm2-logrotate
```

### 6.2.2 Configure log rotation settings (optional)

```
pm2 set pm2-logrotate:max_size 100M  # Rotate logs once they reach 100MB
pm2 set pm2-logrotate:retain 10      # Keep 10 rotated logs
pm2 set pm2-logrotate:compress true  # Compress (gzip) rotated logs
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD # Set the date format used in the log file names
pm2 set pm2-logrotate:rotateModule true     # Rotate the log of pm2-logrotate itself
```

## 7. Run Services

### 7.1 Run Backend

- PM2 process name: 6529backend

```
pm2 start npm --name=6529backend -- run backend
```

- **CRON:** When starting the service, there are several scheduled cron jobs running at specific intervals which will consume data from the chain, process and save the result to the database.
  e.g. discovering Transactions - there is a scheduled cron job to run every 2 minutes which detects new transactions on the chain and saves them in the database

- **Note:** On start, this service will always run the tdh calculation on start and the schedule it to run at 00:00 UTC

### 7.2 Run API

- PM2 process name: 6529api
- PORT: 3000

```
pm2 start npm --name=6529api -- run api
```

**Note:** To ensure PM2 knows which processes to restart at boot, you need to save the after starting the services

```
pm2 save
```
