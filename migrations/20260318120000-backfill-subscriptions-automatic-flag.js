'use strict';

var dbm;
var type;
var seed;
var fs = require('fs');
var path = require('path');
var Promise;

exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
  Promise = options.Promise;
};

exports.up = function(db) {
  var filePath = path.join(__dirname, 'sqls', '20260318120000-backfill-subscriptions-automatic-flag-up.sql');
  return new Promise(function(resolve, reject) {
    fs.readFile(filePath, { encoding: 'utf-8' }, function(err, data) {
      if (err) return reject(err);
      resolve(data);
    });
  }).then(function(data) {
    var statements = data
      .split(';')
      .map(function(statement) {
        return statement.trim();
      })
      .filter(function(statement) {
        return statement.length > 0;
      });

    return statements.reduce(function(promiseChain, statement) {
      return promiseChain.then(function() {
        return db.runSql(statement);
      });
    }, Promise.resolve());
  });
};

exports.down = function(db) {
};

exports._meta = {
  version: 1
};
