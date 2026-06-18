@echo off
setlocal

set "BASE_URL=http://lixindemac-studio.local:8127"
set "ROOT=%LOCALAPPDATA%\DayibinVoiceToWord"
set "ZIP_PATH=%ROOT%\extension.zip"
set "LATEST_PATH=%ROOT%\latest.json"
set "EXT_DIR=%ROOT%\extension"
set "PROFILE_DIR=%ROOT%\chrome-profile"

echo 大宜宾录音助手启动器
echo 正在更新插件...
if not exist "%ROOT%" mkdir "%ROOT%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$base='%BASE_URL%'; $root='%ROOT%'; $zip='%ZIP_PATH%'; $latest='%LATEST_PATH%'; $ext='%EXT_DIR%';" ^
  "$info=Invoke-RestMethod -Uri ($base + '/api/extension/latest');" ^
  "$url=$info.latestExtension.downloadUrl; if (-not $url) { throw '没有拿到新版地址' };" ^
  "Invoke-WebRequest -Uri $url -OutFile $zip;" ^
  "if (Test-Path $ext) { Remove-Item $ext -Recurse -Force };" ^
  "New-Item -ItemType Directory -Path $ext -Force | Out-Null;" ^
  "Expand-Archive -Path $zip -DestinationPath $ext -Force;"

if not "%errorlevel%"=="0" (
  echo 更新失败，请确认办公室网络能访问 %BASE_URL%
  pause
  exit /b 1
)

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo 没有找到 Google Chrome，请先安装 Chrome。
  pause
  exit /b 1
)

echo 正在打开 Chrome...
start "" "%CHROME%" --user-data-dir="%PROFILE_DIR%" --load-extension="%EXT_DIR%" "%BASE_URL%/app"
