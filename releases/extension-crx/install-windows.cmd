@echo off
setlocal

set "APP_ID=njkpohlpnngjhmlicpdnnijnbnahjakl"
set "UPDATE_URL=http://lixindemac-studio.local:8127/releases/extension-crx/updates.xml"
set "POLICY_KEY=HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist"
set "POLICY_VALUE=9901"

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo 正在请求管理员权限，请在弹窗里点“是”。
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo 大宜宾录音助手自动更新版安装器
echo.
echo 正在写入 Chrome 插件安装策略...
reg add "%POLICY_KEY%" /v "%POLICY_VALUE%" /t REG_SZ /d "%APP_ID%;%UPDATE_URL%" /f
if not "%errorlevel%"=="0" (
  echo 安装失败：无法写入 Chrome 策略。
  pause
  exit /b 1
)

echo.
echo 正在重启 Chrome...
taskkill /IM chrome.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "chrome.exe" "chrome://extensions"

echo.
echo 安装完成。Chrome 打开后，请等待 10-30 秒，列表里会出现“大宜宾录音助手”。
echo 如果之前手动加载过旧版，请在 chrome://extensions 里移除旧版。
echo.
pause
