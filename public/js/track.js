import * as CANNON from '../libs/cannon-es.js';
import { SUZUKA_GEOMETRY } from './suzuka-geometry.js';
import { VEGAS_GEOMETRY } from './vegas-geometry.js';
import { SPA_GEOMETRY } from './spa-geometry.js';
import { OVAL_GEOMETRY } from './oval-geometry.js';
// 让下游（track-verify / selftest / 导入工具）能从 track.js 一处拿到走线数据，
// 不必各自去猜模块路径。
export { SUZUKA_GEOMETRY };

/* =============================================================================
 * track.js —— 纯代码数学生成的封闭 3D 赛道（多赛道版）
 *
 * 【零资源原则】
 *   本文件不加载任何外部纹理 / 模型 / 字体。全部几何体由 BufferGeometry 逐顶点
 *   计算生成，颜色由顶点色与材质给出；唯一一张"贴图"是用 Canvas2D 现场绘制的
 *   发车龙门横幅（CanvasTexture，同样属于纯代码产物）。
 *
 * 【统一生成接口】
 *   generateTrack(scene, world, trackType, seed) -> Track
 *   大厅内可自由切换 trackType（'suzuka' | 'vegas'），换赛道只需重建一次。
 *
 * 【数学结构】
 *   每条赛道由一组**手工控制点**（XZ 平面）定义，经 Catmull-Rom 闭合样条
 *   加密后**按等弧长重采样**为 N 个骨架点；纵向高程由 elevation(u) 叠加。
 *   每个骨架点携带 (切线 t, 水平右向量 side, 曲面法线 n)，构成沿路坐标系。
 *
 * 【坐标系约定（与 physics.js 严格一致）】
 *   前向 f = 车体局部 +Z     上向 u = 车体局部 +Y
 *   世界系：side = normalize(cross(tXZ, up))，n = normalize(cross(side, t))
 *   注意 side 实际指向**车身左侧**（右手系 right = forward × up），
 *   lateral = dot(P - C, side) —— 正值在左侧。
 *
 * 【立交（overpass）分层求解】
 *   路面同时保留 sample() 的快速查询和按路段切分的 Cannon Heightfield。
 *   每个 Heightfield 是真实静态碰撞形状，桥面/地面各自带 layer 标签；物理
 *   suspension raycast 通过这些形状选取当前高度层，避免解析弹簧把车抬穿路面。
 *   铃鹿的 8 字立体交叉：桥面骨架点 y 抬高 BRIDGE_Y，桥下地面保持低标高；
 *   两处通行段在 XZ 上重合但**弧长相差很远**，nearest() 的 ±WINDOW 局部窗口
 *   天然把车锁在当前所在的那一层；窗口内若同时命中两层，再用车辆当前高度
 *   做二次判别（|Δy| 更接近的那层胜出）。
 * ========================================================================== */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const UP = { x: 0, y: 1, z: 0 };

/** 赛道尺寸与采样参数（physics.js / main.js 共用，改这里即可全局生效） */
// Road Heightfields are query-only: excluded from vehicle/barrier collision
// pairs while remaining raycastable through their dedicated filter group.
export const ROAD_COLLISION_GROUP = 2;

export const TRACK_CFG = {
  N: 1440,               // 环线等弧长采样点数（1440 / 24 Checkpoint = 每个 CP 60 点）
  HALF_WIDTH: 7.0,       // 半路宽 -> 沥青**有效总宽 14m**（规格：统一 14 米）
  ASPHALT_HALF_W: 7.0,   // 沥青路面有效半宽：车轮横向偏移超出即算驶离沥青，
                         // physics.js 的赛道外沙地减速陷阱以此判定（>2 轮出界即触发）
  CURB_W: 1.2,           // 路肩（红白立体减速带）最大宽度
  CURB_H: 0.06,          // 路肩凸起高度（可见/可感的"起伏"）
  CURB_R_ON: 90,         // 曲率半径 ≤ 此值 ⇒ 立起路肩（真弯道）
  CURB_R_OFF: 260,       // 曲率半径 ≥ 此值 ⇒ 不铺路肩（直道，与路面齐平）
  GRASS_W: 42,           // 缓冲区（草地/沙地）外延宽度
  CHECKPOINTS: 24,       // Checkpoint 数量（规格：24 个隐藏触发盒）
  EDGE_LINE: 0.30,       // 路面内侧白线宽
  CENTER_LINE: 0.20,     // 中央虚线宽

  // ---- 立交桥（仅铃鹿）----
  // 2026-09-30 抬高：原来 BRIDGE_Y=7.5、且"保证净空"只保 BRIDGE_MIN_H+1.5=**2.5m**，
  // 实测立交处净空就是 2.50m —— 而追尾/座舱相机就在 1.6~2.2m，从桥下过时**视角会被
  // 桥面挡死**（用户报障）。现在保证 **6.5m** 净空（真实高架桥 4.5~5.5m，游戏里留余量），
  // 桥面抬升同步提到 9.5m，并把引桥半宽从 235m 拉到 300m，坡度维持原来的水平。
  BRIDGE_Y: 9.5,         // 桥面相对桥下地面抬升高度 (m)
  BRIDGE_MIN_H: 1.0,     // 桥下通行最小净空 (m)：地面层不得高于 桥面-BRIDGE_MIN_H
  BRIDGE_CLEAR_M: 6.5,   // ★ 立交上下两层必须保证的垂直净空 (m)：低于这个值相机就会被挡
  BRIDGE_RAMP_M: 300,    // 立交影响区**沿弧长的半宽**（米）：平顶 + 两端引桥缓坡
  BRIDGE_FLAT_M: 72,     // 桥面平顶的弧长半宽（米）

  // ---- 转角平滑（把手工控制点的尖角修圆到可玩半径）----
  SMOOTH_PASSES: 3,      // 拉普拉斯平滑遍数
  SMOOTH_K: 0.42,        // 每遍的平滑强度 ∈ (0,1]

  // ---- 动态最佳走线（Racing Line）----
  RACE_LINE_W: 1.2,      // 色带宽度 (m)
  RACE_LINE_H: 0.04,     // 悬浮高度 (m)，防止与沥青 Z-fighting 闪烁
  RACE_LINE_GAIN: 120,   // 曲率 -> 偏移量增益（|曲率|=1/120m 时吃满横向偏移）
  RACE_LINE_MARGIN: 1.0, // 走线中心距路缘的最小余量 (m)

  // ---- 弯道拥挤区（规格 §三.2：Congestion Zones）----
  // 用于 physics.js 判定"车是否处在弯道拥挤区"，见 Track.buildCongestionZones()。
  // ⚠ 判据用**分位数**而非固定半径：三大赛道曲率尺度差异极大（spa 高速弯为主），
  //   固定 130m 会让 spa 只圈出 1.7% 的赛道、急弯大面积漏检。见 buildCongestionZones()。
  CONGEST_R_PCTL: 0.14,    // 取半径序列该分位值作为"小半径弯"动态阈值（最急的 14%）
  CONGEST_R_MIN_M: 90,     // 动态阈值下限 (m)：防止缓弯赛道把阈值压得过低
  CONGEST_R_MAX_M: 320,    // 动态阈值上限 (m)：防止急弯赛道把阈值推得过高
  CONGEST_ZONE_SPAN_M: 60, // 连续弯道合并成区的最小跨度 (m)

  // ---- nearest() 局部窗口 ----
  WINDOW: 72,            // 窗口半径（采样点数）。60 点 ≈ 一段路，足够覆盖单帧 30m 位移
  LAYER_DY: 3.0,         // 分层判别的垂直容差 (m)：|Δy| 小于它视为"同一层"
  ROAD_PATCH_SAMPLES: 12, // 每个物理路面 patch 覆盖的中心线采样点数
  ROAD_CELL_SIZE: 1.5,    // Heightfield 横向/纵向网格间距 (m)
  ROAD_LATERAL_CELLS: 10, // 最小横向网格数；实际宽度按赛道半宽扩展
};

/**
 * 可选赛道类型（服务端 `sanitizeTrack` / `trackDisplayName` 白名单必须与此逐项一致，
 * 由 selftest / track-verify 守卫）。
 *   suzuka / vegas / spa —— 真实场地，OSM 实测走线烘焙
 *   oval                 —— 合成入门环道（新手 · 极简高速环道）
 */
export const TRACK_TYPES = ['suzuka', 'vegas', 'spa', 'oval'];

/**
 * 赛道主题：决定材质配色与地物（树林 / 城市 / 路灯）。
 *
 * 【本轮规格 §二.1/§二.2】地物一律**静态常量布置**：
 *   · 完全不用 Math.random，也**不用种子 RNG** —— 树木/建筑/山脊的位置、
 *     尺寸、朝向全部由 `statFrac(i, salt)` 下标哈希决定，任何 seed 都逐字节一致；
 *   · 每个地物中心点到赛道中心线的横向距离必须 ≥ 半宽 + BARRIER_OUT_M(=8.5m)，
 *     即严格落在**护栏外侧 5 米**以外；侵入的**直接跳过生成**。
 *   · 唯一仍与 seed 相关的是**赛道本身的形状**（见 buildTrackShape），
 *     因为"换 seed 换赛道走线"是设计意图；"换 seed 换景观"不是。
 *
 * 注意：此前有一版把 treeCount / buildingCount 全部置 0（"移除所有非赛道物件"），
 * 导致赛道两侧空无一物、只剩远景山脊。本版按规格恢复**静态布置**的植被与建筑。
 * hillCount 是 3000m 开外的远景山脊（只当地平线背景，不参与碰撞）。
 */
const THEMES = {
  suzuka: {
    sky: 0x8fb6d8, ground: 0x14401a, grass: 0x2f6b2c,
    asphalt: 0x363a42, hill: 0x24405c, night: false,
    treeCount: 340, hillCount: 90, buildingCount: 0, lampCount: 64,
    grandstandCount: 0,          // 铃鹿不再生成看台，避免遮挡视线与赛道
  },
  vegas: {
    sky: 0x070a14, ground: 0x121016, grass: 0x2a2620,
    asphalt: 0x2b2e34, hill: 0x141b2c, night: true,
    treeCount: 0, hillCount: 70, buildingCount: 210, lampCount: 96,
  },
  // 新手 · 极简高速环道：晴天、开阔、几乎没有地物（视野必须通透，新手不该被树挡视线）
  oval: {
    sky: 0x9cc4e4, ground: 0x1d4a1e, grass: 0x3d7b39,
    asphalt: 0x3a3e46, hill: 0x2a4a66, night: false,
    treeCount: 96, hillCount: 72, buildingCount: 0, lampCount: 48,
    grandstandCount: 0,          // 不生成看台，避免遮挡视线
  },
  // 斯帕-弗朗科尔尚：阿登森林，白天多云
  spa: {
    sky: 0x93a9bd, ground: 0x1b3a1c, grass: 0x2e6b2e,
    asphalt: 0x33373e, hill: 0x2b3f52, night: false,
    treeCount: 380, hillCount: 80, buildingCount: 0, lampCount: 72,
    grandstandCount: 0,          // 斯帕不再生成看台，避免遮挡视线与赛道
  },
};

/** 净空安全廊道：地物到赛道中心线的水平距离必须 > 半宽 + 该缓冲 */
export const CLEARANCE_BUFFER = 4.5;

/**
 * 规格 §一.2 的景观安全净空体系（比 CLEARANCE_BUFFER 更严，是**当前**的验收口径）：
 *   法向外推锚点 = 半宽 7.0 + 路肩 2.0 + 绿化缓冲带 5.0 = 14.0m
 *   双重距离排他校验：水平距离 D ≤ 13.5m 的实例直接剔除销毁
 * 注意锚点里**必须含路肩**：旧口径只算 半宽 + 4.5 = 11.5m，路灯按 hw+cw+5.2=13.4m 摆，
 * 看着"过了"，实际低于 13.5m 的剔除线 —— 灯杆会探进路肩外沿。
 */
export const CLEAR_ANCHOR_M = 7.0 + 2.0 + 5.0;   // 14.0
export const CLEAR_REJECT_M = 13.5;

/**
 * 规格 §五 —— 景观**绝对隔离**护栏外侧的最小横向间距（米）。
 *
 * 【本轮规格变更】旧值 5.0 已废弃：规格 §五 明确要求
 *   「所有景观中心到赛道中心线的 2D 水平距离**严格 >**（赛道半宽 + 8.5m）」
 * 即外推口径从"护栏外 5m"收紧为"半宽 + 8.5m"。半宽 7.0 ⇒ 最小净空 = 15.5m。
 * 三大赛道统一口径：路面（含路肩）与两侧缓冲区（树/看台/路灯/建筑）之间
 * 不再有任何交叠，硬隔离。
 */
export const BARRIER_OUT_M = 8.5;

/**
 * 地形裙边的**下沉量**：草地外沿（本地地面层 −1.10m）再往下这么深，作为
 * 地形网格在赛道附近的取值。
 *
 * 为什么不再用"从 −26 的大地圆盘"那套：那套是**悬空平台 + 一圈悬崖**。
 * 实测（tools/terrain-probe.mjs）：草地外沿到圆盘的垂直落差是 **18.4~30.2m**，
 * 而缓冲区半宽只有 8m、外侧草地到头 50m —— 于是赛道外侧紧挨着就是一面
 * 20~30m 的垂直墙，从座舱/追尾视角看就是"赛道外的路段塌陷、外面是个大坑"
 * （用户 2026-09-30 报障）。
 *
 * 2026-09-30 起改成**真地形**：
 *   · 裙边只把**真正外侧**那列顶点下沉到 `本地地面层 − TERRAIN_LIP`（浅唇，约 0.5m）；
 *   · 大地网格（`_buildGround`）在赛道附近取同一个高度 ⇒ 接缝不可见，
 *     再随距离**平滑过渡**到远景平原 `TERRAIN_FLOOR_Y`，不再有悬崖与深坑。
 */
export const TERRAIN_LIP = 1.6;

/**
 * 远景平原高度（离赛道约 900m 以外）。
 * 必须低于赛道地面层最低点（实测 −7.6m），否则会从路面/草地里穿出来；
 * 取 −12m 只比最低处低 4.4m，坡度极缓 —— 这是"真的地势低一点"，
 * 而不是原来那个 26m 的深坑。
 */
export const TERRAIN_FLOOR_Y = -12;

/** 地形网格从"贴合本地地面"过渡到"远景平原"的距离区间（米）。 */
export const TERRAIN_BLEND_IN = 70;
export const TERRAIN_BLEND_OUT = 900;

/**
 * ★ 地形圆锥包络参数（裙边唇口与地形网格**共用**同一套值的来源）：
 *   · CONE_D0：距某段路多近之内，地形恒为"该段地面层 − 浅唇"（= 裙边唇口高度）
 *   · CONE_L ：超出 D0 之后的衰减尺度（米）——越大越平缓
 *   · CONE_K ：衰减强度系数（与 L 一起决定斜率）
 * 三者必须与 `_buildGround` 里的用法一致：草地外沿距中心线约 51m < D0，
 * 所以唇口高度就是本地地面层 − 浅唇，与地形在同一函数上取值 ⇒ 接缝天然对齐。
 */
export const TERRAIN_CONE_D0 = 60;    // 距路 ≤ 此值：地形恒为"该段地面层 − 浅唇"
export const TERRAIN_CONE_L = 450;     // 衰减尺度（米）：越大越平缓
export const TERRAIN_CONE_R = 90;      // 只考虑此半径内的其他路段（远处的低路不许把近处地形拉下去）
//   ⚠️ 曾取 300m：149m 外那条低 5m 的路段也会把本地地形拉下 6~8m ⇒ 草地外沿被拖成悬崖

/** 规格 §五：景观中心到中心线的**硬性**最小水平距离 = 半宽 + 8.5m（= 15.5m）。 */
export function sceneryClearMin(halfWidth) { return halfWidth + BARRIER_OUT_M; }

/**
 * 规格 §五：铃鹿立交桥 3D 排除盒（XZ 投影矩形）的半尺寸。
 *   · 以**桥面中心**为基准，前/后各 ±60m（沿桥面轴向）；
 *   · 左/右各 ±25m（垂直桥面轴向）；
 *   · 盒内（桥面 Y=+7.5m 与桥下 Y=0.0m 之间的全部竖向空间）**禁止任何树木** ——
 *     杜绝树从桥下长出来穿透桥面。
 */
export const BRIDGE_EXCL_LEN = 60;   // 桥面中心 ±60m（前/后）
export const BRIDGE_EXCL_WID = 25;   // 桥面中心 ±25m（左/右）

/**
 * 规格 §五：桥下立柱的**硬性外推**距离（相对地面层道路半宽）。
 * 立柱从地面顶到桥面，必须锚定在下层沥青边缘外侧 4.0m 以外，
 * 保证下层道路净空 ≥16m、两条通行层 100% 不互相干扰。
 */
export const BRIDGE_PILLAR_OUT_M = 4.0;

/** 双重距离排他校验：水平横向距离不达标的景物一律不生成 */
export function clearOK(latAbs) { return Math.abs(latAbs) >= CLEAR_REJECT_M; }

/**
 * ★ 定向包围盒（OBB）五点净空判定 —— 大体积建筑的**精确**判据。
 *
 * 为什么需要它（本函数存在的唯一理由）：
 *   建筑落位此前用"中心点横向距离 lat，减去写死的 34m 半对角"近似：
 *       if (lat - 34 < CLEAR_REJECT_M) continue;
 *   但建筑底面尺寸 `w`/`dp` 各自最大 50m（`16 + rng()*34`），
 *   半对角最大 = √(25² + 25²) ≈ 35.36m **> 34m** ——
 *   也就是说**体量最大的那批建筑，角点仍能越过 34m 的保守半径**，
 *   在写死常数的盲区里侵入净空廊道。近似值必须换成真实几何。
 *
 * 判据（水平面内，忽略 Y 高程差）：
 *   取底面 OBB 的 **中心 + 4 个角点**（角点必须经 yaw 旋转矩阵变换到世界系），
 *   逐点与赛道样条线求最近点、算**横向投影距离** D（= 该点相对最近采样点的
 *   side 向量投影）。只要**任一点** D < (半宽 + 路肩 + 安全缓冲) 即判定不安全。
 *
 * @param {object} track   Track 实例（用其 pts/side/nearest）
 * @param {number} cx,cz   底面中心世界坐标 (X,Z)
 * @param {number} yaw     航向角（rad，绕 Y）
 * @param {number} halfW   底面 X 向半宽 (m)
 * @param {number} halfD   底面 Z 向半深 (m)
 * @param {number} need    安全距离下限 (m)，= 半宽 + 路肩 + 缓冲
 * @returns {{ok:boolean, minD:number}}  ok=false 表示至少一个点越界；minD = 五点最小 D
 */
export function obbClearOfTrack(track, cx, cz, yaw, halfW, halfD, need) {
  if (!track || !track.pts || !track.count) return { ok: true, minD: Infinity };
  const co = Math.cos(yaw), si = Math.sin(yaw);
  // 局部 (u,v) -> 世界 (X,Z)：绕 Y 轴旋转  [x] = [ co  si][u]
  //                                       [z] = [-si  co][v]
  // 4 个角点 + 中心，共 5 点（规格要求"中心与 4 个角点逐一对比"）
  const uu = [0, halfW, halfW, -halfW, -halfW];
  const vv = [0, halfD, -halfD, halfD, -halfD];
  let minD = Infinity;
  for (let p = 0; p < 5; p++) {
    const u = uu[p], v = vv[p];
    const wx = cx + co * u + si * v;
    const wz = cz - si * u + co * v;
    const i = track.nearest(wx, wz);
    const pt = track.pts[i], sd = track.side[i];
    // 横向投影距离 = 该点相对样条最近采样点的偏移在 side 向量上的投影
    const lat = (wx - pt.x) * sd.x + (wz - pt.z) * sd.z;
    const D = Math.abs(lat);
    if (D < minD) minD = D;
    if (D < need) return { ok: false, minD: D };   // 任一点越界即刻放弃
  }
  return { ok: true, minD };
}

/**
 * 建筑净空口径：横向投影距离必须 >= 半宽 + 路肩 + 安全缓冲余量。
 * 与 CLEAR_ANCHOR_M(14.0) 的口径**同源但独立**（14.0 = 7.0+2.0+5.0，本式缓冲取 4.0）。
 * 这里显式写出各项，避免再出现"写死一个数、与真实尺寸脱钩"的历史坑。
 */
export const BUILDING_CLEAR_BUFFER_M = 4.0;
export function buildingClearNeed(halfWidth, curbWidth) {
  return halfWidth + curbWidth + BUILDING_CLEAR_BUFFER_M;   // 7.0 + 1.2 + 4.0 = 12.2m
}

/* ---------------------------------------------------------------------------
 * 护栏刚体加厚（规格 §二.1）：防"隧道效应"（高速单帧位移跨过薄壁）。
 *   厚 2.0m / 高 2.5m / 下方深埋 1.0m；**可视护栏维持 1.4m**（第 4/6 轮已验收的观感）。
 *   内侧面与可视护栏内侧面同面 -> 加厚不吃可行驶宽度。
 * ------------------------------------------------------------------------- */
export const BARRIER_HULL_HX = 1.0;    // 半厚（厚 2.0m）
export const BARRIER_HULL_HY = 1.25;   // 半高（高 2.5m）
export const BARRIER_BURY = 1.0;       // 向下深埋（m）
export const BARRIER_VIS_HX = 0.35;    // 可视护栏半厚（0.7m 宽）
export const BARRIER_VIS_HALF_H = 0.75;

/* ---------------------------------------------------------------------------
 * 发车格数量（规格 §八）：由 4 扩展到 12，2 列 × 6 排交错。
 * 与服务端 main.go 的 maxPlayers 必须保持一致（静态守卫断言这一条）。
 * ------------------------------------------------------------------------- */
export const GRID_SLOTS = 12;

/* ---------------------------------------------------------------------------
 * 视野安全角（方案 F 规则 1）
 * 挡住视野的是**仰角**，不是绝对高度 —— 一栋 370m 的楼放在 45m 外，仰角 83°，
 * 整块视野直接堵死。规则：从车眼高度看向建筑顶端的仰角必须 ≤ θ。
 *   h ≤ tan(θ)·lat − 眼高
 * 弯道外侧要求更严（玩家最需要看到出弯点）。
 * ------------------------------------------------------------------------- */
export const VIEW_SAFE = {
  STRAIGHT: 0.30,   // rad ≈ 17°：直道两侧
  CORNER: 0.18,     // rad ≈ 10°：弯道外侧
  EYE_H: 1.2,       // 车眼高度 (m)
  CORNER_R: 420,    // 曲率半径小于它视为"弯道"
}; // 可视护栏半高（1.5m 高，与碰撞体顶面重合）

/* ---------------------------------------------------------------------------
 * 赛道控制点定义
 *
 * 每个定义返回 { ctl: [[x,z],...], elev(u)->y, sphere?: {x,z,r} }
 *   · ctl    —— XZ 平面闭合控制点（Catmull-Rom 会自行圆化转角）
 *   · elev   —— 以归一化参数 u∈[0,1) 为自变量的高程函数
 *   · sphere —— 需要"绕行"的球馆（拉斯维加斯）
 * ------------------------------------------------------------------------- */

/* =============================================================================
 * 铃鹿真车参数（2026-09-30 重构）
 *
 * 走线来自 OpenStreetMap relation 284570（type=circuit），已是**真实铃鹿**，
 * 不再由 seed 程序化生成。下列参数全部以**圈上里程百分比 v∈[0,1)** 为自变量，
 * 因为真车场地是固定的：宽度、护栏、立交位置都不该随 seed 变。
 *
 * ⚠️ 数据精度如实说明：
 *   · **走线**：OSM 测绘中心线，实测周长 5795m（真车 5807m，偏差 −0.2%），
 *     12 个弯名（1/2コーナー、S字、デグナー1/2、ヘアピン、西ストレート、
 *     スプーン、130R、シケイン）全部映射到折线上（误差 ≤34m），
 *     起终点自动落点距真车起终点线 30m。
 *   · **宽度**：真车公布路宽区间 10~16m。OSM 只有中心线、没有路宽数据，
 *     所以下表是按"路段性质"（直道最宽、高速弯次之、发卡/减速弯最窄）
 *     在 10~16m 区间内的**重建**，不是逐米实测值。
 *   · **护栏**：同上，按真车"永久赛道护栏位于缓冲区外沿"的惯例重建。
 *   · **立交**：由几何自洽决定 —— 8 字形自交在 v=79.55%（上行段）与 44.24%
 *     （下行段）投影相交，必须把 79.55% 那一段抬高 BRIDGE_Y 才不会穿模。
 * ========================================================================== */

/** 分段线性插值（闭合环，x 为圈上百分比 0~1，必须单调递增） */
function pctLerp(xs, ys, v) {
  const n = xs.length;
  let t = v - Math.floor(v);
  for (let i = 0; i < n; i++) {
    const x0 = xs[i], x1 = i + 1 < n ? xs[i + 1] : xs[0] + 1;
    if (t >= x0 && t <= x1) {
      const f = x1 > x0 ? (t - x0) / (x1 - x0) : 0;
      const y0 = ys[i], y1 = i + 1 < n ? ys[i + 1] : ys[0];
      return y0 + (y1 - y0) * f;
    }
  }
  return ys[0];
}

const SUZUKA_PCT = {
  main: 0.004, t1: 0.022, t2: 0.078, s1: 0.119, s2: 0.197,
  dunlop: 0.30, d1: 0.401, d2: 0.424, hairpin: 0.502, west: 0.576,
  spoon1: 0.651, spoon2: 0.703, r130: 0.829, chicane: 0.91,
};

/**
 * 半路宽（米）随圈上里程的变化 —— 对应真车 10~16m 路宽区间。
 * 主直道最宽（16m），高速弯/连接直道 14m，S 字与德格纳 12m，
 * 发卡与减速弯最窄（11m）。
 */
export const SUZUKA_HALF_WIDTH = {
  pct: [0.000, 0.010, 0.030, 0.070, 0.100, 0.150, 0.200, 0.330, 0.380,
    0.430, 0.480, 0.520, 0.560, 0.620, 0.680, 0.740, 0.800, 0.855,
    0.880, 0.900, 0.930, 0.960, 0.990],
  half: [8.0, 8.0, 7.2, 7.0, 6.2, 6.0, 6.6, 7.0, 6.2,
    6.0, 5.8, 5.5, 6.5, 6.4, 6.0, 6.8, 7.0, 6.6,
    6.0, 5.5, 5.7, 7.0, 8.0],
};

/** 起终点在主直道后段：index 0 即起终点线，前 X 米为发车格区 */
export const SUZUKA_START_ZONE_M = 300;

/** 立交：上行段（v≈0.7955）抬到桥面，下行段保持地面层 */
export const SUZUKA_BRIDGE_PCT = SUZUKA_GEOMETRY.selfIntersectionPct[0] / 100;

/**
 * 铃鹿（SUZUKA CIRCUIT）—— 真实走线重建。
 *
 * 走线**不再是程序化生成**：直接使用 OpenStreetMap relation 284570
 * （type=circuit, name=鈴鹿サーキット）测绘的中心线，269 个点、周长 5795m
 * （真车 5807m，偏差 −0.2%）。数据烘焙在 `suzuka-geometry.js`，游戏运行期
 * 不联网；要更新走线就重跑 `tools/import-suzuka-osm.mjs`（详见该脚本头注释）。
 *
 * 校验依据（防止有人误改数据）：12 个真实弯名在折线上的映射误差 ≤34m；
 * 起终点自动落点 (492,61) 距真车起终点线 (522,66) 仅 30m；
 * 8 字形立体交叉在投影上恰好自交 1 处。
 */
function suzukaDef(_seed) {
  // ⚠️ seed 在本赛道**不再参与形状生成**：真车场地是固定的。
  //    保留参数只为兼容 Track 的统一构造签名（vegas/spa 仍会用到 seed）。
  // OSM 数据里首点已按行车方向展开、且 index 0 = 起终点线（见 suzuka-geometry.js 头注释）。
  const ctl = SUZUKA_GEOMETRY.pts.map((p) => [p[0], p[1]]);
  return {
    ctl,
    elev: suzukaElev,
    hasBridge: true,
    // 立交中心（圈上百分比）+ 抬升量函数。
    // ⚠️ 两者都必须由赛道定义给出：Track 构造 baseY（桥下地面层/地物落位/分层判别）
    //    时要用**同一个** liftAt，写死 v≈0 或写死 +7.5m 都会让 baseY 与实际不符。
    bridgePct: SUZUKA_BRIDGE_PCT,
    liftAt: suzukaLift,
    // ★ smooth 必须为 0：318 个测绘点已足够密（p50 段长 13.8m），再做 Laplacian
    //   平滑既会磨圆真车发卡（实测最小半径 13.8m ≈ 真车 14m），又会把全长拉短。
    smooth: 0,
    barriers: true,
    // 护栏横向落位由 barrierLatAt(v) 逐点给出（真车护栏在缓冲区外沿）。
    barrierLatAt: suzukaBarrierLat,
    widthAt: (v) => pctLerp(SUZUKA_HALF_WIDTH.pct, SUZUKA_HALF_WIDTH.half, v),
    cp: 24,
  };
}

/**
 * 铃鹿高程：真实铃鹿有约 40m 的总落差，最高点在 8 字的上行段、
 * 最低点在主直道/发卡之间。OSM 只有平面数据，没有高程，所以这里给的是
 * **与真车性格一致的重建**：低频长波起伏 + 立交处的强制抬高。
 *
 * 立交必须抬高：v=79.55% 的上行段与 v=44.24% 的下行段在平面投影上相交，
 * 不抬高就会两条路面穿模（真车也是靠立体交叉解决这个 8 字）。
 */
/**
 * 铃鹿高程 = 低频地形起伏 + 立交处**保证净空**的抬升。
 *
 * ⚠️ 这里有一个必须显式处理的坑（本轮实测踩到）：地形起伏幅度（±7.6m）与桥面
 *    抬升量（BRIDGE_Y=7.5m）是同量级，两者**可能互相抵消** —— 实测立交处上下
 *    两层只剩 0.84m 高差（比 BRIDGE_MIN_H=1.0m 还小），车会从桥面掉到下层。
 *    所以桥面高度不能只是 `base + 7.5`，而必须写成：
 *        桥面高度 = max(base(本层), base(被跨层) + 净空余量)
 *    这样无论地形怎么起伏，立交都真的"立"得起来。
 *
 * v 为圈上百分比；SUZUKA_CROSS_PCT = [上行段, 下行段]（来自实测投影自交位置）。
 */
const SUZUKA_CROSS_PCT = SUZUKA_GEOMETRY.selfIntersectionPct.map((p) => p / 100);
function suzukaBase(v) {
  return 5.2 * Math.sin(TAU * v + 0.35) + 2.4 * Math.sin(TAU * 2 * v + 2.10);
}
/** 立交抬升量（米）。单独成函数是因为 Track 构造 baseY 时必须用**同一个**来源，
 *  否则 baseY 与 pts.y 的差不再是真实抬升量（分层判别、地物落位都会错）。 */
export function suzukaLift(v, total) {
  return TRACK_CFG.BRIDGE_Y * bridgeBumpAt(v, SUZUKA_BRIDGE_PCT, total);
}
function suzukaElev(v, total) {
  return suzukaBase(v) + suzukaLift(v, total);
}

/**
 * 桥面抬升包络（自变量为圈上百分比 v，周期 1）。
 * 中心为平顶 1.0，向两侧以余弦缓坡降到 0 —— 这就是两端引桥。
 * 桥面宽度/引桥长度用**米**给定再换算成 v，换赛道也不失真。
 */
function bridgeBumpAt(v, centerPct, total) {
  let d = Math.abs(v - centerPct) % 1;
  if (d > 0.5) d = 1 - d;                       // 环上最短距离，∈[0,0.5]
  const w = TRACK_CFG.BRIDGE_RAMP_M / total;
  const p = TRACK_CFG.BRIDGE_FLAT_M / total;
  if (d >= w) return 0;
  if (d <= p) return 1;
  const t = (d - p) / (w - p);
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/**
 * 铃鹿护栏横向落位（半宽 + 路肩 + 缓冲区），逐点给出。
 *
 * ⚠️ 与旧版的区别：旧版把护栏一律放在 `半宽+路肩+20m`（≈29m），
 * 因为当时铃鹿"刻意不布防"、依赖 42m 草地带做沙地脱困。用户要求护栏位置
 * 与真车一致后改成：**护栏紧贴缓冲区外沿**（半宽+路肩+缓冲），
 * 与真车永久赛道一致；缓冲宽度取真车典型的砂石/草地缓冲区尺度。
 */
export const SUZUKA_RUNOFF_M = 9.0;      // 缓冲区宽度（路肩外沿 → 护栏）
export function suzukaBarrierLat(v) {
  const hw = pctLerp(SUZUKA_HALF_WIDTH.pct, SUZUKA_HALF_WIDTH.half, v);
  return hw + TRACK_CFG.CURB_W + SUZUKA_RUNOFF_M;
}

/**
 * 拉斯维加斯：1.9km 全油门大直道 + 多个 90° 直角弯 + 绕 Sphere 球馆弧形弯。
 *
 * 直道沿 z=0 铺了**多个共线控制点**，这样 Catmull-Rom 在这些点处的切线严格水平。
 * 注意闭合环的"收尾"必须让 x **单调递增**地接回起点，否则会在接缝处出现
 * 180° 零半径折返（几何尖点）—— 实测会把最小转弯半径打到 11m，整条直道报废。
 * 所以最后一段刻意绕到 x≈-1750 再折回直道，两端通行次在 z 上错开约 120m，
 * 形成一个正常的 U 形回转而不是重合的折返。
 * 街道赛道是固定场地，不用 seed 变形，保证任何机器上都是同一条街。
 */
function vegasDef(_seed) {
  // ⚠️ seed 在本赛道**不再参与形状生成**（2026-09-30：换成 OSM 实测走线）。
  //    真实拉斯维加斯街道赛道是固定的；保留参数只为兼容 Track 的统一构造签名。
  // 数据：OpenStreetMap relation 16696508（type=circuit，实测中心线 6191m，
  //      官方单圈 6201m，偏差 −0.2%；8 个真实街道名）。见 vegas-geometry.js。
  const ctl = VEGAS_GEOMETRY.pts.map((p) => [p[0], p[1]]);
  return {
    ctl,
    elev: vegasElev,
    hasBridge: false,
    // ⚠️ smooth 必须为 0：真实街道赛道有 90° 街角（实测最大单点转折 90.1°），
    //    Laplacian 平滑会把街角磨圆并向内收缩，走线就不再是真实路口形状。
    smooth: 0,
    barriers: true,
    // 街角的外侧护栏需要把吸能带完整留在沥青外；默认 0.75m 仅适合
    // 直线，Vegas 的实测 90° 街角还要给 1.55m 的外侧缓冲。
    barrierLat: 14.0,
    // 经与烘焙几何**同一套切平面投影**换算到局部坐标；
    // 半径取真实尺度 ≈56m（真车 112m 宽）。实测该点到赛道中心线 89m，
    // 89 > 56 + 半宽 7 + 路肩 1.2 + 缓冲 8.5 = 72.7 ⇒ 不侵入路面/视线。
    sphere: { x: 459, z: 425, r: 56 },
  };
}

/** 拉斯维加斯高程：街道级微起伏，整体接近平地（坡度受弧长归一化天然限制）。 */
function vegasElev(v, total) {
  void total;
  return 3.0 * Math.sin(TAU * 2 * v + 1.10) + 1.4 * Math.sin(TAU * 5 * v + 0.30);
}

/* ---------------------------------------------------------------------------
 * 斯帕-弗朗科尔尚（Spa-Francorchamps）
 *   平面形状是经典的"细长三角形"：发车线在西南，凯梅尔大直道沿西侧一路向北，
 *   北端（莱孔布）折向东，再沿东侧南下（普鸿 -> 法涅 -> 斯塔沃洛 -> 布兰奇蒙特），
 *   最后 Bus Stop 减速弯兜回发车线。
 *   高程是这条赛道的灵魂：拉索斯下坡 -> 欧鲁日/拉迪隆陡爬 +14.5m -> 凯梅尔高台
 *   -> 中段下坡 -> 末段回到起点高度。用 SPA_ELEV 关键点给（elevKeys 余弦缓动，C1 连续）。
 * ------------------------------------------------------------------------- */
const SPA_ELEV = [
  { v: 0.000, y: 0.0 },     // 发车线（起点线高度基准，位于起终点直道）
  { v: 0.045, y: -3.2 },    // 拉索斯发卡：下坡到最低点
  { v: 0.125, y: 11.3 },    // 欧鲁日 / 拉迪隆：陡爬（-3.2 -> +11.3 = 恰好 +14.5m）
  { v: 0.200, y: 11.4 },    // 凯梅尔大直道：高位近水平
  { v: 0.320, y: 10.2 },    // 凯梅尔末端
  { v: 0.360, y: 9.4 },     // 莱孔布（右-左连续弯）
  { v: 0.450, y: 6.0 },     // 马尔梅迪下坡
  { v: 0.530, y: 3.4 },     // 里瓦日（长下坡右弯）
  { v: 0.610, y: 5.2 },     // 普鸿（双弯心左弯，中段微抬）
  { v: 0.700, y: 4.0 },     // 法涅
  { v: 0.790, y: 2.4 },     // 斯塔沃洛
  { v: 0.890, y: 0.8 },     // 布兰奇蒙特
  { v: 0.950, y: -1.6 },    // Bus Stop 减速弯（下沉）
];

/** 斯帕平面控制点（x, z）。顺序 = 行车顺序，从发车线开始。 */
// ⚠️ 原程序化斯帕路点表（SPA_WP）已删除：2026-09-30 起斯帕改用 OSM 实测走线
//    （public/js/spa-geometry.js），路点表与 SPA_SCALE 放大系数都不再需要。

/**
 * 周期关键点高程插值：keys 按 v 升序、必须以 v=0 开头（环上同一点只写一次）。
 * 相邻关键点之间用余弦缓动，保证一阶连续 —— 否则坡度会在关键点处出现折角，
 * 车辆通过时会有明显的"顿一下"。
 */
function elevKeys(v, keys) {
  const n = keys.length;
  let vv = v % 1;
  if (vv < 0) vv += 1;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (vv >= keys[k].v) i = k; else break;
  }
  const a = keys[i];
  const nb = keys[(i + 1) % n];
  const bV = (i + 1 < n) ? nb.v : nb.v + 1;
  const t = (vv - a.v) / Math.max(1e-9, bV - a.v);
  const s = 0.5 * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))));
  return a.y + (nb.y - a.y) * s;
}

function spaElev(v) { return elevKeys(v, SPA_ELEV); }

function spaDef(_seed) {
  // ⚠️ seed 在本赛道**不再参与形状生成**（2026-09-30：换成 OSM 实测走线）。
  //    真实斯帕是固定场地；±0.5% 的假扰动会让"1:1 复刻"失效。
  // 数据：OpenStreetMap relation 284560（type=circuit，实测中心线 6971m，
  //      官方单圈 7004m，偏差 −0.5%）；14 个真实弯名已映射到圈上比例
  //      （Eau Rouge 5.5%、Raidillon 7.2%、Kemmel 13.2%、Les Combes 22.1%、
  //       Malmedy 28.8%、Bruxelles 33.8%、Speaker's Corner 40.9%、Double Gauche 47.1%、
  //       Fagnes 56.8%、Campus 65.5%、Courbe Paul Frère 69.5%、Blanchimont 77.9%、
  //       Chicane 89.1%、La Source 98.0%）。见 spa-geometry.js。
  const ctl = SPA_GEOMETRY.pts.map((p) => [p[0], p[1]]);
  return {
    ctl,
    elev: spaElev,
    hasBridge: false,
    // ⚠️ smooth 必须为 0：真实走线不能过 Laplacian —— 斯帕的拉索斯发卡与 Bus Stop
    //    是真·低速紧弯，平滑会把它们磨成中速弯（旧实现甚至因此要用 SPA_SCALE=1.42
    //    把整条赛道放大回来，等于把走线改形）。
    smooth: 0,
    // 触发盒数量：按真实圈长给（斯帕弯多，25 个 CP 的分辨率足够且不比铃鹿的 24 密太多）
    cp: 25,
    barriers: true,
  };
}


/* ---------------------------------------------------------------------------
 * 新手 · 极简高速环道（oval）
 *   两条 400m 大直道 + 两个半径 180m 的半圆弯，周长 ≈ 1931m，平面零自交。
 *   设计意图：给新手与"高速跟车/尾流对抗"用的入门图 —— 没有急弯、没有立交、
 *   没有街道窄口，路宽沿用全局 14m，护栏外还有 ~5.8m 缓冲。
 *   ⚠️ 与三条真实赛道不同，本图是**刻意合成的**，没有真实场地可比，
 *      所以用解析式几何（OVAL_GEOMETRY），不做 1:1 复刻与 OSM 校验。
 * ------------------------------------------------------------------------- */
/**
 * 极简环道高程：近乎平地的缓起伏（幅值 ±3.3m、坡度 < 2%）。
 * 新手图不该有盲坡：既要有轻微地势变化（不然像在一张白纸上开），
 * 又必须保证任何位置的视线与路面牵引都是可预期的。
 */
function ovalElev(v, total) {
  void total;
  return 2.2 * Math.sin(TAU * v + 0.60) + 1.1 * Math.sin(TAU * 2 * v + 2.40);
}

function ovalDef(_seed) {
  // seed 不参与形状生成：合成环道在任何机器上都必须是同一条路。
  const ctl = OVAL_GEOMETRY.pts.map((p) => [p[0], p[1]]);
  return {
    ctl,
    elev: ovalElev,
    hasBridge: false,
    // 控制点本身已足够密（160 点，直道严格直线、弯道每段 5.6°）：
    // 再做 Laplacian 平滑只会把"两条直道 + 两个半圆"的解析形状磨掉，
    // 并让实际周长偏离解析值 2·L + 2πR。因此必须为 0。
    smooth: 0,
    cp: 24,
    barriers: true,
    // 护栏距中心线 14m（半宽 7 + 路肩 1.2 + 缓冲 5.8）：宽缓冲、低惩罚，适合入门图。
    barrierLat: 14.0,
    // 拥挤区阈值显式给 200m：本图弯道半径恒为 180m、直道近似无穷，
    // 半径是**双峰离散谱**，分位判据会把阈值取到 179.97m 从而漏掉整条弯道
    // （详见 buildCongestionZones 的注释）。两条半圆弯就是本图唯一的"拥挤区"。
    congestionRadiusM: 200,
  };
}

export const TRACK_DEFS = { suzuka: suzukaDef, vegas: vegasDef, spa: spaDef, oval: ovalDef };

/* ---------------------------------------------------------------------------
 * 数学工具
 * ------------------------------------------------------------------------- */

/** 确定性 PRNG（mulberry32）—— 同一 seed 在任何机器上生成完全一致的赛道 */
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------------------
 * 规格 §二.1 —— 100% 静态景观布置
 *
 * 旧实现用 makeRng(seed) 摆放树木/建筑，导致**换 seed 就换布局**：同一台机器
 * 每次开赛看到的地物都不同，既无法做逐像素回归，也让"景观是否侵入赛道"这类
 * 几何约束随 seed 漂移。规格要求彻底移除 Math.random / 种子 RNG，
 * 改为**静态常量数组**：任何 seed、任何机器上，每一棵树/每一栋楼的位置逐字节一致。
 *
 * 实现：用**黄金比散列**（Kronecker 低差异序列）把实例下标 i 直接映射到
 * [0,1) 的确定性伪随机数 —— 无需任何状态、无需查表，且分布比线性同余更均匀。
 * 这不是"随机"：给定 i，输出恒定不变，跨 seed/跨机器完全可复现。
 * ------------------------------------------------------------------------- */
const PHI_INV = 0.6180339887498949;
const SQRT2_FRAC = 0.4142135623730951;
const SQRT3_FRAC = 0.7320508075688772;

/**
 * 静态低差异序列：sphereHash(i, salt) ∈ [0,1)。
 * · 不依赖任何 seed / 随机源，纯下标哈希 —— 跨赛次完全一致。
 * · 三个互质无理数（φ⁻¹、√2⁻¹、√3⁻¹）叠加 fract，消除序号相关性。
 * @param {number} i    实例下标（0..N-1）
 * @param {number} salt 通道盐值（同一 i 的不同属性用不同 salt，避免完全相关）
 */
export function statFrac(i, salt) {
  let v = (i + 1) * PHI_INV + (salt + 1) * SQRT2_FRAC + (salt * 0.5 + 0.5) * SQRT3_FRAC;
  return v - Math.floor(v);
}

/** 静态区间映射 [lo, hi) */
function statRange(i, salt, lo, hi) {
  return lo + statFrac(i, salt) * (hi - lo);
}


/** 两个角度（弧度）在环上的最短距离，结果 ∈ [0, π] */
function angDist(a, b) {
  let d = Math.abs(a - b) % TAU;
  if (d > Math.PI) d = TAU - d;
  return d;
}

/**
 * 闭合 Catmull-Rom 样条在 t∈[0,n) 处的取值（t 以控制点为单位）。
 * 标准 CR 张力 0.5，C1 连续 —— 转角自然圆化，正是赛道想要的形态。
 */
function catmullRom(ctl, t) {
  const n = ctl.length;
  const i1 = Math.floor(t);
  const f = t - i1;
  const p0 = ctl[((i1 - 1) % n + n) % n];
  const p1 = ctl[(i1 % n + n) % n];
  const p2 = ctl[((i1 + 1) % n + n) % n];
  const p3 = ctl[((i1 + 2) % n + n) % n];
  const f2 = f * f, f3 = f2 * f;
  const c = (a, b, cc, d, tt) => 0.5 * (
    (2 * b) + (-a + cc) * tt +
    (2 * a - 5 * b + 4 * cc - d) * tt * tt +
    (-a + 3 * b - 3 * cc + d) * tt * tt * tt
  );
  return [c(p0[0], p1[0], p2[0], p3[0], f), c(p0[1], p1[1], p2[1], p3[1], f)];
}

/**
 * 闭合折线 Laplacian 平滑：抑制高频尖角、抬高最小转弯半径，
 * 同时保留整体形状与大弯性格（低频分量不受影响）。
 * 对 8 字形而言这是**拓扑安全**的：横截自交不可能被平滑掉。
 */
function smoothClosed(ctl, passes, k) {
  const n = ctl.length;
  let p = ctl.map((v) => [v[0], v[1]]);
  for (let s = 0; s < passes; s++) {
    const q = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
      q[i] = [
        b[0] + k * 0.5 * (a[0] + c[0] - 2 * b[0]),
        b[1] + k * 0.5 * (a[1] + c[1] - 2 * b[1]),
      ];
    }
    p = q;
  }
  return p;
}


/**
 * 把闭合样条按**等弧长**重采样成 N 个点，同时按归一化弧长 v=i/N 求高程。
 *
 * 关键：高程自变量必须是**弧长**而不是样条参数。用样条参数时，急弯处
 * "1 单位参数"对应的实际弧长很短，高程导数被放大，坡度会飙到 20%+；
 * 换成 v 后 dy/ds = dy/dv · (1/L)，坡度天然有界。
 *
 * @returns {{pts:{x,y,z}[], v:Float64Array, length:number, spacing:number}}
 */
function resampleClosed(ctl, elev, N, smoothPasses) {
  const n = ctl.length;
  const cs = smoothPasses > 0 ? smoothClosed(ctl, smoothPasses, TRACK_CFG.SMOOTH_K) : ctl;
  const M = Math.max(4096, N * 4);          // 高密度预采样
  const xs = new Float64Array(M + 1), zs = new Float64Array(M + 1);
  const cum = new Float64Array(M + 1);
  for (let i = 0; i <= M; i++) {
    const [x, z] = catmullRom(cs, (i / M) * n);
    xs[i] = x; zs[i] = z;
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  const total = cum[M];
  const spacing = total / N;
  const pts = new Array(N);
  const vArr = new Float64Array(N);
  let j = 0;
  for (let i = 0; i < N; i++) {
    const target = i * spacing;
    while (j < M - 1 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg > 1e-9 ? (target - cum[j]) / seg : 0;
    const x = xs[j] + (xs[j + 1] - xs[j]) * t;
    const z = zs[j] + (zs[j + 1] - zs[j]) * t;
    const v = i / N;
    pts[i] = { x, y: elev(v, total), z };
    vArr[i] = v;
  }
  return { pts, v: vArr, length: total, spacing };
}

/** 构造三维点：优先返回 THREE.Vector3（下游/AI/自检会用到 distanceTo 等方法），
 *  three 缺失时退化为普通对象，保证模块顶层求值永不抛错。 */
function vec(x, y, z) {
  return (typeof THREE !== 'undefined') ? new THREE.Vector3(x, y, z) : { x, y, z };
}

/** 由 yaw 角（绕 +Y）构造四元数，避免依赖 THREE */
function quatFromYaw(yaw) {
  const h = yaw * 0.5;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

/** Quaternion whose local X/Y/Z axes map to the supplied world basis. */
function quatFromBasis(x, y, z) {
  const m00 = x.x, m01 = y.x, m02 = z.x;
  const m10 = x.y, m11 = y.y, m12 = z.y;
  const m20 = x.z, m21 = y.z, m22 = z.z;
  const trace = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  return new CANNON.Quaternion(qx, qy, qz, qw).normalize();
}

/**
 * 求解外-内-外最速几何走线（Minimum-Curvature Racing Line）与物理精确刹车点。
 * 按提示词给定算法落地：
 *   ① 80 次弦向拉普拉斯曲率松弛迭代 ⇒ 自动推向"入弯外侧 → 弯心内侧 → 出弯外侧"；
 *   ② 由最速走线重算真实曲率 κ 与弧长步长 ds，得侧向极限 vLimit = √(μg/κ)；
 *   ③ 正向加速约束 + 逆向刹车积分（Backward Pass，跑两圈跨起终点闭合）；
 *   ④ 由纵向减速度需求推 brakeIntensity ∈ [0,1]（0 绿 / 0.5 黄 / 1 红）。
 * @param {THREE.Vector3[]} centerPts 赛道中心线采样点
 * @param {THREE.Vector3[]} sideVecs  赛道横向单位法向量（指向右侧）
 * @param {number} halfWidth          赛道半宽（默认 7.0m）
 */
export function computeOptimalRacingLine(centerPts, sideVecs, halfWidth = 7.0) {
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const N = centerPts.length;
  const maxOffset = Math.max(2.0, halfWidth - 1.35); // 预留车身安全边距
  const alpha = new Float32Array(N);                 // 横向偏移量 [-maxOffset, +maxOffset]
  const nextAlpha = new Float32Array(N);

  // 1. 80 次弦向拉普拉斯曲率松弛迭代：自动将走线推向“入弯外侧 -> 弯心内侧 Apex -> 出弯外侧”
  const ITERATIONS = 80;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < N; i++) {
      const iPrev = (i - 3 + N) % N;
      const iNext = (i + 3) % N;
      const pPrev = centerPts[iPrev], sPrev = sideVecs[iPrev];
      const pCurr = centerPts[i],     sCurr = sideVecs[i];
      const pNext = centerPts[iNext], sNext = sideVecs[iNext];

      const prevX = pPrev.x + sPrev.x * alpha[iPrev];
      const prevZ = pPrev.z + sPrev.z * alpha[iPrev];
      const nextX = pNext.x + sNext.x * alpha[iNext];
      const nextZ = pNext.z + sNext.z * alpha[iNext];

      // 弦中点向当前截面法线的投影即为使路径最直（曲率最小）的理想偏移
      const midX = 0.5 * (prevX + nextX) - pCurr.x;
      const midZ = 0.5 * (prevZ + nextZ) - pCurr.z;
      const ideal = midX * sCurr.x + midZ * sCurr.z;
      nextAlpha[i] = clamp(alpha[i] * 0.35 + ideal * 0.65, -maxOffset, maxOffset);
    }
    alpha.set(nextAlpha);
  }

  // 生成最速走线三维坐标点列
  const linePts = new Array(N);
  for (let i = 0; i < N; i++) {
    const p = centerPts[i], s = sideVecs[i], off = alpha[i];
    linePts[i] = new THREE.Vector3(p.x + s.x * off, p.y + 0.06, p.z + s.z * off);
  }

  // 2. 计算最速走线各点真实曲率 kappa[i] 与弧长步长 ds[i]
  const kappa = new Float32Array(N);
  const ds = new Float32Array(N);
  const vLimit = new Float32Array(N);
  const vTarget = new Float32Array(N);
  const MU_G = 1.65 * 9.81; // GT 赛车有效侧向抓地加速度 (m/s^2)
  const V_MAX = 82.0;       // 最高直道极速 (~295 km/h)

  for (let i = 0; i < N; i++) {
    const p0 = linePts[(i - 2 + N) % N];
    const p1 = linePts[i];
    const p2 = linePts[(i + 2) % N];
    const pNext = linePts[(i + 1) % N];
    ds[i] = Math.max(0.5, Math.hypot(pNext.x - p1.x, pNext.z - p1.z));

    const ax = p1.x - p0.x, az = p1.z - p0.z;
    const bx = p2.x - p1.x, bz = p2.z - p1.z;
    const cx = p2.x - p0.x, cz = p2.z - p0.z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(cx, cz);
    const cross = Math.abs(ax * bz - az * bx);
    const curv = (la > 1e-3 && lb > 1e-3 && lc > 1e-3) ? (2 * cross) / (la * lb * lc) : 0;
    kappa[i] = curv;
    vLimit[i] = curv > 1e-4 ? Math.min(V_MAX, Math.sqrt(MU_G / curv)) : V_MAX;
    vTarget[i] = vLimit[i];
  }

  // 3. 正向加速约束 + 逆向刹车积分（Backward Pass，跑两圈以跨越起终点线闭合）
  const A_ACCEL = 9.5;  // 纵向加速率 (m/s^2)
  const A_BRAKE = 14.5; // 纵向重刹减速率 (m/s^2)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      const vMaxNext = Math.sqrt(vTarget[i] * vTarget[i] + 2 * A_ACCEL * ds[i]);
      if (vMaxNext < vTarget[next]) vTarget[next] = vMaxNext;
    }
    for (let i = N - 1; i >= 0; i--) {
      const next = (i + 1) % N;
      const vBrakeEntry = Math.sqrt(vTarget[next] * vTarget[next] + 2 * A_BRAKE * ds[i]);
      if (vBrakeEntry < vTarget[i]) vTarget[i] = vBrakeEntry;
    }
  }

  // 4. 计算每个点的纵向减速度需求 decel[i]（精确决定红/黄/绿刹车点颜色）
  // brakeIntensity ∈ [0, 1]：0 = 绿（全油门加速），0.5 = 黄（松油/循迹），1.0 = 红（重刹区）
  const brakeIntensity = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const ahead = (i + 2) % N;
    const spanDist = ds[i] + ds[(i + 1) % N];
    const decel = Math.max(0, (vTarget[i] * vTarget[i] - vTarget[ahead] * vTarget[ahead]) / (2 * spanDist));
    brakeIntensity[i] = clamp(decel / (A_BRAKE * 0.78), 0, 1);
  }

  return { linePts, alpha, vTarget, vLimit, brakeIntensity };
}

export class Track {
  /**
   * @param {number} seed      由服务端下发（start 消息里的 seed），保证四台机器同一条赛道
   * @param {string} trackType 'suzuka' | 'vegas'
   */
  constructor(seed = 20260922, trackType = 'suzuka') {
    this.seed = seed >>> 0;
    this.trackType = TRACK_TYPES.indexOf(trackType) >= 0 ? trackType : 'suzuka';
    this.theme = THEMES[this.trackType];
    const def = TRACK_DEFS[this.trackType](this.seed);
    this.sphere = def.sphere || null;
    this.hasBridge = !!def.hasBridge;
    // 是否全线布防实体护栏（规格 §二.3）。见 _buildBarriers 里关于铃鹿的说明。
    this.barriers = !!def.barriers;
    this.grandstands = [];        // 看台落位（供测试审计）
    this.buildings = [];          // 建筑落位（供视野安全角审计）
    // 护栏横向落位（可被赛道定义覆盖）。默认贴路肩外；永久赛道放缓冲区外沿。
    this.barrierLat = def.barrierLat || 0;
    // 拥挤区半径阈值的**赛道级显式覆盖**（可选）。见 buildCongestionZones 的说明：
    // 分位判据假定半径谱是连续的，等半径的合成环道（oval）必须显式给阈值。
    this.congestionRadiusM = def.congestionRadiusM || 0;

    const N = TRACK_CFG.N;
    const r = resampleClosed(def.ctl, def.elev, N, def.smooth != null ? def.smooth : TRACK_CFG.SMOOTH_PASSES);
    const pts = r.pts.map((p) => vec(p.x, p.y, p.z));
    this.count = N;
    this.spacing = r.spacing;
    this.length = r.length;
    this.vArr = r.v;

    // ---- 沿路坐标系 --------------------------------------------------------
    // side = normalize(cross(tXZ, UP)) 展开 => (-tz, 0, tx)：该向量指向**车身左侧**
    // n    = normalize(cross(side, t))  展开 => (-sz·ty, sz·tx - sx·tz, sx·ty)
    const tan = new Array(N), side = new Array(N), nrm = new Array(N);
    for (let i = 0; i < N; i++) {
      const p0 = pts[(i - 1 + N) % N];
      const p1 = pts[(i + 1) % N];
      let tx = p1.x - p0.x, ty = p1.y - p0.y, tz = p1.z - p0.z;
      const tl = Math.hypot(tx, ty, tz) || 1e-6;
      tx /= tl; ty /= tl; tz /= tl;

      let sx = -tz, sz = tx;                     // cross((tx,0,tz), (0,1,0))
      const sl = Math.hypot(sx, sz) || 1e-6;
      sx /= sl; sz /= sl;

      const cx = -sz * ty;
      const cy = sz * tx - sx * tz;
      const cz = sx * ty;
      const cl = Math.hypot(cx, cy, cz) || 1e-6;

      tan[i] = vec(tx, ty, tz);
      side[i] = vec(sx, 0, sz);
      nrm[i] = vec(cx / cl, cy / cl, cz / cl);
    }
    this.pts = pts;
    this.tan = tan;
    this.side = side;
    this.nrm = nrm;
    this.halfWidth = TRACK_CFG.HALF_WIDTH;
    this.asphaltHalfWidth = TRACK_CFG.ASPHALT_HALF_W;
    this.curbWidth = TRACK_CFG.CURB_W;
    // ★ 逐点半宽（2026-09-30）：真实铃鹿路宽 10~16m 随路段变化（主直道最宽、
    //   发卡/减速弯最窄）。半宽序列按**索引归一化位置** v=i/N 取样 —— 重采样是
    //   等弧长，所以 v 就是圈上里程百分比，与真车弯序一一对应。
    //   非变宽赛道（vegas/spa）此处全为同一常量，行为与旧版完全一致。
    this.halfWidthAt = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      this.halfWidthAt[i] = def.widthAt ? def.widthAt(i / N) : TRACK_CFG.HALF_WIDTH;
    }
    // 变宽赛道的标量 halfWidth 取**最窄**值：物理/AI 里用 `hw` 做的保守判据
    // （出界自救、走线夹取、发车格横向限制）必须按最窄处算，否则会把人推出路面。
    if (def.widthAt) {
      let mn = Infinity;
      for (let i = 0; i < N; i++) mn = Math.min(mn, this.halfWidthAt[i]);
      this.halfWidth = mn;
      this.asphaltHalfWidth = mn;
      this.halfWidthMin = mn;
      this.halfWidthMax = Math.max(...this.halfWidthAt);
    } else {
      this.halfWidthMin = this.halfWidthMax = this.halfWidth;
    }
    this.barrierLatAt = def.barrierLatAt || null;
    this.barrierLatArr = def.barrierLatAt
      ? Float64Array.from({ length: N }, (_, i) => def.barrierLatAt(i / N))
      : null;
    // 规格：斯帕埋 28 个 Checkpoint（防抄近道硬边界按序判定），铃鹿/拉斯维加斯维持 24。
    // samplesPerCp **必须取整** —— 1440/28 = 51.43，留小数会让 CP 触发点绕环逐圈漂移。
    this.checkpointCount = def.cp || TRACK_CFG.CHECKPOINTS;
    this.samplesPerCp = Math.round(N / this.checkpointCount);

    // ---- 立交分层数据 ------------------------------------------------------
    // baseY[i] = 不含桥面抬升的"地面层"高程（桥上的骨架点与它的差即抬高量）。
    // ⚠️ 抬升位置必须由**赛道定义**给出（`def.bridgePct`）。旧实现把中心写死在
    //    v≈0，真实铃鹿的立体交叉却在 v=79.55%（8 字的上行段跨过下行段），
    //    写死会让 baseY 全错 —— 而 baseY 是桥下地面层、地物落位、分层判别的共同依据。
    this.baseY = new Float64Array(N);
    const thr = TRACK_CFG.BRIDGE_Y * 0.5;
    const onIdx = [];
    for (let i = 0; i < N; i++) {
      const lift = (this.hasBridge && def.liftAt)
        ? def.liftAt(this.vArr[i], this.length)
        : ((this.hasBridge && def.bridgePct != null)
          ? TRACK_CFG.BRIDGE_Y * bridgeBumpAt(this.vArr[i], def.bridgePct, this.length) : 0);
      this.baseY[i] = pts[i].y - lift;
      if (lift > thr) onIdx.push(i);
    }
    // ★★ 立交净空保证（必须在**最终等弧长几何**上做，不能靠预先定义的百分比）。
    //   踩过的坑：`selfIntersectionPct` 是在重采样**前**的 318 点数组上按索引比例算的，
    //   等弧长重采样后真正的交点偏了 ~29m，落到引桥坡上 ⇒ 实测上下两层只剩 1.32m 高差
    //   （净空要求 ≥1.0m 且要留余量），车会从桥面掉到下层。
    //   正解：在这里找出真正的交点对，按需要**整体加高**桥面区（按 bump 包络缩放，
    //   保证平滑、不会出现台阶），再据此重算 baseY。
    this.bridgeCross = null;
    if (this.hasBridge && def.liftAt && onIdx.length) {
      const isOn = new Uint8Array(N);
      for (const i of onIdx) isOn[i] = 1;
      let bestPair = null;
      for (let i = 0; i < N; i++) {
        const a1 = pts[i], b1 = pts[(i + 1) % N];
        for (let j = i + 1; j < N; j++) {
          const gap = Math.min(Math.abs(i - j), N - Math.abs(i - j));
          if (gap < 10) continue;
          const c1 = pts[j], d1 = pts[(j + 1) % N];
          const den = (b1.x - a1.x) * (d1.z - c1.z) - (b1.z - a1.z) * (d1.x - c1.x);
          if (Math.abs(den) < 1e-12) continue;
          const t = ((c1.x - a1.x) * (d1.z - c1.z) - (c1.z - a1.z) * (d1.x - c1.x)) / den;
          const u = ((c1.x - a1.x) * (b1.z - a1.z) - (c1.z - a1.z) * (b1.x - a1.x)) / den;
          if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const hiIsI = onIdx.includes(i) || onIdx.includes((i + 1) % N);
          const hiIsJ = onIdx.includes(j) || onIdx.includes((j + 1) % N);
          if (hiIsI === hiIsJ) continue;            // 两层都在桥区/都不在 -> 不是立交
          const hi = hiIsI ? i : j, lo = hiIsI ? j : i;
          const dy = pts[hi].y - pts[lo].y;
          if (!bestPair || dy < bestPair.dy) bestPair = { hi, lo, dy };
        }
      }
      if (bestPair) {
        this.bridgeCross = bestPair;
        const clear = TRACK_CFG.BRIDGE_CLEAR_M;       // ★ 保证净空（相机不被桥面挡）
        const deficit = (pts[bestPair.lo].y + clear) - pts[bestPair.hi].y;
        if (deficit > 0) {
          const bumpHi = def.liftAt(this.vArr[bestPair.hi], this.length) / TRACK_CFG.BRIDGE_Y;
          const extra = deficit / Math.max(bumpHi, 1e-3);
          // ★ 必须按 bump 包络**全程加权**施加，不能只加在 onIdx 区内：
          //   区边界上 bump=0.5，只加区内会在边界处跳 extra*0.5 ≈1.7m ⇒ 实测出现
          //   **45% 的台阶坡**（相邻 4.5m 内抬 2.04m），车辆贴地约束直接失效。
          //   bump 在引桥外恒为 0，全程加权天然平滑。
          for (let i = 0; i < N; i++) {
            const bump = def.liftAt(this.vArr[i], this.length) / TRACK_CFG.BRIDGE_Y;
            if (bump > 0) pts[i].y += extra * bump;
          }
          this.bridgeExtraLift = extra;
        }
        for (let i = 0; i < N; i++) {
          if (def.liftAt(this.vArr[i], this.length) > 0) {
            this.baseY[i] = pts[i].y - def.liftAt(this.vArr[i], this.length);
          }
        }
      }
    }
    if (onIdx.length) {
      // 抬升区可能**跨 0 点环绕**（u≈0 的桥正好横跨环线接缝）。
      // 升序排列后，环绕区间会呈现为 [0..a] ∪ [b..N-1]，在 a→b 处出现断裂。
      let brk = -1;
      for (let k = 0; k + 1 < onIdx.length; k++) {
        if (onIdx[k + 1] !== onIdx[k] + 1) { brk = k; break; }
      }
      const b = brk >= 0
        ? { active: true, i0: onIdx[brk + 1], i1: onIdx[brk], wrapped: true, height: TRACK_CFG.BRIDGE_Y }
        : { active: true, i0: onIdx[0], i1: onIdx[onIdx.length - 1], wrapped: false, height: TRACK_CFG.BRIDGE_Y };
      this.bridge = b;
    } else {
      this.bridge = { active: false, i0: 0, i1: 0, wrapped: false, height: 0 };
    }

    // Timing line selection happens before checkpoint placement so every
    // checkpoint index, lap counter, and rescue target share the same origin.
    this.timingLine = this._buildTimingLine();
    this.startSample = this.timingLine.sample;
    // ---- Checkpoint 触发盒（不可见，仅数据）--------------------------------
    this.checkpoints = [];
    for (let c = 0; c < this.checkpointCount; c++) {
      const i = (this.startSample + Math.floor(c * this.samplesPerCp)) % N;
      this.checkpoints.push({
        index: c,
        sample: i,
        pos: pts[i],
        tangent: tan[i],
        side: side[i],
        halfWidth: this.halfWidth + this.curbWidth,
      });
    }

    // 2D 小地图折线（供 Canvas2D 绘制，无需任何外部数据）
    const step = 6;
    const mapPts = [];
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; i += step) {
      const p = pts[i];
      mapPts.push(p.x, p.z);
      if (p.x < minX) minX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.x > maxX) maxX = p.x;
      if (p.z > maxZ) maxZ = p.z;
    }
    this.minimap = { pts: new Float32Array(mapPts), minX, minZ, maxX, maxZ };
    // 静态碰撞体描述（桥栏 / 混凝土护栏 / 桥墩），由 registerTrackBodies 落地
    this.colliders = [];
    this._computeRacingLine();
    // timingLine is selected before checkpoint placement above so lap
    // bookkeeping uses the same official-or-approach origin.
    // 物理路面与可视路面共用这份最终几何。Heightfield body 由
    // registerTrackBodies() 加入具体 World，Track.raycastRoad() 可在加入 World
    // 前直接对同一批 Cannon 形状做射线查询。
    this.roadHeightfields = [];
    this._buildRoadHeightfields();
  }

  /**
   * Select the official line when the start is on a sufficiently straight section;
   * otherwise place timing on a 100m approach to the strongest corner.
   */
  _buildTimingLine() {
    const N = this.count;
    const step = Math.max(1, Math.round(24 / this.spacing));
    const turnAt = (i, span = step) => {
      const a = this.tan[(i - span + N) % N];
      const b = this.tan[(i + span) % N];
      return Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z));
    };
    const straightAt = (i, radius) => {
      const w = Math.max(1, Math.round(radius / this.spacing));
      const center = this.tan[i];
      for (let k = 1; k <= w; k += Math.max(1, Math.floor(w / 8))) {
        const a = this.tan[(i + k) % N], b = this.tan[(i - k + N) % N];
        if (Math.abs(Math.atan2(center.x * a.z - center.z * a.x, center.x * a.x + center.z * a.z)) > 0.22) return false;
        if (Math.abs(Math.atan2(center.x * b.z - center.z * b.x, center.x * b.x + center.z * b.z)) > 0.22) return false;
      }
      return true;
    };
    let cornerIndex = 0, cornerScore = -1;
    for (let i = 0; i < N; i += 2) {
      const score = turnAt(i, Math.max(step, Math.round(12 / this.spacing)));
      if (score > cornerScore) { cornerScore = score; cornerIndex = i; }
    }
    const officialValid = straightAt(0, 100);
    let sample = 0, approachDistance = 0;
    if (!officialValid) {
      const distances = [80, 90, 100, 110, 120];
      for (const d of distances) {
        const candidate = (cornerIndex - Math.round(d / this.spacing) + N * 2) % N;
        if (straightAt(candidate, Math.min(40, d * 0.45))) {
          sample = candidate;
          approachDistance = d;
          break;
        }
      }
      if (!approachDistance) {
        sample = (cornerIndex - Math.round(100 / this.spacing) + N * 2) % N;
        approachDistance = 100;
      }
    }
    return {
      sample,
      point: this.pts[sample],
      tangent: this.tan[sample],
      side: this.side[sample],
      officialSample: 0,
      officialValid,
      cornerIndex,
      approachDistance,
    };
  }

  /** Build oriented high-resolution Heightfield collision patches for both layers. */
  _buildRoadHeightfields() {
    const cell = TRACK_CFG.ROAD_CELL_SIZE;
    const samplesPerPatch = Math.max(2, TRACK_CFG.ROAD_PATCH_SAMPLES | 0);
    const half = Math.max(this.halfWidthMax || this.halfWidth, this.halfWidth) + this.curbWidth;
    const lateralCells = Math.max(TRACK_CFG.ROAD_LATERAL_CELLS, Math.ceil((half * 2) / cell));
    const lateralWidth = lateralCells * cell;
    const N = this.count;
    const addPatch = (i0, layer) => {
      const p0 = this.pts[i0];
      const tangent = this.tan[i0], side = this.side[i0], normal = this.nrm[i0];
      const xCells = Math.max(2, Math.ceil((samplesPerPatch * this.spacing) / cell));
      // 道路查询面跟随实际路面高程；baseY 是场地地形，不能拿它承载引桥。
      const originY = layer === 'ground' && this.onBridge(i0) ? this.baseY[i0] : p0.y;
      // The Heightfield local Z axis is up.  (tangent, side, normal)
      // is left handed because side × tangent = normal, so use -side as
      // local Y and reverse the lateral samples to keep a proper rotation.
      const localSide = { x: -side.x, y: -side.y, z: -side.z };
      const origin = new CANNON.Vec3(
        p0.x + side.x * lateralWidth * 0.5,
        originY + side.y * lateralWidth * 0.5,
        p0.z + side.z * lateralWidth * 0.5,
      );
      const data = new Array(xCells + 1);
      for (let xi = 0; xi <= xCells; xi++) {
        const distance = xi * cell;
        const hint = (i0 + Math.round(distance / this.spacing)) % N;
        data[xi] = new Array(lateralCells + 1);
        for (let yi = 0; yi <= lateralCells; yi++) {
          // Heightfield 的 X/Y 坐标是固定平面格，不能把最近中心线点
          // 高程直接塞入格子；取整会造出约 4m 一阶的台阶和错误法线。
          const bx = origin.x + tangent.x * distance + localSide.x * yi * cell;
          const by = origin.y + tangent.y * distance + localSide.y * yi * cell;
          const bz = origin.z + tangent.z * distance + localSide.z * yi * cell;
          let height = 0;
          for (let pass = 0; pass < 3; pass++) {
            const wx = bx + normal.x * height;
            const wz = bz + normal.z * height;
            const road = this.sample(wx, wz, hint);
            let roadY = road.y;
            if (layer === 'ground' && road.onBridge) {
              const prev = (road.i + N - 1) % N, next = (road.i + 1) % N;
              const run = Math.hypot(this.pts[next].x - this.pts[prev].x, this.pts[next].z - this.pts[prev].z) || 1;
              const grade = (this.baseY[next] - this.baseY[prev]) / run;
              roadY = this.baseY[road.i] + road.along * grade + this.groundOffset(road.lateral, road.i);
            }
            height += (roadY - (by + normal.y * height)) / Math.max(normal.y, 0.5);
          }
          data[xi][yi] = height;
        }
      }
      const shape = new CANNON.Heightfield(data, { elementSize: cell });
      const body = new CANNON.Body({ mass: 0, shape });
      body.position.copy(origin);
      body.quaternion.copy(quatFromBasis(tangent, localSide, normal));
      body.type = CANNON.Body.STATIC;
      body.updateAABB();
      // Heightfield 只作为真实道路查询面：四轮射线 + groundConstraint 负责承重。
      // Cannon Heightfield 的每个 patch 边界自带竖直侧壁；让车壳参与该侧壁接触会在
      // patch 接缝处产生不可见横向冲量（铃鹿 97–98 段实测可把 98km/h 瞬间打到 86km/h）。
      // 护栏仍保持 collisionResponse=true；道路支撑继续由同一 Heightfield 的射线精确求解。
      body.collisionResponse = false;
      body.collisionFilterGroup = ROAD_COLLISION_GROUP;
      body.collisionFilterMask = ROAD_COLLISION_GROUP;
      this.roadHeightfields.push({
        body, shape, layer, levelY: originY, startIndex: i0,
        endIndex: (i0 + samplesPerPatch) % N, cell, lateralWidth,
      });
    };
    for (let i0 = 0; i0 < N; i0 += samplesPerPatch) {
      addPatch(i0, 'ground');
      let hasBridge = false;
      for (let k = 0; k <= samplesPerPatch; k++) {
        if (this.onBridge((i0 + k) % N)) { hasBridge = true; break; }
      }
      if (hasBridge) addPatch(i0, 'bridge');
    }
  }

  /**
   * Raycast the real Cannon Heightfield patches and choose the hit nearest the
   * requested layer. The layer hint is essential at the Suzuka crossing.
   */
  raycastRoad(origin, direction, maxDistance = 8, currentY = undefined, layerHint = undefined) {
    const from = new CANNON.Vec3(origin.x, origin.y, origin.z);
    const d = new CANNON.Vec3(direction.x, direction.y, direction.z);
    const len = d.length();
    if (!Number.isFinite(len) || len < 1e-8) return null;
    d.scale(1 / len, d);
    const to = new CANNON.Vec3(from.x + d.x * maxDistance, from.y + d.y * maxDistance, from.z + d.z * maxDistance);
    const rayMinX = Math.min(from.x, to.x), rayMaxX = Math.max(from.x, to.x);
    const rayMinY = Math.min(from.y, to.y), rayMaxY = Math.max(from.y, to.y);
    const rayMinZ = Math.min(from.z, to.z), rayMaxZ = Math.max(from.z, to.z);
    let best = null;
    let fallback = null;
    for (const patch of this.roadHeightfields) {
      // Heightfield intersection is relatively expensive. The world AABB is a
      // conservative segment test, so it cannot discard a real hit and avoids
      // testing every patch on every wheel at every fixed step.
      const aabb = patch.body.aabb;
      if (aabb && (rayMaxX < aabb.lowerBound.x || rayMinX > aabb.upperBound.x
        || rayMaxY < aabb.lowerBound.y || rayMinY > aabb.upperBound.y
        || rayMaxZ < aabb.lowerBound.z || rayMinZ > aabb.upperBound.z)) continue;
      const ray = new CANNON.Ray(from, to);
      // Heightfield 是查询面而非 Cannon 外壳碰撞体；显式允许射线命中
      // collisionResponse=false 的道路 patch，避免查询也被响应标记过滤掉。
      ray.checkCollisionResponse = false;
      ray.mode = CANNON.Ray.CLOSEST;
      const result = new CANNON.RaycastResult();
      ray.intersectBody(patch.body, result);
      if (!result.hasHit || result.distance < 0 || result.distance > maxDistance + 1e-6) continue;
      const layerBias = Number.isFinite(currentY) ? Math.abs(result.hitPointWorld.y - currentY) : 0;
      const score = layerBias * 1000 + result.distance;
      const candidate = {
        score,
        distance: result.distance,
        point: { x: result.hitPointWorld.x, y: result.hitPointWorld.y, z: result.hitPointWorld.z },
        normal: { x: result.hitNormalWorld.x, y: result.hitNormalWorld.y, z: result.hitNormalWorld.z },
        layer: patch.layer,
        patch,
      };
      if (layerHint && patch.layer !== layerHint) {
        if (!fallback || candidate.score < fallback.score) fallback = candidate;
      } else if (!best || candidate.score < best.score) {
        best = candidate;
      }
    }
    // At a grade into/out of a bridge the chassis can still be close to the
    // lower deck even though the centerline has already entered the bridge
    // layer. Prefer the geometric layer selected by sample(); only fall back to
    // the other layer when the preferred patch has no ray hit at all.
    return best || fallback;
  }

  /** 该采样点是否位于桥面（用于几何生成与分层判别） */
  onBridge(i) {
    const b = this.bridge;
    if (!b.active) return false;
    if (b.wrapped) return i >= b.i0 || i <= b.i1;
    return i >= b.i0 && i <= b.i1;
  }

  /**
   * 世界坐标 -> 最近中心线采样索引。
   * 先做 ±WINDOW 的局部窗口搜索（把车锁在当前所在层），窗口内若同时命中
   * 立交的上下两层，则用 curY（车辆当前高度）择优；窗口不可信时全局兜底。
   */
  /**
   * 地面层横向偏移绝对值。
   * 只在 y 与该处地面标高**同层**（|Δy| < LAYER_DY）的采样点里找最近点，返回 |lateral|。
   * 用于"桥墩是否压在下层路面上"这类同层判定 —— 常规 sample() 是纯几何最近，
   * 在立交处会命中另一条腿，算出来的横向偏移没有意义。
   */
  _groundLatAbs(x, z, groundY) {
    const N = this.count, pts = this.pts;
    let bestD = Infinity, bestI = -1;
    for (let i = 0; i < N; i++) {
      const p = pts[i];
      if (Math.abs(p.y - groundY) > TRACK_CFG.LAYER_DY) continue;
      const dx = p.x - x, dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI < 0) return Infinity;
    const p = pts[bestI], s = this.side[bestI];
    return Math.abs((x - p.x) * s.x + (z - p.z) * s.z);
  }

  /**
   * 桥墩落位校验：柱体（从 y0 顶到 yTop）是否穿到**任何**一段的路面上。
   *
   * ⚠️ 为什么不能复用 `_groundLatAbs`：它只在"与给定地面高度相差 < LAYER_DY"的采样点
   *    里找最近点。铃鹿立交上下两层相差 2.5~4.9m ⇒ **下层路面整段被排除**，于是
   *    实测仍有一根柱子立在下层沥青上（压深 3.24m，@39%）。这里改成按**高度区间**
   *    筛选：任何一段路面只要落在柱体的高度范围内，就必须在横向上避开它。
   */
  _pillarBlocked(x, z, y0, yTop) {
    const N = this.count, pts = this.pts;
    for (let j = 0; j < N; j++) {
      const p = pts[j];
      if (p.y < y0 - 1.0 || p.y > yTop + 1.0) continue;      // 这段路不在柱子的高度范围内
      const s = this.side[j], tn = this.tan[j];
      const dx = x - p.x, dz = z - p.z;
      if (Math.abs(dx * tn.x + dz * tn.z) > 3.0) continue;   // 不在这一段的正横方向（是前后段）
      const lat = Math.abs(dx * s.x + dz * s.z);
      if (lat < this.halfWidthAt[j] + TRACK_CFG.CURB_W + 1.5) return true;
    }
    return false;
  }

  /**
   * 到**整条**赛道中心线采样点的最短二维距离。
   * 8 字自交赛道不能只看落位所依附的那一段：另一条腿可能从数米外穿过。
   * 景观生成统一走此全局排他校验，保证中心点严格离开所有路面与路肩。
   */
  _minTrackDistance2D(x, z) {
    let best = Infinity;
    for (let i = 0; i < this.count; i++) {
      const p = this.pts[i];
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  }

  nearest(x, z, hint, curY, layerHint = undefined) {
    const N = this.count, pts = this.pts;
    let best = -1, bestD = Infinity;
    let bestL = -1, bestLD = Infinity;
    const hasY = typeof curY === 'number' && isFinite(curY);
    const wantedLayer = layerHint === 'bridge' ? 'bridge' : layerHint === 'ground' ? 'ground' : null;
    if (hint >= 0 && hint < N) {
      const W = TRACK_CFG.WINDOW;
      for (let k = -W; k <= W; k++) {
        const i = (hint + k + N) % N;
        const p = pts[i];
        const dx = p.x - x, dz = p.z - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
        if (hasY && Math.abs(p.y - curY) < TRACK_CFG.LAYER_DY && d < bestLD) {
          bestLD = d; bestL = i;
        }
      }
      // During the Suzuka crossing, the same x/z corridor contains two legal
      // centerline layers. The previous route index is the authority for the
      // layer the car is driving on; current body Y is deliberately not allowed
      // to switch it to the lower deck after a missed suspension sample.
      if (wantedLayer) {
        let layerI = -1, layerD = Infinity;
        for (let k = -W; k <= W; k++) {
          const i = (hint + k + N) % N;
          if ((this.onBridge(i) ? 'bridge' : 'ground') !== wantedLayer) continue;
          const p = pts[i], dx = p.x - x, dz = p.z - z;
          const d = dx * dx + dz * dz;
          if (d < layerD) { layerD = d; layerI = i; }
        }
        if (layerI >= 0 && layerD < 900) return layerI;
      }
      // 同层候选只要不比几何最优差 15m 以上，就采用它（立交分层的关键）
      if (bestL >= 0 && bestLD < 900 && bestLD <= bestD + 225) return bestL;
      if (bestD < 900) return best;
    }
    for (let i = 0; i < N; i++) {
      const p = pts[i];
      const dx = p.x - x, dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * 横断面高度剖面：沥青 0 / 路肩微微抬起 / 缓冲区向外侧下沉。
   * 与 _ribbon 生成的几何体保持一致，避免车"浮在草坪上方"。
   */
  /**
   * 物理地面高程偏移：支持按采样点索引感知变宽和路肩起伏。
   * @param {number} lateral 横向距离中心线（米）
   * @param {number} idx 赛道采样点索引（可选；不传则使用保守标量）
   */
  groundOffset(lateral, idx = -1) {
    const a = Math.abs(lateral);
    const hw = (idx >= 0 && this.halfWidthAt) ? this.halfWidthAt[idx] : this.halfWidth;
    const cw = this.curbWidth;
    if (a <= hw) return 0;
    if (a <= hw + cw) {
      // 弯道处立起真实路肩高度 + 搓板波动（物理车轮压上去会有真实的垂直颠簸）
      const m = (idx >= 0 && this.curbMask) ? this.curbMask[idx] : 1;
      if (m < 0.02) return 0;       // 直道上与路面齐平，没有台阶颠簸
      const ripple = (idx >= 0) ? Math.sin(idx * 1.57) * 0.015 * m : 0;
      return TRACK_CFG.CURB_H * m + ripple;
    }
    const t = Math.min(1, (a - hw - cw) / TRACK_CFG.GRASS_W);
    return -0.10 - t * 1.0;
  }

  /**
   * 位置采样：返回沿路坐标（横向偏移 / 地面高度 / 法线等），一次调用喂饱物理与罚时判定。
   * @param {number} hint 上次的采样索引，用于把窗口搜索限制在车辆附近
   * @param {number} curY 车辆当前高度，用于立交上下层判别
   */
  sample(x, z, hint = -1, curY, layerHint = undefined) {
    const i = this.nearest(x, z, hint, curY, layerHint);
    const p = this.pts[i], s = this.side[i], t = this.tan[i];
    const dx = x - p.x, dz = z - p.z;
    const lateral = dx * s.x + dz * s.z;
    const hor = Math.hypot(t.x, t.z) || 1e-3;
    const along = (dx * t.x + dz * t.z) / hor;
    const y = p.y + along * (t.y / hor) + this.groundOffset(lateral, i);
    return {
      i, lateral, along, y, side: s, tangent: t, normal: this.nrm[i],
      px: p.x, pz: p.z, onBridge: this.onBridge(i),
    };
  }

  /** Return the checkpoint bucket in the timing-line-relative coordinate. */
  checkpointIndexAt(sampleIndex) {
    const n = this.count || TRACK_CFG.N;
    const start = Number.isFinite(this.startSample) ? this.startSample : 0;
    const relative = ((Math.round(sampleIndex) - start) % n + n) % n;
    return Math.floor(relative / this.samplesPerCp) % this.checkpointCount;
  }

  /** 判断某点是否越过 Checkpoint 平面（几何二次校验，用于精确冲线判定） */
  crossed(p0, p1, cp) {
    const c = cp.pos, n = cp.tangent;
    const d0 = (p0.x - c.x) * n.x + (p0.z - c.z) * n.z;
    const d1 = (p1.x - c.x) * n.x + (p1.z - c.z) * n.z;
    if (d0 >= 0 || d1 < 0) return false;
    const k = d0 / (d0 - d1);
    const hx = p0.x + (p1.x - p0.x) * k;
    const hz = p0.z + (p1.z - p0.z) * k;
    const s = cp.side;
    const lat = (hx - c.x) * s.x + (hz - c.z) * s.z;
    return Math.abs(lat) <= cp.halfWidth;
  }

  /**
   * 发车格：奇偶车位左右交替，并且每个相邻车位都有独立纵向错位。
   * 偏移量以**米**为单位换算成采样点，保证在不同长度的赛道上手感一致。
   *
   * 复刻真实赛道的 staggered grid：P1 左前、P2 右后半个车身、P3 左后再后一整排。
   */
  gridSlot(slot) {
    const s = Math.max(1, Math.min(GRID_SLOTS, slot | 0));
    const row = Math.floor((s - 1) / 2);
    const leftSide = (s % 2) === 1;
    const behind = Math.round(24 / this.spacing);
    const rowGap = Math.round(12.5 / this.spacing);
    const staggerGap = Math.round(6.5 / this.spacing);
    const stagger = (s % 2) === 0 ? staggerGap : 0;
    return {
      index: (this.startSample + this.count - behind - row * rowGap - stagger + this.count * 2) % this.count,
      lateral: (leftSide ? 1 : -1) * 3.3,
    };
  }

  /** 由采样索引 + 横向偏移求得出生位姿 */
  spawn(index, lateral) {
    const i = ((Math.round(index) % this.count) + this.count) % this.count;
    const p = this.pts[i], s = this.side[i], t = this.tan[i];
    const position = { x: p.x + s.x * lateral, y: p.y + 0.66, z: p.z + s.z * lateral };
    // 车体局部基：+X = 车身右侧、+Y = 路面法线、+Z = 车头方向
    // right = -(side)：沿路 side 实为"左侧"，右侧须满足 right × up = forward。
    const RX = -s.x, RY = -s.y, RZ = -s.z;
    const uX = this.nrm[i].x, uY = this.nrm[i].y, uZ = this.nrm[i].z;
    // fwd = cross(right, up)
    const fX = RY * uZ - RZ * uY;
    const fY = RZ * uX - RX * uZ;
    const fZ = RX * uY - RY * uX;
    const fl = Math.hypot(fX, fY, fZ) || 1e-6;
    if (typeof THREE !== 'undefined') {
      const m = new THREE.Matrix4();
      m.makeBasis(
        new THREE.Vector3(RX, RY, RZ),
        new THREE.Vector3(uX, uY, uZ),
        new THREE.Vector3(fX / fl, fY / fl, fZ / fl)
      );
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      return { position: new THREE.Vector3(position.x, position.y, position.z), quaternion: q };
    }
    // 退化路径（three 缺失时不应走到这里，仅保证不抛错）
    const yaw = Math.atan2(fX, fZ);
    void t;
    return { position, quaternion: quatFromYaw(yaw) };
  }

  // ========================================================================
  //  最佳走线（数学部分 + 色带几何）
  // ========================================================================

  /**
   * 由**有符号曲率**推出每个采样点的横向偏移与曲率半径（纯数学，不依赖 THREE）。
   * 形态：入弯前渐偏(外) → 弯心贴内 → 出弯外放，由长窗口滑动平均自然浮现。
   */
  _computeRacingLine() {
    const N = this.count;
    const hw = this.halfWidth;

    const W = 4;
    const curv = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = this.tan[i], b = this.tan[(i + W) % N];
      const cross = a.x * b.z - a.z * b.x;      // 左转为正
      const dot = a.x * b.x + a.z * b.z;
      curv[i] = Math.atan2(cross, dot) / (W * this.spacing);
    }
    const sm = new Float32Array(N);
    const K1 = 12;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -K1; k <= K1; k++) s += curv[(i + k + N) % N];
      sm[i] = s / (2 * K1 + 1);
    }
    // ⚠️ 横向幅度必须**逐点**取（变宽赛道）：标量 hw 是**最窄值**（铃鹿 5.5m），
    //    而主直道实际 8m ⇒ 若只用标量算上限，越界检查会失真。
    //    （不变量由 track-geometry-audit / selftest 守着：|offset| ≤ halfWidthAt[i] − MARGIN。）
    const MARGIN = TRACK_CFG.RACE_LINE_MARGIN;
    const radius = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      radius[i] = Math.abs(sm[i]) > 1e-6 ? Math.min(1 / Math.abs(sm[i]), 5000) : 5000;
    }
    // ★ 走线偏移：按提示词改为**最小曲率外-内-外迭代 + 逆向运动学刹车积分**求解
    //   （取代旧的"有符号曲率 × 增益 → 滑动平均"启发式）。
    //   求解器自带 maxOffset = max(2.0, halfWidth − 1.35) 夹紧；此处再按**逐点半宽**
    //   夹一次，保证 |offset| ≤ halfWidthAt[i] − MARGIN 这条工程不变量成立。
    const optimal = computeOptimalRacingLine(this.pts, this.side, this.halfWidth);
    const off = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const maxOffI = Math.max(0.2, this.halfWidthAt[i] - MARGIN);
      off[i] = Math.max(-maxOffI, Math.min(maxOffI, optimal.alpha[i]));
    }
    this.raceLine = {
      count: N, spacing: this.spacing,
      offset: off, radius,
      // 逆向刹车积分的产物：走线着色改由 brakeIntensity 决定（0 绿 / 0.5 黄 / 1 红）。
      brakeIntensity: optimal.brakeIntensity, vTarget: optimal.vTarget, vLimit: optimal.vLimit,
      maxOffset: Math.max(0.2, this.halfWidthMin - MARGIN),
      active: true, mesh: null, geometry: null, colorAttr: null,
    };

// ---- 路肩掩码 curbMask（2026-09-30：用户"路肩过于普遍到处都有，不与现实一致"）----
    // 真实赛道只在**弯道**（尤其外侧/弯心）铺红白立体路肩，直道上没有 —— 直道两侧是
    // 与路面齐平的沥青/水泥肩。这里按"曲率半径"逐点算掩码 0..1：
    //   半径 ≥ CURB_R_OFF(260m)  → 0（直道，与路面齐平、不上色）
    //   半径 ≤ CURB_R_ON (90m)   → 1（真弯道，立起 6cm 红白路肩）
    // 中间线性过渡。掩码同时驱动 ① 几何起伏 ② 物理高度 ③ 红白上色，三者共用一条剖面。
    {
      const rc = this.raceLine && this.raceLine.radius;
      this.curbMask = new Float64Array(N);
      if (rc) {
        // ★ 二值化（用户明确要求："路肩不要渐变式的，有就是有没有就是没有"）：
        //   半径 ≤ CURB_R_ON 判为弯道 ⇒ 掩码 1（立起 6cm 红白路肩）；
        //   否则掩码 0（与路面齐平的暗灰肩）。中间**没有过渡带**。
        for (let i = 0; i < N; i++) {
          this.curbMask[i] = rc[i] <= TRACK_CFG.CURB_R_ON ? 1 : 0;
        }
        // ⚠️ 不做平滑：平滑会把二值掩码抹成 0.2/0.6 之类的中间值，
        //    等于又变成"渐变式路肩"，与用户要求相违。二值就二值。
        void 0;
      } else {
        this.curbMask.fill(1);
      }
    }

    
    this.buildCongestionZones(radius);
    return this.raceLine;
  }

  /**
   * 规格 §三.2：从曲率半径序列提取**拥挤区**（发卡弯 / 减速弯 / 连续小半径弯）——
   * 供 `RacePhysics` 判定"车是否处在弯道拥挤区"，从而在弯内多车拥堵时启用幽灵化。
   *
   * ⚠ 阈值必须**与具体赛道的半径尺度解耦**。本工程红线：禁止把"全长/单圈秒数/CP 数"
   * 之类赛道参数写死进判据。曲率半径同理 —— 三大赛道曲率分布差异极大：
   *   · suzuka 5% 分位 161m、vegas 152m、spa 223m（spa 高速弯居多）
   *   · 若写死 `radius < 130m`，spa 只能圈出 1.7% 的赛道（几乎全是直道，急弯漏检）。
   * 因此改为**分位数判据**：取半径序列的 `CONGEST_R_PCTL`（默认 12%）分位值作为动态
   * 阈值（并夹在 [CONGEST_R_MIN_M, CONGEST_R_MAX_M] 内防止极端赛道把阈值推飞）。
   * 这样"最急的那 12% 弯"在任何赛道上都稳定被识别为拥挤区。
   *
   * 提取流程：连续满足 `radius < 阈值` 的采样点合并成区间 -> 短于
   * `CONGEST_ZONE_SPAN_M`（60m）的区间做跨度过滤（单点噪声不单独成区）->
   * 跨 0 点的环绕区间用 `wrapped` 标记。
   *
   * 输出形如 `[{ i0, i1, wrapped, minR, rThr }]`，`i0/i1` 为采样索引闭区间。
   *
   * ⚠️ 分位判据只对**连续半径谱**成立。合成环道（`oval`）的半径只有两个取值
   * （直道≈∞、弯道恒 R=180m），半径序列在 14% 分位上落在"弯道与直道衔接的过渡点"
   * （实测阈值 179.97m，而弯道本体是 180.00m）⇒ 严格小于判据只圈出几段不足 60m 的
   * 过渡带，**整条弯道反而被判成非拥挤区**，拥挤幽灵化在该图上完全失效。
   * 因此 `Track` 支持由赛道定义显式覆盖阈值（`def.congestionRadiusM`），
   * 三条真实赛道不设该字段、继续走分位判据，行为不变。
   */
  buildCongestionZones(radius, opts = {}) {
    const N = this.count;
    // 动态阈值：半径分位数 + 上下限夹取
    let rThr;
    if (opts.rThreshold != null) {
      rThr = opts.rThreshold;
    } else if (this.congestionRadiusM > 0) {
      // 赛道定义显式覆盖（见上方说明：等半径的合成环道不能用分位判据）。
      // 优先级：调用方 opts > 赛道定义 > 分位判据。
      rThr = this.congestionRadiusM;
    } else {
      const pctl = opts.rPercentile != null ? opts.rPercentile : TRACK_CFG.CONGEST_R_PCTL;
      const sorted = Float64Array.from(radius).sort();
      const q = sorted[Math.min(sorted.length - 1,
        Math.max(0, Math.floor(pctl * sorted.length)))];
      rThr = Math.min(TRACK_CFG.CONGEST_R_MAX_M,
        Math.max(TRACK_CFG.CONGEST_R_MIN_M, q));
    }
    const minSpan = Math.max(1, Math.round(
      (opts.spanM != null ? opts.spanM : TRACK_CFG.CONGEST_ZONE_SPAN_M) / this.spacing));
    const hot = new Uint8Array(N);
    for (let i = 0; i < N; i++) hot[i] = radius[i] < rThr ? 1 : 0;

    // 找所有"急弯段"的起点（前一点冷、本点热）
    const zones = [];
    let anyHot = false;
    for (let i = 0; i < N; i++) if (hot[i]) { anyHot = true; break; }
    if (!anyHot) { this.congestionZones = []; return this.congestionZones; }

    const starts = [];
    for (let i = 0; i < N; i++) {
      if (hot[i] && !hot[(i - 1 + N) % N]) starts.push(i);
    }
    // 全域皆热：整条环线一个区（退化情形，理论不发生）
    if (!starts.length) {
      this.congestionZones = [{ i0: 0, i1: N - 1, wrapped: false, minR: rThr, rThr }];
      return this.congestionZones;
    }

    for (const s of starts) {
      let len = 0, minR = Infinity;
      while (hot[(s + len) % N] && len < N) {
        const j = (s + len) % N;
        if (radius[j] < minR) minR = radius[j];
        len++;
      }
      if (len < minSpan) continue;
      const i1 = (s + len - 1) % N;
      zones.push({ i0: s, i1, wrapped: s + len - 1 >= N, minR, rThr });
    }
    this.congestionZones = zones;
    this.congestionRadiusThreshold = rThr;
    return zones;
  }

  /**
   * 通用条带：从横向偏移 a 到 b 的闭环带状面，可携带顶点色（路肩 / 虚线 / 起跑格）。
   * @param {object} opts
   *   · baseY:true —— 沿**地面层**高程（不含桥面抬升）铺展。桥外侧的草皮/缓冲区
   *     必须用它，否则整条 42m 宽的绿化带会跟着桥面一起悬空。
   * @returns {THREE.BufferGeometry}
   */
  /**
   * 横向剖面 ribbon。
   *
   * `a`/`b` 支持三种形态（2026-09-30 新增数组形态，为真实铃鹿的**变宽路面**服务）：
   *   · 数字         —— 全程固定横向偏移；
   *   · 长度 N 的数组 —— 逐采样点横向偏移（真车宽度随路段变化：主直道 16m、发卡 11m）；
   *   · 函数 (i) => number。
   * 纵向 `ya`/`yb` 同样支持三种形态（2026-09-30 扩展：路肩要做逐点起伏，
   *   常量已不够用 —— 直道齐平、弯道立起 + 搓板波动，都由逐点剖面给出）。
   *   ⚠️ 曾经只支持常量：传函数时 `py + fn` = **NaN** ⇒ 整块几何 boundingSphere 变 NaN、
   *      渲染出隐形/破面（selftest 的"所有顶点均为有限数值"直接报红）。
   */
  _latAt(spec, i) {
    if (typeof spec === 'number') return spec;
    if (typeof spec === 'function') return spec(i);
    return spec[i];
  }

  _ribbon(a, b, ya, yb, opts = {}) {
    const N = this.count, pts = this.pts, side = this.side, nrm = this.nrm;
    const yArr = opts.baseY ? this.baseY : null;
    // ★ 每段占 2 个顶点，因此是 2*(N+1) 个而不是 N+1 个 —— 原来的
    //   `(N + 1) * 2 * 3` 正好写对（列数 3 已在尾乘），但为了不让下一个人
    //   再把"2"当口算误差删掉，这里显式命名成 SEG × 2。
    const SEGS = N + 1;
    const pos = new Float32Array(SEGS * 2 * 3);
    const nor = new Float32Array(SEGS * 2 * 3);
    const col = opts.colorA || opts.colorB || opts.color ? new Float32Array(SEGS * 2 * 3) : null;
    const idx = [];
    const cA = opts.colorA ? new THREE.Color(opts.colorA) : null;
    const cB = opts.colorB ? new THREE.Color(opts.colorB) : null;
    const cBase = opts.color ? new THREE.Color(opts.color) : null;
    const blockEvery = opts.blockEvery || 1;
    const vac = opts.variation || 0;

    // 纵向剖面：地面"裙边"要把草地外沿一路拉到大地圆盘（y=-26），
    // 否则赛道边缘到地面之间会留 20~35m 的垂直空档（视觉上就是"缺一块"）。
    const skirt = opts.skirt || null;

    for (let k = 0; k < SEGS; k++) {
      const i = k % N;
      const p = pts[i], s = side[i], n = nrm[i];
      const py = yArr ? yArr[i] : p.y;
      const o = k * 6;
      const av = this._latAt(a, i), bv = this._latAt(b, i);
      pos[o]     = p.x + s.x * av;
      pos[o + 1] = py + this._latAt(ya, i);
      pos[o + 2] = p.z + s.z * av;
      pos[o + 3] = p.x + s.x * bv;
      pos[o + 4] = py + this._latAt(yb, i);
      pos[o + 5] = p.z + s.z * bv;
      nor[o]     = n.x; nor[o + 1] = n.y; nor[o + 2] = n.z;
      nor[o + 3] = n.x; nor[o + 4] = n.y; nor[o + 5] = n.z;
      if (col) {
        let c = cBase;
        if (cA && cB) {
          const block = Math.floor(i / blockEvery);
          const cStriped = (block % 2 === 0) ? cA : cB;
          if (opts.mask) {
            const m = opts.mask[i];
            const cPlain = opts.colorPlain ? new THREE.Color(opts.colorPlain) : new THREE.Color(0x23272d);
            c = cPlain.clone().lerp(cStriped, m);
          } else {
            c = cStriped;
          }
        }
        // 色差扰动改用静态哈希（规格 §二.1）：不再依赖种子 RNG。
        const v = vac ? 1 + (statFrac(i, 41) - 0.5) * vac : 1;
        col[o]     = c.r * v; col[o + 1] = c.g * v; col[o + 2] = c.b * v;
        col[o + 3] = c.r * v; col[o + 4] = c.g * v; col[o + 5] = c.b * v;
      }
      if (k > 0) {
        const a0 = (k - 1) * 2, b0 = a0 + 1, a1 = k * 2, b1 = a1 + 1;
        if (opts.skip && opts.skip(i)) continue;
        idx.push(a0, b0, a1, b0, b1, a1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    if (skirt) this._extendSkirt(g, skirt);
    return g;
  }

  /**
   * 把 ribbon 的**外侧**那一列顶点沿 −Y 下沉到"本地地面层 − TERRAIN_LIP"，
   * 补出一条连续的地形裙边（浅唇），与 `_buildGround` 的地形网格严丝合缝。
   *
   * ⚠️ 2026-09-30 修的两个真 Bug（用户报障"赛道外的路段塌陷"）：
   *
   *  ① **哪一列才是外侧**不能靠"每段第二个顶点"猜。本文件里两条缓冲带的横向
   *     参数顺序是**相反**的：
   *        bufL = `_ribbon(-hw-cw-gw, -hw-cw, …)`   ⇒ 第 1 个顶点是外侧
   *        bufR = `_ribbon( hw+cw, hw+cw+gw, …)`    ⇒ 第 2 个顶点是外侧
   *     旧代码一律下沉"第二个"，于是**左草皮把贴路肩的内侧列拉到地面**，
   *     在赛道左边内侧劈出一道 20~30m 的深沟/空洞（正是"塌陷"的观感）。
   *     现在由 `skirt.outer` 显式指定列号（0 或 1），不再依赖隐含顺序。
   *
   *  ② **下沉目标不能是全局常量**。旧代码一律拉到固定的 TERRAIN_FLOOR_Y，
   *     而地面层沿赛道在 −7.6 ~ +4.2m 起伏 ⇒ 落差忽大忽小，且必然形成悬崖。
   *     现在用 `skirt.ground[i]`（= `this.baseY`）**逐采样点**取本地地面高度，
   *     只下沉 TERRAIN_LIP，裙边变成一道平缓浅唇。
   *
   * ⚠️ 只改**几何顶点**，不动 `groundOffset()` —— 那是物理用的解析地形，
   *    改了会让车"浮空/陷地"。裙边纯视觉，物理层完全不知情。
   * ⚠️ 复用同一列顶点（不新增索引）⇒ 裙边是**共享边**，不可能出现缝隙。
   */
  _extendSkirt(geo, skirt) {
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    const P = pos.array, Nr = nor.array;
    const outer = skirt.outer ? 1 : 0;        // 该 ribbon 里"外侧"顶点在本段内的序号
    const ground = skirt.ground || null;      // 逐采样点的地面层高度（this.baseY）
    const N = this.count;
    let touched = 0;
    for (let k = 0; k < P.length; k += 6) {
      const o = k + outer * 3;                // 外侧顶点的起始下标
      const yo = o + 1;                       // 外侧顶点的 y
      const i = (k / 6) % N;                  // 本段对应的采样点（SEGS = N+1，末段回到 0）
      // 目标高度：本地地面层 − 浅唇。没有地面剖面时退化为"在当前高度上再降一点"。
      // abs:true 时 ground[i] 已是**绝对高度**（锥面值），不再减浅唇
      const target = ground ? (skirt.abs ? ground[i] : ground[i] - TERRAIN_LIP) : P[yo] - TERRAIN_LIP;
      if (!(P[yo] > target + 0.02)) continue;  // 已经够低（或更低）就不动，避免把顶点抬起来
      const dx = P[o] - P[k + (1 - outer) * 3];
      const dz = P[o + 2] - P[k + 2 + (1 - outer) * 3];
      const len = Math.hypot(dx, dz) || 1;
      // 法线只用水平分量：竖直裙面朝外，光照才不会是一片死黑
      const sgn = skirt.side || 1;
      Nr[o] = (dx / len) * sgn; Nr[o + 1] = 0.25; Nr[o + 2] = (dz / len) * sgn;
      P[yo] = target;
      touched++;
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    geo.computeBoundingSphere();
    geo.__skirtVerts = touched;
    return touched;
  }

  /**
   * 大地地形网格（替代原来的 CircleGeometry 悬空圆盘）。
   *
   * 为什么必须换：圆盘固定铺在 y=-26，而赛道地面层在 −7.6~+4.2m 起伏 ⇒
   * 赛道外侧紧邻就是 18~30m 的垂直落差（悬崖），外面整片是"深坑"
   * （用户报障："赛道外的路段塌陷"）。
   *
   * 做法：极坐标网格（近密远疏），每个顶点到赛道中心线的最近距离决定高度：
   *   d ≤ BLEND_IN   → 完全贴合本地地面层（= 裙边落点，接缝不可见）
   *   BLEND_IN..OUT  → smoothstep 平滑过渡到远景平原 TERRAIN_FLOOR_Y
   *   d ≥ BLEND_OUT  → 恒为远景平原
   * 顶点数约 3.4k、一次性构建（构建期算最近点，不进主循环）。
   *
   * ⚠️ 高度一律取 `this.baseY`（**地面层**），不能用 `pts[i].y`：立交处
   *    pts.y 被桥面抬升过，用它会把地形抬到桥上去。
   */
  /**
   * ★ 地形高度函数（**唯一真源**）：所有路段锥面的下包络。
   *   cone_j(x,z) = baseY[j] − LIP                        （距 j 段 ≤ TERRAIN_CONE_D0）
   *               = FAR + (baseY[j] − LIP − FAR)·e^(−…/L) （更远则平滑衰减到远景平原）
   *   y = min over j within TERRAIN_CONE_R (cone_j)，再与"最近段锥面"取小、并夹在 FAR 之上。
   *
   * 为什么必须共用：地形网格与**裙边唇口**都要用这个函数取高度。只要两边算法不一致就会出现
   *   · 唇口按本地地面层、地形按锥面 ⇒ 草地外沿悬空（可差十几米，能看到缝）；
   *   · 唇口按"半径内最低" ⇒ 草地边缘劈出悬崖（用户报的"赛道外塌陷"）。
   * 共用之后：唇口落在锥面上 ⇒ 接缝天然严丝合缝。
   */
  terrainConeY(x, z) {
    const N = this.count, pts = this.pts, base = this.baseY;
    const D0 = TERRAIN_CONE_D0, L = TERRAIN_CONE_L, RINF = TERRAIN_CONE_R;
    const cone = (top, d) => (d <= D0 ? top : TERRAIN_FLOOR_Y + (top - TERRAIN_FLOOR_Y) * Math.exp(-(d - D0) / L));
    const nearest = [];
    for (let i = 0; i < N; i++) {
      const dx = pts[i].x - x, dz = pts[i].z - z;
      const d = Math.hypot(dx, dz);
      if (d <= RINF) nearest.push({ i, d, top: base[i] - TERRAIN_LIP });
    }
    if (!nearest.length) return TERRAIN_FLOOR_Y;
    nearest.sort((a, b) => a.d - b.d);
    // OSM 铃鹿/街道赛道有桥下和回头弯近贴投影。逐点取最低值会在
    // “最近路段”从一条路切到另一条路时产生垂直台阶；只混合最近的
    // 少量候选，并按距离连续衰减，避免把远处的另一层地面传播过来。
    const d0 = nearest[0].d;
    let sum = 0, weightSum = 0;
    for (const c of nearest.slice(0, 16)) {
      if (c.d > d0 + 8) break;
      const w = Math.exp(-(c.d - d0) / 5.0);
      sum += cone(c.top, c.d) * w;
      weightSum += w;
    }
    return Math.max(TERRAIN_FLOOR_Y, sum / Math.max(weightSum, 1e-9));
  }

  /**
   * ★ 近场地形带（2026-09-30 新增，修"弯道有部分路段塌陷"）
   *
   * 病根：大地面网格是**极坐标**的，近处环距也有 9~35m、远处上百米。而草地外沿
   * （离中心线约 51m）到地形之间的过渡只有几米宽 —— 网格根本接不住，于是沿路边
   * 到处是"草地边缘悬空、下面能看到低十几米的空地"的塌陷缝。实测落差 >1m 的点
   * 占 2571/2880，最大 7.64m。
   *
   * 做法：沿赛道**逐采样点**再铺一圈加密地形带（每点 K 环、向外 Δ 米递增），
   * 顶点高度直接用**同一个** `terrainConeY` —— 于是它与
   *   ① 草地裙边唇口（同一函数）严密合缝；
   *   ② 远处的大网格（同一函数）在网格点上取值一致，过渡处不会突然错开。
   * 顶点数 N×(K+1) ≈ 1440×9 ≈ 13k，构建期一次性计算。
   */
  _buildNearTerrain(K = 8, step = 16) {
    const N = this.count, pts = this.pts, side = this.side;
    const RINGV = K + 1;
    const STRIPV = N * RINGV;
    // 赛道左右两侧分别铺带。旧版只沿 +side 生成，另一侧只能依赖稀疏极坐标
    // 大地面，铃鹿桥下/高差段因此会出现可见的三角空洞。
    const pos = new Float32Array(STRIPV * 2 * 3);
    for (let s = 0; s < 2; s++) {
      const sign = s === 0 ? -1 : 1;
      for (let i = 0; i < N; i++) {
        const p = pts[i], sd = side[i];
        const inner = this.halfWidthAt[i] + this.curbWidth;
        const lat0 = inner + TRACK_CFG.GRASS_W;
        const stripBase = s * STRIPV;
        for (let k = 0; k < RINGV; k++) {
          const lat = sign * (lat0 + k * step);
          const x = p.x + sd.x * lat, z = p.z + sd.z * lat;
          const o = (stripBase + i * RINGV + k) * 3;
          pos[o] = x; pos[o + 1] = this.terrainConeY(x, z); pos[o + 2] = z;
        }
      }
    }
    const idx = [];
    for (let s = 0; s < 2; s++) {
      const stripBase = s * STRIPV;
      for (let i = 0; i < N; i++) {
        const i2 = (i + 1) % N;
        for (let k = 0; k + 1 < RINGV; k++) {
          const a0 = stripBase + i * RINGV + k, b0 = a0 + 1;
          const a1 = stripBase + i2 * RINGV + k, b1 = a1 + 1;
          idx.push(a0, a1, b0, a1, b1, b0);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  _buildGround() {
    const N = this.count, pts = this.pts, base = this.baseY;
    const RING = 30, SEG = 140, R_MAX = 6000;
    const pos = new Float32Array((1 + RING * SEG) * 3);
    // ★ 地形高度 = 所有路段的**锥形下包络**：
    //      cone_j = baseY[j] − LIP                       （距该段 ≤ TERRAIN_CONE_D0）
    //      cone_j = FAR + (baseY[j] − LIP − FAR)·e^(−…/L) （再远则平滑衰减到远景平原）
    //      y = min over j (cone_j)
    //   为什么是这个模型（两种错法都踩过）：
    //     · 取"最近采样点"⇒ 大三角形两端各取各的标高、**中段翘到路面之上**，
    //       表现为用户报的"右侧高地绿色草地过宽、已穿模到赛道"（绿色楔形斜切过路面）。
    //     · 取"半径内最低"⇒ 结构性不穿模了，但在高程差大的地方（立交两侧差 ~9m）
    //       草地外沿要被拉到远处那条低路的高度 ⇒ **草地边缘劈出 9m 悬崖**（又是"塌陷"）。
    //   锥形包络两头都对：贴着任何一段路时必然低于它（不穿模），离得远时只按自己的
    //   路段标高平滑下降（不劈悬崖），最终衰减到远景平原（不鼓包）。
    const heightAt = (x, z) => this.terrainConeY(x, z);
    // 顶点 0 = 中心
    pos[0] = 0; pos[1] = heightAt(0, 0); pos[2] = 0;
    let v = 1;
    for (let r = 1; r <= RING; r++) {
      // 半径按平方分布：赛道附近拿掉一半以上的环，远处才稀疏
      const rad = R_MAX * (r / RING) * (r / RING);
      for (let s2 = 0; s2 < SEG; s2++) {
        const a = (s2 / SEG) * TAU;
        const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
        pos[v * 3] = x; pos[v * 3 + 1] = heightAt(x, z); pos[v * 3 + 2] = z;
        v++;
      }
    }
    const idx = [];
    for (let s2 = 0; s2 < SEG; s2++) {          // 中心扇形
      const a1 = 1 + s2, b1 = 1 + ((s2 + 1) % SEG);
      idx.push(0, b1, a1);
    }
    for (let r = 1; r < RING; r++) {            // 环带
      const row = 1 + (r - 1) * SEG, nxt = 1 + r * SEG;
      for (let s2 = 0; s2 < SEG; s2++) {
        const s3 = (s2 + 1) % SEG;
        const a0 = row + s2, b0 = row + s3, a1 = nxt + s2, b1 = nxt + s3;
        idx.push(a0, b0, a1, b0, b1, a1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.__isTerrain = true;
    return g;
  }

  /**
   * 走线色带：1.2m 宽、悬浮 0.04m 的封闭面。顶点色留暗灰，
   * 由 main.js 每帧按"该点的物理极限通过速度"刷新成红→绿渐变。
   */
  buildRacingLine() {
    const N = this.count, pts = this.pts, side = this.side;
    const rl = this.raceLine || this._computeRacingLine();
    const off = rl.offset;
    const half = TRACK_CFG.RACE_LINE_W / 2;

    const pos = new Float32Array((N + 1) * 2 * 3);
    const nor = new Float32Array((N + 1) * 2 * 3);
    const col = new Float32Array((N + 1) * 2 * 3);
    const idx = [];
    for (let k = 0; k <= N; k++) {
      const i = k % N;
      const p = pts[i], s = side[i], n = this.nrm[i];
      const cx = p.x + s.x * off[i];
      const cz = p.z + s.z * off[i];
      const y = p.y + TRACK_CFG.RACE_LINE_H;
      const o = k * 6;
      pos[o] = cx + s.x * half; pos[o + 1] = y; pos[o + 2] = cz + s.z * half;
      pos[o + 3] = cx - s.x * half; pos[o + 4] = y; pos[o + 5] = cz - s.z * half;
      nor[o] = n.x; nor[o + 1] = n.y; nor[o + 2] = n.z;
      nor[o + 3] = n.x; nor[o + 4] = n.y; nor[o + 5] = n.z;
      col[o] = 0.30; col[o + 1] = 0.30; col[o + 2] = 0.34;
      col[o + 3] = 0.30; col[o + 4] = 0.30; col[o + 5] = 0.34;
      if (k > 0) {
        const a0 = (k - 1) * 2, b0 = a0 + 1, a1 = k * 2, b1 = a1 + 1;
        idx.push(a0, b0, a1, b0, b1, a1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'raceLine';
    mesh.renderOrder = 5;

    rl.mesh = mesh;
    rl.geometry = geo;
    rl.colorAttr = geo.attributes.color;
    return mesh;
  }

  // ========================================================================
  //  场景几何生成
  // ========================================================================

  /**
   * 构建整条赛道的可视场景（纯同步几何计算，无外部资源）。
   * @returns {{group:THREE.Group, lights:{setStage:Function, meshes:THREE.Mesh[]}, startIndex:number}}
   */
  build() {
    const N = this.count;
    const cw = this.curbWidth;
    const th = this.theme;
    const group = new THREE.Group();
    group.name = 'track';
    // ★ 变宽路面（2026-09-30）：真车路宽 10~16m 随路段变化，所以**不能**再用单一标量
    //   `hw` 铺设沥青/路肩/缓冲区。halfWidthAt 是逐点半宽数组（非变宽赛道全为同一值）。
    //   旧的标量 `hw` 仍保留给物理/AI 的保守判据（见 Track.halfWidth）。
    const hwAt = (i) => this.halfWidthAt[i];
    const negHwAt = (i) => -this.halfWidthAt[i];
    const hw = this.halfWidth;
    // 安全区度量（供 track-verify 断言）：所有散射地物（路灯/树木/大楼）
    // 中心到赛道中心线的最小水平距离。规格：必须 > 半宽 + 5.0m（护栏外 5m）。
    this.minScatterLat = Infinity;

    // 沥青路面：显式开启多边形偏移（规格 §三.1）。路面与它的阴影贴图/走线色带共面，
    // 不做偏移会在远处出现深度冲突（flicker）。道路标线偏移量再大一点，压在路面之上。
    const mAsphalt = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0.02,
      polygonOffset: true, polygonOffsetFactor: 1.0, polygonOffsetUnits: 1.0,
    });
    const mBuffer  = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0.0 });
    const mPaint   = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.0 });

    // ---- 沥青路面（变宽：主直道 16m、发卡/减速弯 11m）----------------------
    const asphalt = new THREE.Mesh(
      this._ribbon(negHwAt, hwAt, 0.02, 0.02, { color: th.asphalt, variation: 0.12 }),
      mAsphalt
    );
    asphalt.name = 'asphalt';
    group.add(asphalt);

    // ---- 内侧白线（赛道边界）-----------------------------------------------
    const lineW = TRACK_CFG.EDGE_LINE;
    const lineL = new THREE.Mesh(this._ribbon(
      (i) => -this.halfWidthAt[i] + 0.15, (i) => -this.halfWidthAt[i] + 0.15 + lineW,
      0.026, 0.026, { color: 0xdfe4e8 }), mPaint);
    const lineR = new THREE.Mesh(this._ribbon(
      (i) => this.halfWidthAt[i] - 0.15 - lineW, (i) => this.halfWidthAt[i] - 0.15,
      0.026, 0.026, { color: 0xdfe4e8 }), mPaint);
    group.add(lineL, lineR);

    // ---- 中央虚线（1 实 3 虚，4m 周期）-------------------------------------
    const dashBlock = Math.max(1, Math.round(4.0 / this.spacing));
    const centerLine = new THREE.Mesh(
      this._ribbon(-TRACK_CFG.CENTER_LINE / 2, TRACK_CFG.CENTER_LINE / 2, 0.028, 0.028, {
        colorA: 0xdfe4e8, colorB: th.asphalt, blockEvery: dashBlock,
      }),
      mPaint
    );
    group.add(centerLine);

    // ---- 红白立体路肩（减速带）--------------------------------------------
    const stripe = Math.max(1, Math.round(4.0 / this.spacing));
    const cm = this.curbMask;
    const ch = TRACK_CFG.CURB_H;
    // ★ 锯齿起伏（kerb serrations / 搓板减速带）：不仅整体凸起，且沿行车方向每隔一段
    //   有微小的上下波浪（4 采样点周期），压上去车身有可感的垂直震颤（FM8 特征）
    const curbGeoL = this._ribbon(
      (i) => -this.halfWidthAt[i] - cw, (i) => -this.halfWidthAt[i],
      (i) => {
        const m = cm[i];
        if (m < 0.02) return 0.002;           // 直道：完全贴平路面，不立起
        const ripple = Math.sin(i * 1.57) * 0.015 * m;  // 搓板起伏
        return -0.04 + (ch + ripple) * m;
      },
      (i) => cm[i] < 0.02 ? 0.002 : (0.015 + ch * cm[i]),
      {
        colorA: 0xd8241f, colorB: 0xf2f2f2, blockEvery: stripe, mask: cm,
      });
    const curbGeoR = this._ribbon(
      (i) => this.halfWidthAt[i], (i) => this.halfWidthAt[i] + cw,
      (i) => cm[i] < 0.02 ? 0.002 : (0.015 + ch * cm[i]),
      (i) => {
        const m = cm[i];
        if (m < 0.02) return 0.002;
        const ripple = Math.sin(i * 1.57) * 0.015 * m;
        return -0.04 + (ch + ripple) * m;
      },
      {
        colorA: 0xd8241f, colorB: 0xf2f2f2, blockEvery: stripe, mask: cm,
      });
    const curbs = new THREE.Mesh(mergeSimple(curbGeoL, curbGeoR), mPaint);
    curbs.name = 'curbs';
    group.add(curbs);

    // ---- 缓冲区（草地/沙地）：铺在**地面层**，桥段不会跟着悬空 ------------
    // ★ 草地外沿逐点收缩（用户报障："铃鹿后段有草地入侵到赛道"）
    //   草皮带横向要铺 42m，而赛道在发卡/减速弯/立交处会**折返**，两段中心线只隔
    //   十几到几十米 ⇒ 甲段的草皮直接盖到乙段的沥青上（实测 1523 个顶点被压，
    //   最深 7.65m，出现在 81% 处）。
    //   做法：对每个采样点，找所有"**横向过来**的其他路段"（用切向点积排除
    //   "我自己的前后几米"），把草地外沿收到那条路的**路肩外沿**为止。
    //   判据不含任何弧长阈值：同一条路上前后相邻的点与切向几乎平行，天然被排除；
    //   发卡/立交对面那一段与切向近垂直，天然被收进来。
    const gw = TRACK_CFG.GRASS_W;
    const grassLimit = new Float64Array(N);
    // 裙边唇口高度：左/右草皮分开算（左外沿在 −grassLimit，右外沿在 +grassLimit）
    const skirtYL = new Float64Array(N), skirtYR = new Float64Array(N);
    const ptsB = this.pts, tanB = this.tan;
    for (let i = 0; i < N; i++) {
      const pi = ptsB[i], ti = tanB[i], si = this.side[i];
      let lim = Infinity;
      for (let j = 0; j < N; j++) {
        const dx = ptsB[j].x - pi.x, dz = ptsB[j].z - pi.z;
        const d = Math.hypot(dx, dz);
        if (d < 1e-6 || d > 140) continue;
        const cosv = (dx * ti.x + dz * ti.z) / d;
        if (Math.abs(cosv) > 0.70) continue;
        const latAtOther = Math.abs(dx * this.side[j].x + dz * this.side[j].z);
        const clearance = d - (this.halfWidthAt[j] + cw + 1.0);
        if (clearance < lim && clearance > 0) lim = clearance;
        void latAtOther;
      }
      const inner = this.halfWidthAt[i] + cw;
      grassLimit[i] = Math.max(inner + 1.0, Math.min(inner + gw, lim));
      // 左外沿坐标 = p − side · grassLimit；右外沿 = p + side · grassLimit
      const w = grassLimit[i];
      skirtYL[i] = this.terrainConeY(pi.x - si.x * w, pi.z - si.z * w);
      skirtYR[i] = this.terrainConeY(pi.x + si.x * w, pi.z + si.z * w);
    }
    const bufL = this._ribbon(
      (i) => -grassLimit[i], (i) => -this.halfWidthAt[i] - cw,
      -1.10, -0.10, {
        color: th.grass, variation: 0.22, baseY: true,
        // 外侧 = 第 1 个顶点（横向第一个参数就是最外那列）
        skirt: { side: -1, outer: 0, ground: skirtYL, abs: true },
      });
    const bufR = this._ribbon(
      (i) => this.halfWidthAt[i] + cw, (i) => grassLimit[i],
      -0.10, -1.10, {
        color: th.grass, variation: 0.22, baseY: true,
        // 外侧 = 第 2 个顶点（这里的第二个横向参数才是最外那列）
        skirt: { side: 1, outer: 1, ground: skirtYR, abs: true },
      });
    // ★ 裙边：两条 buffer 的**真正外侧**顶点被 _extendSkirt 下沉到"本地地面层 − 浅唇"，
    //   与 _buildGround() 的地形网格接缝重合；不再有 20~30m 悬崖/深坑。
    const buffer = new THREE.Mesh(mergeSimple(bufL, bufR), mBuffer);
    buffer.name = 'buffer';
    group.add(buffer);

    // ---- 起跑/终点格（黑白格）：8 列 2 排 ----------------------------------
    // ⚠️ 横向必须用**逐点半宽** `halfWidthAt[i]`，不能用标量 `hw`：铃鹿变宽后
    //    `hw` 取的是**最窄处**（5.5m），而主直道实际 ±8m ⇒ 终点线两侧各空 2.5m，
    //    看起来就是"终点线没有横向铺满赛道"（用户报障）。四角各自按所在采样点取宽。
    const gridN = 8;
    const half = Math.max(2, Math.round(4.5 / this.spacing));
    const gi = [];
    const gv = [], gn = [], gc = [];
    const black = new THREE.Color(0x1a1c20), white = new THREE.Color(0xf2f2f2);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < gridN; c++) {
        const i0 = (N - half * 2 + r * half) % N;
        const i1 = (i0 + half) % N;
        const t0 = c / gridN, t1 = (c + 1) / gridN;
        const w0 = this.halfWidthAt[i0], w1 = this.halfWidthAt[i1];
        const a0i0 = -w0 + t0 * w0 * 2, a1i0 = -w0 + t1 * w0 * 2;
        const a0i1 = -w1 + t0 * w1 * 2, a1i1 = -w1 + t1 * w1 * 2;
        const p0 = this.pts[i0], p1 = this.pts[i1], s0 = this.side[i0], s1 = this.side[i1], n0 = this.nrm[i0];
        const col = ((r + c) % 2 === 0) ? white : black;
        const base = gv.length / 3;
        const quad = [
          [p0.x + s0.x * a0i0, p0.y + 0.03, p0.z + s0.z * a0i0],
          [p0.x + s0.x * a1i0, p0.y + 0.03, p0.z + s0.z * a1i0],
          [p1.x + s1.x * a0i1, p1.y + 0.03, p1.z + s1.z * a0i1],
          [p1.x + s1.x * a1i1, p1.y + 0.03, p1.z + s1.z * a1i1],
        ];
        for (const v of quad) { gv.push(v[0], v[1], v[2]); gn.push(n0.x, n0.y, n0.z); gc.push(col.r, col.g, col.b); }
        gi.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
    const startGeo = new THREE.BufferGeometry();
    startGeo.setAttribute('position', new THREE.Float32BufferAttribute(gv, 3));
    startGeo.setAttribute('normal', new THREE.Float32BufferAttribute(gn, 3));
    startGeo.setAttribute('color', new THREE.Float32BufferAttribute(gc, 3));
    startGeo.setIndex(gi);
    group.add(new THREE.Mesh(startGeo, mPaint));

    // ---- 发车龙门 + 五连信号灯 ---------------------------------------------
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.45, metalness: 0.6 });
    const poleGeo = new THREE.CylinderGeometry(0.34, 0.4, 11, 10);
    const px0 = this.pts[0], sx0 = this.side[0];
    const pL = new THREE.Mesh(poleGeo, poleMat);
    pL.position.set(px0.x + sx0.x * (hw + 1.6), px0.y + 5.5, px0.z + sx0.z * (hw + 1.6));
    const pR = new THREE.Mesh(poleGeo, poleMat);
    pR.position.set(px0.x - sx0.x * (hw + 1.6), px0.y + 5.5, px0.z - sx0.z * (hw + 1.6));
    const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 4.0, 0.7, 0.7), poleMat);
    beam.position.set(px0.x, px0.y + 10.6, px0.z);
    beam.quaternion.setFromEuler(new THREE.Euler(0, Math.atan2(sx0.z, sx0.x), 0));
    group.add(pL, pR, beam);

    const bannerCanvas = document.createElement('canvas');
    bannerCanvas.width = 1024; bannerCanvas.height = 160;
    const bctx = bannerCanvas.getContext('2d');
    const grad = bctx.createLinearGradient(0, 0, 1024, 0);
    grad.addColorStop(0, '#101318'); grad.addColorStop(0.5, '#1b2029'); grad.addColorStop(1, '#101318');
    bctx.fillStyle = grad; bctx.fillRect(0, 0, 1024, 160);
    bctx.fillStyle = '#e10600'; bctx.fillRect(0, 0, 1024, 8); bctx.fillRect(0, 152, 1024, 8);
    bctx.fillStyle = '#ffffff';
    bctx.font = '600 74px system-ui, "Microsoft YaHei", Arial, sans-serif';
    bctx.textAlign = 'center'; bctx.textBaseline = 'middle';
    // 起点横幅文案按赛道取。原来是 `vegas ? LAS VEGAS : SUZUKA` 的二分写法 ——
    // 加第三条赛道后斯帕会顶着一块写着 SUZUKA 的牌子（实测截图抓到的）。
    const bannerName = { vegas: 'LAS  VEGAS', suzuka: 'SUZUKA', spa: 'SPA  FRANCORCHAMPS' };
    bctx.fillText('FORZA  LAN  ·  ' + (bannerName[this.trackType] || 'SUZUKA'), 512, 82);
    const bannerTex = new THREE.CanvasTexture(bannerCanvas);
    bannerTex.anisotropy = 4;
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(hw * 2 + 4.0, 2.2),
      new THREE.MeshBasicMaterial({ map: bannerTex, side: THREE.DoubleSide })
    );
    banner.position.set(px0.x, px0.y + 8.6, px0.z);
    banner.quaternion.copy(beam.quaternion);
    banner.rotateY(Math.PI / 2);
    group.add(banner);

    const lights = [];
    const lightGeo = new THREE.BoxGeometry(0.9, 0.9, 0.28);
    for (let i = 0; i < 5; i++) {
      const lam = new THREE.MeshBasicMaterial({ color: 0x220404 });
      const m = new THREE.Mesh(lightGeo, lam);
      const off = (i - 2) * 1.5;
      m.position.set(px0.x + sx0.x * off, px0.y + 10.6, px0.z + sx0.z * off);
      m.quaternion.copy(beam.quaternion);
      group.add(m);
      lights.push(m);
    }
    const setStage = (stage) => {
      for (let i = 0; i < 5; i++) {
        if (stage >= 6) { lights[i].material.color.setHex(0x22dd55); continue; }
        lights[i].material.color.setHex(i < stage ? 0xff2a1f : 0x220404);
      }
    };

    // ---- 路灯（InstancedMesh，两个 draw call）------------------------------
    // `THEMES[].lampCount` 在这里当**开关**用（非 0 = 生成路灯）；实际根数由赛道
    // 长度与 lampEvery 推导 —— 所以它是"有无"而不是"根数"，改数值不影响密度。
    // 间距 46m 两侧交错，且落位后再过一遍净空安全廊道（下方 lat 判断）。
    const lampEvery = Math.max(1, Math.round(46 / this.spacing));
    // lampCount=0 时：实例数 0 + 下面的 for 不进入 + 末尾 `if (li > 0)` 不 add，
    // 整段自然变成空操作（不必把 30 多行整块缩进包进 if）。
    const lampCount = th.lampCount > 0 ? (Math.floor(N / lampEvery) * 2 + 4) : 0;
    const poleI = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.13, 0.17, 9, 6), poleMat, lampCount
    );
    const headMat = new THREE.MeshBasicMaterial({ color: th.night ? 0xfff2cf : 0xfff0c4 });
    const headI = new THREE.InstancedMesh(new THREE.BoxGeometry(1.5, 0.22, 0.6), headMat, lampCount);
    const dummy = new THREE.Object3D();
    const box = this._bridgeExclusionBox();
    let li = 0;
    for (let k = 0; k < N && li < lampCount; k += lampEvery) {
      if (this.onBridge(k)) continue;                     // 桥面已另设照明
      for (const dir of [1, -1]) {
        if (li >= lampCount) break;
        const p = this.pts[k], s = this.side[k];
        // 规格 §五：路灯也是景观，必须硬隔离在 半宽 + 8.5m = 15.5m 之外。
        // 旧值 max(CLEAR_ANCHOR_M=14.0, hw+cw+6.0=14.2) 低于新口径 ⇒ 灯杆会探进缓冲区。
        const off = dir * Math.max(sceneryClearMin(hw), CLEAR_ANCHOR_M, hw + cw + 6.0);
        if (!clearOK(off)) continue;                        // 双重距离排他校验
        const x = p.x + s.x * off, z = p.z + s.z * off;
        if (box && this._inBridgeExclusion(box, x, z)) continue;
        const clearance = this._minTrackDistance2D(x, z);
        if (clearance <= sceneryClearMin(hw)) continue;
        this.minScatterLat = Math.min(this.minScatterLat, clearance);
        dummy.position.set(x, p.y + 4.5, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        poleI.setMatrixAt(li, dummy.matrix);
        dummy.position.set(x - s.x * dir * 0.9, p.y + 8.9, z - s.z * dir * 0.9);
        dummy.updateMatrix();
        headI.setMatrixAt(li, dummy.matrix);
        li++;
      }
    }
    poleI.count = li; headI.count = li;
    poleI.instanceMatrix.needsUpdate = true;
    headI.instanceMatrix.needsUpdate = true;
    if (li > 0) group.add(poleI, headI);

    // ---- 主题地物 ----------------------------------------------------------
    // 规格（本轮）：只保留赛道本体。树木 / 大楼数量都是 0，这里会自然跳过；
    // 之所以保留调用点而不是删掉函数，是为了以后想加回景物时只改 THEMES 计数即可。
    if (th.treeCount > 0) this._buildForest(group, dummy);
    if (th.buildingCount > 0) this._buildCity(group, dummy);

    // ---- 立交桥结构（仅铃鹿）----------------------------------------------
    if (this.bridge.active) this._buildBridge(group);

    // 看台会形成赛道外侧的高位遮挡，按当前验收要求不再生成。
    this.grandstands = [];

    // ---- 护栏（三大赛道全线实体护栏，横向落位见 def.barrierLat）-------------
    this._buildBarriers(group);

    // ---- 远景山脊 + 大地 ---------------------------------------------------
    // 静态布置（规格 §二.1）：环形均布 + 下标哈希扰动，跨 seed 完全一致。
    const hillCount = th.hillCount;
    const hillI = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 6),
      new THREE.MeshStandardMaterial({ color: th.hill, roughness: 1, flatShading: true }),
      hillCount
    );
    for (let h = 0; h < hillCount; h++) {
      const a = (h / hillCount) * TAU + statFrac(h, 31) * 0.05;
      const rad = 3000 * (1.6 + statFrac(h, 32) * 0.9);
      const hgt = (th.night ? 90 : 70) + statFrac(h, 33) * 130;
      dummy.position.set(Math.cos(a) * rad, TERRAIN_FLOOR_Y - 8 + hgt * 0.5, Math.sin(a) * rad);
      dummy.scale.set(90 + statFrac(h, 34) * 120, hgt, 90 + statFrac(h, 35) * 120);
      dummy.rotation.set(0, statFrac(h, 36) * TAU, 0);
      dummy.updateMatrix();
      hillI.setMatrixAt(h, dummy.matrix);
    }
    hillI.instanceMatrix.needsUpdate = true;
    const hills = hillI;
    group.add(hills);
    this.hills = hills;

    const ground = new THREE.Mesh(
      this._buildGround(),
      new THREE.MeshStandardMaterial({ color: th.ground, roughness: 1 })
    );
    ground.position.y = 0;      // 高度已在 _buildGround 里逐顶点算好（跟随地形起伏）
    ground.name = 'ground';
    group.add(ground);

    // ★ 近场地形带：沿赛道加密一圈（顶点落在同一个 terrainConeY 上）⇒
    //   草地外沿到地形之间不再有"塌陷缝"（详见 _buildNearTerrain 的说明）。
    const mGroundNear = new THREE.MeshStandardMaterial({ color: th.ground, roughness: 1 });
    const groundNear = new THREE.Mesh(this._buildNearTerrain(), mGroundNear);
    groundNear.name = 'groundNear';
    group.add(groundNear);

    // ---- 动态最佳走线色带（顶点色由 main.js 每帧刷新）----
    group.add(this.buildRacingLine());

    return { group, lights: { setStage, meshes: lights }, startIndex: 0 };
  }

  /* ---------------- 规格 §五：铃鹿立交桥 3D 排除盒 ---------------- */
  /**
   * 构造立交桥的 **3D 排除盒投影**（XZ 平面矩形）。
   *
   * 规格 §五：铃鹿 8 字立体交叉（桥面 Y = +7.5m，桥下 Y = 0.0m）——
   * 以**桥面中心**为基准，向前后各 ±60m、向左右各 ±25m 框出矩形包围盒；
   * 该盒在 XZ 平面的投影内**禁止任何树木**（杜绝树从桥下长出来穿透桥面）。
   *
   * 桥面中心取桥段采样点（bridge.i0..i1）的形心；轴向取桥面主方向
   * （首尾切线），这样盒随赛道形状旋转，而不是写死的 AABB。
   *
   * 返回 null 表示本赛道无立交桥（vegas/spa），调用方据此跳过排除判定。
   */
  _bridgeExclusionBox() {
    const b = this.bridge;
    if (!b || !b.active) return null;
    const N = this.count;
    // 桥段采样点形心 + 主方向（首尾切线均值）
    let cx = 0, cz = 0, n = 0;
    let dirx = 0, dirz = 0;
    for (let i = b.i0; ; i = (i + 1) % N) {
      const p = this.pts[i];
      cx += p.x; cz += p.z; n++;
      if (i === b.i1) break;
    }
    if (!n) return null;
    cx /= n; cz /= n;
    const t0 = this.tan[b.i0], t1 = this.tan[b.i1];
    dirx = t0.x + t1.x; dirz = t0.z + t1.z;
    let dl = Math.hypot(dirx, dirz);
    if (dl < 1e-6) { dirx = t0.x; dirz = t0.z; dl = Math.hypot(dirx, dirz) || 1; }
    dirx /= dl; dirz /= dl;
    // 垂直方向（左法向）
    const perpX = -dirz, perpZ = dirx;
    return {
      cx, cz, dirx, dirz, perpX, perpZ,
      halfLen: BRIDGE_EXCL_LEN,   // 桥面中心 ±60m（前/后）
      halfWid: BRIDGE_EXCL_WID,   // 桥面中心 ±25m（左/右）
      deckY: TRACK_CFG.BRIDGE_Y,  // 桥面高度 +7.5m
      underY: 0.0,                // 桥下地面 0.0m
    };
  }

  /** 世界点 (x,z) 是否落在立交桥 3D 排除盒的 XZ 投影内。 */
  _inBridgeExclusion(box, x, z) {
    if (!box) return false;
    const dx = x - box.cx, dz = z - box.cz;
    const along = dx * box.dirx + dz * box.dirz;      // 桥面轴向投影
    const across = dx * box.perpX + dz * box.perpZ;   // 桥面横向投影
    return Math.abs(along) <= box.halfLen && Math.abs(across) <= box.halfWid;
  }

  /* ---------------- 主题：铃鹿森林 ---------------- */
  /**
   * 静态固定森林（规格 §二.1/§二.2）：
   *   · 布置 100% 由 statFrac(i) 决定，**不含任何 seed / Math.random**；
   *   · 规格 §五：每棵树中心到赛道中心线的 2D 水平距离必须**严格 >（半宽 + 8.5m）**，
   *     硬隔离在路面（含路肩）之外 —— `needLat = hw + BARRIER_OUT_M`（= 7 + 8.5 = 15.5m）。
   *     旧口径 `hw + cw + 5.0` 已废弃（5.0 太近，树冠会探进缓冲区）。
   *   · 规格 §五：铃鹿立交桥 3D 排除盒内的树**一律不生成**（桥下不得长树穿桥面）。
   *   · 双重距离剔除：needLat 已是第一重（横向投影），
   *     generateTrack 里还有第二重（样条最近点柱状剔除，见 _scatterClearance）。
   */
  _buildForest(group) {
    const N = this.count, hw = this.halfWidth, cw = this.curbWidth, gw = TRACK_CFG.GRASS_W;
    const treeCount = this.theme.treeCount;
    const trunkGeo = new THREE.CylinderGeometry(0.42, 0.62, 5.0, 6);
    const leafGeo = new THREE.ConeGeometry(2.5, 8.0, 7);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x1f5c24, roughness: 1 });
    const trunkI = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const leafI = new THREE.InstancedMesh(leafGeo, leafMat, treeCount);
    const c = new THREE.Color();
    const dummy = new THREE.Object3D();
    // 规格 §五硬隔离下界 = 半宽 + 8.5m（严格大于该值才允许落景）。
    const needLat = sceneryClearMin(hw);
    // 规格 §五：铃鹿立交桥 3D 排除盒（桥面投影矩形，盒内禁止任何树木）。
    const box = this._bridgeExclusionBox();
    let k = 0;                       // 实际写入的实例游标（跳过被安全廊道过滤的坐标）
    this.buildings = this.buildings || [];
    // 规格 §五审计用：记录每棵树的落位（含横向距离），供 track-verify 断言
    // "桥下排除盒内 0 棵树" 与 "所有树 > 半宽+8.5m"。
    this.trees = this.trees || [];
    for (let t = 0; t < treeCount; t++) {
      // 静态布置：样条点位与横向距离全部来自下标哈希，跨 seed 一致。
      const idx = Math.floor(statFrac(t, 11) * N) % N;
      // 横向距离从 needLat 起、最多再外扩 grass 余量（确保永远在 8.5m 缓冲之外）。
      const lat = needLat + 1.0 + statFrac(t, 12) * Math.max(4.0, gw - 10);
      // 双重距离剔除：needLat（半宽+8.5）与既有净空口径取较严者。
      const clearMin = Math.max(needLat, CLEAR_REJECT_M);
      if (lat < clearMin) continue;
      const d = statFrac(t, 13) < 0.5 ? -1 : 1;
      const p = this.pts[idx], s = this.side[idx];
      const x = p.x + s.x * lat * d, z = p.z + s.z * lat * d;
      // 规格 §五：立交桥 3D 排除盒投影内的树一律跳过（杜绝桥下长树穿透桥面）。
      if (box && this._inBridgeExclusion(box, x, z)) continue;
      const clearance = this._minTrackDistance2D(x, z);
      if (clearance <= needLat) continue;
      this.minScatterLat = Math.min(this.minScatterLat, clearance);
      this.trees.push({ x, z, lat: clearance });
      const gy = this.baseY[idx] - 0.12 - (lat - hw - cw) / gw * 0.9;
      const sc = 0.7 + statFrac(t, 14) * 0.9;
      dummy.position.set(x, gy + 2.5 * sc, z);
      dummy.rotation.set(0, statFrac(t, 15) * TAU, 0);
      dummy.scale.set(sc, sc, sc);
      dummy.updateMatrix();
      trunkI.setMatrixAt(k, dummy.matrix);
      dummy.position.set(x, gy + (5.0 + 2.6) * sc, z);
      dummy.updateMatrix();
      leafI.setMatrixAt(k, dummy.matrix);
      if (leafI.setColorAt) {
        c.setHSL(0.30 + statFrac(t, 16) * 0.07, 0.5 + statFrac(t, 17) * 0.2, 0.17 + statFrac(t, 18) * 0.13);
        leafI.setColorAt(k, c);
      }
      k++;
    }
    trunkI.count = k;
    leafI.count = k;
    trunkI.instanceMatrix.needsUpdate = true;
    leafI.instanceMatrix.needsUpdate = true;
    if (leafI.instanceColor) leafI.instanceColor.needsUpdate = true;
    group.add(trunkI, leafI);
  }

  /* ---------------- 主题：拉斯维加斯街区 + Sphere 球馆 ---------------- */
  /**
   * 静态固定街区（规格 §二.1/§二.2）：与森林同理，位置/尺寸/朝向全部由
   * statFrac(i, salt) 决定，**不含 seed / Math.random**；且落位硬隔离在
   * 护栏外 5.0m 之外（这里因建筑体量大，实际口径远严于 5m）。
   */
  _buildCity(group) {
    const N = this.count, hw = this.halfWidth, cw = this.curbWidth;
    const count = this.theme.buildingCount;
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1b1f2a, roughness: 0.7, metalness: 0.35,
      emissive: 0x141a2e, emissiveIntensity: 1.0,
    });
    const bi = new THREE.InstancedMesh(boxGeo, mat, count);
    const lightGeo = new THREE.BoxGeometry(1, 0.16, 1);
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xffd98a });
    const li = new THREE.InstancedMesh(lightGeo, lightMat, count);
    const dummy = new THREE.Object3D();
    let k = 0;                       // 实际写入的实例游标（跳过被安全廊道过滤的坐标）
    this.buildings = this.buildings || [];
    // ★ 建筑净空口径 = **取三套口径的较严者**（规格 §五 + 本工程既有红线）：
    //   · 规格 §五 新口径  半宽 + 8.5 缓冲 = 7.0 + 8.5 = 15.5m（sceneryClearMin）
    //   · 规格旧口径       半宽 + 路肩 + 4.0 缓冲 = 7.0 + 1.2 + 4.0 = 12.2m
    //   · 本工程既有红线   CLEAR_REJECT_M = 13.5m（track-verify 一直在断言）
    //   取最严者 —— 只取旧的 12.2 会把判定放松到项目红线以下 ⇒ 破坏既有保证。
    const needLat = Math.max(Math.max(sceneryClearMin(hw), buildingClearNeed(hw, cw)), CLEAR_REJECT_M);
    for (let b = 0; b < count; b++) {
      // 静态布置：样条点位 / 横向距离 / 体量 / 朝向全部来自下标哈希。
      const idx = Math.floor(statFrac(b, 21) * N) % N;
      const lat = (hw + cw + 16) + statFrac(b, 22) * 190;
      const d = statFrac(b, 23) < 0.5 ? -1 : 1;
      const p = this.pts[idx], s = this.side[idx];
      const x = p.x + s.x * lat * d, z = p.z + s.z * lat * d;
      const base = this.baseY[idx] - 1.0;
      const w = 16 + statFrac(b, 24) * 34, dp = 16 + statFrac(b, 25) * 34;
      const yaw = statFrac(b, 26) * TAU;
      // ★★ 真实 OBB 五点净空判定（中心 + 4 角点，角点经 yaw 旋转矩阵变换）。
      //    旧写法 `if (lat - 34 < CLEAR_REJECT_M) continue;` 的致命缺口：
      //    w/dp 半宽最大 25m ⇒ 真实半对角可达 35.36m **> 34m**，
      //    体量最大的建筑角点会越过保守半径、侵入净空廊道。
      //    近似半径必须换成"逐点实测横向投影距离"。
      const clr = obbClearOfTrack(this, x, z, yaw, w * 0.5, dp * 0.5, needLat);
      if (!clr.ok) continue;
      this.minScatterLat = Math.min(this.minScatterLat, clr.minD);
      // 高度按**视野安全角**分级（方案 F 规则 1）：原来最高可到 ~370m 而落位仅 45m
      // -> 仰角 83°，在弯道出口等于整块视野被堵死。现在按 h ≤ tan(θ)·lat − 眼高 压缩。
      const atCorner = this.raceLine.radius[idx] < VIEW_SAFE.CORNER_R;
      const theta = atCorner ? VIEW_SAFE.CORNER : VIEW_SAFE.STRAIGHT;
      let h = 24 + statFrac(b, 27) * 150 * (statFrac(b, 28) < 0.25 ? 2.2 : 1);
      // ★ 视野安全角是**硬上限**：`tan(θ)·lat − 眼高` 就是"从眼位看刚好不出视野"的高度。
      //   旧写法 `Math.min(h, Math.max(12, cap))` 里的 `Math.max(12, ·)` 是个**下界地板**，
      //   当 lat 较小（cap < 12m）时它会**反过来抬高**上限、把视野规则整条废掉
      //   —— 实测 lat=25.75m 的弯道建筑 cap=3.47m 被抬到 12m，仰角 22.8° > 17°。
      //   正解：cap 就是 cap（不再加地板）；若 cap 连最低可接受高度都不到，
      //   说明这个落位**不该盖楼**（离赛道太近 + 在弯道外侧），直接放弃该样本。
      const cap = Math.tan(theta) * lat - VIEW_SAFE.EYE_H;
      if (cap < 8.0) continue;              // 太矮就没有天际线价值，且必然挡视野 -> 弃样
      h = Math.min(h, cap);
      const ang = Math.atan((h - VIEW_SAFE.EYE_H) / lat);
      if (ang > theta) continue;            // 二次保险：仰角硬校验（防 cap 算错）
      // 暴露落位供测试审计（"建筑有没有挡住视野"必须能被断言）
      this.buildings.push({ lat, h, atCorner, i: idx, minD: clr.minD, w, dp, yaw });
      dummy.position.set(x, base + h / 2, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(w, h, dp);
      dummy.updateMatrix();
      bi.setMatrixAt(k, dummy.matrix);
      // 楼顶泛光条（夜间天际线）
      dummy.position.set(x, base + h + 0.4, z);
      dummy.scale.set(w * 0.9, 1, dp * 0.9);
      dummy.updateMatrix();
      li.setMatrixAt(k, dummy.matrix);
      k++;
    }
    bi.count = k;
    li.count = k;
    bi.instanceMatrix.needsUpdate = true;
    li.instanceMatrix.needsUpdate = true;
    group.add(bi, li);

    // ---- Sphere 球馆：赛道绕行的巨大发光球体 ----
    if (this.sphere) {
      const sph = new THREE.Mesh(
        new THREE.SphereGeometry(this.sphere.r, 40, 28),
        new THREE.MeshStandardMaterial({
          color: 0x2a3350, roughness: 0.35, metalness: 0.5,
          emissive: 0x2f5cff, emissiveIntensity: 0.55,
        })
      );
      sph.position.set(this.sphere.x, this.sphere.r * 0.92, this.sphere.z);
      sph.name = 'sphereArena';
      group.add(sph);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(this.sphere.r * 1.06, 2.2, 8, 64),
        new THREE.MeshBasicMaterial({ color: 0x66d9ff })
      );
      ring.position.copy(sph.position);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
    }
  }

  /* ---------------- 立交桥：桥面护栏 + 引桥 + 支撑立柱 ---------------- */
  /**
   * 桥面与桥下是**两套独立的路面层**：
   *   · 桥面层 = pts（含 +BRIDGE_Y 抬升），由 sample() 按车辆所在高度解析命中；
   *   · 桥下层 = baseY，桥下通行次独立命中。
   * 桥上护栏与支撑立柱另外登记为静态刚体（this.colliders），
   * 由 registerTrackBodies() 落地成 cannon-es 的静态 Box —— 车撞上会被真实阻挡。
   */
  _buildBridge(group) {
    const N = this.count, hw = this.halfWidth, cw = this.curbWidth;
    const b = this.bridge;
    const step = Math.max(2, Math.round(6 / this.spacing));
    const mat = new THREE.MeshStandardMaterial({ color: 0xb8c0c8, roughness: 0.6, metalness: 0.3 });
    const rail = new THREE.MeshStandardMaterial({ color: 0xd8241f, roughness: 0.5, metalness: 0.2 });

    const idxs = [];
    for (let i = b.i0; ; i = (i + 1) % N) {
      idxs.push(i);
      if (i === b.i1) break;
    }
    const segs = Math.floor(idxs.length / step) || 1;
    const railI = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), rail, segs * 2);
    const dummy = new THREE.Object3D();
    let n = 0;
    const len = this.spacing * step * 1.05;
    // 规格 §五：桥上**独立加高护栏**。桥面比地面高 +7.5m，普通护栏（1.4m）在
    // 高空落差下防护不足，故桥侧单独建一组**加高**护栏（1.8m 半高的可视 + 碰撞体
    // 同步放大），且与地面护栏**完全独立**（互不影响、互不穿模）。
    const BRIDGE_RAIL_H = 1.8;
    for (let k = 0; k < idxs.length - 1; k += step) {
      const i = idxs[k];
      const p = this.pts[i], s = this.side[i], t = this.tan[i];
      const yaw = Math.atan2(t.x, t.z);
      for (const d of [1, -1]) {
        const lat = d * (hw + cw + 0.55);   // 略外推，避免与车轮贴面
        const x = p.x + s.x * lat, z = p.z + s.z * lat, y = p.y + BRIDGE_RAIL_H / 2;
        dummy.position.set(x, y, z);
        dummy.rotation.set(0, yaw, 0);
        // 桥侧加高护栏：可视网格高度与碰撞体半高必须严格同步（否则会露馅）
        dummy.scale.set(0.45, BRIDGE_RAIL_H, len);
        dummy.updateMatrix();
        if (n < railI.count) railI.setMatrixAt(n++, dummy.matrix);
        this.colliders.push({
          x, y, z,
          qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2),
          hx: BARRIER_HULL_HX, hy: BRIDGE_RAIL_H / 2, hz: len / 2,
        });
      }
    }
    railI.count = n;
    railI.instanceMatrix.needsUpdate = true;
    group.add(railI);

    // ---- 支撑立柱：从桥下地面(baseY)顶到桥面(pts.y) ----
    const pillarStep = Math.max(4, Math.round(34 / this.spacing));
    const pillars = [];
    const stations = [];   // 每个立柱站位（两根柱 + 一根盖梁）
    for (let k = 0; k < idxs.length; k += pillarStep) {
      const i = idxs[k];
      const p = this.pts[i], s = this.side[i];
      const y0 = this.baseY[i];
      const h = Math.max(1, p.y - y0);
      if (h < 2) continue;
      // 桥墩锚点必须避开**桥下道路**（规格 §五：锚定在下层沥青边缘外侧 **4.0m** 以外，
      // 桥下净空 ≥16m）。这里原来是 `lat = d * (hw - 1.2) = ±5.8m` ——
      // 那是相对**桥面**中心线的偏移，而柱子是从地面顶到桥面的：实测 18/20 根
      // 直接立在下层沥青上，最严重处距下层路中心线仅 0.95m（桥下净空只剩 1.89m），
      // 等于在下层路上砌了一堵墙。
      // 桥面中心线与下层道路中心线在交叉处并不重合，所以必须按**地面层**迭代外推。
      const need = hw + BRIDGE_PILLAR_OUT_M;   // 规格 §五：地面层外推 4.0m
      const yTop = p.y;                        // 柱顶 = 桥面标高
      // ★ 每个站位收两根柱子（含盖梁）：以前的"避不开就 continue"会让某些站位只剩单侧
      //   甚至完全没有支柱 —— 用户看到的就是"桥下的支柱不全"。这里改成：
      //   先按 4m 外推找合法点；找不到就继续外推（上限 26m）；仍不合法则取**最外**的那个
      //   候选位（柱脚落在远处草地，由盖梁连回桥面），保证每个站位都有支撑。
      const station = { x: p.x, z: p.z, y: yTop, side: s, lat: [] };
      for (const d of [1, -1]) {
        let lat = d * need;
        let ok = false;
        for (let guard = 0; guard < 100; guard++) {
          const gx = p.x + s.x * lat, gz = p.z + s.z * lat;
          // ⚠️ 必须**同时**满足两条：不压任何一段路（含桥下那层）、不横穿别段路。
          //    曾经为了"保证每个站位都有柱子"而退回最外候选 —— 那会把柱子放到下层
          //    路面上（selftest 的"没有桥墩立在赛道路面上"立刻报红）。
          if (this._groundLatAbs(gx, gz, y0) >= need && !this._pillarBlocked(gx, gz, y0, yTop)) {
            pillars.push({ x: gx, y: y0 + h / 2, z: gz, h });
            station.lat.push({ x: gx, z: gz });
            ok = true;
            break;
          }
          lat += d * 0.5;
          if (Math.abs(lat) > 26) break;     // 上限：再远就不像桥墩了
        }
        void ok;   // 实在没有合法落点就跳过这一侧（盖梁与邻站柱子仍支撑桥面）
      }
      stations.push(station);
    }
    if (pillars.length) {
      const pI = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.55, 0.7, 1, 8), mat, pillars.length
      );
      for (let k = 0; k < pillars.length; k++) {
        const q = pillars[k];
        dummy.position.set(q.x, q.y, q.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, q.h, 1);
        dummy.updateMatrix();
        pI.setMatrixAt(k, dummy.matrix);
        this.colliders.push({
          x: q.x, y: q.y, z: q.z, qx: 0, qy: 0, qz: 0, qw: 1,
          hx: 0.55, hy: q.h / 2, hz: 0.55,
        });
      }
      pI.instanceMatrix.needsUpdate = true;
      group.add(pI);
    }

    // ---- ★ 盖梁（pier cap）：每个站位一根横向箱梁，把两侧柱顶与桥面连成一体 -------
    // 真实高架桥不会是"孤零零一根根柱子"，而是柱—盖梁—桥面连续传力。
    // 用户报障"桥下的支柱不全"里，一部分观感就来自"柱子没接到桥面"。
    if (stations.length) {
      const capGeo = new THREE.BoxGeometry(1, 0.7, 1);
      const capI = new THREE.InstancedMesh(capGeo, mat, stations.length);
      let cn = 0;
      for (const st of stations) {
        if (!st.lat.length) continue;
        const a = st.lat[0], b = st.lat[st.lat.length - 1];
        const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.max(2.0, Math.hypot(dx, dz));
        const yaw2 = Math.atan2(dx, dz);
        dummy.position.set(cx, st.y - 0.35, cz);     // 梁顶贴桥面底
        dummy.rotation.set(0, yaw2, 0);
        dummy.scale.set(0.9, 1, len);
        dummy.updateMatrix();
        if (cn < capI.count) capI.setMatrixAt(cn++, dummy.matrix);
      }
      capI.count = cn;
      capI.instanceMatrix.needsUpdate = true;
      group.add(capI);
    }

    // ---- 引桥坡道下的挡土墙（视觉）----
    for (const i of [b.i0, b.i1]) {
      for (const d of [1, -1]) {
        const p = this.pts[i], s = this.side[i];
        const lat = d * (hw + cw + 0.9);
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(0.8, 2.4, len),
          mat
        );
        wall.position.set(p.x + s.x * lat, this.baseY[i] + 1.2, p.z + s.z * lat);
        wall.rotation.y = Math.atan2(this.tan[i].x, this.tan[i].z);
        group.add(wall);
      }
    }
  }


  /* ---------------- 看台（grandstand）---------------- */
  /**
   * 观众看台建筑群（斯帕的主看台 / 铃鹿的观众席）。
   * 只放在**直道**上（用 raceLine.radius 判曲率），横向偏移严格用净空锚点 +
   * 自身进深的一半，保证看台前沿不侵入 13.5m 排他线。
   * 结构 = 阶梯式座席（逐级抬高的长条盒）+ 顶棚，纯静态视觉，不参与物理。
   */
  _buildGrandstands(group) {
    const N = this.count, hw = this.halfWidth, cw = this.curbWidth;
    const th = this.theme;
    const want = th.grandstandCount || 0;
    if (!want) return;

    const seatMat = new THREE.MeshStandardMaterial({ color: 0x2c4f86, roughness: 0.88, metalness: 0.05 });
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x7f8790, roughness: 0.84, metalness: 0.08 });

    // 找直道：曲率半径越大越直。按 index 均匀采样后排序取最直的若干处。
    const cand = [];
    const probe = Math.max(1, Math.round(N / 72));
    for (let i = 0; i < N; i += probe) cand.push({ i, r: this.raceLine.radius[i] });
    cand.sort((a, b) => b.r - a.r);

    // 低矮、远离赛道中心线的观众席：只作为远处背景，不再形成高位顶棚遮挡。
    const len = 72, rows = 5, rowH = 0.42, rowD = 1.55;
    const depth = rows * rowD;
    // 前沿落在净空锚点之外：中心 = 锚点 + 半个进深
    // 横向再外推 55m：驾驶视角中看台从“遮挡物”退化为远处背景。
    const lat = CLEAR_ANCHOR_M + depth * 0.5 + 55.0;

    let placed = 0;
    const used = [];
    this.grandstands = [];
    for (const c of cand) {
      if (placed >= want) break;
      // 与已放置的看台保持弧长间隔，避免连成一片
      if (used.some((u) => Math.min(Math.abs(u - c.i), N - Math.abs(u - c.i)) < N * 0.12)) continue;
      // 桥面段不放看台：看台定位用的是 baseY（地面层），放在桥面上会沉到桥下。
      if (this.hasBridge && Math.abs(this.pts[c.i].y - this.baseY[c.i]) > 1.0) continue;

      const d = placed % 2 === 0 ? 1 : -1;          // 左右交替
      const p = this.pts[c.i], sd = this.side[c.i], tn = this.tan[c.i];
      const yaw = Math.atan2(tn.x, tn.z);
      const base = vec(p.x + sd.x * d * lat, this.baseY[c.i], p.z + sd.z * d * lat);
      if (this._minTrackDistance2D(base.x, base.z) <= sceneryClearMin(hw)) continue;
      const bridgeBox = this._bridgeExclusionBox();
      if (bridgeBox && this._inBridgeExclusion(bridgeBox, base.x, base.z)) continue;

      // ---- 占位排他校验（铃鹿"看台长在赛道上"的根因就在这里）----------------
      // 只按"这一段直不直"选点是不够的：8 字赛道里**另一条腿**可能就从旁边几米处
      // 穿过（尤其是立交桥交叉点附近），看台会长到那条路的沥青上。
      // 这里把每个采样点变换到看台的局部坐标系（沿赛道 / 横向），做 OBB 相交判定。
      let occupied = false;
      for (let j = 0; j < N; j++) {
        const gap = Math.min(Math.abs(j - c.i), N - Math.abs(j - c.i));
        if (gap < N * 0.06) continue;                       // 同一段路，正常，跳过
        const qx = this.pts[j].x - base.x, qz = this.pts[j].z - base.z;
        const along = qx * tn.x + qz * tn.z;
        const off = qx * sd.x * d + qz * sd.z * d;
        if (Math.abs(along) < len * 0.5 + hw + 2 && Math.abs(off - lat) < depth * 0.5 + hw + 2) {
          occupied = true;
          break;
        }
      }
      if (occupied) continue;

      const g = new THREE.Group();
      for (let r = 0; r < rows; r++) {
        // 每级台阶向后、向上错开 -> 阶梯式看台
        const step = new THREE.Mesh(new THREE.BoxGeometry(len, rowH, rowD * 0.96), r === 0 ? shellMat : seatMat);
        step.position.set(0, rowH * (r + 0.5), d * (r * rowD * 0.5));
        step.castShadow = true;
        step.receiveShadow = true;
        g.add(step);
      }
      const shell = new THREE.Mesh(new THREE.BoxGeometry(len, 1.1, depth + 1.2), shellMat);
      shell.position.set(0, -0.55 + rows * rowH * 0.1, d * (depth * 0.22));
      shell.castShadow = true; shell.receiveShadow = true;
      g.add(shell);
      g.position.copy(base);
      g.rotation.y = yaw + Math.PI;
      group.add(g);
      // 暴露落位供测试审计（"看台有没有长到赛道上"必须能被断言，不能只看组数）
      this.grandstands.push({ i: c.i, x: base.x, z: base.z, d, lat, len, depth, height: rows * rowH });
      used.push(c.i);
      placed++;
    }
  }
  /* ---------------- 护栏：混凝土 + TechPro 吸能体 ---------------- */
  /**
   * ★ 合并相邻同侧护栏段（2026-09-30 性能优化）。
   *
   * 背景：护栏原来**逐采样区间 × 两侧**各生成一个盒 = 2880 个静态刚体，而性能剖析里
   *   `collisionPairs` 占 12.1%、`needBroadphaseCollision` 3.7%、`addBoxToBins` 2.4%
   *   —— 全是宽相在遍历这堆静态体。相邻段沿赛道共线，本来就可以并成一根长盒。
   *
   * 合并条件（三条同时满足，保证"覆盖不变"）：
   *   ① 逐段转角 < `maxTurnDeg`（直道与缓弯才能连成一根）；
   *   ② 中间各段中心到"合并弦"的垂距 < `maxDev`（弯道处偏差很快超限 ⇒ 自动保持细分，
   *      斯帕 31m 发卡不会因为合并而切进内线）；
   *   ③ 单次合并段数 ≤ `maxRun`（封顶，避免一根盒横跨半条赛道）。
   * 合并弦的两个端点就是首末段的实际端点 ⇒ **护栏覆盖不缩水**，空隙断言依旧成立。
   */
  _mergeBarrierItems(items, maxRun = 10, maxTurnDeg = 3.0, maxDev = 0.12) {
    const dirOf = (o) => [Math.sin(o.yaw), Math.cos(o.yaw)];
    const ends = (o) => {
      const [dx, dz] = dirOf(o);
      const h = o.len * 0.5;
      return [o.x - dx * h, o.z - dz * h, o.x + dx * h, o.z + dz * h];
    };
    const turn = (a, b) => {
      let d = Math.abs(b - a) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return d * 180 / Math.PI;
    };
    const out = [];
    for (const key of [1, -1]) {
      const arr = items.filter((o) => (o.d > 0 ? 1 : -1) === key);
      let i = 0;
      while (i < arr.length) {
        let k = i;
        // 试探性延长到 k+1
        while (k + 1 < arr.length && (k + 1 - i) < maxRun) {
          const a = arr[i], b = arr[k + 1];
          if (turn(arr[k].yaw, b.yaw) > maxTurnDeg) break;
          // 以 arr[i] 起点 → arr[k+1] 终点 作弦，检查中间段中心偏差
          const s0 = ends(arr[i]), e1 = ends(b);
          const cx = e1[2] - s0[0], cz = e1[3] - s0[1];
          const cl = Math.hypot(cx, cz) || 1e-6;
          let dev = 0;
          for (let m = i; m <= k + 1; m++) {
            const px = arr[m].x - s0[0], pz = arr[m].z - s0[1];
            const perp = Math.abs(px * (cz / cl) - pz * (cx / cl));
            if (perp > dev) dev = perp;
          }
          if (dev > maxDev) break;
          k++;
        }
        if (k === i) { out.push(arr[i]); i++; continue; }
        const s0 = ends(arr[i]), e1 = ends(arr[k]);
        const cx = e1[2] - s0[0], cz = e1[3] - s0[1];
        const cl = Math.hypot(cx, cz) || 1e-6;
        const yaw = Math.atan2(cx, cz);
        let sx = 0, sz = 0, sy = 0, anyCorner = false;
        for (let m = i; m <= k; m++) { sx += arr[m].sx; sz += arr[m].sz; sy += arr[m].sy; if (arr[m].isCorner) anyCorner = true; }
        const n = k - i + 1;
        const sl = Math.hypot(sx, sz) || 1;
        const y0 = arr[i].y0, y1 = arr[k].y1;
        out.push({
          x: (s0[0] + e1[2]) * 0.5, y: (y0 + y1) * 0.5, z: (s0[1] + e1[3]) * 0.5,
          yaw, y0, y1, isCorner: anyCorner, d: key,
          sx: sx / sl, sz: sz / sl, sy: sy / n,
          len: cl * 1.02,
        });
        i = k + 1;
      }
    }
    return out;
  }

  _buildBarriers(group) {
    const N = this.count, hw = this.halfWidth, cw = this.curbWidth;
    // 三张赛道都生成连续的实体护栏；Vegas 使用可视墙厚，避免相邻
    // OSM 路段近贴时，额外加厚的碰撞体压入另一条沥青路面。
    const hullHx = this.trackType === 'vegas' ? BARRIER_VIS_HX : BARRIER_HULL_HX;
    const hullOffset = Math.max(0, hullHx - BARRIER_VIS_HX);
    if (!this.barriers) return;
    // 护栏横向位置（规格 §二.3）。三种来源，优先级从高到低：
    //   ① barrierLatArr —— 逐点数组（真实铃鹿：半宽随路段变化，护栏必须跟着走）；
    //   ② barrierLat    —— 全程常量；
    //   ③ 默认          —— 贴路肩外沿（街道赛道）。
    // 真车永久赛道的护栏都在**缓冲区外沿**（不是贴着路肩砌墙）：这样
    // "冲出赛道 -> 缓冲带滚阻滑停 -> 掉头回来"与"全封闭防抄近道"同时成立。
    const latArr = this.barrierLatArr;
    const lat = this.barrierLat || (hw + cw + 0.75);
    const latAt = latArr ? ((i) => latArr[i]) : (() => lat);
    const barrierSlot = (i, d) => i * 2 + (d > 0 ? 1 : 0);
    this.barrierSideAt = new Uint8Array(N * 2);
    this.barrierSideAt.fill(1);
    const sideCrossesOtherRoad = (i, d, li, lj) => {
      if (this.trackType !== 'vegas') return false;
      const a = this.pts[i], b = this.pts[(i + 1) % N];
      const s0 = this.side[i], s1 = this.side[(i + 1) % N];
      const samples = [
        [a.x + s0.x * d * li, a.z + s0.z * d * li],
        [(a.x + b.x) * 0.5 + (s0.x + s1.x) * d * (li + lj) * 0.25,
          (a.z + b.z) * 0.5 + (s0.z + s1.z) * d * (li + lj) * 0.25],
        [b.x + s1.x * d * lj, b.z + s1.z * d * lj],
      ];
      for (const [x, z] of samples) {
        for (let k = 0; k < N; k++) {
          const ring = Math.abs(k - i), near = Math.min(ring, N - ring);
          if (near <= 3) continue;
          const clear = this.halfWidthAt[k] + BARRIER_VIS_HX + 0.08;
          if (Math.hypot(x - this.pts[k].x, z - this.pts[k].z) < clear) return true;
        }
      }
      return false;
    };

    const concrete = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85, metalness: 0.05 });
    const techpro = new THREE.MeshStandardMaterial({ color: 0x1f6fd0, roughness: 0.6, metalness: 0.15 });
    const meshes = [];

    const items = [];
    // 护栏必须逐采样区间贴线生成。历史实现每 2 个采样点放一根固定朝向的
    // 长盒，且可视长度误算成 2 倍标称长度；在斯帕 31m 发卡里，直盒会从弯心
    // 一侧切进内线。现在每段由两个真实采样点求弦向与长度，短段随样条弯折，
    // 既不侵入沥青，也不会在弯中留下长矩形断面。
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const curv = Math.min(this.raceLine.radius[i], this.raceLine.radius[j]);
      const isCorner = curv < 260;               // 曲率半径小 = 弯道 -> 用吸能体
      const p0 = this.pts[i], p1 = this.pts[j];
      const s0 = this.side[i], s1 = this.side[j];
      const mx = (p0.x + p1.x) * 0.5, mz = (p0.z + p1.z) * 0.5;
      const my = (p0.y + p1.y) * 0.5;
      for (const d of [1, -1]) {
        const li = latAt(i), lj = latAt(j);
        if (sideCrossesOtherRoad(i, d, li, lj)) {
          this.barrierSideAt[barrierSlot(i, d)] = 0;
          continue;
        }
        const turnDot = s0.x * s1.x + s0.z * s1.z;
        const parts = turnDot < 0.90 ? 16 : (turnDot < 0.98 ? 8 : 1);
        for (let part = 0; part < parts; part++) {
          const u0 = part / parts, u1 = (part + 1) / parts;
          const lerpSide = (u) => {
            const sx = s0.x * (1 - u) + s1.x * u;
            const sz = s0.z * (1 - u) + s1.z * u;
            const sl = Math.hypot(sx, sz) || 1;
            return { x: sx / sl, z: sz / sl };
          };
          const sa = lerpSide(u0), sb = lerpSide(u1);
          const la = li * (1 - u0) + lj * u0, lb = li * (1 - u1) + lj * u1;
          const xa = p0.x * (1 - u0) + p1.x * u0 + sa.x * d * la;
          const za = p0.z * (1 - u0) + p1.z * u0 + sa.z * d * la;
          const xb = p0.x * (1 - u1) + p1.x * u1 + sb.x * d * lb;
          const zb = p0.z * (1 - u1) + p1.z * u1 + sb.z * d * lb;
          const dx = xb - xa, dz = zb - za;
          const segLen = Math.hypot(dx, dz);
          if (segLen < 0.05) continue;
          const yaw = Math.atan2(dx, dz);
          const ya = p0.y * (1 - u0) + p1.y * u0 + 0.75;
          const yb = p0.y * (1 - u1) + p1.y * u1 + 0.75;
          const mx = (xa + xb) * 0.5, mz = (za + zb) * 0.5;
          const ox = (sa.x + sb.x) * 0.5, oz = (sa.z + sb.z) * 0.5;
          const ol = Math.hypot(ox, oz) || 1;
          items.push({
            x: mx, y: (ya + yb) * 0.5, y0: ya, y1: yb, z: mz,
            yaw, isCorner, d, sx: ox / ol, sz: oz / ol,
            sy: (p0.y * (1 - (u0 + u1) * 0.5) + p1.y * ((u0 + u1) * 0.5)),
            len: segLen * 1.02,
          });
        }
      }
    }
    // ★ 补洞（2026-09-30）：退化采样段（segLen < 0.05 被跳过）、或任何成因造成的
    //   相邻段端点间隙，都在这里补一个填充盒。护栏是"防钻出去"的最后一道保险，
    //   4m 的洞就足以让车挤出去 —— 覆盖率审计（barrier-coverage.mjs）会逐米复核。
    const gapItems = [];
    for (const key of [1, -1]) {
      const arr = [];
      for (let k = 0; k < items.length; k++) if ((items[k].d > 0 ? 1 : -1) === key) arr.push(items[k]);
      for (let k = 0; k < arr.length; k++) {
        const a = arr[k], b = arr[(k + 1) % arr.length];
        const ax2 = Math.sin(a.yaw), az2 = Math.cos(a.yaw);
        const bx2 = Math.sin(b.yaw), bz2 = Math.cos(b.yaw);
        const aex = a.x + ax2 * a.len * 0.5, aez = a.z + az2 * a.len * 0.5;
        const bnx = b.x - bx2 * b.len * 0.5, bnz = b.z - bz2 * b.len * 0.5;
        const gx = bnx - aex, gz = bnz - aez;
        const gap = Math.hypot(gx, gz);
        if (gap > 0.3 && this.trackType !== 'vegas') {
          gapItems.push({
            x: (aex + bnx) * 0.5,
            y: a.y,
            y0: a.y1, y1: b.y0,
            z: (aez + bnz) * 0.5,
            yaw: Math.atan2(gx, gz), isCorner: a.isCorner, d: key,
            sx: a.sx, sz: a.sz, sy: a.sy, len: gap * 1.05,
          });
        }
      }
    }

    // ★ 合并相邻同侧共线段（2026-09-30 性能优化，已复验后启用）。
    //   收益：vegas 2880→684、spa→544、suzuka→906 个静态刚体（宽相开销同步下降）。
    //   ⚠️ 之前"审计报 60m 未覆盖"的矛盾已定位：是**审计自己的盒子筛选用 `hz < 1.2`
    //      排桥墩，顺手把合法的短护栏盒也排掉了**（改成按 hx 区分即消失）。几何本身没问题。
    const rawCount = items.length;
    const merged = this._mergeBarrierItems(items, this.trackType === 'vegas' ? 1 : undefined).concat(gapItems);
    // 合并后的端点按真实护栏落位复核；只在合并弦没有覆盖某个采样端点时
    // 补一根短盒。补盒中心直接取两端真实坐标，避免弯道用平均法向产生空洞。
    const coveredXZ = (p, o) => {
      const cx = o.x + o.sx * o.d * hullOffset;
      const cy = o.sy - BARRIER_BURY + BARRIER_HULL_HY;
      const cz = o.z + o.sz * o.d * hullOffset;
      const ax = o.sx * o.d, az = o.sz * o.d;
      const al = Math.hypot(ax, az) || 1;
      const X = { x: ax / al, y: 0, z: az / al };
      const zl = Math.hypot(Math.sin(o.yaw) * o.len, o.y1 - o.y0, Math.cos(o.yaw) * o.len) || 1;
      const Z = { x: Math.sin(o.yaw) * o.len / zl, y: (o.y1 - o.y0) / zl, z: Math.cos(o.yaw) * o.len / zl };
      const Y = { x: Z.z * X.y - Z.y * X.z, y: Z.x * X.z - Z.z * X.x, z: Z.y * X.x - Z.x * X.y };
      const yl = Math.hypot(Y.x, Y.y, Y.z) || 1;
      Y.x /= yl; Y.y /= yl; Y.z /= yl;
      const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
      const lx = dx * X.x + dy * X.y + dz * X.z;
      const ly = dx * Y.x + dy * Y.y + dz * Y.z;
      const lz = dx * Z.x + dy * Z.y + dz * Z.z;
      return Math.abs(lx) <= hullHx + 0.06 && Math.abs(ly) <= BARRIER_HULL_HY + 0.06 && Math.abs(lz) <= o.len * 0.5 + 0.06;
    };
    const finalItems = merged.slice();
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N, p0 = this.pts[i], p1 = this.pts[j];
      const qdx = p1.x - p0.x, qdz = p1.z - p0.z, qlen = Math.hypot(qdx, qdz);
      if (qlen < 0.05) continue;
      for (const d of [1, -1]) {
        if (!this.barrierSideAt[barrierSlot(i, d)]) continue;
        const li = latAt(i), lj = latAt(j);
        const q0 = { x: p0.x + this.side[i].x * d * li, y: p0.y + 0.4, z: p0.z + this.side[i].z * d * li };
        const q1 = { x: p1.x + this.side[j].x * d * lj, y: p1.y + 0.4, z: p1.z + this.side[j].z * d * lj };
        const has0 = finalItems.some((o) => (o.d > 0 ? 1 : -1) === d && coveredXZ(q0, o));
        const has1 = finalItems.some((o) => (o.d > 0 ? 1 : -1) === d && coveredXZ(q1, o));
        const holes = [];
        for (const u of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
          const q = {
            x: q0.x + (q1.x - q0.x) * u,
            y: q0.y + (q1.y - q0.y) * u,
            z: q0.z + (q1.z - q0.z) * u,
          };
          if (!finalItems.some((o) => (o.d > 0 ? 1 : -1) === d && coveredXZ(q, o))) holes.push(q);
        }
        if (has0 && has1 && holes.length === 0) continue;
        const dx = q1.x - q0.x, dz = q1.z - q0.z, len = Math.hypot(dx, dz);
        let nx = (this.side[i].x + this.side[j].x) * 0.5;
        let nz = (this.side[i].z + this.side[j].z) * 0.5;
        const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
        const y0 = p0.y + 0.75, y1 = p1.y + 0.75;
        const addCoverage = (q, boxLen) => finalItems.push({
          x: q.x, y: (y0 + y1) * 0.5, y0, y1, z: q.z,
          yaw: Math.atan2(dx, dz), isCorner: true, d, sx: nx, sz: nz,
          sy: (p0.y + p1.y) * 0.5, len: boxLen,
        });
        if (!has0) addCoverage(q0, Math.max(1.4, Math.min(2.4, len * 0.35)));
        if (!has1) addCoverage(q1, Math.max(1.4, Math.min(2.4, len * 0.35)));
        for (const q of holes) addCoverage(q, Math.max(1.4, Math.min(2.4, len * 0.35)));

      }
    }
    const completed = finalItems;
    this.barrierRawCount = rawCount;
    this.barrierMergedCount = completed.length;
    if (completed !== items) {
      items.length = 0;
      for (const o of completed) items.push(o);
    }

    // 回头弯两条道路的投影距离很近时，长合并盒可能擦进相邻沥青。
    // 在落地碰撞体前按最终路面采样收短这类盒子，保留本侧护栏覆盖，
    // 避免用一面“跨路的隐形墙”解决护栏缺口。
    const nCorner = items.filter((o) => o.isCorner).length;
    const iConc = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), concrete, items.length - nCorner || 1);
    const iTech = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), techpro, nCorner || 1);
    const dummy = new THREE.Object3D();
    const barrierMatrix = new THREE.Matrix4();
    const barrierQuat = new THREE.Quaternion();
    const axisX = new THREE.Vector3(), axisY = new THREE.Vector3(), axisZ = new THREE.Vector3();
    let a = 0, bb = 0;
    for (const o of items) {
      dummy.position.set(o.x, o.y, o.z);
      // 用三维切线建立完整姿态：local-Z 沿护栏，local-X 向外，local-Y 为坡面法线。
      // 这样可视盒与静态碰撞盒共享同一个坡度，不会出现“碰撞墙斜了、画面墙水平”的错位。
      axisZ.set(Math.sin(o.yaw) * o.len, o.y1 - o.y0, Math.cos(o.yaw) * o.len).normalize();
      axisX.set(o.sx * o.d, 0, o.sz * o.d).normalize();
      axisY.crossVectors(axisZ, axisX).normalize();
      axisX.crossVectors(axisY, axisZ).normalize();
      barrierMatrix.makeBasis(axisX, axisY, axisZ);
      barrierQuat.setFromRotationMatrix(barrierMatrix);
      dummy.quaternion.copy(barrierQuat);
      // 可视护栏高 1.5m（半高 0.75）。不再用 1.4m：碰撞体顶面在 路面+1.5m，
      // 可视只能用 1.4m 的话上方会留 0.25m 的隐形墙（撞上去像撞空气）。
      const hy = 0.75;
      dummy.scale.set(o.isCorner ? 0.9 : 0.7, hy * 2, o.len);
      dummy.updateMatrix();
      if (o.isCorner && bb < iTech.count) iTech.setMatrixAt(bb++, dummy.matrix);
      else if (a < iConc.count) iConc.setMatrixAt(a++, dummy.matrix);
      // 碰撞体加厚（规格 §二.1）：厚 2.0m × 高 2.5m × 下方深埋 1.0m。
      // ① 厚度向外挤：内侧面必须与可视护栏内侧面**同一平面**，否则加厚会直接吃掉
      //    可行驶宽度（可视半厚 0.35，所以碰撞体中心外移 1.0-0.35 = 0.65m）。
      // ② 高度以**路面**为基准往下埋 1.0m：中心 = 路面 - 1.0 + 1.25 = 路面 + 0.25。
      // 防隧道的算术在这里闭环：300km/h = 83.3m/s，单个 1/60 物理步位移 1.39m < 2.0m 厚，
      // 离散碰撞不可能整段跳过护栏 —— 这才是加厚的真正目的，不是单纯"更硬"。
      this.colliders.push({
        x: o.x + o.sx * o.d * (hullOffset),
        y: o.sy - BARRIER_BURY + BARRIER_HULL_HY,
        z: o.z + o.sz * o.d * (hullOffset),
        qx: barrierQuat.x, qy: barrierQuat.y, qz: barrierQuat.z, qw: barrierQuat.w,
        hx: hullHx, hy: BARRIER_HULL_HY, hz: o.len * 0.5,
        barrierMain: true,
        barrierExpectedYaw: o.yaw,
        barrierExpectedAxisY: (o.y1 - o.y0) / Math.hypot(Math.sin(o.yaw) * o.len, o.y1 - o.y0, Math.cos(o.yaw) * o.len),
      });
    }
    iConc.count = a; iTech.count = bb;
    iConc.instanceMatrix.needsUpdate = true;
    iTech.instanceMatrix.needsUpdate = true;
    if (a > 0) meshes.push(iConc);
    if (bb > 0) meshes.push(iTech);
    if (meshes.length) group.add(...meshes);
  }
}

/* ---------------------------------------------------------------------------
 * 统一赛道生成接口 + 静态碰撞体落地
 * ------------------------------------------------------------------------- */

/**
 * 统一入口：生成并装配一条赛道。
 * @param {THREE.Scene|null} scene   赛道可视化目标（可为 null，只取数据）
 * @param {CANNON.World|null} world  物理世界（可为 null，跳过静态碰撞体）
 * @param {string} trackType         'suzuka' | 'vegas'
 * @param {number} seed              服务端下发，四机一致
 * @param {object} opts              { material?: CANNON.Material }
 * @returns {Track}
 */
export function generateTrack(scene, world, trackType = 'suzuka', seed = 20260922, opts = {}) {
  const track = new Track(seed, trackType);
  const built = track.build();
  track.built = built;
  if (scene && built && built.group) scene.add(built.group);
  if (world) registerTrackBodies(world, track, opts.material);
  return track;
}

/**
 * 把 track.colliders 的静态 Box 描述落地成 cannon-es 静态刚体（mass=0）。
 * 桥面护栏 / 桥墩 / 混凝土护栏 / TechPro 吸能体都走这里。
 * @returns {CANNON.Body[]}
 */
/**
 * 把 track.colliders 落地成 cannon-es 的静态 Box。
 *
 * 【曾经静默失效过整整数轮，务必看这段】
 * 这里原来有一行 `if (typeof CANNON === 'undefined') return [];` —— 本模块当时**没有
 * import CANNON**，而 `libs/cannon-es.js` 是 ESM（不会产生全局变量），于是这个守卫
 * **恒为真**，函数永远返回空数组：三大赛道的护栏/桥栏/桥墩全部只是视觉装饰，
 * 车直接从护栏穿出去。调用方（physics.js）明明调了、也拿到了返回值，但拿到的是 []。
 * 现在改成显式 `import * as CANNON`，并删掉那个会骗人的守卫。
 */
export function registerTrackBodies(world, track, material) {
  if (!world || !track) return [];
  const out = [];
  for (const c of (track.colliders || [])) {
    const body = new CANNON.Body({ mass: 0, material: material || undefined });
    body.addShape(new CANNON.Box(new CANNON.Vec3(c.hx, c.hy, c.hz)));
    body.position.set(c.x, c.y, c.z);
    body.quaternion.set(c.qx, c.qy, c.qz, c.qw);
    body.collisionResponse = true;
    body.__barrier = true;          // 物理层用于识别护栏/桥栏/桥墩静态刚体
    world.addBody(body);
    out.push(body);
  }
  // Road patches are real static Heightfield bodies, separate from barrier boxes.
  // Keep them in the returned set so callers install the same collision group and
  // broadphase coverage for both road layers.
  for (const patch of (track.roadHeightfields || [])) {
    const body = patch.body;
    if (material && !body.material) body.material = material;
    body.__roadHeightfield = true;
    body.__barrier = false;        // ground contact must never enter barrier response
    world.addBody(body);
    out.push(body);
  }
  return out;
}

/** 把两个同构 BufferGeometry 简单合并（索引各自偏移），避免引入 examples 的 BufferGeometryUtils */
function mergeSimple(g1, g2) {
  const pos = concatAttr(g1, g2, 'position');
  const nor = concatAttr(g1, g2, 'normal');
  const col = concatAttr(g1, g2, 'color');
  const n1 = g1.getAttribute('position').count;
  const idx = [];
  const i1 = g1.getIndex().array, i2 = g2.getIndex().array;
  for (let i = 0; i < i1.length; i++) idx.push(i1[i]);
  for (let i = 0; i < i2.length; i++) idx.push(i2[i] + n1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', pos);
  g.setAttribute('normal', nor);
  if (col) g.setAttribute('color', col);
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function concatAttr(g1, g2, name) {
  const a = g1.getAttribute(name), b = g2.getAttribute(name);
  if (!a || !b) return null;
  const out = new Float32Array(a.array.length + b.array.length);
  out.set(a.array, 0);
  out.set(b.array, a.array.length);
  return new THREE.BufferAttribute(out, a.itemSize);
}

