@echo off
rem herdr-agents - Windows launcher for the JavaScript entry
rem (herdr-agents.mjs, next to this file). Runs the entry with node when it
rem is on PATH and is version 20 or newer, else with bun; passes %* through
rem and exits with the runtime's code.
rem
rem Not exercised by the test suites (they run on POSIX hosts): review the
rem batch specifics before relying on it.

rem node -e exits 0 only when node runs and its major version is 20 or
rem newer; the redirections keep the line quiet when node is missing.
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto try_bun
node "%~dp0herdr-agents.mjs" %*
exit /b %errorlevel%

:try_bun
where bun >nul 2>nul
if errorlevel 1 goto no_runtime
bun "%~dp0herdr-agents.mjs" %*
exit /b %errorlevel%

:no_runtime
echo herdr-agents: needs Node.js 20+ or Bun 1>&2
exit /b 2
