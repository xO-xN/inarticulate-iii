# Creation handoff / 创作交接单

The App records intent. An external agent implements tasks and records status and evidence here.
App 记录创作意图，外部 agent 实施任务并在此记录状态与验收证据。

Read the project's AGENTS.md and the installed PNDS platform contracts before implementation.
实施前读取工程 AGENTS.md 与已安装 PNDS App 的平台契约。

Preserve existing tasks, unknown content and external agent status when appending work.
追加任务时保留既有任务、未知内容及外部 agent 状态。

This source-only document is excluded from .pnds along with the root docs directory.
本文留在源工程，随根 docs 目录一起排除于 .pnds 演出包。

## Creation handoff / 创作交接

Before continuing creation, read docs/creator-handoff.md if present. Preserve existing tasks and agent status; record actual implementation and verification evidence when updating a task.
接续创作前读取 docs/creator-handoff.md（若存在）。保留既有任务与 agent 状态，更新任务时记录实际实现和验证证据。

Platform contracts: /Applications/PNDS.app/Contents/Resources/help/en/reference/README.md (Chinese: help/zh-CN/reference/README.md). Use the installed App's corpus first; fallback: https://github.com/xO-xN/PNDS-App/blob/main/docs/en/reference/README.md.
平台契约优先读取已安装 App 的 help/zh-CN/reference/README.md；未安装时回落到 https://github.com/xO-xN/PNDS-App/blob/main/docs/zh-CN/reference/README.md。

<!-- pnds-task:dfe815ce-2a51-b0e6-5b98-4eed344b9a66 -->
## Wire PNDS module qr / 接入 PNDS 模块 qr (0.2.0). Read its README before choosing dependencies, routes, events and project-specific behavior. / 先阅读模块 README，再确认依赖、路由、事件与作品行为。

Status / 状态: pending

### Intent / 意图

Wire PNDS module qr / 接入 PNDS 模块 qr (0.2.0). Read its README before choosing dependencies, routes, events and project-specific behavior. / 先阅读模块 README，再确认依赖、路由、事件与作品行为。

### Files / 涉及文件

- modules/pnds-qr/qr.js
- modules/pnds-qr/package.json
- modules/pnds-qr/README.md
- modules/pnds-qr/compatibility.json
- modules/pnds-qr/LICENSE.md
- modules/pnds-qr/pnds-module.json

### Acceptance / 验收条件

Files have been added only. Wiring and validation are pending. Preserve project customizations; check dependencies explicitly, wire the server/pages and verify real runtime behavior, reconnect and cleanup. Record wiring and validation evidence separately. Do not treat file copying as a successful performance. / 仅加入文件，接线与验证待完成。保留作品定制，明确检查依赖，接入服务器和页面，验证真实运行、重连与清理，分别记录接线和验证证据；复制成功不代表演出验收通过。
