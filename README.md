# MP3 Player for iPhone

This is an installable web app for iPhone and iPad.

## What it does
- Import MP3 or other audio files from your device
- Save your playlist locally with IndexedDB
- Play, pause, skip, seek, and adjust volume
- Install to the Home Screen as a standalone app

## How to use it on iPhone
1. Upload these files to any static hosting service that serves HTTPS, such as GitHub Pages, Netlify, or Vercel.
2. Open the hosted URL in Safari on your iPhone.
3. Tap Share, then Add to Home Screen.
4. Turn on Open as Web App if Safari shows that option.
5. Tap Add.

## Files
- `index.html`
- `styles.css`
- `app.js`
- `manifest.webmanifest`
- `sw.js`
- `icons/`

## Notes
- This app stores imported tracks locally in the browser storage for that device.
- Browser storage can be cleared by iOS in low-storage situations.
- For a full App Store style native app, this can be converted to SwiftUI later.
