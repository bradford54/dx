import { describe, expect, test } from '@jest/globals'
import { resolveArtifactDeployConfig } from '../lib/artifact-deploy/config.js'

function createTargetConfig(overrides = {}) {
  return {
    internal: 'artifact-deploy',
    artifactDeploy: {
      build: {
        command: 'python -m build_comfy_node',
        sourceDir: 'dist/comfyui-mulerouter',
        versionCommand: 'python scripts/read_version.py',
      },
      artifact: {
        outputDir: 'release/comfyui-mulerouter',
        bundleName: 'comfyui-mulerouter-bundle',
        releaseName: 'comfyui-mulerouter',
      },
      remote: {
        host: 'gpu.example.com',
        port: 22,
        user: 'deploy',
        baseDir: '/srv/comfyui-mulerouter',
      },
      startup: {
        mode: 'systemd',
        serviceName: 'comfyui-mulerouter.service',
      },
      deploy: {
        keepReleases: 5,
        installCommand: 'python -m pip install -r requirements.txt',
      },
      verify: {
        command: 'sudo systemctl is-active --quiet comfyui-mulerouter.service',
        healthCheck: {
          url: 'http://127.0.0.1:8188/health',
        },
      },
    },
    ...overrides,
  }
}

describe('resolveArtifactDeployConfig', () => {
  test('normalizes a non-Node systemd artifact target', () => {
    const config = resolveArtifactDeployConfig({
      cli: { projectRoot: '/repo' },
      target: 'comfyui-mulerouter',
      targetConfig: createTargetConfig(),
      environment: 'production',
      flags: {},
    })

    expect(config.build.sourceDir).toBe('/repo/dist/comfyui-mulerouter')
    expect(config.build.versionCommand).toBe('python scripts/read_version.py')
    expect(config.startup).toEqual({
      mode: 'systemd',
      serviceName: 'comfyui-mulerouter.service',
      command: null,
      rollbackCommand: null,
    })
    expect(config.deploy.installCommand).toBe('python -m pip install -r requirements.txt')
    expect(config.verify.command).toContain('systemctl is-active')
  })

  test('supports command startup and optional install/health commands', () => {
    const targetConfig = createTargetConfig()
    targetConfig.artifactDeploy.startup = {
      mode: 'command',
      command: './scripts/restart.sh',
      rollbackCommand: './scripts/restart.sh --rollback',
    }
    delete targetConfig.artifactDeploy.deploy.installCommand
    delete targetConfig.artifactDeploy.verify

    const config = resolveArtifactDeployConfig({
      cli: { projectRoot: '/repo' },
      target: 'worker',
      targetConfig,
      environment: 'staging',
      flags: {},
    })

    expect(config.startup.command).toBe('./scripts/restart.sh')
    expect(config.startup.rollbackCommand).toBe('./scripts/restart.sh --rollback')
    expect(config.deploy.installCommand).toBeNull()
    expect(config.verify).toEqual({
      command: null,
      maxWaitSeconds: 24,
      retryIntervalSeconds: 2,
      healthCheck: null,
    })
  })

  test('allows remote config to be omitted for build-only', () => {
    const targetConfig = createTargetConfig()
    delete targetConfig.artifactDeploy.remote

    const config = resolveArtifactDeployConfig({
      cli: { projectRoot: '/repo' },
      target: 'comfyui-mulerouter',
      targetConfig,
      environment: 'development',
      flags: { buildOnly: true },
    })

    expect(config.remote).toBeNull()
  })

  test('requires a generic version source and a valid startup contract', () => {
    const missingVersion = createTargetConfig()
    delete missingVersion.artifactDeploy.build.versionCommand
    expect(() => resolveArtifactDeployConfig({
      cli: { projectRoot: '/repo' },
      target: 'worker',
      targetConfig: missingVersion,
      environment: 'production',
      flags: {},
    })).toThrow('build.versionFile')

    const missingCommand = createTargetConfig()
    missingCommand.artifactDeploy.startup = { mode: 'command' }
    expect(() => resolveArtifactDeployConfig({
      cli: { projectRoot: '/repo' },
      target: 'worker',
      targetConfig: missingCommand,
      environment: 'production',
      flags: {},
    })).toThrow('startup.command')

    const systemdWithoutService = createTargetConfig()
    systemdWithoutService.artifactDeploy.startup = {
      mode: 'systemd',
      command: 'sudo systemctl restart worker.service',
    }
    expect(() => resolveArtifactDeployConfig({
      cli: { projectRoot: '/repo' },
      target: 'worker',
      targetConfig: systemdWithoutService,
      environment: 'production',
      flags: {},
    })).toThrow('startup.serviceName')
  })

  test('rejects unsafe artifact release names in artifact-only flows', () => {
    const targetConfig = createTargetConfig()
    targetConfig.artifactDeploy.artifact.releaseName = '../outside'

    expect(() => resolveArtifactDeployConfig({
      cli: { projectRoot: '/repo' },
      target: 'worker',
      targetConfig,
      environment: 'production',
      flags: {},
    })).toThrow('artifact.releaseName')
  })
})
