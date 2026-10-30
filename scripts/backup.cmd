@echo off
rem ============================================================
rem scripts/backup.cmd -- Windows Task Scheduler wrapper
rem
rem ASCII ONLY. Do not put Chinese (or any non-ASCII) text in this file:
rem cmd.exe reads .cmd in the OEM code page (GBK here), so a UTF-8 comment
rem becomes garbage and gets executed as commands. Verified the hard way.
rem
rem Register (already done on this machine):
rem   schtasks /Create /F /SC DAILY /ST 03:17 /TN "wt-agent-backup" ^
rem     /TR "E:\20261024-wt\wt-agent\scripts\backup.cmd"
rem Query:  schtasks /Query /TN "wt-agent-backup" /V /FO LIST
rem Delete: schtasks /Delete /TN "wt-agent-backup" /F
rem Note:   from Git Bash, prefix with MSYS_NO_PATHCONV=1 or /Create becomes a path.
rem ============================================================

setlocal
set "REPO=E:\20261024-wt\wt-agent"

if not exist "%REPO%\scripts\backup.sh" (
  echo [backup] missing %REPO%\scripts\backup.sh >> "%REPO%\backup\backup.log"
  exit /b 1
)
if not exist "%REPO%\backup" mkdir "%REPO%\backup"

"%ProgramFiles%\Git\bin\bash.exe" -lc "cd /e/20261024-wt/wt-agent && bash scripts/backup.sh"
exit /b %ERRORLEVEL%
