#!/usr/bin/env node
/**
 * Build the Desktop application icon set from the official in-repo brand artwork.
 *
 * The source of truth is the artwork the repository already ships: the DeepSeek whale path in
 * `apps/web/public/favicon.svg` (byte-identical to `website/public/favicon.svg`; only the fill
 * differs). The desktop icon uses the official brand blue `#4D6BFE` that the website favicon already
 * renders, plus a safe margin so Windows never crops the silhouette.
 *
 * The artwork itself is never traced, stretched, or redrawn: this script extracts the official path
 * data, translates it, and scales it uniformly.
 *
 * Outputs:
 *
 * - `apps/desktop/assets/icon-source.svg` — the one source file, 1024x1024, transparent.
 * - `apps/desktop/assets/icon.png` — 1024x1024 transparent raster.
 * - `apps/desktop/assets/icon.ico` — 16/24/32/48/64/128/256 entries.
 *
 * `sharp` is resolved from the workspace package that already depends on it, so no new dependency is
 * introduced. Run through `pnpm --dir apps/desktop-portable run icons`.
 *
 * @module @deepseek-ai/dsh-desktop-portable/build-icons
 */

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ADDON_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(ADDON_ROOT, '..', '..')
const ASSETS_ROOT = join(REPOSITORY_ROOT, 'apps', 'desktop', 'assets')

/** Workspace package that already depends on `sharp`; reused instead of adding a dependency. */
const SHARP_OWNER = join(REPOSITORY_ROOT, 'packages', 'attachment', 'attachment-local', 'package.json')

/** Files the official artwork is read from, in priority order. */
const ARTWORK_SOURCES = [
  join(REPOSITORY_ROOT, 'apps', 'web', 'public', 'favicon.svg'),
  join(REPOSITORY_ROOT, 'website', 'public', 'favicon.svg'),
]

/** DeepSeek brand blue, the fill the official website favicon already uses. */
const BRAND_BLUE = '#4D6BFE'

/** Master raster edge, in pixels. */
const CANVAS = 1024

/** Side length of the artwork inside {@link CANVAS}; the remainder is the safe margin. */
const MARK_SIZE = 870

/** View box of the official artwork. */
const MARK_VIEWBOX = 50

/**
 * ICO entries. Everything below 128 stays BMP-encoded the way Windows itself writes ICO files;
 * 128 and 256 use PNG entries, which Windows has supported since Vista and which keep the file small.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

const requireFromWorkspace = createRequire(SHARP_OWNER)
const sharp = requireFromWorkspace('sharp')

/**
 * Read the official whale path data.
 * @returns SVG path `d` attribute of the DeepSeek mark.
 */
function officialArtworkPath() {
  for (const source of ARTWORK_SOURCES) {
    let svg
    try {
      svg = readFileSync(source, 'utf8')
    } catch {
      continue
    }
    const match = /<path[^>]*\sd="([^"]+)"/u.exec(svg)
    if (match?.[1] !== undefined) return match[1]
  }
  throw new Error('desktop icons: no official favicon artwork found to build the icon from')
}

/**
 * Compose the square, transparent source SVG.
 * @param path - official artwork path data.
 * @returns SVG document text.
 */
function sourceSvg(path) {
  const offset = (CANVAS - MARK_SIZE) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none">
  <title>DeepSeek Harness</title>
  <g transform="translate(${offset} ${offset}) scale(${MARK_SIZE / MARK_VIEWBOX})">
    <path d="${path}" fill="${BRAND_BLUE}"/>
  </g>
</svg>
`
}

/**
 * Encode one raster as a 32-bit BMP ICO entry: a 40-byte DIB header, bottom-up BGRA rows, then the
 * 1-bit AND mask that the format requires. Windows ignores the mask for 32-bit entries, but its
 * icons carry one, so writing it keeps the file conventional.
 * @param rgba - tightly packed RGBA pixels.
 * @param size - square edge length.
 * @returns ICO entry bytes.
 */
function bmpEntry(rgba, size) {
  const andStride = Math.ceil(size / 32) * 4
  const imageSize = size * size * 4
  const entry = Buffer.alloc(40 + imageSize + andStride * size)
  entry.writeUInt32LE(40, 0)
  entry.writeInt32LE(size, 4)
  // ICO stores the height doubled to account for the AND mask.
  entry.writeInt32LE(size * 2, 8)
  entry.writeUInt16LE(1, 12)
  entry.writeUInt16LE(32, 14)
  entry.writeUInt32LE(imageSize, 20)
  for (let y = 0; y < size; y += 1) {
    const sourceRow = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x += 1) {
      const from = sourceRow + x * 4
      const to = 40 + (y * size + x) * 4
      entry[to] = rgba[from + 2]
      entry[to + 1] = rgba[from + 1]
      entry[to + 2] = rgba[from]
      entry[to + 3] = rgba[from + 3]
    }
  }
  return entry
}

/**
 * Assemble a multi-size ICO container.
 * @param entries - one raster per size, in {@link ICO_SIZES} order.
 * @returns ICO file bytes.
 */
function icoContainer(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach(({ size, data }, index) => {
    const at = 6 + index * 16
    // 256 is encoded as 0 in the directory.
    header.writeUInt8(size >= 256 ? 0 : size, at)
    header.writeUInt8(size >= 256 ? 0 : size, at + 1)
    header.writeUInt8(0, at + 2)
    header.writeUInt8(0, at + 3)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(data.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...entries.map(entry => entry.data)])
}

async function main() {
  mkdirSync(ASSETS_ROOT, { recursive: true })
  const svg = sourceSvg(officialArtworkPath())
  writeFileSync(join(ASSETS_ROOT, 'icon-source.svg'), svg)

  // Rasterize the vector at high density so downscaling never resamples a low-resolution source.
  const master = await sharp(Buffer.from(svg), { density: 384 })
    .resize(CANVAS, CANVAS)
    .png()
    .toBuffer()
  writeFileSync(join(ASSETS_ROOT, 'icon.png'), master)

  const entries = []
  for (const size of ICO_SIZES) {
    const png = await sharp(master).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
    if (size >= 128) {
      entries.push({ size, data: png })
      continue
    }
    const { data } = await sharp(master).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    entries.push({ size, data: bmpEntry(data, size) })
  }
  const ico = icoContainer(entries)
  writeFileSync(join(ASSETS_ROOT, 'icon.ico'), ico)

  console.log(`desktop icons: wrote icon-source.svg, icon.png (${CANVAS}x${CANVAS}), icon.ico (${ICO_SIZES.join(', ')})`)
  console.log(`desktop icons: icon.ico ${ico.length} bytes, icon.png ${master.length} bytes`)
}

await main()
