// @ts-check
// Live helpers and background jobs: one row each, with status, elapsed time and
// (for helpers) the report that came back. The panel is event-driven — the
// harness emits helper_start/helper_end (a helper run) and subagent_start/end
// (the SUBAGENT marker, foreground or background), plus job_start/job_end for
// background commands. Nothing here asks the backend; it only paints what the
// run already told it.
export function createHelpersPanel(/** @type {any} */ ctx) {
  const { el, $ } = ctx;
  const list = () => $('helpers');
  const section = () => $('helpers-section');
  const count = () => $('helpers-count');

  // id -> { id, kind, role, task, status, startedAt, ms, steps, estTokens,
  //         prepared, skipped, summary, timer }
  const items = new Map();

  function fmtMs(/** @type {any} */ ms) {
    if (ms == null) return '';
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  }

  function badge(/** @type {any} */ kind, /** @type {any} */ role) {
    if (kind === 'job') return 'job';
    return role || 'helper';
  }

  function renderRow(/** @type {any} */ item) {
    const li = el('li', 'helper-row' + (item.status === 'error' ? ' bad' : ''));
    const head = el('div', 'helper-head');
    head.append(el('span', 'helper-badge', badge(item.kind, item.role)));
    head.append(el('span', 'helper-task', String(item.task || '').slice(0, 80)));
    const st = el('span', 'helper-status', item.status === 'running' ? 'กำลังรัน…' : item.status === 'error' ? 'ผิดพลาด' : item.status === 'stopped' ? 'หยุดแล้ว' : 'เสร็จ');
    head.append(st);
    li.append(head);

    const meta = el('div', 'helper-meta');
    const parts = [];
    if (item.status === 'running') parts.push(`⏱ ${fmtMs(Date.now() - item.startedAt)}`);
    else if (item.ms != null) parts.push(`⏱ ${fmtMs(item.ms)}`);
    if (item.steps) parts.push(`${item.steps} step`);
    if (item.estTokens) parts.push(`~${Number(item.estTokens).toLocaleString()} tok`);
    if (item.prepared?.length) parts.push(`เตรียม ${item.prepared.length} ไฟล์`);
    if (item.skipped?.length) parts.push(`ข้าม ${item.skipped.length} ไฟล์`);
    meta.textContent = parts.join(' · ');
    li.append(meta);

    if (item.summary && item.status !== 'running') {
      const sum = el('div', 'helper-summary');
      sum.textContent = String(item.summary).slice(0, 400);
      li.append(sum);
    }
    return li;
  }

  function paint() {
    const ul = list();
    if (!ul) return;
    ul.textContent = '';
    const arr = [...items.values()];
    // running first, then newest first
    arr.sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || (b.startedAt - a.startedAt));
    for (const it of arr) ul.append(renderRow(it));
    const sec = section();
    if (sec) sec.hidden = arr.length === 0;
    const c = count();
    if (c) c.textContent = arr.length ? String(arr.length) : '';
  }

  // tick elapsed time while anything is running
  /** @type {any} */
  let ticker = null;
  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if ([...items.values()].some((i) => i.status === 'running')) paint();
    }, 1000);
  }

  function addHelper(/** @type {any} */ data) {
    const id = data?.id || `h${items.size + 1}`;
    items.set(id, {
      id, kind: 'helper', role: data?.role || null,
      task: data?.task || '', status: 'running',
      startedAt: Date.now(), ms: null, steps: 0, estTokens: null,
      prepared: [], skipped: [], summary: null,
    });
    ensureTicker();
    paint();
  }

  function updateHelper(/** @type {any} */ data) {
    const id = data?.id;
    if (!id || !items.has(id)) {
      // no matching start (e.g. missed frame) — create a finished row
      items.set(id || `h${items.size + 1}`, {
        id: id || `h${items.size + 1}`, kind: 'helper', role: data?.role || null,
        task: data?.task || '', status: data?.error ? 'error' : 'done',
        startedAt: Date.now(), ms: data?.ms ?? null, steps: data?.steps ?? 0,
        estTokens: data?.estTokens ?? null, prepared: data?.prepared || [],
        skipped: data?.skipped || [], summary: data?.summary || data?.out || null,
      });
    } else {
      const it = items.get(id);
      it.status = data?.error ? 'error' : 'done';
      it.ms = data?.ms ?? it.ms;
      it.steps = data?.steps ?? it.steps;
      it.estTokens = data?.estTokens ?? it.estTokens;
      it.prepared = data?.prepared || it.prepared;
      it.skipped = data?.skipped || it.skipped;
      it.summary = data?.summary || data?.out || it.summary;
    }
    paint();
  }

  function addJob(/** @type {any} */ data) {
    const id = data?.id || `job${items.size + 1}`;
    items.set(id, {
      id, kind: 'job', role: null, task: data?.command || data?.task || '',
      status: 'running', startedAt: Date.now(), ms: null, steps: 0,
      estTokens: null, prepared: [], skipped: [], summary: null,
    });
    ensureTicker();
    paint();
  }

  function updateJob(/** @type {any} */ data) {
    const id = data?.id;
    if (!id || !items.has(id)) return;
    const it = items.get(id);
    it.status = data?.stopped ? 'stopped' : (data?.code === 0 ? 'done' : 'error');
    it.ms = data?.ms ?? it.ms;
    it.summary = data?.stopped ? 'stopped' : (data?.code != null ? `exit ${data.code}` : it.summary);
    paint();
  }

  function clear() { items.clear(); paint(); }

  // initial paint (empty -> hidden)
  paint();

  return { addHelper, updateHelper, addJob, updateJob, clear, paint };
}
