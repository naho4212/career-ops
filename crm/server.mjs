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
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync, readdirSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { load as yamlLoad } from 'js-yaml';

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
const OUTPUT = path.join(ROOT, 'output');
const PDF_INDEX = path.join(ROOT, 'data', 'pdf-index.tsv');
const PROFILE = path.join(ROOT, 'config', 'profile.yml');
const PORTALS = path.join(ROOT, 'portals.yml');
const BLACKLIST = path.join(ROOT, 'data', 'blacklist.md');

// ── Terminal (optional) ──────────────────────────────────────────────
// node-pty + ws + xterm live in crm/package.json, not the root package.json
// (a system-layer file). If `npm install` hasn't been run in crm/, the
// server still boots and the Terminal tab explains what to do.
const require_ = createRequire(import.meta.url);
let ptyMod = null, WebSocketServer = null, termUnavailable = '';
try {
  ptyMod = require_('node-pty');
  ({ WebSocketServer } = require_('ws'));
} catch (e) {
  termUnavailable = `Terminal disabled: ${e.message.split('\n')[0]} — run \`npm install\` inside crm/`;
}
const VENDOR = {
  '/vendor/xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
};
// Per-launch secret the served page embeds; the WebSocket upgrade requires
// it plus a matching Origin, so no other page or process on the machine can
// open a shell through this server.
const TOKEN = crypto.randomBytes(16).toString('hex');

const portArgIdx = process.argv.indexOf('--port');
const PORT = portArgIdx > -1 ? Number(process.argv[portArgIdx + 1]) : 7788;

// ── CRM update check ─────────────────────────────────────────────────
// The CRM ships through this fork's `origin`, so "is there a newer CRM" is
// "is origin/main ahead of HEAD". Fetch on startup and at most every 10 min
// after; never pull automatically — the Update CRM tool does a --ff-only pull
// when the user asks. Failures (offline, no remote) are silent: behind = 0.
const crmUpdate = { behind: 0, checkedAt: 0, remote: '' };
function git(args, ms = 8000) {
  return new Promise((resolve) => execFile('git', args, { cwd: ROOT, timeout: ms }, (err, out) => resolve(err ? null : out.trim())));
}
async function checkCrmUpdate(force = false) {
  if (!force && Date.now() - crmUpdate.checkedAt < 10 * 60 * 1000) return crmUpdate;
  crmUpdate.checkedAt = Date.now();
  if (!crmUpdate.remote) crmUpdate.remote = (await git(['remote', 'get-url', 'origin'])) || '';
  if (!crmUpdate.remote) return crmUpdate;
  if ((await git(['fetch', '--quiet', 'origin', 'main'], 15000)) === null) return crmUpdate;
  const n = await git(['rev-list', '--count', 'HEAD..origin/main']);
  crmUpdate.behind = Number(n) || 0;
  if (crmUpdate.behind) console.log(`CRM update: origin/main is ${crmUpdate.behind} commit(s) ahead — run \`git pull\` (or Tools → Update CRM) and restart.`);
  return crmUpdate;
}

// ── Canonical statuses ───────────────────────────────────────────────
// states.yml is the shared source of truth for the writer (career-ops) and
// every reader (Go TUI, this CRM). Never hardcode the list.
function loadStates() {
  const doc = yamlLoad(readFileSync(STATES, 'utf8'));
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

function readPending() {
  if (!existsSync(PIPELINE)) return [];
  const out = [];
  for (const l of readFileSync(PIPELINE, 'utf8').split('\n')) {
    const m = /^- \[ \] (.+)$/.exec(l);
    if (!m) continue;
    const [url, company = '', title = ''] = m[1].split('|').map((x) => x.trim());
    out.push({ url, company, title });
  }
  return out;
}
function pipelinePending() { return readPending().length; }

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

// ── Report metadata + PDF resolution ─────────────────────────────────
// The tracker has no URL column; the posting URL lives in each report's
// header (`**URL:** …`). Read the header once per report and cache by mtime
// so /api/state stays cheap across 350+ rows.
const metaCache = new Map();
function reportMeta(row) {
  const file = resolveReport(row.report);
  if (!file) return { url: '', pdfLine: '', reportFile: null };
  const mtime = statSync(file).mtimeMs;
  const hit = metaCache.get(file);
  if (hit && hit.mtime === mtime) return hit.meta;
  const head = readFileSync(file, 'utf8').split('\n').slice(0, 25);
  const grab = (label) => {
    const l = head.find((x) => x.startsWith(`**${label}:**`));
    return l ? l.slice(label.length + 5).trim() : '';
  };
  const meta = { url: grab('URL'), pdfLine: grab('PDF'), reportFile: file };
  metaCache.set(file, { mtime, meta });
  return meta;
}

function reportNum(row) {
  const m = /\[(\d+)\]/.exec(row.report || '');
  return m ? Number(m[1]) : null;
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function insideRoot(p) {
  return p.startsWith(ROOT + path.sep) && existsSync(p);
}

/**
 * Find the CV PDF for a tracker row. Three sources, most authoritative first:
 * 1. data/pdf-index.tsv (written by generate-pdf.mjs --report=N)
 * 2. the report's own `**PDF:** …/output/….pdf` line
 * 3. a company-slug match in output/*.pdf (newest wins)
 * The pdf-index's report column is often blank on older rows, which is why
 * the fallbacks exist. Returns a ROOT-relative path or null.
 */
function explicitPdf(row, meta) {
  const num = reportNum(row);
  if (num != null && existsSync(PDF_INDEX)) {
    for (const line of readFileSync(PDF_INDEX, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [rep, pdf] = line.split('\t');
      if (rep && Number(rep) === num && pdf) {
        const abs = path.resolve(ROOT, pdf);
        if (insideRoot(abs)) return path.relative(ROOT, abs);
      }
    }
  }
  const m = /(?:^|\/)(output\/[^\s)]+\.pdf)/.exec(meta.pdfLine || '');
  if (m) {
    const abs = path.resolve(ROOT, m[1]);
    if (insideRoot(abs)) return path.relative(ROOT, abs);
  }
  return null;
}

/**
 * PDFs some report names explicitly, keyed by ROOT-relative path. A file one
 * report claims is that report's CV; it must never be handed to a sibling row
 * at the same company by the slug fallback (Headway #76 was showing #335's).
 */
function claimedPdfs(rows) {
  const claimed = new Map();
  for (const r of rows) {
    const rel = explicitPdf(r, reportMeta(r));
    if (rel) claimed.set(rel, r.num);
  }
  return claimed;
}

function resolvePdf(row, meta, claimed = new Map()) {
  const explicit = explicitPdf(row, meta);
  if (explicit) return explicit;
  // Slug fallback runs only when the tracker says a CV was generated for this
  // row (PDF column ✅); a ❌ row with a same-company PDF lying around is
  // exactly the mis-attribution case.
  if (!/✅/.test(row.pdf || '')) return null;
  // Slug fallback. A company can have several tracked roles, so only accept a
  // PDF dated on or after this row's evaluation: a CV generated earlier was
  // tailored for a different posting and is the wrong file to upload.
  if (existsSync(OUTPUT)) {
    const s = slug(row.company);
    const since = /\d{4}-\d{2}-\d{2}/.exec(row.report || '')?.[0] || row.date || '';
    if (s) {
      const hits = readdirSync(OUTPUT)
        .filter((f) => f.endsWith('.pdf') && f.includes(`-${s}-`))
        .map((f) => {
          const stamp = /\d{4}-\d{2}-\d{2}/.exec(f)?.[0]
            || statSync(path.join(OUTPUT, f)).mtime.toISOString().slice(0, 10);
          return { f, stamp };
        })
        .filter((h) => !since || h.stamp >= since)
        .filter((h) => !claimed.has(path.join('output', h.f)) || claimed.get(path.join('output', h.f)) === row.num)
        .sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
      if (hits.length) return path.join('output', hits[0].f);
    }
  }
  return null;
}

function rowByNum(url) {
  const { rows } = readTracker();
  return rows.find((r) => r.num === Number(url.searchParams.get('num'))) || null;
}

/** Reveal in the OS file manager. macOS only; elsewhere the caller gets the path. */
function reveal(abs) {
  if (process.platform !== 'darwin') return false;
  spawn('open', ['-R', abs], { stdio: 'ignore', detached: true }).unref();
  return true;
}

// ── Inputs: profile.yml / portals.yml / pipeline.md / blacklist.md ───
// These are user-layer files with hand-written comments. js-yaml round-trips
// drop comments, so every write here is a line-level patch: replace one
// block, leave every other byte alone, then parse the result before writing
// so a bad patch can never leave a file the rest of the system can't load.

const backedUpFiles = new Set();
function backupInput(file) {
  if (backedUpFiles.has(file) || !existsSync(file)) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = `${file}.crm-${stamp}.bak`;
  if (!existsSync(dest)) copyFileSync(file, dest);
  backedUpFiles.add(file);
}

function writeYamlChecked(file, text) {
  yamlLoad(text); // throws on a broken patch — nothing written
  backupInput(file);
  writeFileAtomic(file, text);
}

const q = (v) => JSON.stringify(String(v ?? ''));

/**
 * Find the line range of a YAML block. `pathKeys` walks nested mapping keys by
 * indentation (2 spaces per level): ['target_roles','primary'] matches the
 * `  primary:` line under `target_roles:`. Returns {start, end} where end is
 * the first line after the block (a line at indent <= the key's indent that
 * is not blank/comment), or null when the key is absent.
 */
function findBlock(lines, pathKeys) {
  let indent = 0, from = 0, start = -1;
  for (const key of pathKeys) {
    start = -1;
    for (let i = from; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim() || l.trim().startsWith('#')) continue;
      const ind = l.match(/^ */)[0].length;
      if (ind < indent) break;
      if (ind === indent && l.slice(ind).startsWith(key + ':')) { start = i; break; }
    }
    if (start < 0) return null;
    from = start + 1; indent += 2;
  }
  const keyIndent = indent - 2;
  let end = start + 1;
  for (; end < lines.length; end++) {
    const l = lines[end];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    if (l.match(/^ */)[0].length <= keyIndent) break;
  }
  // don't swallow trailing blank/comment lines that belong to the next key
  while (end > start + 1 && (!lines[end - 1].trim() || lines[end - 1].trim().startsWith('#'))) end--;
  return { start, end, indent: keyIndent };
}

/** Replace a `key:` list block with the given items (comments inside it are dropped). */
function setListBlock(text, pathKeys, items) {
  const lines = text.split('\n');
  const b = findBlock(lines, pathKeys);
  if (!b) throw new Error(`${pathKeys.join('.')} not found`);
  const pad = ' '.repeat(b.indent);
  const body = items.length ? items.map((it) => `${pad}  - ${q(it)}`) : [`${pad}  []`];
  lines.splice(b.start + 1, b.end - b.start - 1, ...body);
  return lines.join('\n');
}

/** Replace the value of a scalar `key: value` line, keeping a trailing comment. */
function setScalar(text, pathKeys, value) {
  const lines = text.split('\n');
  const b = findBlock(lines, pathKeys);
  if (!b) throw new Error(`${pathKeys.join('.')} not found`);
  const l = lines[b.start];
  const m = /^(\s*[^:]+:)(.*)$/.exec(l);
  const comment = /\s#.*$/.exec(m[2])?.[0] || '';
  lines[b.start] = `${m[1]} ${q(value)}${comment}`;
  return lines.join('\n');
}

function readInputs() {
  const profile = existsSync(PROFILE) ? yamlLoad(readFileSync(PROFILE, 'utf8')) || {} : {};
  const portals = existsSync(PORTALS) ? yamlLoad(readFileSync(PORTALS, 'utf8')) || {} : {};
  const targeting = {
    primary: profile.target_roles?.primary || [],
    anti_industries: profile.anti_targets?.industries || [],
    anti_role_shapes: profile.anti_targets?.role_shapes || [],
    compensation: {
      target_range: profile.compensation?.target_range || '',
      minimum: profile.compensation?.minimum || '',
      location_flexibility: profile.compensation?.location_flexibility || '',
    },
    location: {
      country: profile.location?.country || '',
      city: profile.location?.city || '',
      timezone: profile.location?.timezone || '',
      visa_status: profile.location?.visa_status || '',
    },
  };
  const companies = (portals.tracked_companies || []).map((c) => ({
    name: c.name || '', careers_url: c.careers_url || '', notes: c.notes || '',
    enabled: c.enabled !== false, method: c.api ? 'api' : (c.scan_method || 'auto'),
  }));
  const title_filter = {
    positive: portals.title_filter?.positive || [],
    negative: portals.title_filter?.negative || [],
  };
  const pending = readPending();
  const blacklist = [];
  if (existsSync(BLACKLIST)) {
    for (const l of readFileSync(BLACKLIST, 'utf8').split('\n')) {
      if (!l.trim().startsWith('|')) continue;
      const c = l.split('|').map((x) => x.trim());
      if (!c[1] || /^[-: ]+$/.test(c[1]) || c[1].toLowerCase() === 'company') continue;
      blacklist.push({ company: c[1], since: c[2] || '', scope: c[3] || '', reason: c[4] || '' });
    }
  }
  return {
    targeting, companies, title_filter, pending, blacklist,
    files: {
      profile: path.relative(ROOT, PROFILE), portals: path.relative(ROOT, PORTALS),
      pipeline: path.relative(ROOT, PIPELINE), blacklist: path.relative(ROOT, BLACKLIST),
    },
  };
}

const lines = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean);

function saveTargeting(body) {
  let t = readFileSync(PROFILE, 'utf8');
  t = setListBlock(t, ['target_roles', 'primary'], lines(body.primary));
  t = setListBlock(t, ['anti_targets', 'industries'], lines(body.anti_industries));
  t = setListBlock(t, ['anti_targets', 'role_shapes'], lines(body.anti_role_shapes));
  for (const k of ['target_range', 'minimum', 'location_flexibility']) {
    if (body.compensation && k in body.compensation) t = setScalar(t, ['compensation', k], body.compensation[k]);
  }
  for (const k of ['country', 'city', 'timezone', 'visa_status']) {
    if (body.location && k in body.location) t = setScalar(t, ['location', k], body.location[k]);
  }
  writeYamlChecked(PROFILE, t);
}

function saveTitleFilter(body) {
  let t = readFileSync(PORTALS, 'utf8');
  t = setListBlock(t, ['title_filter', 'positive'], lines(body.positive));
  t = setListBlock(t, ['title_filter', 'negative'], lines(body.negative));
  writeYamlChecked(PORTALS, t);
}

/** Known ATS hosts get a zero-token API feed; anything else falls back to websearch. */
function inferCompanyEntry({ name, careers_url, notes }, positiveTitles) {
  const e = { name, careers_url };
  let m;
  if ((m = /ashbyhq\.com\/([^/?#]+)/.exec(careers_url))) e.api = `https://api.ashbyhq.com/posting-api/job-board/${m[1]}`;
  else if ((m = /greenhouse\.io\/([^/?#]+)/.exec(careers_url))) e.api = `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs`;
  else if ((m = /lever\.co\/([^/?#]+)/.exec(careers_url))) e.api = `https://api.lever.co/v0/postings/${m[1]}?mode=json`;
  else {
    e.scan_method = 'websearch';
    const host = (() => { try { return new URL(careers_url).host + new URL(careers_url).pathname.replace(/\/$/, ''); } catch { return ''; } })();
    const title = positiveTitles[0] || 'Product Manager';
    e.scan_query = host ? `site:${host} "${title}"` : `${name} "${title}"`;
  }
  if (notes) e.notes = notes;
  e.enabled = true;
  return e;
}

function companyBlock(lines_, name) {
  const key = name.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines_.length; i++) {
    const m = /^  - name:\s*(.+?)\s*$/.exec(lines_[i]);
    if (m && m[1].replace(/^["']|["']$/g, '').toLowerCase() === key) { start = i; break; }
  }
  if (start < 0) return null;
  let end = start + 1;
  for (; end < lines_.length; end++) {
    const l = lines_[end];
    if (/^  - /.test(l) || /^[^ #]/.test(l)) break;
  }
  return { start, end };
}

function addCompany(body) {
  const name = String(body.name || '').trim();
  const careers_url = String(body.careers_url || '').trim();
  if (!name) throw new Error('Company name is required');
  if (careers_url && !/^https?:\/\//.test(careers_url)) throw new Error('Careers URL must start with http(s)://');
  let t = readFileSync(PORTALS, 'utf8');
  if (companyBlock(t.split('\n'), name)) throw new Error(`${name} is already tracked`);
  const inputs = readInputs();
  const e = inferCompanyEntry({ name, careers_url, notes: String(body.notes || '').trim() }, inputs.title_filter.positive);
  const block = ['', `  - name: ${name}`]
    .concat(Object.entries(e).filter(([k]) => k !== 'name').map(([k, v]) =>
      `    ${k}: ${typeof v === 'boolean' ? v : (k === 'scan_query' || k === 'notes' ? q(v) : v)}`));
  if (!/\ntracked_companies:/.test(t)) throw new Error('portals.yml has no tracked_companies key');
  t = t.replace(/\n+$/, '\n') + block.join('\n') + '\n';
  writeYamlChecked(PORTALS, t);
  return e;
}

function setCompanyEnabled(name, enabled) {
  const ls = readFileSync(PORTALS, 'utf8').split('\n');
  const b = companyBlock(ls, name);
  if (!b) throw new Error(`${name} not found in portals.yml`);
  let done = false;
  for (let i = b.start + 1; i < b.end; i++) {
    if (/^    enabled:/.test(ls[i])) { ls[i] = `    enabled: ${enabled}`; done = true; }
  }
  if (!done) ls.splice(b.end, 0, `    enabled: ${enabled}`);
  writeYamlChecked(PORTALS, ls.join('\n'));
}

function removeCompany(name) {
  const ls = readFileSync(PORTALS, 'utf8').split('\n');
  const b = companyBlock(ls, name);
  if (!b) throw new Error(`${name} not found in portals.yml`);
  let end = b.end;
  while (end > b.start + 1 && !ls[end - 1].trim()) end--; // keep one blank separator
  ls.splice(b.start, end - b.start);
  writeYamlChecked(PORTALS, ls.join('\n'));
}

function addPending(body) {
  const url = String(body.url || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error('Paste a full http(s) URL');
  let t = existsSync(PIPELINE) ? readFileSync(PIPELINE, 'utf8') : '# Pipeline — Pending URLs\n\n## Pending\n\n';
  if (t.includes(url)) throw new Error('That URL is already in the pipeline');
  const extra = [body.company, body.title].map((x) => String(x || '').trim()).filter(Boolean);
  const line = `- [ ] ${[url, ...extra].join(' | ')}`;
  const ls = t.split('\n');
  const h = ls.findIndex((l) => /^## (Pending|Pendientes)/i.test(l));
  if (h < 0) { t = t.replace(/\n*$/, '\n') + `\n## Pending\n\n${line}\n`; }
  else {
    let i = h + 1;
    while (i < ls.length && (!ls[i].trim() || ls[i].trim().startsWith('<!--'))) i++;
    ls.splice(i, 0, line);
    t = ls.join('\n');
  }
  backupInput(PIPELINE);
  writeFileAtomic(PIPELINE, t);
  return line;
}

function removePending(url) {
  const ls = readFileSync(PIPELINE, 'utf8').split('\n');
  const i = ls.findIndex((l) => l.startsWith('- [ ] ') && l.slice(6).split('|')[0].trim() === url);
  if (i < 0) throw new Error('URL not pending');
  ls.splice(i, 1);
  backupInput(PIPELINE);
  writeFileAtomic(PIPELINE, ls.join('\n'));
}

const normCo = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

function addBlacklist(body) {
  const company = String(body.company || '').trim();
  if (!company) throw new Error('Company is required');
  const cell = (v) => String(v || '').replace(/\|/g, '/').trim();
  let t = existsSync(BLACKLIST) ? readFileSync(BLACKLIST, 'utf8')
    : '# Company Blacklist\n\nDo-not-apply list. `scan.mjs` skips these; `auto-pipeline`/`oferta`/`apply` stop and ask before proceeding.\n\n| Company | Since | Scope | Reason |\n|---------|-------|-------|--------|\n';
  for (const e of readInputs().blacklist) if (normCo(e.company) === normCo(company)) throw new Error(`${e.company} is already blacklisted`);
  const row = `| ${cell(company)} | ${new Date().toISOString().slice(0, 10)} | ${cell(body.scope) || 'company'} | ${cell(body.reason)} |`;
  if (!/\|\s*Company\s*\|/i.test(t)) t = t.replace(/\n*$/, '\n') + '\n| Company | Since | Scope | Reason |\n|---------|-------|-------|--------|\n';
  t = t.replace(/\n*$/, '\n') + row + '\n';
  backupInput(BLACKLIST);
  writeFileAtomic(BLACKLIST, t);
}

function removeBlacklist(company) {
  const ls = readFileSync(BLACKLIST, 'utf8').split('\n');
  const i = ls.findIndex((l) => l.trim().startsWith('|') && normCo(l.split('|')[1] || '') === normCo(company));
  if (i < 0) throw new Error(`${company} not on the blacklist`);
  ls.splice(i, 1);
  backupInput(BLACKLIST);
  writeFileAtomic(BLACKLIST, ls.join('\n'));
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
  // `pipeline` is an LLM mode, so this drives the Claude CLI headless — the
  // same invocation batch/batch-runner.sh uses (headless runs can't answer
  // permission prompts). CLAUDE* env vars are stripped so it works when this
  // server was itself started from inside a Claude Code session.
  pipeline: {
    label: 'Run pipeline', bin: 'claude',
    argv: ['-p', '--dangerously-skip-permissions',
      'Run career-ops pipeline mode for data/pipeline.md: evaluate every pending `- [ ]` URL (auto-pipeline: report + tracker TSV), then run `node merge-tracker.mjs`. Print one line per URL as you finish it.'],
    blurb: 'Evaluate queued URLs with Claude (headless, may take minutes)',
  },
  // Single-URL variant, driven from a Queued row's Evaluate button. Not listed
  // in the Tools panel (it needs a url); argv is built per request.
  evaluate: {
    label: 'Evaluate', bin: 'claude', listed: false,
    argv: ({ url }) => ['-p', '--dangerously-skip-permissions',
      `Evaluate this JD with career-ops auto-pipeline: ${url}\nWrite the report and tracker TSV, run \`node merge-tracker.mjs\`, then mark this URL's line in data/pipeline.md as done (\`- [x]\`). Finish with one line: the score and the report path.`],
    blurb: 'Evaluate one queued URL',
  },
  // Tailored CV for one report, from the drawer's Generate CV button.
  pdf: {
    label: 'Generate CV', bin: 'claude', listed: false,
    argv: ({ num, report }) => ['-p', '--dangerously-skip-permissions',
      `Run career-ops pdf mode for report #${num} (${report}). Generate the tailored CV PDF into output/ and pass --report=${num} to generate-pdf.mjs so data/pdf-index.tsv links it to the report. Do not apply or submit anything. Finish with one line: the PDF path.`],
    blurb: 'Tailored CV for one report',
  },
  verify: { label: 'Verify pipeline', argv: ['verify-pipeline.mjs'], blurb: 'Health-check the tracker' },
  merge: { label: 'Merge tracker', argv: ['merge-tracker.mjs'], blurb: 'Fold in pending TSV additions' },
  dedup: { label: 'Dedup tracker', argv: ['dedup-tracker.mjs'], blurb: 'Collapse duplicate rows' },
  patterns: { label: 'Analyze patterns', argv: ['analyze-patterns.mjs', '--summary'], blurb: 'Rejection + targeting analysis' },
  followup: { label: 'Follow-up cadence', argv: ['followup-cadence.mjs', '--summary'], blurb: 'Who is overdue a nudge' },
  // Fast-forward only: refuses rather than merging if the local branch has
  // diverged, so it can never create a merge commit or touch local edits.
  update: { label: 'Update CRM', bin: 'git', argv: ['pull', '--ff-only', 'origin', 'main'], blurb: 'git pull from the fork — restart the server after' },
};

function streamTool(key, res, params = {}) {
  const tool = TOOLS[key];
  if (!tool) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Unknown tool');
  }
  if (key === 'evaluate' && !/^https?:\/\//.test(params.url || '')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('evaluate needs a http(s) url');
  }
  if (key === 'pdf') {
    const row = readTracker().rows.find((r) => r.num === Number(params.num));
    const file = row && resolveReport(row.report);
    if (!file) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('pdf needs a tracker row with a report');
    }
    params = { num: reportNum(row) ?? row.num, report: path.relative(ROOT, file) };
  }
  const argv = typeof tool.argv === 'function' ? tool.argv(params) : tool.argv;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { label: tool.label, params });

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE(CODE|_)/.test(k)));
  const child = spawn(tool.bin || process.execPath, argv, { cwd: ROOT, env });
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

  child.on('close', (code) => {
    if (key === 'update') crmUpdate.checkedAt = 0; // banner re-evaluates on the next /api/state
    send('done', { code }); res.end();
  });
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
      const html = readFileSync(path.join(HERE, 'index.html'), 'utf8')
        .replace('__CRM_TOKEN__', TOKEN)
        .replace('__CRM_TERM__', termUnavailable ? termUnavailable.replace(/"/g, '&quot;') : 'on');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/api/state') {
      const { rows, missing } = readTracker();
      const counts = {};
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
      return json(res, 200, {
        applications: (() => {
          const claimed = claimedPdfs(rows);
          return rows.map(({ raw, line, ...r }) => {
            const meta = reportMeta(r);
            return { ...r, url: meta.url, pdf: resolvePdf(r, meta, claimed) };
          });
        })(),
        states: STATE_LIST,
        counts,
        pending: pipelinePending(),
        queued: readPending(),
        crmUpdate: await checkCrmUpdate(),
        trackerMissing: Boolean(missing),
        tools: Object.entries(TOOLS).filter(([, v]) => v.listed !== false).map(([k, v]) => ({ key: k, label: v.label, blurb: v.blurb })),
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

    // View inline (default) or force a browser download (?download=1).
    if (url.pathname === '/api/pdf') {
      const row = rowByNum(url);
      const rel = row && resolvePdf(row, reportMeta(row), claimedPdfs(readTracker().rows));
      if (!rel) return json(res, 404, { error: 'No PDF on file for this role' });
      const abs = path.join(ROOT, rel);
      const disp = url.searchParams.get('download') ? 'attachment' : 'inline';
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': statSync(abs).size,
        'Content-Disposition': `${disp}; filename="${path.basename(abs)}"`,
      });
      return createReadStream(abs).pipe(res);
    }

    if (url.pathname === '/api/reveal' && req.method === 'POST') {
      const row = rowByNum(url);
      if (!row) return json(res, 404, { error: 'Unknown row' });
      const what = url.searchParams.get('what');
      if (what !== 'pdf' && what !== 'report') return json(res, 400, { error: 'what must be pdf or report' });
      const meta = reportMeta(row);
      const rel = what === 'report' ? (meta.reportFile && path.relative(ROOT, meta.reportFile)) : resolvePdf(row, meta, claimedPdfs(readTracker().rows));
      if (!rel) return json(res, 404, { error: `No ${what} on file for this role` });
      const abs = path.join(ROOT, rel);
      return json(res, 200, { ok: true, path: abs, revealed: reveal(abs) });
    }

    if (VENDOR[url.pathname]) {
      let file;
      try { file = require_.resolve(VENDOR[url.pathname][0]); } catch { file = null; }
      if (!file) { res.writeHead(404); return res.end('vendor file missing — npm install in crm/'); }
      res.writeHead(200, { 'Content-Type': VENDOR[url.pathname][1], 'Cache-Control': 'no-cache' });
      return createReadStream(file).pipe(res);
    }

    if (url.pathname === '/api/inputs') return json(res, 200, readInputs());

    if (url.pathname.startsWith('/api/inputs/') && req.method === 'POST') {
      const body = await readBody(req);
      const op = url.pathname.slice('/api/inputs/'.length);
      let result = { ok: true };
      switch (op) {
        case 'targeting': saveTargeting(body); break;
        case 'title-filter': saveTitleFilter(body); break;
        case 'company': result.entry = addCompany(body); break;
        case 'company/toggle': setCompanyEnabled(String(body.name || ''), body.enabled !== false); break;
        case 'company/remove': removeCompany(String(body.name || '')); break;
        case 'pipeline': result.line = addPending(body); break;
        case 'pipeline/remove': removePending(String(body.url || '')); break;
        case 'blacklist': addBlacklist(body); break;
        case 'blacklist/remove': removeBlacklist(String(body.company || '')); break;
        default: return json(res, 404, { error: 'Unknown input op' });
      }
      return json(res, 200, { ...result, inputs: readInputs() });
    }

    if (url.pathname === '/api/tool') {
      return streamTool(url.searchParams.get('name'), res, { url: url.searchParams.get('url') || '', num: url.searchParams.get('num') || '' });
    }

    // Is the Claude CLI installed, and (with ?ping=1) does a headless round
    // trip actually work? The ping costs one tiny request; the version check
    // is free. Both use the same stripped env the tools use.
    if (url.pathname === '/api/claude-status') {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE(CODE|_)/.test(k)));
      const run = (args, ms) => new Promise((resolve) => {
        let out = '', err = '';
        const t = Date.now();
        const c = spawn('claude', args, { cwd: ROOT, env });
        const timer = setTimeout(() => c.kill(), ms);
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { err += d; });
        c.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: '', err: e.message, ms: Date.now() - t }); });
        c.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - t }); });
      });
      const v = await run(['--version'], 10000);
      const status = { installed: v.code === 0, version: v.code === 0 ? v.out.split(/\s/)[0] : null, error: v.code === 0 ? null : (v.err || 'claude not found on PATH') };
      if (status.installed && url.searchParams.get('ping')) {
        const p = await run(['-p', 'Reply with exactly: OK', '--max-turns', '1'], 60000);
        status.ping = { ok: p.code === 0 && /\bOK\b/.test(p.out), ms: p.ms, reply: (p.out || p.err).slice(0, 200) };
      }
      return json(res, 200, status);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

// ── Terminal WebSocket ───────────────────────────────────────────────
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const wss = WebSocketServer ? new WebSocketServer({ noServer: true }) : null;
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/term' || !wss) return socket.destroy();
  if (!ORIGINS.has(req.headers.origin || '') || url.searchParams.get('token') !== TOKEN) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const cols = Math.max(20, Number(url.searchParams.get('cols')) || 100);
    const rows = Math.max(5, Number(url.searchParams.get('rows')) || 30);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE(CODE|_)/.test(k)));
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', CAREER_OPS_CRM: '1' });
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
    let term;
    try {
      term = ptyMod.spawn(shell, process.platform === 'win32' ? [] : ['-l'], { name: 'xterm-256color', cols, rows, cwd: ROOT, env });
    } catch (e) {
      ws.send(`\r\n\x1b[31mCould not start ${shell}: ${e.message}\x1b[0m\r\n`);
      return ws.close();
    }
    term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    term.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) { ws.send(`\r\n\x1b[2m[shell exited ${exitCode}]\x1b[0m\r\n`); ws.close(); }
    });
    ws.on('message', (m) => {
      let msg; try { msg = JSON.parse(m); } catch { return; }
      if (msg.t === 'in') term.write(String(msg.d));
      else if (msg.t === 'resize') term.resize(Math.max(20, msg.cols | 0), Math.max(5, msg.rows | 0));
    });
    ws.on('close', () => { try { term.kill(); } catch { /* already gone */ } });
  });
});

checkCrmUpdate(true);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`career-ops CRM  →  http://127.0.0.1:${PORT}`);
  console.log(`Tracker: ${path.relative(process.cwd(), TRACKER)}`);
  console.log('Bound to localhost only. Ctrl-C to stop.');
  if (termUnavailable) console.log(termUnavailable);
});
