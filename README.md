# 大宜宾录音助手

Chrome 侧边栏扩展 + 局域网后端，用于网页录音捕获、上传、转写、总结、跟单记录和历史管理。

## 当前状态

已完成第一阶段的本地可运行底座：

- Chrome Side Panel 登录、首页、录音监听候选、手动上传、历史、详情、备注、导出、员工管理入口。
- 局域网后端 API：登录鉴权、员工/部门种子数据、部门领导权限、录音记录、上传、备注、Markdown/TXT 导出、ztools 预留接口。
- 真实服务适配层：Cloudflare R2 私有存储、R2 临时签名 URL、DashScope Fun-ASR 异步转写、EasyAI/Kimi 总结路由。
- 部门模板：会议纪要、业务复盘、通用客户跟进、红娘客户画像、招聘客户跟进五阶段。
- 导出格式：Markdown、TXT、DOCX、PDF。
- 初始员工、部门、角色按需求文档写入本地开发数据库。
- 浏览器端模型密钥配置已移除，插件只保存后端地址、登录 token 和当前用户信息。
- Supabase 表结构已放在 `server/schema/supabase.sql`，当前后端先用 `data/dev-db.json` 做本地开发存储，方便无 Supabase 环境也能跑通。

目标后端地址：

```text
http://lixindemac-studio.local:8127
```

## 安全要求

- Chrome 扩展源码不得保存 DashScope、EasyAI、Kimi、R2 或 Supabase service role key。
- 浏览器端只保存后端地址、登录 token 和当前用户信息。
- 真实密钥只允许写入本地 `.env`，不要提交到 Git。

## 开发

安装 Chrome 扩展：

1. 打开 Chrome 扩展管理页。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目目录。

启动后端：

```bash
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

## 真实服务配置

复制 `.env.example` 为 `.env` 后填写后端密钥。Chrome 扩展里不要填任何模型或存储密钥。

真实转写需要同时配置：

- `CLOUDFLARE_R2_ACCOUNT_ID`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`
- `CLOUDFLARE_R2_BUCKET`
- `DASHSCOPE_API_KEY`

后端会先把录音上传到 R2，再生成 2 小时有效的临时链接提交给 DashScope Fun-ASR。总结优先走 `EASYAI_BASE_URL` + `EASYAI_API_KEY`，失败或未配置时回退到 Kimi；都未配置时使用本地结构化模板，保证流程可检查。

## 已知边界

- 当前本地存储用于开发联调；上线前应切换到 Supabase 并执行 `server/schema/supabase.sql`。
- `VOICE_TO_WORD_DEV_FAKE_ASR=1` 会跳过真实转写，适合演示 UI 和权限，不代表真实 ASR 成本链路。
