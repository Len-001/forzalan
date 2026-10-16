/* =============================================================================
 * main.js —— 渲染循环 / 比赛状态机 / HUD / 相机 / 音效 / 自定义模型装载
 *
 * 模块依赖（全部相对路径，零 CDN）：
 *   ./track.js    纯代码赛道生成
 *   ./physics.js  Cannon-es 车对车 + 解析式路面 + FM8 规则
 *   ./network.js  局域网 WebSocket 同步与插值
 *   ../libs/three.min.js   全局 THREE（由 index.html 以 <script> 引入）
 * ========================================================================== */

import { Track, GRID_SLOTS } from './track.js';
import { RENDER_CFG as CFG } from './physics-protocol.js';
import { PhysicsWorkerBridge } from './PhysicsWorkerBridge.js';
import { ForzaChaseCamera } from './ForzaChaseCamera.js';
import { Net } from './network.js';
import { routeProgress } from './race-position.js';
import { DrivingControls } from './DrivingControls.js';
import { showPenaltyEvent, setPenaltyMode, clearPenaltyEvents } from './PenaltyController.js';
import { syncPlayerProfile } from './RaceUI.js';

/* ========================================================================== */
/* 0. 启动与容错                                                               */
/* ========================================================================== */

const $ = (id) => document.getElementById(id);

function fatal(msg, detail) {
  const b = $('boot');
  if (!b) return;
  b.classList.remove('hidden');
  $('bootMsg').innerHTML = '<b style="color:#ff6a5a">' + msg + '</b><br><small style="opacity:.75">' +
    (detail || '') + '</small>';
  $('bootBar').style.width = '100%';
  $('bootBar').style.background = '#e10600';
}

window.addEventListener('error', (e) => {
  fatal('运行期错误', (e.message || '未知错误') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
});

if (!window.THREE) {
  fatal('本地引擎库 three.min.js 未加载',
    '请确认 public/libs/three.min.js 存在，并通过 Go 服务端地址访问本页（浏览器禁止 file:// 加载 ES 模块）。');
  throw new Error('THREE not found');
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// 「发车时刻与本地时钟不在同一时间轴」的判定阈值（秒）。
// 倒计时期间 raceClock 合法地是 −2.6s 量级，而真正的换轴（服务端把 monoMs 之类
// 进程相对量写进 at）是 −1e12 量级 —— 取 −30s 把两者彻底分开，诊断不再误报。
const CLOCK_AXIS_BREAK_S = 30;

// Slew only the server-clock offset used by the render/race clock.  The Worker
// never consumes this value: its accumulator continues to call fixedStep with
// the exact PHYSICS_DT.  Limiting the offset correction to dt * 1.5% makes the
// displayed race clock converge without a timestamp jump.
function slewServerClock(dt) {
  const target = (S.offline || !S.net) ? 0 : finiteNum(S.net.clockOffset, 0);
  if (!Number.isFinite(S.simOffset)) S.simOffset = target;
  const maxWarpMs = Math.max(0, dt) * 1000 * CFG.MAX_TIME_WARP;
  S.simOffset += clamp(target - S.simOffset, -maxWarpMs, maxWarpMs);
  return Date.now() + S.simOffset;
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '--:--.--';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
}
function fmtGap(s) {
  if (!isFinite(s)) return '—';
  return (s >= 0 ? '+' : '-') + Math.abs(s).toFixed(2);
}
function finiteNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function safeFixed(v, digits = 1, fallback = '0.0') {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : fallback;
}

const CAR_COLORS = ['#e10600', '#46c8ff', '#ffc400', '#22d17a', '#c04cff', '#ff7a00', '#e8eef5', '#ff4fa3'];
const AI_COLORS = ['#e10600', '#46c8ff', '#ffc400', '#22d17a', '#c04cff', '#ff7a00', '#e8eef5', '#ff4fa3', '#00b8a9', '#8f6fff', '#d9f24e', '#ff5d73'];
const DEFAULT_SEED = 20260922;
let FORCE_SEED = 0;      // 可通过 ?seed=123 固定赛道，便于复现与自动化测试

/* ========================================================================== */
/* 1. WebAudio 引擎音效（全部由振荡器/噪声代码合成，零音频文件）                 */
/* ========================================================================== */

// 活塞档位的波导物理模型配置（Antonio-R1/engine-sound-generator, MIT）。
// 长度单位是 44100Hz 下的采样点，构造时按 (sampleRate/44100) 缩放。
// 气缸数决定点火谐波密度（i6/V8/V12 听感差异的物理来源）；管路几何微调音色：
//   v8 更长的排气/更大的消音器 action → 低频更重；v12 更短的管路/更小的 ignitionTime → 高亢。
const ENGINE_WORKLET_CONFIGS = {
  i6gt: { cylinders: 6, intake: 100, exhaust: 100, extractor: 100, ignition: 0.016,
          straight: 128, muffler: [10, 15, 20, 25], action: 0.1, outlet: 5 },
  v8: { cylinders: 8, intake: 105, exhaust: 110, extractor: 104, ignition: 0.014,
        straight: 132, muffler: [12, 17, 23, 29], action: 0.12, outlet: 5 },
  v12: { cylinders: 12, intake: 92, exhaust: 96, extractor: 94, ignition: 0.012,
         straight: 120, muffler: [8, 12, 16, 20], action: 0.08, outlet: 4 },
};

class EngineAudio {
  /**
   * 程序化合成音效（不依赖任何外部素材）。
   *
   * ⚠️ 关于"用 FM8 的音效"：FM8 的引擎/胎噪是**受版权保护的采样素材**，不能直接取用。
   *    这里改成**程序化合成**出同类音色特征：
   *      · 引擎 = 点火频率的谐波堆（f/2 次低音 + 1/2/3/4/6 次谐波）+ 波形塑形（排气 rasp）
   *        + 随载荷开合的低通 + 进气噪声；换档时 rpm 回落后音高自然下坠。
   *      · 胎噪 = 侧向尖叫（高 Q 带通，随侧偏角）+ 纵向打滑（低 Q 带通，随打滑率/空转/抱死）
   *      · 路面 = 路肩搓板（按车速调制的齿槽频率）+ 草地沙沙 + 风噪
   *
   * 2026-09-30 重写（用户报障："引擎声音不好听…轮胎打滑时没有音效，与地面摩擦也没有音效"）。
   */
  /**
   * @param {string} profile 音色档案（用户指定：默认 **直六 GT**）
   *   'i6gt'   直列六缸 GT  —— 点火频率 (rpm/60)×3，谐波偏"厚"，中高转有金属质感
   *   'v8'     十字曲轴 V8   —— ×4，低频更重、排气"鼓包"感更强
   *   'v12'    高转 V12      —— ×6，高亢、泛音密集
   */
  constructor(profile = 'i6gt') {
    this.ok = false; this.on = true; this.vol = 0.75; this._curbPhase = 0;
    this.profile = profile;
    this.voices = new Map();
  }

  disposeVoices() {
    for (const voice of this.voices.values()) {
      try { for (const o of voice.oscs || []) o.stop(); } catch (e) { /* 已停止 */ }
      try { voice.root && voice.root.disconnect(); } catch (e) { /* ignore */ }
      voice.ok = false;
    }
    this.voices.clear();
  }

  dispose() {
    this._workletReady = false;
    if (this._workletNode) {
      try { this._workletNode.disconnect(); } catch (e) { /* 已释放 */ }
      this._workletNode = null;
    }
    this.disposeVoices();
    try {
      if (this.n) {
        for (const o of (this.n.oscs || [])) o.o.stop();
        if (this.n.sub) this.n.sub.stop();
        this.n.master.gain.value = 0;
        this.n.master.disconnect();
      }
    } catch (e) { /* 浏览器在页面关闭时可能已释放节点 */ }
    this.ok = false;
    const oldCtx = this.ctx;
    this.ctx = null;
    try { oldCtx && oldCtx.close && oldCtx.close(); } catch (e) { /* ignore */ }
  }

  /**
   * 活塞档位：加载波导物理引擎 worklet（Antonio-R1/engine-sound-generator, MIT）。
   * 异步：addModule 完成前引擎声道静音（胎噪/路面/风噪不受影响）；
   * 失败（旧浏览器/CSP 拦截/加载错误）→ 回落谐波振荡器栈。
   * 波导长度按 (sampleRate/44100) 缩放，保证任意采样率下音高一致。
   */
  async _initWorkletEngine(engMix) {
    const profileAtStart = this.profile;
    try {
      const ctx = this.ctx;
      if (!ctx || !ctx.audioWorklet) return;
      const cfg0 = ENGINE_WORKLET_CONFIGS[profileAtStart] || ENGINE_WORKLET_CONFIGS.i6gt;
      const k = ctx.sampleRate / 44100;
      const scale = (n) => Math.max(2, Math.round(n * k));
      await ctx.audioWorklet.addModule('./js/engine-sound-worklet.js');
      // 异步期间用户可能切了档位/重连：ctx 或 profile 变了就丢弃本次结果
      if (this.ctx !== ctx || this.profile !== profileAtStart || !this.ok) return;
      const node = new AudioWorkletNode(ctx, 'forza-engine-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 3,
        outputChannelCount: [1, 1, 1],
        processorOptions: {
          cylinders: cfg0.cylinders,
          intakeWaveguideLength: scale(cfg0.intake),
          exhaustWaveguideLength: scale(cfg0.exhaust),
          extractorWaveguideLength: scale(cfg0.extractor),
          intakeOpenReflectionFactor: 0.01,
          intakeClosedReflectionFactor: 0.95,
          exhaustOpenReflectionFactor: 0.01,
          exhaustClosedReflectionFactor: 0.95,
          ignitionTime: cfg0.ignition,
          straightPipeWaveguideLength: scale(cfg0.straight),
          straightPipeReflectionFactor: 0.01,
          mufflerElementsLength: cfg0.muffler.map(scale),
          action: cfg0.action,
          outletWaveguideLength: scale(cfg0.outlet),
          outletReflectionFactor: 0.01,
        },
      });
      // 输出通道：0=进气（弃用，进气噪声走 engAir 链） 1=机体振动 2=排气尾管（主音色）
      // outletG 1.2 由 tools/audio-calibrate.mjs 实测标定：6000rpm 满油门 RMS≈0.5，
      // 与旧振荡器路径（fe 档实测 RMS≈0.54）同量级；3.0 会削波（RMS 0.95, peak 0.99）。
      const outletG = ctx.createGain(); outletG.gain.value = 1.2;
      const blockG = ctx.createGain(); blockG.gain.value = 1.2;
      node.connect(outletG, 2); outletG.connect(engMix);
      node.connect(blockG, 1); blockG.connect(engMix);
      this._workletOutletG = outletG;
      this._workletNode = node;
      this._workletReady = true;
    } catch (e) {
      console.warn('[audio] 波导引擎 worklet 加载失败，回落振荡器栈', e);
      // 回落：重建振荡器引擎（仅当仍在同一份音频上下文里）
      if (this.ok && this.ctx && this.n && !this._workletNode && this._prof &&
          this._prof.type === 'piston' && !this.n.oscs) {
        const ctx = this.ctx;
        const oscs = [];
        const HARM = this._prof.harm;
        const HG = this._prof.gain;
        for (let i = 0; i < HARM.length; i++) {
          const o = ctx.createOscillator();
          o.type = i === 0 ? 'sawtooth' : 'square';
          o.frequency.value = 60 * HARM[i];
          const g = ctx.createGain(); g.gain.value = HG[i];
          o.connect(g); g.connect(this.n.engMix); o.start();
          oscs.push({ o, mul: HARM[i], g });
        }
        const sub = ctx.createOscillator(); sub.type = 'sine';
        const subG = ctx.createGain(); subG.gain.value = 0.3;
        sub.connect(subG); subG.connect(this.n.engMix); sub.start();
        this.n.oscs = oscs; this.n.sub = sub;
      }
    }
  }

  setProfile(profile) {
    const next = ['i6gt', 'v8', 'v12', 'fe'].includes(profile) ? profile : 'i6gt';
    if (next === this.profile && this.ok) return;
    this.profile = next;
    if (this.ok) { this.dispose(); this.init(); }
  }

  init() {
    if (this.ok) return;
    if (this.ctx) this.dispose();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);

      // ---------- 噪源（确定性白噪声）----------
      const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
      const ch = noiseBuf.getChannelData(0);
      let seed = 987654321;
      for (let i = 0; i < ch.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        ch[i] = (seed / 0x3fffffff) - 1;
      }
      const mkNoise = () => {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf; src.loop = true; src.start();
        return src;
      };

      // ---------- ① 引擎 ----------
      // 活塞档位（i6gt/v8/v12）：优先用开源波导物理模型 —— 每缸进气/排气波导 +
      // 点火激励 + 消音器（public/js/engine-sound-worklet.js，MIT）。
      // fe 电动档 / worklet 不可用 → 回落谐波振荡器栈（音色见 PROFILES）。
      const engMix = ctx.createGain(); engMix.gain.value = 0;
      const engDrive = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = Math.tanh(x * 2.6);
      }
      engDrive.curve = curve; engDrive.oversample = '2x';
      const engLP = ctx.createBiquadFilter(); engLP.type = 'lowpass'; engLP.frequency.value = 900; engLP.Q.value = 0.7;
      const engHonk = ctx.createBiquadFilter(); engHonk.type = 'peaking'; engHonk.frequency.value = 1800; engHonk.Q.value = 1.2; engHonk.gain.value = 7;
      engMix.connect(engDrive); engDrive.connect(engLP); engLP.connect(engHonk); engHonk.connect(master);

      // 音色档案：点火倍率 + 谐波配比（直六 GT 为默认，见构造函数说明）
      const PROFILES = {
        i6gt: { fire: 3, harm: [1, 2, 3, 4, 6], gain: [1.0, 0.55, 0.30, 0.16, 0.07], lp: 1.0, honk: 1800, air: 1.0, type: 'piston' },
        v8: { fire: 4, harm: [1, 2, 3, 4, 5], gain: [1.0, 0.62, 0.24, 0.20, 0.12], lp: 0.85, honk: 1200, air: 1.25, type: 'piston' },
        v12: { fire: 6, harm: [1, 2, 3, 4, 6], gain: [1.0, 0.48, 0.38, 0.24, 0.16], lp: 1.25, honk: 2600, air: 0.85, type: 'piston' },
        // ★ 电动方程式（Formula E）：没有点火/排气，取而代之是
        //   ① 电机高频啸叫（基频 = 转速 × 8，正弦 + 锯齿混合，'fe' 型）
        //   ② 减速齿啸（bandpass 高 Q，音高随车速）
        //   ③ 逆变器开关啸叫的微弱高频成分；进气/排气噪声通道**关掉**
        fe: { fire: 8, harm: [1, 2, 4], gain: [1.0, 0.5, 0.28], lp: 2.2, honk: 4200, air: 0.05, type: 'electric' },
      };
      const PROF = PROFILES[this.profile] || PROFILES.i6gt;
      this._prof = PROF;
      this._workletNode = null;   // 波导引擎节点（仅 piston 档位）
      this._workletReady = false;
      const useWorklet = PROF.type === 'piston' && !!ctx.audioWorklet;
      let oscs = null, sub = null;
      if (useWorklet) {
        this._initWorkletEngine(engMix);
      } else {
        // 谐波振荡器栈：fe 电驱 / worklet 降级路径共用
        oscs = [];
        const HARM = PROF.harm;
        const HG = PROF.gain;
        for (let i = 0; i < HARM.length; i++) {
          const o = ctx.createOscillator();
          // 电驱用正弦为主（啸叫更"纯"），活塞用锯齿/方波（更"毛"）
          o.type = PROF.type === 'electric'
            ? (i === 0 ? 'sine' : 'triangle')
            : (i === 0 ? 'sawtooth' : 'square');
          o.frequency.value = 60 * HARM[i];
          const g = ctx.createGain(); g.gain.value = HG[i];
          o.connect(g); g.connect(engMix); o.start();
          oscs.push({ o, mul: HARM[i], g });
        }
        sub = ctx.createOscillator(); sub.type = 'sine';
        const subG = ctx.createGain(); subG.gain.value = 0.3;
        sub.connect(subG); subG.connect(engMix); sub.start();
      }

      const engAir = mkNoise();
      const engAirBP = ctx.createBiquadFilter(); engAirBP.type = 'bandpass'; engAirBP.frequency.value = 500; engAirBP.Q.value = 0.6;
      const engAirG = ctx.createGain(); engAirG.gain.value = 0.0001;
      engAir.connect(engAirBP); engAirBP.connect(engAirG); engAirG.connect(master);

      // ---------- ② 胎噪 ----------
      const latN = mkNoise();
      const latBP = ctx.createBiquadFilter(); latBP.type = 'bandpass'; latBP.frequency.value = 1150; latBP.Q.value = 7;
      const latG = ctx.createGain(); latG.gain.value = 0.0001;
      latN.connect(latBP); latBP.connect(latG); latG.connect(master);

      const lonN = mkNoise();
      const lonBP = ctx.createBiquadFilter(); lonBP.type = 'bandpass'; lonBP.frequency.value = 620; lonBP.Q.value = 2.4;
      const lonG = ctx.createGain(); lonG.gain.value = 0.0001;
      lonN.connect(lonBP); lonBP.connect(lonG); lonG.connect(master);

      // ---------- ③ 路面 ----------
      const curbN = mkNoise();
      const curbBP = ctx.createBiquadFilter(); curbBP.type = 'bandpass'; curbBP.frequency.value = 95; curbBP.Q.value = 2.2;
      const curbG = ctx.createGain(); curbG.gain.value = 0.0001;
      curbN.connect(curbBP); curbBP.connect(curbG); curbG.connect(master);

      const grassN = mkNoise();
      const grassLP = ctx.createBiquadFilter(); grassLP.type = 'lowpass'; grassLP.frequency.value = 420; grassLP.Q.value = 0.7;
      const grassG = ctx.createGain(); grassG.gain.value = 0.0001;
      grassN.connect(grassLP); grassLP.connect(grassG); grassG.connect(master);

      const windN = mkNoise();
      const windLP = ctx.createBiquadFilter(); windLP.type = 'lowpass'; windLP.frequency.value = 700; windLP.Q.value = 0.5;
      const windG = ctx.createGain(); windG.gain.value = 0.0001;
      windN.connect(windLP); windLP.connect(windG); windG.connect(master);

      this.n = { master, engMix, engLP, engAirBP, engAirG, oscs, sub,
        latBP, latG, lonBP, lonG, curbBP, curbG, grassG, windG };
      master.gain.setTargetAtTime(0.5 * this.vol, ctx.currentTime, 0.4);
      this.ok = true;
    } catch (e) {
      console.warn('[audio] 初始化失败', e);
    }
  }

  resume() { if (this.ok && this.ctx.state === 'suspended') this.ctx.resume(); }

  toggle() {
    this.on = !this.on;
    if (this.ok) this.n.master.gain.setTargetAtTime(this.on ? 0.5 * this.vol : 0, this.ctx.currentTime, 0.06);
    return this.on;
  }

  _num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  _createVoice(car, profile) {
    const ctx = this.ctx;
    const root = ctx.createGain();
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 6;
    panner.maxDistance = 160;
    panner.rolloffFactor = 1.8;
    root.connect(panner); panner.connect(this.n.master);
    const spec = profile === 'v12'
      ? { fire: 6, mul: [1, 2, 3], type: 'sine' }
      : profile === 'v8'
        ? { fire: 4, mul: [1, 2, 4], type: 'sawtooth' }
        : profile === 'fe'
          ? { fire: 8, mul: [1, 2, 4], type: 'sine' }
          : { fire: 3, mul: [1, 2, 3], type: 'sawtooth' };
    const oscs = spec.mul.map((mul, i) => {
      const o = ctx.createOscillator();
      o.type = spec.type === 'sine' ? (i ? 'triangle' : 'sine') : spec.type;
      const gain = ctx.createGain(); gain.gain.value = i ? 0.06 : 0.12;
      o.connect(gain); gain.connect(root); o.start();
      return { o, mul, gain };
    });
    return { id: car.id, profile, ok: true, root, panner, oscs, fire: spec.fire };
  }

  _disposeVoice(voice) {
    if (!voice) return;
    try { for (const o of voice.oscs || []) o.o.stop(); } catch (e) { /* 已停止 */ }
    try { voice.root && voice.root.disconnect(); } catch (e) { /* ignore */ }
    voice.ok = false;
  }

  _updateVoice(voice, car) {
    const t = this.ctx.currentTime;
    const kmh = this._num(car.speedKmhMeasured, this._num(car.speedKmh, 0));
    const rpm = this._num(car.rpm, CFG.IDLE_RPM);
    const f0 = (rpm / 60) * voice.fire;
    for (const h of voice.oscs) h.o.frequency.setTargetAtTime(f0 * h.mul, t, 0.045);
    const gain = clamp(0.035 + kmh / 900, 0.035, 0.18);
    for (const h of voice.oscs) h.gain.gain.setTargetAtTime(gain * (h.mul === 1 ? 1 : 0.5), t, 0.08);
    const p = car.pos || { x: 0, y: 0, z: 0 };
    voice.panner.positionX.setTargetAtTime(this._num(p.x, 0), t, 0.04);
    voice.panner.positionY.setTargetAtTime(this._num(p.y, 0), t, 0.04);
    voice.panner.positionZ.setTargetAtTime(this._num(p.z, 0), t, 0.04);
  }

  updateScene(cars, viewCamera, localCar, active = true) {
    if (!active) {
      this.disposeVoices();
      if (this.ok && this.n) this.n.master.gain.value = 0;
      return;
    }
    this.init();
    if (!this.ok) return;
    const ctx = this.ctx;
    this.n.master.gain.setTargetAtTime(this.on ? 0.5 * this.vol : 0, ctx.currentTime, 0.08);
    const lp = viewCamera && viewCamera.position ? viewCamera.position : { x: 0, y: 0, z: 0 };
    const listener = ctx.listener;
    if (listener && listener.positionX) {
      listener.positionX.setTargetAtTime(this._num(lp.x, 0), ctx.currentTime, 0.04);
      listener.positionY.setTargetAtTime(this._num(lp.y, 0), ctx.currentTime, 0.04);
      listener.positionZ.setTargetAtTime(this._num(lp.z, 0), ctx.currentTime, 0.04);
      const d = new THREE.Vector3(0, 0, 1);
      if (viewCamera && viewCamera.getWorldDirection) viewCamera.getWorldDirection(d);
      for (const [k, v] of [['forwardX', d.x], ['forwardY', d.y], ['forwardZ', d.z]]) {
        if (listener[k]) listener[k].setTargetAtTime(this._num(v, 0), ctx.currentTime, 0.04);
      }
    }
    const activeCars = (Array.isArray(cars) ? cars : []).filter((car) => {
      if (!car || car === localCar || (localCar && car.id === localCar.id)) return false;
      const p = car.pos || { x: 0, y: 0, z: 0 };
      return Math.hypot(this._num(p.x, 0) - this._num(lp.x, 0), this._num(p.z, 0) - this._num(lp.z, 0)) <= 160;
    }).sort((a, b) => {
      const pa = a.pos || {}, pb = b.pos || {};
      return Math.hypot((pa.x || 0) - lp.x, (pa.z || 0) - lp.z) - Math.hypot((pb.x || 0) - lp.x, (pb.z || 0) - lp.z);
    }).slice(0, 8);
    const keep = new Set(activeCars.map((car) => car.id));
    for (const [id, voice] of this.voices) {
      if (!keep.has(id)) { this._disposeVoice(voice); this.voices.delete(id); }
    }
    for (const car of activeCars) {
      const profile = ['i6gt', 'v8', 'v12', 'fe'].includes(car.engineProfile) ? car.engineProfile : 'i6gt';
      let voice = this.voices.get(car.id);
      if (!voice || voice.profile !== profile) {
        if (voice) this._disposeVoice(voice);
        voice = this._createVoice(car, profile);
        this.voices.set(car.id, voice);
      }
      this._updateVoice(voice, car);
    }
  }

  update(car) {
    if (!this.ok || !car) return;
    const t = this.ctx.currentTime;
    const kmh = car.speedKmhMeasured !== undefined ? car.speedKmhMeasured : car.speedKmh;
    const rpm = car.rpm || CFG.IDLE_RPM;
    const thr = car.finished ? 0.15 : (car.input ? car.input.throttle : 0);
    const frac = clamp((rpm - CFG.IDLE_RPM) / Math.max(CFG.REDLINE_RPM - CFG.IDLE_RPM, 1), 0, 1);
    const load = clamp(0.16 + 0.62 * thr + 0.22 * frac, 0, 1);
    const pf = (this._prof && this._prof.lp) || 1;
    const airK = (this._prof && this._prof.air !== undefined) ? this._prof.air : 1;
    if (this._workletReady && this._workletNode) {
      // ---- 波导物理引擎路径（piston 档位）----
      // throttle/rpm 走 AudioParam（a-rate），模型内部按曲柄角逐样本推进；
      // 载荷塑形沿用原链：engMix 载荷开合 + engLP 随转速/油门开合的低通。
      this._workletNode.parameters.get('rpm').setTargetAtTime(rpm, t, 0.03);
      this._workletNode.parameters.get('throttle').setTargetAtTime(clamp(thr, 0, 1), t, 0.05);
      this.n.engMix.gain.setTargetAtTime(load * 0.34, t, 0.05);
      this.n.engLP.frequency.setTargetAtTime((320 + frac * 2400 + thr * 1500) * pf, t, 0.05);
      this.n.engAirBP.frequency.setTargetAtTime(380 + frac * 1500, t, 0.08);
      this.n.engAirG.gain.setTargetAtTime((0.012 + thr * 0.05 * (0.4 + frac)) * airK, t, 0.08);
    } else if (this.n.oscs) {
      // ---- 谐波振荡器路径（fe 电驱 / worklet 降级）----
      const f0 = (rpm / 60) * ((this._prof && this._prof.fire) || 3);
      for (const h of this.n.oscs) h.o.frequency.setTargetAtTime(f0 * h.mul, t, 0.028);
      this.n.sub.frequency.setTargetAtTime(f0 * 0.5, t, 0.03);
      this.n.engMix.gain.setTargetAtTime(load * 0.34, t, 0.05);
      this.n.engLP.frequency.setTargetAtTime((320 + frac * 2400 + thr * 1500) * pf, t, 0.05);
      this.n.engAirBP.frequency.setTargetAtTime(380 + frac * 1500, t, 0.08);
      this.n.engAirG.gain.setTargetAtTime((0.012 + thr * 0.05 * (0.4 + frac)) * airK, t, 0.08);
    }

    const slipDeg = car.slipAngleDeg || 0;
    const latAmt = clamp((slipDeg - 6) / 22, 0, 1) * clamp(kmh / 35, 0, 1);
    this.n.latG.gain.setTargetAtTime(latAmt * 0.16, t, 0.06);
    this.n.latBP.frequency.setTargetAtTime(900 + clamp(kmh, 0, 200) * 4.2, t, 0.08);
    const lonAmt = Math.max(clamp((car.slipRatio || 0) * 1.4, 0, 1),
      clamp(car.wheelspin || 0, 0, 1),
      (car.input && car.input.brake > 0.6 && kmh > 25) ? 0.7 : 0);
    this.n.lonG.gain.setTargetAtTime(lonAmt * 0.14, t, 0.05);
    this.n.lonBP.frequency.setTargetAtTime(520 + clamp(kmh, 0, 200) * 3.0, t, 0.08);

    const speed01 = clamp(kmh / 90, 0, 1);
    const curbN4 = ((car.curbWheels || 0) / 4) * clamp(kmh / 25, 0, 1);
    this._curbPhase = (this._curbPhase || 0) + (kmh / 3.6) / 0.6 / 60;
    const rumble = 0.6 + 0.4 * Math.abs(Math.sin(Math.PI * this._curbPhase));
    this.n.curbG.gain.setTargetAtTime(curbN4 * 0.30 * rumble, t, 0.02);
    this.n.curbBP.frequency.setTargetAtTime(70 + clamp(kmh / 3.6, 0, 60) * 1.6, t, 0.05);
    const grassN4 = ((car.grassWheels || 0) / 4) * clamp(kmh / 30, 0, 1);
    this.n.grassG.gain.setTargetAtTime(grassN4 * 0.12, t, 0.06);
    this.n.windG.gain.setTargetAtTime(speed01 * speed01 * 0.05, t, 0.12);
  }
}

const audio = new EngineAudio();

/* ========================================================================== */
/* 2. three.js 场景                                                            */
/* ========================================================================== */

const renderer = new THREE.WebGLRenderer({
  canvas: $('gl'), antialias: true, powerPreference: 'high-performance', stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setClearColor(0x060a12, 1);
// 阴影贴图（规格 §三）：PCF 软阴影。全项目此前根本没开阴影 —— sun 是裸的平行光，
// 所以规格里"阴影在赛道下方深度冲突 / 忽隐忽现"的前提（阴影存在）本来就不成立。
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x14243a, 420, 2100);

const camera = new THREE.PerspectiveCamera(64, window.innerWidth / window.innerHeight, 0.4, 7000);
const chaseCamera = new ForzaChaseCamera(camera);
camera.position.set(0, 90, 340);

// 渐变天空（ShaderMaterial，顶点色计算，无贴图无外部资源）
{
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      cTop: { value: new THREE.Color(0x081428) },
      cMid: { value: new THREE.Color(0x1d3a5c) },
      cBot: { value: new THREE.Color(0x4a4436) },
    },
    vertexShader: `
      varying vec3 vP;
      void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec3 vP;
      uniform vec3 cTop, cMid, cBot;
      vec3 s2l(vec3 c){ return pow(c, vec3(2.2)); }   // sRGB->线性，配合 renderer.outputEncoding
      void main(){
        float h = normalize(vP).y * 0.5 + 0.5;
        vec3 c = mix(s2l(cBot), s2l(cMid), smoothstep(0.44, 0.53, h));
        c = mix(c, s2l(cTop), smoothstep(0.50, 0.92, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4200, 24, 16), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);
}

// 黄昏光照：半球光给天空/地面染色，主平行光负责明暗与立体感，环境光兜底避免死黑
scene.add(new THREE.HemisphereLight(0x9dc0ff, 0x233a18, 1.05));
const sun = new THREE.DirectionalLight(0xffe9c4, 1.15);
// 阴影正交视锥固定 ±35m（规格 §三.2），**每帧跟随玩家车**（见 loop 里的 sunFollow）：
// 视锥不跟随的话，车一开出 35m 范围阴影就整片消失 —— 这正是"忽隐忽现"的成因。
const SUN_OFF = { x: -42, y: 52, z: 30 };     // 相对车的位置，保证光照方向恒定
sun.position.set(-420, 520, 300);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -35;
sun.shadow.camera.right = 35;
sun.shadow.camera.top = 35;
sun.shadow.camera.bottom = -35;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 120;
// bias 消除自阴影摩尔纹（shadow acne）；normalBias 消除掠射面的漏光（peter-panning 反向）
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);
scene.add(new THREE.AmbientLight(0xffffff, 0.34));

/* ========================================================================== */
/* 3. 世界（赛道）                                                             */
/* ========================================================================== */

let track = null;
let trackBuilt = null;
let gantryLights = null;
let currentSeed = -1;
let currentTrackType = 'suzuka';   // 服务端下发的赛道类型；换赛道必须重建世界

/** 赛道类型的展示名（与服务端 sanitizeTrack 的白名单一致）。 */
const TRACK_NAME = {
  suzuka: '铃鹿 · 8 字立体交叉',
  vegas: '拉斯维加斯 · 街道夜赛',
  spa: '斯帕 · 阿登森林',
  oval: '新手 · 极简高速环道',
};

function buildWorld(seed, trackType) {
  seed = (seed >>> 0) || DEFAULT_SEED;
  if (trackBuilt) {
    scene.remove(trackBuilt.group);
    trackBuilt.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.map) o.material.map.dispose();
      if (o.material) o.material.dispose();
    });
  }
  // trackType 必须透传：Track 构造函数会做白名单校验并回落铃鹿。
  // 这里漏传过一次 -> 拉斯维加斯虽然生成了、服务端也下发了，但客户端永远加载不到。
  track = new Track(seed, trackType || currentTrackType);
  trackBuilt = track.build();
  gantryLights = trackBuilt.lights;
  scene.add(trackBuilt.group);
  // 阴影规范（规格 §三.1）：赛道地面只**接收**阴影、不投射（它自己不产生阴影）。
  // 配合下方 track.js 沥青材质的 polygonOffset，消除阴影贴图与路面共面时的深度冲突。
  trackBuilt.group.traverse((o) => {
    if (!o.isMesh) return;
    o.receiveShadow = true;
    o.castShadow = false;
  });
  currentSeed = seed;
  currentTrackType = track.trackType;
  // 换了赛道：旧的胎痕 / 涡线坐标已失效，直接清空
  if (driftFX) {
    driftFX.marks.reset();
    driftFX.emitter.clear();
  }
  return track;
}

/* ========================================================================== */
/* 4. Low-Poly 赛车（全部用基础几何体拼接）                                    */
/* ========================================================================== */

function makeNumberTexture(num, name) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0d1015'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#ffffff'; g.lineWidth = 8; g.strokeRect(12, 12, 232, 232);
  g.fillStyle = '#ffffff';
  g.font = '800 150px system-ui, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(num), 128, 118);
  g.font = '600 34px system-ui, "Microsoft YaHei", Arial, sans-serif';
  g.fillStyle = '#ffd200';
  const short = (name || '').slice(0, 6);
  g.fillText(short, 128, 212);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function buildCarVisual(color, name, num) {
  const group = new THREE.Group();
  const mBody = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.34, metalness: 0.42 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.75, metalness: 0.15 });
  const mGlass = new THREE.MeshStandardMaterial({ color: 0x0a1420, roughness: 0.12, metalness: 0.7, transparent: true, opacity: 0.82 });
  const mTire = new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.95 });

  // 主车体：**上窄下收**的两段式，而不是一整块方盒 —— 关键几何修正。
  // 旧版是一个 1.82 宽 x 0.5 高的大方盒，四个车轮（±0.80，胎宽 0.30，外沿 0.95）
  // 完全落在盒子的侧影之内：从车尾正后方的追尾相机会被车壳整块挡住，
  // 看上去就是"车轮消失了"。改成：
  //   · 上壳（肩线，1.66 宽）只占 y∈[0,0.30]
  //   · 下脊（1.10 宽）只占 y∈[-0.38,-0.04]
  //   · 四个轮拱（深色）贴住轮胎外沿
  // 这样车壳在轮胎高度上是"两侧镂空"的，追尾视角能直接看到后轮的黑色圆弧。
  // Taper the hood/tail and bevel the shoulder instead of a rectangular shell.
  const shellGeo = new THREE.BoxGeometry(1.78, 0.38, 3.96, 4, 2, 8);
  const shellPos = shellGeo.attributes.position;
  for (let i = 0; i < shellPos.count; i++) {
    const z = shellPos.getZ(i), y = shellPos.getY(i), x = shellPos.getX(i);
    const taper = 1 - 0.17 * Math.pow(Math.abs(z)/1.98, 3);
    shellPos.setXYZ(i, x*taper*(y>0 ? 0.96 : 1), y - 0.12*Math.pow(Math.max(0,z)/1.98,2), z);
  }
  shellGeo.computeVertexNormals();
  const shell = new THREE.Mesh(shellGeo, mBody);
  shell.position.set(0, 0.15, 0);
  group.add(shell);

  // 下车脊：把前后轮之间的车身收窄到 1.10m，给车轮让出可见空间
  const spineGeo = new THREE.BoxGeometry(1.10, 0.34, 3.40);
  const spine = new THREE.Mesh(spineGeo, mBody);
  spine.position.set(0, -0.21, 0);
  group.add(spine);

  // 车头下唇
  const lip = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.16, 0.7), mDark);
  lip.position.set(0, -0.24, 1.95);
  group.add(lip);

  // 后端扩散器：略窄，避免从车尾挡住后轮下半部
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.30, 0.5), mDark);
  diffuser.position.set(0, -0.22, -1.86);
  group.add(diffuser);

  // 四个轮拱（深色翼子板）：贴住轮胎外沿，既提供"轮眉"轮廓又不遮住轮胎
  for (const [ax, az] of [[-0.81, 1.35], [0.81, 1.35], [-0.81, -1.35], [0.81, -1.35]]) {
    const arch = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.26, 1.06), mDark);
    arch.position.set(ax, 0.10, az);
    group.add(arch);
  }

  // 座舱
  const cabinGeo = new THREE.BoxGeometry(1.34, 0.5, 1.7);
  const cabinPos = cabinGeo.attributes.position;
  for (let i = 0; i < cabinPos.count; i++) if (cabinPos.getY(i)>0) {
    cabinPos.setX(i,cabinPos.getX(i)*0.78); cabinPos.setZ(i,cabinPos.getZ(i)*0.66);
  }
  cabinGeo.computeVertexNormals();
  const cabin = new THREE.Mesh(cabinGeo, mGlass);
  cabin.position.set(0, 0.56, -0.25);
  group.add(cabin);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.42, 0.35), mGlass);
  glass.position.set(0, 0.60, 0.62);
  glass.rotation.x = -0.42;
  group.add(glass);
  const glass2 = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.36, 0.3), mGlass);
  glass2.position.set(0, 0.60, -1.06);
  glass2.rotation.x = 0.5;
  group.add(glass2);

  // 车顶号码牌（CanvasTexture，纯代码绘制）
  const top = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), new THREE.MeshBasicMaterial({ map: makeNumberTexture(num, name) }));
  top.rotation.x = -Math.PI / 2;
  top.position.set(0, 0.82, -0.25);
  group.add(top);

  // 尾翼
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.09, 0.5), mDark);
  wing.position.set(0, 0.56, -1.90);
  group.add(wing);
  for (const dx of [-0.66, 0.66]) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.42, 0.3), mDark);
    st.position.set(dx, 0.34, -1.88);
    group.add(st);
  }

  // 前照灯 / 尾灯
  const mHead = new THREE.MeshBasicMaterial({ color: 0xfff4d0 });
  const mTail = new THREE.MeshBasicMaterial({ color: 0x5a0a06 });
  const heads = [], tails = [];
  for (const dx of [-0.58, 0.58]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.16, 0.1), mHead);
    h.position.set(dx, 0.20, 1.97);
    group.add(h); heads.push(h);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.16, 0.1), mTail);
    t.position.set(dx, 0.20, -1.98);
    group.add(t); tails.push(t);
  }

  // 车轮：几何体预先绕 Z 旋转 90°，使圆柱轴向 = 车体 X 轴（这样 mesh.rotation.x 就是滚动）
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.30, 24);
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.23, 0.23, 0.32, 20);
  rimGeo.rotateZ(Math.PI / 2);
  const wheels = [];
  const W = CFG.WHEEL;
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Object3D();
    pivot.position.set(W[i][0], -0.26, W[i][1]);
    const tire = new THREE.Mesh(wheelGeo, mTire);
    const rim = new THREE.Mesh(rimGeo, new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.3, metalness: 0.85 }));
    pivot.add(tire, rim);
    const spokes = new THREE.Group();
    for (let j = 0; j < 5; j++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.335,0.035,0.43), mDark);
      spoke.rotation.x = j*Math.PI/5; spokes.add(spoke);
    }
    tire.add(spokes);
    group.add(pivot);
    wheels.push({ pivot, mesh: tire, isFront: W[i][1] > 0, isRight: W[i][0] > 0 });
  }

  // ⚠️ 车底**不再**画圆形接地阴影（用户要求"去掉车下的圆形影子"）：
  //   这张 CircleGeometry 平面贴在车下 -0.615m，与真实阴影贴图叠加后像一块黑饼，
  //   在斜坡/桥面上还会穿出路面。车的 castShadow 仍然开着，由渲染器出真实阴影。
  group.userData = { mBody, mDark, mGlass, mHead, mTail, heads, tails, wheels, color };
  for (const side of [-1,1]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.20,0.12,0.25),mBody);
    mirror.position.set(side*0.90,0.52,0.38); group.add(mirror);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.12,1.7),mDark);
    skirt.position.set(side*0.83,-0.26,0); group.add(skirt);
  }
  // 阴影规范（规格 §三.1）：车与车轮**投射**阴影、不接收阴影。
  // 车身如果 receiveShadow，自阴影会在曲面上出现摩尔纹；车轮同样只投不收。
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
  });
  return group;
}

/**
 * 幽灵化视觉：整台车的材质透明度 1 -> GHOST_OPACITY（0.35）。
 * 需要动态开启 transparent，并记录材质基准值以便完全恢复。
 */
function applyGhost(root, amt, targetOp = CFG.GHOST_OPACITY, keepDepth = false) {
  const ghosting = amt > 0.001;
  const op = 1 - (1 - targetOp) * amt;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.userData._baseOp === undefined) {
        m.userData._baseOp = m.opacity;
        m.userData._baseTrans = m.transparent;
        m.userData._baseDepth = m.depthWrite;
      }
      m.opacity = m.userData._baseOp * op;
      const wantTrans = ghosting || m.userData._baseTrans;
      if (m.transparent !== wantTrans) { m.transparent = wantTrans; m.needsUpdate = true; }
      // keepDepth = true：幽灵**车模式**的半透明必须保留深度写入，否则互相穿透时
      // 会出现车体前后片乱序的渲染撕裂（R 键那 3.5s 的临时幽灵才关 depthWrite）。
      m.depthWrite = (ghosting && !keepDepth) ? false : m.userData._baseDepth;
    }
  });
}

/* ========================================================================== */
/* 5. 离线 GLB 模型装载（自带极简 glTF 解析，不依赖 GLTFLoader/网络）           */
/* ========================================================================== */

const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function readAccessor(gltf, bin, index, asFloat) {
  const acc = gltf.accessors[index];
  if (!acc || acc.bufferView == null) return null;
  const bv = gltf.bufferViews[acc.bufferView];
  const cs = COMP_SIZE[acc.componentType] || 4;
  const tc = TYPE_COUNT[acc.type] || 1;
  const stride = bv.byteStride || cs * tc;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset + base, Math.min(bin.byteLength - base, stride * acc.count));
  const out = new Float32Array(acc.count * tc);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < tc; c++) {
      const o = i * stride + c * cs;
      let v = 0;
      switch (acc.componentType) {
        case 5126: v = dv.getFloat32(o, true); break;
        case 5125: v = dv.getUint32(o, true); break;
        case 5123: v = dv.getUint16(o, true); break;
        case 5122: v = dv.getInt16(o, true); break;
        case 5121: v = dv.getUint8(o); break;
        case 5120: v = dv.getInt8(o); break;
        default: v = 0;
      }
      out[i * tc + c] = v;
    }
  }
  return out;
}

function buildGltfMesh(gltf, bin, meshIdx) {
  const mesh = gltf.meshes[meshIdx];
  if (!mesh || !mesh.primitives) return null;
  const holder = new THREE.Group();
  for (const prim of mesh.primitives) {
    if (prim.mode !== undefined && prim.mode !== 4) continue;   // 只取三角形
    const posArr = readAccessor(gltf, bin, prim.attributes.POSITION);
    if (!posArr) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    const nrmArr = readAccessor(gltf, bin, prim.attributes.NORMAL);
    if (nrmArr) geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrmArr, 3));
    if (prim.indices != null) {
      const idxArr = readAccessor(gltf, bin, prim.indices);
      const n = gltf.accessors[prim.indices].count;
      const out = new Uint32Array(n);
      for (let i = 0; i < n; i++) out[i] = idxArr[i];
      geo.setIndex(new THREE.BufferAttribute(out, 1));
    }
    if (!nrmArr) geo.computeVertexNormals();
    let col = 0xb9c0c8, metal = 0.4, rough = 0.45;
    if (prim.material != null && gltf.materials && gltf.materials[prim.material]) {
      const m = gltf.materials[prim.material].pbrMetallicRoughness || {};
      if (m.baseColorFactor) {
        col = new THREE.Color(m.baseColorFactor[0], m.baseColorFactor[1], m.baseColorFactor[2]).getHex();
      }
      if (m.metallicFactor != null) metal = m.metallicFactor;
      if (m.roughnessFactor != null) rough = m.roughnessFactor;
    }
    holder.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, metalness: metal, roughness: rough })));
  }
  return holder;
}

function buildGltfNodes(gltf, bin, idx) {
  const n = gltf.nodes[idx];
  const obj = new THREE.Group();
  if (n.matrix) {
    obj.matrix.fromArray(n.matrix);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
  } else {
    if (n.translation) obj.position.fromArray(n.translation);
    if (n.rotation) obj.quaternion.fromArray(n.rotation);
    if (n.scale) obj.scale.fromArray(n.scale);
  }
  if (n.mesh != null) {
    const m = buildGltfMesh(gltf, bin, n.mesh);
    if (m) obj.add(m);
  }
  if (n.children) for (const c of n.children) obj.add(buildGltfNodes(gltf, bin, c));
  return obj;
}

/** 解析 .glb（二进制 glTF 2.0）。贴图/动画忽略，只取静态网格与 PBR 基础色。 */
function parseGLB(ab) {
  const dv = new DataView(ab);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是合法的 GLB 文件');
  const total = dv.getUint32(8, true);
  let off = 12, json = null, bin = null;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, start, len)));
    } else if (type === 0x004e4942) {
      bin = new Uint8Array(ab, start, len);
    }
    off = start + len;
  }
  if (!json || !bin) throw new Error('GLB 缺少 JSON 或 BIN 数据块');
  const sceneIdx = json.scene || 0;
  const sceneDef = (json.scenes && json.scenes[sceneIdx]) || { nodes: [] };
  const root = new THREE.Group();
  for (const ni of (sceneDef.nodes || [])) root.add(buildGltfNodes(json, bin, ni));

  // 归一化：车长对齐 4.6m，水平居中，车轮底部对齐接地平面 (-0.62)
  let box = new THREE.Box3().setFromObject(root);
  let size = box.getSize(new THREE.Vector3());
  const len = Math.max(size.z, size.x, 1e-3);
  const k = 4.6 / len;
  root.scale.setScalar(k);
  box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.position.x -= c.x;
  root.position.z -= c.z;
  root.position.y += (-0.62 - box.min.y);
  const wrap = new THREE.Group();
  wrap.add(root);
  return wrap;
}

let customModel = null;

/** 切换低模/自定义模型的可见性（车底阴影始终保留） */
function applyCustomModel(model) {
  customModel = model || null;
  for (const vis of carVisuals.values()) {
    const ud = vis.userData;

    if (customModel) {
      if (!ud.custom) {
        ud.custom = customModel.clone(true);
        vis.add(ud.custom);
      }
      ud.custom.visible = true;
      ud.custom.traverse((o) => { o.visible = true; });
    } else if (ud.custom) {
      ud.custom.visible = false;
    }
    for (const o of vis.children) {
      if (o === ud.custom) continue;
      // 自定义车模时隐藏全部内置部件（车底圆形阴影已在 2026-09-30 移除，
      // 不再需要按 CircleGeometry 单独豁免 —— 那段豁免逻辑一并删掉）。
      o.visible = !customModel;
    }
  }
}

/** 对外接口：window.loadCustomCarModel(urlOrFileBlobUrl)；传 null 恢复低模 */
window.loadCustomCarModel = function (glbUrl) {
  if (!glbUrl) { applyCustomModel(null); return Promise.resolve('已恢复默认低模赛车'); }
  return fetch(glbUrl)
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
    .then((ab) => {
      const model = parseGLB(ab);
      applyCustomModel(model);
      showToast('已装载自定义车模：' + (model.children.length ? 'OK' : '空模型'));
      return '自定义车模装载成功';
    })
    .catch((e) => {
      showToast('车模装载失败：' + e.message);
      throw e;
    });
};

// 拖拽本地 .glb 直接替换外观（离线可用，走 blob: 本地对象 URL）
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (!/\.glb$/i.test(f.name)) { showToast('只支持 .glb 文件（glTF 2.0 二进制）'); return; }
  const url = URL.createObjectURL(f);
  window.loadCustomCarModel(url).finally(() => setTimeout(() => URL.revokeObjectURL(url), 4000));
});

/* ========================================================================== */
/* 6. 全局状态                                                                 */
/* ========================================================================== */

const S = {
  mode: 'boot',            // boot | menu | room | race | end
  offline: false,
  net: null,
  rp: null,
  localId: 0,
  hostId: 0,
  laps: 3,
  roster: [],              // [{id,name,color,ai}]
  raceStartAt: 0,          // 统一（服务端）时钟毫秒
  simOffset: 0,             // slewed server-clock offset; never used by physics
  raceClock: 0,
  localCar: null,
  results: null,
  spectateId: 0,
  dnfLeft: 0,              // DNF 宽限倒计时剩余秒数（首位冲线后由服务端下发）
  camMode: 0,              // 0 追尾(默认) / 1 引擎盖 / 2 垂直鸟瞰
  gameMode: 'fm8',         // horizon = 轻松驾驶；fm8 = 严格规则
  orbitYaw: 0,
  orbitPitch: 0,
  orbitYawTarget: 0,
  orbitPitchTarget: 0,
  penalties: {},
  ready: false,
  color: CAR_COLORS[0],
  warnings: {},
  names: {},
  demoDrift: false,        // ?drift=1 自动化漂移演示（截图验收用）
  demoRescue: false,       // ?rescue=1 救援复位演示（横幅截图验收用）
  demoDraft: false,        // ?draft=1 尾流涡线常亮演示（截图验收用）
  chatTyping: false,       // 局内聊天输入框激活中（规格 §三：激活时切断驾驶操控）
  localName: '',           // 本地玩家昵称（聊天自标识用）
  // ── 规格 §一：服务端权威倒计时状态机（客户端绝不自行计时）──
  controlsLocked: true,    // 起跑前锁死操控（= !S.rp.racing 的显式镜像，供 UI/守卫断言）
  startSeqSeen: false,     // 是否收到过 START_SEQUENCE_BEGIN
  raceStartSeen: false,    // 是否收到过 RACE_START（权威放行信号）
  _goFallback: null,       // 4.5s 本地兜底定时器句柄
  _lightHideTimer: null,   // 绿灯层隐藏句柄（复位时必须取消，防旧比赛误隐藏新比赛）
  _settlementTimer: null,  // RACE_RESULTS 延迟弹出句柄（防跨场次串台）
  _offlineDnfTimer: null,  // 单机模式首车冲线后的 60s 强制结算句柄
  _offlineSettled: false,  // 单机结算只允许完成一次
  _startTimers: [],        // 单机倒计时的全部定时器，换场时统一取消
  seasonRankings: null,    // 最近一次赛季榜快照（SEASON_LEADERBOARD_UPDATE）
  presence: null,          // 服务端全局大厅在线快照
  settlement: null,        // 最近一次结算数据（RACE_RESULTS），供 Modal 渲染
};

const carVisuals = new Map();   // id -> THREE.Group
const driveControls = new DrivingControls({ changed: () => { if (S.localCar) sampleLocalInput(S.localCar, 0); }, notify: text => showToast(text) });

/* ========================================================================== */
/* 7. 输入                                                                     */
/* ========================================================================== */

const keys = Object.create(null);
const pressed = (c) => !!keys[c];

// 空格键专门用独立状态位记录：不同浏览器/输入法下 e.key 可能是 ' ' 或 'Spacebar'，
// 统一用 e.code === 'Space' 兜底，避免"手刹失灵"。
let handbrakeKey = false;
const isSpaceKey = (e) => e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar' || e.key === 'Space';
const isArrowKey = (e) => e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight';

window.addEventListener('keydown', (e) => {
  const tgt = e.target;
  const inField = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable);

  // ---- 聊天输入激活中：窗口级驾驶按键**全部旁路**（规格 §三.2）----
  // 只要焦点在任意输入框内，就不再把按键送进驾驶状态机。
  // 否则打字时按 W/A/S/D 会被记录成油门/转向，即使输入框吃掉了字符，
  // 赛车也会在输入框背后"自己动"。这里直接 return，什么都不做。
  if (inField || S.chatTyping) {
    audio.init(); audio.resume();
    return;
  }

  // 空格/方向键必须阻断默认行为，否则会触发页面滚动、按钮"再触发"、焦点跳转，
  // 表现出来就是"按了空格没反应"或"手刹一顿一顿的"。
  if (isSpaceKey(e) || isArrowKey(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (isSpaceKey(e)) handbrakeKey = true;

  if (e.repeat) return;

  keys[e.key.toLowerCase()] = true;
  if (S.localCar) sampleLocalInput(S.localCar, 0);
  audio.init(); audio.resume();

  const k = e.key.toLowerCase();

  // ---- 聊天呼出（规格 §二.3 / §三.2）----
  // 大厅：Enter 聚焦大厅聊天输入框；
  // 局内：Enter 或 T 呼出快捷打字条（呼出后由该输入框自行接管 Enter/Esc）。
  if (e.key === 'Enter') {
    if (S.mode === 'room') { focusLobbyChat(); return; }
    if (S.mode === 'race' || S.mode === 'end') { openHudChat(); return; }
  }
  if (k === 't' && (S.mode === 'race' || S.mode === 'end')) {
    openHudChat();
    return;
  }
  // 多视角循环：C 或 V（规格）
  if (k === 'c' || k === 'v') {
    S.camMode = (S.camMode + 1) % CAM.CAM_COUNT;
    showToast(['第三人称追尾视角', '引擎盖视角', '垂直鸟瞰视角'][S.camMode]);
  }
  // 最佳走线显示开关
  if (k === 'l') {
    if (track && track.raceLine) {
      track.raceLine.active = !track.raceLine.active;
      track.raceLine.mesh.visible = track.raceLine.active;
      showToast(track.raceLine.active ? '最佳走线：开' : '最佳走线：关');
    }
  }
  if (k === 'm') showToast(audio.toggle() ? '音效：开' : '音效：关');
  // R 键：赛事救援复位（规格）
  // 瞬移回赛道 -> 罚时 +3.0s -> 3.5s 半透明幽灵化（已无定身冻结）
  //
  // 【为什么之前完全按不动】这里残留着 `S.localCar.freezeTimer <= 0`，
  // 而 freezeTimer 在第七轮就随"定身冻结"一起删掉了 —— `undefined <= 0` 恒为 false，
  // 于是整个分支永远不进。上一轮只修了 `?rescue=1` 那条演示入口，漏了真正的按键路径。
  // 现在只判幽灵化计时器（幽灵期间不重复复位，避免连按刷罚时）。
  // 同时用 e.code 兜底：某些输入法/键盘布局下 e.key 拿不到 'r'，但 KeyR 永远稳定。
  if ((k === 'r' || e.code === 'KeyR') && S.localCar && !S.localCar.finished &&
      S.mode === 'race' && S.rp) {
    if ((S.localCar.ghostTimer || 0) <= 0) {
      S.rp.rescueToCheckpoint(S.localCar);
      if (!S.offline && S.net) { /* 罚时由 physics 的 onPenalty 自动上报 */ }
    }
  }
  if (S.mode === 'end' || (S.localCar && S.localCar.finished)) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      cycleSpectate(e.key === 'ArrowRight' ? 1 : -1);
    }
  }
});
window.addEventListener('keyup', (e) => {
  if (isSpaceKey(e)) handbrakeKey = false;
  keys[e.key.toLowerCase()] = false;
  // 聊天输入期间输入框会吞掉 keyup ⇒ 这里强制清位，杜绝"打完字车还在往前冲"。
  if (S.chatTyping) releaseDriveKeys();
  if (S.localCar) sampleLocalInput(S.localCar, 0);
});
window.addEventListener('blur', () => {
  handbrakeKey = false;
  for (const k in keys) keys[k] = false;
  if (S.localCar) sampleLocalInput(S.localCar, 0);
});

function sampleLocalInput(car, dt) {
  const inp = car.input;
  const flush = () => { if (S.rp && car && S.rp.sendInput) S.rp.sendInput(car, performance.now()); };
  // ⚠️ **发车锁必须是 `!S.rp.racing`，绝不能写成 `S.raceClock < 0`。**
  // 原因：S.raceClock 是用「发车时刻 raceStartAt（服务端墙钟）」减去本地
  // `Date.now() + simOffset` 得到的，而 `net.on('start')` 是在服务端下发 start
  // 报文那一刻才把这一帧写进 `Date.now() + 2600`。两者之间的差值**恒为约 −2600ms**：
  //   offline: startAt = Date.now()+2600，而 S.raceClock 从下一帧就算起
  //   online : 服务端 startAt = now+700，报文再经网络到达客户端
  // 于是 `S.raceClock < 0` 在整个倒计时里都成立 —— 这是一道**永久输入锁**：
  // 倒计时结束、GO 亮起、车能开动之后，只要 raceClock 仍为负（它确实一直为负），
  // 油门就被这里清零，锅踩到底车也不动。
  // S.rp.racing 才是唯一正确的发车判据：它由 `(S.mode==='race'||'end') && S.raceClock >= 0`
  // 推出，并在 main.js 的时钟段里随比赛状态更新（见 updateRaceClock 附近）。
  // 规格 §三.2：聊天输入框激活时**彻底切断**对赛车的操控。
  // 这一条必须放在所有其它判据之前 —— 打字时按到的 W/A/S/D 会被输入框消费，
  // 若不清零意图，赛车会在你打字时继续执行上一次的油门/转向，直接冲出赛道。
  if (S.chatTyping) {
    inp.throttle = 0; inp.brake = 0; inp.handbrake = 0; inp.steer = 0;
    flush();
    return;
  }
  // 规格 §一：controlsLocked 是服务端权威倒计时的显式操控锁（起跑前 true）。
  // 与 `!S.rp.racing` 双保险：即使 raceClock 因网络抖动提前到点，只要没收到
  // RACE_START（或未到 4.5s 兜底）就绝不放行。
  if (!car || car.finished || !S.rp || !S.rp.racing || car.raceLocked || S.controlsLocked) {
    // 交给 physics 的转向状态机去回正（0.15s），这里只把意图清零。
    // car.raceLocked 由阶段二起步灯控（showStartLights）在红灯期间置位，
    // 绿灯放行（stage 6）时清零 —— 双重保险，即使 raceClock 因网络抖动提前到点，
    // 也必须等绿灯报文才放行。
    inp.throttle = 0; inp.brake = 0; inp.handbrake = 0; inp.steer = 0;
    flush();
    return;
  }
  const device = typeof driveControls !== 'undefined' ? driveControls.sample() : {};
  const up = pressed('w') || pressed('arrowup');
  const down = pressed('s') || pressed('arrowdown');
  const left = pressed('a') || pressed('arrowleft');
  const right = pressed('d') || pressed('arrowright');
  inp.throttle = up ? 1 : (device.throttle || 0);
  inp.brake = down ? 1 : (device.brake || 0);
  // 手刹：独立状态位，绕开浏览器 key 差异
  inp.handbrake = handbrakeKey ? 1 : (device.handbrake || 0);
  // 意图直接给 physics：steer>0 = 向右。
  // 打方向/回正的双速率插值由 physics.updateSteer 负责（0.12s 打满 / 0.15s 回正），
  // 这里再插值一次会叠加成"转向迟钝"。
  inp.steer = left || right ? (right ? 1 : 0) - (left ? 1 : 0) : (device.steer || 0);
  flush();
}

/* ========================================================================== */
/* 8. 比赛状态机                                                               */
/* ========================================================================== */

function clearRace() {
  clearPenaltyEvents();
  if (S.rp) S.rp.clear();
  for (const [, vis] of carVisuals) {
    scene.remove(vis);
    const custom = vis.userData.custom;
    vis.traverse((o) => {
      if (!o.geometry && !o.material) return;
      // 自定义车模是 clone 出来的，几何体/材质与模板共享，不能在这里释放
      if (custom && isInSubtree(o, custom)) return;
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();   // 车顶号码牌 CanvasTexture
        o.material.dispose();
      }
    });
  }
  carVisuals.clear();
  // 注意：不清空 customModel —— 用户拖入的自定义车模应跨局继续生效
}

function isInSubtree(node, root) {
  let p = node;
  while (p) { if (p === root) return true; p = p.parent; }
  return false;
}

/** 创建一台车（物理 + 视觉） */
function spawnCar(def, isLocalCar, isAI, assignedGridSlot) {
  const id = def.id;
  const slot = Math.max(1, assignedGridSlot | 0 || id);
  const g = track.gridSlot(slot);
  const car = S.rp.addCar({
    id: id,
    name: def.name,
    color: def.color,
    isLocal: isLocalCar,
    remote: !isLocalCar && (!isAI || (!S.offline && S.hostId !== S.localId)),
    ai: !!isAI,
    engine: def.engine || def.engineProfile || 'i6gt',
    startIndex: g.index,
    lateral: g.lateral,
    laps: S.laps,
  });
  car.auto = !!isAI && !car.remote;
  // ★ 立即把镜像与视觉就位到发车格 —— 这是"开始比赛时瞬移到赛道上"的根因修复。
  // Worker 的第一帧状态要等到预热（纹理上传 + shader 编译，实测约 2s）之后才回来，
  // 在这之前主线程镜像的 pos 一直是 (0,0,0)、视觉车也停在原点；而 beginRace 里的
  // snapCameraToCar 已经按原点把相机吸附了。等首帧状态到达时，视觉车与世界坐标
  // 一起"瞬移"到 665m 外的发车格，用户看到的就是那一下跳。
  // 这里用与 Worker 完全相同的 track.spawn(startIndex, lateral) 预算出格子位姿，
  // 直接写进镜像与视觉网格，于是从第一帧起车就在赛道上、相机也吸附在它后面。
  const gridPose = track.spawn(g.index, g.lateral);
  if (gridPose && gridPose.position) {
    car.pos.copy(gridPose.position); car.prevPos.copy(gridPose.position);
    if (gridPose.quaternion) { car.quat.copy(gridPose.quaternion); car.prevQuat.copy(gridPose.quaternion); }
    car.body.position = car.pos; car.body.quaternion = car.quat;
    const vis = buildCarVisual(def.color, def.name, id);
    vis.position.copy(car.pos);
    vis.quaternion.copy(car.quat);
    scene.add(vis);
    carVisuals.set(id, vis);
    return car;
  }
  const vis = buildCarVisual(def.color, def.name, id);
  scene.add(vis);
  carVisuals.set(id, vis);
  return car;
}

function beginRace(opts) {
  clearRaceFlowTimers();
  const seed = opts.seed >>> 0;
  const type = opts.track || currentTrackType;
  // 种子或赛道类型任一变化都必须重建世界：只比种子会漏掉"同种子换赛道"的情况
  if ((seed && seed !== currentSeed) || type !== currentTrackType) {
    buildWorld(seed || (currentSeed > 0 ? currentSeed : DEFAULT_SEED), type);
  }
  clearRace();

  S.laps = opts.laps || 3;
  S.roster = opts.roster;
  S.localId = opts.localId;
  S.raceStartAt = opts.startAt;      // 统一时钟毫秒
  S.simOffset = (S.offline || !S.net) ? 0 : finiteNum(S.net.clockOffset, 0);
  S.results = null;
  S.settlement = null;
  S._offlineSettled = false;
  S.penalties = {};
  S.lb = null;                       // 服务端权威榜单（20Hz LEADERBOARD_UPDATE 填充）
  S.fuel = 1;                        // HUD 油量条（纯观感）
  S.mode = 'race';
  // 驾驶规则三态，必须与 main.go sanitizeGameMode 逐项一致（漏掉 bumper 会让
  // 房主切到碰碰车后，前端仍按 fm8 走拟真规则 —— 幽灵化/罚时全部照旧）。
  S.gameMode = opts.gameMode === 'horizon' ? 'horizon' : opts.gameMode === 'bumper' ? 'bumper' : 'fm8';
  S.spectateId = 0;
  S.dnfLeft = 0;
  S.rp = new PhysicsWorkerBridge({
    track, seed, trackType: type, localId: opts.localId, hostId: S.offline ? opts.localId : S.hostId, grid: opts.grid, roster: opts.roster,
    laps: S.laps, ghost: !!opts.ghost, gameMode: S.gameMode,
  });
  if (S.net && S.net.attachWorker) S.net.attachWorker(S.offline ? null : S.rp);
  // 全员幽灵车模式（规格 §二）：必须在任何 addCar 之前/之后立刻设置。
  // 默认关（保留上一轮的贴身肉搏碰撞）；大厅可切、URL 可覆盖。
  S.ghost = !!opts.ghost;
  S.rp.setGhostMode(S.ghost);
  S.rp.setGameMode(S.gameMode);
  setPenaltyMode(S.gameMode);
  S.rp.on('penalty', ({ car, seconds, reason }) => {
    if (!car) return;
    if (car.isLocal) {
      S.penalties[reason] = (S.penalties[reason] || 0) + seconds;
      if (!S.offline && S.net) S.net.send({ t: 'pen', sec: seconds, reason });
      showPenaltyEvent(reason, seconds, reason, S.gameMode);
    } else if (car.ai && !car.remote && !S.offline && S.net) {
      // 主机模拟的 AI 车手：罚时随事件上报（服务端按 botTarget 记账），
      // 但不进本机 HUD/罚时表 —— 那是本地玩家自己的数据。
      S.net.send({ t: 'pen', id: car.id, sec: seconds, reason });
    }
  });
  S.rp.on('incident', ({ car, info }) => {
    if (!car || !car.isLocal) return;
    const reason = String((info && (info.reason || info.cause)) || 'incident');
    showPenaltyEvent(reason, finiteNum(info && (info.seconds || info.sec)), info && info.kind, S.gameMode);
  });
  S.rp.on('lap', ({ car, lap, time, dirty }) => {
    if (!S.offline && car && !car.remote && (car.isLocal || car.ai) && S.net) {
      S.net.send({ t: 'lap', id: car.ai ? car.id : undefined, n: lap, time, dirty });
    }
  });
  S.rp.on('finish', ({ car }) => {
    if (!car) return;
    if (!S.offline && car && !car.remote && (car.isLocal || car.ai) && S.net) {
      S.net.send({ t: 'finish', id: car.ai ? car.id : undefined });
    } else if (S.offline) queueOfflineFinish(car);
  });
  S.rp.on('alert', ({ text, kind }) => setAlert(text, kind));
  // 碰碰车模式下车与车一直在撞，逐次弹"顶车加速"会刷屏 ⇒ 该模式静默。
  S.rp.on('bump', () => { if (S.gameMode === 'fm8') showToast('顶车加速 · BUMP DRAFT'); });
  S.rp.on('error', (e) => fatal('物理 Worker 启动失败', e.message || String(e)));
  S.rp.racing = false;

  for (const d of opts.roster) {
    const assigned = opts.grid ? opts.grid[String(d.id)] : d.id;
    const car = spawnCar(d, d.id === opts.localId, !!d.ai, assigned);
    if (car.isLocal) S.localCar = car;
  }
  // 阶段二起步锁定：新一场开始时全员锁死，等 lights stage 1..5 亮红灯、stage 6 绿灯放行。
  // 这样即使 raceClock 因网络抖动提前到点，也不会抢跑。
  for (const [, c] of S.rp.byId) c.raceLocked = true;
  // 规格 §一：进入比赛即进入锁定态（权威倒计时未到 RACE_START 前绝不放行）。
  S.controlsLocked = true;
  S.startSeqSeen = false;
  S.raceStartSeen = false;
  if (customModel) applyCustomModel(customModel);
  snapCameraToCar(S.localCar);
  $('lobby').classList.add('hidden');
  $('results').classList.add('hidden');
  hideSettlement();
  $('hud').classList.remove('hidden');
  $('lapTotal').textContent = S.laps;
  for (const [, vis] of carVisuals) vis.visible = true;

  resetHUD();
  S._racePrewarmDone = false;
  S.rp.start();
  const bridge = S.rp;
  S.raceReadyPromise = prewarmRace(bridge).catch((e) => {
    if (S.rp === bridge && !bridge.disposed) fatal('比赛预热失败', e.message || String(e));
    return false;
  });
}

async function prewarmRace(bridge) {
  const current = () => S.rp === bridge && !bridge.disposed;
  const yieldFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  await yieldFrame();
  if (!current()) return false;
  audio.init(); audio.resume();
  await bridge.prewarm();
  if (!current()) return false;
  // 分批上传已加载的纹理，把首次 GPU 分配提前到红灯之前。
  const textures = new Set();
  scene.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) if (value && value.isTexture) textures.add(value);
    }
  });
  let uploaded = 0;
  for (const texture of textures) {
    if (!current()) return false;
    if (typeof renderer.initTexture === 'function') renderer.initTexture(texture);
    if (++uploaded % 4 === 0) await yieldFrame();
  }
  if (!current()) return false;
  if (typeof renderer.compileAsync === 'function') await renderer.compileAsync(scene, camera);
  else renderer.compile(scene, camera);
  await yieldFrame();
  if (!current()) return false;
  S._racePrewarmDone = true;
  return true;
}

function clearRaceFlowTimers() {
  if (S._settlementTimer) { clearTimeout(S._settlementTimer); S._settlementTimer = null; }
  if (S._offlineDnfTimer) { clearTimeout(S._offlineDnfTimer); S._offlineDnfTimer = null; }
  if (S._lightHideTimer) { clearTimeout(S._lightHideTimer); S._lightHideTimer = null; }
  if (S._startTimers && S._startTimers.length) {
    for (const id of S._startTimers) clearTimeout(id);
    S._startTimers.length = 0;
  }
}

function scheduleStartTimer(fn, ms) {
  const id = setTimeout(() => {
    S._startTimers = (S._startTimers || []).filter((x) => x !== id);
    fn();
  }, ms);
  if (!S._startTimers) S._startTimers = [];
  S._startTimers.push(id);
  return id;
}

function queueOfflineFinish(car) {
  if (!S.offline || !S.rp) return;
  // ★ 已经结算过一次（多半是被 DNF 宽限**强制**结算的）之后又有车冲线：
  //   必须**重算并刷新**结算，否则那台车会永远显示"未完赛" —— 用户报障
  //   "与人机对战完赛后全员已冲线但显示未完赛"就是这个：慢车在 60s 宽限之后冲线，
  //   结算早已定格，之后不再更新。
  if (S._offlineSettled) {
    if (car && car.finished) refreshLocalResults();
    return;
  }
  const cars = Array.from(S.rp.byId.values()).filter((c) => !c.remote);
  const allFinished = cars.length > 0 && cars.every((c) => c.finished);
  if (!allFinished) {
    if (!S._offlineDnfTimer) {
      S._offlineDnfTimer = setTimeout(() => {
        S._offlineDnfTimer = null;
        if (!S.rp || S._offlineSettled) return;
        for (const c of S.rp.byId.values()) {
          if (!c.remote && !c.finished) c.retired = true;
        }
        finishLocally();
      }, 60000);
    }
    if (car && car.isLocal) showFinishBar('已冲线 · 等待其余车手完赛（最长 60s）');
    return;
  }
  if (S._offlineDnfTimer) { clearTimeout(S._offlineDnfTimer); S._offlineDnfTimer = null; }
  finishLocally();
}

/** 由当前车辆状态重算结算（不重复提交赛季积分）——用于"结算后又有车冲线"的刷新。 */
function localResultsFromState() {
  const order = S.rp.cars.slice().sort((a, b) => {
    const at = a.finished ? a.totalTime : 1e9;
    const bt = b.finished ? b.totalTime : 1e9;
    return at - bt;
  });
  const pointTable = [0, 10, 6, 4, 2];
  return order.map((c, i) => ({
    id: c.id, name: c.name, color: c.color,
    net: c.finishTime, pen: c.penalty, total: c.totalTime,
    lap: c.lap, best: c.bestLap, fin: c.finished, dnf: !!c.retired,
    // 同时给出联机侧的服务端字段名，避免两条渲染路径再出现字段不一致
    // （showSettlement 读 bestLap/totalTime，见那里的说明）。
    bestLap: c.bestLap, totalTime: c.totalTime,
    rank: i + 1, points: pointTable[i + 1] || 0,
  }));
}

/**
 * 结算已定后再有车冲线/退赛时刷新界面。
 * ⚠️ 不调 submitOfflineResults —— 赛季积分只能记一次（重复提交会重复加分）。
 */
function refreshLocalResults() {
  if (!S.rp || !S._offlineSettled) return;
  const results = localResultsFromState();
  S.settlement = results;
  showResults(results);
  // 结算弹窗开着就一并刷新（关着就别强行弹出来）
  const box = document.getElementById('settlement');
  if (box && !box.classList.contains('hidden')) showSettlement(results);
}

function finishLocally() {
  if (!S.rp || S._offlineSettled) return;
  S._offlineSettled = true;
  const results = localResultsFromState();
  submitOfflineResults(results);
  showResults(results);
  S.settlement = results;
  S._settlementTimer = setTimeout(() => showSettlement(S.settlement || []), 1500);
}

// 离线单机没有权威房间，但赛季积分仍必须落到同一份 scores.json。
// 提交本地玩家与 AI 的完整名次，服务端原子累加后把最新榜广播给所有首页/大厅客户端。
function submitOfflineResults(results) {
  if (!Array.isArray(results) || !results.length) return;
  const payload = {
    results: results.slice(0, GRID_SLOTS).map((r) => ({
      name: r.name,
      rank: r.rank,
    })),
  };
  fetch('/api/offline-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j && Array.isArray(j.rankings)) renderSeason(j.rankings);
  }).catch(() => { /* 单机模式允许服务端不可用，结果仅本地展示 */ });
}

// showResults —— 规格 §四.1：完赛**禁止弹全屏大面板**，改为顶端单行半透明条幅。
// 完整成绩单数据仍保存在 S.results（供观战切换与后续复看），但不遮挡画面。
// 玩家仍可自由驾驶（巡航）或用 ←/→ 切换观战。
function showResults(results) {
  S.results = results;
  // 不切到 'end' 模式：保持 'race'，让巡航/观战/物理继续跑（完赛即脱手巡航）。
  const body = $('resBody');
  if (body) {
    body.innerHTML = '';
    for (const r of results) {
      const tr = document.createElement('tr');
      if (r.rank === 1) tr.className = 'p1';
      if (r.id === S.localId) tr.className += ' me';
      tr.innerHTML =
        '<td class="rk">' + r.rank + '</td>' +
        '<td class="nm"><span class="dot" style="background:' + r.color + '"></span>' + esc(r.name) + '</td>' +
        '<td>' + (r.fin ? fmtTime(r.net) : (r.dnf ? 'DNF' : '未完赛 (' + r.lap + '/' + S.laps + ')')) + '</td>' +
        '<td style="color:#ff6a5a">' + (finiteNum(r.pen) > 0 ? '+' + safeFixed(r.pen, 1) : '0.0') + '</td>' +
        '<td><b>' + (r.fin ? fmtTime(r.total) : '—') + '</b></td>' +
        '<td>' + (r.best ? fmtTime(r.best) : '--:--.--') + '</td>';
      body.appendChild(tr);
    }
  }
  // 单行条幅：本地玩家名次 + 成绩。
  const me = results.find((r) => r.id === S.localId);
  let txt = '恭喜完赛！成绩已记录';
  if (me) {
    txt = me.fin
      ? '恭喜完赛！P' + me.rank + ' ｜ 总成绩 ' + fmtTime(me.total) + ' ｜ 成绩已记录'
      : '本场结束 ｜ 名次 P' + me.rank + ' ｜ 成绩已记录';
  }
  showFinishBar(txt);
  // 观战面板打开（仍未完赛时可切换观看对象；已完赛的玩家自动进入观战）。
  // 具体列表内容由每帧的 HUD 渲染统一刷新（见 updateStandings 末尾）。
  $('spectate').classList.remove('hidden');
  S.spectateId = ((results.find((r) => !r.fin) || results[0]) || {}).id || 0;
}

/* --------------------------------------------------------------------------
 * 规格 §二：全员完赛结算 Modal（全屏磨砂）
 * data = [{rank,id,name,color,bestLap,totalTime,points,fin,dnf}, ...]
 * 延迟 1.5s 由 net.on('raceResults') 触发，避免刚冲线就砸面板。
 * "返回大厅"按钮 -> 复位到 WAITING（请求服务端回大厅）。
 * ------------------------------------------------------------------------ */
function showSettlement(data) {
  const arr = Array.isArray(data) ? data.slice() : [];
  if (!arr.length) return;
  arr.sort((a, b) => (a.rank | 0) - (b.rank | 0));
  const root = $('settlement');
  if (!root) return;
  const body = $('settleBody');
  if (body) {
    body.innerHTML = '';
    for (const r of arr) {
      const row = document.createElement('div');
      row.className = 'stl-row' + ((r.rank | 0) === 1 ? ' p1' : '')
        + ((r.id === S.localId) ? ' me' : '');
      // ★ 字段名必须**两种都认**（用户报障："与人机对战完赛后全员已冲线但显示未完赛"）：
      //   联机路径由服务端下发 `bestLap`/`totalTime`，而单机（人机对战）的结算对象里
      //   是 `best`/`total`（历史上两处命名不一致）。只认后者时 `r.totalTime` 为 undefined
      //   ⇒ `totTxt` 落到 '未完赛'、`lapTxt` 落到 '--:--.--'，**全员**显示未完赛。
      const bestLap = (r.bestLap !== undefined && r.bestLap !== null) ? r.bestLap : r.best;
      const totalTime = (r.totalTime !== undefined && r.totalTime !== null) ? r.totalTime : r.total;
      const lapTxt = (bestLap && bestLap > 0) ? fmtTime(bestLap) : '--:--.--';
      const totTxt = (r.fin && totalTime > 0) ? fmtTime(totalTime)
        : (r.dnf ? 'DNF' : '未完赛');
      const pts = Math.max(0, r.points | 0);
      row.innerHTML =
        '<span class="stl-rk">' + (r.rank | 0) + '</span>' +
        '<span class="stl-nm"><i class="dot" style="background:' + (r.color || '#888') + '"></i>' +
        esc(r.name || ('席位' + r.id)) + '</span>' +
        '<span class="stl-tot">' + totTxt + '</span>' +
        '<span class="stl-best">' + lapTxt + '</span>' +
        '<span class="stl-pts">' + (pts > 0 ? '+' + pts : '0') + '</span>';
      body.appendChild(row);
    }
  }
  const me = arr.find((r) => r.id === S.localId);
  const sub = $('settleSub');
  if (sub) {
    sub.textContent = me
      ? ('本场名次 P' + (me.rank | 0) + ' ｜ 赛季积分 +' + (Math.max(0, me.points | 0)))
      : '本场结算';
  }
  root.classList.remove('hidden');
  root.classList.add('show');
  // 结算 Modal 接管画面，完赛条和观战切换入口必须退出，避免三层结果 UI 重叠。
  hideFinishBar();
  const spectate = $('spectate');
  if (spectate) spectate.classList.add('hidden');
}

function hideSettlement() {
  const root = $('settlement');
  if (!root) return;
  root.classList.add('hidden');
  root.classList.remove('show');
}

function resetHUD() {
  const d = $('draftText');
  if (d) d.classList.add('hidden');
  $('wrongWay').classList.add('hidden');
  $('spectate').classList.add('hidden');
  hideFinishBar();
  const sl = $('startLights');
  if (sl) sl.classList.add('hidden');
  const io = $('inputOverlay');
  if (io) io.classList.add('hidden');
  // 罚时不再有独立卡片：静默展示在右侧排行榜各车名后
  S.warnings = {};
  S.penalties = {};
  S._timingNextAt = 0;
  if (S._gapSmooth) S._gapSmooth.clear();
}

function setAlert(text, kind) {
  const el = $('alert');
  el.className = 'alert ' + (kind === 'warn' || kind === 'off' ? kind : '');
  $('alertTxt').textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

let toastTimer = null;
function showToast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ========================================================================== */
/* 8b. 聊天与赛事事件控制台（规格 §二 / §三）                                   */
/*                                                                             */
/*   · 大厅：右侧 340px 磨砂面板，玩家发言 + 系统事件共用一条消息流。            */
/*   · 局内：左下轻量浮层，新消息淡入、停留 5s 后向左淡出（绝不遮挡弯心）。       */
/*   · 倒计时文本由服务端以 isSystem 消息推入同一通道 ⇒ 与聊天同层渲染，          */
/*     天然不会被任何 UI 叠层遮挡（根治旧版全屏倒计时被挡的问题）。              */
/*   · 打字隔离：输入框激活时置 S.chatTyping，sampleLocalInput 直接清零操控意图， */
/*     彻底杜绝"打字按到 WASD 导致赛车冲出赛道"。                              */
/* ========================================================================== */

const CHAT = {
  MAX_LOBBY: 200,     // 大厅消息流保留上限（DOM 节点数量收敛）
  MAX_HUD: 4,         // 局内浮层同时可见条数
  HUD_HOLD_MS: 5000,  // 局内消息停留时长（规格：5 秒后淡出）
  OUT_MS: 520,        // 淡出动画时长（与 CSS .hc-msg.out 对齐）
};

// 判断一条消息是否为"发车倒数"（服务端以 [赛事指令] 前缀标注）。
function isCountdownMsg(content) {
  return /^\[赛事指令\]/.test(content);
}
function isGoMsg(content) {
  return /出发|发车！|全员发车/.test(content);
}

/**
 * 把整备倒计时文本拆成「前段 / 秒数 / 后段」，供**大号数字**渲染。
 * 服务端原文："[赛事指令] 全员已准备 · 5 秒后发车…"
 *   → { pre: '[赛事指令] 全员已准备 ·  ', secs: '5', post: ' 秒后发车…' }
 * 不是倒计时就返回 null（调用方照常按纯文本渲染）。
 * 用三个独立节点而不是 innerHTML：文案来自服务端，仍然不许拼 HTML。
 */
function splitCountdown(content) {
  const m = /^(.*?)(\d+)(\s*秒后发车.*)$/.exec(content || '');
  if (!m) return null;
  return { pre: m[1], secs: m[2], post: m[3] };
}

// appendChatRow 向大厅消息流追加一条消息。
//   msg: { sender, senderColor, content, isSystem, timestamp }
function appendChatRow(msg) {
  const feed = $('chatFeed');
  if (!feed) return;
  const row = document.createElement('div');
  if (msg.isSystem) {
    // ---- 系统 / 倒数公告：居中高亮，渐变描边（规格 §二.2）----
    const sys = document.createElement('div');
    const cd = isCountdownMsg(msg.content);
    const go = cd && isGoMsg(msg.content);
    sys.className = 'chat-sys' + (go ? ' go' : cd ? ' countdown' : '');
    const parts = splitCountdown(msg.content || '');
    if (parts) {
      // ★ 整备倒计时（"[赛事指令] 全员已准备 · 5 秒后发车…"）：秒数做成大号数字。
      //   这一行出现在**右侧聊天框**（大厅面板），也是玩家准备时真正盯着看的地方 ——
      //   只在局内浮层做样式是不够的（那正是第一版漏掉的地方）。
      sys.classList.add('cd-big');
      sys.dataset.secs = parts.secs;
      const pre = document.createElement('span');
      pre.className = 'chat-cd-pre';
      pre.textContent = parts.pre;
      const big = document.createElement('b');
      big.className = 'chat-cd-num';
      big.textContent = parts.secs;
      const post = document.createElement('span');
      post.className = 'chat-cd-post';
      post.textContent = parts.post;
      sys.appendChild(pre); sys.appendChild(big); sys.appendChild(post);
    } else {
      sys.textContent = msg.content || '';
    }
    row.appendChild(sys);
  } else {
    // ---- 玩家发言：车色方标 + 高亮昵称 + 正文（全部 textContent，杜绝 XSS）----
    row.className = 'chat-row';
    const sw = document.createElement('span');
    sw.className = 'chat-swatch';
    sw.style.background = sanitizeHex(msg.senderColor);
    const bub = document.createElement('div');
    bub.className = 'chat-bubble';
    const nm = document.createElement('span');
    nm.className = 'chat-name';
    const self = msg.sender === (S.localName || '');
    nm.textContent = (self ? '我 · ' : '') + (msg.sender || '车手');
    if (self) nm.classList.add('chat-self');
    const tx = document.createElement('div');
    tx.className = 'chat-text';
    tx.textContent = msg.content || '';
    bub.appendChild(nm);
    bub.appendChild(tx);
    row.appendChild(sw);
    row.appendChild(bub);
  }
  feed.appendChild(row);
  // 节点上限：超出丢弃最旧的，避免长会话 DOM 膨胀
  while (feed.children.length > CHAT.MAX_LOBBY) feed.removeChild(feed.firstChild);
  // 平滑贴底（滚动容器设了 scroll-behavior:smooth）
  feed.scrollTop = feed.scrollHeight;
}

// sanitizeHex 只接受 #rrggbb 形式，其余回落到中性蓝（服务端已清洗，这里是纵深防御）。
function sanitizeHex(c) {
  return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : '#7fb2ff';
}

// appendHudChat 向局内浮层追加一条消息，并安排 5s 后淡出移除。
function appendHudChat(msg) {
  const feed = $('hudChatFeed');
  if (!feed) return;
  const el = document.createElement('div');
  const cd = msg.isSystem && isCountdownMsg(msg.content);
  const go = cd && isGoMsg(msg.content);
  el.className = 'hc-msg in' + (go ? ' go' : cd ? ' cd' : msg.isSystem ? ' sys' : '');
  if (!msg.isSystem) el.style.borderLeftColor = sanitizeHex(msg.senderColor);
  if (!msg.isSystem) {
    const nm = document.createElement('span');
    nm.className = 'hc-name';
    nm.textContent = (msg.sender || '车手') + '：';
    nm.style.color = sanitizeHex(msg.senderColor);
    el.appendChild(nm);
  }
  const tx = document.createElement('span');
  tx.className = 'hc-text';
  tx.textContent = msg.content || '';
  el.appendChild(tx);
  if (cd) {
    // 倒数公告常驻 + 把秒数抽出来做成大号数字（右侧聊天框里最醒目的一行）
    el._chatSticky = true;
    const parts = splitCountdown(msg.content || '');
    if (parts) {
      el.classList.add('cd-big');
      el.dataset.secs = parts.secs;
      tx.textContent = '';
      const big = document.createElement('b');
      big.className = 'hc-cd-num';
      big.textContent = parts.secs;
      const rest = document.createElement('span');
      rest.className = 'hc-cd-txt';
      rest.textContent = parts.post;
      tx.appendChild(big);
      tx.appendChild(rest);
    }
  }
  feed.appendChild(el);
  // 同时可见条数上限：超出立刻安排最旧的淡出
  while (feed.children.length > CHAT.MAX_HUD) {
    scheduleHudOut(feed.firstChild, 0);
  }
  scheduleHudOut(el, CHAT.HUD_HOLD_MS);
}

// scheduleHudOut 在 delay 后给局内消息切 .out 并移除（已淡出者幂等跳过）。
//
// ⚠️ **倒数公告永不淡出**（2026-09-30）："[赛事指令] … 秒后发车…" 这类消息
//    若照常 5s 淡出，玩家会在起跑前一刻看着倒计时消失 —— 那正是"没有准备时间"
//    的体感来源之一。所以它们**留在浮层上**，直到下一条倒数覆盖它，
//    或被 clearHudChat()（开新一场 / 回大厅）清掉。
function scheduleHudOut(el, delay) {
  if (!el || el._chatOut) return;
  if (el._chatSticky) return;                  // 倒数公告：常驻
  el._chatOut = true;
  setTimeout(() => {
    if (!el.parentNode) return;
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, CHAT.OUT_MS);
  }, delay);
}

// onChatMessage 统一入口：收到服务端 CHAT_MESSAGE 后同时投喂大厅面板与局内浮层。
// 大厅面板在局内是隐藏的（display:none），但消息仍需入队 —— 返回大厅时消息流完整。
function onChatMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  appendChatRow(msg);
  // 局内（含倒计时载入阶段）才推入 HUD 浮层；大厅阶段不显示浮层。
  if (S.mode === 'race' || S.mode === 'end') appendHudChat(msg);
}

// 真机 DOM 验收钩子（tools/chat-ui-check.mjs）：把两个渲染入口暴露到 window，
// 让无头浏览器能注入伪造消息并读回 computedStyle —— 静态正则守卫证明不了"样式真的生效"。
// 与生产路径完全同源（调的就是同两个函数），不存在"测试专用分支"。
if (typeof window !== 'undefined') {
  window.__testAppend = (msg) => {
    appendChatRow(msg);
    if (S.mode === 'race' || S.mode === 'end') appendHudChat(msg);
  };
  // 暴露状态机与输入采样函数，供验收脚本验证"打字时油门真的被清零"
  // （这是规格 §三.2 的核心保证，静态扫描只能证明代码写了，证明不了跑起来生效）。
  window.__S = S;
  window.__audio = audio;   // 供音效档位验收探针读取（tools/audio-profile-check.mjs）
  window.__carVisuals = carVisuals;
  window.__camera = camera;
  window.__chaseCam = chaseCamera;   // 供探针读取 pullback/roll 等生产相机内部量（tools/camera-worker-check.mjs 之外真机核对用）
  window.__renderer = renderer;   // 供探针投影/读取视口尺寸
  window.__sampleLocalInput = sampleLocalInput;
}

// clearChat 回大厅/开新局时是否清空由调用方决定（消息流跨局保留更符合"频道"语义，
// 只有明确"回大厅重开"才清空视觉浮层）。
function clearHudChat() {
  const feed = $('hudChatFeed');
  if (feed) feed.innerHTML = '';
}
// 只清"倒数公告"那一类常驻行（开新一场时用：上一场的"5 秒后发车…"不许留到下一场）
function clearHudCountdown() {
  const feed = $('hudChatFeed');
  if (!feed) return;
  for (const el of [...feed.children]) {
    if (el._chatSticky) feed.removeChild(el);
  }
}

/* ---- 大厅聊天输入 ---- */

function sendChatText(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  if (!S.net || !S.net.connected) { showToast('未连接服务端，无法发言', 1800); return false; }
  return S.net.send({ t: 'CHAT_MESSAGE', content: t.slice(0, 80) });
}

function focusLobbyChat() {
  const inp = $('chatInput');
  if (!inp) return;
  inp.focus();
  // 光标置于末尾
  const v = inp.value;
  inp.value = '';
  inp.value = v;
}

// setChatPanel 统一控制右侧聊天面板显隐（规格 §二 / §三：局内自动隐藏）。
// 只有处于房间/菜单态且面板被要求展开时才显示；比赛与结算态一律收起。
function setChatPanel(on) {
  const el = $('chatPanel');
  if (!el) return;
  const wantShow = !!on && (S.mode === 'room' || S.mode === 'menu');
  el.classList.toggle('hidden', !wantShow);
  el.classList.toggle('show', wantShow);
  // 面板收起时把输入焦点交还，避免隐藏 input 继续吞键。
  if (!wantShow) {
    const inp = $('chatInput');
    if (inp && document.activeElement === inp) inp.blur();
    releaseDriveKeys();
  }
}

/* ---- 局内快捷打字条（Enter / T 呼出）---- */

// openHudChat 呼出打字条并把操控权从赛车手里收回（S.chatTyping = true）。
function openHudChat() {
  const bar = $('hudChatBar');
  const inp = $('hudChatInput');
  if (!bar || !inp) return;
  bar.classList.remove('hidden');
  S.chatTyping = true;
  inp.value = '';
  inp.focus();
  // 呼出瞬间清空一切操控意图 + 按键状态，防止"按住 W 时呼出"留下粘键。
  releaseDriveKeys();
}

// closeHudChat 收起打字条并把操控权无缝交还（S.chatTyping = false）。
function closeHudChat() {
  const bar = $('hudChatBar');
  const inp = $('hudChatInput');
  if (bar) bar.classList.add('hidden');
  if (inp) inp.value = '';
  S.chatTyping = false;
  releaseDriveKeys();
}

// releaseDriveKeys 清空方向/油门/手刹的按键状态位。
// ⚠️ 关键：打字时输入框会吃掉 keyup，若不主动清位，keys['w'] 会永久为 true，
// 表现为"打完字车还在自己往前冲"。呼出与收起各清一次，双向兜底。
function releaseDriveKeys() {
  handbrakeKey = false;
  for (const k in keys) keys[k] = false;
}

/* ========================================================================== */
/* 9. FM8 动态追尾摄像机                                                        */
/*    严格按 FM8 规格：                                                         */
/*      · 目标点 = 车后上方 5.5m / 1.8m，沿【运动速度向量】向后延伸              */
/*      · 追踪 = 指数衰减平滑 1-exp(-12·dt)（帧率无关，200km/h 也不脱节）        */
/*      · 注视点 = 车头前方 8m 切线，转弯时向弯心预瞄                            */
/*      · FOV 60°(静止) -> 72°(200km/h) 线性展开；尾流再微收 1.5°                */
/*      · 尾流镜头湍流 24Hz / 振幅 0.012m（规格值，见 CFG.TURBULENCE_*）        */
/*    严禁任何屏幕速度线/气流贴图 —— 速度感只由 FOV 透视与地面高频后退提供        */
/* ========================================================================== */

const CAM = {
  DIST: 5.5,          // 车后距离 (m)
  HEIGHT: 1.8,        // 车顶上方高度 (m)
  K_POS: 12.0,        // 指数衰减系数（规格值 12.0）
  K_LOOK: 13.5,       // 注视点略快，避免转身滞后
  LOOK_AHEAD: 8.0,    // 注视点超前距离 (m)
  // 偏航低通滤波系数（1/s）：镜头方位只跟随**滤波后**的车头方向。
  // 撞车/打转时车身角速度会剧烈跳变，用瞬时值会把镜头甩到车头前方（看不见车身）。
  YAW_LP: 7.0,
  FOV_STILL: 60,      // 静止基础 FOV
  FOV_FAST: 72,       // 200km/h 时 FOV
  FOV_REF_KMH: 200,
  // ---- 多视角（规格：按 C 或 V 在三种视角间循环）----
  BONNET_H: 0.9,      // 引擎盖视角离地高度 (m)（规格值）
  BONNET_FOV: 75,     // 引擎盖视角视野（规格值）
  TOP_DOWN_H: 35.0,   // 垂直鸟瞰高度 (m)（规格值）
  TOPDOWN_FOV: 70,    // 鸟瞰视野（35m 高度下适当放宽以便看清走线）
  CAM_COUNT: 3,       // 视角数量：0 追尾 / 1 引擎盖 / 2 垂直鸟瞰
};

const camState = {
  yaw: 0,               // 低通滤波后的水平偏航角（镜头方位的唯一依据）
  pull: 0,              // 完赛后镜头拉起的平滑系数 0..1
  pos: new THREE.Vector3(0, 40, 80),
  look: new THREE.Vector3(),
  fov: CAM.FOV_STILL,
  orbit: 0,
  turb: new THREE.Vector3(),
  turbT: 0,
  ghostAmp: 0,
  ghostPhase: 0,
};
const _camWant = new THREE.Vector3();
const _camLook = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _camUp = new THREE.Vector3();

function camFocusCar() {
  if (!S.localCar) return null;
  if (S.localCar.finished || S.localCar.retired) {
    const cand = S.rp.cars.filter((c) => !c.finished && !c.retired);
    if (cand.length) {
      let c = cand.find((x) => x.id === S.spectateId);
      if (!c) c = cand[0];
      S.spectateId = c.id;
      return c;
    }
  }
  return S.localCar;
}

/**
 * 指数衰减平滑：与帧率无关（60fps 与 144fps 手感一致）。
 * 规格指定形式：  currentPos.lerp(targetPos, 1.0 - Math.exp(-K * dt))
 */
function expDamp(cur, target, k, dt) {
  return cur + (target - cur) * (1 - Math.exp(-k * dt));
}

function cycleSpectate(dir) {
  const cand = S.rp ? S.rp.cars.filter((c) => !c.finished && !c.retired) : [];
  if (!cand.length) return;
  let i = cand.findIndex((c) => c.id === S.spectateId);
  i = (i + dir + cand.length) % cand.length;
  S.spectateId = cand[i].id;
  const c = cand[i];
  showToast('观战：P' + (S.rp.cars.indexOf(c) + 1) + ' ' + c.name);
}

/** 发车瞬间把相机直接吸附到车尾：避免从大厅巡航视角缓慢"飞进来"的过渡 */
function snapCameraToCar(car) {
  if (!car) return;
  const visual = carVisuals.get(car.id);
  if (visual) {
    chaseCamera.reset(visual);
    S.orbitYaw = S.orbitYawTarget = 0;
    S.orbitPitch = S.orbitPitchTarget = 0;
    return;
  }
  S.orbitYaw = S.orbitYawTarget = 0;
  S.orbitPitch = S.orbitPitchTarget = 0;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quat);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(car.quat);
  if (S.camMode === 2) {
    // 鸟瞰：直接放到车顶正上方
    camState.pos.set(car.pos.x, car.pos.y + CAM.TOP_DOWN_H, car.pos.z);
    camState.look.copy(car.pos);
  } else if (S.camMode === 1) {
    camState.pos.copy(car.pos).addScaledVector(fwd, 0.35);
    camState.pos.y = car.pos.y - CFG.RIDE_H + CAM.BONNET_H;
    camState.look.copy(car.pos).addScaledVector(fwd, 42);
  } else {
    camState.yaw = Math.atan2(fwd.x, fwd.z);   // 低通初值：避免开局镜头自己空转一圈
  camState.pos.copy(car.pos).addScaledVector(fwd, -CAM.DIST).addScaledVector(up, CAM.HEIGHT);
    camState.look.copy(car.pos).addScaledVector(fwd, CAM.LOOK_AHEAD).addScaledVector(up, 0.6);
  }
  camState.turb.set(0, 0, 0);
}

function updateCamera(dt, now) {
  const car = camFocusCar();
  if (!car) {
    // 大厅/加载：环绕赛道巡航
    camState.orbit += dt * 0.06;
    const r = 460;
    const p = new THREE.Vector3(Math.cos(camState.orbit) * r, 150, Math.sin(camState.orbit) * r);
    camState.pos.lerp(p, 1 - Math.exp(-2.2 * dt));
    camState.look.lerp(new THREE.Vector3(0, 0, 0), 1 - Math.exp(-2.2 * dt));
    camera.position.copy(camState.pos);
    camera.lookAt(camState.look);
    camera.fov = expDamp(camera.fov, CAM.FOV_STILL, 3, dt);
    camera.updateProjectionMatrix();
    return;
  }

  // 生产相机只消费已经由 Worker A/B 插值后的视觉网格；物理车体的位置
  // 不参与镜头位姿，避免网络纠偏或固定步长在渲染线程重新引入抖动。
  const visual = carVisuals.get(car.id);
  if (visual) {
    const lookX = pressed('arrowright') ? 1 : (pressed('arrowleft') ? -1 : 0);
    const lookY = pressed('arrowdown') ? 1 : (pressed('arrowup') ? -1 : 0);
    chaseCamera.update({
      mesh: visual,
      car,
      dt,
      now,
      lookX,
      lookY,
      mode: S.camMode,
      ghostAmplitude: 0,
    });
    return;
  }

  const q = car.quat;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const orbitLeft = pressed('arrowleft') ? 1 : 0;
  const orbitRight = pressed('arrowright') ? 1 : 0;
  const orbitUp = pressed('arrowup') ? 1 : 0;
  const orbitDown = pressed('arrowdown') ? 1 : 0;
  S.orbitYawTarget += (orbitRight - orbitLeft) * dt * 2.5;
  S.orbitPitchTarget = clamp(S.orbitPitchTarget + (orbitDown - orbitUp) * dt * 1.8, -0.75, 0.65);
  S.orbitYaw = expDamp(S.orbitYaw, S.orbitYawTarget, 10, dt);
  S.orbitPitch = expDamp(S.orbitPitch, S.orbitPitchTarget, 10, dt);
  // 松开方向键后缓慢回到车尾视角，避免松键时镜头突然跳回。
  if (!orbitLeft && !orbitRight) S.orbitYawTarget = expDamp(S.orbitYawTarget, 0, 1.8, dt);
  if (!orbitUp && !orbitDown) S.orbitPitchTarget = expDamp(S.orbitPitchTarget, 0, 2.2, dt);
  const orbitYaw = S.orbitYaw || 0;
  const orbitPitch = S.orbitPitch || 0;
  const orbitFwd = _camFwd.set(Math.sin(Math.atan2(fwd.x, fwd.z) + orbitYaw), 0,
    Math.cos(Math.atan2(fwd.x, fwd.z) + orbitYaw)).normalize();
  const spd = car.speed;

  let want = _camWant;
  let lookAt = _camLook;
  let k = CAM.K_POS, lookK = CAM.K_LOOK;

  // 运动方向：优先取速度向量（漂移时能看到车头偏角），低速退化为车头方向
  _camDir.set(car.vel.x, 0, car.vel.z);
  if (_camDir.lengthSq() < 1.2) _camDir.set(fwd.x, 0, fwd.z);
  _camDir.normalize();

  // ---- Mode 2：垂直俯视鸟瞰（Top-Down）----
  // 位置直接在车正上方 35m，垂直向下注视车身中心；相机 Up 取【车辆后方向量】，
  // 于是车头永远朝屏幕上方 —— 类似 Micro Machines 的大局观战术视角。
  if (S.camMode === 2) {
    // 摄像机位于车辆正上方 35m，垂直向下注视车身中心
    _camWant.set(car.pos.x, car.pos.y + CAM.TOP_DOWN_H, car.pos.z);
    _camLook.set(car.pos.x, car.pos.y, car.pos.z);
    // 关键修复：Up 向量严格指向【车头前进方向】并投到 XZ 平面 ——
    // 这样车头永远在屏幕正上方（上一版用了 -fwd，车头实际朝屏幕下方）。
    // 必须在 lookAt 之前设置（three 的 lookAt 依赖 camera.up 构造基）。
    camera.up.copy(fwd);
    camera.up.y = 0;
    camera.up.normalize();
    camState.pos.lerp(_camWant, 1 - Math.exp(-14 * dt));
    camState.look.lerp(_camLook, 1 - Math.exp(-28 * dt));
    camera.position.copy(camState.pos);

    camera.lookAt(camState.look);
    const tF2 = clamp((spd * 3.6) / CAM.FOV_REF_KMH, 0, 1);
    camera.fov = expDamp(camera.fov, CAM.TOPDOWN_FOV + 6 * tF2, 8, dt);
    camera.updateProjectionMatrix();
    return;
  }
  // 其余视角恢复常规 Up
  camera.up.set(0, 1, 0);

  if (S.camMode === 0) {
    // ---- Mode 0（默认）：FM8 第三人称拟真跟随 ----
    // 位置由【低通滤波后的水平偏航角】决定，**不再**用车身瞬时角速度偏转镜头：
    // 撞车/打转时角速度会剧烈跳变，直接拿它算预瞄会瞬间把镜头甩到车头前方，
    // 玩家就看不见自己车身了（这就是"镜头翻到车头前面"的根因）。
    const yawNow = Math.atan2(fwd.x, fwd.z);
    let dyaw = yawNow - camState.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    camState.yaw += dyaw * (1 - Math.exp(-CAM.YAW_LP * dt));
    const sinY = Math.sin(camState.yaw + orbitYaw), cosY = Math.cos(camState.yaw + orbitYaw);
    // 严格落在“质心后方 5.5m、高度 1.8m”的扇区内；方向键允许连续环视。
    want.set(car.pos.x - sinY * CAM.DIST,
      car.pos.y + CAM.HEIGHT + Math.sin(orbitPitch) * 3.5,
      car.pos.z - cosY * CAM.DIST);
    // 环视时注视车身附近，回到默认方向后恢复前视预瞄。
    lookAt.copy(car.pos).addScaledVector(orbitFwd, CAM.LOOK_AHEAD * (1 - Math.min(Math.abs(orbitYaw) / Math.PI, .65)))
      .addScaledVector(up, 0.55 + Math.sin(orbitPitch) * 1.4);

    // 死锁：镜头相对车头的方位角不得超过 90°，永远咬在车尾后半球。
    // 若因为大 dt / 碰撞抖动越界，就把相对位移沿车头方向做镜像，落到后半球
    // （镜像不改变水平距离，5.5m 扇区半径保持不变）。
    const fl = Math.hypot(fwd.x, fwd.z) || 1e-3;
    const nfx = fwd.x / fl, nfz = fwd.z / fl;
    const relX = want.x - car.pos.x, relZ = want.z - car.pos.z;
    const relL = Math.hypot(relX, relZ) || 1e-3;
    const cosA = (relX * nfx + relZ * nfz) / relL;
    if (Math.abs(orbitYaw) < 0.05 && cosA > 0) {
      const proj = relL * cosA;
      want.x -= nfx * proj * 2;
      want.z -= nfz * proj * 2;
      camState.pos.x -= nfx * proj * 2;      // 同步已平滑的位置，避免下一帧又被拽回去
      camState.pos.z -= nfz * proj * 2;
    }

    // 完赛后镜头平滑拉起（规格）：拉远抬高，方便看清巡航与观战其他车手
    const pullT = car.finished ? 1 : 0;
    camState.pull = (camState.pull || 0) + (pullT - (camState.pull || 0)) * (1 - Math.exp(-2.5 * dt));
    if (camState.pull > 0.002) {
      const p = camState.pull;
      want.x = car.pos.x + (want.x - car.pos.x) * (1 + 0.55 * p);
      want.z = car.pos.z + (want.z - car.pos.z) * (1 + 0.55 * p);
      want.y = car.pos.y + CAM.HEIGHT + 2.2 * p;
      lookAt.copy(car.pos).addScaledVector(fwd, CAM.LOOK_AHEAD + 10 * p).addScaledVector(up, 0.55);
    }
  } else {
    // ---- Mode 1：引擎盖 / 车头视角（Bonnet Cam）----
    // 离地 0.9m，视野拉宽到 75°
    const gy = car.pos.y - CFG.RIDE_H;                   // 路面高度
    want.copy(car.pos)
      .addScaledVector(fwd, 0.35)
      .setY(gy + CAM.BONNET_H);
    lookAt.copy(car.pos).addScaledVector(fwd, 42).setY(gy + CAM.BONNET_H + 0.15);
    k = 26; lookK = 20;
  }

  // 指数衰减平滑（帧率无关，规格指定形式）
  camState.pos.lerp(want, 1 - Math.exp(-k * dt));
  camState.look.lerp(lookAt, 1 - Math.exp(-lookK * dt));

  // 尾流镜头湍流：密度 24Hz、振幅仅 0.012m 的高频噪波（前车排气撕扯感，规格值）
  camState.turbT -= dt;
  if (camState.turbT <= 0) {
    camState.turbT += 1 / CFG.TURBULENCE_HZ;
    camState.turb.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  }
  const turbAmp = CFG.TURBULENCE_AMP * clamp(car.slip || 0, 0, 1);
  camera.position.copy(camState.pos);
  if (turbAmp > 1e-5) camera.position.addScaledVector(camState.turb, turbAmp);
  camera.lookAt(camState.look);

  // 动态 FOV：60°(静止) -> 72°(200km/h) 平滑线性展开；进入尾流推背时瞬时微收 1.5°。
  // 这是唯一的"速度感"来源 —— 不做任何屏幕速度线/气流贴图。
  const tFov = clamp((spd * 3.6) / CAM.FOV_REF_KMH, 0, 1);
  let fovTarget;
  if (S.camMode === 1) {
    fovTarget = CAM.BONNET_FOV;                          // 引擎盖：固定 75°（规格值）
  } else {
    fovTarget = CAM.FOV_STILL + (CAM.FOV_FAST - CAM.FOV_STILL) * tFov;
  }
  fovTarget -= CFG.DRAFT_FOV_KICK * clamp(car.slip || 0, 0, 1);
  camera.fov = expDamp(camera.fov, fovTarget, 8, dt);
  camera.updateProjectionMatrix();
}

/* ========================================================================== */
/* 10. HUD                                                                     */
/* ========================================================================== */

/* 仪表盘几何（与 style.css 的 .needle 约定必须一致）
 *   刻度 0 ~ 260 km/h；0 km/h -> -120°，260 km/h -> +120°，总行程 240°
 *   指针元素默认朝上（CSS 0° = 12 点钟），所以 needle 角度用 CSS 空间；
 *   表盘弧线用 SVG 极坐标空间（0° = +X 轴），两者相差 90°：
 *       polar = -90 + css   ⇒  css -120 等价 polar -210，css +120 等价 polar +30
 *   上一版把这两个空间的数值混用，导致指针整体偏了 90°（0km/h 指到右下角）——
 *   这就是"指针错位"的根因。
 */
const GAUGE = {
  // 规格 §五.4：右下角是**大号环形转速表**（tach）—— 中心大档位、档位下方车速。
  // 所以环与指针改由**转速**驱动（上一版是车速驱动，与 FM8 布局不符）。
  MAX_RPM: 7500,           // 与 CFG.REDLINE_RPM 对齐
  CSS_START: -120,         // 指针 CSS 空间：0° = 12 点钟
  CSS_SWEEP: 240,
  // 供 SVG 弧线使用（极坐标空间，0° = +X 轴，与 CSS 空间差 90°）
  get polarStart() { return -90 + this.CSS_START; },
  get polarEnd() { return -90 + this.CSS_START + this.CSS_SWEEP; },
};

/** 转速 -> 指针 CSS 旋转角 */
function needleAngle(rpm) {
  const v = Math.min(Math.max(rpm || 0, 0), GAUGE.MAX_RPM);
  return GAUGE.CSS_START + v * (GAUGE.CSS_SWEEP / GAUGE.MAX_RPM);
}

const speedo = {
  arc: $('spdArc'), fill: $('spdFill'), needle: $('needle'),
  R: 78,
};

function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx, cy, r, d0, d1) {
  const [x0, y0] = polar(cx, cy, r, d0);
  const [x1, y1] = polar(cx, cy, r, d1);
  const large = Math.abs(d1 - d0) > 180 ? 1 : 0;
  return 'M ' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2);
}

function initSpeedo() {
  speedo.arc.setAttribute('d', arcPath(100, 100, speedo.R, GAUGE.polarStart, GAUGE.polarEnd));
  speedo.fill.setAttribute('d', arcPath(100, 100, speedo.R, GAUGE.polarStart, GAUGE.polarStart));
  speedo.fill.style.opacity = '0.95';
  if (speedo.needle) speedo.needle.style.transform = 'rotate(' + GAUGE.CSS_START + 'deg)';
}
initSpeedo();

const hudCache = {};
function setTxt(el, v) {
  const k = el.id || el;
  if (hudCache[k] === v) return;
  hudCache[k] = v;
  if (typeof el === 'string') $(el).textContent = v; else el.textContent = v;
}

/** 带缓存的样式写入（遥测格/油量条每帧都在变，不加缓存会白白触发样式重算） */
function setStyle(el, prop, v) {
  const k = (el.id || el) + ':' + prop;
  if (hudCache[k] === v) return;
  hudCache[k] = v;
  const node = typeof el === 'string' ? $(el) : el;
  if (node) node.style[prop] = v;
}

// 小地图：Canvas2D 绘制，赛道折线由 track.minimap 提供
const mapCv = $('minimap');
const mapCtx = mapCv.getContext('2d');

function updateMinimap() {
  if (!track) return;
  const W = mapCv.width, H = mapCv.height;
  // 透明微缩地图：只绘制白色闭合赛道线、蓝箭头自己、白点其他车和青绿色终点线。
  // 不绘制任何圆盘/椭圆底色，也不做圆形裁切。
  const cx = W / 2, cy = H / 2;
  const pad = Math.min(W, H) * 0.08;    // 透明画布安全内边距
  mapCtx.clearRect(0, 0, W, H);
  const mm = track.minimap;
  const sx = (W - pad * 2) / (mm.maxX - mm.minX);
  const sz = (H - pad * 2) / (mm.maxZ - mm.minZ);
  const s = Math.min(sx, sz);
  const ox = pad + ((W - pad * 2) - (mm.maxX - mm.minX) * s) / 2;
  const oz = pad + ((H - pad * 2) - (mm.maxZ - mm.minZ) * s) / 2;
  const baseX = (x) => ox + (x - mm.minX) * s;
  const baseZ = (z) => oz + (z - mm.minZ) * s;
  const me = S.localCar;
  const meX = me ? baseX(me.pos.x) : cx;
  const meZ = me ? baseZ(me.pos.z) : cy;
  const heading = me ? Math.atan2(me.fwd.x, me.fwd.z) : 0;
  // 以本车为中心旋转地图，让本车车头固定朝屏幕上方；画布尺寸与地图缩放保持不变。
  const rot = heading + Math.PI;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const TX = (x, z) => cx + cr * (baseX(x) - meX) - sr * (baseZ(z) - meZ);
  const TZ = (x, z) => cy + sr * (baseX(x) - meX) + cr * (baseZ(z) - meZ);

  // ── ① 赛道闭环：先粗描淡色底衬再细描白色，两遍叠出干净的闭合线 ──
  mapCtx.lineJoin = 'round';
  mapCtx.lineCap = 'round';
  mapCtx.strokeStyle = 'rgba(255,255,255,.20)';
  mapCtx.lineWidth = 13;
  mapCtx.beginPath();
  for (let i = 0; i < mm.pts.length; i += 2) {
    const X = TX(mm.pts[i], mm.pts[i + 1]), Z = TZ(mm.pts[i], mm.pts[i + 1]);
    if (i === 0) mapCtx.moveTo(X, Z); else mapCtx.lineTo(X, Z);
  }
  mapCtx.closePath();
  mapCtx.stroke();
  // 规格：白色闭合环线
  mapCtx.strokeStyle = 'rgba(236,244,252,.92)';
  mapCtx.lineWidth = 3;
  mapCtx.stroke();

  // ── ② 终点线：青绿色短横条（垂直于起点切线）──
  if (mm.pts.length >= 4) {
    const x0 = TX(mm.pts[0], mm.pts[1]), z0 = TZ(mm.pts[0], mm.pts[1]);
    const x1 = TX(mm.pts[2], mm.pts[3]), z1 = TZ(mm.pts[2], mm.pts[3]);
    let dx = x1 - x0, dz = z1 - z0;
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    // 终线沿赛道法向（切线旋转 90°）铺开，长 16px
    const nx = -dz, nz = dx;
    const half = 9;
    mapCtx.beginPath();
    mapCtx.moveTo(x0 + nx * half, z0 + nz * half);
    mapCtx.lineTo(x0 - nx * half, z0 - nz * half);
    mapCtx.strokeStyle = '#38e8c8';
    mapCtx.lineWidth = 4.5;
    mapCtx.stroke();
  }
  // ── ③ 车辆标记（直接绘制在透明画布上）──
  if (!S.rp) return;
  for (const c of S.rp.cars) {
    const X = TX(c.pos.x, c.pos.z), Z = TZ(c.pos.x, c.pos.z);
    const isMe = c.id === S.localId;
    if (isMe) {
      // 规格：自己的车 = **蓝色三角箭头**，指向车头方向
      // 地图随本车旋转，本车箭头固定朝屏幕上方。
      const L = 11;
      const Wd = 7;
      mapCtx.beginPath();
      mapCtx.moveTo(X, Z - L);
      mapCtx.lineTo(X - Wd, Z + 6);
      mapCtx.lineTo(X + Wd, Z + 6);
      mapCtx.closePath();
      mapCtx.fillStyle = '#3a8cff';
      mapCtx.fill();
      mapCtx.lineWidth = 1.6;
      mapCtx.strokeStyle = 'rgba(255,255,255,.9)';
      mapCtx.stroke();
    } else {
      // 规格：其他车 = **白色实心圆点**
      mapCtx.beginPath();
      mapCtx.arc(X, Z, 4.5, 0, Math.PI * 2);
      mapCtx.fillStyle = '#f2f6fa';
      mapCtx.fill();
      mapCtx.lineWidth = 1.2;
      mapCtx.strokeStyle = 'rgba(0,0,0,.55)';
      mapCtx.stroke();
    }
  }
}

function updateHUD(now) {
  const car = S.localCar;
  if (!car || !S.rp) return;
  // 本函数只有 now 入参；遥测/油量需要帧间隔，这里自行推导（并夹住上限防切页后跳变）
  const hudDt = clamp((now - (S._hudLast || now)) / 1000, 0, 0.05);
  S._hudLast = now;

  // 规格 §四.3：观战时右下时速仪表盘**动态重定向到被观战玩家**。
  // 本地车完赛/退赛后 camFocusCar() 会切到未完赛的车；此时仪表盘应显示那台车的
  // 速度/档位/遥测，并打开入力回显（Input Telemetry Overlay）。
  const specCar = camFocusCar();
  const spectating = !!specCar && specCar !== car;
  const gCar = spectating ? specCar : car;
  // 观战入力回显：展示被观战车（或本地车在观战态）的实时输入。
  updateInputOverlay(spectating ? specCar : null);

  // ---- 车速数字：直接取底盘中心线速度模长（规格要求，严禁用车轮转速推算）----
  const speedMS = gCar.body.velocity.length();
  const speedKmh = Math.floor(speedMS * 3.6);          // 规格：Math.floor
  // ---- 环 + 指针 = 转速表（规格 §五.4：大号环形转速表）----
  const rpm = Math.min(gCar.rpm || 0, GAUGE.MAX_RPM);
  const needleDeg = needleAngle(rpm);
  if (speedo.needle) speedo.needle.style.transform = 'rotate(' + needleDeg.toFixed(2) + 'deg)';
  // 弧线走 SVG 极坐标空间（= css + 90）
  speedo.fill.setAttribute('d', arcPath(100, 100, speedo.R, GAUGE.polarStart, -90 + needleDeg));
  setTxt('spd', String(speedKmh));

  // 档位：直接用变速箱实际档位，不再按速度瞎猜
  setTxt('gear', gCar.forwardSpeed < -0.6 ? 'R' : String(gCar.gear + 1));

  // 计时：每圈用时 / 最佳单圈（规格 §五.2 圈速框）
  setTxt('curLapTime', fmtTime(gCar.lapTimeLive || 0));
  setTxt('bestLap', gCar.bestLap ? fmtTime(gCar.bestLap) : '--:--.---');
  const dirty = $('lapDirty');
  if (dirty) dirty.classList.toggle('hidden', !gCar.lapInvalid);
  setTxt('lapNum', String(Math.min(gCar.lap + 1, S.laps)));
  setTxt('lapTotal', String(S.laps));

  // 位置
  const order = standings();
  const myRank = order.findIndex((c) => c.id === car.id) + 1;
  setTxt('mapPos', 'P' + (myRank || 1));

  // ---- 圈速信息框第三行：累计惩罚（规格 §五.2："惩罚 +2.000"，橙红）----
  setTxt('lapPen', '+' + Math.max(0, gCar.penalty || 0).toFixed(3));

  // ---- 右下遥测：四轮胎温/磨损（按漂移强度与侧偏角模拟）----
  // 本作没有真正的轮胎热学模型，这里按"当前载荷/滑移"推一个 0..1 热度：
  // 冷蓝 -> 绿 -> 黄 -> 红。纯 HUD 可视化，不参与物理。
  {
    const heat = clamp(0.18 + (gCar.driftIntensity || 0) * 0.62 +
      Math.min(1, (gCar.slipAngleDeg || 0) / 30) * 0.34 +
      Math.min(1, Math.abs(gCar.forwardSpeed || 0) / 70) * 0.12, 0, 1);
    const col = (t) => {
      const h = (1 - t) * 55;                    // 55°(冷蓝) -> 0°(红)
      return 'hsl(' + h.toFixed(0) + ', 88%, ' + (34 + t * 22).toFixed(0) + '%)';
    };
    // 前轮偏转向、后轮偏驱动 -> 给一点前后差异，避免四个格子完全一样
    const skew = clamp(Math.abs(gCar.steerAngle || 0) / 0.5, 0, 1) * 0.14;
    setStyle('telFL', 'background', col(clamp(heat + skew, 0, 1)));
    setStyle('telFR', 'background', col(clamp(heat + skew, 0, 1)));
    setStyle('telRL', 'background', col(clamp(heat - skew, 0, 1)));
    setStyle('telRR', 'background', col(clamp(heat - skew, 0, 1)));
  }

  // ---- 挡位模式 + 油量条（规格 §五.4）----
  setTxt('gearMode', gCar.isLocal ? 'M' : 'A');
  {
    // 油量：满油起步，按"全油门时长"线性消耗（纯 HUD 观感，不影响动力）。
    if (S.fuel === undefined) S.fuel = 1;
    if (!car.finished) S.fuel = Math.max(0, S.fuel - hudDt * 0.0042 * clamp(car.input ? car.input.throttle : 0, 0, 1));
    setStyle('fuelBar', 'height', (S.fuel * 100).toFixed(1) + '%');
  }

  // 侧向 G 值（用 physics 里的 ayPrev 估计；1G = 9.81 m/s²）
  const gEl = $('gForce');
  if (gEl) {
    const latG = Math.abs(gCar.ayPrev || 0) / 9.81;
    setTxt('gForce', (latG >= 0.05 ? latG.toFixed(2) : '0.00') + ' G');
  }

  // 尾流 / 逆行提示：HUD 只给一行极简白灰文字，无闪烁大字、无彩色徽标
  const draftEl = $('draftText');
  if (draftEl) {
    const drafting = (car.slip || 0) > 0.15 && !car.finished;
    draftEl.classList.toggle('hidden', !drafting);
    if (drafting && !S.offline && S.net && !S._draftSent) { /* 预留：可用于统计 */ }
  }
  $('wrongWay').classList.toggle('hidden', !car.wrongWay);

  // ---- 左上角计时塔（规格 §6.2）----
  // 联网时**必须**用服务端权威榜单：只有它知道每个人的过线时刻，才能给出
  // 「与 P1 的总差距 / 与前一位的间隔差」。客户端只有本地位姿，自己算不出来。
  // 离线单机没有服务端，才回落到本地 progressScore 排序，秒差列显示占位。
  //
  // ── 符号约定（与服务端 solveDeltaMs / C++ RaceDeltaTracker 严格一致）────────
  // 服务端下发的 gap/int/behind **都是带符号值，>0 = 该车领先被比较者**。
  // 渲染规则（规格 §7.1）：
  //   · 第一行（本地=P1）        -> "LEADER"，并在副行显示对 P2 的优势
  //   · 落后一律显示负号          -> "-0.X" / "-X.XX"（1~2 位小数）
  //   · 后车行（本地 P1 时的 P2~P4）-> 同样负数格式，用 behind 翻符号
  // 格式化函数 fmtDelta 是**唯一**的负号来源，任何渲染分支都不得再自行取反。
  const list = $('standList');
  const ORD = ['1st', '2nd', '3rd', '4th'];
  const num1 = (v) => typeof v === 'number' && isFinite(v);
  const timingDue = !S._timingNextAt || now >= S._timingNextAt;
  if (timingDue) S._timingNextAt = now + 250;       // 4Hz 文本刷新，避免逐帧跳字
  if (!S._gapSmooth) S._gapSmooth = new Map();
  const smoothDelta = (key, value) => {
    if (!num1(value)) {
      S._gapSmooth.delete(key);
      return value;
    }
    if (!timingDue) return S._gapSmooth.has(key) ? S._gapSmooth.get(key) : value;
    const prev = S._gapSmooth.get(key);
    // 直接用目标值当 EMA 初值：起步瞬间第一次拿到有效秒差时，
    // 不要从 0 开始"滑"上去——那一下就是用户看到的"乱跳几百秒"。
    const next = num1(prev) ? prev * 0.72 + value * 0.28 : value;
    S._gapSmooth.set(key, next);
    return next;
  };

  // 规格要求的时差文本：落后一律负号，1~2 位小数（<10s 一位，>=10s 两位）。
  // signed：>0 领先、<0 落后。本函数只负责"把带符号数值变成规格文本"。
  const fmtDelta = (v) => {
    if (!num1(v)) return '—';
    const a = Math.abs(v);
    // Defensive display guard: stale/corrupt progress must never paint a
    // "thousands of seconds" gap. The server rejects the same values, but a
    // mixed-version client can still receive an old packet.
    if (a > 600) return '—';
    const dec = a >= 10 ? 2 : 1;
    const s = a.toFixed(dec);
    return v < 0 ? '-' + s : '+' + s;
  };
  // ★ 规格 §7.1 时差列渲染器：唯一的"相对本地玩家 / 相对第一名"规则入口。
  //   delta 契约：**signed，>0 = 该车领先本地玩家**（与服务端每车 delta 一致）。
  //   isLocalRow 由调用方按 id 判定（联网是 e.id === S.localId，离线是 c === 本车）。
  //   isP1：该行是不是榜单第一名（i === 0）。
  //   返回 HTML 字符串（含 <span class="gap">）。第一行 / 本地行一律 "--"。
  const renderGap = (isP1, isLocalRow, delta, isLocalP1) => {
    // 第一行：本地玩家是 P1 时固定 "--"；否则显示"与第一名的差距" —— 用调用方传来的
    // **该车相对本地玩家**的带符号 delta（>0 = 该车领先我）直接格式化：
    // 我落后 ⇒ delta>0 ⇒ "+xx"（第一名领先我这么多秒）。
    if (isP1) {
      if (isLocalP1) return '<span class="gap leader me-lead">--</span>';
      if (!num1(delta)) return '<span class="gap leader">LEADER</span>';
      // ★ 用户报障（"第一名一直显示 -xx 秒"）：字段契约是 **delta > 0 = 该车领先本地玩家**
      //   （见上面的调用方注释与服务端 delta 定义）。领跑者领先我 ⇒ delta > 0 ⇒ 应显示 "+xx"，
      //   旧代码多取了一次负号，于是"我落后时第一名显示负数"，方向正好反了。
      return '<span class="gap leader">' + fmtDelta(delta) + 's</span>';
    }
    // 第二行及之后：统一相对本地玩家。
    if (isLocalRow) return '<span class="gap me-row">--</span>';
    if (!num1(delta)) return '<span class="gap">—</span>';
    return '<span class="gap">' + fmtDelta(delta) + 's</span>';
  };

  // 本地玩家相对 P1 的总差（signed，>0 = 本地玩家领先 P1，通常 <= 0）。
  // 仅用于旧协议兼容折算；新协议各车直接带 delta 字段。
  const localGapToP1 = (() => {
    if (!Array.isArray(S.lb) || !S.lb.length) return 0;
    const me = S.lb.find((x) => x.id === S.localId);
    return me && num1(me.gap) ? me.gap : 0;
  })();

  let rows;
  if (Array.isArray(S.lb) && S.lb.length) {
    // 本地玩家是不是 P1（用于第一行 "--" 规则）
    const localIsP1 = S.lb.length > 0 && S.lb[0].id === S.localId;
    rows = S.lb.map((e, i) => ({
      id: e.id, name: e.name, color: e.color, fin: !!e.fin, rk: i + 1,
      // 处罚列：橙黄色块 = 累计罚时 + 违规次数（规格 §五.1 第四列）
      pen: finiteNum(e.pen) > 0.05
        ? '<span class="pen hit">+' + safeFixed(e.pen, 2) + '<i>' + (e.vio || 0) + '</i></span>'
        : '<span class="pen">—</span>',
      lapTxt: e.fin ? '完赛' : (Math.min(e.lap + 1, S.laps) + '/' + S.laps),
      dnf: !!e.dnf || !!e.retired,
      // ★ 时差列：服务端每车下发 delta（signed，>0 = 该车领先本地玩家），
      //   交给 renderGap 统一渲染（第一行 "--" / 落后第一名负数 / 相对本地玩家）。
      //   兼容旧协议：若无 delta 字段，用 gap（相对 P1 总差，signed>0=领先P1）折算 ——
      //   该车相对本地玩家 = (该车相对P1) - (本地玩家相对P1)。
      gap: renderGap(i === 0, e.id === S.localId,
        smoothDelta('lb:' + e.id,
          num1(e.delta) ? e.delta
            : (num1(e.gap) ? e.gap - localGapToP1 : undefined)),
        localIsP1),
    }));
  } else {
    // 离线单机没有服务端权威秒差，但**不能空着不显示**（之前这里写的是占位"离线单机"，
    // 看起来就像"时间差距坏了"）。本地自己换算：
    //   progressScore 的距离项单位≈米 -> 落后米数 / 参考车速 = 落后秒数。
    // 参考车速取**前车（领跑者）**车速 —— 与服务端 solveDeltaMs 的口径一致
    // （下限 12m/s，避免起步时除出天文数字）。
    // 符号：本地自己排；score 大者领先，所以"差值为负 = 我落后"。
    const ref = Math.max(Math.abs(order[0] ? order[0].forwardSpeed : 0), 12);
    // 本地玩家在离线排序中的位置（用于 "--" 规则）
    const localIdx = order.findIndex((c) => c.id === S.localId);
    const localIsP1Off = localIdx === 0;
    rows = order.map((c, i) => {
      // 相对本地玩家的带符号差（>0 = 本车领先本地玩家）——与联网 delta 同契约。
      // ★ 规格 §任务3：时差列只认"相对本地玩家"，**不再**计算"与前一名 gAhead"。
      const gLocal = (progressScore(c) - progressScore(order[localIdx])) / ref;
      return {
        id: c.id, name: c.name, color: c.color, fin: !!c.finished, rk: i + 1,
        pen: finiteNum(c.penalty) > 0.05
          ? '<span class="pen hit">+' + safeFixed(c.penalty, 2) + '<i>' + (c.violations || 0) + '</i></span>'
          : '<span class="pen">—</span>',
        lapTxt: c.finished ? '完赛' : (Math.min(c.lap + 1, S.laps) + '/' + S.laps),
        dnf: !!c.retired,
        gap: renderGap(i === 0, c.id === S.localId,
          smoothDelta('off:' + c.id, gLocal), localIsP1Off),
      };
    });
  }
  // 计时塔保持最多四行：前四名时展示前四，末四名时展示末四，中段展示
  // 领跑者与本地车周围的相对位置。人数少于四人时完整显示。
  if (rows.length > 4) {
    const meRow = rows.findIndex((r) => r.id === S.localId);
    let indices;
    if (meRow < 0 || meRow < 4) {
      indices = [0, 1, 2, 3];
    } else if (meRow === rows.length - 1) {
      // 末名也保留前两名，剩余两行给自己与前车，避免只看到车尾局部。
      indices = [0, 1, rows.length - 2, rows.length - 1];
    } else if (meRow >= rows.length - 4) {
      indices = [rows.length - 4, rows.length - 3, rows.length - 2, rows.length - 1];
    } else {
      indices = [0, meRow - 1, meRow, meRow + 1];
    }
    rows = indices.sort((a, b) => a - b).map((i) => rows[i]);
  }
  // 4 列：名次（+领先者王冠）/ 车手名+配色块 / 时间差距 / 处罚 / 🔧
  // 规格 §五.1：名次后带**王冠**（仅第一名）、自己的车**蓝色高亮**、
  // 时差带 +/-s（由 renderGap 统一格式化）、处罚是**橙红色块**、
  // 末列是 🔧（该车是否已退赛/DNF —— 维修区图标）。
  const html = rows.map((r) =>
    '<div class="st-row' + (r.id === S.localId ? ' me' : '') + (r.fin ? ' fin' : '') + '" title="' + r.lapTxt + '">' +
    '<span class="rk">' + r.rk + (r.rk === 1 ? '<i class="crown" title="领先">&#128081;</i>' : '') + '</span>' +
    '<span class="nm"><span class="dot" style="background:' + esc(r.color) + '"></span>' + esc(r.name) + '</span>' +
    r.gap + r.pen +
    '<span class="wr">' + (r.dnf ? '&#128295;' : '') + '</span>' +
    '</div>').join('');
  if ((timingDue || !list._h) && list._h !== html) { list._h = html; list.innerHTML = html; }
  setTxt('twHdr', rows.length + ' 玩家');

  // 观战面板
  const spec = $('spectate');
  const settlementOpen = $('settlement') && !$('settlement').classList.contains('hidden');
  if (!settlementOpen && (car.finished || S.mode === 'end')) {
    spec.classList.remove('hidden');
    const rest = S.rp.cars.filter((c) => !c.finished && !c.retired);
    $('specList').innerHTML = rest.length
      ? rest.map((c) => '<div class="spec-row' + (c.id === S.spectateId ? ' on' : '') + '">' +
        '<span class="dot" style="background:' + c.color + '"></span>' + esc(c.name) +
        '　第 ' + Math.min(c.lap + 1, S.laps) + ' 圈　' + fmtTime(c.lapTimeLive || 0) + '</div>').join('')
      : '<div class="spec-row">全部车辆已完赛</div>';
  } else {
    spec.classList.add('hidden');
  }
}

/**
 * 绝对赛道进程坐标（**单位：米**）。分高者在前。
 *
 * ── 为什么必须是米，而不是"序号加权"（2026-09-29 修正）────────────────────────
 * 旧实现按规格写成 `lap*100000 + cpIdx*1000 − 与下一个 CP 的距离`：
 *   · 排序用途没问题（1000 > CP 间距，CP 索引永远压过距离项）；
 *   · 但离线 HUD 的秒差列是 `(score(他) − score(我)) / 参考车速` ——
 *     它**假设 score 的单位是米**。于是只要两车跨在一个 Checkpoint 边界两侧，
 *     差值里就凭空多出 1000（≈281m 的真实距离被说成 1000m），除以起步阶段
 *     12m/s 的下限参考车速 => **+83 秒**；跨 2~4 个 CP 就是"刚起步跳几百秒"。
 *     这正是用户报的"左上角时间差乱跳"。而且 0.72/0.28 的 EMA 平滑会把这
 *     83 秒的台阶抹成一串乱跳的数字，看起来更不像话。
 *
 * 正解：改用**沿中心线的连续弧长坐标**。赛道采样（`resampleClosed`）是**等弧长**的，
 * 所以弧长 = 采样序号 × spacing；跨圈项用**几何压线次数** `c.lineCross`
 * （physics 的 groundConstraint 里按 …N-1 → 0 的索引回绕计数，正反向对称），
 * 而不是 `c.lap`（后者要集齐全部 Checkpoint 才 +1）。
 *
 * ⚠️ 为什么不能用 `lap`：车辆刚越过起终点线时 `trackIdx` 从 ~N-1 跳到 ~0，
 * 而 `lap` 仍要等集齐全部 CP 才 +1 ⇒ 坐标瞬间"后退一整圈"
 * （6755m ÷ 起步 12m/s ≈ **几百秒**），排位也会短暂倒置 —— 这正是用户报的
 * "刚起步就能跳几百的时间差 / 乱跳"。`lineCross` 在发车压线的那一刹那 +1，
 * 坐标因此**连续**，排序与"米差 ÷ 车速 = 秒差"两个用途同时成立。
 */
function progressScore(c) {
  const t = track;
  // 只允许**米**：赛道几何齐全时 = 压线次数×全长 + 弧长；几何缺失时退化为 0
  // （绝不再回落到"序号加权"—— 那会让同一段代码在缺几何时又开始产出假秒差）。
  const L = (t && t.length > 0) ? t.length : 0;
  const n = (t && t.count > 0) ? t.count : 0;
  const sp = (t && t.spacing > 0) ? t.spacing : (n > 0 && L > 0 ? L / n : 0);
  if (!L || !sp) {
    if (!S._progScoreWarned) {
      S._progScoreWarned = true;
      console.warn('[progressScore] 赛道几何缺失（length/spacing），进程坐标退化为 0 —— '
        + '此时秒差列不可信；正常情况下 track 已构建，不该走到这里');
    }
    return 0;
  }
  const idx = Math.max(0, Math.min(n - 1, c.trackIdx | 0));
  // lineCross 由 physics 维护；老快照/测试桩没有该字段时回落 lap（只影响排序粒度）
  const ord = (typeof c.lineCross === 'number') ? c.lineCross : Math.max(0, c.lap | 0);
  return routeProgress(c, t) * L;
}

function standings() {
  return S.rp.cars.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.totalTime - b.totalTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return progressScore(b) - progressScore(a);   // 实时动态重排
  });
}

const PEN_NAME = { offtrack: '驶离赛道', cut: '切弯', ram: '恶意撞击', collision: '碰撞', wall: '撞击护栏', shortcut: '抄近道', rescue: '救援复位', frr_gain: '离开赛道获利' };

/* --------------------------- 窗口尺寸（已移除屏幕速度线） --------------------------- */
/* FM8 规格：严禁任何屏幕白线 / 漫画速度线 / 气流贴图。
 * 速度感完全由两件事提供：① FOV 60->72 的透视展开；② 路面纹理的高频后退。
 * 这里只保留窗口尺寸变化时的相机与渲染器同步。 */
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

/* ========================================================================== */
/* 10.5 漂移特效：轮胎烟雾 + 动态胎痕                                          */
/*      全部为纯代码生成（CanvasTexture 光斑 + 自写 GLSL），零外部贴图。        */
/* ========================================================================== */

/** 代码绘制的柔和圆形光斑，作为烟雾粒子精灵（唯一一张"贴图"，运行时生成） */
function makeSmokeSprite(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.62)');
  grd.addColorStop(0.72, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

const SMOKE_VS = `
  attribute float aAlpha;
  attribute float aSize;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (340.0 / max(-mv.z, 0.5));
    gl_Position = projectionMatrix * mv;
  }`;

const SMOKE_FS = `
  uniform sampler2D uTex;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    if (vAlpha <= 0.003) discard;
    vec4 t = texture2D(uTex, gl_PointCoord);
    float a = t.a * vAlpha;
    if (a <= 0.005) discard;
    gl_FragColor = vec4(vColor, a);
  }`;

/** 烟雾粒子池：固定 200 个点，环形复用，零 GC */
class SmokeSystem {
  constructor(scene, max = 200) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.cursor = 0;
    this.alive = 0;

    const geo = new THREE.BufferGeometry();
    const mk = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', mk(this.pos, 3));
    geo.setAttribute('aColor', mk(this.col, 3));
    geo.setAttribute('aAlpha', mk(this.alpha, 1));
    geo.setAttribute('aSize', mk(this.size, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: makeSmokeSprite(64) } },
      vertexShader: SMOKE_VS,
      fragmentShader: SMOKE_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    this.geo = geo;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 9;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, col, size, life) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const o = i * 3;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
    this.col[o] = col.r; this.col[o + 1] = col.g; this.col[o + 2] = col.b;
    this.alpha[i] = 0.62;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt) {
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) { this.alpha[i] = 0; this.size[i] = 0; }
        continue;
      }
      alive++;
      this.life[i] -= dt;
      const o = i * 3;
      // 向上膨胀 + 快速阻尼（模拟尾流消散）
      this.vel[o + 1] += 1.15 * dt;
      const dmp = Math.exp(-2.1 * dt);
      this.vel[o] *= dmp; this.vel[o + 1] *= dmp; this.vel[o + 2] *= dmp;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;

      const k = Math.max(0, this.life[i] / this.maxLife[i]);   // 1 -> 0
      this.size[i] += (2.6 - this.size[i]) * (1 - Math.exp(-1.6 * dt)) * 2;
      this.alpha[i] = 0.62 * k * k;                            // 透明度随生命周期衰减到 0
    }
    this.alive = alive;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}

const SKID_VS = `
  attribute float aAlpha;
  varying float vA;
  void main() {
    vA = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const SKID_FS = `
  varying float vA;
  void main() {
    if (vA <= 0.004) discard;
    gl_FragColor = vec4(0.025, 0.024, 0.028, vA);
  }`;

/** 胎痕池：固定 900 个四边形（每条胎痕段一个），环形复用，8 秒后渐隐销毁 */
class SkidMarks {
  constructor(scene, maxQuads = 900) {
    this.max = maxQuads;
    this.pos = new Float32Array(maxQuads * 4 * 3);
    this.alpha = new Float32Array(maxQuads * 4);
    this.birth = new Float32Array(maxQuads).fill(-1e9);
    this.cursor = 0;
    this.life = 8.0;      // 保留 8 秒
    this.fade = 2.0;      // 最后 2 秒渐隐

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint16Array(maxQuads * 6);
    for (let q = 0; q < maxQuads; q++) {
      const b = q * 4;
      const o = q * 6;
      idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
      idx[o + 3] = b + 1; idx[o + 4] = b + 3; idx[o + 5] = b + 2;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      vertexShader: SKID_VS,
      fragmentShader: SKID_FS,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,       // 双面，省去绕序判断
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
  }

  /** 用 4 个角点写入一段胎痕（两端各 2 点），返回是否成功 */
  addQuad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, now) {
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const o = q * 12;
    this.pos[o] = ax; this.pos[o + 1] = ay; this.pos[o + 2] = az;
    this.pos[o + 3] = bx; this.pos[o + 4] = by; this.pos[o + 5] = bz;
    this.pos[o + 6] = cx; this.pos[o + 7] = cy; this.pos[o + 8] = cz;
    this.pos[o + 9] = dx; this.pos[o + 10] = dy; this.pos[o + 11] = dz;
    const b = q * 4;
    this.alpha[b] = this.alpha[b + 1] = this.alpha[b + 2] = this.alpha[b + 3] = 0.42;
    this.birth[q] = now;
  }

  update(now) {
    for (let q = 0; q < this.max; q++) {
      if (this.birth[q] < -1e8) continue;
      const age = now - this.birth[q];
      let a;
      if (age >= this.life) {
        a = 0;
        this.birth[q] = -1e9;
      } else {
        a = 0.42 * clamp((this.life - age) / this.fade, 0, 1);
      }
      const b = q * 4;
      this.alpha[b] = this.alpha[b + 1] = this.alpha[b + 2] = this.alpha[b + 3] = a;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  /** 换赛道时清空全部胎痕（旧坐标在新赛道上没有意义） */
  reset() {
    this.birth.fill(-1e9);
    this.alpha.fill(0);
    this.cursor = 0;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

/** 漂移 FX 总控：根据 physics 给出的 drifting / driftIntensity 生成烟雾与胎痕 */
class DriftFX {
  constructor(scene) {
    this.smoke = new SmokeSystem(scene, 200);       // 规格：200 个烟雾粒子池
    this.marks = new SkidMarks(scene, 900);
    this.emitter = new Map();                        // carId -> {accL, accR, lastL, lastR, markT}
    this._p = new THREE.Vector3();
    this._q = new THREE.Vector3();
    this.smokeColor = new THREE.Color(0xdadada);     // 沥青上：灰白烟
    this.dustColor = new THREE.Color(0xb9a17a);      // 草地上：土黄扬尘
  }

  slot(id) {
    let e = this.emitter.get(id);
    if (!e) {
      e = { accL: 0, accR: 0, lastL: null, lastR: null, markT: 0 };
      this.emitter.set(id, e);
    }
    return e;
  }

  /** 单侧后轮：生成烟雾 + 连续胎痕 */
  emit(car, side, e, key, dt) {
    const p = car.rearContactPoint(side, this._p);
    const gy = p.y;
    const onGrass = car.surface === 2;
    const vel = car.vel;

    // ---- 烟雾：按强度累积发射（强度 1 时约 55 粒/秒/轮）----
    const rate = 55 * car.driftIntensity;
    const prev = key === 'L' ? e.accL : e.accR;
    let acc = prev + rate * dt;
    const n = Math.min(4, Math.floor(acc));
    acc -= n;
    if (key === 'L') e.accL = acc; else e.accR = acc;
    for (let i = 0; i < n; i++) {
      const jx = (Math.random() - 0.5) * 0.5;
      const jz = (Math.random() - 0.5) * 0.5;
      this.smoke.spawn(
        p.x + jx, gy + 0.12 + Math.random() * 0.12, p.z + jz,
        vel.x * 0.16 + (Math.random() - 0.5) * 1.4,
        0.75 + Math.random() * 0.9,
        vel.z * 0.16 + (Math.random() - 0.5) * 1.4,
        onGrass ? this.dustColor : this.smokeColor,
        0.5 + Math.random() * 0.35,
        0.6                                        // 规格：寿命 0.6 秒
      );
    }

    // ---- 胎痕：每 0.05s 铺一段 ----
    const last = key === 'L' ? e.lastL : e.lastR;
    const now = performance.now() / 1000;
    if (e.markT <= 0 && !onGrass) {
      const q = this._q.copy(car.rightSide).multiplyScalar(0.17);   // 半宽 0.17m
      if (last && last.distanceToSquared(p) < 64) {
        this.marks.addQuad(
          last.x - q.x, last.y + 0.02, last.z - q.z,
          last.x + q.x, last.y + 0.02, last.z + q.z,
          p.x - q.x, gy + 0.02, p.z - q.z,
          p.x + q.x, gy + 0.02, p.z + q.z,
          now
        );
        if (key === 'L') e.lastL = p.clone(); else e.lastR = p.clone();
      } else {
        if (key === 'L') e.lastL = p.clone(); else e.lastR = p.clone();
      }
    }
  }

  resetCar(id) {
    const e = this.emitter.get(id);
    if (!e) return;
    e.lastL = null;
    e.lastR = null;
    e.accL = 0;
    e.accR = 0;
    e.markT = 0;
  }

  /**
   * 一次性补一批粒子 + 一段胎痕。
   * 正常比赛不使用，供 ?drift=1 演示模式与无头截图验收使用
   * （无头浏览器每帧间隔极长，靠逐帧累积永远看不到效果）。
   */
  burst(car, n = 30) {
    const onGrass = car.surface === 2;
    const col = onGrass ? this.dustColor : this.smokeColor;
    for (let i = 0; i < n; i++) {
      const side = (i % 2) ? 1 : -1;
      car.rearContactPoint(side, this._p);
      this.smoke.spawn(
        this._p.x + (Math.random() - 0.5) * 0.9,
        this._p.y + 0.1 + Math.random() * 0.5,
        this._p.z + (Math.random() - 0.5) * 0.9,
        car.vel.x * 0.18 + (Math.random() - 0.5) * 1.6,
        0.8 + Math.random() * 1.2,
        car.vel.z * 0.18 + (Math.random() - 0.5) * 1.6,
        col,
        0.55 + Math.random() * 0.6,
        0.6
      );
    }
    // 胎痕：从两只后轮沿"车尾方向"各倒铺 5 段，形成明显拖痕
    if (!onGrass) {
      const now = performance.now() / 1000;
      const back = this._q.copy(car.fwd).multiplyScalar(-1.1);
      const sideQ = new THREE.Vector3().copy(car.rightSide).multiplyScalar(0.17);
      for (const side of [1, -1]) {
        car.rearContactPoint(side, this._p);
        const base = this._p.clone();
        for (let k = 0; k < 5; k++) {
          const p0 = base.clone().addScaledVector(back, k);
          const p1 = base.clone().addScaledVector(back, k + 1);
          this.marks.addQuad(
            p0.x - sideQ.x, p0.y + 0.02, p0.z - sideQ.z,
            p0.x + sideQ.x, p0.y + 0.02, p0.z + sideQ.z,
            p1.x - sideQ.x, p1.y + 0.02, p1.z - sideQ.z,
            p1.x + sideQ.x, p1.y + 0.02, p1.z + sideQ.z,
            now
          );
        }
      }
    }
    const e = this.slot(car.id);
    e.lastL = null;
    e.lastR = null;
  }

  update(dt, cars) {
    const now = performance.now() / 1000;
    for (const c of cars) {
      const active = c.drifting && c.driftIntensity > 0.02 && !c.airborne && c.speedKmh > 12;
      if (!active) { this.resetCar(c.id); continue; }
      const e = this.slot(c.id);
      e.markT = Math.max(0, e.markT - dt);
      const doMark = e.markT <= 0;
      this.emit(c, 1, e, 'L', dt);      // 左后轮
      this.emit(c, -1, e, 'R', dt);     // 右后轮
      if (doMark) e.markT = 0.05;       // 规格：每 0.05s 一段
    }
    this.smoke.update(dt);
    this.marks.update(now);
  }
}

let driftFX = null;

/* ========================================================================== */
/* 10.65 尾流涡线（Vortex Streamline Ribbons）                                 */
/*   规格 §6.2：吸尾流生效时，在**前车尾翼两侧端板**与**本车引擎盖两侧**       */
/*   生成跟随车身流动的半透明 3D 气流涡线。极细淡白、AdditiveBlending、        */
/*   透明度 0.25，沿气流方向高速翻滚衰减。                                    */
/*   刻意与"屏幕空间速度线"划清界限：这些是真实存在于 3D 世界里的几何体，      */
/*   会被透视、会被其它车遮挡 —— 而不是贴在屏幕上的白线。                      */
/* ========================================================================== */

const VORTEX_MAX = 128;    // 涡线段池：每段一个四边形（4 顶点）
const VORTEX_RATE = 420;   // 总发射速率 (段/s)，4 个发射点摊分（寿命 ~0.15s -> 常驻约 60 段）
class VortexFX {
  constructor(scene, max = VORTEX_MAX) {
    this.max = max;
    this.pos = new Float32Array(max * 4 * 3);
    this.alpha = new Float32Array(max * 4);
    this.ox = new Float32Array(max * 3);      // 发射点
    this.dir = new Float32Array(max * 3);     // 气流方向（单位向量）
    this.side = new Float32Array(max * 3);    // 绕气流轴翻滚的起始侧向量
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.len = new Float32Array(max);
    this.wid = new Float32Array(max);
    this.roll = new Float32Array(max);
    this.rollRate = new Float32Array(max);
    this.flow = new Float32Array(max);
    this.cursor = 0;
    this.emitAcc = 0;

    const geo = new THREE.BufferGeometry();
    const mk = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', mk(this.pos, 3));
    geo.setAttribute('aAlpha', mk(this.alpha, 1));
    const idx = new Uint16Array(max * 6);
    for (let i = 0; i < max; i++) {
      const v = i * 4, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xdfeaff) } },   // 极淡的冷白
      vertexShader: `
        attribute float aAlpha;
        varying float vA;
        void main(){
          vA = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vA;
        void main(){
          if (vA <= 0.002) discard;
          gl_FragColor = vec4(uColor, vA);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,        // 会被车身正常遮挡 —— 涡线是 3D 世界里的真实几何
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    scene.add(this.mesh);
  }

  /**
   * 发射一段涡线。
   * @param {number} speed 沿气流方向的流动速度 (m/s)，决定涡线翻滚的推进快慢
   */
  spawn(x, y, z, dx, dy, dz, sx, sy, sz, speed, age0 = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const o3 = i * 3;
    this.ox[o3] = x; this.ox[o3 + 1] = y; this.ox[o3 + 2] = z;
    this.dir[o3] = dx; this.dir[o3 + 1] = dy; this.dir[o3 + 2] = dz;
    this.side[o3] = sx; this.side[o3 + 1] = sy; this.side[o3 + 2] = sz;
    this.age[i] = age0;
    // 寿命短、流速低 -> 拖尾总长只有 2~5m，**贴在车身旁边**。
    // 这是必须的：追尾相机在车后 5.5m，如果按满车速向后拉出 20m 的尾巴，
    // 整条涡线都会跑到相机背后，屏幕上一个像素都看不到（实测 vortex=96 却全不可见）。
    this.life[i] = 0.10 + Math.random() * 0.10;
    this.len[i] = 0.7 + Math.random() * 0.9;
    this.wid[i] = 0.16 + Math.random() * 0.14;
    this.roll[i] = Math.random() * Math.PI * 2;
    this.rollRate[i] = (Math.random() < 0.5 ? -1 : 1) * (7 + Math.random() * 7);
    this.flow[i] = speed;
  }

  update(dt) {
    const P = this.pos, A = this.alpha;
    for (let i = 0; i < this.max; i++) {
      const v = i * 4;
      if (this.life[i] <= 0) {
        if (A[v] !== 0) { A[v] = A[v + 1] = A[v + 2] = A[v + 3] = 0; }
        continue;
      }
      this.age[i] += dt;
      const k = 1 - this.age[i] / this.life[i];
      if (k <= 0) { this.life[i] = 0; A[v] = A[v + 1] = A[v + 2] = A[v + 3] = 0; continue; }

      const o3 = i * 3;
      const dx = this.dir[o3], dy = this.dir[o3 + 1], dz = this.dir[o3 + 2];
      // 沿气流方向推进：越老跑得越远（高速向后翻滚的拖尾）
      const t = this.age[i] * this.flow[i];
      const cx0 = this.ox[o3] + dx * t;
      const cy0 = this.ox[o3 + 1] + dy * t;
      const cz0 = this.ox[o3 + 2] + dz * t;

      // 绕气流轴翻滚：把起始侧向量 s1 与正交的 s2 混合，等效于 s1 旋转 ang。
      // 这就是"涡线"的螺旋观感来源 —— 一条会自转的细带。
      const ang = this.roll[i] + this.age[i] * this.rollRate[i];
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const s1x = this.side[o3], s1y = this.side[o3 + 1], s1z = this.side[o3 + 2];
      const s2x = dy * s1z - dz * s1y;
      const s2y = dz * s1x - dx * s1z;
      const s2z = dx * s1y - dy * s1x;
      const nx = s1x * ca + s2x * sa;
      const ny = s1y * ca + s2y * sa;
      const nz = s1z * ca + s2z * sa;

      // 四边形：沿气流方向的短段 × 侧向宽度（段中心略向后偏，链条才连续）
      const hl = this.len[i] * 0.5, hw = this.wid[i] * 0.5;
      const cx = cx0 - dx * hl, cy = cy0 - dy * hl, cz = cz0 - dz * hl;
      const lx = dx * hl, ly = dy * hl, lz = dz * hl;
      const wx = nx * hw, wy = ny * hw, wz = nz * hw;
      P[v * 3] = cx + lx + wx; P[v * 3 + 1] = cy + ly + wy; P[v * 3 + 2] = cz + lz + wz;
      P[v * 3 + 3] = cx + lx - wx; P[v * 3 + 4] = cy + ly - wy; P[v * 3 + 5] = cz + lz - wz;
      P[v * 3 + 6] = cx - lx - wx; P[v * 3 + 7] = cy - ly - wy; P[v * 3 + 8] = cz - lz - wz;
      P[v * 3 + 9] = cx - lx + wx; P[v * 3 + 10] = cy - ly + wy; P[v * 3 + 11] = cz - lz + wz;

      // 规格：透明度 0.25；段首浓、段尾更淡 -> 细长渐变的撕裂感
      const a = 0.25 * k * k;
      A[v] = A[v + 1] = a;
      A[v + 2] = A[v + 3] = a * 0.35;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  /** 当前存活段数（调试读数用） */
  aliveCount() {
    let n = 0;
    for (let i = 0; i < this.max; i++) if (this.life[i] > 0) n++;
    return n;
  }

  clear() { this.life.fill(0); this.alpha.fill(0); }
}

let vortexFX = null;

/** 吸尾流时只在「本车引擎盖两侧」发射涡线，前车保持干净尾部。 */
/* ---------------------------------------------------------------------------
 * 车手名牌（DOM 投影，2026-09-30 用户要求）
 *   · 只显示**一定范围内最近的 4 名**其他玩家（按与摄像机的距离）；
 *   · 锚点在车顶上方 2.4m；屏幕再上抬 10px ⇒ 名牌与车身之间有可见空隙；
 *   · 超出范围 / 在相机背后 / 屏幕外 → 直接隐藏；
 *   · 只在比赛态显示（大厅/结算不显示）。
 * 为什么用 DOM 而不是 Sprite：文字更锐利、无需纹理内存，且天然参与 CSS 主题。
 * ------------------------------------------------------------------------- */
const NAMEPLATE_MAX = 4;              // 用户指定：最近 4 名
const NAMEPLATE_RANGE = 220;          // 显示范围（米）
const _npV = new THREE.Vector3();
function updateNameplates() {
  window.__npCalls = (window.__npCalls || 0) + 1;
  const box = document.getElementById('nameplates');
  if (!box) { window.__npNoBox = (window.__npNoBox || 0) + 1; return; }
  const show = (S.mode === 'race' || S.mode === 'end') && S.rp && S.rp.cars.length > 0;
  if (!show) { if (box.childElementCount) box.innerHTML = ''; return; }

  // 1) 选最近 4 名（不含自己），按**与本车的距离**排序
  //   ⚠️ 不能用"与摄像机的距离"：相机在车后 8m 且会因视角/观战切换而远离，
  //      判据会随之漂移（实测探针里相机与本车相距 600m+ 时判据完全失效）。
  //      "一定范围内最近的四名玩家"在语义上就是离**我**最近的四名。
  const me = S.localCar;
  if (!me) { if (box.childElementCount) box.innerHTML = ''; return; }
  // ⚠️ 用**视觉位置**（vis.position，已做子步插值）而不是物理位置 c.pos：
  //    物理是固定 60Hz 子步，位置每 1~2 帧才跳一次；标签若跟物理位置就会
  //    "车体平滑、标签一跳一跳"（用户报的"连同车上面的标签也会抖动"正是这个）。
  const list = [];
  for (const c of S.rp.cars) {
    if (c.id === S.localId) continue;
    const vis = carVisuals.get(c.id);
    const pos = vis ? vis.position : c.pos;
    const d = pos.distanceTo(me.pos);
    if (d > NAMEPLATE_RANGE) continue;
    list.push({ c, d, pos });
  }
  list.sort((a, b) => a.d - b.d);
  const pick = list.slice(0, NAMEPLATE_MAX);
  // 自己的幽灵原因也固定在车顶，保持对手最近四名的选择口径。
  if (me.ghostReasonCode && (me.ghost || me.finishGhost || me.rescueGhost)) {
    pick.push({c:me,d:0,pos:carVisuals.get(me.id)?.position || me.pos});
  }

  // 2) 池化 DOM：不足则补、多余则藏
  while (box.childElementCount < pick.length) {
    const d = document.createElement('div');
    d.className = 'nplate';
    box.appendChild(d);
    const name = document.createElement('span');
    name.className = 'np-name';
    const gap = document.createElement('span');
    gap.className = 'np-gap';
    const reason = document.createElement('span');
    reason.className = 'np-reason';
    d.appendChild(name); d.appendChild(gap); d.appendChild(reason);
    d._name = name; d._gap = gap; d._reason = reason;
  }
  const kids = box.children;

  // 3) 逐个投影
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    const it = pick[i];
    if (!it) { el.style.display = 'none'; continue; }
    const c = it.c;
    _npV.set(it.pos.x, it.pos.y + 2.4, it.pos.z);    // 车顶上方 2.4m（用插值后的视觉位置）
    _npV.project(camera);
    const behind = _npV.z > 1;
    if (behind) { el.style.display = 'none'; continue; }
    const vw = renderer.domElement.clientWidth, vh = renderer.domElement.clientHeight;
    const x = (_npV.x * 0.5 + 0.5) * vw;
    const y = (-_npV.y * 0.5 + 0.5) * vh - 10;       // 屏幕再上抬 10px ⇒ 与车身留空隙
    if (x < -80 || x > vw + 80 || y < -40 || y > vh + 40) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.left = x.toFixed(1) + 'px';
    el.style.top = y.toFixed(1) + 'px';
    // 距离淡出（越远越淡，但不至于消失）
    const fade = clamp(1 - (it.d / NAMEPLATE_RANGE) * 0.65, 0.35, 1);
    el.style.opacity = fade.toFixed(2);
    el.style.borderLeftColor = c.color || '#fff';
    if (el._name.textContent !== c.name) el._name.textContent = c.name;
    el._name.style.display = c.isLocal ? 'none' : '';
    const reasons = ['', '被套圈', '逆向行驶', '失控回正', '复位保护', '已完赛'];
    const reason = (c.ghost || c.finishGhost || c.rescueGhost) ? reasons[c.ghostReasonCode] || '' : '';
    el._reason.textContent = reason;
    el._reason.style.display = reason ? '' : 'none';
    // 与本地玩家的秒差：口径与计时塔一致（>0 = 该车领先我），用同一套 progressScore
    // 距离项 / 参考车速折算；算不出就不显示（宁缺勿错）。
    let txt = '';
    if (S.localCar && typeof progressScore === 'function') {
      const ref = Math.max(Math.abs(c.forwardSpeed || 0), 12);
      const g = (progressScore(c) - progressScore(S.localCar)) / ref;
      if (isFinite(g) && Math.abs(g) < 600) {
        txt = (g >= 0 ? '+' : '-') + Math.abs(g).toFixed(1);
        // 在我后面（g<0）的名牌整体淡一点，减少对前方视野的干扰
        el.classList.toggle('np-behind', g < 0);
      }
    }
    if (el._gap.textContent !== txt) el._gap.textContent = txt;
    el._gap.style.display = txt && !c.isLocal ? '' : 'none';
  }
}

function updateVortex(dt) {
  if (!vortexFX) return;
  vortexFX.update(dt);
  const car = S.localCar;
  const demo = !!S.demoDraft;
  // 演示模式（?draft=1）强制常亮：无头浏览器一帧要等几十秒，
  // 靠真实吸尾流条件去凑是截不到图的（与 ?drift=1 / ?rescue=1 同一套路）。
  if (!demo && (!car || !S.rp || (car.slip || 0) <= 0.15 || car.speedKmh < 25)) return;
  if (!car) return;
  // 涡线沿气流方向的推进速度刻意**远低于车速**：这样拖尾只有 2~5m，
  // 落在追尾相机的可见范围内。取满车速会让涡线全部跑到相机身后。
  const speed = demo ? 26 : clamp(car.speed * 0.55, 14, 30);
  // 将一个车体局部偏移点换算到世界坐标，并在那里发射一段涡线。
  // 尾流源车与本车各自使用自己的车头方向，避免弯道中把气流错误地锁在本车航向上。
  const emit = (b, xOff, yOff, zOff, age0, speedScale = 1) => {
    const bf = b.fwd;
    const bp = b.pos;
    const bup = b.up;
    const sideDir = b.lateralDir;
    const px = bp.x + sideDir.x * xOff + bup.x * yOff + bf.x * zOff;
    const py = bp.y + sideDir.y * xOff + bup.y * yOff + bf.y * zOff;
    const pz = bp.z + sideDir.z * xOff + bup.z * yOff + bf.z * zOff;
    const bSpeed = demo ? speed : clamp((b.speed || car.speed) * 0.55, 14, 30);
    vortexFX.spawn(px, py, pz, -bf.x, -bf.y, -bf.z,
      bup.x, bup.y, bup.z, bSpeed * speedScale, age0);
  };

  if (demo) {
    // 一次性把整条涡线拖尾铺满（随机年龄 -> 立刻看到完整形态，而不是等它长出来）
    for (let i = 0; i < VORTEX_MAX; i++) {
      const side = i % 2 ? 1 : -1;
      const age0 = Math.random() * 0.20;
      emit(car, 0.95 * side, 0.30, 1.30, age0);
    }
    return;
  }

  const source = car.slipFrom && S.rp && S.rp.byId ? S.rp.byId.get(car.slipFrom) : null;
  const strength = clamp(car.slip || 0, 0, 1);
  vortexFX.emitAcc += dt * VORTEX_RATE * (source ? (0.35 + strength * 0.65) : 1);
  while (vortexFX.emitAcc >= 1) {
    vortexFX.emitAcc -= 1;
    const side = Math.random() < 0.5 ? 1 : -1;
    if (source && Math.random() < 0.72) {
      // 前车尾翼端板是尾流的物理来源；本车车头只保留少量卷入气流，
      // 两个发射层叠加后能看出气流从前车尾部被本车吸入，而不是凭空从车头冒出。
      emit(source, 0.92 * side, 0.30, -1.35, 0, 0.92);
    } else {
      emit(car, 0.78 * side, 0.24, 1.08, 0, 0.78);
    }
  }
}

/* ========================================================================== */
/* 10.7 动态最佳走线：按物理极限通过速度实时着色                                */
/*      v_max = sqrt(mu · g · R)   （R = 该节点曲率半径）                       */
/*      再按制动距离把"该点的极限"反推成"当前位置允许的车速"：                  */
/*          v_allow = sqrt(v_max² + 2·a·d)                                     */
/*      与玩家当前车速比较 -> 绿(可全油门) / 黄(需收油) / 红(必须重刹)          */
/* ========================================================================== */

const LINE_SAFE = [0.00, 1.00, 0.00];    // #00ff00
const LINE_WARN = [1.00, 1.00, 0.00];    // #ffff00
const LINE_OVER = [1.00, 0.00, 0.20];    // #ff0033
const LINE_IDLE = [0.30, 0.30, 0.34];    // 未激活（玩家后方 / 关闭时）
let lineTick = 0;

function updateRacingLine(dt) {
  const rl = track && track.raceLine;
  if (!rl || !rl.active) return;
  const car = S.localCar;
  if (!car || !S.rp) return;
  lineTick += dt;
  if (lineTick < 1 / 30) return;         // 30Hz 刷新足够，省 CPU
  lineTick = 0;

  const col = rl.colorAttr.array;
  const N = rl.count;
  const recent = rl._recentColor || (rl._recentColor = new Float32Array(N * 3));
  const mu = CFG.GRIP_ROAD;
  const decel = 14.0;                    // 可用制动减速度 m/s²（保守值）
  const vNow = car.body.velocity.length();
  const iNow = track.nearest(car.pos.x, car.pos.z, car.trackIdx);
  const lookSamples = Math.max(8, Math.round(220 / rl.spacing));   // 前视 220m
  const span = lookSamples * rl.spacing;

  for (let k = 0; k < N; k++) {
    const o = k * 6;
    const ahead = ((k - iNow + N) % N) * rl.spacing;
    const behind = ((iNow - k + N) % N) * rl.spacing;
    let r, g, b;
    if (ahead < span) {
      const vMax = rl.vTarget?.[k] || Math.sqrt(mu * 9.81 * Math.max(rl.radius[k], 15));
      // 从该点倒推：当前位置最多能有多快还来得及在那里降到 vMax
      const vAllow = Math.sqrt(vMax * vMax + 2 * decel * ahead);
      const ratio = vNow / Math.max(vAllow, 2);
      // 用当前车速与该处允许速度比较，实时显示绿、黄、红。
      const tint = ratio <= 0.90 ? LINE_SAFE : (ratio <= 1.03 ? LINE_WARN : LINE_OVER);
      recent[k * 3] = tint[0]; recent[k * 3 + 1] = tint[1]; recent[k * 3 + 2] = tint[2];
      const fade = 1 - 0.72 * (ahead / span);             // 越远越暗，避免远处喧宾夺主
      r = tint[0] * fade; g = tint[1] * fade; b = tint[2] * fade;
    } else if (behind > 0 && behind < 105) {
      // 车辆通过后保留上一帧的色彩，沿弧长约 105m 渐隐，不再瞬间跳成灰色。
      const fade = 1 - behind / 105;
      const baseR = recent[k * 3], baseG = recent[k * 3 + 1], baseB = recent[k * 3 + 2];
      r = LINE_IDLE[0] + (baseR - LINE_IDLE[0]) * fade;
      g = LINE_IDLE[1] + (baseG - LINE_IDLE[1]) * fade;
      b = LINE_IDLE[2] + (baseB - LINE_IDLE[2]) * fade;
    } else {
      r = LINE_IDLE[0]; g = LINE_IDLE[1]; b = LINE_IDLE[2];
    }
    col[o] = r; col[o + 1] = g; col[o + 2] = b;
    col[o + 3] = r; col[o + 4] = g; col[o + 5] = b;
  }
  rl.colorAttr.needsUpdate = true;
}

/* ========================================================================== */
/* 11. 主循环                                                                 */
/* ========================================================================== */

let lastT = performance.now();
let mapTick = 0;
let nameplateTick = 0;
let frameCount = 0;
let dbgEl = null;
let dbgErr = '';        // ?dbg=1 时捕获的 console.error（three 着色器编译错误等）

/** ?dbg=1 打开运行期读数（也是无头浏览器验收测试的观测窗口） */
function dbgLine() {
  if (!dbgEl) return;
  const c = S.localCar;
  const fixed = (v, digits = 2, fallback = '-') => Number.isFinite(v) ? v.toFixed(digits) : fallback;
  const input = c && c.input ? c.input : null;
  const lines = [
    'mode=' + S.mode + '  frames=' + frameCount + '  fps~' + (dbgEl._fps || 0),
    'raceClock=' + fixed(S.raceClock, 2) + 's  rpTime=' + (S.rp ? fixed(S.rp.time, 2) : '-') +
      's  racing=' + (S.rp ? S.rp.racing : '-'),
    'local: spd=' + fixed(c && c.speedKmh, 1) + 'km/h lat=' + fixed(c && c.lateralSpeed, 2) +
      ' onAsp=' + (c ? c.surface === 0 : '-') + ' pen=' + fixed(c && c.penalty, 1),
    'steer: input=' + fixed(input && input.steer, 2) + ' angle=' + fixed(c && c.steerAngle, 3) +
      'rad maxNow=' + fixed(c && c.maxSteerNow, 2),
    'drift: slip=' + fixed(c && c.slipAngleDeg, 1) + '° hb=' + fixed(input && input.handbrake, 2) +
      ' fx=' + fixed(c && c.driftIntensity, 2) + ' act=' + (c && c.driftIntensity > 0.05 ? 'Y' : 'N'),
    'fx: smokeAlive=' + (driftFX ? driftFX.smoke.alive : '-') +
      ' marks=' + (driftFX ? driftFX.marks.cursor : '-') +
      ' vortex=' + (vortexFX ? vortexFX.aliveCount() + '/slip' + fixed(c && c.slip, 2) : '-'),
    'ai: ' + (S.rp ? S.rp.cars.filter((x) => x.ai).map((x) => fixed(x.speedKmh, 0) + '/' + x.lap).join(' ') : '-'),
    'cars=' + (S.rp ? S.rp.cars.length : 0) + '  drawCalls=' + renderer.info.render.calls +
      '  tris=' + renderer.info.render.triangles + '  geo=' + renderer.info.memory.geometries,
  ];
  if (dbgErr) lines.push('ERR:' + dbgErr);
  dbgEl.textContent = lines.join('\n');
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  frameCount++;
  if (dbgEl) dbgEl._fps = Math.round(1 / Math.max(dt, 1e-3));

  // 平行光阴影相机跟随玩家车（规格 §三.2）：视锥 ±35m + target 绑车，
  // 保证车开到哪里阴影都完整锐利，不会忽隐忽现。
  if (S.localCar) {
    const cp = S.localCar.pos;
    sun.target.position.set(cp.x, cp.y, cp.z);
    sun.target.updateMatrixWorld();
    sun.position.set(cp.x + SUN_OFF.x, cp.y + SUN_OFF.y, cp.z + SUN_OFF.z);
  }

  // 比赛时钟（统一时钟 - 发车时刻）
  if (S.mode === 'race' || S.mode === 'end') {
    // ForzaTech Clock Slewing（规格 §一.2）：比赛时钟走**被微调过的仿真偏移** simOffset，
    // 而不是直接用 NTP 原始估计 —— 滑窗里"最优样本"换人时原始估计会跳几十毫秒，
    // 微调后的 simOffset 是连续演化的，计时与罚时不会凭空跳一格。
    const srv = slewServerClock(dt);
    S.raceClock = (srv - S.raceStartAt) / 1000;
    // ⚠️ 大负值兜底：raceStartAt 来自服务端墙钟（UnixMilli），而 srv 是本地墙钟 +
    // NTP 偏移。两者若落在不同时间轴上（例如服务端误用 monoMs 这类进程相对量），
    // 差值会是 −1e12 秒量级的巨负值。夹到 −0.001 让 UI 显示 0.00 而不是
    // 一眼看不出异常的负数，同时把"不在同一时间轴"这件事显式记录下来便于排查。
    //
    // ★ 判据必须是"量级不对"，**不能是"< 0"**（2026-09-29 修正）：
    //   倒计时期间 raceClock 本来就合法地是 −2.6s 左右，用 `< -0.001` 会让这道
    //   诊断**每一场都误报**（实测联机单人房间：offN=0.5ms 完美同步，仍然
    //   `_clockAxisWarned=1`），排查时谁看谁懵。真正的换轴是 −1e12 量级，
    //   所以阈值取 −30s：正常倒计时（几秒）放行，换轴必被抓住。
    if (S.raceClock < -CLOCK_AXIS_BREAK_S) {
      if (!S._clockAxisWarned) {
        S._clockAxisWarned = true;
        console.warn('[raceClock] 发车时刻与本地时钟不在同一时间轴：'
          + 'startAt=' + S.raceStartAt + ' localSrv=' + srv.toFixed(0)
          + ' diff=' + ((srv - S.raceStartAt) / 1000).toFixed(3) + 's');
      }
      S.raceClock = -0.001;
    } else if (S.raceClock < 0) {
      // 合法倒计时：保留真值（HUD/诊断都要看得到还剩几秒），只把一次性告警标志
      // 复位，让"换轴"在下一次真出问题时还能报出来。
      S._clockAxisWarned = false;
    }
  } else {
    S.raceClock = 0;
  }

  if (S.rp) {
    // 'end' 阶段仍保持物理活跃：让未完赛的对手继续跑，玩家以观战视角看完整场比赛
    // 权威放行与当前场次预热都完成后才允许物理输入，时钟到点不能越过红灯。
    const running = (S.mode === 'race' || S.mode === 'end') && _raceGoDone && S._racePrewarmDone;
    S.rp.racing = running;
    S.controlsLocked = !running;
    if (running && !S.rp.timeAligned) {
      // 把物理时钟对齐到发车瞬间，使"每圈用时"与"总用时"落在同一时间基准上
      S.rp.timeAligned = true;
      S.rp.time = 0;
      for (const c of S.rp.cars) { c.lapStart = 0; c.lapTimeLive = 0; }
    }

    if (S.localCar) sampleLocalInput(S.localCar, dt);
    const slipstreamEdges = $('slipstreamEdges');
    if (slipstreamEdges) {
      const slip = clamp(Number(S.localCar && S.localCar.slip) || 0, 0, 1);
      slipstreamEdges.style.opacity = String((slip * 0.72).toFixed(3));
    }

    // ?drift=1 自动化漂移演示：持续油门 + 满舵 + 手刹脉冲，
    // 用于无头浏览器截图验收烟雾/胎痕是否真的出画。
    if (S.demoDrift && S.localCar && !S.localCar.finished && S.rp.racing) {
      const inp = S.localCar.input;
      inp.throttle = 1;
      inp.brake = 0;
      inp.steer = 1;
      inp.handbrake = Math.sin(now / 260) > -0.2 ? 1 : 0;
    }
    // ?rescue=1 救援复位演示：幽灵化结束后立刻再触发一次，使半透明幽灵状态常驻，
    // 便于无头浏览器截图验收（无头环境无法模拟按 R 键）。
    if (S.demoRescue && S.localCar && !S.localCar.finished && S.rp.racing &&
        S.localCar.ghostTimer <= 0) {
      S.rp.rescueToCheckpoint(S.localCar);
    }

    // PhysicsWorkerBridge owns fixed stepping, remote interpolation, and network
    // cadence. The main thread only consumes its latest A/B snapshot here.

    // ---- 物理 -> 视觉（子步插值）----
    // 物理固定 1/60 推进，而显示器可能是 144Hz：直接贴 pos 会看到"一步一台阶"。
    // 用 acc/substep 作为插值系数，在"上一固定步"与"当前固定步"之间插值，
    // 等价于 cannon 的 interpolatedPosition，消除高刷新率下的视觉撕裂/微抖。
    // 注意执行顺序：必须在 world.step 全部结束、并完成位姿采样之后才做这一步。
    const alpha = S.rp.renderAlpha(now);
    for (const c of S.rp.cars) {
      const vis = carVisuals.get(c.id);
      if (!vis) continue;
      vis.position.lerpVectors(c.prevPos, c.pos, alpha);
      vis.quaternion.copy(c.prevQuat).slerp(c.quat, alpha);
      const ud = vis.userData;
      // ── ★ 悬挂与车身一体化 + 平滑（用户报障："俯仰侧倾没有丝滑转变" /
      //     "车辆偶尔前后抖动" / "其他玩家车辆行驶时抖动"）──────────────────────────
      // 姿态的三个来源：
      //   ① **路面地形**：四轮各自的路面高度 → 拟合俯仰/侧倾（压路肩必倾）
      //   ② **动态载荷转移**：刹车/加速/横向 G → 前后蹲、左右倾
      //   ③ **物理悬挂行程**：c.suspCompression 驱动车轮上下运动
      //
      // ⚠️ 两个必做的平滑（这是"抖动"的根因）：
      //   · `axMeasured` 是**逐帧实测加速度**，本身就带测量噪声；直接乘系数套到车身上，
      //     车头就会随噪声前后点头 —— 先做时间常数 ~0.10s 的低通；
      //   · 地形项在采样点切换时是**阶跃**的，且横摆/俯仰若每帧瞬时套用就必然抖 ——
      //     最终姿态统一做 ~0.12s 指数缓动（"丝滑"的关键），并保留搓板的高频分量。
      const wg = c.wheelGroundY || null;
      let terrPitch = 0, terrRoll = 0;
      if (wg) {
        const fl = wg[0], fr = wg[1], rl = wg[2], rr = wg[3];
        const frontH = (fl + fr) * 0.5, rearH = (rl + rr) * 0.5;
        const leftH = (fl + rl) * 0.5, rightH = (fr + rr) * 0.5;
        const WB = Math.abs((CFG.WHEEL[3][1] - CFG.WHEEL[0][1])) || 2.6;
        const TR = Math.abs((CFG.WHEEL[0][0] - CFG.WHEEL[1][0])) || 1.6;
        terrPitch = Math.atan2(frontH - rearH, WB) * 0.9;
        terrRoll = Math.atan2(leftH - rightH, TR) * 0.9;
      }
      // 纵向加速度低通：时间常数从 0.10s 加大到 **0.30s**。
      //   0.10s 太短 —— AI 车的油门/换档让 axMeasured 在 ±3m/s² 间来回跳，
      //   车身就跟着**反复点头**（用户报的"其他车辆更加剧烈的前后抖动"）；
      //   0.30s 后只反映真正的加速/刹车趋势，不再被瞬时波动摇动。
      if (ud._axF === undefined) ud._axF = 0;
      const axRaw = c.axMeasured || 0;
      ud._axF += (axRaw - ud._axF) * (1 - Math.exp(-dt / 0.30));
      const ay = c.ayPrev || 0;
      const dynPitch = clamp(-ud._axF / 9.81, -1, 1) * 0.030;   // 1g 刹车 → 前倾 1.7°
      const dynRoll = clamp(ay / 9.81, -1, 1) * 0.030;          // 1g 侧向 → 外倾 1.7°
      // 路肩搓板：只保留高频（±3.5cm 级别），不吃掉缓动的顺滑
      const curbKick = (c.curbH || 0) * 0.10;
      const pitchTarget = terrPitch + dynPitch - curbKick * Math.sign(ud._axF || 1) * 0.4;
      const rollTarget = terrRoll + dynRoll;
      // 姿态缓动（丝滑转变）：时间常数 0.12s；搓板分量不再二次滤波（否则搓板就没了）
      if (ud._pitchS === undefined) { ud._pitchS = pitchTarget; ud._rollS = rollTarget; }
      const kS = 1 - Math.exp(-dt / 0.22);
      ud._pitchS += (pitchTarget - ud._pitchS) * kS;
      ud._rollS += (rollTarget - ud._rollS) * kS;
      // 姿态变化率限制（0.45 rad/s ≈ 26°/s）：即使目标突变也不会"甩头"
      const dMax = 0.45 * dt;
      ud._pitchS = clamp(ud._pitchS, ud._pitchPrev === undefined ? -9 : ud._pitchPrev - dMax, ud._pitchPrev === undefined ? 9 : ud._pitchPrev + dMax);
      ud._rollS = clamp(ud._rollS, ud._rollPrev === undefined ? -9 : ud._rollPrev - dMax, ud._rollPrev === undefined ? 9 : ud._rollPrev + dMax);
      ud._pitchPrev = ud._pitchS; ud._rollPrev = ud._rollS;
      const spitch = ud._pitchS;
      const sroll = ud._rollS;
      if (Math.abs(spitch) > 1e-4 || Math.abs(sroll) > 1e-4) {
        // 每车复用姿态临时对象，避免 12 车 × 120 帧持续制造
        // Quaternion/Euler 垃圾，减少比赛中偶发的长 GC 帧。
        const qDyn = ud._dynQuat || (ud._dynQuat = new THREE.Quaternion());
        const eDyn = ud._dynEuler || (ud._dynEuler = new THREE.Euler(0, 0, 0, 'YXZ'));
        eDyn.set(spitch, 0, sroll, 'YXZ');
        qDyn.setFromEuler(eDyn);
        vis.quaternion.multiply(qDyn);
      }
      // 幽灵化视觉（R 键复位后 3.5s）：车身半透明 0.35，别人能直接穿过去
      const restoreOwn = c.id === S.localId;      // 自己的车永远保持不透明
      const ghostModeAmt = (!restoreOwn && S.rp.ghostMode) ? 1 : 0;
      // 预测性前向幽灵化（规格 §二.2）：TTC 预判出的高速车对 -> 半透明 0.35。
      // 规格要求"平滑淡入透明度"：解除隔离时直接把 0.35 跳回 1.0 会有明显突变，
      // 这里用指数缓动把当前值（ud._pgAmt）推向目标，时间常数 ~0.08s（≈0.25s 走完）。
      const pgTarget = restoreOwn ? 0 : (c.pgGhost ? 1 : 0);
      if (ud._pgAmt === undefined) ud._pgAmt = pgTarget;
      ud._pgAmt += (pgTarget - ud._pgAmt) * (1 - Math.exp(-12 * dt));
      if (Math.abs(ud._pgAmt - pgTarget) < 0.002) ud._pgAmt = pgTarget;   // 收敛后精确贴合，避免每帧重写材质
      // 规格 §三.2：弯道拥挤幽灵化 —— 弯内多车拥堵时整体半透明 + 车车穿透。
      // 与预测性幽灵同样走指数缓动，进/出都不会突变。
      const zoneTarget = restoreOwn ? 0 : (c.zoneGhost ? 1 : 0);
      if (ud._zoneAmt === undefined) ud._zoneAmt = zoneTarget;
      ud._zoneAmt += (zoneTarget - ud._zoneAmt) * (1 - Math.exp(-12 * dt));
      if (Math.abs(ud._zoneAmt - zoneTarget) < 0.002) ud._zoneAmt = zoneTarget;
      const gAmt = Math.max(c.ghost || 0, ghostModeAmt, c.finishGhost ? 1 : 0, ud._pgAmt, ud._zoneAmt);
      const gOp = ghostModeAmt > 0 ? CFG.GHOST_MODE_OPACITY : CFG.GHOST_OPACITY;
      const gKeep = ghostModeAmt > 0;
      if (ud._ghost !== gAmt || ud._ghostOp !== gOp) {
        applyGhost(vis, gAmt, gOp, gKeep);
        ud._ghost = gAmt;
        ud._ghostOp = gOp;
      }
      // 手刹锁死后轮：后轮不再随车速滚动（漂移时后轮是拖着的）
      const rearLocked = c.handbrake > 0.5;
      const spinFront = c.forwardSpeed / 0.36;
      const spinRear = rearLocked ? 0 : spinFront;
      // ── ★ 悬挂位移与车身动态姿态（消除"漂浮在路面上"感，仿 FM8 拟真物理）──
      // 物理计算出的悬挂压缩量（c.suspCompression）在底盘与地面之间动态呼吸：
      //   加速时尾部下沉（squat）、刹车时车头俯冲（dive）、过弯侧倾（roll）、压路肩垂直颠簸。
      // 1. 车身网格微俯仰/侧倾：把悬挂动态反馈到车身主网格上
      // suspCompression 必须是有限标量：镜像层曾被误初始化为数组，
      // 一旦 NaN 进入 _ySm 就永不复原（四轮整体消失）。这里做最后一道防线。
      const suspRaw = c.suspCompression;
      const suspX = Number.isFinite(suspRaw) ? suspRaw : (Number.isFinite(suspRaw && suspRaw[0]) ? suspRaw[0] : 0);
      // 垂直下沉/回弹行程限制在 ±0.08m，避免极速时车身插地
      const suspTravel = Math.max(-0.06, Math.min(0.08, suspX));
      
      // 2. 四轮贴地悬挂动画：轮子独立跟随路面起伏垂直伸缩，并在局部坐标系内保持接地点紧贴地面
      for (let wi = 0; wi < ud.wheels.length; wi++) {
        const w = ud.wheels[wi];
        if (w.isFront) w.pivot.rotation.y = c.steerAngle;
        w.mesh.rotation.x += (w.isFront ? spinFront : spinRear) * dt;

        if (w.initY === undefined) w.initY = w.pivot.position.y;
        // ① 逐轮地面跟随：该轮脚下的路面比车身高多少，车轮就相对车身抬多少
        //    （压上路肩时那侧车轮明显抬起 —— 这就是"悬挂与车互动"的直接体现）
        let groundLift = 0;
        if (c.wheelGroundY) {
          const rel = c.wheelGroundY[wi] - (c.groundY || c.wheelGroundY[wi]);
          groundLift = clamp(rel, -0.12, 0.12);
        }
        // ② 动态载荷转移（刹车前轮压紧 / 加速后轮压紧 / 过弯外侧压紧）
        const pitchLoad = c.input.brake > 0.05 ? (w.isFront ? 0.022 : -0.018)
                        : c.input.throttle > 0.1 ? (w.isFront ? -0.018 : 0.022) : 0;
        const rollLoad = clamp((c.ayPrev || 0) / 9.81, -1, 1) * (w.isRight ? 0.022 : -0.022);
        // ③ 物理悬挂压缩量（整车）
        const wheelTravelTarget = clamp(suspTravel + groundLift + pitchLoad + rollLoad, -0.09, 0.10);
        // 车轮行程缓动（0.08s）：逐轮地面高度在采样点边界是阶跃的，硬切会看到"车轮打嗝"
        if (w._ySm === undefined) w._ySm = w.initY;
        w._ySm += (w.initY + wheelTravelTarget - w._ySm) * (1 - Math.exp(-dt / 0.12));
        w.pivot.position.y = w._ySm;
      }
      // 刹车灯：脚刹或手刹都点亮
      const braking = c.input.brake > 0.05 || c.handbrake > 0.5;
      for (const t of ud.tails) t.material.color.setHex(braking ? 0xff2d1f : 0x5a0a06);
      vis.visible = c.pos.distanceToSquared(camera.position) < 1400 * 1400;
    }

    // 漂移特效：轮胎烟雾 + 动态胎痕
    if (driftFX) {
      driftFX.update(dt, S.rp.cars);
      // 演示模式额外补量：无头浏览器一帧要等几十秒，靠逐帧累积看不到效果
      if (S.demoDrift && S.localCar && S.rp.racing) driftFX.burst(S.localCar, 26);
    }

    // 完赛提示（规格：完赛后剥离操控交给 AI 巡航，提示可切换观战）
    if (S.localCar && S.localCar.finished && !S._finishHinted) {
      S._finishHinted = true;
      showToast('已完赛 · 操控转交自动巡航（60km/h 沿最佳走线）｜按 C/V 观战其他车手', 5200);
    }

  }

  updateCamera(dt, now);
  camera.updateMatrixWorld();
  updateNameplates();

  if (S.mode === 'race' || S.mode === 'end') {
    updateHUD(now);
    updateRacingLine(dt);
    mapTick += dt;
    if (mapTick > 1 / 30) { mapTick = 0; updateMinimap(); }
  }

  if (S.localCar) audio.update(S.localCar);
  audio.updateScene(S.rp && S.rp.cars, camera, S.localCar, !!(S.rp && S.rp.racing));

  dbgLine();
  renderer.render(scene, camera);
}

/* ========================================================================== */
/* 12. 网络与大厅                                                              */
/* ========================================================================== */

function rosterFromLobby(lobby) {
  return lobby.map((p) => ({
    id: p.id,
    name: p.name || ('车手' + p.id),
    color: p.color || CAR_COLORS[(p.id - 1) % CAR_COLORS.length],
    ai: !!p.ai,
    engine: p.engine || p.engineProfile || 'i6gt',
  }));
}

function renderPresence(snapshot, room) {
  const count = $('presenceCount');
  const body = $('presenceBody');
  if (!count || !body) return;
  const hasSnapshot = snapshot && Array.isArray(snapshot.players);
  const players = hasSnapshot ? snapshot.players : (room && Array.isArray(room.players) ? room.players : []);
  const total = hasSnapshot ? Number(snapshot.total) || players.length : players.length;
  const roomPlayers = hasSnapshot
    ? Number(snapshot.roomPlayers) || 0
    : (room && Array.isArray(room.players) ? room.players.length : 0);
  count.textContent = total + ' 人 · 房间内 ' + roomPlayers + ' 人';
  body.textContent = '';
  if (!players.length) {
    const empty = document.createElement('span');
    empty.className = 'presence-empty';
    empty.textContent = '等待在线玩家';
    body.appendChild(empty);
    return;
  }
  for (const p of players) {
    const row = document.createElement('div');
    row.className = 'presence-row' + (p.id === S.localId ? ' me' : '');
    const dot = document.createElement('i');
    dot.className = 'presence-dot';
    dot.style.background = p.color || '#3a8cff';
    const name = document.createElement('span');
    name.className = 'presence-name';
    const roomTag = p.room ? ' · ' + p.room : ' · 大厅';
    name.textContent = (p.name || ('车手' + p.id)) + (p.ai ? ' · 人机' : '') + roomTag;
    const ping = document.createElement('span');
    ping.className = 'presence-ping';
    ping.textContent = Number.isFinite(p.ms) && p.ms >= 0 ? Math.round(p.ms) + ' ms' : '—';
    row.append(dot, name, ping);
    body.appendChild(row);
  }
}

function renderLobby(room) {
  const wasRoom = !!S.lobbyRoom;
  renderPresence(S.presence, room);
  const details = $('presenceDetails');
  if (details && room && !wasRoom) details.open = false;
  if (details && !room && wasRoom) details.open = true;
  $('roomCode').textContent = room ? room.room : '····';
  $('stageJoin').classList.toggle('hidden', !!room);
  $('stageRoom').classList.toggle('hidden', !room);
  // 聊天面板唯一显隐入口：有房间（stageRoom 可见）才展开，回主菜单自动收起。
  setChatPanel(!!room);
  // 在线人数徽标（规格 §二：面板头部显示在线人数）。
  // ★ 只统计**真人**：服务端下发 humanCount（人机不算在线玩家，用户报障）。
  //   兼容旧服务端：没有 humanCount 时退回 players 里非 ai 的条数。
  const humansIn = (r) => (r && Number.isFinite(r.humanCount))
    ? r.humanCount
    : ((r && r.players) ? r.players.filter((p) => !p.ai).length : 0);
  const on = $('chatOnline');
  if (on) on.textContent = String(humansIn(room));
  if (!room) { S.lobbyRoom = null; return; }
  S.lobbyRoom = room;
  // 保留前端旧名册字段作为兼容别名：当前服务端统一使用 players，
  // bots/roster 仅是派生视图，避免房间插件读取时再各自过滤一次。
  room.roster = room.players || [];
  room.bots = room.roster.filter((p) => p.ai);
  // 赛道展示：只有房主（服务端权威席位 1）且尚未发车时才给"切换赛道"按钮，
  // 与服务端 case "track" 的守卫（!started && !counting）保持一致。
  $('roomTrackName').textContent = TRACK_NAME[room.track] || TRACK_NAME.suzuka;
  const host = (room.host != null ? S.localId === room.host : S.localId === 1) && !room.started && !room.counting;
  $('btnTrack').classList.toggle('hidden', !host);
  const mode = room.gameMode === 'horizon' ? 'horizon' : room.gameMode === 'bumper' ? 'bumper' : 'fm8';
  // 碰碰车模式与幽灵车互斥 ⇒ 该模式下幽灵车按钮直接隐藏、状态文案说明原因
  //（服务端 case "ghost" 也会拒绝，这里只是不给用户点进死路）。
  $('roomGhost').textContent = mode === 'bumper'
    ? '碰碰车模式：全程实体对抗（不可开启幽灵车）'
    : (room.ghost ? '全员幽灵车（车车不碰撞 · 可穿透）' : '标准碰撞（车车可碰撞）');
  $('btnGhost').classList.toggle('hidden', !host || mode === 'bumper');
  const modeEl = $('roomGameMode');
  if (modeEl) {
    modeEl.textContent = mode === 'horizon' ? '地平线模式 · 轻松驾驶'
      : mode === 'bumper' ? '碰碰车模式 · 全程实体对抗' : 'FM8 模式 · 拟真规则';
  }
  const modeBtn = $('btnGameMode');
  if (modeBtn) modeBtn.classList.toggle('hidden', !host);
  // 圈数（规格 §八 扩容后仍为房主权威）：房主可在厅内改，非房主只读展示。
  const lapsEl = $('roomLaps');
  if (lapsEl) lapsEl.textContent = (room.laps || 3) + ' 圈';
  const btnLaps = $('btnLaps');
  if (btnLaps) btnLaps.classList.toggle('hidden', !host);
  const btnAddAI = $('btnAddAI');
  if (btnAddAI) btnAddAI.classList.toggle('hidden', !host || (room.players || []).length >= GRID_SLOTS);
  // 赛季积分排行榜（规格 §一.1）：room 报文携带 season 字段时优先使用（服务端权威）。
  if (room.season) renderSeason(room.season);
  const roomPlayersDetails = $('roomPlayersDetails');
  if (roomPlayersDetails && room && !wasRoom) roomPlayersDetails.open = false;
  if (roomPlayersDetails) {
    const roomCount = $('roomPlayersCount');
    // ★ 同上：人数只算真人（车手列表本身仍然列出人机，只是不计入"在线人数"）。
    if (roomCount) roomCount.textContent = humansIn(room) + ' 人';
  }
  const list = $('playerList');
  list.textContent = '';
  const players = room.players || [];
  // 只渲染实际入房玩家；空席位不再生成“等待加入”占位卡片，
  // 房间详情默认收起，展开后内容只代表当前 roster。
  for (const p of players) {
    const div = document.createElement('div');
    div.className = 'pcard';
    const color = document.createElement('span');
    color.className = 'pcolor';
    color.style.background = p.color || '#2a3138';
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name || ('车手' + p.id);
    div.appendChild(color);
    div.appendChild(name);
    if (p.ai) {
      const tag = document.createElement('span');
      tag.className = 'ptag ai';
      tag.textContent = '人机';
      div.appendChild(tag);
    }
    if (p.id === S.localId) {
      const tag = document.createElement('span');
      tag.className = 'ptag me';
      tag.textContent = '我';
      div.appendChild(tag);
    }
    const ready = document.createElement('span');
    ready.className = 'ptag' + (p.ready ? ' ok' : '');
    ready.textContent = p.ready ? '已准备' : '等待准备';
    div.appendChild(ready);
    if (p.pts) {
      const pts = document.createElement('span');
      pts.className = 'ptag';
      pts.textContent = p.pts + ' 分';
      div.appendChild(pts);
    }
    if (Number.isFinite(p.ms) && p.ms >= 0) {
      const ms = document.createElement('span');
      ms.className = 'ptag ping ' + (p.ms < 80 ? 'good' : p.ms < 160 ? 'ok' : 'bad');
      ms.textContent = Math.round(p.ms) + ' ms';
      div.appendChild(ms);
    }
    const slot = document.createElement('span');
    slot.className = 'pid';
    slot.textContent = '席位 ' + p.id;
    div.appendChild(slot);
    if (host && p.ai) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'player-kick';
      kick.dataset.id = String(p.id);
      kick.textContent = '移除人机';
      kick.addEventListener('click', () => {
        if (S.net && S.net.connected && !S.lobbyRoom.started && !S.lobbyRoom.counting) {
          S.net.send({ t: 'remove_bot', id: p.id });
        }
      });
      div.appendChild(kick);
    }
    list.appendChild(div);
  }
}

// renderSeason 渲染赛季积分排行榜（规格 §一.1 / §二）：前 10 名，逐行淡入。
// 兼容两种入参：
//   · [{name,pts}, ...]                  room 报文的 season 字段 / /api/season
//   · {rankings:[{name,pts}, ...]}       SEASON_LEADERBOARD_UPDATE 报文（附加包装）
function renderSeason(data) {
  const body = $('seasonBody');
  const arr = Array.isArray(data) ? data
    : (data && Array.isArray(data.rankings)) ? data.rankings : [];
  const visible = arr.slice(0, 10).map((it) => ({ name: String(it.name || ''), pts: it.pts | 0 }));
  const signature = JSON.stringify(visible);
  S.seasonRankings = arr;
  if (!body) return;
  // 房间报文每次都携带 season；数据没变时保留现有节点，避免 CSS 入场动画反复播放。
  if (signature === S._seasonSignature) return;
  S._seasonSignature = signature;
  if (!visible.length) {
    body.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'season-empty';
    empty.textContent = '暂无记录 —— 完成一场比赛即可上榜';
    body.appendChild(empty);
    return;
  }
  body.textContent = '';
  visible.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'season-row' + (i === 0 ? ' p1' : i === 1 ? ' p2' : i === 2 ? ' p3' : '');
    row.style.animationDelay = (i * 40) + 'ms';
    const rank = document.createElement('span');
    rank.className = 'sr-rank';
    rank.textContent = String(i + 1);
    const name = document.createElement('span');
    name.className = 'sr-name';
    name.textContent = it.name;
    const pts = document.createElement('span');
    pts.className = 'sr-pts';
    pts.textContent = String(it.pts);
    row.append(rank, name, pts);
    body.appendChild(row);
  });
}

// loadSeason 未加入房间时从 /api/season 拉取赛季榜（首页右侧面板）。
async function loadSeason() {
  let arr = Array.isArray(S.seasonRankings) ? S.seasonRankings : [];
  try {
    const r = await fetch('/api/season', { cache: 'no-store' });
    if (!r.ok) return arr;
    const j = await r.json();
    if (j && Array.isArray(j.data)) {
      arr = j.data;
      renderSeason(arr);
    }
  } catch (e) { /* 服务端不可用时静默 */ }
  return arr;
}

/* --------------------------------------------------------------------------
 * 局内起步灯控（服务端权威驱动）
 * lights 报文的 stage = 5..1（仍亮着的红灯数量），stage = 6 = 绿灯放行。
 * 全房间由同一报文驱动，音画与放行时刻严格对齐服务端 start.at。
 * ------------------------------------------------------------------------ */
let _startLightStage = 5;
function showStartLights(stage) {
  // 同一场次两条灯控通道只能向前推进，迟到的红灯不能撤销绿灯。
  if (stage < 6 && (_raceGoDone || stage < 1 || stage > _startLightStage)) return;
  _startLightStage = stage >= 6 ? 0 : stage;
  const box = $('startLights');
  if (!box) return;
  box.classList.remove('hidden');
  box.style.display = '';
  const bulbs = box.querySelectorAll('.sl.red');
  const go = box.querySelector('.sl-go');
  if (stage >= 6) {
    // 红灯全灭 + 绿灯亮起 = 放行
    box.classList.add('go');
    bulbs.forEach((b) => b.classList.remove('on'));
    if (go) go.textContent = 'GREEN / GO!';
    if (S.localCar) S.localCar.raceLocked = !S._racePrewarmDone;
    S.controlsLocked = !S._racePrewarmDone;
  } else {
    box.classList.remove('go');
    if (go) go.textContent = '';
    bulbs.forEach((b, i) => b.classList.toggle('on', i < stage));
    if (S.localCar) S.localCar.raceLocked = true;    // 起步锁定
    S.controlsLocked = true;                         // 规格 §一：锁死操控
  }
}

/* --------------------------------------------------------------------------
 * 规格 §一：起跑放行的统一入口（权威 RACE_START / 旧 lights stage6 / 4.5s 兜底
 * 三条路径**都**汇到这里），保证无论哪条信号先到，放行动作都只会执行一次，
 * 且一定会：清红灯亮绿灯 -> 解锁操控 -> 彻底隐藏起跑遮罩（display:none）。
 * ------------------------------------------------------------------------ */
let _raceGoDone = false;
function forceRaceGo(reason) {
  if (_raceGoDone) return;
  _raceGoDone = true;
  if (S._goFallback) { clearTimeout(S._goFallback); S._goFallback = null; }
  showStartLights(6);           // 亮绿灯；实际输入仍需等待当前场次预热
  S.controlsLocked = !S._racePrewarmDone;
  S.raceStartSeen = true;
  if (gantryLights) gantryLights.setStage(6);
  audio.init(); audio.resume();
  // 绿灯 "GREEN / GO!" 显示 1s 后彻底隐藏灯组。
  if (S._lightHideTimer) clearTimeout(S._lightHideTimer);
  S._lightHideTimer = setTimeout(() => {
    S._lightHideTimer = null;
    const sl = $('startLights');
    if (sl) { sl.classList.add('hidden'); sl.style.display = 'none'; }
  }, 1000);
  if (reason) console.info('[start] 起跑放行 via', reason);
}

/* 起跑序列复位（每场开始 / 回大厅时调用）：恢复遮罩、重置一次性标志。 */
function resetStartSequence() {
  _raceGoDone = false;
  _startLightStage = 5;
  S.controlsLocked = true;
  S.startSeqSeen = false;
  S.raceStartSeen = false;
  if (S._goFallback) { clearTimeout(S._goFallback); S._goFallback = null; }
  if (S._lightHideTimer) { clearTimeout(S._lightHideTimer); S._lightHideTimer = null; }
  if (S._goLedTimer) { clearInterval(S._goLedTimer); S._goLedTimer = null; }
  // ★ 红灯按真实 LIGHT_TICK_MS 逐盏显示（与单机 startOffline / 服务端灯序同一节拍）。
  //   不再一次性点亮 5 盏 —— 那等于把 2.5s 的灯序压成 1 帧，"没有准备时间"。
  if (S._lightLedTimers && S._lightLedTimers.length) {
    for (const id of S._lightLedTimers) clearTimeout(id);
    S._lightLedTimers.length = 0;
  }
  const sl = $('startLights');
  if (sl) {
    sl.classList.remove('hidden', 'go'); sl.style.display = '';
    sl.querySelectorAll('.sl.red').forEach(b => b.classList.remove('on'));
  }
}

/* --------------------------------------------------------------------------
 * 局部起跑灯序（离线单机 / 联机"start 报文缺失"的本地兜底）
 *   ① 5 盏红灯全亮 → ② 每 LIGHT_TICK_MS(700ms) 熄一盏 → ③ 绿灯 + 放行
 * 与服务端阶段二灯序**同一节拍**（main.go: startLightTickMs=700），
 * 所以单机与联机的时间感一致。
 * ------------------------------------------------------------------------ */
const LIGHT_TICK_MS = 700;                    // 与 main.go 的 startLightTickMs 对齐
const LOCAL_GO_MS = 250 + 5 * LIGHT_TICK_MS;  // 与 main.go 的 stage2Ms 对齐（=3750ms）

function armLocalStartLights(goReason) {
  // ⚠️ 必须**先建立**数组：以前这里直接 `const ids = S._lightLedTimers`，
  //    而 resetStartSequence() 只做"若有则清空"，从不初始化 ⇒ ids 是 undefined
  //    ⇒ ids.push 抛 TypeError ⇒ 灯序只亮了第一帧就没了（单机永远停在 R5）。
  if (!S._lightLedTimers) S._lightLedTimers = [];
  if (S._lightLedTimers.length) {
    for (const id of S._lightLedTimers) clearTimeout(id);
    S._lightLedTimers.length = 0;
  }
  resetStartSequence();
  // 第 0 帧：五盏红灯全亮（起跑架上红灯齐亮，随后逐盏熄灭）
  showStartLights(5);
  const ids = S._lightLedTimers;
  for (let stage = 4; stage >= 1; stage--) {
    ids.push(scheduleStartTimer(() => showStartLights(stage), (5 - stage) * LIGHT_TICK_MS));
  }
  ids.push(scheduleStartTimer(() => forceRaceGo(goReason || 'local'), LOCAL_GO_MS));
  return LOCAL_GO_MS;
}

/* 规格 §一：4.5s 本地兜底 —— 若超过 4.5s 未收到 RACE_START/lights stage6 强制放行，
 * 杜绝"卡死在倒计时界面 / 卡死在 1"（缺陷①的直接兜底）。 */
// armGoFallback 只在**收到权威 start 报文之后**才启用（见 net.on('start')），
// 因为此刻服务端已经算好 start.at = now + LOAD_MS + 5×tick。
//
// ⚠️ 兜底预算必须**大于**「载入缓冲 + 五盏红灯」的总时长，否则它会抢在灯序
//    跑完之前放行（客户端自己先开跑，服务端还在亮红灯）——那正是"抢跑"。
//    当前服务端：250ms 载入 + 5×700ms = 3750ms；这里给 7.5s 留足余量
//    （即使客户端时钟偏移几十毫秒，也只会晚放行、绝不早放行）。
const GO_FALLBACK_MS = 7500;
function armGoFallback() {
  if (S._goFallback) clearTimeout(S._goFallback);
  S._goFallback = setTimeout(() => forceRaceGo(GO_FALLBACK_MS / 1000 + 's 本地兜底'), GO_FALLBACK_MS);
}

/* --------------------------------------------------------------------------
 * 规格 §四.1 完赛单行条幅（替代全屏结果面板）
 * ------------------------------------------------------------------------ */
function showFinishBar(text) {
  const el = $('finishBar');
  if (!el) return;
  if (text) $('finishBarTxt').textContent = text;
  el.classList.remove('hidden');
}
function hideFinishBar() {
  const el = $('finishBar');
  if (el) el.classList.add('hidden');
}

/* --------------------------------------------------------------------------
 * 规格 §四.2 观战入力回显（Input Telemetry Overlay）
 * 屏幕正下方键盘指示器 + 油门/刹车进度条。观战时展示被观战车的实时输入。
 * ------------------------------------------------------------------------ */
function updateInputOverlay(car) {
  const box = $('inputOverlay');
  if (!box) return;
  if (!car) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const thr = Math.max(0, Math.min(1, car.throttle || 0));
  const brk = Math.max(0, Math.min(1, car.brake || 0));
  const steer = car.steer || 0;
  const hand = !!car.handbrake;
  const w = box.querySelector('#ioW'), a = box.querySelector('#ioA');
  const s = box.querySelector('#ioS'), d = box.querySelector('#ioD');
  const sp = box.querySelector('#ioSpace');
  if (w) w.classList.toggle('on', thr > 0.05);
  if (s) s.classList.toggle('on', brk > 0.05);
  if (a) a.classList.toggle('on', steer < -0.12);
  if (d) d.classList.toggle('on', steer > 0.12);
  if (sp) sp.classList.toggle('on', hand);
  const ti = box.querySelector('#ioThr'), bi = box.querySelector('#ioBrk');
  if (ti) { ti.style.setProperty('--w', (thr * 100) + '%'); ti.style.width = (thr * 100) + '%'; }
  if (bi) { bi.style.setProperty('--w', (brk * 100) + '%'); bi.style.width = (brk * 100) + '%'; }
}


function bootProgress(p, msg) {
  $('bootBar').style.width = Math.round(p * 100) + '%';
  if (msg) $('bootMsg').innerHTML = msg;
}

async function startOffline() {
  const laps = parseInt($('laps').value, 10) || 3;
  const seed = FORCE_SEED || ((Math.random() * 0x7fffffff) >>> 0);
  S.offline = true;
  const roster = [{ id: 1, name: ($('name').value || '我').slice(0, 12), color: S.color, ai: false }];
  const botNames = ['银箭', '红隼', '蓝鲨', '赤焰', '猎风', '雷鸟', '黑曜', '北极星', '飓风', '流光', '磐石'];
  const colorSeed = (seed ^ 0x9e3779b9) >>> 0;
  const localColor = String(S.color || '').toLowerCase();
  const aiPalette = AI_COLORS.filter((c) => String(c).toLowerCase() !== localColor);
  const palette = aiPalette.length ? aiPalette : AI_COLORS;
  for (let i = 0; i < GRID_SLOTS - 1; i++) {
    const ci = (colorSeed + i) % palette.length;
    roster.push({
      id: i + 2,
      name: 'AI · ' + botNames[i],
      color: palette[ci],
      ai: true,
      engine: ['i6gt', 'v8', 'v12'][i % 3],
    });
  }
  // 积分高者拿更靠前的发车格；同分按固定席位号稳定排序，保证同一份榜单
  // 每次生成的排位完全一致。请求失败时沿用已有内存快照。
  const rankings = await loadSeason();
  const pts = new Map((rankings || []).map((x) => [x.name, Number(x.pts) || 0]));
  roster.sort((a, b) => {
    const pa = pts.get(a.name) || 0;
    const pb = pts.get(b.name) || 0;
    return (pb - pa) || (a.id - b.id);
  });
  const grid = {};
  roster.forEach((d, i) => { grid[String(d.id)] = i + 1; });
  const type = $('track') ? $('track').value : 'suzuka';
  const ghost = $('ghost') ? $('ghost').checked : false;
  buildWorld(seed, type);
  // 与联机一致：没有 3-2-1，进入场景即五红灯全亮，随后每 700ms 熄一盏、绿灯放行。
  const goMs = 250 + 5 * LIGHT_TICK_MS;
  const gameMode = $('gameMode') ? $('gameMode').value : 'fm8';
  beginRace({ seed, track: type, ghost, gameMode, laps, roster, localId: 1, startAt: Date.now() + goMs, grid });
  renderLobby(null);
  hideFinishBar();
  hideSettlement();
  // 单机练习：收起大厅聊天面板（无服务端通道，局内浮层仅供系统消息）。
  setChatPanel(false);
  closeHudChat();
  clearHudChat();
  clearHudCountdown();
  // ★ 单机没有服务端，灯序全部本地驱动，节拍与服务端阶段二**逐拍一致**
  //   （3750ms 后开跑，也就是"5 盏红灯各亮 700ms"的完整准备时间）。
  if (!await S.raceReadyPromise) return;
  S.raceStartAt = Date.now() + goMs;
  armLocalStartLights('offline');
  setAlert('单机练习模式 · 11 台 AI 车手 · ' +
    (gameMode === 'horizon' ? '地平线模式' : gameMode === 'bumper' ? '碰碰车模式' : 'FM8 模式'), 'off');
}

function bindUI() {
  // 引擎音效选择（用户要求：可选择自己的车辆音效，含电动方程式）
  //   档位写进 localStorage，下次进游戏沿用；切换后重建音频图层（音色由振荡器类型/
  //   谐波配比/进气噪声系数共同决定，必须重建才能生效）。
  try {
    const sel = document.getElementById('engineSound');
    if (sel) {
      const saved = localStorage.getItem('forza_lan_engine') || 'i6gt';
      sel.value = saved;
      audio.profile = saved;
      sel.addEventListener('change', () => {
        try { localStorage.setItem('forza_lan_engine', sel.value); } catch (e) { /* ignore */ }
        if (audio.setProfile) audio.setProfile(sel.value);
        showToast('引擎音效：' + sel.options[sel.selectedIndex].textContent);
      });
    }
  } catch (e) { /* ignore */ }
  // 颜色选择
  const box = $('colors');
  CAR_COLORS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (i === 0 ? ' on' : '');
    d.style.background = c;
    d.addEventListener('click', () => {
      S.color = c;
      for (const ch of box.children) ch.classList.remove('on');
      d.classList.add('on');
    });
    box.appendChild(d);
  });

  const saved = (() => { try { return localStorage.getItem('forza_lan_name') || ''; } catch (e) { return ''; } })();
  $('name').value = saved || ('车手' + (1 + Math.floor(Math.random() * 98)));
  S.localName = $('name').value.slice(0, 12);
  syncPlayerProfile(S.localName);
  $('name').addEventListener('change', () => {
    S.localName = $('name').value.slice(0, 12);
    syncPlayerProfile(S.localName);
  });

  $('btnCreate').addEventListener('click', () => {
    audio.init(); audio.resume();
    const laps = parseInt($('laps').value, 10) || 3;
    if (!S.net || !S.net.connected) { showToast('未连接服务端，可先试单机练习'); return; }
    S.localName = $('name').value.slice(0, 12);
    syncPlayerProfile(S.localName);
    S.net.send({
      t: 'create', name: $('name').value.slice(0, 12), color: S.color, laps,
      track: $('track') ? $('track').value : 'suzuka',
      ghost: $('ghost') ? $('ghost').checked : false,
      gameMode: $('gameMode') ? $('gameMode').value : 'fm8',
      engine: $('engineSound') ? $('engineSound').value : (localStorage.getItem('forza_lan_engine') || 'i6gt'),
    });
  });

  $('btnJoin').addEventListener('click', () => {
    audio.init(); audio.resume();
    const code = ($('code').value || '').toUpperCase().trim();
    if (code.length !== 4) { showToast('请输入 4 位房间号'); return; }
    if (!S.net || !S.net.connected) { showToast('未连接服务端，可先试单机练习'); return; }
    S.localName = $('name').value.slice(0, 12);
    syncPlayerProfile(S.localName);
    S.net.send({
      t: 'join', room: code, name: $('name').value.slice(0, 12), color: S.color,
      gameMode: $('gameMode') ? $('gameMode').value : 'fm8',
      engine: $('engineSound') ? $('engineSound').value : (localStorage.getItem('forza_lan_engine') || 'i6gt'),
    });
  });

  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

  $('btnSolo').addEventListener('click', () => { audio.init(); audio.resume(); startOffline(); });

  // 房主在大厅切换赛道：只发意图，真正的权威切换在服务端（会广播回全房间）。
  // 四赛道循环（铃鹿 → 拉斯维加斯 → 斯帕 → 新手环道）。顺序必须与
  // index.html 的 `#track` 下拉、服务端 sanitizeTrack / trackDisplayName 一致。
  $('btnTrack').addEventListener('click', () => {
    if (!S.net || !S.net.connected) return;
    const order = ['suzuka', 'vegas', 'spa', 'oval'];
    const cur = (S.lobbyRoom && S.lobbyRoom.track) || 'suzuka';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    S.net.send({ t: 'track', track: next });
  });

  // 房主切换驾驶规则：FM8 拟真 → 地平线轻松 → 碰碰车 → FM8。
  // 顺序必须与 index.html 的 #gameMode 下拉、服务端 sanitizeGameMode 白名单一致。
  $('btnGameMode').addEventListener('click', () => {
    if (!S.net || !S.net.connected) return;
    const raw = (S.lobbyRoom && S.lobbyRoom.gameMode) || 'fm8';
    const cur = raw === 'horizon' ? 'horizon' : raw === 'bumper' ? 'bumper' : 'fm8';
    const order = ['fm8', 'horizon', 'bumper'];
    S.net.send({ t: 'gamemode', gameMode: order[(order.indexOf(cur) + 1) % order.length] });
  });

  // 局内/大厅改名（规格 §一.2）：把新昵称发给服务端，由服务端权威广播给全房间。
  const doRename = () => {
    const v = ($('nameInRoom').value || '').trim().slice(0, 12);
    if (!v) { showToast('昵称不能为空'); return; }
    if (!S.net || !S.net.connected) { showToast('未连接服务端'); return; }
    S.net.send({ t: 'rename', name: v });
    S.localName = v;
    syncPlayerProfile(S.localName);
  };
  $('btnRename').addEventListener('click', doRename);
  $('nameInRoom').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRename(); });

  // 首页（未入房）的大厅昵称也必须**实时**同步给服务端。
  // RaceUI 只把昵称写进 localStorage，服务端完全不知道 —— 于是首页左侧在线面板里
  // 别人看到的永远是服务端初始占位名"车手"，且改名后不会刷新（用户报障：
  // "局外首页左侧的大厅玩家姓名延迟不会实时更新"）。
  // 去抖 500ms + 只在值真的变化时发送，避免逐字敲键盘把 `rename` 变成洪泛。
  const lobbyNameInput = $('name');
  if (lobbyNameInput) {
    let renameTimer = 0;
    let lastSentName = '';
    lobbyNameInput.addEventListener('input', () => {
      if (!S.net || !S.net.connected) return;
      if (renameTimer) clearTimeout(renameTimer);
      renameTimer = setTimeout(() => {
        renameTimer = 0;
        const v = lobbyNameInput.value.trim().slice(0, 12);
        if (!v || v === lastSentName || !S.net || !S.net.connected) return;
        lastSentName = v;
        S.net.send({ t: 'rename', name: v });
      }, 500);
    });
  }

  // 房主切换碰撞模式（标准碰撞 <-> 全员幽灵车）。权威在服务端，会广播回全房间。
  $('btnGhost').addEventListener('click', () => {
    if (!S.net || !S.net.connected) return;
    const cur = !!(S.lobbyRoom && S.lobbyRoom.ghost);
    S.net.send({ t: 'ghost', ghost: !cur });
  });

  // 房主在房间内改圈数（用户报障："在房间内无法设置比赛圈数"）。
  // 服务端权威：case "laps" 只允许未发车时改，改完广播回房间 + 系统聊天提示。
  $('btnLaps').addEventListener('click', () => {
    if (!S.net || !S.net.connected) return;
    const cur = (S.lobbyRoom && S.lobbyRoom.laps) || 3;
    const next = cur >= 8 ? 1 : cur + 1;      // 1..8 循环，与建房页 laps 输入上限一致
    S.net.send({ t: 'laps', n: next });
  });

  // 房主在当前房间添加一名由主机驱动的人机车手；服务端分配席位并广播完整 roster。
  const btnAddAI = $('btnAddAI');
  if (btnAddAI) {
    btnAddAI.addEventListener('click', () => {
      const room = S.lobbyRoom;
      const isHost = room && (room.host != null ? S.localId === room.host : S.localId === 1);
      if (!isHost || room.started || room.counting || !S.net || !S.net.connected) return;
      S.net.send({ t: 'add_ai_bot' });
    });
  }

  $('btnReady').addEventListener('click', () => {
    S.ready = !S.ready;
    $('btnReady').textContent = S.ready ? '取消准备' : '准备';
    $('btnReady').classList.toggle('primary', !S.ready);
    if (S.net) S.net.send({ t: 'ready', v: S.ready });
  });

  $('btnLeave').addEventListener('click', () => {
    if (S.net) S.net.send({ t: 'leave' });
    S.ready = false;
    $('btnReady').textContent = '准备';
    renderLobby(null);
  });

  $('btnAgain').addEventListener('click', () => {
    hideSettlement();
    if (S.offline) { $('results').classList.add('hidden'); startOffline(); return; }
    if (S.net) S.net.send({ t: 'restart' });
  });

  $('btnQuit').addEventListener('click', () => {
    hideSettlement();
    if (S.offline) {
      $('results').classList.add('hidden');
      location.reload();
      return;
    }
    // 规格 §二："返回大厅" -> 房间复位到 WAITING。
    if (S.net) S.net.send({ t: 'restart' });
    $('results').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    S.mode = 'room';
  });

  // ── 规格 §二：结算 Modal 按钮 ──
  // "返回大厅"：隐藏 Modal + 复位到 WAITING（与 btnQuit 同语义）。
  const stlLobby = $('settleLobby');
  if (stlLobby) {
    stlLobby.addEventListener('click', () => {
      hideSettlement();
      if (S.offline) { $('hud').classList.add('hidden'); location.reload(); return; }
      if (S.net) S.net.send({ t: 'restart' });
      $('results').classList.add('hidden');
      $('hud').classList.add('hidden');
      $('lobby').classList.remove('hidden');
      S.mode = 'room';
    });
  }
  // "再来一局"：隐藏 Modal + 请求重开。
  const stlAgain = $('settleAgain');
  if (stlAgain) {
    stlAgain.addEventListener('click', () => {
      hideSettlement();
      if (S.offline) { startOffline(); return; }
      if (S.net) S.net.send({ t: 'restart' });
    });
  }

  /* ------------------------- 聊天输入（规格 §二 / §三） ------------------------- */

  // 大厅聊天：Enter 发送并清空；ESC 失焦把操控/快捷键交还窗口。
  // 关键：input 的 keydown 必须 stopPropagation —— 否则 window 级 keydown 里的
  // 「Enter 呼出聊天」会与本处「Enter 发送」互相触发，形成打字即抖动。
  const cIn = $('chatInput');
  const cSend = $('chatSend');
  if (cIn) {
    cIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        sendChatText(cIn.value);
        cIn.value = '';
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cIn.blur();
      }
    });
    // 输入框获得焦点时切断驾驶按键（防止 W/A/S/D 残留把车顶死），
    // 失去焦点时清一遍，避免 keyup 被输入框吞掉导致油门粘住。
    cIn.addEventListener('focus', () => releaseDriveKeys());
    cIn.addEventListener('blur', () => releaseDriveKeys());
  }
  if (cSend) {
    cSend.addEventListener('click', () => {
      if (!cIn) return;
      sendChatText(cIn.value);
      cIn.value = '';
      cIn.focus();
    });
  }

  // 局内快捷打字条：Enter 发送并收起；ESC 直接收起（操控权立刻交还）。
  const hIn = $('hudChatInput');
  if (hIn) {
    hIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        sendChatText(hIn.value);
        hIn.value = '';
        closeHudChat();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hIn.value = '';
        closeHudChat();
      }
    });
    hIn.addEventListener('blur', () => releaseDriveKeys());
  }
}

// 依据页面协议推导 WebSocket 端点。
// 页面走 https 时必须用 wss：浏览器会在 `new WebSocket()` 处同步抛 SecurityError
// （混合内容拦截），而该同步异常被 network.js 的 try/catch 吞成 resolve(false)，
// 既不抛到控制台也不触发 onclose ⇒ 重连计数恒为 0、永久失败。
// 归一化 protocol 大小写：规范形态本应是小写带尾冒号，此处只做低成本防御。
function resolveWsUrl(protocol, host) {
  const p = String(protocol || '').toLowerCase();
  return (p === 'https:' ? 'wss://' : 'ws://') + host + '/ws';
}

function wireNet(net) {
  const options = document.createElement('div');
  options.className = 'remote-options';
  options.innerHTML = '<label><input id="p2pEnabled" type="checkbox"> 启用 P2P 车辆直连</label><span id="p2pStatus">默认服务器同步</span><div><input id="remoteGameUrl" type="url" placeholder="远程游戏地址 https://…" aria-label="远程游戏地址"><button id="openRemoteGame" class="btn">进入远程服务器</button></div><small>朋友需进入同一游戏地址和房间。跨网直连需服务器配置 STUN/TURN。</small>';
  $('netinfo').after(options);
  options.querySelector('#p2pEnabled').onchange = async e => {
    try { await net.peers.enable(e.target.checked); net.peers.status(); }
    catch (err) { e.target.checked = false; showToast(err.message); }
  };
  net.on('peerStatus', ({ connected, enabled }) => {
    options.querySelector('#p2pStatus').textContent = enabled ? (connected ? '已直连 ' + connected + ' 位车手' : '等待直连 · 服务器同步可用') : '默认服务器同步';
  });
  options.querySelector('#openRemoteGame').onclick = () => {
    try {
      const url = new URL(options.querySelector('#remoteGameUrl').value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      location.assign(url.href);
    } catch { showToast('请输入完整的 http:// 或 https:// 游戏地址'); }
  };
  net.on('open', () => {
    $('netinfo').innerHTML = '服务端已连接 <b>' + net.url + '</b>';
    // 连上即把本机昵称同步给服务端：服务端新连接的默认名是占位名"车手"，
    // 不同步的话首页左侧在线面板会一直显示"车手"而不是真实昵称。
    const initialName = (($('name') && $('name').value) || '').trim().slice(0, 12);
    if (initialName) net.send({ t: 'rename', name: initialName });
  });
  net.on('reconnecting', (d) => {
    $('netinfo').innerHTML = '<span class="warn">连接断开，正在重连（第 ' + d.attempt + ' 次）…</span>';
  });
  net.on('close', () => {
    $('netinfo').innerHTML = '<span class="warn">与服务端断开</span>';
  });
  net.on('hello', (m) => { S.localId = m.id; });
  net.on('presence', (m) => {
    S.presence = m;
    renderPresence(m, S.lobbyRoom);
  });
  // 一体化聊天总线：服务端下发的玩家发言 / 系统事件 / 倒计时指令全部走这一条。
  // 大厅态进左侧信息流，比赛态同时进局内浮层（onChatMessage 内部按 S.mode 分流）。
  net.on('chat', (m) => onChatMessage(m));
  net.on('room', (m) => {
    S.lobby = m.players || [];
    S.hostId = m.host || S.hostId;
    if (m.started && S.rp) S.rp.setHost(S.hostId);
    if (m.season) renderSeason(m.season);
    // 本地昵称以服务端权威回包为准（防冒名：自标识不能靠自己填的值）。
    // ★ 必须放在所有提前 return **之前**：比赛进行中同样要能刷新（改名/重连后回包）。
    const me = (m.players || []).find((p) => p.id === S.localId);
    if (me && me.name) {
      S.localName = me.name;
      syncPlayerProfile(S.localName);
    }
    if (m.started) return;
    // ★★ 已经在跑的比赛绝不能被 room 报文踢回大厅（2026-09-29 加固）──────────
    // 比赛只能由**权威终局报文**结束：`lobby`（服务端 backToLobby）/ `RACE_RESULTS` /
    // `end` / 本地完赛。`room` 只是"房间看板"刷新，它的 `started` 字段在倒计时期间
    // 仍然是 false（`started` 是 ticker 到点、广播 START 那一刻才置位的），
    // 所以一条在 START 前后擦边送达的 room 报文会把：
    //     S.mode = 'room'  ⇒  主循环走 else 分支  ⇒  S.raceClock = 0
    //                       ⇒  S.rp.racing = false  ⇒  sampleLocalInput 第一道闸就清零油门
    // 结果就是"绿灯亮着、别人的车在跑、**我的车永远动不了**"（用户报的
    // "每次都要等人机走了几步才起步"）。这条护栏与触发原因无关，必须无条件成立。
    if (S.mode === 'race' || S.mode === 'end') return;
    S.mode = 'room';
    renderLobby(m);
    $('hud').classList.add('hidden');
    $('results').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    // 进入房间后展开右侧聊天面板，并把空闲焦点预置到输入框（Enter 即可打字）。
    setChatPanel(true);
  });
  // 服务端权威发车灯序：没有数字倒计时，只有五红灯逐盏熄灭 -> 绿灯放行。
  net.on('startSeq', () => {
    // beginRace 已建立当前场次后，重复序列通知不能清掉已推进的灯序。
    if (S.mode === 'race' && S.rp) { S.startSeqSeen = true; return; }
    resetStartSequence();
    S.startSeqSeen = true;
    armGoFallback();
  });
  // RACE_START：归零放行（权威，绝不缺失）。走统一放行入口。
  net.on('raceStart', () => forceRaceGo('RACE_START'));
  // 阶段二：局内起步灯控（5 盏深红信号灯自左至右依次点亮，stage 6 = 绿灯放行）。
  // 保留旧通道：stage 6 也汇入统一放行入口（双通道冗余）。
  net.on('lights', (m) => {
    const st = m.stage | 0;
    if (st >= 6) forceRaceGo('lights stage6');
    else showStartLights(st);
  });
  // 服务端权威榜单（20Hz）：名次 / 秒差 / 罚时全部以服务端为准，全房间绝对同步。
  net.on('leaderboard', (data) => { S.lb = data; });
  net.on('start', (m) => {
    // ★★ 迟到的重复 start 报文绝不能撤销已经发生的放行（实测间歇性"永远发不出车"）。
    //   报文顺序在负载高时可能变成 raceStart -> start：raceStart 先把 racing 置 true，
    //   随后 start 又跑一遍 beginRace()，而 beginRace 结尾有 `S.rp.racing = false`
    //   ⇒ 放行被撤销，且本地兜底计时器已被这次重入清掉 ⇒ 车永远不动。
    //   已处于比赛态且已放行时，直接忽略重复的 start（幂等）。
    if (S.mode === 'race' && S.rp && S.rp.racing) return;
    S.offline = false;
    // 阶段二：载入场景后所有赛车强制起步锁定，等待 lights stage 1..5 逐盏点亮红灯，
    // stage 6 时红灯全灭绿灯亮 = 放行（showStartLights 负责解锁）。
    hideFinishBar();
    // 进入比赛：大厅聊天面板自动收起，局内浮层接管（规格 §三）。
    setChatPanel(false);
    closeHudChat();
    clearHudChat();
    clearHudCountdown();
    beginRace({
      seed: m.seed,
      track: m.track,          // 服务端权威赛道类型（大厅里房主可切换）
      ghost: m.ghost,          // 服务端权威碰撞模式（全员幽灵车开关）
      gameMode: m.gameMode || (S.lobbyRoom && S.lobbyRoom.gameMode) || 'fm8',
      laps: m.laps,
      grid: m.grid || null,    // 服务端权威发车格：每车独立纵向错位
      roster: rosterFromLobby(S.lobby),
      localId: S.localId,
      startAt: m.at,
    });
    // ★ 本地兜底灯序（与服务端同节拍：250ms 载入 + 5×700ms 红灯 + 绿灯）。
    //   正常情况下服务端 lights 报文会按拍覆盖它；只有 start 报文整段丢失时，
    //   它才会自己把灯序跑完（并用 goReason 标出来，便于排查到底谁放的行）。
    armLocalStartLights('start 报文后本地兜底');
    // ★ 权威兜底计时器：必须长于「本地灯序 + 一点点」，否则会抢在红灯跑完前放行。
    //   当前本地灯序 3750ms ⇒ 给 7.5s（只晚不早）。
    armGoFallback();
    audio.init(); audio.resume();
  });
  net.on('pen', (m) => {
    const car = S.rp && S.rp.byId.get(m.id);
    const total = Math.max(0, finiteNum(m.sec));
    const delta = Math.max(0, finiteNum(m.delta, total));
    if (car) car.penalty = total;
    const name = car ? car.name : ('席位' + m.id);
    if (m.id === S.localId) {
      // ⚠️ 这一次是服务端对**同一次违规**的权威回显，而本地物理链路
      //    （`S.rp.on('penalty')` → `showPenaltyEvent(reason, sec, reason)`）已经弹过一次。
      //    旧实现把 kind 写成 'server'，与本地那次的原因键（如 frr_gain）不同名，
      //    PenaltyController 的"同类合并 / 同键冷却"两条去重都失效 ⇒ 每次罚时弹两遍，
      //    持续压线时表现为"罚时一直弹"。
      //    现在用**同一个原因键**再调一次：控制器会原地合并（不会弹第二条）；若本地链路
      //    整段丢失（Worker 未就绪、事件被吞），这里仍是唯一的兜底展示。
      showPenaltyEvent(m.reason || 'pen', delta, m.reason, S.gameMode);
    } else {
      if (S.gameMode !== 'bumper' && m.reason !== 'wall') showToast(name + ' 被判罚 ' + safeFixed(delta, 1) + 's（' + (PEN_NAME[m.reason] || '赛事规则') + '）');
    }
  });
  net.on('lap', (m) => {
    // Lap state is rendered by the HUD/leaderboard; there is no central lap toast.
  });
  net.on('fin', (m) => {
    const car = S.rp && S.rp.byId.get(m.id);
    const pen = Math.max(0, finiteNum(m.pen));
    const total = finiteNum(m.total, 0);
    const netTime = finiteNum(m.net, total);
    const rank = Math.max(1, m.rank | 0);
    if (car) { car.penalty = pen; car.finished = true; car.totalTime = total; car.rank = rank; }
    if (m.id === S.localId) {
      setAlert('完赛 · P' + rank + ' ｜ 净用时 ' + fmtTime(netTime) + ' + 罚时 ' + safeFixed(pen, 1) + 's = ' + fmtTime(total), 'off');
    } else {
      showToast((car ? car.name : '对手') + ' 完赛 P' + rank);
    }
  });
  net.on('end', (m) => showResults(m.results || []));
  // ── 规格 §二：全员完赛结算流 ──
  // RACE_RESULTS：延迟 1.5s 平滑弹出全屏磨砂结算 Modal（含名次/净时/最快圈/积分）。
  net.on('raceResults', (m) => {
    S.settlement = m.data || [];
    if (S._settlementTimer) clearTimeout(S._settlementTimer);
    S._settlementTimer = setTimeout(() => showSettlement(m.data || []), 1500);
  });
  // SEASON_LEADERBOARD_UPDATE：赛季榜实时重渲染（首页/大厅右侧榜单，无需刷新页面）。
  net.on('seasonUpdate', (m) => {
    S.seasonRankings = m.rankings || [];
    renderSeason(S.seasonRankings);
  });
  net.on('dnf', (m) => {
    // 首位车手冲线后的 60 秒 DNF 宽限倒计时（规格 §五.1）。
    // 对已完赛玩家：只是提示"比赛还在继续"；对未完赛玩家：红色紧迫提示。
    const secs = Math.max(0, m.secs | 0);
    S.dnfLeft = secs;
    const meFin = S.localCar && S.localCar.finished;
    if (meFin) {
      if (secs === 60 || secs % 15 === 0) {
        showToast('比赛继续 · 剩余车手 ' + secs + 's 后判 DNF ｜ C/V 观战', 2600);
      }
    } else if (secs === 60 || secs <= 10 || secs % 15 === 0) {
      setAlert('DNF 倒计时 ' + secs + 's · 尽快冲线', 'off');
    }
  });
  net.on('lobby', () => {
    clearRaceFlowTimers();
    $('results').classList.add('hidden');
    hideSettlement();
    $('hud').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    hideFinishBar();
    resetStartSequence();
    const sl = $('startLights');
    if (sl) sl.classList.add('hidden');
    const io = $('inputOverlay');
    if (io) io.classList.add('hidden');
    S.mode = 'room';
    S.ready = false;
    $('btnReady').textContent = '准备';
    $('btnReady').classList.add('primary');
    renderLobby({ room: net.roomCode, players: net.lobby, laps: net.laps });
    // 回到大厅：收起局内浮层，重新展开右侧聊天面板（历史消息保留在流里）。
    clearHudChat();
    closeHudChat();
    setChatPanel(true);
  });
  net.on('left', (m) => {
    if (S.rp) {
      S.rp.removeCar(m.id);
      const vis = carVisuals.get(m.id);
      if (vis) { scene.remove(vis); carVisuals.delete(m.id); }
    }
    showToast((m.name || '一名车手') + ' 离开了比赛');
  });
  net.on('serverError', (m) => showToast('服务端：' + m.msg, 3200));
}

/* ========================================================================== */
/* 13. 启动                                                                    */
/* ========================================================================== */

async function boot() {
  bootProgress(0.1, '初始化渲染器…');
  await new Promise((r) => setTimeout(r, 16));

  bootProgress(0.35, '纯代码生成 3D 赛道…');
  buildWorld(DEFAULT_SEED);
  await new Promise((r) => setTimeout(r, 16));

  bootProgress(0.7, '构建车辆与 HUD…');
  initSpeedo();
  bindUI();
  driftFX = new DriftFX(scene);      // 漂移烟雾 + 胎痕（纯代码生成）
  await new Promise((r) => setTimeout(r, 16));

  bootProgress(0.9, '连接服务端…');
  const net = new Net();
  S.net = net;
  wireNet(net);
  const ok = await net.connect(resolveWsUrl(location.protocol, location.host));
  if (!ok) {
    $('netinfo').innerHTML = '<span class="warn">未能连接 WebSocket 服务端（' + location.host +
      '）。可以直接使用下方的「单机练习」，或确认服务端仍在运行。</span>';
  }

  // 赛季积分排行榜面板（规格 §一.1）：跟随大厅显隐平滑滑入/滑出。
  // 用 MutationObserver 监听 #lobby 的 hidden 类，避免逐个修改 lobby 显隐调用点。
  {
    const lobbyEl = $('lobby');
    const seasonEl = $('season');
    if (lobbyEl && seasonEl) {
      const sync = () => seasonEl.classList.toggle('show', !lobbyEl.classList.contains('hidden'));
      new MutationObserver(sync).observe(lobbyEl, { attributes: true, attributeFilter: ['class'] });
      sync();
    }
    loadSeason();   // 未加入房间时也展示已有赛季榜（HTTP 拉取一次）
  }

  bootProgress(1, '就绪');
  setTimeout(() => {
    $('boot').classList.add('hidden');
    // 只有仍处于 boot 阶段才切到大厅：?solo=1 会在此之前就已进入比赛，
    // 无脑写 S.mode='menu' 会把刚建立起来的比赛状态冲掉。
    if (S.mode === 'boot') {
      $('lobby').classList.remove('hidden');
      S.mode = 'menu';
    }
  }, 220);

  // 调试/自动化入口（也是无头浏览器验收测试的入口）：
  //   ?solo=1        直接进入单机练习，跳过大厅点击
  //   ?seed=12345    固定赛道种子，便于复现
  //   ?track=vegas   指定赛道（suzuka|vegas），便于截图验收
  //   ?laps=2        预设圈数
  //   ?drift=1       自动驾驶漂移演示（验收烟雾/胎痕）
  //   ?dbg=1         运行期读数面板
  const qs = new URLSearchParams(location.search);
  if (qs.get('laps')) {
    const l = parseInt(qs.get('laps'), 10);
    if (l > 0) $('laps').value = String(Math.min(l, 8));
  }
  if (qs.get('seed')) FORCE_SEED = (parseInt(qs.get('seed'), 10) >>> 0) || 0;
  // ?track=vegas 直接指定赛道（截图/验收用）。未知值会在 Track 构造里回落铃鹿，
  // 这里不做白名单，避免和 track.js 的 TRACK_TYPES 出现第二份真相。
  if (qs.get('track') && $('track')) $('track').value = qs.get('track');
  if (qs.get('mode') && $('gameMode')) {
    const m = qs.get('mode');
    $('gameMode').value = m === 'horizon' ? 'horizon' : m === 'bumper' ? 'bumper' : 'fm8';
  }
  if (qs.has('drift')) S.demoDrift = true;
  if (qs.has('rescue')) S.demoRescue = true;
  // ?draft=1 尾流涡线常亮（无头截图验收专用：正常要满足吸尾流条件才发光）
  if (qs.has('draft')) S.demoDraft = true;
  // ?ghost=1 全员幽灵车模式（车车不碰撞，可穿透）
  if (qs.get('ghost') !== null && $('ghost')) $('ghost').checked = qs.get('ghost') !== '0';
  // ?cam=0|1|2 直接指定初始视角（0 追尾 / 1 引擎盖 / 2 垂直鸟瞰），用于截图验收
  if (qs.get('cam') !== null) {
    const c = parseInt(qs.get('cam'), 10);
    if (c >= 0 && c < CAM.CAM_COUNT) S.camMode = c;
  }
  if (qs.has('dbg')) {
    dbgEl = document.createElement('pre');
    dbgEl.id = 'dbg';
    dbgEl.className = 'dbg';
    document.body.appendChild(dbgEl);
    // 无头验收用：把 console.error（含 three 的着色器编译错误）捕获进读数面板，
    // 否则这类错误在无头环境里完全看不到，只会表现为"某个网格莫名不绘制"。
    const _err = console.error.bind(console);
    console.error = (...a) => {
      dbgErr = (dbgErr + ' | ' + a.map((x) => String(x)).join(' ')).slice(-600);
      _err(...a);
    };
  }
  if (qs.has('solo')) {
    $('boot').classList.add('hidden');
    startOffline();
  }

  requestAnimationFrame(loop);
}

boot().catch((e) => {
  console.error(e);
  fatal('启动失败', e && e.message ? e.message : String(e));
});
