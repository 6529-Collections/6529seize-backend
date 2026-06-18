const fs = require('fs');
const path = require('path');

exports.up = async function (db) {
  const filePath = path.join(
    __dirname,
    'sqls',
    '20260617222400-profile-cms-pointer-events-up.sql'
  );
  const data = fs.readFileSync(filePath, { encoding: 'utf8' });
  const statements = data
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    await db.runSql(statement);
  }
};

exports.down = async function () {
  return null;
};
