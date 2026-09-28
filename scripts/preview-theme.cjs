const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
let html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/g,'');
html=html.replace('</body>',`<script>
var types={composer:'composerToolsView',silence:'silenceCutterView',captions:'autoCaptionsView',beat:'beatView',audio:'audioView',motion:'motionView',punch:'punchView',library:'sfxMogrtView',doctor:'projectDoctorView',multicam:'multicamView'};
var type=location.hash.slice(1)||'silence';
Object.keys(types).forEach(function(k){var v=document.getElementById(types[k]);if(v){v.classList.add(k===type?'orbit-route-active':'orbit-route-hidden');}});
document.querySelectorAll('#assetTypeRow .shelf').forEach(function(b){b.classList.toggle('active',b.dataset.type===type)});
document.querySelector('.orbit-header-copy')?.setAttribute('title','Static theme preview');
var metrics=document.createElement('pre');metrics.id='layout-metrics';metrics.style.display='none';metrics.textContent=JSON.stringify(['app','panel-sfx',types[type],'composerToolsPanel'].map(function(id){var e=document.getElementById(id);if(!e)return null;var c=getComputedStyle(e),r=e.getBoundingClientRect();return {id:id,width:r.width,x:r.x,minWidth:c.minWidth,grid:c.gridTemplateColumns};}));document.body.appendChild(metrics);
</script></body>`);
fs.writeFileSync(path.join(root,'theme-preview.html'),html);
