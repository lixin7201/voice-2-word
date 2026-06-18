import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const keyPath = process.env.EXTENSION_KEY_PATH || '';
const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://lixindemac-studio.local:8127';
const releaseDir = path.join(root, 'releases', 'extension-crx');
const packageFiles = [
  'manifest.json',
  'background.js',
  'sidepanel.html',
  'sidepanel.js',
  'sidepanel.css',
  'options.html',
  'options.js',
  'icon.png',
];

if (!keyPath) {
  throw new Error('请先设置 EXTENSION_KEY_PATH，指向固定 CRX 私钥 PEM 文件。');
}
if (!fs.existsSync(keyPath)) throw new Error(`CRX 私钥不存在：${keyPath}`);
if (!fs.existsSync(chromePath)) throw new Error(`未找到 Chrome：${chromePath}`);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const appId = process.env.EXTENSION_ID || extensionIdFromPrivateKey(fs.readFileSync(keyPath, 'utf8'));
const updateUrl = `${publicBaseUrl.replace(/\/$/, '')}/releases/extension-crx/updates.xml`;
const crxFileName = `voice-to-word-extension-${version}.crx`;
const crxUrl = `${publicBaseUrl.replace(/\/$/, '')}/releases/extension-crx/${crxFileName}`;
const installerZipFileName = `voice-to-word-auto-installer-${version}.zip`;
const installerZipUrl = `${publicBaseUrl.replace(/\/$/, '')}/releases/extension-crx/${installerZipFileName}`;
const outputPath = path.join(releaseDir, crxFileName);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-extension-crx-'));

fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(outputPath, { force: true });

try {
  for (const relativePath of packageFiles) {
    const source = path.join(root, relativePath);
    if (!fs.existsSync(source)) throw new Error(`缺少扩展文件：${relativePath}`);
    const target = path.join(tempDir, relativePath);
    if (relativePath === 'manifest.json') {
      fs.writeFileSync(target, `${JSON.stringify({ ...manifest, update_url: updateUrl }, null, 2)}\n`);
    } else {
      fs.copyFileSync(source, target);
    }
  }

  const result = childProcess.spawnSync(chromePath, [
    `--pack-extension=${tempDir}`,
    `--pack-extension-key=${keyPath}`,
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Chrome CRX 打包失败');

  const packedCrx = `${tempDir}.crx`;
  if (!fs.existsSync(packedCrx)) throw new Error('未找到 Chrome 生成的 CRX 文件');
  fs.renameSync(packedCrx, outputPath);
  fs.chmodSync(outputPath, 0o644);
  fs.rmSync(`${tempDir}.pem`, { force: true });

  const updatesXml = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${appId}">
    <updatecheck codebase="${crxUrl}" version="${version}" />
  </app>
</gupdate>
`;
  writeReleaseFile('updates.xml', updatesXml);
  writeReleaseFile('install-windows-force-policy.reg', windowsPolicyRegistry({ appId, updateUrl }));
  writeReleaseFile('com.google.Chrome.plist', macChromePlist({ appId, updateUrl }));
  writeReleaseFile('voice-to-word-chrome-policy.mobileconfig', macChromeMobileconfig({ appId, updateUrl }));
  writeReleaseFile('install-mac.command', macInstallerCommand({ appId, updateUrl }), 0o755);
  writeReleaseFile('install-windows.cmd', windowsInstallerCommand({ appId, updateUrl }));
  writeReleaseFile('INSTALL.txt', installerReadme({ appId, updateUrl }));
  writeInstallerZip(installerZipFileName, [
    'INSTALL.txt',
    'install-mac.command',
    'install-windows.cmd',
  ]);
  writeReleaseFile('metadata.json', `${JSON.stringify({
    name: manifest.name || '大宜宾录音助手',
    version,
    appId,
    updateUrl,
    crxUrl,
    installerZipUrl,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  writeReleaseFile('README.md', releaseReadme({ version, appId, updateUrl, crxUrl, installerZipUrl }));
  console.log(`已生成 ${outputPath}`);
  console.log(`已生成 ${path.join(releaseDir, installerZipFileName)}`);
  console.log(`扩展 ID：${appId}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function writeReleaseFile(fileName, content, mode = 0o644) {
  const filePath = path.join(releaseDir, fileName);
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, mode);
}

function writeInstallerZip(fileName, packageFiles) {
  const output = path.join(releaseDir, fileName);
  const tempInstallerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-extension-installer-'));
  try {
    for (const relativePath of packageFiles) {
      fs.copyFileSync(path.join(releaseDir, relativePath), path.join(tempInstallerDir, relativePath));
    }
    fs.rmSync(output, { force: true });
    const result = childProcess.spawnSync('zip', ['-q', '-r', output, ...packageFiles], {
      cwd: tempInstallerDir,
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error('安装包 zip 打包失败，请确认系统已安装 zip 命令');
    fs.chmodSync(output, 0o644);
  } finally {
    fs.rmSync(tempInstallerDir, { recursive: true, force: true });
  }
}

function extensionIdFromPrivateKey(privateKeyPem) {
  const publicKeyDer = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(publicKeyDer).digest();
  return [...hash.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((value) => String.fromCharCode('a'.charCodeAt(0) + value))
    .join('');
}

function windowsPolicyRegistry({ appId, updateUrl }) {
  return `Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist]
"1"="${appId};${updateUrl}"
`;
}

function macInstallerCommand({ appId, updateUrl }) {
  return `#!/bin/bash
set -euo pipefail

APP_ID="${appId}"
UPDATE_URL="${updateUrl}"
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
`;
}

function windowsInstallerCommand({ appId, updateUrl }) {
  return `@echo off
setlocal

set "APP_ID=${appId}"
set "UPDATE_URL=${updateUrl}"
set "POLICY_KEY=HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist"
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
`;
}

function macChromePlist({ appId, updateUrl }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ExtensionInstallForcelist</key>
  <array>
    <string>${appId};${updateUrl}</string>
  </array>
</dict>
</plist>
`;
}

function macChromeMobileconfig({ appId, updateUrl }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadDisplayName</key>
      <string>Custom: com.google.Chrome</string>
      <key>PayloadIdentifier</key>
      <string>cc.dayibin.voice-to-word.chrome.policy.preferences</string>
      <key>PayloadType</key>
      <string>com.apple.ManagedClient.preferences</string>
      <key>PayloadUUID</key>
      <string>9B6A9846-D1D2-46F9-A6D9-7D1D14DF7E73</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadEnabled</key>
      <true/>
      <key>PayloadContent</key>
      <dict>
        <key>com.google.Chrome</key>
        <dict>
          <key>Forced</key>
          <array>
            <dict>
              <key>mcx_preference_settings</key>
              <dict>
                <key>ExtensionSettings</key>
                <dict>
                  <key>${appId}</key>
                  <dict>
                    <key>installation_mode</key>
                    <string>force_installed</string>
                    <key>update_url</key>
                    <string>${updateUrl}</string>
                    <key>override_update_url</key>
                    <true/>
                  </dict>
                </dict>
              </dict>
            </dict>
          </array>
        </dict>
      </dict>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Force install and update the Voice to Word Chrome extension.</string>
  <key>PayloadDisplayName</key>
  <string>Voice to Word Chrome Policy</string>
  <key>PayloadIdentifier</key>
  <string>cc.dayibin.voice-to-word.chrome</string>
  <key>PayloadOrganization</key>
  <string>Dayibin</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadScope</key>
  <string>System</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>F98F2F96-0F19-4876-97A8-B02D72F97859</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

function installerReadme({ appId, updateUrl }) {
  return `大宜宾录音助手自动更新版安装包

这个安装包只需要安装一次。后续新版会通过办公室内网自动更新。

Mac 电脑：
1. 解压 zip。
2. 双击 install-mac.command。
3. 按提示输入电脑密码。
4. Chrome 自动重启后，等待 10-30 秒。

Windows 电脑：
1. 解压 zip。
2. 双击 install-windows.cmd。
3. 如果弹出管理员确认，点“是”。
4. Chrome 自动重启后，等待 10-30 秒。

如果之前手动加载过旧版，请在 chrome://extensions 里移除旧版。

扩展 ID：
${appId}

更新地址：
${updateUrl}
`;
}

function releaseReadme({ version, appId, updateUrl, crxUrl, installerZipUrl }) {
  return `# 大宜宾录音助手 CRX 自动更新包

当前版本：${version}

扩展 ID：

\`\`\`text
${appId}
\`\`\`

更新地址：

\`\`\`text
${updateUrl}
\`\`\`

CRX 地址：

\`\`\`text
${crxUrl}
\`\`\`

给同事安装时，优先只发这个入口：

\`\`\`text
http://lixindemac-studio.local:8127/install
\`\`\`

页面会提供一个自动更新安装包。用户下载 zip、解压，然后按电脑系统双击：

- Mac：\`install-mac.command\`
- Windows：\`install-windows.cmd\`

安装器内部会把 Chrome 指向办公室内网 CRX 更新源。用户以后不需要再重复安装。

也可以直接下载自动更新安装包：

\`\`\`text
${installerZipUrl}
\`\`\`

## 适用结论

- Mac 和 Windows 都要走 Chrome 企业策略，才能做到静默安装和后续自动更新。
- 已经用“加载已解压的扩展程序”安装的旧版本，不能原地变成自动更新版本，需要迁移一次。
- Windows 如果不是公司受管设备，且没有域控、组策略、Intune 或 Chrome Enterprise 管理，自托管 CRX 的静默安装可能会被 Chrome 拦截；这种电脑继续用 zip 手动更新，或者改走 Chrome Web Store 私有/非公开发布。

## Mac 配置

优先使用 \`install-mac.command\`。它会写入 \`/Library/Preferences/com.google.Chrome.plist\`，并重启 Chrome。

\`voice-to-word-chrome-policy.mobileconfig\` 和 \`com.google.Chrome.plist\` 是备用的企业管理材料，不建议普通员工手动操作。

验证：

1. 关闭并重新打开 Chrome。
2. 打开 \`chrome://policy\`，点“重新加载政策”。
3. 搜索 \`ExtensionSettings\`，确认状态是 OK。
4. 打开 \`chrome://extensions\`，确认“大宜宾录音助手”的 ID 是 \`${appId}\`。

## Windows 配置

优先使用 \`install-windows.cmd\`。它会写入本机 Chrome 策略，并重启 Chrome。

如需通过域控组策略、Intune 或其他设备管理工具统一下发，策略值为：

\`\`\`text
ExtensionInstallForcelist = ${appId};${updateUrl}
\`\`\`

\`install-windows-force-policy.reg\` 是备用材料。正式推广时不要让普通员工手动改注册表。

验证：

1. 关闭并重新打开 Chrome。
2. 打开 \`chrome://policy\`，点“Reload policies”。
3. 搜索 \`ExtensionInstallForcelist\`，确认状态是 OK。
4. 打开 \`chrome://extensions\`，确认“大宜宾录音助手”的 ID 是 \`${appId}\`。

## 后续发布

每次发布新版本：

\`\`\`bash
EXTENSION_KEY_PATH=/Users/lixin/.voice-to-word/extension-update-key.pem PUBLIC_BASE_URL=http://lixindemac-studio.local:8127 npm run package:extension-crx
\`\`\`

必须一直使用同一把私钥。私钥位置：

\`\`\`text
/Users/lixin/.voice-to-word/extension-update-key.pem
\`\`\`

这把私钥不要发给员工，不要提交到 Git。丢失后，扩展 ID 会变，旧插件就不能原地自动更新。
`;
}
