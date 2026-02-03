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
  var memesWaveId = process.env.MEMES_WAVE_ID;
  if (!memesWaveId) {
    return Promise.reject(
      new Error(
        'MEMES_WAVE_ID env var is required for this migration. Set it to the wave id of the memes wave.'
      )
    );
  }
  var escapedWaveId = memesWaveId.replace(/'/g, "''");
  var filePath = path.join(
    __dirname,
    'sqls',
    '20260203085204-populate-drop-winner-meme-up.sql'
  );
  return new Promise(function (resolve, reject) {
    fs.readFile(filePath, { encoding: 'utf-8' }, function (err, data) {
      if (err) return reject(err);
      resolve(data.replace(/__MEMES_WAVE_ID__/g, escapedWaveId));
    });
  }).then(function (sql) {
    return db.runSql(sql);
  });
};

exports.down = function (db) {};

exports._meta = {
  version: 1
};
