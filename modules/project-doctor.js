/** Orbit Project Doctor — dependable project, sequence and caption checks. */
(function (global) {
  'use strict';
  var state = { report: null, filter: 'all', scanning: false, opened: false };
  function $(id) { return document.getElementById(id); }
  var el = {
    view: $('projectDoctorView'), panel: $('projectDoctorPanel'), scan: $('pdScan'), score: $('pdScore'), verdict: $('pdVerdict'), meta: $('pdMeta'),
    critical: $('pdCritical'), warnings: $('pdWarnings'), info: $('pdInfo'), clips: $('pdClips'), duration: $('pdDuration'), offline: $('pdOffline'),
    gaps: $('pdGaps'), captions: $('pdCaptions'), filters: $('pdFilters'), mark: $('pdMarkIssues'), save: $('pdSaveProject'), copy: $('pdCopyReport'),
    count: $('pdResultCount'), list: $('pdIssueList'), status: $('pdStatus'), diagnostic: $('pdDiagnostic')
  };
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function host(name, args, options) {
    options = options || {};
    if (global.OrbitCore && global.OrbitCore.host) return global.OrbitCore.host.call(name, args || [], options);
    if (!global.CEP || !global.CEP.evalScript) return Promise.reject(new Error('Premiere host bridge is unavailable.'));
    return global.CEP.evalScript(name, args || [], options.timeout || 15000);
  }
  function setStatus(text, error, success) { if (!el.status) return; el.status.textContent = text || ''; el.status.className = 'pd-status' + (error ? ' error' : (success ? ' success' : '')); }
  function finite(value) { value = Number(value); return isFinite(value) ? value : NaN; }
  function captionText(cue) { return String((cue && (cue.text || cue.caption || cue.word)) || '').trim(); }
  function addCaptionChecks(report) {
    var cues = [], data = null;
    try { data = JSON.parse(global.localStorage.getItem('machicut_captions') || 'null'); cues = data && Array.isArray(data.captions) ? data.captions.slice() : []; } catch (_) {}
    report.stats = report.stats || {}; report.stats.captionCount = cues.length; report.stats.captionIssues = 0;
    if (!cues.length) return report;
    cues.sort(function (a, b) { return finite(a.start) - finite(b.start); });
    var previousEnd = -1, limit = 80, added = 0, fps = (report.sequence && report.sequence.fps) || 30, seqDuration = (report.sequence && report.sequence.duration) || 0;
    function add(severity, title, detail, time) {
      if (added >= limit) return; added++;
      report.issues.push({ id:'pd-caption-'+added, severity:severity, category:'captions', title:title, detail:detail, time:isFinite(time)?time:null, track:'Captions', fix:'' });
    }
    for (var i = 0; i < cues.length && added < limit; i++) {
      var cue = cues[i], start = finite(cue.start), end = finite(cue.end), text = captionText(cue), duration = end - start, lines = text.split(/\r?\n/), chars = text.replace(/\s+/g, ' ').length;
      if (!isFinite(start) || !isFinite(end) || end <= start) { add('critical','Invalid caption timing','Cue '+(i+1)+' has a zero, negative or unreadable duration.',start); continue; }
      if (previousEnd >= 0 && start < previousEnd - (1 / fps)) add('critical','Overlapping captions','Cue '+(i+1)+' overlaps the preceding caption by '+(previousEnd-start).toFixed(2)+' seconds.',start);
      if (duration < 0.45) add('warning','Caption is too brief','Cue '+(i+1)+' is visible for only '+duration.toFixed(2)+' seconds.',start);
      else if (duration > 7) add('warning','Caption is unusually long','Cue '+(i+1)+' remains on screen for '+duration.toFixed(2)+' seconds.',start);
      if (duration > 0 && chars / duration > 25) add('warning','Caption reading speed is high',Math.round(chars/duration)+' characters per second may be hard to read.',start);
      var longLine = false; for (var l=0;l<lines.length;l++) if (lines[l].length > 42) longLine = true;
      if (lines.length > 2 || longLine) add('info','Caption needs line balancing','Cue '+(i+1)+' exceeds two lines or 42 characters on one line.',start);
      if (seqDuration > 0 && end > seqDuration + (1/fps)) add('warning','Caption exceeds sequence','Cue '+(i+1)+' ends after the active sequence.',start);
      previousEnd = Math.max(previousEnd, end);
    }
    report.stats.captionIssues = added;
    report.counts = { critical:0, warning:0, info:0 };
    report.issues.forEach(function (issue) { report.counts[issue.severity] = (report.counts[issue.severity] || 0) + 1; });
    report.score = Math.max(0, 100 - Math.min(60, report.counts.critical*18) - Math.min(32, report.counts.warning*6) - Math.min(10, report.counts.info));
    return report;
  }
  function formatDuration(seconds) { seconds = Math.max(0, Number(seconds)||0); var h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=Math.floor(seconds%60); return (h?h+':':'')+('0'+m).slice(-2)+':'+('0'+s).slice(-2); }
  function timecode(seconds, fps) { seconds=Math.max(0,Number(seconds)||0); fps=Math.max(1,Math.round(Number(fps)||30)); var total=Math.floor(seconds),f=Math.floor((seconds-total)*fps),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60; return [h,m,s,f].map(function(v){return ('0'+v).slice(-2);}).join(':'); }
  function render() {
    var r=state.report; if (!r) return;
    var c=r.counts||{}, s=r.stats||{}, seq=r.sequence||{}, project=r.project||{}, score=Number(r.score)||0;
    el.score.textContent=score; el.score.parentNode.setAttribute('data-grade',score>=85?'good':(score>=65?'warn':'bad'));
    el.verdict.textContent=score>=90?'Ready for delivery':(score>=75?'Healthy with minor issues':(score>=50?'Needs attention':'Critical issues found'));
    el.meta.textContent=(project.name||'Untitled Project')+' · '+(seq.name||'Untitled Sequence')+' · '+(seq.width||'?')+'×'+(seq.height||'?')+' · '+(seq.fps||'?')+' fps';
    el.critical.textContent=c.critical||0; el.warnings.textContent=c.warning||0; el.info.textContent=c.info||0;
    el.clips.textContent=(s.videoClips||0)+(s.audioClips||0); el.duration.textContent=formatDuration(seq.duration); el.offline.textContent=s.offlineMedia||0; el.gaps.textContent=s.gaps||0; el.captions.textContent=s.captionIssues||0;
    var list=(r.issues||[]).filter(function(i){return state.filter==='all'||i.severity===state.filter;}); el.count.textContent=list.length+' issue'+(list.length===1?'':'s');
    el.copy.disabled=false; el.mark.disabled=!(r.issues||[]).some(function(i){return typeof i.time==='number';});
    if (!list.length) { el.list.innerHTML='<div class="pd-empty"><span>✓</span><strong>No '+escapeHtml(state.filter==='all'?'verified issues':state.filter+' issues')+'</strong><p>The active filter is clear.</p></div>'; return; }
    el.list.innerHTML=list.map(function(i){var actions=''; if(typeof i.time==='number') actions+='<button data-pd-go="'+escapeHtml(i.id)+'">Go</button>'; if(i.fix==='save-project') actions+='<button data-pd-fix="save-project">Fix</button>'; return '<article class="pd-issue '+escapeHtml(i.severity)+'"><i class="pd-issue-dot"></i><div class="pd-issue-main"><div class="pd-issue-title"><strong>'+escapeHtml(i.title)+'</strong><span class="pd-category">'+escapeHtml(i.category)+'</span></div><p>'+escapeHtml(i.detail)+'</p><div class="pd-issue-meta">'+(typeof i.time==='number'?'<span>'+timecode(i.time,seq.fps)+'</span>':'')+(i.track?'<span>'+escapeHtml(i.track)+'</span>':'')+'</div></div><div class="pd-issue-actions">'+actions+'</div></article>';}).join('');
  }
  function scan() {
    if (state.scanning) return Promise.resolve(); state.scanning=true; el.scan.disabled=true; el.panel.classList.add('pd-loading'); setStatus('Scanning active project and sequence…');
    return host('projectDoctorScan',[],{timeout:45000,readOnly:true,attempts:2}).then(function(r){if(!r||r.error)throw new Error((r&&r.error)||'Project scan failed.'); state.report=addCaptionChecks(r); render(); setStatus('Inspection complete · '+state.report.issues.length+' verified issue(s).',false,true); if(global.CompXDiagnostics&&global.CompXDiagnostics.record)global.CompXDiagnostics.record('info','PROJECT_DOCTOR_SCAN','Project Doctor scan complete','Score '+state.report.score+' · '+state.report.issues.length+' issue(s)'); return state.report;}).catch(function(e){setStatus(e.message||String(e),true); if(global.showToast)global.showToast(e.message||String(e),true);}).then(function(){state.scanning=false;el.scan.disabled=false;el.panel.classList.remove('pd-loading');});
  }
  function runAction(config, fallback) { return global.OrbitCore ? global.OrbitCore.run(config) : fallback(); }
  function saveProject() { return runAction({id:'project-doctor-save',title:'Save Project',button:el.save,confirm:true,preview:'Save the current Premiere project now?',safetyCopy:false,toast:false,execute:function(ctx){return ctx.host('projectDoctorAction',['save-project',''],{timeout:20000});},successMessage:'Project saved.',onStatus:function(p,v,e){setStatus(v,e,!e&&p==='success');}},function(){return host('projectDoctorAction',['save-project',''],{timeout:20000});}).then(function(r){if(r&&!r.cancelled)return scan();}).catch(function(e){setStatus(e.message,true);}); }
  function markIssues() { var timed=(state.report&&state.report.issues||[]).filter(function(i){return typeof i.time==='number';}).map(function(i){return {title:i.title,detail:i.detail,time:i.time,track:i.track,severity:i.severity};}); if(!timed.length)return; return runAction({id:'project-doctor-markers',title:'Add Doctor Markers',button:el.mark,confirm:true,preview:'Add '+timed.length+' issue marker(s) to the active sequence? Existing matching markers will be skipped.',safetyCopy:false,toast:false,execute:function(ctx){return ctx.host('projectDoctorAction',['mark-issues',JSON.stringify(timed)],{timeout:30000});},successMessage:function(r){return (r&&r.message)||'Issue markers added.';},onStatus:function(p,v,e){setStatus(v,e,!e&&p==='success');}},function(){return host('projectDoctorAction',['mark-issues',JSON.stringify(timed)],{timeout:30000});}).catch(function(e){setStatus(e.message,true);}); }
  function goTo(id) { var issue=(state.report&&state.report.issues||[]).filter(function(i){return i.id===id;})[0]; if(!issue)return; host('projectDoctorAction',['go-to',String(issue.time)],{timeout:10000}).then(function(){setStatus('Playhead moved to '+timecode(issue.time,state.report.sequence.fps)+'.',false,true);}).catch(function(e){setStatus(e.message,true);}); }
  function reportText(){var r=state.report||{},seq=r.sequence||{},p=r.project||{},s=r.stats||{},lines=['Orbit Project Doctor Report','Generated: '+new Date().toISOString(),'Score: '+(r.score==null?'—':r.score)+'/100','Project: '+(p.name||'Untitled'),'Sequence: '+(seq.name||'Untitled')+' · '+(seq.width||'?')+'x'+(seq.height||'?')+' · '+(seq.fps||'?')+' fps','Stats: '+((s.videoClips||0)+(s.audioClips||0))+' clips · '+(s.offlineMedia||0)+' offline · '+(s.gaps||0)+' primary gaps · '+(s.captionIssues||0)+' caption issues','','Issues:']; (r.issues||[]).forEach(function(i){lines.push('- ['+i.severity.toUpperCase()+'] '+i.title+(typeof i.time==='number'?' @ '+timecode(i.time,seq.fps):'')+' — '+i.detail);}); if(!(r.issues||[]).length)lines.push('- None'); return lines.join('\n');}
  function copyReport(){var text=reportText(),done=function(){setStatus('Doctor report copied to clipboard.',false,true);}; if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text).then(done).catch(function(){copyFallback(text);done();}); copyFallback(text);done();}
  // Collects platform + FFmpeg state and copies it out. The point is that a
  // failure on a machine we cannot reach names the step that broke, instead of
  // surfacing whatever error happened to bubble up last.
  function diagnostic(){
    if(el.diagnostic) el.diagnostic.disabled=true;
    setStatus('Collecting diagnostic\u2026');
    var api=global.FFmpegAPI;
    var media=(api&&typeof api.diagnoseText==='function')?api.diagnoseText()
      :('  FAIL media pipeline: '+((api&&api._disabled)||'FFmpegAPI did not load'));
    return host('getTempDir',[],{timeout:8000,readOnly:true}).then(function(t){
      return '  OK   host temp dir: '+(typeof t==='string'?t:JSON.stringify(t));
    },function(e){ return '  FAIL host temp dir: '+e.message; }).then(function(hostLine){
      var head=['CompX Orbit Premiere \u2014 diagnostic',new Date().toISOString(),''];
      try{ head.push('  OK   panel agent: '+String(navigator.userAgent||'').slice(0,150)); }catch(_){}
      var text=head.concat([hostLine,'',media]).join('\n');
      var first=null,lines=text.split('\n');
      for(var i=0;i<lines.length;i++){ if(lines[i].indexOf('  FAIL ')===0){ first=lines[i].replace('  FAIL ','').trim(); break; } }
      function done(){ setStatus(first?('Diagnostic copied \u2014 first failure: '+first):'Diagnostic copied \u2014 all checks passed.',!!first,!first); }
      try{ console.log(text); }catch(_){}
      if(navigator.clipboard&&navigator.clipboard.writeText)
        return navigator.clipboard.writeText(text).then(done).catch(function(){copyFallback(text);done();});
      copyFallback(text); done();
    }).catch(function(e){ setStatus('Diagnostic failed: '+e.message,true); })
      .then(function(){ if(el.diagnostic) el.diagnostic.disabled=false; });
  }
  function copyFallback(text){var a=document.createElement('textarea');a.value=text;a.style.position='fixed';a.style.left='-9999px';document.body.appendChild(a);a.select();document.execCommand('copy');document.body.removeChild(a);}
  function wireRoute(){var row=$('assetTypeRow'),shelf=row&&row.querySelector('.shelf[data-type="doctor"]');if(!row||!shelf||!el.view)return;row.addEventListener('click',function(event){var b=event.target;while(b&&b!==row&&!/(^|\s)shelf(\s|$)/.test(b.className||''))b=b.parentNode;if(!b||b===row)return;if(b.getAttribute('data-type')!=='doctor'){el.view.style.display='none';return;}event.preventDefault();event.stopImmediatePropagation();var shelves=row.querySelectorAll('.shelf');for(var i=0;i<shelves.length;i++)shelves[i].classList.toggle('active',shelves[i]===b);var lib=$('sfxMogrtView');if(lib)lib.style.display='none';var panels=document.querySelectorAll('.orbit-view-panel');for(var j=0;j<panels.length;j++)panels[j].style.display='none';el.view.style.display='block';try{localStorage.setItem('compXLibraryShelf','doctor');}catch(_){}if(!state.opened){state.opened=true;scan();}},true);}
  function wire(){if(!el.scan)return;wireRoute();el.scan.addEventListener('click',scan);el.save.addEventListener('click',saveProject);el.mark.addEventListener('click',markIssues);el.copy.addEventListener('click',copyReport);if(el.diagnostic)el.diagnostic.addEventListener('click',diagnostic);el.filters.addEventListener('click',function(e){var b=e.target;if(!b.getAttribute('data-pd-filter'))return;state.filter=b.getAttribute('data-pd-filter');var buttons=el.filters.querySelectorAll('button');for(var i=0;i<buttons.length;i++)buttons[i].classList.toggle('active',buttons[i]===b);render();});el.list.addEventListener('click',function(e){var go=e.target.getAttribute('data-pd-go'),fix=e.target.getAttribute('data-pd-fix');if(go)goTo(go);if(fix==='save-project')saveProject();});}
  wire(); global.ProjectDoctor={scan:scan,getReport:function(){return state.report;},reportText:reportText,diagnostic:diagnostic,_addCaptionChecks:addCaptionChecks};
}(window));
