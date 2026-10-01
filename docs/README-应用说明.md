# 微信消息任务汇总器与展示台（WX_msg_grb）

> 版本 1.0.0 · Windows 10/11 64 位
>
> 本文件是**软件自身的说明文档**（如何构建、运行、配置、排错）。
> 需求原文见项目根目录的 `README.md` 与 `README_NEW.md`，本文件不重复需求内容。

---

## 一、这是什么

一个本地运行的 Windows 桌面程序：

1. 通过 `wechat_exp.exe`（第三方开源工具）读取本机微信的聊天记录；
2. 把选定的联系人与群聊的聊天内容交给大模型（LLM），从中**抽取任务**；
3. 把任务以 **Windows 10 开始菜单动态磁贴**的形式展示在暗色调界面上，按
   「进行中 / 未开始 / 已完成 / 已过期」分类，支持拖拽排列、长按完成/删除；
4. 同一任务被多人在多群发布时自动**合并发布人**，避免重复。

所有数据**只在本机**：聊天记录、账号信息、API Key 都用 PBKDF2 派生的密钥加密后存储，
数据库文件整体加密，不上传任何第三方（调用 LLM 时只发送你选定的那些聊天片段）。

---

## 二、运行环境与依赖

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11（64 位） |
| 微信 | 4.x（已测 4.1.9 / 4.1.10 / 4.1.12.55，与 wechat_exp 的支持范围一致） |
| 读微信数据 | 需要 `wechat_exp.exe`（**不随本软件分发，需自行下载**，见第五节） |
| 抽取任务 | 需要一个 LLM 平台的 API Key（DeepSeek / ChatGPT / 通义千问 / 文心一言 / Gemini / Claude 任选其一） |
| 开发环境 | Node.js ≥ 20（本项目在 Node 24 + npm 11 下开发） |

**没有微信环境也能用**：打开「设置 → 数据来源 → 模拟数据模式」，界面会装载一套内置演示数据，
可以直接体验完整的「聊天 → 任务 → 磁贴」流程（此时用规则抽取，不调用大模型）。

---

## 三、快速开始（开发模式）

```powershell
# 1. 安装依赖（脚本会自动探测本地代理，连不上就直连；端口不同可传 -Proxy）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# 2. 启动开发模式（Vite 热更新 + Electron）
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

也可以直接用 npm：

```powershell
npm install
npm run dev          # 开发模式
npm run typecheck    # 类型检查（主进程 + 渲染进程）
npm run build        # 只构建，不打包安装程序
```

首次运行会自动创建加密保险库（随机主口令 + Windows 凭据保护，**不会弹口令框**），
并显示「首次配置」向导：登录账号 → 选择联系人与群聊 → 配置 AI Key。

> 💡 **只想先看界面**：在向导里直接点右上角关闭，然后到「设置 → 数据来源」点
> **装载演示数据**，立刻就能看到磁贴界面。

---

## 四、构建安装包

```powershell
# 一键构建 + 部署成品
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
```

脚本会：

1. `npm run build`（electron-vite 构建主进程 / 预加载 / 渲染进程）
2. `electron-builder --win`（生成 NSIS 安装包 + 免安装目录）
3. 把成品整理到 **`D:\Applications\WX_message`**：
   - `D:\Applications\WX_message\WX_msg_grb\` ← 免安装版，直接运行里面的 `WX_msg_grb.exe`
   - `D:\Applications\WX_message\Setup.exe` ← 安装包
   - `D:\Applications\WX_message\README.md` ← 本文件的副本
   - `D:\Applications\WX_message\tools\wechat_exp_*.exe` ← 若项目里存在就一并带上

安装包特性（对应需求「模块 1」）：UAC 提权、可选安装语言（中/英）、可选安装路径、
可选当前用户/全体用户、可选加入 PATH、创建桌面与开始菜单快捷方式。
详细说明与验收清单见 `build/README-安装包说明.md`。

---

## 五、接入 wechat_exp（读取微信聊天记录）

### 5.1 下载

到 <https://github.com/sunhanaix/pc_wechat_exp/releases> 下载最新的
`wechat_exp_<版本>.exe`（当前最新 `wechat_exp_2.10.20260925.exe`，约 43 MB）。

### 5.2 放置位置

软件会按以下顺序自动查找（文件名匹配 `wechat_exp*.exe`）：

1. 软件根目录（开发时=项目根目录，安装后=exe 所在目录）
2. `<软件根目录>\tools\`
3. `<软件根目录>\resources\`
4. `<软件根目录>\reference\`
5. 打包资源的 `resources\tools\`

**推荐放到 `<软件根目录>\tools\`**：`wechat_exp` 会把它的备份/解密数据写在
**exe 所在目录**，放在 `tools\` 下可以让这些中间文件集中在一处，便于清理。

也可以不放置，而在「设置 → 数据来源 → wechat_exp 路径」里手动指定绝对路径。

### 5.3 它是怎么被调用的

软件**不直接解析微信数据库**，而是调用 wechat_exp 的 HTTP 接口：

```
wechat_exp.exe serve --host 127.0.0.1 --port <自动挑选的空闲端口，默认从 18700 起>
```

启动后使用这些端点：

| 用途 | 端点 |
|---|---|
| 环境自检 / 就绪探测 | `GET /` |
| 联系人与群聊列表 | `GET /api/contacts`（失败时回退 `GET /api/address-book`） |
| 拉取某个会话的消息 | `GET /api/messages?chat_id=&page=&per_page=≤200` |
| 扫描本机微信账号 | `POST /api/backup/scan` |

进程由主进程托管：启动时拉起、60 秒内未就绪则报错并附带最后 20 行输出；
应用退出时 `SIGTERM` → 3 秒后 `taskkill /T /F` 兜底，不会留下孤儿进程。

> ⚠️ **前置条件**：微信需要**正在运行且已登录**（wechat_exp 的密钥提取依赖微信进程内存）。
> 微信 4.1.10+ 为只读扫描，无需管理员权限、无需重启微信。

### 5.4 如果接口对不上

上游是第三方程序，字段与端点在不同版本间可能变化。所有适配都集中在
`src/main/wechat/` 一层（详见该目录下各文件的注释），需要手工调整时改这里即可：

- `exe-locator.ts` — 查找 exe 与读版本
- `service.ts` — 启动/停止 `serve` 子进程
- `client.ts` — HTTP 客户端与 SSE 解析
- `normalize.ts` — 上游 JSON → 本应用数据模型的映射（**字段映射都在这**）
- `mock.ts` — 模拟数据

字段映射的权威依据是一份对上游源码逐行调研产出的接口契约文档
（`docs/reference/wechat-exp-integration-contract.md`）。

> ⚠️ 该契约文档**不随本仓库公开发布**（它包含微信密钥提取的内部细节，
> 而本项目刻意不实现密钥提取）。公开仓库中该路径不存在，属预期情况；
> 若你需要维护这一层，请自行对照上游源码重新调研。

---

## 六、配置 LLM（API Key）

进入软件后点左侧「**AI 平台与 Key**」或首次配置向导的第三步：

1. 选择平台（六个之一）；
2. 粘贴 API Key（DeepSeek/OpenAI/Qwen/文心一言 形如 `sk-...`，各家略有不同，界面有提示）；
3. 点「保存并测试」——软件会**发一个最小请求验证 Key 是否可用**：
   - 可用 → 保存并把该平台设为当前平台，同时**自动选用该平台价格最低的模型**；
   - 不可用 → 弹出中文原因（401/403 提示 Key 无效，429 提示限流，等等），不会保存错误配置。
4. 也可以在配置区用下拉框换成同平台的其它模型（价格从低到高排列）。

Key 用 PBKDF2 派生的密钥加密后存进本地加密数据库，**日志与界面一律只显示打码值**，
明文只存在于主进程内存中，任何 IPC 都不会把它返回给界面。

「申请 Key」的入口在每个平台卡片上（点了用系统浏览器打开对应控制台）。

---

## 七、日常使用

| 操作 | 位置 |
|---|---|
| 添加/移除账号 | 右上角「My Account」→ 账户管理 |
| 选择要读取的联系人与群聊 | 左侧「联系人与群聊」 |
| 开始/停止实时同步（默认 30 秒轮询） | 顶栏「开始同步 / 停止同步」 |
| 手动触发一次任务抽取 | 顶栏「抽取任务」 |
| **手动新建任务**（第二次更新 §1a） | 顶栏「**新增任务**」→ 自动打开详情面板 |
| **编辑任务**（名称/主题/负责人/接头人/起止时间，改完自动保存） | 详情面板右上角「**编辑**」 |
| 切换类别 / 搜索任务 | 左侧类别栏 / 顶栏搜索框 |
| 排列磁贴 | 直接拖拽，落到已占用的格子会与之交换位置 |
| 完成任务 / 删除任务 | 鼠标移到磁贴上，底部出现按钮，**按住 1.5 秒**进度条走满才生效 |
| 查看任务详情（原文/材料/发布人/链接） | 单击磁贴 |
| 用某个账号的登录态打开在线表格 | 详情页里点击带链接的材料 |
| **托盘 / 后台捕获开关、平台登录状态** | 左侧「设置 → **托盘与后台**」 |
| **打开 QQFlow 提取 QQ 密钥** | 账户管理（QQ 区）或「设置 → 托盘与后台」 |
| 环境自检、模拟数据、缩放、改主口令 | 左侧「设置」 |
| 查看运行日志 | 左侧「运行日志」（也可到日志目录看文件） |

### 数据与日志位置

| 内容 | 路径 |
|---|---|
| 加密数据库 | `%APPDATA%\wx-msg-grb\store.db.enc` |
| 保险库（口令校验） | `%APPDATA%\wx-msg-grb\vault.json` |
| 自动解锁凭据 | `%APPDATA%\wx-msg-grb\vault.key`（Windows DPAPI 加密） |
| 非敏感设置 | `%APPDATA%\wx-msg-grb\boot.json` |
| 日志文件 | `%APPDATA%\wx-msg-grb\logs\app-<日期>.log`（保留 14 天） |
| wechat_exp 的备份 | `<wechat_exp.exe 所在目录>\backup\`（由 wechat_exp 自己管理） |

---

## 八、安全设计

- **主口令 → PBKDF2-HMAC-SHA512（210,000 次迭代，16 字节盐）→ 32 字节密钥**
- **AES-256-GCM** 加密：数据库文件整体加密 + 敏感字段（账号凭据、LLM Key）单独加密
- 主口令本身不明文落盘：
  - 开启「自动解锁」时用 Electron `safeStorage`（Windows 下即 DPAPI，绑定当前 Windows 用户）保存；
  - 关闭后每次启动都需要手动输入主口令。
- 首次运行的随机主口令是自动生成的，建议在「设置 → 安全」里改成自己记得的。
  **忘记主口令=数据无法解密**（这是加密的正常结果，没有后门）。
- 渲染进程开启了 `contextIsolation`、关闭了 `nodeIntegration`，并配置了 CSP；
  只允许通过预加载脚本暴露的白名单通道访问主进程。
- 打开外部链接的窗口按账号隔离 Cookie（`persist:acct-<accountId>` 分区），
  且只允许 http/https。

---

## 九、v2 更新说明（2026-09-28）

按 `README_UPDATE_NEW.md`（优先）/ `README_UPDATE.md` 做的一轮功能调整。原版需求中未被更新的部分仍然有效。

### 9.1 登录：取消扫码、取消企业微信

- **取消所有平台的扫码登录**。微信/QQ 的扫码协议都是私有协议，需要逆向客户端，本项目不内置这类实现——界面上**不再有任何二维码**（连占位二维码也删掉了）。
- **取消企业微信**接入，只保留 **微信** 与 **QQ**。
- **账号数量不再设上限**（原版「每平台最多 2 个」的限制已按更新需求去掉）。多开工具由用户自理。
- 现在加账号只有两条路：
  - 微信 →「**检测本机已登录账号**」（走 wechat_exp 扫 `db_storage`）
  - QQ →「**扫描本机 QQ 数据库**」+ 填密钥

### 9.2 QQ 聊天记录读取（新增）

- 定位 `%USERPROFILE%\Documents\Tencent Files\<QQ号>\nt_qq\nt_db\nt_msg.db`
- 消息 BLOB 的解析算法**移植自 [QQFlow](https://github.com/yfgug/QQFlow)**（Rust 源码逐行对照重写为 TypeScript），
  包括类型判定（文本/图片/语音/视频/表情/链接/小程序/撤回/系统…）与「文本纯净度过滤」
- **密钥来源**（我们**不注入 QQ 进程**——那需要 Windows 调试 API，纯 Node 做不到）：
  1. 复用你已经用 QQFlow 提取过的密钥：读 `%APPDATA%\qqflow\qqflow_keys.json`（XOR + Base64 解码）
  2. 或在界面上手动粘贴 16 位密钥
  两者都存进本应用的加密保险库。
- 提取后的流程与微信**完全相同**：同样进「联系人与群聊」勾选 → 同步 → 任务抽取

### 9.3 文件与链接内容读取（新增）

- **文件**：`.txt` / `.md` / `.docx` / `.xlsx` / `.pdf`（8MB 上限），提取正文喂给 LLM 一起判断任务。
  图片**不做 OCR**，只保留文件引用供手动查看。
- **链接**：抓页面标题 + 正文前 500 字（8 秒超时）；抓不到就只保留原始链接。
- **只有从文件或链接里提取到任务关键字段（名称/时间/材料/负责人/接头人）时才生成任务**，
  否则只在原文里保留引用。

### 9.4 磁贴缩略信息补全

磁贴现在固定显示三行：**接头人 / 负责人 / 起止时间**。信息缺失时用统一文案：
`未明确`（接头人、负责人）、`未明确起止时间`（仅在**两个时间都没有**时；只有一个就显示已有的那个）。

### 9.5 多选与「已删除」分类（新增）

- **多选模式**：长按磁贴（或点标题栏的「多选」）进入，左上角出现复选框；
  顶部工具栏显示「已选中 X 项」+ 全选 / 反选 / 清除，底部有「取消多选」。
- **新增「已删除」分类**（左侧第五个）：
  - 点「删除」= **移入该分类**，不是物理删除
  - 该分类里磁贴底部按钮合并为一个大的「**恢复**」，**点击即生效**，并弹出绿色提示框
    （上方中部、2 秒、带倒数进度条、可手动关闭、最多同时叠 3 个）
  - 恢复后**按起止时间自动归类**（未开始/进行中/已过期），不会直接扔回「进行中」
  - 要**彻底删除**：在该分类里**长按磁贴** → 弹窗二次确认
- **确认时长**（更新需求硬要求）：普通「完成」「删除」改为 **1.5 秒**；
  一键清除 **2.5 秒**（红色）；「已删除」分类的一键清除 **3 秒** + 弹窗二次确认。
- 一键清除**只清当前标签页**，绝不动账号信息与 API Key。

### 9.6 任务去重修复（重要 bug 修复）

**原来现象**：任务标记完成 → 同步后又冒出一条「进行中」，且「已完成」里那条还在。

**原因**：去重时只比对了未删除的任务，且判定过严，LLM 换个名字就被当成新任务。

**现在**：
- 比对范围**覆盖全部 5 个分类（含已删除）**
- 判定规则按更新需求：**任务名称 + 发布人 + 起始时间三者一致即视为同一任务**；
  发布人与时间一致、名称有出入时用更宽松的阈值判定
- 命中后一律**合并到已存在的那条，绝不新建**；已完成的不会被改回进行中
- 同一任务散落在多个分类时，保留**最早创建**的那条，其余合并发布人后删除

**回归自检**：`node scripts/core-logic.selftest.cjs`（34 条断言，无需 Electron 即可跑）。
覆盖去重判定、跨分类命中、合并保留状态，以及「已删除」分类与恢复归类的全部规则。
改 `dedup.ts` / `classify.ts` 后建议先跑它。

---

## 九之二、v3 更新说明（2026-09-29，第二次更新需求）

按 `README_UPDATE2_NEW.md`（优先）/ `README_UPDATE2.md` 做的第二轮功能调整。
原版与第一次更新的需求中未被改动的部分仍然有效。

### 9b.1 手动新增 / 编辑任务（§1）

- **「新增任务」按钮**：在顶栏「抽取任务」**旁边**，样式完全一致。
  点它 → 新建一条空白任务 → 立即打开右侧详情面板让你填写。
- **详情面板可编辑**：点磁贴进入详情后，右上角有「编辑」按钮，可自由修改
  **名称 / 主题 / 类型 / 负责人 / 接头人 / 起止时间**。
  - 起止时间用浏览器原生的 `datetime-local` 选择器（点开就是日历 + 时间），
    另有「截止到今天 23:59」和「清空时间」两个快捷按钮。
  - **改动自动保存**：停止输入 0.8 秒后自动落库，面板上会显示「已自动保存」。
- **未填写的信息**：在磁贴上按原有设计统一显示「未明确」（名称/接头人/负责人）
  与「未明确起止时间」（两端时间都没填时）。
- **AI 生成名称/主题**：编辑态下点「AI 生成名称/主题」，会用当前激活的 LLM
  根据已填内容补全空缺项（已有值不会被覆盖）。
  未配置 LLM 时会提示去配置，不会报错中断。
- **来源信息不可改**：`origin='auto'`（自动抽取）的任务，其来源消息、发布人、
  原文、抽取模型等字段**在界面与主进程两层都被拒绝修改**（需求 §1b 的硬要求）。

### 9b.2 QQFlow 作为外部依赖（§2 / §5，方案已调整）

- **不改 QQFlow 源码**：其仓库未声明 LICENSE，魔改并分发存在合规风险，
  因此按调整后的方案，把它当**外部依赖**处理。
- **重要事实**：QQFlow 是**纯 GUI 程序，没有任何命令行参数**（已核对源码
  `main.rs`，不解析 `std::env::args`）。所以"命令行调用 QQFlow"实际只能实现为
  **启动它的进程**——密钥提取必须在 QQFlow 自己的窗口里完成。
- 软件提供两个入口把它跑起来：
  - 「账户管理 → QQ」里的**「打开 QQFlow」**按钮；
  - 「设置 → 托盘与后台」里的**「打开 QQFlow」**按钮。
- 提取出的密钥写在 `%APPDATA%\qqflow\qqflow_keys.json`，回到软件点
  **「从 QQFlow 导入」**即可（这条链路 v1 就有，未改动）。
- **构建脚本会自动带上它**：`scripts/build-release.ps1` 现在会把
  `QQFlow*.exe` 与 `wechat_exp*.exe` 一起收进成品的 `tools\`（本机已有才拷）。

### 9b.3 系统托盘与后台运行（§3）

- 新增设置页**「托盘与后台」**（设置面板第三个页签），三个开关：
  | 开关 | 作用 |
  |---|---|
  | 启用系统托盘 | 任务栏右下角常驻图标，左键单击唤出主窗口 |
  | 关闭窗口时最小化到托盘 | 开：点 × 只隐藏窗口，软件继续后台运行；关：点 × 直接退出 |
  | 后台持续捕获 | 启动**平台登录状态监听**（见下） |
- 该页还会实时显示**微信/QQ 的登录状态**（是否在运行、密钥是否就绪），
  每 10 秒刷新一次。
- **登录状态监听（不是盲目轮询）**：每 15 秒用 `tasklist` 轻量探测一次微信/QQ
  进程，**只在"未运行 → 运行"的跳变时触发动作**。
  - QQ 登录且 QQFlow 已提取过密钥 → **自动导入**到本软件保险库（无感）。
  - QQ 登录但还没有密钥 → 只记日志提示（**不自动弹 QQFlow 窗口**，避免后台突然
    弹窗打扰；你可随时点上面的「打开 QQFlow」）。
  - 微信登录 → 无需额外动作，同步循环已按间隔读取。
- 实现位置：`src/main/services/login-watch.ts`；托盘：`src/main/core/tray.ts`。

### 9b.4 安装包依赖检查（§4，方案已调整）

- 按调整后的要求，安装包**不打包、不分发** wechat_exp 与 QQFlow。
- 安装向导的「选择附加任务」页上增加了**依赖检查**区域：检测程序目录与其
  `tools\` 下是否存在这两个工具，
  - 都在 → 显示"已检测到，无需额外操作"；
  - 缺哪个 → 列出缺的工具名 + 对应 GitHub 下载地址，并说明"未安装不影响启动，
    只是对应平台读不到数据"。
- 检测只做提示，**不会代为下载或安装**。实现见 `build/installer.nsh`。

### 9b.5 项目许可证（§6）

- 根目录新增 **`LICENSE`**（标准 MIT 文本），并在文末附第三方依赖说明：
  本项目采用 MIT；wechat_exp 与 QQFlow 不随本项目分发，各自遵循其自身条款。
- `package.json` 的 `license` 字段已是 `MIT`，与之一致。

---

## 十、已知边界与需要人工介入的地方


请在正式使用前知悉以下几点：

1. **扫码登录已被完全移除**（更新需求 §1）。
   微信 / QQ 的扫码登录都是私有协议，本项目**不内置**任何逆向实现，
   界面上**不再有任何二维码**（占位二维码也已删除）。
   实际可用的路径是「**检测本机已登录账号**」（微信，走 wechat_exp 扫 `db_storage`）
   与「**登记本机 QQ 数据库**」（QQ，配密钥）。接入真实协议时，只需在
   `src/main/services/platform-service.ts` 里补一个登录提供者，上层无需改动。

2. **QQ 的密钥提取需要你自己解决**（我们不做进程注入）。
   两条路：① 用 QQFlow 提取过后点「从 QQFlow 导入」直接复用；
   ② 手动粘贴 16 位密钥。**密钥提取本身不在本软件能力范围内**——它需要
   Windows 调试 API 注入 QQ 进程，纯 Node 环境做不到。

3. **QQ 数据库的 SQLCipher 解密是按 QQFlow 的参数规格实现的**（页大小 4096、
   `kdf_iter=4000`、HMAC-SHA1 失败回退 SHA512、`aes-256-cbc`），
   **未经真实 QQ 数据库验证**（开发机上没有 QQ 环境）。解密后会校验
   page 1 是否以 `SQLite format 3\0` 开头，失败会给出明确中文提示。
   若你的 QQ 版本参数不同，改 `src/main/qq/decrypt.ts` 顶部的常量即可。

4. **QQ 消息 BLOB 的解析算法是逆向成果**（移植自 QQFlow 的 `message_parser.rs`），
   QQ 大版本更新后可能失效。解析失败时保留占位符，不会生成任务。

5. **PDF 文本提取是无依赖的简化实现**，扫描件、多层编码的 PDF 取不到文字
   （此时只保留文件引用，不假装成功）。`.docx`/`.xlsx` 只取正文，不含页眉页脚、
   图片文字、图表、公式。

6. **「用对应账号登录后打开链接」的技术边界。**
   第三方网站（腾讯文档、问卷星等）的登录态无法从微信迁移过去。
   本软件能做到的是**按账号隔离浏览器会话**：用某账号打开过的网站，其 Cookie
   只保存在该账号的分区里，下次仍用该账号打开就是已登录状态。
   这是在不伪造第三方登录的前提下能做到的最接近效果（详见
   `src/main/core/external-window.ts` 顶部注释）。

7. **wechat_exp 的接口是内部接口。**
   上游 README 完全没有记载 `/api/*`，字段可能随版本变化。若某天读不到数据，
   先看「运行日志」里 wechat_exp 的输出，再对照
   `src/main/wechat/normalize.ts` 检查字段映射。
   （上一条提到的接口契约文档不随公开仓库发布，见第五节末尾的说明。）

8. **任务抽取的质量取决于模型与提示词。**
   提示词在 `src/main/tasks/prompt.ts`，去重阈值在 `src/main/tasks/dedup.ts`
   （`DUPLICATE_THRESHOLD` 默认 0.62、`LOOSE_SIMILARITY_THRESHOLD` 默认 0.45，可调）。
   没有配置任何 Key 时会退回**规则抽取**，磁贴上会标出「规则」角标。

9. **安装包未做代码签名。** 首次运行 Windows SmartScreen 可能拦截，
   选择「更多信息 → 仍要运行」即可；正式分发建议购买代码签名证书。

10. **安装包的 NSIS 自定义逻辑（PATH 写入等）只做了静态核对**，
    没有实际编译验证过。首次构建后请按 `build/README-安装包说明.md` 第 3 节的
    五项清单实测一遍。

11. **构建脚本的代理是探活的**：`scripts/build-release.ps1` 会先探测代理端口，
    连不上就自动跳过并给出提示，不会再抛难懂的 `ECONNREFUSED`。
    首次构建（需要下载 Electron 二进制）必须联网。

12. **【第二次更新 §2/§5】QQFlow 没有命令行接口**，本软件无法"自动完成"QQ 密钥
    提取——只能把 QQFlow 启动起来，由你在它的窗口里操作。
    如果将来 QQFlow 提供了 CLI（如 `QQFlow.exe extract --out ...`），
    改造点在 `src/main/qq/launcher.ts` 的 `launchQqflow()`：把 `spawn(path, [])`
    换成带参数的调用，并在返回前等待它写完密钥文件即可，上层无需改动。

13. **【第二次更新 §3】平台登录状态是"进程是否在运行"的近似判断**，
    不是真正的登录态（拿不到各家的登录接口）。探测实现在
    `src/main/services/login-watch.ts` 的 `detectProcessRunning()`，
    用的是 `tasklist`：若你的微信/QQ 进程名与 `PLATFORM_PROCESSES` 里列的不一致
    （比如换了分支版本、进程名带后缀），改那个常量即可。
    轮询间隔 `WATCH_INTERVAL_MS`（默认 15 秒）也在同一文件顶部。

14. **【第二次更新 §3】「后台持续捕获」默认是关的**。
    开启后软件会常驻托盘；此时"关闭窗口"只隐藏窗口，需要从**托盘右键 → 退出**
    才能真正结束进程。若你希望默认开启，改
    `src/main/core/settings.ts` 里 `DEFAULT_SETTINGS.tray.backgroundCapture`。

15. **【第二次更新 §4】安装向导的依赖检查是"只检测本程序目录"**，
    即 `$INSTDIR` 与其 `tools\` 子目录。若用户把 wechat_exp / QQFlow 装在别处，
    检查会提示"未检测到"（不影响使用——软件运行时会自己搜索更多位置，
    也可以在设置里手动指定路径）。要扩大检测范围，改
    `build/installer.nsh` 里那两处 `FindFirst` 的路径。

---

## 十一、项目结构

```
src/
  shared/            三方共享（主进程 / 预加载 / 渲染进程）
    types.ts           领域模型：账号、会话、消息、任务、LLM、设置、QQ
    ipc.ts             IPC 通道契约（改通道先改这里）
    time.ts            UTC+8 时间工具
  main/              主进程
    index.ts           入口：单实例锁、窗口、启动与退出清理
    core/              基础设施
      paths.ts         目录解析（含 wechat_exp 查找）
      logger.ts        日志（文件 + 内存环形缓冲 + 推送到界面）
      vault.ts         PBKDF2 + AES-256-GCM 保险库
      store.ts         SQLite（sql.js）+ 整库加密落盘
      settings.ts      非敏感设置（boot.json）
      bootstrap.ts     启动顺序编排（含旧数据迁移）
      ipc-router.ts    IPC 路由（统一 Result 包装）
      external-window.ts  按账号隔离的外部网页窗口
      tray.ts          系统托盘  ★v3
    data/              仓储层（accounts / conversations / messages / tasks / llm / layouts / kv）
    services/          业务编排（platform / sync / demo-data）
      login-watch.ts     平台登录状态监听（登录后触发密钥导入）  ★v3
    tasks/             任务域
      classify.ts        状态分类（纯函数，避免循环依赖）
      status.ts          定时重分类调度
      prompt.ts          提示词与 transcript 拼装（含附件正文）
      extractor.ts       抽取编排 + 跨分类去重
      dedup.ts           相似度判定与合并
      heuristic.ts       无 LLM 时的规则兜底
      enrich.ts          文件（docx/xlsx/pdf/txt/md）与链接内容读取  ★v2
      manual.ts          手动新建任务 + AI 生成名称/主题  ★v3
    llm/               LLM 适配（providers / client）
    wechat/            wechat_exp 适配（exe-locator / service / client / normalize / mock）
    qq/                QQ 数据源  ★v2
      locator.ts         扫描 nt_msg.db
      keys.ts            密钥（复用 QQFlow / 手动）+ 保险库存储
      decrypt.ts         SQLCipher 解密（按 QQFlow 参数）
      parser.ts          消息 BLOB 解析（移植自 QQFlow）
      reader.ts          读表、组装会话与消息
      service.ts         对上层暴露的统一入口
      launcher.ts        定位并启动外部 QQFlow.exe  ★v3
  preload/index.ts   预加载（contextBridge 白名单）
  renderer/          渲染进程（React 19 + TypeScript）
    src/
      App.tsx          应用主壳与首次配置流程编排
      api.ts           后端调用封装（Result → 异常 + Toast 总线）
      components/      组件
        TileGrid / TaskTile        磁贴与拖拽网格
        LongPressButton            长按确认（1.5s / 2.5s / 3s 可配）
        SelectionToolbar           多选工具栏  ★v2
        RestoreToast               恢复提示（队列最多 3 个）  ★v2
        task-labels.ts             未明确文案的唯一定义处  ★v2
        LoginWizard / AccountManager / AccountButton
        LlmKeyDialog / ConversationPicker
        TaskDetail / SettingsPanel / LogPanel
      styles/          设计令牌与样式（tokens/base/components/layout/views-*）
build/               安装包资源（NSIS 自定义脚本 + 说明）
scripts/             安装 / 开发 / 构建脚本
docs/
  README-应用说明.md                     ← 本文件
  reference/wechat-exp-integration-contract.md   ← wechat_exp 接口契约（调研产出）
  reference/recon-*.md                           ← 各子系统的调研明细
reference/           wechat_exp / QQFlow 源码与运行时（仅作参考，不参与构建）
```

> **v2 新增**的文件在目录树里用 ★v2 标出。QQ 那一层与 `wechat/` 结构对称，
> 上层的同步流程（`services/sync-service.ts`）对两个平台走同一条管线，
> 所以新增平台时不需要改抽取逻辑。

---

## 十二、排错

| 现象 | 原因与处理 |
|---|---|
| 启动即退出，报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')` | 环境里存在 `ELECTRON_RUN_AS_NODE=1`，Electron 被当成 Node 运行。清掉该变量（`scripts\dev.ps1` 已自动处理） |
| `npm install` 报 ERESOLVE | 依赖版本组合被改动过。本项目使用的稳定组合见 `package.json`：Electron 44 + electron-vite 5 + Vite 7 + @vitejs/plugin-react 5 + TypeScript 5.9 |
| 装完没有 `node_modules\electron\dist\electron.exe` | npm 11 默认拦截安装脚本。执行 `npm approve-scripts electron` 后 `npm rebuild electron`（`scripts\install.ps1` 里有说明） |
| 界面显示「未找到 wechat_exp.exe」 | 见第五节 5.2 的放置位置，或在设置里手动指定路径 |
| 界面显示「未找到微信数据目录」 | 微信数据放在了自定义位置。到「设置 → 数据来源」手动填 `db_storage` 路径（微信「设置 → 文件管理 → 打开文件夹」里能找到） |
| 一直读不到消息 | ① 确认微信正在运行并已登录；② 确认已在「联系人与群聊」里勾选；③ 看运行日志里 wechat_exp 的输出 |
| 抽取任务没有任何结果 | 没配 Key 时会走规则抽取，规则较严；配一个 Key 后结果会好很多。也可先「装载演示数据」验证流程 |
| 任务被拆成很多重复项 | 调高 `src/main/tasks/dedup.ts` 里的 `DUPLICATE_THRESHOLD`（越大越难判定为同一任务）；已完成的却被改回进行中，说明去重没命中，看日志里的「判定依据」字段 |
| 磁贴上的字太小 / 太大 | 「设置 → 界面 → 界面缩放」 |
| 忘记主口令 | 数据无法解密。可删除 `%APPDATA%\wx-msg-grb\store.db.enc` 重新开始（历史任务会丢失） |
| **QQ：提示「还没有可用的数据库密钥」** | 到「添加账号」里粘贴 16 位密钥，或点「从 QQFlow 导入」（需你之前用 QQFlow 提取过；密钥文件在 `%APPDATA%\qqflow\qqflow_keys.json`） |
| **QQ：解密失败** | 如果 QQ 版本较新/较旧，SQLCipher 参数可能不同。改 `src/main/qq/decrypt.ts` 顶部的页大小 / KDF 迭代 / HMAC 算法常量。失败信息里会带上「是不是密钥错了」的判断 |
| **QQ：读到会话但消息都是 `[其他]`** | BLOB 解析算法是逆向成果，QQ 大版本更新后可能失效。看日志 `[qq]` 前缀的记录，必要时对照 `reference/QQFlow-main/src-tauri/src/message_parser.rs` 更新 `src/main/qq/parser.ts` |
| **文件/链接没被读取** | 只有 `.docx/.pdf/.xlsx/.txt/.md` 会解析，其余（含 `.zip`）按设计跳过；图片不做 OCR。链接抓取失败会保留原链接不生成任务。看日志 `[enrich]` 前缀确认原因 |
| **构建时报 `ECONNREFUSED 127.0.0.1:12450`** | 你的代理软件没开。`scripts\build-release.ps1` 现在会先探活代理，连不上会自动跳过；但**首次构建必须联网下载 Electron 二进制**，所以要先开代理。也可传 `-Proxy ""` 明确禁用 |
| **删了的任务找不到** | 点左侧「已删除」分类（第五个）。要彻底删除需在该分类里**长按**磁贴并二次确认 |

更多细节看运行日志：界面上「运行日志」面板，或 `%APPDATA%\wx-msg-grb\logs\`。

---

## 十三、发布与安全说明（v1.0.0）

本节说明本项目在**公开分发前**所做的安全清理与合规处理，供使用者与贡献者知悉。

### 13.1 隐私声明（重要）

- **所有数据本地处理**：本软件不上传任何聊天记录、账号信息或 API Key 到本项目作者的服务器。
- **调用 LLM 时**：只会把你**选定会话**的聊天片段（含附件正文摘要）发送到**你自己配置的**
  LLM 平台；数据去向由你选择的平台决定，请阅读该平台的隐私政策。
- **加密存储**：账号凭据与 API Key 使用 PBKDF2-HMAC-SHA512（210,000 次迭代）派生密钥 +
  AES-256-GCM 加密；数据库文件整体加密。
- **密钥提取依赖第三方工具**：`wechat_exp` / `QQFlow` 会访问本机微信/QQ 数据，
  请自行评估其安全性。
- **本软件不收集任何遥测数据。**

### 13.2 仓库安全清理（`D;` 目录与 `.gitignore`）

在把本项目发布到 GitHub 之前，做过以下清理与防护：

1. **删除了误入库的真实聊天数据。** 开发过程中曾有一个名为 `D;` 的目录（因脚本把
   `D:\WXdecoded` 的冒号写坏而产生），里面是**解密后的真实微信数据**
   （`contact.db`、`message_*.db`、语音 `.silk` 等，约 50 MB）。这些文件**已全部删除**，
   不会出现在仓库与发行版中。
2. **新增 `.gitignore` 作为最后一道防线。** 除常规的 `node_modules/`、`out/`、`build-*.log`
   之外，它显式忽略了所有可能承载隐私的路径与后缀：

   ```
   D;/                 WXdecoded/           xwechat_files/
   *.db *.db-shm *.db-wal                     # 解密后的数据库
   *.silk *.amr                               # 语音文件
   qqflow_keys.json                           # QQ 密钥文件
   .wechat_exp_config.json                    # 含真实 wxid 与各库密钥
   reference/                                 # 第三方源码与可执行文件（不分发）
   wechat_exp*.exe  QQFlow*.exe  *.zip
   ```

3. **清理了成品目录里的本机配置。** 构建脚本会把 `wechat_exp` / `QQFlow` 拷进免安装版的
   `tools\`；其中 `wechat_exp` 生成的 `.wechat_exp_config.json` 含**真实 wxid 与数据库密钥**，
   已从成品目录中删除。

> **给贡献者的提醒**：提交前请确认没有夹带任何真实聊天数据、账号信息或密钥。
> 若你在本机调试时产生了解密数据，请放在 `.gitignore` 覆盖的路径下，或直接删除。

### 13.3 第三方依赖与许可证

本项目采用 **MIT License**（根目录 `LICENSE`）。以下第三方工具**不随本项目分发**，
各自遵循其自身仓库的许可条款，使用者需自行获取并遵守：

- `wechat_exp` — <https://github.com/sunhanaix/pc_wechat_exp>
- `QQFlow` — <https://github.com/yfgug/QQFlow>

安装向导中的「依赖检查」步骤只**检测并提示**这两个工具是否就位，**不代为下载或安装**。

