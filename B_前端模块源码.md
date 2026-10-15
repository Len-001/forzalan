# 极限竞速8 — 前端模块源码合集（不含三大文件）

> 「极限竞速8」精简源码包自动生成 · 2026-10-15 08:56:46 (UTC+8)
> 分隔格式：`### 文件: <路径>` + 对应语言围栏，可直接被 AI 解析。

> 本包为 **v3**（数据来源 `极限竞速8 (3).zip`）。三大核心文件 `main.js` / `physics.js` / `track.js` 均单列成册——
> v2 时 `physics.js` 未改动，**本轮它首次进入变更列表（+5.7 KB）**，正说明必须始终纳入。

## 本合集包含

- **页面骨架**
  - `public/index.html` — 384 行 / 29.3 KB
- **联机 / 协议 / Worker 桥接**
  - `public/js/network.js` — 601 行 / 26.7 KB
  - `public/js/physics-protocol.js` — 145 行 / 7.3 KB
  - `public/js/PhysicsWorkerBridge.js` — 405 行 / 23.3 KB
  - `public/js/RemoteSnapshotBuffer.js` — 99 行 / 4.4 KB
  - `public/js/physics.worker.js` — 473 行 / 26.1 KB
- **相机 / UI / 音效**
  - `public/js/ForzaChaseCamera.js` — 501 行 / 19.6 KB
  - `public/js/PenaltyController.js` — 215 行 / 9.3 KB
  - `public/js/RaceUI.js` — 38 行 / 1.5 KB
  - `public/js/engine-sound-worklet.js` — 343 行 / 14.9 KB
- **赛道几何定义**
  - `public/js/oval-geometry.js` — 96 行 / 4.7 KB
  - `public/js/suzuka-geometry.js` — 23 行 / 6.2 KB
  - `public/js/spa-geometry.js` — 49 行 / 8.3 KB
  - `public/js/vegas-geometry.js` — 37 行 / 6.2 KB

**合计：3409 行，187.6 KB**

---

## 页面骨架

> `index.html` 本轮 +0.1 KB（新增 bumper 碰碰车模式选项）。

### 文件: public/index.html

```html
<!DOCTYPE html>
<html lang="zh-CN" data-page-node-id="aRJvoE4vZaLXhW5R7AoqNH">
<head data-page-node-id="gXLUFwhRrYwznaSPhKFFDt">
<meta charset="utf-8" data-page-node-id="HeNm4FPJBM3CplHse1oX8Z">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" data-page-node-id="aekUM7sC2cXePKFbC3Vl58">
<!--
  全离线内容安全策略：default-src 'none' 表示除下面显式列出的来源外，浏览器会拒绝一切加载。
  任何人不小心写回外链脚本/字体/图片（CDN 等），都会被浏览器当场拦截 —— 这是"零外部请求"的自动防线，
  同时 tools/e2e.mjs 会静态扫描本目录下所有文件，出现任何外链字面量即判定失败。

  script-src 里的 'wasm-unsafe-eval' 是给 WebAssembly 用的：
  WebAssembly.instantiate / compile 属于"动态代码生成"，即使 wasm 已经以 base64 内联在
  JS 里（构建时用 -sSINGLE_FILE=1），也仍然需要这条显式授权，否则会被静默拒绝，
  只在 console 留一条 CSP violation，极难排查。
  它比 'unsafe-eval' **窄得多**：只放行 wasm 编译，不放行 eval() / new Function()，
  所以"零外链 + 禁动态求值"这两条防线都还在。
  兼容性：Chrome/Edge 97+、Firefox 102+、Safari 16.4+；老浏览器会忽略这个未知关键字，
  此时 wasm 路径加载失败，但不影响纯 JS 物理路径（现有实现仍然可用）。
-->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: ws: wss:; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'" data-page-node-id="iY24cBCIxvM2otfN65xy7A">
<title>极限竞速 · LAN ｜ 12 人局域网 3D 竞速</title>
<link rel="stylesheet" href="./style.css" data-page-node-id="FnONTxBa9yjuu6KCIwkuCU">
<link rel="stylesheet" href="./ui-layout-overrides.css">
<!-- 本地离线引擎库：相对路径，绝不经过任何外网 -->
<script src="./libs/three.min.js"></script>
</head>
<body data-page-node-id="NiH6gGw2sfIZLWCwwwIELX">

<canvas id="gl" data-page-node-id="QGjO8wqSP5vL6EXH4QsmAR"></canvas>

<!-- ============================ 启动遮罩 ============================ -->
<div id="boot" class="overlay" data-page-node-id="tfBwIV4jY75TD2W4Eh6EpY">
  <div class="boot-box" data-page-node-id="ghGvB1s5exytzVfnlxArJB">
    <div class="brand" data-page-node-id="5syiAXRfdDAdrgVkumJ5MJ">极限竞速 <span data-page-node-id="DFaMlpLX9F0B1HtDkDM0T1">· LAN</span></div>
    <div id="bootMsg" class="boot-msg" data-page-node-id="IgxdyFHyVyo42ZpS26Q5dl">正在装载本地离线引擎…<br data-page-node-id="JAENmVegE8pkm5GHEt07Jy">
      <small style="opacity:.6" data-page-node-id="MJ2mkBBwT9A48vKPVKR3Td">若长时间停在此页：请通过 Go 服务端的 http:// 地址访问，浏览器禁止 file:// 直接加载 ES 模块。</small>
    </div>
    <div class="bar" data-page-node-id="lfKFwx2AlmeExopKBzFtOj"><i id="bootBar" data-page-node-id="eNAinXVWjIw4pHB8Ck6BCs"></i></div>
  </div>
</div>

<!-- ============================ 大厅 ============================ -->
<div id="lobby" class="overlay hidden" data-page-node-id="ZziD1NkGFPZ6JvV0TisVzI">
  <aside id="presencePanel" class="presence-panel" aria-label="大厅玩家">
    <div id="playerProfile" class="player-profile"><span>车手</span><b id="profileName">未命名车手</b></div>
    <details id="presenceDetails" open>
      <summary class="presence-head"><b>大厅玩家</b><span id="presenceCount">0 人 · 房间内 0 人</span></summary>
      <div id="presenceBody" class="presence-body"></div>
    </details>
  </aside>

  <!-- 赛季积分排行榜（规格 §一.1）：首页右侧滑出的半透明磨砂面板。
       未加入房间时通过 /api/season 拉取；进入房间后由 room 报文的 season 字段推送。 -->
  <aside id="season" class="season-panel" data-page-node-id="hrBjCgV9b9QAgRUzTUZHos">
    <div class="season-head" data-page-node-id="Z96ESRVQ1Xpn92J4yTlfdx">
      <span class="season-ico" data-page-node-id="9UxltiN2UcFlY8TSJU20zH">🏆</span>
      <b data-page-node-id="FeOaOculYnxI4nFMY4lTyw">赛季积分排行榜</b>
    </div>
    <div class="season-cols" data-page-node-id="3qV2lI8cOrLZ11xDaA7DnT"><span data-page-node-id="vRAYWuRE3PK5yBeb2bQKbr">名次</span><span data-page-node-id="e5ub2iwKCQ0sUYMIvSsYCU">车手</span><span data-page-node-id="a4qXRaxxRea6lzlzkm2qyh">积分</span></div>
    <div id="seasonBody" class="season-body" data-page-node-id="EzsAsYpaEQsjuSeiNWAKGD">
      <div class="season-empty" data-page-node-id="n2CIlcEBh8J3Ee2A33nB2O">暂无记录 —— 完成一场比赛即可上榜</div>
    </div>
    <div class="season-foot" data-page-node-id="6wwDoLS1BZDKz7KfJuHp6C">仅统计真实昵称 · 每场按名次累加积分</div>
  </aside>

  <!-- ==================== 大厅一体化聊天 / 赛事事件控制台 ====================
       （规格 §二）大厅右侧固定 340px 磨砂面板：标题 + 在线人数、独立滚动消息流、
       玩家彩色气泡、系统/倒数高亮公告、底部紧凑输入框。
       玩家发言与系统事件共用一条消息流（服务端统一走 CHAT_MESSAGE）。
       开赛倒计时同时进入本消息流 ⇒ 与聊天同层，天然不会被任何 UI 叠层遮挡。 -->
  <aside id="chatPanel" class="chat-panel hidden" data-page-node-id="ChPnl000000000000000AS">
    <header class="chat-head" data-page-node-id="ChHead00000000000000AH">
      <div class="chat-title" data-page-node-id="ChTtl000000000000000AT">
        <span class="chat-ico" data-page-node-id="ChIco000000000000000AI">💬</span>
        <b data-page-node-id="ChB00000000000000000AB">赛事频道</b>
        <small data-page-node-id="ChS00000000000000000AS2">/ EVENT CHAT</small>
      </div>
      <div class="chat-online" data-page-node-id="ChOnl00000000000000AO">
        <i class="dot-live" data-page-node-id="ChDot00000000000000AD"></i>
        <span data-page-node-id="ChOnc00000000000000AON2">在线 <b id="chatOnline" data-page-node-id="ChOnb00000000000000AOB">1</b></span>
      </div>
    </header>
    <div id="chatFeed" class="chat-feed" data-page-node-id="ChFeed000000000000AF" aria-live="polite"></div>
    <div class="chat-input-row" data-page-node-id="ChInpR000000000000AR">
      <input id="chatInput" class="chat-input" type="text" maxlength="80" autocomplete="off"
             placeholder="按 Enter 发言…" data-page-node-id="ChInp0000000000000AIT">
      <button id="chatSend" class="chat-send" type="button" title="发送（Enter）" data-page-node-id="ChSnd00000000000000ASD">发送</button>
    </div>
  </aside>

  <div class="panel lobby-panel" data-page-node-id="ggC15BMTBK6w7AcxpmccO3">
    <header class="p-head" data-page-node-id="86OImbP0BEC0T7gQHGa08n">
      <h1 data-page-node-id="tmpbDcM3aiNkGQAPFUzAfi">极限竞速 <span data-page-node-id="QUWmxKfFlPvoevSOvMOW5W">· LAN</span></h1>
      <p class="sub" data-page-node-id="kmWLVFq8WuPdN8dFVBw06f">12 人局域网竞速 ｜ 单文件离线部署 ｜ 零外部依赖</p>
    </header>

    <div id="stageJoin" class="stage" data-page-node-id="xEsEXJMQDhFyX8ZX9eZ8DA">
      <div class="row" data-page-node-id="QQyHDjhWSTxnlGzbBjGBhB">
        <label class="lbl" data-page-node-id="0BW77WoIH2IzoteEfNVEY4">车手昵称</label>
        <input id="name" class="inp" maxlength="12" placeholder="输入昵称" value="" data-page-node-id="JzCQC1N4rI1dFqRhzH4Hpr">
      </div>
      <div class="row" data-page-node-id="soCPkFbfQwf7IIcVKwZQSx">
        <label class="lbl" data-page-node-id="D14ZKbQCrri3iXLeX6obG1">车身颜色</label>
        <div id="colors" class="colors" data-page-node-id="kEPfy0MokiYmZSZAjUm04L"></div>
      </div>
      <div class="row" data-page-node-id="QtTNQW1pYRJSczJfDUsIYn">
        <label class="lbl" data-page-node-id="2UwUgdMA3Bf5kGSAnAGSnT">比赛圈数</label>
        <select id="laps" class="inp sel" data-page-node-id="22ejTsdVxNyH6Hoc5gGOiD">
          <option value="1" data-page-node-id="RjKQixciB82JzGm9YiDmPT">1 圈（约 1 分钟）</option>
          <option value="3" selected data-page-node-id="GF5OiRZSVzGt1LlGFYkSfu">3 圈（标准）</option>
          <option value="5" data-page-node-id="Z8wtaL4UUkskBQWl0xoXd2">5 圈</option>
          <option value="8" data-page-node-id="HamA8rPgTlhRJZ5sresKOP">8 圈（耐力）</option>
        </select>
      </div>
      <div class="row" data-page-node-id="U7fK4cBv98b7zv3JEQa7Pj">
        <label class="lbl" data-page-node-id="fPp1pYPEfEESvP5cCI246Z">赛道</label>
        <select id="track" class="inp sel" data-page-node-id="h7YKUneBrvcMTDigEkdx4f">
          <option value="suzuka" selected data-page-node-id="B05jSg3qogUE5CBEASTX7n">铃鹿 · 8 字立体交叉</option>
          <option value="vegas" data-page-node-id="lXTRS0a7DUjY4HtGTOIpfY">拉斯维加斯 · 街道夜赛</option>
          <option value="spa" data-page-node-id="1Bf5s17belLtOoAFFPNQfo">斯帕 · 阿登森林</option>
          <option value="oval">新手 · 极简高速环道</option>
        </select>
      </div>
      <div class="row" data-page-node-id="2yScG7DNLyHW6ntjTjSxkB">
        <label class="lbl" data-page-node-id="uw2S3iPwecl7nstQztmMNo">碰撞</label>
        <label class="chkrow" data-page-node-id="ndRFfXAOeenE8tKs8kWLmY">
          <input type="checkbox" id="ghost" data-page-node-id="4sdeClltruOTBTy60V0gvr">
          <span data-page-node-id="3RVaCo2GfP1fBNDHuF5jIj">全员幽灵车模式（车与车不碰撞 · 可互相穿透 · 保留吸尾流）</span>
        </label>
      </div>
      <div class="row"><label class="lbl">引擎音效</label><select id="engineSound" class="inp sel"><option value="i6gt">直列六缸 GT（默认）</option><option value="v8">V8 十字曲轴</option><option value="v12">V12 高转</option><option value="fe">电动方程式（Formula E）</option></select></div>
      <div class="row"><label class="lbl">游戏模式</label><select id="gameMode" class="inp sel"><option value="horizon">地平线模式 · 轻松驾驶</option><option value="fm8" selected>FM8 模式 · 拟真规则</option><option value="bumper">碰碰车模式 · 全程实体对抗</option></select></div>
      <div class="grid2" data-page-node-id="cn6vIBIAGQdgBnHMs12TFQ">
        <button id="btnCreate" class="btn primary" data-page-node-id="nXUjf0xDDMKZEDRCELHXMM">创建房间</button>
        <div class="joinbox" data-page-node-id="iXWiv5jssgblbsRJGZjWQG">
          <input id="code" class="inp code" maxlength="4" placeholder="房间号" autocomplete="off" data-page-node-id="JrP8jtWgIFZNgxrP3EMN99">
          <button id="btnJoin" class="btn" data-page-node-id="u9HAb5OlCgOX3dw8MJhJ2V">加入</button>
        </div>
      </div>
      <button id="btnSolo" class="btn ghost wide" data-page-node-id="IOJPADVobWpSkDry45v5Zu">单机练习</button>
      <p id="netinfo" class="netinfo" data-page-node-id="NxdSwxny0spZDZOyFSc9qj">正在探测服务端…</p>
    </div>

    <div id="stageRoom" class="stage hidden" data-page-node-id="UoMB6r7KgogeFwxeJoPorL">
      <div class="roomcode" data-page-node-id="iljdmECyzP5X2IsMhp5SQq">
        <span class="lbl" data-page-node-id="79HPeiT9yvAuCvh2qaLY9n">房间号</span>
        <b id="roomCode" data-page-node-id="Fs9FAko5GpPdp56etjPPU9">····</b>
        <span class="hintline" data-page-node-id="BtZsOa0Q4Wi9ydhuZgxUBw">把这 4 位字符告诉其他玩家</span>
      </div>
      <div class="row" data-page-node-id="OAPJPFlEaumFMol4ywW4lb">
        <label class="lbl" data-page-node-id="WtUIyXnBo6BxvX2hnsOZxx">昵称</label>
        <input id="nameInRoom" class="inp" maxlength="12" placeholder="改昵称（大厅内实时同步）" data-page-node-id="fPN8ir6APjHwaNPDB4UgAp">
        <button id="btnRename" class="btn ghost" data-page-node-id="ZCBbupjor7edy4nZo6sEJJ">改名</button>
      </div>
      <div class="row" data-page-node-id="Kxgpcbku4Byz5CqLgB1QMN">
        <label class="lbl" data-page-node-id="A5tFshYChlCHBjD5HtRdrF">赛道</label>
        <b id="roomTrackName" class="trackname" data-page-node-id="1Sra49KGWQUJyo0exV8Z8S">铃鹿 · 8 字立体交叉</b>
        <button id="btnTrack" class="btn ghost hidden" data-page-node-id="66T8X9PDiucZH5wvBNSWSA">切换赛道</button>
      </div>
      <div class="row" data-page-node-id="RrkNJh0uulQnM6UqSRD7Q8">
        <label class="lbl" data-page-node-id="jJFPjfGDY7TFnQ5gpSCoaR">碰撞</label>
        <b id="roomGhost" class="trackname" data-page-node-id="SIiRIWveF55obBCz9TmZpA">标准碰撞（车车可碰撞）</b>
        <button id="btnGhost" class="btn ghost hidden" data-page-node-id="MGYtQZZs0gzxXGPKFbr4ck">切换模式</button>
      </div>
      <div class="row" data-page-node-id="RwMode000000000000R1">
        <label class="lbl">规则</label>
        <b id="roomGameMode" class="trackname">FM8 模式 · 拟真规则</b>
        <button id="btnGameMode" class="btn ghost hidden" type="button">切换模式</button>
      </div>
      <div class="row" data-page-node-id="RwLaps000000000000R1">
        <label class="lbl" data-page-node-id="LbLaps000000000000L2">圈数</label>
        <b id="roomLaps" class="trackname" data-page-node-id="TxLaps000000000000T3">3 圈</b>
        <button id="btnLaps" class="btn ghost hidden" data-page-node-id="BtLaps000000000000B4">修改圈数</button>
      </div>
      <button id="btnAddAI" class="btn ghost wide hidden" type="button">添加人机车手</button>
      <details id="roomPlayersDetails" class="room-players">
        <summary class="room-players-head"><b>房间玩家</b><span id="roomPlayersCount">0 人</span></summary>
        <div id="playerList" class="players" data-page-node-id="ngJDnF8I1shQtEEI0DSE3l"></div>
      </details>
      <div class="row2" data-page-node-id="1gPNQ6v7GDN0ABPNxLW0KO">
        <button id="btnReady" class="btn primary" data-page-node-id="9iJhfUfBKGOdttlBxTkFki">准备</button>
        <button id="btnLeave" class="btn ghost" data-page-node-id="hBQcOp40FcddMyGNs2glJG">离开房间</button>
      </div>
      <p class="hintline" data-page-node-id="lhK6AFmbtkZZ65yg5ivQBe">全员准备后进入聊天框 5 秒整备倒计时，随后红灯逐盏熄灭发车。方向键环视，WASD 驾驶，空格手刹。</p>
    </div>

    <div class="keys" data-page-node-id="6xLwrXjjrC9Djt8uooIals">
      <span data-page-node-id="6ZiwiJGPKnKmjO2icISEx0"><b data-page-node-id="GJcPxIEjz1BDvi2lJ0YHRM">W</b> 油门</span><span data-page-node-id="wUf46FjM84MC2w4jGydFhI"><b data-page-node-id="1u7rXxjfw2CTroKF8ATNyO">S</b> 刹车·倒车</span><span data-page-node-id="5lx3eio9eRVpFXxG9OQUhF"><b data-page-node-id="klDDhSKMMBpiEt6q1DBYxV">A/D</b> 转向</span>
      <span data-page-node-id="7I7aRA4oGH9emSjW6rDZHs"><b data-page-node-id="gYfaD4fwA9tG3kybh2hNot">Space</b> 手刹漂移</span><span data-page-node-id="sn8KQ02VT6yBxafuczGUYg"><b data-page-node-id="li1h1KCDc9jq8ysJDHWl26">C/V</b> 切换视角（追尾·引擎盖·鸟瞰）</span><span><b>方向键</b> 八向环视</span>
      <span data-page-node-id="w3EJAgLMd9UfzNuzvkAGbQ"><b data-page-node-id="i0ZRqRfSUD0tVGGCpRQku9">L</b> 最佳走线</span><span data-page-node-id="QZF77z4P6BYGOog1CGtYmr"><b data-page-node-id="4rrcvIcQQyTBbeHOv32QE9">R</b> 脱困复位</span><span data-page-node-id="s0qvGVREPHJu3wKbrRjjCk"><b data-page-node-id="ceTJCon1ExiuAI9DNPVA7h">M</b> 静音</span>
    </div>
  </div>
</div>

<!-- ============================ 比赛 HUD ============================ -->
<div id="hud" class="hidden" data-page-node-id="tAGSBMtddg7o1JIgSq5H1F">
  <div id="slipstreamEdges" aria-hidden="true"></div>
  <div id="nameplates" data-page-node-id="nameplates000000N1"></div>

  <div class="hud-tl" data-page-node-id="HicPYNxR2n5sPX71FKVRsE">
    <!-- FM8 计时塔：4 列 —— 名次大数字 / 车手名+配色块 / 时间差距 / 处罚。
         自己所在行有微弱蓝色高亮；「处罚」列是橙黄色块，显示累计罚时与违规次数。
         必须留在 .hud-tl 内（#hud 曾被多余的闭合标签提前关掉，导致速度表/地图/榜单
         全掉到 #hud 外面）。本条注释刻意不写闭合标签字面量，免得带偏标签配平扫描器。 -->
    <div class="twrow" data-page-node-id="mDBE1JiI95XtGDmDpZPg9p">
      <div class="card tower" data-page-node-id="4QHEVinRDCAvLSimWH1IqL">
        <div class="tw-head" data-page-node-id="p8Klgfn0jVzB0I56BNbMvT"><span id="twHdr" data-page-node-id="Yj2FE5bQmtX2UB92lDDwhN">玩家</span><span data-page-node-id="stnU5vYBvHBxI8Txg03rWA"></span><span data-page-node-id="L2sCbAOVaBsAfKx3ZeiUBf">时间差距</span><span data-page-node-id="2AtjSFZ6kxqaoHDqCNgJeD">处罚</span><span data-page-node-id="hNwNHdMvI6tGM61BDr3ZSY">🔧</span></div>
        <div id="standList" class="st-body" data-page-node-id="gnjHmOhx7sAU23RsJPXdjF"></div>
      </div>

      <!-- 圈速信息框（规格 §五.2：**无边框**、浮动文字，不用卡片底）。
           目前单圈 ▲ | 白色等宽大字 | 最佳 | 惩罚 -->
      <div class="lapbox" data-page-node-id="R6KcpiFSpYU8Uq2eNHFWx7">
        <div class="lb-row" data-page-node-id="hDdVfiHoNRrwnMb1sm3WV8"><span data-page-node-id="Q9YWg6evPXa2Is2wlgiuxk">目前单圈</span><i id="lapDirty" class="lb-dirty hidden" title="当前圈已被标记为脏圈">&#9888;&#65039;</i><b id="curLapTime" data-page-node-id="squmxnVefJWJWgNOjB5M3h">00:00.000</b></div>
        <div class="lb-row" data-page-node-id="XbcCPUuc5vR3VddCJfBLU5"><span data-page-node-id="ylQYfef8BWVQdAh0WeBTSi">最佳</span><i class="lb-mark" data-page-node-id="D3IK62YMCIYxELtuptu6YS">▲</i><b id="bestLap" data-page-node-id="Oh0zwR0hcR0siFOtwrfrbu">--:--.---</b></div>
        <div class="lb-row pen-row" data-page-node-id="ibGUsoAkjvhcwfx2vwR4O2"><span data-page-node-id="UNHlRDQG1iRm3AzaVky6mN">惩罚</span><b id="lapPen" class="lb-pen" data-page-node-id="cd9LjlGUbXb62CRF0IyA3k">+0.000</b></div>
      </div>
    </div>
  </div>

  <!-- 右上角：极简圈数进度 + 车辆分组标识 -->
  <div class="hud-tr" data-page-node-id="XFobvdqk6FchDib3kfk9BF">
    <div class="lapcounter" data-page-node-id="GKfBN24Gtci1yIBpH4TRkH">
      <b data-page-node-id="fmCkaizLmPunTaUQVRX7Dm">圈 <span id="lapNum" data-page-node-id="0MGhFQ7mNCfRSSaz3D0rmI">1</span>/<span id="lapTotal" data-page-node-id="FpvpUI2LNEIya3FxudgqkV">3</span></b>
      <span id="carClass" data-page-node-id="k75WgjePZNAN9s0jJtsKMd">GT · A 组</span>
    </div>
  </div>

  <!-- 左下角：圆形微缩地图（实时描摹赛道闭环 + 四车彩色圆点与朝向指针） -->
  <div class="hud-bl" data-page-node-id="H8bY7g1ubTMlsetB1vPGDq">
    <div id="wrongWay" class="badge wrong hidden" data-page-node-id="BRl0uggPb05hTdi7kcBi02">逆 行 · WRONG WAY</div>
    <div id="alert" class="alert hidden" data-page-node-id="iS0xigA3N7xZC9ctDmzOx7"><b id="alertTxt" data-page-node-id="Lwu3XKnTLsyCEwHfBe0jNp"></b></div>
    <div class="card map-card" data-page-node-id="nUkuNmHvBIwgROX6eWQc4h">
      <canvas id="minimap" width="320" height="320" data-page-node-id="G37usNa3nHs8SEtQ3Jm33p"></canvas>
      <div class="map-legend" data-page-node-id="JpgDDpK4nDwHzTPyELaoqa"><span id="mapTrack" data-page-node-id="cUN61xpyqjW3SlgSozkWFZ">赛道</span><b id="mapPos" data-page-node-id="p0B13GfYDx7P38XryHVBx7">P1</b></div>
    </div>
  </div>

  <div class="hud-br" data-page-node-id="oWJzwnEoNfHq3gf1yjvRxF">
    <div class="speedo-wrap" data-page-node-id="e4gXs0BkvCeUvlCFE5zyAJ">
      <div id="draftText" class="draft-text hidden" data-page-node-id="3ckPUrx6iAcphJxEX1LSd9">DRAFTING</div>

      <!-- 遥测列：四轮胎温/磨损 + 挡位模式 + 油量/电量条 -->
      <div class="telemetry" data-page-node-id="dtvTNLidjeDxSyZIai0DjR">
        <div class="tel-grid" data-page-node-id="rKTSlDvWxGYgEDmjRBCjOO">
          <i id="telFL" class="tel" data-page-node-id="TuL41rBAFF4qsJJkVv1oDF"></i><i id="telFR" class="tel" data-page-node-id="GNHBcV89QN17FLKchylZzL"></i>
          <i id="telRL" class="tel" data-page-node-id="UVFjgSYSNcsl4EYnSE5lC1"></i><i id="telRR" class="tel" data-page-node-id="fsCywBQQYtSOGOnawunLBb"></i>
        </div>
        <div class="tel-mode" data-page-node-id="rmaJIeT0OctTHCoLX4eRH0"><b id="gearMode" data-page-node-id="gogqh0ysJVjY9pLTJRKGU0">A</b><span data-page-node-id="qHazoTlMLL3A0gucPPhJw3">挡位</span></div>
        <div class="tel-fuel" data-page-node-id="XsfaOri7Dp0PQLG6pPDTVj"><i id="fuelBar" data-page-node-id="gVd2SYG4PpMcJ67tfDWjam"></i></div>
      </div>

      <div class="gauge-box" data-page-node-id="jpjk32AubPAuYvueY2lPQz">
      <svg id="speedo" viewBox="0 0 200 200" aria-hidden="true" data-page-node-id="OazVc4x0LQdZakGW789XRc">
        <defs data-page-node-id="2mvgIbgRnlG3yTq50Slylm">
          <linearGradient id="spdGrad" x1="0" y1="1" x2="1" y2="0" data-page-node-id="dF6U7jnsr7MSTdTDXU5k3T">
            <stop offset="0%" stop-color="#3ad1ff" data-page-node-id="u6LqZXgtUbmHAjmuWN8GEi"/>
            <stop offset="55%" stop-color="#ffd200" data-page-node-id="Tvo8S9Ao6HoEEd4UbFkItu"/>
            <stop offset="100%" stop-color="#ff2d1f" data-page-node-id="xtuGo8XsbbUDD1bKiac1YF"/>
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r="88" class="spd-bg" data-page-node-id="j2JCjN7IIKHz6GycQExwiV"/>
        <path id="spdArc" class="spd-arc" d="" data-page-node-id="LaxE8xMFn5xYEoP4CLFYHO"/>
        <path id="spdFill" class="spd-fill" d="" data-page-node-id="FigVFshnEihhAFFwT3sVnT"/>
        <!-- FM8 布局：中心是**大号档位**，档位下方才是车速与单位 -->
        <text id="gear" class="gear" x="100" y="114" data-page-node-id="5vlZUYDnHMTqqdB7s6vAYq">N</text>
        <text id="spd" class="spd-num" x="100" y="148" data-page-node-id="3ihkKJF7kvFf4TixyriSxD">0</text>
        <text class="unit" x="100" y="172" data-page-node-id="uJyNROhDSgmFHDL6lIk3Pg">公里/小时</text>
      </svg>
      <!-- 指针用独立 HTML 元素：规格要求 style.transform = rotate(...) + CSS transform-origin -->
      <div id="needle" class="needle" data-page-node-id="yQNSFdw5jDKpJWs1Zd359V"></div>
      <div id="gForce" class="gforce" data-page-node-id="2sLroHU8sFXJmqEvTWPRLK"></div>
      </div>
    </div>
  </div>

  <div id="spectate" class="card spectate hidden" data-page-node-id="FOXQhdhBixUac6UC9QaArm">
    <div class="spec-head" data-page-node-id="7cTmZEVCkjWkEyJ4kabJvk">观战模式 <span data-page-node-id="UhDDE86lTgMJFRwMFcHOV9">← → 切换车辆</span></div>
    <div id="specList" class="spec-list" data-page-node-id="E8FkCoazREZY0pRhjyoVDz"></div>
  </div>

  <!-- ==================== 局内非侵入式聊天浮层（规格 §三）====================
       左下轻量消息流：新消息平滑淡入、停留 5s 后向左淡出；绝不遮挡挡风玻璃与弯心。
       位置在计时塔下方、圆形小地图上方之间的空白带。 -->
  <div id="hudChat" class="hud-chat" data-page-node-id="HCht000000000000000HC">
    <div id="hudChatFeed" class="hc-feed" data-page-node-id="HCf0000000000000000HF" aria-live="polite"></div>
  </div>
  <!-- 驾驶中快捷打字条（Enter / T 呼出）。激活时切断 WASD 对赛车的控制。 -->
  <div id="hudChatBar" class="hc-bar hidden" data-page-node-id="HCb0000000000000000HB">
    <span class="hc-hint" data-page-node-id="HCh0000000000000000HH">发言</span>
    <input id="hudChatInput" class="hc-input" type="text" maxlength="80" autocomplete="off"
           placeholder="输入消息… Enter 发送 · Esc 取消" data-page-node-id="HCi0000000000000000HI">
  </div>

  <div id="toast" class="toast hidden" data-page-node-id="AsHCLy82mNmVTlcxoCynyq"></div>
</div>

<!-- 顶部裁决唯一宿主；通知销毁后子节点为空。 -->
<div id="frrBanner" class="frr impact" aria-live="polite" aria-atomic="true" hidden data-page-node-id="O5sASE4UGSYAf2nAROvOf4"></div>

<!-- ============================ 起步灯 ============================ -->
<!-- 进入场景后五盏红灯全亮，随后逐盏熄灭；全部熄灭后五灯转绿并放行。 -->
<div id="startLights" class="startlights hidden" data-page-node-id="JetNFmtg2AnBy8rKEBqPLT">
  <div class="sl-row" data-page-node-id="Gy9m5Dctw0qYLBTPE8LuCr">
    <i class="sl red" data-page-node-id="eSQX5a4rGzNpywfgHKqRql"></i><i class="sl red" data-page-node-id="FESQGEcRQCDOuCXaCnFwLt"></i><i class="sl red" data-page-node-id="XXlcSjhKJBYsWtwWtQnoFw"></i>
    <i class="sl red" data-page-node-id="9qu2ocnEBADnb57FVW6p1r"></i><i class="sl red" data-page-node-id="MRJlNzGttrJQOrZKDrfeVH"></i>
  </div>
  <div class="sl-go" id="slGo" role="status" aria-live="assertive" data-page-node-id="C4A3uvJR1ljdYcMCEQB0qU">GREEN / GO!</div>
</div>

<!-- 完赛单行半透明条幅（规格 §四.1）：禁止弹全屏大面板 -->
<div id="finishBar" class="finishbar hidden" data-page-node-id="HiD9gW5XMni3SgB3W5TLH5">
  <span class="fb-ico" data-page-node-id="9GuqjX0B9YgyADUdTMpvhk">🏁</span>
  <span class="fb-txt" id="finishBarTxt" data-page-node-id="5wnunwOiwjYpoqcfgkYvbm">恭喜完赛！成绩已记录</span>
  <span class="fb-hint" data-page-node-id="e7u0m3LknHHA0uGicRG6es">← / → 切换观战</span>
</div>

<!-- 观战入力回显（规格 §四.2）：屏幕正下方半透明键盘指示器 + 油门刹车进度条 -->
<div id="inputOverlay" class="inputov hidden" data-page-node-id="NoQG1CnvHAcuYkBclsGjZ6">
  <div class="io-keys" data-page-node-id="ZpSllcSzb8Zt7gKqSYCPwW">
    <b id="ioW" class="io-key" data-page-node-id="QQAy8gDZTD39oqgf02NZvb">W</b>
    <b id="ioA" class="io-key" data-page-node-id="JFqhuIdQaYn7pgkcu6KFbn">A</b>
    <b id="ioS" class="io-key" data-page-node-id="FgoVI7NE3XNETlyRhJRN3m">S</b>
    <b id="ioD" class="io-key" data-page-node-id="lFHlOGaikVETfJxxMhq9DM">D</b>
    <b id="ioSpace" class="io-key wide" data-page-node-id="g51jN20Ysa4e0ugQ1Fjz1U">SPACE</b>
  </div>
  <div class="io-bars" data-page-node-id="w2oeMkTxN0n6Iw87QAi0SO">
    <div class="io-bar thr" data-page-node-id="tG8oLEXrzzEAstWCEFwl0z"><i id="ioThr" data-page-node-id="yDTKlK0jwkcIO95aTq5IUc"></i><span data-page-node-id="jCdGRYwNRdCAHN3TeQTAAd">油门</span></div>
    <div class="io-bar brk" data-page-node-id="BEvrVifUTCuKxB8FzEINbh"><i id="ioBrk" data-page-node-id="DQikQPueWNy4kjHYU0g2Au"></i><span data-page-node-id="jD54WKujjEncn5t2JhjGDG">刹车</span></div>
  </div>
</div>

<!-- ============================ 结算 ============================ -->
<div id="results" class="overlay hidden" data-page-node-id="yyaQpbfRNZNTnDRCCTRoBe">
  <div class="panel res-panel" data-page-node-id="EK0BXtV0HQVFGwYzAp7msp">
    <h2 data-page-node-id="PhsI8eASEvLwzpsyLScUxs">比赛结果</h2>
    <div class="res-sub" id="resSub" data-page-node-id="1BI1Z0NHFS3xp60AgxTcnt">最终成绩 = 净用时 + 累计罚时</div>
    <table class="res-table" data-page-node-id="YPhs7cxNrb5eeeTNzwpF09">
      <thead data-page-node-id="GaEXHHA3C2XJeq8WXCf7u8">
        <tr data-page-node-id="CJcjxeEMH86B7RPG7Chjbk"><th data-page-node-id="rK8lnWku4sEylyFllUz57K">名次</th><th data-page-node-id="Q1WASXJ2MOLLaCJtwhIr68">车手</th><th data-page-node-id="WVT2kMyQGQxhiCk63r6OWk">净用时</th><th data-page-node-id="zEv5WjhZjQoWFvkbY7DOmH">罚时</th><th data-page-node-id="RTOGcY7vcTUtGw2jCkVY8T">总成绩</th><th data-page-node-id="fcmFtKMo9E3ZFWmSvHn7SX">最快圈</th></tr>
      </thead>
      <tbody id="resBody" data-page-node-id="atFu53SIEzVo7Pq8aFt5vt"></tbody>
    </table>
    <div class="row2" data-page-node-id="XqYxhVkh8CMa5kLnd4wMmO">
      <button id="btnAgain" class="btn primary" data-page-node-id="4vvG5fVzGFwSANPB4s0okO">再来一局</button>
      <button id="btnQuit" class="btn ghost" data-page-node-id="SYIKyQ1Eo19lBHdftMLaVn">返回大厅</button>
    </div>
    <p class="hintline" data-page-node-id="ypzUu92F9LKNACHxcKO9PM">结算后仍可切换观战视角，看其他玩家跑完。</p>
  </div>
</div>

<!-- ==================== 规格 §二：全员完赛全屏磨砂结算 Modal ====================
     由服务端 RACE_RESULTS 报文驱动，延迟 1.5s 平滑弹出。展示全部完赛者：
     名次 / 车手 / 总成绩 / 最快圈 / 本场赛季积分。底部两个按钮：
     「再来一局」与「返回大厅」（后者把房间复位到 WAITING）。 -->
<div id="settlement" class="overlay settlement hidden" data-page-node-id="StlRoot00000000000ST">
  <div class="settle-panel" data-page-node-id="StlPanel0000000000SP">
    <div class="settle-head" data-page-node-id="StlHead00000000000SH">
      <span class="settle-flag" data-page-node-id="StlFlag00000000000SF">🏁</span>
      <h2 data-page-node-id="StlTtl000000000000ST2">比赛结算</h2>
      <p class="settle-sub" id="settleSub" data-page-node-id="StlSub00000000000SS">本场结算</p>
    </div>
    <div class="settle-cols" data-page-node-id="StlCols0000000000SC">
      <span data-page-node-id="StlC1_000000000000C1">名次</span>
      <span data-page-node-id="StlC2_000000000000C2">车手</span>
      <span data-page-node-id="StlC3_000000000000C3">总成绩</span>
      <span data-page-node-id="StlC4_000000000000C4">最快圈</span>
      <span data-page-node-id="StlC5_000000000000C5">赛季积分</span>
    </div>
    <div id="settleBody" class="settle-body" data-page-node-id="StlBody00000000000SB"></div>
    <div class="settle-actions" data-page-node-id="StlAct000000000000SA">
      <button id="settleAgain" class="btn primary" data-page-node-id="StlAgn000000000000S1">再来一局</button>
      <button id="settleLobby" class="btn ghost" data-page-node-id="StlLby000000000000S2">返回大厅</button>
    </div>
    <p class="hintline" data-page-node-id="StlHint00000000000HN">赛季积分已实时累加 · 右侧榜单同步更新</p>
  </div>
</div>

<script type="module" src="./js/RaceUI.js"></script>
<script type="module" src="./js/main.js"></script>
</body>
</html>
```

## 联机 / 协议 / Worker 桥接

> `PhysicsWorkerBridge.js` 本轮 +2.0 KB（定点量化 r2/r3/r4）。

### 文件: public/js/network.js

```javascript
/* =============================================================================
 * network.js —— 局域网 WebSocket 同步 + 60Hz 快照插值（Snapshot Interpolation）
 *
 * 【为什么不能用"收到最新包就直接移动过去"】
 *   服务端 60Hz 广播，客户端渲染 60~144Hz，网络还会抖动。若把最新包的位置直接
 *   贴到车上，一旦丢包/抖动，远端车就会"瞬移向前闪现"，随后又"卡顿断层"。
 *
 * 【本实现：Jitter Buffer + 快照插值】
 *   · 每个远端车维护长度 64 的历史快照环形缓冲（时间戳 / 位置 / 四元数 / 线速度）
 *   · 自适应渲染延迟 RenderDelay = clamp(3σ, 60, 120)ms（σ = 近 1s 快照到达时差的标准差），
 *     永远回放"过去"的状态，于是任何抖动都发生在缓冲里，而不是发生在画面上
 *   · renderTime = 本地时钟 − RenderDelay，在缓冲里定位前后两个快照 SnapA / SnapB
 *   · 位置：Hermite 三次样条插值（用线速度作为端点切线，比线性 LERP 无折角）
 *   · 旋转：四元数 SLERP 球面插值
 *   · 缓冲里没有未来快照时：按最后快照的位置 + 速度做直线外推（Dead Reckoning），
 *     绝不停止也绝不瞬移
 *   · 新快照到达后：渲染位置以指数衰减向真实轨迹收敛（误差融合），杜绝生硬闪现
 *
 * 【时钟】
 *   比赛计时与快照时间戳都用服务端时钟。开局 6 次 ping/pong 取 RTT 最小样本估
 *   算 offset，使 serverNow() = Date.now() + offset；快照时间统一换算到本地时间轴。
 * ========================================================================== */

/* 渲染延迟：规格要求**弹性自适应** —— dynamicDelay = clamp(3σ, 60, 120)，
 * σ = 近 RENDER_WIN_MS 内快照到达时差的标准差。丢包/抖动大就自动加长缓冲，
 * 网络好就收紧以减少视觉滞后。冷启动（样本不足）先用 80ms 兜底，
 * 否则 σ=0 会直接把延迟压到下限 60ms，一上来就缓冲区击穿。 */
const RENDER_DELAY_DEFAULT = 80;  // 样本不足时的兜底渲染延迟 (ms)
const RENDER_DELAY_MIN = 60;      // 规格：3σ 下限 (ms)
const RENDER_DELAY_MAX = 120;     // 规格：3σ 上限 (ms)
const RENDER_WIN_MS = 1000;       // σ 统计窗口：近 1 秒
const RENDER_MIN_N = 8;           // 至少这么多次到达间隔才开始自适应
const CLOCK_WIN = 20;         // 规格：时钟样本滑窗长度 20（保留 RTT 最小的优质样本）
const BUF_LEN = 64;           // 环形缓冲槽数（约 1.07s @60Hz；时间跨度另限 2s）
const MAX_BUFFER_SPAN_MS = 2000;
const MAX_EXTRAP_MS = 250;    // 航位推测上限（超过就停住，避免"飞出去"）
const ERR_BLEND = 20;         // Dual-Layer 误差融合的衰减系数（1/s，规格：20.0）
const STATE_HZ = 60;          // 位姿上报频率（与 60Hz 广播同频，保证插值源足够密）

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const monoNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * Hermite 三次样条：p(s) = h00·p0 + h10·m0·dt + h01·p1 + h11·m1·dt
 * 用端点线速度当切线 -> 速度连续，过弯时没有折角（线性 LERP 会有）。
 * @param {number} s 归一化时间比例 0..1
 * @param {number} dt 两快照的时间差（秒）
 */
function hermite(p0, m0, p1, m1, s, dt) {
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * p0 + h10 * m0 * dt + h01 * p1 + h11 * m1 * dt;
}

export class Net {
  constructor() {
    this.ws = null;
    this.url = '';
    this.myId = 0;
    this.handlers = new Map();
    this.players = new Map();      // id -> { id, buf:[], last:null, render:{} }
    this.roomCode = '';
    this.laps = 3;
    this.seed = 0;
    this.lobby = [];               // 服务端下发的玩家列表快照
    this.countdown = -1;
    this.connected = false;
    this.clockOffset = 0;
    this.bestRtt = Infinity;
    this.monoOffset = null;   // 服务端单调时钟 -> 本地时间轴的偏移；null 表示尚未同步
    this.clockWindow = [];    // 长度 10 的时钟样本滑窗 [{rtt, offset, mono}]，取最小 RTT 者
    this.renderDelay = RENDER_DELAY_DEFAULT;  // 自适应渲染延迟 (ms)
    this.jitterSigma = 0;     // 近 1s 快照到达时差的标准差 (ms)
    this._arrivals = [];      // 近 1s 的快照到达时刻（只保留窗口内）
    this._pingTimer = null;
    this._lastSend = 0;
    this._seq = 0;
    this._reconnect = 0;
    this._manualClose = false;
    this._rr = new Float32Array(3);
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
    this._target = new THREE.Vector3();   // 本帧插值/外推得到的目标位置
    this._vtmp = new THREE.Vector3();     // 双层融合：矫正前的视觉位置
    this._qtmp = new THREE.Quaternion();  // 双层融合：矫正前的视觉姿态
    this._qid = new THREE.Quaternion();   // 恒等四元数
    this._interpDt = 1 / 60;              // 逐帧 dt（误差融合用）
    this._frameStamp = 0;
    this._workerInbound = null;
    this._worker = null;
  }

  /* --------------------------- 事件 --------------------------- */

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, data) {
    const arr = this.handlers.get(type);
    if (!arr) return;
    for (const fn of arr) {
      try { fn(data); } catch (e) { console.error('[net] handler error', type, e); }
    }
  }

  /* --------------------------- 连接 --------------------------- */

  connect(url) {
    this.url = url;
    this._manualClose = false;
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this.emit('error', { msg: '无法建立 WebSocket 连接：' + e.message });
        resolve(false);
        return;
      }
      this.ws = ws;
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };

      ws.onopen = () => {
        this.connected = true;
        this._reconnect = 0;
        this.startClockSync();
        this.emit('open');
        done(true);
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.dispatch(m);
      };
      ws.onerror = () => {
        this.emit('error', { msg: '连接异常，请确认服务端仍在运行' });
        done(false);
      };
      ws.onclose = () => {
        this.connected = false;
        this.emit('close');
        done(false);
        if (!this._manualClose && this._reconnect < 6) {
          this._reconnect++;
          const wait = Math.min(4000, 400 * this._reconnect);
          setTimeout(() => { if (!this._manualClose) this.connect(this.url); }, wait);
          this.emit('reconnecting', { attempt: this._reconnect });
        }
      };
      setTimeout(() => done(false), 5000);
    });
  }

  close() {
    this._manualClose = true;
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
  }

  /* --------------------------- 时钟同步 --------------------------- */

  startClockSync() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this.clockWindow = [];
    this.bestRtt = Infinity;
    // 开局 6 次快速采样（间隔 130ms）尽快收敛 offset，之后按规格以 1Hz 维持
    for (let i = 0; i < 6; i++) setTimeout(() => this.send({ t: 'ping', c: Date.now() }), i * 130);
    this._pingTimer = setInterval(() => this.send({ t: 'ping', c: Date.now() }), 1000);
  }

  serverNow() { return Date.now() + this.clockOffset; }

  /** Connect the network protocol to the physics worker's remote proxy. */
  attachWorker(workerBridge) {
    this._worker = workerBridge || null;
    if (this._worker) {
      this._worker.onNetwork = (packet) => this.sendWorkerState(packet);
      this._workerInbound = (packet) => this._worker.handleNetworkPacket(packet);
    } else {
      this._workerInbound = null;
    }
    return this;
  }

  /** Worker-owned state source. The server keeps the existing `d` protocol. */
  sendWorkerState(packet) {
    if (!packet || packet.t !== 'state' || !packet.d) return false;
    const out = { t: 'state', id: packet.id, seq: packet.seq, d: packet.d };
    return this.send(out);
  }

  /**
   * 自适应抖动缓冲（规格 §3.2）。
   * 记录快照到达时刻，对**近 RENDER_WIN_MS 窗口内**的到达间隔求标准差 σ，
   * 再按 dynamicDelay = clamp(3σ, 60, 120) 伸缩渲染延迟：
   * 网络一抖就自动加长缓冲（防击穿断流），网络好就收紧（减少视觉滞后）。
   * 样本不足时维持兜底值 —— 冷启动 σ=0 会把延迟直接压到下限 60ms，反而更易被击穿。
   */
  _trackJitter(now) {
    const a = this._arrivals;
    a.push(now);
    while (a.length > 2 && now - a[0] > RENDER_WIN_MS) a.shift();
    if (a.length < RENDER_MIN_N) return;
    let sum = 0, n = 0;
    for (let i = 1; i < a.length; i++) { sum += a[i] - a[i - 1]; n++; }
    const mean = sum / n;
    let sq = 0;
    for (let i = 1; i < a.length; i++) { const d = (a[i] - a[i - 1]) - mean; sq += d * d; }
    this.jitterSigma = Math.sqrt(sq / n);
    this.renderDelay = clamp(3 * this.jitterSigma, RENDER_DELAY_MIN, RENDER_DELAY_MAX);
  }

  /* --------------------------- 收发 --------------------------- */

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 位姿上报，内部限频到 30Hz。track 可选：给定时用于解算 (cpIdx, distNext) */
  maybeSendState(car, now, track) {
    if (!car || car.remote) return;
    if (now - this._lastSend < 1000 / STATE_HZ) return;
    this._lastSend = now;
    const q = car.quat, p = car.pos, v = car.body.velocity;
    this._seq++;
    // 进度字段：c/n 是旧 Checkpoint 回退路径，p 是当前圈归一化样条弧长。
    // 权威秒差现在以 p 对应的服务端通过时刻为准；不再使用瞬时速度外推。
    const cpIdx = (typeof car.cpIdx === 'number') ? car.cpIdx : -1;
    let distNext = 0;
    if (track && track.checkpoints && track.checkpoints.length) {
      const n = track.checkpoints.length;
      const next = track.checkpoints[((cpIdx + 1) % n + n) % n];
      if (next && next.pos) distNext = Math.hypot(p.x - next.pos.x, p.z - next.pos.z);
    }
    const count = track && track.count > 0 ? track.count : 1;
    const trackIdx = (typeof car.trackIdx === 'number') ? car.trackIdx : 0;
    const spline = ((trackIdx % count) + count) % count / count;
    // 入力字段（规格 §四.2 观战入力回显）：throttle/brake/steer/handbrake。
    // 让已完赛/退赛的玩家在观战时能看到被观战车手的实时操控（键盘 + 踏板条）。
    // steer 取 [-1,1]（input.steer 已是该区间），油门/刹车 [0,1]。
    const inp = car.input || {};
    this.send({
      t: 'state',
      seq: this._seq,
      d: {
        x: r3(p.x), y: r3(p.y), z: r3(p.z),
        q: [r3(q.x), r3(q.y), r3(q.z), r3(q.w)],
        v: [r1(v.x), r1(v.y), r1(v.z)],
        s: Math.round(car.speedKmh),
        t: r2(car.steerAngle),
        l: car.lap,
        c: cpIdx,
        n: r1(distNext),
        p: r3(spline),
        k: car.slip > 0.5 ? 1 : 0,
        f: car.finished ? 1 : 0,
        // 入力遥测（供观战回显）
        u: r2(clamp01(inp.throttle)),
        b: r2(clamp01(inp.brake)),
        e: r2(clamp(inp.steer, -1, 1)),
        h: (inp.handbrake ? 1 : 0),
      },
    });
  }

  dispatch(m) {
    switch (m.t) {
      // 服务端发起的延迟探测（用于在房间里显示**每个玩家**的毫秒数）。
      // 客户端只负责原样回显 nonce `c`，RTT 由服务端用"发出→收回"的时间差计算，
      // 因此玩家无法伪造自己的延迟。与时钟同步用的 ping/pong 是两条独立通道。
      case 'sping': {
        this.send({ t: 'spong', c: m.c });
        return;
      }
      case 'pong': {
        const t4 = Date.now();
        const t1 = m.c;
        const hasNtp = typeof m.t2 === 'number' && typeof m.t3 === 'number';
        // NTP 公式（规格）：
        //   RTT    = (t4 - t1) - (t3 - t2)      —— 剔除服务端处理时长
        //   Offset = ((t2 - t1) + (t3 - t4)) * 0.5
        // 没有 t2/t3 的旧服务端退化到 s - 中点（同一结果的特例）。
        const rtt = hasNtp ? Math.max(0, (t4 - t1) - (m.t3 - m.t2)) : (t4 - t1);
        const offset = hasNtp
          ? ((m.t2 - t1) + (m.t3 - t4)) * 0.5
          : (m.s - (t1 + rtt / 2));
        const mid = t1 + (t4 - t1) / 2;
        // 规格：维护长度 20 的滑窗，只认 RTT 最小的优质样本。
        // Wi-Fi 偶发抖动会把个别 RTT 抬高几十毫秒，直接平均会被毛刺污染。
        this.clockWindow.push({
          rtt,
          offset,
          mono: typeof m.m === 'number' ? m.m - mid : null,   // 单调时钟（不受 NTP 校时影响）
        });
        if (this.clockWindow.length > CLOCK_WIN) this.clockWindow.shift();
        let best = this.clockWindow[0];
        for (const s2 of this.clockWindow) if (s2.rtt < best.rtt) best = s2;
        this.bestRtt = best.rtt;
        this.clockOffset = best.offset;
        if (Number.isFinite(best.mono)) this.monoOffset = best.mono;
        this.emit('clock', { rtt, offset: this.clockOffset });
        break;
      }
      case 'hello':
        this.myId = m.id;
        this.clockOffset = m.s - Date.now();
        this.emit('hello', m);
        break;
      case 'room':
        this.roomCode = m.room;
        this.laps = m.laps;
        this.seed = m.seed;
        this.lobby = m.players || [];
        this.emit('room', m);
        break;
      case 'count':
        this.countdown = m.n;
        this.emit('count', m);
        break;
      // ── 规格 §一：服务端权威倒计时状态机（客户端绝不自行计时）──
      // START_SEQUENCE_BEGIN   全员载入 -> 开始下发倒计时序列
      // COUNTDOWN_TICK {val}   严格 1000ms 间隔单发：3 -> 2 -> 1
      // RACE_START             归零 -> 放行（**绝不缺失**）
      // 三条各自独立转发：main.js 侧再做 4.5s 本地兜底，任何一条丢失都能兜住。
      case 'START_SEQUENCE_BEGIN': this.emit('startSeq', m); break;
      case 'COUNTDOWN_TICK': this.emit('tick', m); break;
      case 'lights': this.emit('lights', m); break;
      case 'RACE_START': this.emit('raceStart', m); break;
      case 'start':
        this.countdown = -1;
        this.seed = m.seed;
        this.laps = m.laps;
        this.emit('start', m);
        break;
      case 'snap': {
        const now = Date.now();
        this._trackJitter(now);       // 自适应抖动缓冲：先按到达抖动刷新渲染延迟
        // 快照时间轴优先用**服务端单调时钟**（mts）换算到本地时间轴：
        // 单调时钟不受 NTP 校时/系统改时间影响，也不会因网络接收抖动而失真。
        const snapT = (Number.isFinite(m.mts) && Number.isFinite(this.monoOffset))
          ? (m.mts - this.monoOffset)
          : (Number.isFinite(m.ts) ? (m.ts - this.clockOffset) : now);
        if (this._workerInbound) {
          // snapT/now are both local wall-clock values.  Convert their delta
          // onto the page monotonic epoch before crossing into the Worker.
          const receivedAt = monoNow();
          const localMonoT = receivedAt + (snapT - now);
          this._workerInbound({ kind: 'snap', packet: m, snapT: localMonoT, receivedAt, renderDelay: this.renderDelay });
        }
        // 入力遥测（规格 §四.2）：从位姿包里抽出 u/b/e/h，供观战回显使用。
        // 只在 onInputTelemetry 回调存在时才做，避免无谓的对象分配。
        const tele = this._inputTelemetry;
        for (const entry of m.p) {
          if (!this._workerInbound) this.pushState(entry.id, entry.d, now, entry.f, snapT - Math.max(0, Number(entry.age) || 0));
          if (tele && entry.d) {
            tele(entry.id, entry.d.u, entry.d.b, entry.d.e, entry.d.h);
          }
        }
        this.emit('snap', m);
        break;
      }
      // Some server revisions forward bot/host state as a direct packet instead
      // of wrapping it in a snap. Keep that path worker-owned as well.
      case 'state': {
        if (this._workerInbound && m.id && m.d) {
          // 直传 state 的 ts 属于发送者的进程时间，不是本机时钟。
          const receivedAt = monoNow();
          this._workerInbound({ kind: 'state', packet: m, snapT: receivedAt, receivedAt, renderDelay: this.renderDelay });
        }
        break;
      }
      // 服务端权威榜单（20Hz）。字段：id/name/color/pos/lap/pen/fin/gap/int
      case 'LEADERBOARD_UPDATE': this.emit('leaderboard', m.data || []); break;
      case 'pen': this.emit('pen', m); break;
      case 'lap': this.emit('lap', m); break;
      case 'fin': this.emit('fin', m); break;
      case 'dnf': this.emit('dnf', m); break;
      case 'end': this.emit('end', m); break;
      // ── 规格 §二：全员完赛结算流 ──
      // RACE_RESULTS             全量完赛者（rank/name/bestLap/totalTime/points）
      // SEASON_LEADERBOARD_UPDATE 赛季榜最新快照（首页/大厅右侧实时重渲染）
      case 'RACE_RESULTS': this.emit('raceResults', m); break;
      case 'SEASON_LEADERBOARD_UPDATE': this.emit('seasonUpdate', m); break;
      case 'presence': this.emit('presence', m); break;
      case 'lobby': this.emit('lobby', m); break;
      case 'left': this.emit('left', m); break;
      // 一体化聊天总线（规格 §一.1）：
      // 玩家发言与系统事件/倒计时广播共用同一条 CHAT_MESSAGE 通道，
      // 因此倒计时消息天然与聊天行同层渲染 —— 不可能被任何面板遮挡（根因修复）。
      // 这里只做纯转发，不发任何网络请求；渲染与 XSS 防御全部在 main.js。
      case 'CHAT_MESSAGE': this.emit('chat', m); break;
      case 'err':
        console.warn('[net] 服务端:', m.msg);
        this.emit('serverError', m);
        break;
      default: break;
    }
  }

  /* --------------------------- 快照环形缓冲 --------------------------- */

  /**
   * 为某个远端玩家建立长度 64 的历史快照环形缓冲（规格）。
   * 全部用 TypedArray，零 GC；索引 k（0 = 最旧）-> 实际槽位。
   */
  ensurePlayer(id) {
    let p = this.players.get(id);
    if (!p) {
      p = {
        id,
        T: new Float64Array(BUF_LEN),      // 快照时间（本地时间轴，已扣除 clockOffset）
        P: new Float32Array(BUF_LEN * 3),  // 位置
        Q: new Float32Array(BUF_LEN * 4),  // 四元数
        V: new Float32Array(BUF_LEN * 3),  // 线速度（Hermite 切线 / 航位推测）
        M: new Float32Array(BUF_LEN * 2),  // speed(km/h), steer
        F: new Int32Array(BUF_LEN * 2),    // lap, slip
        head: 0, count: 0, lastT: -1e18,
        render: {
          pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
          // Dual-Layer（ForzaTech，规格 §一.3）：
          //   phys* = 物理层权威状态（直接矫正为网络数据）
          //   visual*Offset = 视觉平滑层偏移量（吸收矫正差值，exp(-20·dt) 衰减）
          physPos: new THREE.Vector3(), physRot: new THREE.Quaternion(),
          visualPosOffset: new THREE.Vector3(), visualRotOffset: new THREE.Quaternion(),
          speed: 0, steer: 0, lap: 0, slip: 0, finished: false,
        },
        has: false,
        extrapolating: false,
      };
      this.players.set(id, p);
    }
    return p;
  }

  /** 取第 k 个最旧快照的实际槽位 */
  slot(p, k) { return ((p.head - p.count + k) % BUF_LEN + BUF_LEN) % BUF_LEN; }

  /**
   * 写入一帧快照。serverTs 为服务端时间戳（毫秒）；换算到本地时间轴后入队。
   * 乱序包（时间戳早于队尾）直接丢弃 —— 单条 WebSocket 本就有序，这里是防御。
   */
  pushState(id, d, recv, finished, snapTimeLocal) {
    const p = this.ensurePlayer(id);
    // snapTimeLocal 已由 dispatch 换算到本地时间轴；缺失时退化到本地接收时间
    const t = (typeof snapTimeLocal === 'number' && isFinite(snapTimeLocal)) ? snapTimeLocal : recv;
    if (!Number.isFinite(t) || t < p.lastT) return;
    // 同一时间戳的广播可能补充完赛标记或输入遥测；按 Worker 缓冲语义
    // 替换队尾，不新增一个重复时间点。
    const replacing = p.count > 0 && t === p.lastT;
    const i = replacing ? (p.head - 1 + BUF_LEN) % BUF_LEN : p.head;
    p.T[i] = t;
    p.P[i * 3] = d.x; p.P[i * 3 + 1] = d.y; p.P[i * 3 + 2] = d.z;
    p.Q[i * 4] = d.q[0]; p.Q[i * 4 + 1] = d.q[1]; p.Q[i * 4 + 2] = d.q[2]; p.Q[i * 4 + 3] = d.q[3];
    p.V[i * 3] = d.v ? d.v[0] : 0; p.V[i * 3 + 1] = d.v ? d.v[1] : 0; p.V[i * 3 + 2] = d.v ? d.v[2] : 0;
    p.M[i * 2] = d.s || 0; p.M[i * 2 + 1] = d.t || 0;
    p.F[i * 2] = d.l || 0; p.F[i * 2 + 1] = d.k || 0;
    if (!replacing) {
      p.head = (p.head + 1) % BUF_LEN;
      if (p.count < BUF_LEN) p.count++;
    }
    p.lastT = t;
    p.finished ||= !!finished || !!d.f;
    while (p.count > 1 && t - p.T[this.slot(p, 0)] > MAX_BUFFER_SPAN_MS) p.count--;
    this.emit('state', { id, sample: { t } });
  }

  /**
   * 取某台远端车在当前渲染时刻的位姿。
   *   renderTime = 本地 now − 50ms
   *   夹在 SnapA/SnapB 之间 -> Hermite 位置插值 + SLERP 旋转插值
   *   超出最新快照 -> 按速度直线外推（Dead Reckoning）
   *   最后统一做指数误差融合，杜绝闪现
   */
  beginFrame(now) {
    const prev = this._frameStamp || (now - 16);
    this._interpDt = clamp((now - prev) / 1000, 0.001, 0.05);
    this._frameStamp = now;
  }

  renderState(id, now) {
    const p = this.players.get(id);
    if (!p || p.count === 0) return null;
    const r = p.render;
    const rt = now - this.renderDelay;      // 自适应延迟（clamp(3σ,60,120)）

    // ---- 定位夹帧：找到最后一个 T <= rt 的快照 ----
    let ka = -1;
    for (let k = p.count - 1; k >= 0; k--) {
      if (p.T[this.slot(p, k)] <= rt) { ka = k; break; }
    }
    const sb = ka + 1 < p.count ? this.slot(p, ka + 1) : -1;
    const sa = ka >= 0 ? this.slot(p, ka) : -1;

    if (sa >= 0 && sb >= 0) {
      // ================= 区间内：Hermite + SLERP =================
      const t0 = p.T[sa], t1 = p.T[sb];
      const span = Math.max(t1 - t0, 1e-4);
      const s = clamp((rt - t0) / span, 0, 1);
      const dtS = span / 1000;                       // 秒
      r.pos.set(
        hermite(p.P[sa * 3], p.V[sa * 3], p.P[sb * 3], p.V[sb * 3], s, dtS),
        hermite(p.P[sa * 3 + 1], p.V[sa * 3 + 1], p.P[sb * 3 + 1], p.V[sb * 3 + 1], s, dtS),
        hermite(p.P[sa * 3 + 2], p.V[sa * 3 + 2], p.P[sb * 3 + 2], p.V[sb * 3 + 2], s, dtS)
      );
      this._qa.set(p.Q[sa * 4], p.Q[sa * 4 + 1], p.Q[sa * 4 + 2], p.Q[sa * 4 + 3]);
      this._qb.set(p.Q[sb * 4], p.Q[sb * 4 + 1], p.Q[sb * 4 + 2], p.Q[sb * 4 + 3]);
      r.quat.copy(this._qa).slerp(this._qb, s);
      r.speed = p.M[sa * 2] + (p.M[sb * 2] - p.M[sa * 2]) * s;
      r.steer = p.M[sa * 2 + 1] + (p.M[sb * 2 + 1] - p.M[sa * 2 + 1]) * s;
      r.lap = p.F[sb * 2]; r.slip = p.F[sb * 2 + 1];
      p.extrapolating = false;
      this._target.set(r.pos.x, r.pos.y, r.pos.z);
    } else if (ka < 0) {
      // rt 早于最旧快照（刚接入/时钟跳变）：直接用最旧一帧，不插值
      const s0 = this.slot(p, 0);
      this._target.set(p.P[s0 * 3], p.P[s0 * 3 + 1], p.P[s0 * 3 + 2]);
      this._qa.set(p.Q[s0 * 4], p.Q[s0 * 4 + 1], p.Q[s0 * 4 + 2], p.Q[s0 * 4 + 3]);
      r.quat.copy(this._qa);
      r.speed = p.M[s0 * 2]; r.steer = p.M[s0 * 2 + 1];
      r.lap = p.F[s0 * 2]; r.slip = p.F[s0 * 2 + 1];
      p.extrapolating = false;
    } else {
      // ================= 超出最新快照：直线航位推测 =================
      const last = this.slot(p, p.count - 1);
      const dtMs = clamp(rt - p.T[last], 0, MAX_EXTRAP_MS);
      const dt = dtMs / 1000;
      this._target.set(
        p.P[last * 3] + p.V[last * 3] * dt,
        p.P[last * 3 + 1] + p.V[last * 3 + 1] * dt,
        p.P[last * 3 + 2] + p.V[last * 3 + 2] * dt
      );
      this._qa.set(p.Q[last * 4], p.Q[last * 4 + 1], p.Q[last * 4 + 2], p.Q[last * 4 + 3]);
      r.quat.copy(this._qa);
      r.speed = p.M[last * 2]; r.steer = p.M[last * 2 + 1];
      r.lap = p.F[last * 2]; r.slip = p.F[last * 2 + 1];
      p.extrapolating = true;
    }
    r.finished = p.finished;

    // ---- ForzaTech Dual-Layer Error Blending（规格 §一.3）----
    // 物理层 = 上面分支算出的插值/外推目标（权威）；视觉层 = 带偏移量的平滑壳。
    // 矫正前后产生的位移/姿态差值**吸收进偏移量**，再用 exp(-20·dt) 衰减消解 ——
    // 网络纠偏时画面是"滑过去"而不是"跳过去"，且**姿态也平滑**
    // （旧版只对位置做指数收敛，姿态是直接瞬甩的）。
    if (!p.has) {
      // 首次出现：物理层直接落位，偏移清零
      r.physPos.copy(this._target);
      r.physRot.copy(r.quat);
      r.visualPosOffset.set(0, 0, 0);
      r.visualRotOffset.identity();
      p.has = true;
    } else {
      // 记录矫正前的视觉空间状态
      const curVisualPos = this._vtmp.copy(r.physPos).add(r.visualPosOffset);
      const curVisualRot = this._qtmp.copy(r.physRot).multiply(r.visualRotOffset);
      // 物理层直接矫正为新数据
      r.physPos.copy(this._target);
      r.physRot.copy(r.quat);
      // 把矫正前后的差值吸收进视觉偏移
      // Always absorb corrections into the visual shell. The worker bounds
      // extrapolation and keeps rescue/teleport semantics explicit in state;
      // the renderer must never produce a hard distance-based visual jump.
      r.visualPosOffset.copy(curVisualPos).sub(r.physPos);
      r.visualRotOffset.copy(r.physRot).invert().multiply(curVisualRot);
    }
    // 每帧衰减消解（规格系数 20.0）
    const bf = Math.exp(-ERR_BLEND * this._interpDt);
    r.visualPosOffset.multiplyScalar(bf);
    r.visualRotOffset.slerp(this._qid, 1 - bf);
    // 最终提交给渲染的变换 = 物理层 + 视觉偏移
    r.pos.copy(r.physPos).add(r.visualPosOffset);
    r.quat.copy(r.physRot).multiply(r.visualRotOffset);
    return r;
  }

  dropPlayer(id) { this.players.delete(id); }
  reset() { this.players.clear(); this.countdown = -1; this.lobby = []; }
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
// 入力遥测字段的夹取（防止 NaN 或越界值污染报文的 JSON）。
// 注意：本文件顶部已有通用 clamp(v,a,b)，这里只补一个 [0,1] 版本。
const clamp01 = (v) => clamp(Number(v) || 0, 0, 1);
```

### 文件: public/js/physics-protocol.js

```javascript
/* Worker transport contract. Keep this file free of Cannon/DOM imports. */
export const PHYSICS_DT = 1 / 60;
export const PHYSICS_STATE_HZ = 60;
export const INPUT_HZ = 60;
export const MAX_EXTRAP_MS = 250;

// Main-thread rendering/audio constants mirrored from physics.js. Loading physics.js
// in main would pull Cannon into the renderer, so this is deliberately a small copy.
export const RENDER_CFG = Object.freeze({
  IDLE_RPM: 1100,
  REDLINE_RPM: 7500,
  RIDE_H: 0.62,
  WHEEL: [[-0.80, 1.35], [0.80, 1.35], [-0.80, -1.35], [0.80, -1.35]],
  GHOST_OPACITY: 0.38,
  GHOST_MODE_OPACITY: 0.28,
  TURBULENCE_HZ: 24,
  TURBULENCE_AMP: 0.012,
  DRAFT_FOV_KICK: 1.5,
  GRIP_ROAD: 2.4,
  MAX_TIME_WARP: 0.015,
});

// One Float32Array record per car. The first value is the integer id; all values
// are transport data, never object references. Adding fields requires appending
// before STATE_STRIDE is consumed by both sides.
export const STATE = Object.freeze({
  ID: 0,
  PX: 1, PY: 2, PZ: 3,
  QX: 4, QY: 5, QZ: 6, QW: 7,
  VX: 8, VY: 9, VZ: 10,
  PPX: 11, PPY: 12, PPZ: 13,
  PQX: 14, PQY: 15, PQZ: 16, PQW: 17,
  SPEED: 18, SPEED_KMH: 19, SPEED_KMH_MEASURED: 20,
  FORWARD_SPEED: 21, LATERAL_SPEED: 22,
  RPM: 23, GEAR: 24,
  LAP: 25, BEST_LAP: 26, LAP_TIME: 27, LAST_LAP: 28,
  PENALTY: 29, VIOLATIONS: 30,
  SLIP: 31, SLIP_ANGLE: 32, SLIP_RATIO: 33, WHEELSPIN: 34,
  DRIFT: 35, STEER_ANGLE: 36, AY_PREV: 37,
  WRONG_WAY: 38, TRACK_IDX: 39, LINE_CROSS: 40, PROGRESS: 41,
  GHOST: 42, GHOST_TIMER: 43,
  RESCUE_GHOST: 44, FINISH_GHOST: 45, ZONE_GHOST: 46,
  FINISHED: 47, RETIRED: 48, TOTAL_TIME: 49, FINISH_TIME: 50, RANK: 51,
  RACE_LOCKED: 52, CP_IDX: 53,
  WGY0: 54, WGY1: 55, WGY2: 56, WGY3: 57,
  SUSP0: 58, SUSP1: 59, SUSP2: 60, SUSP3: 61,
  AX: 62, SURFACE: 63, AIRBORNE: 64,
  THROTTLE: 65, BRAKE: 66, STEER: 67, HANDBRAKE: 68,
  INPUT_SEQ: 69,
  TIRE_TEMP0: 70, TIRE_TEMP1: 71, TIRE_TEMP2: 72, TIRE_TEMP3: 73,
  TIRE_GRIP: 74,
  GHOST_REASON: 75, YAW_SPEED: 76, GROUND_Y: 77, SUSPENSION: 78, PG_GHOST: 79,
  ROAD_NX: 80, ROAD_NY: 81, ROAD_NZ: 82, CURB_H: 83,
  LAP_INVALID: 84, BEST_CLEAN_LAP: 85, CHECKPOINT_PROGRESS: 86, CROSSED_START: 87,
});
export const STATE_STRIDE = 88;
export const REMOTE_STRIDE = 35;

export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

export function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function trackForWorker(track) {
  if (!track) return null;
  // Track math is deterministic from seed/type. Only the generated static boxes
  // cross the boundary; this avoids cloning Three/Cannon instances.
  const colliders = Array.isArray(track.colliders) ? track.colliders.map((c) => ({
    x: finite(c.x), y: finite(c.y), z: finite(c.z),
    qx: finite(c.qx), qy: finite(c.qy), qz: finite(c.qz), qw: finite(c.qw, 1),
    hx: Math.max(0.01, finite(c.hx)), hy: Math.max(0.01, finite(c.hy)), hz: Math.max(0.01, finite(c.hz)),
    barrierMain: !!c.barrierMain,
    barrierExpectedYaw: finite(c.barrierExpectedYaw),
    barrierExpectedAxisY: finite(c.barrierExpectedAxisY),
  })) : [];
  return { seed: track.seed >>> 0, trackType: track.trackType || 'suzuka', colliders };
}

export function buildStateArray(cars, out) {
  const need = Math.max(1, cars.length) * STATE_STRIDE;
  const a = out && out.length >= need ? out : new Float32Array(need);
  const put = (o, c, i) => {
    const n = (v, d = 0) => finite(v, d);
    const p = c.pos || { x: 0, y: 0, z: 0 };
    const q = c.quat || { x: 0, y: 0, z: 0, w: 1 };
    const v = c.vel || { x: 0, y: 0, z: 0 };
    const pp = c.prevPos || p, pq = c.prevQuat || q;
    o.fill(0, i, i + STATE_STRIDE);
    o[i + STATE.ID] = n(c.id);
    o[i + STATE.PX] = n(p.x); o[i + STATE.PY] = n(p.y); o[i + STATE.PZ] = n(p.z);
    o[i + STATE.QX] = n(q.x); o[i + STATE.QY] = n(q.y); o[i + STATE.QZ] = n(q.z); o[i + STATE.QW] = n(q.w, 1);
    o[i + STATE.VX] = n(v.x); o[i + STATE.VY] = n(v.y); o[i + STATE.VZ] = n(v.z);
    o[i + STATE.PPX] = n(pp.x); o[i + STATE.PPY] = n(pp.y); o[i + STATE.PPZ] = n(pp.z);
    o[i + STATE.PQX] = n(pq.x); o[i + STATE.PQY] = n(pq.y); o[i + STATE.PQZ] = n(pq.z); o[i + STATE.PQW] = n(pq.w, 1);
    o[i + STATE.SPEED] = n(c.speed); o[i + STATE.SPEED_KMH] = n(c.speedKmh);
    o[i + STATE.SPEED_KMH_MEASURED] = n(c.speedKmhMeasured);
    o[i + STATE.FORWARD_SPEED] = n(c.forwardSpeed); o[i + STATE.LATERAL_SPEED] = n(c.lateralSpeed);
    o[i + STATE.RPM] = n(c.rpm, RENDER_CFG.IDLE_RPM); o[i + STATE.GEAR] = n(c.gear, 1);
    o[i + STATE.LAP] = n(c.lap); o[i + STATE.BEST_LAP] = n(c.bestLap);
    o[i + STATE.LAP_TIME] = n(c.lapTimeLive); o[i + STATE.LAST_LAP] = n(c.lastLap);
    o[i + STATE.PENALTY] = n(c.penalty); o[i + STATE.VIOLATIONS] = n(c.violations);
    o[i + STATE.SLIP] = n(c.slip); o[i + STATE.SLIP_ANGLE] = n(c.slipAngleDeg);
    o[i + STATE.SLIP_RATIO] = n(c.slipRatio); o[i + STATE.WHEELSPIN] = n(c.wheelspin);
    o[i + STATE.DRIFT] = n(c.driftIntensity); o[i + STATE.STEER_ANGLE] = n(c.steerAngle);
    o[i + STATE.AY_PREV] = n(c.ayPrev); o[i + STATE.WRONG_WAY] = c.wrongWay ? 1 : 0;
    o[i + STATE.TRACK_IDX] = n(c.trackIdx); o[i + STATE.LINE_CROSS] = n(c.lineCross);
    o[i + STATE.PROGRESS] = n(c.progressScore || c.progress);
    o[i + STATE.GHOST] = n(c.ghost); o[i + STATE.GHOST_TIMER] = n(c.ghostTimer);
    o[i + STATE.RESCUE_GHOST] = c.rescueGhost ? 1 : 0; o[i + STATE.FINISH_GHOST] = c.finishGhost ? 1 : 0;
    o[i + STATE.ZONE_GHOST] = c.zoneGhost ? 1 : 0; o[i + STATE.FINISHED] = c.finished ? 1 : 0;
    o[i + STATE.RETIRED] = c.retired ? 1 : 0; o[i + STATE.TOTAL_TIME] = n(c.totalTime);
    o[i + STATE.FINISH_TIME] = n(c.finishTime); o[i + STATE.RANK] = n(c.rank);
    o[i + STATE.RACE_LOCKED] = c.raceLocked ? 1 : 0; o[i + STATE.CP_IDX] = n(c.cpIdx);
    // suspCompression 在 Worker（physics.js Car）与主线程镜像里都是**标量**；
    // 这里对逐轮槽位做一次兼容读取，避免任何一端误把它当数组时写入 NaN。
    const wg = c.wheelGroundY || [], sc = Array.isArray(c.suspCompression) ? c.suspCompression : null;
    for (let k = 0; k < 4; k++) { o[i + STATE.WGY0 + k] = n(wg[k]); o[i + STATE.SUSP0 + k] = n(sc ? sc[k] : 0); }
    o[i + STATE.AX] = n(c.axMeasured); o[i + STATE.SURFACE] = n(c.surface); o[i + STATE.AIRBORNE] = c.airborne ? 1 : 0;
    const inp = c.remote ? c : c.input || {};
    o[i + STATE.THROTTLE] = n(inp.throttle); o[i + STATE.BRAKE] = n(inp.brake);
    o[i + STATE.STEER] = n(inp.steer); o[i + STATE.HANDBRAKE] = n(inp.handbrake);
    o[i + STATE.INPUT_SEQ] = n(c._inputSeq);
    const tireTemp = c.tireTemp || [];
    for (let k = 0; k < 4; k++) o[i + STATE.TIRE_TEMP0 + k] = n(tireTemp[k], 80);
    o[i + STATE.TIRE_GRIP] = n(c.tireGrip, 1);
    o[i + STATE.GHOST_REASON] = n(c.ghostReasonCode);
    o[i + STATE.YAW_SPEED] = n(c.body?.angularVelocity?.y);
    o[i + STATE.GROUND_Y] = n(c.groundY);
    o[i + STATE.SUSPENSION] = n(c.suspCompression);
    o[i + STATE.PG_GHOST] = c.pgGhost ? 1 : 0;
    const rn = c.roadNormal || c.up || {};
    o[i + STATE.ROAD_NX] = n(rn.x); o[i + STATE.ROAD_NY] = n(rn.y, 1); o[i + STATE.ROAD_NZ] = n(rn.z);
    o[i + STATE.CURB_H] = n(c.curbH);
    o[i + STATE.LAP_INVALID] = c.lapInvalid ? 1 : 0;
    o[i + STATE.BEST_CLEAN_LAP] = n(c.bestCleanLap);
    o[i + STATE.CHECKPOINT_PROGRESS] = n(c.progress);
    o[i + STATE.CROSSED_START] = c.crossedStart ? 1 : 0;
  };
  for (let k = 0; k < cars.length; k++) put(a, cars[k], k * STATE_STRIDE);
  return a;
}
```

### 文件: public/js/PhysicsWorkerBridge.js

```javascript
import { PHYSICS_DT, STATE, STATE_STRIDE, REMOTE_STRIDE, trackForWorker, RENDER_CFG } from './physics-protocol.js';

const V3 = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();
const nowMono = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const n = (v, d = 0) => Number.isFinite(v) ? v : d;
// 定点量化（用于上行报文，见 _publishNetwork 的说明）。纯算术取整，不产生临时字符串。
const r1 = (v) => Math.round(n(v) * 10) / 10;
const r2 = (v) => Math.round(n(v) * 100) / 100;
const r3 = (v) => Math.round(n(v) * 1000) / 1000;
const r4 = (v) => Math.round(n(v) * 1e4) / 1e4;
// 驾驶规则三态（与 main.go sanitizeGameMode 必须一致）。
const normalizeGameMode = (mode) => (mode === 'horizon' ? 'horizon' : mode === 'bumper' ? 'bumper' : 'fm8');

class CarMirror {
  constructor(opts) {
    Object.assign(this, opts);
    this.id = opts.id;
    this.name = opts.name || ('车手' + opts.id);
    this.color = opts.color || '#e10600';
    this.isLocal = !!opts.isLocal;
    this.remote = !!opts.remote;
    this.ai = !!opts.ai;
    this.auto = !!opts.ai && !this.remote;
    this.engineProfile = opts.engine || opts.engineProfile || 'i6gt';
    this.engine = this.engineProfile;
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.pos = V3(); this.prevPos = V3(); this.quat = Q(); this.prevQuat = Q();
    this.vel = V3(); this.fwd = V3(); this.lateralDir = V3(); this.rightSide = V3(); this.up = V3();
    this.body = { position: this.pos, quaternion: this.quat, velocity: this.vel };
    this.wheelGroundY = [0, 0, 0, 0]; this.suspCompression = 0;   // 与 Worker 侧 physics.js 一致：标量（正=压缩）
    this.finished = false; this.retired = false; this.totalTime = 0; this.finishTime = 0; this.rank = 0;
    this.throttle = 0; this.brake = 0; this.steer = 0; this.handbrake = 0;
    this.lap = 0; this.bestLap = 0; this.bestCleanLap = 0; this.lastLap = 0; this.lapTimeLive = 0; this.lapInvalid = false; this.penalty = 0; this.violations = 0;
    this.speed = 0; this.speedKmh = 0; this.speedKmhMeasured = 0; this.forwardSpeed = 0; this.lateralSpeed = 0;
    this.rpm = RENDER_CFG.IDLE_RPM; this.gear = 1; this.slip = 0; this.slipAngleDeg = 0; this.slipRatio = 0;
    this.wheelspin = 0; this.driftIntensity = 0; this.steerAngle = 0; this.ayPrev = 0; this.wrongWay = false;
    this.tireTemp = [80, 80, 80, 80]; this.tireGrip = 1;
    this.trackIdx = 0; this.lineCross = 0; this.progressScore = 0; this.ghost = 0; this.ghostTimer = 0;
    this.rescueGhost = false; this.finishGhost = false; this.zoneGhost = false; this.raceLocked = true;
    this.cpIdx = -1; this.axMeasured = 0; this.surface = 0; this.airborne = false; this._inputSeq = 0;
  }
  addPenalty(sec, reason) { this.penalty += Math.max(0, n(sec)); this.lastPenaltyReason = reason || ''; }
  rearContactPoint(side, out = V3()) { return out.copy(this.pos).addScaledVector(this.fwd, -1.35).addScaledVector(this.lateralDir, side * 0.8); }
}

export class PhysicsWorkerBridge {
  constructor({ track, seed, trackType, localId = 0, hostId = localId, grid = null, roster = [], laps = 3, ghost = false, gameMode = 'fm8', workerUrl } = {}) {
    this.track = track || null;
    this.seed = (seed >>> 0) || (track && track.seed) || 0;
    this.trackType = trackType || (track && track.trackType) || 'suzuka';
    this.localId = localId;
    this.hostId = hostId;
    this.laps = laps;
    // 服务端权威发车格（id -> slot）。必须存成实例字段：_normalizeCarOpts 与
    // addCar 都要读它，此前只作为构造参数被 roster 闭包捕获。
    this.grid = grid || null;
    this.cars = [];
    this.byId = new Map();
    this.time = 0;
    this.physicsStep = -1;
    this.lastContactDetails = [];
    this.alpha = 0;
    this._racing = false;
    this.timeAligned = false;
    this.gameMode = normalizeGameMode(gameMode);
    // 碰碰车模式要求全程实体对抗 ⇒ 忽略 ghost 参数（服务端也会强制，这里是客户端侧冗余）。
    this.ghostMode = this.gameMode === 'bumper' ? false : !!ghost;
    this.ready = false;
    this.disposed = false;
    this._inputSeq = 0;
    this._inputPool = [];
    this._remotePool = [];
    this._networkSeq = 0; this._lastNetworkNow = -Infinity;
    this._stateNow = null;
    // Worker performance.now() has its own monotonic epoch.  Keep one explicit
    // conversion into the page epoch instead of inferring it from timeOrigin.
    this._workerToMainMonoOffset = 0;
    this._events = new Map();
    this._diagnosticId = 0;
    this._diagnostics = new Map();
    this.onNetwork = null;
    const url = workerUrl || new URL('./physics.worker.js', import.meta.url);
    this.worker = new Worker(url, { type: 'module', name: 'fm8-physics' });
    this.readyPromise = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject; });
    this.worker.onmessage = (ev) => this._message(ev.data || {});
    this.worker.onerror = (ev) => { const e = new Error(ev.message || 'physics worker error'); this._rejectReady(e); this._emit('error', e); };
    // 与 addCar 共用同一套归一化（见 _normalizeCarOpts），避免两条路径行为漂移。
    const workerRoster = roster.map((x, index) => {
      const opts = this._normalizeCarOpts(x, index);
      const car = new CarMirror(opts);
      this.cars.push(car); this.byId.set(car.id, car);
      return opts;
    });
    this.worker.postMessage({
      type: 'init', localId: this.localId, laps: this.laps, ghost: this.ghostMode, gameMode: this.gameMode,
      track: trackForWorker(this.track) || { seed: this.seed, trackType: this.trackType, colliders: [] },
      roster: workerRoster,
    });
  }
  on(type, fn) { if (!this._events.has(type)) this._events.set(type, []); this._events.get(type).push(fn); return this; }
  get racing() { return this._racing; }
  set racing(value) { this.setRunning(value); }
  _emit(type, data) { for (const fn of this._events.get(type) || []) { try { fn(data); } catch (e) { console.error('[physics bridge]', type, e); } } }
  prewarm() { return this.readyPromise; }
  async requestDiagnostics(durationMs = 2000) {
    await this.readyPromise;
    if (this.disposed) throw new Error('physics worker disposed');
    const duration = Math.max(250, Math.min(5000, n(durationMs, 2000)));
    const id = ++this._diagnosticId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._diagnostics.delete(id);
        reject(new Error('physics diagnostics timeout'));
      }, duration + 5000);
      this._diagnostics.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'diagnostics', id, duration });
    });
  }
  renderAlpha(now = nowMono()) {
    if (this._stateNow === null) return 0;
    // Worker 包晚到时只预测一物理步的显示位置，避免每次等包都硬停。
    return Math.max(0, Math.min(2, this.alpha + Math.max(0, now - this._stateNow) / (PHYSICS_DT * 1000)));
  }
  _postWhenReady(message, transfer = []) { this.readyPromise.then(() => { if (!this.disposed) this.worker.postMessage(message, transfer); }).catch(() => {}); }
  /**
   * 追加一台车（中途加入 / 补席位）。
   *
   * ⚠️ 必须与构造函数的 roster 路径**走同一套归一化**：`isLocal` / `remote` /
   * `startIndex` / `lateral` 与发车格位姿都要在这里补齐。否则中途加入的车
   * `isLocal=false, remote=false` —— 既不会被 `_publishNetwork` 上报（它的车永远
   * 停在对端起点），本地镜像又停在 (0,0,0)。构造函数里那段逻辑此前只对 roster
   * 生效，`addCar` 走的是裸 `{...opts}`，两条路径的行为不一致。
   */
  addCar(opts) {
    const existing = this.byId.get(opts.id);
    if (existing) return existing;
    const normalized = this._normalizeCarOpts(opts, this.cars.length);
    const c = new CarMirror(normalized);
    this.cars.push(c);
    this.byId.set(c.id, c);
    this._postWhenReady({ type: 'addCar', car: normalized });
    return c;
  }
  /**
   * 把外部传入的车辆描述归一化成 Worker 与本地镜像**共用的一份定义**：
   * 由发车格（服务端 grid 或 track.gridSlot）推出 startIndex/lateral，
   * 并按本机视角补齐 isLocal / remote。构造函数与 addCar 必须共用它。
   */
  _normalizeCarOpts(x, index = this.cars.length) {
    const slot = Math.max(1, Number(this.grid?.[String(x.id)] || x.gridSlot || x.slot || x.id || index + 1) | 0);
    const pose = this.track && typeof this.track.gridSlot === 'function' ? this.track.gridSlot(slot) : null;
    const isLocal = x.isLocal ?? (x.id === this.localId);
    return {
      ...x,
      isLocal,
      remote: x.remote ?? (!isLocal && (!x.ai || this.hostId !== this.localId)),
      startIndex: Number.isFinite(x.startIndex) ? x.startIndex : (pose ? pose.index : 0),
      lateral: Number.isFinite(x.lateral) ? x.lateral : (pose ? pose.lateral : 0),
      laps: x.laps || this.laps,
      raceLocked: true,
    };
  }
  removeCar(id) { this._postWhenReady({ type: 'removeCar', id }); const c = this.byId.get(id); if (c) { this.byId.delete(id); const i = this.cars.indexOf(c); if (i >= 0) this.cars.splice(i, 1); } }
  clear() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.ready) this._rejectReady(new Error('physics worker disposed'));
    for (const pending of this._diagnostics.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('physics worker disposed'));
    }
    this._diagnostics.clear();
    try { this.worker.postMessage({ type: 'dispose' }); } catch (e) { /* worker already gone */ }
    this.worker.terminate(); this.cars.length = 0; this.byId.clear(); this._racing = false;
  }
  dispose() { this.clear(); }
  start() { this._postWhenReady({ type: 'start' }); }
  setRunning(value) {
    const next = !!value;
    if (next === this._racing) return;
    this._racing = next;
    this._postWhenReady({ type: 'running', value: next });
  }
  setGhostMode(value) {
    // 碰碰车模式与幽灵车互斥：该模式下任何开启请求都被压低为 false。
    this.ghostMode = this.gameMode === 'bumper' ? false : !!value;
    this._postWhenReady({ type: 'setGhost', value: this.ghostMode });
  }
  setGameMode(value) {
    this.gameMode = normalizeGameMode(value);
    if (this.gameMode === 'bumper') this.ghostMode = false;
    this._postWhenReady({ type: 'setGameMode', value: this.gameMode });
  }
  setHost(hostId) {
    if (hostId === this.hostId) return;
    this.hostId = hostId;
    for (const c of this.cars) if (c.ai) { c.remote = hostId !== this.localId; c.auto = !c.remote; }
    this._postWhenReady({ type: 'aiHost', local: hostId === this.localId });
  }
  setRemoteInput(id, thr, brk, steer, hand) {
    const c = this.byId.get(id);
    if (!c) return;
    c.input.throttle = n(thr); c.input.brake = n(brk); c.input.steer = n(steer); c.input.handbrake = hand ? 1 : 0;
    c.throttle = c.input.throttle; c.brake = c.input.brake; c.steer = c.input.steer; c.handbrake = c.input.handbrake;
  }
  applyRemoteTarget() { /* remote history and kinematic proxies live in the worker */ }
  sendInput(car, timestamp = nowMono()) {
    if (!car || this.disposed) return;
    let a = this._inputPool.pop();
    if (!a || a.length !== 4) a = new Float32Array(4);
    a[0] = n(car.input && car.input.throttle); a[1] = n(car.input && car.input.brake);
    a[2] = n(car.input && car.input.steer); a[3] = n(car.input && car.input.handbrake);
    const seq = ++this._inputSeq;
    this._postWhenReady({ type: 'input', id: car.id || this.localId, seq, timestamp: n(timestamp), values: a, buffer: a.buffer }, [a.buffer]);
  }
  rescueToCheckpoint(car) { this._postWhenReady({ type: 'rescue', id: car && car.id ? car.id : this.localId }); }
  // 兼容旧版 RacePhysics 的外部回调入口；正式比赛事件由 Worker 转发。
  onLap(car, lap, time, dirty = false) { if (car) this._emit('lap', { car, lap, time, dirty }); }
  onIncident(car, info = {}) { if (car) this._emit('incident', { car, info }); }
  finishCar(car) {
    if (!car) return;
    car.finished = true;
    if (car.ai) car.finishGhost = true;
    this._postWhenReady({ type: 'finish', id: car.id });
  }
  /**
   * 取一块远端样本缓冲。优先复用 Worker 归还的缓冲，避免 60Hz × N 车每包
   * `new Float32Array(...)` 造成的持续分配（GC 抖动会直接表现为远端车"顿一下"）。
   */
  _acquireRemoteBuffer(size) {
    for (let i = this._remotePool.length - 1; i >= 0; i--) {
      const b = this._remotePool[i];
      if (b.byteLength >= size * 4) {
        this._remotePool.splice(i, 1);
        return new Float32Array(b, 0, size);
      }
    }
    return new Float32Array(Math.max(REMOTE_STRIDE, size));
  }
  handleNetworkPacket(packet) {
    const rawList = packet.kind === 'snap' ? packet.packet?.p || [] : packet.kind === 'state' ? [packet.packet] : [];
    // 先计可用条目；不用 Array.prototype.filter —— 那会为每个 60Hz 网络包
    // 分配一个中间数组，正是本次要消除的垃圾来源。
    let count = 0;
    for (let i = 0; i < rawList.length; i++) {
      const e = rawList[i];
      if (e && e.d) count++;
    }
    if (!count) return;
    const a = this._acquireRemoteBuffer(count * REMOTE_STRIDE);
    let k = 0;
    for (let idx = 0; idx < rawList.length && k < count; idx++) {
      const e = rawList[idx];
      if (!e || !e.d) continue;
      const d = e.d, i = k * REMOTE_STRIDE, q = d.q || [], v = d.v || [];
      // Network supplies timestamps in the page's monotonic epoch.  The Worker
      // history is keyed by its own performance.now() epoch, so convert exactly
      // once at this boundary.
      a[i] = e.id; a[i+1] = n(packet.snapT, nowMono()) - Math.max(0, n(e.age)) - this._workerToMainMonoOffset;
      a[i+2] = n(d.x); a[i+3] = n(d.y); a[i+4] = n(d.z);
      for (let j=0;j<4;j++) a[i+5+j] = n(q[j], j===3 ? 1 : 0);
      for (let j=0;j<3;j++) a[i+9+j] = n(v[j]);
      a[i+12] = n(d.u); a[i+13] = n(d.b); a[i+14] = n(d.e); a[i+15] = n(d.h);
      a[i+16] = e.f || d.f ? 1 : 0; a[i+17] = n(d.l); a[i+18] = n(d.s);
      a[i+19] = n(d.gr); a[i+20] = n(d.go);
      a[i+21] = n(d.c, -1); a[i+22] = n(d.lt); a[i+23] = n(d.bl); a[i+24] = n(d.bc);
      a[i+25] = n(d.pen); a[i+26] = n(d.vio); a[i+27] = d.li ? 1 : 0; a[i+28] = n(d.pr);
      a[i+29] = d.cs ? 1 : 0; a[i+30] = n(d.lc); a[i+31] = n(d.ll); a[i+32] = n(d.ft); a[i+33] = n(d.tt);
      a[i+34] = n(e.seq);
      k++;
    }
    this._postWhenReady({ type:'remoteSamples', count, stride:REMOTE_STRIDE, renderDelay:n(packet.renderDelay,80), buffer:a.buffer }, [a.buffer]);
  }
  /**
   * 位姿上报（30Hz，Worker 拥有真实物理状态后由它驱动）。
   *
   * ★ 定点量化（问题 5：降低网络体积与序列化开销）
   *   此前 `JSON.stringify` 会把每个 double 写成 17~18 位十进制（"12.345678901234567"），
   *   一包 state 里 x/y/z + q(4) + v(3) + t 共 11 个浮点 ⇒ 光小数位就吃掉 ~150 字节，
   *   30Hz × 12 车在服务端就是每秒数千个 JSON 解析的对象更替。按**语义精度**量化后
   *   单包体积降约 1/3，而分辨率远细于任何下游判据：
   *     · 位置/姿态 r3 (1e-3)  —— 亚毫米级，远细于渲染插值与 0.03m 穿透容差
   *     · 四元数 r4 (1e-4)     —— 约 0.01°，SLERP 前还会归一化
   *     · 速度 r1 (0.1 m/s)、油门/刹车/转向 r2
   *     · 样条 p 用 r4 (1e-4 圈) —— 服务端通过时刻表分辨率是 1/1024 圈(约 6.6m)，
   *       1e-4 圈(约 0.19m) 比它细 30 倍 ⇒ 不改变任何切片判定
   */
  _publishNetwork(now) {
    if (!this.onNetwork || now - this._lastNetworkNow < 1000 / 30) return;
    this._lastNetworkNow = now;
    for (const c of this.cars) {
      if (c.remote) continue;
      const p = c.pos, q = c.quat, v = c.vel, cp = this.track?.checkpoints || [];
      const next = cp.length ? cp[((c.cpIdx + 1) % cp.length + cp.length) % cp.length] : null;
      const distNext = next?.pos ? Math.hypot(p.x-next.pos.x,p.z-next.pos.z) : 0;
      const count = this.track?.count || 1;
      // ⚠️ 发车格在起终点线**之前** ⇒ trackIdx ≈ count-k，原始归一化样条 p ≈ 0.98~0.99。
      //    原样上报会让服务端把"还没起步的车"当成已跑完 99% 圈来记录样条通过时刻，
      //    起步后头几秒的秒差列会按一个并不存在的 0.99 截面解算。
      //    未压过起终点线（crossedStart=false）时的这一整段统一钳为 0：
      //    语义 = "第 0 圈尚未开始"，与服务端 case "state" 里的同口径钳位互为冗余。
      const rawSpline = ((c.trackIdx % count) + count) % count / count;
      const spline = (!c.crossedStart && c.lap === 0 && rawSpline > 0.8) ? 0 : rawSpline;
      this.onNetwork({t:'state',id:c.id,seq:++this._networkSeq,d:{
        x:r3(p.x),y:r3(p.y),z:r3(p.z),
        q:[r4(q.x),r4(q.y),r4(q.z),r4(q.w)],
        v:[r1(v.x),r1(v.y),r1(v.z)],
        s:Math.round(c.speedKmh),t:r2(c.steerAngle),
        l:c.lap,c:c.cpIdx,n:r1(distNext),p:r4(spline),
        k:c.slip>0.5?1:0,f:c.finished?1:0,
        u:r2(c.throttle),b:r2(c.brake),e:r2(c.steer),h:c.handbrake?1:0,
        gr:c.ghostReasonCode,go:c.ghost,
        lt:r3(c.lapTimeLive),bl:r3(c.bestLap),bc:r3(c.bestCleanLap),
        pen:r2(c.penalty),vio:c.violations,li:c.lapInvalid?1:0,
        pr:r1(c.progress),cs:c.crossedStart?1:0,lc:c.lineCross,ll:r3(c.lastLap),
        ft:r3(c.finishTime),tt:r3(c.totalTime),
      }});
    }
  }
  _message(m) {
    if (m.type === 'ready') {
      this.ready = true;
      const workerNow = Number.isFinite(m.clockNow) ? m.clockNow : null;
      this._workerToMainMonoOffset = workerNow === null ? 0 : nowMono() - workerNow;
      this._resolveReady(m); this._emit('ready', m); return;
    }
    if (m.type === 'recycleInput' && m.buffer) { this._inputPool.push(new Float32Array(m.buffer)); return; }
    if (m.type === 'recycleRemote' && m.buffer) { this._remotePool.push(m.buffer); return; }
    if (m.type === 'network') { if (this.onNetwork) this.onNetwork(m.packet); this._emit('network', m.packet); return; }
    if (m.type === 'error') { const e = new Error(m.message || 'physics worker failure'); this._emit('error', e); if (!this.ready) this._rejectReady(e); return; }
    if (m.type === 'event') { this._applyEvent(m.name, m.payload || {}); return; }
    if (m.type === 'diagnostics') {
      const pending = this._diagnostics.get(m.id);
      if (pending) {
        this._diagnostics.delete(m.id); clearTimeout(pending.timer);
        m.error ? pending.reject(new Error(m.error)) : pending.resolve(m.data);
      }
      return;
    }
    if (m.type !== 'state' || !m.buffer) return;
    const a = new Float32Array(m.buffer);
    this.time = n(m.time); this.alpha = Math.max(0, Math.min(1, n(m.alpha)));
    this._stateNow = n(m.now, nowMono()) + this._workerToMainMonoOffset;
    const count = Math.min(m.count | 0, Math.floor(a.length / (m.stride || STATE_STRIDE)));
    const stride = m.stride || STATE_STRIDE;
    this.physicsStep = n(m.step, -1);
    this.lastContactDetails = Array.isArray(m.contactDetails) ? m.contactDetails : [];
    for (let k = 0; k < count; k++) {
      this._applyRecord(a, k * stride);
      const car = this.byId.get(Math.round(a[k * stride + STATE.ID]));
      if (car) {
        car.contact = !!((m.contactMask | 0) & (1 << k));
        car.terrainContact = !!((m.terrainContactMask | 0) & (1 << k));
        car.contactDetails = Array.isArray(m.contactDetails?.[k]) ? m.contactDetails[k] : [];
      }
    }
    this._publishNetwork(this._stateNow);
    this._emit('state', { seq: m.seq, now: m.now, count });
    this.worker.postMessage({ type: 'recycleState', buffer: m.buffer }, [m.buffer]);
  }
  _applyRecord(a, i) {
    const id = Math.round(a[i + STATE.ID]);
    const c = this.byId.get(id); if (!c) return;
    c.prevPos.set(a[i + STATE.PPX], a[i + STATE.PPY], a[i + STATE.PPZ]);
    c.prevQuat.set(a[i + STATE.PQX], a[i + STATE.PQY], a[i + STATE.PQZ], a[i + STATE.PQW]);
    c.pos.set(a[i + STATE.PX], a[i + STATE.PY], a[i + STATE.PZ]); c.quat.set(a[i + STATE.QX], a[i + STATE.QY], a[i + STATE.QZ], a[i + STATE.QW]);
    c.vel.set(a[i + STATE.VX], a[i + STATE.VY], a[i + STATE.VZ]); c.body.position = c.pos; c.body.quaternion = c.quat; c.body.velocity = c.vel;
    c.fwd.set(0, 0, 1).applyQuaternion(c.quat);
    c.up.set(0, 1, 0).applyQuaternion(c.quat);
    c.lateralDir.set(1, 0, 0).applyQuaternion(c.quat); c.rightSide.copy(c.lateralDir).multiplyScalar(-1);
    c.speed = a[i + STATE.SPEED]; c.speedKmh = a[i + STATE.SPEED_KMH]; c.speedKmhMeasured = a[i + STATE.SPEED_KMH_MEASURED];
    c.forwardSpeed = a[i + STATE.FORWARD_SPEED]; c.lateralSpeed = a[i + STATE.LATERAL_SPEED]; c.rpm = a[i + STATE.RPM]; c.gear = a[i + STATE.GEAR];
    c.lap = a[i + STATE.LAP]; c.bestLap = a[i + STATE.BEST_LAP]; c.lapTimeLive = a[i + STATE.LAP_TIME]; c.lastLap = a[i + STATE.LAST_LAP]; c.penalty = a[i + STATE.PENALTY]; c.violations = a[i + STATE.VIOLATIONS];
    c.slip = a[i + STATE.SLIP]; c.slipAngleDeg = a[i + STATE.SLIP_ANGLE]; c.slipRatio = a[i + STATE.SLIP_RATIO]; c.wheelspin = a[i + STATE.WHEELSPIN]; c.driftIntensity = a[i + STATE.DRIFT]; c.steerAngle = a[i + STATE.STEER_ANGLE]; c.ayPrev = a[i + STATE.AY_PREV];
    c.wrongWay = a[i + STATE.WRONG_WAY] > 0.5; c.trackIdx = a[i + STATE.TRACK_IDX]; c.lineCross = a[i + STATE.LINE_CROSS]; c.progressScore = a[i + STATE.PROGRESS]; c.ghost = a[i + STATE.GHOST]; c.ghostTimer = a[i + STATE.GHOST_TIMER];
    c.rescueGhost = a[i + STATE.RESCUE_GHOST] > 0.5; c.finishGhost = a[i + STATE.FINISH_GHOST] > 0.5; c.zoneGhost = a[i + STATE.ZONE_GHOST] > 0.5; c.finished = a[i + STATE.FINISHED] > 0.5; c.retired = a[i + STATE.RETIRED] > 0.5;
    c.totalTime = a[i + STATE.TOTAL_TIME]; c.finishTime = a[i + STATE.FINISH_TIME]; c.rank = a[i + STATE.RANK]; c.raceLocked = a[i + STATE.RACE_LOCKED] > 0.5; c.cpIdx = a[i + STATE.CP_IDX];
    for (let k = 0; k < 4; k++) c.wheelGroundY[k] = a[i + STATE.WGY0 + k];
    c.axMeasured = a[i + STATE.AX]; c.surface = a[i + STATE.SURFACE]; c.airborne = a[i + STATE.AIRBORNE] > 0.5;
    for (let k = 0; k < 4; k++) c.tireTemp[k] = a[i + STATE.TIRE_TEMP0 + k];
    c.tireGrip = a[i + STATE.TIRE_GRIP];
    c.ghostReasonCode = a[i + STATE.GHOST_REASON]; c.yawSpeed = a[i + STATE.YAW_SPEED];
    c.groundY = a[i + STATE.GROUND_Y]; c.suspCompression = a[i + STATE.SUSPENSION];
    c.pgGhost = a[i + STATE.PG_GHOST] > 0.5; c.curbH = a[i + STATE.CURB_H];
    c.lapInvalid = a[i + STATE.LAP_INVALID] > 0.5; c.bestCleanLap = a[i + STATE.BEST_CLEAN_LAP];
    c.progress = a[i + STATE.CHECKPOINT_PROGRESS]; c.crossedStart = a[i + STATE.CROSSED_START] > 0.5;
    if (!c.roadNormal) c.roadNormal = V3();
    c.roadNormal.set(a[i + STATE.ROAD_NX], a[i + STATE.ROAD_NY], a[i + STATE.ROAD_NZ]);
    c.throttle = a[i + STATE.THROTTLE]; c.brake = a[i + STATE.BRAKE]; c.steer = a[i + STATE.STEER]; c.handbrake = a[i + STATE.HANDBRAKE];
    // 本车输入意图归主线程所有，旧快照不可覆盖刚按下的按键。
    if (!c.isLocal) { c.input.throttle = c.throttle; c.input.brake = c.brake; c.input.steer = c.steer; c.input.handbrake = c.handbrake; }
    c._inputSeq = a[i + STATE.INPUT_SEQ];
  }
  _applyEvent(name, p) {
    const c = p.car && this.byId.get(p.car.id);
    if (c && p.car) Object.assign(c, p.car);
    if (name === 'penalty' && c) { c.lastPenaltyReason = p.reason || ''; if (!Number.isFinite(p.car?.penalty)) c.addPenalty(p.seconds, p.reason); }
    if (name === 'finish' && c) c.finished = true;
    this._emit(name, { ...p, car: c || (p.car ? this.byId.get(p.car.id) : null) });
  }
}

export { CarMirror };
```

### 文件: public/js/RemoteSnapshotBuffer.js

```javascript
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
      // ① seq 回绕（新一局 / 重连 / 房主交接）：旧局残留的 seq 一旦高于新局，后续所有
      //    包都会被下面第 ② 条永久判为"乱序"⇒ 该远端车在画面里永远停在起点不动。
      //    这里显式识别回绕（seq 变小且时间轴同时回退）并整段清空重来。
      if (seq > 0 && lastSeq > 0 && seq < lastSeq && sample.t <= last.t) {
        this.reset();
      } else {
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
```

### 文件: public/js/physics.worker.js

```javascript
/* Dedicated physics runtime. This module is loaded only by PhysicsWorkerBridge. */
import {
  PHYSICS_DT, STATE_STRIDE, REMOTE_STRIDE, buildStateArray, clamp,
} from './physics-protocol.js';
import { RemoteSnapshotBuffer } from './RemoteSnapshotBuffer.js';

const root = globalThis;

// physics.js/track.js use a small, well-defined subset of Three math. Keeping the
// shim here makes the worker independent of the renderer and DOM. Cannon remains
// entirely inside this worker module graph.
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  divideScalar(s) { return this.multiplyScalar(s ? 1 / s : 0); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return this.crossVectors(this, v); }
  crossVectors(a, b) { const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x; this.x = x; this.y = y; this.z = z; return this; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const n = this.length(); return this.multiplyScalar(n > 1e-12 ? 1 / n : 1); }
  distanceTo(v) { return Math.sqrt(this.distanceToSquared(v)); }
  distanceToSquared(v) { const x = this.x - v.x, y = this.y - v.y, z = this.z - v.z; return x * x + y * y + z * z; }
  lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
  lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; }
  applyQuaternion(q) {
    const x = this.x, y = this.y, z = this.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
}
class Q {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Q(this.x, this.y, this.z, this.w); }
  identity() { return this.set(0, 0, 0, 1); }
  normalize() { const n = Math.hypot(this.x, this.y, this.z, this.w) || 1; return this.set(this.x / n, this.y / n, this.z / n, this.w / n); }
  invert() { const n = this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w; return this.set(-this.x / n, -this.y / n, -this.z / n, this.w / n); }
  multiply(q) { return this.multiplyQuaternions(this, q); }
  premultiply(q) { return this.multiplyQuaternions(q, this); }
  multiplyQuaternions(a, b) { const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w, qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w; return this.set(qax * qbw + qaw * qbx + qay * qbz - qaz * qby, qay * qbw + qaw * qby + qaz * qbx - qax * qbz, qaz * qbw + qaw * qbz + qax * qby - qay * qbx, qaw * qbw - qax * qbx - qay * qby - qaz * qbz); }
  slerp(qb, t) {
    let x = this.x, y = this.y, z = this.z, w = this.w;
    let cos = x * qb.x + y * qb.y + z * qb.z + w * qb.w;
    if (cos < 0) { cos = -cos; qb = { x: -qb.x, y: -qb.y, z: -qb.z, w: -qb.w }; }
    if (cos > 0.9995) return this.set(x + t * (qb.x - x), y + t * (qb.y - y), z + t * (qb.z - z), w + t * (qb.w - w)).normalize();
    const ang = Math.acos(clamp(cos, -1, 1)), s = Math.sin(ang), a = Math.sin((1 - t) * ang) / s, b = Math.sin(t * ang) / s;
    return this.set(x * a + qb.x * b, y * a + qb.y * b, z * a + qb.z * b, w * a + qb.w * b);
  }
  setFromRotationMatrix(m) {
    const te = m.elements, m11 = te[0], m12 = te[4], m13 = te[8], m21 = te[1], m22 = te[5], m23 = te[9], m31 = te[2], m32 = te[6], m33 = te[10], trace = m11 + m22 + m33;
    if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); return this.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s); }
    if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); return this.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s); }
    if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); return this.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s); }
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22); return this.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
  }
}
class M4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  makeBasis(x, y, z) { const e = this.elements; e[0] = x.x; e[1] = x.y; e[2] = x.z; e[4] = y.x; e[5] = y.y; e[6] = y.z; e[8] = z.x; e[9] = z.y; e[10] = z.z; return this; }
}
root.THREE = { Vector3: V3, Quaternion: Q, Matrix4: M4, MathUtils: { damp: (x, y, lambda, dt) => x + (y - x) * (1 - Math.exp(-lambda * dt)) } };

let RacePhysics;
let Track;
let rp = null;
let ready = false;
let running = false;
let disposed = false;
let localId = 0;
let lastNow = 0;
let acc = 0;
let statePool = [];
let stateSeq = 0;
let stateHits = 0;
let stateTerrainHits = 0;
let stateContactDetails = [];
let diagnosticProbe = null;
let renderDelayMs = 80;
const MAX_FIXED_STEPS = 15;
const remoteHistory = new Map();
// 复用型 scratch：接触详情与"步前运动学"每个固定步都要用，但不需要每步重新分配。
const preKinematics = [];        // [{ v:[x,y,z], p:[x,y,z] }]，下标 = 车序
const stepDetails = [];          // [detail[]]，下标 = 车序；每步先清空再填充
const ZERO_NORMAL = { x: 0, y: 1, z: 0 };
// 纯算术取整，语义等价于 Number(x.toFixed(n))，但不产生临时字符串。
const rnd3 = (v) => Math.round(num(v) * 1e3) / 1e3;
const rnd4 = (v) => Math.round(num(v) * 1e4) / 1e4;
const rnd5 = (v) => Math.round(num(v) * 1e5) / 1e5;

const post = (message, transfer = []) => { if (!disposed) self.postMessage(message, transfer); };
const otherBarrier = (a, b) => (a.__barrier === true || b.__barrier === true) && !(a.__roadHeightfield || b.__roadHeightfield);
const num = (v, d = 0) => Number.isFinite(v) ? v : d;
const pos = (d) => ({ x: num(d && d.x), y: num(d && d.y), z: num(d && d.z) });
const quat = (d) => ({ x: num(d && d[0]), y: num(d && d[1]), z: num(d && d[2]), w: num(d && d[3], 1) });
const vel = (d) => ({ x: num(d && d[0]), y: num(d && d[1]), z: num(d && d[2]) });

function carPayload(c) { return c ? { id:c.id,name:c.name,lap:c.lap,bestLap:c.bestLap,lastLap:c.lastLap,lapInvalid:!!c.lapInvalid,finished:!!c.finished,finishGhost:!!c.finishGhost,totalTime:c.totalTime,finishTime:c.finishTime,rank:c.rank,penalty:c.penalty,violations:c.violations } : null; }
function event(name, payload) { post({ type: 'event', name, payload }); }
function configureCallbacks() {
  rp.onPenalty = (c, sec, reason) => event('penalty', { car: carPayload(c), seconds: num(sec), reason: String(reason || '') });
  rp.onIncident = (c, info) => event('incident', { car: carPayload(c), info: info || {} });
  rp.onLap = (c, lap, time, dirty) => event('lap', { car: carPayload(c), lap, time, dirty: !!dirty });
  rp.onFinish = (c) => event('finish', { car: carPayload(c) });
  rp.onAlert = (c, text, kind) => event('alert', { car: carPayload(c), text: String(text || ''), kind: String(kind || '') });
  rp.onBump = (c) => event('bump', { car: carPayload(c) });
}

// 仅按需测量真实固定步长，不额外推进世界，也不在高频状态包中复制诊断对象。
function collectDiagnostics(m) {
  if (!rp || diagnosticProbe) {
    post({ type: 'diagnostics', id: m.id, error: !rp ? 'physics not ready' : 'diagnostics busy' });
    return;
  }
  const w = rp.world, originalTick = w.collisionMatrixTick;
  const probe = diagnosticProbe = { start: performance.now(), step: w.stepnumber, fixed: [], matrix: [] };
  w.collisionMatrixTick = function(...args) {
    const started = performance.now();
    const result = originalTick.apply(this, args);
    probe.matrix.push(performance.now() - started);
    return result;
  };
  const statistics = values => {
    if (!values.length) return { count: 0, mean: null, p50: null, p99: null, max: null };
    const sorted = values.slice().sort((a, b) => a - b);
    return { count: sorted.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
      p50: sorted[Math.floor(sorted.length * 0.5)], p99: sorted[Math.floor(sorted.length * 0.99)], max: sorted[sorted.length - 1] };
  };
  probe.timer = setTimeout(() => {
    w.collisionMatrixTick = originalTick;
    diagnosticProbe = null;
    const mapBacked = w.collisionMatrix._m instanceof Map;
    post({ type: 'diagnostics', id: m.id, data: {
      elapsedMs: performance.now() - probe.start, fixedDt: PHYSICS_DT,
      fixedSteps: w.stepnumber - probe.step, stateSeq, carCount: rp.cars.length, bodies: w.bodies.length,
      broadphase: w.broadphase.__workerConfig, matrixIsMapBacked: mapBacked,
      livePairs: mapBacked ? w.collisionMatrix._m.size : null,
      heightfields: w.bodies.reduce((sum, b) => sum + b.shapes.filter(s => s.type === 32).length, 0),
      fixedStepMs: statistics(probe.fixed), collisionMatrixTickMs: statistics(probe.matrix),
    }});
  }, clamp(num(m.duration, 2000), 250, 5000));
}

function acquireState(size) {
  for (let i = statePool.length - 1; i >= 0; i--) {
    const b = statePool[i];
    if (b.byteLength >= size * 4) { statePool.splice(i, 1); return new Float32Array(b); }
  }
  return new Float32Array(size);
}
function releaseState(buffer) { if (buffer && buffer.byteLength) statePool.push(buffer); }
function snapshot(now) {
  if (!rp) return;
  const arr = acquireState(Math.max(1, rp.cars.length) * STATE_STRIDE);
  const filled = buildStateArray(rp.cars, arr);
  const alpha = clamp(num(rp.acc) / PHYSICS_DT, 0, 1);
  const frame = ++stateSeq;
  post({ type: 'state', seq: frame, now, time: num(rp.time), alpha, step: rp.world.stepnumber, contactMask: stateHits, terrainContactMask: stateTerrainHits, contactDetails: stateContactDetails, count: rp.cars.length, stride: STATE_STRIDE, buffer: filled.buffer }, [filled.buffer]);
  stateHits = 0;
  stateTerrainHits = 0;
  stateContactDetails = [];

}
function pushRemoteSample(id, d, t, seq = 0) {
  const c = rp && rp.byId.get(id);
  if (!c || !c.remote || !d) return;
  let h = remoteHistory.get(id);
  if (!h) { h = new RemoteSnapshotBuffer(); remoteHistory.set(id, h); }
  h.push({t:num(t,performance.now()),seq,p:pos(d),q:quat(d.q),v:vel(d.v),u:[num(d.u),num(d.b),num(d.e),num(d.h)]}, performance.now());
  const wasGhost = c.ghost > 0, wasFinished = c.finishGhost;
  if (d.f) { c.finished = true; c.finishGhost = true; }
  c.lap = num(d.l, c.lap);
  c.ghostReasonCode = num(d.gr); c.ghost = num(d.go);
  if (wasGhost !== (c.ghost > 0) || wasFinished !== c.finishGhost) rp._refreshMasks();
  if (c.ai) {
    c.cpIdx = num(d.c, -1); c.lapTimeLive = num(d.lt); c.bestLap = num(d.bl); c.bestCleanLap = num(d.bc);
    c.penalty = num(d.pen); c.violations = num(d.vio); c.lapInvalid = !!d.li;
    c.progress = num(d.pr); c.crossedStart = !!d.cs; c.lineCross = num(d.lc); c.lastLap = num(d.ll);
    c.finishTime = num(d.ft); c.totalTime = num(d.tt);
  }
}
function updateRemoteTargets(now) {
  if (!rp) return;
  const targetTime = now - renderDelayMs;
  for (const c of rp.cars) {
    if (!c.remote) continue;
    const h = remoteHistory.get(c.id);
    const sample = h && h.sample(targetTime, PHYSICS_DT);
    if (!sample) continue;
    rp.applyRemoteTarget(c.id, sample.p, sample.q, sample.v);
    rp.setRemoteInput(c.id, ...sample.u);
  }
}
function tick(now) {
  if (disposed) return;
  try {
    if (!lastNow) lastNow = now;
    const elapsed = Math.min(0.25, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    if (running && rp) {
      acc += elapsed;
      let steps = 0;
      while (acc >= PHYSICS_DT && steps < MAX_FIXED_STEPS) {
        updateRemoteTargets(now - (acc - PHYSICS_DT) * 1000);
        // ★ 零分配改造。接触详情（contactDetails）是**常驻遥测**：jitter-check 与
        //   worker-kinematic-check 都直接消费它，所以不能"只在探针期构造"。
        //   这里改为消除每步的分配与字符串格式化：
        //     · preKinematics / stepDetails 改为模块级 scratch，按车数增长后复用
        //       （原来每步一次 `rp.cars.map(...)` + 一次 `Array.from(...)`）；
        //     · `Number(x.toFixed(n))` 换成纯算术取整 `rndN(x)`，不再产生临时字符串
        //       —— 12 车 × 每个接触点 3~5 次 toFixed × 60Hz 是此前最稳定的垃圾源。
        const probe = diagnosticProbe;
        const began = probe ? performance.now() : 0;
        const cars = rp.cars;
        for (let k = 0; k < cars.length; k++) {
          const b = cars[k].body;
          const slot = preKinematics[k] || (preKinematics[k] = { v: [0, 0, 0], p: [0, 0, 0] });
          slot.v[0] = b.velocity.x; slot.v[1] = b.velocity.y; slot.v[2] = b.velocity.z;
          slot.p[0] = b.position.x; slot.p[1] = b.position.y; slot.p[2] = b.position.z;
        }
        rp.fixedStep(PHYSICS_DT);
        if (probe) probe.fixed.push(performance.now() - began);
        // 记录最后一个固定步的真实接触详情，供抖动诊断区分路面顶面与侧壁。
        for (let k = 0; k < cars.length; k++) {
          const row = stepDetails[k] || (stepDetails[k] = []);
          row.length = 0;
        }
        for (const contact of rp.world.contacts) {
          const a = contact.bi, b = contact.bj;
          const terrain = a.shapes.some(s => s.type === 32) || b.shapes.some(s => s.type === 32);
          for (let k = 0; k < cars.length; k++) {
            if (cars[k].body !== a && cars[k].body !== b) continue;
            if (terrain) stateTerrainHits |= 1 << k;
            else stateHits |= 1 << k;
            const own = cars[k].body;
            const other = a === own ? b : a;
            stepDetails[k].push({
              road: terrain, barrier: otherBarrier(a, b), otherCar: other.__carId !== undefined ? other.__carId : 0,
              normal: [rnd4(contact.ni.x), rnd4(contact.ni.y), rnd4(contact.ni.z)],
              penetration: rnd5(contact.__lastPenetration || 0),
              ri: [rnd3(contact.ri.x), rnd3(contact.ri.y), rnd3(contact.ri.z)],
              rj: [rnd3(contact.rj.x), rnd3(contact.rj.y), rnd3(contact.rj.z)],
              preVelocity: [rnd3(preKinematics[k].v[0]), rnd3(preKinematics[k].v[1]), rnd3(preKinematics[k].v[2])],
              postVelocity: [rnd3(own.velocity.x), rnd3(own.velocity.y), rnd3(own.velocity.z)],
              prePosition: [rnd3(preKinematics[k].p[0]), rnd3(preKinematics[k].p[1]), rnd3(preKinematics[k].p[2])],
              postPosition: [rnd3(own.position.x), rnd3(own.position.y), rnd3(own.position.z)],
            });
          }
        }
        // 路面 Heightfield 是 query-only，承重来自 groundConstraint 的四轮射线，
        // 因而它不会出现在 Cannon contacts。将这条真实承重路径单独镜像到
        // terrainContactMask/contactDetails，避免把“无刚体碰撞”误报成“未接地”。
        for (let k = 0; k < cars.length; k++) {
          const car = cars[k];
          if (!car.grounded || !(car.roadRayHits > 0)) continue;
          stateTerrainHits |= 1 << k;
          const normal = car.roadNormal || ZERO_NORMAL;
          stepDetails[k].push({
            road: true, barrier: false, otherCar: 0,
            normal: [rnd4(normal.x), rnd4(normal.y), rnd4(normal.z)],
            penetration: 0,
            ri: [0, 0, 0], rj: [0, 0, 0],
            preVelocity: [rnd3(preKinematics[k].v[0]), rnd3(preKinematics[k].v[1]), rnd3(preKinematics[k].v[2])],
            postVelocity: [rnd3(car.body.velocity.x), rnd3(car.body.velocity.y), rnd3(car.body.velocity.z)],
            prePosition: [rnd3(preKinematics[k].p[0]), rnd3(preKinematics[k].p[1]), rnd3(preKinematics[k].p[2])],
            postPosition: [rnd3(car.body.position.x), rnd3(car.body.position.y), rnd3(car.body.position.z)],
          });
        }
        for (let k = 0; k < cars.length; k++) {
          const row = stepDetails[k];
          if (!row.length) continue;
          const prev = stateContactDetails[k];
          stateContactDetails[k] = prev && prev.length ? prev.concat(row).slice(-12) : row.slice(-12);
        }
        acc -= PHYSICS_DT;
        steps++;
        // 每个固定步都发布一次状态。落后补算时若只在 while 结束发布，
        // 主线程会连续看到旧状态后一次跳过多步，造成可见的“顶一下”。
        rp.acc = acc;
        // alpha 已含剩余时间；时间戳再减 acc 会让渲染端重复计时。
        snapshot(now);
      }
      if (steps === MAX_FIXED_STEPS) acc = 0;
      rp.acc = acc;
    }
  } catch (error) {
    running = false;
    post({ type: 'error', message: error && error.stack ? error.stack : String(error) });
    return;
  }
  setTimeout(() => tick(performance.now()), 4);
}
self.addEventListener('error', (event) => {
  post({ type: 'error', message: event && (event.error?.stack || event.message) || 'physics worker uncaught error' });
});
self.addEventListener('unhandledrejection', (event) => {
  post({ type: 'error', message: event && (event.reason?.stack || event.reason) || 'physics worker unhandled rejection' });
});
async function init(m) {
  if (ready) return;
  const pmod = await import('./physics.js');
  const tmod = await import('./track.js');
  RacePhysics = pmod.RacePhysics; Track = tmod.Track;
  const td = m.track || {};
  const t = new Track(td.seed >>> 0, td.trackType || 'suzuka');
  t.colliders = Array.isArray(td.colliders) ? td.colliders : [];
  rp = new RacePhysics(t);
  // Remote cars are network-owned KINEMATIC bodies. RacePhysics also calls
  // groundConstraint() for them, but that routine is a suspension controller
  // and is allowed to move a body vertically. Keep the road as telemetry only
  // for remotes; local cars retain the normal raycast/constraint path.
  const groundConstraint = rp.groundConstraint;
  rp.groundConstraint = function workerGroundConstraint(car, dt, post = false) {
    if (!car || !car.remote) return groundConstraint.call(this, car, dt, post);
    const body = car.body;
    const info = this.track.sample(body.position.x, body.position.z, car.trackIdx, body.position.y);
    if (!info) return;
    car.trackIdx = info.i;
    car.lateral = info.lateral;
    car.roadNormal = info.normal;
    car.roadTangent = info.tangent;
    car.roadSide = info.side;
    car.groundY = info.y;
    car.roadRayHits = 0;
    car.roadLayer = info.onBridge ? 'bridge' : 'ground';
  };
  const broadphase = rp.world.broadphase;
  const needPair = broadphase.needBroadphaseCollision.bind(broadphase);
  const testPair = broadphase.intersectionTest.bind(broadphase);
  const broadphaseCell = 32;
  let indexedBodyCount = -1;
  let dynamicBodies = [];
  let staticBuckets = new Map();
  let largeStaticBodies = [];
  const bucketKey = (x, z) => `${x},${z}`;
  const indexStaticBody = (body) => {
    if (body.aabbNeedsUpdate) body.updateAABB();
    const lo = body.aabb.lowerBound, hi = body.aabb.upperBound;
    const x0 = Math.floor(lo.x / broadphaseCell), x1 = Math.floor(hi.x / broadphaseCell);
    const z0 = Math.floor(lo.z / broadphaseCell), z1 = Math.floor(hi.z / broadphaseCell);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 256) { largeStaticBodies.push(body); return; }
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const key = bucketKey(x, z);
      let bucket = staticBuckets.get(key);
      if (!bucket) { bucket = []; staticBuckets.set(key, bucket); }
      bucket.push(body);
    }
  };
  const rebuildBroadphaseIndex = (world) => {
    if (indexedBodyCount === world.bodies.length) return;
    indexedBodyCount = world.bodies.length;
    dynamicBodies = [];
    staticBuckets = new Map();
    largeStaticBodies = [];
    for (const body of world.bodies) {
      if (body.mass > 0 || body.type === 4) dynamicBodies.push(body);
      else indexStaticBody(body);
    }
  };
  rp.world.broadphase.collisionPairs = (world, pairs1, pairs2) => {
    rebuildBroadphaseIndex(world);
    for (let i = 0; i < dynamicBodies.length; i++) {
      const a = dynamicBodies[i];
      if (a.aabbNeedsUpdate) a.updateAABB();
      for (let j = 0; j < i; j++) {
        const b = dynamicBodies[j];
        if (needPair(a, b)) testPair(a, b, pairs1, pairs2);
      }
      for (const b of largeStaticBodies) {
        if (needPair(a, b)) testPair(a, b, pairs1, pairs2);
      }
      const lo = a.aabb.lowerBound, hi = a.aabb.upperBound;
      const x0 = Math.floor(lo.x / broadphaseCell), x1 = Math.floor(hi.x / broadphaseCell);
      const z0 = Math.floor(lo.z / broadphaseCell), z1 = Math.floor(hi.z / broadphaseCell);
      const seen = new Set();
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const bucket = staticBuckets.get(bucketKey(x, z));
        if (!bucket) continue;
        for (const b of bucket) {
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          if (needPair(a, b)) testPair(a, b, pairs1, pairs2);
        }
      }
    }
  };
  broadphase.__workerConfig = { algorithm: 'static-bucket-xz', cellXZ: broadphaseCell };
  localId = Number(m.localId) || 0;
  rp.setGhostMode(!!m.ghost); rp.setGameMode(m.gameMode || 'fm8');
  configureCallbacks();
  if (Array.isArray(m.roster)) for (const car of m.roster) addCar(car);
  ready = true;
  // The bridge calibrates this Worker monotonic epoch against the page epoch.
  // Do not make the bridge infer the offset from timeOrigin: those values are
  // not a safe substitute for an explicit clock-domain handshake.
  post({ type: 'ready', clockNow: performance.now(), cars: rp.cars.length, baumgarteKilled: !!rp.baumgarteKilled, colliders: rp.staticBodies ? rp.staticBodies.length : 0 });
  tick(performance.now());
}
function addCar(opts) {
  if (!rp || !opts || rp.byId.has(opts.id)) return;
  const c = rp.addCar(opts); c.auto = !!opts.ai && !c.remote; c.raceLocked = opts.raceLocked !== false;
  c._inputSeq = 0;
}
self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === 'recycleState') { releaseState(m.buffer); return; }
    if (m.type === 'init') { await init(m); return; }
    if (m.type === 'diagnostics') { collectDiagnostics(m); return; }
    if (m.type === 'addCar') { addCar(m.car); return; }
    // ★ 远端历史必须随车辆/局次生命周期一起清空：残留的旧 seq 会让新一局的包
    //   被 RemoteSnapshotBuffer 永久判为"乱序"，表现为远端车卡在起点不动。
    if (m.type === 'removeCar') { remoteHistory.delete(m.id); if (rp) rp.removeCar(m.id); return; }
    if (m.type === 'clear') { remoteHistory.clear(); if (rp) rp.clear(); return; }
    if (m.type === 'start') { remoteHistory.clear(); if (rp) { running = true; rp.racing = false; rp.timeAligned = false; acc = 0; lastNow = performance.now(); } return; }
    if (m.type === 'running') {
      if (rp) {
        if (m.value && !rp.timeAligned) { rp.time = 0; rp.timeAligned = true; for (const c of rp.cars) { c.lapStart = 0; c.lapTimeLive = 0; } }
        rp.racing = !!m.value;
        for (const c of rp.cars) c.raceLocked = !rp.racing;
      }
      return;
    }
    if (m.type === 'setGhost') { if (rp) rp.setGhostMode(!!m.value); return; }
    if (m.type === 'setGameMode') { if (rp) rp.setGameMode(m.value); return; }
    if (m.type === 'aiHost') { if (rp) { rp.setAIAuthority(!!m.local); for (const c of rp.cars) if (c.ai) remoteHistory.delete(c.id); } return; }
    if (m.type === 'input') {
      const c = rp && rp.byId.get(m.id || localId); const d = m.values || m.data || [];
      if (c) { c.input.throttle = clamp(num(d[0] ?? d.throttle), 0, 1); c.input.brake = clamp(num(d[1] ?? d.brake), 0, 1); c.input.steer = clamp(num(d[2] ?? d.steer), -1, 1); c.input.handbrake = (d[3] ?? d.handbrake) ? 1 : 0; c._inputSeq = num(m.seq); }
      if (m.buffer) post({ type: 'recycleInput', buffer: m.buffer }, [m.buffer]);
      return;
    }
    if (m.type === 'remoteSamples') {
      renderDelayMs = clamp(num(m.renderDelay,80),60,120);
      const a = new Float32Array(m.buffer), stride = m.stride || REMOTE_STRIDE;
      for (let k=0;k<m.count;k++) {
        const i=k*stride;
        pushRemoteSample(a[i],{x:a[i+2],y:a[i+3],z:a[i+4],q:[a[i+5],a[i+6],a[i+7],a[i+8]],v:[a[i+9],a[i+10],a[i+11]],u:a[i+12],b:a[i+13],e:a[i+14],h:a[i+15],f:a[i+16],l:a[i+17],gr:a[i+19],go:a[i+20],c:a[i+21],lt:a[i+22],bl:a[i+23],bc:a[i+24],pen:a[i+25],vio:a[i+26],li:a[i+27],pr:a[i+28],cs:a[i+29],lc:a[i+30],ll:a[i+31],ft:a[i+32],tt:a[i+33]},a[i+1],a[i+34]);
      }
      // 归还缓冲给主线程的复用池：60Hz × N 车不再每包分配一个 Float32Array。
      post({ type: 'recycleRemote', buffer: m.buffer }, [m.buffer]);
      return;
    }
    if (m.type === 'network') {
      const p = m.packet || {};
      if (p.kind === 'snap' && p.packet) {
        const list = Array.isArray(p.packet.p) ? p.packet.p : [];
        for (const e of list) pushRemoteSample(e.id, e.d, p.snapT - Math.max(0, num(e.age)), num(e.seq));
      } else if (p.t === 'snap') {
        for (const e of (p.p || [])) pushRemoteSample(e.id, e.d, (p.ts || performance.now()) - Math.max(0, num(e.age)), num(e.seq));
      } else if (p.id && p.d) pushRemoteSample(p.id, p.d, p.ts || performance.now(), num(p.seq));
      return;
    }
    if (m.type === 'rescue') { if (rp) { const c = rp.byId.get(m.id || localId); if (c && rp.rescueToCheckpoint) rp.rescueToCheckpoint(c); } return; }
    if (m.type === 'finish') { if (rp) { const c = rp.byId.get(m.id); if (c && rp.finishCar) rp.finishCar(c); } return; }
    if (m.type === 'dispose') { disposed = true; running = false; if (rp) rp.clear(); close(); }
  } catch (error) {
    post({ type: 'error', message: error && error.stack ? error.stack : String(error) });
  }
};
```

## 相机 / UI / 音效

### 文件: public/js/ForzaChaseCamera.js

```javascript
/*
 * FM8-style chase camera.
 *
 * The application currently loads three.min.js before its module graph and exposes
 * THREE globally. Keeping the lookup lazy makes this controller usable from that
 * loader while leaving the public module import-free and easy to test.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function dampAlpha(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= TAU;
  while (angle < -Math.PI) angle += TAU;
  return angle;
}

function dampAngle(value, target, rate, dt) {
  return wrapAngle(value + wrapAngle(target - value) * dampAlpha(rate, dt));
}

function rotateVectorAroundAxis(vector, axis, angle) {
  if (Math.abs(angle) < 1e-7) return;
  const x = vector.x;
  const y = vector.y;
  const z = vector.z;
  const ax = axis.x;
  const ay = axis.y;
  const az = axis.z;
  const dot = x * ax + y * ay + z * az;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  vector.set(
    x * c + (ay * z - az * y) * s + ax * dot * k,
    y * c + (az * x - ax * z) * s + ay * dot * k,
    z * c + (ax * y - ay * x) * s + az * dot * k,
  );
}

function readVelocitySpeed(car) {
  if (!car) return 0;
  if (Number.isFinite(car.speed)) return Math.abs(car.speed);
  if (Number.isFinite(car.speedMps)) return Math.abs(car.speedMps);
  if (Number.isFinite(car.speedKmh)) return Math.abs(car.speedKmh) / 3.6;
  const body = car.body;
  const velocity = car.velocity || car.vel || (body && (body.velocity || body.vel));
  if (velocity) return Math.hypot(finite(velocity.x), finite(velocity.z));
  return 0;
}

function readAcceleration(car) {
  if (!car) return 0;
  if (Number.isFinite(car.axMeasured)) return car.axMeasured;
  if (Number.isFinite(car.acceleration)) return car.acceleration;
  if (Number.isFinite(car.longitudinalAcceleration)) return car.longitudinalAcceleration;
  if (Number.isFinite(car.accel)) return car.accel;
  return 0;
}

function readYawRate(car) {
  if (!car) return NaN;
  if (Number.isFinite(car.yawRate)) return car.yawRate;
  if (Number.isFinite(car.yawVelocity)) return car.yawVelocity;

  const body = car.body;
  const mirror = car.mirror;
  const mirrorBody = mirror && mirror.body;
  const angularVelocity = car.angularVelocity || car.angularVel ||
    (body && (body.angularVelocity || body.angularVel)) ||
    (mirror && (mirror.angularVelocity || mirror.angularVel)) ||
    (mirrorBody && (mirrorBody.angularVelocity || mirrorBody.angularVel));
  if (angularVelocity && Number.isFinite(angularVelocity.y)) return angularVelocity.y;
  return NaN;
}

function readLateralSign(car, yawRate) {
  if (Math.abs(yawRate) > 1e-5) return Math.sign(yawRate);
  // steerAngle > 0 points left; input.steer > 0 requests right. These
  // fields recover a side only, never masquerade as angular velocity.
  if (Number.isFinite(car.steerAngle) && Math.abs(car.steerAngle) > 1e-5) {
    return Math.sign(car.steerAngle);
  }
  const input = car.input;
  if (input && Number.isFinite(input.steer) && Math.abs(input.steer) > 1e-5) {
    return -Math.sign(input.steer);
  }
  if (Number.isFinite(car.steerInput) && Math.abs(car.steerInput) > 1e-5) {
    return -Math.sign(car.steerInput);
  }
  if (Number.isFinite(car.lateralSpeed) && Math.abs(car.lateralSpeed) > 1e-5) {
    // Lateral grip accelerates against the velocity along local +X.
    return -Math.sign(car.lateralSpeed);
  }
  return 0;
}

function readLateralAcceleration(car, yawRate) {
  if (!car) return 0;
  // Production physics exports ayPrev as Math.abs(...), so recover its side
  // from the signed yaw/steer telemetry. Preserve a negative value and an
  // explicitly signed producer for forward compatibility.
  if (Number.isFinite(car.ayPrev)) {
    if (car.ayPrevSigned === true || car.ayPrev < 0) return car.ayPrev;
    return Math.abs(car.ayPrev) * readLateralSign(car, yawRate);
  }
  if (Number.isFinite(car.lateralAcceleration)) return car.lateralAcceleration;
  if (Number.isFinite(car.lateralAccel)) return car.lateralAccel;
  if (Number.isFinite(car.lateralG)) return car.lateralG * 9.81;
  if (Number.isFinite(car.accelX)) return car.accelX;
  return 0;
}

/**
 * Camera controller for an interpolated vehicle mesh.
 *
 * @param {THREE.PerspectiveCamera} camera camera mutated by update()
 */
export class ForzaChaseCamera {
  constructor(camera) {
    const THREE = globalThis.THREE;
    if (!THREE) throw new Error('ForzaChaseCamera requires global THREE');
    if (!camera || !camera.position || !camera.quaternion) {
      throw new TypeError('ForzaChaseCamera requires a Three.js camera');
    }

    this.camera = camera;

    // All reusable frame state lives here. update() does not create vectors,
    // quaternions, arrays, or objects.
    this._meshPosition = new THREE.Vector3();
    this._meshQuaternion = new THREE.Quaternion();
    // 去掉车身侧倾（Roll）的朝向基：保留航向 + 俯仰，只把绕车头的自转抹掉。
    this._noRollQuaternion = new THREE.Quaternion();
    this._basisMatrix = new THREE.Matrix4();
    this._basisRight = new THREE.Vector3(1, 0, 0);
    this._basisUp = new THREE.Vector3(0, 1, 0);
    this._meshUp = new THREE.Vector3(0, 1, 0);
    this._meshVelocity = new THREE.Vector3();
    this._lastMeshPosition = new THREE.Vector3();
    this._hasLastMeshPosition = false;
    this._forward = new THREE.Vector3(0, 0, 1);
    this._worldForward = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._localPosition = new THREE.Vector3();
    this._localLook = new THREE.Vector3();
    this._worldOffset = new THREE.Vector3();
    this._desiredPosition = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._currentPosition = new THREE.Vector3();
    this._currentLook = new THREE.Vector3();
    this._viewDirection = new THREE.Vector3();
    this._desiredUp = new THREE.Vector3(0, 1, 0);
    this._desiredQuaternion = new THREE.Quaternion();
    this._orientation = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);

    this._freeLookYaw = 0;
    this._freeLookYawTarget = 0;
    this._pullback = 0;
    this._pullbackTarget = 0;
    this._roll = 0;
    this._rollTarget = 0;
    this._fov = finite(camera.fov, 60);
    this._lastMeshYaw = null;
    this._noiseX = 0;
    this._noiseY = 0;
    this._noiseZ = 0;
    this._clock = 0;
    this._hasClock = false;
    this._initialized = false;

  }

  /**
   * Snap the initial chase framing to the already interpolated mesh.
   * Later calls to update() always use inertial smoothing.
   *
   * @param {THREE.Object3D} mesh interpolated vehicle mesh
   * @returns {THREE.Camera} the controlled camera
   */
  reset(mesh) {
    this._requireMesh(mesh);
    this._meshPosition.copy(mesh.position);
    this._meshQuaternion.copy(mesh.quaternion).normalize();
    this._freeLookYaw = 0;
    this._freeLookYawTarget = 0;
    this._pullback = 0;
    this._pullbackTarget = 0;
    this._roll = 0;
    this._rollTarget = 0;
    this._noiseX = 0;
    this._noiseY = 0;
    this._noiseZ = 0;
    this._clock = 0;
    this._hasClock = false;
    this._meshVelocity.set(0, 0, 0);
    this._hasLastMeshPosition = false;   // reset 是硬吸附，下一帧不该算出巨大的位移速度
    this._fov = 60;
    this._cameraTarget(mesh, 0, 0, 0, 0, 0, 0);
    this._lastMeshYaw = Math.atan2(this._worldForward.x, this._worldForward.z);
    this._currentPosition.copy(this._desiredPosition);
    this._currentLook.copy(this._desiredLook);
    this.camera.position.copy(this._currentPosition);
    this.camera.fov = this._fov;
    if (typeof this.camera.updateProjectionMatrix === 'function') {
      this.camera.updateProjectionMatrix();
    }
    this._setOrientation(1);
    this._initialized = true;
    return this.camera;
  }

  /**
   * Advance the camera from an interpolated mesh snapshot.
   *
   * lookX is positive to the right and lookY is positive downward. The stick
   * direction maps through atan2(-lookX, -lookY): down=180°, left=+90°,
   * right=-90°, down-left=+135°, down-right=-135°.
   *
   * @param {object} state
   * @param {THREE.Object3D} state.mesh interpolated visual mesh
   * @param {object} [state.car] physical telemetry; its position is ignored
   * @param {number} state.dt seconds since the previous render
   * @param {number} [state.now] monotonic timestamp, milliseconds or seconds
   * @param {number} [state.lookX] gamepad/keyboard horizontal look input
   * @param {number} [state.lookY] gamepad/keyboard vertical look input
   * @param {0|1|2} [state.mode] chase, hood, or bird view
   * @param {number} [state.ghostAmplitude] legacy field, ignored by the camera
   * @returns {THREE.Camera} the controlled camera
   */
  update({ mesh, car = null, dt = 0, now = 0, lookX = 0, lookY = 0, mode = 0, ghostAmplitude = 0 }) {
    this._requireMesh(mesh);
    let frameDt = finite(dt, 0);
    if (frameDt < 0) frameDt = 0;
    if (frameDt > 0.1) frameDt = 0.1;

    if (!this._initialized) this.reset(mesh);
    this._updateClock(now, frameDt);

    const x = finite(lookX);
    const y = finite(lookY);
    if (x * x + y * y > 0.0004) {
      this._freeLookYawTarget = Math.abs(x) < 1e-7 && y > 0 ? Math.PI : Math.atan2(-x, -y);
    } else {
      this._freeLookYawTarget = 0;
    }
    this._freeLookYaw = dampAngle(this._freeLookYaw, this._freeLookYawTarget, 8, frameDt);

    const speed = readVelocitySpeed(car);
    const speedKmh = speed * 3.6;
    const speedFactor = clamp(speedKmh / 240, 0, 1);
    const acceleration = readAcceleration(car);
    const accelFactor = clamp(Math.max(0, acceleration) / 8, 0, 1);
    this._pullbackTarget = clamp(1.15 * speedFactor + 0.35 * accelFactor, 0, 1.5);
    this._pullback += (this._pullbackTarget - this._pullback) * dampAlpha(5, frameDt);

    // 网格真实位移速度（有限差分）。_cameraTarget 里会写 _meshPosition，
    // 所以必须在调用它之前采样，否则拿到的是本帧已更新的值、差分为 0。
    if (frameDt > 0 && this._hasLastMeshPosition) {
      this._meshVelocity.copy(mesh.position).sub(this._lastMeshPosition).multiplyScalar(1 / frameDt);
    } else {
      this._meshVelocity.set(0, 0, 0);
    }
    this._lastMeshPosition.copy(mesh.position);
    this._hasLastMeshPosition = true;

    // 转弯视角偏转（roll）已按用户要求**彻底移除**：绕视线的滚转会让左右打方向时
    // 整个画面跟着倾斜。这里保留 `_roll`/`_rollTarget` 字段与 getter（恒为 0），
    // 以免外部探针/调试面板读取时报错，但不再产生任何镜头滚转，
    // 也不再为此读取 yawRate / lateralAcceleration。
    this._rollTarget = 0;
    this._roll = 0;

    // Ghosting changes collision/opacity state. It must never add camera
    // motion, especially while two ghost cars overlap.
    void ghostAmplitude;
    this._cameraTarget(mesh, speedKmh, mode, speedFactor, this._freeLookYaw, frameDt, this._roll);

    // 高速"越跑越远"的真因是一阶低通的稳态滞后：相机始终落后车尾 v/k 处
    // （k=7.5 ⇒ 192km/h 时被甩后 6.7m；实测后距 12.7m 而期望机位只有 6.0m）。
    // 给期望位置/注视点加**速度前馈**：把期望点按真实世界速度前移 v/k，
    // 稳态误差被精确抵消，而阻尼本身的频率响应完全不变 —— 不引入新的抖动源，
    // 也不改基础机位（4.8m 后 / 1.65m 高）。用真实速度向量（含漂移与坡度），
    // 而不是车头方向，保证上/下坡与甩尾时前馈方向依然正确。
    if (speed > 0.5) {
      const vx = this._meshVelocity.x, vy = this._meshVelocity.y, vz = this._meshVelocity.z;
      const vLenSq = vx * vx + vy * vy + vz * vz;
      if (vLenSq > 1e-6) {
        this._meshVelocity.multiplyScalar(1 / Math.sqrt(vLenSq));
        this._desiredPosition.addScaledVector(this._meshVelocity, speed / 7.5);
        this._desiredLook.addScaledVector(this._meshVelocity, speed / 9.5);
      } else {
        this._desiredPosition.addScaledVector(this._worldForward, speed / 7.5);
        this._desiredLook.addScaledVector(this._worldForward, speed / 9.5);
      }
    }

    if (frameDt > 0) {
      this._currentPosition.lerp(this._desiredPosition, dampAlpha(7.5, frameDt));
      this._currentLook.lerp(this._desiredLook, dampAlpha(9.5, frameDt));
    }

    this._fov += (60 + 20 * speedFactor - this._fov) * dampAlpha(5, frameDt);
    this.camera.position.copy(this._currentPosition);
    this.camera.fov = this._fov;
    if (typeof this.camera.updateProjectionMatrix === 'function') {
      this.camera.updateProjectionMatrix();
    }
    this._setOrientation(dampAlpha(12, frameDt));
    this._initialized = true;
    return this.camera;
  }

  /** Smoothed yaw in radians; forward is 0, left is positive. */
  get freeLookYaw() {
    return this._freeLookYaw;
  }

  /** Smoothed camera field of view in degrees. */
  get fov() {
    return this._fov;
  }

  /** Smoothed additional rearward distance in metres. */
  get pullback() {
    return this._pullback;
  }

  /** Smoothed camera roll in radians; negative is the production left-load response. */
  get roll() {
    return this._roll;
  }

  /** Upper-case alias retained for debug probes that mirror camera.fov. */
  get FOV() {
    return this._fov;
  }

  _requireMesh(mesh) {
    if (!mesh || !mesh.position || !mesh.quaternion) {
      throw new TypeError('ForzaChaseCamera requires a mesh with position and quaternion');
    }
  }

  _updateClock(now, dt) {
    if (!this._hasClock && Number.isFinite(now)) {
      this._clock = Math.abs(now) > 100 ? now * 0.001 : now;
      this._hasClock = true;
    } else {
      this._clock += dt;
    }
  }

  _sampleMeshYawRate(mesh, dt) {
    this._meshQuaternion.copy(mesh.quaternion).normalize();
    this._worldForward.copy(this._forward).applyQuaternion(this._meshQuaternion);
    if (this._worldForward.x * this._worldForward.x + this._worldForward.z * this._worldForward.z < 1e-6) {
      this._lastMeshYaw = null;
      return 0;
    }
    const yaw = Math.atan2(this._worldForward.x, this._worldForward.z);
    const rate = dt > 0 && this._lastMeshYaw !== null ? wrapAngle(yaw - this._lastMeshYaw) / dt : 0;
    this._lastMeshYaw = yaw;
    return clamp(rate, -4.5, 4.5);
  }

  _cameraTarget(mesh, speedKmh, mode, speedFactor, yaw, dt, roll) {
    this._meshPosition.copy(mesh.position);
    this._meshQuaternion.copy(mesh.quaternion).normalize();
    this._worldForward.copy(this._forward).applyQuaternion(this._meshQuaternion);
    // ★ 转弯视角倾斜的根因：这一行原本是
    //       this._worldUp.set(0, 1, 0).applyQuaternion(this._meshQuaternion)
    //   即"相机上方向 = 车身完整朝向"，其中**包含侧倾（Roll）**；机位偏移
    //   （_localPosition / _localLook）也直接乘了完整 `_meshQuaternion`。
    //   于是过弯车身一倾、压路肩一晃，整个画面就跟着车身歪掉。
    //
    //   正解：构造一个**只去掉 Roll** 的正交基 ——
    //       right = normalize(worldUp × forward)     （横向轴严格水平）
    //       up    = forward × right                  （在 forward 的竖直平面内）
    //   该基 = 车身朝向 ∘ R(forward, -roll)，因此航向与俯仰完全保留（上坡下坡、
    //   桥面/路肩起伏的镜头响应不变），只有绕视线的滚转被抹掉。
    //   对纯偏航（无侧倾）的车，该基与 `_meshQuaternion` **逐元素相同**，
    //   所以既有的机位/取景断言全部保持原值。
    this._basisRight.set(0, 1, 0).cross(this._worldForward);
    if (this._basisRight.lengthSq() < 1e-6) this._basisRight.set(1, 0, 0);
    else this._basisRight.normalize();
    this._basisUp.crossVectors(this._worldForward, this._basisRight).normalize();
    this._basisMatrix.makeBasis(this._basisRight, this._basisUp, this._worldForward);
    this._noRollQuaternion.setFromRotationMatrix(this._basisMatrix);
    this._meshUp.copy(this._basisUp);
    this._worldUp.copy(this._basisUp);

    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    let localX;
    let localY;
    let localZ;
    let lookX;
    let lookY;
    let lookZ;

    if (mode === 1) {
      // Hood: a short forward mount, with free-look rotating around the car.
      localX = 0;
      localY = 0.95;
      localZ = 0.75;
      lookX = 0;
      lookY = 0.85;
      lookZ = 24;
    } else if (mode === 2) {
      // Bird: retain a little rearward offset so the mesh remains readable.
      localX = 0;
      localY = 18 + 0.25 * speedFactor;
      localZ = -0.01;
      lookX = 0;
      lookY = 0;
      lookZ = 0;
    } else {
      localX = 0;
      // Keep the base mount fixed at the specified 1.65m. Speed changes the
      // rearward distance through pullback, but must not lower the camera.
      localY = 1.65;
      localZ = -4.8 - this._pullback;
      lookX = 0;
      lookY = 0.9;
      lookZ = 2.2;
    }

    // Rotate the local chase/hood look pair around local +Y for free-look.
    this._localPosition.set(localX * cosYaw + localZ * sinYaw, localY, -localX * sinYaw + localZ * cosYaw);
    this._localLook.set(lookX * cosYaw + lookZ * sinYaw, lookY, -lookX * sinYaw + lookZ * cosYaw);

    // Smooth deterministic noise avoids Math.random() discontinuities and stays
    // bounded while retaining a high-frequency filtered road texture.
    const noiseStrength = 0.028 * clamp((speedKmh - 150) / 100, 0, 1);
    const n = this._clock;
    if (noiseStrength <= 0) {
      this._noiseX = 0;
      this._noiseY = 0;
      this._noiseZ = 0;
    } else {
      const targetNoiseX = noiseStrength * (Math.sin(n * 23.0 + 0.4) * 0.65 + Math.sin(n * 37.0 + 1.9) * 0.35);
      const targetNoiseY = noiseStrength * 0.42 * (Math.sin(n * 19.0 + 2.2) * 0.65 + Math.sin(n * 31.0 + 0.6) * 0.35);
      const targetNoiseZ = noiseStrength * 0.55 * (Math.sin(n * 17.0 + 4.1) * 0.65 + Math.sin(n * 29.0 + 2.7) * 0.35);
      const noiseK = dampAlpha(15, dt);
      this._noiseX += (targetNoiseX - this._noiseX) * noiseK;
      this._noiseY += (targetNoiseY - this._noiseY) * noiseK;
      this._noiseZ += (targetNoiseZ - this._noiseZ) * noiseK;
    }
    this._localPosition.x += this._noiseX;
    this._localPosition.y += this._noiseY;
    this._localPosition.z += this._noiseZ;

    // 机位/注视点用**无 Roll 基**换算：车身侧倾不再把机位横向甩出去。
    this._worldOffset.copy(this._localPosition).applyQuaternion(this._noRollQuaternion);
    this._desiredPosition.copy(this._meshPosition).add(this._worldOffset);
    this._worldOffset.copy(this._localLook).applyQuaternion(this._noRollQuaternion);
    this._desiredLook.copy(this._meshPosition).add(this._worldOffset);

    if (mode === 2) {
      // For a bird view the car's horizontal forward is the screen-up axis.
      this._desiredUp.copy(this._worldForward);
      this._desiredUp.y = 0;
      if (this._desiredUp.lengthSq() < 1e-6) this._desiredUp.set(0, 0, 1);
      else this._desiredUp.normalize();
    } else {
      this._desiredUp.copy(this._worldUp);
    }

    this._viewDirection.copy(this._desiredLook).sub(this._desiredPosition);
    if (this._viewDirection.lengthSq() < 1e-8) this._viewDirection.copy(this._worldForward);
    else this._viewDirection.normalize();
    rotateVectorAroundAxis(this._desiredUp, this._viewDirection, roll);

  }

  _setOrientation(alpha) {
    this._orientation.position.copy(this._currentPosition);
    this._orientation.up.copy(this._desiredUp);
    this._orientation.lookAt(this._currentLook);
    this._desiredQuaternion.copy(this._orientation.quaternion);
    if (alpha >= 1) this.camera.quaternion.copy(this._desiredQuaternion);
    else this.camera.quaternion.slerp(this._desiredQuaternion, alpha);
    this.camera.up.copy(this._desiredUp);
  }
}

export default ForzaChaseCamera;
```

### 文件: public/js/PenaltyController.js

```javascript
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
```

### 文件: public/js/RaceUI.js

```javascript
// 首页昵称在游戏重模块加载前同步；各入口共享同一个 Profile。
import { setPenaltyMode } from './PenaltyController.js';

const NAME_KEY = 'forza_lan_name';
export function syncPlayerProfile(name) {
  const value = String(name || '').trim().slice(0, 12);
  const profile = document.getElementById('profileName');
  if (profile) profile.textContent = value || '未命名车手';
  if (value) {
    try { localStorage.setItem(NAME_KEY, value); } catch (_) { /* 禁用存储时仍可驾驶 */ }
  }
  return value;
}

export function initializeRaceUI() {
  const name = document.getElementById('name');
  let saved = '';
  try { saved = localStorage.getItem(NAME_KEY) || ''; } catch (_) { /* 无本地存储 */ }
  if (name && saved) name.value = saved.slice(0, 12);
  syncPlayerProfile(saved || name?.value);
  name?.addEventListener('input', () => syncPlayerProfile(name.value));
  const inRoom = document.getElementById('nameInRoom');
  document.getElementById('btnRename')?.addEventListener('click', () => {
    if (inRoom?.value.trim()) syncPlayerProfile(inRoom.value);
  });
  window.addEventListener('storage', event => {
    if (event.key === NAME_KEY) {
      if (name) name.value = (event.newValue || '').slice(0, 12);
      syncPlayerProfile(event.newValue);
    }
  });
  const mode = document.getElementById('gameMode');
  mode?.addEventListener('change', () => setPenaltyMode(mode.value));
  setPenaltyMode(mode?.value || 'fm8');
}

initializeRaceUI();
```

### 文件: public/js/engine-sound-worklet.js

```javascript
/*
 * engine-sound-worklet.js —— ForzaTech 风格波导引擎声（AudioWorklet）
 *
 * 改编自开源项目 Antonio-R1/engine-sound-generator（MIT License）：
 *   https://github.com/Antonio-R1/engine-sound-generator
 *   Copyright (c) 2021-2022 Antonio-R1
 * 改动（本项目）：
 *   · 合并为单文件自包含 worklet 模块（原仓库按 ES module 拆分 + 依赖 three.js 的非 worklet 路径已剔除）
 *   · 波导长度由主线程按 (sampleRate/44100) 缩放后传入（原版硬编码 44100）
 *   · 低通滤波器 alpha 用 worklet 全局 sampleRate 计算
 *   · process() 三路输出：[0] 进气  [1] 机体振动  [2] 排气尾管（主线程只取 [1]+[2] 混音）
 *
 * 物理模型：每个气缸 = 进气/排气/歧管三段波导（传输线方程的数字波导实现），
 * 进气阀/排气阀按曲柄角开闭（反射系数在开/关两档间切换），点火激励（fuel ignition）
 * 在压缩上止点附近注入脉冲，全体气缸排气汇入直管 -> 消音器（多支路并联） -> 尾管。
 * 音色由气缸数与管路几何决定 —— 这就是六缸/八缸/十二缸听感差异的物理来源。
 */
'use strict';

const SPEED_OF_SOUND = 343; // m/s（多普勒延迟用；本项目暂不启用）

class LowpassFilter {
   constructor(frequency, lastValue = 0.0) {
      this.frequency = frequency;
      this.alpha = 2.0 * Math.PI / sampleRate * frequency /
                   (2.0 * Math.PI / sampleRate * frequency + 1.0);
      this.lastValue = lastValue;
   }

   getFilteredValue(value) {
      this.lastValue = this.lastValue + this.alpha * (value - this.lastValue);
      return this.lastValue;
   }
}

class Cylinder {
   constructor({index,
                intakeWaveguideLength,
                exhaustWaveguideLength,
                extractorWaveguideLength,
                intakeOpenReflectionFactor,
                intakeClosedReflectionFactor,
                exhaustOpenReflectionFactor,
                exhaustClosedReflectionFactor,
                ignitionTime}) {
      this.index = index;
      this.cylinderWaveguide = new Waveguide(10, 0.75, 0.75);
      this.intakeWaveguide = new Waveguide(intakeWaveguideLength, 0.01, intakeOpenReflectionFactor);
      this.exhaustWaveguide = new Waveguide(exhaustWaveguideLength, exhaustClosedReflectionFactor, 0.01);
      this.extractorWaveguide = new Waveguide(extractorWaveguideLength, 0.01, 0.01);
      this.intakeOpenReflectionFactor = intakeOpenReflectionFactor;
      this.intakeClosedReflectionFactor = intakeClosedReflectionFactor;
      this.exhaustOpenReflectionFactor = exhaustOpenReflectionFactor;
      this.exhaustClosedReflectionFactor = exhaustClosedReflectionFactor;
      this.ignitionTime = ignitionTime;
      this.intakeValve = null;
      this.exhaustValve = null;
      this.pistonMotion = null;
      this.fuelIgnition = null;
   }

   updateWaveguidesReflectionValues() {
      this.intakeWaveguide.reflectionFactorRight = this.intakeOpenReflectionFactor * this.intakeValve +
                                                   this.intakeClosedReflectionFactor * (1.0 - this.intakeValve);
      this.cylinderWaveguide.reflectionFactorLeft = this.intakeOpenReflectionFactor * this.intakeValve +
                                                    this.intakeClosedReflectionFactor * (1.0 - this.intakeValve);
      this.exhaustWaveguide.reflectionFactorLeft = this.exhaustOpenReflectionFactor * this.exhaustValve +
                                                   this.exhaustClosedReflectionFactor * (1.0 - this.exhaustValve);
      this.cylinderWaveguide.reflectionFactorRight = this.exhaustOpenReflectionFactor * this.exhaustValve +
                                                     this.exhaustClosedReflectionFactor * (1.0 - this.exhaustValve);
   }

   update(intakeNoise, straightPipeOutputLeft, x) {
      this.exhaustValve = this._exhaustValve(x);
      this.intakeValve = this._intakeValve(x);
      this.pistonMotion = this._pistonMotion(x);
      this.fuelIgnition = this._fuelIgnition(x, this.ignitionTime);
      this.updateWaveguidesReflectionValues();
      intakeNoise = intakeNoise * this.intakeValve;
      const currentCylinderAmplitude = this.pistonMotion * 1.5 + this.fuelIgnition * 5.0;
      this.currentCylinderAmplitude = currentCylinderAmplitude;
      this.exhaustOutputLeft = this.exhaustWaveguide.outputLeft;
      this.exhaustOutputRight = this.exhaustWaveguide.outputRight;
      const extractorOutputLeft = this.extractorWaveguide.outputLeft;
      const extractorOutputRight = this.extractorWaveguide.outputRight;
      const cylinderOutputLeft = this.cylinderWaveguide.outputLeft;
      const cylinderOutputRight = this.cylinderWaveguide.outputRight;
      const intakeOutputLeft = this.intakeWaveguide.outputLeft;
      const intakeOutputRight = this.intakeWaveguide.outputRight;
      this.extractorWaveguide.add(this.exhaustWaveguide.outputRight, straightPipeOutputLeft);
      this.exhaustWaveguide.add(cylinderOutputRight * (1.0 - 0 * this.exhaustWaveguide.reflectionFactorLeft),
                                extractorOutputLeft);
      this.cylinderWaveguide.add(currentCylinderAmplitude + intakeOutputRight * (1.0 - this.intakeWaveguide.reflectionFactorRight),
                                 extractorOutputLeft * (1.0 - this.exhaustWaveguide.reflectionFactorLeft));
      this.intakeWaveguide.add(intakeNoise, cylinderOutputLeft * (1.0 - this.intakeWaveguide.reflectionFactorRight));
   }

   _exhaustValve(x) {
      if (0.75 < x && x < 1.0) {
         return -Math.sin(4.0 * Math.PI * x);
      }
      return 0;
   }

   _intakeValve(x) {
      if (0 < x && x < 0.25) {
         return Math.sin(4.0 * Math.PI * x);
      }
      return 0;
   }

   _pistonMotion(x) {
      return Math.cos(4.0 * Math.PI * x);
   }

   _fuelIgnition(x, t) {
      if (0.0 < x && x < 0.5 * t) {
         return Math.sin(2.0 * Math.PI * (x / t));
      }
      return 0;
   }
}

class Muffler {
   constructor({elementLengths, action}) {
      this.elements = [];
      this.elementsCount = elementLengths.length;
      this.elementsCountInverse = 1.0 / this.elementsCount;
      for (let i = 0; i < elementLengths.length; i++) {
         this.elements[i] = new Waveguide(elementLengths[i], 0.0, action);
      }
      this.outputLeft = 0.0;
      this.outputRight = 0.0;
   }

   update(mufflerInput, outletValue) {
      mufflerInput = this.elementsCountInverse * mufflerInput;
      outletValue = this.elementsCountInverse * outletValue;
      this.outputLeft = 0.0;
      this.outputRight = 0.0;
      for (let i = 0; i < this.elementsCount; i++) {
         this.outputLeft += this.elements[i].outputLeft;
         this.outputRight += this.elements[i].outputRight;
         this.elements[i].add(mufflerInput, outletValue);
      }
   }
}

class DelayLine {
   constructor(length) {
      if (length < 1) {
         throw new Error("The length of the delay line needs to be a positive value.");
      }
      this.data = new Float32Array(length);
      this.index = 0;
   }

   setValues(values, factor) {
      if (this.data.length != values.length) {
         throw Error("The \"values\" array needs to have the same length as the delay line.");
      }
      for (let i = 0; i < values.length; i++) {
         this.data[i] = factor * values[i];
      }
   }

   updateLeft(value) {
      this.data[this.index] = value;
      this.index++;
      if (this.index >= this.data.length) {
         this.index = 0;
      }
   }

   updateRight(value) {
      this.data[this.index] = value;
      this.index--;
      if (this.index < 0) {
         this.index = this.data.length - 1;
      }
   }

   getAtPosition(index) {
      index = this.index + index;
      while (index < 0) {
         index += this.data.length;
      }
      while (index >= this.data.length) {
         index -= this.data.length;
      }
      return this.data[index];
   }
}

class Waveguide {
   constructor(length, reflectionFactorLeft, reflectionFactorRight) {
      this.upper = new DelayLine(length);
      this.lower = new DelayLine(length);
      this.reflectionFactorLeft = reflectionFactorLeft;
      this.reflectionFactorRight = reflectionFactorRight;
      this.maxIndex = length - 1;
      this.outputLeft = 0.0;
      this.outputRight = 0.0;
   }

   add(valueLeft, valueRight) {
      const reflectedValueLeft = this.lower.getAtPosition(0 * this.maxIndex) * this.reflectionFactorLeft;
      this.outputLeft = this.lower.getAtPosition(0 * this.maxIndex) * (1.0 - this.reflectionFactorLeft);
      const reflectedValueRight = this.upper.getAtPosition(0 * this.maxIndex) * this.reflectionFactorRight;
      this.outputRight = this.upper.getAtPosition(0 * this.maxIndex) * (1.0 - this.reflectionFactorRight);
      this.upper.updateRight(valueLeft + reflectedValueLeft);
      this.lower.updateLeft(valueRight + reflectedValueRight);
   }
}

class EngineSoundGenerator extends AudioWorkletProcessor {
   constructor(options) {
      super();
      const processorOptions = options.processorOptions;
      this.secondsPerSample = 1.0 / sampleRate;
      this.rpm = 0.0;
      this.currentRevolution = 0.0;
      this.intakeNoiseLowPassFilter = new LowpassFilter(11000.0);
      this.crankshaftLowPassFilter = new LowpassFilter(75.0);
      this.engineLowPassFilter = new LowpassFilter(125.0);
      this.sound = null;
      this.intakeSound = null;
      this.outletSound = null;
      this.updateParameters({
         cylinderCount: processorOptions.cylinders,
         intakeWaveguideLength: processorOptions.intakeWaveguideLength,
         exhaustWaveguideLength: processorOptions.exhaustWaveguideLength,
         extractorWaveguideLength: processorOptions.extractorWaveguideLength,
         intakeOpenReflectionFactor: processorOptions.intakeOpenReflectionFactor,
         intakeClosedReflectionFactor: processorOptions.intakeClosedReflectionFactor,
         exhaustOpenReflectionFactor: processorOptions.exhaustOpenReflectionFactor,
         exhaustClosedReflectionFactor: processorOptions.exhaustClosedReflectionFactor,
         ignitionTime: processorOptions.ignitionTime,
         straightPipeWaveguideLength: processorOptions.straightPipeWaveguideLength,
         straightPipeReflectionFactor: processorOptions.straightPipeReflectionFactor,
         mufflerElementsLength: processorOptions.mufflerElementsLength,
         action: processorOptions.action,
         outletWaveguideLength: processorOptions.outletWaveguideLength,
         outletReflectionFactor: processorOptions.outletReflectionFactor});
      this.port.onmessage = (event) => {
         this.updateParameters(event.data);
      };
   }

   updateParameters({cylinderCount,
                     intakeWaveguideLength, exhaustWaveguideLength,
                     extractorWaveguideLength,
                     intakeOpenReflectionFactor, intakeClosedReflectionFactor,
                     exhaustOpenReflectionFactor, exhaustClosedReflectionFactor, ignitionTime,
                     straightPipeWaveguideLength, straightPipeReflectionFactor,
                     mufflerElementsLength, action,
                     outletWaveguideLength, outletReflectionFactor}) {
      this.cylinders = [];
      this.cylindersCountInverse = 1.0 / cylinderCount;
      for (let i = 0; i < cylinderCount; i++) {
         this.cylinders.push(new Cylinder({index: i,
                                           intakeWaveguideLength: intakeWaveguideLength,
                                           exhaustWaveguideLength: exhaustWaveguideLength,
                                           extractorWaveguideLength: extractorWaveguideLength,
                                           intakeOpenReflectionFactor: intakeOpenReflectionFactor,
                                           intakeClosedReflectionFactor: intakeClosedReflectionFactor,
                                           exhaustOpenReflectionFactor: exhaustOpenReflectionFactor,
                                           exhaustClosedReflectionFactor: exhaustClosedReflectionFactor,
                                           ignitionTime: ignitionTime}));
      }
      this.straightPipe = new Waveguide(straightPipeWaveguideLength, straightPipeReflectionFactor,
                                        straightPipeReflectionFactor);
      this.muffler = new Muffler({elementLengths: mufflerElementsLength, action: action});
      this.outlet = new Waveguide(outletWaveguideLength, outletReflectionFactor, outletReflectionFactor);
   }

   static get parameterDescriptors() {
      return [{
         name: 'throttle',
         defaultValue: 0.0,
         minValue: 0.0,
         maxValue: 1.0,
         automationRate: 'a-rate'
      }, {
         name: 'rpm',
         defaultValue: 0.0,
         minValue: 0.0,
         automationRate: 'a-rate'
      }];
   }

   _updateSample(index) {
      this.sound[index] = 0.0;
      let intakeNoise = this.intakeNoiseLowPassFilter.getFilteredValue(2.0 * Math.random() - 1.0);
      if (this.rpm < 25.0) {
         intakeNoise = 0;
      }
      const crankshaftValue = this.crankshaftLowPassFilter.getFilteredValue(0.25 * Math.random());
      for (let i = 0; i < this.cylinders.length; i++) {
         const x = this.currentRevolution + i * (this.cylindersCountInverse + crankshaftValue);
         this.cylinders[i].update(intakeNoise, this.straightPipe.outputLeft, x % 1);
         this.sound[index] += this.cylinders[i].cylinderWaveguide.outputLeft;
      }
      this.currentRevolution += this.secondsPerSample * this.rpm / 120.0;
      if (this.currentRevolution > 1.0) {
         this.currentRevolution -= 1.0;
      }
      this.intakeSound[index] = 0;
      for (let i = 0; i < this.cylinders.length; i++) {
         this.intakeSound[index] += this.cylinders[i].intakeWaveguide.outputLeft;
      }
      let straightPipeInput = 0.0;
      for (let i = 0; i < this.cylinders.length; i++) {
         straightPipeInput += this.cylinders[i].extractorWaveguide.outputRight;
      }
      this.straightPipe.add(straightPipeInput, this.muffler.outputLeft);
      this.outlet.add(this.muffler.outputRight, 0.0);
      this.outletSound[index] = this.outlet.outputRight;
      this.muffler.update(this.straightPipe.outputRight, this.outlet.outputLeft);
   }

   process(inputList, outputList, parameters) {
      this.chunkSize = outputList[0][0].length;
      const channelIntake = outputList[0][0];
      const channelEngineBlockVibrations = outputList[1][0];
      const channelOutlet = outputList[2][0];
      this.sound = channelEngineBlockVibrations;
      this.intakeSound = channelIntake;
      this.outletSound = channelOutlet;
      for (let i = 0; i < this.chunkSize; i++) {
         this.throttle = parameters["throttle"].length > 1 ? parameters["throttle"][i] : parameters["throttle"][0];
         this.rpm = parameters["rpm"].length > 1 ? parameters["rpm"][i] : parameters["rpm"][0];
         this._updateSample(i);
      }
      for (let i = 0; i < this.chunkSize; i++) {
         channelEngineBlockVibrations[i] = this.engineLowPassFilter.getFilteredValue(this.sound[i]);
      }
      return true;
   }
}

registerProcessor("forza-engine-processor", EngineSoundGenerator);
```

## 赛道几何定义

> oval 为 v2 新增赛道；`oval-geometry.js` 本轮未改。

### 文件: public/js/oval-geometry.js

```javascript
/*
 * 新手 · 极简高速环道（Stadium Oval Circuit）
 *
 * 【定位】给新手与"高速跟车/尾流对抗"准备的入门赛道：
 *   · 两条大直道 + 两个宽半径平缓弯（R = 180m，远大于任何车型的极限弯速）
 *   · 无立交、无急弯、无街道窄口，路宽沿用全局 14m（半宽 7.0m）
 *   · 平面投影**零自交**（封闭凸环），因此不触碰立交分层/桥面净空那套逻辑
 *
 * 【为什么是程序化几何、而不是 OSM】
 *   铃鹿 / 斯帕 / 拉斯维加斯是**真实场地**，必须逐点复刻（见 suzuka/spa/vegas-geometry）。
 *   本赛道是刻意设计的合成入门环道，没有对应的真实赛场，所以由解析式给出：
 *   直道严格平行于 Z 轴、弯道严格是半径 180m 的半圆 —— 端点连续、切向连续、
 *   曲率只有两个离散取值，任何"最小转弯半径/坡度"审计都能给出确定答案。
 *
 * 【坐标系与行车方向】
 *   与 track.js 全局约定一致：控制点是 (x, z)，顺序 = 行车顺序。
 *   发车线位于 p[0] = (R, 0)，即右侧主直道的中点，车头朝 +Z。
 *   全圈几何：右侧直道 → 北半圆 → 左侧直道 → 南半圆 → 回到发车线。
 *
 * 【尺寸】
 *   straightHalf = 200m（单侧直道半长）  radius = 180m
 *   周长 = 2 × 400m（两条直道）+ 2 × π × 180m（两个半圆）= 800 + 1130.97 ≈ 1931m
 */

const OVAL_RADIUS = 180;   // 半圆弯半径 (m)
const OVAL_HALF = 200;     // 直道沿 Z 的半长 (m)

/** 生成闭合控制点列（(x, z) 数组，顺序 = 行车顺序，首点 = 发车线）。 */
function buildOvalPts(radius = OVAL_RADIUS, straightHalf = OVAL_HALF) {
  const pts = [];
  const straightSteps = 24;   // 直道分段（等长，保证 Catmull-Rom 切线严格沿 Z）
  const curveSteps = 32;      // 半圆分段（每段 5.625°，矢高 < 0.22m）
  const r2 = (v) => Number(v.toFixed(4));

  // ① 右侧主直道：从发车线 (r, 0) 向 +Z 走到弯前
  for (let i = 0; i < straightSteps; i++) {
    pts.push([radius, r2((i / straightSteps) * straightHalf)]);
  }
  // ② 北侧半圆：a ∈ [0, π]，从 (r, +half) 经 (0, +half+r) 到 (-r, +half)
  for (let i = 0; i < curveSteps; i++) {
    const a = (i / curveSteps) * Math.PI;
    pts.push([r2(Math.cos(a) * radius), r2(straightHalf + Math.sin(a) * radius)]);
  }
  // ③ 左侧副直道：从 (-r, +half) 向 -Z 走到 (-r, -half)
  for (let i = 0; i < straightSteps * 2; i++) {
    pts.push([-radius, r2(straightHalf - (i / (straightSteps * 2)) * (straightHalf * 2))]);
  }
  // ④ 南侧半圆：a ∈ [π, 2π]，从 (-r, -half) 经 (0, -half-r) 到 (+r, -half)
  for (let i = 0; i < curveSteps; i++) {
    const a = Math.PI + (i / curveSteps) * Math.PI;
    pts.push([r2(Math.cos(a) * radius), r2(-straightHalf + Math.sin(a) * radius)]);
  }
  // ⑤ 回到发车线：右侧主直道下半段 (r, -half) → (r, 0)
  for (let i = 0; i < straightSteps; i++) {
    pts.push([radius, r2(-straightHalf + (i / straightSteps) * straightHalf)]);
  }
  return pts;
}

/**
 * 导出几何。字段与其它 *-geometry.js 保持同一形状，便于 track.js 用同一条路径消费：
 *   pts                 控制点列 (x, z)，顺序 = 行车顺序
 *   perimeter           解析周长 (m)，供审计比对（真值 = 2·L + 2πR）
 *   bbox                [xmin, xmax, zmin, zmax]
 *   selfIntersections   平面自交对数（本赛道恒为 0）
 *   startFinishFraction 发车线在圈上的比例（首点即发车线 ⇒ 0）
 *   corners             弯位标注（比例 + 名称），供 HUD/调试使用
 */
export const OVAL_GEOMETRY = {
  source: 'Procedural rookie high-speed oval (no real-world counterpart)',
  center: [0, 0],
  radius: OVAL_RADIUS,
  straightHalf: OVAL_HALF,
  // 解析周长：2 条 400m 直道 + 2 个半径 180m 的半圆
  realPerimeter: 2 * (2 * OVAL_HALF) + 2 * Math.PI * OVAL_RADIUS,
  osmPerimeter: 2 * (2 * OVAL_HALF) + 2 * Math.PI * OVAL_RADIUS,
  bbox: [-OVAL_RADIUS, OVAL_RADIUS, -(OVAL_HALF + OVAL_RADIUS), OVAL_HALF + OVAL_RADIUS],
  selfIntersections: 0,
  startFinishFraction: 0,
  startFinishDist: 0,
  // 圈上比例按**等弧长**解析给出：
  //   ① 右直道 0 → 200m（0 → 0.1036）
  //   ② 北半圆 200 → 765.5m（0.1036 → 0.3965），中点 0.250
  //   ③ 左直道 765.5 → 1165.5m（0.3965 → 0.6036），中点 0.500
  //   ④ 南半圆 1165.5 → 1731.0m，中点 0.750
  //   ⑤ 右直道下半段 1731.0 → 1931.0m，回到 p[0] = 发车线
  corners: [
    { name: '1 号北弯', fraction: 0.250, dist: 0 },
    { name: '西侧全油门直道', fraction: 0.500, dist: 0 },
    { name: '2 号南弯', fraction: 0.750, dist: 0 },
  ],
  pts: buildOvalPts(),
};

export default OVAL_GEOMETRY;
```

### 文件: public/js/suzuka-geometry.js

```javascript
/* 铃鹿赛道中心线 —— 由 tools/import-suzuka-osm.mjs + tools/suzuka-orient.mjs 从 OpenStreetMap 生成，**请勿手改**。
 *
 * 数据来源：OpenStreetMap relation 284570 (type=circuit, 鈴鹿サーキット)
 * 投影：局部切平面（中心 34.844399,136.533289），单位米。
 * 实测：OSM 中心线周长 5795.04m（真实单圈 5807m）、包围盒 1964×1042m。
 *
 * ⚠️ **数组已按行车方向展开，index 0 = 起终点线**（真车起终点在主直道后段、距 1 号弯约 300m）。
 *    OSM 原始拼接的起点在第 284 段，行车方向相对其索引顺序递减。
 *    立体交叉（8 字形自交）落在圈上 79.56% / 43.4% 处。
 *
 * ⚠️ 这是**真实铃鹿**的走线，不随 seed 变化（真车场地是固定的）。
 */
export const SUZUKA_GEOMETRY = {"source":"OpenStreetMap relation 284570 (type=circuit, 鈴鹿サーキット)",
  "center":[34.844399,136.533289],
  "realPerimeter":5807,
  "osmPerimeter":5795.04,
  "bbox":[-1038.7,925.2,-601.9,440.3],
  "startIndexInOsm":284,
  "travelDirVsOsmIndex":-1,
  "selfIntersections":1,
  "selfIntersectionPct":[79.56,43.4],
  "pts":[[664.67,-146.75],[689.29,-176.4],[713.9,-206.05],[737.89,-235.22],[761.88,-264.4],[785.87,-293.57],[809.86,-322.75],[833.86,-351.92],[857.85,-381.1],[881.84,-410.27],[898.98,-431.19],[908.36,-443.13],[916.05,-456.84],[920.48,-467.49],[922.68,-474.9],[923.94,-480.81],[924.98,-489.27],[925.21,-495.2],[924.47,-505.26],[922.78,-514.83],[920.48,-523.63],[915.57,-539.77],[905.87,-567.86],[900.45,-577.2],[895.53,-584.43],[887.71,-591.03],[878.89,-596.2],[869.3,-599.8],[859.23,-601.73],[848.97,-601.93],[838.84,-600.38],[829.11,-597.14],[820.09,-592.3],[812.03,-586.01],[803.75,-577.32],[789.24,-553.48],[767.89,-520.43],[746.54,-487.39],[725.18,-454.34],[712.68,-436.9],[705.26,-428.79],[696.69,-421.86],[687.18,-416.28],[676.93,-412.21],[666.17,-409.69],[655.15,-408.8],[628.55,-408.29],[618.54,-407.4],[608.73,-405.13],[599.34,-401.55],[590.53,-396.72],[582.49,-390.73],[575.34,-383.7],[569.24,-375.75],[564.3,-367.05],[560.6,-357.76],[557.35,-347.97],[550.19,-321.2],[543.04,-294.43],[539.92,-284.18],[535.46,-274.44],[529.73,-265.38],[522.84,-257.14],[514.91,-249.9],[506.08,-243.76],[502.6,-241.99],[496.5,-238.86],[486.35,-235.26],[475.8,-233.04],[465.06,-232.24],[426.69,-231.1],[420.47,-230.68],[412.59,-230.14],[399.56,-226.52],[388.11,-221.38],[376.73,-214.56],[366.76,-206.49],[357.12,-195.72],[349.72,-185.16],[344.33,-173.44],[341.11,-160.97],[340.17,-148.13],[341.53,-135.31],[345.15,-122.94],[349.06,-113.03],[357.95,-89.56],[366.85,-66.09],[370.41,-54.63],[372.25,-42.77],[372.32,-30.77],[370.63,-18.87],[367.21,-7.36],[362.13,3.52],[355.51,13.57],[347.48,22.54],[338.21,30.25],[322.4,39.56],[303.8,48.82],[289.15,55.39],[274.28,61.25],[263.62,65.12],[253.91,67.38],[245.02,69.45],[232.27,71.22],[221.49,72.32],[198.47,72.73],[186.46,72.04],[172.69,71.23],[157.62,68.6],[142.06,63.29],[109.24,48.96],[94.32,41.33],[78.8,31.82],[66.29,22.39],[58.66,15.56],[53.16,10.28],[47.89,5.19],[34.47,-8.57],[12.28,-35.22],[-9.9,-61.87],[-32.08,-88.51],[-54.26,-115.16],[-58.21,-119.92],[-64.46,-125.73],[-70.03,-128.12],[-102.65,-130.96],[-135.27,-133.79],[-167.88,-136.63],[-200.5,-139.47],[-210.96,-139.6],[-215.96,-137.96],[-220.46,-135.25],[-224.25,-131.62],[-227.16,-127.27],[-229.01,-122.37],[-230.13,-117.12],[-236.85,-83.19],[-243.57,-49.27],[-250.29,-15.34],[-257.02,18.59],[-263.74,52.51],[-270.46,86.44],[-277.19,120.36],[-282.29,146.6],[-284.17,162.09],[-283.95,174.58],[-281.79,187.39],[-275.5,206.77],[-265.16,228.66],[-253.68,254.63],[-242.19,280.59],[-240.11,288.16],[-241.03,296.08],[-243.85,302.21],[-248.46,307.22],[-254.55,310.37],[-261.36,311.54],[-267.93,310.55],[-274.34,307.51],[-279.59,302.52],[-284.02,296.81],[-297.45,274.42],[-310.89,252.04],[-316.37,243.73],[-334.05,216.07],[-352.97,185.75],[-363.98,172.21],[-373.43,161.15],[-387.52,147.08],[-395.33,140.02],[-403.54,134.2],[-428.11,119.7],[-451.91,112.41],[-479.85,109.05],[-498.17,107.4],[-516.83,106.58],[-530.55,106.85],[-547.39,108.43],[-572.06,111.75],[-606.64,120.14],[-637.49,130.49],[-668.59,141.8],[-690.21,151.66],[-711.41,163.83],[-729.51,176],[-749.92,192.71],[-761.48,204.52],[-771.6,215.97],[-779.72,225.83],[-788.63,237.92],[-799.73,256.27],[-809.7,275.93],[-824.5,310.09],[-839.29,344.25],[-853.05,375.34],[-866.81,406.43],[-870.32,412.4],[-873.87,417.07],[-878.36,421.76],[-883.45,426.22],[-889.61,430.62],[-895.58,433.68],[-902.56,436.44],[-910.02,438.42],[-925.69,440.3],[-945.93,439.56],[-958.92,438.24],[-973.61,435.46],[-991.3,430.86],[-1001.71,426.85],[-1011.42,422.31],[-1016.34,419.49],[-1021.71,414.97],[-1026.46,409.15],[-1031.54,401.05],[-1035.07,393.13],[-1038.09,382.5],[-1038.73,371.22],[-1037.89,361.29],[-1034.99,349.96],[-1031.31,340.1],[-1024.39,327.79],[-1019.25,320.69],[-1015.55,316.53],[-1001.83,301.11],[-985.97,287.19],[-969.47,273.5],[-938.72,249.43],[-917.69,234.03],[-899.49,221.54],[-877.73,207.46],[-855.98,193.38],[-836.22,181.75],[-816.45,170.12],[-797.83,160.23],[-779.2,150.33],[-749.7,136.02],[-741.3,131.94],[-716.47,120.97],[-683.69,107.3],[-658.57,98.46],[-633.45,89.61],[-604.41,79.4],[-575.37,69.18],[-546.33,58.96],[-509.49,45.99],[-472.65,33.02],[-435.81,20.05],[-400.81,7.79],[-365.82,-4.48],[-330.82,-16.74],[-295.83,-29],[-260.83,-41.27],[-226.47,-53.48],[-216.36,-56.65],[-209.81,-58.13],[-197.25,-59.4],[-183.98,-58.48],[-170.84,-55.57],[-154.27,-50.62],[-139.48,-45.82],[-123.98,-40.13],[-111.09,-34.39],[-98.29,-28.82],[-87.45,-22.74],[-66.95,-9.8],[-54.69,-1.55],[-45.54,5.3],[-26.94,20.81],[-7.54,38.81],[11.86,56.8],[30.23,73.72],[51.73,93.42],[73.24,113.13],[94.75,132.83],[100.25,137.48],[117.49,150.95],[124.89,156.08],[132.53,161.21],[137.7,164.23],[141.52,165.5],[145.19,166.25],[148.63,166.27],[151.96,165.44],[155,163.83],[178.3,143.52],[182.86,140.55],[188.03,138.83],[193.47,138.44],[198.83,139.43],[203.78,141.72],[207.97,145.18],[228.73,163.49],[242.77,172.96],[255.02,179.17],[267.96,183.96],[284.74,186.49],[297.8,186.95],[310.64,186.35],[320.26,185.12],[324.95,184.41],[334.96,182.91],[340.71,181.64],[357.24,176.45],[368.46,172.1],[393.22,158.4],[413.64,143.91],[428.58,131.04],[444.25,116.2],[464.46,93.55],[478.42,77.17],[492.38,60.78],[516.99,31.14],[541.6,1.49],[566.22,-28.16],[590.83,-57.81],[615.44,-87.46],[640.06,-117.1]]};
```

### 文件: public/js/spa-geometry.js

```javascript
/* Circuit de Spa-Francorchamps 赛道中心线 —— 由 tools/import-track-osm.mjs 从 OpenStreetMap 生成，**请勿手改**。
 *
 * 数据来源：OpenStreetMap relation 284560 (type=circuit, Circuit de Spa-Francorchamps)
 * 投影：局部切平面（中心 50.434619,5.9691），单位米。
 * 实测：OSM 中心线周长 6970.54m（真实单圈 7004m）、
 * 包围盒 1275×2054m、
 * 投影自交 0 处、起终点在 0.00% 处（取自 OSM raceway=start-finish，距该 way 首节点 Infinitym）。
 *
 * ⚠️ 这是**真实赛道**的走线，不随 seed 变化（真车场地是固定的）。
 */
export const SPA_GEOMETRY = {"source":"OpenStreetMap relation 284560 (type=circuit, Circuit de Spa-Francorchamps)",
  "center":[50.434619,5.9691],
  "realPerimeter":7004,
  "osmPerimeter":6970.54,
  "bbox":[-675.4,599.6,-767.4,1286.9],
  "selfIntersections":0,
  "startFinishFraction":0,
  "startFinishDist":null,
  "corners":[{"name":"Eau Rouge",
  "fraction":0.0546,
  "dist":0},{"name":"Raidillon",
  "fraction":0.072,
  "dist":0},{"name":"Kemmel",
  "fraction":0.1315,
  "dist":0},{"name":"Les Combes",
  "fraction":0.2208,
  "dist":0},{"name":"Malmedy",
  "fraction":0.2878,
  "dist":0},{"name":"Bruxelles",
  "fraction":0.3375,
  "dist":0},{"name":"Speaker's Corner",
  "fraction":0.4094,
  "dist":0},{"name":"Double Gauche",
  "fraction":0.4715,
  "dist":0},{"name":"Fagnes",
  "fraction":0.5682,
  "dist":0},{"name":"Campus",
  "fraction":0.6551,
  "dist":0},{"name":"Courbe Paul Frère",
  "fraction":0.6948,
  "dist":0},{"name":"Blanchimont",
  "fraction":0.7792,
  "dist":0},{"name":"Chicane",
  "fraction":0.8908,
  "dist":0},{"name":"La Source",
  "fraction":0.9801,
  "dist":0}],
  "pts":[[-378.52,1280.68],[-356.9,1271.04],[-335.27,1261.4],[-313.77,1250.92],[-292.27,1240.44],[-261.69,1222.97],[-241.56,1212.73],[-220.17,1200.12],[-199.93,1187.16],[-173.83,1168.11],[-159.78,1156.9],[-147.51,1146.57],[-135.77,1136.52],[-118.49,1120.72],[-96.35,1097.12],[-74.12,1071.44],[-51.9,1045.76],[-29.68,1020.08],[-8.67,995.39],[12.34,970.7],[33.35,946.01],[54.36,921.32],[65.58,907.93],[83.45,887.06],[90.25,879.55],[93.24,876.26],[99.13,871.45],[113.37,861.62],[122.11,856.39],[135.38,848.43],[140.81,844.93],[148.46,839.83],[155.65,834.43],[161.69,829.44],[167.17,823.96],[172.49,817.07],[175.93,812.74],[180.17,805.7],[183.99,798.89],[187.95,791.33],[192.14,780.88],[196.99,767.13],[200.14,753.69],[201.87,742.85],[203.29,732.46],[205.08,719.36],[206.71,708.9],[207.78,702.57],[209.17,696.7],[211.83,689.48],[215.18,681.87],[218.07,676.52],[220.95,671.6],[230.05,656.76],[242.2,638.02],[254.34,619.27],[272.66,590.75],[290.98,562.24],[309.29,533.72],[327.61,505.2],[343.89,481.28],[351.45,470.56],[357.71,461.05],[363.45,451.41],[368.32,442.8],[372.79,434.19],[377.86,423.98],[382.28,413.78],[389.73,394.29],[396.35,367.92],[406.45,332.68],[416.55,297.44],[426.94,261.28],[437.34,225.12],[447.74,188.96],[458.13,152.8],[468.53,116.64],[478.93,80.48],[489.32,44.32],[499.61,8.38],[509.89,-27.56],[520.17,-63.49],[530.46,-99.43],[540.74,-135.37],[551.02,-171.31],[561.31,-207.25],[571.59,-243.19],[581.87,-279.13],[588.08,-298.99],[593.2,-316.17],[597.49,-330.96],[598.72,-337.8],[599.47,-342.88],[599.57,-348.18],[599.12,-352.34],[597.51,-358.85],[595.1,-365.63],[591.64,-371.26],[586.81,-377.43],[581.24,-382.8],[577.23,-385.28],[571.31,-388.47],[562.93,-392.94],[559.37,-395.35],[556.18,-398.12],[550.97,-402.86],[545.74,-409.9],[542.83,-415.3],[540.39,-421.25],[538.77,-426.39],[538.11,-431.64],[538.06,-436.33],[538.45,-440.96],[539.04,-445.42],[541.03,-455.47],[549.91,-490.94],[558.78,-526.41],[561.68,-539.93],[562.76,-548.35],[561.97,-555.88],[560.78,-560.03],[559.49,-565.66],[557.87,-569.34],[555.45,-574.09],[552.84,-578.67],[549.79,-582.27],[546.96,-585.78],[543.09,-589.1],[530.82,-598.16],[514.91,-608.83],[484.8,-629.62],[454.69,-650.41],[424.57,-671.21],[394.46,-692],[364.35,-712.8],[334.23,-733.59],[304.12,-754.38],[294.02,-761.11],[286.97,-764.53],[282.04,-766.13],[274.55,-767.33],[267.34,-767.39],[260.32,-766.59],[252.95,-764.75],[244.84,-761.09],[238.67,-757.16],[233.31,-752.13],[228.51,-745.75],[224.72,-739.2],[222.26,-732.66],[220.91,-726.17],[220.31,-719.31],[220.55,-712.24],[221.63,-705.63],[223.7,-699.07],[226.55,-693.42],[230.29,-687.96],[234.6,-683.01],[238.08,-679.85],[244.07,-675.4],[251.57,-670.71],[258.7,-666.48],[280.36,-652.85],[302.03,-639.21],[328.47,-622.8],[334.2,-619.58],[344.05,-613.53],[353.01,-607.34],[358.16,-602.54],[362.88,-596.47],[366.47,-589.82],[368.91,-582.96],[370.35,-575.19],[370.71,-568.85],[370.48,-562.46],[368.57,-555.37],[363.54,-540.36],[355.23,-515.73],[346.93,-491.11],[338.29,-464.12],[329.66,-437.13],[320.5,-407.86],[315.62,-390.4],[312.36,-377.14],[306.27,-342.88],[299.01,-304.33],[291.76,-265.79],[284.51,-227.24],[279.46,-197.64],[274.42,-168.04],[269.37,-138.44],[266.42,-124.77],[263.33,-112.15],[258.82,-101.79],[253.22,-91.96],[245.54,-81.65],[236.84,-72.91],[229.88,-67.15],[222.94,-61.76],[211.29,-55.31],[201.86,-51.37],[192.51,-49.05],[184.61,-47.82],[157.51,-45.69],[130.41,-43.56],[124.01,-43.05],[114.93,-42.96],[106.59,-43.3],[93.26,-45.06],[79.87,-48.19],[69.82,-51.08],[60.61,-54.62],[48.95,-60.06],[38.55,-66.03],[29.95,-71.58],[22.63,-77.46],[13.59,-85.89],[5.37,-94.5],[-4.26,-106.53],[-11.01,-118.06],[-18.48,-133.11],[-29.32,-159.7],[-40.17,-186.29],[-51.02,-212.88],[-63.81,-244.18],[-76.6,-275.48],[-89.4,-306.79],[-102.19,-338.09],[-114.99,-369.39],[-127.78,-400.69],[-131.32,-410.18],[-132.78,-413.61],[-136.35,-422.02],[-140.9,-430.24],[-145.21,-436.85],[-149.95,-442.71],[-157.92,-450.32],[-166.42,-456.57],[-174.61,-460.66],[-185.48,-464.65],[-197.09,-466.83],[-204.37,-467.51],[-212.31,-467.02],[-219.82,-465.86],[-228.74,-463.75],[-237.7,-460.43],[-246.47,-455.89],[-255.4,-449.89],[-267.8,-441.89],[-280.36,-435.76],[-287.14,-433.64],[-295.44,-432.16],[-305.16,-431.45],[-317.11,-432.2],[-328.19,-434.79],[-338.1,-438.52],[-347.29,-443.49],[-354.95,-449.84],[-362.48,-456.57],[-368.92,-465.65],[-389.18,-496.94],[-409.44,-528.22],[-427.61,-555.91],[-447.55,-587.71],[-465.21,-615.6],[-470.1,-623.05],[-473.63,-628.24],[-481.28,-635.51],[-486.44,-639.12],[-491.82,-642.32],[-497.01,-644.31],[-502.85,-646.1],[-511.45,-647.2],[-519.47,-646.82],[-529.37,-645.08],[-538.57,-640.67],[-546.41,-635.43],[-571.32,-617.42],[-596.22,-599.41],[-621.13,-581.4],[-631.84,-573.61],[-639.03,-568.4],[-644.58,-563.54],[-654.19,-552.87],[-660.15,-544.38],[-665.45,-534.84],[-668.58,-528.02],[-671.13,-521.05],[-673.11,-513.81],[-674.47,-506.58],[-675.38,-492.55],[-674.66,-480.04],[-672.68,-468.45],[-669.72,-457.95],[-658.94,-429.77],[-648.16,-401.6],[-640.06,-382.84],[-633.42,-370.17],[-624.43,-355.15],[-616.68,-343.93],[-604.9,-325.98],[-590.55,-307.38],[-575.24,-290.06],[-553.34,-267.2],[-530.37,-244.45],[-506.43,-221.64],[-496.05,-212.01],[-485.25,-202.59],[-473.25,-193.17],[-460.61,-184.61],[-444.83,-174.45],[-434.56,-168.59],[-425.37,-163.58],[-394.88,-147.83],[-364.39,-132.09],[-333.85,-116.22],[-303.32,-100.35],[-270.58,-83.06],[-255.61,-74.73],[-241.61,-65.32],[-229.64,-57.1],[-217.1,-46.59],[-200.59,-31],[-183.84,-13.26],[-174.11,-0.6],[-166.51,10.59],[-159.66,21],[-153.22,32.27],[-139.78,59.05],[-128.05,85.09],[-116.32,111.13],[-104.59,137.17],[-95.31,158.18],[-86.02,179.2],[-81.94,188.67],[-77.7,200.45],[-75,211.2],[-73.48,220.19],[-72.66,230.91],[-72.56,238.61],[-72.92,248.58],[-74.55,261.25],[-77.96,274.54],[-83.89,290.9],[-98.15,328.2],[-112.4,365.5],[-126.66,402.8],[-140.92,440.1],[-155.18,477.4],[-162.93,503.95],[-168.65,527.9],[-171.46,543.55],[-173.85,560.01],[-177.97,588.71],[-180.96,627.03],[-183.22,655.92],[-185.48,684.81],[-187.84,711.17],[-190.2,737.52],[-191.03,749.87],[-191.05,753.86],[-190.13,757.29],[-188.81,760.22],[-187.19,762.45],[-184.99,764.57],[-181.72,766.43],[-177.21,767.41],[-172.5,767.31],[-169.24,766.94],[-163.43,766.29],[-145.58,765.39],[-141.3,766],[-136.76,767.35],[-133.71,770.03],[-131.03,773.6],[-129.7,777.47],[-129.34,781.58],[-129.59,785.69],[-130.81,789.56],[-133.1,793.7],[-143.78,808.7],[-162.28,840.85],[-180.78,873],[-199.29,905.16],[-217.79,937.31],[-233.13,964.02],[-248.47,990.72],[-263.81,1017.43],[-279.16,1044.13],[-298.38,1077.73],[-317.6,1111.33],[-336.82,1144.93],[-356.05,1178.52],[-375.27,1212.12],[-388.27,1234.71],[-401.26,1257.29],[-408.29,1270.47],[-408.47,1275.14],[-407.01,1280.03],[-405.36,1282.74],[-402.73,1285.31],[-394.35,1286.94],[-386.76,1283.94]]};
```

### 文件: public/js/vegas-geometry.js

```javascript
/* Las Vegas Strip Circuit 赛道中心线 —— 由 tools/import-track-osm.mjs 从 OpenStreetMap 生成，**请勿手改**。
 *
 * 数据来源：OpenStreetMap relation 16696508 (type=circuit, Las Vegas Strip Circuit)
 * 投影：局部切平面（中心 36.116533,-115.166485），单位米。
 * 实测：OSM 中心线周长 6191.13m（真实单圈 6201m）、
 * 包围盒 1173×1947m、
 * 投影自交 0 处、起终点在 0.00% 处（取自 OSM raceway=start-finish，距该 way 首节点 Infinitym）。
 *
 * ⚠️ 这是**真实赛道**的走线，不随 seed 变化（真车场地是固定的）。
 */
export const VEGAS_GEOMETRY = {"source":"OpenStreetMap relation 16696508 (type=circuit, Las Vegas Strip Circuit)",
  "center":[36.116533,-115.166485],
  "realPerimeter":6201,
  "osmPerimeter":6191.13,
  "bbox":[-599.5,573.1,-949.1,997.7],
  "selfIntersections":0,
  "startFinishFraction":0,
  "startFinishDist":null,
  "corners":[{"name":"Las Vegas Strip Circuit",
  "fraction":0,
  "dist":0},{"name":"East Harmon Avenue",
  "fraction":0.058,
  "dist":0},{"name":"West Harmon Avenue",
  "fraction":0.2014,
  "dist":0},{"name":"South Las Vegas Boulevard",
  "fraction":0.2048,
  "dist":0},{"name":"Spring Mountain Road",
  "fraction":0.4881,
  "dist":0},{"name":"Sands Avenue",
  "fraction":0.4915,
  "dist":0},{"name":"Westchester Drive",
  "fraction":0.7543,
  "dist":0},{"name":"Koval Lane",
  "fraction":0.785,
  "dist":0}],
  "pts":[[550.48,-644.78],[542.15,-657.68],[516.52,-686.41],[490.89,-715.15],[465.26,-743.89],[439.63,-772.63],[414,-801.37],[393.67,-824.17],[373.33,-846.98],[352.99,-869.78],[341.06,-883.16],[328.07,-897.76],[315.09,-909.43],[300.39,-918.67],[283.25,-926.21],[267.68,-933.35],[254.86,-937.98],[232.36,-946.64],[221.07,-948.57],[213.8,-948.58],[210.38,-948.58],[184.03,-948.62],[157.69,-948.65],[134.98,-948.88],[112.27,-949.1],[88.62,-948.75],[64.96,-948.4],[43.7,-948.47],[22.43,-948.55],[-8.22,-948.5],[-38.87,-948.46],[-69.51,-948.41],[-100.16,-948.36],[-111.16,-948.38],[-115.38,-948.4],[-123.06,-948.42],[-150.33,-948.49],[-177.6,-948.56],[-190.24,-948.72],[-199.74,-948.84],[-234.23,-948.43],[-268.71,-948.01],[-303.2,-947.6],[-312.85,-947.51],[-325.35,-947.38],[-333.62,-947.14],[-365.57,-946.88],[-397.52,-946.62],[-431.45,-946.91],[-454.57,-946.21],[-477.68,-945.51],[-488.27,-944.87],[-498.28,-943.01],[-505.61,-940.49],[-513.22,-936.05],[-520.6,-929.95],[-526.68,-924.98],[-546.4,-906.89],[-568.34,-884.98],[-584.09,-868.55],[-599.48,-853.61],[-598.82,-832.54],[-598.57,-816.52],[-598.78,-784.31],[-598.83,-759.7],[-598.89,-735.09],[-598.73,-710.83],[-598.57,-686.58],[-598.45,-682.18],[-598.41,-673.24],[-598.05,-633.72],[-597.89,-616.34],[-597.59,-604.98],[-596.99,-588],[-596.66,-578.53],[-595.88,-554.65],[-594.9,-527.6],[-594.39,-508.28],[-593.43,-480.81],[-592.61,-458.07],[-591.79,-435.32],[-590.99,-412.01],[-590.2,-388.69],[-589.65,-351.4],[-589.09,-314.12],[-588.54,-276.83],[-586.91,-245.3],[-585.29,-213.76],[-584.32,-194.92],[-584.41,-179.09],[-584.63,-141.11],[-584.86,-103.13],[-585.08,-65.15],[-584.95,-27.35],[-584.83,10.45],[-584.7,48.25],[-584.94,81.11],[-584.86,86.67],[-584.46,97.24],[-584.39,104.03],[-584.13,108.07],[-582.46,138.7],[-580.8,169.33],[-580.25,179.18],[-577.61,202.15],[-574.05,233.02],[-570.49,263.9],[-564.54,301.19],[-558.82,327.89],[-556.27,340.53],[-552.9,355.1],[-549.95,366.61],[-549.39,369.5],[-542.76,394.44],[-539.72,404.72],[-532.55,429.01],[-525.38,453.3],[-522.01,464.84],[-513.73,491.26],[-505.45,517.68],[-497.17,544.1],[-485.9,569.89],[-474.63,595.68],[-463.36,621.47],[-459.93,628.13],[-457.55,632.56],[-450.07,645.51],[-434.85,671.86],[-430.46,679.49],[-416.18,704.07],[-401.91,728.64],[-390.43,748.37],[-384.22,760.14],[-373.39,780.37],[-363.92,798.06],[-354.45,815.75],[-343.13,836.91],[-331.81,858.08],[-316.64,887.35],[-301.47,916.62],[-286.3,945.89],[-281.29,955.56],[-268.75,981.31],[-260.16,997.66],[-249.98,996.21],[-239.79,994.75],[-226.6,992.14],[-202.03,987.55],[-167.52,981.16],[-134.22,972.89],[-125.11,969.58],[-100.83,960.66],[-82.55,947.96],[-63.75,930.93],[-45.65,914.52],[-36.22,904.62],[-29.74,893.49],[-28.32,891.06],[-21.03,876.48],[-15.94,862.84],[-8.44,842.98],[1.04,817.75],[10.52,792.51],[20,767.27],[34.75,736.63],[43.76,722.92],[64.23,701.77],[89.85,679.54],[112.64,668.13],[132.61,663.54],[152.58,658.94],[175.74,657.79],[198.91,656.63],[208.98,656.13],[219.94,636.33],[227.71,636.35],[251.62,636.44],[253.57,636.45],[281.8,636.5],[310.02,636.56],[332.65,635.94],[359.8,635.06],[386.96,634.17],[412.2,633.33],[437.45,632.49],[475.97,631.74],[514.5,630.99],[546.68,630.41],[546.6,623.33],[546.38,619.35],[545.58,588.98],[544.73,584.45],[543.21,580.29],[527.57,549.94],[520.92,535.38],[518.9,529.77],[517.11,522.71],[516.12,515.78],[516.28,507.45],[516.72,502.36],[518.32,496.85],[520.2,491.8],[522.87,487.03],[528.17,481.49],[532.36,478.03],[536.65,474.89],[540.29,472.99],[547.9,470.79],[560.66,467.83],[573.04,465.09],[573.12,451.21],[570.47,423.68],[565.34,399.43],[557.86,382.33],[556.21,378.57],[547.23,359.29],[532.72,339.3],[516.52,323.62],[500.31,307.95],[497.47,306],[487.42,299.11],[476.62,291.73],[442.34,292.39],[408.07,293.05],[377.21,293.79],[346.34,294.53],[315.48,295.28],[307.34,295.31],[268.65,295.44],[229.96,295.58],[223.93,295.6],[223.91,277.07],[224.13,247.27],[224.36,217.48],[224.58,187.68],[224.49,171.5],[224.71,142.69],[224.94,113.88],[225.16,85.08],[225.3,73.99],[225.33,71],[225.68,37.07],[225.68,30.28],[225.94,0.03],[226.2,-30.23],[226.43,-50.4],[226.66,-70.56],[226.79,-88.9],[226.8,-104.22],[226.77,-129.23],[226.43,-166.95],[226.08,-204.67],[226.2,-215],[226.35,-231.43],[226.28,-242.65],[226.34,-245.59],[226.58,-258.63],[226.87,-285.63],[226.97,-295.58],[227.18,-314.85],[227.3,-325.65],[227.54,-348.86],[227.91,-382.83],[228.27,-416.8],[228.83,-429.24],[228.82,-461.62],[228.81,-494],[228.8,-526.38],[229.46,-553.56],[229.7,-574.07],[229.94,-594.59],[245.28,-623.62],[258.51,-640.4],[274.67,-654.27],[289.62,-662.54],[304.07,-668.13],[320.48,-673.24],[335.67,-673.48],[353.79,-670.81],[368.48,-665.94],[380.64,-657.68],[399.18,-640.04],[417.72,-622.4],[441.73,-606.35],[458.38,-597.83],[474.79,-593.21],[493.41,-592.24],[512.51,-594.91],[525.25,-598.8],[535.78,-604.16],[545.83,-613.4],[552.07,-625.56],[552.68,-634.32]]};
```
