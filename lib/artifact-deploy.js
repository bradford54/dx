import { access } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { buildArtifact } from './artifact-deploy/artifact-builder.js'
import { resolveArtifactDeployConfig } from './artifact-deploy/config.js'
import { deployArtifactRemotely } from './artifact-deploy/remote-transport.js'
import { logger as defaultLogger } from './logger.js'

export async function loadArtifact(config, artifactPath, deps = {}) {
  const ensureReadable = deps.ensureArtifactReadable || access
  const bundlePath = resolve(config.projectRoot, artifactPath)
  await ensureReadable(bundlePath)

  const bundleFile = basename(bundlePath)
  const prefix = `${config.artifact.bundleName}-v`
  if (!bundleFile.startsWith(prefix) || !bundleFile.endsWith('.tgz')) {
    throw new Error(`制品文件名必须匹配 ${prefix}<version>-<timestamp>.tgz`)
  }
  const versionTag = bundleFile.slice(prefix.length, -'.tgz'.length)
  if (!versionTag) throw new Error('无法从制品文件名解析版本')
  const versionName = `${config.artifact.releaseName}-v${versionTag}`
  return {
    bundlePath,
    versionName,
    innerArchiveName: `${versionName}.tgz`,
    checksumName: `${versionName}.tgz.sha256`,
  }
}

function printSuccessfulDeploySummary(result, logger) {
  const summary = result?.summary
  if (!summary) return
  logger.success(`制品部署成功: ${summary.releaseName || 'unknown-release'}`)
  if (summary.currentRelease) logger.info(`[deploy-summary] current=${summary.currentRelease}`)
  if (summary.serviceName || summary.startupMode) {
    logger.info(
      `[deploy-summary] service=${summary.serviceName || 'custom-command'} mode=${summary.startupMode || 'unknown'}`,
    )
  }
  if (summary.healthUrl) logger.info(`[deploy-summary] health=${summary.healthUrl}`)
}

export async function runArtifactDeploy({ cli, target, args, environment, deps = {} }) {
  const logger = deps.logger || defaultLogger
  const resolveConfig = deps.resolveConfig || resolveArtifactDeployConfig
  const build = deps.buildArtifact || buildArtifact
  const deployRemotely = deps.deployRemotely || deployArtifactRemotely
  const config = resolveConfig({
    cli,
    target,
    targetConfig: cli?.commands?.deploy?.[target],
    environment,
    flags: cli?.flags || {},
    args,
  })

  const artifactPath = cli?.flags?.artifact
  if (cli?.flags?.buildOnly && artifactPath) {
    throw new Error('--build-only 与 --artifact 不能同时使用')
  }

  const load = deps.loadArtifact || loadArtifact
  const bundle = artifactPath
    ? await load(config, artifactPath, deps)
    : await build(config, deps)
  if (cli?.flags?.buildOnly) return bundle

  const result = await deployRemotely(config, bundle, deps)
  if (result?.ok) printSuccessfulDeploySummary(result, logger)
  return result
}
