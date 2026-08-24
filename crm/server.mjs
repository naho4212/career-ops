#!/usr/bin/env node
/**
 * crm/server.mjs — local web CRM for career-ops.
 *
 * Why a local server and not a hosted page: the two things this UI exists to do
 * — write a status back to data/applications.md, and run scan.mjs — both need
 * filesystem and process access. A static page on GitHub Pages can do neither.
 * Binding to 127.0.0.1 keeps the tracker (which holds recruiter names, phone
 * numbers, and comp targets) off the network entirely.
 *
 * Reads and writes go through the repo's own tracker-parse/tracker-utils, the
 * same modules merge-tracker.mjs uses, so this can't drift from the CLI path.
 *
 * Run:  node crm/server.mjs [--port 7788]
 */

import http from 'node:http';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import {
  rebuildRow,
  writeFileAtomic,
  acquireTrackerLock,
  trackerLockDirFor,
} from '../tracker-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// CAREER_OPS_ROOT lets the server run against another checkout (tests, a
// second profile) without editing this file. Default: the repo this lives in.
const ROOT = process.env.CAREER_OPS_ROOT
  ? path.resolve(process.env.CAREER_OPS_ROOT)
  : path.resolve(HERE, '..');
const TRACKER = path.join(ROOT, 'data', 'applications.md');
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const STATES = path.join(ROOT, 'templates', 'states.yml');

const portArgIdx = process.argv.indexOf('--port');
const PORT = portArgIdx > -1 ? Number(process.argv[portArgIdx + 1]) : 7788;

// ── Canonical statuses ───────────────────────────────────────────────
// states.yml is the shared source of truth for the writer (career-ops) and
// every reader (Go TUI, this CRM). Never hardcode the list.
function loadStates() {
  const doc = yaml.load(readFileSync(STATES, 'utf8'));
  const list = Array.isArray(doc?.states) ? doc.states : [];
  return list.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description || '',
    group: s.dashboard_group || s.id,
  }));
}
const STATE_LIST = loadStates();
const VALID_LABELS = new Set(STATE_LIST.map((s) => s.label));

// ── Tracker read ─────────────────────────────────────────────────────
function readTracker() {
  // A fresh clone has no tracker until the first evaluation (or onboarding
  // Step 4) creates it. Serve an empty board rather than a 500 so the CRM is
  // usable from the first minute; the UI's empty state explains the next step.
  if (!existsSync(TRACKER)) return { rows: [], lines: [], colmap: null, missing: true };
  const content = readFileSync(TRACKER, 'utf8');
  const lines = content.split('\n');
  const colmap = resolveColumns(lines);
  const rows = [];
  lines.forEach((line, i) => {
    const row = parseTrackerRow(line, colmap);
    if (row) rows.push({ ...row, line: i });
  });
  return { rows, lines, colmap };
}

function pipelinePending() {
  if (!existsSync(PIPELINE)) return 0;
  return readFileSync(PIPELINE, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- [ ] ')).length;
}

/**
 * Resolve a tracker report link to a file on disk.
 *
 * Two link styles coexist in this tracker: 143 rows use "../reports/…"
 * (relative to data/, the style merge-tracker.mjs writes today) and 106 older
 * rows use "reports/…" (relative to the repo root). Rather than rewrite the
 * tracker, try both bases and confine the result to ROOT so a crafted link
 * can't escape the project.
 */
function resolveReport(link) {
  const m = /\(([^)]+)\)/.exec(link || '');
  if (!m) return null;
  for (const base of [path.dirname(TRACKER), ROOT]) {
    const resolved = path.resolve(base, m[1]);
    if (!resolved.startsWith(ROOT + path.sep)) continue;
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

// ── Tracker write ────────────────────────────────────────────────────
// One backup per server run, before the first mutation.
let backedUp = false;
function backupOnce() {
  if (backedUp) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = path.join(ROOT, 'data', `applications.md.crm-${stamp}.bak`);
  if (!existsSync(dest)) copyFileSync(TRACKER, dest);
  backedUp = true;
}

/**
 * Replace one row's status cell.
 *
 * Matched on num AND company AND role: num alone would be enough today, but
 * requiring the client to echo back what it displayed turns a stale browser tab
 * into a rejected write instead of a silent edit to the wrong row.
 */
async function updateStatus({ num, company, role, status }) {
  if (!VALID_LABELS.has(status)) {
    return { ok: false, error: `"${status}" is not a canonical status` };
  }

  // v1.22.0 introduced a shared tracker lock that merge-tracker.mjs and
  // set-status.mjs both take. Without it, a skip clicked here could interleave
  // with a CLI write and lose one of the two edits.
  let lock;
  try {
    lock = await acquireTrackerLock(trackerLockDirFor(TRACKER), { tracker: TRACKER });
  } catch (err) {
    return {
      ok: false,
      error: err?.code === 'LOCK_TIMEOUT'
        ? 'Tracker is locked by another career-ops process. Try again in a moment.'
        : `Cannot acquire tracker lock: ${err.message}`,
    };
  }
  try {
    return updateStatusLocked({ num, company, role, status });
  } finally {
    lock.release();
  }
}

function updateStatusLocked({ num, company, role, status }) {
  const { lines, colmap } = readTracker();

  let target = -1;
  for (let i = 0; i < lines.length; i++) {
    const row = parseTrackerRow(lines[i], colmap);
    if (!row || row.num !== num) continue;
    if (row.company !== company || row.role !== role) {
      return {
        ok: false,
        error: 'Row changed on disk since this page loaded. Reload and retry.',
      };
    }
    target = i;
    break;
  }
  if (target === -1) return { ok: false, error: `No row #${num} in the tracker` };

  const parts = lines[target].split('|').map((s) => s.trim());
  const previous = parts[colmap.status];
  if (previous === status) return { ok: true, previous, unchanged: true };

  backupOnce();
  parts[colmap.status] = status;
  const rebuilt = rebuildRow(parts);

  // Round-trip guard: if the rebuilt line no longer parses to the same row
  // identity, something is off — leave the file untouched.
  const check = parseTrackerRow(rebuilt, colmap);
  if (!check || check.num !== num || check.company !== company || check.role !== role) {
    return { ok: false, error: 'Rewrite failed its round-trip check; file untouched' };
  }

  lines[target] = rebuilt;
  writeFileAtomic(TRACKER, lines.join('\n'));
  return { ok: true, previous };
}

// ── Tools ────────────────────────────────────────────────────────────
// Strict whitelist, spawned without a shell. Nothing from the request reaches
// argv — the client sends a key, never a command.
const TOOLS = {
  scan: { label: 'Run scan', argv: ['scan.mjs'], blurb: 'Search portals for new roles' },
  verify: { label: 'Verify pipeline', argv: ['verify-pipeline.mjs'], blurb: 'Health-check the tracker' },
  merge: { label: 'Merge tracker', argv: ['merge-tracker.mjs'], blurb: 'Fold in pending TSV additions' },
  dedup: { label: 'Dedup tracker', argv: ['dedup-tracker.mjs'], blurb: 'Collapse duplicate rows' },
  patterns: { label: 'Analyze patterns', argv: ['analyze-patterns.mjs'], blurb: 'Rejection + targeting analysis' },
  followup: { label: 'Follow-up cadence', argv: ['followup-cadence.mjs'], blurb: 'Who is overdue a nudge' },
};

function streamTool(key, res) {
  const tool = TOOLS[key];
  if (!tool) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Unknown tool');
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { label: tool.label });

  const child = spawn(process.execPath, tool.argv, { cwd: ROOT });
  const pump = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const line of parts) send('line', line);
    });
    stream.on('end', () => { if (buf) send('line', buf); });
  };
  pump(child.stdout);
  pump(child.stderr);

  child.on('close', (code) => { send('done', { code }); res.end(); });
  child.on('error', (err) => { send('line', `Failed to start: ${err.message}`); send('done', { code: 1 }); res.end(); });
  res.on('close', () => child.kill());
}

// ── HTTP ─────────────────────────────────────────────────────────────
function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = readFileSync(path.join(HERE, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/api/state') {
      const { rows, missing } = readTracker();
      const counts = {};
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
      return json(res, 200, {
        applications: rows.map(({ raw, line, ...r }) => r),
        states: STATE_LIST,
        counts,
        pending: pipelinePending(),
        trackerMissing: Boolean(missing),
        tools: Object.entries(TOOLS).map(([k, v]) => ({ key: k, label: v.label, blurb: v.blurb })),
      });
    }

    if (url.pathname === '/api/status' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await updateStatus({
        num: Number(body.num),
        company: String(body.company ?? ''),
        role: String(body.role ?? ''),
        status: String(body.status ?? ''),
      });
      return json(res, result.ok ? 200 : 409, result);
    }

    if (url.pathname === '/api/report') {
      const { rows } = readTracker();
      const row = rows.find((r) => r.num === Number(url.searchParams.get('num')));
      const file = row ? resolveReport(row.report) : null;
      if (!file) return json(res, 404, { error: 'No report on file for this role' });
      return json(res, 200, { markdown: readFileSync(file, 'utf8'), path: path.relative(ROOT, file) });
    }

    if (url.pathname === '/api/tool') {
      return streamTool(url.searchParams.get('name'), res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`career-ops CRM  →  http://127.0.0.1:${PORT}`);
  console.log(`Tracker: ${path.relative(process.cwd(), TRACKER)}`);
  console.log('Bound to localhost only. Ctrl-C to stop.');
});
