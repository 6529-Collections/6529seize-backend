const fs = require('fs');
const path = require('path');

async function runSqlFile(db, fileName) {
  const filePath = path.join(__dirname, 'sqls', fileName);
  const data = fs.readFileSync(filePath, { encoding: 'utf8' });
  await db.runSql(data);
}

exports.up = async function (db) {
  await runSqlFile(
    db,
    '20260617222400-profile-cms-pointer-events-up.sql'
  );
  await runSqlFile(
    db,
    '20260617222400-profile-cms-publish-signatures-up.sql'
  );
};

exports.down = async function (db) {
  await runSqlFile(
    db,
    '20260617222400-profile-cms-publish-signatures-down.sql'
  );
  await runSqlFile(
    db,
    '20260617222400-profile-cms-pointer-events-down.sql'
  );
};
