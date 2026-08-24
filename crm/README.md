# career-ops CRM

A local web dashboard over `data/applications.md`: status bands, one-click status
changes, report preview, and buttons that run `scan.mjs` and friends. It lives
in this fork as an **overlay** on upstream career-ops: it is not part of the
upstream system layer, and nothing in it touches your data layer beyond the
tracker writes you click.

## Run

```bash
node crm/server.mjs            # http://127.0.0.1:7788
node crm/server.mjs --port 8000
```

Binds to `127.0.0.1` only. The tracker holds recruiter names, phone numbers,
and comp targets, so it never goes on the network. Before the first status
write of each run it copies the tracker to `data/applications.md.crm-{date}.bak`.

Fresh clone with no tracker yet? The board opens empty and tells you the next
step; it does not crash. Point it at another checkout with
`CAREER_OPS_ROOT=/path/to/career-ops node crm/server.mjs`.

## Row actions

- **Role name** links to the posting (read from the report's `**URL:**` line;
  the tracker itself has no URL column). URLs inside the report drawer are
  clickable too.
- **Report** opens the drawer. While it is out, clicking another row or moving
  with `j`/`k` swaps in that row's report; clicking anywhere outside the table
  or drawer (search, tools, filters) collapses it. **Show file** in the drawer
  header reveals the report in Finder.
- **PDF** appears on rows with a CV PDF and opens it inline in a new tab; the
  same link sits in the report drawer's header. The PDF is resolved from
  `data/pdf-index.tsv`, then the report's `**PDF:**` line, then a company-slug
  match in `output/*.pdf` (newest wins). Reveal (drawer `Show file`) is
  macOS-only; elsewhere the toast shows the path instead.

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
