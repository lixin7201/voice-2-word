# 大宜宾录音助手

Chrome 侧边栏扩展 + 局域网后端，用于网页录音捕获、上传、转写、总结、跟单记录和历史管理。

## 当前状态

这是早期 Chrome 扩展原型的安全基线版本。旧原型中的浏览器端模型密钥配置已经移除，后续密钥只能放在后端 `.env` 中。

目标后端地址：

```text
http://lixindemac-studio.local:8127
```

## 安全要求

- Chrome 扩展源码不得保存 DashScope、EasyAI、Kimi、R2 或 Supabase service role key。
- 浏览器端只保存后端地址、登录 token 和当前用户信息。
- 真实密钥只允许写入本地 `.env`，不要提交到 Git。

## 开发

后续开发按 `需求文档-大宜宾录音助手.md` 的阶段执行。
