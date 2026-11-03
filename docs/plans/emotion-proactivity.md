# 情感与主动性（Emotion & Proactivity）实现方案

> 目标读者：负责实现的 AI / 开发者。
> 仓库：`moeru-ai/airi` monorepo（Vue 3 + Pinia + Vite + Vitest）。
> 开始前必读：根目录 `AGENTS.md`（代码规则、检查要求）。

---

## 0. 现状盘点（已核实，直接可用）

| 能力 | 状态 | 位置 |
|---|---|---|
| VRM 表情播放 | ✅ 有 5 个预设：happy / sad / angry / surprised / relaxed，带强度与过渡 | `packages/stage-ui-three/src/composables/vrm/expression.ts`（382 行，`emotionStates` Map + `setEmotion(name, intensity)`） |
| 贴图情绪标签 | ✅ 12 个：happy, sad, confused, surprised, thanks, celebrate, angry, tired, affectionate, awkward, agree, disagree | `packages/stage-ui/src/assets/stickers/index.ts` |
| 贴图选择 | ✅ 每轮回复选一张 | `packages/stage-ui/src/stores/modules/stickers.ts` 的 `selectCatalogForReply()` |
| 后台 LLM pass 范式 | ✅ 本项目最成熟的参考实现 | `packages/stage-ui/src/stores/memory-formation.ts`（valibot 校验、cursor、idle 延迟、超时、防并发） |
| 文本生成 | ✅ | `packages/stage-ui/src/composables/text-generation.ts` 的 `useTextGeneration().generateText({ providerId, model })(conversation, signal)` |
| 聊天编程式发送 | ✅ | `packages/stage-ui/src/stores/chat.ts:1487` 的 `send(payload: ChatSendPayload)` |
| 自动朗读 | ✅ 已存在，勿重复造 | `packages/stage-ui/src/stores/auto-speak.ts` + `composables/use-auto-speak.ts` |
| headless 生成参考 | ✅ | `packages/stage-ui/src/stores/modules/artistry-autonomous.ts`（eventa IPC + `artistryGenerateHeadless`） |
| **持久情绪状态** | ❌ 无 | — |
| **主动开口** | ❌ 无（全仓库无 proactive / idle-chat 逻辑） | — |

**两套情绪系统没有打通**：VRM 用 5 个表情，贴图用 12 个标签。本方案统一它们。

---

## 1. 设计原则

1. **情绪是状态，不是回复的副产品。** 现在的表情是"LLM 回复时顺带挑一个"，用完即弃。新设计里情绪是一个随时间演化、被事件改变、可累积到阈值的状态机。
2. **主动是情绪的下游。** 先有内在状态，再谈主动开口，否则只是定时器随机说话。
3. **计算与框架解耦。** 核心数学（衰减、阈值、映射）放 `packages/stage-shared/src/emotion/` 纯函数，Pinia store 只做接线。这样无需浏览器即可单测。
4. **默认关闭、用户可控。** 主动说话默认 off，Settings 里有开关。
5. **绝不阻塞聊天。** 一切 LLM pass 参照 `memory-formation.ts`：后台、超时、失败静默。

---

## 2. 情绪模型

### 2.1 双层结构

```ts
// packages/stage-shared/src/emotion/types.ts

/** 瞬时情绪：会衰减到 0。 */
export interface EmotionState {
  /** 主情绪，值域对齐 VRM 5 预设 + 贴图标签的并集 */
  emotion: EmotionLabel
  /** 0..1，随时间指数衰减 */
  intensity: number
  /** 上次更新的时间戳，用于离线衰减补偿 */
  updatedAt: number
}

/** 长期关系状态：不衰减，只缓慢演化，持久化。 */
export interface MoodDimensions {
  /** 好感度 0..100，正向事件 +，负向事件 -，每日向基准值回归一点 */
  affection: number
  /** 精力 0..100，长时间对话下降，静默恢复 */
  energy: number
}

export type EmotionLabel
  = | 'happy' | 'sad' | 'angry' | 'surprised' | 'relaxed' // VRM 5 预设
    | 'confused' | 'tired' | 'affectionate' | 'awkward' // 贴图侧补充
```

> `thanks / celebrate / agree / disagree` 属于"行为"而非"情绪"，不进状态机，仍走贴图选择。

### 2.2 衰减（纯函数，必须可单测）

```ts
// packages/stage-shared/src/emotion/decay.ts

/** 半衰期默认 20 分钟；低于 0.05 归零，避免永远残留。 */
export function decayIntensity(intensity: number, elapsedMs: number, halfLifeMs = 20 * 60_000): number {
  const decayed = intensity * 0.5 ** (elapsedMs / halfLifeMs)
  return decayed < 0.05 ? 0 : decayed
}
```

App 从后台回来时用 `Date.now() - updatedAt` 一次性补偿，不要依赖 setInterval 追赶。

### 2.3 事件注入

```ts
// packages/stage-shared/src/emotion/events.ts

export interface EmotionEvent {
  type: 'message-received' | 'message-sent' | 'gift' | 'silence-tick'
    | 'positive-feedback' | 'negative-feedback' | 'long-session'
  /** 可选：一句话描述，供 reflection 用 */
  note?: string
  at: number
}

/** 每种事件对情绪的影响，集中一处，方便调参。 */
export const EMOTION_EVENT_EFFECTS: Record<EmotionEvent['type'], {
  emotion?: EmotionLabel
  intensityDelta?: number
  affectionDelta?: number
  energyDelta?: number
  /** 累积到 reflection 的重要性分（见 §3） */
  importance: number
}> = {
  'message-received': { emotion: 'happy', intensityDelta: +0.08, affectionDelta: +0.2, energyDelta: -1, importance: 1 },
  'message-sent': { energyDelta: -1, importance: 1 },
  'gift': { emotion: 'surprised', intensityDelta: +0.9, affectionDelta: +8, importance: 5 },
  'silence-tick': { emotion: 'sad', intensityDelta: +0.05, energyDelta: +1, importance: 0.5 },
  'positive-feedback': { emotion: 'happy', intensityDelta: +0.3, affectionDelta: +2, importance: 3 },
  'negative-feedback': { emotion: 'sad', intensityDelta: +0.4, affectionDelta: -2, importance: 3 },
  'long-session': { emotion: 'tired', intensityDelta: +0.2, energyDelta: -10, importance: 1 },
}
```

**Phase 1 用这张规则表即可。** LLM 情绪分类是可选优化（§5 Phase 4），不要一上来就加。

### 2.4 表达层映射（统一两套系统）

```ts
// packages/stage-shared/src/emotion/mapping.ts

/** 情绪标签 → VRM 表情。VRM 不认识的标签回落到最近似预设。 */
export const EMOTION_TO_VRM: Record<EmotionLabel, 'happy' | 'sad' | 'angry' | 'surprised' | 'relaxed'> = {
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  surprised: 'surprised',
  relaxed: 'relaxed',
  confused: 'surprised',
  tired: 'relaxed',
  affectionate: 'happy',
  awkward: 'sad',
}
```

驱动方式：emotion store 的 `watch` 里调 `setEmotion(EMOTION_TO_VRM[state.emotion], state.intensity)`。
**需要先核实的接入点**：找到 `setEmotion` 当前的调用方（从 `VRMModel.vue` / stage-ui-three 的组件事件往回追），确认 store → 渲染层走的是 eventa 事件还是组件 prop，沿用现有通道，不要新开一条。

---

## 3. Reflection（反思）：情绪带动记忆

照抄 Stanford generative_agents 的核心机制：**重要性累积 + 阈值触发**。

- 每个事件按 `EMOTION_EVENT_EFFECTS[type].importance` 累积到一个 ledger（localStorage）。
- 累积分 ≥ `REFLECTION_THRESHOLD`（建议 12）时，触发一次后台 LLM pass：
  - 输入：最近 transcript（截 6000 字符，同 `memory-formation.ts` 的 `trimTranscript`）+ 当前情绪快照 + 好感度/精力变化摘要。
  - 输出（valibot `strictObject` 校验）：`{ insights: string[], moodAdjustment?: { affection?: number } }`，最多 3 条 insight。
  - insight 通过 `memory.write({ source: 'reflection', ... })` 写入**现有记忆系统**，情绪和历史自然汇流到一处。
- 完全复用 `memory-formation.ts` 的骨架：idle 延迟、cursor、`AbortController` 60s 超时、`running` 防重入、失败静默 `console.warn`。
- **跨窗口防并发**：用 `navigator.locks.request('airi:emotion-reflection', ...)`（仓库已有此惯例，见 `memory.repo.ts:64`）。这是 memory-formation 已知未做的一步，这里必须做。

---

## 4. 主动说话（Proactive）

### 4.1 调度器

```ts
// packages/stage-ui/src/stores/modules/proactive-chat.ts
```

- 一个 30s 的 `setInterval` tick（页面不可见时暂停：`document.visibilityState`）。
- **全部门控条件满足才触发**：

| 条件 | 默认值 | 存储键 |
|---|---|---|
| 总开关 | off | `emotion/proactive/enabled` |
| 静默时长 ≥ | 5 分钟（自最后一次 user 消息起算） | `emotion/proactive/silence-ms` |
| 距上次主动消息冷却 ≥ | 15 分钟 | `emotion/proactive/cooldown-ms` |
| 每小时上限 | 3 次 | `emotion/proactive/max-per-hour` |
| 当前会话无进行中的生成 | — | 查 `chatSession` / stream store |
| 精力 ≥ | 20（低于就不打扰） | — |

### 4.2 触发后的动作

1. 组一个内部 prompt：当前情绪快照 + `memory.coreIndexFor(persona)` + 一条指令（"主人已经 X 分钟没说话，用符合你当前心情的方式自然地开启一个话题；不想说话时返回空"）。
2. 走 `chat.ts` 的 `send()`（1487 行）。**需要核实的接入点**：`ChatSendPayload` 是否支持标记"系统发起"（避免把它当作用户输入存历史、触发 again-formations）。若不支持，在 payload 加可选字段 `origin: 'user' | 'proactive'`，并在 formation / memory 的 afterTurn 钩子里跳过 proactive 消息，防止自问自答形成记忆回声。
3. LLM 返回空字符串 → 本次不说话，且冷却时间翻倍（避免硬尬）。

### 4.3 语气由情绪决定

prompt 里注入当前状态（示例）：

```
Your current feeling: happy (0.6). Affection: 42/100. Energy: 71/100.
When affection is low, be more reserved. When energy is low, keep it short.
```

---

## 5. 分阶段实施（每阶段独立可合并、可验收）

### Phase 1 — 情绪核心（无 LLM，1 个 PR）
- `packages/stage-shared/src/emotion/{types,decay,events,mapping}.ts` + `emotion.test.ts`
- `packages/stage-ui/src/stores/modules/emotion-state.ts`（Pinia store，接线 chat 事件）
- chat store 里在消息收发处调用 `ingest()`
- 表达层对接（§2.4）
- **验收**：连续发消息可见表情变化并缓慢回落；`decayIntensity` 单测覆盖边界（0、超大 elapsed、归零阈值）。

### Phase 2 — Reflection
- `emotion-reflection` store（参照 `memory-formation.ts` 逐行抄骨架）
- insight 写入现有 memory（`source: 'reflection'`）
- **验收**：制造高重要性事件（gift 等）跨过阈值后，memory 设置页出现 insight 条目；同一窗口重复触发不会双写。

### Phase 3 — 主动说话
- `proactive-chat` store + Settings UI
- UI 位置：`packages/stage-pages/src/pages/settings/modules/`（参照 `memory-long-term.vue` 的页面结构），i18n 键加进 `packages/i18n/src/locales/en/settings.yaml` 和 `zh-Hans/settings.yaml`（至少这两个语言）
- **验收**：默认关闭；开启后静默超时主动发一条；冷却与每小时上限生效；关闭开关立即停。

### Phase 4 —（可选）LLM 情绪分类 + 直播事件
- 在主回复的 system prompt 里要求附带情绪标注（复用该轮调用，不新增请求），或独立小模型分类
- `gift` / `danmaku` 事件源依赖弹幕接入（另一条线），先把 `ingest()` 接口留好

---

## 6. 测试计划

| 层 | 工具 | 覆盖 |
|---|---|---|
| 纯函数 | vitest（node，`*.test.ts`） | 衰减数学、阈值、事件效果表、映射完备性 |
| Store | vitest fake timers + `*.browser.test.ts`（参照 `stores/memory.browser.test.ts` 的双窗口写法） | 衰减随时间推进、reflection 只触发一次、主动消息门控 |
| 手工验收 | `pnpm dev` | 聊 10 轮观察表情回落；静默看主动消息 |

命令（改完必须跑，AGENTS.md 要求）：

```sh
pnpm -F @proj-airi/stage-shared exec vitest run src/emotion
pnpm -F @proj-airi/stage-ui exec vitest run src/stores
pnpm -F @proj-airi/stage-shared typecheck && pnpm -F @proj-airi/stage-ui typecheck
pnpm lint
```

---

## 7. 参考项目（按用途标注看哪里）

| 项目 | 地址 | 看什么 |
|---|---|---|
| **generative_agents**（Stanford，22.3k★） | https://github.com/joonspk-research/generative_agents | **本方案的方法论源头**。`reverie/architecture/memory_stream.py`（重要性打分）、`reverie/architecture/reflect.py`（累积阈值 + 生成反思问题）、`plan.py`。只抄算法思想，它是 Python |
| **N.E.K.O**（3.2k★） | https://github.com/Project-N-E-K-O/N.E.K.O | topics 直写 `proactive-agent`；看它的主动排程与门控条件怎么设计 |
| **my-neuro**（1.4k★） | https://github.com/morettt/my-neuro | JS 实现的主动闲聊 + 长期记忆，工程量小、好读 |
| **aituber-onair**（315★，TS） | https://github.com/shinshin86/aituber-onair | 同为 TypeScript，观众反应驱动的接口设计可直接借鉴 |
| **elizaOS/eliza**（19.8k★，TS） | https://github.com/elizaOS/eliza | character 卡结构 + autonomous loop + `shouldRespond` evaluator 的思路 |
| **letta**（25.3k★） | https://github.com/letta-ai/letta | memory blocks：core memory 常驻 / archival 检索的分层，对应情绪的"瞬时 vs 长期" |
| **Open-LLM-VTuber**（14.5k★） | https://github.com/Open-LLM-VTuber/Open-LLM-VTuber | 语音打断与 idle 行为，Phase 3 接语音时参考 |

理论背景（一句话）：情绪学界标准做法是 OCC 模型（事件→情绪的规则映射）或 PAD 三维（愉悦-唤醒-支配）。本方案的"规则表 + 两维度"是两者的极简混合，够用且可解释，不要上更复杂的框架。

---

## 8. 实现禁区与代码规范

- 遵守根 `AGENTS.md`：禁 `any`、文件名 kebab-case、schema 用 valibot、错误消息用 `@moeru/std` 的 `errorMessageFrom`、临时方案加 `// NOTICE:` 注释。
- **不要动** `memory-search.ts` / `chat.ts` 的检索链路（另有独立的性能修复线，避免冲突）。
- **不要**为情绪新建独立存储：insight 走现有 memory 系统，mood 走 localStorage（`useLocalStorageManualReset`，见 `stores/memory.ts` 的用法）。
- 共享逻辑一律进 `packages/stage-shared`，store 只做接线。
- 每个 PR 只做一个 Phase；提交前跑 §6 的命令并如实报告结果。

---

## 9. 顺手可修的已知问题（与本方案同文件时）

1. `chat.ts` 中 `afterTurn` 钩子（约 1150 行，`memoryFormation.afterTurn` 调用处）就是本方案事件注入的自然挂点，接入时确认 proactive 消息**不**触发 formation。
2. `expression.ts` 的 `emotionStates` 只注册 5 个键，新增标签需要同步扩充该 Map，并保持 `EMOTION_TO_VRM` 映射同步。
