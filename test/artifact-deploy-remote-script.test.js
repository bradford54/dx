import { describe, expect, test } from '@jest/globals'
import { execFileSync } from 'node:child_process'
import { buildRemoteDeployScript } from '../lib/artifact-deploy/remote-script.js'

function createPayload() {
  return {
    environment: 'production',
    versionName: 'comfyui-mulerouter-v1.2.3-20260809-120000',
    uploadedBundlePath: '/srv/comfyui-mulerouter/uploads/comfyui-bundle-v1.2.3-20260809-120000.tgz',
    remote: { baseDir: '/srv/comfyui-mulerouter' },
    artifact: {
      innerArchiveName: 'comfyui-mulerouter-v1.2.3-20260809-120000.tgz',
      checksumName: 'comfyui-mulerouter-v1.2.3-20260809-120000.tgz.sha256',
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
        timeoutSeconds: 10,
        maxWaitSeconds: 30,
        retryIntervalSeconds: 2,
      },
    },
  }
}

describe('generic artifact remote script', () => {
  test('keeps release/current semantics without Node runtime requirements', () => {
    const script = buildRemoteDeployScript(createPayload())

    expect(script).toContain('RELEASES_DIR="$APP_ROOT/releases"')
    expect(script).toContain('ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"')
    expect(script).toContain('KEEP_RELEASES=5')
    expect(script).toContain('rm -rf "$old_release"')
    expect(script).not.toContain('command -v node')
    expect(script).not.toContain('command -v pnpm')
    expect(script).not.toContain('node_modules/.bin/dotenv')
  })

  test('runs configurable install, startup and verification commands', () => {
    const script = buildRemoteDeployScript(createPayload())

    expect(script).toContain("INSTALL_COMMAND='python -m pip install -r requirements.txt'")
    expect(script).toContain("START_COMMAND='sudo systemctl restart comfyui-mulerouter.service'")
    expect(script).toContain("VERIFY_COMMAND='sudo systemctl is-active --quiet comfyui-mulerouter.service'")
    expect(script).toContain('bash -lc "$command"')
    expect(script).toContain('curl -fsS --max-time "$HEALTHCHECK_TIMEOUT_SECONDS"')
  })

  test('rolls current back and restarts the previous release after startup or verify failure', () => {
    const script = buildRemoteDeployScript(createPayload())

    expect(script).toContain('attempt_rollback()')
    expect(script).toContain('ln -sfn "$PREVIOUS_CURRENT_TARGET" "$CURRENT_LINK"')
    expect(script).toContain('run_command_at "$CURRENT_LINK" "$ROLLBACK_COMMAND"')
    expect(script).toContain('CURRENT_SWITCHED=1')
    expect(script).toContain('ROLLBACK_ATTEMPTED=true')
  })

  test('supports a fully custom command lifecycle', () => {
    const payload = createPayload()
    payload.startup = {
      mode: 'command',
      command: './deploy/restart.sh',
      rollbackCommand: './deploy/restart.sh --rollback',
    }
    payload.verify = { command: './deploy/healthcheck.sh', healthCheck: null }

    const script = buildRemoteDeployScript(payload)

    expect(script).toContain("START_MODE='command'")
    expect(script).toContain("START_COMMAND='./deploy/restart.sh'")
    expect(script).toContain("ROLLBACK_COMMAND='./deploy/restart.sh --rollback'")
    expect(script).toContain("VERIFY_COMMAND='./deploy/healthcheck.sh'")
  })

  test('generates valid Bash', () => {
    expect(() => execFileSync('bash', ['-n'], {
      input: buildRemoteDeployScript(createPayload()),
    })).not.toThrow()
  })
})
