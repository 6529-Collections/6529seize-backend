'use strict';

var dbm;
var type;
var seed;
var fs = require('fs');
var path = require('path');
var Promise;

exports.setup = function (options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
  Promise = options.Promise;
};

exports.up = function (db) {
  var filePath = path.join(
    __dirname,
    'sqls',
    '20260819170000-fix-erc4337-mint-transaction-value-up.sql'
  );
  return new Promise(function (resolve, reject) {
    fs.readFile(filePath, { encoding: 'utf-8' }, function (err, data) {
      if (err) return reject(err);
      resolve(data);
    });
  }).then(function (data) {
    return db.runSql(data);
  });
};

exports.down = function () {
  // Intentionally irreversible: the prior value and value_usd were both 0,
  // and restoring the known-wrong values would reintroduce the data defect.
  return Promise.resolve();
};

exports._meta = {
  version: 1
};
