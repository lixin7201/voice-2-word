import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const releaseDir = path.join(root, 'releases', 'extension');
const fileName = `voice-to-word-extension-${version}.zip`;
const outputPath = path.join(releaseDir, fileName);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://lixindemac-studio.local:8127';
const changelog = String(process.env.RELEASE_CHANGELOG || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
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

fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(outputPath, { force: true });

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-extension-'));
try {
  for (const relativePath of packageFiles) {
    const source = path.join(root, relativePath);
    if (!fs.existsSync(source)) throw new Error(`缺少扩展文件：${relativePath}`);
    fs.copyFileSync(source, path.join(tempDir, relativePath));
  }

  const result = childProcess.spawnSync('zip', ['-q', '-r', outputPath, ...packageFiles], {
    cwd: tempDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('zip 打包失败，请确认系统已安装 zip 命令');

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex');
  fs.writeFileSync(`${outputPath}.sha256`, `${sha256}  ${fileName}\n`);
  fs.writeFileSync(path.join(releaseDir, 'latest.json'), `${JSON.stringify({
    name: manifest.name || '大宜宾录音助手',
    version,
    minSupportedVersion: version,
    releasedAt: new Date().toISOString(),
    changelog,
    downloadUrl: `${publicBaseUrl.replace(/\/$/, '')}/releases/extension/${fileName}`,
    sha256,
  }, null, 2)}\n`);
  console.log(`已生成 ${outputPath}`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
