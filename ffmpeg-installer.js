const fs = require('fs');
const path = require('path');

const customContent = `module.exports = require('./lib/fluent-ffmpeg');`;

const filePath = path.join(
  __dirname,
  'node_modules',
  'fluent-ffmpeg',
  'index.js'
);

fs.writeFile(filePath, customContent, 'utf8', function (err) {
  if (err) {
    console.error('Error writing file:', err);
  } else {
    console.log('Successfully replaced fluent-ffmpeg index.js');
  }
});