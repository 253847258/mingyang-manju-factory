# Liblib.tv（LibTV）视频制作技术调研 → 画布与视频生产智能体的改进清单

> 调研时间：2026-09-27｜依据：公开资料（LibTV 发布报道、官方/第三方 Skill 仓库、LiblibAI 教程与工作流实践）
> 关联：`docs/智能Claw研究报告.md`（Agent 范式）、`docs/DramaClaw评估与画布Claw改进.md`（同赛道对照）、`docs/画布节点图改造方案.md`（本项目画布演进）
> 说明：本文件区分「已核实」与「待核实」；未逐篇精读 LibTV 官方文档与全部工作流，因此结论按「可借鉴的机制」而非「逐条复刻」表述。

---

## 一、LibTV 是什么（已核实）

| 项 | 内容 | 来源 |
|---|---|---|
| 定位 | LiblibAI 发布的 AI 视频创作平台 **LibTV**，主打「**首个同时面向人与 Agent 的专业视频创作平台**」 | [C114 报道](https://www.c114.net.cn/ainews/69475.html)、[极客公园](https://w.geekpark.net/news/361466) |
| 面向 Agent | 官方生态提供 **Skill 包**（`libtv-skill`）：把平台能力以「技能声明」的形式交给 Agent 调用 | [libtv-labs/libtv-skills](https://github.com/libtv-labs/libtv-skills/blob/main/skills/libtv-skill/SKILL.md)、[libtv-skill-pro](https://github.com/Qiuxiangxiang/libtv-skill-pro/blob/main/SKILL.md) |
| 技术底座 | 与 ComfyUI 生态深度相关（教程/工作流以 ComfyUI 为主），社区已有 **首帧→自动生成尾帧**、**AI 自动分镜 + 角色一致性**、**混元视频首尾帧特效**等成熟工作流 | [LiblibAI 教程合集](https://www.snm0516.aisee.tv/video/BV123B7BpEg9/)、[自动分镜/尾帧](https://www.snm0516.aisee.tv/video/BV1GAWfzfEFX/)、[混元首尾帧](https://adg.csdn.net/695245645b9f5f31781b4cdd.html)、[Bernini Director](https://raw.githubusercontent.com/AIMixer/ComfyUI_Bernini_Director/main/README.md) |
| 画布 | 平台形态是**无限画布 + 节点式工作流**（与本项目模块 1 的画布同构） | 同上（教程与产品页描述） |

**待核实**：LibTV Skill 的具体工具清单与参数 schema、其画布节点类型全集、计费与并发口径、人机协作（审核/多人）机制。

---

## 二、从「视频制作技术」角度，值得吸收的 7 个机制

1. **首帧 → 自动尾帧（无需提示词的自动分镜）**
   社区工作流已能做到「输入首帧，自动生成尾帧，用于首尾帧图生视频或做 LoRA 素材」。
   → 我们已有 `last` 端口与尾帧注入，但**缺「自动尾帧」这一步**：应当支持「只给首帧，自动推出尾帧（用 LLM 描述 + 文生图或 img2img 变体）」再走首尾帧视频。

2. **首尾帧特效（混元/即梦系）**
   首尾帧过渡是「稳定性最好」的视频技巧之一（社区评价）。
   → 我们 `placeholder` 用 xfade 表达、comfy 走 `lastImageNode`、generic 走 `{{lastImage}}` 模板；**缺「首尾帧质量自检」**：过渡时长是否够、尾帧与首帧的语义差异是否过大（过大→闪烁）。

3. **AI 自动分镜 + 角色一致性**
   自动分镜要保证「同一角色在多镜里长得一样」。
   → 我们有演员档案 + 参考生图 + LoRA 字段，但**缺一致性度量**：可用「人脸/整体 embedding 相似度」或轻量方案（关键帧直方图/感知哈希）做**同角色跨镜一致性评分**，并把不合格镜头标出来自动重跑。

4. **工作流即资产（ComfyUI workflow JSON 可复用/可分享）**
   LibTV 生态的价值一半在工作流模板。
   → 我们的 `config/workflows/*.json` + `comfy.map` 已是这个形态，但**缺「工作流能力探测 → 自动选模板」的完整闭环**：已有 `/object_info` 预检，可再进一步：把「实例装了什么 LoRA/采样器」与镜头需求自动匹配并给出建议。

5. **面向 Agent 的 Skill 包**
   官方把平台能力封成 Skill 给 Agent 用（我们已对齐：`skills/*.skill.json` + 31 个 MCP 工具）。
   → 下一步该补齐的是 **Skill 的输入输出契约与失败语义**（每个技能声明：前置能力、产物、可重试错误类别、人工闸门点），让外部 Agent 能「读技能就知道边界」。

6. **画布与时间线同源**（平台形态：画布编排 → 时间线成片）
   → 我们已实现「clip1..N → 成片时间线 + 多轨叠加 + 字幕轨」，**可补**：时间线上的**逐镜缩略图轨道**（可视化剪辑决策）与**拖拽调序**（当前只能在画布上改槽位）。

7. **成本与配额前置**
   AI 视频平台的共识是「先给预演，再让用户点」。
   → 我们已有 dry-run 计划、预算闸门、单次制片上限、每分钟成本口径；**可补**：按后端的**实际计费口径**（按秒/按次/按 token）配置化，并把「预计 vs 实际」做成对账。

---

## 三、给「画布 + 视频生产智能体」的施工清单（按性价比）

| # | 项目 | 落点 | 验收 |
|---|---|---|---|
| 1 | **自动尾帧**：只给首帧也能做首尾帧过渡（按本镜提示词推导尾帧 → 出图 → 作为 `last`） | ✅ **已落地**：`src/timeline.js#createLastFrameNode` + `POST /api/canvas/auto-last` + 画布右键「⌛ 自动补尾帧」+ Claw 指令「给镜 1 补尾帧」+ MCP `canvas_auto_last_frame` | 断言：新节点 `variant=autoLast`、提示词继承本镜 + 收尾语义、连线为 `image → last`、重复补被中文拒绝、非视频节点被拒、无提示词被拒（`tests/test-timeline.js` 9b / `tests/test-studio.js` 8e） |
| 2 | **首尾帧质量自检（第一层：出手前静态检查）** | ✅ **已落地**：`src/graph.js` 视频分支自检 —— 尾帧图不存在→出手前中文报错（不浪费一次计费调用）；首尾帧同一文件/同内容→`raw.firstLast.warn` 告警「这一镜不会有任何运动」；只有首帧→`raw.autoLastHint` 引导到第 1 条 | 断言：同图首尾帧带 warn、缺文件抛中文错、只连首帧带引导（`tests/test-timeline.js` 9b）|
| 2b | **首尾帧质量自检（第二层：运动量阈值）** | ✅ **已落地**：`src/frames.js`（32×32 灰度平均绝对差）+ `src/graph.js` 自检接入 —— ≤1% 判「基本没有运动」、<4% 判「变化很轻微」，告警带百分比并写入 `raw.firstLast.distance/level/verdict`；本地 ffmpeg 计算，零成本零网络 | 断言：同图 distance=0、加噪图判 same、异色图判 ok、缺文件诚实不可用；graph 侧「几乎一样」告警 + 正常不误报（`tests/test-timeline.js` 9c） |
| 3 | **跨镜角色一致性评分**：同角色关键帧相似度，低分镜头自动列出可一键重跑 | ✅ **已落地**：`src/consistency.js`（分组 + 多数位中位哈希 + 抗离群判定线） + `src/qc.js` 整集质检新检查项 + `GET /api/render/consistency` + 制作台「🧬 跨镜一致性」按钮 + MCP `render_consistency_score` | 断言：故意插一张异色关键帧 → 被标成离群且给出「只重跑这 1 镜」；阈值口径透明（cut/median/mad）；高阈值下极端离群仍被抓到（`tests/test-timeline.js` 9c、`tests/test-mcp.js` 第 3 节） |
| 4 | **时间线可视化**：成片节点内画逐镜缩略轨 + 拖拽调序 | ✅ **已落地**：`src/thumbs.js`（ffmpeg 抽帧 + 指纹缓存）+ `GET /api/render/thumb`｜`/api/render/thumbs` + `src/timeline.js#reorderTimelineClips` + `POST /api/canvas/reorder-clips` + 画布内缩略轨绘制与拖拽 | 断言：拖拽后**端口写回 clip1..N（唯一）+ slot 0..N-1**、dry-run 预览顺序一致、少给/外来/非成片节点中文拒绝、可逆调序（`tests/test-timeline.js` 9d、`tests/canvas-audit.py` N2 真机 7 项） |
| 5 | **Skill 契约化**：`skills/*.skill.json` 增加 `requires`（前置能力）/`paid`/`outputs`/`retryKinds` | `src/skills.js` + `GET /api/capabilities` | 断言：缺前置能力时技能不可用并给出中文原因 |
| 6 | **工作流能力匹配**：把实例的 LoRA/分辨率/首尾帧能力与镜头需求匹配并给建议 | ✅ **已落地**：`src/backend-fit.js`（能力事实表 ↔ 本集需求 → block/warn/info + 可执行建议） + `GET /api/render/backend-fit` + MCP `render_backend_fit` + 制作台「🧩 能力匹配」面板 + 制片 Agent 计划页卡片 | 断言：占位后端 + 9s 超长镜头 → 拆镜/续写建议；缺 turbo LoRA → 120s/条 + 先跑 5 镜；后端不可用 → block + 换 placeholder；无需求时明说「这次没比什么」（`tests/test-comfy.js` 第 10 节 11 项） |
| 7 | **计费口径配置化 + 预计/实际对账** | ✅ **已落地**：`src/billing.js`（按次 / 按秒 × 分辨率阶梯、换口径对比、按**真实产出**对账） + 设置页「计费口径」字段（`PUT /api/settings` 的 `billing` 段）+ 一页纸报告「三之二、计费口径与对账」+ `GET /api/studio/productions/:id/reconcile` + MCP `studio_reconcile` + 制片页对账卡片 | 断言：按次 6 元 / 按秒 31 元（1080p ×1.5）与差额、阶梯匹配、未配单价 → `unpriced` 且金额差为 null、实际按真实产出统计、报告含差额表（`tests/test-studio.js` 8f 14 项） |

---

## 四、结论

LibTV 的技术价值集中在三处：**首尾帧与自动分镜的工程化**、**工作流/技能的可复用资产化**、**画布与时间线的一体化**。本项目在第二、三项已具备主体能力（可执行节点图 + 多轨时间线 + Skill/模板 + 31 个 MCP 工具 + 人类审核闸门），**最大的缺口是第一项**：首帧驱动下的**自动尾帧**与**首尾帧质量自检**，以及由此延伸的**跨镜一致性评分**——这三条恰好也是「视频生产智能体」最需要专业判断的地方。

建议顺序：**1 → 2 → 3**（把「一致性」做成可度量的质量闭环），再做 **4 → 5 → 6 → 7**（体验与治理）。

### 进度（两轮累计）

- **第 2b 条 运动量量化**：已落地（`src/frames.js`）。首尾帧「不是同一张图但几乎一样」这种最隐蔽的浪费被量化成 0~1 的数字并写进执行记录。
- **性能**：评分首版是「一张图一个同步 ffmpeg」，50 张要 10.1 秒且阻塞事件循环；现已改为**异步 6 路并发 + 按文件指纹缓存**（`grayPixelsAsync` / `mapLimit`），冷启动 2.45 秒、命中缓存 0.01 秒，弹窗 0.6 秒出现。
- **第 3 条 跨镜角色一致性评分**：已落地（`src/consistency.js`）。在线数据上实测：`S01E001` 两个角色 / 50 张真实关键帧，判定线 0.34、组内距离中位数 0.0078，未发现离群 —— 说明**没飘的时候它不会瞎报**；离线测试里故意插一张反色关键帧则被稳稳标出。口径写在报告里（`8×8 aHash + 中位数/MAD 判定线 + 代理指标不做人脸识别`），接上真实出图后把哈希换成 embedding 即可。

### 第一轮进度（第 1、2（第一层）、5 条）

- **第 1 条 自动尾帧**：已落地，四个入口共用同一实现（画布右键 / HTTP `/api/canvas/auto-last` / Claw 指令 / MCP 工具），**全部只建图不生成**——尾帧图仍走「执行计划 → 人工闸门」，符合本项目「花钱的动作必须人工批准」的红线。Claw 侧把「补尾帧」归入**建图类意图**（`trace.paid === false`）；连点两次会依次推进到下一个还没尾帧的片段，全部补完后给可读说明而不是报错。右键补尾帧的节点会自动落在片段**正上方**，不压住原节点。
- **第 2 条 首尾帧自检（第一层）**：已落地在 DAG 执行器里，属于**出手前的静态检查**（不依赖任何后端）：缺文件直接中文报错、首尾同图明确告警、只有首帧时给出补尾帧引导。
- **已补齐**：第 2 条第二层与第 3 条都已用**本地可计算的代理指标**实现（不需要等真实出图）：运动量用 32×32 灰度差、跨镜一致性用 8×8 感知哈希组内离群。两条都把「接上真实出图后如何替换度量」写在了模块注释里。
- **第 4 条 时间线可视化**：已落地（`src/thumbs.js` + `reorderTimelineClips` + 画布缩略轨拖拽）。缩略图按文件指纹缓存，同一个源文件只抽一次帧；LOD 简（<22%）时不画轨道、不发请求。
- **第 6 条 工作流能力匹配**：已落地（`src/backend-fit.js`）。判断是「按这一集」做的：读分镜的时长/台词/比例 + 画布上是否接了 `last`/`dub`，再与实例真正具备的能力对表 —— 缺 turbo LoRA 会换算成「120s/条、本集约 N 分钟」这种可决策的量级，而不是一句「不可用」。
- **第 7 条 计费口径配置化 + 对账**：已落地（`src/billing.js`）。**实际**按真实产出统计（落库的 done 关键帧/视频条数与时长），提交失败的不计入；没配单价时只对账条数/秒数并把金额差额返回 `null`，不假装免费。
- **调研清单 7 条全部落地**（1 / 2 / 2b / 3 / 4 / 5 / 6 / 7）。下一阶段若要继续，方向是真实后端接入后的调优（本机出图 `base_url/key/模型` 仍未提供）与画布专业能力（FCP7 XML/OTIO、TTML/VTT 字幕规范、EBU R128 响度、安全框检查）。
