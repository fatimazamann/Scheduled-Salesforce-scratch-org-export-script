# Setup

Exports ConnectJunction (`cja_cj`) configuration from every eligible scratch org
authenticated on this machine, on a schedule, without opening a browser.

## 1. Install

| | |
|---|---|
| Node.js 18+ | <https://nodejs.org> (LTS) |
| Salesforce CLI v2 | <https://developer.salesforce.com/tools/salesforcecli> |
| Git | <https://git-scm.com/download/win> |

Reopen your terminal after installing, then check:

```cmd
node --version
sf --version
git --version
```

## 2. Authenticate your orgs

In VS Code: **Ctrl+Shift+P → SFDX: Authorize an Org**, once per org.

Or in a terminal:

```cmd
sf org login web --alias my-feature-org
```

Either way writes to the same place. This is the only step that opens a
browser — the scheduled job never does.

Check what the tool will see:

```cmd
sf org list
```

## 3. Get the code

```cmd
cd C:\tools
git clone https://github.com/fatimazamann/Scheduled-Salesforce-scratch-org-export-script.git salesforce-export
cd salesforce-export
```

No `npm install` — there are no dependencies.

## 4. Verify the checkout

```cmd
node test\run-tests.js
```

Expect `215 passed, 0 failed`. Runs against a mock CLI — no org, no network.

## 5. Run it

In order. Use a plain Command Prompt, not the VS Code terminal (VS Code sets
environment variables that Task Scheduler won't, so a pass there can still fail
at 8pm).

```cmd
scheduled-export.bat --dry-run
scheduled-export.bat --org my-feature-org
scheduled-export.bat
```

`--dry-run` lists every org and what it decided, and exports nothing.

## 6. Metadata (optional)

`config\package.xml` is already in the repo. Try it for one run:

```cmd
scheduled-export.bat --org my-feature-org --metadata
```

To make it permanent, set `"enabled": true` in the `metadata` block of
`config\export-config.json`.

## 7. Schedule it

```cmd
schtasks /create ^
  /tn "ConnectJunction Nightly Export" ^
  /tr "C:\tools\salesforce-export\scheduled-export.bat" ^
  /sc daily /st 20:00 ^
  /ru "%USERDOMAIN%\%USERNAME%" /rp *
```

> **Register it as the account that authenticated the orgs.** The CLI stores
> authentication per Windows profile, so a task running as `SYSTEM` finds an
> empty store and reports "0 orgs discovered, exit 0" — success, with nothing
> exported.

In the GUI, tick **Run whether user is logged on or not**.

Test it without waiting:

```cmd
schtasks /run /tn "ConnectJunction Nightly Export"
```

## Output

```
connectjunction-exports\cj-export_<alias>\    replaced every run
logs\latest.json                              most recent run
```

| Exit code | Meaning |
|---:|---|
| 0 | all eligible orgs exported (including "none found") |
| 1 | at least one org failed; the rest still ran |
| 2 | preflight failure; nothing was exported |
| 3 | another run is already active |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `0 orgs discovered` but `sf org list` shows orgs | the task is running as the wrong Windows account — see step 7 |
| `"node" was not found on PATH` | add Node to the machine PATH, or create `set-env.cmd` next to the .bat and set PATH there |
| `spawn ...\npm\sf ENOENT` or `'"C:\Users\Cloud' is not recognized` | set `sfCliEntry` in the config to the CLI's `bin\run.js` |
| `SKIPPED_UNREACHABLE` — "deleted or expired" | `sf org list --clean --no-prompt` |
| `SKIPPED_APP_NOT_INSTALLED` | that org has no `cja_cj__CJ_Connector__c`; expected |
| `Entity of type '...' cannot be found` | `config\package.xml` names something the org lacks — drop the line |

Run with `--log-level debug` for more.

## Updating

```cmd
git pull
node test\run-tests.js
scheduled-export.bat --dry-run
```
