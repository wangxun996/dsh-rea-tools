# dsh-rea-tools

把 [morluto/rea](https://github.com/morluto/rea)（REA — Reverse Engineer Anything）做成 DSH 插件：
以 `rea-agents` 的 MCP 引擎为后端，把它的 255 个逆向工具接进 DSH 的工具表。

## 装了什么

| 层 | 内容 |
|---|---|
| 引擎 | `rea-agents@6.9.0`（本仓 `package.json` 里锁版本，随插件一起安装，不走 npx） |
| 通道 | `lib/bridge.js`：Node 内置模块实现的 MCP stdio 客户端（newline-delimited JSON-RPC），懒连接、断线自愈、调用超时、可取消 |
| 工具 | 16 个常用工具直接注册（带引擎原始 JSON Schema，名字 `rea_*`）+ 2 个网关工具 |

直接注册的 16 个（覆盖原生二进制 / 归档与安装包 / JS-Electron / Web 页面 / Android / 指南 / 证据导出）：

```
rea_open_binary              rea_binary_session           rea_binary_overview
rea_procedure_pseudo_code    rea_analyze_function         rea_search_strings
rea_inspect_native_exports   rea_inspect_artifact         rea_inspect_managed_artifact
rea_analyze_javascript_application                        rea_inspect_web_page
rea_inspect_android_package  rea_search_guidance          rea_guided_workflows
rea_export_evidence_bundle   rea_close_binary
```

网关（剩下 239 个工具从这里走，避免把几十 KB schema 塞进每次请求）：

```
rea_tools  { query?, limit?, schema? }            搜索目录 / 看某个工具的参数名
rea_call   { tool, arguments }                    按名字调用任意 REA 工具
```

## 安装 / 卸载

```bash
dsh plugin --profile web add dsh-rea-tools      # 从 npm 安装
# 本地开发：dsh plugin --profile web add file:/root/workspace/rea-dsh-plugin
# 卸载
dsh plugin --profile web remove dsh-rea-tools
```

装完要重启一次引擎（App：设置 → 本地引擎 → 重启，或整体重启 App），插件层在启动时组合。

profile 里 `pnpm-workspace.yaml` 有一行 `allowBuilds: frida: false`：`rea-agents` 把 frida 列为可选依赖，
它的构建脚本会下载本机用不到的原生 agent，pnpm 11 在未表态时会直接报 `ERR_PNPM_IGNORED_BUILDS`。

## 配置（`cordis.patch.yml` 里改）

| 字段 | 默认 | 说明 |
|---|---|---|
| `toolPrefix` | `rea_` | 工具名前缀 |
| `toolCallTimeoutMs` | `240000` | 单次 `tools/call` 超时（长分析要留足） |
| `directTools` | `default` | `default` / `all`（255 个全注册，慎用）/ `none` / 显式数组 |
| `engineEntry` | 自动 | 覆盖 `scripts/rea.mjs` 路径 |
| `workdir` | `$DSH_HOME/rea` | 引擎工作目录 |
| `engineEnv` | `{}` | 追加给引擎的环境变量 |

引擎进程的环境是**清洗过的**：`DSH_*` 与 name 里像凭据的变量不会传下去，只留 HOME/PATH/LANG/TMP 等。

## 两个上游坑（本插件已在代码里绕开）

1. **输出校验**：REA 6.9.0 声明 `outputSchema = { required: ["result"], … }`，实际把内层对象当
   `structuredContent` 返回。官方 MCP SDK 会逐个校验并让**每一次** `tools/call` 失败
   （`data must have required property 'result'`）。所以这里不用 SDK，自己做 JSON-RPC。
2. **输入 schema**：引擎的 `enum` / `required` 是字符串数组，早期版本把数组元素当子 schema 递归处理，
   变成对象后 DeepSeek 直接拒绝整个请求（`Invalid schema for function 'rea_analyze_function'`）。
   现在只清洗 schema 对象、保留数据原样，并把 `const` 降级成 `enum`、合并 `allOf`、去掉 `propertyNames`。

## 自检

```bash
node test/schema-check.mjs   # 255 个上游 schema 的结构守卫
node test/harness.mjs        # 假 ctx 里跑通注册、网关和真实工具调用
```


## 上架市场

仓库：<https://github.com/wangxun996/dsh-rea-tools> · npm：`dsh-rea-tools`

一条命令做完三步（建仓库+推代码 → `npm publish` → 给 `awesome-dsh-plugin` 提 PR）：

```bash
GH_TOKEN=<github token> NPM_TOKEN=<npm token> node upload-to-market.mjs
node upload-to-market.mjs --check        # 只自检，不动任何东西
```

`market/` 里是待提交的条目文件（`category: tools`），`SUBMIT.md` 是手工流程版。
发布名用 `dsh-rea-tools`：`dsh-plugin-rea` 已被别的作者占用。

## 本机已装的引擎组件（2026-11-16）

| 组件 | 版本 | 位置 | REA 里怎么用 |
|---|---|---|---|
| Ghidra | 12.1.4 PUBLIC | `/opt/ghidra_12.1.4_PUBLIC` | `GHIDRA_INSTALL_DIR`（原生反编译器为源码自编译的 `linux_arm_64`） |
| rizin | 0.9.1 (android-aarch64 release) | `/opt/rizin/.../bin/rizin` → `/usr/local/bin/rizin` | `RIZIN_COMMAND`，PROOT 里实测可跑 |
| jadx | 1.5.6 | `/opt/jadx` → `/usr/local/bin/jadx` | CLI 可用；REA 的 jadx provider 需要 `jadx-headless-mcp` JAR 且仅支持 x64 宿主，arm64 上会被拒 |
| frida | 17.26.3（python）+ npm 绑定 | `pip3 install frida frida-tools`，`node_modules/frida/build/frida_binding.node` | REA 用 npm 绑定的 `frida_binding.node`，本机 `list_frida_devices` 已通 |

profile 的 `cordis.patch.yml` 里给 `id: rea` 补了 `engineEnv`，把上面两个路径传给引擎进程。

> 坑：在这个 profile 里跑 `pnpm install` / `pnpm rebuild` 会把 `package.json` 的
> `dsh.profile.bundles` 里手写的 `dsh-rea-tools` 抹掉（pnpm 重写清单时只保留它自己写的键）。
> 出现 `--dump-config` 里看不到 `id: rea` 时，把它补回 bundles 数组，或重新跑一次
> `dsh plugin --profile web add dsh-rea-tools      # 从 npm 安装
# 本地开发：dsh plugin --profile web add file:/root/workspace/rea-dsh-plugin`。

## 本机能力现状

Linux / Android(proot, arm64) 上：静态分析（ELF/PE 归档/APK 元数据/JS-Web 包）可用；
`native-macos` 系列 provider 不可用；Ghidra / JADX / rizin / frida 相关工具需要自行装好对应组件，
`rea_binary_session` 会列出每个 provider 的可用性与原因。
