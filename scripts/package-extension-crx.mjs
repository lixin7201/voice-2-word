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
  writeReleaseFile('metadata.json', `${JSON.stringify({
    name: manifest.name || '大宜宾录音助手',
    version,
    appId,
    updateUrl,
    crxUrl,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  writeReleaseFile('README.md', releaseReadme({ version, appId, updateUrl, crxUrl }));
  console.log(`已生成 ${outputPath}`);
  console.log(`扩展 ID：${appId}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function writeReleaseFile(fileName, content) {
  const filePath = path.join(releaseDir, fileName);
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o644);
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
      <string>Voice to Word Chrome Policy</string>
      <key>PayloadIdentifier</key>
      <string>cc.dayibin.voice-to-word.chrome.policy</string>
      <key>PayloadType</key>
      <string>com.google.Chrome</string>
      <key>PayloadUUID</key>
      <string>9B6A9846-D1D2-46F9-A6D9-7D1D14DF7E73</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>ExtensionInstallForcelist</key>
      <array>
        <string>${appId};${updateUrl}</string>
      </array>
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

function releaseReadme({ version, appId, updateUrl, crxUrl }) {
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

## 适用结论

- Mac 和 Windows 都要走 Chrome 企业策略，才能做到静默安装和后续自动更新。
- 已经用“加载已解压的扩展程序”安装的旧版本，不能原地变成自动更新版本，需要迁移一次。
- Windows 如果不是公司受管设备，且没有域控、组策略、Intune 或 Chrome Enterprise 管理，自托管 CRX 的静默安装可能会被 Chrome 拦截；这种电脑继续用 zip 手动更新，或者改走 Chrome Web Store 私有/非公开发布。

## Mac 配置

推荐把 \`voice-to-word-chrome-policy.mobileconfig\` 通过 MDM 下发。没有 MDM 时，可以先在测试机手动安装这个配置描述文件。

也可以把 \`com.google.Chrome.plist\` 作为 Chrome 的托管偏好配置，下发到 \`com.google.Chrome\` 域。

验证：

1. 关闭并重新打开 Chrome。
2. 打开 \`chrome://policy\`，点“重新加载政策”。
3. 搜索 \`ExtensionInstallForcelist\`，确认状态是 OK。
4. 打开 \`chrome://extensions\`，确认“大宜宾录音助手”的 ID 是 \`${appId}\`。

## Windows 配置

推荐通过域控组策略、Intune 或其他设备管理工具设置 Chrome 策略：

\`\`\`text
ExtensionInstallForcelist = ${appId};${updateUrl}
\`\`\`

\`install-windows-force-policy.reg\` 只适合在测试机上用管理员权限导入验证。正式推广时不要让普通员工手动改注册表。

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
