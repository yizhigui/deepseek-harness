/**
 * electron-builder configuration for the add-on Windows targets.
 *
 * `apps/desktop/electron-builder.config.mjs` remains the single source of truth for its own package
 * command; this file only layers a portable target, the `dist-desktop/` output directory, and a
 * same-volume tool cache on top of the official configuration.
 *
 * @module @deepseek-ai/dsh-desktop-portable/portable.config
 */

import { createPortableConfig } from './scripts/portable-targets.mjs'

export default await createPortableConfig()
