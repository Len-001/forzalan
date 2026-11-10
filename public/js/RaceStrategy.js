// Shared rules, independent of the renderer and DOM.
export const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,Number.isFinite(+v)?+v:lo));
export const COMPOUND_NAMES=Object.freeze(['Soft','Medium','Hard','Wet']);
export const COMPOUNDS=Object.freeze({Soft:{grip:1.08,heat:1.18,wear:0.000035,opt:90},Medium:{grip:1,heat:1,wear:0.000022,opt:85},Hard:{grip:0.95,heat:0.82,wear:0.000012,opt:95},Wet:{grip:0.88,heat:1.3,wear:0.000045,opt:65}});
export const TUNING_RANGES=Object.freeze({pressure:[24,36,30],finalDrive:[0.8,1.2,1],frontAero:[0.75,1.25,1],rearAero:[0.75,1.25,1],suspension:[0.75,1.3,1],differential:[0,1,0.5]});
export function normalizeTuning(input={}){const out={};for(const [k,[lo,hi,d]]of Object.entries(TUNING_RANGES))out[k]=clamp(input[k]??d,lo,hi);return out;}
export function drivingAssists(mode,input={}){return mode!=='horizon'?{autoBrake:false,abs:true,tcs:true,stability:false,steering:false}:{autoBrake:!!input.autoBrake,abs:input.abs!==false,tcs:input.tcs!==false,stability:!!input.stability,steering:!!input.steering};}
const FIELDS=['pitProgress','time','lapStart','lap','lapTimeLive','lastLap','bestLap','bestCleanLap','cpIdx','progress','lineCross','trackIdx','crossedStart','penalty','violations','lapInvalid','steerInput','steerAngle','handbrake','gear','rpm','fuel','suspCompression','suspVel','wheelspin','ayPrev','prevForwardSpeed'];
const WHEELS=['tireTemp','tireWear','wheelGroundY','wheelCurb'];
const STRIDE=15+FIELDS.length+16;
export class RewindHistory {
  constructor(){this.capacity=201;this.data=new Float64Array(this.capacity*STRIDE);this.head=0;this.count=0;this.cursor=null;this.acc=0;}
  reset(){this.head=this.count=0;this.cursor=null;this.acc=0;}
  record(c,time,dt){
    this.acc+=dt;if(this.acc<0.05)return;this.acc%=0.05;
    const a=this.data,o=this.head*STRIDE,b=c.body;let k=o;
    for(let i=0;i<4;i++){const v=i===0?b.position:i===1?b.quaternion:i===2?b.velocity:b.angularVelocity;a[k++]=v.x;a[k++]=v.y;a[k++]=v.z;if(i===1)a[k++]=v.w;}
    a[k++]=time;for(const f of FIELDS)a[k++]=f==='time'?time:Number(c[f])||0;
    for(const f of WHEELS)for(let j=0;j<4;j++)a[k++]=c[f]?.[j]||0;
    a[k++]=COMPOUND_NAMES.indexOf(c.compound);
    this.head=(this.head+1)%this.capacity;this.count=Math.min(this.capacity,this.count+1);
  }
  rewind(c,dt){
    if(!this.count)return null;if(this.cursor===null)this.cursor=this.count-1;
    this.cursor=Math.max(0,this.cursor-dt*20);const i=Math.floor(this.cursor),s=this.cursor-i;
    const first=(this.head-this.count+this.capacity)%this.capacity,a=this.data,oa=((first+i)%this.capacity)*STRIDE,ob=((first+Math.min(i+1,this.count-1))%this.capacity)*STRIDE;let k=0;
    for(let j=0;j<4;j++){
      const v=j===0?c.body.position:j===1?c.body.quaternion:j===2?c.body.velocity:c.body.angularVelocity;
      let sign=1;if(j===1&&a[oa+k]*a[ob+k]+a[oa+k+1]*a[ob+k+1]+a[oa+k+2]*a[ob+k+2]+a[oa+k+3]*a[ob+k+3]<0)sign=-1;
      v.x=a[oa+k]*(1-s)+a[ob+k]*s*sign;k++;v.y=a[oa+k]*(1-s)+a[ob+k]*s*sign;k++;v.z=a[oa+k]*(1-s)+a[ob+k]*s*sign;k++;
      if(j===1){v.w=a[oa+k]*(1-s)+a[ob+k]*s*sign;k++;v.normalize();}
    }
    const time=a[oa+k]*(1-s)+a[ob+k]*s;k++;
    for(const f of FIELDS)c[f]=a[oa+k++];for(const f of WHEELS)for(let j=0;j<4;j++)c[f][j]=a[oa+k++];
    c.compound=COMPOUND_NAMES[a[oa+k]|0]||'Medium';c.pitRequested=false;
    c.body.force.set(0,0,0);c.body.torque.set(0,0,0);c.body.aabbNeedsUpdate=true;c.syncFromBody();c.prevPos.copy(c.pos);c.prevQuat.copy(c.quat);
    c.lapTimeLive=Math.max(0,time-c.lapStart);
    c.offTimer=c.offDist=c.offThrottleT=c.offBrakeT=0;c.wasOff=false;c.reentryGrace=0.75;c.finished=false;c.finishGhost=false;c.rewoundLap=true;return time;
  }
  resume(){if(this.cursor!==null){const first=(this.head-this.count+this.capacity)%this.capacity;this.count=Math.floor(this.cursor)+1;this.head=(first+this.count)%this.capacity;}this.cursor=null;this.acc=0;}
}
export class PersonalBestDelta {
  constructor(best=null){this.current=new Float32Array(257).fill(-1);this.best=best?.length===257?Float32Array.from(best):null;this.previous=-1;this.previousTime=0;this.lap=-1;this.valid=true;this.delta=null;}
  update(progress,time,lap,dirty=false){
    const p=clamp(progress,0,0.999999)*256;
    if(lap!==this.lap||p<this.previous-128){this.current.fill(-1);this.previous=-1;this.valid=true;this.lap=lap;}
    if(dirty)this.valid=false;
    if(this.previous>=0&&p>=this.previous&&p-this.previous<64)for(let k=Math.ceil(this.previous);k<=Math.floor(p);k++)this.current[k]=this.previousTime+(time-this.previousTime)*(p===this.previous?0:(k-this.previous)/(p-this.previous));
    this.previous=p;this.previousTime=time;const i=Math.floor(p),a=this.best?.[i],b=this.best?.[i+1];this.delta=a>=0&&b>=0?time-(a+(b-a)*(p-i)):null;return this.delta;
  }
  finish(time,dirty){let count=0;for(const t of this.current)if(t>=0)count++;if(dirty||!this.valid||count<245||time<=0)return false;this.current[0]=0;this.current[256]=time;if(!this.best||time<this.best[256]){this.best=this.current.slice();return true;}return false;}
}
export class CarMastery {
  constructor(xp=0){this.xp=Math.max(0,Number(xp)||0);this.ledger=new Set();this.sector=-1;this.rank=0;this.lastRadius=5000;this.approaching=false;this.sectorDirty=false;this.sectorStart=0;}
  get level(){return Math.min(50,1+Math.floor(Math.sqrt(this.xp/100)));}
  award(key,amount){if(this.ledger.has(key))return 0;this.ledger.add(key);this.xp+=amount;return amount;}
  update(c,t,rank){
    if(!c||c.finished||c.rewoundLap)return 0;const lap=c.lap||0,sector=Math.floor(c.trackIdx/t.count*3),distance=(c.lineCross||0)*t.count+c.trackIdx;let xp=0;
    if(c.lapInvalid)this.sectorDirty=true;
    if(this.sector!==sector){if(this.sector>=0&&!this.sectorDirty&&distance-this.sectorStart>=t.count/6&&c.surface===0)xp+=this.award(`sector:${lap}:${this.sector}`,40);this.sector=sector;this.sectorStart=distance;this.sectorDirty=!!c.lapInvalid;}
    const radius=t.raceLine?.radius[c.trackIdx]||5000;if(radius<this.lastRadius-0.5)this.approaching=true;
    if(this.approaching&&radius>this.lastRadius+0.5&&radius<500){if(!c.lapInvalid&&c.surface===0&&c.speed>0.8*(t.raceLine?.vTarget[c.trackIdx]||15))xp+=this.award(`apex:${lap}:${Math.floor(c.trackIdx/12)}`,25);this.approaching=false;}
    if(this.rank>rank&&rank>0&&c.speedKmh>20&&!c.lapInvalid)xp+=this.award(`pass:${lap}:${rank}`,50);this.rank=rank;this.lastRadius=radius;return xp;
  }
}
