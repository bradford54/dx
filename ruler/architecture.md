# 架构与技术栈

本仓库是一个可安装的 Node.js CLI：`dx`（包名 `@ranger1/dx`）。

注意：本仓库本身不是 Monorepo 业务工程；它用于“管理符合约定的 pnpm + Nx monorepo 工程”。因此，`apps/backend` / `apps/front` 等目录是“被 dx 管理的目标工程”的常见布局，不一定存在于本仓库。

## 技术栈（以 `package.json` 为准）

- Node.js：>= 20.11.0
- 模块系统：ESM（`"type": "module"`）
- 测试：Jest（`pnpm test`）
- 运行时依赖：`strip-json-comments`、`yaml`

## 仓库结构（本仓库）

```
bin/
  dx.js                    # CLI 入口：定位项目根与配置目录，启动 DxCli
  dx-with-version-env.js    # 辅助入口：为 nx:run-commands 注入版本/sha/时间等 env

lib/
  cli/
    dx-cli.js               # DxCli：解析参数/flags，加载 commands.json，路由命令
    help.js                 # help/usage 文案
    flags.js                # 环境标志/通用标志解析
    args.js                 # 位置参数提取（支持 -- passthrough）
    commands/               # 子命令实现（start/build/db/deploy/…）
  env.js                    # dotenv 分层、APP_ENV/NODE_ENV 映射、插值与告警
  env-policy.js             # env-policy.jsonc 的解析与校验
  validate-env.js           # .env 文件布局与机密策略校验（strict env-policy 规则）
  exec.js                   # 执行器：dotenv 包裹、端口清理、重试、并发/串行
  logger.js                 # 统一日志（可选写入 dx/logs）
  confirm.js                # 确认/危险操作二次确认（支持 CI 自动 yes）
  codex-initial.js          # dx initial：同步包内 skills 到本机 agent 目录
  worktree.js               # issue worktree 管理（注意：与原生 git worktree 不同）
  vercel-deploy.js          # Vercel 部署辅助
  artifact-deploy/          # 技术栈无关的制品构建、上传、systemd/command 启动与回滚
  backend-artifact-deploy/   # 后端制品部署配置、构建、远端脚本与结果解析
  start-dev.js              # 内置开发启动 runner
  backend-package.js        # 后端打包 runner（给目标工程用）
  sdk-build.js              # SDK 构建 runner（给目标工程用）
  version.js                # CLI 版本读取
  run-with-version-env.js   # 注入版本环境变量逻辑

example/
  dx/config/                # 最小可读配置示例（commands/env-layers/env-policy）
  .env.*                    # 示例 env 文件（用于演示分层与占位符）

test/                       # Jest tests（主要覆盖 env-policy/validate-env）

ruler/                      # 常驻提示词（本文件所在目录）
```

## dx 的工作机制（高层）

1) 发现目标工程根目录
- `bin/dx.js` 从当前目录向上查找 `dx/config/commands.json`。
- 或使用 `DX_CONFIG_DIR` / `--config-dir` 显式指定配置目录。
- 找到后设置：
  - `DX_PROJECT_ROOT`：目标工程根目录
  - `DX_CONFIG_DIR`：目标工程配置目录（默认 `dx/config`）

2) 配置驱动命令执行
- `DxCli` 读取 `${DX_CONFIG_DIR}/commands.json` 并以此决定每个 `dx <command> ...` 的实际执行内容。
- `commands.json` 支持：
  - 单命令：`{ "command": "..." }`
  - 并发：`{ "concurrent": true, "commands": ["build.front.development", ...] }`
  - 串行：`{ "sequential": true, "commands": ["build.backend.production", ...] }`
  - 按环境分支：`development/staging/production/test/e2e`（由 `--dev/--staging/--prod/--test/--e2e` 选择；默认 `--dev`）
  - 元数据：`app`（触发 dotenv 分层与 env-policy required 校验）、`ports`（端口冲突清理）、`dangerous`（危险操作确认）
  - internal runner：`sdk-build`、`backend-package`、`artifact-deploy`、`backend-artifact-deploy`、`start-dev`、`pm2-stack`

3) 环境变量分层与校验
- `dx/config/env-layers.json` 定义每个环境加载哪些 `.env.<env>(.local)` 文件。
- `dx/config/env-policy.jsonc`（推荐）统一定义：
  - .env 文件布局限制（禁止根 `.env` / `.env.local`，禁止子目录散落 `.env*`，可配置例外）
  - 机密 key 的占位符策略（committed 文件必须为占位符，真实值只能在 `.local`）
  - required keys（按 target + environment）
- `env-policy.jsonc` 为必需配置；缺失时 dx 将直接报错。

## 约定速记（对“被 dx 管理的目标工程”）

- 必需配置目录：`dx/config/{commands.json,env-layers.json,env-policy.jsonc}`
- 常用环境标志：`--dev/--staging/--prod/--test/--e2e`
- 危险操作：需要交互确认；可用 `-Y/--yes` 跳过确认（CI 或明确场景）
