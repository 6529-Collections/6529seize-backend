const fs = require('fs');
const path = require('path');

exports.up = async function (db) {
  const filePath = path.join(
    __dirname,
    'sqls',
    '20260617222400-profile-cms-pointer-events-up.sql'
  );
  const data = fs.readFileSync(filePath, { encoding: 'utf8' });
  await db.runSql(data);
};

exports.down = async function () {
  return null;
};
