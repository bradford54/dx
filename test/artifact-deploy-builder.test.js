import { describe, expect, test } from '@jest/globals'
import { createArtifactNames } from '../lib/artifact-deploy/artifact-builder.js'
import { loadArtifact } from '../lib/artifact-deploy.js'

describe('generic artifact bundle naming', () => {
  test('uses a target-specific release name instead of backend-v', () => {
    expect(createArtifactNames({
      version: '1.2.3',
      timeTag: '20260809-120000',
      bundleName: 'comfyui-bundle',
      releaseName: 'comfyui-mulerouter',
    })).toEqual({
      versionName: 'comfyui-mulerouter-v1.2.3-20260809-120000',
      innerArchiveName: 'comfyui-mulerouter-v1.2.3-20260809-120000.tgz',
      checksumName: 'comfyui-mulerouter-v1.2.3-20260809-120000.tgz.sha256',
      bundleName: 'comfyui-bundle-v1.2.3-20260809-120000.tgz',
    })
  })

  test('loads a previously built bundle without project dependencies', async () => {
    const result = await loadArtifact({
      projectRoot: '/repo',
      artifact: {
        bundleName: 'comfyui-bundle',
        releaseName: 'comfyui-mulerouter',
      },
    }, 'release/comfyui-bundle-v1.2.3-20260809-120000.tgz', {
      ensureArtifactReadable: async () => {},
    })

    expect(result.versionName).toBe('comfyui-mulerouter-v1.2.3-20260809-120000')
    expect(result.innerArchiveName).toBe(`${result.versionName}.tgz`)
  })
})
