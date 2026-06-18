#!/bin/bash
set -euo pipefail

BASE_URL="${VOICE_TO_WORD_BASE_URL:-http://lixindemac-studio.local:8127}"
APP_NAME="Google Chrome"
ROOT="$HOME/.dayibin-voice-to-word"
ZIP_PATH="$ROOT/extension.zip"
LATEST_PATH="$ROOT/latest.json"
EXT_DIR="$ROOT/extension"
TMP_EXT_DIR="$ROOT/extension.tmp"
PROFILE_DIR="$ROOT/chrome-profile"

echo "大宜宾录音助手启动器"
echo "正在更新插件..."
mkdir -p "$ROOT"

if /usr/bin/curl -fsSL "$BASE_URL/api/extension/latest" -o "$LATEST_PATH"; then
  DOWNLOAD_URL="$(/usr/bin/sed -n 's/.*"downloadUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$LATEST_PATH" | /usr/bin/head -n 1)"
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
