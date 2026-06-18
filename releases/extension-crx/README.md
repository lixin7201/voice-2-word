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

页面会自动提供 Mac 和 Windows 两个安装按钮。

## 适用结论

- Mac 和 Windows 都要走 Chrome 企业策略，才能做到静默安装和后续自动更新。
- 已经用“加载已解压的扩展程序”安装的旧版本，不能原地变成自动更新版本，需要迁移一次。
- Windows 如果不是公司受管设备，且没有域控、组策略、Intune 或 Chrome Enterprise 管理，自托管 CRX 的静默安装可能会被 Chrome 拦截；这种电脑继续用 zip 手动更新，或者改走 Chrome Web Store 私有/非公开发布。

## Mac 配置

推荐把 `voice-to-word-chrome-policy.mobileconfig` 通过 MDM 下发。没有 MDM 时，可以先在测试机手动安装这个配置描述文件。

也可以把 `com.google.Chrome.plist` 作为 Chrome 的托管偏好配置，下发到 `com.google.Chrome` 域。

验证：

1. 关闭并重新打开 Chrome。
2. 打开 `chrome://policy`，点“重新加载政策”。
3. 搜索 `ExtensionInstallForcelist`，确认状态是 OK。
4. 打开 `chrome://extensions`，确认“大宜宾录音助手”的 ID 是 `njkpohlpnngjhmlicpdnnijnbnahjakl`。

## Windows 配置

推荐通过域控组策略、Intune 或其他设备管理工具设置 Chrome 策略：

```text
ExtensionInstallForcelist = njkpohlpnngjhmlicpdnnijnbnahjakl;http://lixindemac-studio.local:8127/releases/extension-crx/updates.xml
```

`install-windows-force-policy.reg` 只适合在测试机上用管理员权限导入验证。正式推广时不要让普通员工手动改注册表。

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
