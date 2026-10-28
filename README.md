# PoA on Codex 示例仓库

本仓库提供一组可运行的 PoA 示例：

- `demos/` 下的示例程序
- `poas/` 下的示例包
- 打包脚本 `poas/build.sh`
- `runner/` 下的 JSON-RPC 客户端

> 本文档仅说明环境配置与运行方式。
>
> PoA 的概念、程序写法、运行机制、注意事项与已知限制，参见 PoA 开发文档：<https://github.com/Brainary-Team/brainary-codex-docs>。

## 1. 前置条件

| 项      | 要求                                                         |
| ------ | ---------------------------------------------------------- |
| 运行时二进制 | 不随本仓库分发，须单独获取，见 1.1                                        |
| 平台     | 当前构建面向 x86\_64 Linux。macOS 与 Windows 须在容器、虚拟机或 WSL 中运行     |
| Python | 运行示例程序需 `python3`；`poas/build.sh` 需 3.11 及以上（依赖 `tomllib`） |
| 模型服务   | 见 2.2                                                      |

### 1.1 安装运行时

发布归档包含 `codex` 与 `codex-code-mode-host` 两个二进制。

`codex` 在自身所在目录中查找 `codex-code-mode-host`，两者须置于同一目录。

将其解压至仓库根目录下的 `bin/`：

```bash
mkdir -p bin
tar -xzf codex-poa-<target>.tar.gz -C bin
./bin/codex --version
```

`bin/` 已列入 `.gitignore`。

> 二进制置于其他位置时，通过 `CODEX_BIN` 指定 `codex` 路径。查找顺序为 `CODEX_BIN`、`./bin/codex`、`PATH`。

若最终解析到 OpenAI 发行的 `codex`，运行将以 `unknown method thread/codeMode/exec` 失败。

## 2. 配置

### 2.1 连接参数

将 `.env.example` 复制为 `.env` 并填写。

```sh
OPENAI_API_URL=https://your-provider.example/v1   # 末尾 /v1 可省略，缺失时自动补全
OPENAI_API_KEY=...
OPENAI_API_MODEL=your-model
```

各 profile 均设定 `wire_api = "responses"`，模型服务须支持 Responses API，仅支持 chat-completions 的端点不适用。

使用 Anthropic 协议时设置 `WIRE_API=anthropic`。

### 2.2 模型服务依赖

| 运行对象                               | 是否需要模型服务            |
| ---------------------------------- | ------------------- |
| `demos/00`、`demos/06` 至 `demos/09` | 否。不派生子智能体，不产生模型调用   |
| `demos/01` 至 `demos/05`、`demos/10` | 是                   |
| `poas/` 下的包                        | 否。`run.sh` 自动以占位值填充 |

尚未取得 API key 时，可先运行 `demos/00` 与 `demos/06` 至 `demos/09`。

### 2.3 可选环境变量

| 变量                    | 说明                                                              |
| --------------------- | --------------------------------------------------------------- |
| `CODEX_BIN`           | `codex` 二进制路径                                                   |
| `CODEX_DEMO_MODEL`    | 覆盖 `OPENAI_API_MODEL`                                           |
| `CODEX_DEMO_BASE_URL` | 指定完整 base URL，不再由 `OPENAI_API_URL` 推导                           |
| `CODEX_DEMO_WIRE_API` | 覆盖 `WIRE_API`，取值 `responses`（默认）或 `anthropic`                   |
| `CODEX_DEMO_SANDBOX`  | 设置 `sandbox_mode`，默认 `read-only`。`demos/08` 需 `workspace-write` |

优先级为 `CODEX_DEMO_*` > `.env` 及环境变量 > 占位值，其中占位值仅在运行 PoA 包时生效。

### 2.4 Profile

`config/` 下每个 `.toml` 对应一个 profile。`run.sh` 将其渲染至按 profile 隔离的 `CODEX_HOME`（`.home/<profile>/`），并替换其中的模型、base URL 与沙箱等占位符。

| profile     | 后端            | 说明                                                              |
| ----------- | ------------- | --------------------------------------------------------------- |
| `v1`        | 由模型元数据决定      | 不做固定，实际后端取决于所用模型                                                |
| `v1-forced` | 固定为 v1        | 多数示例的推荐取值                                                       |
| `v2`        | v2            | 用于验证 v2 行为                                                      |
| `full`      | 同 `v1-forced` | 额外启用 memories、时钟、token 预算与权限工具；`demos/09` 必需，`demos/06` 在此矩阵最完整 |

后端由模型元数据决定，不由本地配置决定。

变更模型、模型服务或 profile 后，应以实际使用的 profile 运行 `demos/06`，确认当前配置暴露的工具集合、缺失项及其原因：

```bash
./run.sh demos/06_capability_matrix.js v1-forced
```

## 3. 运行

```text
./run.sh <demo.js | poa 目录 | *.poa> [profile] [附加参数]
```

profile 缺省为 `v1`。目录与 `.poa` 文件按包处理，交由 `codex exec --poa` 执行；`.js` 文件按示例程序处理，交由 `runner/run_workflow.py` 执行。

```bash
./run.sh demos/00_probe.js          v1-forced
./run.sh demos/01_fanout_summary.js v1-forced --cwd /path/to/any/multi-folder/repo
CODEX_DEMO_SANDBOX=workspace-write ./run.sh demos/08_file_and_image.js full
```

`runner/run_workflow.py` 支持的附加参数：

| 参数               | 说明                    |
| ---------------- | --------------------- |
| `--cwd <path>`   | 指定线程的工作目录，读取仓库内容的示例需要 |
| `--model <name>` | 覆盖模型                  |
| `--raw`          | 输出原始 RPC 返回值          |

### 3.1 示例程序

| 编号 | 文件                         | 内容                                                           | 需要模型服务 |
| -- | -------------------------- | ------------------------------------------------------------ | ------ |
| 0  | `00_probe.js`              | 探测进入 code mode 的多智能体后端                                       | 否      |
| 1  | `01_fanout_summary.js`     | 并行分发：N 个目录对应 N 个子智能体，汇总为结构化报告                                | 是      |
| 2  | `02_map_reduce.js`         | mapper 读取仓库，reducer 仅依据 mapper 输出的 JSON 进行综合                 | 是      |
| 3  | `03_adversarial_review.js` | 一个子智能体提出结论，三个从不同视角反驳，由程序统计结果                                 | 是      |
| 4  | `04_stateful_dialogue.js`  | 长驻子智能体：单次读取后进行四轮存在依赖关系的追问                                    | 是      |
| 5  | `05_streaming_select.js`   | 对多个等待调用使用 `Promise.race`，并说明其非流式表现                           | 是      |
| 6  | `06_capability_matrix.js`  | 当前配置的能力矩阵，逐个调用只读工具，耗时约 1 秒                                   | 否      |
| 7  | `07_exec_session.js`       | 通过 `write_stdin` 驱动 `exec_command` 会话，并对照并行与串行执行             | 否      |
| 8  | `08_file_and_image.js`     | `apply_patch`、`view_image` 与 `image()`，须配合 `workspace-write` | 否      |
| 9  | `09_memory_clock_goal.js`  | memories、goal、plan、上下文预算与权限工具                                | 否      |
| 10 | `10_agent_lifecycle.js`    | 子智能体原始工具：`resume_agent`、`interrupt_agent` 及层级深度              | 是      |

### 3.2 PoA 包

PoA 包是根目录含 `manifest.toml` 的目录，清单的 `entry` 指向程序主体（示例中为 `main.js`），并可捆绑自带的 stdio MCP server。

`.poa` 是该目录打包后的单文件形态。

两种形态运行方式一致，且均不经过 Python 客户端：

```bash
./run.sh poas/00_echo v1-forced           # 渲染 profile 与 CODEX_HOME 后调用 codex exec --poa
./bin/codex exec --poa poas/00_echo       # 直接调用
./bin/codex exec --poa ./00_echo.poa      # 已打包的形态
```

`codex exec --poa <目录>` 在提交前自行打包，故运行前无需构建。需要以单个文件分发时使用 `poas/build.sh`：

```bash
poas/build.sh poas/00_echo                # 输出 ./00_echo.poa
poas/build.sh poas/00_echo dist/echo.poa  # 指定输出路径
```

包格式、清单字段及编写方式参见开发文档[《打包与分发》](https://github.com/Brainary-Team/brainary-codex-docs/blob/main/08-packaging.md)。

### 3.3 在 TUI 主对话里调用已安装的 PoA

`poas/01_tui_call` 是一个无参数的包。安装后，`thread/start` 会从 `$CODEX_HOME/poas` 载入它，主对话里的工具名是 `poa.tui_call`。TUI 和 `exec --poa` 都会先启动线程，因此使用同一个 `CODEX_HOME`。

```bash
./poas/01_tui_call/install.sh
set -a && source .env && set +a
export CODEX_HOME="${CODEX_HOME:-$PWD/.home/v1-forced}"
```

`tui_call` 会先派一个子智能体请求 `https://ipinfo.io/json` 取得城市，再派第二个子智能体按该城市请求 `https://wttr.in`。当前 profile 的 `read-only` 沙箱默认不出网，所以下面两条命令都要加 `-s danger-full-access`。这个取值取消沙箱隔离，只作用于这一次启动。

进入 TUI，在新会话输入 `请调用已安装的 tui_call PoA`：

```bash
./bin/codex -s danger-full-access
```

直接执行已安装目录：

```bash
./bin/codex exec --poa "$CODEX_HOME/poas/01_tui_call" -s danger-full-access
```

成功标志是输出里同时有 ipinfo 返回的城市，以及 wttr.in 返回的天气原文。`exec --poa` 按路径执行这个包，会打两次模型。主对话里的发现和调用以 TUI 那条为准。不要用 `./run.sh` 代替：它会改写 `.home/<profile>`，而且 `.js` 用例不走已安装目录。

## 4. 目录结构

```
run.sh                  入口脚本，按 profile 隔离 CODEX_HOME 并分发至客户端或 codex exec --poa
poas/build.sh           将包目录打包为可分发的 .poa
runner/rpc_client.py    基于 codex app-server stdio 的 JSON-RPC 客户端
runner/run_workflow.py  预置 lib/prelude.js，提交程序并渲染输出
runner/make_catalog.py  由 vendor/models.json 派生固定 v1 的模型目录
lib/prelude.js          与后端无关的编排原语，预置于每个示例程序之前
demos/                  示例程序
poas/                   自带能力的示例包
config/                 profile 模板，每个 profile 一个 toml
vendor/models.json      运行时模型目录的副本
bin/                    运行时二进制的存放位置，已列入 .gitignore
.home/<profile>/        运行时生成的 CODEX_HOME，已列入 .gitignore
```

`lib/prelude.js` 中各 helper 的说明参见开发文档[《API 参考》第 2 节](https://github.com/Brainary-Team/brainary-codex-docs/blob/main/07-api-reference.md#2-prelude-primitive16-个)。

## 5. 常见问题

| 现象                                      | 原因与处理                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 报 `unknown method thread/codeMode/exec` | 解析到了 `PATH` 中 OpenAI 发行的 `codex`。设置 `CODEX_BIN`，或将二进制置于 `bin/`                                                                    |
| 无法找到 `codex-code-mode-host`             | 两个二进制未置于同一目录                                                                                                                |
| 沙箱启动失败，Linux 缺少 `bwrap`                 | 设置 `CODEX_DEMO_SANDBOX=danger-full-access`。该取值取消沙箱隔离，子智能体将获得完整文件访问权限                                                        |
| `demos/08` 写入失败                         | 须设置 `CODEX_DEMO_SANDBOX=workspace-write`                                                                                    |
| 智能体工具数量为 0                              | 模型元数据判定的后端与 profile 不匹配。运行 `demos/06` 确认，或改用 `v1-forced`                                                                    |
| 报 `unknown profile 'x'`                 | `config/x.toml` 不存在                                                                                                         |
| 配置解析错误指向 `.home/` 下的文件                  | 该文件为渲染产物，应修改 `.env` 或 `config/<profile>.toml`                                                                               |
| 无人值守运行无响应                               | 通常为某一工具触发审批所致，参见开发文档[《打包与分发》第 4 节](https://github.com/Brainary-Team/brainary-codex-docs/blob/main/08-packaging.md#4-两项必做处理) |

## 6. 密钥处理

API key 不写入配置文件。`config/*.toml` 仅以 `env_key = "OPENAI_API_KEY"` 声明变量名，`run.sh` 从 `.env` 读取该变量并导出至运行时进程。

密钥因此会以明文落在本地磁盘的两处：

| 位置                                 | 来源                           |
| ---------------------------------- | ---------------------------- |
| `.env`                             | 由使用者填写                       |
| `.home/<profile>/shell_snapshots/` | 运行时写出的环境快照，每个用过的 profile 各一份 |

两处均已列入 `.gitignore`，不会随 `git commit` 提交。但 `.gitignore` 仅对 Git 生效，对外分发或归档本目录前，须删除 `.home/`（运行产物，可重新生成）并排除 `.env`。
