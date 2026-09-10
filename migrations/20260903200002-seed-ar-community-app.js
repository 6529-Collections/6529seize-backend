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
    '20260903200002-seed-ar-community-app-up.sql'
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

exports.down = function (db) {
  return db.runSql(
    "DELETE FROM community_app_clients WHERE client_id = 'ar-community-platform'"
  );
};

exports._meta = {
  version: 1
};