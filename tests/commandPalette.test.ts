import { describe, expect, it, vi } from 'vitest'

import { groupMatches, matchCommands, scoreCommand } from '../src/renderer/commands'
import type { Command } from '../src/renderer/commands'

const command = (id: string, title: string, group: string, keywords?: string[]): Command => ({
  id,
  title,
  group,
  keywords,
  enabled: true,
  run: vi.fn()
})

const commands: Command[] = [
  command('export.gif', 'Export GIF', 'Export', ['animated', 'gifski']),
  command('export.video', 'Export video', 'Export', ['mp4', 'h264']),
  command('view.output', 'Show output', 'View', ['result', 'preview']),
  command('view.settings', 'Open settings', 'View', ['preferences', 'theme']),
  command('media.load', 'Load media', 'Media', ['open', 'import', 'url'])
]

describe('ranking a command against a query', () => {
  it('scores an empty query the same for every command', () => {
    expect(scoreCommand('', commands[0]!)).toBe(0)
    expect(scoreCommand('   ', commands[3]!)).toBe(0)
  })

  it('ranks an exact title, then a prefix, then a contains', () => {
    expect(scoreCommand('export gif', commands[0]!)).toBe(4)
    expect(scoreCommand('export', commands[0]!)).toBe(3)
    expect(scoreCommand('gif', commands[0]!)).toBe(2)
  })

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(scoreCommand('  EXPORT  ', commands[0]!)).toBe(3)
  })

  it('finds a command by a keyword that does not appear in its title', () => {
    expect(scoreCommand('preferences', commands[3]!)).toBe(1.5)
  })

  it('falls back to an in-order subsequence match, below any substring', () => {
    // "exg" is not in "Export GIF", but the letters appear in order.
    expect(scoreCommand('exg', commands[0]!)).toBe(1)
    expect(scoreCommand('exg', commands[0]!)!).toBeLessThan(scoreCommand('gif', commands[0]!)!)
  })

  it('answers null when nothing matches at all', () => {
    expect(scoreCommand('zzzzz', commands[0]!)).toBeNull()
  })
})

describe('listing the commands a query answers', () => {
  it('shows everything, in authored order, for an empty query', () => {
    expect(matchCommands('', commands).map((match) => match.command.id)).toEqual([
      'export.gif',
      'export.video',
      'view.output',
      'view.settings',
      'media.load'
    ])
  })

  it('puts the best match first and drops the rest', () => {
    const ids = matchCommands('export', commands).map((match) => match.command.id)
    expect(ids).toEqual(['export.gif', 'export.video'])
  })

  it('keeps equal-scoring commands in the order they were given', () => {
    const ids = matchCommands('export', commands).map((match) => match.command.id)
    expect(ids[0]).toBe('export.gif')
    expect(ids[1]).toBe('export.video')
  })

  it('finds a command by keyword as well as title', () => {
    const ids = matchCommands('theme', commands).map((match) => match.command.id)
    expect(ids).toContain('view.settings')
  })
})

describe('grouping the matches', () => {
  it('sections the rows and leads with the most relevant section', () => {
    const groups = groupMatches(matchCommands('output', commands))
    expect(groups[0]!.group).toBe('View')
    expect(groups[0]!.matches.map((match) => match.command.id)).toEqual(['view.output'])
  })

  it('keeps authored order when nothing has been typed', () => {
    const groups = groupMatches(matchCommands('', commands))
    expect(groups.map((group) => group.group)).toEqual(['Export', 'View', 'Media'])
  })

  it('buckets a section together even when its rows are not adjacent in score order', () => {
    const groups = groupMatches(matchCommands('', commands))
    const exportGroup = groups.find((group) => group.group === 'Export')
    expect(exportGroup?.matches.map((match) => match.command.id)).toEqual(['export.gif', 'export.video'])
  })
})
