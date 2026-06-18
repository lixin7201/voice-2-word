#!/bin/bash
set -euo pipefail

APP_ID="njkpohlpnngjhmlicpdnnijnbnahjakl"
UPDATE_URL="http://lixindemac-studio.local:8127/releases/extension-crx/updates.xml"
PLIST="/Library/Preferences/com.google.Chrome.plist"
TMP_PLIST="$(mktemp /tmp/dayibin-chrome-policy.XXXXXX.plist)"

cleanup() {
  rm -f "$TMP_PLIST"
}
trap cleanup EXIT

echo "大宜宾录音助手自动更新版安装器"
echo
echo "接下来会写入 Chrome 插件安装策略，需要输入一次电脑密码。"
echo "安装完成后会自动重启 Chrome。"
echo

if [ -f "$PLIST" ]; then
  cp "$PLIST" "$TMP_PLIST" 2>/dev/null || true
else
  cat > "$TMP_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
PLIST
fi

/usr/libexec/PlistBuddy -c "Add :ExtensionSettings dict" "$TMP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :ExtensionSettings:$APP_ID" "$TMP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :ExtensionSettings:$APP_ID dict" "$TMP_PLIST"
/usr/libexec/PlistBuddy -c "Add :ExtensionSettings:$APP_ID:installation_mode string force_installed" "$TMP_PLIST"
/usr/libexec/PlistBuddy -c "Add :ExtensionSettings:$APP_ID:update_url string $UPDATE_URL" "$TMP_PLIST"
/usr/libexec/PlistBuddy -c "Add :ExtensionSettings:$APP_ID:override_update_url bool true" "$TMP_PLIST"
/usr/bin/plutil -convert xml1 "$TMP_PLIST"

sudo /bin/mkdir -p /Library/Preferences
sudo /bin/cp "$TMP_PLIST" "$PLIST"
sudo /usr/sbin/chown root:wheel "$PLIST"
sudo /bin/chmod 644 "$PLIST"

echo
echo "Chrome 策略已写入，正在重启 Chrome..."
/usr/bin/osascript -e 'tell application "Google Chrome" to quit' >/dev/null 2>&1 || true
/bin/sleep 2
/usr/bin/open -a "Google Chrome" "chrome://extensions" >/dev/null 2>&1 || true

echo
echo "安装完成。Chrome 打开后，请等待 10-30 秒，列表里会出现“大宜宾录音助手”。"
echo "如果之前手动加载过旧版，请在 chrome://extensions 里移除旧版。"
echo
read -r -p "按回车关闭这个窗口..."
