// Read-only regression tests. Adobe APIs are mocked; no timeline is modified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
}
const host = {};
vm.createContext(host);
vm.runInContext(section(read('jsx/hostscript.jsx'), 'function orbitGetTrackList()', 'function smartAutoReframe'), host);
check('Track discovery reports no active sequence', () => {
  host.app = { project: { activeSequence: null } };
  assert.match(JSON.parse(host.orbitGetTrackList()).error, /No active sequence/);
});
check('Track discovery preserves populated A/V track indexes', () => {
  const tracks = counts => Object.assign(counts.map(n => ({ clips: { numItems: n } })), { numTracks: counts.length });
  host.app.project.activeSequence = { name: 'Fixture', videoTracks: tracks([1, 0]), audioTracks: tracks([2, 0, 1]) };
  const result = JSON.parse(host.orbitGetTrackList());
  assert.deepEqual(result.tracks.map(t => t.name), ['V1', 'A1', 'A3']);
  assert.equal(result.tracks[2].index, 2);
});
const subtitles = { TextDecoder, Uint8Array, ArrayBuffer };
vm.createContext(subtitles);
const captions = read('modules/autoCaptions.js');
vm.runInContext(section(captions, 'function parseSrt(raw)', 'function _commitSrtImport'), subtitles);
vm.runInContext(section(captions, 'function decodeSubtitleBuffer(buffer)', 'var SYLLABLES_PER_SEC'), subtitles);
const srt = '1\r\n00:00:01,250 --> 00:00:02,500\r\nবাংলা caption\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,100\r\nSecond line\r\n';
check('SRT preserves Bengali text and exact cue timing', () => {
  const cues = subtitles.parseSrt(srt);
  assert.equal(cues.length, 2); assert.equal(cues[0].text, 'বাংলা caption');
  assert.equal(cues[0].start, 1.25); assert.equal(cues[1].end, 4.1);
});
check('UTF-16LE subtitles decode before parsing', () => {
  const data = Buffer.concat([Buffer.from([255, 254]), Buffer.from(srt, 'utf16le')]);
  assert.equal(subtitles.parseSrt(subtitles.decodeSubtitleBuffer(data))[0].text, 'বাংলা caption');
});
check('Script-style SRT with start stamps only derives cue ends from the next stamp', () => {
  const script = 'START: 00:26:17\n"I spent thousands of dollars..."\n\n00:26:22\n"...because credit\'s bad."\n\n00:28:52\n"...one letter from the law firm."\n\n🎬 END: 00:28:57\n';
  const cues = subtitles.parseSrt(script);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].start, 26 * 60 + 17); assert.equal(cues[0].end, 26 * 60 + 22);
  assert.equal(cues[0].text, 'I spent thousands of dollars...');
  assert.equal(cues[2].start, 28 * 60 + 52); assert.equal(cues[2].end, 28 * 60 + 57);
});
check('Program-TC SRT slides onto the clip so the first cue starts with the video', () => {
  const cues = [
    { text: 'a', start: 26 * 60 + 17, end: 26 * 60 + 22 },
    { text: 'b', start: 28 * 60 + 52, end: 28 * 60 + 57 }
  ];
  subtitles.fitCuesToMedia(cues, 0, 27);
  assert.ok(Math.abs(cues[0].start) < 1e-9);
  assert.ok(Math.abs(cues[0].end - 5) < 1e-9);
});
check('Program-TC SRT normalizes even when the sequence duration is much longer than the edit', () => {
  const cues = [
    { text: 'a', start: 26 * 60 + 17, end: 26 * 60 + 22 },
    { text: 'b', start: 28 * 60 + 52, end: 28 * 60 + 57 }
  ];
  subtitles.fitCuesToMedia(cues, 0, 3600);
  assert.ok(Math.abs(cues[0].start) < 1e-9);
  assert.ok(Math.abs(cues[0].end - 5) < 1e-9);
});
check('Zero-based SRT follows a clip that does not start at zero', () => {
  const cues = [{ text: 'a', start: 0, end: 2 }];
  subtitles.fitCuesToMedia(cues, 5, 25);
  assert.equal(cues[0].start, 5); assert.equal(cues[0].end, 7);
});
check('Premiere HH:MM:SS:FF cues convert frames, not milliseconds', () => {
  const cues = subtitles.parseSrt('1\n00:00:01:15 --> 00:00:02:00\nHello\n');
  assert.equal(cues.length, 1);
  assert.ok(Math.abs(cues[0].start - 1.5) < 1e-9);
  assert.equal(cues[0].end, 2);
});
check('VTT and invalid timing are rejected', () => {
  assert.equal(subtitles.parseSrt('WEBVTT\n\n00:01.000 --> 00:02.000\nNo').length, 0);
  assert.equal(subtitles.parseSrt('1\n00:00:04 --> 00:00:01\nNo').length, 0);
});
function element(type) {
  const classes = new Set(), attrs = { 'data-type': type };
  return { className: 'shelf', classList: { toggle(n, on) { on ? classes.add(n) : classes.delete(n); } },
    classes, attrs, setAttribute(n, v) { attrs[n] = v; }, getAttribute(n) { return attrs[n]; },
    querySelector() { return null; } };
}
// SFX has its own view now — the studio. #sfxMogrtView is MOGRT alone, and
// it is the one view the router shows by id rather than through the
// .orbit-view-panel sweep, which is why the stub below excludes it there.
const routeIds = { silence: 'silenceCutterView', captions: 'autoCaptionsView',
  beat: 'beatView', audio: 'audioView', motion: 'motionView',
  sfx: 'sfxStudioView', mogrt: 'sfxMogrtView',
  doctor: 'projectDoctorView' };
const shelves = Object.keys(routeIds).map(element), nodes = {}, events = [], listeners = {};
Object.values(routeIds).forEach(id => { nodes[id] = element(); });
const row = { querySelectorAll: () => shelves, querySelector: () => shelves.find(s => s.classes.has('active')),
  addEventListener(n, fn) { listeners['row:' + n] = fn; } };
shelves.forEach(s => { s.parentNode = row; }); nodes.assetTypeRow = row;
const routing = { console, setTimeout, localStorage: { getItem() { return null; }, setItem() {} },
  CustomEvent: function (type, init) { this.type = type; this.detail = init.detail; },
  dispatchEvent(e) { events.push(e); },
  document: { getElementById: id => nodes[id] || null,
    querySelectorAll: selector => selector === '.orbit-view-panel' ? Object.entries(nodes).filter(([id]) => id !== 'assetTypeRow' && id !== 'sfxMogrtView').map(([, n]) => n) : [],
    querySelector: () => null,
    dispatchEvent() {}, addEventListener(n, fn) { listeners[n] = fn; } } };
routing.window = routing; vm.createContext(routing);
vm.runInContext(read('modules/rail-router.js'), routing);
check('Every rail route selects exactly one matching view', () => {
  const routes = Object.keys(routeIds);
  const viewIds = [...new Set(Object.values(routeIds))];
  for (const type of routes) {
    routing.OrbitRailRouter.open(type);
    assert.ok(nodes[routeIds[type]].classes.has('orbit-route-active'), type + ' did not open its view');
    // Counted over views, not routes: sfx and mogrt share one, so counting
    // routes would read that single open view as two.
    assert.equal(viewIds.filter(id => nodes[id].classes.has('orbit-route-active')).length, 1,
      type + ' left another view open');
  }
});

// Builds before the split saved 'library' as the selected shelf. It has to
// land somewhere real, not on a route that no longer exists.
check('A shelf saved as "library" still opens the SFX studio', () => {
  routing.OrbitRailRouter.open('doctor');
  routing.OrbitRailRouter.open('library');
  assert.ok(nodes.sfxStudioView.classes.has('orbit-route-active'));
  assert.ok(shelves.find(s => s.attrs['data-type'] === 'sfx').classes.has('active'),
    'the SFX shelf was not marked');
});

// The MOGRT view is relabelled by setLibraryType. Running that for the SFX
// rail would leave a MOGRT library advertising sound effects.
check('Opening SFX does not relabel the MOGRT view', () => {
  const view = nodes.sfxMogrtView;
  routing.OrbitRailRouter.open('mogrt');
  assert.equal(view.attrs['data-library-mode'], 'mogrt');
  routing.OrbitRailRouter.open('sfx');
  assert.equal(view.attrs['data-library-mode'], 'mogrt', 'SFX rewrote the MOGRT view');
  assert.equal(view.classes.has('orbit-route-active'), false);
});
check('Rail clicks do not suppress feature listeners', () => {
  let blocked = false;
  listeners['row:click']({ target: shelves[0], preventDefault() {}, stopImmediatePropagation() { blocked = true; } });
  assert.equal(blocked, false); assert.equal(events.at(-1).detail.type, 'silence');
});
check('Host-ready event refreshes the selected route', () => {
  events.length = 0; listeners['host-loader-ready'](); assert.equal(events[0].detail.type, 'silence');
});
check('Production license module exposes check, not isActivated', () => {
  const context = { console, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    navigator: {}, location: {}, localStorage: { getItem: () => null }, SystemPath: {},
    CSInterface: function () { this.getSystemPath = () => ''; this.getHostEnvironment = () => ({ appName: 'PPRO' }); },
    document: { addEventListener() {} } };
  context.window = context; vm.createContext(context);
  vm.runInContext(read('js/compx-license.js'), context, { timeout: 2000 });
  assert.equal(typeof context.CompXLicense.check, 'function');
  assert.equal(context.CompXLicense.isActivated, undefined);
});
check('CSInterface loads once, before the CEP bridge and feature modules', () => {
  const html = read('index.html');
  assert.equal((html.match(/src="js\/CSInterface.js"/g) || []).length, 1);
  assert.ok(html.indexOf('src="js/CSInterface.js"') < html.indexOf('src="utils/cep.js"'));
});
// The Work Tracker had no UI in Premiere, yet it polled the host every few
// seconds, asked for notification permission at launch and fired a "take a
// break" notification and beep from nowhere. It was removed; keep it gone.
check('No hidden activity tracker polls the host or raises notifications', () => {
  const main = read('js/main.js');
  assert.ok(!/ppro_getActivitySignature/.test(main), 'main.js must not poll the host for activity');
  assert.ok(!/Notification\.requestPermission|new Notification\(/.test(main), 'main.js must not raise OS notifications');
});
const hostFixture = section(read('jsx/hostscript.jsx'), 'function orbitGetTrackList()', 'function smartAutoReframe') + '\nfunction getSequenceInfo(){return "{}";}';
check('A same-call probe cannot prove host functions persist outside an IIFE', () => {
  const scope = { __hostFixture: hostFixture }; vm.createContext(scope);
  assert.equal(vm.runInContext('(function(){eval(__hostFixture);return typeof orbitGetTrackList;})()', scope), 'function');
  assert.equal(vm.runInContext('typeof orbitGetTrackList', scope), 'undefined');
});
async function loaderCase(mode) {
  const emitted = [], errors = [], timers = new Map(); let nextTimer = 0;
  let hostCalls = 0, scriptLoads = 0, licensed = mode !== 'denied';
  const adobe = { __hostFixture: mode === 'throw' ? 'throw new Error("fixture load failure");' :
    (mode === 'missing' ? '' : hostFixture), app: { project: { activeSequence: null } } };
  vm.createContext(adobe);
  const context = { console: { log() {} }, Promise, JSON, Date,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    SystemPath: { EXTENSION: 'extension' }, CompXLicense: { check: async () => {
      if (mode === 'license-error') throw new Error('License unavailable');
      return { licensed };
    } },
    csInterface: { getSystemPath: () => 'D:/fixture "quoted"/বাংলা', evalScript(code, callback) {
      hostCalls++;
      if (mode === 'timeout' || (mode === 'probe-timeout' && hostCalls === 2)) return;
      if (mode === 'lost' && hostCalls === 2) { adobe.orbitGetTrackList = undefined; }
      // Model evalFile's caller-scope semantics using direct eval, rather than
      // injecting globals from the mock (which concealed the scope regression).
      const scopedCode = code.replace(/\$\.evalFile\("(?:\\.|[^"\\])*"\)/g, 'eval(__hostFixture)');
      callback(vm.runInContext(scopedCode, adobe));
    } }, alert: msg => errors.push(msg), CustomEvent: function (type) { this.type = type; },
    document: { addEventListener() {}, dispatchEvent(e) { emitted.push(e.type); }, createElement() { return {}; },
      head: { appendChild(script) { scriptLoads++; script.onload(); } } } };
  context.window = context; vm.createContext(context); vm.runInContext(read('js/compx-loader.js'), context);
  const promise = context.HostLoader.boot();
  assert.equal(context.HostLoader.boot(), promise, 'Concurrent boot shares the pending operation');
  for (let i = 0; i < 12; i++) await Promise.resolve();
  if (mode === 'timeout' || mode === 'probe-timeout') for (const fn of timers.values()) fn();
  const ok = await promise;
  assert.equal(ok, mode === 'ok');
  assert.equal(emitted.includes('host-loader-ready'), mode === 'ok');
  assert.equal(errors.length, ['ok', 'denied', 'license-error'].includes(mode) ? 0 : 1);
  if (mode === 'denied' || mode === 'license-error') {
    assert.equal(hostCalls, 0); assert.equal(scriptLoads, 0);
  }
  if (mode === 'denied') {
    licensed = true;
    assert.equal(await context.HostLoader.boot(), true, 'A later valid activation can retry startup');
    assert.equal(hostCalls, 2); assert.equal(scriptLoads, 2);
  }
  if (mode === 'ok') {
    assert.equal(await context.HostLoader.boot(), true); assert.equal(hostCalls, 2);
    context.CSInterface = function () { return context.csInterface; };
    vm.runInContext(read('utils/cep.js'), context);
    const noSequence = await context.CEP.evalScript('orbitGetTrackList', []);
    assert.match(noSequence.error, /No active sequence/);
    adobe.app.project.activeSequence = { name: 'Fixture',
      videoTracks: { numTracks: 0 }, audioTracks: { numTracks: 1, 0: { clips: { numItems: 1 } } } };
    const result = await context.CEP.evalScript('orbitGetTrackList', []);
    assert.equal(result.tracks[0].name, 'A1', 'Actual bridge can call the persisted JSX endpoint');
  }
  console.log('PASS loader ' + mode); passed++;
}
(async () => {
  for (const mode of ['ok', 'throw', 'missing', 'timeout', 'probe-timeout', 'lost', 'denied', 'license-error']) await loaderCase(mode);
  console.log('Passed ' + passed + ' read-only regressions; real Premiere integration still requires a host smoke test.');
})().catch(error => { console.error(error); process.exitCode = 1; });
