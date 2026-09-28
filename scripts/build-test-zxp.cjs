'use strict';
// Signed test ZXP. Same packaging and signing as build-release.cjs, but the
// host script ships as readable .jsx instead of .jsxbin so a failure in
// Premiere can still be traced to a line. Use build-release.cjs for shipping.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), cp = require('child_process');
const root = path.resolve(__dirname, '..'), tools = path.resolve(root, '../CompX-Orbit-Studio/tools');
const version = process.env.ORBIT_TEST_VERSION || '2.4.42';
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function build() {
  for (const suite of ['tests/beat-regression.cjs', 'scripts/audit-release.cjs', 'tests/wiring-regression.cjs', 'tests/tools-regression.cjs']) {
    cp.execFileSync(process.execPath, [path.join(root, suite)], { cwd: root, stdio: 'inherit' });
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-premiere-test-'));
  for (const dir of ['CSXS', 'assets', 'bin', 'css', 'fonts', 'icons', 'js', 'lib', 'modules', 'utils']) {
    const srcDir = path.join(root, dir);
    if (!fs.existsSync(srcDir)) continue;
    fs.cpSync(srcDir, path.join(stage, dir), { recursive: true, filter: p => !path.basename(p).startsWith('._') && path.basename(p) !== '.DS_Store' });
  }
  for (const file of ['index.html', 'default-templates.json', 'motion-presets.json']) {
    fs.copyFileSync(path.join(root, file), path.join(stage, file));
  }
  fs.mkdirSync(path.join(stage, 'jsx'));
  fs.copyFileSync(path.join(root, 'jsx/hostscript.jsx'), path.join(stage, 'jsx/hostscript.jsx'));

  // The loader keeps pointing at the plain source, so its recorded hashes must
  // still match byte for byte; verify rather than rewrite them.
  const loader = fs.readFileSync(path.join(stage, 'js/compx-loader.js'), 'utf8');
  if (!/var HOST_FILE = '\/jsx\/hostscript\.jsx';/.test(loader)) throw Error('Loader does not point at the plain host script');
  const hashes = Function('return (' + loader.match(/var HASHES = (\{[\s\S]*?\});/)[1] + ')')();
  for (const key of Object.keys(hashes)) {
    const staged = path.join(stage, key.replace(/^\//, ''));
    if (hash(staged) !== hashes[key]) throw Error('Integrity mismatch: ' + key);
  }

  const manifest = path.join(stage, 'CSXS/manifest.xml');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8')
    .replace(/ExtensionBundleVersion="[^"]+"/, 'ExtensionBundleVersion="' + version + '"')
    .replace(/(<Extension Id="com\.compxorbit\.premiere\.main" Version=")[^"]+"/, '$1' + version + '"'));

  // Same rule as build-release.cjs: the signing password comes from the
  // environment only, never from a source file, and is never logged.
  const password = process.env.ORBIT_SIGN_PASSWORD;
  if (!password) throw Error('Set ORBIT_SIGN_PASSWORD before building a test ZXP');

  const out = path.join(root, 'dist', 'CompX-Orbit-Premiere-v' + version + '-test.zxp');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  cp.execFileSync(path.join(tools, 'ZXPSignCmd.exe'), ['-sign', stage, out, path.join(tools, 'certs/compx-selfsigned.p12'), password], { stdio: 'pipe' });
  console.log(cp.execFileSync(path.join(tools, 'ZXPSignCmd.exe'), ['-verify', out], { encoding: 'utf8' }).trim());

  console.log(JSON.stringify({
    version, build: 'test', hostScript: 'jsx/hostscript.jsx', zxp: out,
    zxpSha256: hash(out), sourceSha256: hash(path.join(root, 'jsx/hostscript.jsx')),
    signed: true, jsxbin: false, livePremiereVerified: false
  }, null, 2));
}

try { build(); } catch (e) { console.error('Test build failed: ' + e.message); process.exitCode = 1; }

