# career-ops CRM

A local web dashboard over `data/applications.md`: status bands, one-click status
changes, report preview, and buttons that run `scan.mjs` and friends. It lives
in this fork as an **overlay** on upstream career-ops: it is not part of the
upstream system layer, and nothing in it touches your data layer beyond the
tracker writes you click.

## Quick start

**First time (no career-ops yet)** — needs Node 18+ and Claude Code:

```bash
git clone https://github.com/naho4212/career-ops.git
cd career-ops && npm install && (cd crm && npm install)
```

Open Claude Code in the folder and say hi; it onboards you (CV, target
roles, salary). Then `node crm/server.mjs` → http://127.0.0.1:7788.

**Already ran career-ops** — keep your data, switch to this fork. Your CV,
profile, tracker and reports are not in git, so this cannot touch them:

```bash
cd career-ops && git stash
git remote rename origin upstream
git remote add origin https://github.com/naho4212/career-ops.git
git fetch origin main && git checkout -B main origin/main && git stash pop
npm install && (cd crm && npm install)
node crm/server.mjs
```

If `git stash pop` reports a conflict it is `interview-prep/story-bank.md`;
keep yours: `git checkout --theirs interview-prep/story-bank.md && git add
interview-prep/story-bank.md`. Details for both paths are below.

**Then:** paste a job URL in Inputs → hit Evaluate → scored fit report and a
tailored CV. Terminal tab is a real shell for interactive `claude`. A banner
appears when the fork has updates; click it to pull. Don't push to this repo —
fork it if you want to change things.

## Run

```bash
(cd crm && npm install)        # once — terminal deps (node-pty, ws, xterm)
node crm/server.mjs            # http://127.0.0.1:7788
node crm/server.mjs --port 8000
```

`crm/package.json` is separate from the root `package.json` on purpose: the
root one is a system-layer file the updater replaces. Skipping `npm install`
is fine — everything but the Terminal tab works, and that tab says what to
run. `node-pty` needs a C toolchain on first install (Xcode CLT on macOS).

The `crm` postinstall also runs
`git update-index --skip-worktree interview-prep/story-bank.md`. That file is
the one user-layer file `.gitignore` cannot cover — upstream tracks it as an
empty template — and it fills with your interview stories over time. Marking
it skip-worktree means `git add .` / `git commit -a` never stage it. If an
update ever changes the template upstream and `git pull` complains, run
`git update-index --no-skip-worktree interview-prep/story-bank.md`, stash,
pull, pop, and re-mark it.

Binds to `127.0.0.1` only. The tracker holds recruiter names, phone numbers,
and comp targets, so it never goes on the network. Before the first status
write of each run it copies the tracker to `data/applications.md.crm-{date}.bak`.

Fresh clone with no tracker yet? The board opens empty and tells you the next
step; it does not crash. Point it at another checkout with
`CAREER_OPS_ROOT=/path/to/career-ops node crm/server.mjs`.

## Terminal tab

A real login shell (`$SHELL -l`, cwd = repo root) in the dashboard: xterm.js in
the page, `node-pty` behind a WebSocket. Anything Terminal.app can do works
here — `claude` interactively with its full TUI and permission prompts,
`vim cv.md`, git, the `.mjs` scripts. That is the point: the headless tools
run `--dangerously-skip-permissions` because `-p` mode cannot answer prompts;
an interactive session can, which is what `apply` mode (stop before Submit)
and hands-on CV edits need.

The three headless actions — **Run pipeline**, a queued row's **Evaluate**,
and the report's **Generate CV** — each have an **in terminal** alternative
that switches to this tab and types the equivalent interactive `claude "…"`
command, unsubmitted, so you can read or edit it and press Enter.

Keys follow macOS terminal conventions: ⌥←/→ word jump, ⌥⌫ delete word,
⌘⌫ kill the line, ⌘←/→ line start/end, ⌘A select all, ⌘K clear, ⌘C copy
(or interrupt when nothing is selected), ⌘V paste, ⇧↩ / ⌥↩ newline inside
`claude`.

Security: the server binds to 127.0.0.1 and the upgrade to `/term` requires
both a matching `Origin` and a per-launch token embedded in the served page,
so no other page or process on the machine can open a shell through it. One
shell per page; closing the tab kills it. Run `tmux` inside if you want a
session that outlives the page. `CLAUDE*` env vars are stripped so a nested
`claude` starts cleanly.

## Queued (pre-evaluation)

URLs still pending in `data/pipeline.md` show as **Queued** rows ahead of the
tracker rows, with their own zone in the spine before Pending/Evaluated. Two
actions: **Evaluate** (`Enter`) runs `auto-pipeline` for just that URL via the
headless Claude CLI and streams into the Tools tab; **Skip** (`s`) drops the
URL from `pipeline.md` so no tokens are spent on it. One tool runs at a time. Queued rows are not tracker
rows: no number, score, report, or status change until they are evaluated.

## Row actions

- **Role name** links to the posting (read from the report's `**URL:**` line;
  the tracker itself has no URL column). URLs inside the report drawer are
  clickable too.
- **Report** opens the drawer. While it is out, clicking another row or moving
  with `j`/`k` swaps in that row's report; clicking anywhere outside the table
  or drawer (search, tools, filters) collapses it. The report header renders
  as a key/value grid; its `PDF` row is a link to the CV plus **Show in
  Finder** (the PDF is what gets uploaded to an ATS; macOS-only, elsewhere the
  toast shows the path). When no CV exists the row offers **Generate CV**,
  which runs `pdf` mode headless for that report (with `--report=N` so
  `pdf-index.tsv` links it) and refreshes the drawer when done. Tables, lists
  and section rules render properly.
- **PDF** appears on rows with a CV PDF and is a link that opens it inline in
  a new tab. The PDF is resolved from `data/pdf-index.tsv`, then the report's
  `**PDF:**` line, then a company-slug match in `output/*.pdf` (newest wins).

## Tools tab

Seven tools run from the **Tools** tab, streamed live over SSE: `scan`,
**Run pipeline**, `verify-pipeline`, `merge-tracker`, `dedup-tracker`,
`analyze-patterns --summary`, `followup-cadence --summary`.

A status strip at the top of the tab shows whether the Claude CLI is installed
(version check, free, runs when the tab opens) and **Ping** does a real
headless round trip (`claude -p "Reply with exactly: OK"`, one tiny request,
~5–10s) to confirm auth and connectivity before you launch a long run.

**Run pipeline** is different from the rest: `pipeline` is an LLM mode, so the
tool drives the Claude CLI headless — `claude -p --dangerously-skip-permissions
"Run career-ops pipeline mode…"`, the same invocation `batch/batch-runner.sh`
uses, because a headless run cannot answer permission prompts. It evaluates
every queued URL, writes reports and tracker TSVs, then merges. Expect minutes,
not seconds; output arrives when Claude prints it. `CLAUDE*` env vars are
stripped from the child so it also works when the server was started from
inside a Claude Code session. The console renders the
CLI output as a report rather than a log: status emoji become colored markers,
`====`/`----` rows become rules, ALL-CAPS labels become section heads, blank
runs collapse, and a footer tallies ok / warnings / errors. Each tool remembers
its last run time and exit code for the session.

## Inputs tab

The **Inputs** tab (masthead toggle, remembered per browser) edits the user-layer
files that steer scoring and scanning. Every write is a line-level patch —
the block you changed is replaced, every other byte (including comments) is
left alone — and the result is parsed before it is written, so a bad patch
never lands. First write per file per server run leaves `{file}.crm-{date}.bak`.

| Section | File | Edits |
|---|---|---|
| Targeting | `config/profile.yml` | `target_roles.primary`, `anti_targets.industries` / `role_shapes`, `compensation.*`, `location.*`. Archetype notes and narrative are left to hand-editing. |
| Target companies | `portals.yml` | Add (Ashby / Greenhouse / Lever careers URLs get a zero-token `api` feed inferred from the slug; anything else becomes a `websearch` entry), pause/enable, remove (two-click confirm). |
| Title filter | `portals.yml` | `title_filter.positive` / `negative`. |
| Pipeline inbox | `data/pipeline.md` | Queue a posting URL (dedup on URL); drop it. Evaluation still runs via `/career-ops pipeline` in the AI CLI — `pipeline` is a mode, not a script. |
| Blacklist | `data/blacklist.md` | Add / remove companies. File is created on first add; `scan.mjs` and the evaluate/apply gates already honour it. |

## Already running career-ops? Adopt the fork in place

Your CV, profile, portals, tracker, reports, PDFs and interview prep are all
untracked or gitignored, so they are not in git history and a branch switch
cannot touch them. Point your existing checkout at this fork:

```bash
cd career-ops
git stash                                   # parks tracked edits (e.g. story-bank.md); untracked data is untouched
git remote rename origin upstream           # keep santifer's remote around, renamed
git remote add origin https://github.com/naho4212/career-ops.git
git fetch origin main
git checkout -B main origin/main            # tracked tree now = this fork; your data layer is as it was
git stash pop                               # bring the parked edits back
npm install && (cd crm && npm install)
node crm/server.mjs
```

What changes: the system files (modes, scripts, templates) now come from
this fork's snapshot, which may be a different career-ops version than you
had. That is fine — the next `node update-system.mjs check` reconciles
against upstream exactly as before, because the updater is hard-wired to
santifer's repo, not to `origin`. Your own auto-update commits are dropped
from the branch; nothing in them was yours.

If `git stash pop` reports a conflict it is almost certainly
`interview-prep/story-bank.md` (your stories vs the upstream template): keep
yours (`git checkout --theirs interview-prep/story-bank.md`, then
`git add` it, then `git update-index --skip-worktree` it).

## Two independent update channels

This fork receives updates from two places, and they do not collide:

| What | Comes from | How |
|---|---|---|
| career-ops system (modes, scripts, templates) | `santifer/career-ops` | `node update-system.mjs apply --confirm` |
| this CRM (`crm/`) | this fork's `origin` | `git pull` |

Why they cannot break each other:

- `update-system.mjs` fetches from its hard-coded `CANONICAL_REPO`
  (upstream), never from `origin`. It checks out and commits **only** the
  paths in its `SYSTEM_PATHS` manifest. `crm/` is not in that manifest, so an
  upstream update neither overwrites nor prunes it. If upstream ever ships a
  `crm/` path of its own, the updater's collision guard refuses loudly rather
  than clobbering.
- The server checks on startup (and at most every 10 minutes) whether
  `origin/main` is ahead of `HEAD`. If so it logs a line, the masthead shows
  **CRM update · N commits behind**, and clicking it runs the **Update CRM**
  tool: `git pull --ff-only origin main`. Fast-forward only, so it refuses
  rather than merging if local commits exist; it never runs on its own.
  Restart the server after a pull that touched `crm/server.mjs`.
- `git pull` from this fork brings CRM changes plus whatever system version the
  fork was on. If you are already ahead of that via `update-system.mjs`, git
  keeps your newer system files; `crm/` merges cleanly because upstream never
  writes to it.

**Do not add CRM docs or an npm script to `README.md` / `package.json`.** Both
are `SYSTEM_PATHS` entries and get replaced on every update. Anything the CRM
needs to say lives in this directory.

## The one coupling to watch

`server.mjs` imports `resolveColumns`, `parseTrackerRow` (from
`tracker-parse.mjs`) and `rebuildRow`, `writeFileAtomic`,
`acquireTrackerLock`, `trackerLockDirFor` (from `tracker-utils.mjs`). Those
two files are upstream-owned. Using them is deliberate: it is the same read
and write path `merge-tracker.mjs` and `set-status.mjs` use, so the CRM cannot
drift from the CLI's idea of a valid row. The cost is that an upstream rename
of one of those exports breaks the CRM at startup with a clear import error.
If that happens, the fix is a one-line import update here, never a copy of
the parser into `crm/`.

## Giving this to someone

1. They clone **this fork**, not upstream.
2. Normal onboarding: `node doctor.mjs --json`, then fill in their own `cv.md`
   and `config/profile.yml`. The `.gitignore` is fail-closed on the whole data
   layer, so nothing of yours travels with the clone.
3. `node crm/server.mjs`.

From then on, `update-system.mjs` for the system, `git pull` for the CRM.
