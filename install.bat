@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>nul
title dsh-plain-approvals installer
set "HERE=%~dp0"
set "NODE_EXE="

if not exist "%HERE%install.mjs" goto :no_script

rem --- 1) node.exe from PATH
for %%I in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:I"

rem --- 2) common install locations
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\current\node.exe" set "NODE_EXE=%APPDATA%\nvm\current\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" set "NODE_EXE=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Volta\bin\node.exe"

rem --- 3) runtime bundled with the DSH desktop app
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes" for /d %%R in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do if exist "%%~R\dependencies\node\bin\node.exe" set "NODE_EXE=%%~R\dependencies\node\bin\node.exe"

if not defined NODE_EXE goto :no_node

"%NODE_EXE%" "%HERE%install.mjs" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

:no_node
powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand WwBDAG8AbgBzAG8AbABlAF0AOgA6AE8AdQB0AHAAdQB0AEUAbgBjAG8AZABpAG4AZwA9AFsAVABlAHgAdAAuAEUAbgBjAG8AZABpAG4AZwBdADoAOgBVAFQARgA4AAoAVwByAGkAdABlAC0ASABvAHMAdAAgACIAIgAKAFcAcgBpAHQAZQAtAEgAbwBzAHQAIAAiACAAIAChbAlnfmIwUiAATgBvAGQAZQAuAGoAcwAM/4lbxYgagSxn0Y0NTneNZWcCMCIAIAAtAEYAbwByAGUAZwByAG8AdQBuAGQAQwBvAGwAbwByACAAWQBlAGwAbABvAHcACgBXAHIAaQB0AGUALQBIAG8AcwB0ACAAIgAiAAoAVwByAGkAdABlAC0ASABvAHMAdAAgACIAIAAgAEQAZQBlAHAAUwBlAGUAawAgAEgAYQByAG4AZQBzAHMAIABMaGKXSHIATiyC6oEmXiAATgBvAGQAZQAgANCPTIj2ZQz/Rk/ZjyFroWwoV9iepItNT25/fmIwUgIwIgAKAFcAcgBpAHQAZQAtAEgAbwBzAHQAIAAiACAAIAD7TgmQAE7NeZ5S1WxzU+9TGv8iAAoAVwByAGkAdABlAC0ASABvAHMAdAAgACIAIgAKAFcAcgBpAHQAZQAtAEgAbwBzAHQAIAAiACAAIAAgACAAMQApACAASFEvVKhSAE4hayAARABlAGUAcABTAGUAZQBrACAASABhAHIAbgBlAHMAcwAgAExoYpdIcgz/jVHMU/tRLGeHZfZOIgAKAFcAcgBpAHQAZQAtAEgAbwBzAHQAIAAiACAAIAAgACAAMgApACAAMFIgAGgAdAB0AHAAcwA6AC8ALwBuAG8AZABlAGoAcwAuAG8AcgBnAC8AIAALTn2PIABMAFQAUwAgAEhyDP8ATu+NDDALTgBOZWsNMMWIfVkiAAoAVwByAGkAdABlAC0ASABvAHMAdAAgACIAIgAKAFcAcgBpAHQAZQAtAEgAbwBzAHQAIAAiACAAIADFiH1ZS04OVM2RsGXMU/tRIABpAG4AcwB0AGEAbABsAC4AYgBhAHQAAjAiAAoAVwByAGkAdABlAC0ASABvAHMAdAAgACIAIgA=
pause
exit /b 1

:no_script
powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand WwBDAG8AbgBzAG8AbABlAF0AOgA6AE8AdQB0AHAAdQB0AEUAbgBjAG8AZABpAG4AZwA9AFsAVABlAHgAdAAuAEUAbgBjAG8AZABpAG4AZwBdADoAOgBVAFQARgA4AAoAVwByAGkAdABlAC0ASABvAHMAdAAgACIAIgAKAFcAcgBpAHQAZQAtAEgAbwBzAHQAIAAiACAAIAB+Yg1OMFIgAGkAbgBzAHQAYQBsAGwALgBtAGoAcwACMCIAIAAtAEYAbwByAGUAZwByAG8AdQBuAGQAQwBvAGwAbwByACAAWQBlAGwAbABvAHcACgBXAHIAaQB0AGUALQBIAG8AcwB0ACAAIgAiAAoAVwByAGkAdABlAC0ASABvAHMAdAAgACIAIAAgAGkAbgBzAHQAYQBsAGwALgBiAGEAdAAgAMVfe5iMVCAAaQBuAHMAdABhAGwAbAAuAG0AagBzACAAPmUoVwxUAE4qTodl9k45WcyRAjAiAAoAVwByAGkAdABlAC0ASABvAHMAdAAgACIAIAAgAIJZnGdgT+pT92KGTiAALgBiAGEAdAAM//eLimJ0ZSpOh2X2TjlZAE53jfdix49lZwIwIgAKAFcAcgBpAHQAZQAtAEgAbwBzAHQAIAAiACIA
pause
exit /b 1