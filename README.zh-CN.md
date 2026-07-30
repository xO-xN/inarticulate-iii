# Inarticulate III 失语 III

**中文** | [English](README.md)

一个面向三位演奏者的网络数字乐谱作品，基于 **PNDS**（Platform for Networked Digital Score）构建。

三位演奏者各持一台手机或平板。触摸控制自己声部的位置，第二个触点改变该声部的变调量。当两位演奏者靠得足够近时，乐谱会在他们之间画出连线并耦合彼此的声音。Node.js score server 通过 Socket.IO 同步所有设备的视觉状态，并把交互转化为声音——既可以经由 PNDS App 内置的 SuperCollider 引擎发声，也可以发送到外部 OSC 目标。

本作品是 PNDS V1 工程契约的参考实现。

---

## 演奏这部作品

你需要两样东西：**PNDS App**，以及**本作品的打包版本**。

### 1. 安装 PNDS App

从 [PNDS App releases 页面](https://github.com/xO-xN/PNDS-App/releases/latest)下载最新的 `.dmg`，把 PNDS 拖入「应用程序」文件夹。需要搭载 Apple Silicon 的 Mac。

首次打开时 macOS 会提示无法验证开发者：在「应用程序」中右键点击 PNDS，选择**打开**，在弹窗中再次点击**打开**。

你**不需要**自行安装 Node.js 或 SuperCollider，PNDS App 已内置这两个运行时。

### 2. 下载本作品

> [!IMPORTANT]
> 请从 [releases 页面](https://github.com/xO-xN/inarticulate-iii/releases/latest)下载 `Inarticulate-III-<版本号>.zip`。
>
> **不要使用绿色的「Code → Download ZIP」按钮。** 那样下载到的是源码，不含已安装的依赖，PNDS App 会拒绝启动并提示 `Project dependencies are missing`。

解压到任意位置，你会得到一个名为 `Inarticulate III` 的文件夹，可离线直接运行。

### 3. 打开并演奏

1. 将运行 PNDS App 的 Mac 接入本地网络，建议使用有线连接。三台演奏者设备（手机或平板）连接到同一网络。
2. 启动 PNDS App，点击 **Open**，选择解压出的 `Inarticulate III` 文件夹。
3. 音频模式选择 **Internal Synth**，选定输出设备，然后点击 **Load**。
4. 监视/指挥页面出现，其中包含二维码。演奏者扫码进入演奏者页面，各自选择 Player 1、2 或 3。

演出过程中若要更改音频模式、输出设备或总音量，将鼠标移到 PNDS App 窗口左侧边缘，侧栏会浮出。

---

## 从源码运行

这条路径面向想要修改作品的创作者与开发者，直接运行 score server，不经过 PNDS App。

### 前置条件

- Node.js 与 npm
- 下文的 Internal 模式需要安装 SuperCollider——手动运行 `scsynth` 只在 PNDS App 之外才有必要
- Internal runtime 所需的 SynthDef 已包含在 `supercollider/synthdefs/inarticulate-iii.scsyndef`

安装依赖：

```sh
npm install
```

### None 模式——仅测试网页与网络

不启动也不发送任何 OSC：

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

手动启动时不要设置 `PNDS_AUDIO_OUTPUT_BUS`；项目会回退到硬件输出 bus `0`，直接从声卡出声。

成功时会出现：

```text
[audio] Internal Synth ready.
```

### External OSC 与 SuperCollider Debug Bridge

先在 SuperCollider IDE 中执行：

```text
supercollider/dev/inarticulate-iii-debug.scd
```

再启动 Node：

```sh
PNDS_OSC_TARGET=127.0.0.1:57120 \
node server.js --audio-mode external
```

这里的 `57120` 是作品开发期的 sclang debug bridge，不是 Internal 模式所使用的 scsynth 端口 `57110`。该 bridge 让创作者在**不启动 PNDS App** 时，以 `external` 模式验证浏览器交互、Node OSC 映射与声音设计。它不是 App runtime：正式 Internal 模式只加载已编译的 `.scsyndef`，不会启动 `sclang`。

本作品的 External OSC 协议为：

```text
/p1, /p2, /p3                 gate
/p1xy, /p2xy, /p3xy           x, y, amp（amp 控制 PitchShift 变调量）
/p1-p2, /p2-p1                couple12
/p1-p3, /p3-p1                couple13
/p2-p3, /p3-p2                couple23
```

这些地址属于 Inarticulate III，不是 PNDS 通用标准。

## 两个页面

默认端口由 `manifest.json` 提供：

| 页面               | 地址                     | 作用                                       |
| ------------------ | ------------------------ | ------------------------------------------ |
| Performer          | `http://localhost:6868/` | 选择 Player 1、2 或 3 后触摸演奏           |
| Operator / Monitor | `http://localhost:6869/` | 查看状态，显示供演奏者扫码加入的 QR code   |

演奏者主触点控制位置；第二触点映射为每个声部的 PitchShift 变调量。两位演奏者距离进入连接阈值时，页面显示连线并发送 pairwise coupling 控制。

Monitor 页面为横向观察界面：中央保持完整的手机交互区域，左侧显示演奏策略说明，右侧列出本作品的 `/p*` 控制地址与最后一次发送的数据。右侧是**作品控制流**观察器：在 External 模式中这些是实际发出的 OSC 地址；在 Internal 模式中，Node 会将同一语义映射为标准 scsynth `/n_set`。

Monitor 中的 QR code 始终指向 performer 页面。Node 以 `PNDS_HOST_IP` 构造该 URL，PNDS App 会注入用户选择的 LAN IPv4。手动运行且存在多张网卡时，可显式指定正确地址：

```sh
PNDS_HOST_IP=192.168.1.42 \
node server.js --audio-mode internal
```

未设置时，standalone 调试回退到第一个非 loopback IPv4。

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

`status` 可能为 `starting`、`ready`、`error` 或 `stopping`。PNDS App 以 JSON 中 `status === "ready"` 作为项目可显示的依据，而不只检查 HTTP 是否连通。

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

`scsynth` 由宿主拥有——PNDS App，或手动运行时的终端。score server 不会主动终止它。

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
├── test/output-bus.test.js       # 输出总线解析的最小回归检查
├── manifest.json                 # PNDS project 运行配置
├── server.js                     # Express、Socket.IO 与运行时生命周期
└── PROJECT_HANDSOFF.md           # 面向后续开发环境 / AI agent 的交接说明
```

## 音频约定

- SynthDef 文件名：`inarticulate-iii.scsyndef`
- SynthDef 内部名称：`inarticulateIII`
- Internal group ID：`1000`
- Internal synth node ID：`1001`
- 裸 `scsynth` 的 root group 是 `0`。不要把项目 group 挂到 group `1`，后者通常由 `sclang` 客户端创建，在裸 scsynth 中不存在。

### 输出总线

本项目遵守 PNDS V1 的输出总线契约：

| 运行方式     | `PNDS_AUDIO_OUTPUT_BUS` | synth `out` | 说明                                                                     |
| ------------ | ----------------------- | ----------- | ------------------------------------------------------------------------ |
| PNDS App     | 由 App 注入（如 `2`）   | 该值        | App 的 master synth 从这条 private bus 读取，做总音量后输出到硬件 bus `0` |
| 手动 standalone | 未设置               | `0`         | 直接输出到硬件，便于本地调试                                             |

变量存在但不是非负整数时，项目会启动失败，而不是静默回退。

## 检查

```sh
npm run check
npm test
```

`check` 执行 `server.js`、两个 audio controller 与 `public/sketch.js` 的 Node 语法检查；`test` 运行输出总线解析的回归检查。

## 延伸阅读

- [`PROJECT_HANDSOFF.md`](PROJECT_HANDSOFF.md)——面向后续开发者与 AI agent 的交接说明，描述当前磁盘中的实际状态、约束与实现建议。
- [PNDS App](https://github.com/xO-xN/PNDS-App)——运行本工程的 macOS 宿主应用，以及它所实现的 PNDS V1 工程契约。
