import AWS from 'aws-sdk';
import { TDHENS } from './entities/ITDH';
import { OwnerMetric } from './entities/IOwner';
import { areEqualAddresses } from './helpers';
import { SIX529_MUSEUM } from './constants';
const converter = require('json-2-csv');

const config = require('./config');

const s3 = new AWS.S3({
  accessKeyId: config.aws.AWS_ACCESS_KEY_ID,
  secretAccessKey: config.aws.AWS_SECRET_ACCESS_KEY
});

const myBucket = config.aws.AWS_IMAGES_BUCKET_NAME;

export const uploadTDH = (
  tdh: TDHENS[],
  ownerMetrics: OwnerMetric[],
  db: any
) => {
  const block = tdh[0].block;

  console.log(
    new Date(),
    '[TDH UPLOAD]',
    `[BLOCK ${block}]`,
    `[TDH ${tdh.length}]`,
    `[OWNER METRICS ${ownerMetrics.length}]`,
    `[ASYNC]`
  );

  const tdhProcessed = tdh.map((tdh) => {
    const {
      date,
      memes_tdh_season2,
      memes_tdh_season2__raw,
      memes_balance_season2,
      ...rest
    } = tdh;
    if (!rest.ens) {
      if (areEqualAddresses(rest.wallet, SIX529_MUSEUM)) {
        rest.ens = '6529Museum';
      } else {
        rest.ens = '';
      }
    }
    return rest;
  });

  const ownerMetricProcessed = ownerMetrics.map((om) => {
    const { balance, ...rest } = om;
    return rest;
  });

  const combinedArray = tdhProcessed.reduce((combined: any[], tdhProcessed) => {
    const ownerMetric = ownerMetricProcessed.find((om) =>
      areEqualAddresses(om.wallet, tdhProcessed.wallet)
    );
    if (ownerMetric) {
      combined.push({ ...tdhProcessed, ...ownerMetric });
    }
    return combined;
  }, []);

  combinedArray.sort((a, b) => a.tdh_rank - b.tdh_rank);

  converter.json2csv(combinedArray, async (err: any, csv: any) => {
    if (err) throw err;

    const dateString = formatDate(new Date());

    const fileKey = `backend_uploads/${process.env.NODE_ENV}/tdh/${block}_${dateString}/seizers_${block}_${dateString}.csv`;
    const uploadedTDH = await s3
      .upload({
        Bucket: myBucket,
        Key: fileKey,
        Body: Buffer.from(csv),
        ContentType: `text/csv`
      })
      .promise();

    console.log(
      new Date(),
      '[TDH UPLOAD]',
      `[FILE PERSISTED AT ${uploadedTDH.Location}`
    );

    await db.persistTdhUpload(block, dateString, uploadedTDH.Location);
  });
};

function padTo2Digits(num: number) {
  return num.toString().padStart(2, '0');
}

function formatDate(date: Date) {
  return [
    date.getFullYear(),
    padTo2Digits(date.getMonth() + 1),
    padTo2Digits(date.getDate())
  ].join('');
}
