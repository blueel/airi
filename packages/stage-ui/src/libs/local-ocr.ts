import type Ocr from '@gutenye/ocr-browser'

/**
 * The model files of the local reader, as the app serves them.
 * `scripts/prepare-local-ocr.mjs` copies them out of their package into the app, so a read never asks a server for
 * text and the picture never leaves the device.
 */
const MODEL_FILES = {
  detection: 'ch_PP-OCRv4_det_infer.onnx',
  recognition: 'ch_PP-OCRv4_rec_infer.onnx',
  dictionary: 'ppocr_keys_v1.txt',
} as const

/** One text box that the reader found, as the four corners of the box in pixels of the image it read. */
export interface LocalOcrLine {
  text: string
  box?: number[][]
}

let engine: Promise<Ocr> | undefined

function assetUrl(file: string) {
  return `${import.meta.env.BASE_URL}ocr/${file}`
}

async function createEngine() {
  try {
    // The reader brings an inference runtime of its own, which the page loads only when someone starts reading.
    const [{ default: Ocr }, runtime] = await Promise.all([
      import('@gutenye/ocr-browser'),
      // The same entry that the reader uses: one copy of the runtime, so one place to point at the wasm files.
      import('onnxruntime-web/wasm'),
    ])

    // A bundler renames the files it emits, while the runtime asks for their original names beside its own script. The
    // app copies them under those names, so this folder answers. Other features set this path themselves, so it goes
    // back once these sessions are built.
    const previous = runtime.env.wasm.wasmPaths
    runtime.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`
    try {
      return await Ocr.create({
        models: {
          detectionPath: assetUrl(MODEL_FILES.detection),
          recognitionPath: assetUrl(MODEL_FILES.recognition),
          dictionaryPath: assetUrl(MODEL_FILES.dictionary),
        },
      })
    }
    finally {
      runtime.env.wasm.wasmPaths = previous
    }
  }
  catch (error) {
    // A load that failed leaves nothing usable, so a second try builds the reader again.
    engine = undefined
    throw error
  }
}

/** Builds the reader once. The first call reads 15 MB of models, and every read after it reuses them. */
export function loadLocalOcr() {
  engine ??= createEngine()
  return engine
}

/** Whether a reader is already built, so a panel can show a first read that still waits for the models. */
export function localOcrIsReady() {
  return engine !== undefined
}

function median(values: number[]) {
  if (!values.length)
    return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function needsSpace(left: string, right: string) {
  return /[A-Z0-9]$/i.test(left) && /^[A-Z0-9]/i.test(right)
}

/** Two words of a Latin line need the space that the reader dropped between their boxes. Chinese needs none. */
function joinRow(parts: string[]) {
  return parts.reduce((line, part) => {
    if (!line)
      return part
    return needsSpace(line, part) ? `${line} ${part}` : `${line}${part}`
  }, '')
}

/**
 * The text of one image as lines.
 *
 * A reader returns a box per text fragment, and a comment row can come back as several: a nickname, a colon, and the
 * line. Boxes that share a height on the picture are one row, read from left to right.
 */
export function groupOcrLines(lines: readonly LocalOcrLine[]): string[] {
  const boxes = lines
    .map((line) => {
      const ys = line.box?.map(point => point[1]) ?? []
      const xs = line.box?.map(point => point[0]) ?? []
      const top = ys.length ? Math.min(...ys) : 0
      const bottom = ys.length ? Math.max(...ys) : 0
      return {
        text: line.text.trim(),
        left: xs.length ? Math.min(...xs) : 0,
        height: bottom - top,
        middle: (top + bottom) / 2,
      }
    })
    .filter(box => box.text)

  if (!boxes.length)
    return []

  // A row holds boxes of about one line height, so half of the middle height keeps two lines apart.
  const tolerance = Math.max(1, median(boxes.map(box => box.height)) * 0.6)
  const rows: typeof boxes[] = []
  for (const box of [...boxes].sort((a, b) => a.middle - b.middle)) {
    const row = rows.at(-1)
    const anchor = row?.[0]
    if (row && anchor && Math.abs(box.middle - anchor.middle) <= tolerance)
      row.push(box)
    else
      rows.push([box])
  }

  return rows.map(row => joinRow(row.sort((a, b) => a.left - b.left).map(box => box.text)))
}

/** Reads one image on this device and returns its lines, top to bottom. */
export async function readLocalOcr(image: string): Promise<string[]> {
  const reader = await loadLocalOcr()
  const result = await reader.detect(image)
  return groupOcrLines(result.texts)
}
