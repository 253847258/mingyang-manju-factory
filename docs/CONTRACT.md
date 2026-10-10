# 开发契约（模块2 / 模块3 并行开发用）

> 项目根：`/home/linsheng/Desktop/ai-video-factory`　运行时：Node ≥ 22（ESM，`"type":"module"`），**零外部依赖**（不要 npm install，不要引入第三方包）。
> 服务入口 `server.js` 已自动挂载 `src/routes/novel.js` 的 `registerNovelRoutes` 与 `src/routes/script.js` 的 `registerScriptRoutes`（缺失时降级 501）。

## 一、可用的核心模块（只读，不要修改）

| 文件 | 可用导出 |
|---|---|
| `src/db.js` | `db`（DatabaseSync）、`all(sql,...p)`、`get(sql,...p)`、`run(sql,...p)`、`nextId(prefix, seqName)`（如 `nextId('N','novel')` → `N-0001`）、`ROOT`、`DATA_DIR`、`IMAGE_DIR`、`UPLOAD_DIR`、`getConfigValue(k,def)`、`setConfigValue(k,v)` |
| `src/http.js` | `createApp()`、`HttpError`、`badRequest(msg)`、`notFound(msg)` |
| `src/llm.js` | `chat({system,prompt,messages,temperature,maxTokens,json,retries})` → `{text,usage,model,elapsedMs}`；`chatJSON({...})` → `{text,data,usage,model}`（自动解析 JSON）；`llmStatus()` |
| `src/jobs.js` | `enqueue({type,title,total,payload,limit,handler})` → `jobId`；handler 收到 `ctx = {id,payload,setProgress(pct,extra),step(done,total),isCanceled(),log(msg)}`，返回值存入 `jobs.result`；`getJob/listJobs/cancelJob` |
| `src/config.js` | `loadConfig()`（LLM/出图配置）、`saveConfig(patch)` |
| `src/util.js` | `nowISO`、`rid(prefix)`、`countWords(text)`（中英混排字数）、`clipWords`、`parseJSONLoose`、`truncate`、`mergeDeep`、`slugify`、`safeJoin`、`asInt/asFloat/clamp`、`splitItems(text)`、`sleep`、`randomSeed` |
| `src/data/dictionaries.js` | `GENRES`（在 genres.js）、`POVS/TONES/SCALES/CHAPTER_WORDS/CAST_SIZE/TARGET_WORDS/OUTLINE_SECTIONS/SCRIPT_FORMATS/SHOT_SIZES/CAMERA_MOVES/COST_LEVELS/SHOT_KINDS/SHOT_KIND_LIST/RATIOS/ROLE_TYPES/...` |
| `src/data/genres.js` | `GENRES`（100 题材，字段 `id,name,cat,desc,tags,tone,hook,keywords`）、`GENRE_CATEGORIES`、`genreById` |
| `src/data/styles.js` | `STYLES`（10 画风）、`styleById(id)`、`BASE_NEGATIVE`、`BASE_QUALITY` |
| `src/prompts.js` | `subjectFragment(actor)`（英文角色锚点）、`subjectChinese(actor)`、`buildPrompt({actor,styleId,kind,variant,...})`、`ratioToSize(ratio)` |

## 二、路由写法（模块1 `src/routes/actors.js` 可作范例）

```js
export function registerNovelRoutes(app) {
  app.get('/api/novels', async (ctx) => ctx.json({ ok: true, novels: [...] }));
  app.post('/api/novels/:id/outline', async (ctx) => {
    const body = (await ctx.body()) || {};
    ctx.json({ ok: true, ... });
  });
}
```
`ctx` 提供：`params`、`query`、`await ctx.body()`（JSON/表单/multipart 自动解析，文件在 `ctx.files`）、`ctx.json(obj, status)`、`ctx.text()`、`ctx.sendFile(abs)`。异常用 `badRequest()/notFound()` 抛出，框架会转成 JSON 错误。

## 三、已建好的数据表（`src/db.js` 中的 SCHEMA，直接用，不要改表结构；缺列用 `ALTER TABLE ADD COLUMN` 需在 `migrate()` 之外自行容错）

- 模块2：`novels`（id,title,genre,sub_genre,tone,scale,cast_size,target_words,chapter_words,pov,framework_intro,actor_ids,custom_actors,ref_doc_path,ref_doc_name,style_id,seasons,status,meta,created_at,updated_at）
- `novel_outlines`（id,novel_id,version,status,payload,raw,model,tokens,elapsed_ms,created_at,updated_at）
- `novel_chapters`（id,novel_id,outline_id,idx,volume,title,summary,content,words,hook,cliffhanger,characters,locations,status,model,tokens,error,created_at,updated_at）
- 模块3：`scripts`（id,novel_id,title,format,style_id,episode_seconds,episodes_per_season,seasons,skill_doc_path,skill_doc_name,options,plan,status,created_at,updated_at）
- `script_episodes`（id,script_id,season,episode,code,title,logline,hook,cliffhanger,duration,source_chapters,scenes,status,created_at,updated_at）
- `shots`（id,script_id,episode_id,idx,scene_no,location_id,time_of_day,shot_size,camera,move,transition,duration,action,dialogue,sfx,music,mood,prompt_pos,prompt_neg,refs,cost_level,status,created_at）

ID 前缀约定：小说 `N-0001`（`nextId('N','novel')`），大纲 `O-0001`（`nextId('O','outline')`），章节 `CH-0001`（`nextId('CH','chapter')`），剧本 `SC-0001`，集 `EP-0001`，镜头 `SH-0001`，地点 `L-0001`，道具 `I-0001`。

## 四、前端视图约定（关键，必须严格遵守）

`web/views/novel.js` 与 `web/views/script.js` 各导出：

```js
export function mount(root, ctx) { /* root: HTMLElement，渲染整个模块界面 */ }
export function unmount() { /* 清理定时器/事件 */ }
```

`ctx` 只提供以下成员（**只准用这些，不要 import 其它 web/lib 文件**，避免耦合）：

| 成员 | 说明 |
|---|---|
| `ctx.api.get(path)` / `.post(path, body)` / `.put(path, body)` / `.del(path)` | 相对路径即可（如 `/api/novels`），内部已处理 JSON 与错误抛出；`post` 默认 JSON |
| `ctx.api.upload(file, filename?)` | 上传单个 File，返回 `{path,name,size}`（走 `/api/upload`） |
| `ctx.meta` | `/api/meta` 的缓存对象（含 `styles/genres/genreCategories/povs/tones/scales/outlineSections/scriptFormats/shotSizes/cameraMoves/costLevels/limits`），可能是 `null`（自行兜底） |
| `ctx.toast(msg, type?)` | `type`: `info`\|`ok`\|`err` |
| `ctx.confirm(msg)` | → `Promise<boolean>` |
| `ctx.modal({title, body, width?})` | `body` 为 HTMLElement 或 HTML 字符串，返回 `{ close() }` |
| `ctx.watchJob(jobId, onUpdate)` | 轮询任务，`onUpdate(job)` 每次状态变化回调（`job.status/progress/result/error`），返回停止函数 |
| `ctx.go(moduleId)` | 切到其它模块（`actors`/`novel`/`script`/`settings`） |

样式要求：所有类名加前缀（模块2 用 `nv-`，模块3 用 `sc-`），并在 `mount()` 里注入自己的 `<style>`（用唯一 id 判断避免重复注入）。使用项目 CSS 变量：`--bg --panel --panel-2 --line --text --muted --accent --accent-2 --ok --warn --err --radius`。

## 五、测试要求（务必自测通过再交付）

1. **不要污染主库**：测试时用独立 DB —— `FACTORY_DB=/tmp/test-novel.db PORT=8891 node ...`。
2. 推荐一次性自测脚本（写在 `tests/` 下，命名 `test-novel.js` / `test-script.js`，用 Node 原生 `node:test` 或断言）：
```bash
cd /home/linsheng/Desktop/ai-video-factory
FACTORY_DB=/tmp/t2.db PORT=8891 timeout 60 node -e "
process.env.FACTORY_DB='/tmp/t2.db';
const {createServer,createApp}=await import('./src/http.js');
const {migrate}=await import('./src/db.js');
const {registerNovelRoutes}=await import('./src/routes/novel.js');
migrate(); const {app,handle}=createApp(); registerNovelRoutes(app);
const s=createServer((q,r)=>handle(q,r,{staticMounts:[]})); s.listen(8891);
// ... fetch 断言 ...
s.close(); process.exit(0);
" --input-type=module
```
3. LLM 真实调用：测试时最多允许 **1~2 次真实调用**（DeepSeek Key 已配置在 `~/.dsh/.credentials.yaml`，`loadConfig()` 会自动取用）；其余用 `provider: 'mock'`（`saveConfig({llm:{provider:'mock'}})` 会写坏主配置 —— **不要这么做**，改为在测试里给请求体传 `provider:'mock'` 之类的方式，或只测非 LLM 分支）。**禁止修改 `config/config.json`**。
4. 所有 LLM 交互必须包 `try/catch`，失败时返回明确中文错误，且不得让任务把服务打崩。

## 六、文件所有权（避免互相覆盖）

| 归属 | 文件 |
|---|---|
| 模块2 | `src/modules/novel.js`、`src/routes/novel.js`、`web/views/novel.js`、`tests/test-novel.js`、`docs/模块2-使用说明.md` |
| 模块3 | `src/modules/script.js`、`src/routes/script.js`、`src/data/shotgrammar.js`、`src/data/scriptskills.js`、`web/views/script.js`、`tests/test-script.js`、`docs/模块3-使用说明.md` |
| 主控（不要动） | `server.js`、`src/{db,http,llm,jobs,config,util,prompts,image}.js`、`src/routes/{actors,meta}.js`、`src/modules/actors.js`、`src/data/{styles,genres,dictionaries}.js`、`web/{index.html,app.js,styles.css}`、`web/lib/*`、`web/views/{actors,settings}.js`、`config/config.json` |
