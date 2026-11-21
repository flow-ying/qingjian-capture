'use strict';
const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { address } = require('../standalone/task-graph-client.cjs');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'artifacts', 'quota-native-' + Date.now());
const identity = path.join(dir, 'identity');
const fixtureFile = path.join(dir, 'quota-fixture.json');
fs.mkdirSync(dir, { recursive: true });

const quotaFixture = {
  now: '2026-11-21T17:20+0900',
  primary: 'A1',
  relay: 'A2',
  order: ['A1', 'A2', 'B'],
  digest: {
    date: '2026-11-21',
    landed: true,
    landedAt: '2026-11-21T14:39+0900',
    hasChange: true,
    headline: 'Gemini 4 Neon 缓存池扩容待实测',
    handled: false,
    pendingReview: true,
  },
  pools: {
    B: {
      label: '官方 Claude Pro',
      note: '',
      hoursToReset: 126.5,
      reservePct: 0,
      phase: '平稳期',
      weekly: { resetsAt: '2026-11-27T00:00+0900', u: 48.2, capacity: 98.8, lowerBound: true, observedAt: null, usedPct: 48.8, confidence: 'estimated' },
      fiveHour: { resetsAt: '2026-11-21T19:00+0900', u: 15.7, capacity: null, lowerBound: true, observedAt: null, usedPct: null, confidence: 'unknown' },
      burn: { elapsedPct: 24.4, targetDays: 5.5, targetPct: 100, targetUsedNowPct: 31.1, ratio: 1.57, dailyBudgetPct: 13.5, warn: 'fast' },
      exhausted: false,
    },
    A2: {
      label: 'Ultra · Claude/GPT',
      note: '',
      hoursToReset: 95.2,
      reservePct: 0,
      phase: '平稳期',
      weekly: { resetsAt: '2026-11-25T16:34+0900', u: 3.2, capacity: null, lowerBound: true, observedAt: '2026-11-19T18:07+0900', usedPct: 60.0, confidence: 'anchor-only' },
      burn: { elapsedPct: 43.1, targetDays: 5.5, targetPct: 100, targetUsedNowPct: 54.9, ratio: 1.09, dailyBudgetPct: 16.1 },
      exhausted: false,
    },
    A1: {
      label: 'Ultra · Gemini',
      note: '',
      hoursToReset: 92.8,
      reservePct: 12.0,
      phase: '平稳期',
      weekly: { resetsAt: '2026-11-25T14:01+0900', u: 69.6, capacity: null, lowerBound: true, observedAt: '2026-11-19T18:07+0900', usedPct: 99.0, confidence: 'anchor-only+' },
      burn: { elapsedPct: 44.7, targetDays: 6.0, targetPct: 88, targetUsedNowPct: 45.9, ratio: 2.1, dailyBudgetPct: 0 },
      exhausted: true,
    },
    C: {
      label: 'X Premium / Grok',
      note: '',
      hoursToReset: 74.9,
      reservePct: 0,
      phase: '平稳期',
      weekly: { resetsAt: '2026-11-24T20:12+0900', u: 0, capacity: null, lowerBound: false, observedAt: '2026-11-19T18:10+0900', usedPct: 8.0, confidence: 'anchor-only' },
      burn: { elapsedPct: 55.3, targetDays: 5.5, targetPct: 100, targetUsedNowPct: 70.3, ratio: 0.11, dailyBudgetPct: 56.4, warn: 'slow' },
      exhausted: false,
      advice: { state: 'open', text: '可放开用', reservePct: 8.0 },
    },
  },
  tips: ['今日 X 日报有实质变动待核实入表', 'B 超速', 'C 偏慢'],
  uncalibrated: ['A2', 'C'],
};
fs.writeFileSync(fixtureFile, JSON.stringify(quotaFixture));

const graph = {
  id: 'g1',
  projectId: 'p1',
  revision: 1,
  title: '路由 · 多节点与算力路由测试',
  nodes: [
    {
      id: 'n_done',
      title: '已完成节点',
      summary: '原问题：已完成\n【首选：Claude Desktop · Claude Sonnet 5.5 ｜ 平替：Antigravity · Gemini 4 Neon ｜ 用量：S · B】',
      description: 'done',
      status: 'done',
    },
    {
      id: 'n_b_todo',
      title: 'B池超速待做',
      summary: '原问题：需从 B 改走 A2\n【首选：Claude Desktop (Code 页签) · Claude Sonnet 5.5 (medium) ｜ 平替：Antigravity · Claude Opus 5.5 (High) ｜ 用量：M · B】',
      description: 'todo B',
      status: 'todo',
    },
    {
      id: 'n_nocl',
      title: '禁Claude待做',
      summary: '原问题：A1 耗尽但禁派 Claude\n【首选：Antigravity · Gemini 4 Neon (Medium) ｜ 平替：Claude Desktop · Opus / Grok · Grok 4.7 (Think) ｜ 用量：M · A1 ｜ 禁派全系 Claude】',
      description: 'todo no claude',
      status: 'todo',
    },
  ],
  edges: [{ from: 'n_done', to: 'n_b_todo' }, { from: 'n_done', to: 'n_nocl' }],
};

const wait = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timed out');
};

let app, server;
const errors = [];

(async () => {
  server = net.createServer((s) => {
    s.on('error', () => {});
    s.setEncoding('utf8');
    let text = '';
    s.on('data', (chunk) => {
      text += chunk;
      if (!text.includes('\n')) return;
      const { name, args } = JSON.parse(text.split('\n')[0]);
      let data;
      if (name === 'task_graph_list_projects') data = { projects: [{ id: 'p1', name: '测试项目' }] };
      else if (name === 'task_graph_list_graphs') data = { graphs: [{ id: graph.id, title: graph.title, projectId: 'p1', revision: graph.revision, nodeCount: graph.nodes.length }], errors: [] };
      else data = require('./graph-rpc-fixture.cjs')(graph, name, args);
      s.end(JSON.stringify({ ok: true, data }) + '\n');
    });
  });
  await new Promise((r) => server.listen(address(identity), r));

  // Run 1: With quota fixture active
  app = await _electron.launch({
    args: [path.join(root, 'dist/desktop-capture'), '--vault=' + identity, '--qa-root=' + dir, '--open-task-graph'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, QUOTA_TRACKER_FIXTURE: fixtureFile },
  });
  await wait(async () => await app.evaluate(() => Boolean(globalThis.captureQA?.taskGraph.getWindow())));
  let p;
  await wait(async () => { p = (await app.windows()).find((w) => w.url().endsWith('/ui/graph.html')); return !!p; });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.waitForSelector('.node');

  await p.locator('#quota-bar:not([hidden]) .q-chip').first().waitFor();
  assert.equal(await p.locator('#quota-bar .q-chip').count(), 4);
  assert.equal(await p.locator('#quota-bar .q-digest-pill').isVisible(), true);

  // Verify orb window also received digestPending
  const orbWin = (await app.windows()).find((w) => w.url().endsWith('/ui/orb.html'));
  assert.ok(orbWin);
  await wait(async () => await orbWin.evaluate(() => document.body.dataset.digest === 'pending'));

  // Verify card dynamic overrides
  const doneBadgeHidden = await p.locator('[data-id="n_done"] .node-override').isHidden();
  assert.equal(doneBadgeHidden, true);
  const bBadgeText = await p.locator('[data-id="n_b_todo"] .node-override').textContent();
  assert.match(bBadgeText, /A2 池/);
  const ncBadgeText = await p.locator('[data-id="n_nocl"] .node-override').textContent();
  assert.match(ncBadgeText, /C 池/);
  assert.doesNotMatch(ncBadgeText, /\b(B|A2)\s*池/);

  // Open detail on n_nocl, verify override callout & mocked copy
  await app.evaluate(({ clipboard }) => {
    globalThis.qCopies = [];
    clipboard.writeText = (t) => globalThis.qCopies.push(t);
  });
  await p.locator('[data-id="n_nocl"] .node-open').click();
  await p.locator('#detail .override-callout').waitFor();
  assert.match(await p.locator('#detail .override-callout').textContent(), /C 池 Grok 4\.7/);
  await p.locator('#copy').click();
  await wait(async () => (await p.locator('#copy').textContent()) === '已复制');
  assert.match(await app.evaluate(() => globalThis.qCopies.at(-1)), /实时算力参考.*C 池 Grok 4\.7/);
  await p.keyboard.press('Escape');

  // Open quota popover & test copy buttons & Esc close
  await p.locator('#quota-toggle').click();
  await p.locator('#quota-popover:not([hidden])').waitFor();
  assert.equal(await p.locator('#quota-popover .q-pool-card').count(), 4);
  await p.locator('#quota-popover .q-digest .q-copy-btn').click();
  await wait(async () => (await app.evaluate(() => globalThis.qCopies.at(-1))).includes('ack-digest 2026-11-21'));
  await p.locator('#quota-popover .q-foot .q-copy-btn').click();
  await wait(async () => (await app.evaluate(() => globalThis.qCopies.at(-1))).includes('--logged-share'));
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('#quota-popover').isHidden(), true);

  await app.evaluate(() => globalThis.captureQA.quit());
  await app.close();
  app = null;

  // Run 2: Missing script path -> quiet degradation, hidden quota-bar, zero errors
  const dir2 = path.join(root, 'artifacts', 'quota-missing-' + Date.now());
  fs.mkdirSync(dir2, { recursive: true });
  app = await _electron.launch({
    args: [path.join(root, 'dist/desktop-capture'), '--vault=' + identity, '--qa-root=' + dir2, '--open-task-graph'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, QUOTA_TRACKER_SCRIPT: path.join(dir2, 'nonexistent.py') },
  });
  await wait(async () => await app.evaluate(() => Boolean(globalThis.captureQA?.taskGraph.getWindow())));
  let p2;
  await wait(async () => { p2 = (await app.windows()).find((w) => w.url().endsWith('/ui/graph.html')); return !!p2; });
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.waitForSelector('.node');
  await p2.waitForTimeout(400);
  assert.equal(await p2.locator('#quota-bar').isHidden(), true);
  assert.deepEqual(errors, []);
  await app.evaluate(() => globalThis.captureQA.quit());
  await app.close();
  app = null;
  fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({ passed: true, errors }, null, 2));
  console.log('QUOTA_NATIVE_PASS', dir);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(async () => {
  if (app) { await app.evaluate(() => globalThis.captureQA?.quit()).catch(() => {}); await app.close().catch(() => {}); }
  if (server) server.close();
});
