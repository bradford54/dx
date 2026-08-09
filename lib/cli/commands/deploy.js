import { logger } from '../../logger.js'
import { envManager } from '../../env.js'
import { validateEnvironment } from '../../validate-env.js'

export function mergeLayeredDeployEnv(layeredEnv, manager, runtimeEnv = process.env) {
  const vercelCriticalKeys = new Set([
    'VERCEL_TOKEN',
    'VERCEL_ORG_ID',
    'VERCEL_PROJECT_ID_FRONT',
    'VERCEL_PROJECT_ID_ADMIN',
    'VERCEL_PROJECT_ID_MERCHANT',
    'VERCEL_PROJECT_ID_TELEGRAM_BOT',
  ])

  for (const [key, value] of Object.entries(layeredEnv)) {
    if (vercelCriticalKeys.has(key)) {
      const currentValue = runtimeEnv[key]
      const currentUsable =
        currentValue !== undefined && currentValue !== null && !manager.isPlaceholderEnvValue(currentValue)
      const incomingIsPlaceholder = manager.isPlaceholderEnvValue(value)

      // 保留外部显式注入的真实凭据，避免被 .env.<env> 的占位符回退污染。
      if (currentUsable && incomingIsPlaceholder) continue

      runtimeEnv[key] = value
      continue
    }

    const currentValue = runtimeEnv[key]
    if (!currentValue || manager.isPlaceholderEnvValue(currentValue)) {
      runtimeEnv[key] = value
    }
  }
}

export function parseTelegramWebhookFlags(argv = []) {
  const args = Array.isArray(argv) ? argv : []

  const idx = args.indexOf('--webhook-path')
  const webhookPath = idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined

  const dryRun = args.includes('--webhook-dry-run') ? true : undefined

  // 默认值由下游决定（当前为默认严格），这里仅处理显式覆盖
  const strict = args.includes('--strict-webhook')
    ? true
    : args.includes('--no-strict-webhook')
      ? false
      : undefined

  return {
    webhookPath,
    dryRun,
    strict,
  }
}

export async function handleDeploy(cli, args) {
  const target = args[0]
  const deployTargets = Object.keys(cli.commands.deploy || {})
  if (!target) {
    logger.error(
      deployTargets.length > 0
        ? `请指定部署目标: ${deployTargets.join(', ')}`
        : '请指定部署目标',
    )
    logger.info(`用法: ${cli.invocation} deploy <target> [环境标志]`)
    logger.info(`示例: ${cli.invocation} deploy front --staging`)
    process.exitCode = 1
    return
  }

  const normalizedTarget = String(target).toLowerCase()
  if (!cli.commands.deploy?.[normalizedTarget]) {
    logger.error(`未找到部署目标: ${target}`)
    if (deployTargets.length > 0) {
      logger.info(`可用目标: ${deployTargets.join(', ')}`)
    }
    logger.info(`用法: ${cli.invocation} deploy <target> [环境标志]`)
    process.exitCode = 1
    return
  }

  if (cli.flags.test || cli.flags.e2e) {
    logger.error('deploy 命令仅支持 --dev/--staging/--prod 环境标志')
    process.exitCode = 1
    return
  }

  const selectedEnvs = []
  if (cli.flags.dev) selectedEnvs.push('development')
  if (cli.flags.staging) selectedEnvs.push('staging')
  if (cli.flags.prod) selectedEnvs.push('production')

  if (selectedEnvs.length > 1) {
    logger.error('deploy 命令不支持同时传入多个环境标志')
    logger.info('请使用 --dev、--staging 或 --prod 中的一个')
    process.exitCode = 1
    return
  }

  const targetConfig = cli.commands.deploy?.[normalizedTarget]
  const artifactInternal = targetConfig?.internal
  const isBackendArtifactDeploy = artifactInternal === 'backend-artifact-deploy'
  const isGenericArtifactDeploy = artifactInternal === 'artifact-deploy'
  const isArtifactDeploy = isBackendArtifactDeploy || isGenericArtifactDeploy
  const environment = selectedEnvs[0] || (isArtifactDeploy ? 'development' : 'staging')

  if (isBackendArtifactDeploy) {
    const { runBackendArtifactDeploy } = await import('../../backend-artifact-deploy.js')
    await runBackendArtifactDeploy({
      cli,
      target: normalizedTarget,
      args,
      environment,
    })
    return
  }

  if (isGenericArtifactDeploy) {
    const { runArtifactDeploy } = await import('../../artifact-deploy.js')
    await runArtifactDeploy({
      cli,
      target: normalizedTarget,
      args,
      environment,
    })
    return
  }

  cli.ensureRepoRoot()

  // 只执行基础环境校验（检查 .env 文件结构），跳过后端环境变量校验
  // Vercel 部署所需的环境变量由 vercel-deploy.js 自行校验
  try {
    validateEnvironment()
  } catch (error) {
    logger.error(error.message)
    process.exitCode = 1
    return
  }

  // 加载环境变量层，但不校验后端必需变量
  const layeredEnv = envManager.collectEnvFromLayers(null, environment)
  if (envManager.latestEnvWarnings && envManager.latestEnvWarnings.length > 0) {
    envManager.latestEnvWarnings.forEach(message => {
      logger.warn(message)
    })
  }

  // 默认仅在缺失/占位时覆盖；Vercel 关键变量额外避免“真实值被占位符覆盖”的回退污染。
  mergeLayeredDeployEnv(layeredEnv, envManager, process.env)
  envManager.syncEnvironments(environment)

  const { deployToVercel } = await import('../../vercel-deploy.js')

  if (normalizedTarget === 'front') {
    process.env.FRONT_I18N_PROFILE = cli.flags.BR ? 'br' : 'default'
  }

  const telegramWebhook = normalizedTarget === 'telegram-bot'
    ? parseTelegramWebhookFlags(cli.args)
    : null

  const strictContext = process.env.DX_VERCEL_STRICT_CONTEXT != null
    ? !['0', 'false', 'no'].includes(String(process.env.DX_VERCEL_STRICT_CONTEXT).toLowerCase())
    : true

  await deployToVercel(normalizedTarget, {
    environment,
    telegramWebhook,
    strictContext,
    targetConfig: targetConfig?.vercel,
  })
}
