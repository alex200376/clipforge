import { createRoot } from 'react-dom/client'

import { App } from './App'
import { I18nProvider } from './i18n'
import './styles.css'

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root')
  if (!container) throw new Error('ClipForge root container is missing')

  // Settings are read before the first paint: the saved language, theme and export
  // defaults must be in place from the start, otherwise a custom theme flashes the
  // default palette behind the first frame.
  const settings = await window.clipforge.getSettings().catch(() => null)
  document.documentElement.dataset.theme = settings?.theme ?? 'midnight'
  const root = createRoot(container)

  // Deliberately no StrictMode: its double-invoked effects would spawn duplicate
  // ffmpeg preview and filmstrip jobs on every mount.
  root.render(
    <I18nProvider initialLanguage={settings?.language ?? 'en'}>
      <App initialSettings={settings ?? undefined} />
    </I18nProvider>
  )
}

void bootstrap()
