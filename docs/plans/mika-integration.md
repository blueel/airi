# Mika 集成方案（讨论稿）

> 状态：路线 A 的 Android 同机 POC 已实现，见 §8。桌面端、远程网关与 iOS 仍未实现。本文档评估将 [wangzan101/Mika](https://github.com/wangzan101/Mika) 集成进 airi 的可行性与路线，供讨论后决策。

## TL;DR

Mika 是 Android 端的设备内 AI Agent（Apache-2.0），能通过后台虚拟屏 + 无障碍服务实际操作手机上的任意 App 和网页。它与 airi 的结合**可行**，有三条路线：

| 路线 | 内容 | 成本 | 建议 |
| --- | --- | --- | --- |
| A | airi 桌面端经 Mika 官方 MCP/CLI 接口遥控手机上的 Mika | 小（天级） | ✅ 推荐先做 |
| B | 把 Mika 的 Kotlin Agent 能力 vendor 进 `apps/stage-pocket` | 大（周级） | 暂缓，A 验证后再议 |
| C | 复用 Mika 的 App/网站使用知识（纯文本） | 极小 | 可作为 A/B 的附带收益 |

## 1. Mika 是什么

- **形态**：原生 Android App（Kotlin/Gradle），要求 Android 11+（操作 App 需 12+，推荐 14+），arm64 才有 Linux 沙箱。
- **核心能力**：在一个独立的后台虚拟屏上打开 App、点按、输入、滚动——像人一样看屏幕找按钮，不需要任何 App 的 API 或逐 App 适配；内置桌面级浏览器；按对话隔离的 Linux 沙箱（Python/Node/shell）；定时与条件任务；任务可插话、可纠正、可暂停恢复。
- **模型**：无自有服务器，用用户自己的 API key（OpenAI-compatible / Anthropic / Gemini 端点均可）。
- **对外接口**（关键，是我们集成的抓手）：
  - **MCP 服务器**（Streamable HTTP，`/mcp`，Bearer 令牌）：暴露 `mika_run_task` / `mika_task_status` / `mika_wait_task` / `mika_answer` / `mika_steer_task` / `mika_cancel_task` / `mika_list_tasks` 等工具，另有可选的远程亮屏/解锁工具组。
  - **CLI + Agent Skill**（`mika` 命令，调普通 HTTP `/api/v1`，无需 MCP SDK）：`task run/status/wait/answer/steer/cancel/list`、`devices/connect/doctor`。
  - 两者共用手机端同一套远程任务服务（`RemoteTaskService`），状态机为 `starting / running / queued / paused / waiting_for_answer / waiting_on_phone / done / failed / cancelled`。
- **连接方式**：USB（adb 端口转发，仅监听 127.0.0.1）、Wi-Fi/私有 VPN（局域网明文 HTTP + Bearer）、自托管 HTTPS 网关（远程）。默认全部关闭，令牌 32 字节随机、常量时间比较、限流封禁。
- **安全边界**：付款/确认类操作永远只在手机上由人完成，电脑派的任务无法代答；`waiting_on_phone` 状态只能等人；电脑看不到手机上本地发起的任务。

## 2. airi 现状

- monorepo：pnpm + Vite + Vue3 + Pinia；桌面端 `apps/stage-tamagotchi`（Electron，eventa IPC 体系成熟），Web 端 `apps/stage-web`，移动端 `apps/stage-pocket`（**Capacitor**，自带完整 Android Gradle 工程 `apps/stage-pocket/android/`，还有 iOS 工程）。
- 已有 provider / MCP 相关基础设施（`packages/stage-ui/src/stores/providers/`、`stores/modules/`），路线 A 可挂在这上面。
- 依赖注入用 `injeca`，跨进程事件用 `@moeru/eventa`，契约集中在 `apps/stage-tamagotchi/src/shared`。

## 3. 路线 A：经 MCP/CLI 接入（推荐）

**思路**：不合并任何代码。用户手机装 Mika，airi（先做桌面端）新增「Mika 设备操控」能力，AIRI 角色把任务派给手机上的 Mika 执行并回读结果。这正是 Mika 官方设计的用法——"电脑说『要办成什么』，怎么做由手机上的 Mika 决定"。

### 3.1 架构

```
┌─────────────────────────┐        USB(adb forward) / Wi-Fi / VPN        ┌──────────────────┐
│ airi stage-tamagotchi   │ ────────── Streamable HTTP + Bearer ───────▶ │ Android 手机      │
│ (Electron 主进程)        │          http://127.0.0.1:8765/mcp           │ Mika             │
│  Mika Connector 模块     │ ◀───────── task 状态机 / 回答 ────────────── │  McpService      │
│  → eventa → 渲染进程 UI  │                                              │  TaskService     │
└─────────────────────────┘                                              └──────────────────┘
```

- 传输层走 MCP（Streamable HTTP）而不是 CLI：airi 是 Electron 应用，直接 HTTP + Bearer 即可，**不需要** adb 依赖打包（USB 方式需要 adb，但可以同时支持 Wi-Fi/VPN 方式做到零 adb 依赖）。
- 会话与任务模型映射到 airi 侧：一个 Mika `conversation` 对应 airi 的一段连续操控会话；`mika_run_task` 返回 `task_id` 后按官方建议的循环驱动：`run → wait(≤50s) → waiting_for_answer ? answer : wait → done/failed/cancelled`。

### 3.2 airi 侧改动点（预估）

| 模块 | 位置 | 内容 |
| --- | --- | --- |
| Mika 连接器 | `packages/server-runtime` 或 `packages/stage-shared` 新模块 | MCP Streamable HTTP 客户端封装：连接配置（url/token/transport）、工具发现、任务循环驱动、事件上报 |
| Eventa 契约 | `apps/stage-tamagotchi/src/shared` | `mika:task:dispatch / progress / waiting / done / failed / cancelled` 等契约，主进程 ↔ 渲染进程 |
| 设置页 | settings layout 新页 | 「设备操控 (Mika)」：地址、令牌、连接测试（等价 `doctor`）、连接方式说明 |
| 角色接入 | `packages/stage-ui/src/stores/modules/` | 给 AIRI 的 agent loop 增加一个「手机操控」工具：把用户指令（"帮我给文件传输助手发条消息"）转成 `mika_run_task`，把 `wait` 的进度/追问转述给用户，追问用 `mika_answer` 回传 |
| UI 反馈 | 聊天界面 | 任务进度条/状态卡片；`waiting_for_answer` 时把 Mika 的问题展示给用户；`waiting_on_phone` 提示"请在手机上完成这一步" |

### 3.3 体验设计要点

- **插话（steer）**：任务运行中用户补充要求 → `mika_steer_task`（≤4000 字符，仅 `running` 状态可收）；注意响应丢失时**不要自动重发**。
- **幂等**：`mika_run_task` 支持 `request_id`（UUID），airi 侧生成并持久化，回执丢失后可用同一编号查询终态，避免重复执行。
- **等待上限**：`wait` 单次最多 50s，airi 侧做轮询循环而不是一次长等。
- **付款安全**：Mika 侧已硬保证电脑派的任务不执行付款/确认，airi 侧文案如实转述即可，不要尝试绕过。

### 3.4 工作量

连接器 + 契约 + 设置页 ≈ 2–3 天；角色 agent loop 接入 + UI 反馈 ≈ 2–3 天。合计一周内可出可用的 POC→正式版。

## 4. 路线 B：源码并入 stage-pocket（暂缓）

**思路**：让 AIRI 安卓 App 自身具备"操作手机"的能力（无障碍服务、后台虚拟屏、任务引擎 vendor 进 `apps/stage-pocket/android/`）。

### 4.1 主要难点

1. **Mika 不是库**：它是完整 App（`:app` + `:core` 等多个 Gradle 模块），没有发布过 Maven artifact。需要把 `core`（AgentLoop/TaskService/知识库）与 `app`（UI/入口）拆开，只 vendor `core` + 必要的服务组件，重新设计入口。
2. **与 Capacitor 外壳共存**：无障碍服务（`AccessibilityService`）、虚拟屏呈现（`Presentation`/display 管理）、前台服务、`INTERACT_ACROSS_USERS_FULL` 相关流程都要在 Capacitor 的 `MainActivity` 体系外正确注册（AndroidManifest service 声明、权限向导），并做 JS↔Native 桥（Capacitor plugin）暴露给 Vue 层。
3. **构建体系**：airi 用 pnpm/Vite 管理 Web 层，Android 层是 Capacitor 生成的 Gradle 工程；vendor 进来后 `settings.gradle.kts`、依赖版本（Kotlin/AGP/compose 等）要与 Capacitor 模板对齐，CI 需新增 Android 构建验证。
4. **许可证**：Apache-2.0 兼容 airi 现行许可，但需保留 NOTICE 与第三方组件声明（Mika 自带 `NOTICE`、`licenses/THIRD_PARTY_NOTICES.md`）。
5. **上游同步**：vendor 后失去自动跟进 Mika 上游迭代的能力（它更新很活跃），要么定期 rebase，要么事实分叉。

### 4.2 前置条件

建议先做路线 A 的 POC 验证产品体验（"角色派任务给手机"是否成立），再决定是否值得投入周级工程。若最终目标是"AIRI App 自己操作手机"，也应优先评估 Capacitor plugin 复用 Mika `core` 的最小切面（无障碍 + 单任务执行），而不是全量 vendor。

## 5. 路线 C：复用 Mika 的使用知识（附带收益）

Mika 内置了 23 个 App + 18 个网站的使用知识及 6 类 how-to 技能，全部是**纯文本、无代码**（Apache-2.0）。即使不走 A/B，也可以把这份知识作为 airi 移动端/桌面端 agent 的参考资料（需保留署名）。Mika 有贡献指南与知识格式文档，格式简单。

## 6. 风险与合规

- **第三方 ToS**：自动操作第三方 App/网站可能违反其服务条款（Mika 官方免责声明已明确提示）。airi 集成后需在 UI 明示风险，默认「询问模式」（花钱前确认）。
- **隐私**：Mika 无自有服务器，屏幕内容只发给用户配置的模型服务商；airi 侧不引入额外中转即可保持该性质。令牌与 API key 均在手机端加密存储。
- **传输安全**：局域网方式为明文 HTTP + Bearer，文档建议在可信网络或经 adb/VPN 使用；airi 设置页应如实提示。
- **平台行为**：手机重启后 USB 连接与令牌会失效需重开；后台任务偶发被系统冻结（需先打开一次 Mika）——这些是 Android 平台限制，产品文案要管理预期。

## 6.5 网页版能否调用 Mika？

**不能直连，只能间接。** 三重硬性限制（均为 Mika 侧设计）：

1. Mika 拒绝一切带 `Origin` 请求头的请求（明确防浏览器直连）；
2. Mika 只有明文 HTTP，HTTPS 页面调它会触发混合内容拦截；
3. Mika 只接受私有网络地址，公网连接当场断开；USB 方式仅监听手机本机。

**间接路径**：

- **自托管远程网关（官方支持，仅适合个人自用）**：手机主动向外连接自托管 HTTPS 网关，链路为 `网页版 airi → airi 后端代理 → Mika 网关 ← 手机`。全程 HTTPS、无混合内容问题，但首版网关为单用户单设备、且网关终止 HTTPS 可读全部转发内容——适合自己搭自己用，不适合产品化给所有用户。
- **本地桥接（仅开发场景）**：本地跑 stage-web + 本机小代理（代理负责 CORS、剥离 `Origin` 后转发）。线上用户不可用。

**结论**：调 Mika 的正确载体是桌面端 Electron（路线 A）；网页版如需支持，只能走自托管网关方案且定位为个人自用能力。

## 6.6 手机同机调用（stage-pocket → 本机 Mika）

**可行，且可能是比桌面端更顺的路线 A 变体。** 网页版撞上的三堵墙，对原生 App 有两堵自动消失：

| 限制 | 浏览器 | 原生 App（stage-pocket） |
| --- | --- | --- |
| `Origin` 头被拒 | 必带 Origin，被 Mika 拒绝 | 原生请求（OkHttp / capacitor-http）不带 Origin，不触发防浏览器机制 |
| 混合内容拦截 | HTTPS 页面禁调 HTTP | 无此限制；仅需 network security config 允许 cleartext 到 localhost/私有网段 |
| 网络可达性 | 触不到 loopback/局域网 | 同机连 `127.0.0.1:8765` 天然可达 |

Mika 文档明确「USB 方式只在本机监听……手机上别的 App 也能连本机端口，所以照样要令牌」——同机 App 调用在它的安全模型之内。

**条件与限制**：

1. **令牌走 Wi-Fi 模式手动复制**：USB 模式令牌文件在 Mika 的外部目录，Android 11+ 分区存储下其他 App 读不到。实际流程：Mika「设置 › 连接电脑」开 Wi-Fi/VPN 方式 → 复制地址+令牌 → 粘贴进 AIRI 设置页。
2. **明文 HTTP**：stage-pocket Android 工程需允许 cleartext 到 localhost/私有网段。
3. **自连接需真机验证**：同机连自己的 LAN IP/loopback 符合其私有地址规则，但非官方验证过的用法。
4. **后台冻结**：安卓可能不让后台的 Mika 开始任务，需最近打开过 Mika。
5. **仅 Android**：iOS 无 Mika，按平台 feature gate。

**价值定位**：同机上 Mika 自带完整 UI，airi-pocket 的增量价值是**角色化调度层**——用户对 AIRI 说需求，AIRI 转成 `mika_run_task` 并把进度/追问转述成角色对话。无需桌面端连接器的 adb/端口转发层，改造成本更低。

## 7. 建议的决策

1. **先做路线 A**（一周内可验证端到端体验），载体二选一：桌面端（stage-tamagotchi，需处理 USB/端口转发）或 **手机同机（stage-pocket → 本机 Mika，见 6.6，改造成本更低但需真机验证自连接）**；
2. POC 结论出来后再评估**路线 B**是否立项，以及最小切面是什么；
3. 无论 A/B，**路线 C** 的知识库都可以低成本吸收。

## 8. 已实现的 Android 同机 POC

2026-11 实现，范围只覆盖 `apps/stage-pocket`（Android）：

| 部分 | 位置 |
| --- | --- |
| REST 客户端与任务模型 | `packages/stage-shared/src/mika/`（`@proj-airi/stage-shared/mika`） |
| 原生 HTTP 桥 | `apps/stage-pocket/android/app/src/main/java/ai/moeru/airi_pocket/MikaBridgePlugin.kt`，在 `MainActivity` 注册 |
| 平台 transport | `apps/stage-pocket/src/modules/mika.ts` |
| 设置 | `apps/stage-pocket/src/stores/mika.ts`、`apps/stage-pocket/src/pages/settings/system/mika.vue` |
| 聊天工具 | `apps/stage-pocket/src/stores/tools/mika.ts`，注册到 `useLlmToolsStore` |

实现要点：

- 请求由 OkHttp 发出，不带 `Origin`，因此能通过 Mika 的浏览器请求拦截。
- 直接使用 Mika 的 `/api/v1`，不引入 MCP SDK。
- 五个工具：`builtIn_mikaRunTask`、`builtIn_mikaTaskStatus`、`builtIn_mikaAnswerTask`、`builtIn_mikaSteerTask`、`builtIn_mikaCancelTask`。
- `run_task` 等待到软截止时间。`waiting_for_answer` 与 `waiting_on_phone` 立即返回，由对话转述给用户。
- 地址与令牌保存在本机 localStorage。未做独立密钥加密。
- 任务进度仍使用通用工具卡片，没有独立的实时进度 UI。

使用前：在 Mika 打开「连接电脑」的局域网模式，复制地址与令牌，填入 AIRI 的「设置 › 系统 › 手机操控」。

## 参考资料

- Mika 仓库：<https://github.com/wangzan101/Mika>
- MCP 接口文档：`docs/mcp.md`（工具清单、状态机、安全机制）
- CLI/Skill 文档：`docs/cli.md`（`/api/v1` HTTP 契约）
- 总入口：`docs/computer.md`；架构与开发文档：`docs/dev/README.md`
