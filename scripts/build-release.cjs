'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process');
const root=path.resolve(__dirname,'..'),tools=path.resolve(root,'../CompX-Orbit-Studio/tools');
const version='2.5.0',hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function build(){
  cp.execFileSync(process.execPath,[path.join(root,'tests/beat-regression.cjs')],{cwd:root,stdio:'inherit'});
  cp.execFileSync(process.execPath,[path.join(__dirname,'audit-release.cjs')],{cwd:root,stdio:'inherit'});
  cp.execFileSync(process.execPath,[path.join(root,'tests/wiring-regression.cjs')],{cwd:root,stdio:'inherit'});
  cp.execFileSync(process.execPath,[path.join(root,'tests/tools-regression.cjs')],{cwd:root,stdio:'inherit'});
  cp.execFileSync(process.execPath,[path.join(root,'tests/dock-regression.cjs')],{cwd:root,stdio:'inherit'});
  cp.execFileSync(process.execPath,[path.join(root,'tests/diagnostic-regression.cjs')],{cwd:root,stdio:'inherit'});
  cp.execFileSync(process.execPath,[path.join(root,'tests/motion-regression.cjs')],{cwd:root,stdio:'inherit'});
  cp.execFileSync(process.execPath,[path.join(root,'tests/library-regression.cjs')],{cwd:root,stdio:'inherit'});
  cp.execFileSync(process.execPath,[path.join(root,'tests/sfx-regression.cjs')],{cwd:root,stdio:'inherit'});
  cp.execFileSync(process.execPath,[path.join(root,'tests/audio-regression.cjs')],{cwd:root,stdio:'inherit'});
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-premiere-release-'));
  // Only these folders ship. Retired modules were deleted from the repo rather
  // than excluded here; presets/ is left out because the Preset shelf that used
  // those .prfpset packs was retired and nothing reads them any more.
  // Keep this list in step with SHIPPED_DIRS in audit-release.cjs.
  for(const dir of ['CSXS','assets','bin','css','fonts','icons','js','lib','modules','utils']){
    const srcDir=path.join(root,dir);
    if(!fs.existsSync(srcDir))continue;
    fs.cpSync(srcDir,path.join(stage,dir),{recursive:true,filter:p=>{
      const base=path.basename(p);
      return !(base.startsWith('._')||base==='.DS_Store');
    }});
  }
  for(const file of ['index.html','default-templates.json','motion-presets.json'])fs.copyFileSync(path.join(root,file),path.join(stage,file));
  fs.mkdirSync(path.join(stage,'jsx'));
  await require(path.join(tools,'node_modules/jsxbin'))(path.join(root,'jsx/hostscript.jsx'),path.join(stage,'jsx/hostscript.jsxbin'));
  const binary=path.join(stage,'jsx/hostscript.jsxbin');
  if(!fs.readFileSync(binary,'utf8').startsWith('@JSXBIN@'))throw Error('Compiler did not produce JSXBIN');
  // One version constant, three places. These used to drift: the update checker
  // reported 2.4.15 for 32 releases because only the manifest was rewritten.
  // Must run BEFORE the integrity hashes below — js/license-gate.js is hashed.
  for(const [file,pattern] of [['js/update-checker.js',/currentVersion:\s*"[^"]+"/],['js/license-gate.js',/appVersion:\s*"[^"]+"/]]){
    const target=path.join(stage,file),before=fs.readFileSync(target,'utf8');
    // Check the PATTERN, not whether the text changed: when the source file
    // already carries the target version the rewrite is a no-op, and comparing
    // strings reported that as "constant not found" and failed the build.
    if(!pattern.test(before))throw Error('Version constant not found in '+file);
    fs.writeFileSync(target,before.replace(pattern,m=>m.replace(/"[^"]+"$/,'"'+version+'"')));
  }
  let loader=fs.readFileSync(path.join(stage,'js/compx-loader.js'),'utf8');
  const old=Function('return ('+loader.match(/var HASHES = (\{[\s\S]*?\});/)[1]+')')(),hashes={};
  for(let key of Object.keys(old)){if(key==='/jsx/hostscript.jsx')key='/jsx/hostscript.jsxbin';hashes[key]=hash(path.join(stage,key.replace(/^\//,'')));}
  loader=loader.replace("var HOST_FILE = '/jsx/hostscript.jsx';","var HOST_FILE = '/jsx/hostscript.jsxbin';").replace(/var HASHES = \{[\s\S]*?\};/,'var HASHES = '+JSON.stringify(hashes,null,4)+';');
  fs.writeFileSync(path.join(stage,'js/compx-loader.js'),loader);
  const manifest=path.join(stage,'CSXS/manifest.xml');
  fs.writeFileSync(manifest,fs.readFileSync(manifest,'utf8').replace(/ExtensionBundleVersion="[^"]+"/,'ExtensionBundleVersion="'+version+'"').replace(/(<Extension Id="com\.compxorbit\.premiere\.main" Version=")[^"]+"/,'$1'+version+'"').replace('jsx/hostscript.jsx is now','jsx/hostscript.jsxbin is now'));
  // Signing password comes from the environment only. It must never be read
  // out of a source file, and it must never be logged.
  const password=process.env.ORBIT_SIGN_PASSWORD;
  if(!password)throw Error('Set ORBIT_SIGN_PASSWORD before building a release');
  const out=path.join(root,'dist','CompX-Orbit-Premiere-v'+version+'.zxp');
  if(fs.existsSync(out))throw Error('Release already exists; choose a new version rather than overwrite it');
  fs.mkdirSync(path.dirname(out),{recursive:true});
  cp.execFileSync(path.join(tools,'ZXPSignCmd.exe'),['-sign',stage,out,path.join(tools,'certs/compx-selfsigned.p12'),password],{stdio:'pipe'});
  const verification=cp.execFileSync(path.join(tools,'ZXPSignCmd.exe'),['-verify',out],{encoding:'utf8'});
  console.log(verification.trim());
  fs.copyFileSync(binary,path.join(root,'jsx/hostscript.jsxbin'));
  fs.copyFileSync(binary,path.join(root,'dist','hostscript-v'+version+'.jsxbin'));
  const receipt={version,stage,zxp:out,zxpSha256:hash(out),jsxbinSha256:hash(binary),sourceSha256:hash(path.join(root,'jsx/hostscript.jsx')),signed:true,livePremiereVerified:false};
  fs.writeFileSync(path.join(root,'dist','release-'+version+'.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt,null,2));
}
build().catch(e=>{console.error('Build failed: '+e.message);process.exitCode=1;});
