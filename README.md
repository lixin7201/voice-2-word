# 大宜宾录音助手

Chrome 侧边栏扩展 + 局域网后端，用于网页录音捕获、上传、转写、总结、跟单记录和历史管理。

## 当前状态

已完成第一阶段的本地可运行底座：

- Chrome Side Panel 登录、首页、录音监听候选、手动上传、历史、详情、备注、导出、员工管理入口。
- 局域网后端 API：登录鉴权、员工/部门种子数据、部门领导权限、录音记录、上传、备注、Markdown/TXT 导出、ztools 预留接口。
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

## 已知边界

- R2 上传、DashScope Fun-ASR 真实转写、EasyAI/Kimi 总结适配层已留出环境变量和任务状态入口，但还没有连真实服务。
- DOCX/PDF 导出接口已预留，当前已实现 Markdown/TXT。
- 当前本地存储用于开发联调；上线前应切换到 Supabase 并执行 `server/schema/supabase.sql`。
