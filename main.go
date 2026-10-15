// 极限竞速 · LAN —— 单文件可执行的多人在线 3D 网页赛车服务端
//
// 设计要点
//  1. 全部前端静态资源（HTML / CSS / three.min.js / cannon-es.js / 游戏脚本）通过 embed.FS
//     打进同一个可执行文件，运行期零文件依赖、零外部网络请求 —— 断网路由器下开箱即用。
//  2. WebSocket 服务端为**手写实现**（RFC6455 握手 + 帧编解码），因此本模块
//     不引入任何第三方依赖，离线机器上 `go build` 也无需联网拉取 module。
//  3. 权威划分：
//     服务端权威 —— 房间/席位/准备态/倒计时/发车时刻(统一时钟基准)/罚时累计/名次与成绩。
//     客户端权威 —— 车辆物理与 Checkpoint 判定。局域网 RTT 极低，锁步回滚反而破坏手感，
//     因此采用"服务端定规则与计时、客户端跑物理"的混合模型。
//
// 协议（全部为紧凑 JSON，热路径为手写拼接以避免反射开销）
//
//	客户端 -> 服务端:
//	  {"t":"create","name":..,"color":..,"laps":..}   建房
//	  {"t":"join","room":"ABCD","name":..,"color":..} 加入
//	  {"t":"ready","v":true}                          准备/取消准备
//	  {"t":"state","d":{...}}                         位姿上报（30Hz，服务端原样中继）
//	  {"t":"pen","sec":0.5,"reason":"offtrack"}       罚时事件上报
//	  {"t":"lap","n":2,"time":43.91}                  单圈完成（用于大厅最速圈）
//	  {"t":"finish"}                                  冲线（成绩由服务端时钟计算）
//	  {"t":"ping","c":<ms>}                           时钟同步
//	  {"t":"restart"}                                 回到大厅，开下一场
//	  {"t":"leave"}                                   离房
//	服务端 -> 客户端:
//	  {"t":"hello","id":..,"s":<ms>}
//	  {"t":"room","room":..,"laps":..,"you":..,"players":[...],"seed":..}
//	  {"t":"count","n":3} / {"t":"start","at":<ms>,"seed":..,"laps":..}
//	  ⚠️ "at"（发车时刻）与 "ts"（快照时间戳）走 **UnixMilli 墙钟**，客户端用
//	     `Date.now() + NTP offset` 换算；而 "mts"（单调时钟）走 **服务端进程启动起的
//	     毫秒数**，客户端用 `this.monoOffset`（同样源自 hello 的 m 字段）换算。
//	     两条轴各自闭合，**不可互相代入**：mts 是进程相对量，直接当 UnixMilli 用
//	     会得到一个 1970 年附近的数，所有跨轴比较立刻失真。
//	  {"t":"snap","ts":<ms>,"p":[{"id":1,"f":0,"d":{...}}]}    30Hz 位姿中继
//	  {"t":"pen","id":..,"sec":..,"delta":..,"reason":..}
//	  {"t":"fin","id":..,"net":..,"pen":..,"total":..,"rank":..}
//	  {"t":"end","results":[...],"best":..}
//	  {"t":"lobby"} / {"t":"err","msg":..} / {"t":"pong","c":..,"s":..}
package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"math/rand"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

//go:embed all:public
var embedded embed.FS

const (
	maxPlayers = 12 // 房间席位上限（规格 §八：由 4 扩展到 12，为大厅多人对战预留）
	// 每条出站队列容量：快照可丢，控制队列溢出则断开慢连接。
	sendBufSize = 64
	// 赛道 Checkpoint 数量（与 track.js 的 TRACK_CFG.CHECKPOINTS 保持一致）
	maxCP = 24
	// 位姿中继频率：规格要求 60Hz（极限竞速同款）——ticker 步长 16666µs。
	// 注意这实际是 59.99Hz（16666µs 略大于 16666.67µs），累计漂移 0.002%，可忽略。
	tickHz      = 60 // 位姿中继频率（规格：60 Tick）
	wsMagic     = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	maxPayload  = 1 << 18 // 单帧上限 256KB
	readTimeout = 120 * time.Second
	raceHardCap = 20 * time.Minute
	// 延迟探测间隔（"房间内显示每个玩家延迟"）。2s 足够快、又不至于刷屏；
	// 与 60Hz 主循环共用 ticker，无额外 goroutine。
	pingInterval = 2 * time.Second
	// 延迟变化上报阈值（毫秒）：两次测得值之差小于它就不重发 room/presence 报文，
	// 避免"每 2 秒对全房间 + 全大厅无差别全量重发 JSON"。
	pingReportDeltaMs = 2
	// DNF 宽限倒计时（规格 §五.1）：首位车手冲线后，为赛道上尚未完赛的车手
	// 启动 60 秒倒计时；到点仍未冲线者按当前进度判 DNF（未完赛）强制结算。
	// 这样既保证"早完赛的玩家能通过观战看完整场比赛"，又不会因个别掉线/挂机
	// 让整场无限期挂着（20 分钟的 raceHardCap 只是极端兜底）。
	dnfGraceSec = 60
	defaultLaps = 3
	// 默认监听端口。刻意避开 8080 —— 见 main() 里的说明（Steam CEF 调试端口冲突）。
	defaultPort = 8099
	// 权威排位解算频率（规格 20Hz）：60Hz 主 ticker 每 3 拍解算并广播一次。
	leaderboardDiv = tickHz / 20

	// 秒差按赛道样条切片记录"通过时刻"，每圈 1024 片。分辨率约 6.6m，
	// 足以支撑 0.1s 级 HUD 显示，同时严格避免用瞬时速度反推秒差。
	passageSlices = 1024
)

// 名次积分表（规格 §二：P1 +10 / P2 +6 / P3 +4 / P4 +2）。
//
// 跨场次累加进历史总积分，用于**赛季积分排行榜**与下一场的倒序发车排位
// （积分最低者拿 P1 杆位，最高者排末尾）。索引 = 名次（索引 0 不用）。
//
// ⚠️ 本轮规格把积分制从 F1 25-18-15-12 改为 10-6-4-2（四人房间量级标定）。
//
//	P1~P4 为规格硬性值；本房型最多 4 席，实际只会用到这四档。
//	P5 起是超出四人房型的溢出席位（maxPlayers=12 为开发者预留），规格未定义，
//	统一给 0（非前列不给分）。整表**非递增**且末位为 0 —— 见 TestPointsTableMonotonic。
var pointTable = [maxPlayers + 1]int64{0, 10, 6, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0}

// scoresFile 是历史总积分的持久化文件（JSON: {"玩家名": 积分}）。
// 旧版本使用 points.json；启动时若 scores.json 尚不存在，会一次性迁移旧文件，
// 之后所有写入都以规格要求的 scores.json 为唯一数据源。
const (
	scoresFile       = "scores.json"
	legacyPointsFile = "points.json"
)

// 赛季排行榜对外只展示前 N 名（规格 §一.1：前 10 名）。
const seasonBoardSize = 10

// 默认随机名过滤器：客户端在玩家没填昵称时会生成 "Guest_1234" / "Player_5678" 这类
// 占位名，或回落到 "车手" / "默认玩家"。这些名字没有身份意义，混进赛季榜会刷屏，
// 因此上榜与积分累加时统一过滤（大小写不敏感的前缀匹配）。
func isDefaultName(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	if n == "" {
		return true
	}
	// ★ 人机名（"AI · 银箭" 等）必须一并过滤：它们不是在线玩家，更不该进赛季积分榜
	//   与 scores.json（用户报障"人机不要记为在线玩家"；旧文件里确实混进了 6 条）。
	if isBotName(n) {
		return true
	}
	for _, pfx := range []string{"guest_", "player_", "guest", "player", "默认玩家", "车手", "游客"} {
		if strings.HasPrefix(n, pfx) {
			return true
		}
	}
	return false
}

// isBotName 只认**机器生成**的人机名，前缀精确到实际生成格式
// （`AI · 银箭`：服务器 aiProfiles 与前端 `'AI · ' + botNames[i]` 都是这个形态）。
//
// ⚠️ 必须与 isDefaultName 分开：isDefaultName 里的 "车手"/"游客" 等是**宽前缀**，
// 用来决定"能不能上榜"；而**删除磁盘数据**只能依据这个窄谓词 —— 否则把
// "车手B"（可能是真玩家长年用默认名）的历史积分一并抹掉，是不可逆的误删。
// 宽松写成 "ai " 也不行：会把真名 "AI 爱好者" 一起误杀。
func isBotName(lower string) bool {
	for _, pfx := range []string{"ai ·", "ai·", "ai_", "bot_"} {
		if strings.HasPrefix(lower, pfx) {
			return true
		}
	}
	return false
}

// serviceStart 是服务端启动时刻。所有快照都附加**单调时钟**戳 monoMs：
// time.Since 基于单调时钟，不受 NTP 校时/系统改时间影响，是插值时间轴的正确基准。
var serviceStart = time.Now()

func monoMs() int64 { return time.Since(serviceStart).Milliseconds() }

var (
	listenAddr = flag.String("addr", "", "监听地址，默认 :8099（也可用环境变量 PORT）")
	lapsFlag   = flag.Int("laps", defaultLaps, "默认圈数")
	quiet      = flag.Bool("quiet", false, "关闭逐帧日志")
)

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 0.999999 {
		return 0.999999
	}
	return v
}

func passageSlice(p float64) int {
	i := int(clamp01(p) * passageSlices)
	if i < 0 {
		return 0
	}
	if i >= passageSlices {
		return passageSlices - 1
	}
	return i
}

// sanitizeName 限制昵称长度并剔除控制字符，避免污染 HUD 与 JSON。
// isFRRRuling 判断一条罚时原因是否属于"赛事裁决"（FRR）而非碰撞安全提示。
// 只有裁决类才计入违规次数：离开赛道获利 / 抄近道 / 未集齐检查点冲线 / 脱困复位 / 切弯。
// ram（恶意撞击）是被撞一方的安全提示，不记违规。
func isFRRRuling(reason string) bool {
	switch reason {
	case "frr_gain", "shortcut", "rescue", "cut":
		return true
	default:
		return false
	}
}

// sanitizeTrack 白名单化赛道类型，未知值一律回落到铃鹿。
// ⚠️ 必须与客户端 track.js 的 TRACK_TYPES 逐项一致（selftest / track-verify 守着）。
func sanitizeTrack(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "vegas", "lasvegas", "las-vegas":
		return "vegas"
	case "spa", "spa-francorchamps", "francorchamps", "spafrancorchamps":
		return "spa"
	case "oval", "simple", "ring", "rookie":
		return "oval"
	default:
		return "suzuka"
	}
}

// sanitizeGameMode 白名单化驾驶规则。与客户端 main.js 的模式归一化必须一致：
//
//	fm8    —— 拟真规则（默认）
//	horizon—— 轻松驾驶（免罚时、幽灵化静默）
//	bumper —— 碰碰车模式（全程实体、关闭碰撞罚时、车车高弹性）
func sanitizeGameMode(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "horizon", "horizon-mode", "horizon模式":
		return "horizon"
	case "bumper", "bumper-car", "bumper_mode", "碰碰车", "碰碰车模式":
		return "bumper"
	default:
		return "fm8"
	}
}

func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
		if b.Len() >= 36 { // 约 12 个汉字
			break
		}
	}
	out := b.String()
	if out == "" {
		out = "车手"
	}
	return out
}

// sanitizeColor 只接受 #rgb / #rrggbb 形式，其余一律回落为 Forza 红。
func sanitizeColor(s string) string {
	s = strings.TrimSpace(s)
	if len(s) == 7 && s[0] == '#' {
		ok := true
		for i := 1; i < 7; i++ {
			c := s[i]
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				ok = false
				break
			}
		}
		if ok {
			return strings.ToLower(s)
		}
	}
	return "#e10600"
}

// sanitizeEngine 只接受前端支持的四种音效档，避免把任意字符串写入房间名册。
func sanitizeEngine(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "i6gt", "v8", "v12", "fe":
		return strings.ToLower(strings.TrimSpace(s))
	default:
		return "i6gt"
	}
}

// ---------------------------------------------------------------------------

// lanIPv4 遍历所有已启用的物理/虚拟网卡，挑出可被同网段玩家直连的 IPv4 地址。
// 过滤规则：跳过回环、跳过 link-local(169.254/16)、跳过未启用接口。
func lanIPv4() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() {
				continue
			}
			out = append(out, ip.String())
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// WebSocket（RFC6455）极简服务端
// ---------------------------------------------------------------------------

type wsConn struct {
	conn net.Conn
	br   *bufio.Reader
	wmu  sync.Mutex
}

// upgrade 完成 HTTP -> WebSocket 握手（101 Switching Protocols）。
func upgrade(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		return nil, errors.New("非 websocket 升级请求")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errors.New("缺少 Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("当前 ResponseWriter 不支持 Hijack")
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	// 强制关闭 Nagle 算法：否则操作系统会把多个小包攒起来合并发送，
	// 表现为"网络包成簇到达 -> 停顿一下再瞬移向前"。60Hz 位姿广播必须即刻推送。
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetKeepAlive(true)
		_ = tc.SetKeepAlivePeriod(30 * time.Second)
	}
	h := sha1.Sum([]byte(key + wsMagic))
	accept := base64.StdEncoding.EncodeToString(h[:])
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := brw.WriteString(resp); err != nil {
		conn.Close()
		return nil, err
	}
	if err := brw.Flush(); err != nil {
		conn.Close()
		return nil, err
	}
	return &wsConn{conn: conn, br: brw.Reader}, nil
}

// readFrame 读取单个 WebSocket 帧（处理掩码与 126/127 扩展长度）。
func (c *wsConn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	_ = c.conn.SetReadDeadline(time.Now().Add(readTimeout))
	var head [2]byte
	if _, err = io.ReadFull(c.br, head[:]); err != nil {
		return
	}
	fin = head[0]&0x80 != 0
	opcode = head[0] & 0x0f
	masked := head[1]&0x80 != 0
	length := int64(head[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	if length < 0 || length > maxPayload {
		err = errors.New("帧长度超限")
		return
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if length > 0 {
		if _, err = io.ReadFull(c.br, payload); err != nil {
			return
		}
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i&3]
		}
	}
	return
}

// writeFrame 写出一个帧（服务端 -> 客户端不使用掩码）。
func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	var head [10]byte
	head[0] = 0x80 | opcode
	n := len(payload)
	hn := 2
	switch {
	case n < 126:
		head[1] = byte(n)
	case n <= 0xffff:
		head[1] = 126
		head[2] = byte(n >> 8)
		head[3] = byte(n)
		hn = 4
	default:
		head[1] = 127
		u := uint64(n)
		head[2] = byte(u >> 56)
		head[3] = byte(u >> 48)
		head[4] = byte(u >> 40)
		head[5] = byte(u >> 32)
		head[6] = byte(u >> 24)
		head[7] = byte(u >> 16)
		head[8] = byte(u >> 8)
		head[9] = byte(u)
		hn = 10
	}
	if _, err := c.conn.Write(head[:hn]); err != nil {
		return err
	}
	if n > 0 {
		if _, err := c.conn.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// readMessage 组装完整消息（支持分片，并内部消化 ping/pong/close 控制帧）。
func (c *wsConn) readMessage() (opcode byte, data []byte, err error) {
	var acc []byte
	var msgOp byte
	started := false
	for {
		fin, op, payload, e := c.readFrame()
		if e != nil {
			return 0, nil, e
		}
		switch op {
		case 0x0: // continuation
			if !started {
				return 0, nil, errors.New("非法的 continuation 帧")
			}
			acc = append(acc, payload...)
		case 0x1, 0x2: // text / binary
			msgOp = op
			started = true
			acc = append(acc, payload...)
		case 0x8: // close
			_ = c.writeFrame(0x8, payload)
			return 0, nil, io.EOF
		case 0x9: // ping -> pong
			_ = c.writeFrame(0xa, payload)
			continue
		case 0xa: // pong
			continue
		default:
			return 0, nil, errors.New("不支持的操作码")
		}
		if len(acc) > maxPayload {
			return 0, nil, errors.New("消息过大")
		}
		if fin && started {
			return msgOp, acc, nil
		}
	}
}

// ---------------------------------------------------------------------------
// 客户端连接
// ---------------------------------------------------------------------------

// Client 的字段划分（重要，避免竞态）：
//
//	· 房间内的对局相关字段（name/color/ready/lap/penalty/state...）一律只在持有 room.mu 时读写。
//	· 出站通道 send/snaps/done/closed 由 c.mu 保护。
type Client struct {
	ws   *wsConn
	hub  *Hub
	room *Room

	mu     sync.Mutex
	send   chan []byte // 控制帧出站队列（发车/灯序/结算/房间管理等，**不可丢**）
	snaps  chan []byte // 高频流帧出站队列（位姿/排位/在线状态，满则丢新帧）
	done   chan struct{}
	closed bool

	// --- 以下字段受 room.mu 保护 ---
	id         int
	name       string
	color      string
	ai         bool   // 虚拟车手：没有 WebSocket、不会进入 Hub.clients
	engine     string // 客户端用于选择 AI 驱动器的稳定标识
	ownerID    int    // 当前房主控制该人机的席位号
	ready      bool
	finished   bool
	retired    bool
	locked     bool // 已冲线，成绩已记
	lap        int
	laps       int
	bestLap    float64
	penalty    float64
	violations int // FRR 裁决违规次数（计时塔"处罚"列显示为 "罚时 次数"）
	offTime    float64
	netTime    float64
	total      float64
	rank       int
	state      json.RawMessage
	stateAt    int64 // 服务端收到此位姿的单调时刻；广播不能刷新旧位姿的年龄。
	lastSeen   time.Time
	lastPen    time.Time
	lastSeq    uint32

	// ---- 赛道进度（服务端权威排位用；受 room.mu 保护）----
	cp        int                    // 上一个通过的 Checkpoint 索引（未通过任何 Checkpoint 时为 -1）
	distNext  float64                // 到下一个 Checkpoint 的欧氏距离
	speedKmh  float64                // 上报车速（用于秒差估算）
	score     int64                  // 进度积分
	passTime  [maxCP]float64         // 本圈各 Checkpoint 的**服务端**通过时刻（ms）
	spline    float64                // 当前圈归一化样条进度 [0,1)
	sliceAt   int                    // 最近记录的样条切片（-1 表示本圈尚无记录）
	sliceTime [passageSlices]float64 // 每片首次通过的服务端单调时刻（ms）
	gridSlot  int                    // 倒序发车分配的槽位 1..maxPlayers
	points    int64                  // 历史总积分（加入房间时从 Hub 快照，结算后回写）

	// ---- 延迟测量（供房间内**与大厅**显示每个玩家的毫秒数）----
	// 由服务端主动探测：每 2s 发一次 {"t":"sping","c":<nonce>}，客户端回
	// {"t":"spong","c":<同一 nonce>}，服务端用"发出→收回"的墙钟差算 RTT。
	// RTT 完全由服务端计算 ⇒ 玩家无法伪造/美化自己的延迟。
	//
	// ★ 这五个字段由 **pingMu** 独占保护，与 room.mu 无关 —— 因为未进房间的
	// 大厅玩家也要被测延迟（用户报障：首页大厅面板里所有人都显示"—"）。
	// Hub 锁不等待房间锁；房间锁可嵌套 Hub/ping 锁。
	pingMu    sync.Mutex
	pingSent  time.Time // 最近一次 sping 的发出时刻（零值 = 当前无在途探测）
	pingNonce int64     // 最近一次 sping 的 nonce，回包必须一致才计入
	rttMs     int       // 平滑后的延迟（毫秒），-1 = 尚未测得
	pingLoss  int       // 连续未回包次数（诊断用）
	nextPing  time.Time // 下一次该发探测的时刻
}

// droppableFrame 标记允许在慢客户端积压时丢弃的帧类型。
// 只有"下一拍必然重发"的高频快照流可丢：60Hz 位姿快照、20Hz 权威排位、
// 在线状态（全量快照语义，重发即覆盖）。控制帧（start/lights/RACE_START/
// fin/end/RACE_RESULTS/room/chat…）丢了客户端没有任何补发机制，必须入队。
func droppableFrame(b []byte) bool {
	return bytes.HasPrefix(b, []byte(`{"t":"snap",`)) ||
		bytes.HasPrefix(b, []byte(`{"t":"LEADERBOARD_UPDATE"`)) ||
		bytes.HasPrefix(b, []byte(`{"t":"presence"`))
}

func (c *Client) enqueue(b []byte) {
	if c.ai {
		return
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	if droppableFrame(b) {
		select {
		case c.snaps <- b:
		default: // 慢客户端：高频帧直接丢新帧 —— 16ms 后的下一拍自带新数据
		}
		c.mu.Unlock()
		return
	}
	// 控制队列溢出必须断开，不能留下缺失发车/结算事件的会话。
	select {
	case c.send <- b:
		c.mu.Unlock()
	default:
		c.mu.Unlock()
		c.close()
	}
}

func (c *Client) close() {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		if c.done != nil {
			close(c.done)
		}
		if c.ws != nil {
			_ = c.ws.conn.Close()
		}
	}
	c.mu.Unlock()
}

// idleFor 返回距离上次收到任何消息的时长（lastSeen 统一由 c.mu 保护）。
func (c *Client) idleFor() time.Duration {
	if c.ai {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Since(c.lastSeen)
}

// resetPassageStateLocked 清零本圈样条通过时间表（调用方持 room.mu）。
func (c *Client) resetPassageStateLocked() {
	c.spline = 0
	c.sliceAt = -1
	for i := range c.sliceTime {
		c.sliceTime[i] = 0
	}
}

func (c *Client) advanceLapLocked(lap, limit int) {
	if lap <= c.lap || lap > limit {
		return
	}
	c.lap = lap
	c.cp = -1
	c.passTime = [maxCP]float64{}
	c.resetPassageStateLocked()
}

// recordPassageLocked 把客户端进度换算成样条切片。若一帧跨过多片，则把
// 中间切片统一记为服务端当前时刻；时间戳只前进，不倒带，避免网络乱序让
// 秒差突然跳成负数或几千秒。
func (c *Client) recordPassageLocked(nowMs float64) {
	idx := passageSlice(c.spline)
	if c.sliceAt < 0 {
		c.sliceTime[idx] = nowMs
		c.sliceAt = idx
		return
	}
	if idx == c.sliceAt {
		if c.sliceTime[idx] <= 0 {
			c.sliceTime[idx] = nowMs
		}
		return
	}
	if idx > c.sliceAt {
		for k := c.sliceAt + 1; k <= idx; k++ {
			c.sliceTime[k] = nowMs
		}
		c.sliceAt = idx
		return
	}
	if c.sliceTime[idx] <= 0 {
		c.sliceTime[idx] = nowMs
	}
}

// writePump 独占地向 socket 写数据，并周期发送 ping 保活。
// 控制帧队列（c.send）优先于高频流队列（c.snaps）：先非阻塞尝试控制帧，
// 避免被持续到达的 60Hz 位姿帧饿死；两条队列都空时才阻塞等待。
func (c *Client) writePump() {
	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()
	for {
		select {
		case msg := <-c.send:
			if err := c.ws.writeFrame(0x1, msg); err != nil {
				c.close()
				return
			}
			continue
		case <-c.done:
			return
		default:
		}
		select {
		case msg := <-c.send:
			if err := c.ws.writeFrame(0x1, msg); err != nil {
				c.close()
				return
			}
		case msg := <-c.snaps:
			if err := c.ws.writeFrame(0x1, msg); err != nil {
				c.close()
				return
			}
		case <-tick.C:
			if err := c.ws.writeFrame(0x9, nil); err != nil {
				c.close()
				return
			}
		case <-c.done:
			return
		}
	}
}

// ---------------------------------------------------------------------------
// 房间与大厅
// ---------------------------------------------------------------------------

type Result struct {
	ID       int     `json:"id"`
	Name     string  `json:"name"`
	Color    string  `json:"color"`
	Net      float64 `json:"net"`
	Pen      float64 `json:"pen"`
	Total    float64 `json:"total"`
	Lap      int     `json:"lap"`
	BestLap  float64 `json:"best"`
	Finished bool    `json:"fin"`
	DNF      bool    `json:"dnf"` // 60s 宽限倒计时到点仍未冲线（未完赛，成绩按进度排名）
	Rank     int     `json:"rank"`
}

type Room struct {
	mu        sync.Mutex
	hub       *Hub
	id        string
	laps      int
	trackType string // 赛道类型：suzuka / vegas
	gameMode  string // 驾驶规则：horizon / fm8
	ghost     bool   // 全员幽灵车模式：车与车不做刚体碰撞（可在大厅切换）
	players   []*Client
	hostID    int // 当前仍在线的人类房主席位；人机永远不成为房主
	started   bool
	racing    bool // startAt 已到达
	counting  bool
	// readyCountdown 是"全员准备后聊天框整备倒计时"的剩余秒数（0 = 没在跑）。
	// 专门用来做**幂等**：倒计时进行中若再来一次 ready 事件（有人反复点准备/
	// 取消），beginCountdownLocked 看到它 >0 就直接返回，不会叠加第二条协程
	// （否则两条协程各自走完 5 秒 + 灯序，会下发两遍 START / 两遍灯序）。
	readyCountdown int
	// countdownGeneration invalidates a sleeping countdown when the room returns
	// to the lobby or starts a replacement countdown.
	countdownGeneration uint64
	finished            bool // 结算已广播
	startAt             time.Time
	// dnfDeadline 是"首位冲线后 60 秒"的 DNF 强制结算时刻（零值表示未启动）。
	// 一旦首位车手冲线即置位；到点仍未冲线的座位按进度判 DNF 并强制结算。
	dnfDeadline time.Time
	dnfLeft     int // 上次广播的剩余秒数（仅在变化时重发，省带宽；-1 = 尚未广播过）
	trackSeed   int64
	bestLap     float64
	lbTick      int     // 20Hz 权威排位解算的节拍计数器
	lapMs       float64 // 当前最佳单圈（ms），多圈落后时的秒差估算基准
	close       chan struct{}
	closeOnce   sync.Once
	// draining 表示房间已空、正在被回收（leave 的删除流程进行中）。
	// 置位后 attachLocked 一律拒绝新成员 —— 否则 join 可能在"empty 判定后、
	// hub.rooms 删除前"的窗口内挤进来，随后房间被 delete+shutdown，
	// 新玩家落入没有 ticker 的孤儿房间（无快照、无探测、无法再加入）。
	draining bool
	// tick 耗时统计（诊断："服务器延迟高"到底是服务端卡还是网络 RTT）
	tickEwmaUs   int64
	tickPeakUs   int64
	tickCount    int64
	tickReportAt time.Time
}

func (r *Room) shutdown() {
	r.closeOnce.Do(func() { close(r.close) })
}

func (r *Room) emptyLocked() bool { return len(r.players) == 0 }

func (r *Room) indexOf(c *Client) int {
	for i, p := range r.players {
		if p == c {
			return i
		}
	}
	return -1
}

func (r *Room) humanCountLocked() int {
	n := 0
	for _, p := range r.players {
		if !p.ai {
			n++
		}
	}
	return n
}

func (r *Room) playerByIDLocked(id int) *Client {
	for _, p := range r.players {
		if p.id == id {
			return p
		}
	}
	return nil
}

// botTargetLocked keeps the old no-id protocol sender-local while allowing only
// the live human host to address a bot explicitly.
func (r *Room) botTargetLocked(actor *Client, requestedID *int) (*Client, bool) {
	if actor == nil || actor.ai {
		return nil, false
	}
	if requestedID == nil {
		return actor, true
	}
	target := r.playerByIDLocked(*requestedID)
	// ★ 报文里的 id 只用于"房主代报人机"这一种跨席位写入。对真人而言，身份**只认
	//   连接本身**（服务端权威，绝不信任客户端自报的 id）。因此当 id 落空、或指向
	//   另一个**真人**时，一律当作"未携带 id"处理，把这条报文记到发送者自己头上。
	//
	//   为什么必须这样：前端 `localId` 与服务端分配的席位在极端时序下可能不一致
	//   （重连/切房残留）。旧实现此时返回 false ⇒ 该玩家的 **所有 state/lap/fin 报文
	//   被 100% 静默丢弃** ⇒ 其他所有人看他永远停在发车格"挂机"（用户报障"双方互相
	//   显示在起点挂机"）。退化为"记到发送者自己头上"不会产生任何越权：这与不带 id
	//   的报文路径完全等价（反正也只能写自己）。
	if target == nil || !target.ai {
		return actor, true
	}
	// 人机席位：只有"当前房主代报自己拥有的人机"才放行。
	if actor.id != r.hostID || target.ownerID != actor.id {
		return nil, false
	}
	return target, true
}

// freeSlotLocked 返回 1..4 中最小空闲席位号。
func (r *Room) freeSlotLocked() int {
	used := [maxPlayers + 1]bool{}
	for _, p := range r.players {
		if p.id >= 1 && p.id <= maxPlayers {
			used[p.id] = true
		}
	}
	for i := 1; i <= maxPlayers; i++ {
		if !used[i] {
			return i
		}
	}
	return 0
}

type aiProfile struct {
	name   string
	color  string
	engine string
}

var aiProfiles = []aiProfile{
	{name: "AI · 银箭", color: "#c0c7d1", engine: "silver-arrow"},
	{name: "AI · 红隼", color: "#e10600", engine: "kestrel"},
	{name: "AI · 蓝鲨", color: "#1683ff", engine: "blue-shark"},
	{name: "AI · 黑豹", color: "#8f5cff", engine: "black-panther"},
}

// addAIBotLocked creates a server-visible seat without creating a fake
// WebSocket client. The host is the only authority that may drive this seat.
func (r *Room) addAIBotLocked(host *Client) *Client {
	if host == nil || host.ai || host.id != r.hostID || r.started || r.counting || r.humanCountLocked() == 0 {
		return nil
	}
	slot := r.freeSlotLocked()
	if slot == 0 {
		return nil
	}
	profile := aiProfiles[(slot-1)%len(aiProfiles)]
	bot := &Client{
		room: r, id: slot, name: profile.name, color: profile.color, ai: true,
		engine: profile.engine, ownerID: host.id, ready: true, rttMs: -1,
		lastSeen: time.Now(), cp: -1,
	}
	bot.resetPassageStateLocked()
	r.players = append(r.players, bot)
	sort.SliceStable(r.players, func(i, j int) bool { return r.players[i].id < r.players[j].id })
	return bot
}

func (r *Room) removeAIBotLocked(host *Client, id int) bool {
	if host == nil || host.ai || host.id != r.hostID || r.started || r.counting {
		return false
	}
	bot := r.playerByIDLocked(id)
	if bot == nil || !bot.ai {
		return false
	}
	idx := r.indexOf(bot)
	if idx < 0 {
		return false
	}
	r.players = append(r.players[:idx], r.players[idx+1:]...)
	bot.room = nil
	return true
}

func (r *Room) broadcastLocked(msg []byte) {
	for _, p := range r.players {
		p.enqueue(msg)
	}
}

func (r *Room) send(c *Client, msg []byte) { c.enqueue(msg) }

func (r *Room) roomMsgLocked(you int) []byte {
	var sb strings.Builder
	sb.WriteString(`{"t":"room","room":`)
	sb.WriteString(strconv.Quote(r.id))
	sb.WriteString(`,"laps":`)
	sb.WriteString(strconv.Itoa(r.laps))
	sb.WriteString(`,"you":`)
	sb.WriteString(strconv.Itoa(you))
	sb.WriteString(`,"host":`)
	sb.WriteString(strconv.Itoa(r.hostID))
	sb.WriteString(`,"started":`)
	sb.WriteString(boolStr(r.started))
	sb.WriteString(`,"ghost":`)
	sb.WriteString(boolStr(r.ghost))
	sb.WriteString(`,"seed":`)
	sb.WriteString(strconv.FormatInt(r.trackSeed, 10))
	sb.WriteString(`,"best":`)
	sb.WriteString(strconv.FormatFloat(r.bestLap, 'f', 3, 64))
	sb.WriteString(`,"track":`)
	sb.WriteString(strconv.Quote(r.trackType))
	sb.WriteString(`,"gameMode":`)
	sb.WriteString(strconv.Quote(r.gameMode))
	// humanCount = 房内**真人**数（人机不计入在线玩家）。前端房间页的"人数"用它，
	// 而 players 数组仍包含人机（用于渲染车手列表与发车格）。
	sb.WriteString(`,"humanCount":`)
	sb.WriteString(strconv.Itoa(r.humanCountLocked()))
	// 赛季积分排行榜（规格 §一.1）：随 room 报文下发，客户端首页右侧滑出展示。
	// 使用积分变更时重建的缓存，房间广播无需读取整个积分表。
	if r.hub != nil {
		sb.WriteString(`,"season":`)
		sb.WriteString(r.hub.seasonSnapshot())
	}
	sb.WriteString(`,"players":[`)
	for i, p := range r.players {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(`{"id":`)
		sb.WriteString(strconv.Itoa(p.id))
		sb.WriteString(`,"name":`)
		sb.WriteString(strconv.Quote(p.name))
		sb.WriteString(`,"color":`)
		sb.WriteString(strconv.Quote(p.color))
		sb.WriteString(`,"ai":`)
		sb.WriteString(boolStr(p.ai))
		sb.WriteString(`,"engine":`)
		sb.WriteString(strconv.Quote(p.engine))
		sb.WriteString(`,"ready":`)
		sb.WriteString(boolStr(p.ready))
		sb.WriteString(`,"lap":`)
		sb.WriteString(strconv.Itoa(p.lap))
		sb.WriteString(`,"pen":`)
		sb.WriteString(strconv.FormatFloat(p.penalty, 'f', 2, 64))
		sb.WriteString(`,"vio":`)
		sb.WriteString(strconv.Itoa(p.violations))
		sb.WriteString(`,"fin":`)
		sb.WriteString(boolStr(p.finished))
		sb.WriteString(`,"slot":`)
		sb.WriteString(strconv.Itoa(p.gridSlot))
		sb.WriteString(`,"pts":`)
		sb.WriteString(strconv.FormatInt(p.points, 10))
		// 延迟（毫秒）：服务端实测，-1 = 尚未测得（客户端据此不显示徽标）。
		sb.WriteString(`,"ms":`)
		p.pingMu.Lock()
		sb.WriteString(strconv.Itoa(p.rttMs))
		p.pingMu.Unlock()
		sb.WriteByte('}')
	}
	sb.WriteString(`]}`)
	return []byte(sb.String())
}

func (r *Room) broadcastRoomLocked() {
	for _, p := range r.players {
		p.enqueue(r.roomMsgLocked(p.id))
	}
}

// snapshotLocked 以零反射方式拼装 30Hz 位姿快照（状态体原样中继，不再反序列化）。
func (r *Room) snapshotLocked() []byte {
	nowMs := monoMs()
	var sb strings.Builder
	sb.Grow(1024)
	sb.WriteString(`{"t":"snap","ts":`)
	sb.WriteString(strconv.FormatInt(time.Now().UnixMilli(), 10))
	// mts = 服务端单调时钟（自启动毫秒数）。客户端插值时间轴以它为准：
	// time.Since 基于单调时钟，不受 NTP 校时/系统改时间影响。
	sb.WriteString(`,"mts":`)
	sb.WriteString(strconv.FormatInt(nowMs, 10))
	sb.WriteString(`,"p":[`)
	n := 0
	for _, p := range r.players {
		if len(p.state) == 0 {
			continue
		}
		if n > 0 {
			sb.WriteByte(',')
		}
		n++
		sb.WriteString(`{"id":`)
		sb.WriteString(strconv.Itoa(p.id))
		sb.WriteString(`,"f":`)
		if p.finished {
			sb.WriteString("1")
		} else {
			sb.WriteString("0")
		}
		sb.WriteString(`,"ai":`)
		sb.WriteString(boolStr(p.ai))
		sb.WriteString(`,"age":`)
		sb.WriteString(strconv.FormatInt(max(int64(0), nowMs-p.stateAt), 10))
		sb.WriteString(`,"seq":`)
		sb.WriteString(strconv.FormatUint(uint64(p.lastSeq), 10))
		sb.WriteString(`,"d":`)
		sb.Write(p.state)
		sb.WriteByte('}')
	}
	sb.WriteString(`]}`)
	return []byte(sb.String())
}

func (r *Room) readyCountLocked() int {
	n := 0
	for _, p := range r.players {
		if !p.ai && p.ready {
			n++
		}
	}
	return n
}

// allReadyLocked 全员准备且人数 >= 1 才可以发车（单人也能练习计时）。
func (r *Room) allReadyLocked() bool {
	humans := 0
	for _, p := range r.players {
		if p.ai {
			continue
		}
		humans++
		if !p.ready {
			return false
		}
	}
	return humans > 0
}

// assignGridLocked 按历史总积分**升序**分配倒序发车格（调用方持锁）：
// 积分最低者拿 P1 杆位（最前），积分最高者排末位发车格。
// 积分相同时按当前房间席位号稳定排序，保证多机结果一致。
func (r *Room) assignGridLocked() {
	type se struct {
		p   *Client
		pts int64
	}
	ses := make([]se, 0, len(r.players))
	for _, p := range r.players {
		ses = append(ses, se{p, p.points})
	}
	sort.SliceStable(ses, func(i, j int) bool {
		if ses[i].pts != ses[j].pts {
			return ses[i].pts < ses[j].pts
		}
		return ses[i].p.id < ses[j].p.id
	})
	for i, s := range ses {
		s.p.gridSlot = i + 1
	}
}

// gridJSONLocked 输出 "玩家席位号 -> 发车格序号(1..4)" 映射。
// 服务端只裁决**谁站哪个格**；具体世界坐标由客户端用同一 seed 生成的
// 赛道几何按 slot 求解（服务端无需复制赛道几何，保证单一数据源）。
func (r *Room) gridJSONLocked() string {
	var sb strings.Builder
	sb.WriteByte('{')
	first := true
	for _, p := range r.players {
		if !first {
			sb.WriteByte(',')
		}
		first = false
		sb.WriteString(strconv.Quote(strconv.Itoa(p.id)))
		sb.WriteByte(':')
		sb.WriteString(strconv.Itoa(p.gridSlot))
	}
	sb.WriteByte('}')
	return sb.String()
}

// startLightTickMs 是局内五盏红灯逐盏熄灭的权威节拍。比赛开始后不再显示
// 数字倒计时，只有红灯逐盏熄灭 -> 绿灯发车（规格 §一）。
//
// ★ 2026-09-30：用户要求「红灯再长一点」—— 500ms → 700ms（灯序总长 2.5s → 3.5s）。
//
//	客户端 public/js/main.js 的 LIGHT_TICK_MS 必须与此**逐毫秒一致**
//	（单机没有服务端，灯序完全靠它自驱）。
const startLightTickMs = 700

// readyCountdownSec 是"全员准备后"在**右侧聊天框**里播报的整备倒计时秒数。
// 规格 §一.0：全员准备 → 聊天框 5 秒倒计时 → 才开始载入并亮红灯。
// 这段时间是留给玩家的**准备时间**（调视角、看地图、互相打招呼），
// 期间操控仍然锁死（客户端在收到 START_SEQUENCE_BEGIN 前就已经锁车）。
const readyCountdownSec = 5

// beginCountdownLocked 两阶段开赛倒计时 -> START 广播。调用方需持锁。
//
// 权威发车状态机：
//
//	{"t":"START_SEQUENCE_BEGIN"} 全员载入，客户端锁车并显示五盏红灯
//	{"t":"start",...}            统一下发赛道与发车时钟，进入驾驶场景
//	{"t":"lights","stage":5..1}  五盏红灯逐盏熄灭
//	{"t":"lights","stage":6}     绿灯亮起
//	{"t":"RACE_START"}           权威放行，绝不缺失
//
// 不再广播 `count` 或聊天倒计时文本；数字 3-2-1 不属于比赛流程。
func (r *Room) beginCountdownLocked() {
	if r.counting || r.started {
		return
	}
	r.counting = true
	if r.readyCountdown > 0 {
		return
	}
	r.countdownGeneration++
	r.armCountdownLocked()
}

// armCountdownLocked 启动两阶段开赛协程。调用方需持锁。
// 幂等保护由调用方负责（readyCountdown > 0 时表示已在跑）。
func (r *Room) armCountdownLocked() {
	r.readyCountdown = readyCountdownSec
	generation := r.countdownGeneration
	go func() {
		defer func() { recover() }() // 房间被销毁时的关门保护

		// ── 规格 §一：全员载入 -> 宣告倒计时序列开始 ──
		r.mu.Lock()
		if generation != r.countdownGeneration || !r.counting || r.emptyLocked() || !r.allReadyLocked() {
			if generation == r.countdownGeneration {
				r.counting = false
				r.readyCountdown = 0
			}
			r.mu.Unlock()
			return
		}
		// ★ 全员准备后的**准备时间**（规格 §一.0）：先在右侧聊天框里播报 5 秒
		//   整备倒计时，倒计时跑完才开始载入赛道、亮红灯。用户明确要求
		//   "不能再一键就发车，要有准备时间"。
		//
		//   ⚠️ 每拍都要**重新取锁**并复查房间状态：这 5 秒里可能有人取消准备、
		//      有人退房（房间空掉）、或房主切了赛道/圈数。任一情况都立即中止并
		//      回到 WAITING —— 否则会把玩家硬拖进一场他们没准备好的比赛。
		//   ⚠️ 与阶段二灯序同样必须**在进入循环前解锁**（sync.Mutex 不可重入，
		//      曾在阶段二灯序上栽过一次首拍自锁死）。
		r.mu.Unlock()
		for s := readyCountdownSec; s >= 1; s-- {
			r.mu.Lock()
			if generation != r.countdownGeneration || !r.counting {
				r.mu.Unlock()
				return
			}
			if r.emptyLocked() || !r.allReadyLocked() {
				r.counting = false
				r.readyCountdown = 0
				// 有人退出准备：清掉倒计时公告，别让聊天框停在一句"5"。
				r.broadcastSystemLocked("有玩家取消准备，发车已中止")
				r.mu.Unlock()
				return
			}
			r.readyCountdown = s
			r.broadcastSystemLocked("[赛事指令] 全员已准备 · " + strconv.Itoa(s) + " 秒后发车…")
			r.mu.Unlock()
			time.Sleep(1 * time.Second)
		}

		r.mu.Lock()
		if generation != r.countdownGeneration || !r.counting || r.emptyLocked() || !r.allReadyLocked() {
			if generation == r.countdownGeneration {
				r.counting = false
				r.readyCountdown = 0
			}
			r.mu.Unlock()
			return
		}
		r.readyCountdown = 0
		r.broadcastLocked([]byte(`{"t":"START_SEQUENCE_BEGIN"}`))
		r.mu.Unlock()

		r.mu.Lock()
		if generation != r.countdownGeneration || !r.counting || r.emptyLocked() || !r.allReadyLocked() {
			if generation == r.countdownGeneration {
				r.counting = false
				r.readyCountdown = 0
			}
			r.mu.Unlock()
			return
		}
		r.counting = false
		r.started = true
		r.finished = false
		r.lbTick = 0
		r.racing = false
		// DNF 宽限倒计时随新一场比赛重置（首位冲线时才重新置位）。
		r.dnfDeadline = time.Time{}
		r.dnfLeft = 0
		// 发车时刻取"服务端当前 + 阶段二时长 + 缓冲"。
		//
		// 局内灯序 = 5 拍 × 0.7s + 0.25s 载入缓冲，故 start.at = now + 3.75s。
		// 客户端 beginRace 后立刻显示五盏红灯并锁定操控；灯序结束才放行。
		//
		// ⚠️ 必须用 **UnixMilli 墙钟** 而不是 monoMs()：这个值经 "start" 报文下发给
		// 客户端，客户端按 `Date.now() + simOffset`（NTP 校正过的墙钟）去减。
		// monoMs() 是"进程启动起的毫秒数"（相对量），客户端另用 monoOffset 换算 "mts"，
		// 两条时间轴不可混用 —— 一旦混用，raceClock 会变成 −1.7e12 秒量级的巨负值，
		// 发车即被判为"比赛已结束"，玩家永远无法起步。
		const stage2Ms = 5*startLightTickMs + 250
		r.startAt = time.Now().Add(time.Duration(stage2Ms) * time.Millisecond)
		r.trackSeed = rand.Int63n(1 << 30)
		r.bestLap = 0
		r.lapMs = 0
		for _, p := range r.players {
			p.penalty, p.offTime, p.netTime, p.total, p.rank = 0, 0, 0, 0, 0
			p.lap, p.bestLap = 0, 0
			p.finished, p.locked, p.retired = false, false, false
			p.state = nil
			p.ready = p.ai
			p.cp, p.distNext, p.speedKmh, p.score, p.gridSlot = -1, 0, 0, 0, 0
			p.lastSeq = 0
			p.resetPassageStateLocked()
			for i := range p.passTime {
				p.passTime[i] = 0
			}
		}
		r.assignGridLocked()
		msg := `{"t":"start","at":` + strconv.FormatInt(r.startAt.UnixMilli(), 10) +
			`,"seed":` + strconv.FormatInt(r.trackSeed, 10) +
			`,"track":` + strconv.Quote(r.trackType) +
			`,"ghost":` + boolStr(r.ghost) +
			`,"gameMode":` + strconv.Quote(r.gameMode) +
			`,"laps":` + strconv.Itoa(r.laps) +
			`,"grid":` + r.gridJSONLocked() + `}`
		r.broadcastLocked([]byte(msg))
		log.Printf("[room %s] START laps=%d track=%s seed=%d players=%d (lights=%dms)",
			r.id, r.laps, r.trackType, r.trackSeed, len(r.players), stage2Ms)
		// ⚠️ 必须在此释放 r.mu：上面的状态初始化一直持锁，
		//   而阶段二的循环会在每拍自行 r.mu.Lock()。sync.Mutex 不可重入，
		//   若不在此解锁，第一拍 Lock() 即自锁死 —— ticker 也会跟着永久阻塞，
		//   表现为"START 已下发但位姿快照/信号灯全部停摆"（仅 ping/pong 仍通）。
		r.mu.Unlock()

		// ── 局内五红灯：先全亮，再自右向左逐盏熄灭 ──
		// stage=5..1 表示仍亮着的红灯数量；stage=6 表示熄红灯、亮绿灯。
		// 载入缓冲：客户端收到 "start" 后要建赛道/编译着色器，这里先给 250ms。
		time.Sleep(250 * time.Millisecond)
		for stage := 5; stage >= 1; stage-- {
			r.mu.Lock()
			if generation != r.countdownGeneration || !r.started || r.finished || r.emptyLocked() {
				r.mu.Unlock()
				return
			}
			r.broadcastLocked([]byte(`{"t":"lights","stage":` + strconv.Itoa(stage) +
				`,"at":` + strconv.FormatInt(r.startAt.UnixMilli(), 10) + `}`))
			r.mu.Unlock()
			time.Sleep(startLightTickMs * time.Millisecond)
		}
		// 绿灯放行（把上面预支的 250ms 计入总时长，start.at 与之严格对齐）。
		r.mu.Lock()
		if generation == r.countdownGeneration && r.started && !r.finished && !r.emptyLocked() {
			// 规格 §一：归零 -> `RACE_START`（**绝不缺失**）。这是客户端放行的
			// 唯一权威信号；旧 `lights stage 6` 继续下发作为冗余双通道。
			r.broadcastLocked([]byte(`{"t":"RACE_START","at":` +
				strconv.FormatInt(r.startAt.UnixMilli(), 10) + `}`))
			r.broadcastLocked([]byte(`{"t":"lights","stage":6,"at":` +
				strconv.FormatInt(r.startAt.UnixMilli(), 10) + `}`))
			// 规格 §一.2：绿灯放行事件推入聊天流（系统公告，与 count 同通道）。
			r.broadcastSystemLocked("[赛事指令] 全员发车！")
			// 服务端时钟到点即视为正式开赛（客户端 S.rp.racing 亦由 raceClock>=0 推出）。
			r.racing = true
		}
		r.mu.Unlock()
	}()
}

// ---------------------------------------------------------------------------
// 服务端权威排位（20Hz 解算）
// ---------------------------------------------------------------------------

// 进度积分权重（与客户端 progressScore 必须完全一致）：
//
//	Score = lap*100000 + (cpLast+1)*1000 - clamp(distNext, 0, 999)
//
// 其中 cpLast 是**最后通过**的 Checkpoint 索引（起步时为 -1）。
// 权重差保证严格单调：圈数 >> Checkpoint 数 >> 距下一个 Checkpoint 的剩余距离
// （Checkpoint 间距远小于 1000m，所以 distNext 不会跨过相邻 Checkpoint 的档位）。
// nominalCpMeters 是 Checkpoint 之间的**标称**间距（米），只在"刚发车、双方还没有
// 任何公共 Checkpoint"的兜底分支里使用：那时只能按整档积分差折算里程。
// 铃鹿全长 6755m / 24 CP ≈ 281m。一旦有任何公共 Checkpoint，就改用绝对时间戳差，
// 与这个常量无关了，所以它不需要精确。
const (
	scoreLapW = 100000
	scoreCpW  = 1000
)

func progressScore(lap, cpLast int, distNext float64) int64 {
	if lap < 0 {
		lap = 0
	}
	if cpLast < -1 {
		cpLast = -1
	}
	if cpLast > maxCP-1 {
		cpLast = maxCP - 1
	}
	if distNext < 0 {
		distNext = 0
	}
	if distNext > scoreCpW-1 {
		distNext = scoreCpW - 1
	}
	return int64(lap)*scoreLapW + int64(cpLast+1)*scoreCpW - int64(distNext)
}

// solveDeltaMs 解算 a 相对 b 的**带符号**时间差（毫秒）。
//
// ⚠️ 符号约定（与 C++ `forza::race::RaceDeltaTracker::Solve` **严格一致**）：
//
//	> 0  a 领先 b（a 更早到达同一截面）
//	< 0  a 落后 b
//	== 0 并驾齐驱
//
// 反对称性：solveDeltaMs(a,b) == -solveDeltaMs(b,a)（同一判定路径下）。
// 规格：依据两人**共同通过过**的最新 Checkpoint 的服务端绝对时间戳求差；
// 未经过固定计时点时用**前车**在该赛段的实时车速外推（严禁"欧氏距离 ÷ 实时速度"）。
//
// ok=false 表示当前状态无法给出确定的秒差（客户端应渲染为 "—"）。
//
// 历史教训：本函数此前叫 gapBehindMs，语义是"a 落后 b 记正号"——正好与
// RaceDeltaTracker 相反。两套符号并存了一段时间，榜首那一行的负号方向反复出错。
// 现在**全工程只保留这一套 signed 语义**：服务端只输出 signed 值，
// 客户端 `RaceDeltaTracker::FormatLocalRow / FormatChaserRow` 负责把符号翻成
// 规格要求的文本（落后一律 "-X.X"、领跑 "--"）。任何一层都不得再自行取反。
func (r *Room) solveDeltaMs(a, b *Client) (float64, bool) {
	if a == b {
		return 0, true
	}

	// The UI treats a delta as a race-control aid, not a raw arithmetic dump.
	// Reject stale or corrupt values instead of painting thousands of seconds.
	const (
		fallbackLapMs  = 90000.0
		minLapMs       = 15000.0
		maxLapMs       = 300000.0
		maxTimingGapMs = 600000.0
	)
	plausible := func(ms float64) bool {
		return ms >= -maxTimingGapMs && ms <= maxTimingGapMs
	}
	lms := r.lapMs
	if lms < minLapMs || lms > maxLapMs {
		lms = fallbackLapMs
	}

	// Both cars finished: compare official net race time.
	if a.finished && b.finished {
		ms := (b.total - a.total) * 1000
		if !plausible(ms) {
			return 0, false
		}
		return ms, true
	}
	// A running car cannot be given a meaningful gap to a finished car.
	if !a.finished && b.finished {
		return 0, false
	}

	// Different lap counters: extend each car's total progress and scale by the
	// room's latest clean lap. This keeps the value continuous when one car is
	// just before the line and the other has already crossed it.
	if a.lap != b.lap {
		// Only trust the lap-extrapolated gap when the cars are within one
		// spline "lap rollover" window (0.05 = ~340m on Suzuka). Outside that
		// window the estimate is unreliable and can show hundreds of seconds.
		aTotal := float64(a.lap) + clamp01(a.spline)
		bTotal := float64(b.lap) + clamp01(b.spline)
		diff := aTotal - bTotal
		if diff > 1.05 || diff < -1.05 {
			return 0, false
		}
		ms := diff * lms
		if !plausible(ms) {
			return 0, false
		}
		return ms, true
	}

	// Same lap: compare the two cars at a common spline passage slice. This is
	// the stable definition: when the chasing car reaches slice s, its arrival
	// time minus the leader's arrival time at the same slice is the true elapsed
	// gap, independent of either car's instantaneous speed or braking point.
	nowMs := float64(monoMs())
	staleWindowMs := lms*1.5 + 5000
	if staleWindowMs < 45000 {
		staleWindowMs = 45000
	}
	aTotal := float64(a.lap) + clamp01(a.spline)
	bTotal := float64(b.lap) + clamp01(b.spline)
	aAhead := aTotal > bTotal || (aTotal == bTotal && a.id < b.id)
	lead, chase := a, b
	if !aAhead {
		lead, chase = b, a
	}
	slice := passageSlice(chase.spline)
	for back := 0; back <= 8; back++ {
		k := slice - back
		if k < 0 {
			k += passageSlices
		}
		tl, tc := lead.sliceTime[k], chase.sliceTime[k]
		if tl <= 0 || tc <= 0 {
			continue
		}
		if nowMs-tl > staleWindowMs || nowMs-tc > staleWindowMs {
			continue
		}
		ms := tc - tl
		if !plausible(ms) || ms > staleWindowMs || ms < -staleWindowMs {
			continue
		}
		if aAhead {
			return ms, true
		}
		return -ms, true
	}

	// Checkpoint timestamps remain a fallback for clients that joined an older
	// protocol or whose spline telemetry was temporarily dropped.
	c := a.cp
	if b.cp < c {
		c = b.cp
	}
	for ; c >= 0; c-- {
		ta, tb := a.passTime[c], b.passTime[c]
		if ta <= 0 || tb <= 0 {
			continue
		}
		if nowMs-ta > staleWindowMs || nowMs-tb > staleWindowMs {
			continue
		}
		ms := tb - ta
		if !plausible(ms) || ms > staleWindowMs || ms < -staleWindowMs {
			continue
		}
		return ms, true
	}

	// No common passage timestamp yet. Returning a live-speed extrapolation here
	// makes the HUD jump by seconds whenever one car brakes or a state packet is
	// delayed, so the only honest answer is "not measurable yet".
	return 0, false
}

// leaderboardLocked 解算权威排位并拼装 LEADERBOARD_UPDATE（调用方持 room.mu）。
func (r *Room) leaderboardLocked() []byte {
	type entry struct {
		c *Client
	}
	es := make([]entry, 0, len(r.players))
	for _, p := range r.players {
		es = append(es, entry{p})
	}
	sort.SliceStable(es, func(i, j int) bool {
		a, b := es[i].c, es[j].c
		if a.finished != b.finished {
			return a.finished // 完赛者排在前面
		}
		if a.finished && b.finished {
			return a.total < b.total // 都完赛：净用时短者在前
		}
		if a.score != b.score {
			return a.score > b.score // 都未完赛：进度积分高者在前
		}
		// 起步瞬间（都在发车格、尚未过 CP0）进度积分可能同分，此时按**发车格**决胜：
		// 积分相同者本来就是同一排起步，用席位号排序会与倒序发车位置相反
		// （用户报障"局内左上角的名次有时会错乱"）。gridSlot>0 才参与本档，
		// 避免未分配发车格的座位（大厅/观战）拿到不存在的次序。
		if a.gridSlot > 0 && b.gridSlot > 0 && a.gridSlot != b.gridSlot {
			return a.gridSlot < b.gridSlot
		}
		return a.id < b.id
	})

	var sb strings.Builder
	sb.Grow(640)
	sb.WriteString(`{"t":"LEADERBOARD_UPDATE","data":[`)
	for i, e := range es {
		p := e.c
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(`{"id":`)
		sb.WriteString(strconv.Itoa(p.id))
		sb.WriteString(`,"name":`)
		sb.WriteString(strconv.Quote(p.name))
		sb.WriteString(`,"color":`)
		sb.WriteString(strconv.Quote(p.color))
		sb.WriteString(`,"pos":`)
		sb.WriteString(strconv.Itoa(i + 1))
		sb.WriteString(`,"lap":`)
		sb.WriteString(strconv.Itoa(p.lap))
		sb.WriteString(`,"pen":`)
		sb.WriteString(strconv.FormatFloat(p.penalty, 'f', 2, 64))
		sb.WriteString(`,"vio":`)
		sb.WriteString(strconv.Itoa(p.violations))
		sb.WriteString(`,"fin":`)
		sb.WriteString(boolStr(p.finished))

		// ── 三个秒差字段，全部是**带符号**值（>0 = 该车领先被比较者）──
		// 约定与 C++ RaceDeltaTracker 完全一致：由服务端给出 signed 数值，
		// 客户端负责按规格翻成文本（落后 "-X.X"、领跑 "--"）。任何一层不得自行取反。
		//
		//   gap    = 该车相对 P1（领跑者）的带符号差。P1 恒为 0（客户端渲染 LEADER）。
		//            负值 = 落后 P1，客户端渲染成 "-X.Xs"。
		//   int    = 该车相对**前一名**的带符号差（Interval to Ahead）。P1 恒为 0。
		//   behind = 该车相对**后一名**的带符号差。正值 = 该车领先后车，
		//            客户端渲染成 "▼ X.Xs"（防守秒差）；末位为 null。
		sb.WriteString(`,"gap":`)
		if i == 0 {
			sb.WriteString("0")
		} else if g, ok := r.solveDeltaMs(p, es[0].c); ok {
			sb.WriteString(strconv.FormatFloat(g/1000, 'f', 3, 64))
		} else {
			sb.WriteString("null")
		}
		// Interval to Ahead（与前一名）
		sb.WriteString(`,"int":`)
		if i == 0 {
			sb.WriteString("0")
		} else if g, ok := r.solveDeltaMs(p, es[i-1].c); ok {
			sb.WriteString(strconv.FormatFloat(g/1000, 'f', 3, 64))
		} else {
			sb.WriteString("null")
		}
		// Gap to Behind（与后一名）
		sb.WriteString(`,"behind":`)
		if i >= len(es)-1 {
			sb.WriteString("null")
		} else if g, ok := r.solveDeltaMs(p, es[i+1].c); ok {
			sb.WriteString(strconv.FormatFloat(g/1000, 'f', 3, 64))
		} else {
			sb.WriteString("null")
		}
		sb.WriteByte('}')
	}
	sb.WriteString(`]}`)
	return []byte(sb.String())
}

func (r *Room) resultsLocked() []Result {
	out := make([]Result, 0, len(r.players))
	// 排序键：未完赛者（DNF）按服务端进度积分排名——谁跑得远谁名次高。
	// progressScore 已在秒差解算里同一口径使用（lap/cp/distNext）。
	score := make(map[int]int64, len(r.players))
	for _, p := range r.players {
		score[p.id] = progressScore(p.lap, p.cp, p.distNext)
		out = append(out, Result{
			ID: p.id, Name: p.name, Color: p.color,
			Net: p.netTime, Pen: p.penalty, Total: p.total,
			Lap: p.lap, BestLap: p.bestLap,
			Finished: p.finished,
			DNF:      !p.finished && p.retired,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Finished != b.Finished {
			return a.Finished // 完赛者优先
		}
		if a.Finished && b.Finished {
			return a.Total < b.Total
		}
		return score[a.ID] > score[b.ID]
	})
	for i := range out {
		out[i].Rank = i + 1
	}
	return out
}

// notifyDnfLocked 广播 DNF 宽限倒计时开始（含剩余秒数与"首位完赛者"）。
// 客户端据此在 HUD 顶部显示倒计时，让未完赛车手知道还有多久被强制结算。
func (r *Room) notifyDnfLocked(secs int) {
	r.dnfLeft = -1 // 置为"未广播"，下一拍 ticker 会广播真实剩余秒数
}

func (r *Room) endRaceLocked(reason string) {
	if r.finished {
		return
	}
	r.finished = true
	r.started = false
	res := r.resultsLocked()
	b, err := json.Marshal(res)
	if err != nil {
		return
	}
	msg := `{"t":"end","reason":` + strconv.Quote(reason) + `,"results":` + string(b) + `}`
	r.broadcastLocked([]byte(msg))

	// ── 规格 §二：结算名次积分 -> 累加进赛季总积分并持久化 ──
	// 积分表见 pointTable（P1 +10 / P2 +6 / P3 +4 / P4 +2）。res 已按名次排好序
	// （Rank = i+1）。排除默认随机名（Guest_*/Player_* 等）在 addPoints 里统一处理。
	//
	// 结算完成后**立刻**广播两条新报文：
	//   · RACE_RESULTS           全量完赛者（名次/名/最快圈/总用时/本场积分）
	//   · SEASON_LEADERBOARD_UPDATE 赛季榜最新快照（首页/大厅右侧榜单实时重渲染）
	// 二者都需在 hub.mu 内取到积分后的最新快照，故在锁内构造、锁外广播（避免锁序）。
	pointsAwarded := make(map[int]int64, len(res))
	var seasonJSON string
	if r.hub != nil {
		r.hub.mu.Lock()
		for _, e := range res {
			if e.Rank >= 1 && e.Rank <= maxPlayers {
				pts := pointTable[e.Rank]
				// 默认随机名不进赛季榜（addPoints 内部过滤），但"本场积分"仍按名次给出，
				// 以便结算 Modal 精确展示每个座位的得分。
				pointsAwarded[e.ID] = pts
				isAI := false
				for _, p := range r.players {
					if p.id == e.ID {
						isAI = p.ai
						break
					}
				}
				if !isAI {
					r.hub.addPoints(e.Name, pts)
				}
			}
		}
		for _, p := range r.players {
			if p.ai {
				p.points = 0
			} else {
				p.points = r.hub.pointsOf(p.name)
			}
		}
		r.hub.savePoints()
		r.hub.rebuildSeasonLocked()
		seasonJSON = r.hub.seasonSnapshot()
		r.hub.mu.Unlock()
	}
	log.Printf("[room %s] END (%s)", r.id, reason)

	// RACE_RESULTS：结算 Modal 的数据源（规格 §二）。字段名与前端严格对齐：
	//   {rank, name, bestLap, totalTime, points, fin, dnf, color, id}
	r.broadcastLocked(r.raceResultsJSONLocked(res, pointsAwarded))
	// SEASON_LEADERBOARD_UPDATE：赛季积分排行榜实时推送（规格 §二：无需刷新页面）。
	if seasonJSON != "" {
		payload := []byte(`{"t":"SEASON_LEADERBOARD_UPDATE","rankings":` + seasonJSON + `}`)
		if r.hub != nil {
			// 首页、其它房间的大厅玩家也必须实时看到积分变化，不能只发本房。
			r.hub.broadcastAll(payload)
		} else {
			r.broadcastLocked(payload)
		}
	}
}

// raceResultsJSONLocked 构造 `RACE_RESULTS` 报文（调用方需持 r.mu）。
// 规格 §二要求的字段：rank / name / bestLap / totalTime / points。
// 额外附带 fin/dnf/color/id 供 Modal 区分完赛状态与配色（不破坏规格字段语义）。
func (r *Room) raceResultsJSONLocked(res []Result, pts map[int]int64) []byte {
	var sb strings.Builder
	sb.WriteString(`{"t":"RACE_RESULTS","data":[`)
	for i, e := range res {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(`{"rank":`)
		sb.WriteString(strconv.Itoa(e.Rank))
		sb.WriteString(`,"id":`)
		sb.WriteString(strconv.Itoa(e.ID))
		sb.WriteString(`,"name":`)
		sb.WriteString(strconv.Quote(e.Name))
		sb.WriteString(`,"color":`)
		sb.WriteString(strconv.Quote(e.Color))
		sb.WriteString(`,"bestLap":`)
		sb.WriteString(strconv.FormatFloat(e.BestLap, 'f', 3, 64))
		sb.WriteString(`,"totalTime":`)
		sb.WriteString(strconv.FormatFloat(e.Total, 'f', 3, 64))
		sb.WriteString(`,"points":`)
		sb.WriteString(strconv.FormatInt(pts[e.ID], 10))
		sb.WriteString(`,"fin":`)
		sb.WriteString(boolStr(e.Finished))
		sb.WriteString(`,"dnf":`)
		sb.WriteString(boolStr(e.DNF))
		sb.WriteByte('}')
	}
	sb.WriteString(`]}`)
	return []byte(sb.String())
}

// backToLobbyLocked 清空本场状态，回到准备界面。
func (r *Room) backToLobbyLocked() {
	r.countdownGeneration++
	r.started = false
	r.racing = false
	r.finished = false
	r.counting = false
	r.readyCountdown = 0
	r.startAt = time.Time{}
	r.dnfDeadline = time.Time{}
	r.dnfLeft = 0
	for _, p := range r.players {
		p.ready = p.ai
		p.finished = false
		p.locked = false
		p.retired = false
		p.lap = 0
		p.bestLap = 0
		p.penalty = 0
		p.violations = 0
		p.offTime = 0
		p.netTime = 0
		p.total = 0
		p.rank = 0
		p.state = nil
		p.resetPassageStateLocked()
	}
	r.broadcastLocked([]byte(`{"t":"lobby"}`))
	r.broadcastRoomLocked()
}

// ticker 房间主循环：30Hz 位姿中继 + 超时保护 + 掉线清理。
// tickStats 未使用（统计字段直接挂在 Room 上）。保留类型仅为占位说明。
// nolint:unused
type tickStats struct {
	ewmaUs int64
	peakUs int64
	count  int64
	at     time.Time
}

// stepServerBotsLocked 服务端权威推进局内人机数据（问题 6：局内人机使用服务器数据，避免不同步）。
// 若房主客户端正在实时上报该 AI（120ms 内有新鲜包），优先沿用并由服务端统一加时间戳广播；
// 若无房主上报或房主卡顿，服务端按赛道解析轨迹权威推进 AI，确保所有客户端看到完全一致的 AI。
// ⚠️ 必须在持有 rm.mu 时调用（函数名后缀 Locked）。
func (r *Room) stepServerBotsLocked(now time.Time) {
	if !r.started || r.finished || !r.racing || now.Before(r.startAt) {
		return
	}
	nowMs := monoMs()
	elapsed := now.Sub(r.startAt).Seconds()
	if elapsed < 0 {
		return
	}
	for _, p := range r.players {
		if !p.ai || p.finished {
			continue
		}
		if len(p.state) > 0 && nowMs-p.stateAt <= 120 {
			continue
		}
		// 服务端权威 AI 进度推进（根据席位差异化配速，单圈约 82~88 秒）
		lapDur := 82.0 + float64(p.id%5)*1.4
		totalProg := elapsed / lapDur
		lap := int(totalProg)
		spline := totalProg - float64(lap)
		if lap >= r.laps {
			p.advanceLapLocked(r.laps, r.laps)
			p.netTime = float64(r.laps) * lapDur
			p.total = p.netTime + p.penalty
			p.finished = true
			p.locked = true
			rank := 0
			for _, q := range r.players {
				if q.locked {
					rank++
				}
			}
			p.rank = rank
			msg := `{"t":"fin","id":` + strconv.Itoa(p.id) +
				`,"net":` + strconv.FormatFloat(p.netTime, 'f', 3, 64) +
				`,"pen":` + strconv.FormatFloat(p.penalty, 'f', 3, 64) +
				`,"total":` + strconv.FormatFloat(p.total, 'f', 3, 64) +
				`,"rank":` + strconv.Itoa(rank) + `}`
			r.broadcastLocked([]byte(msg))
			continue
		}
		if lap > p.lap {
			p.advanceLapLocked(lap, r.laps)
			if p.bestLap == 0 || lapDur < p.bestLap {
				p.bestLap = lapDur
			}
		}
		cp := int(spline * maxCP)
		if cp >= maxCP {
			cp = maxCP - 1
		}
		if cp > p.cp {
			for k := p.cp + 1; k <= cp; k++ {
				p.passTime[k] = float64(nowMs)
			}
			p.cp = cp
		}
		p.spline = spline
		p.recordPassageLocked(float64(nowMs))
		p.distNext = (1.0 - (spline*maxCP - float64(cp))) * 240.0
		p.speedKmh = 185.0
		p.score = progressScore(p.lap, p.cp, p.distNext)
	}
}

func (r *Room) ticker() {
	t := time.NewTicker(16666 * time.Microsecond) // 规格：60 Tick 高频广播
	defer t.Stop()
	for {
		select {
		case <-r.close:
			return
		case <-t.C:
		}
		tickStart := time.Now()
		r.mu.Lock()
		// ---- 延迟探测（用户要求"在房间内显示每个玩家的延迟毫秒"）------------
		// 服务端主动探测，与时钟同步的客户端 ping 是两条独立通道：
		//   服务端 --sping(nonce)--> 客户端 --spong(nonce)--> 服务端
		// RTT 由服务端用"发出→收回"的墙钟差算，玩家无法伪造。
		// 放在 `if r.started` 之外 —— 房间等车阶段也要能看到延迟。
		// ★ 探测状态由各玩家自己的 pingMu 保护（大厅玩家同样要被探测），
		//   因此这里在 rm.mu 内也只做"锁内改状态、锁外 enqueue"。
		nowPing := time.Now()
		var pingOut []*Client
		for _, p := range r.players {
			if p.ai {
				continue
			}
			p.pingMu.Lock()
			if p.nextPing.IsZero() || !nowPing.Before(p.nextPing) {
				if !p.pingSent.IsZero() {
					p.pingLoss++ // 上一拍没回：计一次丢失（不回退已测得的 rttMs）
				}
				p.pingNonce++
				p.pingSent = nowPing
				p.nextPing = nowPing.Add(pingInterval)
				pingOut = append(pingOut, p)
			}
			p.pingMu.Unlock()
		}
		for _, p := range pingOut {
			p.pingMu.Lock()
			nonce := p.pingNonce
			p.pingMu.Unlock()
			p.enqueue([]byte(`{"t":"sping","c":` + strconv.FormatInt(nonce, 10) + `}`))
		}
		if r.started && !r.finished {
			if time.Since(r.startAt) > raceHardCap {
				r.endRaceLocked("timeout")
			} else if !r.dnfDeadline.IsZero() && time.Now().After(r.dnfDeadline) {
				// 60 秒 DNF 宽限到点：把仍未冲线的座位标记为 retired（未完赛），
				// 按当前进度强制结算整场（规格 §五.1）。
				for _, p := range r.players {
					if !p.finished {
						p.retired = true
					}
				}
				r.endRaceLocked("dnf")
			} else {
				if !r.racing && time.Now().After(r.startAt) {
					r.racing = true
				}
				// 服务端权威推进局内人机（问题 6）：在快照广播前把人机进度推进到本拍时刻，
				// 使所有客户端看到的 AI 位置/进度完全一致（房主卡顿时由服务端接管）。
				r.stepServerBotsLocked(time.Now())
				r.broadcastLocked(r.snapshotLocked())
				// 权威排位以 20Hz 解算并广播（60Hz 主循环每 3 拍一次），
				// 与 60Hz 位姿流解耦：排名是慢变量，没必要每帧重排。
				r.lbTick++
				if r.lbTick%leaderboardDiv == 0 {
					r.broadcastLocked(r.leaderboardLocked())
				}
				// DNF 倒计时按秒广播剩余值（客户端 HUD 顶部倒计时）。
				if !r.dnfDeadline.IsZero() {
					left := int(time.Until(r.dnfDeadline).Seconds())
					if left < 0 {
						left = 0
					}
					if left != r.dnfLeft {
						r.dnfLeft = left
						r.broadcastLocked([]byte(`{"t":"dnf","secs":` + strconv.Itoa(left) + `}`))
					}
				}
			}
		}
		var dead []*Client
		for _, p := range r.players {
			if p.ai {
				continue
			}
			if p.idleFor() > 90*time.Second {
				dead = append(dead, p)
			}
		}
		// ★ 每拍工作耗时统计（2026-09-30）：把"服务端卡不卡"量化出来。
		//   只看锁内的工作量（快照拼装 + 广播 + 排位解算），不含 sleep。
		//   EWMA 反映常态，peak 反映抖动；>20ms 会明显影响 60Hz 广播的稳定性。
		workUs := time.Since(tickStart).Microseconds()
		r.tickEwmaUs = (r.tickEwmaUs*7 + workUs) / 8
		if workUs > r.tickPeakUs {
			r.tickPeakUs = workUs
		}
		r.tickCount++
		if nowTick := time.Now(); nowTick.Sub(r.tickReportAt) > 5*time.Second {
			r.tickReportAt = nowTick
			if r.tickEwmaUs > 4000 || r.tickPeakUs > 20000 {
				log.Printf("[房间 %s] tick 耗时 EWMA %.1fms 峰值 %.1fms（%d 拍）",
					r.id, float64(r.tickEwmaUs)/1000, float64(r.tickPeakUs)/1000, r.tickCount)
			}
			r.tickPeakUs = 0
		}
		r.mu.Unlock()

		for _, p := range dead {
			log.Printf("[room %s] 席位 %d 心跳超时，剔除", r.id, p.id)
			p.close()
			r.removePlayer(p, "timeout")
		}
	}
}

func (r *Room) removePlayer(c *Client, reason string) {
	c.hub.leave(c, reason)
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

type Hub struct {
	mu      sync.Mutex
	rooms   map[string]*Room
	clients map[*Client]struct{} // 所有已连接客户端（含未入房的大厅/首页玩家）
	rnd     *rand.Rand
	points  map[string]int64 // 玩家名 -> 历史总积分（跨场次持久化，用于倒序发车）

	// season atomic.Value 缓存**预渲染**的赛季排行榜 JSON（string）。
	// 积分只在结算时变更，因此每次变更后重建一次即可；房间报文读取它时无需加锁，
	// 房间广播无锁读取；Hub 锁只在积分变更时重建缓存。
	season atomic.Value // string
}

func newHub() *Hub {
	h := &Hub{
		rooms:   map[string]*Room{},
		clients: map[*Client]struct{}{},
		rnd:     rand.New(rand.NewSource(time.Now().UnixNano())),
		points:  map[string]int64{},
	}
	h.season.Store("[]")
	h.loadPoints()
	h.rebuildSeasonLocked()
	// 大厅（未入房）玩家的延迟探测：房间内的探测仍由 60Hz room ticker 负责，
	// 二者以"是否在房间里"互斥，不会对同一连接重复发 sping。
	go h.lobbyPingLoop()
	return h
}

// lobbyPingLoop 为**尚未入房**的大厅（首页）玩家定期发送 sping 探测。
//
// 根因：延迟探测此前只挂在房间的 60Hz ticker 上，`c.room == nil` 的玩家永远收不到
// sping ⇒ `rttMs` 恒为 -1 ⇒ 首页在线面板的延迟列一直是空的（用户报障
// "局外首页左侧的大厅玩家姓名延迟不会实时更新"）。
//
// 锁序：先 registrySnapshot（内含 hub.mu，函数返回即已释放）→ 逐房间取 rm.mu 收集
// 房内成员 → 只对大厅成员取 c.pingMu 改状态 → **锁外** enqueue。
// 绝不出现"持有 hub.mu 再取 room 锁"的嵌套。
func (h *Hub) lobbyPingLoop() {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for range t.C {
		rooms, clients := h.registrySnapshot()
		inRoom := make(map[*Client]bool, len(clients))
		for _, rm := range rooms {
			rm.mu.Lock()
			for _, p := range rm.players {
				inRoom[p] = true
			}
			rm.mu.Unlock()
		}
		nowPing := time.Now()
		for _, c := range clients {
			if c.ai || inRoom[c] {
				continue
			}
			c.pingMu.Lock()
			if c.nextPing.IsZero() || !nowPing.Before(c.nextPing) {
				if !c.pingSent.IsZero() {
					c.pingLoss++ // 上一拍没回：计一次丢失（不回退已测得的 rttMs）
				}
				c.pingNonce++
				c.pingSent = nowPing
				c.nextPing = nowPing.Add(pingInterval)
				nonce := c.pingNonce
				c.pingMu.Unlock()
				c.enqueue([]byte(`{"t":"sping","c":` + strconv.FormatInt(nonce, 10) + `}`))
				continue
			}
			c.pingMu.Unlock()
		}
	}
}

// seasonSnapshot 无锁读取赛季榜 JSON（atomic.Value 已含 happens-before 保证）。
func (h *Hub) seasonSnapshot() string {
	if v, ok := h.season.Load().(string); ok {
		return v
	}
	return "[]"
}

// addClient / removeClient 维护全局连接集合。players 只包含当前房间成员，
// 而赛季榜需要在首页、其它房间的大厅玩家之间实时扇出，故必须有独立集合。
func (h *Hub) addClient(c *Client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	h.broadcastPresence()
}

func (h *Hub) removeClient(c *Client) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
	h.broadcastPresence()
}

// broadcastAll 向所有已连接客户端投递控制报文（enqueue 自身线程安全）。
// 先在 hub 锁内复制切片，再锁外发送，避免慢客户端阻塞 Hub 元数据操作。
func (h *Hub) broadcastAll(payload []byte) {
	h.mu.Lock()
	targets := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		targets = append(targets, c)
	}
	h.mu.Unlock()
	for _, c := range targets {
		c.enqueue(payload)
	}
}

// Never hold hub.mu while acquiring a room lock: settlement takes room -> hub.
func (h *Hub) registrySnapshot() ([]*Room, []*Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, rm := range h.rooms {
		rooms = append(rooms, rm)
	}
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	return rooms, clients
}

// presenceSnapshot 先复制 Hub 注册表，再逐房读取，避免嵌套 Hub -> 房间锁。
// 大厅在线人数与房间席位是两套概念：total 统计所有 WebSocket 客户端，
// roomPlayers 统计已经加入房间的客户端，players 列表同时包含两者，供首页与房内
// 默认收起的玩家面板展开查看。这里只读服务端记录，不接受浏览器自报人数。
func (h *Hub) presenceSnapshot() []byte {
	rooms, clients := h.registrySnapshot()

	type person struct {
		name, color, room string
		id, ms            int
	}
	people := make([]person, 0, len(clients))
	occupied := make(map[*Client]bool, len(clients))
	roomPlayers := 0
	for _, rm := range rooms {
		rm.mu.Lock()
		for _, p := range rm.players {
			if p.ai {
				continue
			}
			occupied[p] = true
			roomPlayers++
			p.pingMu.Lock()
			people = append(people, person{name: p.name, color: p.color, room: rm.id, id: p.id, ms: p.rttMs})
			p.pingMu.Unlock()
		}
		rm.mu.Unlock()
	}
	for _, c := range clients {
		if occupied[c] {
			continue
		}
		// ⚠️ 未入房的大厅玩家此前漏填 `ms`（零值 ⇒ 前端恒显示 0ms），
		//    且 c.name / c.rttMs 分属两把锁，必须各自加锁读取（rename 协程会写 c.name）。
		c.mu.Lock()
		name, color := c.name, c.color
		c.mu.Unlock()
		c.pingMu.Lock()
		ms := c.rttMs
		c.pingMu.Unlock()
		people = append(people, person{name: name, color: color, ms: ms})
	}

	var sb strings.Builder
	sb.WriteString(`{"t":"presence","total":`)
	sb.WriteString(strconv.Itoa(len(clients)))
	sb.WriteString(`,"roomPlayers":`)
	sb.WriteString(strconv.Itoa(roomPlayers))
	sb.WriteString(`,"players":[`)
	for i, p := range people {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(`{"name":`)
		sb.WriteString(strconv.Quote(p.name))
		sb.WriteString(`,"color":`)
		sb.WriteString(strconv.Quote(p.color))
		sb.WriteString(`,"room":`)
		sb.WriteString(strconv.Quote(p.room))
		sb.WriteString(`,"id":`)
		sb.WriteString(strconv.Itoa(p.id))
		sb.WriteString(`,"ms":`)
		sb.WriteString(strconv.Itoa(p.ms))
		sb.WriteByte('}')
	}
	sb.WriteString(`]}`)
	return []byte(sb.String())
}

func (h *Hub) broadcastPresence() { h.broadcastAll(h.presenceSnapshot()) }

// rebuildSeasonLocked 重建赛季榜缓存（需持 h.mu）。
func (h *Hub) rebuildSeasonLocked() {
	h.season.Store(h.seasonBoardLocked())
}

// loadPoints 从磁盘恢复历史总积分（文件不存在/损坏时静默从零开始）。
func (h *Hub) loadPoints() {
	b, err := os.ReadFile(scoresFile)
	source := scoresFile
	if err != nil {
		// 旧存档兼容：只在新文件不存在时读取一次 points.json，随后立即写入新文件名。
		b, err = os.ReadFile(legacyPointsFile)
		source = legacyPointsFile
		if err != nil {
			return
		}
	}
	m := map[string]int64{}
	if json.Unmarshal(b, &m) != nil {
		return
	}
	// ★ 内存里剔除历史残留的**人机**条目（用户报障"人机不要记为在线玩家"）。
	//   scores.json 里曾有 "AI · 银箭" 等条目（早期 addPoints 未过滤人机名）。
	//   ⚠️ 判据只能用**窄谓词 isBotName**：用 isDefaultName 会把 "车手B" 这类
	//      宽前缀名（很可能就是真玩家长年沿用的默认名）连积分一起删掉，且不可逆。
	clean := make(map[string]int64, len(m))
	dropped := 0
	for k, v := range m {
		if isBotName(strings.ToLower(strings.TrimSpace(k))) {
			dropped++
			continue
		}
		clean[k] = v
	}
	h.points = clean
	// ⚠️ **载入期绝不落盘**（只做内存过滤）。曾经在这里 `savePoints()`，
	//    结果任何"起一次 hub"的单元测试都会在**仓库工作目录**里重写真实
	//    scores.json —— 实测把真人的历史积分一起改掉了。清理改为在 savePoints
	//    出口统一过滤：平时读盘零副作用，任何一次正常结算写盘时自然会清理干净。
	if source == legacyPointsFile {
		h.savePoints()
	}
	log.Printf("已载入 %d 位玩家的历史总积分（%s）；内存中忽略人机条目 %d 条", len(clean), source, dropped)
}

// savePoints 原子落盘（先写临时文件再改名，避免中途崩溃留下半截 JSON）。
// 出口统一过滤人机名：磁盘上永不出现 "AI · *" 条目（用户报障"人机不要记为在线玩家"）。
// 把清理放在**写**这一侧、而不是读那一侧，是为了让"读盘"保持零副作用 ——
// 否则任何起一次 hub 的代码（含单元测试）都会改写真实存档。
func (h *Hub) savePoints() {
	out := make(map[string]int64, len(h.points))
	for k, v := range h.points {
		if isBotName(strings.ToLower(strings.TrimSpace(k))) {
			continue
		}
		out[k] = v
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return
	}
	tmp := scoresFile + ".tmp"
	if os.WriteFile(tmp, b, 0o644) != nil {
		return
	}
	_ = os.Rename(tmp, scoresFile)
}

// pointsOf / addPoints 需持有 h.mu。
func (h *Hub) pointsOf(name string) int64 { return h.points[name] }

func (h *Hub) addPoints(name string, p int64) {
	// 默认随机名（Guest_/Player_/车手…）不进赛季榜，避免积分大屏被占位名刷屏（规格 §一.1）。
	if name == "" || p == 0 || isDefaultName(name) {
		return
	}
	h.points[name] += p
}

// seasonBoardLocked 输出赛季积分排行榜（前 seasonBoardSize 名）的 JSON 数组。
// 过滤默认随机名；按积分降序，同分按名字升序稳定排序（保证多机一致）。
// 返回格式：[{"name":"..","pts":25},{"name":"..","pts":18}, ...]
func (h *Hub) seasonBoardLocked() string {
	type e struct {
		name string
		pts  int64
	}
	es := make([]e, 0, len(h.points))
	for n, v := range h.points {
		if isDefaultName(n) || v <= 0 {
			continue
		}
		es = append(es, e{n, v})
	}
	sort.SliceStable(es, func(i, j int) bool {
		if es[i].pts != es[j].pts {
			return es[i].pts > es[j].pts
		}
		return es[i].name < es[j].name
	})
	if len(es) > seasonBoardSize {
		es = es[:seasonBoardSize]
	}
	var sb strings.Builder
	sb.WriteByte('[')
	for i, it := range es {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(`{"name":`)
		sb.WriteString(strconv.Quote(it.name))
		sb.WriteString(`,"pts":`)
		sb.WriteString(strconv.FormatInt(it.pts, 10))
		sb.WriteByte('}')
	}
	sb.WriteByte(']')
	return sb.String()
}

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func (h *Hub) newCode() string {
	for attempt := 0; attempt < 64; attempt++ {
		b := make([]byte, 4)
		for i := range b {
			b[i] = codeAlphabet[h.rnd.Intn(len(codeAlphabet))]
		}
		code := string(b)
		if _, exists := h.rooms[code]; !exists {
			return code
		}
	}
	return "RACE"
}

func (h *Hub) create(c *Client, laps int, track string, ghost bool, gameMode string) {
	if c.room != nil {
		return
	}
	h.mu.Lock()
	code := h.newCode()
	mode := sanitizeGameMode(gameMode)
	// 碰碰车模式与全员幽灵车互斥：建房时就强制实体对抗（详见 bumperForcesGhostOff）。
	if bumperForcesGhostOff(mode) {
		ghost = false
	}
	rm := &Room{hub: h, id: code, laps: clampInt(laps, 1, 20), trackType: sanitizeTrack(track), gameMode: mode, ghost: ghost, close: make(chan struct{})}
	h.rooms[code] = rm
	c.points = h.pointsOf(c.name)
	h.mu.Unlock()

	rm.mu.Lock()
	if !h.attachLocked(rm, c) {
		rm.mu.Unlock()
		return
	}
	rm.broadcastRoomLocked()
	rm.mu.Unlock()

	go rm.ticker()
	h.broadcastPresence()
	log.Printf("[room %s] 创建，房主=%s", code, c.name)
}

// attachLocked 把客户端放进房间（调用方持 room.mu）。
func (h *Hub) attachLocked(rm *Room, c *Client) bool {
	if c.room != nil {
		c.enqueue([]byte(`{"t":"err","msg":"已在房间内，请先离开当前房间"}`))
		return false
	}
	if rm.draining {
		// 房间正在回收（最后一名玩家刚离开），并入会破坏回收流程的原子性。
		c.enqueue([]byte(`{"t":"err","msg":"房间已解散，请重新创建或稍后再试"}`))
		return false
	}
	slot := rm.freeSlotLocked()
	if slot == 0 {
		c.enqueue([]byte(`{"t":"err","msg":"房间已满（上限 12 人）"}`))
		return false
	}
	c.id = slot
	c.ai = false
	if c.engine == "" {
		c.engine = "i6gt"
	}
	c.ownerID = 0
	c.lap = 0
	c.cp = -1
	c.distNext = 0
	c.speedKmh = 0
	c.score = 0
	c.gridSlot = 0
	c.resetPassageStateLocked()
	for i := range c.passTime {
		c.passTime[i] = 0
	}
	c.finished = false
	c.locked = false
	c.retired = false
	c.penalty = 0
	c.violations = 0
	c.ready = false
	c.bestLap = 0
	c.state = nil
	c.lastSeen = time.Now()
	c.room = rm
	if rm.hostID == 0 {
		rm.hostID = c.id
	}
	rm.players = append(rm.players, c)
	sort.SliceStable(rm.players, func(i, j int) bool { return rm.players[i].id < rm.players[j].id })
	c.enqueue([]byte(`{"t":"hello","id":` + strconv.Itoa(slot) + `,"s":` +
		strconv.FormatInt(time.Now().UnixMilli(), 10) + `}`))
	return true
}

func (h *Hub) join(c *Client, code string) {
	if c.room != nil {
		return
	}
	code = strings.ToUpper(strings.TrimSpace(code))
	h.mu.Lock()
	rm := h.rooms[code]
	c.points = h.pointsOf(c.name)
	h.mu.Unlock()
	if rm == nil {
		c.enqueue([]byte(`{"t":"err","msg":"房间不存在，检查房间号"}`))
		return
	}
	rm.mu.Lock()
	if rm.started || rm.counting {
		rm.mu.Unlock()
		c.enqueue([]byte(`{"t":"err","msg":"该房间比赛进行中，稍后再试"}`))
		return
	}
	if !h.attachLocked(rm, c) {
		rm.mu.Unlock()
		return
	}
	rm.broadcastRoomLocked()
	// 规格 §一.2：进房事件推入聊天流（系统消息）。
	rm.broadcastSystemLocked("玩家 【" + c.name + "】 加入了房间")
	rm.mu.Unlock()
	h.broadcastPresence()
	log.Printf("[room %s] %s 加入（席位 %d）", code, c.name, c.id)
}

func (h *Hub) leave(c *Client, reason string) {
	rm := c.room
	if rm == nil {
		return
	}
	rm.mu.Lock()
	idx := rm.indexOf(c)
	if idx >= 0 {
		rm.players = append(rm.players[:idx], rm.players[idx+1:]...)
	}
	c.room = nil

	hostChanged := false
	if c.id == rm.hostID || rm.playerByIDLocked(rm.hostID) == nil {
		oldHost := rm.hostID
		rm.hostID = 0
		for _, p := range rm.players { // players 已按席位号排序，结果稳定
			if !p.ai {
				rm.hostID = p.id
				break
			}
		}
		hostChanged = oldHost != rm.hostID
	}
	if rm.hostID != 0 {
		for _, p := range rm.players {
			if p.ai {
				p.ownerID = rm.hostID
				if hostChanged {
					p.lastSeq = 0
				}
			}
		}
	}
	// 没有人类时停止并清掉虚拟席位，避免留下没有权威控制者的 bot-only 房间。
	if rm.humanCountLocked() == 0 {
		for _, p := range rm.players {
			if p.ai {
				p.room = nil
			}
		}
		rm.players = nil
		rm.hostID = 0
	}
	empty := rm.emptyLocked()
	if empty {
		// ★ 必须在持有 rm.mu 时置位：join 的 attachLocked 也持 rm.mu，
		//   由此封闭"empty 判定 -> hub.rooms 删除"窗口内的并发加入。
		rm.draining = true
	}
	if !empty {
		// 规格 §一.2：离线/离房事件推入聊天流（区分主动退出与心跳超时掉线）。
		if reason == "timeout" || reason == "disconnect" {
			rm.broadcastSystemLocked("玩家 【" + c.name + "】 已离线")
		} else {
			rm.broadcastSystemLocked("玩家 【" + c.name + "】 离开了房间")
		}
		if rm.started {
			msg := `{"t":"left","id":` + strconv.Itoa(c.id) + `,"name":` + strconv.Quote(c.name) +
				`,"reason":` + strconv.Quote(reason) + `}`
			rm.broadcastLocked([]byte(msg))
			if hostChanged {
				rm.broadcastRoomLocked()
			}
			// 剩下的全是完赛/掉线状态时直接结算
			allDone := true
			for _, p := range rm.players {
				if !p.finished {
					allDone = false
					break
				}
			}
			if allDone {
				rm.endRaceLocked("all-finished")
			}
		} else {
			rm.broadcastRoomLocked()
		}
	}
	rm.mu.Unlock()
	h.broadcastPresence()

	if empty {
		h.mu.Lock()
		if cur, ok := h.rooms[rm.id]; ok && cur == rm {
			delete(h.rooms, rm.id)
		}
		h.mu.Unlock()
		rm.shutdown()
		log.Printf("[room %s] 已空，回收", rm.id)
	}
}

// ---------------------------------------------------------------------------
// 入站消息处理
// ---------------------------------------------------------------------------

// progressJSON 只解客户端 60Hz 位姿包里排位需要的进度字段，
// 比整包反序列化便宜得多（12 人 x 60Hz = 720 次/秒的小结构体解析）。
type progressJSON struct {
	L int      `json:"l"` // 已完成圈数
	C int      `json:"c"` // 上一个通过的 Checkpoint 索引（0..maxCP-1）
	N float64  `json:"n"` // 到下一个 Checkpoint 的欧氏距离（米）
	S float64  `json:"s"` // 车速 km/h
	P *float64 `json:"p"` // 当前圈归一化样条进度 [0,1)
}

type inbound struct {
	T        string          `json:"t"`
	ID       *int            `json:"id"`
	Room     string          `json:"room"`
	Name     string          `json:"name"`
	Color    string          `json:"color"`
	Engine   string          `json:"engine"`
	Laps     int             `json:"laps"`
	Track    string          `json:"track"`
	GameMode string          `json:"gameMode"`
	Ghost    bool            `json:"ghost"`
	V        bool            `json:"v"`
	Seq      uint32          `json:"seq"`
	C        int64           `json:"c"`
	Sec      float64         `json:"sec"`
	Reason   string          `json:"reason"`
	N        int             `json:"n"`
	Time     float64         `json:"time"`
	Dirty    bool            `json:"dirty"`
	Net      *float64        `json:"net"`
	Pen      *float64        `json:"pen"`
	Total    *float64        `json:"total"`
	Content  string          `json:"content"` // Chat：聊天正文（1~80 字符，服务端清洗后广播）
	D        json.RawMessage `json:"d"`
}

// ---------------------------------------------------------------------------
// 聊天与系统事件（规格 §一）
//
//	上行：{"t":"CHAT_MESSAGE","content":"..."}                   玩家发言
//	下行：{"t":"CHAT_MESSAGE","type":"CHAT_MESSAGE","sender":"..","senderColor":"#rrggbb",
//	       "content":"..","isSystem":false,"timestamp":<UnixMilli>}
//
// 所有赛事流程事件（进房/准备/换赛道/倒计时/发车）也以 isSystem:true 的聊天消息
// 直接推入同一聊天流 —— 客户端只需消费一条通道即可同时渲染"玩家发言"与"系统公告"，
// 倒计时因此与消息流同层，天然不会被其它图层遮挡（根治旧版遮挡问题）。
// ---------------------------------------------------------------------------

const (
	chatMaxRunes = 80  // 规格：聊天正文上限 1~80 字符（按 Unicode 码点计，避免截断多字节）
	chatMaxBytes = 480 // 字节上限（80 个 4 字节 emoji 的极端情况），防止超长报文打爆广播
)

// sanitizeChat 清洗聊天正文：去除控制字符/空字符，折叠空白，按码点截断到 80 字符。
// 返回空串表示内容非法（纯空白/全是控制字符），调用方应直接丢弃。
//
// ⚠️ 本工程全程以 **textContent / JSON 字符串** 传递内容，前端渲染时用 textContent
// 而非 innerHTML，因此既不需要也无法做"转义"——这里只负责剔除不可见控制字符与
// 长度收敛，杜绝零宽字符/换行注入导致的排版破版与超长广播放大。
func sanitizeChat(s string) string {
	var b strings.Builder
	lastSpace := false
	for _, r := range s {
		// 丢弃 C0/C1 控制字符、DEL、以及 NUL 与各种零宽/格式化字符
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f) {
			continue
		}
		switch r {
		case 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x2060:
			continue // 零宽空格 / 零宽连字 / 方向标记 / BOM / word-joiner
		}
		// 折叠连续空白为单个空格（含 Tab / 换行 / 全角空格）
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == 0x3000 {
			if lastSpace || b.Len() == 0 {
				continue
			}
			lastSpace = true
			b.WriteByte(' ')
			continue
		}
		lastSpace = false
		b.WriteRune(r)
		if b.Len() >= chatMaxBytes {
			break
		}
	}
	out := strings.TrimSpace(b.String())
	// 按 Unicode 码点截断（b.Len() 是字节数，多字节字符需按 rune 重数）
	if utf8.RuneCountInString(out) > chatMaxRunes {
		rs := []rune(out)
		out = string(rs[:chatMaxRunes])
	}
	return out
}

// chatPayload 拼装一条聊天/系统消息的下行 JSON（零反射手写拼接，热路径友好）。
// isSystem=true 时 sender 固定为"系统"，前端据此切换高亮公告样式。
func chatPayload(sender, color, content string, isSystem bool) []byte {
	var sb strings.Builder
	sb.Grow(len(content) + 160)
	sb.WriteString(`{"t":"CHAT_MESSAGE","type":"CHAT_MESSAGE","sender":`)
	sb.WriteString(strconv.Quote(sender))
	sb.WriteString(`,"senderColor":`)
	sb.WriteString(strconv.Quote(sanitizeColor(color)))
	sb.WriteString(`,"content":`)
	sb.WriteString(strconv.Quote(content))
	sb.WriteString(`,"isSystem":`)
	sb.WriteString(boolStr(isSystem))
	sb.WriteString(`,"timestamp":`)
	sb.WriteString(strconv.FormatInt(time.Now().UnixMilli(), 10))
	sb.WriteString(`}`)
	return []byte(sb.String())
}

// systemMsg 是系统公告的便捷构造函数（sender="系统"，颜色用中性灰蓝）。
func systemMsg(content string) []byte {
	return chatPayload("系统", "#7fb2ff", content, true)
}

// trackDisplayName 把内部赛道 id 映射成玩家可读的中文名（与客户端下拉一致）。
func trackDisplayName(id string) string {
	switch id {
	case "spa":
		return "斯帕-弗朗科尔尚赛道"
	case "vegas":
		return "拉斯维加斯 · 街道夜赛"
	case "oval":
		return "新手 · 极简高速环道"
	default:
		return "铃鹿 · 8 字立体交叉"
	}
}

func gameModeDisplayName(id string) string {
	switch sanitizeGameMode(id) {
	case "horizon":
		return "地平线模式 · 轻松驾驶"
	case "bumper":
		return "碰碰车模式 · 全程实体对抗"
	default:
		return "FM8 模式 · 拟真规则"
	}
}

// bumperForcesGhostOff 报告某驾驶模式是否**不允许**开启全员幽灵车。
// 碰碰车模式的卖点就是"玩家全程实体、鼓励对抗"，与幽灵化互斥 ⇒ 该模式下
// 强制 ghost=false（建房与切换模式两处都要落），并拒绝房主再打开幽灵车。
func bumperForcesGhostOff(mode string) bool { return sanitizeGameMode(mode) == "bumper" }

// broadcastSystemLocked 以系统公告形式向房内全体推送一条聊天消息（调用方持 room.mu）。
func (r *Room) broadcastSystemLocked(content string) {
	r.broadcastLocked(systemMsg(content))
}

func (h *Hub) handleFrame(c *Client, raw []byte) {
	var m inbound
	if err := json.Unmarshal(raw, &m); err != nil {
		c.enqueue([]byte(`{"t":"err","msg":"消息格式错误"}`))
		return
	}
	if c.ai {
		return
	}
	c.mu.Lock()
	c.lastSeen = time.Now()
	c.mu.Unlock()
	if (m.T == "create" || m.T == "join") && c.room != nil {
		c.enqueue([]byte(`{"t":"err","msg":"已在房间内，请先离开当前房间"}`))
		return
	}

	switch m.T {
	case "create":
		c.name = sanitizeName(m.Name)
		c.color = sanitizeColor(m.Color)
		c.engine = sanitizeEngine(m.Engine)
		h.create(c, m.Laps, m.Track, m.Ghost, m.GameMode)

	case "join":
		c.name = sanitizeName(m.Name)
		c.color = sanitizeColor(m.Color)
		c.engine = sanitizeEngine(m.Engine)
		h.join(c, m.Room)

	case "rename":
		// 局内/大厅改昵称（规格 §一.2）：实时广播同步给房内所有人。
		// 改名后要重新对齐该玩家的历史总积分（新名字对应新积分桶），
		// 并重建赛季榜缓存（旧占位名可能因此上榜或下榜）。
		rm := c.room
		if rm == nil {
			// 不在房间内（首页/大厅）：立即更新自身昵称并广播 presence，
			// 让首页左侧在线面板实时刷新（用户报障"大厅玩家姓名不实时更新"）。
			// c.name 现在会被 presenceSnapshot 在 c.mu 内读取，写入必须同锁，
			// 否则 rename 与 presence 广播之间存在数据竞争。
			c.mu.Lock()
			c.name = sanitizeName(m.Name)
			c.mu.Unlock()
			h.broadcastPresence()
			return
		}
		newName := sanitizeName(m.Name)
		oldName := c.name
		rm.mu.Lock()
		if rm.started {
			// 比赛进行中禁止改名（会打乱成绩归属与赛季榜），静默忽略。
			rm.mu.Unlock()
			// 用 err 告知客户端，避免 UI 出现"改了但没生效"的错觉。
			c.enqueue([]byte(`{"t":"err","msg":"比赛进行中无法改名"}`))
			return
		}
		c.name = newName
		if c.hub != nil {
			c.hub.mu.Lock()
			c.points = c.hub.pointsOf(newName)
			c.hub.mu.Unlock()
		}
		rm.broadcastRoomLocked()
		// 规格 §一.2：改名事件推入聊天流（系统消息）。
		rm.broadcastSystemLocked("玩家 【" + oldName + "】 更名为 【" + newName + "】")
		rm.mu.Unlock()
		h.broadcastPresence()
		log.Printf("[room %s] 席位 %d 改名：%s -> %s", rm.id, c.id, oldName, newName)

	case "track":
		// 房主在大厅切换赛道（suzuka / vegas / spa）。比赛进行中禁止切换。
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		if !rm.started && !rm.counting && c.id == rm.hostID {
			nextTrack := sanitizeTrack(m.Track)
			if nextTrack != rm.trackType {
				rm.trackType = nextTrack
				// 规格：换图属于房间系统事件，必须与聊天/倒计时共用同一消息流，
				// 不能只弹一个聊天框下方的 toast 让玩家错过。
				rm.broadcastSystemLocked("赛道切换为【" + trackDisplayName(nextTrack) + "】")
			}
			rm.broadcastRoomLocked()
		}
		rm.mu.Unlock()

	case "laps":
		// 房主在房间内改圈数（用户报障："在房间内无法设置比赛圈数"）。
		// 与 case "track"/"ghost" 完全同一套守卫：未发车、未在整备倒计时中才能改。
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		if !rm.started && !rm.counting && c.id == rm.hostID {
			n := m.N
			if n < 1 {
				n = 1
			}
			if n > 8 {
				n = 8
			}
			if n != rm.laps {
				rm.laps = n
				rm.broadcastSystemLocked("比赛圈数改为【" + strconv.Itoa(n) + " 圈】")
				rm.broadcastRoomLocked()
			}
		}
		rm.mu.Unlock()

	case "gamemode":
		// 房主在大厅切换驾驶规则：比赛开始后保持锁定，避免同一场比赛出现两套物理参数。
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		if !rm.started && !rm.counting && c.id == rm.hostID {
			next := sanitizeGameMode(m.GameMode)
			if next != rm.gameMode {
				rm.gameMode = next
				// 碰碰车模式必须全程实体：切进来就关掉幽灵车（服务端权威，随 room 广播）。
				if bumperForcesGhostOff(next) && rm.ghost {
					rm.ghost = false
					rm.broadcastSystemLocked("碰碰车模式已关闭全员幽灵车（该模式要求全程实体对抗）")
				}
				rm.broadcastSystemLocked("驾驶规则切换为【" + gameModeDisplayName(next) + "】")
			}
			rm.broadcastRoomLocked()
		}
		rm.mu.Unlock()

	case "ghost":
		// 房主在大厅切换"全员幽灵车模式"（车与车不做刚体碰撞）。比赛进行中禁止切换。
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		if !rm.started && !rm.counting && c.id == rm.hostID {
			if m.Ghost && bumperForcesGhostOff(rm.gameMode) {
				// 碰碰车模式要求全程实体 ⇒ 拒绝打开幽灵车，并明确告知房主。
				rm.broadcastSystemLocked("碰碰车模式下无法开启幽灵车（全程实体对抗）")
			} else if rm.ghost != m.Ghost {
				rm.ghost = m.Ghost
				mode := "标准碰撞模式已开启"
				if rm.ghost {
					mode = "全员幽灵车模式已开启（车车可穿透）"
				}
				rm.broadcastSystemLocked(mode)
			}
			rm.broadcastRoomLocked()
		}
		rm.mu.Unlock()

	case "add_ai_bot":
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		if bot := rm.addAIBotLocked(c); bot != nil {
			rm.broadcastSystemLocked("AI 车手【" + bot.name + "】加入了房间")
			rm.broadcastRoomLocked()
		}
		rm.mu.Unlock()

	case "remove_bot":
		rm := c.room
		if rm == nil {
			return
		}
		id := 0
		if m.ID != nil {
			id = *m.ID
		} else {
			id = m.N
		}
		rm.mu.Lock()
		if rm.removeAIBotLocked(c, id) {
			rm.broadcastSystemLocked("AI 车手已离开房间")
			rm.broadcastRoomLocked()
		}
		rm.mu.Unlock()

	case "kick":
		// 房主只能在比赛尚未开始前踢出另一名真人；先发送确认，再移除并延迟断开，
		// 确保 writePump 有机会把 kicked 报文写入 socket。
		rm := c.room
		if rm == nil || m.ID == nil {
			return
		}
		rm.mu.Lock()
		kicked := false
		var kickedTarget *Client
		if !rm.started && !rm.counting && c.id == rm.hostID {
			target := rm.playerByIDLocked(*m.ID)
			if target != nil && !target.ai && target != c {
				target.enqueue([]byte(`{"t":"kicked"}`))
				idx := rm.indexOf(target)
				if idx >= 0 {
					rm.players = append(rm.players[:idx], rm.players[idx+1:]...)
				}
				target.room = nil
				rm.broadcastSystemLocked("玩家 【" + target.name + "】 被房主移出房间")
				rm.broadcastRoomLocked()
				kicked = true
				kickedTarget = target
			}
		}
		rm.mu.Unlock()
		if kicked {
			h.broadcastPresence()
			// 给 writePump 时间把 kicked 报文写进 socket，再断开连接。
			// 不断开的话，被踢客户端若不自行跳转，连接会永久留在 hub.clients
			// （心跳超时清理只遍历房间成员，覆盖不到房间外的连接）。
			time.AfterFunc(2*time.Second, kickedTarget.close)
		}

	case "ready":
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		if !rm.started {
			c.ready = m.V
			rm.broadcastRoomLocked()
			// 规格 §一.2：准备/取消准备事件推入聊天流（系统消息）。
			if c.ready {
				rm.broadcastSystemLocked("玩家 【" + c.name + "】 已准备就绪")
			} else {
				rm.broadcastSystemLocked("玩家 【" + c.name + "】 取消了准备")
			}
			if rm.allReadyLocked() {
				rm.beginCountdownLocked()
			}
		}
		rm.mu.Unlock()

	case "CHAT_MESSAGE":
		// 规格 §一.1：聊天上行。服务端做**权威清洗**（长度 1~80、去控制字符、
		// 折叠空白），然后向房间内全体广播扇出；发送者昵称/颜色一律以服务端
		// 记录的 c.name / c.color 为准，**绝不信任客户端自报身份**（防冒名）。
		rm := c.room
		if rm == nil {
			return
		}
		text := sanitizeChat(m.Content)
		if text == "" {
			return // 空白/纯控制字符：静默丢弃，不回执
		}
		rm.mu.Lock()
		// 发送者身份取服务端权威副本（c.name / c.color 已在入房时清洗过）。
		payload := chatPayload(c.name, c.color, text, false)
		rm.broadcastLocked(payload)
		rm.mu.Unlock()

	case "state":
		rm := c.room
		if rm == nil {
			return
		}
		d := m.D
		if len(d) == 0 || len(d) > 2048 || d[0] != '{' {
			return
		}
		rm.mu.Lock()
		target, allowed := rm.botTargetLocked(c, m.ID)
		if !allowed {
			rm.mu.Unlock()
			return
		}
		if rm.started {
			if m.Seq != 0 && m.Seq <= target.lastSeq { // 丢弃乱序及重复包
				rm.mu.Unlock()
				return
			}
			target.lastSeq = m.Seq
			target.state = d
			target.stateAt = monoMs()
			var pj progressJSON
			// 完赛车辆继续中继巡航位姿，已锁定的成绩不再参与进度更新。
			if !target.finished && json.Unmarshal(d, &pj) == nil {
				nowMs := float64(monoMs())
				target.advanceLapLocked(pj.L, rm.laps)
				// ★ 防"跨圈瞬间的旧 Checkpoint 索引污染新圈"。
				//   advanceLapLocked 刚刚把 cp 重置为 -1；但同一份状态包仍可能带着
				//   上一圈末尾的 C（例如 23）。若无条件执行 `pj.C > target.cp`，新圈的
				//   cp 会被直接写成 23，progressScore 瞬间多出 24×1000 = 24000 分 ⇒
				//   该车名次一下子跳到第 1（用户报障"局内左上角的名次有时会错乱"）。
				//   判据：cp 刚归 -1、已进入新圈、样条仍在圈首（< 0.25）、而 C 落在后半圈。
				staleRolloverCP := target.cp == -1 && target.lap > 0 &&
					pj.P != nil && *pj.P < 0.25 && pj.C > maxCP/2
				if !staleRolloverCP && pj.C >= 0 && pj.C < maxCP && pj.C > target.cp {
					for k := target.cp + 1; k <= pj.C; k++ {
						target.passTime[k] = nowMs
					}
					target.cp = pj.C
				}
				if pj.N >= 0 && pj.N <= 20000 {
					target.distNext = pj.N
				}
				if pj.S >= 0 && pj.S <= 600 {
					target.speedKmh = pj.S
				}
				if pj.P != nil && *pj.P >= 0 && *pj.P < 1 {
					// ★ 发车格在起终点线**之前**：车辆尚未起步时 trackIdx ≈ count-k，
					//   归一化样条 p 落在 0.98~0.99。若原样采信，服务端会把"还没起步的车"
					//   当成已跑完第 0 圈的 99% 来记录样条通过时刻（recordPassageLocked），
					//   起步后头几秒的秒差列会按一个并不存在的 0.99 截面解算。
					//   判据（与客户端 PhysicsWorkerBridge._publishNetwork 互为冗余）：
					//   第 0 圈 && 未通过任何 CP && 客户端自己也没报告压线 && p > 0.8
					//   ⇒ 语义钳为"第 0 圈尚未开始"，且不写入通过时刻表。
					if target.lap == 0 && target.cp < 0 && pj.C < 0 && *pj.P > 0.8 {
						target.spline = 0
					} else {
						target.spline = *pj.P
						target.recordPassageLocked(nowMs)
					}
				}
				target.score = progressScore(target.lap, target.cp, target.distNext)
			}
		}
		rm.mu.Unlock()

	case "pen":
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		// 与 state/lap/finish 同一套权威：无 id 记到发送者头上；
		// 带 id 且发送者是房主时记到其人机席位上（AI 罚时链路）。
		target, allowed := rm.botTargetLocked(c, m.ID)
		if !allowed {
			rm.mu.Unlock()
			return
		}
		if rm.started && !target.finished && time.Since(target.lastPen) > 150*time.Millisecond {
			sec := m.Sec
			if sec <= 0 || sec > 4 {
				sec = 0.5
			}
			target.lastPen = time.Now()
			target.penalty += sec
			// FRR 裁决类罚时（获利 / 抄近道 / 脱困复位 / 切弯）计入**违规次数**，
			// 计时塔"处罚"列要显示成 "+2.70 1" 这种"罚时 + 违规次数"。
			// 注意 sec 被夹到 ≤4s：FRR 阶梯罚上限 3.0s 正好落在允许区间内。
			if isFRRRuling(m.Reason) {
				target.violations++
			}
			msg := `{"t":"pen","id":` + strconv.Itoa(target.id) +
				`,"sec":` + strconv.FormatFloat(target.penalty, 'f', 3, 64) +
				`,"delta":` + strconv.FormatFloat(sec, 'f', 3, 64) +
				`,"reason":` + strconv.Quote(m.Reason) + `}`
			rm.broadcastLocked([]byte(msg))
		}
		rm.mu.Unlock()

	case "lap":
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		target, allowed := rm.botTargetLocked(c, m.ID)
		if !allowed {
			rm.mu.Unlock()
			return
		}
		if rm.started && !target.finished && m.N >= 1 && m.N <= rm.laps {
			target.advanceLapLocked(m.N, rm.laps)
			if !m.Dirty && m.Time > 0 && (target.bestLap == 0 || m.Time < target.bestLap) {
				target.bestLap = m.Time
			}
			if target.bestLap > 0 && (rm.bestLap == 0 || target.bestLap < rm.bestLap) {
				rm.bestLap = target.bestLap
				rm.lapMs = target.bestLap * 1000
			}
			msg := `{"t":"lap","id":` + strconv.Itoa(target.id) +
				`,"n":` + strconv.Itoa(m.N) +
				`,"time":` + strconv.FormatFloat(m.Time, 'f', 3, 64) +
				`,"best":` + strconv.FormatFloat(target.bestLap, 'f', 3, 64) +
				`,"roomBest":` + strconv.FormatFloat(rm.bestLap, 'f', 3, 64) +
				`,"dirty":` + boolStr(m.Dirty) + `}`
			rm.broadcastLocked([]byte(msg))
		}
		rm.mu.Unlock()

	case "finish", "fin":
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		target, allowed := rm.botTargetLocked(c, m.ID)
		if !allowed {
			rm.mu.Unlock()
			return
		}
		if rm.started && rm.racing && !target.locked && target.lap >= rm.laps && !time.Now().Before(rm.startAt) {
			// 人类成绩以服务端时钟为准；人机成绩由当前房主的 sim 驱动器上报。
			net := time.Since(rm.startAt).Seconds()
			penalty := target.penalty
			total := net + penalty
			if target.ai {
				if m.Net != nil && *m.Net >= 0 && !math.IsNaN(*m.Net) && !math.IsInf(*m.Net, 0) {
					net = *m.Net
				}
				if m.Pen != nil && *m.Pen >= 0 && !math.IsNaN(*m.Pen) && !math.IsInf(*m.Pen, 0) {
					penalty = *m.Pen
				}
				total = net + penalty
				if m.Total != nil && *m.Total >= 0 && !math.IsNaN(*m.Total) && !math.IsInf(*m.Total, 0) {
					total = *m.Total
				}
			}
			if math.IsNaN(total) || math.IsInf(total, 0) || total < 0 {
				rm.mu.Unlock()
				return
			}
			target.netTime = net
			target.penalty = penalty
			target.total = total
			target.finished = true
			target.locked = true
			rank := 0
			for _, p := range rm.players {
				if p.locked {
					rank++
				}
			}
			target.rank = rank
			msg := `{"t":"fin","id":` + strconv.Itoa(target.id) +
				`,"net":` + strconv.FormatFloat(target.netTime, 'f', 3, 64) +
				`,"pen":` + strconv.FormatFloat(target.penalty, 'f', 3, 64) +
				`,"total":` + strconv.FormatFloat(target.total, 'f', 3, 64) +
				`,"rank":` + strconv.Itoa(rank) + `}`
			rm.broadcastLocked([]byte(msg))
			allDone := true
			for _, p := range rm.players {
				if !p.finished {
					allDone = false
					break
				}
			}
			if allDone {
				rm.endRaceLocked("all-finished")
			} else if rm.dnfDeadline.IsZero() {
				rm.dnfDeadline = time.Now().Add(dnfGraceSec * time.Second)
				rm.notifyDnfLocked(dnfGraceSec)
			}
		}
		rm.mu.Unlock()

	case "spong":
		// 延迟探测回包（见 Client.rttMs 的说明）。只认最近一次 sping 的 nonce，
		// 过期/伪造的 nonce 一律忽略 —— 玩家无法用回放旧 nonce 美化自己的延迟。
		//
		// ⚠️ 旧实现开头就是 `rm := c.room; if rm == nil { return }`，把**大厅（未入房）**
		//    玩家的回包直接丢掉 ⇒ rttMs 永远是 -1 ⇒ 首页在线面板的延迟列恒为空
		//    （用户报障"大厅玩家延迟不会实时更新"）。现在大厅与房间共用同一条回填路径。
		// 锁序：只在 pingMu 内改状态，**解锁后**才取 rm.mu（与 lobbyPingLoop / room ticker
		// 的 rm.mu → pingMu 顺序一致，不会形成环）。
		c.pingMu.Lock()
		if c.pingSent.IsZero() || m.C != c.pingNonce {
			c.pingMu.Unlock()
			return
		}
		rtt := int(time.Since(c.pingSent).Milliseconds())
		if rtt < 0 {
			rtt = 0
		}
		prev := c.rttMs
		// 指数平滑：单次抖动不至于让徽标来回跳。
		if c.rttMs < 0 {
			c.rttMs = rtt
		} else {
			c.rttMs = (c.rttMs*3 + rtt) / 4
		}
		c.pingLoss = 0
		c.pingSent = time.Time{}
		cur := c.rttMs
		c.pingMu.Unlock()
		// 只在"首次测得"或"变化达到阈值"时才重发报文：否则每 2 秒对全房间 + 全大厅
		// 做一次无差别的全量 JSON 重发（12 人房间里就是 6 次/秒的纯冗余流量）。
		delta := cur - prev
		if delta < 0 {
			delta = -delta
		}
		if prev >= 0 && delta < pingReportDeltaMs {
			return
		}
		if rm := c.room; rm != nil {
			rm.mu.Lock()
			rm.broadcastRoomLocked()
			rm.mu.Unlock()
		}
		h.broadcastPresence()

	case "ping":
		// NTP 应答（规格）：t2 = 服务端收到时刻，t3 = 服务端应答时刻（毫秒）。
		// 客户端据此计算 RTT = (t4 - t1) - (t3 - t2)，Offset = ((t2 - t1) + (t3 - t4)) * 0.5。
		// s / m 是旧字段（分别给时钟偏移与单调时钟用），保留以兼容现有断言与客户端。
		t2 := time.Now().UnixMilli()
		t3 := t2
		c.enqueue([]byte(`{"t":"pong","c":` + strconv.FormatInt(m.C, 10) +
			`,"s":` + strconv.FormatInt(t2, 10) +
			`,"m":` + strconv.FormatInt(monoMs(), 10) +
			`,"t2":` + strconv.FormatInt(t2, 10) +
			`,"t3":` + strconv.FormatInt(t3, 10) + `}`))

	case "restart":
		rm := c.room
		if rm == nil {
			return
		}
		rm.mu.Lock()
		if c.ai || c.id != rm.hostID || !rm.finished {
			rm.mu.Unlock()
			return
		}
		rm.backToLobbyLocked()
		rm.mu.Unlock()

	case "leave":
		h.leave(c, "quit")

	default:
		c.enqueue([]byte(`{"t":"err","msg":"未知指令"}`))
	}
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

func noCacheFS(sub fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasSuffix(p, ".html") || p == "/" {
			w.Header().Set("Cache-Control", "no-store")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=600")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func main() {
	flag.Parse()
	log.SetFlags(log.Ltime)

	sub, err := fs.Sub(embedded, "public")
	if err != nil {
		log.Fatalf("内嵌资源解包失败: %v", err)
	}

	// 默认 8099 而非 8080：8080 常被 Steam 的 steamwebhelper（CEF 调试端口）
	// 占在 127.0.0.1 上，而本服务端绑 0.0.0.0，Windows 下 127.0.0.1 优先级更高，
	// 会导致本机 localhost 被截胡（现象：/ 返回 200 但静态资源 404）。
	port := defaultPort
	if v := os.Getenv("PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			port = n
		}
	}
	addr := *listenAddr
	if addr == "" {
		addr = fmt.Sprintf(":%d", port)
	}

	hub := newHub()

	mux := http.NewServeMux()
	mux.Handle("/ws", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrade(w, r)
		if err != nil {
			http.Error(w, "websocket upgrade failed: "+err.Error(), http.StatusBadRequest)
			return
		}
		c := &Client{
			ws:       ws,
			hub:      hub,
			send:     make(chan []byte, sendBufSize),
			snaps:    make(chan []byte, sendBufSize),
			done:     make(chan struct{}),
			lastSeen: time.Now(),
			name:     "车手",
			color:    "#e10600",
			// -1 = 延迟尚未测得（客户端据此不显示 ms 徽标，而不是显示假的 0 ms）
			rttMs: -1,
		}
		hub.addClient(c)
		go c.writePump()
		log.Printf("[ws] %s 连接建立", r.RemoteAddr)
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[ws] 处理panic: %v", rec)
			}
			hub.leave(c, "disconnect")
			hub.removeClient(c)
			c.close()
			log.Printf("[ws] %s 断开", r.RemoteAddr)
		}()
		for {
			op, data, err := ws.readMessage()
			if err != nil {
				return
			}
			if op != 0x1 {
				continue
			}
			hub.handleFrame(c, data)
		}
	}))

	mux.Handle("/api/online", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		rooms, clients := hub.registrySnapshot()
		inRoom := make(map[*Client]bool, len(clients))
		racing, lobby := 0, 0
		for _, rm := range rooms {
			rm.mu.Lock()
			for _, p := range rm.players {
				if p.ai {
					continue
				}
				inRoom[p] = true
				if rm.started {
					racing++
				}
			}
			rm.mu.Unlock()
		}
		for _, c := range clients {
			if !c.ai && !inRoom[c] {
				lobby++
			}
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, `{"racing":%d,"lobby":%d}`, racing, lobby)
	}))
	mux.Handle("/api/info", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		roomList, _ := hub.registrySnapshot()
		rooms := make([]string, 0, len(roomList))
		for _, v := range roomList {
			v.mu.Lock()
			// ★ 只统计**真人**：人机不算在线玩家（用户报障"人机不要记为在线玩家"）。
			rooms = append(rooms, fmt.Sprintf("%s(%d/%d)", v.id, v.humanCountLocked(), maxPlayers))
			v.mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		fmt.Fprintf(w, `{"ok":true,"rooms":%s,"laps":%d,"tick":%d}`,
			toJSONStrings(rooms), *lapsFlag, tickHz)
	}))
	mux.Handle("/healthz", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	// 赛季积分排行榜（规格 §一.1）：首页在**未加入任何房间**时也能拉取展示。
	// 返回形式 {"t":"season","data":[{"name":..,"pts":..}, ...]}，前 10 名。
	mux.Handle("/api/season", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, `{"t":"season","data":%s}`, hub.seasonSnapshot())
	}))
	// 离线单机成绩结算：浏览器端赛后把本地玩家与 AI 的最终名次提交到同一
	// scores.json，再向所有首页/大厅客户端广播赛季榜。这样离线胜利不再只更新
	// 本地 UI，也不会把所有人的积分错误地记到固定名称上。
	mux.Handle("/api/offline-result", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodPost {
			http.Error(w, `{"ok":false,"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Results []struct {
				Name string `json:"name"`
				Rank int    `json:"rank"`
			} `json:"results"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
			http.Error(w, `{"ok":false,"error":"invalid json"}`, http.StatusBadRequest)
			return
		}

		hub.mu.Lock()
		for i, e := range req.Results {
			if i >= maxPlayers || e.Rank < 1 || e.Rank > maxPlayers {
				continue
			}
			name := sanitizeName(e.Name)
			if name == "" {
				continue
			}
			hub.addPoints(name, pointTable[e.Rank])
		}
		hub.savePoints()
		hub.rebuildSeasonLocked()
		rankings := hub.seasonSnapshot()
		hub.mu.Unlock()

		payload := []byte(`{"t":"SEASON_LEADERBOARD_UPDATE","rankings":` + rankings + `}`)
		hub.broadcastAll(payload)
		fmt.Fprintf(w, `{"ok":true,"rankings":%s}`, rankings)
	}))
	mux.Handle("/", noCacheFS(sub))

	ips := lanIPv4()
	displayPort := port
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		if n, err := strconv.Atoi(addr[i+1:]); err == nil && n > 0 {
			displayPort = n
		}
	}
	fmt.Println()
	fmt.Println("  ┌───────────────────────────────────────────────────────────┐")
	fmt.Println("  │   极限竞速 · LAN   多人局域网 3D 网页赛车（全离线单文件）  │")
	fmt.Println("  └───────────────────────────────────────────────────────────┘")
	fmt.Println()
	fmt.Printf("   本机访问      http://localhost:%d\n", displayPort)
	for _, ip := range ips {
		fmt.Printf("   局域网访问    http://%s:%d\n", ip, displayPort)
	}
	if len(ips) == 0 {
		fmt.Println("   未探测到局域网 IPv4，请检查网卡状态")
	}
	fmt.Println()
	fmt.Println("   同一 Wi-Fi / 交换机下，让其他玩家在浏览器打开上面的局域网地址即可（最多 12 人同房）。")
	fmt.Println("   所有前端资源（three.js / cannon-es / 脚本）均已打包进本可执行文件，无需外网。")
	fmt.Println()

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	if *quiet {
		log.SetOutput(io.Discard)
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func toJSONStrings(in []string) string {
	if len(in) == 0 {
		return "[]"
	}
	b, _ := json.Marshal(in)
	return string(b)
}
