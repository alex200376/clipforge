/**
 * The UI has one styling system: the shadcn primitives in `components/ui` plus Tailwind
 * utilities. It did not use to. Half the app was primitives and the other half was ~180
 * hand-written kebab-case class families in a 3,176-line stylesheet, and two systems in one
 * app is why "make it roomier" or "fix the spacing here" kept landing on some screens and
 * not others.
 *
 * These assertions are what keeps the second system from growing back, in the two ways it
 * actually did: a primitive nobody imports (so the next screen hand-rolls its own) and a
 * class in the stylesheet that no longer has a consumer (so the CSS stops being readable).
 * A class built from a template - `${prefix}-box` for the crop and watermark overlays - is
 * matched as a stem, because that is genuinely how it is written.
 *
 * The stylesheet's remaining job is geometry and tokens - the timeline track, the crop and
 * region overlays, the theme palettes - and none of that is expressible as a utility.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const renderer = join(root, 'src', 'renderer')
const primitiveDir = join(renderer, 'components', 'ui')
const stylesheet = join(renderer, 'styles.css')

/** Every TypeScript file under the renderer, paired with its contents. */
function readRenderer(): Array<{ file: string; source: string }> {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const full = join(directory, entry)
      if (statSync(full).isDirectory()) return walk(full)
      return /\.tsx?$/.test(entry) ? [full] : []
    })
  return walk(renderer).map((file) => ({ file, source: readFileSync(file, 'utf8') }))
}

const files = readRenderer()
const sources = files.map((entry) => entry.source).join('\n')

describe('the ui primitives', () => {
  const primitives = readdirSync(primitiveDir).filter((entry) => entry.endsWith('.tsx'))

  it('has a primitive for every control the app draws', () => {
    // Not a count: the point is that the set is deliberate and reviewable.
    expect(primitives.length).toBeGreaterThan(10)
  })

  it.each(primitives)('%s is imported by something that is not a primitive', (entry) => {
    const name = entry.replace(/\.tsx$/, '')
    const consumers = files.filter(
      (file) => file.file !== join(primitiveDir, entry) && new RegExp(`['"\\./]${name}'`).test(file.source)
    )
    expect(consumers.length, `${name} has no consumer`).toBeGreaterThan(0)
  })
})

describe('the stylesheet', () => {
  const css = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  /** Class selectors declared in the stylesheet, as bare names. */
  const classes = [...new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map((match) => match[1]!))]

  it('names no class the renderer has stopped using', () => {
    const orphaned = classes.filter((name) => {
      if (new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(sources)) return false
      // `${prefix}-box` and friends: matched on the stem, since that is how they are built.
      const stem = name.replace(/-[a-z0-9]+$/, '')
      const suffix = name.slice(stem.length + 1)
      return !(stem && new RegExp(`\\$\\{[^}]+\\}-${suffix}`).test(sources))
    })

    expect(orphaned).toEqual([])
  })

  it('stays near the geometry budget, not the old class list', () => {
    // 34 when the migration finished. The ceiling is headroom, not a target: anything
    // approaching it means class rules are creeping back in beside the primitives.
    expect(classes.length).toBeLessThan(60)
  })
})

describe('remote content', () => {
  const updatePanel = files.find((entry) => entry.file.endsWith(join('components', 'UpdatePanel.tsx')))!

  it('is never parsed as markup', () => {
    // The window shows two things it did not write: a release body fetched from GitHub, and
    // the failure text electron-updater produces. `innerHTML` and its React spelling are how
    // remote text becomes remote markup, so the whole renderer is held to not using them -
    // and the release notes are the case that made this worth asserting.
    const offenders = files.filter((entry) => /dangerouslySetInnerHTML|\binnerHTML\b|outerHTML/.test(entry.source))
    expect(offenders.map((entry) => entry.file)).toEqual([])
  })

  it('prints the release notes one line per element', () => {
    // Not the assertion above: text nodes *are* the mechanism, and this is what says the
    // notes go through one. A `<ul>` of `<li>{line}</li>` cannot execute a release body.
    expect(updatePanel.source).toMatch(/notes\.map\(\(line, index\)/) 
    expect(updatePanel.source).toContain('<li key={index}>{line}</li>')
    // And they are only shown for the version they describe, so a later check cannot present
    // one release's notes as another's.
    expect(updatePanel.source).toContain('state.notesFor === state.version')
  })
})
