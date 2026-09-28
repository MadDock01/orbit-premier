// Node.js script to calculate SHA-256 hash of a file
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'utils', 'panelSwitcher.js');

try {
  const fileContent = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
  console.log('SHA-256 hash of panelSwitcher.js:');
  console.log(hash);
  console.log('\nAdd this to the HASHES object in js/compx-loader.js:');
  console.log(`'utils/panelSwitcher.js': '${hash}',`);
} catch (error) {
  console.error('Error calculating hash:', error);
  process.exit(1);
}