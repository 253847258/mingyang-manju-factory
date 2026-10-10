# 技能（Skills）目录

把「怎么把工具串成一件正事」写成**声明式文件**，引擎读它驱动流水线（来源：OpenClaw 的 Skills 优先范式，见 `docs/智能Claw研究报告.md`）。

## 格式（`*.skill.json`）

```json
{
  "id": "my-skill",
  "name": "技能名（中文）",
  "desc": "一句话说明",
  "format": "duanju | manju",
  "ratio": "9:16",
  "episodes": 3,
  "episodeSeconds": 60,
  "castSize": 6,
  "stages": ["brief", "cast", "novel", "script", "canvas", "keyframe", "video", "finish", "qc", "deliver"],
  "params": { "chaptersToWrite": 0, "reuseActors": false }
}
```

- `stages`：只用 `src/studio.js` 里的十个阶段 id，顺序即执行顺序；**付费阶段（`keyframe` / `video`）无论如何都会停下等人工批准**，技能文件改不了这条红线。
- 放在本目录或 `data/skills/` 下都会被加载；同 `id` 覆盖内置技能。
- 用法：`POST /api/studio/productions { "brief": "...", "skill": "my-skill" }`，或 `GET /api/skills` 查看全部可用技能。
