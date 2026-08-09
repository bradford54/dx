import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { parseRemoteResult } from '../backend-artifact-deploy/remote-result.js'
import { buildRemoteDeployScript } from './remote-script.js'

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', exitCode => resolve({ stdout, stderr, exitCode }))
  })
}

function escapeShellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function buildEnsureRemoteBaseDirsCommand(baseDir) {
  const normalizedBaseDir = String(baseDir).replace(/\/+$/, '') || '/'
  const directories = ['releases', 'shared', 'uploads'].map(name => `${normalizedBaseDir}/${name}`)
  return `mkdir -p ${directories.map(escapeShellArg).join(' ')}`
}

async function defaultEnsureRemoteBaseDirs(remote) {
  const target = `${remote.user}@${remote.host}`
  const result = await runProcess('ssh', [
    '-p',
    String(remote.port || 22),
    target,
    buildEnsureRemoteBaseDirsCommand(remote.baseDir),
  ])
  if (result.exitCode !== 0) throw new Error(result.stderr || `ssh mkdir failed (${result.exitCode})`)
}

async function defaultUploadBundle(remote, bundlePath) {
  const target = `${remote.user}@${remote.host}:${remote.baseDir}/uploads/${basename(bundlePath)}`
  const result = await runProcess('scp', ['-P', String(remote.port || 22), bundlePath, target])
  if (result.exitCode !== 0) throw new Error(result.stderr || `scp failed (${result.exitCode})`)
}

async function defaultRunRemoteScript(remote, script) {
  const target = `${remote.user}@${remote.host}`
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-p', String(remote.port || 22), target, 'bash -s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', exitCode => resolve({ stdout, stderr, exitCode }))
    child.stdin.write(script)
    child.stdin.end()
  })
}

export async function deployArtifactRemotely(config, bundle, deps = {}) {
  const ensureRemoteBaseDirs = deps.ensureRemoteBaseDirs || defaultEnsureRemoteBaseDirs
  const uploadBundle = deps.uploadBundle || defaultUploadBundle
  const runRemoteScript = deps.runRemoteScript || defaultRunRemoteScript

  await ensureRemoteBaseDirs(config.remote)
  await uploadBundle(config.remote, bundle.bundlePath)
  const payload = {
    environment: config.environment,
    versionName: bundle.versionName,
    uploadedBundlePath: `${config.remote.baseDir}/uploads/${basename(bundle.bundlePath)}`,
    remote: config.remote,
    artifact: {
      innerArchiveName: bundle.innerArchiveName || `${bundle.versionName}.tgz`,
      checksumName: bundle.checksumName || `${bundle.versionName}.tgz.sha256`,
    },
    startup: config.startup,
    deploy: config.deploy,
    verify: config.verify,
  }
  const commandResult = await runRemoteScript(config.remote, buildRemoteDeployScript(payload))
  const result = parseRemoteResult(commandResult)
  if (!result.ok) throw new Error(`远端部署失败(${result.phase}): ${result.message}`)
  return result
}
