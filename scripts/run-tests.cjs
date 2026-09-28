'use strict';
// Runs the release audit and every regression suite; exits non-zero on the
// first failure so CI and `npm test` agree with build-release.cjs.
const cp = require('child_process'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const suites = ['scripts/audit-release.cjs'].concat(
  fs.readdirSync(path.join(root, 'tests')).filter(f => /-regression\.cjs$/.test(f)).sort().map(f => 'tests/' + f));
for (const suite of suites) {
  console.log('\n== ' + suite);
  const r = cp.spawnSync(process.execPath, [path.join(root, suite)], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) { console.error('FAILED: ' + suite); process.exit(r.status || 1); }
}
console.log('\nAll ' + suites.length + ' suites passed.');
