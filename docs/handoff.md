# Inarticulate III — PNDS Project Handoff

本文档面向在其他开发环境中继续工作的 AI Agent 或开发者。它描述的是**当前磁盘中的实际状态**，而不是历史计划。

## 1. 项目定位与当前阶段

`Inarticulate III` 是一个 PNDS（Platform for Network Digital Score）示例 score project：三个演奏者在浏览器中触摸交互，网页通过 Socket.IO 共享视觉状态，Node.js 将音乐控制映射为 Internal scsynth OSC 或作品自身的 External OSC 协议。

当前阶段结论：

- score project 的核心网页、Socket.IO、音频 controller、Internal Synth、health 和关闭接口已经完成；
- Internal 模式已由用户手动完成端到端验证：裸 `scsynth`、Node score server 与浏览器交互均可正常发声；
- `manifest.json` 与音频输出已对齐 **PNDS V1 契约**，本项目是 V1 的参考实现；
- 下一阶段的主要工作是新建并开发 **PNDS Tauri App**；
- 不要在没有明确需求时重写 p5.js 的作品交互、扩展 SynthDef 音色，或重新引入构建系统。

## 2. 已验证的运行链路

```text
裸 scsynth
  └─ UDP OSC 127.0.0.1:57110
       ↑ 标准 scsynth OSC
Node server.js
  ├─ AudioController
  ├─ Express performer server
  ├─ Express monitor server
  └─ Socket.IO
       ↑
浏览器 Performer / Monitor 页面
```

Internal 启动过程：

1. Node 读取 `manifest.json`；
2. 解析音频模式与 OSC target；
3. `AudioController` 向 scsynth 发 `/status`；
4. 用 `/d_load` 加载 `supercollider/synthdefs/inarticulate-iii.scsyndef`；
5. 在裸 scsynth root group `0` 下创建项目 group `1000`；
6. 在 group `1000` 中创建 synth node `1001`，SynthDef 名为 `inarticulate-iii`，`out` 取自 `PNDS_AUDIO_OUTPUT_BUS`（缺失时为 `0`）；
7. 用 `/s_get` 验证 node `1001` 的 `master` control 确实存在；
8. 浏览器事件经 Node 转换为 `/n_set`。

这条链路已实测成功。`[audio] Internal Synth ready.` 现在意味着 synth node 已通过 `/s_get` 验证，而不只是 OSC 数据包被发送。

## 3. 关键目录与文件

```text
Inarticulate III/
├── lib/                         ← 可复用核心（从 server.js 和 audio/ 提取）
│   ├── config.js                manifest / CLI / 端口 / 环境变量解析
│   ├── network.js               LAN IPv4 枚举
│   ├── health.js                /__pnds/health (HealthTracker)
│   ├── osc-transport.js         UDP OSC 传输（osc-min + dgram）
│   ├── audio-engine.js          scsynth 会话生命周期
│   ├── players.js               演奏者身份分配与 claim token
│   └── lifecycle.js             优雅关闭（SIGINT / SIGTERM）
├── audio/
│   └── controller.js            作品音频语义层（Internal / External / None）
├── public/
│   ├── assets/
│   ├── libraries/p5.min.js
│   ├── index.html               ← 加载 __config.js + shared.js（端口动态注入）
│   ├── shared.js                ← UMD 单事实来源（事件名、playerIds、storageKeys）
│   ├── sketch.js                ← p5.js 视觉与交互
│   └── style.css
├── supercollider/
│   ├── debug/inarticulate-iii-debug.scd
│   ├── source/inarticulate-iii.scd
│   └── synthdefs/inarticulate-iii.scsyndef
├── test/
│   ├── audio.test.js
│   ├── integration.test.js
│   └── players.test.js
├── docs/
│   └── handoff.md
├── manifest.json
├── package.json
├── server.js                    ← 精简编排层（~560 行，配置/健康/生命周期已提取到 lib/）
├── README.md
└── README.zh-CN.md
```

### `manifest.json`

PNDS project 的配置源，已对齐 PNDS V1 schema：

```json
{
  "schemaVersion": 1,
  "id": "inarticulate-iii",
  "name": "Inarticulate III",
  "version": "0.1.0",
  "scoreServer": {
    "entry": "server.js",
    "workingDirectory": ".",
    "performerPort": 6868,
    "monitorPort": 6869
  },
  "audio": {
    "defaultMode": "internal",
    "supportedModes": ["internal", "external", "none"],
    "synthdefs": [
      "supercollider/synthdefs/inarticulate-iii.scsyndef"
    ],
    "scsynth": {
      "blockSize": 64,
      "audioBusChannels": 128
    },
    "standaloneTarget": "127.0.0.1:57110"
  }
}
```

几个容易踩坑的点：

- `audio.scsynth` 的 `blockSize` / `audioBusChannels` 在 Internal 模式下是**必填项**，App 用它们启动 `scsynth`；`sampleRate` 已从 schema 移除（App 全局偏好是采样率的唯一来源，默认 48000；旧工程里的残留字段会被容忍但不再生效）；
- `standaloneTarget` **仅供手动调试**。PNDS App 不得读取它，必须注入自己分配的动态端口；
- 早期版本的 `roles` 字段已删除。角色边界就是端口本身：`performerPort` 是演奏者页，`monitorPort` 是 App 显示的 conductor / monitor 页，两者都用 `/`。

### `server.js`

负责：

- 解析 manifest、`--audio-mode` 与 `PNDS_OSC_TARGET`；
- 服务 performer 与 monitor 页面；
- Socket.IO player ID、点位和连线事件；
- performer 身份恢复：浏览器持久化 player ID 与 claim token；同一 token 的新 socket 接管旧 socket，不同 token 抢同一 ID 会被拒绝；
- 向 monitor 广播作品控制流活动（`oscActivity`），供右侧 `/p*` 地址观察器显示最后一次数据；
- 创建并调用 `AudioController`；
- 提供 `/qr` 与 `GET /__pnds/health`；
- 处理 `SIGINT` / `SIGTERM` 并释放本项目资源。

### `audio/osc-controller.js`

通用 UDP/OSC 传输层。它处理 endpoint 解析、OSC message 编码、`/status.reply`、`/done`、`/synced`、`/fail` 与 synth control 查询。不要在这里写 `/p1`、Player 或作品语义。

### `audio/audio-controller.js`

当前作品的音频语义层。公开方法：

```js
audioController.start();
audioController.setPlayerGate(player, value);
audioController.setPlayerPosition(player, { x, y, amp });
audioController.setPairStroke(pair, value);
audioController.releasePlayer(player);
audioController.stop();
```

它选择并实现：

- `internal`：标准 scsynth `/d_load`、`/g_new`、`/s_new`、`/n_set`、`/n_free`；
- `external`：本作品自定义 `/p1`、`/p1xy`、`/p1-p2` 等地址；
- `none`：不创建 OSC 连接、不发送 OSC。

### SuperCollider 文件

- `supercollider/source/inarticulate-iii.scd`：SynthDef 源码与声音设计参考；
- `supercollider/debug/inarticulate-iii-debug.scd`：sclang 的本地 External OSC debug bridge；
- `supercollider/synthdefs/inarticulate-iii.scsyndef`：Internal runtime 实际加载的已编译文件。

如需重新生成 artifact，用 PNDS App → Settings → Developer Tools → Compile SynthDef（`.scd` 源码是唯一事实源；契约：SynthDef 符号名 = 产物文件名 = manifest 引用，均为 `inarticulate-iii`）。

## 4. 核心运行约定

### 音频模式与 target 优先级

音频模式：

```text
--audio-mode > manifest.audio.defaultMode
```

OSC target：

```text
PNDS_OSC_TARGET > manifest.audio.standaloneTarget（仅 Internal standalone 回退）
```

- `external` 没有 `PNDS_OSC_TARGET` 时必须启动失败；
- `none` 不需要 target；
- `standaloneTarget` 不是 External target。

### 输出总线（PNDS V1 契约）

Internal 模式下，项目 **不能**假定自己直接写硬件输出。输出总线由宿主决定：

```text
PNDS_AUDIO_OUTPUT_BUS   存在  →  synth out = 该值
                        缺失  →  synth out = 0（硬件）
                        非法  →  启动失败
```

完整的 App 侧信号路径：

```text
项目 synth  ─Out.ar(PNDS_AUDIO_OUTPUT_BUS, 2)─►  private stereo bus
                                                        │
                                        App master synth（总音量）
                                                        │
                                                  Out.ar(0, 2)  →  CoreAudio
```

手动 standalone 运行时没有 App master stage，回退到 bus `0` 直接出声。实现在 `audio/audio-controller.js` 的 `resolveOutputBus()`，回归检查在 `test/output-bus.test.js`。

App 还会注入 `PNDS_AUDIO_OUTPUT_CHANNELS=2`。V1 固定立体声，本项目目前忽略该变量；多声道属于后续版本。

### Internal Synth

| 项目 | 值 |
| --- | --- |
| SynthDef 文件 | `supercollider/synthdefs/inarticulate-iii.scsyndef` |
| SynthDef 内部名称 | `inarticulate-iii` |
| group ID | `1000` |
| synth node ID | `1001` |
| bare scsynth root group | `0` |

重要：裸 `scsynth` 不会自动存在 group `1`。group `1` 常由 `sclang` client 创建；因此项目 group 必须挂到 root group `0`。此前的 `Group 1 not found` 已由此修复。

### External OSC

以下是 **Inarticulate III 专属** 协议，不能被视为所有 PNDS project 的全局标准：

```text
/p1, /p2, /p3
/p1xy, /p2xy, /p3xy
/p1-p2, /p2-p1
/p1-p3, /p3-p1
/p2-p3, /p3-p2
```

debug bridge 使用 sclang 默认 OSC 端口 `57120`；Internal runtime 通常使用 scsynth `57110`。两种 target 与协议不能混用。

## 5. 已实现的 App 宿主接口

### Health

两个 HTTP server 均可访问：

```text
GET /__pnds/health
```

返回结构参见 `lib/health.js`（`HealthTracker.payload()`）。

状态含义：`starting` → `ready` / `error` / `stopping`。PNDS App 应轮询 performer endpoint，只在 `status === "ready"` 时显示项目页面。

### Graceful shutdown

`SIGINT` 与 `SIGTERM` 已实现（`lib/lifecycle.js`）。关闭顺序：

1. 标记 stopping（health）；
2. 清除 release retry timers；
3. 关闭 Socket.IO；
4. 调用 `projectAudio.stop()`，释放 synth / group 与 UDP socket；
5. 关闭两个 HTTP server。

注意：`lib/lifecycle.js` 的 `process.exit()` **已移除**。shutdown 完成后不再强制退出 Node 进程——这允许 PNDS App 的 Node 托管层在清理完成后自行决定进程生命周期。

## 6. 手动运行与验证

安装：

```sh
npm install
```

静态检查与回归检查：

```sh
npm run check
npm test
```

两者目前均已执行通过。

### None

```sh
node server.js --audio-mode none
```

### Internal

```sh
/Applications/SuperCollider.app/Contents/Resources/scsynth \
  -u 57110 \
  -B 127.0.0.1
```

```sh
node server.js --audio-mode internal
```

检查：

```sh
curl http://127.0.0.1:6868/__pnds/health
```

预期：`status` 与 `audio.status` 均为 `ready`。按 `Ctrl-C` 后应看到：

```text
[shutdown] complete.
```

### External debug bridge

1. 在 SuperCollider IDE 执行 `supercollider/debug/inarticulate-iii-debug.scd`；
2. 启动：

```sh
PNDS_OSC_TARGET=127.0.0.1:57120 \
node server.js --audio-mode external
```

## 7. 已知限制

1. **前端端口已通过 `__config.js` 动态注入**
   - `server.js` 在 `__config.js` 中注入 `manifest.json` 的端口；
   - `public/shared.js` 在浏览器端读取 `window.__PNDS_CONFIG__`，在 Node 端从 `manifest.json` 读取；
   - `public/sketch.js` 通过 `window.PNDS.monitorPort` 判断 monitor；
   - 端口只在 `manifest.json` 一处定义。

## 8. 下一阶段：PNDS Tauri App

App 尚未在任何仓库中初始化。V1 的完整产品与实现契约已写入平台文档，开始前先读：

```text
PNDS app 开发/docs/PNDS_APP_REQUIREMENTS.md
PNDS app 开发/docs/README.md
```

已确认的关键边界：仅 macOS Apple Silicon；App 内置 `scsynth` 与 Node.js runtime；工程必须自带 `node_modules/`，App 绝不运行 `npm install`；所有配置变更都是完整 session 重启，无热切换。

建议的启动流程：

```text
选择 PNDS project directory
  ↓
读取并校验 manifest.json
  ↓
选择 audio mode（仅限 manifest.audio.supportedModes）
  ↓
Internal：按 audio.scsynth 启动 scsynth，分配动态 UDP 端口
           并在项目 group 之后创建 master synth
External：要求用户输入 host:port
None：不启动 scsynth
  ↓
注入环境变量（None 不注入）：
  PNDS_OSC_TARGET
  PNDS_AUDIO_OUTPUT_BUS
  PNDS_AUDIO_OUTPUT_CHANNELS
  ↓
启动 node <entry> --audio-mode <mode>
  ↓
轮询 http://127.0.0.1:<performerPort>/__pnds/health
  ↓
status=ready 后显示 monitor 页面
  ↓
模式切换或退出时：先终止 Node，等待其 graceful shutdown；再按需终止 App 自己启动的 scsynth
```

第一版不要求 Node 运行时热切换 audio mode；以停止并按新配置重新启动整个 project 为策略。

## 9. 后续 Agent 工作原则

- 先读当前磁盘文件，再相信历史描述；
- 不要重新引入 `readline` 或交互式 OSC target 询问；
- 不要把 host、OSC port、HTTP port 写死到 Node server；
- 不要把 `/p1` 等 External protocol 当作 PNDS 标准；
- 不要把 `.scd` 当成 scsynth runtime 文件；
- `.scsyndef` 是 runtime artifact，应与项目一同保存；
- 修改 server/controller 后运行：

  ```sh
  npm run check
  npm test
  ```

- 不要无确认执行 `npm audit fix`、大范围依赖升级或重写 p5.js 交互；
- 对 App 开发，优先利用已有 `manifest.json`、`/__pnds/health` 与 SIGTERM shutdown 契约，不要为第一版引入项目特例。

## 10. 2026-08-18 回改记录（对齐 PNDS Template 定稿）

按定稿模板回改 lib 核心，作品自身的协议与音频语义（选 ID / takeover / 单 synth 三声部耦合）**保持不变**：

- `lib/audio-engine.js` 与模板定稿同源：`stopped` 标志（shutdown 竞态下晚到的命令为 no-op）、`transportFactory` 注入（测试用记录型假传输覆盖 boot 序列与命令编码）、`send(address, args[])` 数组签名（controller 三处调用点已改）。本工程独有并保留：`verifySynthControl()`（`/s_get` 回读验证 `/s_new` 真的建成节点——fire-and-forget 的失败否则不可见）；待模板侧采纳后两文件将完全一致。
- `lib/lifecycle.js`：shutdown `finally { process.exit() }`——即使有残留 socket/timer 挂住事件循环也保证退出（App 等的是进程退出）。
- `lib/qr.js`：QR 端点从 server.js 内联抽出为 `qrHandler`（与模板同文件）。
- `__PNDS_PORTS__` → `__PNDS_CONFIG__`（shared.js 的 `readConfig()`），对齐平台注入约定。
- `lib/config.js` 标签对齐：`External OSC` / `None`。
- server.js 协议生命周期日志：`[protocol] select / select rejected / disconnect: player N`（现场排查重连循环用，与模板同实践）。
- manifest 删除 `sampleRate`（App 全局偏好是唯一来源）。
- `audio/controller.js` 去掉 `instanceof AudioEngine` 守卫——按引擎接口约束，测试注入替身引擎。
- 测试从 4 个增至 17 个：engine 假传输套件、controller 假引擎套件、集成测试加 `assertPortsFree()` 端口占用守卫。

刻意**不**回改的部分：模板的 `lib/protocol.js` / `PlayerRegistry`（自动分配 id 的模型不适用于本作品的选 ID + takeover 模型）、born-restored 重连恢复（本作品演奏状态是触摸瞬态，pair stroke 存活在 synth 内，无按客户端持久化的音频状态）、`ID: N CH: N` 状态行（无声道改派概念）。
