import { describe, expect, jest, test } from '@jest/globals'
import { DxCli } from '../lib/cli/dx-cli.js'

function createCli({ command = 'deploy', target = 'backend', artifact, internal } = {}) {
  return Object.assign(Object.create(DxCli.prototype), {
    command,
    subcommand: target,
    flags: artifact ? { artifact } : {},
    commands: {
      deploy: {
        backend: { internal: internal || 'backend-artifact-deploy' },
        worker: { internal: 'artifact-deploy' },
        front: { description: 'Vercel target' },
      },
    },
  })
}

describe('artifact deploy dependency routing', () => {
  test('existing backend artifact does not require target project dependencies', () => {
    expect(createCli({ artifact: 'release/backend/backend-bundle-v1.tgz' }).requiresProjectDependencies()).toBe(false)
  })

  test('existing generic artifact does not require target project dependencies', () => {
    expect(createCli({
      target: 'worker',
      artifact: 'release/worker/worker-bundle-v1.tgz',
    }).requiresProjectDependencies()).toBe(false)
  })

  test('generic artifact builds do not force pnpm dependencies into non-Node projects', () => {
    expect(createCli({ target: 'worker' }).requiresProjectDependencies()).toBe(false)
  })

  test('generic artifact deploy skips backend-specific startup checks', async () => {
    const cli = createCli({ target: 'worker' })
    cli.ensurePrismaClient = jest.fn()
    cli.validateEnvVars = jest.fn()
    cli.getWorktreeManager = jest.fn()

    await cli.runStartupChecks()

    expect(cli.ensurePrismaClient).not.toHaveBeenCalled()
    expect(cli.validateEnvVars).not.toHaveBeenCalled()
    expect(cli.getWorktreeManager).not.toHaveBeenCalled()
  })

  test.each([
    ['regular backend deploy', createCli()],
    ['Vercel deploy', createCli({ target: 'front', artifact: 'dist/front.tgz' })],
    ['non-deploy command', createCli({ command: 'build', artifact: 'dist/backend.tgz' })],
  ])('%s keeps the dependency check', (_label, cli) => {
    expect(cli.requiresProjectDependencies()).toBe(true)
  })
})
