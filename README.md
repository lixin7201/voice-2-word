# 大宜宾录音助手

Chrome 侧边栏扩展 + 局域网后端，用于网页录音捕获、上传、转写、总结、跟单记录和历史管理。

## 当前状态

已完成第一阶段的本地可运行底座：

- Chrome Side Panel 登录、首页、录音监听候选、手动上传、历史、详情、备注、导出、员工管理入口。
- 局域网后端 API：登录鉴权、员工/部门种子数据、部门领导权限、录音记录、上传、备注、Markdown/TXT 导出、ztools 预留接口。
- 真实服务适配层：Cloudflare R2 私有存储、R2 临时签名 URL、DashScope Fun-ASR 异步转写、总结模型池优先级路由。
- 部门模板：会议纪要、业务复盘、通用客户跟进、红娘客户画像、招聘客户跟进五阶段。
- 导出格式：Markdown、TXT、DOCX、PDF。
- 初始员工、部门、角色按需求文档写入本地开发数据库。
- 浏览器端模型密钥配置已移除，插件只保存后端地址、登录 token 和当前用户信息；业务密钥由管理员在后台统一配置。
- 录音标题支持上传前命名、详情页重命名、AI 自动命名；人工标题不会被 AI 覆盖。
- 详情页和历史页会自动刷新“已上传 / 转写中 / 总结中 / 已完成 / 失败”等处理状态。
- 右上角头像进入个人资料，可维护头像、简介、AI 生成偏好和密码。
- Supabase 表结构已放在 `server/schema/supabase.sql`，当前后端先用 `data/dev-db.json` 做本地开发存储，方便无 Supabase 环境也能跑通。

目标后端地址：

```text
http://lixindemac-studio.local:8127
```

## AI 接手必读

这个项目已经在办公室真实使用。任何 AI 或开发者接手时，先按下面规则做，不要只看单个文件就改。

### 项目红线

- 新增功能不能破坏已实现功能：登录、上传、网页录音监听、R2 上传、DashScope 转写、AI 总结、历史、详情、导出、员工权限、配置中心都必须继续可用。
- 不要为了新增功能重构整套架构；优先小步修改，保持现有 API、状态字段、页面入口和用户操作习惯稳定。
- 不要把真实密钥写进 Chrome 扩展、README、测试、截图或发布包；`.env`、`data/`、`uploads/`、`exports/` 一律不能打进插件包。
- 不要把失败伪装成成功。转写成功但总结模型失败时，只能显示“已转写，待生成总结”，不能标记为“完成”。
- 不要直接删除或迁移办公室真实数据。涉及数据库、`data/dev-db.json`、录音文件、R2 对象清理时，必须先备份、再只改相关记录。
- 不要绕过权限。普通员工只能看自己的录音；部门负责人只能看本部门；管理员/老板才能看全部。
- 不要随意改局域网地址、端口、认证方式或后端公开地址。当前默认服务地址是 `http://lixindemac-studio.local:8127`。
- 新增功能必须补测试或更新现有测试；至少跑 `npm run check` 和 `npm test` 后才能说完成。

### 新版本更新必须推送

只要改了以下任意文件，就视为“插件前端有新版”，必须更新版本号并重新打包：

- `manifest.json`
- `background.js`
- `sidepanel.html`
- `sidepanel.js`
- `sidepanel.css`
- `options.html`
- `options.js`
- `icon.png`

发布步骤：

1. 同步修改 `manifest.json` 和 `package.json` 的版本号，例如 `0.1.1` -> `0.1.2`。
2. 写清楚更新内容：

```bash
RELEASE_CHANGELOG=$'修复 xxx\n新增 xxx' npm run package:extension
```

3. 确认生成：

```text
releases/extension/latest.json
releases/extension/voice-to-word-extension-<版本>.zip
releases/extension/voice-to-word-extension-<版本>.zip.sha256
```

4. 确认压缩包里只有插件文件：

```bash
zipinfo -1 releases/extension/voice-to-word-extension-<版本>.zip
```

正常只能出现：

```text
manifest.json
background.js
sidepanel.html
sidepanel.js
sidepanel.css
options.html
options.js
icon.png
```

5. 跑检查：

```bash
npm run check
npm test
```

6. 后端运行在局域网后，同事的新版插件会读取：

```text
GET /api/extension/latest
```

并显示“发现新版插件”的更新提示。

重要边界：

- 当前办公室使用的是“加载已解压的扩展程序”，Chrome 不允许这种扩展静默覆盖安装目录。
- 已安装 `0.1.1` 及以后版本的同事，可以在局域网内看到后续版本提示并下载新版包。
- 仍停留在 `0.1.0` 或更旧版本的同事，旧插件本身没有更新检查代码，需要手动安装一次新版包。
- “加载已解压的扩展程序”永远只是手动更新模式。即使删除 `0.1.1` 后重新加载 `0.1.2` 文件夹，后续也不会变成静默自动更新。
- 真正自动更新必须迁移到 CRX 策略安装模式：固定 CRX 私钥、生成 `.crx` 和 `updates.xml`，再用 Chrome 企业策略安装。

### CRX 自动更新模式

给同事安装时，优先只发这个入口：

```text
http://lixindemac-studio.local:8127/install
```

页面会提供一个自动更新安装包。用户下载 zip、解压，然后按电脑系统双击：

- Mac：`install-mac.command`
- Windows：`install-windows.cmd`

安装器内部会把 Chrome 指向办公室内网 CRX 更新源。用户以后不需要再重复安装。

当前已准备好 `0.1.2` 的 CRX 自动更新包：

```text
releases/extension-crx/
  README.md
  updates.xml
  voice-to-word-extension-0.1.2.crx
  voice-to-word-auto-installer-0.1.2.zip
  INSTALL.txt
  install-mac.command
  install-windows.cmd
  voice-to-word-chrome-policy.mobileconfig
  com.google.Chrome.plist
  install-windows-force-policy.reg
  metadata.json
```

固定扩展 ID：

```text
njkpohlpnngjhmlicpdnnijnbnahjakl
```

更新地址：

```text
http://lixindemac-studio.local:8127/releases/extension-crx/updates.xml
```

迁移规则：

1. 旧的 `0.1.1` 如果是“加载已解压的扩展程序”安装的，需要从 `chrome://extensions` 移除。
2. 新版不能再用“加载已解压的扩展程序”安装；请使用自动更新安装包。
3. Mac 双击 `install-mac.command`，Windows 双击 `install-windows.cmd`。
4. 安装后打开 `chrome://extensions`，确认扩展 ID 是 `njkpohlpnngjhmlicpdnnijnbnahjakl`。

后续发布新版本时：

```bash
EXTENSION_KEY_PATH=/Users/lixin/.voice-to-word/extension-update-key.pem PUBLIC_BASE_URL=http://lixindemac-studio.local:8127 npm run package:extension-crx
```

必须一直使用同一把私钥：

```text
/Users/lixin/.voice-to-word/extension-update-key.pem
```

这把私钥不要发给员工，不要提交到 Git。丢失后扩展 ID 会变，旧 CRX 版就不能原地自动更新。

## 安全要求

- Chrome 扩展源码不得保存 DashScope、EasyAI、Kimi、R2 或 Supabase service role key。
- 浏览器端只保存后端地址、登录 token 和当前用户信息。
- 真实密钥只允许保存在后端：优先由管理员在“配置”页统一维护，`.env` 只作为部署兜底，不要提交到 Git。
- 后端启动前必须配置随机 `JWT_SECRET`；不要使用 `.env.example` 里的占位值。

## 开发

安装 Chrome 扩展：

1. 打开 Chrome 扩展管理页。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目目录。

启动后端：

```bash
cp .env.example .env
# 修改 .env 里的 JWT_SECRET 为随机长字符串后再启动
npm run dev
```

本地演示上传闭环：

```bash
VOICE_TO_WORD_DEV_FAKE_ASR=1 npm run dev
```

开发检查：

```bash
npm run check
npm test
```

## 管理员统一配置

同事安装 Chrome 扩展后，只需要使用自己的花名/工号登录。DashScope、R2、总结模型 API Key 等业务密钥不在同事电脑上配置，也不会写入插件源码。

管理员第一次配置：

1. 启动后端：`npm run dev`
2. 打开插件，用 `离心 / dayibin` 登录。
3. 进入“配置”页。
4. 填写 R2、DashScope 参数，并在“总结模型池”里配置 EasyAI GPT-5.5、AI 大宜宾 sub2api GPT-5.5 或 Kimi K2.6。
5. 回到首页上传录音测试。

真实转写需要同时配置：

- `CLOUDFLARE_R2_ACCOUNT_ID`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_R2_BUCKET`
- `DASHSCOPE_API_KEY`

后端会先把录音上传到 R2，再生成 2 小时有效的临时链接提交给 DashScope Fun-ASR。总结会读取“总结模型池”中已启用且配置了 Key 的模型，按优先级依次调用；`openai-responses` 用于 EasyAI/sub2api GPT-5.5，`openai-chat` 用于 Kimi K2.6。模型池没有可用模型时，才读取旧版 EasyAI/Kimi 环境变量兜底；都未配置时使用本地结构化模板，保证流程可检查。

模型池注意事项：

- sub2api 默认地址是 `http://127.0.0.1:8080/v1`，这里的 127.0.0.1 指运行录音助手后端的机器。
- Chrome 扩展不直接请求模型服务，也不会保存模型 Key。
- 管理员可在配置页测试模型、启停模型、调整优先级；普通员工看不到模型池接口。

`.env.example` 中仍保留这些变量，是为了服务器部署或紧急兜底；正常内部使用推荐在管理员后台配置一次，所有员工端共享。

设置中心同步规则：

- DashScope、R2、总结模型池、演示模式等后端参数保存后，下次上传或重新总结立即使用新配置，不需要员工重装插件。
- 个人资料和 AI 生成偏好保存后，重新生成总结时会作为表达重点参考；不会被当作录音事实写入纪要。
- 如果只是修改 `publicBaseUrl`，通常不需要员工重装；如果真实后端地址变了，员工需要在登录页“服务地址”里改成新地址。
- 前端代码更新不会自动进入已安装的解压扩展，需要重新加载扩展或发布新版。

## 日常使用

- 上传或监听网页录音时，可以先填写“录音标题”；不填时会先用文件名，等总结完成后由 AI 自动生成短标题。
- 在录音详情页点击标题旁的编辑按钮，可以随时重命名；人工改过的标题不会被重新总结覆盖。
- 长录音上传后可停留在详情页等待，页面会自动从“已上传”刷新到“转写中 / 总结中 / 已完成”；历史页也会自动更新处理中记录。
- 点击右上角头像进入个人资料，可修改头像底色、头像、自我介绍、AI 生成偏好和登录密码，底部提供退出登录。

## 网页录音捕获范围

插件点击“监听当前页录音”后，会同时做几件事：

1. 扫描当前网页里的 `audio` / `video` / `source` 标签。
2. 扫描页面资源记录里已经加载过的音频、视频链接。
3. 监听当前 Tab 后续出现的媒体网络请求，包括网页播放器通过接口动态加载的录音。
4. 监听页面播放事件，用户点播放后会自动刷新候选录音列表。
5. 对带登录态的网页音频，插件会在用户浏览器环境里拉取音频 Blob，再上传到本地后端。

当前可直接上传识别的独立文件格式：

- 音频：`mp3`、`m4a`、`wav`、`aac`、`flac`、`ogg`、`opus`
- 视频含音频：`mp4`、`mov`、`webm`

已能识别但不会误传的情况：

- `blob:` 临时地址：会提示需要捕获其背后的网络音频请求。
- `m3u8` / `mpd` 播放列表：会显示为候选线索，但不会当成单个录音上传。
- `m4s` / `ts` 等分片：会过滤，避免把碎片当成完整录音。

不承诺支持 DRM 加密音频、浏览器外本地录音监听，以及需要专门解密或转封装的流媒体。

## 已知边界

- 当前本地存储用于开发联调；上线前应切换到 Supabase 并执行 `server/schema/supabase.sql`。
- `VOICE_TO_WORD_DEV_FAKE_ASR=1` 会跳过真实转写，适合演示 UI 和权限，不代表真实 ASR 成本链路。
