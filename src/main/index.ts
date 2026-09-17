import { BrowserWindow, app, session, shell } from 'electron'

import { cancelActiveWork, registerIpc, trackWindowState } from './ipc'
import { handleMediaProtocol, registerMediaScheme } from './mediaProtocol'
import { iconPath, isDev, preloadEntry, rendererEntry } from './paths'

// Scheme privileges must be declared before the app is ready.
registerMediaScheme()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const icon = iconPath()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    // Small laptops and 720p screens are the target for the compact layout, so the
    // floor sits below the old 980x640: everything still fits, it just gets denser.
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#080d16',
    // Frameless: the renderer draws its own drag regions and window controls.
    // Windows still resizes a frameless window from its edges.
    frame: false,
    autoHideMenuBar: true,
    title: 'ClipForge',
    // Undefined would fall back to the Electron default; the packaged exe already
    // carries the .ico, this covers dev and other window decorations.
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: preloadEntry(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  trackWindowState(mainWindow)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev()) {
    void mainWindow.loadURL('http://localhost:5173')
  } else {
    void mainWindow.loadFile(rendererEntry())
  }
}

function applyContentSecurityPolicy(): void {
  if (isDev()) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; img-src 'self' data: clipforge:; media-src 'self' clipforge:; style-src 'self' 'unsafe-inline'; font-src 'self' data:"
        ]
      }
    })
  })
}

app.whenReady().then(() => {
  handleMediaProtocol()
  applyContentSecurityPolicy()
  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  cancelActiveWork()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
