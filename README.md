# Inarticulate III

一个面向三位演奏者的 PNDS（Platform for Network Digital Score）网络数字乐谱示例项目。演奏者在浏览器中以触摸交互控制各自声部的位置与连接关系；Node.js score server 通过 Socket.IO 同步视觉状态，并可将音乐控制发送到内部 SuperCollider synth 或外部 OSC 目标。

> 本仓库目前是 **PNDS score project**。PNDS Tauri App 尚未在本仓库中创建；下一阶段将由 App 读取本项目的 `manifest.json`、管理进程并托管运行时。

## 当前状态

已完成并验证：

- 三位演奏者与一个 Operator/Monitor 浏览器页面；
- manifest 驱动的 HTTP 端口、音频模式与 OSC 目标；
- `internal`、`external`、`none` 三种音频模式；
- Internal 模式使用标准 scsynth OSC，加载项目内的 `.scsyndef`；
- 裸 `scsynth` + Node server + 浏览器交互的 Internal 音频链路已手动验证可发声；
- `GET /__pnds/health` 健康接口；
- `SIGINT` / `SIGTERM` 优雅关闭 Node、Socket.IO、OSC 与项目 Synth node。

## 前置条件

- Node.js 与 npm；
- 执行 Internal 模式时，需要安装 SuperCollider，且能够运行 `scsynth`；
- Internal runtime 所需的 SynthDef 已包含在：

  ```text
  supercollider/synthdefs/inarticulate-iii.scsyndef
  ```

安装 Node 依赖：

```sh
npm install
```

## 快速启动

### 仅测试网页与网络：None 模式

不启动或发送任何 OSC：

```sh
node server.js --audio-mode none
```

### Internal Synth 模式

先启动裸 `scsynth`：

```sh
/Applications/SuperCollider.app/Contents/Resources/scsynth \
  -u 57110 \
  -B 127.0.0.1
```

再启动 score server：

```sh
node server.js --audio-mode internal
```

也可以显式指定目标：

```sh
PNDS_OSC_TARGET=127.0.0.1:57110 \
node server.js --audio-mode internal
```

成功时会出现：

```text
[audio] Internal Synth ready.
```

### External OSC / SuperCollider Debug Bridge

先在 SuperCollider IDE 中执行：

```text
supercollider/dev/inarticulate-iii-debug.scd
```

再启动 Node：

```sh
PNDS_OSC_TARGET=127.0.0.1:57120 \
node server.js --audio-mode external
```

这里的 `57120` 是 sclang debug bridge；它不是 Internal 模式所使用的 scsynth 端口 `57110`。

## 使用页面

默认端口由 `manifest.json` 提供：

| 页面 | 地址 | 作用 |
| --- | --- | --- |
| Performer | `http://localhost:6868/` | 选择 Player 1、2 或 3 后触摸演奏 |
| Operator / Monitor | `http://localhost:6869/` | 查看状态、显示供演奏者扫码加入的 QR code |

演奏者主触点控制位置；第二触点保留为 External OSC 的 amplitude 兼容数据。两位演奏者距离进入连接阈值时，页面显示连线并发送 pairwise coupling 控制。

## 运行时健康接口

两个 HTTP server 都提供：

```text
GET /__pnds/health
```

例如：

```sh
curl http://127.0.0.1:6868/__pnds/health
```

Internal 模式正常启动时的返回示例：

```json
{
  "status": "ready",
  "projectId": "inarticulate-iii",
  "audioMode": "internal",
  "audio": {
    "status": "ready",
    "target": "127.0.0.1:57110"
  },
  "scoreServer": {
    "performerPort": 6868,
    "monitorPort": 6869
  }
}
```

`status` 可能为 `starting`、`ready`、`error` 或 `stopping`。PNDS App 应以 JSON 中 `status === "ready"` 作为项目可显示的依据，而不只检查 HTTP 是否连通。

## 停止

向 Node score server 发送 `SIGINT` 或 `SIGTERM`，例如在终端按 `Ctrl-C`。项目将：

1. 停止 Socket.IO 客户端；
2. 释放 Internal Synth node 与 group；
3. 关闭 OSC UDP socket；
4. 关闭 performer / monitor HTTP server。

成功时输出：

```text
[shutdown] complete.
```

`scsynth` 由宿主（目前是手动终端、未来是 PNDS App）拥有；score server 不会主动终止它。

## 项目结构

```text
.
├── audio/
│   ├── audio-controller.js       # 项目级 Internal / External 音频语义
│   └── osc-controller.js         # UDP 与 OSC 请求 / reply 传输层
├── public/                       # p5.js 视觉与 Socket.IO 客户端
├── supercollider/
│   ├── dev/inarticulate-iii-debug.scd
│   ├── source/inarticulate-iii.scd
│   └── synthdefs/inarticulate-iii.scsyndef
├── manifest.json                 # PNDS project 运行配置
├── server.js                     # Express、Socket.IO 与运行时生命周期
└── PROJECT_HANDSOFF.md           # 面向后续开发环境 / AI agent 的交接说明
```

## 音频约定

- SynthDef 文件名：`inarticulate-iii.scsyndef`；
- SynthDef 内部名称：`inarticulateIII`；
- Internal group ID：`1000`；
- Internal synth node ID：`1001`；
- 裸 `scsynth` 的 root group 是 `0`。不要把项目 group 挂到 group `1`，后者通常由 `sclang` 客户端创建，在裸 scsynth 中不存在。

## 检查

```sh
npm run check
```

该命令执行 `server.js`、两个 audio controller 与 `public/sketch.js` 的 Node 语法检查。

## 下一阶段

下一阶段是构建 PNDS Tauri App。App 的最小职责是：读取 manifest、启动或停止 `scsynth`、向 Node 注入 `PNDS_OSC_TARGET`、启动 score server、轮询 health endpoint，并在退出或切换模式时终止对应进程。详细的现状、约束与实现建议见 [`PROJECT_HANDSOFF.md`](PROJECT_HANDSOFF.md)。
