const fs = require('fs');
const path = require('path');

async function runSqlFile(db, fileName) {
  const filePath = path.join(__dirname, 'sqls', fileName);
  const data = fs.readFileSync(filePath, { encoding: 'utf8' });
  const statements = data
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    await db.runSql(statement);
  }
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
