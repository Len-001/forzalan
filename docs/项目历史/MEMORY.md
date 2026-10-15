# 项目长期记忆 · 极限竞速 · LAN

> 只放**高频红线**；细节/数值/命令/症状展开 → `REFERENCE.md`（不参与注入）；过程 → `YYYY-MM-DD.md`。
> ⚠️ 铁律：本文件**曾在 34KB / 352 行时于注入环节被截断**（2026-10-14），
> 现为 14.3KB / 8.9k 字符 —— **已无明显余量**。新增内容**默认写 `REFERENCE.md`**，
> 只有"不记住就会静默失败"的红线才进本文件。

## 定位与硬约束
多人（≤12）局域网 3D 网页赛车，对标 FM8。交付 = **单个 Go exe**（`//go:embed all:public`），运行期零外部请求。
1. 前端**零外链字面量**（`tools/e2e.mjs` 扫描）。CSP `default-src 'none'` + `script-src 'self' 'wasm-unsafe-eval'`
   （无 `'unsafe-inline'`）—— **改 CSP 必重跑 e2e**。
2. 字体只用系统族；`go.mod` 零第三方依赖（WebSocket 手写）。
3. 赛道不做 Trimesh 碰撞（cannon-es 无 `convexTrimesh`），路面走 `track.sample()`。
4. **赛道类型一路透传**：`sanitizeTrack`/START `track` → `beginRace(opts.track)` → `buildWorld(seed,type)` → `new Track(seed,type)`。
5. **服务端算完的客户端必须真消费**（已栽 5 次）：权威字段必须有静态守卫钉 `下发 → network.js 分发 → main.js 消费`。
6. **测试常量与赛道参数解耦**（禁写死全长/单圈/spacing/CP 数）。
7. **容量两端同步**：`maxPlayers`(main.go) == `GRID_SLOTS`(track.js)。
8. **积分表** `pointTable=[maxPlayers+1]int64`，P1..P4 = **10/6/4/2**，其余 0。

## ★★ 锁纪律（P0，已栽一次）
- **`sync.Mutex` 不可重入**：曾持锁进灯序循环、循环内再 `Lock()` ⇒ **首拍自锁死**。
  症状：**START 已下发、count 正常，但 START 后 0 帧**（snap/lights/榜单全停），仅 ping/pong 通。
- **红线**："循环内自行取锁"的代码块，进循环前**必须**已释放外层同名锁。
- **锁序**：`hub.mu`（`registrySnapshot` 内，返回即释放）→ 逐房间 `rm.mu` → `c.mu`/`c.pingMu`；
  取 `pingMu` 后**先解锁**再取 `rm.mu`。**绝不 hub.mu 与 room 锁嵌套**。
- 诊断：`runtime.Stack(buf,true)` dump 全 goroutine 栈；多个卡 `Lock` 且无人持锁运行 ⇒ 持锁者自卡死。

## 时间轴：墙钟 vs 单调（**两条轴不可互代**）
- 墙钟 `UnixMilli`：`start.at`、快照 `ts`、`hello.s`、`pong.c/t2/t3`。
- 单调：`monoMs()`、快照 `mts`、`pong.m`、Worker `performance.now()`（经 ready 握手换算）。
- ⚠️ `monoMs()` 写进 `at` ⇒ `raceClock` 变 −1.7e12 秒（selftest 3 断言）。
- ⚠️ **倒计时期间 `raceClock` 恒约 −2.6s** ⇒ 用 `raceClock<0` 当"没开始"会**永久锁**；
  **起步判据唯一来源 `S.rp.racing`**（已栽：`sampleLocalInput` 用它清零油门 ⇒ GO 后车不动）。
- ⚠️ 时钟轴告警判据是**量级**（`< -CLOCK_AXIS_BREAK_S` = −30s），不是 `< 0`。

## 秒差符号（全工程唯一一套）
- **`>0` = 前者领先**。反对称 `Solve(a,b)==-Solve(b,a)`。三处同套：服务端 `solveDeltaMs`、
  C++ `RaceDeltaTracker::Solve`、离线 `gLead/gAhead/gBehind`。
- `LEADERBOARD_UPDATE` 的 `gap`/`int`/`behind` 带符号，正=领先；格式化唯一入口 `renderGap(...)`。
  ⚠️ **HUD 时差列 = 相对【本地玩家】**：本地=P1 → `--`；本地≠P1 → `fmtDelta(-delta)` 必负。
- **必须上报 `c`(cpIdx)/`n`(distNext)**（`S.rp.track` 由 main.js 注入），缺了永远走起步兜底。
- **起步兜底"比分大者在前"(`>`)**；⚠️ 写 `<` ⇒ cp=−1 时角色**倒置**。外推除数取**前车**车速。
- 排序键统一 `progressScore(lap,cp,distNext)`。

## 坐标 / 单位 / 法线
- 右手系 `right=forward×up`；车头 +Z、车顶 +Y ⇒ **局部 +X 是车身左侧**。全 SI。
- `input.steer>0`=向右；`steerAngle>0`=前轮指左 ⇒ `steerAngle = -steerInput*maxSteer` 负号**必需**。
- SVG 极坐标(0°=+X) 与 CSS rotate(0°=12点) 差 90°：`polar = -90 + css`。
- **接触法线 `n` 从 A 指向 B**：`v_n=(v_A−v_B)·n >0` = **接近**（须解算）；`<0` 分离（跳过）。
  ⚠️ 写成 `if(vn>0) skip` ⇒ 车原速穿墙且无报错。
- **速度相与位置同号**：`v_A -= J·invMassA` 配 `p_A -= n·dx·wA`。
  ⚠️ 位置相写 `p_A += n·dx` ⇒ 修穿透反把车推进墙。
- **单测必须断言可观测量**（"间距变大"/"朝远离墙移动"）；只断言"位移非零"方向反了照样过。

## ★★★ 帧率红线（出厂版 7.5fps 事故）—— 四条必须同时成立
1. **宽相只能静态桶/网格**（static-bucket-XZ、格 32m；`__workerConfig` 可自证）。
   `NaiveBroadphase` + 2963 静态护栏 = O(n²) ⇒ **p50 133ms / 7.5fps**；SAP 更差，别换。
2. **网格维度只能走构造参数**：构造后改 `bp.nx/ny/nz` 只改索引算术、**不扩容 bins**
   ⇒ 异常从 `world.step` 冒出、**整帧中断、绿灯亮着车一动不动**。
3. **`installMakePairsUniqueFix()` 必须装**（否则 `undefined` 进 `pairs1` ⇒ 窄相 TypeError/死循环；
   旧宽相不调用它 ⇒ 换宽相才引爆）。
4. **`installSparseCollisionMatrix()` 必须装**（平方预分配 + 每子步清两次 ⇒ "起步还行、
   **某一刻起持续 110ms/帧**"）。→ 实测数字见 REFERENCE「帧率红线」。

## 强度量纲 / 跨圈坐标（"刚起步跳几百秒"）
- **离线 `progressScore(c)` 单位必须是米**：`lap*track.length + trackIdx*track.spacing`（采样**等弧长**）；
  秒差 = `米差 ÷ 参考车速(≥12m/s)`。`cpIdx`/`100000` 加权已**结构性移除**，**不许**回落。
- 服务端 `progressScore` 是 **ordinal 积分**（int64），折算里程只经 `nominalCpMeters`。**两套口径不混用**。
- ★★ **跨圈项必须是 `c.lineCross`（几何压线次数），不能是 `c.lap`**（过线瞬间坐标后退整圈 ≈ 几百秒、排位倒置）；
  `lineCross` 在 `groundConstraint` 按索引回绕计数（前向 +1 / 倒车 −1，下限 0）。

## ★ 名次 / 进度三条守卫
- **起步同分按 `gridSlot` 决胜**（`leaderboardLocked` 第三键），无发车格才退回 `id`。
- **跨圈旧 CP 污染**：归 cp=−1 后同包仍带上一圈 `C`（`P<0.25 && C>maxCP/2`）⇒ 判 `staleRolloverCP` 跳过。
- **发车格在起终点线之前**：`lap==0 && cp<0 && pj.C<0 && p>0.8` ⇒ 样条钳 0 且**不写通过时刻表**。
  守门 `progress_regression_test.go`（6 条，反证已验）。

## ★ 赛道 / OSM / 铃鹿
- **白名单五处必须一致**：`track.js: TRACK_TYPES`、`main.go: sanitizeTrack`、`main.go: trackDisplayName`、
  `index.html #track`、`main.js: TRACK_NAME`+`btnTrack`。当前 = `suzuka / vegas / spa / oval`。
- `oval` 是合成图（1930.97m、`smooth:0`、`barrierLat:14.0`、`cp:24`）。★ `buildCongestionZones` 的 14% 分位
  判据**只对连续半径谱成立**，oval 会**整条弯被判非拥挤区** ⇒ 新增 `congestionRadiusM`(oval=200)，
  优先序 **调用方 opts > 赛道定义 > 分位判据**。
- ★ **OSM 一律用 `openstreetmap.org/api/0.6/relation/{id}/full`**，**绝不要 `map?bbox=...`**
  （城区 400；同一 relation 8465m vs 6971m，曾误判"OSM 长 21%"）。导入器**必须排除 `role=pit_lane`**。
- ★ **铃鹿走线是 OSM 实测（relation 284570），不许改回 seed 生成**。指纹：5797m、自交**恰好 1 处**、
  最小弯半径 13.8m。铃鹿**宽度/护栏逐点**（标量 `halfWidth` 取最窄、`barrierLat` 标量是 0 ⇒ **读标量摆错车**）。
  立交桥面**不能固定 +7.5m**，须 `max(base 本层, base 被跨层+净空+余量)`。
- ⚠️ 加/换赛道必重跑：`track-verify`、`verify_sec3`（断言数会变）、`TRACKS=oval SEEDS=4 track-geometry-audit`、
  `terrain-multi-check`。

## 计圈 / 结算 / 起跑（高频陷阱）
- **计圈判据 `cpNow === 0`**（⚠️ 写成 `!== 0` ⇒ "起步就被罚 2 秒" + 第一整圈被当"上膛"丢掉）；
  `crossedStart` 按发车位置初始化；复位瞬移 ⇒ `_syncCpAfterRescue` 须同步 `cpIdx/progress/crossedStart`，
  且**不许重置本圈计时**。冲线即 `retired = false`。
- **结算字段两套**（联机 `bestLap`/`totalTime`，单机 `best`/`total`）⇒ `showSettlement` **两种都认**；
  `_offlineSettled` 分支只调 `refreshLocalResults()`，**不要**重复 `submitOfflineResults`。
- **节拍三处一致**：`startLightTickMs`(go) == `LIGHT_TICK_MS`(js)；`LOCAL_GO_MS = 250 + 5*LIGHT_TICK_MS`；
  `GO_FALLBACK_MS` **必须 > LOCAL_GO_MS**（selftest 守卫）。
- ⚠️ **`net.on('room')` 绝不能让进行中的比赛回大厅**（⇒ `racing=false` ⇒ 油门清零 ⇒ **绿灯亮着车不动**）。
- ⚠️ `armLocalStartLights` 用 `S._lightLedTimers` 前**必须先初始化**（否则 `ids.push` 抛 TypeError ⇒ **灯序卡 R5**）；
  整备倒计时 goroutine **每拍须重新取锁复查**。
- 细节（8.75s 两阶段、`forceRaceGo`、sping/spong 大厅覆盖、聊天/昵称/圈数）→ REFERENCE「起跑 / 状态机」。

## 物理 / 碰撞（高频陷阱）
- **抓地不能单一 mu**；**`yawGrip` 只看前轴 μ**（加权平均 ⇒ 手刹推头）。
- **悬挂是弹簧-阻尼非位置钳位**；**严禁 `body.position.y=groundY` 贴地**；**不能每步抬车壳却保留下落速度**。
- **出界纯物理**：侧向抓地下限必须**倍数形式**（⚠️ 绝对值常量会旁路成死代码）；
  横向摩擦兜底必须 `max(min(...), latFloorMu·g)`（只写 `min()` ⇒ 草地无限平移）。
- **★ 非物理弹跳主因 = cannon Baumgarte 穿透偏置** ⇒ 必须装 `installCannonBaumgarteKill`
  （`BARRIER_RESTITUTION=0` 杀不掉；200km/h 反弹 −99.4%）。守卫 `tools/verify_baumgarte.mjs`。
- **反冲限幅 `clampCollisionImpulse(cars)`**：**只在 `_stepTouched` 时动手**，**严禁无条件 `vy=0`**。
- **静态赛道刚体必须在 `RacePhysics` 构造里注册**（只在 `track.js generateTrack()` 调过 ⇒ 护栏/桥栏/桥墩
  **全是视觉装饰**）。
- **R 键救援**：优先最后合法驶出锚点上方 0.3m；**只标脏圈、不重置圈速**；**严禁 `collisionResponse=false`**。
- 参数全量 → REFERENCE「物理参数全集」「碰撞参数」「物理/碰撞要点（细节）」。
- ⚠️ 2026-10-14 第三轮落地（`surfaceGripMul` 无消费方 / `Room.stepServerBotsLocked` 只推进名次不产生位姿 /
  **`c.roadSide` 首拍可能 undefined ⇒ 必须判空，否则 verify_sec3 崩**）→ REFERENCE「第三轮落地细节」。

## 人机 / 积分 / 身份（不可逆风险）
- 人机名形态 **`AI · <名字>`**（U+00B7）。
- **两个谓词必须分开**：`isDefaultName`（宽，决定能否上榜）vs **`isBotName`（窄，决定能否删磁盘数据）**。
  ⚠️ 用宽谓词删数据会把 `车手B` 这类真玩家沿用的默认名连积分一起**不可逆删掉**。
- **`loadPoints()` 读盘绝不许落盘**（零副作用）；清理只在 `savePoints()` 出口做。
  ⚠️ 曾在 loadPoints 里 `savePoints()` ⇒ 单元测试会重写仓库真实 `scores.json`。
- 人数口径 `humanCountLocked()`。守门 `ai_identity_regression_test.go`（6 条，含反证）。
- **身份归属**：报文 `id` 只用于"房主代报自己名下的人机"；`botTargetLocked` 落空/指向别的真人时
  **退化为记到 actor 自己头上**（旧的"return false"会让该玩家全部 state/lap/fin 被静默丢弃）。
- 罚时 UI / 驾驶三态与碰碰车 / 幽灵掩码（`_refreshMasks` 是**唯一掩码来源**）→ REFERENCE 对应小节。

## native/ 模块红线
`timesync`（时钟源单调、校正绝不硬跳）/ `rb_replicator`（衰减 **ln2 不能漏**；强制短弧三处都要）/
`race_delta`（`v_seg` 取**前车弧长速度**，严禁"欧氏距离÷实时速度"）/ `safe_physics`（摩擦符号陷阱、
空过陷阱、0.03m/子步是算术）/ `safe_collision`（**【已废弃】**）/ `harness`·`mp_chaos`。
→ REFERENCE「各模块陷阱细节」及各模块「参数与基线」。

## Go 工具链 / 构建核验 / 环境硬约束
- **Go 1.27.1**：`export PATH="/c/Users/Administrator/.workbuddy/binaries/go/go/bin:$PATH"`；
  `GOCACHE=$(pwd)/.gocache GOTMPDIR=$(pwd)/.gotmp`；`go build -trimpath -ldflags "-s -w" -o forzalan.exe .`。
- ⚠️ **Windows 大小写不敏感** ⇒ `ForzaLAN.exe` 与 `forzalan.exe` 同一文件（别 .bak）。
- ⚠️ **★ exe 时间戳旧 ≠ 只是日志假红**：旧 exe 内嵌中间快照缺功能，**e2e 全绿也没发现**。
  判据 `find public main.go -newer forzalan.exe -type f`（有输出 = 必须重编）。
- ⚠️ **改完不重编 = 白改**：重编后必跑 `node tools/embedded-assets-check.mjs`。反向：只改 `tools/`/`docs/`
  不需重编；但 `cp` 恢复源文件会刷新 mtime ⇒ 需重编。
- **端口**：别用 8080（本机 Steam CEF 占用）；默认 **8099**；优先级 `-addr` > `PORT` > 8099。
- **node 无法派生 node 子进程**（EBUSY）；JS 语法用 `node --check`（复制成 `.mjs`）；spawn Go 二进制没问题。
- **后台进程活不过一次 Bash 调用**：起服务 + 跑 curl/浏览器必须在**同一次调用里**。
- **bash 的 `/tmp` ≠ Node 的 `/tmp`**；统一用项目内相对路径。
- 绝不用 PowerShell 做 UTF-8 往返（GBK 乱码）；**同一文件别并发发多个 Edit**（会静默互相覆盖）。

## 基线（2026-10-14）与交付前必跑
- selftest **715/715**、e2e **128/128**、track-verify **122/4**（= Spa 最紧弯索引 / Spa CP 数 28 /
  Vegas 1.8km 直道 / Vegas 护栏厚度）、verify_sec3 **47/0**、penalty **24**、chat-ui **33/33**、
  embedded-assets **22/22**、room-ping **8/8**；⚠️ `terrain-probe` **12 项红**（铃鹿，未修）。
  **不能称门禁全绿，也不能称真实赛道逐米 1:1。**
- 必跑顺序与门禁工具陷阱 → **REFERENCE「交付前必跑」+「门禁工具的已知陷阱」**。

## 待决（勿擅自做）
- **Wasm 未接进主循环**：`public/js/` 0 处引用；实跑 `network.js` 纯 JS。
- **`terrain-probe` 12 项红**：需决定改实现还是改工具口径。
- **门禁端口**：本机可能**正开着实时会话**（8099 有 LAN 的 ESTABLISHED 连接，**绝不能 kill**）⇒
  服务端 `bind: Only one usage of each socket address` 而**不报错退出**。新门禁一律支持端口覆盖。
- **文件清理**：`.workbuddy/` **禁止删除**；其余（`.gocache`/`.gotmp`/`forzalan_test.exe`/`ai-race.json`/
  `points.json`/`*.log`/`*-report.json`）**只列未删**，等确认。
