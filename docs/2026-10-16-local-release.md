# 赛车本地修复版与部署说明

更新日期：2026-10-16。在仓库根目录运行 `go build -o forzalan.exe .` 构建 Windows 程序，或运行 `go run .` 启动服务。以下双击启动步骤适用于另行打包的本地运行版；Git 仓库按惯例不包含 exe。尚未部署公网服务。

本日追加 Bug 复查：修复旧包覆盖赛况、跨线复位和逆行名次跳变，以及两处 P2P 配置/重连竞态。详见 [Bug 复查报告](2026-10-16-bug-review.md)。请先关闭旧服务器再运行新版。

## 本地启动

1. 双击「启动游戏.cmd」，保留弹出的服务器窗口；浏览器打开 http://localhost:8099 。
2. 首次启动时，如 Windows 询问防火墙权限，局域网联机需允许专用网络访问。
3. 同一 Wi-Fi 的朋友访问 http://电脑的局域网IPv4地址:8099 ，进入同一房间；可在终端运行 ipconfig 查看地址。
4. 退出时关闭服务器窗口。积分和成绩写入程序工作目录，保留该目录里的 JSON 数据。
5. 8099 被占用时，在 forzalan 目录运行：`forzalan.exe -addr :8100`，再访问 http://localhost:8100 。

局域网手机使用 HTTP 可以触控游玩；陀螺仪通常需要浏览器信任的 HTTPS，普通局域网 HTTP 地址不满足该条件。

## 13 项调整

| 需求 | 本次实现 |
| --- | --- |
| 1 房主看到其他车停在起点 | Worker 就绪并校准时钟后才处理缓存快照，避免大厅长时间等待后的时间轴错误；人类远端车同步完整赛况。 |
| 2 压草出现巨大时间差 | 时间差取两车经过同一赛道位置的时刻；缺少共同记录时不编造秒差，横向偏离不作为纵向落后距离。 |
| 3 名次跳动 | 行驶中按累计过线次数与连续赛道弧长排序，使用切线投影修正采样点间位置；完赛后保留成绩排序。 |
| 4 罚时规则 | 碰碰车模式全部免罚，包括切弯和复位；所有模式撞墙均不罚时、不弹罚时调查。前端、物理、服务端同时处理。 |
| 5 最优走线 | 优化时按各处实际路宽约束，预留车身宽度；颜色比较当前车速、目标速度与可用刹车距离，实时绿/黄/红变化。 |
| 6 地图拐角 | 改用向心 Catmull–Rom 插值，减少不均匀控制点造成的弯角过冲，保留原赛道锚点。 |
| 7 3D 车辆 | 收窄车头/尾轮廓、优化玻璃座舱，增加后视镜、侧裙、轮辐及轮胎细分。仍为程序化模型。 |
| 8 手柄 | 标准映射手柄：左摇杆转向、RT 油门、LT 刹车、A 手刹；模拟扳机、摇杆死区、断开与页面失焦处理。 |
| 9 手机 | 多点触控按钮；可开启体感并校准；横屏两种方向的传感器投影；点击开始时尝试全屏与横屏锁定，提供手动全屏按钮。 |
| 10 P2P | 房间内可勾选 P2P 车辆直连，WebRTC 不可靠无序通道传输位姿；服务器继续处理房间、计时和成绩，并保留同步回退。支持开关重连。 |
| 11 上下坡 | 去除重复坡度重力，限制悬挂法向力；在物理步前后执行路面穿透修正，避免向内速度积累。 |
| 12 英文罚时 | 已知原因统一中文，未知原因显示“赛事规则”。 |
| 13 草地惯性 | 去除直接乘系数扣速度和额外软限速，草地阻力由受力积分产生，入草程度渐变，减小重复阻力。 |

## 操控与手机限制

键盘 WASD 或方向键驾驶。手柄连接后先按任意键，让浏览器识别；当前支持浏览器的 standard 映射手柄，非标准设备需另做映射。

手机点击“启用体感”，授予运动传感器权限，自然握持后点击“回正校准”。油门、刹车、手刹使用屏幕按钮。浏览器可拒绝自动全屏或横屏锁定，特别是部分 iOS 浏览器；此时手动横置并用触控继续。网页无法绕过浏览器权限限制。

本机没有实体手柄与手机，输入算法已做自动验证，实际设备手感、权限弹窗及横屏行为仍需真机验收。
相关平台说明：[体感权限](https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static)、[横屏锁定](https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock)。

## 公网部署

P2P 仍需要大家可访问的游戏/信令服务器；仅勾选 P2P，不能让外网朋友访问你本机的 localhost。当前未配外部 STUN/TURN，已验证同机两浏览器的直接通道，跨运营商与复杂 NAT 尚未实测。

推荐使用一台云服务器、一域名、HTTPS 反向代理和 STUN/TURN：

1. 将源码复制至服务器并安装 Go，在仓库目录运行 `go build -o forzalan .`。Linux 运行 `./forzalan -addr 127.0.0.1:8099`。Windows 可直接使用交付 exe。
2. 将域名解析到云服务器；安装 Caddy，建立以下 Caddyfile（替换域名），开放 TCP 80/443。Caddy 会处理 HTTPS 和 WebSocket 升级。
3. 用 systemd 或对应服务管理器托管游戏进程与 Caddy，游戏工作目录设为可持久写入的目录。
4. 所有人打开同一个 HTTPS 游戏域名、加入同一房间；需要直连的玩家分别勾选 P2P。无法直连时服务器同步继续可用。

```caddyfile
race.example.com {
    reverse_proxy 127.0.0.1:8099
}
```

### STUN/TURN 配置

服务端通过环境变量 FORZALAN_ICE_SERVERS 读取浏览器 RTCIceServer 数组。以下是格式示例，地址和凭据必须替换成自己实际可用的服务，示例本身不可连接。

PowerShell：
```powershell
$env:FORZALAN_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"},{"urls":["turn:turn.example.com:3478?transport=udp","turns:turn.example.com:5349?transport=tcp"],"username":"临时用户名","credential":"临时凭据"}]'
.\forzalan.exe -addr 127.0.0.1:8099
```

Linux：
```sh
export FORZALAN_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478?transport=udp","username":"TEMP_USER","credential":"TEMP_CREDENTIAL"}]'
./forzalan -addr 127.0.0.1:8099
```

STUN 帮助发现可连接地址；部分 NAT 必须经 TURN 中继。自建 coturn 还需按其配置开放监听端口及中继 UDP 端口范围。游戏的 HTTPS 反向代理不会代理 WebRTC 的 UDP 数据。

GET /api/rtc-config 会向浏览器公开该数组，这是 WebRTC 建连所必需的。使用短期、限额凭据；不要填云账户密钥或 TURN 的长期签名主密钥。当前版本读取静态配置，不会自动生成或刷新 TURN 临时凭据；公开运营前应补充临时凭据签发与访问控制。可以先不用 P2P，通过服务器联机验收。

## 验证与范围

- Go 全部单元测试通过，包含名次、同位置时间差和服务端罚时回归。
- 新增 request-regression-check：大厅等待时钟、双通道乱序、四地图进度连续性、走线边界/变色、手柄/体感输入算法通过。
- 新增 request-physics-check：四条完整赛道采样路径的垂直支撑约束通过；测试以给定水平轨迹检查垂直物理，并非真人完整驾驶验收。草地单步测试从 50.000 降到 49.985 m/s，入草不再直接修改速度。
- 两个真实 Edge 页面验证人类与 AI 同步、P2P 单独传位姿、短时断流恢复、房主交接和末圈结算。
- 浏览器罚时检查通过，运行时异常为零。
- 最终 exe 通过 HTTP 提供的 25/25 项 public 资源与源码 SHA-256 一致。
- 四赛道几何检查使用每图 1 个种子通过。旧 track-anchor-check 引用仓库缺失的 roundStreetCorners 导出和 suzuka-osm-source.xml，当前不能运行；没有将其计为通过。

主要复验命令（仓库目录，Node 24 与 Go）：
```powershell
go test ./...
go build -o forzalan.exe .
node tools/request-regression-check.mjs
node tools/request-physics-check.mjs
node tools/bumper-mode-check.mjs
node tools/penalty-controller-check.mjs
$env:P2P='1'
node tools/lan-sync-check.mjs
node tools/embedded-assets-check.mjs
```

外网高延迟、多运营商 NAT、实体手机/手柄及长时间多人负载尚未验收；地图和车模的视觉改动也需要你结合实际驾驶反馈继续调整。
