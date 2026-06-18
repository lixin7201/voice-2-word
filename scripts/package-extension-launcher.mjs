import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://lixindemac-studio.local:8127';
const releaseDir = path.join(root, 'releases', 'launcher');
const packageFileName = `voice-to-word-browser-launcher-${version}.zip`;
const packageFiles = [
  'README.txt',
  'open-voice-to-word-chrome.command',
  'open-voice-to-word-atlas.command',
  'open-voice-to-word-chrome-windows.cmd',
];

fs.mkdirSync(releaseDir, { recursive: true });
writeReleaseFile('README.txt', readmeText());
writeReleaseFile('open-voice-to-word-chrome.command', macLauncher({ appName: 'Google Chrome', profileName: 'chrome-profile' }), 0o755);
writeReleaseFile('open-voice-to-word-atlas.command', macLauncher({ appName: 'ChatGPT Atlas', profileName: 'atlas-profile' }), 0o755);
writeReleaseFile('open-voice-to-word-chrome-windows.cmd', windowsLauncher());
writeZip(packageFileName, packageFiles);
console.log(`已生成 ${path.join(releaseDir, packageFileName)}`);

function writeReleaseFile(fileName, content, mode = 0o644) {
  const filePath = path.join(releaseDir, fileName);
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, mode);
}

function writeZip(fileName, files) {
  const output = path.join(releaseDir, fileName);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-launcher-'));
  try {
    for (const file of files) {
      fs.copyFileSync(path.join(releaseDir, file), path.join(tempDir, file));
    }
    fs.rmSync(output, { force: true });
    const result = childProcess.spawnSync('zip', ['-q', '-r', output, ...files], {
      cwd: tempDir,
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error('启动器 zip 打包失败，请确认系统已安装 zip 命令');
    fs.chmodSync(output, 0o644);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function readmeText() {
  return `大宜宾录音助手浏览器启动器

这个包不需要谷歌商店，也不需要 VPN。

Mac 用 Chrome：
双击 open-voice-to-word-chrome.command

Mac 用 ChatGPT Atlas：
双击 open-voice-to-word-atlas.command

Windows 用 Chrome：
双击 open-voice-to-word-chrome-windows.cmd

说明：
1. 每次打开启动器，都会先从办公室内网更新最新版录音助手插件。
2. 启动器会打开一个专门用于录音助手的浏览器窗口。
3. 第一次使用时，可能需要重新登录 Plaud 或其他录音网页。
4. 如果 Atlas 不支持加载这个插件，请改用 Chrome 启动器。

服务地址：
${publicBaseUrl}
`;
}

function macLauncher({ appName, profileName }) {
  return `#!/bin/bash
set -euo pipefail

BASE_URL="\${VOICE_TO_WORD_BASE_URL:-${publicBaseUrl}}"
APP_NAME="${appName}"
ROOT="$HOME/.dayibin-voice-to-word"
ZIP_PATH="$ROOT/extension.zip"
LATEST_PATH="$ROOT/latest.json"
EXT_DIR="$ROOT/extension"
TMP_EXT_DIR="$ROOT/extension.tmp"
PROFILE_DIR="$ROOT/${profileName}"

echo "大宜宾录音助手启动器"
echo "正在更新插件..."
mkdir -p "$ROOT"

if /usr/bin/curl -fsSL "$BASE_URL/api/extension/latest" -o "$LATEST_PATH"; then
  DOWNLOAD_URL="$(/usr/bin/sed -n 's/.*"downloadUrl"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$LATEST_PATH" | /usr/bin/head -n 1)"
else
  DOWNLOAD_URL=""
fi

if [ -z "$DOWNLOAD_URL" ]; then
  echo "没有拿到新版地址，请确认办公室网络能访问 $BASE_URL"
  read -r -p "按回车关闭..."
  exit 1
fi

/usr/bin/curl -fsSL "$DOWNLOAD_URL" -o "$ZIP_PATH"
/bin/rm -rf "$TMP_EXT_DIR"
/bin/mkdir -p "$TMP_EXT_DIR"
/usr/bin/ditto -x -k "$ZIP_PATH" "$TMP_EXT_DIR"
/bin/rm -rf "$EXT_DIR"
/bin/mv "$TMP_EXT_DIR" "$EXT_DIR"
/bin/mkdir -p "$PROFILE_DIR"

echo "正在打开 $APP_NAME..."
if ! /usr/bin/open -na "$APP_NAME" --args --user-data-dir="$PROFILE_DIR" --load-extension="$EXT_DIR" "$BASE_URL/app"; then
  echo "没有找到 $APP_NAME，请确认已经安装。"
  read -r -p "按回车关闭..."
  exit 1
fi

echo "已打开。第一次使用可能需要重新登录录音网页。"
`;
}

function windowsLauncher() {
  return `@echo off
setlocal

set "BASE_URL=${publicBaseUrl}"
set "ROOT=%LOCALAPPDATA%\\DayibinVoiceToWord"
set "ZIP_PATH=%ROOT%\\extension.zip"
set "LATEST_PATH=%ROOT%\\latest.json"
set "EXT_DIR=%ROOT%\\extension"
set "PROFILE_DIR=%ROOT%\\chrome-profile"

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

set "CHROME=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"
if not exist "%CHROME%" (
  echo 没有找到 Google Chrome，请先安装 Chrome。
  pause
  exit /b 1
)

echo 正在打开 Chrome...
start "" "%CHROME%" --user-data-dir="%PROFILE_DIR%" --load-extension="%EXT_DIR%" "%BASE_URL%/app"
`;
}
