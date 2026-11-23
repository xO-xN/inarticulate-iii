# 失语 III

**中文** | [English](README.md)

title: 失语 III
composer: @肖翔
composer_url:https://space.bilibili.com/44522297
github_url: https://github.com/xO-xN/inarticulate-iii
color_palette: [#000000, #C9D8B6, #F1ECC3, #57837B]

## 作品简介：

失语III 是为三个手机演奏者而作的数字乐谱作品。
演奏者通过手机触控屏幕上的“轨迹”来演奏，各演奏者之间的触控点会因为距离靠近而产生频率调制，通过这种交互方式引发演奏。

---

## 关于作品

本作品为 PNDS 工程。PNDS（Platform for Networked Digital Score）是一个面向网络化数字音乐演出的开放平台，用于创建、运行和组织多人参与的数字乐谱作品：创作者将一份数字乐谱、一套声音引擎和一组网络交互规则组织成一个独立的演出工程，再由 [PNDS App](https://github.com/xO-xN/PNDS-App)（macOS 桌面应用）在演出现场将它变成一个可运行的本地多人数字音乐演奏系统。

## 运行 2.0.0 版

请使用 [PNDS App 1.7.0-beta.4](https://github.com/xO-xN/PNDS-App/releases/tag/v1.7.0-beta.4)，或支持相同共享库版本、浏览器入口和演奏记录协议的后续版本。用 App 打开 `.pnds` 安装包。共享库由 App 提供；包内保留三张谱面图片、已编译 SynthDef、SuperCollider 源码与工程代码。App 打开工程时不会运行 npm。

独立开发使用 Node 24，先执行 `npm ci`，再执行 `npm run dev:none`。Internal／External 音频模式沿用本作品原有协议与声音引擎。接线与验证方法见[共享库说明](docs/shared-libraries.md)及[工程交接](docs/handoff.md)。

## 加入演出

在 PNDS App 中打开作品，从演出底栏打开网络二维码。同一局域网内的演奏者扫码确认进入，然后选择空闲的演奏者编号。创作模式可从演奏者栏打开测试入口。参见[浏览器演奏入口](docs/browser-participation.md)和[演奏记录与叠录](docs/developer/performance-recording.md)。
