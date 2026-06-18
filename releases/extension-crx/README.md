# 大宜宾录音助手 CRX 自动更新包

当前版本：0.1.2

扩展 ID：

```text
njkpohlpnngjhmlicpdnnijnbnahjakl
```

更新地址：

```text
http://lixindemac-studio.local:8127/releases/extension-crx/updates.xml
```

CRX 地址：

```text
http://lixindemac-studio.local:8127/releases/extension-crx/voice-to-word-extension-0.1.2.crx
```

给同事安装时，优先只发这个入口：

```text
http://lixindemac-studio.local:8127/install
```

页面会提供一个自动更新安装包。用户下载 zip、解压，然后按电脑系统双击：

- Mac：`install-mac.command`
- Windows：`install-windows.cmd`

安装器内部会把 Chrome 指向办公室内网 CRX 更新源。用户以后不需要再重复安装。

也可以直接下载自动更新安装包：

```text
http://lixindemac-studio.local:8127/releases/extension-crx/voice-to-word-auto-installer-0.1.2.zip
```

## 适用结论

- Mac 和 Windows 都要走 Chrome 企业策略，才能做到静默安装和后续自动更新。
- 已经用“加载已解压的扩展程序”安装的旧版本，不能原地变成自动更新版本，需要迁移一次。
- Windows 如果不是公司受管设备，且没有域控、组策略、Intune 或 Chrome Enterprise 管理，自托管 CRX 的静默安装可能会被 Chrome 拦截；这种电脑继续用 zip 手动更新，或者改走 Chrome Web Store 私有/非公开发布。

## Mac 配置

优先使用 `install-mac.command`。它会写入 `/Library/Preferences/com.google.Chrome.plist`，并重启 Chrome。

`voice-to-word-chrome-policy.mobileconfig` 和 `com.google.Chrome.plist` 是备用的企业管理材料，不建议普通员工手动操作。

验证：

1. 关闭并重新打开 Chrome。
2. 打开 `chrome://policy`，点“重新加载政策”。
3. 搜索 `ExtensionSettings`，确认状态是 OK。
4. 打开 `chrome://extensions`，确认“大宜宾录音助手”的 ID 是 `njkpohlpnngjhmlicpdnnijnbnahjakl`。

## Windows 配置

优先使用 `install-windows.cmd`。它会写入本机 Chrome 策略，并重启 Chrome。

如需通过域控组策略、Intune 或其他设备管理工具统一下发，策略值为：

```text
ExtensionInstallForcelist = njkpohlpnngjhmlicpdnnijnbnahjakl;http://lixindemac-studio.local:8127/releases/extension-crx/updates.xml
```

`install-windows-force-policy.reg` 是备用材料。正式推广时不要让普通员工手动改注册表。

验证：

1. 关闭并重新打开 Chrome。
2. 打开 `chrome://policy`，点“Reload policies”。
3. 搜索 `ExtensionInstallForcelist`，确认状态是 OK。
4. 打开 `chrome://extensions`，确认“大宜宾录音助手”的 ID 是 `njkpohlpnngjhmlicpdnnijnbnahjakl`。

## 后续发布

每次发布新版本：

```bash
EXTENSION_KEY_PATH=/Users/lixin/.voice-to-word/extension-update-key.pem PUBLIC_BASE_URL=http://lixindemac-studio.local:8127 npm run package:extension-crx
```

必须一直使用同一把私钥。私钥位置：

```text
/Users/lixin/.voice-to-word/extension-update-key.pem
```

这把私钥不要发给员工，不要提交到 Git。丢失后，扩展 ID 会变，旧插件就不能原地自动更新。
