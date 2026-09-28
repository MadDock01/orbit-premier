// Execute production JSX functions with simulated Premiere objects.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const acorn=require('./dev-require.cjs')('acorn');
const source=fs.readFileSync(path.join(root,'jsx/hostscript.jsx'),'utf8');
const ast=acorn.parse(source,{ecmaVersion:2022,allowReturnOutsideFunction:true});
function load(ctx,names){vm.createContext(ctx);for(const name of names){const fn=ast.body.find(x=>x.type==='FunctionDeclaration'&&x.id.name===name);assert.ok(fn,name);vm.runInContext(source.slice(fn.start,fn.end),ctx);}return ctx;}
// Top-level `var` constants the loaded functions close over. Evaluating the
// real declaration keeps a fixture from drifting away from production — a
// hand-copied clip-name prefix would let a renamed constant pass the suite.
function loadConsts(ctx,names){for(const name of names){
 const decl=ast.body.find(x=>x.type==='VariableDeclaration'&&x.declarations.some(d=>d.id.name===name));
 assert.ok(decl,name);vm.runInContext(source.slice(decl.start,decl.end),ctx);}return ctx;}
let count=0;
function test(name,fn){fn();count++;console.log('PASS '+name);}
test('Safety copy restores original sequence, playhead and clip selection',()=>{
 let selected=true,at='12345',copies=0;
 const clip={setSelected(v){selected=v;}};
 const seq={sequenceID:'original',getSelection(){return selected?[clip]:[]},getPlayerPosition(){return {ticks:at}},setPlayerPosition(v){at=v},clone(){copies++;selected=false;at='0';ctx.app.project.activeSequence={sequenceID:'copy'};return true;}};
 const ctx=load({pproRequireSequence:()=>seq,toolResult:(success,message)=>({success,message}),app:{project:{activeSequence:seq,openSequence(id){assert.equal(id,'original');this.activeSequence=seq;}}}},['ppro_duplicateActiveSequence']);
 assert.equal(ctx.ppro_duplicateActiveSequence(true).success,true);
 assert.equal(copies,1);assert.equal(selected,true);assert.equal(at,'12345');assert.equal(ctx.app.project.activeSequence,seq);
 ctx.app.project.openSequence=()=>{};
 assert.equal(ctx.ppro_duplicateActiveSequence(true).success,false);
});
// A 200x100 clip in a 1000x500 sequence unless a test passes its own clip.
function fixture(opts){
 opts=opts||{};
 const prop=v=>({value:v,getValue(){return this.value},setValue(v){this.value=v;return 0},isTimeVarying(){return false}});
 const props={'Position':prop([.5,.5]),'Anchor Point':prop([.5,.5]),'Rotation':prop(0),'Scale':prop(100),'Uniform Scale':prop(true),'Scale Width':prop(100)};
 const clip=opts.clip||{projectItem:{getVideoInfo:()=> '200 x 100'}},seq={frameSizeHorizontal:1000,frameSizeVertical:500};
 const items=opts.items||[clip];
 const c=load({app:{},_composerSelected:()=>({seq,items}),_composerIntrinsicMotionProperty:(clip,name)=>props[name],_composerMotionPositionProperty:()=>props.Position},
 ['_composerFrameSize','_composerParseSize','_composerColumnSize','_composerPixelAspect','_composerSourceSize','_composerMotionScale','_composerRotatedBounds','_composerAnchorTarget','_composerNormalizedMotionPoint','_composerWriteMotionValue','_composerVisualItems','_composerClipLabel','_composerAlignAxis','composerAlignSelection','composerSetAnchorPoint']);
 loadConsts(c,['_COMPOSER_UNKNOWN_SIZE']);
 return {c,props};
}
const near=(actual,expected)=>expected.forEach((v,i)=>assert.ok(Math.abs(actual[i]-v)<1e-9,'got '+JSON.stringify([...actual])+', wanted '+JSON.stringify(expected)));
// Position is where the anchor sits. Writing the pad spot straight into it put
// a default clip's centre on the frame corner, with most of the clip off screen.
test('Align puts the clip edges on the frame edges, not its centre',()=>{
 const {c,props}=fixture();
 assert.equal(JSON.parse(c.composerAlignSelection('top-left')).moved,1);
 near(props.Position.value,[.1,.1]);           // centre 100px/50px in: the corner is flush
 assert.equal(JSON.parse(c.composerAlignSelection('bottom-right')).moved,1);
 near(props.Position.value,[.9,.9]);
 assert.equal(JSON.parse(c.composerAlignSelection('middle-left')).moved,1);
 near(props.Position.value,[.1,.5]);
});
test('Align measures a rotated clip by its rotated bounds',()=>{
 const {c,props}=fixture();props.Rotation.value=90;  // now 100 wide, 200 tall
 assert.equal(JSON.parse(c.composerAlignSelection('top-left')).moved,1);
 near(props.Position.value,[.05,.2]);
});
test('Anchor top-left then Align top-left lands the corner exactly on the frame corner',()=>{
 const {c,props}=fixture();
 assert.equal(JSON.parse(c.composerSetAnchorPoint('top-left')).changed,1);
 near(props.Position.value,[.4,.4]);           // the picture did not move
 assert.equal(JSON.parse(c.composerAlignSelection('top-left')).moved,1);
 near(props.Position.value,[0,0]);
});
test('Anamorphic footage is measured at its display width',()=>{
 const clip={projectItem:{getProjectColumnsMetadata:()=>JSON.stringify([{ColumnName:'Video Info',ColumnValue:'1440 x 1080 (1.3333)'}])}};
 const {c}=fixture({clip});
 const size=c._composerSourceSize(clip,{width:1920,height:1080},null);
 assert.ok(Math.abs(size.width-1920)<0.1,'width '+size.width);assert.equal(size.height,1080);
});
test('Graphics with no known size are left alone with a clear reason',()=>{
 const {c,props}=fixture({clip:{}});
 assert.match(JSON.parse(c.composerAlignSelection('top-left')).error,/Essential Graphics/);
 assert.match(JSON.parse(c.composerSetAnchorPoint('top-left')).error,/Essential Graphics/);
 assert.deepEqual([...props.Position.value],[.5,.5]);assert.deepEqual([...props['Anchor Point'].value],[.5,.5]);
});
test('The linked audio half of a selection is ignored, not reported as skipped',()=>{
 const clip={projectItem:{getVideoInfo:()=> '200 x 100'}};
 const {c}=fixture({clip,items:[clip,{mediaType:'Audio'}]});
 const res=JSON.parse(c.composerAlignSelection('top-left'));
 assert.equal(res.moved,1);assert.equal(res.skipped,0);assert.equal(res.errors.length,0);
 assert.match(JSON.parse(fixture({items:[{mediaType:'Audio'}]}).c.composerAlignSelection('center')).error,/video or image/);
});
test('Anchor compensates position and supports rotated static clips',()=>{
 const {c,props}=fixture();props.Rotation.value=90;
 assert.equal(JSON.parse(c.composerSetAnchorPoint('top-left')).changed,1);
 assert.ok(Math.abs(props.Position.value[0]-.55)<1e-9);assert.ok(Math.abs(props.Position.value[1]-.3)<1e-9);
});
test('A silent rejected Position write is not reported as aligned',()=>{
 const {c,props}=fixture();props.Position.setValue=()=>0;
 assert.match(JSON.parse(c.composerAlignSelection('top-left')).error,/rejected/);
});
test('Animated anchor edits fail explicitly instead of adding a key at the wrong time',()=>{
 const {c,props}=fixture();props.Position.isTimeVarying=()=>true;
 assert.match(JSON.parse(c.composerSetAnchorPoint('center')).error,/Animated/);
});
test('Nonuniform scale respects Scale Width',()=>{
 const {c,props}=fixture();props['Uniform Scale'].value=false;props['Scale Width'].value=50;
 assert.equal(c._composerMotionScale({}).x,.5);
});
test('Graphics with no reported source bounds fall back to the sequence frame',()=>{
 const {c}=fixture();const size=c._composerSourceSize({}, {width:1000,height:500}, null);
 assert.equal(size.width,1000);assert.equal(size.height,500);assert.equal(size.estimated,true);
});
test('The Video Info project column is preferred over XMP guessing',()=>{
 const {c}=fixture();
 const item={getProjectColumnsMetadata:()=>JSON.stringify([{ColumnName:'Media Duration',ColumnValue:'00;00;20;17'},{ColumnName:'Video Info',ColumnValue:'1080 x 1920 (1.0)'}]),
  getProjectMetadata:()=>'<xmpDM:videoFrameSize stDim:w="640" stDim:h="480"/>'};
 const size=c._composerSourceSize({projectItem:item}, {width:1000,height:500}, null);
 assert.equal(size.width,1080);assert.equal(size.height,1920);assert.equal(size.estimated,false);
});
test('XMP frame-size attributes are read, not just element text',()=>{
 const {c}=fixture();
 const item={getProjectMetadata:()=>'<xmpDM:videoFrameSize rdf:parseType="Resource" stDim:w="3840" stDim:h="2160"/>'};
 const size=c._composerSourceSize({projectItem:item}, {width:1000,height:500}, null);
 assert.equal(size.width,3840);assert.equal(size.height,2160);
});
test('A clip larger than the frame aligns its edge and keeps the frame covered',()=>{
 const {c,props}=fixture();props.Scale.value=1000;props.Position.value=[.62,.4];  // 2000x1000
 assert.equal(JSON.parse(c.composerAlignSelection('top-right')).moved,1);
 near(props.Position.value,[0,1]);             // right edge at 1000, top edge at 0
});
// A write that lands on the value already in place is a success, not a
// rejection. Judging the write by "did the value change" made Align > centre on
// a centred clip, and Anchor > centre on a default clip, always report failure.
test('Re-applying the spot a clip already sits on is reported as already there, not rejected',()=>{
 const {c,props}=fixture();
 const res=JSON.parse(c.composerAlignSelection('center'));
 assert.equal(res.error,undefined);assert.equal(res.moved,0);assert.equal(res.alreadyThere,1);
 assert.deepEqual([...props.Position.value],[.5,.5]);
});
test('Anchor centre on a default clip succeeds instead of erroring',()=>{
 const {c,props}=fixture();
 const res=JSON.parse(c.composerSetAnchorPoint('center'));
 assert.equal(res.changed,1);assert.equal(res.error,undefined);
 assert.deepEqual([...props['Anchor Point'].value],[.5,.5]);
 assert.deepEqual([...props.Position.value],[.5,.5]);
});
test('Keyframed Position blocks align; animated scale blocks anchor',()=>{
 const {c,props}=fixture();props.Position.isTimeVarying=()=>true;
 assert.match(JSON.parse(c.composerAlignSelection('top-left')).error,/keyframed/);
 assert.equal(props.Position.value[0],.5);
 const other=fixture();other.props.Scale.isTimeVarying=()=>true;
 assert.match(JSON.parse(other.c.composerSetAnchorPoint('top-left')).error,/Animated scale/);
});
// ── Playhead actions ────────────────────────────────────────────────────────
// Premiere silently ignores writes to read-only TrackItem properties, so the
// timeline fixture can switch its edge setters off to exercise that path.
const TIMELINE_FNS=['ticksToSeconds','secondsToTicks','secondsToTimecode','_composerFps','_composerExactFps','_composerPlayheadSeconds',
 '_composerTimelineSeconds','_composerTimelineTime','_composerTimelineSelected','_composerTimelineBounds','_composerSetTimelineBoundary',
 '_composerTrackAt','_composerQeTrackAt','_composerTrackLabel','_composerTimelineTrackGroups','_composerGroupList','_composerPlayheadTimecode',
 '_composerLockedTargets','_composerRazorTargetTracks','_composerReselectRanges','_composerTimelineTrackItemTotal','_composerTimelineSelectedGroups',
 '_composerTimelineLockNonTargetTracks','_composerTimelineRestoreTrackLocks','composerTimelineAction'];
function collection(items){Object.defineProperty(items,'numItems',{get(){return this.length},configurable:true});return items;}
function trackList(items){Object.defineProperty(items,'numTracks',{get(){return this.length},configurable:true});return items;}
function makeClip(track,s,e,selected,writable){
 const clip={_s:s,_e:e,_sel:!!selected,isSelected(){return this._sel},setSelected(v){this._sel=!!v},
  remove(ripple){const i=track.clips.indexOf(clip);if(i<0)throw new Error('detached');const span=clip._e-clip._s;track.clips.splice(i,1);
   if(ripple)track.clips.forEach(other=>{if(other._s>=clip._s){other._s-=span;other._e-=span;}});return true}};
 for(const edge of ['start','end']){const key=edge==='start'?'_s':'_e';
  Object.defineProperty(clip,edge,{get(){return {seconds:this[key]}},set(v){if(writable)this[key]=Number(v.seconds)},configurable:true});}
 return clip;
}
function timeline(spec,writable,noQe){
 const state={playhead:spec.playhead,razors:0};
 function build(kind,rows){return trackList(rows.map((row,index)=>{const track={kind,index,clips:collection([])};
  row.forEach(([s,e,sel])=>track.clips.push(makeClip(track,s,e,sel,writable)));return track;}));}
 const seq={timebase:String(Math.round(254016000000/spec.fps)),videoTracks:build('video',spec.video||[]),audioTracks:build('audio',spec.audio||[]),
  getPlayerPosition(){return {ticks:String(Math.round(state.playhead*254016000000)),seconds:state.playhead}},
  getSelection(){const out=[];[...seq.videoTracks,...seq.audioTracks].forEach(t=>t.clips.forEach(c=>{if(c._sel)out.push(c)}));return out}};
 function qeTrack(track){return {isLocked(){return false},razor(){state.razors++;
  const at=state.playhead,hit=track.clips.find(c=>c._s<at-1e-9&&c._e>at+1e-9);if(!hit)return;
  const tail=makeClip(track,at,hit._e,hit._sel,writable);hit._e=at;track.clips.splice(track.clips.indexOf(hit)+1,0,tail);}};}
 const qeSeq={CTI:{timecode:'00;00;00;00'},getVideoTrackAt(i){return qeTrack(seq.videoTracks[i])},getAudioTrackAt(i){return qeTrack(seq.audioTracks[i])},razor(){}};
 const ctx=load({app:{enableQE(){},beginUndoGroup(){},endUndoGroup(){}},qe:{project:{getActiveSequence(){return noQe?null:qeSeq}}},
  Time:function Time(){this.seconds=0;this.ticks='0';},_composerSelected:()=>({seq,items:seq.getSelection()})},TIMELINE_FNS);
 return {run:a=>JSON.parse(ctx.composerTimelineAction(a)),seq,state};
}
const spans=track=>track.clips.map(c=>[c._s,c._e]);
test('Cut at playhead splits the selected clip and keeps both halves selected',()=>{
 const t=timeline({fps:30,playhead:5,video:[[[0,10,true]]]},true);
 const res=t.run('cut-at-playhead');
 assert.equal(res.changed,1);assert.deepEqual(spans(t.seq.videoTracks[0]),[[0,5],[5,10]]);
 assert.deepEqual(t.seq.videoTracks[0].clips.map(c=>c._sel),[true,true]);
});
test('Cut leaves untargeted tracks untouched',()=>{
 const t=timeline({fps:30,playhead:5,video:[[[0,10,true]],[[0,10,false]]]},true);
 assert.equal(t.run('cut-at-playhead').changed,1);
 assert.deepEqual(spans(t.seq.videoTracks[1]),[[0,10]]);
});
test('Cut at an existing edit point reports a clear failure',()=>{
 const t=timeline({fps:30,playhead:5,video:[[[0,5,true],[5,10,true]]]},true);
 assert.match(t.run('cut-at-playhead').error,/playhead inside a selected clip/);
});
test('Trim uses razor + remove so Premiere records it in undo history',()=>{
 const t=timeline({fps:30,playhead:4,video:[[[0,10,true]]],audio:[[[0,10,true]]]},true);
 const res=t.run('trim-before');
 assert.equal(res.changed,2);assert.ok(t.state.razors>0);
 assert.deepEqual(spans(t.seq.videoTracks[0]),[[4,10]]);assert.deepEqual(spans(t.seq.audioTracks[0]),[[4,10]]);
});
test('Trim after playhead removes only the tail piece',()=>{
 const t=timeline({fps:30,playhead:4,video:[[[0,10,true]]]},true);
 assert.equal(t.run('trim-after').changed,1);assert.deepEqual(spans(t.seq.videoTracks[0]),[[0,4]]);
});
test('Trim never touches unselected clips on the same track',()=>{
 const t=timeline({fps:30,playhead:4,video:[[[0,10,true],[10,20,false]]]},true);
 assert.equal(t.run('trim-after').changed,1);
 assert.deepEqual(spans(t.seq.videoTracks[0]),[[0,4],[10,20]]);
});
test('Without QE the verified edge write still trims',()=>{
 const t=timeline({fps:30,playhead:4,video:[[[0,10,true]]]},true,true);
 const res=t.run('trim-before');
 assert.equal(res.changed,1);assert.equal(t.state.razors,0);
 assert.deepEqual(spans(t.seq.videoTracks[0]),[[4,10]]);
});
test('Trim needs the playhead inside a selected clip',()=>{
 const t=timeline({fps:30,playhead:12,video:[[[0,10,true]]]},true);
 assert.match(t.run('trim-before').error,/playhead inside a selected clip/);
});
test('Ripple delete closes the gap on every selected track',()=>{
 const t=timeline({fps:30,playhead:0,video:[[[0,2,false],[2,4,true],[4,6,false]]],audio:[[[0,2,false],[2,4,true],[4,6,false]]]},true);
 assert.equal(t.run('ripple-delete').changed,2);
 assert.deepEqual(spans(t.seq.videoTracks[0]),[[0,2],[2,4]]);
 assert.deepEqual(spans(t.seq.audioTracks[0]),[[0,2],[2,4]]);
});
test('Ripple delete removes several clips per track, latest first',()=>{
 const t=timeline({fps:30,playhead:0,video:[[[0,2,true],[2,4,false],[4,6,true]]]},true);
 assert.equal(t.run('ripple-delete').changed,2);
 assert.deepEqual(spans(t.seq.videoTracks[0]),[[0,2]]);
});
test('Ripple delete refuses mismatched ranges across tracks',()=>{
 const t=timeline({fps:30,playhead:0,video:[[[2,4,true]]],audio:[[[3,5,true]]]},true);
 assert.match(t.run('ripple-delete').error,/same start and end/);
});

// ---------------------------------------------------------------------------
// Second round of dock actions: Nest/Unnest, Flip, Fit to Frame, guides,
// Create Sequence. Same approach as above — the real production functions run
// against stand-in Premiere objects.
// ---------------------------------------------------------------------------

function fitFixture(sourceW,sourceH,uniform=true){
 const prop=v=>({value:v,getValue(){return this.value},setValue(v){this.value=v;return 0},isTimeVarying(){return false}});
 const props={'Scale':prop(100),'Uniform Scale':prop(uniform),'Scale Width':prop(100),'Anchor Point':prop([.5,.5])};
 const clip={name:'shot',projectItem:{getVideoInfo:()=>sourceW+' x '+sourceH}};
 const seq={frameSizeHorizontal:1000,frameSizeVertical:500};
 const c=load({app:{},_composerSelected:()=>({seq,items:[clip]}),
  _composerIntrinsicMotionProperty:(_clip,name)=>props[name]},
  ['_composerFrameSize','_composerParseSize','_composerColumnSize','_composerPixelAspect','_composerSourceSize','_composerMotionScale',
   '_composerWriteMotionValue','composerFitToFrame']);
 return {c,props};
}

// A 200x200 source in a 1000x500 frame: fitting is limited by the short side
// (2.5x), filling by the long one (5x). A single "scale to frame" would have
// to pick one and be wrong half the time, which is why both shipped.
test('Fit is bounded by the tighter axis and fill by the looser one',()=>{
 const fit=fitFixture(200,200);
 assert.equal(JSON.parse(fit.c.composerFitToFrame('fit')).changed,1);
 assert.equal(fit.props.Scale.value,250);
 const fill=fitFixture(200,200);
 assert.equal(JSON.parse(fill.c.composerFitToFrame('fill')).changed,1);
 assert.equal(fill.props.Scale.value,500);
});

test('Reset returns Scale to 100 without reading the source size',()=>{
 const {c,props}=fitFixture(0,0);           // unreadable source
 props.Scale.value=333;
 assert.equal(JSON.parse(c.composerFitToFrame('reset')).changed,1);
 assert.equal(props.Scale.value,100);
});

// Scale only drives one axis while Uniform Scale is off, so a fit would apply
// to half the clip and silently leave it distorted.
test('Fit re-enables Uniform Scale before writing',()=>{
 const {c,props}=fitFixture(200,200,false);
 JSON.parse(c.composerFitToFrame('fit'));
 assert.equal(props['Uniform Scale'].value,true);
 assert.equal(props.Scale.value,250);
});

// An unreadable source (a MOGRT, a shape, a graphic) reports no dimensions.
// _composerSourceSize treats that as a full-frame surface, so fit resolves to
// 100% and leaves the clip where it is rather than throwing it off-screen.
test('An unreadable source falls back to the frame and lands on 100%',()=>{
 const {c,props}=fitFixture(0,0);
 props.Scale.value=42;
 assert.equal(JSON.parse(c.composerFitToFrame('fit')).changed,1);
 assert.equal(props.Scale.value,100);
});

test('An unknown fit mode is refused rather than guessed',()=>{
 const {c}=fitFixture(200,200);
 assert.match(JSON.parse(c.composerFitToFrame('nonsense')).error,/Unknown fit mode/);
});

function flipFixture(existing){
 const removed=[],added=[];
 const component=name=>({name,remove(){removed.push(name);return true}});
 const qeClip={numComponents:existing.length,getComponentAt(i){return component(existing[i])},
  addVideoEffect(e){added.push(e.name);return true}};
 const clip={name:'shot',mediaType:'Video'};
 const c=load({app:{enableQE(){}},qe:{project:{getActiveSequence:()=>({}),
   getVideoEffectByName(n){return n==='Horizontal Flip'||n==='Vertical Flip'?{name:n}:null}}},
  _composerSelected:()=>({seq:{},items:[clip]}),_composerFindQeClip:()=>qeClip,_composerQe:()=>({})},
  ['_composerFindFlipEffect','_composerRemoveFlipComponent','composerFlip']);
 loadConsts(c,['_COMPOSER_FLIP_NAMES']);
 return {c,removed,added};
}

// The same button has to turn the flip off again; applying a second copy of
// the effect would leave the clip looking unflipped and carrying two effects.
test('Flip toggles: it adds when absent and removes when present',()=>{
 const off=flipFixture([]);
 const first=JSON.parse(off.c.composerFlip('horizontal'));
 assert.equal(first.applied,1);assert.equal(first.removed,0);
 assert.deepEqual(off.added,['Horizontal Flip']);

 const on=flipFixture(['Motion','Horizontal Flip']);
 const second=JSON.parse(on.c.composerFlip('horizontal'));
 assert.equal(second.removed,1);assert.equal(second.applied,0);
 assert.deepEqual(on.removed,['Horizontal Flip']);
 assert.deepEqual(on.added,[]);
});

test('A horizontal flip does not touch a vertical one',()=>{
 const f=flipFixture(['Vertical Flip']);
 assert.equal(JSON.parse(f.c.composerFlip('horizontal')).applied,1);
 assert.deepEqual(f.removed,[]);
});

function nestSeq(rows,name='Inner'){
 const tracks=kind=>trackList((rows[kind]||[]).map(row=>({clips:collection(row.map(r=>({
  name:r.name||'c',start:{seconds:r.s},end:{seconds:r.e},
  inPoint:{seconds:r.in||0},outPoint:{seconds:r.out!==undefined?r.out:(r.in||0)+(r.e-r.s)},
  projectItem:r.item,components:{numItems:r.fx===undefined?3:3+r.fx}})))})));
 return {name,videoTracks:tracks('video'),audioTracks:tracks('audio'),projectItem:{nodeId:'inner'}};
}

function unnestFixture(rows,nestSpec){
 const placed=[],trims=[];
 const item=id=>({id,_in:0,_out:99,getInPoint(){return {seconds:this._in}},getOutPoint(){return {seconds:this._out}},
  setInPoint(v){this._in=v;trims.push(['in',id,v])},setOutPoint(v){this._out=v;trims.push(['out',id,v])}});
 const items={a:item('a'),b:item('b')};
 for(const kind of Object.keys(rows))rows[kind].forEach(row=>row.forEach(r=>{r.item=items[r.item]}));
 const inner=nestSeq(rows);
 let removed=false;
 const nest={name:'Inner',projectItem:{nodeId:'inner'},start:{seconds:nestSpec.at},
  inPoint:{seconds:nestSpec.in},outPoint:{seconds:nestSpec.out},end:{seconds:nestSpec.at+(nestSpec.out-nestSpec.in)},
  remove(){removed=true;return true}};
 const track=()=>({clips:collection([]),overwriteClip(projectItem,time){placed.push({id:projectItem.id,at:time.seconds,in:projectItem._in,out:projectItem._out})}});
 const parentVideo=trackList([track(),track(),track()]);
 const parentAudio=trackList([track(),track()]);
 // Audio is stacked above every existing audio track so an unnest can never
 // overwrite the editor's own work, which means it always has to grow them.
 parentVideo.add=()=>parentVideo.push(track());
 parentAudio.add=()=>parentAudio.push(track());
 parentVideo[0].clips.push(nest);
 const outer={videoTracks:parentVideo,audioTracks:parentAudio};
 const c=load({app:{project:{sequences:Object.assign([inner],{numSequences:1})}},
  Time:function Time(){this.seconds=0;},
  _composerSelected:()=>({seq:outer,items:[nest]})},
  ['_composerSeconds','_composerTimeAt','_composerAppliedEffects','_composerSequenceForItem',
   '_composerCollectNested','_composerTrackFor','composerUnnest']);
 loadConsts(c,['_COMPOSER_INTRINSIC_COMPONENTS']);
 return {c,placed,trims,isRemoved:()=>removed};
}

// Inspect has to be a pure read. A combined call that rebuilt first and warned
// afterwards would be warning the user about something already done.
test('Unnest inspect changes nothing and reports what would be lost',()=>{
 const f=unnestFixture({video:[[{s:0,e:10,item:'a',fx:2}]]},{at:100,in:0,out:10});
 const plan=JSON.parse(f.c.composerUnnest('inspect'));
 assert.equal(plan.inspected,true);
 assert.equal(plan.clips,1);
 assert.equal(plan.effects,2);
 assert.match(plan.message,/cannot be carried over/);
 assert.equal(f.isRemoved(),false,'inspect must not delete the nest');
 assert.equal(f.placed.length,0,'inspect must not place anything');
});

test('Inspect says nothing about effects when the nest has none',()=>{
 const f=unnestFixture({video:[[{s:0,e:10,item:'a'}]]},{at:100,in:0,out:10});
 const plan=JSON.parse(f.c.composerUnnest('inspect'));
 assert.equal(plan.effects,0);
 assert.doesNotMatch(plan.message,/carried over/);
});

// The nest's in/out point is a trim on the inner timeline, so a clip that
// starts before the trim has to lose its head, not slide backwards.
test('Unnest maps inner time through the nest trim',()=>{
 const f=unnestFixture({video:[[{s:0,e:10,item:'a',in:4}]]},{at:100,in:3,out:8});
 const res=JSON.parse(f.c.composerUnnest('apply'));
 assert.equal(res.placed,1);
 assert.equal(f.isRemoved(),true);
 const p=f.placed[0];
 assert.equal(p.at,100,'a clip overlapping the trim start lands at the nest start');
 assert.equal(p.in,7,'source in = its own in (4) + the 3s the nest trimmed off the head');
 assert.equal(p.out,12,'source out = its own out (14) - the 2s trimmed off the tail');
});

test('Unnest drops clips the nest trimmed away entirely',()=>{
 const f=unnestFixture({video:[[{s:0,e:2,item:'a'},{s:5,e:9,item:'b'}]]},{at:50,in:4,out:9});
 const res=JSON.parse(f.c.composerUnnest('apply'));
 assert.equal(res.placed,1,'the clip ending at 2s is outside the 4-9s nest');
 assert.equal(f.placed[0].id,'b');
 assert.equal(f.placed[0].at,51,'5s inner - 4s trim + 50s nest start');
});

// The projectItem's in/out is the only lever overwriteClip responds to, so it
// gets trimmed — and it is shared with every other use of that footage, so it
// has to be put back.
test('Unnest restores each source item in and out point',()=>{
 const f=unnestFixture({video:[[{s:0,e:10,item:'a',in:4}]]},{at:0,in:0,out:10});
 f.c.composerUnnest('apply');
 const last=f.trims.slice(-2);
 assert.deepEqual(last.map(t=>t[0]),['in','out'],'the restore must be the final write');
 assert.equal(last[0][2],0);
 assert.equal(last[1][2],99);
});

test('Unnest stacks audio above the parent audio tracks, not over them',()=>{
 const f=unnestFixture({audio:[[{s:0,e:5,item:'a'}],[{s:0,e:5,item:'b'}]]},{at:0,in:0,out:5});
 const res=JSON.parse(f.c.composerUnnest('apply'));
 assert.equal(res.placed,2,'two inner audio tracks need two new parent tracks');
});

test('Unnest refuses a clip that is not a nested sequence',()=>{
 const c=load({app:{project:{sequences:Object.assign([],{numSequences:0})}},
  _composerSelected:()=>({seq:{},items:[{projectItem:{nodeId:'plain'},name:'clip'}]})},
  ['_composerSeconds','_composerSequenceForItem','composerUnnest']);
 assert.match(JSON.parse(c.composerUnnest('inspect')).error,/not a nested sequence/);
});

function guideFixture(names){
 const removedOrder=[];
 const clips=collection(names.map(n=>({name:n})));
 clips.forEach(c=>{c.remove=()=>{removedOrder.push(c.name);clips.splice(clips.indexOf(c),1);return true}});
 const seq={videoTracks:trackList([{clips}])};
 const c=loadConsts(load({getActiveSequence:()=>seq},['composerRemoveGuides']),['_COMPOSER_GUIDE_CLIP_NAME']);
 return {c,clips,removedOrder};
}

// Removing a clip re-indexes the ones after it, so a forward loop would skip
// every second guide and leave half of them on the timeline.
test('Removing guides survives the re-index that each removal causes',()=>{
 const g=guideFixture(['Orbit Safe Margins 16:9','Orbit Safe Margins 9:16','Orbit Safe Margins 16:9']);
 assert.equal(JSON.parse(g.c.composerRemoveGuides()).removed,3);
 assert.equal(g.clips.length,0);
});

test('Removing guides leaves the editor’s own clips alone',()=>{
 const g=guideFixture(['intro','Orbit Safe Margins 9:16','b-roll']);
 assert.equal(JSON.parse(g.c.composerRemoveGuides()).removed,1);
 assert.deepEqual([...g.clips].map(c=>c.name),['intro','b-roll']);
});

function sequenceFixture(settingsWork){
 const created=[];
 const settings={videoFrameWidth:1920,videoFrameHeight:1080};
 const made={getSettings:()=>({...settings}),setSettings(s){if(settingsWork)Object.assign(settings,s)}};
 const sequences=Object.assign([],{numSequences:0});
 const project={sequences,rootItem:{},
  createNewSequence(name){created.push(name);sequences.push(made);sequences.numSequences=sequences.length;},
  createNewSequenceFromClips(name,items){created.push(name);sequences.push(made);sequences.numSequences=sequences.length;}};
 const c=load({app:{project},_composerSelected:()=>({seq:{},items:[{projectItem:{id:'a'}}]})},['composerCreateSequence']);
 return {c,created,settings};
}

test('A 9:16 sequence is created and then resized through setSettings',()=>{
 const f=sequenceFixture(true);
 const res=JSON.parse(f.c.composerCreateSequence('9x16','Vertical'));
 assert.equal(res.ok,true);
 assert.equal(res.resized,true);
 assert.equal(f.settings.videoFrameWidth,1080);
 assert.equal(f.settings.videoFrameHeight,1920);
});

// setSettings is refused on some builds and throws on others, and either way
// it does so silently. Saying "created at 1080x1920" when Premiere kept
// 1920x1080 would send the user off to edit in the wrong aspect.
test('A refused resize is reported rather than assumed',()=>{
 const f=sequenceFixture(false);
 const res=JSON.parse(f.c.composerCreateSequence('9x16','Vertical'));
 assert.equal(res.ok,true);
 assert.equal(res.resized,false);
});

test('Creating from a selection needs a selection',()=>{
 const c=load({app:{project:{sequences:Object.assign([],{numSequences:0}),rootItem:{}}},
  _composerSelected:()=>({seq:{},items:[]})},['composerCreateSequence']);
 assert.match(JSON.parse(c.composerCreateSequence('selection','X')).error,/Select one or more/);
});

test('Nest refuses when Premiere adds no sequence',()=>{
 const sequences=Object.assign([],{numSequences:1});
 const c=load({app:{enableQE(){},project:{sequences}},
  qe:{project:{getActiveSequence:()=>({createSubsequence(){/* silently does nothing */}})}},
  _composerSelected:()=>({seq:{},items:[{}]})},['_composerQe','composerNest']);
 assert.match(JSON.parse(c.composerNest('')).error,/did not create a nested sequence/);
});

test('Nest reports the count and the new sequence name',()=>{
 const made={name:'Nested Sequence 01'};
 const sequences=Object.assign([{name:'Main'}],{numSequences:1});
 const c=load({app:{enableQE(){},project:{sequences}},
  qe:{project:{getActiveSequence:()=>({createSubsequence(){sequences.push(made);sequences.numSequences=2;}})}},
  _composerSelected:()=>({seq:{},items:[{},{}]})},['_composerQe','composerNest']);
 const res=JSON.parse(c.composerNest(''));
 assert.equal(res.nested,2);
 assert.equal(res.name,'Nested Sequence 01');
});


console.log(count+' production-function tests passed; real Adobe API behavior remains unverified.');
