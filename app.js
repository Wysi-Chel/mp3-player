const DB_NAME = 'mp3-player-db';
const STORE_NAME = 'tracks';
const audio = document.getElementById('audio');
const fileInput = document.getElementById('fileInput');
const playlistEl = document.getElementById('playlist');
const emptyStateEl = document.getElementById('emptyState');
const coverArtEl = document.querySelector('.cover-art');
const trackTitleEl = document.getElementById('trackTitle');
const trackInfoEl = document.getElementById('trackInfo');
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const seekBar = document.getElementById('seekBar');
const volumeBar = document.getElementById('volumeBar');
const playBtn = document.getElementById('playBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const clearBtn = document.getElementById('clearBtn');
const filterInput = document.getElementById('filterInput');
const filterModeSelect = document.getElementById('filterMode');
const sortOptionSelect = document.getElementById('sortOption');

let filterText = '';
let filterMode = 'auto';
let sortOption = 'added';
const shuffleBtn = document.getElementById('shuffleBtn');
const repeatBtn = document.getElementById('repeatBtn');

const LOCAL_STATE_KEY = 'mp3-player-state';

let db;
let tracks = [];
let currentIndex = -1;
let isSeeking = false;
let isShuffle = false;
let repeatMode = 'off'; // 'off' | 'one' | 'all'
let lastSavedTime = -1;

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

async function deleteTrackRecord(id) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  await dbRequestToPromise(store.delete(id));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function parseChapterInfo(value) {
  if (!value) return null;
  const chapterRegex = /chapter\s*#?\s*(\d+)/i;
  const shortRegex = /^(\d+)\b/;

  let match = value.match(chapterRegex);
  if (match) return Number(match[1]);

  match = value.match(shortRegex);
  if (match) return Number(match[1]);

  return null;
}

function matchesFilter(track) {
  const raw = filterText.trim().toLowerCase();
  if (!raw) return true;

  const title = track.title.toLowerCase();
  const filename = track.filename.toLowerCase();
  const chapter = parseChapterInfo(track.title) ?? parseChapterInfo(track.filename);

  const numericQuery = raw.replace(/^chapter\s*/i, '').trim();
  const isNumeric = /^\d+$/.test(numericQuery);
  const numericMatch = isNumeric && chapter === Number(numericQuery);
  const textMatch = title.includes(raw) || filename.includes(raw);

  if (filterMode === 'numeric') {
    return numericMatch;
  }

  if (filterMode === 'alphabetic') {
    return textMatch;
  }

  return numericMatch || textMatch;
}

function sortTracks(items) {
  const tracksCopy = [...items];

  switch (sortOption) {
    case 'title-asc':
      return tracksCopy.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    case 'title-desc':
      return tracksCopy.sort((a, b) => b.title.localeCompare(a.title, undefined, { numeric: true, sensitivity: 'base' }));
    case 'duration-asc':
      return tracksCopy.sort((a, b) => (a.duration || 0) - (b.duration || 0));
    case 'duration-desc':
      return tracksCopy.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    default:
      return tracksCopy;
  }
}

function loadPlayerState() {
  try {
    const raw = localStorage.getItem(LOCAL_STATE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (typeof state.volume === 'number') {
      volumeBar.value = state.volume;
      audio.volume = state.volume;
    }
    isShuffle = !!state.isShuffle;
    repeatMode = state.repeatMode || 'off';
    if (state.filterMode) {
      filterMode = state.filterMode;
      filterModeSelect.value = filterMode;
    }
    if (state.sortOption) {
      sortOption = state.sortOption;
      sortOptionSelect.value = sortOption;
    }
    return state;
  } catch {
    // ignore parse failures
  }
}

function savePlayerState(extra = {}) {
  const state = {
    volume: Number(volumeBar.value),
    isShuffle,
    repeatMode,
    filterMode,
    sortOption,
    lastTrackId: tracks[currentIndex]?.id || null,
    lastTime: audio.currentTime || 0,
    ...extra,
  };
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
}

function updateShuffleRepeatButtons() {
  shuffleBtn.classList.toggle('active', isShuffle);
  repeatBtn.textContent = repeatMode === 'off' ? '🔁' : repeatMode === 'one' ? '🔂' : '🔁';
  repeatBtn.classList.toggle('active', repeatMode !== 'off');
}

function cycleRepeatMode() {
  if (repeatMode === 'off') repeatMode = 'all';
  else if (repeatMode === 'all') repeatMode = 'one';
  else repeatMode = 'off';
  updateShuffleRepeatButtons();
  savePlayerState();
}

function stripExtension(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function revokeTrackUrls() {
  tracks.forEach((track) => {
    if (track.url) URL.revokeObjectURL(track.url);
  });
}

function updateNowPlaying() {
  if (currentIndex < 0 || !tracks[currentIndex]) {
    trackTitleEl.textContent = 'No track selected';
    trackInfoEl.textContent = 'Import MP3 files to start';
    coverArtEl.textContent = '♪';
    coverArtEl.style.background = 'linear-gradient(160deg, rgba(56, 189, 248, 0.25), rgba(34, 197, 94, 0.18))';
    currentTimeEl.textContent = '0:00';
    durationEl.textContent = '0:00';
    seekBar.value = 0;
    playBtn.textContent = '▶';
    return;
  }

  const track = tracks[currentIndex];
  trackTitleEl.textContent = track.title;
  trackInfoEl.textContent = `${formatTime(track.duration)} • ${track.filename}`;
  durationEl.textContent = formatTime(audio.duration || track.duration || 0);
  playBtn.textContent = audio.paused ? '▶' : '⏸';

  // Show profile / track info on the cover art block
  coverArtEl.textContent = track.title.charAt(0).toUpperCase();
  coverArtEl.style.background = 'linear-gradient(160deg, rgba(34, 197, 94, 0.35), rgba(56, 189, 248, 0.3))';
  coverArtEl.title = `${track.title} — ${track.filename}`;
}

function renderPlaylist() {
  playlistEl.innerHTML = '';

  let visibleTracks = tracks.filter(matchesFilter);
  visibleTracks = sortTracks(visibleTracks);

  emptyStateEl.hidden = visibleTracks.length > 0;

  if (visibleTracks.length === 0 && tracks.length > 0) {
    emptyStateEl.textContent = 'No matching chapter or track found.';
    emptyStateEl.hidden = false;
  } else {
    emptyStateEl.textContent = 'No songs yet. Tap (Add MP3 files) to import tracks.';
  }

  visibleTracks.forEach((track) => {
    const index = tracks.findIndex((t) => t.id === track.id);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `track-item${index === currentIndex ? ' active' : ''}`;
    item.innerHTML = `
      <div>
        <p class="track-title">${track.title}</p>
        <div class="playlist-row">
          <span class="track-subline">${track.filename}</span>
          <span class="track-subline">${formatTime(track.duration)}</span>
        </div>
      </div>
    `;
    item.addEventListener('click', () => playTrack(index));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-track';
    removeBtn.title = 'Remove track';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      removeTrack(index);
    });

    const wrapper = document.createElement('li');
    wrapper.className = 'playlist-item';
    wrapper.appendChild(item);
    wrapper.appendChild(removeBtn);
    playlistEl.appendChild(wrapper);
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

  return {
    id: `${Date.now()}-${crypto.randomUUID()}`,
    title: stripExtension(file.name),
    filename: file.name,
    type: file.type || 'audio/mpeg',
    duration,
    addedAt: Date.now(),
    blob: file,
  };
}

async function loadTracksFromDatabase() {
  revokeTrackUrls();
  const records = await getAllTrackRecords();
  tracks = records.map((record) => ({
    ...record,
    url: URL.createObjectURL(record.blob),
  }));

  const savedState = loadPlayerState() || {}; // reapply saved config and last track position

  if (tracks.length === 0) {
    currentIndex = -1;
    audio.removeAttribute('src');
    audio.load();
  } else {
    if (savedState.lastTrackId) {
      const savedIndex = tracks.findIndex((t) => t.id === savedState.lastTrackId);
      if (savedIndex !== -1) currentIndex = savedIndex;
      else currentIndex = 0;
    } else if (currentIndex < 0 || currentIndex >= tracks.length) {
      currentIndex = 0;
    }

    const lastTime = Number(savedState.lastTime || 0);
    if (lastTime > 0 && lastTime < (tracks[currentIndex]?.duration || Number.MAX_VALUE)) {
      audio.currentTime = lastTime;
    }
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
  const track = tracks[index];
  audio.src = track.url;
  audio.load();

  const savedState = loadPlayerState();
  if (savedState?.lastTrackId === track.id && Number(savedState.lastTime) > 0) {
    audio.currentTime = Math.min(Number(savedState.lastTime), track.duration || Number.MAX_VALUE);
  }

  renderPlaylist();
  updateNowPlaying();
  savePlayerState();

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

  if (repeatMode === 'one' && currentIndex >= 0) {
    playTrack(currentIndex);
    return;
  }

  let nextIndex;
  if (isShuffle) {
    if (tracks.length === 1) {
      nextIndex = 0;
    } else {
      nextIndex = currentIndex;
      while (nextIndex === currentIndex) {
        nextIndex = Math.floor(Math.random() * tracks.length);
      }
    }
  } else {
    nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
    if (nextIndex >= tracks.length) {
      if (repeatMode === 'all') {
        nextIndex = 0;
      } else {
        audio.pause();
        return;
      }
    }
  }

  playTrack(nextIndex);
}

function playPrevious() {
  if (tracks.length === 0) return;

  if (repeatMode === 'one' && currentIndex >= 0) {
    playTrack(currentIndex);
    return;
  }

  let prevIndex;
  if (isShuffle) {
    if (tracks.length === 1) {
      prevIndex = 0;
    } else {
      prevIndex = currentIndex;
      while (prevIndex === currentIndex) {
        prevIndex = Math.floor(Math.random() * tracks.length);
      }
    }
  } else {
    prevIndex = currentIndex > 0 ? currentIndex - 1 : tracks.length - 1;
  }

  playTrack(prevIndex);
}

async function clearAllTracks() {
  audio.pause();
  revokeTrackUrls();
  await clearTrackRecords();
  tracks = [];
  currentIndex = -1;
  savePlayerState({ lastTrackId: null, lastTime: 0 });
  audio.removeAttribute('src');
  audio.load();
  renderPlaylist();
  updateNowPlaying();
}

async function removeTrack(index) {
  if (!tracks[index]) return;
  const removedTrack = tracks[index];

  await deleteTrackRecord(removedTrack.id);
  const wasCurrent = index === currentIndex;

  await loadTracksFromDatabase();

  if (tracks.length > 0 && wasCurrent) {
    currentIndex = Math.min(index, tracks.length - 1);
    playTrack(currentIndex, false);
  } else {
    updateNowPlaying();
  }
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

filterInput.addEventListener('input', () => {
  filterText = filterInput.value;
  renderPlaylist();
});

filterModeSelect.addEventListener('change', () => {
  filterMode = filterModeSelect.value;
  renderPlaylist();
});

sortOptionSelect.addEventListener('change', () => {
  sortOption = sortOptionSelect.value;
  renderPlaylist();
});

volumeBar.addEventListener('input', () => {
  audio.volume = Number(volumeBar.value);
  savePlayerState();
});

shuffleBtn.addEventListener('click', () => {
  isShuffle = !isShuffle;
  updateShuffleRepeatButtons();
  savePlayerState();
});

repeatBtn.addEventListener('click', cycleRepeatMode);

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

  const currentSecond = Math.floor(audio.currentTime);
  if (currentSecond !== lastSavedTime) {
    lastSavedTime = currentSecond;
    savePlayerState();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateNowPlaying();
});

window.addEventListener('dragover', (event) => {
  event.preventDefault();
});

window.addEventListener('drop', async (event) => {
  event.preventDefault();
  if (event.dataTransfer?.files?.length) {
    await addFiles(event.dataTransfer.files);
  }
});

document.addEventListener('keydown', (event) => {
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT'].includes(active.tagName)) return;

  if (event.code === 'Space') {
    event.preventDefault();
    togglePlayPause();
  } else if (event.code === 'ArrowRight') {
    event.preventDefault();
    playNext();
  } else if (event.code === 'ArrowLeft') {
    event.preventDefault();
    playPrevious();
  } else if (event.code === 'ArrowUp') {
    event.preventDefault();
    volumeBar.value = Math.min(1, Number(volumeBar.value) + 0.1).toFixed(2);
    audio.volume = Number(volumeBar.value);
    savePlayerState();
  } else if (event.code === 'ArrowDown') {
    event.preventDefault();
    volumeBar.value = Math.max(0, Number(volumeBar.value) - 0.1).toFixed(2);
    audio.volume = Number(volumeBar.value);
    savePlayerState();
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

(async function init() {
  try {
    db = await openDatabase();
    loadPlayerState();
    await loadTracksFromDatabase();
    updateShuffleRepeatButtons();
  } catch (error) {
    trackInfoEl.textContent = 'Storage is not available in this browser mode.';
    console.error(error);
  }
})();
