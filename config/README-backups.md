# config/ 备份文件说明（哪些能真回滚，哪些是空操作）

> 本文档**严禁出现任何密钥明文**：所有 Key 一律只用「前 4 位 + 后 4 位」掩码。
> 逐条「备份 ↔ 线上配置」的机器判定由 `node scripts/check-config-backups.js` 给出（内容比对，不看文件名），
> 本文解释**每个文件为什么在那儿**、以及**该不该拿它回滚**。改了备份请顺手重跑一次那个脚本。

## 一、先说最要命的一条：文件名会骗人，只能看内容

| 你可能会以为 | 实际情况 |
| --- | --- |
| `config.json.bak.ark` 是「Ark（火山方舟）版备份」 | **错**。它和线上 `config.json` **逐字节相同**（md5 均为 `e1163c65f824c8f7b503f2e82f0eb1e7`），内容其实是**纯百炼**。拿它回滚 = `cp` 一下配置一个字都不变，纯粹的空操作，白耽误排障时间。 |
| `config.json.backup-bailian-verified` 名字带 bailian，应该是最新的回滚点 | **部分对**。它是「百炼实跑核验之后、由当前线上配置生成的快照」，但只要线上配置没被改过，它此刻也**逐字节等于**线上 → 同样是空操作。它的价值在**线上配置被改坏之后**才体现（那时它自动变成最新的回滚点）。 |
| 名字里带 broken 的一定不能用 | **对，但原因不是「坏了」**。`config.json.ark-broken` 是合法 JSON、结构完整，只是内容指向火山方舟（`ark.cn-beijing.volces.com`），而**方舟当前欠费**，回滚过去出图会直接 403。 |

所以判定必须**只看内容**：`scripts/check-config-backups.js` 就是这么干的。

## 二、线上配置（基准，不是备份）

`config/config.json` —— 12503 B，改于 2026-09-30 03:11:16，md5 `e1163c65…`

* 出图：`generic-http` → `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`（主机 `dashscope.aliyuncs.com`），模型 `wan2.7-image`
* Key：`image.generic.apiKey` = `sk-w****jwmQ`，`llm.apiKey` = `sk-7****7ba4`
* 这是**当前线上正在跑的那一份**，也是所有比对的基准。**不要把它本身当备份**。

## 三、逐个备份文件

| 文件 | 大小(B) | 改于 | image.generic.apiKey | image.openai.apiKey | llm.apiKey |
| --- | --- | --- | --- | --- | --- |
| `config.json.ark-broken` | 13429 | 2026-09-30 03:11 | `VxCg****6geZ` | (空) | `sk-7****7ba4` |
| `config.json.backup-bailian-verified` | 12503 | 2026-09-30 03:11 | `sk-w****jwmQ` | (空) | `sk-7****7ba4` |
| `config.json.bak` | 4903 | 2026-09-29 14:29 | (空) | (空) | (空) |
| `config.json.bak.ark` | 12503 | 2026-09-30 02:53 | `sk-w****jwmQ` | (空) | `sk-7****7ba4` |
| `config.json.bak.before-p0` | 12503 | 2026-09-30 03:11 | `sk-w****jwmQ` | (空) | `sk-7****7ba4` |
| `config.json.bak.before-refimg-merge` | 11967 | 2026-09-30 02:50 | `sk-w****jwmQ` | (空) | `sk-7****7ba4` |
| `config.json.bak.refimg` | 12393 | 2026-09-30 02:43 | `sk-w****jwmQ` | (空) | `sk-7****7ba4` |
| `config.json.bak2` | 5412 | 2026-09-30 02:19 | `sk-w****jwmQ` | (空) | `sk-7****7ba4` |

### 有效回滚点（3 份，可以真的回滚）

**`config.json.bak.before-refimg-merge`** —— 11967 B，改于 2026-09-30 02:50
* 用途：参考生图（refImage）合并**之前**的配置快照，也就是「百炼单模板时代」的最后一份。做参考生图相关改动前留的。
* 判定：`image.generic.url` 主机 = `dashscope.aliyuncs.com`（纯百炼，不含任何 ark 域名）；关键键齐全；内容与线上不同 → **有效回滚点**。三份里内容最接近线上（只少 536 B），**首选**。
* 代价：回滚它会丢掉「图生图模板 `refBodyTemplate`」相关的配置项（回滚后走 `bodyTemplate` 单模板的老路径）。

**`config.json.bak.refimg`** —— 12393 B，改于 2026-09-30 02:43
* 用途：参考生图（refImage / refBodyTemplate）那一轮的中间态快照。
* 判定：同上，纯百炼、关键键齐全、与线上不同 → **有效回滚点**，可作次选。
* 代价：比线上少 110 B，是参考生图功能收敛过程中的中间态。

**`config.json.bak2`** —— 5412 B，改于 2026-09-30 02:19
* 用途：较早的一份「能出图的最小可用配置」。
* 判定：纯百炼、关键键齐全、与线上不同 → **有效回滚点**，但体量只有线上的 43%，缺的段（预算/计费/成片包装/变体等）会由 `src/config.js` 的内置默认值补齐 → **那些自定义设置会丢**，只适合「线上配置彻底烂了、先恢复出图能力」的救急场景。

### 与线上相同（空操作，**勿用**）

**`config.json.bak.ark`** —— 12503 B
* 用途：名字本想表达「Ark 版备份」，但当时 `cp` 的源就是线上那份纯百炼配置 → 内容与线上逐字节相同。
* 判定：md5 `e1163c65…` == 线上 → **与线上相同（空操作，勿用）**。这是本次 P0 要修的核心问题：**以为有回滚点，其实没有**。

**`config.json.bak.before-p0`** —— 12503 B
* 用途：P0 动 `config.js` 之前的留档。
* 判定：同样与线上逐字节相同 → **空操作，勿用**。（P0 只改了 `src/config.js` 的**代码默认值**，没动 `config/config.json`，所以这份留档本身就等于线上，属预期。）

**`config.json.backup-bailian-verified`** —— 12503 B
* 用途：**「这是当前可用配置的快照」** —— 在百炼（`dashscope.aliyuncs.com` / `wan2.7-image`）**实跑核验通过之后**，由当时的线上 `config.json` 原样另存，作为「已知可用的百炼配置基准」。
* 判定：创建时与线上逐字节相同 → 此刻用它是**空操作**（`scripts/check-config-backups.js` 会如实这么报，并额外标注 `freshSnapshot: true`）。
* 为什么仍然要留：上面那 3 份「有效回滚点」都**早于**百炼最终态，而这份是**唯一一份在百炼实跑核验之后**生成的。**线上配置一旦被改坏，它马上变成最贴近现状、最该用的回滚点。**
* 注意：它是一份**原样快照**（没有插入任何注释字段），所以可以直接 `cp` 回去当配置用，不会因为多了自定义键而污染配置。

### 含 ark 配置（当前欠费，**勿用**）

**`config.json.ark-broken`** —— 13429 B
* 用途：接火山方舟（Ark）那轮的配置，`image.generic.url` = `https://ark.cn-beijing.volces.com/api/v3/images/generations`、模型 `doubao-seedream-5-0-pro-260628`、`video.generic.url` 也是 ark。
* 判定：内容命中 `ark.cn-beijing.volces.com`、`volces.com`、`doubao-seedream` → **含 ark 配置（当前欠费，勿用）**。方舟账户欠费，回滚过去出图直接 403。
* 它**结构是完好的**（合法 JSON、字段齐全），将来方舟充值后可以重新评估；但**现在**不能当回滚点。

### 缺关键键

**`config.json.bak`** —— 4903 B，改于 2026-09-29 14:29
* 用途：项目早期的原始配置（`image.backend = placeholder`，还没有接任何真实出图后端）。
* 判定：**缺关键键** —— 三个出图后端入口（`image.generic.url` / `image.openai.apiKey` / `image.comfy.url`）全为空，`llm.apiKey` 也未配。拷回去会**没有任何可用出图后端**，只能出占位图。

## 四、怎么用（判定 + 回滚）

```bash
# 1) 先体检：所有备份 ↔ 线上 config.json 按内容比对，给出逐条判定（退出码 1 = 没有任何有效回滚点）
node scripts/check-config-backups.js

# 2) 机器可读（供编排方 / 留痕消费；同样不含任何密钥）
node scripts/check-config-backups.js --json

# 3) 确认真有回滚点了，再回滚（示例用最新的那份有效回滚点）
cp config/config.json.bak.before-refimg-merge config/config.json

# 4) 回滚后复验：备份体检 + 后端体检
node scripts/check-config-backups.js && node scripts/check-backends.js
```

判定口径（脚本实现，全部只看内容）：

| 判定 | 含义 | 能不能回滚 |
| --- | --- | --- |
| `有效回滚点` | 纯百炼（`image.generic.url` 主机含 `dashscope.aliyuncs.com`、不含 ark 域名）、关键键齐全、且与线上内容**不同** | ✅ 能 |
| `与线上相同（空操作，勿用）` | 与线上 `config.json` **逐字节相同**，`cp` 回去配置一个字都不变 | ❌ 空操作 |
| `含 ark 配置（当前欠费，勿用）` | 内容里出现 ark 域名 / 豆包模型名 | ❌ 出图 403 |
| `缺关键键` | 顶层缺 `llm`/`image` 段，或没有任何可用出图后端（`image.generic.url` + Key / `image.openai.apiKey` / `image.comfy.url` 全空） | ❌ 出不了图 |
| `损坏（不是合法 JSON，勿用）` | 读不出 / 不是合法 JSON | ❌ |

## 五、维护约定

* 新增备份时**在本文档补一行**，写清「为什么留、能不能回滚」。
* 备份一律整份原样保存（不要往 JSON 里塞注释字段，否则回滚时会污染配置）。
* 每波改动收口前跑一次 `node scripts/check-config-backups.js`；若它提示「没有任何有效回滚点」，**先造一个真的再继续改**。
* 本文档与脚本都**只输出文件名、大小、md5 与掩码**，任何时候都不要把 Key 明文写进来。
