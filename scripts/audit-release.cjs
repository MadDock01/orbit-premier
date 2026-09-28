const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const acorn = require(path.resolve(root, '../CompX-Orbit-Studio/tools/node_modules/acorn'));
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const source = read('jsx/hostscript.jsx');
const hostAst = acorn.parse(source, {ecmaVersion: 2020});
const globals = {};
function walk(n, scope) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach(x => walk(x, scope));
  if (/Function/.test(n.type || '')) {
    if (n.type === 'FunctionDeclaration' && scope === 'global') (globals[n.id.name] ||= []).push(n);
    scope = n;
  }
  Object.values(n).forEach(x => { if (typeof x === 'object') walk(x, scope); });
}
walk(hostAst, 'global');
const duplicates = Object.entries(globals).filter(([,v]) => v.length > 1);
if (process.argv.includes('--deduplicate')) {
  if (!duplicates.every(([,v]) => v.every(n => source.slice(n.start,n.end) === source.slice(v.at(-1).start,v.at(-1).end)))) throw Error('Non-identical duplicate requires manual review');
  let clean = source;
  for (const n of duplicates.flatMap(([,v])=>v.slice(0,-1)).sort((a,b)=>b.start-a.start)) clean = clean.slice(0,n.start) + clean.slice(n.end);
  const backup = path.join(require('os').tmpdir(), 'orbit-host-before-dedup-' + Date.now() + '.jsx');
  fs.copyFileSync(path.join(root,'jsx/hostscript.jsx'),backup);
  fs.writeFileSync(path.join(root,'jsx/hostscript.jsx'),clean);
  console.log('Removed identical global duplicates: ' + duplicates.length + '; backup: ' + backup);
  process.exit(0);
}
let failures = [], checked = 0;
const html = read('index.html');
const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m=>m[1].split('?')[0]).filter(p=>!/^https?:|^data:/.test(p));
for (const p of assets) if (!fs.existsSync(path.join(root,p))) failures.push('Missing HTML asset: '+p);
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
for (const id of new Set(ids)) if (ids.filter(x=>x===id).length>1) failures.push('Duplicate DOM id: '+id);
for (const dir of ['js','utils','modules']) for (const name of fs.readdirSync(path.join(root,dir))) {
  if (!name.endsWith('.js') || name.startsWith('._')) continue;
  const file=dir+'/'+name, text=read(file);
  try { acorn.parse(text,{ecmaVersion:2022,allowReturnOutsideFunction:true}); checked++; } catch(e) { failures.push(file+': '+e.message); }
  for (const m of text.matchAll(/CEP\.evalScript\(\s*['"]([\w$]+)['"]/g)) if (!globals[m[1]]) failures.push(file+': missing host function '+m[1]);
}
for (const [name] of duplicates) failures.push('Duplicate host global: '+name);
let loader = read('js/compx-loader.js');
const hashes = Function('return ('+loader.match(/var HASHES = (\{[\s\S]*?\});/)[1]+')')();
if (process.argv.includes('--hashes')) {
  for (const key of Object.keys(hashes)) hashes[key]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,key.replace(/^\//,'')))).digest('hex');
  loader=loader.replace(/var HASHES = \{[\s\S]*?\};/,'var HASHES = '+JSON.stringify(hashes,null,4)+';');
  fs.writeFileSync(path.join(root,'js/compx-loader.js'),loader);
}
for (const [key,value] of Object.entries(hashes)) if(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,key.replace(/^\//,'')))).digest('hex')!==value) failures.push('Integrity mismatch: '+key);
console.log(JSON.stringify({javascriptFiles:checked,hostFunctions:Object.keys(globals).length,htmlAssets:assets.length,failures},null,2));
if(failures.length)process.exitCode=1;
