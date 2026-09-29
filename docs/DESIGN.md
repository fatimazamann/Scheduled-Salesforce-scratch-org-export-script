# Design

What this system is, how it works, and why it is built the way it is.

Companion diagram: [`architecture.drawio`](architecture.drawio) — open at
<https://app.diagrams.net>. Page 1 is the component architecture, page 2 the
per-org decision flow.

---

## 1. Purpose

Every night, without anyone present, export the ConnectJunction (`cja_cj`)
application configuration from every eligible Salesforce **scratch org**
authenticated on one Windows machine, so that a mapping someone deletes or
breaks can be recovered.

Two halves, deliberately separate:

- **Data** — connectors, object mappings, field mappings, message templates,
  dataflows and their actions. Salesforce records. Cannot be reconstructed from
  a repository; this is the part that matters.
- **Metadata** — Apex, objects, fields, layouts, flows, permission sets and the
  rest, driven by `config/package.xml`. Usually reconstructible from source
  control, so it is the half that loses if only one can finish.

### What it is not

Not a change log. Each run is a **snapshot**. Under the default layout a
successful run replaces the previous one, so there is no history and no diff.
Getting history means `"layout": "per-run"`, or putting the export root under
Git.

Not a restore tool. The output is in Salesforce's own formats and can be
re-imported, but nothing here orchestrates a restore.

---

## 2. Constraints

These came from the original brief and shaped everything:

| Constraint | Consequence |
|---|---|
| The CLI auth store is the source of truth for which orgs exist — not VS Code | Discovery is `sf org list --json` |
| Never touch production, sandboxes or Dev Hubs | Three positive signals for "scratch", and any explicit sandbox/Dev Hub marker overrides all of them |
| Never open a browser | `sf org login web` is opt-in and refused outright for scratch orgs |
| Keep the `.bat` thin | It is ~40 lines and contains no logic |
| Never interpolate into a shell | Argument arrays everywhere, `shell: false` |
| Never log tokens | Allowlist for org records, denylist for free text |
| One org's failure must not stop the run | One OS process per org; every throwing path becomes a status |
| The exit code must reflect partial failure | Four distinct codes |

---

## 3. Architecture

```
Windows Task Scheduler
  └─ scheduled-export.bat      thin entry point
       └─ orchestrator.js      once per RUN
            └─ export-script.js    once per ORG
                 ├─ clean-json.js
                 └─ sf project retrieve start
```

### Why the parent and child are separate processes

One org failing must not stop the others. Because each org export is its own
OS process, a crash, a hang, an out-of-memory or a stuck socket is contained —
the parent observes an exit code and moves on. Sharing one process would put
every org at the mercy of the worst one.

It also gives a precise failure vocabulary. The child classifies what went
wrong and encodes it in its exit status, so the parent can distinguish "retry
this" from "retrying will fail identically" without parsing log text.

### Why the `.bat` is nearly empty

Batch has no JSON parser, no arrays, no exception handling, and a quoting model
that becomes a liability the moment org data is involved. Node is already a
hard dependency — the exporter is a Node script — so using it for the parent
adds no new moving part. PowerShell would add one.

The `.bat` does exactly four things: anchor the working directory to its own
folder (`%~dp0`, because Task Scheduler frequently starts a task in
`C:\Windows\System32`), optionally source a machine-local `set-env.cmd`, verify
`node` is runnable by this account, and propagate the exit code.

That third check has to live there. `orchestrator.js` performs the full
preflight, but it cannot report a missing Node runtime — it needs Node to run.

### Why there are no dependencies

`lib/args.js` (~90 lines) replaces `commander`. A scheduled job running
unattended under a service account at 2am is the worst possible place to
discover that a transitive dependency changed, or that `npm install` was never
run on this machine. There is no `node_modules`, no lockfile to keep current,
and nothing to audit.

---

## 4. Which orgs get exported

Four gates, in order. Failing any one produces a *stated reason* and the run
continues.

### 4.1 Is it a scratch org?

Three accepted signals:

1. `isScratch === true`
2. the CLI's `scratchOrgs` bucket
3. an instance URL matching `*.scratch.my.salesforce.com`

Any explicit `isSandbox` or `isDevHub` **overrides all three**.

Signal 3 exists because of a real incident: two of eight scratch orgs were
silently missing from every run. The CLI only sets `isScratch` for orgs it
created itself with `sf org create scratch`. An org authenticated with
`sf org login web` — which is what VS Code's *SFDX: Authorize an Org* runs —
carries no such flag. The instance URL is set on every org, comes from
Salesforce rather than local bookkeeping, and is specific enough that it cannot
misfire: sandboxes use `.sandbox.`, Developer Edition uses `.develop.`, and
production is a bare `.my.salesforce.com`.

### 4.2 Is it expired?

```
isExpired === true                          → SKIPPED_EXPIRED
status present and not "Active"             → SKIPPED_EXPIRED
expirationDate passed (23:59:59 that day)   → SKIPPED_EXPIRED
hours remaining < minHoursUntilExpiry       → SKIPPED_EXPIRED
none of those fields present                → warn, continue
```

The comparison is against the *end* of the expiration day, because a scratch
org is usable through that whole day.

**This check is weaker than it looks, and the reason is worth understanding.**
Those fields come from the Dev Hub's `ScratchOrgInfo` object, which
`sf org list` queries only when the local auth record names a `devHubUsername`.
Orgs authenticated via `sf org login web` have no Dev Hub association, so they
carry none of these fields and fall through to the warning branch.

What actually protects the run is elsewhere: `sf org list` hides expired
scratch orgs unless `--all` is passed, and gate 4.3 fails on any org that has
stopped responding. Expiry therefore gets caught late and expensively — by
timing out — rather than early and cheaply. For orgs authenticated this way the
data genuinely is not available locally.

### 4.3 Is it reachable, and is the app installed?

One `sf sobject describe --sobject cja_cj__CJ_Connector__c` answers both.

It is deliberately a **metadata** probe, not a record count: a legitimately
installed package can contain zero records, and skipping an empty org would be
wrong. An org with the app and no data exports successfully and produces empty
files.

The failure is then classified — authentication, dead org, missing object,
timeout, or unrecognised — so the summary says *why*, not just *no*.

### 4.4 Configuration filters

`orgFilter` include/exclude lists, `perOrg.skip`, and the `--org` flag.

---

## 5. What gets exported

### 5.1 Data

Four query sets, **unchanged** from the original `exportconnectordata.js` and
verified identical after whitespace normalisation:

| Set | Object |
|---|---|
| CJ Connectors | `cja_cj__CJ_Connector__c` |
| JSON Object Mappings | `cja_cj__JSON_Object_Mapping__c` + `cja_cj__Json_Field_Mappings__r` subquery |
| Message Templates | `cja_cj__CJ_Message_Template__c` |
| Dataflows | `cja_cj__Dataflow__c` + actions + action data — **`any-to-any` only** |

Issued through `sf data export tree --plan`, producing Salesforce's SObject
Tree format: one JSON per object with a `records` array, plus a plan file
describing import order. Round-trips through `sf data import tree`.

`clean-json.js` then strips audit fields (`CreatedById`, `SystemModstamp` and
the rest). That is not cosmetic — those fields are not insertable, so removing
them is what keeps the export importable.

#### The `LIMIT 200` clauses are mandatory

SOQL `FIELDS(ALL)` is an unbounded query and Salesforce **requires**
`LIMIT <= 200` on it. Removing those clauses produces `MALFORMED_QUERY`, not
more data. The migration path, if 200 ever becomes a real ceiling, is explicit
field lists — which lifts the limit to the 2,000-record cap that
`sf data export tree` imposes.

#### Truncation detection

After each export, every record set is counted. A count landing **exactly** on
a limit is the signature of silent truncation — configuration that exists in
the org and is missing from the backup. It warns and is recorded in
`_export-summary.json`; it does not fail the export, because an org can
legitimately have exactly 200 mappings.

Only an *exact* match counts. An earlier version warned on any count above the
limit, which fired constantly: `--plan` flattens subquery children into their
own file, and the per-parent limit applies per parent, so the file total is a
sum across parents and bears no relation to the limit.

### 5.2 Metadata

`sf project retrieve start --manifest config/package.xml`, producing SFDX
**source format** — decomposed objects, `*-meta.xml` suffixes, type folders.

Always `--json`. The human-readable form is a table with one row per component;
several hundred rows per org would bury everything else in the nightly log.

Warnings are extracted and logged individually. When the manifest names a
component the org does not have, the retrieve **succeeds** and reports it as a
warning — which is exactly why it would otherwise go unnoticed. Each one is a
component you believe is backed up and is not.

#### Why the retrieve happens outside the export folder

This took three production failures to get right, and the reason is the most
load-bearing design decision in the metadata half.

`sf project retrieve start` imposes at least four rules on where it may work:

1. it must run inside an SFDX project — `InvalidProjectWorkspaceError`
2. `--output-dir` must be inside that project — `OutputDirOutsideProjectError`
3. `--output-dir` must not overlap a package directory — `RetrieveTargetDirOverlapsPackageError`
4. and, not a CLI rule at all: the project root becomes the child's working
   directory, and **on Windows a directory a process has used as its cwd cannot
   afterwards be renamed or deleted**

Rule 4 is fatal for the obvious design. The export folder is renamed at the end
of every successful run, so making it the project root broke the atomic swap
with `EPERM` — and took the whole run down with it.

Each of the first three attempts picked a different directory and hit a
different rule. The directory was never the problem: **letting the CLI's
workspace rules dictate where the backup is written** was. So the two concerns
are separated. The CLI gets `.metadata-work/` — a fixed scratch SFDX project
outside the export tree, never renamed, never shared — and the result is
**moved** into the backup afterwards (rename, with a recursive copy fallback
for `EXDEV` when the export root is on another volume).

The CLI's rules now apply only to a directory this tool fully controls, so they
stop being a function of `exportRoot`, the layout, the folder pattern, or
whatever else happens to be on disk nearby.

One hazard came with that move: the work directory is reused across orgs, so a
retrieve that fails part-way leaves components behind that would be moved into
the *next* org's backup — silent, plausible-looking corruption of exactly what
this tool exists to produce. It is cleared before every retrieve, and test MD1b
covers it.

#### A static manifest goes stale

`config/package.xml` names 401 members explicitly, so anything created in an
org afterwards is absent from the backup and nothing says so — the retrieve
succeeded exactly as instructed. `config/package.xml.example` shows the
wildcard alternative, which cannot go stale but costs a longer retrieve.

Not a gap: fields, list views, record types and web links are children of
`CustomObject` and come back whenever their object is retrieved, listed
individually or not.

---

## 6. Output and the atomic swap

```
connectjunction-exports/
    cj-export_<alias>/                  one per org, replaced every run
        cja_cj__*.json                  data, cleaned
        <plan>.json                     import plan
        sfdx-project.json               the backup is a deployable DX project
        force-app/main/default/         metadata, SFDX source format
        _export-summary.json            what happened, and the exact SOQL
logs/
    export_<runId>.log                  human-readable
    export_<runId>.json                 machine-readable
    latest.json                         the most recent run
.metadata-work/                         scratch SFDX project, not a backup
```

Every export is written to `.tmp_<folder>_<runId>` and only swapped into place
once it has fully succeeded. The swap renames the existing folder aside,
renames the temp folder in, then deletes the old one — so the window in which
the destination does not exist is a single rename rather than a recursive
delete, and a failed run leaves the previous backup exactly as it was. This
matters most under the default layout, where that previous copy is the only one
there is.

Stale temp folders from a killed run are swept at the start of the next run.
Cleanup failures are **never** fatal: a leftover folder is a far smaller
problem than aborting a run with orgs still queued.

### `_export-summary.json`

Per org, and the most useful artifact for later forensics:

- **`queries`** — the exact SOQL that produced these files. Six months from now,
  when something is missing, this says whether the query ever asked for it.
- **`truncationWarnings`** — counts that landed on a limit.
- **`metadata`** — status, component and file counts, and manifest warnings.
- **`integrationType`, `connectorFilter`, `rowLimit`** — the settings in force
  for this org, since `perOrg` can override them.
- **`startedAt` / `status`** — under the default layout the folder is
  overwritten nightly, so this distinguishes last night's export from a stale
  folder belonging to an org that has been failing quietly.

---

## 7. Failure model

### Exit codes

| Code | Meaning |
|---:|---|
| 0 | every eligible org exported — including "none found" |
| 1 | at least one org failed; the others still ran |
| 2 | preflight or configuration failure; **nothing was processed** |
| 3 | another run holds the lock; this instance did nothing |

3 exists because an overlap is not a failure. Treating it as 1 would make a
healthy "previous run still going" look like a broken export.

### Child exit codes

`0` success · `1` uncaught · `2` invalid arguments · `3` auth · `4` export
failed · `5` cleanup failed · `6` transient.

### Retry policy — deliberately narrow

Only exit code 6 (transient: network errors, socket hang-ups, 5xx, request
limits) or a child we timed out ourselves. Never invalid arguments,
authentication, a malformed query, or a `clean-json` failure — those fail
identically on a second attempt, and retrying them burns time and delays every
org still queued.

### Skips are not failures

`SKIPPED_EXPIRED`, `SKIPPED_UNREACHABLE`, `SKIPPED_APP_NOT_INSTALLED` and
`SKIPPED_BY_CONFIG` leave the exit code at 0. An expired scratch org is normal;
a dead org is normal. Only a *failed export of an eligible org* is a failure.

### A skip always states a reason

A blank reason is the one thing that cannot be diagnosed afterwards. When the
CLI produces no parseable error, the message falls back to the exit code plus
the CLI's raw unfiltered output — because the noise filter that strips the
update nag is itself capable of emptying the message.

### The swap retries before it gives up

A folder that has just had several hundred metadata files written into it is
exactly what a virus scanner, the Windows Search indexer, an open Explorer
window or an editor watching the folder holds a handle on — for a second or
two. A single `rename` attempt loses that race and throws away an export that
had already succeeded, which is what happened on the first real scheduled run.

`renameWithRetry` makes up to five attempts with increasing backoff, for
`EPERM`/`EBUSY`/`EACCES`/`ENOTEMPTY` only. Anything else — `ENOENT` included —
still fails on the first attempt rather than burning four retries on an error
that will never clear. Removing the set-aside folder is best-effort for the
same reason.

Intermittent failure at 8pm, for reasons that have nothing to do with
Salesforce, is exactly the shape of problem nobody notices until they need the
backup.

### Locking

Atomic `fs.openSync(path, 'wx')`. A stale lock is reclaimed by checking PID
liveness and age, so a crashed run cannot block the schedule indefinitely.

---

## 8. Security

| Concern | Treatment |
|---|---|
| Command injection | Argument arrays with `shell: false`; the original built shell strings with template literals |
| SOQL injection | `lib/soql.js` escapes literals; the original did `replaceAll(',', "','")`, which breaks on any apostrophe |
| Token leakage | `ORG_SAFE_FIELDS` allowlist for org records — a new secret field added by a future CLI cannot leak because it is not on the list. Plus a denylist scrubbing `force://` URLs, `00D…!…` tokens, OAuth secrets, bearer headers and PEM blocks from free text |
| `sfdxAuthUrl` | `sf org display` is called **without** `--verbose`, which would return a refresh token |
| Unattended browser prompts | Non-interactive by default; `--interactive` refused for scratch orgs |
| Exports on disk | `connectjunction-exports/` and `logs/` are gitignored and must stay so — message template bodies routinely contain real names and business rules |

---

## 9. Windows specifics

Every Windows bug in this project was in *launching* the CLI, never in the
Salesforce logic — and all were caught by preflight with exit 2 rather than a
half-finished export.

**npm ships three shims.** `sf` (a bash script), `sf.cmd` and `sf.ps1`. Windows
cannot execute the extensionless one, and naive `PATH` resolution picks it
first → `spawn ... ENOENT`. `pickWindowsExecutable` prefers `.exe`, then
`.cmd`/`.bat`, and never returns `.ps1`.

**cmd.exe re-parses the command line.** Running a `.cmd` means routing through
`cmd.exe`, which re-parses — the injection surface known as BatBadBut
(CVE-2024-27980). Handled in three tiers, best first: the CLI's own `run.js`
spawned as `node run.js` with no shell at all; a resolved `.exe`; or the `.cmd`
shim through `cmd.exe` with both escaping layers applied.

**The command name is not an argument.** Caret-escaping the command name broke
on a path containing a space — `'"C:\Users\Cloud' is not recognized`. The
command name gets real quotes; only arguments get carets.

**A process's working directory cannot be renamed.** See §5.2.

The preferred path is `sfCliEntry` — auto-discovered next to the shim — which
removes `cmd.exe` from the picture entirely and is faster besides.

---

## 10. Configuration

`config/export-config.json`, layered: defaults → file → `SFEXPORT_*`
environment variables → CLI flags. Every relative path resolves against the
project root, never the working directory, so whatever Task Scheduler hands the
process is irrelevant.

Keys worth knowing: `layout` (`per-org` | `per-run`), `orgFolderPattern`,
`integrationType`, `connectorFilter`, `queryLimit`, `appCheck`, `orgFilter`,
`perOrg`, `metadata.*`, `maxRetries`, `childTimeoutSeconds`.

`metadata.timeoutSeconds` is **added** to `childTimeoutSeconds`, never shared
with it — otherwise a slow retrieve could get the child killed after the data
export had already succeeded.

---

## 11. Testing

`node test/run-tests.js` — **246 assertions** against a mock Salesforce CLI. No
org, no network, no credentials. Every scenario drives the real orchestrator
and the real exporter; only `sf` and `clean-json.js` are stubbed.

The mock enforces the real CLI's *environmental* rules, not just its happy
path: it refuses to run outside an SFDX project, refuses an `--output-dir`
outside that project, refuses one overlapping a package directory, and records
its working directory so tests can assert it is not a folder the run later
renames.

That is the lesson of this project, stated plainly: **three metadata bugs
reached real orgs because the mock only knew the rules already discovered.** A
mock that models only the happy path will certify a design that cannot work.

A related trap, worth naming because it was nearly repeated: the first version
of the cross-org contamination test used two *successful* retrieves and passed
even with the fix removed, because a successful retrieve is moved out of the
work directory anyway. It was rewritten around a retrieve that writes files and
then fails, and verified to go red when the fix is deleted. **A test that cannot
fail is worse than no test**, because it reports safety that does not exist.

---

## 12. Known limitations

- **No alerting.** A failed run puts an exit code in Task Scheduler and a line
  in `logs/latest.json` and tells nobody. A backup failing silently for three
  weeks is indistinguishable from one that works. *This is the largest gap.*
- **Org coverage decays.** Scratch orgs expire; nothing re-authenticates or
  creates new ones. Each new org needs a one-time `sf org login web`.
- **Dead orgs cost real time** — 30–60s each, and `sf org list --clean` does not
  remove them because the CLI has no expiry data for orgs authenticated
  directly. They need `sf org logout`.
- **The connector filter is partial.** It applies to `cja_cj__CJ_Connector__c`
  only. Object mappings, message templates and dataflows are exported
  unfiltered — preserved from the original, which had an unfinished ternary
  (`${!CJconnectorName ? '' : ''}`) where the filter would have gone. Rather
  than invent a relationship that could not be verified from the code, the
  behaviour was kept and a runtime warning added whenever a filter is supplied.
- **No history** under the default layout.
- **`FIELDS(ALL)` caps every query at 200 rows.**
- **No restore tooling.**
