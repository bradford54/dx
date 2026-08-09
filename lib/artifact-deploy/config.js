import { isAbsolute } from 'node:path'
import { resolveWithinBase } from '../backend-artifact-deploy/path-utils.js'

function requireString(value, fieldPath) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少必填配置: ${fieldPath}`)
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requireSafeName(value, fieldPath) {
  const name = requireString(value, fieldPath)
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
    throw new Error(`${fieldPath} 包含非法字符: ${name}`)
  }
  return name
}

function requirePositiveInteger(value, fieldPath) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`缺少必填配置: ${fieldPath}`)
  }
  return parsed
}

function resolveProjectPath(projectRoot, value, fieldPath) {
  return resolveWithinBase(projectRoot, requireString(value, fieldPath), fieldPath)
}

function requireRemoteBaseDir(value, fieldPath) {
  const baseDir = requireString(value, fieldPath)
  if (!isAbsolute(baseDir)) throw new Error(`${fieldPath} 必须是绝对路径: ${baseDir}`)
  if (!/^\/[A-Za-z0-9._/-]*$/.test(baseDir)) {
    throw new Error(`${fieldPath} 包含非法字符: ${baseDir}`)
  }
  return baseDir.replace(/\/+$/, '') || '/'
}

function resolveRemoteConfig(remoteConfig, environment) {
  if (!remoteConfig || typeof remoteConfig !== 'object') return null
  if (typeof remoteConfig.host === 'string') return remoteConfig

  const selected = remoteConfig[environment]
  if (!selected || typeof selected !== 'object') {
    throw new Error(`缺少必填配置: remote.${environment}`)
  }
  return selected
}

function resolveBuildCommand(buildConfig, environment) {
  if (buildConfig?.commands && typeof buildConfig.commands === 'object') {
    return requireString(buildConfig.commands[environment], `build.commands.${environment}`)
  }
  return requireString(buildConfig?.command, 'build.command')
}

function resolveHealthCheck(healthCheckConfig) {
  if (healthCheckConfig == null) return null
  const url = requireString(healthCheckConfig.url, 'verify.healthCheck.url')
  try {
    new URL(url)
  } catch {
    throw new Error('缺少必填配置: verify.healthCheck.url')
  }

  return {
    url,
    timeoutSeconds: healthCheckConfig.timeoutSeconds == null
      ? 10
      : requirePositiveInteger(healthCheckConfig.timeoutSeconds, 'verify.healthCheck.timeoutSeconds'),
    maxWaitSeconds: healthCheckConfig.maxWaitSeconds == null
      ? 24
      : requirePositiveInteger(healthCheckConfig.maxWaitSeconds, 'verify.healthCheck.maxWaitSeconds'),
    retryIntervalSeconds: healthCheckConfig.retryIntervalSeconds == null
      ? 2
      : requirePositiveInteger(
          healthCheckConfig.retryIntervalSeconds,
          'verify.healthCheck.retryIntervalSeconds',
        ),
  }
}

export function resolveArtifactDeployConfig({ cli, target, targetConfig, environment, flags = {} }) {
  const deployConfig = targetConfig?.artifactDeploy
  if (!deployConfig || typeof deployConfig !== 'object') {
    throw new Error('缺少必填配置: artifactDeploy')
  }

  const buildConfig = deployConfig.build || {}
  const artifactConfig = deployConfig.artifact || {}
  const startupConfig = deployConfig.startup || {}
  const runConfig = deployConfig.deploy || {}
  const verifyConfig = deployConfig.verify || {}
  const buildOnly = Boolean(flags.buildOnly)
  const remoteConfig = resolveRemoteConfig(deployConfig.remote, environment)
  const startupMode = optionalString(startupConfig.mode) || 'command'

  if (!['systemd', 'command'].includes(startupMode)) {
    throw new Error('startup.mode 仅支持 systemd 或 command')
  }

  const versionFile = optionalString(buildConfig.versionFile)
  const versionCommand = optionalString(buildConfig.versionCommand)
  const version = optionalString(artifactConfig.version)
  if (!versionFile && !versionCommand && !version) {
    throw new Error('缺少必填配置: build.versionFile、build.versionCommand 或 artifact.version')
  }

  const serviceName = optionalString(startupConfig.serviceName)
  const startupCommand = optionalString(startupConfig.command)
  if (serviceName && !/^[A-Za-z0-9_.@-]+$/.test(serviceName)) {
    throw new Error(`startup.serviceName 包含非法字符: ${serviceName}`)
  }
  if (startupMode === 'systemd' && !serviceName) {
    throw new Error('缺少必填配置: startup.serviceName')
  }
  if (startupMode === 'command' && !startupCommand) {
    throw new Error('缺少必填配置: startup.command')
  }
  const healthCheck = resolveHealthCheck(verifyConfig.healthCheck)

  return {
    projectRoot: cli.projectRoot,
    target,
    environment,
    build: {
      app: optionalString(buildConfig.app),
      command: resolveBuildCommand(buildConfig, environment),
      sourceDir: resolveProjectPath(cli.projectRoot, buildConfig.sourceDir, 'build.sourceDir'),
      versionFile: versionFile
        ? resolveProjectPath(cli.projectRoot, versionFile, 'build.versionFile')
        : null,
      versionCommand,
    },
    artifact: {
      outputDir: resolveProjectPath(cli.projectRoot, artifactConfig.outputDir, 'artifact.outputDir'),
      bundleName: requireSafeName(artifactConfig.bundleName, 'artifact.bundleName'),
      releaseName: requireSafeName(
        optionalString(artifactConfig.releaseName) || String(target),
        'artifact.releaseName',
      ),
      version,
    },
    remote: buildOnly
      ? null
      : {
          host: requireString(remoteConfig?.host, 'remote.host'),
          port: remoteConfig?.port == null ? 22 : requirePositiveInteger(remoteConfig.port, 'remote.port'),
          user: requireString(remoteConfig?.user, 'remote.user'),
          baseDir: requireRemoteBaseDir(remoteConfig?.baseDir, 'remote.baseDir'),
        },
    startup: {
      mode: startupMode,
      serviceName,
      command: startupCommand,
      rollbackCommand: optionalString(startupConfig.rollbackCommand),
    },
    deploy: {
      keepReleases: runConfig.keepReleases == null
        ? 5
        : requirePositiveInteger(runConfig.keepReleases, 'deploy.keepReleases'),
      installCommand: optionalString(runConfig.installCommand),
    },
    verify: {
      command: optionalString(verifyConfig.command),
      maxWaitSeconds: verifyConfig.maxWaitSeconds == null
        ? healthCheck?.maxWaitSeconds || 24
        : requirePositiveInteger(verifyConfig.maxWaitSeconds, 'verify.maxWaitSeconds'),
      retryIntervalSeconds: verifyConfig.retryIntervalSeconds == null
        ? healthCheck?.retryIntervalSeconds || 2
        : requirePositiveInteger(verifyConfig.retryIntervalSeconds, 'verify.retryIntervalSeconds'),
      healthCheck,
    },
  }
}
