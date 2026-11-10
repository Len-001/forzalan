// 首页昵称在游戏重模块加载前同步；各入口共享同一个 Profile。
import { setPenaltyMode } from './PenaltyController.js';

const NAME_KEY = 'forza_lan_name';
export function syncPlayerProfile(name) {
  const value = String(name || '').trim().slice(0, 12);
  const profile = document.getElementById('profileName');
  if (profile) profile.textContent = value || '未命名车手';
  if (value) {
    try { localStorage.setItem(NAME_KEY, value); } catch (_) { /* 禁用存储时仍可驾驶 */ }
  }
  return value;
}

export function initializeRaceUI() {
  const name = document.getElementById('name');
  let saved = '';
  try { saved = localStorage.getItem(NAME_KEY) || ''; } catch (_) { /* 无本地存储 */ }
  if (name && saved) name.value = saved.slice(0, 12);
  syncPlayerProfile(saved || name?.value);
  name?.addEventListener('input', () => syncPlayerProfile(name.value));
  const inRoom = document.getElementById('nameInRoom');
  document.getElementById('btnRename')?.addEventListener('click', () => {
    if (inRoom?.value.trim()) syncPlayerProfile(inRoom.value);
  });
  window.addEventListener('storage', event => {
    if (event.key === NAME_KEY) {
      if (name) name.value = (event.newValue || '').slice(0, 12);
      syncPlayerProfile(event.newValue);
    }
  });
  const mode = document.getElementById('gameMode');
  mode?.addEventListener('change', () => setPenaltyMode(mode.value));
  setPenaltyMode(mode?.value || 'fm8');
}

initializeRaceUI();

import {TUNING_RANGES,normalizeTuning,drivingAssists,PersonalBestDelta,CarMastery} from './RaceStrategy.js';
const readSaved=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{/* private browsing */}};
export function createMotorsportUI(getState,notify=()=>{}) {
  const $=id=>document.getElementById(id),garage=$('tuningGarage'),sliders=$('tuningSliders');
  const labels={pressure:'胎压 PSI',finalDrive:'终传比',frontAero:'前空气动力',rearAero:'后空气动力',suspension:'悬挂刚度',differential:'差速锁'};
  let tuning=normalizeTuning(readSaved('forzalan.tuning',{})),delta=null,mastery=null,lastTick=0,trackKey='',rewindStart=null;
  if(sliders)for(const [key,[min,max]]of Object.entries(TUNING_RANGES)){
    const label=document.createElement('label');label.textContent=labels[key];const input=document.createElement('input'),value=document.createElement('output');
    input.type='range';input.min=min;input.max=max;input.step=key==='pressure'?'0.5':'0.01';input.value=tuning[key];input.id='tune-'+key;value.textContent=input.value;
    input.oninput=()=>{tuning[key]=+input.value;value.textContent=input.value;save('forzalan.tuning',tuning);};label.append(input,value);sliders.append(label);
  }
  $('btnGarage')?.addEventListener('click',()=>garage.showModal());$('closeGarage')?.addEventListener('click',()=>garage.close());
  const assists=()=>{const a={};for(const k of ['autoBrake','abs','tcs','stability','steering'])a[k]=!!$('assist-'+k)?.checked;return a;};
  function syncMode(){const mode=$('gameMode')?.value||'fm8',pro=mode!=='horizon';const a=drivingAssists(mode,assists());for(const k of Object.keys(a)){const e=$('assist-'+k);if(e){e.checked=a[k];e.disabled=pro;}}$('assistStatus').textContent=pro?'Spec Series · 辅助已锁定':'Track Day · 自定义辅助';getState().rp?.setAssists(a);}
  $('gameMode')?.addEventListener('change',syncMode);for(const e of document.querySelectorAll('#drivingAssists input'))e.addEventListener('change',()=>getState().rp?.setAssists(assists()));syncMode();
  function rewind(value){const s=getState();if(!s.offline||s.gameMode!=='horizon'||!s.rp?.racing||s.localCar?.finished)return;
    if(value&&rewindStart===null)rewindStart=s.rp.time;
    if(!value&&rewindStart!==null){s.raceStartAt=Date.now()-s.rp.time*1000;rewindStart=null;}
    s.rp.setRewind(value);
  }
  window.addEventListener('keydown',e=>{if(e.target?.closest('input,textarea,select')||getState().chatTyping)return;if(e.code==='Backspace'){e.preventDefault();rewind(true);}if(e.code==='KeyP')getState().rp?.requestPit($('pitCompound').value);});
  window.addEventListener('keyup',e=>{if(e.code==='Backspace'){e.preventDefault();rewind(false);}});window.addEventListener('blur',()=>rewind(false));
  const rewindButton=$('btnRewind');rewindButton?.addEventListener('pointerdown',e=>{rewindButton.setPointerCapture(e.pointerId);rewind(true);});for(const name of ['pointerup','pointercancel','lostpointercapture'])rewindButton?.addEventListener(name,()=>rewind(false));
  $('btnPit')?.addEventListener('click',()=>{getState().rp?.requestPit($('pitCompound').value);notify('进入青色维修区并停车，3 秒后换胎加油');});
  function xpPopup(amount){const root=$('masteryPopup');if(!root)return;root.textContent='+'+amount+' XP';root.hidden=false;clearTimeout(root._hide);root._hide=setTimeout(()=>{root.hidden=true;},1800);}
  return {
    syncMode,
    setup(){return {tuning:normalizeTuning(tuning),assists:assists(),compound:$('startingCompound')?.value||'Medium'};},
    begin(track,mode){trackKey='forzalan.pb.'+track.trackType+'.'+track.seed;delta=new PersonalBestDelta(readSaved(trackKey,null));mastery=new CarMastery(readSaved('forzalan.mastery.'+(getState().localCar?.engine||'i6gt'),0));lastTick=0;$('btnRewind').hidden=!(getState().offline&&mode==='horizon');},
    lap(car,time,dirty){if(!car?.isLocal||!delta)return;if(delta.finish(time,dirty||car.rewoundLap))save(trackKey,Array.from(delta.best));},
    update(now,car,track,rank){
      if(now-lastTick<100)return;lastTick=now;const s=getState();if(!car)return;
      const visual=s.localCar;if(delta&&visual){const p=visual.trackIdx/track.count;const d=delta.update(p,visual.lapTimeLive,visual.lap,visual.lapInvalid||visual.rewoundLap||visual.rewinding);
        const root=$('personalDelta');root.dataset.sign=d===null?'none':d<0?'ahead':'behind';$('personalDeltaText').textContent=d===null?'个人最佳 · —':(d<0?'':'+')+d.toFixed(3)+' s';$('personalDeltaFill').style.width=(d===null?0:Math.min(50,Math.abs(d)*10))+'%';}
      const ids=['FL','FR','RL','RR'];for(let i=0;i<4;i++){const e=$('tire-'+ids[i]),temp=car.tireTemp?.[i]??80,wear=Math.round((1-(car.tireWear?.[i]||0))*100);e.textContent=ids[i]+' '+Math.round(temp)+'° '+wear+'%';e.style.setProperty('--heat',temp<60?'#38bfff':temp<100?'#36e5a0':temp<120?'#ffcf54':'#ff5858');}
      $('compoundReadout').textContent=(car.compound||'Medium')+' · 油量 '+Math.round((car.fuel??1)*100)+'%';
      $('pitStatus').textContent=car.pitProgress>0?'维修中 '+Math.round(car.pitProgress*100)+'%':car.inPit?'维修区 · 停车换胎':'P · 进站策略';
      $('rewindStatus').textContent=car.rewinding?'◀ 回溯中':Math.min(10,car.rewindSeconds||0).toFixed(1)+' 秒可回溯';
      if(mastery&&visual&&s.rp?.racing&&!visual.rewinding){const gained=mastery.update(visual,track,rank);if(gained){xpPopup(gained);save('forzalan.mastery.'+(visual.engine||'i6gt'),mastery.xp);} $('masteryLevel').textContent='Car Mastery · Lv.'+mastery.level+' · '+mastery.xp+' XP';}
    },
  };
}
