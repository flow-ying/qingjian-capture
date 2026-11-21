'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultCandidates(vault) {
  const out = [];
  if (process.env.QUOTA_TRACKER_SCRIPT) out.push(process.env.QUOTA_TRACKER_SCRIPT);
  out.push(path.join(os.homedir(), 'Documents', 'Obsidian-External', 'Tooling', 'quota-tracker', 'quota.py'));
  if (typeof vault === 'string' && vault) {
    out.push(path.resolve(vault, '..', 'Obsidian-External', 'Tooling', 'quota-tracker', 'quota.py'));
  }
  return [...new Set(out)];
}

function execQuotaScript(scriptPath) {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const runOnce = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true, env }, (err, stdout, stderr) => {
      if (err) {
        if (stderr && !String(err.message).includes(stderr)) err.message = `${err.message}: ${stderr.trim()}`;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
  return runOnce('python', [scriptPath, 'status', '--json']).catch((err) => {
    if (err && err.code === 'ENOENT' && process.platform === 'win32') {
      return runOnce('py', ['-3', scriptPath, 'status', '--json']);
    }
    throw err;
  });
}

function createQuotaClient({ vault, scriptPath, fixturePath, runner, ttlMs = 60000 } = {}) {
  let lastResult = null;
  let lastAt = 0;
  let inflight = null;

  async function fetchNow() {
    const fixture = fixturePath ?? process.env.QUOTA_TRACKER_FIXTURE;
    if (fixture) {
      try {
        if (!fs.existsSync(fixture)) return { available: false, status: null, fetchedAt: null, error: '' };
        const parsed = JSON.parse(fs.readFileSync(fixture, 'utf8'));
        return { available: true, status: parsed, fetchedAt: new Date().toISOString(), error: '' };
      } catch (e) {
        return {
          available: Boolean(lastResult?.status),
          status: lastResult?.status || null,
          fetchedAt: lastResult?.fetchedAt || null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    const candidates = scriptPath ? [scriptPath] : defaultCandidates(vault);
    const resolved = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!resolved) return { available: false, status: null, fetchedAt: null, error: '' };

    try {
      const raw = await (runner ? runner(resolved) : execQuotaScript(resolved));
      const status = JSON.parse(raw);
      if (!status || typeof status !== 'object' || !status.pools) throw Error('算力 JSON 格式无效');
      return { available: true, status, fetchedAt: new Date().toISOString(), error: '' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (lastResult?.status) {
        return {
          available: true,
          status: lastResult.status,
          fetchedAt: lastResult.fetchedAt,
          error: `刷新失败，保留上次快照：${msg}`,
        };
      }
      return { available: false, status: null, fetchedAt: null, error: msg };
    }
  }

  return {
    peek() {
      return lastResult;
    },
    get(force = false) {
      if (!force && lastResult && Date.now() - lastAt < ttlMs) return Promise.resolve(lastResult);
      if (inflight) return inflight;
      inflight = fetchNow().then((res) => {
        lastResult = res;
        lastAt = Date.now();
        return res;
      }).finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}

module.exports = { createQuotaClient };
