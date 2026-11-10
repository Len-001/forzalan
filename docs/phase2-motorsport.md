# Motorsport modes and strategy

The room protocol keeps the existing IDs: Casual / 休闲 is `horizon`, Competitive / 竞技 is `fm8`, and Bumper is `bumper`. Hosts own room mode selection; the server broadcasts it. Competitive grids sort by Skill Rating, then score; older unspecified-mode callers retain their reverse-grid behavior. The existing five-light countdown and Bumper compatibility remain.

Casual offers a cyan/yellow/red, road-hugging racing ribbon and configurable auto-brake, ABS, TCS, stability and steering assists. Competitive locks ABS and TCS on, with automatic braking, steering and stability assists off. The Worker also enforces that preset. The tuning garage applies pressure (PSI), final-drive ratio, front/rear aero, suspension stiffness and differential lock when a race is created; editing the saved setup affects the next race.

Hold **Backspace** or the rewind button in solo Casual to rewind up to ten seconds. The Worker keeps 201 samples at 20 Hz in a fixed typed buffer, including chassis position/orientation, linear/angular velocity, suspension/wheel state, tire temperatures/wear/compound, fuel and lap timing/progress. Releasing truncates the old future and restores clean reentry. Online and Competitive Workers reject rewind. Rewound laps cannot become clean personal bests, and previously awarded mastery events cannot be farmed by replaying them.

Soft, Medium, Hard and Wet compounds have different grip, heating and wear rates. The cyan lane near the start, marked **P** on the minimap, is the active pit zone. Select the next compound and press **P** or the pit button, enter the marked lane, and stop below 5 km/h for three seconds to change tires and refuel. Leaving the zone or moving interrupts service. Fuel and per-wheel thermal/wear data come from physics, including during spectating.

The upper delta bar compares passage times at the same spline position with the driver's own clean personal best: negative/green is faster, positive/red is slower. Best laps and per-car mastery XP persist locally. Clean sectors, corner apexes and overtakes award bounded XP; Car Mastery caps at level 50. Telemetry updates at 10 Hz and timing-tower DOM writes remain throttled to 4 Hz. Results use a bottom drawer whose outer surface passes camera/telemetry input through.

Competitive settlement computes pairwise human-only Skill Rating changes and a numeric safety score mapped to S/A/B/C/D/E. These persist atomically in `scores.json`. For compatibility with old name-to-integer readers, ratings use reserved numeric keys beginning with the escaped control prefix `\u001frating:`; they are excluded from player leaderboards. Bot names and bot seats never earn human ratings or count toward online human counters. Cut penalties require four wheels outside and positive net route-time advantage; victims receive collision reentry protection. Penalty notifications retain bounded queues and timed dismissal.

## Validation

Run the six requested checks from the repository root:

```sh
go test ./...
node tools/selftest.mjs
node tools/penalty-controller-check.mjs
node tools/hud-gap-probe.mjs
node tools/bumper-mode-check.mjs
node tools/bug-regression-check.mjs
```

`node tools/strategy-check.mjs` additionally checks history limits, timeline/wheel restoration, mode locks, real pit service, personal-best timing and mastery deduplication. `node tools/phase2-browser-check.mjs` exercises the real garage, telemetry, rewind, room start and results drawer. Browser probes support Linux Chromium and Windows Edge. GPU presentation budgets require hardware WebGL; software-renderer runs identify that limitation explicitly and validate actual Worker timing instead. Phase 1 reconciliation, Hermite/dead-reckoning, collision, handling and spatial-query regressions remain covered by `tools/handling-check.mjs` and `tools/remote-snapshot-check.mjs`.
