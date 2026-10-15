package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

/*
 * 用户报障回归："人机不要记为在线玩家" + "双方互相显示在起点挂机"。
 *
 * 四条独立根因，各配一条反例：
 *   ① 人机名（"AI · 银箭"）不在占位名过滤器里 ⇒ 人机被写进 scores.json 与赛季榜
 *      （实测旧文件里混了 6 条 AI · * 条目）。
 *   ② 历史残留的人机条目在 loadPoints 时不会被剔除 ⇒ 每局重开都会被赛季榜重新读到。
 *   ③ /api/info 用 len(players) 统计房间人数 ⇒ 人机被算作"在线玩家"。
 *   ④ state 报文的 id 一旦与发送者的席位不一致（重连/切房残留），旧实现直接判"越权"
 *      返回 false ⇒ 该玩家的**全部** state/lap/fin 被静默丢弃 ⇒ 别人看他永远停在发车格。
 */

func TestIsDefaultNameFiltersBotsButKeepsRealNames(t *testing.T) {
	// 人机与占位名必须被过滤（前缀精确到实际生成格式 "AI · X"）
	for _, bot := range []string{"AI · 银箭", "AI · 猎风", "ai · kestrel", "bot_1", "AI_2", "车手3", "Guest_9", "默认玩家"} {
		if !isDefaultName(bot) {
			t.Fatalf("人机/占位名 %q 未被过滤", bot)
		}
	}
	// 真人名不得被误杀：宽松的 "ai " 前缀会把 "AI 爱好者" 一起吃掉。
	// （注意 "车手…"/"游客…" 属于**既有**宽前缀规则，"车手爸爸" 这类名字一直会被
	//   判定为占位名 —— 那是历史行为，本次不动，只保证人机前缀是**精确**的。）
	for _, human := range []string{"AI 爱好者", "AI", "Aiden", "人机克星", "D", "神", "极速蜗牛"} {
		if isDefaultName(human) {
			t.Fatalf("真人名 %q 被误判为默认名", human)
		}
	}
	// 窄谓词只认机器生成的人机名：删除磁盘数据只能依据它。
	for _, bot := range []string{"AI · 银箭", "ai · kestrel", "AI_2", "bot_7"} {
		if !isBotName(strings.ToLower(bot)) {
			t.Fatalf("isBotName 漏掉人机名 %q", bot)
		}
	}
	for _, human := range []string{"车手B", "车手2", "游客中心", "AI 爱好者"} {
		if isBotName(strings.ToLower(human)) {
			t.Fatalf("isBotName 误伤真人名 %q（会导致 loadPoints 不可逆地删掉他的积分）", human)
		}
	}
}

// ① 人机能进赛季榜？addPoints 必须把它们挡在门外。
func TestAddPointsRejectsBotNames(t *testing.T) {
	h := newHub()
	h.mu.Lock()
	h.addPoints("AI · 银箭", 10)
	h.addPoints("真人车手甲", 10)
	_, botHas := h.points["AI · 银箭"]
	_, humanHas := h.points["真人车手甲"]
	h.mu.Unlock()
	if botHas {
		t.Fatal("人机名被写入了赛季积分表")
	}
	if !humanHas {
		t.Fatal("真人积分未写入")
	}
}

// ② 历史残留的人机条目必须在载入时被剔除，并把清理结果回写磁盘。
func TestLoadPointsDropsLegacyBotEntries(t *testing.T) {
	// 本模块 go.mod 声明 go1.21（`t.Chdir` 需要 1.24），因此手工切工作目录；
	// scoresFile 是相对路径，切目录即可让 loadPoints/savePoints 落在临时目录里，
	// 绝不会碰到仓库里真实的 scores.json。
	origWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("读取工作目录失败: %v", err)
	}
	dir := t.TempDir()
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("切换工作目录失败: %v", err)
	}
	defer func() { _ = os.Chdir(origWD) }()
	seed := map[string]int64{"AI · 银箭": 136, "AI · 黑曜": 8, "D": 1608, "车手B": 1375}
	raw, _ := json.Marshal(seed)
	if err := os.WriteFile(scoresFile, raw, 0o644); err != nil {
		t.Fatalf("写入测试存档失败: %v", err)
	}
	h := newHub() // newHub → loadPoints（含清理）
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, bad := h.points["AI · 银箭"]; bad {
		t.Fatal("载入后仍保留人机条目 AI · 银箭")
	}
	// ★ 清理只能删人机：宽前缀名（车手B）虽然不上榜，但其积分属于**可能真实的**玩家，
	//   绝不能因为"清理人机"而不可逆地删掉。
	if h.points["D"] != 1608 || h.points["车手B"] != 1375 {
		t.Fatalf("真人积分在清理中丢失: %+v", h.points)
	}
	// ★ 读盘必须**零副作用**：载入期绝不许改写存档。
	//   （曾经在 loadPoints 里 savePoints，导致任何"起一次 hub"的单元测试都会在
	//     仓库工作目录里重写真实 scores.json —— 实测误删过真人积分。）
	rawNow, err := os.ReadFile(scoresFile)
	if err != nil {
		t.Fatalf("读取存档失败: %v", err)
	}
	var onDisk map[string]int64
	if json.Unmarshal(rawNow, &onDisk) != nil {
		t.Fatalf("存档被破坏: %s", rawNow)
	}
	if len(onDisk) != len(seed) {
		t.Fatalf("载入期改写了存档（读盘必须零副作用）：%d -> %d 条", len(seed), len(onDisk))
	}

	// 清理发生在**写**这一侧：任何一次正常结算落盘都会顺带把人机条目清掉。
	h.savePoints()
	out, err := os.ReadFile(scoresFile)
	if err != nil {
		t.Fatalf("写出存档失败: %v", err)
	}
	var back map[string]int64
	if json.Unmarshal(out, &back) != nil {
		t.Fatalf("写出的存档不是合法 JSON: %s", out)
	}
	if _, bad := back["AI · 银箭"]; bad {
		t.Fatal("落盘后的存档里仍有人机条目")
	}
	if back["D"] != 1608 || back["车手B"] != 1375 {
		t.Fatalf("落盘时误删了真人积分: %+v", back)
	}
}

// ③ 人机不算在线玩家：房间人数与 /api/info 都只统计真人。
func TestHumanCountExcludesBots(t *testing.T) {
	h := newHub()
	r := &Room{hub: h, id: "HCNT", laps: 3, trackType: "suzuka", gameMode: "fm8", close: make(chan struct{})}
	h.rooms[r.id] = r
	human := newProtocolTestClient("真人")
	attachProtocolTestClient(t, h, r, human)
	r.mu.Lock()
	r.players = append(r.players, &Client{ai: true, id: 3, name: "AI · 银箭", color: "#c0c7d1", ready: true, ownerID: human.id, room: r})
	count := r.humanCountLocked()
	total := len(r.players)
	msg := string(r.roomMsgLocked(human.id))
	r.mu.Unlock()

	if total != 2 {
		t.Fatalf("前提不成立：房间应有 1 真人 + 1 人机，实际 %d 席", total)
	}
	if count != 1 {
		t.Fatalf("humanCountLocked 把人数算成 %d（应只统计真人 = 1）", count)
	}
	if !contains(msg, `"humanCount":1`) {
		t.Fatalf("room 报文未下发 humanCount=1（前端只能拿 players.length 才会把人机算进去）:\n%s", msg)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// ④ id 与会话席位不一致时，state/lap 必须退化为"记到发送者自己头上"而不是静默丢弃。
func TestStateWithStaleIdIsAttributedToSender(t *testing.T) {
	h := newHub()
	r := &Room{hub: h, id: "ATTR", laps: 3, trackType: "suzuka", gameMode: "fm8", close: make(chan struct{})}
	h.rooms[r.id] = r
	a := newProtocolTestClient("A")
	b := newProtocolTestClient("B")
	attachProtocolTestClient(t, h, r, a)
	attachProtocolTestClient(t, h, r, b)
	r.mu.Lock()
	r.started = true
	r.racing = true
	r.mu.Unlock()

	// A 误报成 B 的席位号（重连/切房残留的真实形态）
	packet := []byte(`{"t":"state","id":` + itoa(b.id) + `,"seq":1,"d":{"x":1,"y":2,"z":3,"q":[0,0,0,1]}}`)
	h.handleFrame(a, packet)
	r.mu.Lock()
	aHasState := len(a.state) > 0
	bHasState := len(b.state) > 0
	r.mu.Unlock()
	if !aHasState {
		t.Fatal("★id 失配时 A 的位姿被静默丢弃（别人看他永远停在发车格）")
	}
	if bHasState {
		t.Fatal("★id 失配时写到了 B 的头上（越权写入）")
	}

	// 真正的越权仍必须被拒：非房主不得伪造房主名下的人机
	r.mu.Lock()
	bot := &Client{ai: true, id: 9, name: "AI · 黑曜", color: "#8f5cff", ready: true, ownerID: a.id}
	bot.room = r
	r.players = append(r.players, bot)
	r.mu.Unlock()
	h.handleFrame(b, []byte(`{"t":"state","id":9,"seq":2,"d":{"x":9,"y":9,"z":9,"q":[0,0,0,1]}}`))
	r.mu.Lock()
	botHasState := len(bot.state) > 0
	r.mu.Unlock()
	if botHasState {
		t.Fatal("非房主仍可伪造人机 state（越权未拦住）")
	}
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}

// 碰碰车模式进服务端白名单，且与幽灵车互斥（建房 / 切模式两处都强制实体）。
func TestBumperGameModeWhitelistAndGhostExclusion(t *testing.T) {
	for _, alias := range []string{"bumper", "BUMPER", " bumper ", "bumper-car", "碰碰车", "碰碰车模式"} {
		if got := sanitizeGameMode(alias); got != "bumper" {
			t.Fatalf("sanitizeGameMode(%q) = %q，应为 bumper", alias, got)
		}
	}
	if sanitizeGameMode("nonsense") != "fm8" {
		t.Fatal("未知模式必须回落 fm8")
	}
	if !bumperForcesGhostOff("bumper") || bumperForcesGhostOff("fm8") || bumperForcesGhostOff("horizon") {
		t.Fatal("bumperForcesGhostOff 只在碰碰车模式返回 true")
	}
	if got := gameModeDisplayName("bumper"); got != "碰碰车模式 · 全程实体对抗" {
		t.Fatalf("gameModeDisplayName(bumper) = %q", got)
	}

	// 建房时请求 ghost=true 也必须被强制关掉（碰碰车全程实体）
	h := newHub()
	c := newProtocolTestClient("Host")
	h.mu.Lock()
	c.id = 1
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	h.create(c, 3, "suzuka", true, "bumper")
	rm := c.room
	if rm == nil {
		t.Fatal("建房失败")
	}
	rm.mu.Lock()
	mode, ghost := rm.gameMode, rm.ghost
	rm.mu.Unlock()
	if mode != "bumper" {
		t.Fatalf("房间模式 = %q，应为 bumper", mode)
	}
	if ghost {
		t.Fatal("★碰碰车房间仍带着 ghost=true（与全程实体矛盾）")
	}

	// 切到碰碰车时也必须把已开启的幽灵车关掉
	h2 := newHub()
	c2 := newProtocolTestClient("Host")
	h2.mu.Lock()
	c2.id = 1
	h2.clients[c2] = struct{}{}
	h2.mu.Unlock()
	h2.create(c2, 3, "suzuka", true, "fm8")
	rm2 := c2.room
	rm2.mu.Lock()
	ghostBefore := rm2.ghost
	rm2.mu.Unlock()
	if !ghostBefore {
		t.Fatal("前提不成立：fm8 房间应能开启幽灵车")
	}
	h2.handleFrame(c2, []byte(`{"t":"gamemode","gameMode":"bumper"}`))
	rm2.mu.Lock()
	ghostAfter, modeAfter := rm2.ghost, rm2.gameMode
	rm2.mu.Unlock()
	if modeAfter != "bumper" || ghostAfter {
		t.Fatalf("切到 bumper 后应强制 ghost=false，实际 mode=%q ghost=%v", modeAfter, ghostAfter)
	}
	// 碰碰车模式下再请求打开幽灵车必须被拒
	h2.handleFrame(c2, []byte(`{"t":"ghost","ghost":true}`))
	rm2.mu.Lock()
	ghostFinal := rm2.ghost
	rm2.mu.Unlock()
	if ghostFinal {
		t.Fatal("碰碰车模式下幽灵车开关未拦住")
	}
}
