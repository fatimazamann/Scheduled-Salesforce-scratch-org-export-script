@echo off
rem ===========================================================================
rem  scheduled-export.bat
rem ---------------------------------------------------------------------------
rem  Entry point for Windows Task Scheduler.
rem
rem  This file is deliberately THIN. It does four things and nothing more:
rem
rem     1. anchors the working directory to the script's own folder
rem     2. optionally sources a machine-local environment file
rem     3. verifies Node.js is runnable by THIS account
rem     4. hands off to orchestrator.js and propagates its exit code
rem
rem  All JSON parsing, org discovery, eligibility logic, locking, logging and
rem  retry handling live in orchestrator.js. Batch has no JSON parser, no
rem  arrays, no exception handling and a string-quoting model that is a
rem  liability once user data is involved -- putting discovery logic here would
rem  make the whole system fragile for no benefit. Node is already a hard
rem  dependency of this project (the exporter is a Node script), so using it
rem  for the parent adds no new moving part. PowerShell would add one.
rem
rem  EXIT CODES (returned unchanged from orchestrator.js)
rem     0  every eligible org exported successfully (including "nothing to do")
rem     1  at least one org export failed
rem     2  preflight / configuration / discovery failure
rem     3  another run holds the lock; this instance exited without doing work
rem
rem  Usage:
rem     scheduled-export.bat
rem     scheduled-export.bat --dry-run
rem     scheduled-export.bat --org test-abc@example.com
rem ===========================================================================

setlocal EnableExtensions

rem --- 1. Anchor to this script's directory ---------------------------------
rem  Task Scheduler often starts a task in C:\Windows\System32. %~dp0 is the
rem  folder containing this file and always ends with a backslash, so every
rem  path below is absolute regardless of how the task was launched.
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" || (
    echo [scheduled-export] FATAL: cannot change directory to "%SCRIPT_DIR%".
    exit /b 2
)

rem --- 2. Optional machine-local environment --------------------------------
rem  A scheduled task does NOT inherit an interactive user's PATH. If the
rem  run-as account cannot see node or sf, create set-env.cmd next to this file
rem  and set PATH (and any SFEXPORT_* overrides) there. It is gitignored, so
rem  machine-specific settings never end up in the repository.
rem
rem  Example set-env.cmd:
rem      set "PATH=C:\Program Files\nodejs;C:\Program Files\sf\bin;%PATH%"
rem      set "SFEXPORT_LOG_LEVEL=debug"
if exist "%SCRIPT_DIR%set-env.cmd" (
    call "%SCRIPT_DIR%set-env.cmd"
    if errorlevel 1 (
        echo [scheduled-export] FATAL: set-env.cmd failed.
        popd
        exit /b 2
    )
)

rem --- 3. Verify Node.js is runnable by this account ------------------------
rem  orchestrator.js performs the full preflight (sf, scripts, writable dirs),
rem  but it cannot report a missing Node runtime -- it needs Node to run. So
rem  that one check has to happen here.
where node >nul 2>&1
if errorlevel 1 (
    echo [scheduled-export] FATAL: "node" was not found on PATH for user %USERDOMAIN%\%USERNAME%.
    echo [scheduled-export] A scheduled task uses the PATH of its run-as account, not yours.
    echo [scheduled-export] Add Node.js to the machine PATH, or set it in set-env.cmd next to this script.
    popd
    exit /b 2
)

rem --- 4. Run the orchestrator ----------------------------------------------
rem  %* forwards any flags (--dry-run, --org, --config ...) through unchanged.
node "%SCRIPT_DIR%orchestrator.js" %*
set "RUN_RC=%ERRORLEVEL%"

popd

rem  Report the outcome in plain language. Task Scheduler shows the numeric
rem  code in "Last Run Result"; this line is for whoever reads the console or
rem  a redirected transcript.
if "%RUN_RC%"=="0" echo [scheduled-export] Completed: all eligible exports succeeded.
if "%RUN_RC%"=="1" echo [scheduled-export] Completed with failures: see the run log in the logs folder.
if "%RUN_RC%"=="2" echo [scheduled-export] Aborted: preflight or discovery failed; no orgs were processed.
if "%RUN_RC%"=="3" echo [scheduled-export] Skipped: another export run is already active.

exit /b %RUN_RC%
