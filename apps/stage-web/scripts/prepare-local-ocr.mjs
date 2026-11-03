import { copyFile, mkdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Puts the PaddleOCR models where the app serves them.
 *
 * The reader runs in the browser, so the app must serve the model files itself.
 * They come from the `@gutenye/ocr-models` package, so no download happens here,
 * and nothing about the screen leaves the machine at run time.
 */
const FILES = [
  'ch_PP-OCRv4_det_infer.onnx',
  'ch_PP-OCRv4_rec_infer.onnx',
  'ppocr_keys_v1.txt',
]

/**
 * The inference runtime of the reader, under the names that it asks for.
 * A bundler renames the files it emits, and the runtime then looks for the original names beside its own script.
 */
const RUNTIME_FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
]

const require = createRequire(import.meta.url)
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(dirname(require.resolve('@gutenye/ocr-models/node')), 'assets')
const runtimeDir = dirname(require.resolve('onnxruntime-web'))

async function copyAll(files, from, targetDir) {
  await mkdir(targetDir, { recursive: true })
  let copied = 0
  for (const file of files) {
    const source = join(from, file)
    const target = join(targetDir, file)
    const existing = await stat(target).catch(() => undefined)
    const wanted = await stat(source).catch(() => undefined)
    // A file of the same size is the same file, and copying tens of MB on every start is wasted work.
    if (!wanted || existing?.size === wanted.size)
      continue

    await copyFile(source, target)
    copied += 1
  }
  return copied
}

const models = await copyAll(FILES, sourceDir, join(appRoot, 'public', 'ocr'))
const runtime = await copyAll(RUNTIME_FILES, runtimeDir, join(appRoot, 'public', 'ort'))

console.info(`[local-ocr] ${FILES.length} models (${models} copied) and ${RUNTIME_FILES.length} runtime files (${runtime} copied) are ready`)
