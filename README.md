# Scheduled Salesforce Scratch-Org Export

Periodically exports `cja_cj` application configuration from every eligible
scratch org that is authenticated on this machine, without a developer running
the exporter org by org, and without ever opening a browser.

```
Windows Task Scheduler
  └─ scheduled-export.bat        thin entrypoint: cwd, PATH, node check
       └─ orchestrator.js        discovery, eligibility, locking, logging, retry
            └─ export-script.js  one org per invocation: SOQL + sf data export tree
                 ├─ clean-json.js
                 └─ sf project retrieve start   (optional, manifest-driven)
```

## Install

1. Copy this folder onto the machine that will run the schedule.
2. **Copy your existing `clean-json.js` into the project root.** It is not
   shipped here; the exporter calls it with its existing contract
   `node clean-json.js <directory> <comma,separated,fields>`.
3. Review `config/export-config.json`.
4. There are no runtime dependencies — no `npm install` step.

## Run it by hand first

```cmd
scheduled-export.bat --dry-run
```

A dry run discovers orgs, prints every eligibility decision and the exact child
command it *would* run, and exports nothing. It does not take the run lock, so
it is safe to use while a real run is in progress.

Then a single org:

```cmd
scheduled-export.bat --org my-feature-org
```

Then everything:

```cmd
scheduled-export.bat
```

Run these from a plain Command Prompt, **not** from the VS Code terminal. VS
Code injects environment variables that Task Scheduler will not, and a script
that only works inside VS Code will fail at 2am.

## Exit codes

| Code | Meaning |
|-----:|---------|
| 0 | Every eligible org exported successfully (including "no orgs found") |
| 1 | At least one org export failed; the others still ran |
| 2 | Preflight, configuration or discovery failure; no orgs were processed |
| 3 | Another run holds the lock; this instance exited without doing work |

## Output

```
connectjunction-exports\
    cj-export_my-feature-org\        one folder per org, replaced every run
        cja_cj__CJ_Connector__cs.json
        cja_cj__JSON_Object_Mapping__cs.json
        cja_cj__CJ_Message_Template__cs.json
        cja_cj__Dataflow__cs.json     any-to-any only
        export-demo-plan.json
        _export-summary.json          when this org was last exported
        metadata\                     only when metadata.enabled
            classes\ objects\ layouts\ ...
            _metadata-summary.json
    cj-export_integration-test\
    cj-export_dev-org-4\

logs\
    export_20260831_183000.log        human-readable
    export_20260831_183000.json       machine-readable
    latest.json                       copy of the most recent run
```

The export root always shows the current state of each org and nothing
accumulates — three orgs means three folders, tonight replacing last night.
`_export-summary.json` inside each folder records when that org was last
exported.

A run writes into a temporary folder and only swaps it into place once the
export has fully succeeded, so a failed or partial run leaves the existing
folder exactly as it was rather than half-overwriting it.

**There is no history under this layout.** Once tonight succeeds, last night's
content is gone. Set `"layout": "per-run"` to keep a timestamped folder per run
instead, pruned by `exportRetentionDays`.

`connectjunction-exports/` and `logs/` are gitignored and must stay that way:
the exports contain customer configuration, including message template bodies.

## Metadata

Off by default. Two steps to turn it on:

```cmd
copy "C:\path\to\your\package.xml" "C:\tools\salesforce-export\config\package.xml"
```

then set `"enabled": true` in the `metadata` block of
`config/export-config.json`. Check it first without touching the schedule:

```cmd
scheduled-export.bat --org my-feature-org --metadata
```

Metadata runs **after** the data export, per org, into `metadata\` inside that
org's folder. The two are deliberately separate:

* Data is the part that cannot be reconstructed from a repo. Metadata usually
  can. If only one of the two can finish, data wins.
* A failed retrieve is **reported, not fatal** — the data export that already
  succeeded is still swapped into place, the org still counts as a success, and
  the run summary carries a `metadata: FAILED` line. Set
  `"failureIsFatal": true` if a run without metadata should count as a failed
  run instead.
* `metadata.timeoutSeconds` is **added** to `childTimeoutSeconds`, never shared
  with it, so a slow retrieve can never get the child killed after the data
  export has already succeeded.

`sf project retrieve start` refuses to run outside an SFDX project, so the
first run creates `metadata-project/` — a folder containing nothing but an
`sfdx-project.json`. It is gitignored and nothing is ever written into it; the
retrieved files go to `--output-dir`.

Two things worth knowing about manifests:

* **A manifest that names every component explicitly goes stale.** Anything
  created in an org after the manifest was written is silently absent from the
  backup, and nothing says so, because the retrieve succeeded exactly as
  instructed. `config/package.xml.example` shows the wildcard alternative.
* **Fields are not a gap.** Fields, list views, record types and web links are
  children of `CustomObject` and come back whenever their object is retrieved,
  listed individually or not.

When the org lacks something the manifest names, the retrieve still *succeeds*
and reports it as a warning. Those warnings are pulled out of the JSON and
logged individually — `Entity of type 'Layout' named '...' cannot be found`
means that component is not in the backup.

The retrieve always runs with `--json`. The human-readable form is a table with
one row per component; several hundred rows per org would bury everything else
in the nightly log.

## Configuration

`config/export-config.json` is the source of truth. Any value can be overridden
at run time with an environment variable, which is how you adjust a scheduled
task without editing a tracked file:

| Variable | Overrides |
|---|---|
| `SFEXPORT_CONFIG` | path to the config file |
| `SFEXPORT_EXPORT_ROOT` / `SFEXPORT_LOG_ROOT` | output locations |
| `SFEXPORT_LAYOUT` | `per-org` \| `per-run` |
| `SFEXPORT_SF_EXECUTABLE` / `SFEXPORT_SF_CLI_ENTRY` | how `sf` is invoked |
| `SFEXPORT_INTEGRATION_TYPE` | `any-to-any` \| `salesforce-to-any` \| empty |
| `SFEXPORT_CONNECTORS` | comma-separated connector filter |
| `SFEXPORT_METADATA` | `true` / `false` — metadata retrieve on or off |
| `SFEXPORT_METADATA_MANIFEST` | path to the package.xml |
| `SFEXPORT_METADATA_NAMESPACE` | namespace the manifest's names resolve against |
| `SFEXPORT_METADATA_FATAL` | `true` makes a failed retrieve fail the org |
| `SFEXPORT_METADATA_TIMEOUT_SECONDS` | retrieve budget, added to the child's |
| `SFEXPORT_APP_CHECK` | `true` / `false` |
| `SFEXPORT_APP_CHECK_OBJECT` | probe object, default `cja_cj__CJ_Connector__c` |
| `SFEXPORT_MAX_RETRIES`, `SFEXPORT_CHILD_TIMEOUT_SECONDS` | execution |
| `SFEXPORT_DRY_RUN`, `SFEXPORT_LOG_LEVEL` | diagnostics |
| `SFEXPORT_LOG_RETENTION_DAYS`, `SFEXPORT_EXPORT_RETENTION_DAYS` | housekeeping |

If the scheduled account cannot see `node` or `sf`, create `set-env.cmd` next to
`scheduled-export.bat` (gitignored) and set `PATH` there.

## Running the child directly

```cmd
node export-script.js --user test-abc@example.com --dir "C:\exports\one-off" --type Scratch --integration any-to-any
```

`--type Scratch` (or `x`) is new. It means *this org must already be
authenticated*; a scratch org will never trigger a browser login. `--interactive`
opts back in to `sf org login web` for Sandbox and Production only.

## Tests

```cmd
node test\run-tests.js
```

208 assertions covering the full test matrix against a mock Salesforce CLI: org
discovery and filtering, expiry, package detection, failure isolation, retry
policy, locking, dry run, paths with spaces, SOQL escaping, Windows command-line
escaping, metadata retrieve (including that a metadata failure never discards a
good data export), and secret redaction. No org and no network required.
