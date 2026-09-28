'use strict';
// Dev dependencies (acorn, jsdom) resolve from this repo's node_modules after
// `npm install`, then from the sibling CompX-Orbit-Studio/tools checkout that
// older setups installed them into.
const path = require('path');
const root = path.resolve(__dirname, '..');
module.exports = function devRequire(name) {
  try { return require(require.resolve(name, { paths: [root] })); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  return require(path.resolve(root, '../CompX-Orbit-Studio/tools/node_modules', name));
};
