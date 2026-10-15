// 所有裁决统一由顶部两阶段通知消费；物理层只报告事件，不操作 DOM。
export const PENALTY_TIMING = Object.freeze({ investigate: 2500, verdict: 3000, exit: 420 });
const REASONS = Object.freeze({
  ram: '造成碰撞', collision: '造成碰撞', frr_gain: '偏离赛道', offtrack: '偏离赛道',
  cut: '切弯获利', shortcut: '切弯获利', rescue: '失控复位', wall: '撞击',
});

/**
 * 罚时原因**归一化**：同一个物理事故在不同链路上用不同键名上报
 * （本地物理 `onIncident` 用 `frr_gain`，服务端 `case "pen"` 回显用 `reason`，
 *  HUD 文案可能是中文）。若不归并，同一次违规会被当成两类事故分别入队，
 * 表现就是"罚时提示一条接一条弹不完"。
 */
export function normalizePenaltyKey(rawKey, reason, wallImpact = false) {
  if (wallImpact) return 'wall';
  const k = String(rawKey || reason || 'collision').toLowerCase();
  if (k === 'frr_gain' || k === 'offtrack' || k === '偏离赛道' || k === '离开赛道') return 'offtrack';
  if (k === 'cut' || k === 'shortcut' || k === '切弯获利' || k === '抄近道' || k === '切弯') return 'cut';
  if (k === 'ram' || k === 'collision' || k === '造成碰撞' || k === '撞击') return 'collision';
  if (k === 'rescue' || k === '失控复位' || k === '脱困复位') return 'rescue';
  return k;
}

export class PenaltyController {
  constructor({ root = null, getMode = () => 'fm8', clock = () => performance.now(),
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) } = {}) {
    this.root = root;
    this.getMode = getMode;
    this.clock = clock;
    this.schedule = schedule;
    this.cancel = cancel;
    this.queue = [];
    this.active = null;
    this.timers = [];
    this.phase = 'idle';
    this.lastEvent = -Infinity;
    // 每个归一化原因键的"上次入队时刻"。用于同类型冷却，避免持续压线/擦墙时连环弹窗。
    this.lastByKey = new Map();
  }

  show(reason, seconds = 0, kind = '', mode = this.getMode()) {
    if (mode === 'horizon') { this.clear(); return false; }
    // 护栏撞击不产生罚时，但仍显示调查与裁决动画，让玩家知道碰撞已被记录。
    const wallImpact = kind === 'wall' || reason === 'wall' || reason === '撞击护栏';
    const sec = wallImpact ? 0 : Math.max(0, Number(seconds) || 0);
    const rawKey = wallImpact ? 'wall' : (kind || reason || 'collision');
    // ★ 归一化：`frr_gain` / `offtrack` / `偏离赛道` 视为同一类事故，
    //   `cut` / `shortcut` / `切弯获利` 同理。否则同一次违规会被拆成多条队列项。
    const key = normalizePenaltyKey(rawKey, reason, wallImpact);
    const label = (REASONS[rawKey] || REASONS[key] || REASONS[reason] || String(reason || '撞击')).slice(0, 6);
    const title = ['ram', 'collision', 'wall'].includes(key) ? '撞击' : label;
    const now = this.clock();
    const entry = { key, title, label, sec, time: now };

    // ① 当前正在展示**同一类**事故 ⇒ 绝不重复入队。
    //    原实现只在 phase === 'investigating' 时合并，于是"本地物理先报调查 →
    //    服务端广播回显再报一次"在裁决阶段会各弹一条相同的提示。
    if (this.active && this.active.key === key) {
      this.lastEvent = now;
      this.lastByKey.set(key, now);
      if (this.phase === 'leaving') return false;      // 已在退场：只续冷却，不重新弹
      if (sec > this.active.sec) {
        this.active.sec = sec;
        this.active.label = label;
        if (this.phase === 'verdict') this._refreshVerdict(this.active);
      }
      return true;
    }

    // ② 同类冷却期：本地物理与网络回显是两条独立链路，"同一次违规"必然在几十毫秒内
    //    到达两次；持续压草皮/连续擦护栏更是每帧都可能触发。冷静期内直接忽略。
    const prevKeyTime = this.lastByKey.get(key) ?? -Infinity;
    const cooldownMs = sec > 0 ? 4500 : 6000;
    if (now - prevKeyTime < cooldownMs) return false;

    // ③ 待播队列里已有同类 ⇒ 原地合并秒数，不再新增一条。
    const queuedSame = this.queue.find((item) => item.key === key);
    if (queuedSame) {
      queuedSame.sec = Math.max(queuedSame.sec, sec);
      this.lastEvent = now;
      this.lastByKey.set(key, now);
      return true;
    }
    // ④ 已有有偿罚时在展示时，丢弃 0 秒的擦墙/擦碰提示（避免"弹完一条又弹一条无处罚"）。
    if (this.active && sec === 0) return false;

    this.lastEvent = now;
    this.lastByKey.set(key, now);
    if (this.active) {
      // ★ 待播队列上限收敛到 **1** 条：单条展示约 5.9s（2.5 调查 + 3.0 裁决 + 0.42 退场），
      //   旧的 8 条上限意味着最长近 50 秒的连环弹窗 —— 正是"罚时一直弹"的根因。
      //   新的更严重事故覆盖待播项，否则丢弃。
      if (this.queue.length === 0) this.queue.push(entry);
      else if (sec > this.queue[0].sec) this.queue[0] = entry;
    } else {
      this._start(entry);
    }
    return true;
  }

  /** 裁决阶段原地升级秒数（不重新挂载 DOM、不重排队列）。 */
  _refreshVerdict(entry) {
    const root = this.root;
    if (!root) return;
    const text = entry.sec > 0 ? `+${entry.sec.toFixed(3)}s` : '无处罚';
    const verdict = root.querySelector('.impact-verdict');
    if (verdict) verdict.textContent = text;
    root.classList.toggle('penalized', entry.sec > 0);
    root.setAttribute('aria-label', `${entry.label}，${text}`);
  }

  _start(entry) {
    if (this.getMode() === 'horizon') { this.clear(); return; }
    this.active = entry;
    this.phase = 'investigating';
    this.startedAt = this.clock();
    this._mount(entry);
    this._later(() => this._resolve(), PENALTY_TIMING.investigate);
  }

  _mount(entry) {
    const root = this.root || (typeof document !== 'undefined' && document.getElementById('frrBanner'));
    if (!root) return;
    this.root = root;
    const doc = root.ownerDocument;
    const investigation = doc.createElement('div');
    investigation.className = 'impact-investigating';
    const label = doc.createElement('span');
    label.className = 'impact-label'; label.id = 'frrTxt'; label.textContent = entry.title;
    const loader = doc.createElement('span');
    loader.className = 'impact-loader'; loader.setAttribute('aria-label', '调查中');
    investigation.append(label, loader);
    const result = doc.createElement('div');
    result.className = 'impact-result';
    const reason = doc.createElement('span');
    reason.className = 'impact-result-label'; reason.textContent = entry.title;
    const verdict = doc.createElement('span');
    verdict.className = 'impact-verdict'; verdict.id = 'impactVerdict';
    result.append(reason, verdict);
    root.replaceChildren(investigation, result);
    root.hidden = false;
    root.className = 'frr impact';
    root.dataset.phase = 'investigating';
    root.dataset.reason = entry.label;
    root.dataset.startedAt = String(this.startedAt);
    root.style.setProperty('--penalty-width', `${Math.max(94, entry.title.length * 16 + 55)}px`);
    root.setAttribute('aria-label', `${entry.title}，调查中`);
    // 每条通知只触发布局一次，让 display:none 之后的下滑也有起始帧。
    root.getBoundingClientRect();
    root.classList.add('on');
  }

  _resolve() {
    if (!this.active) return;
    if (this.getMode() === 'horizon') { this.clear(); return; }
    this.phase = 'verdict';
    const root = this.root;
    const text = this.active.sec > 0 ? `+${this.active.sec.toFixed(3)}s` : '无处罚';
    if (root) {
      this._refreshVerdict(this.active);
      root.classList.add('result');
      root.dataset.phase = this.phase;
      root.dataset.verdictAt = String(this.clock());
      root.setAttribute('aria-label', `${this.active.label}，${text}`);
    }
    this._later(() => this._leave(), PENALTY_TIMING.verdict);
  }

  _leave() {
    this.phase = 'leaving';
    if (this.root) {
      this.root.classList.remove('on');
      this.root.dataset.phase = this.phase;
      this.root.dataset.exitAt = String(this.clock());
    }
    this._later(() => {
      if (this.root) { this.root.hidden = true; this.root.replaceChildren(); this.root.dataset.phase = 'idle'; }
      this.active = null;
      this.phase = 'idle';
      this.timers.length = 0;
      const next = this.queue.shift();
      if (next) this._start(next);
    }, PENALTY_TIMING.exit);
  }

  _later(fn, ms) { this.timers.push(this.schedule(fn, ms)); }

  clear() {
    for (const id of this.timers) this.cancel(id);
    this.timers.length = 0;
    this.queue.length = 0;
    this.active = null;
    this.phase = 'idle';
    this.lastByKey.clear();
    if (this.root) {
      this.root.classList.remove('on', 'result', 'penalized');
      this.root.hidden = true;
      this.root.replaceChildren();
      this.root.dataset.phase = 'idle';
    }
  }
}

let currentMode = 'fm8';
const controller = new PenaltyController({ getMode: () => currentMode });
export function showPenaltyEvent(reason, seconds = 0, kind = '', mode = 'fm8') {
  currentMode = mode;
  return controller.show(reason, seconds, kind, mode);
}
export function setPenaltyMode(mode) {
  currentMode = mode === 'horizon' ? 'horizon' : 'fm8';
  if (currentMode === 'horizon') controller.clear();
}
export function clearPenaltyEvents() { controller.clear(); }
