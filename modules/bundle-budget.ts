import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { defineNuxtModule } from 'nuxt/kit'

import { CLIENT_MANIFEST_PATH } from '../bundle-budget.config'

/**
 * Persists the client manifest so the bundle-budget gate can read it.
 *
 * `nuxt build` hands the finished client manifest to the `build:manifest` hook
 * and then does not leave a copy anywhere a script can read: `.nuxt/dist` is
 * consumed by the Nitro build and removed, and the only surviving form is the
 * precomputed structure inlined into `.output/server/chunks/virtual/`, which is
 * a rendering implementation detail rather than an interface.
 *
 * So the manifest is written out here, to a gitignored `.bundle-budget/` in the
 * project root rather than to `.output/public/`, because everything under
 * `.output/public/` is served: a file listing every chunk and its source module
 * would be public, for no benefit to a visitor.
 *
 * The module exists only for that write. It registers no runtime code, adds
 * nothing to the bundle, and is a no-op in `nuxt dev`, where the hook does not
 * fire.
 */
export default defineNuxtModule({
  meta: {
    name: 'bundle-budget',
    configKey: 'bundleBudget',
  },
  setup(_options, nuxt) {
    nuxt.hook('build:manifest', async (manifest) => {
      const target = join(nuxt.options.rootDir, CLIENT_MANIFEST_PATH)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    })
  },
})
