import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { argv, exit } from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Writes `bundle-index.json` next to the built pages.
 *
 * The phone reads this file twice: from the APK, as the list of files it already has, and from the release tunnel,
 * as the list of files a release needs. Matching hashes mean a file can be copied instead of downloaded, which is
 * what keeps a page update in the megabytes while the whole build is around 130 MB.
 *
 * Run it between `pnpm build` and `cap sync`, so the index is inside the APK too.
 */

const INDEX_FILE = 'bundle-index.json'
const here = fileURLToPath(new URL('.', import.meta.url))
const appRoot = resolve(here, '..')

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : fallback
}

async function filesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await filesIn(path))
      continue
    }
    if (entry.isFile())
      files.push(path)
  }
  return files
}

async function versionFromProperties() {
  const properties = await readFile(join(appRoot, 'android', 'app-version.properties'), 'utf8')
  const name = properties.match(/^AIRI_VERSION_NAME=(.+)$/m)?.[1]?.trim()
  const code = Number(properties.match(/^AIRI_VERSION_CODE=(\d+)$/m)?.[1])
  if (!name || !Number.isInteger(code)) {
    console.error(`[FAIL] Cannot read the version from android/app-version.properties`)
    exit(1)
  }
  return { name, code }
}

const dist = resolve(option('dist', join(appRoot, 'dist')))
const version = await versionFromProperties()
const versionName = option('version', version.name)
const versionCode = Number(option('code', String(version.code)))
const id = Number(option('id', String(Date.now())))

if (!Number.isInteger(versionCode) || versionCode <= 0) {
  console.error(`[FAIL] Invalid version code: ${versionCode}`)
  exit(1)
}
if (!Number.isSafeInteger(id) || id <= 0) {
  console.error(`[FAIL] Invalid release id: ${id}`)
  exit(1)
}

const names = await filesIn(dist)
const files = []
let totalBytes = 0

for (const path of names) {
  const name = relative(dist, path).split(sep).join('/')
  if (name === INDEX_FILE)
    continue

  const [bytes, info] = await Promise.all([readFile(path), stat(path)])
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  files.push({ path: name, sha256, size: info.size })
  totalBytes += info.size
}

files.sort((left, right) => left.path.localeCompare(right.path))

const index = {
  id,
  versionName,
  versionCode,
  files,
}

await writeFile(join(dist, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`)

console.info(`[ok] ${INDEX_FILE}: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
console.info(`[ok] id ${id} for ${versionName} (${versionCode})`)
