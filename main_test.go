package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// newTestClient 造一个只带最小字段的 Client，用于排位逻辑单测。
func newTestClient(id int, name string, points int64) *Client {
	return &Client{id: id, name: name, color: "#ffffff", points: points, cp: -1}
}

func newTestRoom(ps ...*Client) *Room {
	return &Room{id: "TEST", laps: 3, trackType: "suzuka", players: ps}
}

// ---------- 1. progressScore 单调性与档位权重 ----------

func TestProgressScoreOrdering(t *testing.T) {
	// 同一圈：Checkpoint 更靠前 -> 分数更高
	if progressScore(0, 5, 50) <= progressScore(0, 4, 10) {
		t.Fatalf("cp 更大应分数更高")
	}
	// 同一 Checkpoint：距下一个更近 -> 分数更高
	if progressScore(0, 5, 10) <= progressScore(0, 5, 90) {
		t.Fatalf("distNext 更小应分数更高")
	}
	// 圈数权重压倒一切：多一圈哪怕在起跑线也高于少一圈在终点前
	if progressScore(1, -1, 999) <= progressScore(0, maxCP-1, 0) {
		t.Fatalf("圈数必须压过 Checkpoint 进度")
	}
	// Checkpoint 档位不被 distNext 跨越：cp 差 1 的最小/最大组合
	if progressScore(0, 3, 999) >= progressScore(0, 4, 0) {
		t.Fatalf("distNext 不得跨过相邻 Checkpoint 档位")
	}
	// cp = -1（起步）应为该圈最低非负区间
	if got := progressScore(0, -1, 0); got != 0 {
		t.Fatalf("起步分数应为 0，得到 %d", got)
	}
}

func TestProgressScoreClamp(t *testing.T) {
	// distNext 必须被夹到 < scoreCpW，避免破坏单调性
	if got := progressScore(0, 2, 99999); got != int64(3*scoreCpW-(scoreCpW-1)) {
		t.Fatalf("distNext 未正确夹取: %d", got)
	}
	// 负 distNext 夹到 0
	if got := progressScore(0, 2, -50); got != int64(3*scoreCpW) {
		t.Fatalf("负 distNext 未夹到 0: %d", got)
	}
	// cp 越界夹取
	if got := progressScore(0, 999, 0); got != int64(maxCP*scoreCpW) {
		t.Fatalf("cp 越界未夹取: %d", got)
	}
}

// ---------- 2. 倒序发车 ----------

func TestAssignGridReverseOrder(t *testing.T) {
	// 积分：A 最高、B 次之、C 最低
	a := newTestClient(1, "A", 100)
	b := newTestClient(2, "B", 50)
	c := newTestClient(3, "C", 0)
	r := newTestRoom(a, b, c)
	r.assignGridLocked()

	// 积分最低者拿 P1 杆位
	if c.gridSlot != 1 {
		t.Fatalf("最低分应拿 P1，得到 slot=%d", c.gridSlot)
	}
	if b.gridSlot != 2 {
		t.Fatalf("B 应为 P2，得到 slot=%d", b.gridSlot)
	}
	if a.gridSlot != 3 {
		t.Fatalf("最高分应排末尾 P3，得到 slot=%d", a.gridSlot)
	}
	// 槽位必须无重复且覆盖 1..n
	seen := map[int]bool{}
	for _, p := range r.players {
		if p.gridSlot < 1 || p.gridSlot > maxPlayers || seen[p.gridSlot] {
			t.Fatalf("槽位非法或重复: %d", p.gridSlot)
		}
		seen[p.gridSlot] = true
	}
}

func TestAssignGridTieBreakStable(t *testing.T) {
	// 积分相同 -> 按席位号升序，保证多机一致
	a := newTestClient(1, "A", 7)
	b := newTestClient(2, "B", 7)
	r := newTestRoom(a, b)
	r.assignGridLocked()
	if a.gridSlot != 1 || b.gridSlot != 2 {
		t.Fatalf("同分应按席位号稳定排序，得到 %d/%d", a.gridSlot, b.gridSlot)
	}
}

func TestGridJSONShape(t *testing.T) {
	a := newTestClient(1, "A", 0)
	b := newTestClient(2, "B", 10)
	r := newTestRoom(a, b)
	r.assignGridLocked()
	var m map[string]int
	if err := json.Unmarshal([]byte(r.gridJSONLocked()), &m); err != nil {
		t.Fatalf("grid JSON 非法: %v", err)
	}
	if m["1"] != 1 || m["2"] != 2 {
		t.Fatalf("grid 映射错误: %v", m)
	}
}

// ---------- 3. 秒差：带符号语义（与 C++ RaceDeltaTracker 严格一致）----------
//
// 全工程只有一套符号：solveDeltaMs(a,b) > 0 表示 **a 领先 b**，< 0 表示 a 落后 b。
// 规格要求的文本格式（落后 "-X.X"、领跑 "--"）由客户端格式化层负责，
// 服务端只给带符号数值。以下用例把这条约定钉死。

func TestSolveDeltaCommonCheckpoint(t *testing.T) {
	lead := newTestClient(1, "L", 0)
	chas := newTestClient(2, "C", 0)
	lead.lap, chas.lap = 0, 0
	lead.cp, chas.cp = 5, 5
	// leader 在 t=1000 通过 CP3，chaser 在 t=1420 通过同一个 CP3
	lead.passTime[3] = 1000
	chas.passTime[3] = 1420
	r := newTestRoom(lead, chas)

	// chaser 相对 leader：落后 -> 负值
	g, ok := r.solveDeltaMs(chas, lead)
	if !ok {
		t.Fatalf("应能给出秒差")
	}
	if g != -420 {
		t.Fatalf("落后者相对领先者应为 -420ms，得到 %v", g)
	}
	// 反向：领先者相对落后者 -> 正值 +420
	gg, _ := r.solveDeltaMs(lead, chas)
	if gg != 420 {
		t.Fatalf("领先者相对落后者应为 +420ms，得到 %v", gg)
	}
	// 反对称性
	if g+gg != 0 {
		t.Fatalf("solveDeltaMs(a,b) 必须等于 -solveDeltaMs(b,a)：%v vs %v", g, gg)
	}
}

// 起步阶段没有共同通过的样条切片/Checkpoint 时，服务端必须返回不可测，
// 不能按瞬时车速外推。旧实现会在前车重刹时把秒差瞬间放大到十几秒。
func TestSolveDeltaWithoutCommonPassageIsUnavailable(t *testing.T) {
	lead := newTestClient(1, "L", 0)
	chas := newTestClient(2, "C", 0)
	lead.cp, chas.cp = -1, -1 // 谁都没过 CP -> 无公共 Checkpoint
	lead.distNext, chas.distNext = 100, 400
	lead.speedKmh, chas.speedKmh = 90, 36
	r := newTestRoom(lead, chas)

	g, ok := r.solveDeltaMs(chas, lead)
	if ok || g != 0 {
		t.Fatalf("缺少公共通过断面时必须返回不可测，得到 ok=%v g=%v", ok, g)
	}
	if gg, ok := r.solveDeltaMs(lead, chas); ok || gg != 0 {
		t.Fatalf("反向也必须是不可测，得到 ok=%v g=%v", ok, gg)
	}
}

// 规格硬约束：同一圈使用赛道样条切片的服务端通过时刻求差。
func TestSolveDeltaUsesCommonSplinePassage(t *testing.T) {
	lead := newTestClient(1, "L", 0)
	chas := newTestClient(2, "C", 0)
	lead.lap, chas.lap = 0, 0
	lead.spline, chas.spline = 0.62, 0.58
	k := passageSlice(chas.spline)
	lead.sliceTime[k] = 1000 // 领先车更早到达同一断面
	chas.sliceTime[k] = 1700 // 后车晚 700ms 到达
	r := newTestRoom(lead, chas)

	g, ok := r.solveDeltaMs(chas, lead)
	if !ok {
		t.Fatalf("有公共样条切片时应能给出秒差")
	}
	if g != -700 {
		t.Fatalf("后车相对前车应为 -700ms，得到 %v", g)
	}
	if gg, ok := r.solveDeltaMs(lead, chas); !ok || gg != 700 {
		t.Fatalf("前车相对后车应为 +700ms，得到 ok=%v g=%v", ok, gg)
	}
	// 瞬时速度不参与同一断面时间差：改速度不得改变结果。
	lead.speedKmh, chas.speedKmh = 20, 260
	if again, ok := r.solveDeltaMs(chas, lead); !ok || again != -700 {
		t.Fatalf("样条通过时间差不应受瞬时速度影响，得到 ok=%v g=%v", ok, again)
	}
}

func TestResetPassageStateClearsCurrentLapSlices(t *testing.T) {
	c := newTestClient(1, "L", 0)
	c.spline = 0.5
	c.sliceAt = 12
	c.sliceTime[12] = 12345
	c.resetPassageStateLocked()
	if c.spline != 0 || c.sliceAt != -1 || c.sliceTime[12] != 0 {
		t.Fatalf("逐圈重置未清空样条状态: spline=%v sliceAt=%d sliceTime=%v",
			c.spline, c.sliceAt, c.sliceTime[12])
	}
}

func TestSolveDeltaLapDelta(t *testing.T) {
	lead := newTestClient(1, "L", 0)
	chas := newTestClient(2, "C", 0)
	lead.lap, chas.lap = 1, 0 // chaser 落后一整圈
	r := newTestRoom(lead, chas)
	r.lapMs = 45000
	g, ok := r.solveDeltaMs(chas, lead)
	if !ok {
		t.Fatalf("应能给出量级秒差")
	}
	if g != -45000 {
		t.Fatalf("落后一整圈应为 -lapMs=-45000ms，得到 %v", g)
	}
	// 反向：领先一整圈 -> +45000
	if gg, _ := r.solveDeltaMs(lead, chas); gg != 45000 {
		t.Fatalf("领先一整圈应为 +45000ms，得到 %v", gg)
	}
}

func TestSolveDeltaUnfinishedVsFinished(t *testing.T) {
	fin := newTestClient(1, "F", 0)
	run := newTestClient(2, "R", 0)
	fin.finished, fin.total = true, 120.5
	run.finished = false
	r := newTestRoom(fin, run)
	if _, ok := r.solveDeltaMs(run, fin); ok {
		t.Fatalf("未完赛者相对完赛者不应给出确定秒差")
	}
	// 双方完赛 -> 净用时之差。净用时短者领先，故 fin2 相对 fin 为负（fin2 更慢）。
	fin2 := newTestClient(3, "F2", 0)
	fin2.finished, fin2.total = true, 121.25
	r2 := newTestRoom(fin, fin2)
	g, ok := r2.solveDeltaMs(fin2, fin)
	if !ok || g != -750 {
		t.Fatalf("更慢的完赛者相对更快者应为 -750ms，得到 %v ok=%v", g, ok)
	}
	// 反向：更快者相对更慢者 -> +750
	if gg, _ := r2.solveDeltaMs(fin, fin2); gg != 750 {
		t.Fatalf("更快者相对更慢者应为 +750ms，得到 %v", gg)
	}
}

// ---------- 4. LEADERBOARD_UPDATE 报文 ----------

func TestLeaderboardJSON(t *testing.T) {
	lead := newTestClient(1, "L", 0)
	mid := newTestClient(2, "M", 0)
	tail := newTestClient(3, "T", 0)
	lead.lap, mid.lap, tail.lap = 0, 0, 0
	lead.cp, mid.cp, tail.cp = 5, 5, 4
	lead.passTime[4], mid.passTime[4], tail.passTime[4] = 900, 1250, 1600
	r := newTestRoom(lead, mid, tail)

	raw := r.leaderboardLocked()
	if !strings.HasPrefix(string(raw), `{"t":"LEADERBOARD_UPDATE","data":[`) {
		t.Fatalf("报文前缀错误: %s", raw)
	}
	var msg struct {
		T    string `json:"t"`
		Data []struct {
			ID  int      `json:"id"`
			Pos int      `json:"pos"`
			Gap *float64 `json:"gap"`
			Int *float64 `json:"int"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatalf("LEADERBOARD 报文非法 JSON: %v\n%s", err, raw)
	}
	if msg.T != "LEADERBOARD_UPDATE" || len(msg.Data) != 3 {
		t.Fatalf("报文结构错误: %+v", msg)
	}
	// P1 必须是进度最高的 L
	if msg.Data[0].ID != 1 || msg.Data[0].Pos != 1 {
		t.Fatalf("P1 应为车手 1，得到 %+v", msg.Data[0])
	}
	// P1 自身 gap/int 为 0（客户端渲染成 LEADER）
	if msg.Data[0].Gap == nil || *msg.Data[0].Gap != 0 {
		t.Fatalf("P1 gap 应为 0，得到 %v", msg.Data[0].Gap)
	}
	// P2 相对 P1：公共 CP4 时间戳差 = 900-1250 = -350ms = -0.35s（负 = 落后）
	if msg.Data[1].Gap == nil || *msg.Data[1].Gap > -0.349 || *msg.Data[1].Gap < -0.351 {
		t.Fatalf("P2 Gap to Leader 应约 -0.35s（负=落后），得到 %v", msg.Data[1].Gap)
	}
	// P3 相对 P2 的间隔 = 1250-1600 = -350ms（P3 落后 P2）
	if msg.Data[2].Int == nil || *msg.Data[2].Int > -0.349 || *msg.Data[2].Int < -0.351 {
		t.Fatalf("P3 Interval to Ahead 应约 -0.35s（负=落后于前一名），得到 %v", msg.Data[2].Int)
	}
	// P3 相对 P1 = 900-1600 = -700ms
	if msg.Data[2].Gap == nil || *msg.Data[2].Gap > -0.699 || *msg.Data[2].Gap < -0.701 {
		t.Fatalf("P3 Gap to Leader 应约 -0.70s，得到 %v", msg.Data[2].Gap)
	}
}

// gap to behind（规格 §7.1）：P1 要能显示"领先 P2 多少"，末位没有后车。
// 新约定下 behind 是该车相对后一名的**带符号**差：正值 = 该车领先（防守秒差），
// 客户端渲染成 "▼ X.Xs"。末位无后车 -> null。
func TestLeaderboardBehindField(t *testing.T) {
	lead := newTestClient(1, "L", 0)
	mid := newTestClient(2, "M", 0)
	tail := newTestClient(3, "T", 0)
	lead.cp, mid.cp, tail.cp = 5, 5, 4
	lead.passTime[4], mid.passTime[4], tail.passTime[4] = 900, 1250, 1600
	r := newTestRoom(lead, mid, tail)

	var msg struct {
		Data []struct {
			Pos    int      `json:"pos"`
			Behind *float64 `json:"behind"`
		} `json:"data"`
	}
	if err := json.Unmarshal(r.leaderboardLocked(), &msg); err != nil {
		t.Fatalf("报文非法: %v", err)
	}
	if len(msg.Data) != 3 {
		t.Fatalf("应 3 条，得到 %d", len(msg.Data))
	}
	// P1 的 behind = solveDeltaMs(P1, P2) = P1 领先 P2 = 900-1250 = +350ms（正）
	if msg.Data[0].Behind == nil || *msg.Data[0].Behind < 0.349 || *msg.Data[0].Behind > 0.351 {
		t.Fatalf("P1 gap-to-behind 应约 +0.35s（正=领先），得到 %v", msg.Data[0].Behind)
	}
	// P2 的 behind = solveDeltaMs(P2, P3)：P2 与前一名 P1 同 CP，P3 落后 ->
	// P2 领先 P3 = 1250-1600 = +350ms
	if msg.Data[1].Behind == nil || *msg.Data[1].Behind < 0.349 || *msg.Data[1].Behind > 0.351 {
		t.Fatalf("P2 gap-to-behind 应约 +0.35s，得到 %v", msg.Data[1].Behind)
	}
	// 末位没有后车 -> null（客户端据此不渲染 ▼）
	if msg.Data[2].Behind != nil {
		t.Fatalf("末位 behind 应为 null，得到 %v", *msg.Data[2].Behind)
	}
}

// TestPointsTableMonotonic 校验名次积分表的两条不变量（规格 §二）：
//  1. 规格硬性档位 P1~P4 必须**严格递减**，且恰为 10/6/4/2；
//  2. 整表**非递增**（后面的溢出席位不得高于前面），且末位为 0。
//
// ⚠️ 旧版断言"i=2..maxPlayers 全表严格递减"。四人房规格把档位压到 10/6/4/2 后，
//
//	P5 起的溢出席位（规格未定义）统一为 0 —— 相邻两个 0 会违反"严格递减"。
//	这是一个**规格口径变更**导致的守卫调整，不是放松：规格真正在乎的 P1~P4
//	现在是显式断言的硬值（比"只要递减"更强）。
func TestPointsTableMonotonic(t *testing.T) {
	want := []int64{10, 6, 4, 2} // 规格 §二：P1 +10 / P2 +6 / P3 +4 / P4 +2
	for i, w := range want {
		rank := i + 1
		if pointTable[rank] != w {
			t.Fatalf("规格 §二名次积分不符: P%d=%d，应为 %d", rank, pointTable[rank], w)
		}
	}
	// 整表非递增 + 末位为 0
	for i := 2; i <= maxPlayers; i++ {
		if pointTable[i] > pointTable[i-1] {
			t.Fatalf("名次积分必须随名次非递增: P%d=%d P%d=%d",
				i, pointTable[i], i-1, pointTable[i-1])
		}
	}
	if pointTable[maxPlayers] != 0 {
		t.Fatalf("末位积分应为 0，得到 %d", pointTable[maxPlayers])
	}
}

// ---------- DNF 60 秒宽限倒计时（规格 §五.1）----------
// 首位车手冲线 -> Room 必须置位 dnfDeadline（约 60s 后）；
// 到点仍未冲线的座位必须被标记 retired，且结算结果里 DNF 标记出现在 client 结果中。
func TestDnfGraceCountdown(t *testing.T) {
	fin := newTestClient(1, "首位", 0)
	slow := newTestClient(2, "慢车", 0)
	slow.lap, slow.cp, slow.distNext = 0, 5, 40 // 有进度，DNF 时按进度排名
	r := newTestRoom(fin, slow)
	r.started = true
	r.startAt = time.Now().Add(-time.Second)

	// 首位冲线：应启动 60s DNF 倒计时
	fin.finished = true
	fin.locked = true
	if !r.dnfDeadline.IsZero() {
		t.Fatalf("初始 dnfDeadline 应为零值")
	}
	// 模拟 finish 分支里启动倒计时的动作
	r.dnfDeadline = time.Now().Add(dnfGraceSec * time.Second)
	r.notifyDnfLocked(dnfGraceSec)
	if r.dnfLeft != -1 {
		t.Fatalf("notifyDnfLocked 应把 dnfLeft 置 -1（待下一拍广播），得到 %d", r.dnfLeft)
	}
	// 倒计时在 55~60s 之间（容忍执行耗时）
	left := time.Until(r.dnfDeadline).Seconds()
	if left < 55 || left > 60 {
		t.Fatalf("DNF 宽限应约 60s，得到 %.2fs", left)
	}
	// 到点：未完赛者标记 retired 并结算
	r.dnfDeadline = time.Now().Add(-time.Millisecond)
	for _, p := range r.players {
		if !p.finished {
			p.retired = true
		}
	}
	if !slow.retired {
		t.Fatalf("DNF 到点后未完赛车手应被标记 retired")
	}
	res := r.resultsLocked()
	if len(res) != 2 {
		t.Fatalf("结果应有 2 条，得到 %d", len(res))
	}
	if !res[0].Finished {
		t.Fatalf("完赛者应排第一")
	}
	if res[1].DNF != true {
		t.Fatalf("未完赛者结果应带 dnf=true 标记")
	}
	if res[0].Rank != 1 || res[1].Rank != 2 {
		t.Fatalf("名次应为 1/2，得到 %d/%d", res[0].Rank, res[1].Rank)
	}
}

// DNF 位次按进度（progressScore）排名：跑得远的名次靠前。
func TestDnfRankByProgress(t *testing.T) {
	a := newTestClient(1, "近", 0)
	b := newTestClient(2, "远", 0)
	a.lap, a.cp, a.distNext = 0, 2, 100
	b.lap, b.cp, b.distNext = 0, 6, 20
	a.retired, b.retired = true, true
	r := newTestRoom(a, b)
	r.started = true
	res := r.resultsLocked()
	if res[0].ID != 2 {
		t.Fatalf("DNF 位次应按进度排：更远的 #2 应排前，得到 #%d 在前", res[0].ID)
	}
}

func TestSanitizeTrack(t *testing.T) {
	cases := map[string]string{
		"vegas": "vegas", "VEGAS": "vegas", "lasvegas": "vegas",
		"suzuka": "suzuka", "": "suzuka", "garbage": "suzuka",
	}
	for in, want := range cases {
		if got := sanitizeTrack(in); got != want {
			t.Fatalf("sanitizeTrack(%q)=%q，期望 %q", in, got, want)
		}
	}
}

func newProtocolTestClient(name string) *Client {
	return &Client{
		name: name, color: "#ffffff", send: make(chan []byte, 64), done: make(chan struct{}),
		lastSeen: time.Now(), rttMs: -1,
	}
}

func attachProtocolTestClient(t *testing.T, h *Hub, r *Room, c *Client) {
	t.Helper()
	c.hub = h
	r.mu.Lock()
	defer r.mu.Unlock()
	if !h.attachLocked(r, c) {
		t.Fatalf("attach %s failed", c.name)
	}
	select {
	case <-c.send: // discard hello
	default:
		t.Fatalf("attach %s did not emit hello", c.name)
	}
}

func roomMessageFrom(c *Client) map[string]any {
	for {
		select {
		case raw := <-c.send:
			var msg map[string]any
			if json.Unmarshal(raw, &msg) == nil && msg["t"] == "room" {
				return msg
			}
		default:
			return nil
		}
	}
}

func TestAddAIBotRosterHostAndPresence(t *testing.T) {
	h := newHub()
	r := &Room{hub: h, id: "BOTS", laps: 3, trackType: "suzuka", gameMode: "fm8", close: make(chan struct{})}
	h.rooms[r.id] = r
	human := newProtocolTestClient("Host")
	attachProtocolTestClient(t, h, r, human)
	h.clients[human] = struct{}{}

	h.handleFrame(human, []byte(`{"t":"add_ai_bot"}`))

	r.mu.Lock()
	if len(r.players) != 2 {
		r.mu.Unlock()
		t.Fatalf("add_ai_bot 应增加一个席位，得到 %d", len(r.players))
	}
	bot := r.players[1]
	if !bot.ai || !bot.ready || bot.id < 1 || bot.id > maxPlayers || bot.engine == "" {
		r.mu.Unlock()
		t.Fatalf("人机席位字段错误: %+v", bot)
	}
	if r.hostID != human.id || bot.ownerID != human.id {
		r.mu.Unlock()
		t.Fatalf("房主/人机控制权错误: host=%d owner=%d human=%d", r.hostID, bot.ownerID, human.id)
	}
	r.mu.Unlock()

	room := roomMessageFrom(human)
	if room == nil || int(room["host"].(float64)) != human.id {
		t.Fatalf("room 应返回当前房主 id: %v", room)
	}
	players, ok := room["players"].([]any)
	if !ok || len(players) != 2 {
		t.Fatalf("room roster 应包含人类和人机: %v", room["players"])
	}
	var sawAI bool
	for _, raw := range players {
		p := raw.(map[string]any)
		if p["ai"] == true {
			sawAI = true
			if p["engine"] == "" {
				t.Fatal("AI roster 缺少 engine")
			}
		}
	}
	if !sawAI {
		t.Fatal("room roster 未标记 ai=true")
	}

	var presence map[string]any
	if err := json.Unmarshal(h.presenceSnapshot(), &presence); err != nil {
		t.Fatalf("presence JSON 非法: %v", err)
	}
	if int(presence["total"].(float64)) != 1 || len(presence["players"].([]any)) != 1 {
		t.Fatalf("AI 不得计入全局在线人数: %v", presence)
	}
}

func TestHostOwnedBotStateLapFinishRejectsHumanForgery(t *testing.T) {
	h := newHub()
	r := &Room{hub: h, id: "OWNR", laps: 3, trackType: "suzuka", gameMode: "fm8", close: make(chan struct{}), started: true, startAt: time.Now().Add(-10 * time.Second)}
	h.rooms[r.id] = r
	host := newProtocolTestClient("Host")
	other := newProtocolTestClient("Other")
	attachProtocolTestClient(t, h, r, host)
	attachProtocolTestClient(t, h, r, other)
	r.mu.Lock()
	r.started = true
	bot := &Client{ai: true, id: 3, name: "AI · Test", color: "#123456", engine: "ai", ready: true, ownerID: host.id}
	bot.room = r
	r.players = append(r.players, bot)
	r.mu.Unlock()

	h.handleFrame(host, []byte(`{"t":"state","id":3,"seq":7,"d":{"x":1,"y":2,"z":3,"q":[0,0,0,1]}}`))
	r.mu.Lock()
	goodState := string(bot.state)
	r.mu.Unlock()
	if goodState == "" {
		t.Fatal("房主发送的人机 state 未写入目标人机")
	}

	h.handleFrame(other, []byte(`{"t":"state","id":3,"seq":8,"d":{"x":9,"y":9,"z":9,"q":[0,0,0,1]}}`))
	r.mu.Lock()
	if string(bot.state) != goodState {
		r.mu.Unlock()
		t.Fatal("非房主可以伪造人机 state")
	}
	r.mu.Unlock()

	h.handleFrame(host, []byte(`{"t":"lap","id":3,"n":1,"time":42.5,"dirty":true}`))
	r.mu.Lock()
	if bot.lap != 1 || bot.bestLap != 0 {
		r.mu.Unlock()
		t.Fatalf("房主发送的人机 lap 未写入: lap=%d best=%v", bot.lap, bot.bestLap)
	}
	r.mu.Unlock()
	h.handleFrame(other, []byte(`{"t":"lap","id":3,"n":2,"time":1}`))
	r.mu.Lock()
	if bot.lap != 1 {
		r.mu.Unlock()
		t.Fatal("非房主可以伪造人机 lap")
	}
	r.mu.Unlock()

	r.mu.Lock()
	r.racing = true
	bot.lap = r.laps
	r.mu.Unlock()
	h.handleFrame(host, []byte(`{"t":"fin","id":3,"net":12.5,"pen":0.25,"total":12.75}`))
	r.mu.Lock()
	if !bot.finished || !bot.locked || bot.netTime != 12.5 || bot.penalty != 0.25 || bot.total != 12.75 {
		r.mu.Unlock()
		t.Fatalf("房主发送的人机 fin 未写入: %+v", bot)
	}
	r.mu.Unlock()

	// A legacy message without id remains local to its sender.
	h.handleFrame(other, []byte(`{"t":"state","seq":1,"d":{"x":4,"q":[0,0,0,1]}}`))
	r.mu.Lock()
	if string(other.state) == "" {
		r.mu.Unlock()
		t.Fatal("无 id 的 legacy state 未写入发送者")
	}
	r.mu.Unlock()
}

func TestBotAuthorityTransfersWhenHostLeaves(t *testing.T) {
	h := newHub()
	r := &Room{hub: h, id: "MOVE", laps: 3, trackType: "suzuka", gameMode: "fm8", close: make(chan struct{})}
	h.rooms[r.id] = r
	host := newProtocolTestClient("Host")
	next := newProtocolTestClient("Next")
	attachProtocolTestClient(t, h, r, host)
	attachProtocolTestClient(t, h, r, next)
	h.handleFrame(host, []byte(`{"t":"add_ai_bot"}`))
	r.mu.Lock()
	bot := r.players[2]
	oldBotID := bot.id
	r.mu.Unlock()

	h.leave(host, "disconnect")
	r.mu.Lock()
	if r.hostID != next.id || bot.ownerID != next.id {
		r.mu.Unlock()
		t.Fatalf("房主离开后未转移人机控制权: host=%d owner=%d next=%d", r.hostID, bot.ownerID, next.id)
	}
	r.mu.Unlock()

	r.mu.Lock()
	r.started = true
	r.mu.Unlock()
	h.handleFrame(next, []byte(`{"t":"state","id":3,"seq":1,"d":{"x":8,"q":[0,0,0,1]}}`))
	r.mu.Lock()
	if bot.id != oldBotID || string(bot.state) == "" {
		r.mu.Unlock()
		t.Fatal("新房主不能继续驱动原人机")
	}
	r.mu.Unlock()
}

func TestAllReadyUsesHumansWhileBotsAreAutoready(t *testing.T) {
	human := newTestClient(1, "Human", 0)
	bot := newTestClient(2, "AI", 0)
	bot.ai, bot.ready = true, true
	r := newTestRoom(human, bot)
	if r.allReadyLocked() {
		t.Fatal("人类未准备时，自动准备的人机不应触发开赛")
	}
	human.ready = true
	if !r.allReadyLocked() {
		t.Fatal("唯一人类准备后，人机应参与单人练习开赛")
	}
}
