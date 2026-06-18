# 大宜宾录音助手插件发布包

这个目录用于局域网插件更新提示和给同事安装新版插件。

## 当前发布文件

- `latest.json`：员工端检查新版时读取的版本清单。
- `voice-to-word-extension-<版本>.zip`：给同事安装的 Chrome 扩展压缩包。
- `voice-to-word-extension-<版本>.zip.sha256`：压缩包校验值。

## 给同事安装

1. 把 `voice-to-word-extension-<版本>.zip` 发给同事。
2. 同事解压到一个固定目录，不要直接从微信临时目录加载。
3. 打开 Chrome：`chrome://extensions`
4. 开启“开发者模式”。
5. 点“加载已解压的扩展程序”。
6. 选择解压后的插件目录。

## 后续新版推送规则

只要修改了插件前端文件，就必须重新打包并更新这里的文件。

插件前端文件包括：

- `manifest.json`
- `background.js`
- `sidepanel.html`
- `sidepanel.js`
- `sidepanel.css`
- `options.html`
- `options.js`
- `icon.png`

发布命令：

```bash
RELEASE_CHANGELOG=$'修复 xxx\n新增 xxx' npm run package:extension
```

发布后必须确认：

```bash
cat releases/extension/latest.json
zipinfo -1 releases/extension/voice-to-word-extension-<版本>.zip
```

压缩包里只能有插件文件，不能包含：

- `.env`
- `data/`
- `uploads/`
- `exports/`
- `audit-screenshots/`
- `server/`
- `node_modules/`
- 任何真实录音、数据库、密钥或日志

## 更新提示边界

- 已安装 `0.1.1` 及以后版本的同事，只要能访问 `http://lixindemac-studio.local:8127`，就能看到后续新版提示。
- 旧版 `0.1.0` 没有检查更新功能，需要先手动安装一次新版。
- 当前方式是“局域网提示 + 下载新版包”，不是静默自动覆盖安装。
- 真正自动更新需要 CRX 固定私钥、`updates.xml` 或 Chrome 企业策略。

