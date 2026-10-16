// 网络历史缓冲只做时间采样；不施加追赶力，也不拥有渲染器或 Cannon。
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export class RemoteSnapshotBuffer {
  constructor() {
    this.samples = [];
    this.pose = { p: {x:0,y:0,z:0}, q: {x:0,y:0,z:0,w:1}, v: {x:0,y:0,z:0}, u: [0,0,0,0] };
    this.lastTargetTime = -Infinity;
    this.lastReceive = -Infinity;
    this.recovering = false;
    this.initialized = false;
  }
  /** 清空历史。新一局 / 重连 / 编队换手时调用，避免旧时间轴残留。 */
  reset() {
    this.samples.length = 0;
    this.lastTargetTime = -Infinity;
    this.lastReceive = -Infinity;
    this.recovering = false;
    this.initialized = false;
  }

  push(sample, receivedAt) {
    const h = this.samples;
    if (!sample || !Number.isFinite(sample.t)) return false;
    if (h.length) {
      const last = h[h.length - 1];
      const seq = sample.seq || 0;
      const lastSeq = last.seq || 0;
      // P2P 与服务端可重复、乱序到达；旧包不得重置历史。
      // 新局与房主交接由生命周期显式 reset。
      {
        // ② 真·乱序 / 重放：丢弃。
        if (seq > 0 && lastSeq > 0 && seq <= lastSeq) return false;
        const lastT = last.t;
        if (sample.t < lastT) {
          // ③ 时钟域重标定（monoOffset 取窗口内最小 RTT 样本，会向下微调）会让同一辆车的
          //    新包时间戳轻微回退。小幅回退钳到单调轴上而不是丢包 —— 丢包会让该车在
          //    "重标定幅度 ÷ 报文间隔" 帧内完全冻结；大幅回退才判为真乱序。
          if (lastT - sample.t > 150) return false;
          sample.t = lastT + 1;
        } else if (sample.t === lastT) {
          sample.t = lastT + 1;
        }
      }
    }
    this.recovering ||= this.initialized && receivedAt - this.lastReceive > 250;
    this.lastReceive = receivedAt;
    h.push(sample);
    while (h.length > 64 || (h.length > 2 && sample.t - h[0].t > 2000)) h.shift();
    return true;
  }
  sample(targetTime, dt = 1 / 60) {
    const h = this.samples;
    if (!h.length) return null;
    targetTime = Math.max(this.lastTargetTime, targetTime);
    this.lastTargetTime = targetTime;
    let a = h[0], b = a;
    for (let i = 1; i < h.length; i++) {
      b = h[i];
      if (b.t >= targetTime) break;
      a = b;
    }
    const span = Math.max(0, (b.t - a.t) / 1000);
    const s = span ? clamp((targetTime - a.t) / (span * 1000), 0, 1) : 1;
    const ex = clamp((targetTime - b.t) / 1000, 0, 0.25);
    const s2 = s*s, s3 = s2*s;
    const k0 = 2*s3-3*s2+1, k1 = s3-2*s2+s, k2 = -2*s3+3*s2, k3 = s3-s2;
    const out = this.pose;
    const blend = this.recovering && this.initialized ? 1 - Math.exp(-8 * dt) : 1;
    let error = 0;
    for (const axis of ['x','y','z']) {
      const p = ex > 0 ? b.p[axis] + b.v[axis] * ex : k0*a.p[axis] + k1*span*a.v[axis] + k2*b.p[axis] + k3*span*b.v[axis];
      const predicted = out.p[axis] + out.v[axis] * dt;
      error += (p - predicted) ** 2;
      out.p[axis] = blend < 1 ? predicted + (p - predicted)*blend : p;
      out.v[axis] = targetTime - b.t > 250 ? 0 : a.v[axis] + (b.v[axis] - a.v[axis])*s;
    }
    const aq = a.q, bq = b.q;
    let dot = aq.x*bq.x+aq.y*bq.y+aq.z*bq.z+aq.w*bq.w;
    const sign = dot < 0 ? -1 : 1;
    dot = clamp(Math.abs(dot), 0, 1);
    let ka = 1-s, kb = s;
    if (dot < 0.9995) { const ang = Math.acos(dot), sin = Math.sin(ang); ka = Math.sin((1-s)*ang)/sin; kb = Math.sin(s*ang)/sin; }
    const q = out.q;
    const target = [ka*aq.x+kb*bq.x*sign, ka*aq.y+kb*bq.y*sign, ka*aq.z+kb*bq.z*sign, ka*aq.w+kb*bq.w*sign];
    const qs = q.x*target[0]+q.y*target[1]+q.z*target[2]+q.w*target[3] < 0 ? -1 : 1;
    q.x += (target[0]*qs-q.x)*blend; q.y += (target[1]*qs-q.y)*blend;
    q.z += (target[2]*qs-q.z)*blend; q.w += (target[3]*qs-q.w)*blend;
    const norm = Math.hypot(q.x,q.y,q.z,q.w) || 1;
    q.x/=norm; q.y/=norm; q.z/=norm; q.w/=norm;
    for (let i=0; i<4; i++) out.u[i] = b.u[i];
    if (this.recovering && error < 0.0025) this.recovering = false;
    this.initialized = true;
    return out;
  }
}
