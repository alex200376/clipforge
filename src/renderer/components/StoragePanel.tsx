import { useCallback, useEffect, useState } from 'react'

import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Checkbox } from './ui/checkbox'
import type { StorageReport, StorageTarget, UpdateState } from '../../shared/types'
import { formatBytes } from '../format'
import { useI18n } from '../i18n'

interface Props {
  /** The update state decides whether clearing the cache would delete a download in use. */
  update: UpdateState
  /** Whether the installer behind an update is kept once that update has been installed. */
  keepInstaller: boolean
  onKeepInstaller: (value: boolean) => void
  onNotice: (text: string) => void
}

/**
 * What the app is holding on disk.
 *
 * Two large things live outside the app folder and neither was ever visible: the scratch
 * folders each job makes under the system temp directory, and the updater's cache, which
 * holds a downloaded update plus the previous installer - about 700 MB for this app,
 * quietly, in a folder nobody opens. Showing the real sizes is most of the fix: the rest
 * is a button that reclaims them on request.
 *
 * The automatic side is elsewhere (folders are released as they are finished with,
 * leftovers from a crashed run are swept at startup, and an update's installer is cleared
 * as soon as that update has been installed), so this card is for the deliberate case:
 * the user wants the space back now - or wants the installer kept instead.
 */
export function StoragePanel({ update, keepInstaller, onKeepInstaller, onNotice }: Props): JSX.Element {
  const { t } = useI18n()
  const [report, setReport] = useState<StorageReport | null>(null)
  const [clearing, setClearing] = useState<StorageTarget | null>(null)

  const refresh = useCallback(async () => {
    try {
      setReport(await window.clipforge.storageStats())
    } catch {
      // A failed read leaves the figures as they were rather than showing zero, which
      // would read as "nothing to clear" and be wrong.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The figures move on their own: an update download adds hundreds of megabytes while
  // this page is open, so the cache size is re-read whenever the updater's state changes.
  // Saving the switch below clears the cache from the main process, so that counts too.
  useEffect(() => {
    void refresh()
  }, [refresh, update.status, keepInstaller])

  const clear = async (target: StorageTarget): Promise<void> => {
    setClearing(target)
    try {
      const next = await window.clipforge.clearStorage(target)
      setReport(next)
      if (next.refused === 'busy') onNotice(t('settings.storage.refusedBusy'))
      else if (next.refused === 'ready') onNotice(t('settings.storage.refusedReady'))
      else if ((next.cleared ?? 0) > 0) {
        // A folder that is still open is said so rather than counted as reclaimed: that
        // silence is what left invisible empty shells in a real temp folder.
        const freed = t('settings.storage.cleared', { size: formatBytes(next.cleared ?? 0) })
        onNotice(
          next.failed && next.failed > 0
            ? `${freed} ${t('settings.storage.inUse', { count: next.failed })}`
            : freed
        )
      } else if (next.failed && next.failed > 0) onNotice(t('settings.storage.inUse', { count: next.failed }))
      else onNotice(t('settings.storage.nothing'))
    } catch {
      onNotice(t('settings.storage.failed'))
    } finally {
      setClearing(null)
    }
  }

  const tempBytes = (report?.scratchBytes ?? 0) + (report?.installCacheBytes ?? 0)
  const hasTemp = tempBytes > 0
  const hasUpdates = (report?.updateBytes ?? 0) > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.storage.title')}</CardTitle>
        <CardDescription>{t('settings.storage.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="kv">
          <span>{t('settings.storage.temp')}</span>
          <span>
            {formatBytes(tempBytes)}
            {report && report.scratchCount > 0
              ? ` · ${
                  report.scratchCount === 1
                    ? t('settings.storage.folderOne')
                    : t('settings.storage.folders', { count: report.scratchCount })
                }`
              : ''}
          </span>
        </div>
        <div className="kv">
          <span>{t('settings.storage.updates')}</span>
          <span>{formatBytes(report?.updateBytes ?? 0)}</span>
        </div>

        <p className="muted">{t('settings.storage.updateNote')}</p>

        <label className="check-row">
          <Checkbox
            id="keep-update-installer"
            checked={keepInstaller}
            onCheckedChange={(checked) => onKeepInstaller(checked === true)}
          />
          <span>
            <strong>{t('settings.storage.keepInstaller')}</strong>
            <em>{t('settings.storage.keepInstallerHint')}</em>
          </span>
        </label>

        {report?.updateReady && <p className="muted">{t('settings.storage.readyNote')}</p>}
        {report?.busy && <p className="muted">{t('settings.storage.busyNote')}</p>}

        <div className="card-actions">
          <Button
            variant="secondary"
            disabled={!hasTemp || clearing !== null || report?.busy === true}
            onClick={() => void clear('scratch')}
          >
            {clearing === 'scratch' ? t('settings.storage.clearing') : t('settings.storage.clearTemp')}
          </Button>
          <Button
            variant="secondary"
            disabled={!hasUpdates || clearing !== null || report?.updateReady === true}
            onClick={() => void clear('updates')}
          >
            {clearing === 'updates' ? t('settings.storage.clearing') : t('settings.storage.clearUpdates')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
