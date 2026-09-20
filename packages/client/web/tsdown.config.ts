import { clientLibrary, staticLinked } from '../tsdown.client.ts'

/**
 * Two artifacts. `lib/index.js` is the shell library apps/web links statically.
 * `lib/platform.js` is the platform module contract published as
 * `@deepseek-ai/dsh-client-web/platform`: Desktop packaging imports it from a
 * plain Node process, and bundling it keeps the contract off the tsc-emitted
 * `lib/types` tree, which this package does not publish as JavaScript (those
 * modules import stylesheets the shell's own build places under `lib/`).
 */
const shellLibrary = staticLinked(
  '@deepseek-ai/dsh-client-web',
  ['lib/types/index.js'],
)
const platformContract = clientLibrary(
  '@deepseek-ai/dsh-client-web',
  ['lib/types/platform.js'],
)

export default (inlineConfig: Parameters<typeof shellLibrary>[0]) => [
  ...shellLibrary(inlineConfig),
  ...platformContract(inlineConfig),
]
