// Runs ffmpegLocal's diagnose() in a Node context with CEP's require available,
// simulating both a healthy machine and a broken Mac.
const fs=require('fs'), path=require('path'), vm=require('vm'), os=require('os');
const src=fs.readFileSync(require('path').resolve(__dirname,'../utils/ffmpegLocal.js'),'utf8');

function run(label, opts){
  const fakeBin=path.join(os.tmpdir(),'fake-ffmpeg-'+Date.now());
  fs.writeFileSync(fakeBin, Buffer.from(opts.magic,'hex'));
  fs.chmodSync(fakeBin, opts.mode);
  const cp=require('child_process');
  const ctx={ console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, Date, Math, JSON, process:{
      platform:opts.platform, arch:opts.arch, versions:{node:'18.0.0'}, env:{}, cwd:()=>'/' },
    navigator:{userAgent:'test'}, localStorage:{getItem:()=>opts.override||''},
    CSInterface:function(){ this.getSystemPath=()=>opts.extPath; },
    SystemPath:{EXTENSION:'extension'},
    require:(m)=>{
      if(m==='child_process') return { spawn:cp.spawn, spawnSync:(bin,args,o)=>opts.spawnSync(bin,args,o) };
      if(m==='fs') return fs; if(m==='path') return path; if(m==='os') return os;
      return require(m);
    },
    document:{addEventListener(){}}, fetch:()=>Promise.reject(new Error('no net'))
  };
  ctx.window=ctx; vm.createContext(ctx);
  // point resolution at our fake binary via the settings override
  ctx.localStorage={getItem:()=>fakeBin};
  vm.runInContext(src, ctx);
  const text=ctx.FFmpegAPI.diagnoseText();
  try{fs.unlinkSync(fakeBin);}catch(_){}
  const assert=require('assert/strict');
  for(const needle of opts.expect) assert.ok(text.indexOf(needle)>=0,
    label+': diagnostic never mentioned '+JSON.stringify(needle)+'\n'+text);
  if(opts.clean) assert.ok(text.indexOf('  FAIL ')<0, label+' should be clean:\n'+text);
  console.log('PASS '+label);
}

run('Healthy Windows reports no failures', { clean:true, expect:['PE/EXE (Windows)','ffmpeg version 6.1'], platform:'win32', arch:'x64', magic:'4d5a9000', mode:0o755, extPath:'C:\\ext',
  spawnSync:(bin,args)=>({status:0,stdout:'ffmpeg version 6.1 Copyright (c) 2000-2023',stderr:''}) });

run('Gatekeeper SIGKILL is named, not swallowed', { expect:['execute bit is missing','QUARANTINED','killed by signal SIGKILL','cloud only'], platform:'darwin', arch:'arm64', magic:'cffaedfe', mode:0o644, extPath:'/Users/x/ext',
  spawnSync:(bin,args)=>{
    if(String(bin).indexOf('xattr')>=0) return {status:0,stdout:'0081;65f0;Safari;\n',stderr:''};
    if(String(bin).indexOf('codesign')>=0) return {status:1,stdout:'',stderr:'code object is not signed at all'};
    return {status:null,signal:'SIGKILL',stdout:'',stderr:''};
  } });

run('A Windows binary on a Mac is identified by its magic bytes', { expect:['needs Mach-O'], platform:'darwin', arch:'x64', magic:'4d5a9000', mode:0o755, extPath:'/Users/x/ext',
  spawnSync:(bin,args)=>{
    if(String(bin).indexOf('xattr')>=0) return {status:1,stdout:'',stderr:'No such xattr'};
    if(String(bin).indexOf('codesign')>=0) return {status:1,stdout:'',stderr:'not signed'};
    return {error:new Error('spawnSync EACCES'),status:null};
  } });

console.log('3 diagnostic scenarios passed; real machine behavior remains unverified.');
