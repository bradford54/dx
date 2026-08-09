# dx

一个可安装的 Node.js CLI，用于管理符合约定的 pnpm + nx monorepo 项目的构建/启动/数据库/部署等流程。

本工具通过项目内的 `dx/config/*` 配置文件来驱动命令执行：你可以把它理解成「带环境变量分层 + 校验 + 命令编排能力的脚本系统」。

## 当前规范

当前版本的 `dx` 已收敛到 strict 配置规范。

这意味着：

- 配置写错时直接报错，不再自动兼容旧写法
- `help` 输出由 `dx/config/commands.json` 动态生成，不再依赖代码中的大段硬编码文案
- 命令配置中的环境分支必须使用完整环境键

当前推荐且受支持的环境键：

- `development`
- `staging`
- `production`
- `test`
- `e2e`

当前推荐且受支持的 CLI 环境标志：

- `--dev`
- `--staging`
- `--prod`
- `--test`
- `--e2e`

不再建议写法：

- `dev` / `prod` 作为配置节点名
- `--development` / `--production` / `--stage`
- 任何旧配置回退、旧命令别名或自动输入修正

## 安装

必须全局安装，并始终使用最新版本：

```bash
pnpm add -g @ranger1/dx@latest
```

安装后即可在任意目录使用：

```bash
dx --help
dx --version
dx status
```

升级到最新版本：

```bash
pnpm update -g @ranger1/dx
```

## 使用条件（必须满足）

- Node.js：>= 20
- 包管理器：pnpm（dx 内部会调用 `pnpm`）
- 构建系统：Nx（dx 默认命令配置里大量使用 `npx nx ...`）
- 环境加载：建议项目依赖 `dotenv-cli`（dx 会用 `pnpm exec dotenv ...` 包裹命令来注入 `.env.*`）
- 项目结构：推荐按 `apps/backend` / `apps/front` / `apps/admin-front` 这类布局组织；如有自定义目录结构，请通过 `dx/config/commands.json` 适配

如果你的 monorepo 不完全一致，也能用：关键是你在 `dx/config/commands.json` 里把命令写成适配你项目的形式。

## 项目配置（必须）

dx 会从当前目录向上查找 `dx/config/commands.json` 来定位项目根目录。

你需要在项目根目录提供：

```
dx/
  config/
    commands.json
    env-layers.json
    env-policy.jsonc
```

可选覆盖：

- 环境变量：`DX_CONFIG_DIR=/abs/path/to/config`
- 参数：`dx --config-dir /abs/path/to/config ...`

全局安装场景下，如果你不在项目目录内执行，也可以通过 `DX_CONFIG_DIR` / `--config-dir` 显式指定配置目录（目录下需要存在 `commands.json`）。

示例：

```bash
# 在任意目录执行
dx --config-dir /path/to/your-repo/dx/config status

# 或
DX_CONFIG_DIR=/path/to/your-repo/dx/config dx status
```

## 配置文件写法

### 1) dx/config/commands.json

这是核心文件，定义了 dx 各命令要执行的 shell 命令，也承载帮助信息配置。

它支持：

- 单命令：`{ "command": "..." }`
- 并发：`{ "concurrent": true, "commands": ["build.front.development", "build.admin.development"] }`
- 串行：`{ "sequential": true, "commands": ["build.backend.production", "build.sdk"] }`
- 环境分支：如 `build.backend.development` / `build.backend.production`（dx 会根据 `--dev/--prod/--staging/...` 选择）
- dotenv 包裹：配置里带 `"app": "backend"` 时，dx 会按 `env-layers.json` 拼出 dotenv 层并用 `pnpm exec dotenv ... -- <command>` 执行

常见字段（单命令配置）：

```jsonc
{
  "command": "npx nx build backend --configuration=production",
  "app": "backend",                // 可选：用于选择 dotenv 层，并决定需要校验的 env 变量组
  "ports": [3000],                  // 可选：用于 start 类命令，冲突时自动清理
  "description": "构建后端(生产环境)",
  "dangerous": true,                // 可选：危险操作需要确认
  "skipEnvValidation": true,         // 可选：跳过 env 校验（仍可加载 dotenv 层）
  "env": { "NX_CACHE": "false" } // 可选：注入额外环境变量
}
```

命令路径引用（并发/串行的 commands 数组）使用点号字符串，例如：

```json
{ "concurrent": true, "commands": ["build.shared", "build.front.development"] }
```

帮助配置示例：

```json
{
  "help": {
    "summary": "统一开发环境管理工具",
    "globalOptions": [
      { "flags": ["--dev"], "description": "使用 development 环境" },
      { "flags": ["--prod"], "description": "使用 production 环境" }
    ],
    "commands": {
      "start": {
        "summary": "启动/桥接服务",
        "notes": ["未指定 service 时默认使用开发套件，仅允许 --dev"],
        "examples": [
          { "command": "dx start backend --dev", "description": "启动后端开发服务" }
        ]
      }
    }
  }
}
```

约束：

- 命令级帮助推荐放在 `help.commands.<command>`
- target 级帮助推荐放在 `help.targets.<command>.<target>`
- 帮助示例必须与真实命令树一致，不能写配置里不存在的 target
- 运行时会校验 help 配置结构；坏配置会直接报错

### 2) dx/config/env-layers.json

用于定义不同环境下加载哪些 `.env.*` 文件（顺序 = 覆盖优先级）。格式：

```json
{
  "development": [".env.development", ".env.development.local"],
  "staging": [".env.staging", ".env.staging.local"],
  "production": [".env.production", ".env.production.local"],
  "test": [".env.test", ".env.test.local"],
  "e2e": [".env.e2e", ".env.e2e.local"]
}
```

### 3) dx/config/env-policy.jsonc

统一的 env 策略配置（jsonc），同时覆盖：

- env 文件布局约束（禁用 `.env` / `.env.local`；禁止子目录散落 `.env*`，仅允许少数特例路径）
- 机密键策略：机密 key 只能在 `.env.<env>.local` 放真实值；对应的 `.env.<env>` 必须存在同名 key 且为占位符 `__SET_IN_env.local__`
- 必填校验：按环境 + 按 target（端）定义 required keys，执行命令前校验是否缺失/仍为占位符

target（端）不写死，由 `env-policy.jsonc.targets` 定义；`commands.json` 里的 `app` 通过 `env-policy.jsonc.appToTarget` 映射到某个 target。

注：`env-policy.jsonc` 为必需配置；未提供时 dx 将直接报错。

### 4) 可选的品牌环境 profile

多品牌项目可以增加 `dx/config/env-profiles.json`，声明允许运维使用的 profile、环境和必须直接
存在于私有 profile 中的键：

```json
{
  "version": 1,
  "environments": ["staging", "production"],
  "profiles": {
    "primary": { "label": "Primary brand" },
    "secondary": { "label": "Secondary brand" }
  },
  "requiredLocalKeys": {
    "staging": ["DATABASE_URL"],
    "production": ["DATABASE_URL"]
  }
}
```

私有文件固定放在 `dx/env/templates/<profile>/<environment>.local`，与对应的
`<environment>.local.example` 模板同目录。真实文件必须被 Git 忽略且权限为 `0600`；模板不含真实值。

```bash
dx env status
dx env validate secondary --staging
dx env exec secondary --staging -- dx deploy backend
```

`dx env exec` 会加锁、原子装配 `.env.<environment>.local`、把同一份值注入子进程，并在成功、
失败或中断后删除临时文件。根目录不允许持久保存 staging/production `.local`；发现旧文件时命令
会直接报错，必须先迁移到品牌 profile。内部 `dx` 命令未指定环境时会自动补齐；指定冲突环境时
直接拒绝。该命令只操作本机文件和子进程，不包含上传、同步或修改 GitHub Environment 的能力。

## 示例工程

查看 `example/`：包含一个最小可读的 `dx/config` 配置示例，以及如何在一个 pnpm+nx monorepo 中接入 dx。

## 命令

dx 的命令由 `dx/config/commands.json` 驱动，并且内置了一些 internal runner（避免项目侧依赖任何 `scripts/lib/*.js`）：

- `internal: sdk-build`：SDK 生成/构建
- `internal: backend-package`：后端打包
- `internal: backend-artifact-deploy`：后端制品构建、上传与远端部署
- `internal: artifact-deploy`：技术栈无关的制品构建、上传、原子切换与服务启动
- `internal: start-dev`：开发环境一键启动
- `internal: pm2-stack`：PM2 交互式服务栈（支持端口清理/缓存清理配置）

内置命令入口速览：

- `dx start [target]`：启动开发服务；未指定 target 时默认使用 `start.development`
- `dx build [target]`：按当前环境构建；未指定 target 时默认 `all`
- `dx test [unit|e2e] <target> [path...]`：运行测试；unit 自动使用 `--test` 环境，e2e 自动使用 `--e2e` 环境
- `dx db <generate|migrate|deploy|reset|seed|format|script>`：数据库相关命令；`migrate` 仅允许 `--dev`
- `dx deploy <target>`：部署目标；普通 Vercel target 默认 `--staging`，artifact target 默认 `--dev`
- `dx lint [--fix]`：运行 lint；`--fix` 会透传给下游 runner
- `dx install`：执行项目配置的安装命令
- `dx clean [target]` / `dx cache clear`：执行清理类命令，危险操作会要求确认
- `dx package backend [--skip-build]`：使用内置后端打包 runner
- `dx worktree <make|del|list|clean>`：管理 issue worktree；这是 dx 封装，不等同于原生 `git worktree`
- `dx export <target>`：执行配置化导出命令
- `dx contracts [generate|pull]`：导出 OpenAPI 并生成 `packages/api-contracts` 下的 Zod 合约（需要目标工程具备对应结构）
- `dx release version <version>`：同步更新常见 app 包版本号
- `dx env status|validate|exec`：安全校验并临时装配多品牌私有环境 profile（需 `env-profiles.json`）
- 内置命令族支持项目扩展：例如项目可在 `commands.json.release.plan/run` 中声明
  `dx release plan --prod` 和 `dx release run --prod`，同时保留内置的 `release version`
- `dx initial`：同步包内 skills 到本机 agent 目录

常用示例：

```bash
dx start backend --dev
dx start all --dev
dx build backend --prod
dx build sdk --dev
dx db generate
dx db migrate --dev --name init
dx db deploy --prod -Y
dx deploy front --staging
dx deploy backend --prod
dx install
dx lint
dx lint --fix
dx test unit backend apps/backend/src/modules/user/user.service.spec.ts
dx test e2e backend apps/backend/e2e/auth
dx test e2e quantify apps/quantify/e2e/health/health.e2e-spec.ts
dx db script fix-email-verified-status --dev -- --dry-run
dx package backend --prod --skip-build
dx worktree make 88 --base main
dx cache clear -Y
```

测试命令默认并行度：

- `dx test unit ...` 会自动追加 `--maxWorkers=8`
- `dx test e2e ...` 会自动追加 `--workers=8`
- 如果命令配置或 `--` 透传参数里已经指定了对应 worker 参数，dx 不会重复追加；例如 `dx test e2e backend apps/backend/e2e/auth -- --workers=2`
- 如果 unit 命令或对应 `apps/<target>/package.json` 的 `scripts.test` 已使用 Jest `--runInBand`，dx 不会追加 `--maxWorkers=8`，避免触发 Jest 互斥参数错误

关于 `dx initial`：

- `dx initial` 会把 npm 包内置的 `skills/` 覆盖同步到 `~/.agents/skills`。
- `~/.claude/skills` 中包内管理的同名非软链接 skill 会先删除，再创建指向 `~/.agents/skills` 的软链接。
- `~/.codex/skills` 中包内管理的同名非软链接 skill 会被清理；已有软链接不会按旧副本删除。
- 不属于包内管理的其他用户自有 skill 目录会保留。

关于 `help`：

- `dx --help`
- `dx help <command>`

现在都优先从 `commands.json` 的 `help` 区域动态生成。

如果某个命令还没有补充足够的 `help` 元数据，输出会回退到配置结构推导出的最小帮助，而不是旧的手写兼容文案。

命令约束摘要：

- 对声明了 `requiresPath: true` 的 E2E target，`dx test e2e <target>` 必须提供文件或目录路径，禁止无路径或 `all` 全量执行
- `dx test e2e all` 不受支持，必须显式指定 target 和路径
- `dx test unit ...` 默认使用 8 个 worker；`dx test e2e ...` 默认使用 8 个 worker；可通过 `--` 透传参数覆盖；unit 检测到 Jest `--runInBand` 时不会追加 `--maxWorkers`
- `dx db migrate --dev` 必须通过 `--name` 或 `-n` 指定迁移名，禁止依赖 Prisma 交互式输入
- `dx db migrate` 仅允许在 `--dev` 环境创建迁移；非开发环境请使用 `dx db deploy`
- `dx db generate/migrate/deploy/reset/seed/script` 会禁用 Nx 缓存，避免命中缓存后未实际执行
- `dx deploy` 仅支持 `--dev`、`--staging`、`--prod`，不支持 `--test` / `--e2e`
- `dx start` 未指定服务时默认是开发套件，仅允许 `--dev`
- `dx start` 下的单层目标（如 `stagewise-front`）默认仅支持 `--dev`
- `dx build` 显式传入环境标志时，必须是该 target 实际支持的环境
- `dx worktree` 是 dx 的 issue worktree 封装，与原生 `git worktree` 行为不同，不要混用

### `dx start stack` 配置详解（PM2 交互式服务栈）

从 `0.1.78` 起，`dx start stack` 推荐完全由 `dx/config/commands.json` 配置驱动，不再依赖硬编码服务列表。

最小可用配置：

```json
{
  "start": {
    "stack": {
      "internal": "pm2-stack",
      "interactive": true,
      "description": "PM2 交互式服务栈",
      "stack": {
        "ecosystemConfig": "ecosystem.config.cjs",
        "services": ["backend", "front", "admin"],
        "preflight": {
          "killPorts": [3000, 3001, 3500],
          "pm2Reset": true
        }
      }
    }
  }
}
```

完整字段说明：

- `start.stack.internal`
  - 固定为 `pm2-stack`，表示启用内置 PM2 交互式 runner。
- `start.stack.interactive`
  - 建议设为 `true`，用于标记这是交互式命令（便于团队识别）。
- `start.stack.stack.ecosystemConfig`
  - PM2 配置文件路径；支持相对路径（相对项目根目录）或绝对路径。
  - 默认值：`ecosystem.config.cjs`。
- `start.stack.stack.pm2Bin`
  - PM2 命令前缀，默认 `pnpm pm2`。如果团队使用全局 pm2，可改为 `pm2`。
- `start.stack.stack.services`
  - 交互命令（`r/l/s`）可操作的服务名单。
  - 示例：`["backend", "front", "admin"]`。
- `start.stack.stack.preflight.killPorts`
  - 启动前自动清理占用端口列表。
  - 这就是“某些端口被占用时自动处理”的核心配置。
- `start.stack.stack.preflight.forcePortCleanup`
  - 是否强制清理端口占用，默认 `true`。
- `start.stack.stack.preflight.pm2Reset`
  - 启动前是否执行 PM2 状态重置（`delete all` / `kill` / 状态文件清理），默认 `true`。
- `start.stack.stack.preflight.cleanPaths`
  - 启动前需要删除的缓存路径列表（相对项目根目录）。
  - 适合清理 `.next`、`dist`、`.vite` 等缓存，避免脏状态。
- `start.stack.stack.preflight.cleanTsBuildInfo`
  - 是否清理 `*.tsbuildinfo`，默认 `true`。
- `start.stack.stack.preflight.cleanTsBuildInfoDirs`
  - 扫描 `*.tsbuildinfo` 的目录列表。

交互命令保持不变：

- `r <service>` 重启服务
- `l <service>` 查看日志
- `s <service>` 停止服务
- `list` 查看状态
- `monit` 打开 PM2 监控
- `q` 停止所有服务并退出

推荐实践：

- 将 `services` 与 `ecosystem.config.cjs` 里的 app 名保持一致，避免交互命令找不到服务。
- `killPorts` 只配置开发态常驻端口，避免误杀不相关进程。
- 如果项目不是 `apps/front` / `apps/admin-front` 结构，请按实际目录改 `cleanPaths` 与 `cleanTsBuildInfoDirs`。

## deploy 行为说明

从 `0.1.9` 起，`dx deploy <target>` 不再在 dx 内部硬编码执行任何 `nx build`/`sdk build` 等前置步骤。

- 需要的前置构建（例如 `shared`、`api-contracts`、OpenAPI 导出、后端构建等）应由项目自己的 Nx 依赖图（`dependsOn`/项目依赖）或 Vercel 的 `buildCommand` 负责。
- 这样 dx deploy 不会强依赖 `apps/sdk` 等目录结构，更容易适配不同 monorepo。

### 配置化 Vercel target

Vercel target 不再限于 dx 内置名称。项目可以在 `commands.json` 声明任意 target，适合多品牌分别绑定配置文件和 Project ID：

```json
{
  "deploy": {
    "front-br": {
      "description": "部署 br front",
      "vercel": {
        "configFile": "vercel.front.br.json",
        "projectIdEnvVar": "VERCEL_PROJECT_ID_FRONT",
        "deployCwd": ".",
        "prebuiltCwd": "."
      }
    }
  }
}
```

```bash
dx deploy front-br --prod
```

Project ID 的值仍由当前环境层或 CI Environment 注入；`commands.json` 只声明变量名，不保存凭据或具体 ID。

### 通用制品发布（非 Node / systemd）

当 target 配置为 `internal: "artifact-deploy"` 时，`dx deploy <target>` 使用技术栈无关的制品发布流程。远端不要求 Node、pnpm、dotenv、PM2；安装、启动和验活都由 target 自己声明。

```json
{
  "deploy": {
    "comfyui-mulerouter": {
      "internal": "artifact-deploy",
      "artifactDeploy": {
        "build": {
          "command": "python scripts/build_comfyui_mulerouter.py",
          "sourceDir": "dist/comfyui-mulerouter",
          "versionCommand": "python scripts/read_comfyui_mulerouter_version.py"
        },
        "artifact": {
          "outputDir": "release/comfyui-mulerouter",
          "bundleName": "comfyui-mulerouter-bundle",
          "releaseName": "comfyui-mulerouter"
        },
        "remote": {
          "production": {
            "host": "gpu-prod",
            "port": 22,
            "user": "deploy",
            "baseDir": "/srv/comfyui-mulerouter"
          }
        },
        "deploy": {
          "keepReleases": 5,
          "installCommand": "python -m pip install -r requirements.txt"
        },
        "startup": {
          "mode": "systemd",
          "serviceName": "comfyui-mulerouter.service"
        },
        "verify": {
          "command": "sudo systemctl is-active --quiet comfyui-mulerouter.service",
          "healthCheck": {
            "url": "http://127.0.0.1:8188/health",
            "timeoutSeconds": 10,
            "maxWaitSeconds": 30,
            "retryIntervalSeconds": 2
          }
        }
      }
    }
  }
}
```

常用命令：

```bash
dx deploy comfyui-mulerouter --prod
dx deploy comfyui-mulerouter --build-only
dx deploy comfyui-mulerouter --prod --artifact release/comfyui-mulerouter/comfyui-mulerouter-bundle-v1.2.3-20260809-120000.tgz
```

配置约定：

- `build.sourceDir` 是构建完成后要打入 release 的目录。
- 默认按纯技术栈命令执行构建；只有显式配置 `build.app` 时才加载 dx 的应用环境层。
- 版本可来自 `artifact.version`、JSON 文件 `build.versionFile` 的 `version` 字段，或输出版本字符串的 `build.versionCommand`。
- `deploy.installCommand` 可省略；配置后在新 release 目录内执行。
- `startup.mode` 支持 `systemd` 和 `command`。`systemd` 默认执行 `sudo systemctl restart <serviceName>`；也可以用 `startup.command` 完全覆盖。
- `startup.rollbackCommand` 可覆盖回滚后的重启命令；未配置时复用正常启动命令。
- `verify.command` 会重试到成功或超过 `verify.maxWaitSeconds`（默认 24 秒）；`verify.retryIntervalSeconds` 默认 2 秒。`verify.healthCheck` 可选，用于额外执行 HTTP 探测。
- 生命周期命令可读取 `DX_RELEASE_DIR`、`DX_CURRENT_LINK`、`DX_PREVIOUS_RELEASE`、`DX_ENVIRONMENT`、`DX_SERVICE_NAME`。
- 通用 artifact target 不触发目标工程的 pnpm 依赖安装，也不套用 backend 环境变量校验。

远端目录与发布语义：

- `<baseDir>/releases/<release-name>-v<version>-<timestamp>`
- `<baseDir>/current` 原子切换到本次 release
- `<baseDir>/uploads/<bundle-file>`
- 成功后只保留最新的 `keepReleases` 个 release
- 启动或验活失败时，`current` 切回上一 release，并执行回滚启动命令

打包阶段仍会拒绝任何 `.env*` 文件进入制品，并对内层归档生成 SHA-256 校验文件。已有制品可通过 `--artifact` 直接部署；该路径不要求目标工程存在 Node/pnpm 依赖。

### backend 制品发布

当 `dx/config/commands.json` 的 `deploy.backend.internal` 配置为 `backend-artifact-deploy` 时，`dx deploy backend` 走内置的后端制品发布流程，而不是 Vercel 部署。

常用命令：

```bash
dx deploy backend --prod
dx deploy backend --build-only
dx deploy backend --prod --artifact release/backend/backend-bundle-v1.2.3-20260719-120000.tgz
dx deploy backend --prod --skip-migration
```

`--build-only` 只生成制品；`--artifact <path>` 跳过本地构建并直接部署指定制品。artifact-only 发布也会跳过目标工程依赖安装，因此两者可用于 CI 跨 job 传递同一个、已经验证过的 backend artifact。

最小示例配置：

```json
{
  "deploy": {
    "backend": {
      "internal": "backend-artifact-deploy",
      "backendDeploy": {
        "build": {
          "app": "backend",
          "distDir": "dist/backend",
          "versionFile": "apps/backend/package.json",
          "commands": {
            "development": "npx nx build backend --configuration=development",
            "staging": "npx nx build backend --configuration=production",
            "production": "npx nx build backend --configuration=production"
          }
        },
        "runtime": {
          "appPackage": "apps/backend/package.json",
          "rootPackage": "package.json",
          "lockfile": "pnpm-lock.yaml",
          "prismaSchemaDir": "apps/backend/prisma/schema",
          "prismaConfig": "apps/backend/prisma.config.ts",
          "ecosystemConfig": "ecosystem.config.cjs"
        },
        "artifact": {
          "outputDir": "release/backend",
          "bundleName": "backend-bundle"
        },
        "remote": {
          "host": "deploy.example.com",
          "port": 22,
          "user": "deploy",
          "baseDir": "/srv/example-app"
        },
        "startup": {
          "mode": "pm2",
          "serviceName": "backend"
        },
        "deploy": {
          "keepReleases": 5,
          "installCommand": "pnpm install --prod --no-frozen-lockfile --ignore-workspace",
          "prismaGenerate": true,
          "prismaMigrateDeploy": true
        },
        "verify": {
          "healthCheck": {
            "url": "http://127.0.0.1:3005/api/v1/health",
            "timeoutSeconds": 10,
            "maxWaitSeconds": 24,
            "retryIntervalSeconds": 2
          }
        }
      }
    }
  }
}
```

固定远端目录协议：

- `<baseDir>/releases/<version-name>`
- `<baseDir>/current`
- `<baseDir>/shared/.env.<environment>`
- `<baseDir>/shared/.env.<environment>.local`
- `<baseDir>/uploads/<bundle-file>`

运行时制品约束：

- 生成的 release `package.json` 默认只保留运行时依赖；如果应用把 `prisma` 放在 `devDependencies`，dx 会自动把它提升进 release 依赖，保证远端 `prisma generate` / `prisma migrate deploy` 可执行。
- 打包前会递归扫描整个 staged payload；任意层级出现 `.env*` 文件都会直接失败，避免把环境文件误打进制品。
- 所有本地路径字段都会被解析为相对项目根目录，并且必须留在项目根目录内；例如 `build.distDir`、`runtime.prismaSchemaDir`、`artifact.outputDir` 不能通过 `../` 逃逸到仓库外。
- `remote.baseDir` 必须是绝对路径，并且只能包含 `/`、字母、数字、`.`、`_`、`-`；不要使用空格或 shell 特殊字符。

部署后验活与成功摘要：

- `dx deploy backend` 在远端启动完成后，会继续校验 `current` 软链接是否切到本次 release。
- 如果 `startup.mode` 是 `pm2`，还会校验 PM2 进程是否存在，以及 PM2 中的 `APP_ENV` / `NODE_ENV` 是否与部署环境一致。
- 如果配置了 `verify.healthCheck`，dx 会在远端对健康检查地址做重试探测；适合处理不同项目启动时间不一致的问题。
- 成功后，dx 会在本地 CLI 回显一段摘要，默认包含：
  - release 版本名
  - current 当前指向的 release 目录
  - service/status
  - APP_ENV / NODE_ENV
  - health 地址

示例成功输出：

```text
✅ 后端部署成功: backend-v0.0.24-20260313-174425
🚀 [deploy-summary] current=/opt/work/noveai/releases/backend-v0.0.24-20260313-174425
🚀 [deploy-summary] service=noveai-backend status=online
🚀 [deploy-summary] APP_ENV=staging NODE_ENV=production
🚀 [deploy-summary] health=http://127.0.0.1:3005/api/v1/health
```

`verify.healthCheck` 配置说明：

- `url`：健康检查地址。未配置时，dx 会跳过 health check，但仍会执行 `current` / PM2 验活。
- `timeoutSeconds`：单次 `curl` 请求超时。
- `maxWaitSeconds`：从启动后开始，health check 最长等待多久；超过这个时间仍未成功则失败。
- `retryIntervalSeconds`：两次 health check 之间的等待间隔。

推荐配置：

```json
{
  "verify": {
    "healthCheck": {
      "url": "http://127.0.0.1:3005/api/v1/health",
      "timeoutSeconds": 10,
      "maxWaitSeconds": 24,
      "retryIntervalSeconds": 2
    }
  }
}
```

说明：

- `timeoutSeconds` 控制“单次请求能等多久”。
- `maxWaitSeconds` 控制“服务从启动到 ready 最多允许多久”。
- `retryIntervalSeconds` 越小，ready 后越快通过；越大，请求频率越低。

SSH 认证说明：

- `dx deploy backend` 当前直接调用系统 `ssh` / `scp`，不会单独解析 `sshKey`、`identityFile` 之类的 dx 配置项。
- 因此，发布使用哪把私钥，取决于本机 OpenSSH 的默认认证行为，例如 `ssh-agent`、`~/.ssh/config`、默认私钥文件等。
- 如果你已经在 `~/.ssh/config` 中配置了主机别名（例如 `Host ai-staging`），推荐直接把 `backendDeploy.remote.host` 写成这个别名，让 OpenSSH 自动匹配对应的 `HostName`、`User`、`Port`、`IdentityFile`。
- `backendDeploy.remote` 可以保持旧的单远端对象；也可以按环境拆成 `remote.staging` / `remote.production`，此时 `dx deploy backend --staging` 与 `dx deploy backend --prod` 会选择对应环境的远端。

例如本机 `~/.ssh/config`：

```sshconfig
Host ai-staging
  HostName 1.2.3.4
  User deploy
  Port 22
  IdentityFile ~/.ssh/your_staging_key
```

对应的 `dx/config/commands.json`：

```json
{
  "deploy": {
    "backend": {
      "internal": "backend-artifact-deploy",
      "backendDeploy": {
        "remote": {
          "host": "ai-staging",
          "port": 22,
          "user": "deploy",
          "baseDir": "/srv/example-app"
        }
      }
    }
  }
}
```

按环境区分远端时：

```json
{
  "deploy": {
    "backend": {
      "internal": "backend-artifact-deploy",
      "backendDeploy": {
        "remote": {
          "staging": {
            "host": "ai-staging",
            "port": 22,
            "user": "deploy",
            "baseDir": "/srv/example-app"
          },
          "production": {
            "host": "ai-ubuntu-prod",
            "port": 22,
            "user": "deploy",
            "baseDir": "/srv/example-app"
          }
        }
      }
    }
  }
}
```

注意：

- `remote.host` 写成别名后，dx 仍会显式传入 `remote.user` 和 `remote.port`；如果这两个值与 `~/.ssh/config` 中的 `User` / `Port` 不一致，命令行参数会覆盖 SSH config。
- 最稳妥的做法是让 `remote.user`、`remote.port` 与 `~/.ssh/config` 保持一致，或者都统一以 SSH config 中的值为准后再同步到 dx 配置。

## 依赖关系约定

dx 不负责管理「工程之间的构建依赖关系」。如果多个工程之间存在依赖（例如 `front/admin` 依赖 `shared` 或 `api-contracts`），必须由 Nx 的依赖图来表达并自动拉起：

- 使用 Nx 的项目依赖（基于 import graph 或 `implicitDependencies`）
- 使用 `nx.json` 的 `targetDefaults.dependsOn` / `targetDependencies`

dx 只会执行你在 `dx/config/commands.json` 中配置的命令，不会在执行过程中额外硬编码插入依赖构建。

## 给 Nx target 注入版本信息（可选）

本包提供 `dx-with-version-env`，用于在 `nx:run-commands` 中注入版本/sha/构建时间等环境变量：

```json
{
  "command": "dx-with-version-env --app front -- next build"
}
```

支持的 app：`backend` / `front` / `admin`。

## 约束与假设

当前版本面向 pnpm + nx 的 monorepo，默认假设：

- 使用 pnpm + nx
- 项目布局包含 `apps/backend`、`apps/front`、`apps/admin-front`（如有差异，通过 `dx/config/commands.json` 适配）
- 版本注入脚本 `dx-with-version-env` 默认支持 app: `backend` / `front` / `admin`

## 发布到 npm（准备工作）

如果你准备公开发布：

1. 注意：npm 上的包名 `dx` 很可能已被占用；更稳妥的是使用 scope（例如 `@ranger1/dx`）。
2. 发布前需要把 `package.json` 里的 `private: true` 去掉，并补全 `version` / `license` / `repository` 等字段。
3. 发布命令（公开包）：

```bash
npm publish --access public --registry=https://registry.npmjs.org
```
