'use strict';

const siteHeader = document.querySelector('.site-header');
const updateHeaderHeight = () => {
  document.documentElement.style.setProperty('--header-height', `${siteHeader.offsetHeight}px`);
};
updateHeaderHeight();
new ResizeObserver(updateHeaderHeight).observe(siteHeader);

const $ = (id) => document.getElementById(id);
const video = $('video');
const state = {data:null,sample:null,pressure:null,loading:0};
const regionNames = [
  ['Thumb', '拇指'], ['Index', '食指'], ['Middle', '中指'], ['Ring', '无名指'],
  ['Little', '小指'], ['Upper palm', '上掌'], ['Lower palm', '下掌'],
];
const regionEnglish = new Map(regionNames.map(([english, chinese]) => [chinese, english]));
const meshMethodLabels = [
  ['', ''], ['Interpolated mesh', '网格插值'], ['Held mesh', '沿用邻帧'],
  ['Held mesh > 0.4 s', '沿用邻帧超过 0.4 秒'],
];
let trialStatus;

function englishActionName(name) {
  return name.split('、').map(region => regionEnglish.get(region) ?? region).join(', ');
}

function formatAction(name) {
  return localized(englishActionName(name), name);
}

function showTrialStatus(english, chinese) {
  trialStatus = [english, chinese];
  $('sample-status').textContent = localized(...trialStatus);
}

function updatePlaybackLabel() {
  $('play').textContent = video.paused ? localized('Play', '播放') : localized('Pause', '暂停');
}
const palette = [[220,230,246],[240,190,70],[246,119,80],[206,69,69]];
const fmt = (v) => Number.isFinite(v) ? v.toFixed(1) : '—';
function color(value,max,shade=1){
  const x=Math.min(1,Math.max(0,Math.log1p(Math.max(0,value)/Math.max(max,1e-9)*15)/Math.log(16)));
  const f=x*3,i=Math.min(2,Math.floor(f)),w=f-i;
  return `rgb(${palette[i].map((c,k)=>Math.round((c*(1-w)+palette[i+1][k]*w)*shade)).join(',')})`;
}
function nearest(times,t){let lo=0,hi=times.length-1;while(lo<hi){const m=(lo+hi)>>1;if(times[m]<t)lo=m+1;else hi=m;}return lo&&Math.abs(times[lo-1]-t)<Math.abs(times[lo]-t)?lo-1:lo;}
function canvas(id){
  const c=$(id),r=c.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);
  if(c.width!==Math.round(r.width*d)||c.height!==Math.round(r.height*d)){c.width=Math.round(r.width*d);c.height=Math.round(r.height*d);}
  const ctx=c.getContext('2d');ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,r.width,r.height);
  return {ctx,w:r.width,h:r.height};
}
function triangleNormal(first, second, third) {
  const edgeA = second.map((value, axis) => value - first[axis]);
  const edgeB = third.map((value, axis) => value - first[axis]);
  return [edgeA[1]*edgeB[2]-edgeA[2]*edgeB[1], edgeA[2]*edgeB[0]-edgeA[0]*edgeB[2], edgeA[0]*edgeB[1]-edgeA[1]*edgeB[0]];
}

function pressureView({sample, mesh, faces, force, time}) {
  const frame = nearest(sample.mesh_times, time);
  const forceFrame = nearest(sample.force_times, time);
  const fallback = {yaw:-.28, pitch:.18};
  if (!sample.mesh_valid[frame] || sample.face_force_mapped?.[forceFrame] === false) return fallback;
  const origin = frame * sample.vertex_count * 3;
  const direction = [0, 0, 0];
  for (const [index, face] of faces.entries()) {
    const weight = force[forceFrame * sample.face_count + index];
    if (!(weight > 0)) continue;
    const vertices = face.map(vertex => mesh.subarray(origin + vertex*3, origin + vertex*3 + 3));
    const normal = triangleNormal(...vertices);
    const length = Math.hypot(...normal);
    if (length > 0) normal.forEach((value, axis) => { direction[axis] += value * weight / length; });
  }
  if (Math.hypot(...direction) < 1e-6) return fallback;
  const [horizontal, vertical, depth] = direction;
  return {yaw:Math.atan2(-horizontal, depth), pitch:Math.atan2(vertical, Math.hypot(horizontal, depth))};
}

function smoothMeshForDisplay(mesh, sample) {
  const times = sample.mesh_times;
  const stride = sample.vertex_count * 3;
  const smoothed = new Float32Array(mesh);
  const radius = 8;
  const sigmaSeconds = .09;
  const maxCorrection = .006;
  const usable = sample.mesh_valid.map((valid, frame) => valid && !sample.mesh_completion_method?.[frame]);
  for (let frame = 1; frame < times.length - 1; frame++) {
    if (!usable[frame]) continue;
    const neighbors = [];
    let weightSum = 1;
    for (let offset = 1; offset <= radius && frame-offset >= 0 && frame+offset < times.length; offset++) {
      const before = frame - offset;
      const after = frame + offset;
      const earlier = times[frame] - times[before];
      const later = times[after] - times[frame];
      if (!usable[before] || !usable[after] || Math.max(earlier,later) > .275 ||
          times[before+1]-times[before] > .06 || times[after]-times[after-1] > .06) break;
      const pairWeight = 2 * Math.exp(-.5 * (Math.max(earlier,later)/sigmaSeconds)**2);
      neighbors.push({left:before*stride, right:after*stride, leftWeight:pairWeight*later/(earlier+later), rightWeight:pairWeight*earlier/(earlier+later), span:earlier+later});
      weightSum += pairWeight;
    }
    if (!neighbors.length) continue;
    const widest = neighbors.at(-1);
    const start = frame * stride;
    for (let vertex = 0; vertex < stride; vertex += 3) {
      const coord = start + vertex;
      const displacement = [0, 0, 0];
      const motion = [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) {
        const center = mesh[coord+axis];
        for (const neighbor of neighbors) {
          displacement[axis] += (mesh[neighbor.left+vertex+axis]-center)*neighbor.leftWeight
            + (mesh[neighbor.right+vertex+axis]-center)*neighbor.rightWeight;
        }
        displacement[axis] /= weightSum;
        motion[axis] = mesh[widest.right+vertex+axis] - mesh[widest.left+vertex+axis];
      }
      const speed = Math.hypot(...motion) / widest.span;
      const blend = Math.max(0, Math.min(1, (.26 - speed) / .20));
      const correction = Math.hypot(...displacement);
      if (!Number.isFinite(correction) || !Number.isFinite(blend)) continue;
      const strength = blend * Math.min(1, maxCorrection / Math.max(correction, 1e-9));
      for (let axis = 0; axis < 3; axis++) smoothed[coord+axis] += strength*displacement[axis];
    }
  }
  return smoothed;
}

function hand(viewer, id, meshStatus){
  if(!viewer.sample)return;
  const {ctx,w,h}=canvas(id),s=viewer.sample,frame=nearest(s.mesh_times,viewer.time),cf=nearest(s.force_times,viewer.time);
  const labels = s.mesh_valid[frame] ? meshMethodLabels[s.mesh_completion_method?.[frame] ?? 0] : ['Mesh unavailable', '网格缺失'];
  const meshLabel = localized(...labels);
  meshStatus.hidden = !meshLabel;
  if (meshStatus.textContent !== meshLabel) meshStatus.textContent = meshLabel;
  if(!s.mesh_valid[frame]){ctx.fillStyle='#61788c';ctx.font='14px sans-serif';ctx.textAlign='center';ctx.fillText(localized('Mesh unavailable at this frame', '此帧网格不可用'),w/2,h/2);return;}
  const mesh=viewer.mesh,base=frame*s.vertex_count*3,scale=Math.min(w*.92,h*.84)/.205;
  const nextFrame = viewer.time >= s.mesh_times[frame] ? frame + 1 : frame - 1;
  const interval = s.mesh_times[nextFrame] - s.mesh_times[frame];
  const interpolate = s.mesh_valid[nextFrame] && !s.mesh_completion_method?.[frame] &&
    !s.mesh_completion_method?.[nextFrame] && Math.abs(interval) <= .06 && interval !== 0;
  const mix = interpolate ? (viewer.time-s.mesh_times[frame])/interval : 0;
  const nextOffset = interpolate ? nextFrame*s.vertex_count*3 : base;
  const {yaw,pitch}=viewer.view;
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),points=[],spatial=[];
  for(let i=0;i<s.vertex_count;i++){
    const current = base+i*3, next = nextOffset+i*3;
    const x=mesh[current]*(1-mix)+mesh[next]*mix,y=mesh[current+1]*(1-mix)+mesh[next+1]*mix,z=mesh[current+2]*(1-mix)+mesh[next+2]*mix;
    const xx=x*cy+z*sy,zz=-x*sy+z*cy,yy=y*cp-zz*sp;
    const depth=y*sp+zz*cp;points.push([w*.52+xx*scale,h*.46-yy*scale,depth]);spatial.push([xx,yy,depth]);
  }
  ctx.save();ctx.shadowColor='#16334b18';ctx.shadowBlur=28;ctx.fillStyle='#16334b08';ctx.beginPath();ctx.ellipse(w*.55,h*.80,w*.22,h*.025,0,0,Math.PI*2);ctx.fill();ctx.restore();
  const order=viewer.faces.map((face,i)=>({face,i,z:face.reduce((a,j)=>a+points[j][2],0)})).sort((a,b)=>a.z-b.z);
  for(const tri of order){
    const a=points[tri.face[0]],b=points[tri.face[1]],c=points[tri.face[2]];if(!Number.isFinite(a[0]+b[0]+c[0]))continue;
    const normal=triangleNormal(...tri.face.map(vertex => spatial[vertex])),len=Math.hypot(...normal)||1;
    const shade=.67+.33*Math.abs((normal[0]*-.25+normal[1]*.35+normal[2]*.9)/len);
    const faceForce=s.face_force_mapped?.[cf]===false?0:viewer.force[cf*s.face_count+tri.i];
    ctx.fillStyle=color(faceForce,s.force_color_max,shade);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.lineTo(c[0],c[1]);ctx.closePath();ctx.fill();
  }
}
function signals(){
  if(!state.sample)return;
  const s=state.sample,{ctx,w,h}=canvas('emg'),left=28,right=9,top=6,bottom=8;
  ctx.strokeStyle=signalTheme.grid;ctx.lineWidth=1;
  for(let i=0;i<5;i++){const x=left+(w-left-right)*i/4;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,h-bottom);ctx.stroke();}
  const row=(h-top-bottom)/18;
  for(let ch=0;ch<18;ch++){
    const y=top+(ch+.7)*row;
    ctx.fillStyle=signalTheme.label;
    ctx.font='10px Arial';
    ctx.textAlign='left';
    ctx.fillText(String(ch+1).padStart(2,'0'),0,y);
    ctx.strokeStyle=signalTheme.traces[ch%3];ctx.lineWidth=.9;ctx.beginPath();
    s.emg.forEach((v,i)=>{const x=left+Math.max(0,Math.min(1,s.emg_times[i]/s.duration))*(w-left-right),yy=y-v[ch]*row*.75;i?ctx.lineTo(x,yy):ctx.moveTo(x,yy);});ctx.stroke();
  }
  const x=left+(w-left-right)*state.time/s.duration;ctx.strokeStyle='#f67750';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();
  const p=canvas('pressure'),pf=nearest(s.pressure_times,state.time),[rows,cols]=s.pressure_shape,cell=Math.min(p.w/(cols+2),p.h/(rows+2)),ox=(p.w-cols*cell)/2,oy=(p.h-rows*cell)/2;
  p.ctx.fillStyle='#f6f8fb';p.ctx.fillRect(ox,oy,cols*cell,rows*cell);
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const value=state.pressure[pf*rows*cols+r*cols+c];p.ctx.fillStyle=value>0?color(value,s.pressure_color_max):'#f1f5fa';p.ctx.fillRect(ox+c*cell,oy+r*cell,cell+.4,cell+.4);}
  const f=nearest(s.region_times,state.time),values=s.region_forces[f],max=Math.max(1,...values);
  values.forEach((v,i)=>{const row=$('region-bars').children[i];row.querySelector('.region-fill').style.width=`${Math.max(0,v)/max*100}%`;row.querySelector('.region-value').textContent=fmt(v);});
  $('total-force').textContent=`${fmt(values.reduce((a,b)=>a+b,0))} N`;
}
function drawTrialHand(){hand(state,'hand',$('mesh-status'));}
function render(){drawTrialHand();signals();if(state.sample){$('time').value=String(state.time);$('time-label').textContent=`${state.time.toFixed(2)} / ${state.sample.duration.toFixed(2)} s`;}}

const themeRoot = document.documentElement;
const themeButtons = [...document.querySelectorAll('[data-theme-choice]')];
const signalTheme = {};

function applyTheme(theme) {
  themeRoot.dataset.theme = theme;
  for (const button of themeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
  }
  const styles = getComputedStyle(themeRoot);
  signalTheme.grid = styles.getPropertyValue('--line').trim();
  signalTheme.label = styles.getPropertyValue('--muted').trim();
  signalTheme.traces = ['--trace-blue', '--trace-teal', '--trace-muted']
    .map(property => styles.getPropertyValue(property).trim());
  document.querySelector('meta[name="theme-color"]').content = styles.getPropertyValue('--white').trim();
  render();
}

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    const theme = button.dataset.themeChoice;
    applyTheme(theme);
    try { localStorage.setItem('egomyo-theme', theme); } catch {}
  });
}
applyTheme(themeRoot.dataset.theme ?? 'light');

const backToTop = document.querySelector('.back-to-top');
function updateBackToTop() {
  backToTop.hidden = window.scrollY < window.innerHeight;
}
window.addEventListener('scroll', updateBackToTop, {passive:true});
window.addEventListener('resize', updateBackToTop);
window.addEventListener('pageshow', updateBackToTop);
updateBackToTop();

function checkJSON(r){if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();}
function checkBuffer(r){if(!r.ok)throw Error(`HTTP ${r.status}`);return r.arrayBuffer();}

async function loadMesh(base) {
  const [sample, mesh, faces, force] = await Promise.all([
    fetch(base+'sample.json').then(checkJSON), fetch(base+'mesh.bin').then(checkBuffer),
    fetch(base+'faces.json').then(checkJSON), fetch(base+'face_force.bin').then(checkBuffer),
  ]);
  const model = {sample, mesh:smoothMeshForDisplay(new Float32Array(mesh), sample), faces, force:new Float32Array(force), time:sample.preview_time ?? 0};
  model.defaultView = pressureView(model);
  model.view = {...model.defaultView};
  return model;
}

async function loadSample(id){
  const request=++state.loading;video.pause();$('play').disabled=true;$('time').disabled=true;
  showTrialStatus('Loading selected trial…', '正在加载所选试次…');
  document.querySelectorAll('#sample-buttons button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sample===id)));
  try{
    const base=`samples/${id}/`;
    const [model,pressure]=await Promise.all([loadMesh(base),fetch(base+'pressure.bin').then(checkBuffer)]);
    if(request!==state.loading)return;
    const s = model.sample;
    Object.assign(state,model,{pressure:new Float32Array(pressure)});
    video.onloadedmetadata=()=>{if(request===state.loading)video.currentTime=state.time;};
    video.poster = s.poster ? base + s.poster : '';
    video.src=base+s.video;video.load();$('time').max=String(s.duration);$('time').disabled=false;$('play').disabled=false;
    showTrialStatus(`${s.subject} · Session ${s.wearing} · ${englishActionName(s.action_name)}`,
                    `${s.subject} · 第 ${s.wearing} 次佩戴 · ${s.action_name}`);
    $('mesh-fallback').hidden=true;render();
  }catch(error){
    if(request!==state.loading)return;
    showTrialStatus('Trial could not load. Refresh to retry.', '试次加载失败，请刷新重试。');
    $('mesh-fallback').hidden=false;
    console.error('Sample loading failed',error);
  }
}
let raf=0;
function tick(){if(!state.sample||video.paused)return;state.time=Math.min(state.sample.duration,video.currentTime);render();raf=requestAnimationFrame(tick);}
video.addEventListener('play',()=>{updatePlaybackLabel();cancelAnimationFrame(raf);tick();});
video.addEventListener('pause',()=>{updatePlaybackLabel();cancelAnimationFrame(raf);});
video.addEventListener('ended',()=>{state.time=Math.min(state.sample.duration,video.currentTime);render();});
$('play').addEventListener('click',()=>{if(!state.sample)return;if(video.paused){if(video.ended||video.currentTime>=state.sample.duration-.05)video.currentTime=0;video.play().catch(()=>{showTrialStatus('Playback did not start. Select Play to retry.', '视频未开始播放，请再次点击播放。');});}else video.pause();});
$('time').addEventListener('input',e=>{if(!state.sample)return;state.time=Number(e.target.value);video.currentTime=state.time;render();});
window.addEventListener('resize',()=>requestAnimationFrame(render));document.addEventListener('visibilitychange',()=>{if(document.hidden)video.pause();});

function bindRotation(viewer, surface, resetButton, redraw) {
  const reset = () => {
    if (!viewer.sample) return;
    viewer.view = {...viewer.defaultView};
    redraw();
  };
  const rotate = (yaw, pitch) => {
    viewer.view = {yaw, pitch:Math.max(-Math.PI/2, Math.min(Math.PI/2, pitch))};
    redraw();
  };
  resetButton.addEventListener('click', reset);
  let drag = null;
  surface.addEventListener('pointerdown', event => {
    if (!viewer.sample || event.button !== 0 || !event.isPrimary) return;
    drag = {id:event.pointerId, x:event.clientX, y:event.clientY, ...viewer.view};
    surface.setPointerCapture(event.pointerId);
  });
  surface.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    rotate(drag.yaw+(event.clientX-drag.x)*.008, drag.pitch+(event.clientY-drag.y)*.006);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    surface.addEventListener(name, event => { if (drag?.id === event.pointerId) drag = null; });
  }
  const steps = {ArrowLeft:[-.1,0], ArrowRight:[.1,0], ArrowUp:[0,-.1], ArrowDown:[0,.1]};
  surface.addEventListener('keydown', event => {
    if (!viewer.sample) return;
    if (event.key === 'Home') {
      event.preventDefault();
      reset();
    } else if (Object.hasOwn(steps, event.key)) {
      event.preventDefault();
      const [yaw, pitch] = steps[event.key];
      rotate(viewer.view.yaw+yaw, viewer.view.pitch+pitch);
    }
  });
}

bindRotation(state, $('hand'), $('reset-view'), drawTrialHand);

function configureDownload(metadata) {
  if (!metadata.dataset_url) return;
  const url = new URL(metadata.dataset_url, window.location.href);
  if (url.origin !== 'https://huggingface.co' || !/^\/datasets\/[^/]+\/[^/]+\/?$/.test(url.pathname)) return;
  const link = $('dataset-link');
  for (const resource of [link, $('paper-dataset-link')]) {
    resource.href = url.href;
    resource.target = '_blank';
    resource.rel = 'noopener';
    resource.removeAttribute('aria-disabled');
  }
  link.textContent = localized('View on Hugging Face ↗', '在 Hugging Face 获取数据 ↗');
}

document.addEventListener('site-languagechange', () => {
  updatePlaybackLabel();
  if (trialStatus) showTrialStatus(...trialStatus);
  if (state.data) {
    const names = new Map(state.data.samples.map(sample => [sample.id, sample.action_name]));
    for (const button of $('sample-buttons').children) button.lastElementChild.textContent = formatAction(names.get(button.dataset.sample));
    configureDownload(state.data);
  }
  [...$('region-bars').children].forEach((row, index) => { row.firstElementChild.textContent = localized(...regionNames[index]); });
  render();
});

async function start(){
  for(const names of regionNames){const row=document.createElement('div');row.className='region-row';row.innerHTML=`<span>${localized(...names)}</span><div class="region-track"><div class="region-fill"></div></div><span class="region-value">0.0</span>`;$('region-bars').append(row);}
  updatePlaybackLabel();
  try{
    state.data=await fetch('data.json').then(checkJSON);
    for (const sample of state.data.samples) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.sample = sample.id;
      button.setAttribute('aria-pressed', 'false');
      const action = document.createElement('span');
      action.textContent = formatAction(sample.action_name);
      button.append(sample.subject, action);
      button.addEventListener('click', () => loadSample(sample.id));
      $('sample-buttons').append(button);
    }
    configureDownload(state.data);
    await loadSample(state.data.samples[0].id);
  }catch(error){showTrialStatus('Dataset details could not load. Refresh to retry.', '数据说明加载失败，请刷新重试。');console.error('Dataset metadata loading failed',error);}
}
start();
