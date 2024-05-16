# SEIZE-LITE

[1. Infrastructure](#1-infrastructure)

[2. Setup](#2-Setup)

- 2.1 [2.1 Manual Setup](#21-manual-setup)
- 2.2 [Scripted Setup](#22-scripted-setup)

3. [Set Environment](#3-set-environment)

4. [Initialize DB](#4-initialize-db)

- 4.1 [Restore Snapshot](#41-restore)
- 4.2 [Direct Load](#42-direct-load)

5. [Run Services](#5-run-services)

- 5.1 [Manual Start](#51-manual-start)
- 5.2 [Scripted Start](#52-scripted-start)

6. [Updates](#6-updates)

- 6.1 [Manual Update](#61-manual-update)
- 6.2 [Scripted Update](#52-scripted-update)

## 1. Infrastructure

**Prerequisites:**

- you have an AWS EC2 instance configured (<a href="https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html" target="_blank" rel="noopener noreferrer">Read More</a>)

- you have an AWS RDS instance configured (<a href="https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html" target="_blank" rel="noopener noreferrer">Read More</a>)

## 2. Setup

Choose between [2.1 Manual Setup](#21-manual-setup) or [2.2 Scripted Setup](#22-scripted-setup)

### 2.1 Manual Setup

#### 2.1.1 Clone Repository

Clone repository "6529seize-backend" at branch `seize-lite`

```
git clone --branch seize-lite https://github.com/6529-Collections/6529seize-backend.git
```

#### 2.1.2 Install NPM

```
sudo apt install npm
```

Note: We need npm version v21. Get it using `n`

```
sudo npm i n -g
```

Select v21 using

```
sudo n 21
```

Reset your session using `hash -r`

#### 2.1.2 Install Project Dependencies

```
npm i
```

#### 2.1.3 Build Project

```
npm run build
```

#### 2.1.4 PM2

Services run using <a href="https://pm2.keymetrics.io/" target="_blank" rel="noopener noreferrer">PM2</a>

##### 2.1.4.1 Install PM2

```
npm install pm2@latest -g
```

##### 2.1.4.2 Configure to Auto-restart on System Reboot

To ensure your application starts on system boot, you can use PM2’s startup script generator. Run the following command and follow the instructions provided:

```
pm2 startup
```

##### 2.1.4.3 Set Up Log Rotation

PM2 can also manage log rotation, which is critical for ensuring that logs do not consume all available disk space.

```
pm2 install pm2-logrotate
```

Configure log rotation settings (optional)

```
pm2 set pm2-logrotate:max_size 100M  # Rotate logs once they reach 100MB
pm2 set pm2-logrotate:retain 10      # Keep 10 rotated logs
pm2 set pm2-logrotate:compress true  # Compress (gzip) rotated logs
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD # Set the date format used in the log file names
pm2 set pm2-logrotate:rotateModule true     # Rotate the log of pm2-logrotate itself
```

### 2.2 Scripted Setup

```
scripts/setup.sh
```

## 3. Set Environment

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

## 4. Initialize DB

The database expects some initial data. Choose to load either from latest snapshot or directly

## 4.1 Restore Snapshot

Restore database from the latest snapshot using the following

```
npm run restore
```

## 4.2 Direct Load

Two main components need to be loaded directly:

### 4.2.1 NFTDelegation

Run the following to restore data from NFTDelegation contract

```
npm run direct_load_nftd
```

### 4.2.2 Transactions

Run the following to restore transaction data

```
npm run direct_load_trx
```

## 5. Run Services

Choose between [5.1 Manual Start](#51-manual-start) or [5.2 Scripted Start](#52-scripted-start)

### 5.1 Manual Start

#### 5.1.1 Run Backend

- PM2 process name: 6529backend

```
pm2 start npm --name=6529backend -- run backend
```

- **CRON:** When starting the service, there are several scheduled cron jobs running at specific intervals which will consume data from the chain, process and save the result to the database.
  e.g. discovering Transactions - there is a scheduled cron job to run every 2 minutes which detects new transactions on the chain and saves them in the database

- **Note:** On start, this service will always run the tdh calculation on start and the schedule it to run at 00:00 UTC

#### 5.1.2 Run API

- PM2 process name: 6529api
- PORT: 3000

```
pm2 start npm --name=6529api -- run api
```

**Note:** To ensure PM2 knows which processes to restart at boot, you need to save the list after starting the services

```
pm2 save
```

### 5.2 Scripted Start

```
scripts/start.sh
```

### 5.3 Test

### 5.3.1 Local

To test your api locally, navigate in your browser to:

```
http://localhost:3000/api/tdh/<address>
```

### 5.3.2 AWS

If you are using AWS EC2, navigate to

```
http://[ip-address]:3000/api/tdh/<address>
```

Note: Please make sure that you have added an inbound rule on the instance security group for port 3000

Compare the response with

```
https://api.seize.io/api/tdh/<address>
```

## 6 Updates

Choose between [6.1 Manual Update](#61-manual-update) or [6.2 Scripted Update](#62-scripted-update)

### 6.1 Manual Update

#### 6.1.1 Pull new changes

```
git pull
```

#### 6.1.2 Re-Install

```
npm i
```

#### 6.1.3 Re-Build

```
npm run build
```

#### 6.1.4 Restart Backend and API

```
pm2 restart 6529backend
pm2 restart 6529api
```

### 6.2 Scripted Update

```
scripts/update.sh
```
