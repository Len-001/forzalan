package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

/*
 * 用户报障回归："局内左上角的名次有时会错乱"。
 *
 * 三个独立根因，各配一条**反例**测试（修复前必须报红）：
 *   ① 起步瞬间所有车进度积分同分，旧实现按席位号 id 决胜 —— 而席位号与倒序发车格
 *      并不一致，于是"排最后的车"被排到第 1 名。
 *   ② 跨圈瞬间：advanceLapLocked 刚把 cp 重置为 -1，同一份状态包却还带着上一圈末尾的
 *      C（如 23）；旧实现无条件 `pj.C > target.cp` ⇒ 新圈 cp 直接跳到 23 ⇒
 *      progressScore 瞬间多出 24×1000 分，名次跳到第 1。
 *   ③ 发车格在起终点线**之前**：未起步时归一化样条 p ≈ 0.98~0.99，旧实现原样采信并
 *      记入"样条通过时刻表"，秒差列按一个不存在的 0.99 截面解算。
 */

// ① 起步同分：必须按**发车格**决胜，而不是席位号。
//
//	构造刻意冲突的样本：席位号小的车反而在更后面的发车格。
func TestLeaderboardStartTieBreaksByGridSlot(t *testing.T) {
	// 两台车都还没过起跑线：lap=0, cp=-1, distNext 相同 ⇒ progressScore 完全相同
	front := newTestClient(2, "P1", 0) // 席位 2，但拿杆位（gridSlot 1）
	back := newTestClient(1, "P2", 0)  // 席位 1，却在后方发车（gridSlot 2）
	front.gridSlot, back.gridSlot = 1, 2
	r := newTestRoom(front, back)

	if progressScore(front.lap, front.cp, front.distNext) != progressScore(back.lap, back.cp, back.distNext) {
		t.Fatal("前提不成立：两台起步车应同分")
	}

	raw := r.leaderboardLocked()
	var msg struct {
		Data []struct {
			ID  int `json:"id"`
			Pos int `json:"pos"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatalf("LEADERBOARD 报文非法: %v", err)
	}
	if len(msg.Data) != 2 {
		t.Fatalf("应有 2 行，得到 %d", len(msg.Data))
	}
	if msg.Data[0].ID != front.id || msg.Data[1].ID != back.id {
		t.Fatalf("起步同分时应按发车格排序（杆位在前），得到 %+v", msg.Data)
	}
	if msg.Data[0].Pos != 1 || msg.Data[1].Pos != 2 {
		t.Fatalf("pos 字段必须与排序一致: %+v", msg.Data)
	}
}

// ①b 没有发车格信息时（大厅/观战座位）退回席位号，保证排序仍然是全序。
func TestLeaderboardStartTieFallsBackToSeatWithoutGrid(t *testing.T) {
	a := newTestClient(1, "A", 0)
	b := newTestClient(2, "B", 0)
	r := newTestRoom(a, b)
	raw := r.leaderboardLocked()
	// 只需保证不 panic、且顺序与席位号一致（gridSlot 均为 0）
	if !strings.Contains(string(raw), `"pos":1`) {
		t.Fatalf("报文异常: %s", raw)
	}
	if !strings.HasPrefix(string(raw), `{"t":"LEADERBOARD_UPDATE","data":[{"id":1,`) {
		t.Fatalf("无发车格时应按席位号决胜: %s", raw)
	}
}

// statePacket 构造一份最小合法 state 报文（`d` 内部字段与客户端一致）。
func statePacket(lap, cp int, p *float64, seq uint32) []byte {
	d := map[string]any{"x": 0, "y": 0, "z": 0, "q": [4]float64{0, 0, 0, 1}, "l": lap, "c": cp, "n": 0.0, "s": 120.0}
	if p != nil {
		d["p"] = *p
	}
	raw, _ := json.Marshal(map[string]any{"t": "state", "seq": seq, "d": d})
	return raw
}

func startedRoomWithClient(t *testing.T) (*Hub, *Room, *Client) {
	t.Helper()
	h := newHub()
	r := &Room{hub: h, id: "PROG", laps: 3, trackType: "suzuka", gameMode: "fm8",
		close: make(chan struct{}), started: true, racing: true, startAt: time.Now().Add(-5 * time.Second)}
	h.rooms[r.id] = r
	c := newProtocolTestClient("Racer")
	attachProtocolTestClient(t, h, r, c)
	r.mu.Lock()
	r.started = true
	r.racing = true
	r.mu.Unlock()
	return h, r, c
}

// ② 跨圈瞬间的旧 Checkpoint 索引不得污染新圈进度。
func TestStateStaleRolloverCPDoesNotJumpProgress(t *testing.T) {
	h, r, c := startedRoomWithClient(t)

	// 第 0 圈末尾：已通过 CP23，样条接近 1.0
	almostOne := 0.995
	h.handleFrame(c, statePacket(0, 23, &almostOne, 1))
	r.mu.Lock()
	scoreBefore := c.score
	r.mu.Unlock()
	if scoreBefore < int64(24*scoreCpW) {
		t.Fatalf("前提不成立：CP23 的 score 应已很高，得到 %d", scoreBefore)
	}

	// 跨圈：lap 变 1（advanceLapLocked 会把 cp 重置为 -1），但同一包仍带着上一圈的 C=23
	justStarted := 0.02
	h.handleFrame(c, statePacket(1, 23, &justStarted, 2))
	r.mu.Lock()
	lap, cp, spline, score := c.lap, c.cp, c.spline, c.score
	r.mu.Unlock()

	if lap != 1 {
		t.Fatalf("圈数应已推进到 1，得到 %d", lap)
	}
	if cp != -1 {
		t.Fatalf("★跨圈时旧 Checkpoint 索引污染了新圈：cp=%d（应保持 -1）", cp)
	}
	// 新圈起点分数必须接近单圈基数（1*100000），而不是 1*100000 + 24*1000
	if score >= int64(scoreLapW)+int64(12*scoreCpW) {
		t.Fatalf("★跨圈后进度积分暴涨（名次会瞬间跳到第 1）：score=%d", score)
	}
	if score <= scoreBefore {
		t.Fatalf("跨圈后进度必须仍然前进：%d -> %d", scoreBefore, score)
	}
	if spline != justStarted {
		t.Fatalf("新圈圈首的样条应原样采信，得到 %.4f", spline)
	}
}

// ②b 正常同圈推进必须照旧生效（防"为了修 bug 把功能关掉"）。
func TestStateNormalCheckpointAdvanceStillWorks(t *testing.T) {
	h, r, c := startedRoomWithClient(t)
	mid := 0.45
	h.handleFrame(c, statePacket(0, 7, &mid, 1))
	r.mu.Lock()
	if c.cp != 7 {
		r.mu.Unlock()
		t.Fatalf("同圈内 CP 前进未被记录: cp=%d", c.cp)
	}
	if c.passTime[7] <= 0 {
		r.mu.Unlock()
		t.Fatal("通过时刻未记录")
	}
	r.mu.Unlock()
}

// ③ 发车格在起终点线之前：未起步的 0.98~0.99 样条必须钳为 0 且不写入通过时刻表。
func TestStatePreStartSplineIsClampedToZero(t *testing.T) {
	h, r, c := startedRoomWithClient(t)
	gridSpline := 0.987 // 发车格在圈尾 ⇒ 归一化样条接近 1
	h.handleFrame(c, statePacket(0, -1, &gridSpline, 1))
	r.mu.Lock()
	spline, score, sliceAt := c.spline, c.score, c.sliceAt
	r.mu.Unlock()
	if spline != 0 {
		t.Fatalf("★未起步的 0.98+ 样条必须钳为 0（否则秒差按不存在的 99%% 截面解算），得到 %.4f", spline)
	}
	if sliceAt >= 0 {
		t.Fatalf("钳位期间不得写入样条通过时刻表，sliceAt=%d", sliceAt)
	}
	if score != 0 {
		t.Fatalf("起步分数应为 0，得到 %d", score)
	}

	// 一旦真的压过起终点线（C>=0 且样条回到圈首），必须恢复正常采信
	afterLine := 0.004
	h.handleFrame(c, statePacket(0, 0, &afterLine, 2))
	r.mu.Lock()
	spline2, sliceAt2 := c.spline, c.sliceAt
	r.mu.Unlock()
	if spline2 != afterLine || sliceAt2 < 0 {
		t.Fatalf("压线后应恢复样条采信: spline=%.4f sliceAt=%d", spline2, sliceAt2)
	}
}

// ④ 新赛道 oval 必须进服务端白名单，且显示名与客户端下拉一致。
func TestSanitizeTrackAcceptsOval(t *testing.T) {
	for _, alias := range []string{"oval", "OVAL", " oval ", "simple", "ring", "rookie"} {
		if got := sanitizeTrack(alias); got != "oval" {
			t.Fatalf("sanitizeTrack(%q) = %q，应为 oval", alias, got)
		}
	}
	if got := trackDisplayName("oval"); got != "新手 · 极简高速环道" {
		t.Fatalf("trackDisplayName(oval) = %q", got)
	}
	// 未知值仍必须回落铃鹿（白名单不可被绕过）
	if sanitizeTrack("nurburgring") != "suzuka" {
		t.Fatal("未知赛道必须回落铃鹿")
	}
}
