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

## 运行 1.4.0 版

此版本要求 **PNDS App 1.6.2 或更新版本**（manifest schema 2）。将工程目录或 `.pnds` 包导入该版 App。共享库由 App 提供；包内保留三张谱面图片、已编译 SynthDef、SuperCollider 源码与工程代码。App 打开工程时不会运行 npm。

独立开发使用 Node 24，先执行 `npm ci`，再执行 `npm run dev:none`。Internal／External 音频模式沿用本作品原有协议与声音引擎。接线与验证方法见[共享库说明](docs/shared-libraries.md)及[工程交接](docs/handoff.md)。

## App 演奏端二维码迁移

本版本移除工程自己的二维码界面与 `/qr` 端点。支持内置演奏端二维码的 PNDS App 中，演出模式使用底栏按钮，创作模式使用演奏者栏按钮；手机进入当前工程的 performer 页面。独立浏览器及旧版 App 仍可使用原页面，但不再提供页内扫码入口。
