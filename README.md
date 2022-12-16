# 6529SEIZE BACKEND

BACKEND PORT: 3001
API PORT: 3000

# Setup

## Install

```
npm i
```

## Build

```
npm run build
```

# Services

## LOCAL

```
npm run backend:local
npm run api:local
```

## STAGING

```
npm run backend:dev
npm run api:dev
```

PM2

```
pm2 start npm --name=6529backend -- run backend:dev
pm2 start npm --name=6529api -- run api:dev
```

## LIVE

```
npm run backend:prod
npm run api:prod
```

PM2

```
pm2 start npm --name=6529backend -- run backend:prod
pm2 start npm --name=6529api -- run api:prod
```
