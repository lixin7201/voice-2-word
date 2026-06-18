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
  fs.rmSync(`${tempDir}.pem`, { force: true });

  const updatesXml = `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${appId}">
    <updatecheck codebase="${publicBaseUrl.replace(/\/$/, '')}/releases/extension-crx/${crxFileName}" version="${version}" />
  </app>
</gupdate>
`;
  fs.writeFileSync(path.join(releaseDir, 'updates.xml'), updatesXml);
  console.log(`已生成 ${outputPath}`);
  console.log(`扩展 ID：${appId}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function extensionIdFromPrivateKey(privateKeyPem) {
  const publicKeyDer = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(publicKeyDer).digest();
  return [...hash.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((value) => String.fromCharCode('a'.charCodeAt(0) + value))
    .join('');
}
