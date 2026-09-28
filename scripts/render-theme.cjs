const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const root=path.resolve(__dirname,'..');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-render-'));
 const chrome=cp.spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let ws;
 try{
  const portFile=path.join(profile,'DevToolsActivePort');
  for(let i=0;i<100&&!fs.existsSync(portFile);i++)await new Promise(r=>setTimeout(r,100));
  const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
  ws=new WebSocket(pages.find(p=>p.type==='page'&&p.url==='about:blank').webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let seq=0;const pending=new Map();ws.onmessage=e=>{let m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){let [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result)}};
  const call=(method,params={})=>new Promise((r,j)=>{let id=++seq;pending.set(id,[r,j]);ws.send(JSON.stringify({id,method,params}));});
  for(const [type,width]of [['composer',1100],['composer',380],['silence',700],['library',700],['library',380],['captions',700]]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:type==='composer'&&width>900?1350:850,deviceScaleFactor:1,mobile:false});
   await call('Page.navigate',{url:require('url').pathToFileURL(path.join(root,'theme-preview.html')).href+'#'+type});
   await new Promise(r=>setTimeout(r,350));
   await call('Runtime.evaluate',{expression:"location.reload()"});
   await new Promise(r=>setTimeout(r,350));
   const png=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,'dist','theme-'+type+'-'+width+'.png'),Buffer.from(png.data,'base64'));
   const data=await call('Runtime.evaluate',{expression:"JSON.stringify({width:innerWidth,scroll:document.documentElement.scrollWidth,metrics:document.getElementById('layout-metrics')?.textContent})",returnByValue:true});
   console.log(type+' '+data.result.value);
  }
  await call('Browser.close');
 }finally{if(ws)ws.close();chrome.kill();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
