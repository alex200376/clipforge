# Bundled media binaries

`electron-builder` copies this directory into the installed app as `resources/bin`, and
the main process resolves `ffmpeg`, `ffprobe`, `yt-dlp` and `gifski` from there.

Sources: FFmpeg from gyan.dev, yt-dlp from its GitHub releases, and gifski from
`gif.ski/gifski-<version>.zip` (gifski stopped attaching Windows builds to its GitHub
releases after 1.32.0, so the website zip is the only official Windows binary).

Populate it with:

```powershell
npm run prepare:binaries
```

The executables are gitignored; only this file is committed so the directory exists for
the packaging step.
