# Project Flux

A browser-based video editor in a single HTML file. Includes timeline editing, split A/V tracks, text/arrow annotations, MP4 export, and encrypted `.flux` project backup/import.

<img width="929" height="509" alt="ProjectFlux screenshot" src="https://github.com/user-attachments/assets/ed01b42f-cafc-4e4a-ab86-a4aff72c0480" />


## Features

- Import video and audio files directly in the browser (IndexedDB storage).
- Timeline editing with draggable clips and range delete.
- Split A/V to edit audio and video tracks separately.
- Annotations (text and arrows) with edit mode, drag/resize, and duration control.
- MP4 export using WebCodecs (Chrome/Edge recommended).
- Encrypted project export/import as `.flux` (PBKDF2 + AES‑GCM).

## Getting Started

1. Open `projectflux.html` in a modern browser (Chrome or Edge recommended).
2. Click **New Project** and give it a name.
3. Use **Library +** to add media files.
4. Click the **+** on any asset to add it to the timeline.

## Editing Basics

- **Play/Pause**: click the preview or press space.
- **Scrub**: click/drag in the timeline ruler.
- **Move clips**: click and drag a clip on the timeline.
- **Delete range**: drag to select a range, then press Delete/Backspace.
- **Split A/V**: select a video clip, click **Split A/V**.
- **Track targeting**: toggle **Video**/**Audio** to apply edits to one track.
- **Toggle panels**: use **Toggle Annotations** and **Toggle Timeline** to reclaim preview space.

## Annotations

1. Click **Edit Mode** to enter annotation editing.
2. Use **Add Pointer** or **Add Text** to place annotations.
3. Drag existing annotations to move them.
4. Drag the small handle on text to resize.
5. Adjust duration in the annotations list (seconds).
6. Press **Delete/Backspace** to remove a selected annotation (while in Edit Mode).

## Exporting

### MP4

1. Click **Export**.
2. The editor uses WebCodecs for encoding (Chrome/Edge required).

### Encrypted `.flux`

1. Click **Export .flux**.
2. Enter a password to encrypt the project and media.
3. A `.flux` file is downloaded.

### Import `.flux`

1. Click **Import .flux**.
2. Enter the password used at export.
3. The project is imported as a new project.

## Notes and Limits

- Storage is limited by your browser’s IndexedDB quota.
- Large multi‑GB projects may fail due to memory/quota limits.
- Export requires WebCodecs support (Chrome 94+ / Edge 94+).

## File Layout

- `projectflux.html` — the entire app.
- `README.md` — this file.
