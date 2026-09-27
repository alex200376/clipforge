/**
 * The command palette's registry and its matching, kept pure so the ranking can be
 * tested without a DOM or a language.
 *
 * A command carries its title and group already translated: this module never sees a
 * dictionary, so a test asserts on plain strings and the app hands in whatever `useI18n`
 * produced for the current language. That is what makes the palette cheap to keep in
 * both languages - the strings live in the dictionaries like every other one.
 */

/** One action the palette can run, as the app hands it in. */
export interface Command {
  /** Stable identity, also passed to `run` results so a test can name a choice. */
  id: string
  /** Shown as the row, in the current language. */
  title: string
  /** Section the row sits under; rows keep their group's order. */
  group: string
  /** Extra terms that should find this row but are not shown, in the current language. */
  keywords?: string[]
  /** False greys the row: still listed, so a user learns it exists, but not runnable. */
  enabled: boolean
  run: () => void
}

/** A command and how well it answers the current query. */
export interface CommandMatch {
  command: Command
  score: number
}

/**
 * Whether every character of `needle` appears in `haystack`, in order.
 *
 * The last resort when no substring matches: typing `exg` should still find "Export GIF".
 * Deliberately loose - it is ranked below every substring match, so it only decides among
 * the rows nothing better claimed.
 */
function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0
  for (const character of haystack) {
    if (character === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return needle.length === 0
}

/**
 * Scores one command against a query, or answers `null` when it does not match.
 *
 * The order is the one a person expects from a launcher: the exact title, then a title that
 * starts with the query, then one that contains it, then a keyword hit, and only then the
 * loose subsequence. An empty query scores every command the same, so the list opens showing
 * everything in its authored order.
 */
export function scoreCommand(query: string, command: Pick<Command, 'title' | 'keywords'>): number | null {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return 0
  const title = command.title.toLowerCase()
  if (title === needle) return 4
  if (title.startsWith(needle)) return 3
  if (title.includes(needle)) return 2
  const keywords = (command.keywords ?? []).map((keyword) => keyword.toLowerCase())
  if (keywords.some((keyword) => keyword.includes(needle))) return 1.5
  if (isSubsequence(needle, title)) return 1
  if (keywords.some((keyword) => isSubsequence(needle, keyword))) return 0.5
  return null
}

/**
 * The commands that answer `query`, best first.
 *
 * Stable within a score band: equal-scoring commands keep the order they were given in, which
 * is how the list stays predictable as the query is typed and shortened. `commands` is expected
 * to be authored in a sensible order already.
 */
export function matchCommands(query: string, commands: readonly Command[]): CommandMatch[] {
  const matches: CommandMatch[] = []
  commands.forEach((command) => {
    const score = scoreCommand(query, command)
    if (score !== null) matches.push({ command, score })
  })
  // Array.prototype.sort is stable in every engine this app ships on, so the tie-break is the
  // authored order without needing to carry an index along.
  return matches.sort((left, right) => right.score - left.score)
}

/**
 * Buckets matches into their sections, in the order each section first appears.
 *
 * Sectioned rather than left in one scored column: a launcher is read by scanning headings, and
 * a row under "Export" that appeared above one under "View" because it scored a little higher
 * would pull the eye out of the section it belongs to. Ranking still decides the order *inside* a
 * section, and the sections themselves follow the best match they hold - so the group a query
 * was really about still floats to the top.
 */
export function groupMatches(matches: readonly CommandMatch[]): Array<{ group: string; matches: CommandMatch[] }> {
  const order: string[] = []
  const buckets = new Map<string, CommandMatch[]>()
  for (const match of matches) {
    const group = match.command.group
    const bucket = buckets.get(group)
    if (bucket) {
      bucket.push(match)
      continue
    }
    buckets.set(group, [match])
    order.push(group)
  }
  // A section's rank is the best score it holds, so the most relevant section is listed first.
  order.sort((left, right) => (buckets.get(right)![0]?.score ?? 0) - (buckets.get(left)![0]?.score ?? 0))
  return order.map((group) => ({ group, matches: buckets.get(group)! }))
}
