import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { useI18n } from '../i18n'
import { groupMatches, matchCommands } from '../commands'
import type { Command } from '../commands'

interface Props {
  open: boolean
  /** Every action the app can run from here, already translated and in authored order. */
  commands: Command[]
  onClose: () => void
}

/** One renderable row: a section heading, or a runnable command. */
type Row =
  | { kind: 'header'; group: string }
  | { kind: 'item'; command: Command; index: number }

/**
 * The keyboard launcher, opened with `Ctrl`/`Cmd`+`K`.
 *
 * Everything the workspace can do is reachable from here, so a user who knows the name of an
 * action does not have to find the panel that happens to hold it - and neither does a keyboard
 * user, who can otherwise only tab through whichever controls are in view. It is a dialog on the
 * same Radix primitive as the shortcut sheet and the frame comparison, so focus is trapped while
 * it is open and handed back where it came from when it closes.
 *
 * The list is sectioned (see `groupMatches`) but navigated as one flat column: the arrow keys walk
 * through the rows in the order they are drawn, which is the only order a user can see.
 */
export function CommandPalette({ open, commands, onClose }: Props): JSX.Element | null {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement | null>(null)

  const rows = useMemo<Row[]>(() => {
    const built: Row[] = []
    let index = 0
    for (const section of groupMatches(matchCommands(query, commands))) {
      built.push({ kind: 'header', group: section.group })
      for (const match of section.matches) {
        built.push({ kind: 'item', command: match.command, index })
        index += 1
      }
    }
    return built
  }, [query, commands])

  const items = useMemo(
    () => rows.filter((row): row is Extract<Row, { kind: 'item' }> => row.kind === 'item').map((row) => row.command),
    [rows]
  )

  // A new query re-ranks the list, so the highlight goes back to the top rather than
  // pointing at whatever now happens to sit at the old index.
  useEffect(() => {
    setActive(0)
  }, [query])

  // Keep the highlighted row on screen as the arrows walk past the fold.
  useEffect(() => {
    if (!open) return
    const element = listRef.current?.querySelector<HTMLElement>(`[data-command-index="${active}"]`)
    element?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  if (!open) return null

  const chosen = items.length > 0 ? Math.min(active, items.length - 1) : -1

  const run = (command: Command): void => {
    if (!command.enabled) return
    onClose()
    command.run()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (items.length > 0) setActive((current) => (current + 1) % items.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (items.length > 0) setActive((current) => (current - 1 + items.length) % items.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const command = items[chosen]
      if (command) run(command)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        className="w-[min(620px,94vw)] gap-3 p-0"
        aria-describedby={undefined}
        onOpenAutoFocus={() => setQuery('')}
      >
        <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-dim" aria-hidden />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.title')}
            aria-controls="command-list"
            role="combobox"
            aria-expanded
            className="h-8 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0"
          />
        </div>

        {items.length === 0 ? (
          <p className="px-4 pt-1 pb-5 text-sm text-dim">{t('palette.empty')}</p>
        ) : (
          <ul
            id="command-list"
            ref={listRef}
            role="listbox"
            aria-label={t('palette.title')}
            data-slot="command-list"
            className="flex max-h-[52vh] min-h-0 flex-col overflow-y-auto px-2 pb-2"
          >
            {rows.map((row) =>
              row.kind === 'header' ? (
                <li
                  key={`header-${row.group}`}
                  data-slot="command-group"
                  className="px-2 pt-3 pb-1 text-xs font-medium tracking-wide text-dim uppercase"
                >
                  {row.group}
                </li>
              ) : (
                <li key={row.command.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={row.index === chosen}
                    disabled={!row.command.enabled}
                    data-command-index={row.index}
                    onMouseMove={() => setActive(row.index)}
                    onClick={() => run(row.command)}
                    className={`flex w-full items-center justify-between gap-4 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                      row.index === chosen ? 'bg-accent text-accent-foreground' : 'text-foreground'
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <span className="truncate">{row.command.title}</span>
                  </button>
                </li>
              )
            )}
          </ul>
        )}

        <div className="border-t border-border px-4 py-2 text-xs text-dim">{t('palette.hint')}</div>
      </DialogContent>
    </Dialog>
  )
}
