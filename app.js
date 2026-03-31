const DB_NAME = 'mp3-player-db';
const STORE_NAME = 'tracks';
const audio = document.getElementById('audio');
const fileInput = document.getElementById('fileInput');
const playlistEl = document.getElementById('playlist');
const emptyStateEl = document.getElementById('emptyState');
const trackTitleEl = document.getElementById('trackTitle');
const trackInfoEl = document.getElementById('trackInfo');
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const seekBar = document.getElementById('seekBar');
const playBtn = document.getElementById('playBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const clearBtn = document.getElementById('clearBtn');
const coverArtImageEl = document.getElementById('coverArtImage');
const coverArtPlaceholderEl = document.getElementById('coverArtPlaceholder');

let db;
let tracks = [];
let currentIndex = -1;
let isSeeking = false;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveTrackRecord(record) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  await dbRequestToPromise(store.put(record));
}

async function getAllTrackRecords() {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const records = await dbRequestToPromise(store.getAll());
  return records.sort((a, b) => a.addedAt - b.addedAt);
}

async function clearTrackRecords() {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  await dbRequestToPromise(store.clear());
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function stripExtension(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function revokeTrackUrls() {
  tracks.forEach((track) => {
    if (track.url) URL.revokeObjectURL(track.url);
  });
}

function syncSafeToInt(bytes) {
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f);
}

function decodeLatin1(bytes) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

function findTerminator(bytes, offset, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let index = offset; index < bytes.length - 1; index += 1) {
      if (bytes[index] === 0x00 && bytes[index + 1] === 0x00) return index;
    }
    return -1;
  }

  for (let index = offset; index < bytes.length; index += 1) {
    if (bytes[index] === 0x00) return index;
  }
  return -1;
}

function bytesToDataUrl(bytes, mimeType) {
  const blob = new Blob([bytes], { type: mimeType || 'image/jpeg' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function extractId3Artwork(fileOrBlob) {
  try {
    const buffer = await fileOrBlob.slice(0, Math.min(fileOrBlob.size, 3 * 1024 * 1024)).arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes.length < 10 || decodeLatin1(bytes.slice(0, 3)) !== 'ID3') {
      return null;
    }

    const version = bytes[3];
    const flags = bytes[5];
    const tagSize = syncSafeToInt(bytes.slice(6, 10));
    let offset = 10;
    const tagEnd = Math.min(bytes.length, 10 + tagSize);

    if (flags & 0x40) {
      if (version === 3) {
        const extSize = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
        offset += extSize;
      } else if (version === 4) {
        const extSize = syncSafeToInt(bytes.slice(offset, offset + 4));
        offset += extSize;
      }
    }

    while (offset < tagEnd) {
      if (version === 2) {
        if (offset + 6 > tagEnd) break;
        const frameId = decodeLatin1(bytes.slice(offset, offset + 3));
        const frameSize = (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5];
        if (!frameId.trim() || frameSize <= 0) break;

        const frameStart = offset + 6;
        const frameEnd = Math.min(tagEnd, frameStart + frameSize);
        if (frameId === 'PIC') {
          const frameBytes = bytes.slice(frameStart, frameEnd);
          const encoding = frameBytes[0];
          const format = decodeLatin1(frameBytes.slice(1, 4)).trim();
          const mimeType = format === 'PNG' ? 'image/png' : 'image/jpeg';
          let imageOffset = 5;
          const descriptionEnd = findTerminator(frameBytes, imageOffset, encoding);
          imageOffset = descriptionEnd === -1
            ? imageOffset
            : descriptionEnd + ((encoding === 1 || encoding === 2) ? 2 : 1);
          return await bytesToDataUrl(frameBytes.slice(imageOffset), mimeType);
        }

        offset = frameEnd;
        continue;
      }

      if (offset + 10 > tagEnd) break;

      const frameId = decodeLatin1(bytes.slice(offset, offset + 4));
      const frameSize = version === 4
        ? syncSafeToInt(bytes.slice(offset + 4, offset + 8))
        : ((bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7]);

      if (!frameId.trim() || frameSize <= 0) break;

      const frameStart = offset + 10;
      const frameEnd = Math.min(tagEnd, frameStart + frameSize);

      if (frameId === 'APIC') {
        const frameBytes = bytes.slice(frameStart, frameEnd);
        const encoding = frameBytes[0];
        const mimeEnd = findTerminator(frameBytes, 1, 0);
        if (mimeEnd === -1) return null;
        const mimeType = decodeLatin1(frameBytes.slice(1, mimeEnd)) || 'image/jpeg';
        let imageOffset = mimeEnd + 2;
        const descriptionEnd = findTerminator(frameBytes, imageOffset, encoding);
        imageOffset = descriptionEnd === -1
          ? imageOffset
          : descriptionEnd + ((encoding === 1 || encoding === 2) ? 2 : 1);
        return await bytesToDataUrl(frameBytes.slice(imageOffset), mimeType);
      }

      offset = frameEnd;
    }
  } catch (error) {
    console.error('Unable to read album artwork', error);
  }

  return null;
}

function updateCoverArt(track) {
  if (track?.artworkDataUrl) {
    coverArtImageEl.src = track.artworkDataUrl;
    coverArtImageEl.hidden = false;
    coverArtPlaceholderEl.hidden = true;
    return;
  }

  coverArtImageEl.removeAttribute('src');
  coverArtImageEl.hidden = true;
  coverArtPlaceholderEl.hidden = false;
}

function updateNowPlaying() {
  if (currentIndex < 0 || !tracks[currentIndex]) {
    trackTitleEl.textContent = 'No track selected';
    trackInfoEl.textContent = 'Import MP3 files to start';
    currentTimeEl.textContent = '0:00';
    durationEl.textContent = '0:00';
    seekBar.value = 0;
    playBtn.textContent = '▶';
    updateCoverArt(null);
    return;
  }

  const track = tracks[currentIndex];
  trackTitleEl.textContent = track.title;
  trackInfoEl.textContent = `${formatTime(track.duration)} • ${track.filename}`;
  durationEl.textContent = formatTime(audio.duration || track.duration || 0);
  playBtn.textContent = audio.paused ? '▶' : '⏸';
  updateCoverArt(track);
}

function renderPlaylist() {
  playlistEl.innerHTML = '';
  emptyStateEl.hidden = tracks.length > 0;

  tracks.forEach((track, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `track-item${index === currentIndex ? ' active' : ''}`;
    button.innerHTML = `
      <p class="track-title">${track.title}</p>
      <div class="playlist-row">
        <span class="track-subline">${track.filename}</span>
        <span class="track-subline">${formatTime(track.duration)}</span>
      </div>
    `;
    button.addEventListener('click', () => playTrack(index));
    playlistEl.appendChild(button);
  });
}

async function fileToTrackRecord(file) {
  const tempUrl = URL.createObjectURL(file);
  const tempAudio = new Audio(tempUrl);

  const duration = await new Promise((resolve) => {
    tempAudio.addEventListener('loadedmetadata', () => resolve(tempAudio.duration || 0), { once: true });
    tempAudio.addEventListener('error', () => resolve(0), { once: true });
  });

  URL.revokeObjectURL(tempUrl);
  const artworkDataUrl = await extractId3Artwork(file);

  return {
    id: `${Date.now()}-${crypto.randomUUID()}`,
    title: stripExtension(file.name),
    filename: file.name,
    type: file.type || 'audio/mpeg',
    duration,
    addedAt: Date.now(),
    artworkDataUrl,
    blob: file,
  };
}

async function backfillArtwork(records) {
  const updates = [];

  for (const record of records) {
    if (!record.artworkDataUrl && record.blob) {
      const artworkDataUrl = await extractId3Artwork(record.blob);
      if (artworkDataUrl) {
        record.artworkDataUrl = artworkDataUrl;
        updates.push(saveTrackRecord(record));
      }
    }
  }

  if (updates.length > 0) {
    await Promise.all(updates);
  }
}

async function loadTracksFromDatabase() {
  revokeTrackUrls();
  let records = await getAllTrackRecords();
  await backfillArtwork(records);
  records = await getAllTrackRecords();

  tracks = records.map((record) => ({
    ...record,
    url: URL.createObjectURL(record.blob),
  }));

  if (tracks.length === 0) {
    currentIndex = -1;
    audio.removeAttribute('src');
    audio.load();
  } else if (currentIndex >= tracks.length || currentIndex === -1) {
    currentIndex = 0;
  }

  renderPlaylist();
  updateNowPlaying();
}

async function addFiles(files) {
  const selected = Array.from(files).filter((file) => file.type.startsWith('audio/') || file.name.toLowerCase().endsWith('.mp3'));
  for (const file of selected) {
    const record = await fileToTrackRecord(file);
    await saveTrackRecord(record);
  }
  await loadTracksFromDatabase();
  if (tracks.length > 0 && currentIndex === 0 && !audio.src) {
    playTrack(0, false);
  }
}

function playTrack(index, autoplay = true) {
  if (!tracks[index]) return;
  currentIndex = index;
  audio.src = tracks[index].url;
  audio.load();
  renderPlaylist();
  updateNowPlaying();
  if (autoplay) {
    audio.play().catch(() => {});
  }
}

function togglePlayPause() {
  if (!audio.src && tracks.length > 0) {
    playTrack(currentIndex >= 0 ? currentIndex : 0);
    return;
  }

  if (audio.paused) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
  updateNowPlaying();
}

function playNext() {
  if (tracks.length === 0) return;
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % tracks.length : 0;
  playTrack(nextIndex);
}

function playPrevious() {
  if (tracks.length === 0) return;
  const prevIndex = currentIndex > 0 ? currentIndex - 1 : tracks.length - 1;
  playTrack(prevIndex);
}

async function clearAllTracks() {
  audio.pause();
  revokeTrackUrls();
  await clearTrackRecords();
  tracks = [];
  currentIndex = -1;
  audio.removeAttribute('src');
  audio.load();
  renderPlaylist();
  updateNowPlaying();
}

fileInput.addEventListener('change', async (event) => {
  const { files } = event.target;
  if (!files || files.length === 0) return;
  await addFiles(files);
  event.target.value = '';
});

playBtn.addEventListener('click', togglePlayPause);
nextBtn.addEventListener('click', playNext);
prevBtn.addEventListener('click', playPrevious);
clearBtn.addEventListener('click', clearAllTracks);

seekBar.addEventListener('input', () => {
  isSeeking = true;
  const duration = audio.duration || 0;
  currentTimeEl.textContent = formatTime((duration * Number(seekBar.value)) / 100);
});

seekBar.addEventListener('change', () => {
  const duration = audio.duration || 0;
  audio.currentTime = (duration * Number(seekBar.value)) / 100;
  isSeeking = false;
});

audio.addEventListener('loadedmetadata', updateNowPlaying);
audio.addEventListener('play', updateNowPlaying);
audio.addEventListener('pause', updateNowPlaying);
audio.addEventListener('ended', playNext);
audio.addEventListener('timeupdate', () => {
  if (!isSeeking && Number.isFinite(audio.duration) && audio.duration > 0) {
    seekBar.value = String((audio.currentTime / audio.duration) * 100);
  }
  currentTimeEl.textContent = formatTime(audio.currentTime || 0);
  durationEl.textContent = formatTime(audio.duration || 0);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateNowPlaying();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

(async function init() {
  try {
    db = await openDatabase();
    await loadTracksFromDatabase();
  } catch (error) {
    trackInfoEl.textContent = 'Storage is not available in this browser mode.';
    console.error(error);
  }
})();
