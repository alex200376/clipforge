/**
 * Decides whether `dist/` still matches the sources, for `run.bat`.
 *
 * This exists because the launcher used to skip the build whenever `dist/` merely
 * *existed*: editing the app and running it again silently relaunched the previous
 * build, which makes a fix invisible and a bug look permanent.
 *
 * Exit code 0 = up to date, 1 = a rebuild is needed. Anything unexpected is
 * treated as "needs a build", because a needless compile is cheap and a stale app
 * is not.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/** Everything whose contents end up in the build. */
const INPUTS = ['src', 'index.html', 'package.json', 'vite.config.mts', 'tsconfig.json', 'tsconfig.node.json']

/** Files the build writes. If any is missing or older than an input, rebuild. */
const OUTPUTS = [
  'dist/main/index.js',
  'dist/preload/index.js',
  'dist/renderer/index.html',
  'dist/shared/api.js'
]

function newestMtime(target, best = 0) {
  let stats
  try {
    stats = statSync(target)
  } catch {
    return best
  }
  if (!stats.isDirectory()) return Math.max(best, stats.mtimeMs)
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    best = newestMtime(join(target, entry.name), best)
  }
  return best
}

function oldestMtime(targets) {
  let oldest = Number.POSITIVE_INFINITY
  for (const target of targets) {
    try {
      oldest = Math.min(oldest, statSync(target).mtimeMs)
    } catch {
      // A missing output means there is nothing to compare, so build.
      return 0
    }
  }
  return oldest
}

const newestInput = Math.max(...INPUTS.map((input) => newestMtime(join(ROOT, input))))
const oldestOutput = oldestMtime(OUTPUTS.map((output) => join(ROOT, output)))
const stale = oldestOutput <= newestInput

if (stale) {
  const seconds = oldestOutput === 0 ? 'missing' : `${Math.round((newestInput - oldestOutput) / 1000)}s newer`
  console.log(`dist is stale (${seconds})`)
  process.exit(1)
}
process.exit(0)
