import { describe, expect, jest, test } from '@jest/globals'
import { runArtifactDeploy } from '../lib/artifact-deploy.js'

function createCli(flags = {}) {
  return {
    projectRoot: '/repo',
    flags,
    commands: {
      deploy: {
        worker: {
          internal: 'artifact-deploy',
          artifactDeploy: {},
        },
      },
    },
  }
}

describe('runArtifactDeploy', () => {
  test('build-only returns the bundle without remote deployment', async () => {
    const bundle = { versionName: 'worker-v1', bundlePath: '/repo/release/worker-v1.tgz' }
    const deps = {
      resolveConfig: jest.fn(() => ({ artifact: {} })),
      buildArtifact: jest.fn(async () => bundle),
      deployRemotely: jest.fn(),
    }

    const result = await runArtifactDeploy({
      cli: createCli({ buildOnly: true }),
      target: 'worker',
      args: ['worker'],
      environment: 'development',
      deps,
    })

    expect(result).toBe(bundle)
    expect(deps.deployRemotely).not.toHaveBeenCalled()
  })

  test('artifact-only loads and deploys an existing generic bundle', async () => {
    const bundle = { versionName: 'worker-v1', bundlePath: '/repo/release/worker-v1.tgz' }
    const remoteResult = { ok: true, summary: null }
    const deps = {
      resolveConfig: jest.fn(() => ({ artifact: {} })),
      buildArtifact: jest.fn(),
      loadArtifact: jest.fn(async () => bundle),
      deployRemotely: jest.fn(async () => remoteResult),
    }

    const result = await runArtifactDeploy({
      cli: createCli({ artifact: 'release/worker-v1.tgz' }),
      target: 'worker',
      args: ['worker'],
      environment: 'production',
      deps,
    })

    expect(result).toBe(remoteResult)
    expect(deps.loadArtifact).toHaveBeenCalled()
    expect(deps.buildArtifact).not.toHaveBeenCalled()
    expect(deps.deployRemotely).toHaveBeenCalledWith(expect.anything(), bundle, deps)
  })
})
