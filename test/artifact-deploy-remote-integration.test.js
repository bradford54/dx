import { afterEach, describe, expect, test } from '@jest/globals'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildArtifact } from '../lib/artifact-deploy/artifact-builder.js'
import { buildRemoteDeployScript } from '../lib/artifact-deploy/remote-script.js'

const tempDirs = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createBundle(root, versionName = 'worker') {
  const sourceDir = join(root, 'dist')
  const outputDir = join(root, 'release')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(join(sourceDir, 'worker.py'), 'print("ok")\n')

  return buildArtifact({
    projectRoot: root,
    environment: 'production',
    build: {
      command: 'true',
      sourceDir,
      versionFile: null,
      versionCommand: null,
      app: null,
    },
    artifact: {
      outputDir,
      bundleName: `${versionName}-bundle`,
      releaseName: versionName,
      version: '1.2.3',
    },
  }, {
    runBuild: async () => {},
    nowTag: () => '20260809-120000',
  })
}

async function prepareRemote(root, bundle) {
  const baseDir = join(root, 'remote')
  const uploadsDir = join(baseDir, 'uploads')
  await mkdir(uploadsDir, { recursive: true })
  const uploadedBundlePath = join(uploadsDir, bundle.bundlePath.split('/').at(-1))
  await cp(bundle.bundlePath, uploadedBundlePath)
  return { baseDir, uploadedBundlePath }
}

function runRemoteScript(payload) {
  return spawnSync('bash', {
    input: buildRemoteDeployScript(payload),
    encoding: 'utf8',
  })
}

describe('generic artifact remote integration', () => {
  test('extracts, installs, switches current and reports success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dx-artifact-success-'))
    tempDirs.push(root)
    const bundle = await createBundle(root)
    const remote = await prepareRemote(root, bundle)

    const result = runRemoteScript({
      environment: 'production',
      versionName: bundle.versionName,
      uploadedBundlePath: remote.uploadedBundlePath,
      remote: { baseDir: remote.baseDir },
      artifact: {
        innerArchiveName: bundle.innerArchiveName,
        checksumName: bundle.checksumName,
      },
      startup: {
        mode: 'command',
        command: 'test -f worker.py',
      },
      deploy: {
        keepReleases: 2,
        installCommand: 'touch installed.marker',
      },
      verify: {
        command: 'test -f installed.marker',
        maxWaitSeconds: 2,
        retryIntervalSeconds: 1,
        healthCheck: null,
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"ok":true')
    const currentTarget = await readlink(join(remote.baseDir, 'current'))
    expect(currentTarget).toBe(join(remote.baseDir, 'releases', bundle.versionName))
    expect(await readFile(join(currentTarget, 'worker.py'), 'utf8')).toContain('print("ok")')
    expect(await readFile(join(currentTarget, 'installed.marker'), 'utf8')).toBe('')
  })

  test('restores current and restarts the previous release when startup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dx-artifact-rollback-'))
    tempDirs.push(root)
    const bundle = await createBundle(root)
    const remote = await prepareRemote(root, bundle)
    const previousRelease = join(remote.baseDir, 'releases', 'worker-v1.2.2-previous')
    await mkdir(previousRelease, { recursive: true })
    await writeFile(join(previousRelease, 'old.marker'), '')
    await symlink(previousRelease, join(remote.baseDir, 'current'))

    const result = runRemoteScript({
      environment: 'production',
      versionName: bundle.versionName,
      uploadedBundlePath: remote.uploadedBundlePath,
      remote: { baseDir: remote.baseDir },
      artifact: {
        innerArchiveName: bundle.innerArchiveName,
        checksumName: bundle.checksumName,
      },
      startup: {
        mode: 'command',
        command: 'false',
        rollbackCommand: 'test -f old.marker',
      },
      deploy: { keepReleases: 5, installCommand: null },
      verify: {
        command: null,
        maxWaitSeconds: 2,
        retryIntervalSeconds: 1,
        healthCheck: null,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('"phase":"startup"')
    expect(result.stdout).toContain('"rollbackAttempted":true')
    expect(result.stdout).toContain('"rollbackSucceeded":true')
    expect(await readlink(join(remote.baseDir, 'current'))).toBe(await realpath(previousRelease))
  })

  test('restores current when the configured verification command times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dx-artifact-verify-rollback-'))
    tempDirs.push(root)
    const bundle = await createBundle(root)
    const remote = await prepareRemote(root, bundle)
    const previousRelease = join(remote.baseDir, 'releases', 'worker-v1.2.2-previous')
    await mkdir(previousRelease, { recursive: true })
    await writeFile(join(previousRelease, 'old.marker'), '')
    await symlink(previousRelease, join(remote.baseDir, 'current'))

    const result = runRemoteScript({
      environment: 'production',
      versionName: bundle.versionName,
      uploadedBundlePath: remote.uploadedBundlePath,
      remote: { baseDir: remote.baseDir },
      artifact: {
        innerArchiveName: bundle.innerArchiveName,
        checksumName: bundle.checksumName,
      },
      startup: {
        mode: 'command',
        command: 'true',
        rollbackCommand: 'test -f old.marker',
      },
      deploy: { keepReleases: 5, installCommand: null },
      verify: {
        command: 'false',
        maxWaitSeconds: 1,
        retryIntervalSeconds: 1,
        healthCheck: null,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('"phase":"verify"')
    expect(result.stdout).toContain('"rollbackAttempted":true')
    expect(result.stdout).toContain('"rollbackSucceeded":true')
    expect(await readlink(join(remote.baseDir, 'current'))).toBe(await realpath(previousRelease))
  })
})
