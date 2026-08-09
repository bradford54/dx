import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { execManager } from '../exec.js'
import { resolveWithinBase } from '../backend-artifact-deploy/path-utils.js'

const execFileAsync = promisify(execFile)
const tarEnv = {
  ...process.env,
  COPYFILE_DISABLE: '1',
  COPY_EXTENDED_ATTRIBUTES_DISABLE: '1',
}

function assertSafeNamePart(value, label) {
  const text = String(value || '').trim()
  if (!text || text.includes('/') || text.includes('\\') || text.includes('..')) {
    throw new Error(`${label} 越界，已拒绝: ${text}`)
  }
  return text
}

function defaultNowTag() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function defaultRunBuild(build, environment) {
  await execManager.executeCommand(build.command, {
    app: build.app || undefined,
    skipEnvValidation: !build.app,
    flags: environment === 'production'
      ? { prod: true }
      : environment === 'staging'
        ? { staging: true }
        : { dev: true },
  })
}

async function defaultReadVersion(config) {
  if (config.artifact.version) return config.artifact.version
  if (config.build.versionCommand) {
    const { stdout } = await execFileAsync('bash', ['-lc', config.build.versionCommand], {
      cwd: config.projectRoot,
      env: process.env,
    })
    return String(stdout).trim()
  }

  const parsed = JSON.parse(await readFile(config.build.versionFile, 'utf8'))
  return String(parsed.version || '').trim()
}

async function defaultStageFiles(sourceDir, stageDir) {
  if (!existsSync(sourceDir)) throw new Error(`缺少待打包目录: ${sourceDir}`)
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  for (const entry of await readdir(sourceDir)) {
    await cp(join(sourceDir, entry), join(stageDir, entry), { recursive: true })
  }
}

async function defaultAssertNoEnvFiles(stageDir) {
  const queue = ['.']
  const envFiles = []
  while (queue.length > 0) {
    const relativeDir = queue.shift()
    const currentDir = relativeDir === '.' ? stageDir : join(stageDir, relativeDir)
    for (const entry of await readdir(currentDir, { withFileTypes: true })) {
      const relativePath = relativeDir === '.' ? entry.name : join(relativeDir, entry.name)
      if (entry.name.startsWith('.env')) envFiles.push(relativePath.replace(/\\/g, '/'))
      if (entry.isDirectory()) queue.push(relativePath)
    }
  }
  if (envFiles.length > 0) throw new Error(`制品目录包含 .env* 文件: ${envFiles.join(', ')}`)
}

export function createArtifactNames({ version, timeTag, bundleName, releaseName }) {
  const safeVersion = assertSafeNamePart(version, 'version')
  const safeTimeTag = assertSafeNamePart(timeTag, 'timeTag')
  const safeBundleName = assertSafeNamePart(bundleName, 'bundleName')
  const safeReleaseName = assertSafeNamePart(releaseName, 'releaseName')
  const versionName = `${safeReleaseName}-v${safeVersion}-${safeTimeTag}`
  const innerArchiveName = `${versionName}.tgz`
  return {
    versionName,
    innerArchiveName,
    checksumName: `${innerArchiveName}.sha256`,
    bundleName: `${safeBundleName}-v${safeVersion}-${safeTimeTag}.tgz`,
  }
}

export async function buildArtifact(config, deps = {}) {
  const runBuild = deps.runBuild || defaultRunBuild
  const readVersion = deps.readVersion || defaultReadVersion
  const nowTag = deps.nowTag || defaultNowTag
  const stageFiles = deps.stageFiles || defaultStageFiles
  const assertNoEnvFiles = deps.assertNoEnvFiles || defaultAssertNoEnvFiles
  const version = await readVersion(config)
  if (!version) throw new Error('无法解析制品版本')

  const names = createArtifactNames({
    version,
    timeTag: nowTag(),
    bundleName: config.artifact.bundleName,
    releaseName: config.artifact.releaseName,
  })
  const outputDir = resolveWithinBase(config.artifact.outputDir, '.', 'artifact.outputDir')
  const stageDir = resolveWithinBase(outputDir, names.versionName, 'stageDir')
  const innerArchivePath = resolveWithinBase(outputDir, names.innerArchiveName, 'innerArchivePath')
  const checksumPath = resolveWithinBase(outputDir, names.checksumName, 'checksumPath')
  const bundlePath = resolveWithinBase(outputDir, names.bundleName, 'bundlePath')

  await runBuild(config.build, config.environment)
  await mkdir(outputDir, { recursive: true })
  await stageFiles(config.build.sourceDir, stageDir)
  await assertNoEnvFiles(stageDir)
  await execFileAsync('tar', ['-czf', innerArchivePath, '.'], { cwd: stageDir, env: tarEnv })

  const archiveName = basename(innerArchivePath)
  let checksum
  try {
    checksum = await execFileAsync('sha256sum', [archiveName], { cwd: dirname(innerArchivePath) })
  } catch {
    checksum = await execFileAsync('shasum', ['-a', '256', archiveName], { cwd: dirname(innerArchivePath) })
  }
  await writeFile(checksumPath, checksum.stdout)
  await execFileAsync('tar', ['-czf', bundlePath, archiveName, basename(checksumPath)], {
    cwd: outputDir,
    env: tarEnv,
  })

  return {
    version,
    versionName: names.versionName,
    innerArchiveName: names.innerArchiveName,
    checksumName: names.checksumName,
    bundlePath,
    innerArchivePath,
    checksumPath,
  }
}
