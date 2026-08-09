# dx Example

这个目录是一份“可读、可抄、可改”的 `dx` 接入示例。

它的目的不是展示所有能力，而是告诉同事：

- `dx/config/*` 现在应该怎么写
- 新项目接入时，最小需要改哪些地方
- 当前 `dx` 只认什么规范，不再兼容什么旧写法

## 这份 Example 的定位

- 这是示例配置，不是完整业务项目。
- 它展示的是当前推荐的 `dx` 配置结构。
- 它只保留新规范，不保留任何旧兼容写法。

这里采用的规范是：

- 环境键只使用：
  - `development`
  - `staging`
  - `production`
  - `test`
  - `e2e`
- CLI 环境标志只使用：
  - `--dev`
  - `--staging`
  - `--prod`
  - `--test`
  - `--e2e`

不再建议也不再接受：

- `dev` / `prod` 作为配置节点名
- `--development` / `--production` / `--stage`
- 任何自动回退到旧配置的行为

如果配置不符合规范，`dx` 应该直接报错，而不是帮你兼容。

## 目录结构

```text
example/
  README.md
  dx/
    config/
      commands.json
      env-layers.json
      env-policy.jsonc
      env-profiles.json
```

这三份配置分别负责：

- [commands.json](/Users/a1/work/dx/example/dx/config/commands.json)
  命令树、执行方式、帮助信息
- [env-layers.json](/Users/a1/work/dx/example/dx/config/env-layers.json)
  每个环境加载哪些 `.env` 文件
- [env-policy.jsonc](/Users/a1/work/dx/example/dx/config/env-policy.jsonc)
  环境变量布局、机密约束、required 校验
- [env-profiles.json](/Users/a1/work/dx/example/dx/config/env-profiles.json)
  可选声明多品牌私有环境 profile；存在时启用 `dx env status|validate|exec`

## 最快体验方式

在仓库根目录执行：

```bash
node ./bin/dx.js --config-dir ./example/dx/config --help
node ./bin/dx.js --config-dir ./example/dx/config help start
node ./bin/dx.js --config-dir ./example/dx/config help build
```

如果只是想理解配置结构，优先看帮助输出，不需要真的去跑业务命令。

## `commands.json` 怎么理解

[commands.json](/Users/a1/work/dx/example/dx/config/commands.json) 是最核心的文件。

它同时承载两类内容：

1. 命令执行配置
2. 帮助输出配置

### 1. 命令执行配置

例如：

```json
{
  "start": {
    "backend": {
      "command": "npx nx dev backend",
      "app": "backend"
    }
  },
  "build": {
    "backend": {
      "development": {
        "command": "npx nx build backend --configuration=development",
        "app": "backend"
      },
      "production": {
        "command": "npx nx build backend --configuration=production",
        "app": "backend"
      }
    }
  }
}
```

这表示：

- `dx start backend --dev` 执行 `start.backend`
- `dx build backend --dev` 执行 `build.backend.development`
- `dx build backend --prod` 执行 `build.backend.production`

测试命令有一层内置参数补齐：`dx test unit ...` 默认追加 `--maxWorkers=8`，`dx test e2e ...` 默认追加 `--workers=8`。如果 `commands.json` 或 `--` 透传参数已经指定了对应 worker 参数，dx 会保留显式配置，不再重复追加。unit 命令检测到 Jest `--runInBand` 时，也不会再追加 `--maxWorkers=8`，避免互斥参数冲突。

测试命令还会自动选择环境：`dx test unit ...` 使用 `--test`，`dx test e2e ...` 使用 `--e2e`。如果 E2E target 配了 `requiresPath: true`，调用时必须提供文件或目录路径，不能用 `all` 跑全量。

### 2. 帮助输出配置

例如：

```json
{
  "help": {
    "summary": "统一开发环境管理工具",
    "commands": {
      "start": {
        "summary": "启动/桥接服务"
      }
    }
  }
}
```

这表示：

- `dx --help`
- `dx help start`

不再由代码里的硬编码长文案生成，而是从配置动态渲染。

## `commands.json` 的关键规则

### 1. 环境分支必须写完整名

要写：

```json
"development": { ... }
"staging": { ... }
"production": { ... }
```

不要写：

```json
"dev": { ... }
"prod": { ... }
```

### 2. 命令行入口统一用短标志

命令行里统一写：

```bash
dx start backend --dev
dx build backend --dev
dx build backend --prod
dx deploy backend --staging
dx db migrate --dev --name init-user-table
dx db script fix-user-data --dev -- --dry-run
dx test unit backend apps/backend/src/app.service.spec.ts
dx test e2e backend apps/backend/e2e/health
```

通用选项里，`-Y` / `--yes` 用于跳过危险操作确认，`-v` / `--verbose` 用于给支持的 Nx 命令追加详细输出，`-V` / `--version` 输出 dx 版本号。只有裸 `dx -v` 会按常见 CLI 习惯输出版本号。

### 3. 默认开发套件必须显式写在 `start.development`

这份 example 里保留了：

```json
"start": {
  "development": {
    "concurrent": true,
    "commands": [
      "start.backend",
      "start.front"
    ]
  }
}
```

这样：

- `dx start`
- `dx start --dev`

都会明确落到默认开发套件，而不是依赖任何旧兼容入口。

### 4. `stack` 只支持 `dx start stack`

这份 example 里演示的是：

```bash
dx start stack
```

不再依赖任何 `dx start stack front` / `stack admin` 这类兼容写法。

### 5. 帮助示例必须与真实命令树一致

帮助里写出来的示例，必须是当前配置真能支撑的命令。

不要写：

- 配置里没有的 target
- 旧规范标志
- 已删除的兼容入口

### 6. 后端制品部署使用内置 runner

这份 example 里的 `deploy.backend` 演示了内置后端制品部署：

配置要点是 `internal: "backend-artifact-deploy"`。

```json
{
  "deploy": {
    "backend": {
      "internal": "backend-artifact-deploy"
    }
  }
}
```

常用命令：

```bash
dx deploy backend --prod
dx deploy backend --build-only
dx deploy backend --prod --artifact release/backend/backend-bundle-v1.2.3-20260719-120000.tgz
dx deploy backend --prod --skip-migration
```

配置 `backendDeploy` 时要注意：

- 所有本地路径字段都会先约束在项目根目录内，不能通过 `../` 指到项目外。
- `remote.baseDir` 必须使用绝对路径，并且只能包含 `/`、字母、数字、`.`、`_`、`-`。

### 7. 非 Node 制品使用通用 artifact runner

Python、Go 或其他由 systemd/自定义命令托管的服务使用 `internal: "artifact-deploy"`。它复用 `releases/`、`current`、`uploads/`、`keepReleases` 和失败回滚语义，但不会在远端检查 Node、pnpm 或 dotenv。

最小结构：

```json
{
  "deploy": {
    "worker": {
      "internal": "artifact-deploy",
      "artifactDeploy": {
        "build": {
          "command": "python scripts/build_worker.py",
          "sourceDir": "dist/worker",
          "versionCommand": "python scripts/read_worker_version.py"
        },
        "artifact": {
          "outputDir": "release/worker",
          "bundleName": "worker-bundle"
        },
        "remote": {
          "host": "worker-host",
          "user": "deploy",
          "baseDir": "/srv/worker"
        },
        "startup": {
          "mode": "systemd",
          "serviceName": "worker.service"
        },
        "deploy": {
          "keepReleases": 5,
          "installCommand": "python -m pip install -r requirements.txt"
        },
        "verify": {
          "command": "sudo systemctl is-active --quiet worker.service"
        }
      }
    }
  }
}
```

## `env-layers.json` 怎么理解

[env-layers.json](/Users/a1/work/dx/example/dx/config/env-layers.json) 只负责一件事：
每个环境加载哪些 `.env` 文件。

当前 example 是：

```json
{
  "development": [".env.development", ".env.development.local"],
  "staging": [".env.staging", ".env.staging.local"],
  "production": [".env.production", ".env.production.local"],
  "test": [".env.test", ".env.test.local"],
  "e2e": [".env.e2e", ".env.e2e.local"]
}
```

含义很简单：

- committed 文件放默认值/占位值
- `.local` 文件放本机真实值

## `env-policy.jsonc` 怎么理解

[env-policy.jsonc](/Users/a1/work/dx/example/dx/config/env-policy.jsonc) 负责环境变量治理。

重点看这几块：

- `environments`
- `keys.secret`
- `appToTarget`
- `targets.*.required`

它回答的是：

1. 这个项目有哪些环境
2. 哪些变量是机密
3. 哪些变量在哪些环境必须存在
4. `commands.json` 里的 `app` 应该映射到哪个 target

## 常见接入方式

如果同事要把这份 example 拿去改成自己项目的 `dx/config`，一般按这个顺序做：

1. 先改 [commands.json](/Users/a1/work/dx/example/dx/config/commands.json)
   把 app 名称、Nx target、启动/构建/部署命令改成项目自己的

2. 再改 [env-policy.jsonc](/Users/a1/work/dx/example/dx/config/env-policy.jsonc)
   把 `appToTarget`、`targets`、`required` 改成项目自己的变量规则

3. 最后改 [env-layers.json](/Users/a1/work/dx/example/dx/config/env-layers.json)
   如果项目的 `.env` 组织方式和 example 不同，再调整层级

## 新增配置时怎么做

### 新增一个命令 target

例如新增 `build.worker`：

1. 在 `commands.json` 中找到 `build`
2. 新增 `worker`
3. 明确写 `development` / `production` 分支
4. 如果要展示帮助，再补 `help.commands.build` 或后续 `help.targets.build.worker`

### 新增一个环境变量

1. 先判断它属于哪个 target
2. 更新 `env-policy.jsonc` 的 `targets.<target>.required`
3. 如果它是机密，再加到 `keys.secret`

### 新增一个帮助示例

直接改 [commands.json](/Users/a1/work/dx/example/dx/config/commands.json) 的 `help` 区域，不要去改 CLI 代码。

## 给同事的结论

如果你要把 `dx` 接到新项目里，直接照着这份 example 配：

- 命令树看 [commands.json](/Users/a1/work/dx/example/dx/config/commands.json)
- 环境层看 [env-layers.json](/Users/a1/work/dx/example/dx/config/env-layers.json)
- 环境变量治理看 [env-policy.jsonc](/Users/a1/work/dx/example/dx/config/env-policy.jsonc)

不要再引入任何旧兼容写法。

项目需要什么，就把配置写清楚；写错了就让 `dx` 直接报错，然后改配置。
