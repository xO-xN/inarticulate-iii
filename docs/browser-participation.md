# 统一演奏入口迁移（App #305）

维护输入是 `PNDS-1.6.2-projects/Inarticulate III` 的 1.4.1，保留此前共享包、
App 二维码与 OSC 适配修改。本轮未发行新版本、打标签或发布 `.pnds`。

## 运行与页面接线

`scoreServer.runtimePorts: 1` 接管 App 注入的两个 listener descriptor；两者监听完成后
原子发布本次 `runId` 的 bound 报告。config、health 与 monitor 连接目标均使用实际端口，
manifest 仍保留首选端口。独立运行没有注入时继续原固定端口路径。None health 如实报告
`audio.status: disabled`、空目标；Internal／External 与关停语义保持。

`scoreServer.browserParticipation: 1` 使用已确认的浏览器协议 1。页面先加载
`__pnds/context.js`，其余本地脚本、p5／Socket.IO 共享文件和三张曲线均保留该次演出的
不可变 URL 前缀；实时连接使用同源与 context 的 Socket.IO path 副本。没有 Host 确认时，
工程服务返回空 context 脚本，保留直接 HTTP／Host 既有 HTTPS 入口。

context.js 先于必需 style.css 加载。页面只有在 stylesheet 的实际 load、canvas 初始化、
三张必需曲线加载及实际 Socket.IO 连接全部完成后才报告 page prepared。
stylesheet error 显式报告 preparation failed，迟到连接不能绕过未完成或失败的样式。
不等待隐藏候选可能没有的动画帧，不把页面准备等同身份已接纳、发声权限或离线冷启动。
曲线失败会显示原有失败提示并报告 preparation failed，不能让失败候选替换已有页面。

必需样式在相邻内联脚本中首次赋值 href。仅浏览器确认上下文（basePath 非 `/`）
附加 `pndsDocument` 查询值，由本 Document 的 performance.timeOrigin 与随机后缀组成，
不依赖计时精度，也不作为身份、claim 或授权。路径仍在同一确认前缀内；新候选使用
自己的样式资源请求，原生与独立运行保留原 href。原 load/error 准备门槛保持。

## 身份与既有音乐行为

普通浏览器的 playerId／claimToken 按稳定池主与工程命名，不包含本次演出或 grant。
同工程重新明确进入可恢复身份，不同池主不会正常串用。原生私有来源的 base 为 `/`，
继续使用原有键；未迁移或复制原生存储。命名空间不构成同源浏览器的安全隔离，跨地址、
浏览器或图标实例不承诺数据共享。

`selectId`／`point`／`lineStroke` 与载荷、三位演奏者的音乐规则、venue 只读旁观、
原有断线重连与释放规则保持。角色重置仍清除当前来源的 playerId，凭据拒绝仍重新选择；
接入层没有合成 START／暂停／身份重置。monitor 移除此前已删除 QR 功能的残留调用。

手机 canvas 直接接收非 passive 的原生 TouchEvent，并阻止画布上的文本选择、
长按菜单和触摸默认动作；不会拦截工程按钮或其他原生控件。触点按画布当前矩形
转换到 p5 坐标，仍由原 draw 路径发送双指 point／OSC，不为同一次 Pointer／Touch
输入重复发消息。未收到 TouchEvent 的页面继续沿用 p5 PointerEvent 路径；取消、
失焦和页面退出清除该页原生触点，旧 p5 触点不会在取消后复活。后继新 touch
PointerEvent 手势可重新接管 p5 输入，先前已结束的原生数组不会永久遮蔽该路径。

回归分别覆盖无 PointerEvent 的原生双触点、坐标缩放、取消和失焦；受控真实浏览器
另验证实际 p5 canvas → Socket.IO → monitor point 的路径。它证明兼容路径与默认
动作抑制，不代替最新版 iPhone Safari 的长按体验及真实手指验收。

## 局域网、HTTP 与验证范围

III 的浏览器演奏依赖 canvas、Pointer／Touch、Socket.IO 与本地图像，没有调用
`getUserMedia`、Service Worker 或 AudioWorklet。声音继续由 Host 的 Internal 音频引擎或
原有 External OSC 目标承担。主屏幕／桌面图标和普通 LAN HTTP 不赋予安全上下文能力；
保留 App 既有 HTTPS 路径及证书需求。所需 App 固定共享库准备后，页面不依赖 CDN／WAN。

`npm run check` 与 `npm test` 覆盖继承 listener、实际端口／运行报告／health、查询资源、
页面身份分区与原生键、拒绝／重置、准备成功／资源失败、既有音乐／OSC／断线／关停回归。
样式回归执行实际 link load/error 处理器，验证样式延迟阻止成功、缺失样式报告失败。
App issue #305 的真实公开 Host 与普通 WK 页面证据统一记入 App 的
`docs/acceptance/305-306-307-project-adapters.md`。自动化不代替现场触摸／听音、手机浏览器、
双机、真实 WAN 断开与签名安装结果；这些边界继续由 #313／#314 记录。

本次样式请求回归执行实际 HTML 中首次 href 赋值的内联脚本，覆盖同确认前缀两份 Document、
计时精度缩减、原生与独立运行。触摸兼容回归后 `npm run check` 通过，`npm test` 52 项通过；
Chromium 149 受控真实页面验证双指、原生 TouchEvent、取消释放、身份恢复及 External
OSC 的原始 UDP 字节均通过。iPhone Safari 的物理触摸与长按仍需用户复测。
