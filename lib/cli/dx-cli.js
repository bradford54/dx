import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { logger } from '../logger.js'
import { envManager } from '../env.js'
import { execManager } from '../exec.js'
import { validateEnvironment } from '../validate-env.js'
import {
  loadEnvPolicy,
  resolvePolicyTargetId,
  resolveTargetRequiredVars,
} from '../env-policy.js'
import { FLAG_DEFINITIONS, parseFlags } from './flags.js'
import { getCleanArgs, getCleanArgsWithConsumedValues } from './args.js'
import { showHelp, showCommandHelp } from './help.js'
import { buildStrictHelpValidationContext, validateHelpConfig } from './help-schema.js'
import { appendNxVerboseFlag } from './nx-command.js'
import { getPackageVersion } from '../version.js'
import { confirmManager } from '../confirm.js'
import {
  handleHelp,
  handleBuild,
  handleTest,
  handleLint,
  handleClean,
  handleCache,
  handleInstall,
  handleStatus,
} from './commands/core.js'
import { handleStart } from './commands/start.js'
import { handleDeploy } from './commands/deploy.js'
import { handleDatabase } from './commands/db.js'
import { handleWorktree } from './commands/worktree.js'
import { handlePackage } from './commands/package.js'
import { handleExport } from './commands/export.js'
import { handleContracts } from './commands/contracts.js'
import { handleRelease } from './commands/release.js'
import { handleEnv } from './commands/env.js'
import { COMMAND_NOT_HANDLED } from './command-result.js'

class DxCli {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.env.DX_PROJECT_ROOT || process.cwd()
    this.configDir = options.configDir || process.env.DX_CONFIG_DIR || join(this.projectRoot, 'dx', 'config')
    this.invocation = options.invocation || 'dx'

    this.commands = this.loadCommands()

    this.args = process.argv.slice(2)
    this.flags = parseFlags(this.args)
    this.command = this.args[0]
    this.subcommand = this.args[1]
    this.environment = this.args[2]
    this.worktreeManager = null
    this.envCache = null
    this.commandHandlers = {
      help: args => handleHelp(this, args),
      start: args => handleStart(this, args),
      build: args => handleBuild(this, args),
      test: args => handleTest(this, args),
      lint: args => handleLint(this, args),
      clean: args => handleClean(this, args),
      cache: args => handleCache(this, args),
      install: args => handleInstall(this, args),
      status: args => handleStatus(this, args),
      deploy: args => handleDeploy(this, args),
      db: args => handleDatabase(this, args),
      worktree: args => handleWorktree(this, args),
      package: args => handlePackage(this, args),
      export: args => handleExport(this, args),
      contracts: args => handleContracts(this, args),
      release: args => handleRelease(this, args),
    }
    if (this.hasEnvProfileConfig()) {
      this.commandHandlers.env = args => handleEnv(this, args)
    }
    this.registerConfiguredCommandHandlers()

    this.flagDefinitions = FLAG_DEFINITIONS
    this.validateLoadedHelpConfig()
  }

  // 加载命令配置
  loadCommands() {
    try {
      const configPath = join(this.configDir, 'commands.json')
      return JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (error) {
      logger.error(`无法加载命令配置文件: ${join(this.configDir, 'commands.json')}`)
      logger.error(error?.message || String(error))
      process.exit(1)
    }
  }

  validateLoadedHelpConfig() {
    validateHelpConfig(this.commands, buildStrictHelpValidationContext(this))
  }

  // 检测并安装依赖
  async ensureDependencies() {
    const nodeModulesPath = join(process.cwd(), 'node_modules')

    // 检查 node_modules 是否存在且包含关键依赖
    if (!existsSync(nodeModulesPath) || !existsSync(join(nodeModulesPath, '.pnpm'))) {
      logger.warn('检测到依赖未安装，正在自动安装...')
      logger.info('将以 NODE_ENV=development 安装完整依赖（含 devDependencies）')
      try {
        execSync('pnpm install --frozen-lockfile', {
          stdio: 'inherit',
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: 'development', // 确保安装完整依赖（含 devDependencies）
          },
        })
        logger.success('依赖安装完成')
      } catch (error) {
        logger.error('依赖安装失败，请手动执行: pnpm install')
        process.exit(1)
      }
    }
  }

  requiresProjectDependencies() {
    if (this.command !== 'deploy') return true
    const targetConfig = this.commands?.deploy?.[this.subcommand]
    if (targetConfig?.internal === 'artifact-deploy') return false
    if (!this.flags.artifact) return true
    return targetConfig?.internal !== 'backend-artifact-deploy'
  }

  // 每次启动时执行的检查流程
  async runStartupChecks() {
    // 0. 跳过 db 命令的启动检查
    // 原因：ensurePrismaClient() 会调用 `dx db generate`，如果不跳过会导致无限递归
    // db 命令本身不需要 Prisma Client 或环境变量验证即可执行
    if (this.command === 'db') return
    // 通用 artifact target 的构建与部署生命周期完全由自身命令定义，
    // 不应隐式安装 pnpm 依赖、生成 Prisma Client 或校验 backend 环境。
    if (
      this.command === 'deploy'
      && this.commands?.deploy?.[this.subcommand]?.internal === 'artifact-deploy'
    ) return

    // 1. 在 worktree 中自动同步根目录的 .env.*.local 文件
    try {
      const worktreeManager = await this.getWorktreeManager()
      worktreeManager.syncEnvFilesFromMainRoot()
    } catch (error) {
      logger.warn(`自动同步 env 文件失败: ${error.message}`)
    }

    // 2. 检测 Prisma Client 是否存在，不存在则执行 db generate
    await this.ensurePrismaClient()

    // 3. 验证环境变量（尊重多种跳过机制）
    // 跳过条件：
    // - 命令配置了 skipEnvValidation: true（如 lint）
    // - 子命令配置了 skipEnvValidation: true（如 build.shared）
    // - 用户指定了 --no-env-check 标志
    // - 环境变量 AI_SKIP_ENV_CHECK=true（CI 场景）
    // - CI 环境（CI=1）- 由 exec.js 中的 executeCommand 进行精细检查
    // - Vercel 构建环境（VERCEL=1）
    const commandConfig = this.getCommandConfig(this.command)
    const subcommandConfig = this.subcommand ? commandConfig?.[this.subcommand] : null
    const isVercelEnv = String(process.env.VERCEL || '').toLowerCase() === '1'
    // 兼容 GitHub Actions (CI=true) 和其他 CI 系统 (CI=1)
    const isCIEnv = ['true', '1'].includes(String(process.env.CI || '').toLowerCase())
    const skipEnvValidation =
      commandConfig?.skipEnvValidation ||
      subcommandConfig?.skipEnvValidation ||
      this.flags.noEnvCheck ||
      String(process.env.AI_SKIP_ENV_CHECK || '').toLowerCase() === 'true' ||
      isCIEnv ||
      isVercelEnv

    if (!skipEnvValidation) {
      await this.validateEnvVars()
    }
  }

  // 获取命令配置
  getCommandConfig(command) {
    return this.commands[command]
  }

  hasEnvProfileConfig() {
    return existsSync(join(this.configDir, 'env-profiles.json'))
  }

  registerConfiguredCommandHandlers() {
    for (const [commandName, config] of Object.entries(this.commands || {})) {
      if (commandName === 'help') continue
      if (this.commandHandlers[commandName]) continue
      if (!this.isExecutableConfigTree(config)) continue

      this.commandHandlers[commandName] = args => this.handleConfiguredCommand(commandName, args)
    }
  }

  isExecutableConfigTree(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    if (node.command || node.internal || node.concurrent || node.sequential) return true

    return Object.entries(node).some(([key, value]) => {
      if (key === 'help' || key === 'description' || key === 'args') return false
      if (key === 'app' || key === 'ports' || key === 'dangerous') return false
      return this.isExecutableConfigTree(value)
    })
  }

  async handleConfiguredCommand(commandName, args = []) {
    const environment = this.determineEnvironment()
    const config = this.resolveConfiguredCommand(commandName, args, environment)

    if (!config) {
      const path = [commandName, ...args].join('.')
      logger.error(`未找到命令配置: ${path}`)
      process.exitCode = 1
      return
    }

    if (config.dangerous) {
      const operation = config.description || [commandName, ...args].join(' ')
      const confirmed = await confirmManager.confirmDangerous(operation, environment, this.flags.Y)
      if (!confirmed) {
        logger.warn('操作已取消')
        return
      }
    }

    if (config.concurrent && Array.isArray(config.commands)) {
      await this.handleConcurrentCommands(config.commands, null, environment)
    } else if (config.sequential && Array.isArray(config.commands)) {
      await this.handleSequentialCommands(config.commands, environment)
    } else {
      await this.executeCommand(config)
    }
  }

  resolveConfiguredCommand(commandName, args = [], environment) {
    let config = this.commands?.[commandName]
    if (!config) return null

    for (const arg of args) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) return null
      config = config[arg]
      if (!config) return null
    }

    if (environment && config && typeof config === 'object' && !Array.isArray(config)) {
      const envKey = this.normalizeEnvKey(environment)
      if (config[envKey]) config = config[envKey]
    }

    return config
  }

  // 检测并生成 Prisma Client
  async ensurePrismaClient() {
    // 仅对真正安装了 @prisma/client 的项目执行检查。
    // 依据「node_modules/@prisma/client/package.json 是否存在」判断项目是否使用 Prisma，
    // 避免在纯文档站、纯前端等未引入 Prisma 的项目上误触发生成流程，
    // 进而报出形如「未找到 db.generate 命令配置」的误导性错误。
    const prismaClientDir = join(process.cwd(), 'node_modules', '@prisma', 'client')
    if (!existsSync(join(prismaClientDir, 'package.json'))) {
      return
    }

    // pnpm 结构下检测 @prisma/client 生成的 default.js 文件
    const prismaClientPath = join(prismaClientDir, 'default.js')

    if (!existsSync(prismaClientPath)) {
      const environment = this.determineEnvironment()
      logger.step('检测到 Prisma Client 未生成，正在生成...')
      try {
        const generateConfig = this.commands?.db?.generate
        if (!generateConfig?.command) {
          throw new Error('未找到 db.generate 命令配置，请检查 dx/config/commands.json')
        }

        await execManager.executeCommand(generateConfig.command, {
          app: generateConfig.app || 'backend',
          flags: this.createExecutionFlags(environment),
          // Prisma generate 不应卡在环境变量校验上
          skipEnvValidation: true,
        })
        logger.success('Prisma Client 生成完成')
      } catch (error) {
        logger.error('Prisma Client 生成失败')
        logger.error(error?.message || String(error))
        process.exit(1)
      }
    }
  }

  // 验证环境变量
  async validateEnvVars() {
    const environment = this.determineEnvironment()

    if (this.envCache?.environment === environment) {
      return this.envCache.layeredEnv
    }

    try {
      validateEnvironment()

      const layeredEnv = envManager.collectEnvFromLayers('backend', environment)
      if (envManager.latestEnvWarnings && envManager.latestEnvWarnings.length > 0) {
        envManager.latestEnvWarnings.forEach(message => {
          logger.warn(message)
        })
      }

      // CI 环境跳过后端环境变量校验（CI 中 build backend 只生成 OpenAPI，不需要数据库连接）
      // 非 CI 环境下，检查 backend 组的环境变量
      if (process.env.CI !== '1') {
        const effectiveEnv = { ...process.env, ...layeredEnv }
        const policy = loadEnvPolicy(envManager.configDir)
        const targetId = resolvePolicyTargetId(policy, 'backend')
        if (!targetId) {
          throw new Error('缺少 appToTarget.backend 配置（dx 内置逻辑需要 backend target）')
        }
        const requiredVars = resolveTargetRequiredVars(policy, targetId, environment)
        if (requiredVars.length > 0) {
          const { valid, missing, placeholders } = envManager.validateRequiredVars(
            requiredVars,
            effectiveEnv,
          )
          if (!valid) {
            const problems = ['环境变量校验未通过']
            if (missing.length > 0) {
              problems.push(`缺少必填环境变量: ${missing.join(', ')}`)
            }
            if (placeholders.length > 0) {
              problems.push(`以下环境变量仍为占位值或空串: ${placeholders.join(', ')}`)
            }
            if (missing.length > 0 || placeholders.length > 0) {
              problems.push(`请在 .env.${environment} / .env.${environment}.local 中补齐配置`)
            }
            throw new Error(problems.join('\n'))
          }
        }
      }

      this.envCache = { environment, layeredEnv }
      return layeredEnv
    } catch (error) {
      logger.error('环境变量验证失败')
      logger.error(error.message)
      process.exit(1)
    }
  }

  // 获取环境对应的命令行 flag
  getEnvironmentFlag(environment) {
    switch (environment) {
      case 'production':
        return '--prod'
      case 'staging':
        return '--staging'
      case 'test':
        return '--test'
      case 'e2e':
        return '--e2e'
      case 'development':
      default:
        return '--dev'
    }
  }

  // 主执行方法
  async run() {
    try {
      if (this.flags.version) {
        console.log(getPackageVersion())
        return
      }

      // 显示帮助
      if (this.flags.help || !this.command) {
        if (this.flags.help && this.command && this.command !== 'help') {
          showCommandHelp(this.command, this)
        } else {
          showHelp(this)
        }
        return
      }

      this.validateInputs()

      // Fail fast for unknown commands before dependency/env startup checks.
      if (this.command && !this.commandHandlers[this.command]) {
        logger.error(`未知命令: ${this.command}`)
        showHelp(this)
        process.exit(1)
      }

      // Commands that should work without env/dependency checks.
      // - help: printing help should never require env vars.
      // - status: should be available even when env is incomplete.
      // - release: only edits package.json versions.
      const skipStartupChecks = new Set(['help', 'status', 'release'])
      if (this.command === 'env' && this.hasEnvProfileConfig()) skipStartupChecks.add('env')
      if (skipStartupChecks.has(this.command)) {
        await this.routeCommand()
        return
      }

      // 在执行命令前先校验参数与选项
      if (this.requiresProjectDependencies()) await this.ensureDependencies()
      await this.runStartupChecks()

      // 设置详细模式
      if (this.flags.verbose) {
        logger.debug('启用详细输出模式')
      }

      // 路由到对应的命令处理器
      await this.routeCommand()

    } catch (error) {
      logger.error('命令执行失败')
      logger.error(error.message)

      if (this.flags.verbose) {
        console.error(error.stack)
      }

      process.exit(1)
    }
  }

  // 命令路由
  async routeCommand() {
    const command = getCleanArgs(this.args)[0]

    const allowedFlags = this.getAllowedFlags(command)
    const consumedFlagValueIndexes = this.validateFlags(command, allowedFlags)
    const cleanArgs = getCleanArgsWithConsumedValues(this.args, consumedFlagValueIndexes)
    const [, ...subArgs] = cleanArgs

    if (!command) {
      showHelp(this)
      return
    }

    const handler = this.commandHandlers[command]
    if (!handler) return

    const result = await handler(subArgs)
    if (result === COMMAND_NOT_HANDLED) {
      if (this.isExecutableConfigTree(this.commands?.[command])) {
        await this.handleConfiguredCommand(command, subArgs)
        return
      }

      logger.error(`未找到命令: ${[command, ...subArgs].join(' ')}`)
      showCommandHelp(command, this)
      process.exitCode = 1
    }
  }

  // 校验原始输入，禁止未识别的选项或多余参数
  validateInputs() {
    const cleanArgs = getCleanArgs(this.args)
    const command = cleanArgs[0]
    const allowedFlags = this.getAllowedFlags(command)
    const consumedFlagValueIndexes = this.validateFlags(command, allowedFlags)

    // 收集所有位置参数（不含命令本身、选项及其值）
    const positionalArgs = []
    let commandConsumed = false
    let afterDoubleDash = false
    for (let i = 0; i < this.args.length; i++) {
      const token = this.args[i]
      if (token === '--') {
        afterDoubleDash = true
        continue
      }
      if (afterDoubleDash) continue
      if (token.startsWith('-')) continue
      if (consumedFlagValueIndexes.has(i)) continue

      if (!commandConsumed && command) {
        // 跳过命令本身
        commandConsumed = true
        continue
      }

      positionalArgs.push(token)
    }

    if (!command) {
      if (positionalArgs.length > 0) {
        this.reportExtraPositionals('全局', positionalArgs)
      }
      return
    }

    this.validatePositionalArgs(command, positionalArgs)
  }

  // 获取命令允许的选项
  getAllowedFlags(command) {
    const allowed = new Map()
    const applyDefs = defs => {
      defs?.forEach(({ flag, expectsValue }) => {
        if (!flag) return
        allowed.set(flag, { expectsValue: Boolean(expectsValue) })
      })
    }

    applyDefs(this.flagDefinitions._global)
    if (command && this.flagDefinitions[command]) {
      applyDefs(this.flagDefinitions[command])
    }

    return allowed
  }

  // 校验选项合法性并返回被选项消耗的参数下标集合
  validateFlags(command, allowedFlags) {
    const consumedIndexes = new Set()
    const doubleDashIndex = this.args.indexOf('--')

    for (let i = 0; i < this.args.length; i++) {
      if (doubleDashIndex !== -1 && i >= doubleDashIndex) break
      const token = this.args[i]
      if (!token.startsWith('-')) continue

      const spec = allowedFlags.get(token)
      if (!spec) {
        this.reportUnknownFlag(command, token, allowedFlags)
        process.exit(1)
      }

      if (spec.expectsValue) {
        const next = this.args[i + 1]
        if (next === undefined || next.startsWith('-')) {
          logger.error(`选项 ${token} 需要提供参数值`)
          process.exit(1)
        }
        consumedIndexes.add(i + 1)
      }
    }

    return consumedIndexes
  }

  // 根据命令定义校验位置参数
  validatePositionalArgs(command, positionalArgs) {
    const ensureMax = (max) => {
      if (positionalArgs.length > max) {
        this.reportExtraPositionals(command, positionalArgs.slice(max))
      }
    }

    switch (command) {
      case 'help':
        ensureMax(1)
        break
      case 'build': {
        this.validateBuildPositionals(positionalArgs)
        if (positionalArgs.length >= 2 && this.isEnvironmentToken(positionalArgs[1])) {
          this.reportEnvironmentFlagRequired(command, positionalArgs[1], positionalArgs)
        }
        ensureMax(1)
        break
      }
      case 'package': {
        if (positionalArgs.length >= 2 && this.isEnvironmentToken(positionalArgs[1])) {
          this.reportEnvironmentFlagRequired(command, positionalArgs[1], positionalArgs)
        }
        ensureMax(1)
        break
      }
      case 'db': {
        if (positionalArgs.length === 0) return
        const action = positionalArgs[0]
        const extras = positionalArgs.slice(1)
        const envToken = extras.find(token => this.isEnvironmentToken(token))
        if (envToken) {
          this.reportEnvironmentFlagRequired(command, envToken, positionalArgs)
        }

        if (action === 'migrate') {
          if (extras.length > 0) {
            this.reportExtraPositionals(command, extras)
          }
        } else if (action === 'deploy') {
          if (extras.length > 0) {
            this.reportExtraPositionals(command, extras)
          }
        } else if (action === 'script') {
          // script 子命令需要一个脚本名称参数
          if (extras.length > 1) {
            this.reportExtraPositionals(command, extras.slice(1))
          }
        } else if (extras.length > 0) {
          this.reportExtraPositionals(command, extras)
        }
        break
      }
      case 'test':
        this.validateTestPositionals(positionalArgs)
        if ((positionalArgs[0] || 'e2e') !== 'unit') {
          ensureMax(3)
        }
        break
      case 'worktree': {
        if (positionalArgs.length === 0) return
        const action = positionalArgs[0]
        if (action === 'del') {
          return
        }
        if (action === 'make') {
          ensureMax(3)
          break
        }
        if (action === 'list' || action === 'clean') {
          ensureMax(1)
          break
        }
        break
      }
      case 'start': {
        this.validateStartPositionals(positionalArgs)
        const extras = positionalArgs.slice(1)
        const envToken = extras.find(token => this.isEnvironmentToken(token))
        if (envToken) {
          this.reportEnvironmentFlagRequired(command, envToken, positionalArgs)
        }
        ensureMax(1)
        break
      }
      case 'lint':
        ensureMax(0)
        break
      case 'clean':
        ensureMax(1)
        break
      case 'cache':
        ensureMax(1)
        break
      case 'status':
        ensureMax(0)
        break
      default:
        // 默认放行，具体命令内部再校验
        break
    }
  }

  isEnvironmentToken(token) {
    if (!token) return false
    const value = String(token).toLowerCase()
    return (
      value === 'dev' ||
      value === 'prod' ||
      value === 'staging' ||
      value === 'test' ||
      value === 'e2e'
    )
  }

  reportEnvironmentFlagRequired(command, token, positionalArgs = []) {
    const normalizedFlag = this.getEnvironmentFlagExample(token)
    logger.error(`命令 ${command} 不再支持通过位置参数指定环境: ${token}`)
    logger.info('请使用带前缀的环境标志，例如 --dev、--staging、--prod、--test 或 --e2e。')
    const suggestion = normalizedFlag
      ? this.buildEnvironmentSuggestion(command, normalizedFlag, positionalArgs, token)
      : null
    if (suggestion) {
      logger.info(`建议命令: ${suggestion}`)
    } else if (normalizedFlag) {
      logger.info(`示例: ${this.invocation} ${command} ... ${normalizedFlag}`)
    }
    logger.info('未显式指定环境时将默认使用 --dev。')
    process.exit(1)
  }

  getEnvironmentFlagExample(token) {
    switch (String(token || '').toLowerCase()) {
      case 'dev':
      case 'development':
        return '--dev'
      case 'prod':
      case 'production':
        return '--prod'
      case 'staging':
        return '--staging'
      case 'test':
        return '--test'
      case 'e2e':
        return '--e2e'
      default:
        return null
    }
  }

  buildEnvironmentSuggestion(command, normalizedFlag, positionalArgs, token) {
    const parts = [this.invocation, command]
    const rest = Array.isArray(positionalArgs) ? [...positionalArgs] : []
    if (rest.length > 0) {
      const matchIndex = rest.findIndex(arg => String(arg).toLowerCase() === String(token).toLowerCase())
      if (matchIndex !== -1) rest.splice(matchIndex, 1)
    }
    if (!rest.includes(normalizedFlag)) {
      rest.push(normalizedFlag)
    }
    return parts.concat(rest).join(' ')
  }

  validateTestPositionals(positionalArgs) {
    const [type = 'e2e', target = 'all', testPath] = positionalArgs

    if (type !== 'e2e') return

    if (target === 'all') {
      logger.error('dx test e2e all 不受支持，请指定 target 和测试文件或目录路径')
      process.exit(1)
    }

    const testConfig = this.commands?.test?.[type]?.[target]
    if (!testConfig) return
    if (!testConfig.requiresPath) return

    if (!testPath) {
      logger.error(`dx test e2e ${target} 必须提供测试文件或目录路径`)
      logger.info(`示例: ${this.invocation} test e2e ${target} apps/${target}/e2e/health`)
      process.exit(1)
    }

    if (testPath === 'all') {
      logger.error(`dx test e2e ${target} 不支持 all，必须提供测试文件或目录路径`)
      process.exit(1)
    }
  }

  validateStartPositionals(positionalArgs) {
    const service = positionalArgs[0] || 'development'
    const environment = this.determineEnvironment()
    const envKey = this.normalizeEnvKey(environment)

    if (service === 'development' && envKey !== 'development') {
      logger.error('dx start 在未指定服务时仅允许使用开发环境')
      logger.info(`示例: ${this.invocation} start --dev`)
      logger.info(`示例: ${this.invocation} start backend --prod`)
      process.exit(1)
    }

    const startConfig = this.commands?.start?.[service]
    if (!startConfig) return

    // 对 start 下的单层 command 配置，默认视为开发态目标，仅允许 --dev。
    if (startConfig.command && envKey !== 'development') {
      logger.error(`启动目标 ${service} 仅支持开发环境`)
      logger.info(`示例: ${this.invocation} start ${service} --dev`)
      process.exit(1)
    }
  }

  validateBuildPositionals(positionalArgs) {
    const target = positionalArgs[0] || 'all'
    const environment = this.determineEnvironment()
    const envKey = this.normalizeEnvKey(environment)
    const explicitEnv = Boolean(
      this.flags.dev || this.flags.prod || this.flags.staging || this.flags.test || this.flags.e2e,
    )

    if (!explicitEnv) return

    const buildConfig = this.commands?.build?.[target]
    if (!buildConfig || buildConfig.command) return

    const supportsCurrentEnv = Boolean(buildConfig[envKey])
    if (supportsCurrentEnv) return

    const envFlag = this.getEnvironmentFlagExample(envKey) || `--${envKey}`
    logger.error(`构建目标 ${target} 不支持 ${envFlag} 环境`)
    logger.info('显式传入环境标志时，必须是该 target 实际支持的环境。')
    const available = ['development', 'staging', 'production', 'test', 'e2e']
      .filter(key => key in buildConfig)
      .map(key => this.getEnvironmentFlagExample(key) || `--${key}`)
    if (available.length > 0) {
      logger.info(`支持的环境: ${available.join(', ')}`)
      logger.info(`示例: ${this.invocation} build ${target} ${available[0]}`)
      if (available.length > 1) {
        logger.info(`示例: ${this.invocation} build ${target} ${available[1]}`)
      }
    }
    process.exit(1)
  }

  reportExtraPositionals(command, extras) {
    const list = extras.join(', ')
    if (command === '全局') {
      logger.error(`检测到未识别的参数: ${list}`)
    } else {
      logger.error(`命令 ${command} 存在未识别的额外参数: ${list}`)
    }
    const hint = command && command !== '全局' ? `${this.invocation} help ${command}` : `${this.invocation} --help`
    logger.info(`提示: 执行 ${hint} 或 ${this.invocation} --help 查看命令用法`)
    if (command && command !== '全局') {
      logger.info(`示例: ${this.invocation} ${command} --help`)
    }
    process.exit(1)
  }

  reportUnknownFlag(command, flag, allowedFlags) {
    logger.error(`检测到未识别的选项: ${flag}`)
    const supported = Array.from(allowedFlags.keys())
    if (supported.length > 0) {
      logger.info(`支持的选项: ${supported.join(', ')}`)
    } else if (command) {
      logger.info(`命令 ${command} 不接受额外选项`)
    }
    const hint = command ? `${this.invocation} help ${command}` : `${this.invocation} --help`
    logger.info(`提示: 执行 ${hint} 或 ${this.invocation} --help 查看命令用法`)
    if (command) {
      logger.info(`示例: ${this.invocation} ${command} --help`)
    }
  }

  // 校验是否在仓库根目录执行
  ensureRepoRoot() {
    const cwd = process.cwd()

    const markers = ['pnpm-workspace.yaml', 'package.json', 'apps']
    const missing = markers.filter(p => !existsSync(join(cwd, p)))
    if (missing.length) {
      logger.error(`请从仓库根目录运行此命令。缺少标识文件/目录: ${missing.join(', ')}`)
      process.exit(1)
    }

    const commandsPath = join(this.configDir, 'commands.json')
    if (!existsSync(commandsPath)) {
      logger.error(`未找到命令配置文件: ${commandsPath}`)
      process.exit(1)
    }
  }

  async getWorktreeManager() {
    if (!this.worktreeManager) {
      const { default: worktreeManager } = await import('../worktree.js')
      this.worktreeManager = worktreeManager
    }
    return this.worktreeManager
  }

  // 并发命令处理
  async handleConcurrentCommands(commandPaths, baseCommand, environment) {
    const commands = []

    for (const path of commandPaths) {
      const config = this.resolveCommandPath(
        path,
        baseCommand,
        this.normalizeEnvKey(environment)
      )
      if (!config) {
        logger.warn(`未解析到命令配置: ${path} (${environment || '-'})`)
        continue
      }
      commands.push({
        command: config.command,
        options: {
          app: config.app,
          ports: config.ports,
          flags: this.flags,
        },
      })
    }

    if (commands.length > 0) {
      await execManager.executeConcurrent(commands)
    }
  }

  // 顺序命令处理
  async handleSequentialCommands(commandPaths, environment) {
    for (const path of commandPaths) {
      const config = this.resolveCommandPath(path, null, this.normalizeEnvKey(environment))
      if (!config) {
        logger.warn(`未解析到命令配置: ${path} (${environment || '-'})`)
        continue
      }

      // 支持在顺序执行中嵌套并发/顺序配置
      if (config.concurrent && Array.isArray(config.commands)) {
        await this.handleConcurrentCommands(config.commands, null, environment)
      } else if (config.sequential && Array.isArray(config.commands)) {
        await this.handleSequentialCommands(config.commands, environment)
      } else {
        await this.executeCommand(config)
      }
    }
  }

  // 解析命令路径
  resolveCommandPath(path, baseCommand, environment) {
    const parts = path.split('.')
    let config = this.commands

    for (const part of parts) {
      config = config[part]
      if (!config) break
    }

    // 如果有环境参数，尝试获取对应环境的配置
    if (environment && config) {
      const envKey = this.normalizeEnvKey(environment)
      if (config[envKey]) config = config[envKey]
    }

    return config
  }

  collectStartPorts(service, startConfig, envKey) {
    const portSet = new Set()

    if (startConfig && Array.isArray(startConfig.ports)) {
      startConfig.ports.forEach(port => {
        this.addPortToSet(portSet, port)
      })
    }

    return Array.from(portSet)
  }

  addPortToSet(target, port) {
    const numeric = Number(port)
    if (Number.isFinite(numeric) && numeric > 0) {
      target.add(numeric)
    }
  }

  // 执行单个命令
  async executeCommand(config, overrideFlags) {
    if (!config) {
      logger.error('无效的命令配置')
      return
    }

    const withTempEnv = async fn => {
      const envPatch = config?.env && typeof config.env === 'object' ? config.env : null
      if (!envPatch) return await fn()

      const previous = {}
      for (const [key, value] of Object.entries(envPatch)) {
        previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
          ? process.env[key]
          : undefined
        process.env[key] = String(value)
      }

      try {
        return await fn()
      } finally {
        for (const [key, oldValue] of Object.entries(previous)) {
          if (oldValue === undefined) delete process.env[key]
          else process.env[key] = oldValue
        }
      }
    }

    // internal runners (for projects that only ship scripts/config)
    if (config.internal) {
      if (config.internal === 'sdk-build') {
        await withTempEnv(async () => {
          const { runSdkBuild } = await import('../sdk-build.js')
          await runSdkBuild(Array.isArray(config.args) ? config.args : [])
        })
        return
      }
      if (config.internal === 'backend-package') {
        await withTempEnv(async () => {
          const { runBackendPackage } = await import('../backend-package.js')
          await runBackendPackage(Array.isArray(config.args) ? config.args : [])
        })
        return
      }

      if (config.internal === 'start-dev') {
        await withTempEnv(async () => {
          const { runStartDev } = await import('../start-dev.js')
          await runStartDev(Array.isArray(config.args) ? config.args : [])
        })
        return
      }

      if (config.internal === 'pm2-stack') {
        await withTempEnv(async () => {
          const { runPm2Stack } = await import('./commands/stack.js')
          const stackConfig = config.stack && typeof config.stack === 'object' ? config.stack : {}
          await runPm2Stack(stackConfig)
        })
        return
      }

      throw new Error(`未知 internal runner: ${config.internal}`)
    }

    if (!config.command) {
      logger.error('无效的命令配置: 缺少 command/internal')
      return
    }

    const effectiveFlags = overrideFlags || this.flags
    let rawCommand = String(config.command).trim()
    if (effectiveFlags.verbose) {
      rawCommand = appendNxVerboseFlag(rawCommand)
    }

    const options = {
      app: config.app,
      flags: effectiveFlags,
      cwd: config.cwd,
      ports: config.ports || [],
      // 允许上游在 config.env 中注入环境变量（例如 NX_CACHE=false）
      env: config.env || {},
      skipEnvValidation: Boolean(config.skipEnvValidation),
      forcePortCleanup: Boolean(config.forcePortCleanup),
    }

    await execManager.executeCommand(rawCommand, options)
  }

  // 确定环境
  determineEnvironment() {
    return envManager.detectEnvironment(this.flags)
  }

  // 规范化环境键到命令配置使用的命名（development/staging/production/test/e2e）
  normalizeEnvKey(env) {
    switch (String(env || '').toLowerCase()) {
      case 'development':
        return 'development'
      case 'production':
        return 'production'
      case 'staging':
        return 'staging'
      case 'test':
        return 'test'
      case 'e2e':
        return 'e2e'
      default:
        return env
    }
  }

  createExecutionFlags(environment) {
    const envKey = this.normalizeEnvKey(environment)
    const execFlags = { ...this.flags }

    ;['dev', 'prod', 'staging', 'test', 'e2e'].forEach(key => {
      delete execFlags[key]
    })

    if (envKey === 'production') execFlags.prod = true
    else if (envKey === 'development') execFlags.dev = true
    else if (envKey === 'test') execFlags.test = true
    else if (envKey === 'e2e') execFlags.e2e = true
    else if (envKey === 'staging') execFlags.staging = true

    return execFlags
  }

}

export { DxCli }
