# WX_msg_grb 安装包说明（构建与验证）

本文档说明如何构建、配置与验证本项目的 Windows 安装包（`Setup.exe`）。
涉及的文件：

| 文件 | 作用 |
| --- | --- |
| `electron-builder.yml` | electron-builder 打包配置（应用名、目标、NSIS 各项） |
| `build/installer.nsh` | 自定义 NSIS 片段（“是否加入 PATH”勾选页 + 写入/移除 PATH） |
| `scripts/build-release.ps1` | 一键构建并部署成品到 `D:\Applications\WX_message` |
| `scripts/dev.ps1` | 开发环境启动脚本 |

---

## 1. 快速开始

在项目根目录（`E:\Files\Programmes\WX_message`）执行：

```powershell
# 一键构建 + 部署（推荐）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1

# 或者只要打包产物、不部署
npm run dist
```

构建完成后，成品位于 `D:\Applications\WX_message`：

```
D:\Applications\WX_message\
├── Setup.exe            # 安装包（由 WX_msg_grb-Setup-<版本>.exe 改名而来）
├── WX_msg_grb\          # 免安装版（双击其中的 WX_msg_grb.exe 即可运行）
├── README.md            # 应用说明（从项目 docs\README-应用说明.md 拷来，存在才拷）
├── tools\               # wechat_exp*.exe 兜底副本（项目里存在才拷）
└── release\             # electron-builder 原始输出
    ├── WX_msg_grb-Setup-0.1.0.exe
    └── win-unpacked\
```

> 说明：`docs\README-应用说明.md` 由其他同事负责。构建脚本在它不存在时会跳过并提示，
> 不会自己生成该文件。

---

## 2. electron-builder 配置项含义

### 2.1 顶层

| 配置 | 值 | 含义 |
| --- | --- | --- |
| `appId` | `com.wxmsggrb.app` | 应用唯一标识；Windows 上作为 AppUserModelID（任务栏/快捷方式归组）。 |
| `productName` | `WX_msg_grb` | 产品名。Windows 下默认决定可执行文件名，所以必需是 ASCII 的 `WX_msg_grb`，最终生成 `WX_msg_grb.exe`。 |
| `directories.output` | `release` | 打包输出目录（相对项目根目录，保证可移植）。 |
| `directories.buildResources` | `build` | 构建资源目录（图标、`installer.nsh` 等）。 |
| `files` | `out/**`、`package.json`，并排除源码/文档/脚本 | 只把运行期需要的文件打进 `app.asar`。 |
| `asar` / `asarUnpack` | `true` / `node_modules/sql.js/**` | `sql.js` 运行时要用文件路径读取自带的 `.wasm`，必须解包到 `app.asar.unpacked`。 |
| `publish` | `null` | 不做自动发布。 |

**关于 `extraResources`**：`src/main/core/paths.ts` 会在 exe 同级目录、`tools/`、
`resources/`、打包内 `resources/` 等多个位置查找 `wechat_exp*.exe`，不强依赖打包内置。
而 electron-builder 的配置不支持条件判断，若写死 `from: resources` 而目录不存在会直接
构建失败，因此本配置**暂不启用** `extraResources`；`electron-builder.yml` 里保留了
一段注释掉的写法，等确实需要内置兜底副本、且项目里已有 `resources/` 目录时再打开。

### 2.2 `win`

| 配置 | 值 | 含义 |
| --- | --- | --- |
| `target` | `nsis`、`dir` | 同时产出安装包与免安装目录（`win-unpacked`）。 |
| `executableName` | `WX_msg_grb` | 显式锁定可执行文件名，确保是 `WX_msg_grb.exe`。 |
| `requestedExecutionLevel` | `requireAdministrator` | 让应用本体以管理员身份运行（读取微信数据通常需要）。若不需要可改为 `asInvoker`。 |

### 2.3 `nsis`（对应需求“模块 1：安装程序”）

| 配置 | 值 | 含义 |
| --- | --- | --- |
| `oneClick` | `false` | 关闭一键安装，改成“引导式向导”，才会出现语言/路径/用户范围等页面。 |
| `perMachine` | `false` | 引导模式下会显示“为当前用户 / 为全体用户”选择页。 |
| `allowElevation` | `true` | 允许在需要时弹 UAC 提权（选“全体用户”时触发）。 |
| `allowToChangeInstallationDirectory` | `true` | 允许用户选择安装路径。 |
| `createDesktopShortcut` | `true` | 创建桌面快捷方式。 |
| `createStartMenuShortcut` | `true` | 创建开始菜单快捷方式。 |
| `shortcutName` | `微信消息任务汇总器` | 快捷方式显示名（指向 `WX_msg_grb.exe`）。 |
| `installerLanguages` | `zh_CN`、`en_US` | 安装向导支持的语言。 |
| `displayLanguageSelector` | `true` | 安装开始时弹出语言选择对话框（需求“支持选择语言”靠它实现）。 |
| `language` | `"2052"` | 默认语言 LCID，2052 = 简体中文。 |
| `include` | `build/installer.nsh` | 引入自定义 NSIS 片段。 |
| `artifactName` | `WX_msg_grb-Setup-${version}.${ext}` | 安装包文件名。 |
| `deleteAppDataOnUninstall` | `false` | 卸载时**不删**用户数据。原因：`%APPDATA%\WX_msg_grb` 下存有加密任务数据与保险库文件，删除会永久丢失。 |

### 2.4 `build/installer.nsh` 做了什么

- `preInit`：给“是否加入 PATH”设默认值（加入），并解析命令行开关 `--no-path` / `/no-path`。
- `customPageAfterChangeDir`：在“选择安装路径”之后插入一个带复选框的自定义页
  （默认勾选“将 WX_msg_grb 加入 PATH 环境变量”）。
- `customInstall`：按选择把 `$INSTDIR` 追加进 PATH：
  - 全体用户安装 → 系统 PATH（`HKLM\SYSTEM\...\Environment`）；
  - 当前用户安装 → 用户 PATH（`HKCU\Environment`）。
  写回时使用 `REG_EXPAND_SZ`（保留 `%SystemRoot%` 之类变量），并广播
  `WM_SETTINGCHANGE`；追加后若超过 2000 字符则放弃修改，避免截断用户 PATH。
- `customUnInstall`：卸载时从 HKLM / HKCU 两处的 PATH 中移除 `$INSTDIR`。

> **取舍说明**：需求希望“是否加入 PATH”是个可勾选项。这里用
> `customPageAfterChangeDir` + nsDialogs 实现了勾选页。之所以可行，是因为用户选
> “全体用户”时 electron-builder 会在更早的“安装模式页”就完成提权并重启，之后
> 才轮到本勾选页，于是勾选页和真正执行安装的代码处于**同一进程**，勾选值不会因
> 提权而丢失。同时保留 `--no-path` 命令行开关，供静默/自动化安装（`/S`）使用
> （静默安装不显示页面，此时以开关为准，未指定则默认加入）。

---

## 3. 如何验证五项需求

先构建出 `Setup.exe`，然后逐项验证：

### 3.1 UAC 管理员权限

- 双击 `Setup.exe`，弹窗标题栏应出现 UAC 盾牌图标。
- 在安装模式页选择“为全体用户安装”并点“下一步”，应弹出 UAC 提权对话框。
- 若已用管理员身份运行，则不会重复弹窗，且“全体用户”可直接安装。

### 3.2 安装语言（中文简体 / 英文）

- 运行 `Setup.exe`，应先弹出语言选择对话框，列出“简体中文”和“English”。
- 分别选中文/英文，向导页面文案应随之切换，且默认选中简体中文。

### 3.3 安装路径

- 向导中应出现“选择安装位置”页，且可点击“浏览…”修改路径。
- 改动路径后继续安装，检查文件确实装到了所选目录
  （注意：向导会自动在所选目录下追加 `WX_msg_grb` 子目录，这是 electron-builder 的行为）。

### 3.4 是否加入 PATH

- 选择“为当前用户安装”，在“是否加入 PATH”页**勾选**后完成安装；
  打开新的命令行执行 `where WX_msg_grb`（或 `echo %PATH%`）应能看到安装目录。
- 再卸载，`echo %PATH%` 中该目录应被移除。
- 选“为全体用户安装”，则应写入**系统**环境变量（可在“系统属性 → 高级 →
  环境变量”里看到，或管理员命令行 `echo %PATH%`）。
- 静默安装验证：`Setup.exe /S --no-path` 安装后 PATH 中不应出现该目录。

### 3.5 快捷方式

- 安装完成后，桌面应出现“微信消息任务汇总器”快捷方式；
- 开始菜单中也应出现同名快捷方式；
- 右键任一快捷方式 → 属性 → “目标”应指向安装目录下的 `WX_msg_grb.exe`。

---

## 4. 常见构建失败原因与解决办法

| 现象 | 可能原因 | 解决办法 |
| --- | --- | --- |
| `npm run build` 报 TypeScript/编译错误 | 主进程/渲染进程代码有编译问题 | 先 `npm run typecheck` 定位，修好再打包。 |
| electron-builder 首次构建卡住或超时 | 需要联网下载 `nsis`、`winCodeSign` 等二进制 | 确认代理 `http://127.0.0.1:12450` 可用（脚本已自动设置 `HTTP_PROXY`/`HTTPS_PROXY`）；或预热 electron-builder 缓存目录。 |
| `cannot find ... nsis` / 解压失败 | 下载的压缩包不完整 | 删除 `%LOCALAPPDATA%\electron-builder\Cache` 下对应目录后重试。 |
| `File not found: resources` 之类报错 | 启用了 `extraResources` 但目录不存在 | 本配置默认不启用；若你打开了注释，请先建好 `resources/` 目录。 |
| 安装包能生成但双击报错/缺 `WX_msg_grb.exe` | `productName`/`executableName` 被改成了中文 | 必须保持为 ASCII `WX_msg_grb`（见 `electron-builder.yml`）。 |
| 自定义页乱码 | `build/installer.nsh` 保存成了非 UTF-8 | 用 UTF-8（无 BOM）保存该文件；项目生成的脚本带 `Unicode true`，NSIS 对该片段按 UTF-8 解析。 |
| PATH 未生效 | 已有命令行窗口是旧环境 | 关闭并重新打开终端；PATH 写入后会广播 `WM_SETTINGCHANGE`。 |
| `sql.js` 运行时报找不到 `.wasm` | `asarUnpack` 未生效 | 确认 `asarUnpack: node_modules/sql.js/**` 存在，且打包产物 `resources\app.asar.unpacked\node_modules\sql.js\` 下有文件。 |
| 代码签名相关告警 | 未配置证书 | 本项目不做签名，出现 “skipped code signing” 属正常提示。 |

---

## 5. 相关脚本用法

```powershell
# 一键构建 + 部署
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1

# 跳过 electron-vite 构建（复用现有 out\），只重新打包
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -SkipBuild

# 只要免安装版，不生成安装包
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1 -SkipInstaller

# 开发启动
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1
```
