// 小说工坊 · 故事框架 AI 自动填写路由（plain text module）

import { badRequest } from '../http.js';
import { generateFrameworkProposal, commitCharacters } from '../novel-ai.js';

export function registerNovelAiRoutes(app) {
  app.post('/api/novels/ai/framework', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const proposal = await generateFrameworkProposal(body);
      ctx.json(proposal);
    } catch (err) {
      throw badRequest(err.message || 'AI 生成故事框架失败');
    }
  });

  app.post('/api/novels/ai/commit-characters', async (ctx) => {
    try {
      const body = (await ctx.body()) || {};
      const result = await commitCharacters(body);
      ctx.json(result);
    } catch (err) {
      throw badRequest(err.message || '创建演员矩阵角色卡失败');
    }
  });
}
