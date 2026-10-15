import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
const param = () => ({ value: 0, setTargetAtTime(v) { this.value = v; }, setValueAtTime(v) { this.value = v; } });
let contexts = 0, stopped = 0;
class Context {
  constructor() { contexts++; this.currentTime = 0; this.sampleRate = 100; this.state = 'running'; this.destination = {}; this.listener = Object.fromEntries(['positionX','positionY','positionZ','forwardX','forwardY','forwardZ','upX','upY','upZ'].map(k => [k, param()])); }
  node() { return { gain: param(), frequency: param(), Q: param(), positionX: param(), positionY: param(), positionZ: param(), connect(n) { this.connected = n; }, disconnect() {}, start() {}, stop() { stopped++; } }; }
  createGain() { return this.node(); } createOscillator() { return this.node(); } createBufferSource() { return this.node(); }
  createBiquadFilter() { return this.node(); } createWaveShaper() { return this.node(); } createPanner() { return this.node(); }
  createBuffer(_, n) { return { getChannelData: () => new Float32Array(n) }; } resume() {} 
}
const sandbox = { THREE: { Vector3: class {} }, window: { AudioContext: Context }, console, Map, Math, Float32Array, CFG: { IDLE_RPM: 900, REDLINE_RPM: 8000 }, clamp: (v,a,b) => Math.max(a,Math.min(b,v)) };
vm.createContext(sandbox);
vm.runInContext(source.slice(source.indexOf('class EngineAudio {'), source.indexOf('const audio = new EngineAudio();')) + '\nthis.Audio = EngineAudio;', sandbox);
const audio = new sandbox.Audio('fe'); audio.init();
const car = (id,x,profile='i6gt') => ({ id, pos: { x,y:0,z:0 }, engineProfile: profile, rpm: 4000, speedKmh: 70, input: { throttle:.6, brake:0 } });
const own = car(1,300,'fe'), other = car(2,5,'v8'), bot = car(3,15);
const camera = { position: { x:0,y:2,z:0 }, getWorldDirection(v) { return Object.assign(v,{x:0,y:0,z:1}); } };
assert.equal(typeof audio.updateScene, 'function', '必须存在多车空间混音入口');
audio.updateScene([own,other,bot],camera,own,true);
assert.equal(contexts,1,'所有声源共享一个AudioContext');
assert.equal(audio.voices.size,2,'视角附近玩家及AI都有声源，远处本车无声');
assert.equal(audio.voices.get(2).profile,'v8','其他玩家使用各自音色');
assert.equal(audio.voices.get(3).profile,'i6gt','AI默认直六GT');
assert.equal(audio.voices.get(2).panner.positionX.value,5,'声源位于车辆世界位置');
assert.equal(audio.ctx.listener.positionY.value,2,'监听位置跟随相机');
const old = audio.voices.get(2);
other.engineProfile='v12'; audio.updateScene([own,other,bot],camera,own,true);
assert.equal(audio.voices.get(2).profile,'v12'); assert.ok(stopped>0,'切换档案停止旧振荡器');
assert.equal(old.ok,false,'旧声源已销毁');
audio.updateScene([],camera,own,false);
assert.equal(audio.voices.size,0,'退出比赛销毁其他车辆声源');
assert.equal(audio.n.master.gain.value,0,'大厅静音');
console.log('PASS 空间音频：附近玩家/AI、观战排除远处本车、音色同步、单Context、声源释放');
