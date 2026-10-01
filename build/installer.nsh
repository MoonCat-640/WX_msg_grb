; ============================================================================
; WX_msg_grb —— electron-builder 自定义 NSIS 片段（build/installer.nsh）
; ----------------------------------------------------------------------------
; 由 electron-builder 的 nsis.include 引入，用来补充内置安装向导没有的功能：
;   1. 在“选择安装位置”之后增加一个“是否加入 PATH”的勾选页；
;   2. 安装时按用户选择写入 PATH（区分“全体用户→系统 PATH / 当前用户→用户 PATH”）；
;   3. 卸载时把安装时写进去的路径从 PATH 中移除；
;   4. 【第二次更新需求 §4】在同一个向导页上做“依赖检查”：检测 wechat_exp 与
;      QQFlow 是否已就位，缺哪个就把下载地址提示给用户——**只提示，不代为安装**。
;
; 关于“是否加入 PATH”是怎么提供选择的（取舍说明）：
;   electron-builder 提供了 customPageAfterChangeDir 钩子，位置正好在
;   “选择安装路径页”之后、开始复制文件之前。本文件用它 + nsDialogs 做了一个
;   带复选框的自定义页，默认勾选。
;   ★ 关键点：用户选择“为全体用户安装”时，electron-builder 会在“安装模式页”里
;     就完成 UAC 提权并重启为 inner 实例，之后才轮到本页，因此本页与真正执行
;     安装的 Section 处于【同一个进程】，$WXAddPath 不会因为提权重启而丢失。
;   ★ 另外还支持命令行开关 --no-path / /no-path（在 preInit 里解析），
;     用于静默/自动化安装（/S）时跳过加入 PATH。静默安装不会显示本页，
;     此时以命令行开关为准，未指定则默认加入。
;
; 编码：本文件以 UTF-8（无 BOM）保存。electron-builder 生成的脚本带
;   `Unicode true`，NSIS 3 对这种被 !include 的片段会默认按 UTF-8 解析，
;   因此文件里的中文可以正常显示。
; ============================================================================

; 逻辑判断宏（If/ElseIf/While/Break 等）与自定义页控件宏。
; 这两个头文件都带重复包含保护，且 electron-builder 的模板也会引入它们，
; 在这里再写一次是安全的（让本文件的依赖自洽，不依赖模板的引入顺序）。
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; 全局变量（必须在脚本顶层声明）。
;   WXAddPath      —— "1" 表示要加入 PATH，"0" 表示不加入。
;   WXPathCheckbox —— 自定义页上复选框的控件句柄。
Var WXAddPath
Var WXPathCheckbox

; ----------------------------------------------------------------------------
; preInit：在 .onInit 里最先执行。给 PATH 选项一个默认值，并解析命令行开关。
;
; 关于下面那行给 $WXPathCheckbox 的赋值（不要删）：
;   electron-builder 把 NSIS 的警告当作构建错误（日志里是 "warning treated as error"），
;   而 NSIS 会对"用 Var 声明了却从未被使用"的变量报 warning 6001。
;   electron-builder 在生成卸载器时会**单独编译一趟**，那一趟里
;   customPageAfterChangeDir（自定义页所在的宏）不会被展开，
;   于是 $WXPathCheckbox 的唯一使用点消失，构建就会因为这个警告而失败。
;   preInit 是两趟编译里都会展开的宏，所以在这里给它一个初值即可让编译器
;   认为该变量"已被使用"。这行赋的是空值，而且自定义页创建时会重新 Pop 句柄，
;   因此对实际行为没有任何影响。
; ----------------------------------------------------------------------------
!macro preInit
  ; 默认：加入 PATH
  StrCpy $WXAddPath "1"

  ; 消除 warning 6001（详见上方说明）；不要删除本行
  StrCpy $WXPathCheckbox ""

  ; 解析命令行参数：--no-path 或 /no-path 时跳过加入 PATH。
  ; ${GetParameters}/${GetOptions}/${Errors} 由 FileFunc.nsh 提供
  ; （electron-builder 的 multiUser.nsh 已引入 FileFunc.nsh，.onInit 时可用）。
  ${GetParameters} $R0
  ${GetOptions} $R0 "--no-path" $R1
  ${IfNot} ${Errors}
    StrCpy $WXAddPath "0"
  ${EndIf}
  ${GetOptions} $R0 "/no-path" $R1
  ${IfNot} ${Errors}
    StrCpy $WXAddPath "0"
  ${EndIf}
  ClearErrors
!macroend

; ----------------------------------------------------------------------------
; customPageAfterChangeDir：插入“是否加入 PATH”自定义页。
; 该钩子由 electron-builder 的 assistedInstaller.nsh 提供，位置在
; MUI_PAGE_DIRECTORY 之后、MUI_PAGE_INSTFILES 之前，且此时 MUI2 已引入，
; 因此这里可以安全使用 MUI_HEADER_TEXT 与 nsDialogs。
; ----------------------------------------------------------------------------
!macro customPageAfterChangeDir
  Page custom WXPathPageCreate WXPathPageLeave

  Function WXPathPageCreate
    !insertmacro MUI_HEADER_TEXT "选择附加任务" "请选择是否将本程序加入 PATH 环境变量"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 28u "勾选后，可在任意命令提示符 / PowerShell 窗口中直接输入 WX_msg_grb 启动本程序（推荐）。$\r$\n取消勾选则不修改 PATH 环境变量，仍可通过桌面 / 开始菜单快捷方式启动。"
    Pop $0

    ${NSD_CreateCheckbox} 0 40u 100% 12u "将 WX_msg_grb 加入 PATH 环境变量"
    Pop $WXPathCheckbox
    ; 复选框初值跟随 $WXAddPath（默认勾选；若命令行传了 --no-path 则不勾选）
    ${If} $WXAddPath == "0"
      ${NSD_SetState} $WXPathCheckbox 0
    ${Else}
      ${NSD_SetState} $WXPathCheckbox 1
    ${EndIf}

    ; ------------------------------------------------------------------------
    ; 依赖检查（第二次更新需求 §4）
    ;
    ; 需求原文（已调整版）：
    ;   「wechat_exp 和 QQFlow 均为第三方开源工具，README 明确"仅供个人学习、
    ;     研究用途"。你的安装包**不打包、不分发**这两个工具。安装向导中增加
    ;     "依赖检查"步骤：检测系统中是否已存在这两个工具，若不存在则提示用户
    ;     "请前往对应 GitHub 仓库下载"，并附上链接，**不代为安装**。」
    ;
    ; 实现取值：只做"检测 + 提示"，检测范围是本程序的安装目录与其 tools\ 子目录
    ;   （这是软件运行时会自动搜索的位置）。用 $R0-$R3 寄存器而**不新增 Var**，
    ;   避免卸载器那一趟编译出现"变量未使用"警告（该警告会被当作构建错误）。
    ; ------------------------------------------------------------------------
    StrCpy $R0 ""   ; $R0 = 缺失工具的中文名清单（空 = 都就位）

    ; 检测 wechat_exp：先看 tools\，再看安装根目录
    FindFirst $R1 $R2 "$INSTDIR\tools\wechat_exp*.exe"
    FindClose $R1
    ${If} $R2 == ""
      FindFirst $R1 $R2 "$INSTDIR\wechat_exp*.exe"
      FindClose $R1
    ${EndIf}
    ${If} $R2 == ""
      StrCpy $R0 "wechat_exp"
    ${EndIf}

    ; 检测 QQFlow（同理）
    FindFirst $R1 $R2 "$INSTDIR\tools\QQFlow*.exe"
    FindClose $R1
    ${If} $R2 == ""
      FindFirst $R1 $R2 "$INSTDIR\QQFlow*.exe"
      FindClose $R1
    ${EndIf}
    ${If} $R2 == ""
      ${If} $R0 == ""
        StrCpy $R0 "QQFlow"
      ${Else}
        StrCpy $R0 "$R0 与 QQFlow"
      ${EndIf}
    ${EndIf}

    ${If} $R0 == ""
      ${NSD_CreateLabel} 0 58u 100% 20u "依赖检查：已检测到 wechat_exp 与 QQFlow，无需额外操作。"
      Pop $R3
    ${Else}
      ${NSD_CreateLabel} 0 58u 100% 62u "依赖检查：未检测到 $R0。$\r$\n这两个工具是第三方开源软件，本安装包不打包、不分发；请自行下载后放到本程序的 tools\ 目录（如 $INSTDIR\tools\）。$\r$\n  • wechat_exp：github.com/sunhanaix/pc_wechat_exp/releases$\r$\n  • QQFlow：github.com/yfgug/QQFlow$\r$\n未安装也不影响程序启动，只是对应的平台读不到数据。"
      Pop $R3
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function WXPathPageLeave
    ${NSD_GetState} $WXPathCheckbox $0
    ${If} $0 == 1
      StrCpy $WXAddPath "1"
    ${Else}
      StrCpy $WXAddPath "0"
    ${EndIf}
  FunctionEnd
!macroend

; ----------------------------------------------------------------------------
; customInstall：文件复制完成后执行，按用户选择写入 PATH。
; 说明：
;   * $installMode == "all"  —— 全体用户安装（此时已提权，可写 HKLM）
;     写入系统 PATH：HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment
;   * 否则                   —— 仅当前用户安装，写入用户 PATH：HKCU\Environment
;   * SHELL_CONTEXT 是 NSIS 的特殊注册表根，随 SetShellVarContext 切换
;     HKLM/HKCU，electron-builder 在设置安装模式时已经把它切好，正好可用。
; ----------------------------------------------------------------------------
!macro customInstall
  ${If} $WXAddPath == "1"

    ${If} $installMode == "all"
      StrCpy $R2 "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
    ${Else}
      StrCpy $R2 "Environment"
    ${EndIf}

    ReadRegStr $R3 SHELL_CONTEXT "$R2" "Path"
    StrCpy $R4 "$R3"   ; $R4 = 将要写回的值（默认保持原值）
    StrCpy $R5 "0"     ; $R5 = 是否已包含 $INSTDIR（0 否，1 是）

    ${If} $R3 == ""
      ; 原本没有 PATH，直接写我们自己的目录
      StrCpy $R4 "$INSTDIR"
    ${Else}
      ; 逐位扫描，判断 PATH 里是否已经含有安装目录，避免重复添加。
      ; （NSIS 没有内置子串查找，这里用 StrCpy 取定长子串比较来实现；
      ;   PATH 中的路径大小写通常与安装目录一致，故做大小写敏感比较即可。）
      StrLen $R7 "$R3"
      StrLen $R8 "$INSTDIR"
      ${If} $R7 >= $R8
        StrCpy $R9 "0"
        IntOp $R0 $R7 - $R8          ; 最后一个可能的起始位置
        StrCpy $R6 "0"               ; 0 = 继续搜索
        ${While} $R6 == "0"
          StrCpy $R1 "$R3" $R8 $R9   ; 从 $R9 起取 $R8 个字符
          ${If} $R1 == "$INSTDIR"
            StrCpy $R5 "1"
            ${Break}
          ${EndIf}
          ${If} $R9 >= $R0
            StrCpy $R6 "1"           ; 已到末尾，结束
          ${Else}
            IntOp $R9 $R9 + 1
          ${EndIf}
        ${EndWhile}
      ${EndIf}
      ${If} $R5 == "0"
        StrCpy $R4 "$R3;$INSTDIR"    ; 追加到 PATH 末尾
      ${EndIf}
    ${EndIf}

    ; PATH 长度保护：
    ;   系统的环境变量块上限约 32767 字符，但 PATH 这一项在注册表里历史上有
    ;   约 2047 字符的软上限，超限时会被截断甚至写入失败，从而破坏用户原有 PATH。
    ;   因此这里若追加后超过 2000 字符，就放弃修改并保持原值（宁可不加，也不破坏）。
    StrLen $R7 "$R4"
    ${If} $R7 < 2000
      ${If} $R4 != $R3
        ; 用 REG_EXPAND_SZ 写回，保留 PATH 中形如 %SystemRoot% 的变量引用
        WriteRegExpandStr SHELL_CONTEXT "$R2" "Path" "$R4"
        ; 广播 WM_SETTINGCHANGE，让新开的 cmd/PowerShell 立即感知（不必重登录）
        ; 0xFFFF = HWND_BROADCAST，0x1A = WM_SETTINGCHANGE
        SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
      ${EndIf}
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend

; ----------------------------------------------------------------------------
; customUnInstall：卸载时清理 PATH。
; 安装时可能写的是 HKLM（全体用户）也可能是 HKCU（当前用户），卸载时不一定
; 能百分百还原当时的选择，因此两个注册表位置都各清理一次（幂等；权限不足的
; 一侧会静默失败，属正常）。
;
; 处理范围：只移除“恰好位于 PATH 末尾的 ;$INSTDIR”以及“PATH 恰好只有 $INSTDIR”
; 两种情况；若用户安装后手工调整过 PATH，可能残留一条失效路径（不影响使用，
; 属可接受）。为稳妥起见这里没有封装成带字符串参数的宏（避免 NSIS 宏参数引号
; 语义带来的歧义），而是把逻辑展开写两遍。
; ----------------------------------------------------------------------------
!macro customUnInstall

  ; ---- 系统 PATH（“为全体用户安装”时写入的位置）----
  ReadRegStr $R3 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${If} $R3 != ""
    ${If} $R3 == "$INSTDIR"
      DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
      SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
    ${Else}
      StrLen $R7 "$R3"
      StrLen $R8 ";$INSTDIR"
      IntOp $R9 $R7 - $R8
      ${If} $R9 >= 0
        StrCpy $R1 "$R3" $R8 $R9   ; 取末尾 $R8 个字符，应等于 ";$INSTDIR"
        ${If} $R1 == ";$INSTDIR"
          StrCpy $R4 "$R3" $R9     ; 取前 $R9 个字符，即去掉尾部的 ;$INSTDIR
          WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$R4"
          SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors

  ; ---- 用户 PATH（“为当前用户安装”时写入的位置）----
  ReadRegStr $R3 HKCU "Environment" "Path"
  ${If} $R3 != ""
    ${If} $R3 == "$INSTDIR"
      DeleteRegValue HKCU "Environment" "Path"
      SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
    ${Else}
      StrLen $R7 "$R3"
      StrLen $R8 ";$INSTDIR"
      IntOp $R9 $R7 - $R8
      ${If} $R9 >= 0
        StrCpy $R1 "$R3" $R8 $R9
        ${If} $R1 == ";$INSTDIR"
          StrCpy $R4 "$R3" $R9
          WriteRegExpandStr HKCU "Environment" "Path" "$R4"
          SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend
