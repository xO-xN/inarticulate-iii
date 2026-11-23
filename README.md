# Inarticulate III

[中文](README.zh-CN.md) | **English**

title: Inarticulate III
composer: @XiaoXiang
composer_url:https://space.bilibili.com/44522297
github_url: https://github.com/xO-xN/inarticulate-iii
color_palette: [#000000, #C9D8B6, #F1ECC3, #57837B]

## Description:

Inarticulate III is a digital score work for three performers on mobile phones.
Performers play by tracing “trajectories” on their phone screens; when two performers’ touch points come close enough to each other, frequency modulation couples their voices — it is through this interaction that the performance unfolds.

---

## About the Work

This work is a PNDS project. PNDS (Platform for Networked Digital Score) is an open platform for networked digital music performance, used to create, run, and organize multi-performer digital score works: a creator organizes a digital score, a sound engine, and a set of network interaction rules into a self-contained performance project, and [PNDS App](https://github.com/xO-xN/PNDS-App) (a macOS desktop application) turns it, at the performance venue, into a running local multi-performer digital music performance system.

## Running version 2.0.0

Use [PNDS App 1.7.0-beta.4](https://github.com/xO-xN/PNDS-App/releases/tag/v1.7.0-beta.4) or a later build with the same shared-library versions and support for the browser entry and recording protocols. Open the `.pnds` bundle with the App. App supplies the exact shared libraries; the bundle contains the three score images, compiled SynthDef, SuperCollider sources and project code. App does not run npm when opening a project.

For standalone development, use Node 24, run `npm ci`, then `npm run dev:none`. Internal and External audio modes keep the existing work-specific protocol and sound engine. See [shared-library runtime and verification](docs/shared-libraries.md) and [project handoff](docs/handoff.md).

## Joining a performance

Open the project in PNDS App and use the network QR code in the performance bottom bar. Performers join from the same local network, confirm the performance and select an available player number. In Creation, use the Performers button to open the project’s test entry. See [browser participation](docs/browser-participation.md) and [recording and overdubbing](docs/developer/performance-recording.md).
