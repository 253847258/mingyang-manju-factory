// 前端 API 封装
async function request(method, path, body, opts = {}) {
  const init = { method, headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: res.ok, raw: text }; }
  if (!res.ok || data.ok === false) {
    const msg = data.error || data.message || `请求失败（HTTP ${res.status}）`;
    const err = new Error(msg);
    err.status = res.status; err.detail = data.detail; err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
  del: (p) => request('DELETE', p),
  raw: request,
  /** 上传单个 File → {path,name,size} */
  async upload(file, extra = {}) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const r = await request('POST', '/api/upload', fd);
    return r.files?.[0] || null;
  },
  /** 读取已上传文本文件内容 */
  readText: (path) => request('GET', `/api/upload/text?path=${encodeURIComponent(path)}`),
  /** 轮询任务直到结束 */
  watchJob(jobId, onUpdate, { interval = 1200, onDone } = {}) {
    let stopped = false;
    let timer = null;
    const tick = async () => {
      if (stopped) return;
      try {
        const { job } = await api.get(`/api/jobs/${jobId}`);
        onUpdate?.(job);
        if (job && ['done', 'error', 'canceled'].includes(job.status)) {
          stopped = true;
          onDone?.(job);
          return;
        }
      } catch (e) { onUpdate?.({ status: 'error', error: e.message }); stopped = true; return; }
      timer = setTimeout(tick, interval);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  },
  /** SSE 订阅（不支持时静默失败） */
  subscribeJobs(onJob) {
    try {
      const es = new EventSource('/api/jobs-stream');
      es.onmessage = (ev) => { try { onJob(JSON.parse(ev.data)); } catch { /* ignore */ } };
      es.onerror = () => { /* 自动重连或忽略 */ };
      return () => es.close();
    } catch { return () => {}; }
  },
  fileUrl: (relPath) => (relPath ? '/' + String(relPath).replace(/^\/+/, '') : ''),
};
