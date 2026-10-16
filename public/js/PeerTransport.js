// WebSocket owns rooms/results. WebRTC carries disposable pose snapshots only.
export class PeerTransport {
  constructor(net) {
    this.net = net; this.enabled = false; this.peers = new Map(); this.roster = []; this.host = 0; this.room = '';
    this.config = { iceServers: [] };
    this.configReady = false; this.enableVersion = 0;
    net.on('room', m => this.sync(m));
    net.on('rtc', m => {
      const pending = this.signal(m), peer = this.peers.get(m.from);
      pending.catch(() => { if (this.peers.get(m.from) === peer) this.drop(m.from); });
    });
    net.on('close', () => this.clear());
    net.on('lobby', () => this.clear());
    net.on('start', () => { for (const p of this.peers.values()) p.lastSeq.clear(); });
    net.on('left', m => this.drop(m.id));
  }
  async enable(value) {
    const version = ++this.enableVersion;
    this.configReady = false;
    for (const id of this.peers.keys()) this.sendSignal(id, { bye:true });
    this.enabled = !!value; this.clear();
    if (!this.enabled) return;
    if (typeof RTCPeerConnection === 'undefined') { this.enabled = false; throw new Error('当前浏览器不支持 WebRTC'); }
    let config = { iceServers: [] };
    try {
      const base = new URL(this.net.url); base.protocol = base.protocol === 'wss:' ? 'https:' : 'http:'; base.pathname = '/api/rtc-config';
      const response = await fetch(base, { signal:AbortSignal.timeout(5000) });
      if (response.ok) config = await response.json();
    } catch { /* Host candidates can still connect on a LAN. */ }
    if (version !== this.enableVersion || !this.enabled) return;
    this.config = config; this.configReady = true;
    if (this.enabled) for (const p of this.roster) if (!p.ai && p.id !== this.net.myId) this.sendSignal(p.id, { ready:true });
  }
  sync(room) {
    if (this.host !== room.host) for (const p of this.peers.values()) p.lastSeq.clear();
    if (room.room !== this.room) this.clear();
    const old = new Set(this.roster.map(p => p.id));
    this.room = room.room; this.roster = room.players || []; this.host = room.host;
    const humans = new Set(this.roster.filter(p => !p.ai && p.id !== this.net.myId).map(p => p.id));
    for (const id of this.peers.keys()) if (!humans.has(id)) this.drop(id);
    if (this.enabled) for (const id of humans) if (!old.has(id) || !this.peers.has(id)) this.sendSignal(id, { ready:true });
  }
  sendSignal(to, signal) { this.net.send({ t:'rtc', to, signal }); }
  peer(id) {
    if (this.peers.has(id)) return this.peers.get(id);
    const pc = new RTCPeerConnection(this.config);
    const p = { pc, channel:null, candidates:[], lastSeq:new Map(), offering:false }; this.peers.set(id, p);
    pc.onicecandidate = e => { if (this.peers.get(id) === p && e.candidate) this.sendSignal(id, { candidate:e.candidate.toJSON() }); };
    pc.ondatachannel = e => { if (this.peers.get(id) === p) this.channel(id, p, e.channel); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop(id); this.status(); };
    return p;
  }
  async signal({ from, signal }) {
    if (signal?.bye) { this.drop(from); return; }
    if (!this.enabled || !this.configReady || !this.roster.some(p => p.id === from && !p.ai) || from === this.net.myId || !signal) return;
    const p = this.peer(from), pc = p.pc;
    if (signal.ready) {
      if (this.net.myId < from && !pc.localDescription && !p.offering) {
        p.offering = true;
        this.channel(from, p, pc.createDataChannel('poses', { ordered:false, maxRetransmits:0 }));
        const offer = await pc.createOffer();
        if (this.peers.get(from) !== p) return;
        await pc.setLocalDescription(offer);
        if (this.peers.get(from) !== p) return;
        this.sendSignal(from, { description:pc.localDescription });
      } else if (this.net.myId > from && !pc.remoteDescription) this.sendSignal(from, { ready:true });
    } else if (signal.description) {
      const d = signal.description;
      if (d.type !== 'offer' && d.type !== 'answer') return;
      await pc.setRemoteDescription(d);
      if (this.peers.get(from) !== p) return;
      for (const c of p.candidates.splice(0)) { await pc.addIceCandidate(c); if (this.peers.get(from) !== p) return; }
      if (d.type === 'offer') {
        const answer = await pc.createAnswer();
        if (this.peers.get(from) !== p) return;
        await pc.setLocalDescription(answer);
        if (this.peers.get(from) === p) this.sendSignal(from, { description:pc.localDescription });
      }
    } else if (signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else if (p.candidates.length < 64) p.candidates.push(signal.candidate);
    }
  }
  channel(id, peer, channel) {
    peer.channel = channel;
    channel.onopen = channel.onclose = () => this.status();
    channel.onmessage = e => {
      if (this.peers.get(id) !== peer) return;
      if (typeof e.data !== 'string' || e.data.length > 4096) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m || m.race !== this.net.raceId || !this.net.raceId) return;
      const car = this.roster.find(c => c.id === m.id);
      if (!car || !(m.id === id || (car.ai && id === this.host)) || !m.d || m.t !== 'state') return;
      if (!Number.isInteger(m.seq) || m.seq <= (peer.lastSeq.get(m.id) || 0)) return;
      const d = m.d;
      if (!Array.isArray(d.q) || !Array.isArray(d.v) || d.q.length !== 4 || d.v.length !== 3 || ![d.x,d.y,d.z,...d.q,...d.v].every(Number.isFinite)) return;
      peer.lastSeq.set(m.id, m.seq);
      this.net.dispatch(m);
    };
  }
  publish(packet) {
    if (!this.enabled) return;
    const payload = JSON.stringify(packet);
    for (const p of this.peers.values()) if (p.channel?.readyState === 'open' && p.channel.bufferedAmount < 32768) {
      try { p.channel.send(payload); } catch { /* Server transport remains active. */ }
    }
  }
  status() { this.net.emit('peerStatus', { connected:[...this.peers.values()].filter(p => p.channel?.readyState === 'open').length, enabled:this.enabled }); }
  drop(id) { const p = this.peers.get(id); this.peers.delete(id); if (p) { p.pc.onconnectionstatechange = null; p.pc.close(); } this.status(); }
  clear() { for (const id of [...this.peers.keys()]) this.drop(id); }
}
