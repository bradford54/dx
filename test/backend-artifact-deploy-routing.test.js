import { describe, expect, jest, test } from '@jest/globals'

jest.unstable_mockModule('../lib/backend-artifact-deploy.js', () => ({
  runBackendArtifactDeploy: jest.fn(),
}))

jest.unstable_mockModule('../lib/artifact-deploy.js', () => ({
  runArtifactDeploy: jest.fn(),
}))

jest.unstable_mockModule('../lib/vercel-deploy.js', () => ({
  deployToVercel: jest.fn(),
}))

jest.unstable_mockModule('../lib/validate-env.js', () => ({
  validateEnvironment: jest.fn(),
}))

jest.unstable_mockModule('../lib/env.js', () => ({
  envManager: {
    collectEnvFromLayers: jest.fn(() => ({})),
    latestEnvWarnings: [],
    syncEnvironments: jest.fn(),
    isPlaceholderEnvValue: jest.fn(() => false),
  },
}))

const { FLAG_DEFINITIONS, parseFlags } = await import('../lib/cli/flags.js')
const { showCommandHelp, showHelp } = await import('../lib/cli/help.js')
const { handleDeploy } = await import('../lib/cli/commands/deploy.js')
const { runBackendArtifactDeploy } = await import('../lib/backend-artifact-deploy.js')
const { runArtifactDeploy } = await import('../lib/artifact-deploy.js')
const { deployToVercel } = await import('../lib/vercel-deploy.js')

describe('backend artifact deploy routing', () => {
  test('deploy flags include build-only, artifact and skip-migration', () => {
    const flags = parseFlags([
      'deploy',
      'backend',
      '--build-only',
      '--artifact',
      'release/backend/backend-bundle-v1.tgz',
      '--skip-migration',
    ])

    expect(flags.buildOnly).toBe(true)
    expect(flags.artifact).toBe('release/backend/backend-bundle-v1.tgz')
    expect(flags.skipMigration).toBe(true)
    expect(FLAG_DEFINITIONS.deploy).toContainEqual({ flag: '--artifact', expectsValue: true })
  })

  test('deploy backend internal target dispatches to backend artifact runner', async () => {
    const cli = {
      invocation: 'dx',
      commands: {
        deploy: {
          backend: {
            internal: 'backend-artifact-deploy',
          },
        },
      },
      flags: {},
      args: ['deploy', 'backend'],
      ensureRepoRoot: jest.fn(),
    }

    await handleDeploy(cli, ['backend'])

    expect(runBackendArtifactDeploy).toHaveBeenCalledWith({
      cli,
      target: 'backend',
      args: ['backend'],
      environment: 'development',
    })
    expect(deployToVercel).not.toHaveBeenCalled()
  })

  test('generic artifact target dispatches to the generic artifact runner', async () => {
    const cli = {
      invocation: 'dx',
      commands: {
        deploy: {
          'comfyui-mulerouter': { internal: 'artifact-deploy' },
        },
      },
      flags: {},
      args: ['deploy', 'comfyui-mulerouter'],
      ensureRepoRoot: jest.fn(),
    }

    await handleDeploy(cli, ['comfyui-mulerouter'])

    expect(runArtifactDeploy).toHaveBeenCalledWith({
      cli,
      target: 'comfyui-mulerouter',
      args: ['comfyui-mulerouter'],
      environment: 'development',
    })
    expect(runBackendArtifactDeploy).not.toHaveBeenLastCalledWith(expect.objectContaining({ cli }))
    expect(deployToVercel).not.toHaveBeenLastCalledWith('comfyui-mulerouter', expect.anything())
  })

  test('deploy backend defaults to development while Vercel targets keep staging default', async () => {
    const backendCli = {
      invocation: 'dx',
      commands: {
        deploy: {
          backend: {
            internal: 'backend-artifact-deploy',
          },
        },
      },
      flags: {},
      args: ['deploy', 'backend'],
      ensureRepoRoot: jest.fn(),
    }

    const frontCli = {
      invocation: 'dx',
      commands: {
        deploy: {
          front: {
            description: 'vercel front deploy',
          },
        },
      },
      flags: {},
      args: ['deploy', 'front'],
      ensureRepoRoot: jest.fn(),
    }

    await handleDeploy(backendCli, ['backend'])
    await handleDeploy(frontCli, ['front'])

    expect(runBackendArtifactDeploy).toHaveBeenLastCalledWith({
      cli: backendCli,
      target: 'backend',
      args: ['backend'],
      environment: 'development',
    })
    expect(deployToVercel).toHaveBeenCalledWith('front', expect.objectContaining({ environment: 'staging' }))
  })

  test('deploy help documents backend artifact mode and different defaults', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const cli = {
      invocation: 'dx',
      commands: {
        help: {
          summary: '统一开发环境管理工具',
          commands: {
            deploy: {
              summary: '部署前端到 Vercel 或后端制品到远端主机',
              usage: 'dx deploy <target> [环境标志] [选项]',
              notes: ['backend 制品发布目标默认 --dev'],
              examples: [
                {
                  command: 'dx deploy backend --prod',
                  description: '构建 backend 制品并部署到远端主机',
                },
              ],
            },
          },
          targets: {
            deploy: {
              backend: {
                summary: '构建并部署 backend 制品到远端主机',
                options: [
                  {
                    flags: ['--build-only'],
                    description: '仅本地构建并打包制品，不上传不远端部署',
                  },
                  {
                    flags: ['--skip-migration'],
                    description: '远端部署时跳过 prisma migrate deploy',
                  },
                ],
                examples: [
                  {
                    command: 'dx deploy backend --build-only',
                    description: '仅构建 backend 制品',
                  },
                ],
              },
            },
          },
          examples: [
            {
              command: 'dx deploy backend --build-only',
              description: '仅构建 backend 制品',
            },
          ],
        },
        deploy: {
          backend: {
            internal: 'backend-artifact-deploy',
          },
          front: {
            description: '部署 front 到 Vercel',
          },
        },
      },
      commandHandlers: {
        deploy: () => {},
      },
      flagDefinitions: FLAG_DEFINITIONS,
    }

    showHelp(cli)
    showCommandHelp('deploy', cli)

    const output = logSpy.mock.calls.flat().join('\n')
    expect(output).toContain('部署前端到 Vercel 或后端制品到远端主机')
    expect(output).toContain('dx deploy backend --prod')
    expect(output).toContain('--build-only')
    expect(output).toContain('--skip-migration')
    expect(output).toContain('构建并部署 backend 制品到远端主机')
    expect(output).toContain('backend 制品发布目标默认 --dev')

    logSpy.mockRestore()
  })
})
