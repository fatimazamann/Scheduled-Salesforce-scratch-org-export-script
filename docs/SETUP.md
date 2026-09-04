# Setup

How to get this running on a machine that has never run it before.

It exports ConnectJunction (`cja_cj`) configuration — connectors, object
mappings, message templates, dataflows, and optionally metadata — from every
eligible Salesforce **scratch org** that is already authenticated on that
machine. It runs unattended, on a schedule, and never opens a browser.

Budget about 30 minutes the first time, most of it waiting on installers.

---

## 0. The one thing to understand first

**This tool does not authenticate anything. It exports orgs that are already
authenticated in the Salesforce CLI on that machine, under that Windows
account.**

The CLI keeps its authentication in your Windows profile:

```
C:\Users\<you>\.sfdx\
C:\Users\<you>\.sf\
```

Two consequences that cause almost every "it found no orgs" report:

- **The scheduled task must run as the same Windows account that authenticated
  the orgs.** A task running as `SYSTEM`, `NETWORK SERVICE`, or a different
  service account reads a different profile, finds an empty auth store, and
  cheerfully reports "0 orgs discovered, exit 0". It is not broken; it is
  looking somewhere else.
- **The Windows account is what matters, not which tool you used.** Any route
  into the CLI writes to the same store.

If you are setting this up for a shared/service account, log in as that account
and authenticate the orgs there. There is no way around it and no flag that
fixes it.

### Authenticating from VS Code is fine

This is the normal workflow here, and it works. VS Code's **SFDX: Authorize an
Org**, and the `sf` commands you type in its integrated terminal, both invoke
the same CLI binary and write to the same `%USERPROFILE%\.sfdx` store. VS Code
has no auth store of its own. So orgs you authorised in VS Code are visible to
the scheduled task, as long as it runs as your Windows account.

Two things that follow, neither of them a problem:

- **The org "selected" in VS Code is irrelevant.** That is a per-project default
  (`target-org`), and this tool always names the org explicitly with
  `--target-org`. It exports every eligible org, not the one you happen to have
  selected.
- **`sf org list --json` is the source of truth, not the VS Code Org Browser.**
  The panel reads the same store but can show a cached view. When the two
  disagree, believe the CLI — that is what this tool reads.

The one place it does matter: **`sf org login web` does not always set the
`isScratch` flag** on the org record, and that is the command behind *Authorize
an Org*. Orgs created directly with `sf org create scratch` get flagged; orgs
you authorised into get flagged inconsistently. Discovery therefore does not
rely on that flag alone — it also accepts the CLI's `scratchOrgs` bucket and a
`*.scratch.my.salesforce.com` instance URL. Without that fallback, orgs
authorised the VS Code way go missing from the run with no error at all.

Still run the exporter itself from a plain Command Prompt rather than the VS
Code terminal — see step 5. That is about *running*, not about authenticating.

---

## 1. Prerequisites

| Need | Why | Get it |
|---|---|---|
| Windows 10/11 or Server | `scheduled-export.bat` + Task Scheduler | — |
| **Node.js 18 or newer** | the tool is a Node program | <https://nodejs.org> (LTS) |
| **Salesforce CLI v2** (`sf`) | every Salesforce call goes through it | <https://developer.salesforce.com/tools/salesforcecli> |
| **Git** | to clone and update | <https://git-scm.com/download/win> |
| At least one authenticated scratch org | there is nothing to export otherwise | see step 3 |

There are **no npm dependencies**. Nothing to `npm install`, no `node_modules`,
no lockfile to keep current. That is deliberate: a scheduled job running
unattended under a service account is a bad place to discover that a transitive
dependency changed.

Verify all three, in a **plain Command Prompt** (not the VS Code terminal —
see the note in step 5):

```cmd
node --version
sf --version
git --version
```

Expect something like `v20.11.1`, `@salesforce/cli/2.x.x ...`, `git version 2.x`.
If `sf` is not found, close and reopen the Command Prompt — the installer edits
`PATH` and existing windows keep the old one.

---

## 2. Get the code

```cmd
mkdir C:\tools
cd C:\tools
git clone https://github.com/fatimazamann/Scheduled-Salesforce-scratch-org-export-script.git salesforce-export
cd salesforce-export
```

Any folder works. Avoid OneDrive, Dropbox or any synced folder: exports contain
customer configuration, including message template bodies.

Confirm the checkout is sound before pointing it at a real org. This runs the
whole system against a mock Salesforce CLI — no org, no network, no credentials:

```cmd
node test\run-tests.js
```

Expect `211 passed, 0 failed`. If that fails, stop; nothing after this will
work either.

---

## 3. Authenticate the orgs

Skip this if `sf org list` already shows the orgs you want.

Scratch orgs you created on this machine with `sf org create scratch` are
already authenticated. For orgs created elsewhere, authenticate each one **once,
interactively**:

```cmd
sf org login web --alias my-feature-org
```

This is the only step that opens a browser, and it is a one-time human action.
The scheduled job never does it — if an org's authentication dies, the run
reports that org as unreachable and moves on, rather than hanging on a login
prompt at 2am that nobody is there to answer.

Then check what the tool will see:

```cmd
sf org list
```

**What makes an org eligible**, in order:

1. It is a scratch org — flagged by the CLI, in the CLI's `scratchOrgs` bucket,
   or on a `*.scratch.my.salesforce.com` instance URL. Anything explicitly
   marked as a sandbox or Dev Hub is excluded even if it looks scratch-like.
   Production orgs, sandboxes and Dev Hubs are never touched.
2. It is not expired and its status is Active.
3. It is reachable with the stored authentication.
4. It has `cja_cj__CJ_Connector__c` — i.e. ConnectJunction is actually
   installed. This is a metadata check, so an org with the app installed and
   **zero records still exports**; it just produces empty files.

An org failing any of these is skipped with a stated reason, and the run
continues with the others.

---

## 4. Configure

Open `config\export-config.json`. Most people change nothing. The values worth
knowing about:

| Key | Default | What it does |
|---|---|---|
| `exportRoot` | `connectjunction-exports` | where exports land |
| `layout` | `per-org` | one folder per org, replaced each run. No history. `per-run` keeps a timestamped folder per run instead. |
| `orgFolderPattern` | `cj-export_{alias}` | folder name. Tokens: `{alias}` `{orgId}` `{username}` `{usernamePrefix}` |
| `integrationType` | `any-to-any` | `any-to-any` also exports Dataflows |
| `metadata.enabled` | `false` | see step 6 |
| `appCheck.enabled` | `true` | set false to export every reachable scratch org regardless of the app |

Relative paths resolve against the project folder, never the working directory,
so Task Scheduler handing the job `C:\Windows\System32` changes nothing.

Any value can be overridden at run time with an `SFEXPORT_*` environment
variable — see the table in the README. That is how you adjust a scheduled task
without editing a tracked file.

---

## 5. First run

Do these three in order. Each one proves something the next one depends on.

**Dry run** — discovers orgs, prints every eligibility decision and the exact
command it *would* run, and exports nothing. It does not take the run lock, so
it is safe even while a real run is going:

```cmd
scheduled-export.bat --dry-run
```

Read the output. It should list each org and say what it decided. If an org you
expected is missing, this is where you find out.

**One org** — smallest thing that touches a real org:

```cmd
scheduled-export.bat --org my-feature-org
```

**Everything:**

```cmd
scheduled-export.bat
```

> **Run these from a plain Command Prompt, not the VS Code terminal.** VS Code
> injects environment variables that Task Scheduler will not. A script that
> only works inside VS Code will fail at 2am, and the failure will look
> unrelated to VS Code.

---

## 6. Metadata (optional)

Off by default. `config\package.xml` is already in the repo — 25 types, 401
members — so switching it on is one edit:

```json
"metadata": { "enabled": true, ... }
```

Or try it for a single run without editing anything:

```cmd
scheduled-export.bat --org my-feature-org --metadata
```

Metadata runs **after** the data export, into a `metadata\` subfolder inside
that org's folder. A metadata failure is reported but does **not** discard a
data export that already succeeded — the org still counts as a success and the
summary carries a `metadata: FAILED` line. Set `"failureIsFatal": true` if you
would rather a run without metadata count as a failed run.

The first metadata run creates `metadata-project\` — a folder containing
nothing but an `sfdx-project.json`, because `sf project retrieve start` refuses
to run outside an SFDX project. It is gitignored and nothing is written into
it.

Time it before you schedule it: the retrieve happens once per eligible org and
goes straight onto your nightly runtime. The run prints
`Metadata: N component(s), N file(s) in Ns`.

---

## 7. Schedule it

Register the task **as the account that owns the org authentications** (step 0).

```cmd
schtasks /create ^
  /tn "ConnectJunction Nightly Export" ^
  /tr "C:\tools\salesforce-export\scheduled-export.bat" ^
  /sc daily /st 20:00 ^
  /ru "%USERDOMAIN%\%USERNAME%" /rp *
```

`/rp *` prompts for that account's password, which Windows needs in order to
run the task while nobody is logged on.

Or through the Task Scheduler GUI — the settings that matter:

- **General → Run whether user is logged on or not.** Otherwise it only fires
  during an interactive session.
- **General → Run as:** the account from step 0. Not `SYSTEM`.
- **Actions → Program:** the full path to `scheduled-export.bat`. Leave
  arguments empty.
- **Settings → Stop the task if it runs longer than:** a few hours. The tool
  has its own per-org timeouts and a stale-lock reclaim, but a hard backstop
  costs nothing.
- Leave **"Run a new instance in parallel"** off. If two runs do overlap
  anyway, the second exits immediately with code 3 rather than corrupting the
  first — but there is no reason to rely on that.

Test the registration without waiting for 8pm:

```cmd
schtasks /run /tn "ConnectJunction Nightly Export"
schtasks /query /tn "ConnectJunction Nightly Export" /v /fo LIST | findstr "Last"
```

`Last Result: 0` is success. The other codes are in the table below.

---

## 8. Reading a run

```
connectjunction-exports\
    cj-export_my-feature-org\        replaced every run
        cja_cj__CJ_Connector__cs.json
        cja_cj__JSON_Object_Mapping__cs.json
        cja_cj__CJ_Message_Template__cs.json
        cja_cj__Dataflow__cs.json          any-to-any only
        _export-summary.json               when this org was last exported
        metadata\                          only when metadata is on
logs\
    export_20260904_200000.log       human-readable
    export_20260904_200000.json      machine-readable
    latest.json                      the most recent run
```

Exports are written to a temporary folder and only swapped into place once the
export has fully succeeded, so a failed run leaves the previous folder exactly
as it was rather than half-overwriting it.

**Exit codes** (also Task Scheduler's "Last Run Result"):

| Code | Meaning |
|---:|---|
| 0 | every eligible org exported — including "no orgs found" |
| 1 | at least one org failed; the others still ran |
| 2 | preflight or configuration failure; **no orgs were processed** |
| 3 | another run holds the lock; this instance did nothing |

`connectjunction-exports\` and `logs\` are gitignored and must stay that way.

---

## 9. When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `0 orgs discovered`, exit 0, but `sf org list` shows orgs | the task is running as a different Windows account than the one holding the auth store | re-register the task as that account (step 0) |
| `"node" was not found on PATH` | scheduled accounts don't inherit your interactive `PATH` | add Node to the machine `PATH`, or create `set-env.cmd` next to the .bat and set `PATH` there (gitignored) |
| `spawn ...\npm\sf ENOENT` | npm installs three `sf` shims and Windows can't execute the extensionless one | already handled — if you still see it, set `sfCliEntry` in the config to the CLI's `bin\run.js` |
| `'"C:\Users\Cloud' is not recognized` | a space in the CLI path, re-parsed by cmd.exe | same fix: set `sfCliEntry`, which bypasses the shim and the shell entirely |
| Orgs skipped as `SKIPPED_UNREACHABLE` with "most likely deleted or expired" | dead scratch orgs still in the local auth store | `sf org list --clean --no-prompt` — each dead org costs ~1 minute of run time |
| `SKIPPED_APP_NOT_INSTALLED` | that org genuinely has no `cja_cj__CJ_Connector__c` | expected, or set `appCheck.enabled: false` |
| `Possible truncation ... exactly 200 records` | a query hit the `FIELDS(ALL)` ceiling | verify with `sf data query --target-org <alias> --query "SELECT COUNT() FROM <object>"`. Salesforce **requires** `LIMIT <= 200` on `FIELDS(ALL)`; lifting it means moving to explicit field lists. |
| `Entity of type 'Layout' named '...' cannot be found` | the manifest names a component the org doesn't have | that component is not in the backup. Drop the line from `config\package.xml` or create the component. |
| `InvalidProjectWorkspaceError` | metadata retrieve ran outside an SFDX project | the tool creates the scaffold itself; if you hit this running `sf` by hand, `cd metadata-project` first |

Exit code 2 always means **nothing was exported**. Read the top of the log —
preflight names exactly what it couldn't find.

For more detail, run with `--log-level debug`.

---

## 10. Updating

```cmd
cd C:\tools\salesforce-export
git pull
node test\run-tests.js
scheduled-export.bat --dry-run
```

Nothing to reinstall. If the tests pass and the dry run looks right, the
scheduled task picks up the new code on its next fire.

---

## Not on Windows?

Only `scheduled-export.bat` and the Task Scheduler steps are Windows-specific.
The tool itself is plain Node and runs anywhere:

```bash
node orchestrator.js --dry-run
node orchestrator.js
```

Schedule it with cron. Everything else in this document applies unchanged —
including step 0: cron jobs run as a specific user, and that user needs to be
the one holding the CLI auth store.
