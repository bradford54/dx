import { readFileSync } from 'node:fs'
import { describe, expect, test } from '@jest/globals'

describe('backend artifact deploy docs and example config', () => {
  test('example commands config documents backend artifact deploy shape', () => {
    const source = readFileSync(new URL('../example/dx/config/commands.json', import.meta.url), 'utf8')
    const config = JSON.parse(source)

    expect(config.deploy.backend.internal).toBe('backend-artifact-deploy')
    expect(config.deploy.backend.backendDeploy.build.commands.production).toContain('npx nx build backend')
    expect(config.deploy.backend.backendDeploy.remote.baseDir).toBe('/srv/example-app')
  })

  test('README documents backend artifact deploy command and remote layouts', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const exampleReadme = readFileSync(new URL('../example/README.md', import.meta.url), 'utf8')

    expect(readme).toContain('dx deploy backend --prod')
    expect(readme).toContain('--build-only')
    expect(readme).toContain('--skip-migration')
    expect(readme).toContain('<baseDir>/releases/<version-name>')
    expect(readme).toContain('<baseDir>/current')
    expect(readme).toContain('<baseDir>/shared/.env.<environment>')
    expect(readme).toContain('如果应用把 `prisma` 放在 `devDependencies`')
    expect(readme).toContain('任意层级出现 `.env*` 文件都会直接失败')
    expect(readme).toContain('所有本地路径字段都会被解析为相对项目根目录')
    expect(readme).toContain('`remote.baseDir` 必须是绝对路径')
    expect(readme).toContain('只能包含 `/`、字母、数字、`.`、`_`、`-`')
    expect(readme).toContain('`remote.staging` / `remote.production`')
    expect(readme).toContain('dx deploy backend --staging')
    expect(readme).toContain('ai-ubuntu-prod')
    expect(exampleReadme).toContain('internal: "backend-artifact-deploy"')
    expect(exampleReadme).toContain('dx deploy backend --build-only')
    expect(exampleReadme).toContain('所有本地路径字段都会先约束在项目根目录内')
    expect(exampleReadme).toContain('`remote.baseDir` 必须使用绝对路径')
  })

  test('README documents the non-Node artifact target contract', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const exampleReadme = readFileSync(new URL('../example/README.md', import.meta.url), 'utf8')

    expect(readme).toContain('internal: "artifact-deploy"')
    expect(readme).toContain('dx deploy comfyui-mulerouter --prod')
    expect(readme).toContain('`startup.mode` 支持 `systemd` 和 `command`')
    expect(readme).toContain('`deploy.installCommand` 可省略')
    expect(readme).toContain('`verify.command` 会重试到成功')
    expect(readme).toContain('`current` 切回上一 release')
    expect(exampleReadme).toContain('非 Node 制品使用通用 artifact runner')
  })
})
