(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || '';
  const manifestEndpoints = [meta('radar-manifest'), meta('radar-manifest-fallback')].filter(Boolean);
  const FIVE_MINUTES = 300;
  const IST_OFFSET_SECONDS = 5.5 * 3600;
  const DEFAULT_BOUNDS = { south: 0, west: 61.875, north: 40.979898, east: 106.875 };

  const state = {
    manifest: null,
    manifestUrl: '',
    manifestBase: '',
    frames: [],
    frameByTime: new Map(),
    timeline: [],
    index: 0,
    layers: [],
    opacity: Number(localStorage.getItem('indiaRadarOpacity') || 82) / 100,
    playing: false,
    playTimer: null,
    playStart: 0,
    playEnd: 0,
    renderToken: 0,
    preloaded: new Map(),
    monthUrls: new Map(),
    loadedMonths: new Set(),
    loadingMonths: new Map(),
    refreshing: false,
    scrubTimer: null,
    toastTimer: null,
    userMarker: null,
  };

  if (!window.L) {
    showFatal('The map library could not be loaded. Check your connection and reload.');
    return;
  }

  const map = L.map('map', {
    center: [22.8, 79.2],
    zoom: 4,
    minZoom: 3,
    maxZoom: 10,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    zoomControl: false,
    attributionControl: true,
  });

  map.createPane('radarPane');
  map.getPane('radarPane').style.zIndex = 410;
  map.getPane('radarPane').style.pointerEvents = 'none';
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  const controls = {
    feedStatus: $('#feedStatus'),
    headerTime: $('#headerTime'),
    mapLoading: $('#mapLoading'),
    loadingText: $('#loadingText'),
    selectedTime: $('#selectedTime'),
    selectedDate: $('#selectedDate'),
    frameKind: $('#frameKind'),
    latestButton: $('#latestButton'),
    previousButton: $('#previousButton'),
    playButton: $('#playButton'),
    nextButton: $('#nextButton'),
    timeRange: $('#timeRange'),
    rangeStart: $('#rangeStart'),
    rangeEnd: $('#rangeEnd'),
    dateButton: $('#dateButton'),
    dateButtonLabel: $('#dateButtonLabel'),
    datePicker: $('#datePicker'),
    archiveSummary: $('#archiveSummary'),
    fitButton: $('#fitButton'),
    locateButton: $('#locateButton'),
    aboutButton: $('#aboutButton'),
    aboutDialog: $('#aboutDialog'),
    opacityRange: $('#opacityRange'),
    opacityOutput: $('#opacityOutput'),
    toast: $('#toast'),
  };

  controls.opacityRange.value = String(Math.round(state.opacity * 100));
  controls.opacityOutput.value = `${Math.round(state.opacity * 100)}%`;

  function validManifest(payload) {
    return payload && payload.schema_version === 1 && payload.bounds && Array.isArray(payload.frames);
  }

  function baseFromManifestUrl(url) {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/[^/]+$/, '/');
    return parsed.href;
  }

  async function fetchJson(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const separator = url.includes('?') ? '&' : '?';
      const response = await fetch(`${url}${separator}_=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function firstUsableManifest() {
    let lastError = null;
    for (const [index, endpoint] of manifestEndpoints.entries()) {
      try {
        const payload = await fetchJson(endpoint, index === 0 ? 6000 : 15000);
        if (!validManifest(payload)) throw new Error('invalid manifest structure');
        return { payload, endpoint };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('no radar manifest configured');
  }

  function mergeFrames(frames) {
    for (const frame of frames || []) {
      const time = Number(frame.time);
      if (!Number.isFinite(time) || !frame.url) continue;
      state.frameByTime.set(time, { ...frame, time });
    }
    state.frames = [...state.frameByTime.values()].sort((a, b) => a.time - b.time);
  }

  function rebuildTimeline(preserveTime = null) {
    if (!state.frames.length || !state.manifest) return;
    const first = Number(state.manifest.first_time ?? state.frames[0].time);
    const last = Number(state.manifest.latest_time ?? state.frames[state.frames.length - 1].time);
    state.timeline = [];
    for (let time = first; time <= last; time += FIVE_MINUTES) state.timeline.push(time);

    controls.timeRange.max = String(Math.max(0, state.timeline.length - 1));
    const target = preserveTime ?? last;
    state.index = closestTimelineIndex(target);
    controls.timeRange.value = String(state.index);
    controls.rangeStart.textContent = shortRangeLabel(first);
    controls.rangeEnd.textContent = shortRangeLabel(last);
    updateArchiveSummary();
  }

  function closestTimelineIndex(epoch) {
    if (!state.timeline.length) return 0;
    const raw = Math.round((epoch - state.timeline[0]) / FIVE_MINUTES);
    return Math.max(0, Math.min(state.timeline.length - 1, raw));
  }

  function frameBracket(epoch) {
    let low = 0;
    let high = state.frames.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (state.frames[mid].time === epoch) return { before: state.frames[mid], after: null, ratio: 0 };
      if (state.frames[mid].time < epoch) low = mid + 1;
      else high = mid - 1;
    }
    const before = state.frames[Math.max(0, high)];
    const after = state.frames[Math.min(state.frames.length - 1, low)];
    if (!before || !after || before.time === after.time || epoch <= before.time) {
      return { before: before || after, after: null, ratio: 0 };
    }
    const ratio = (epoch - before.time) / (after.time - before.time);
    return { before, after, ratio: Math.max(0, Math.min(1, ratio)) };
  }

  function usableBracket(bracket, epoch) {
    if (!bracket?.before) return false;
    if (!bracket.after) {
      return Math.abs(epoch - bracket.before.time) <= FIVE_MINUTES;
    }
    const sourceInterval = Number(state.manifest?.source_interval_seconds || 600);
    return bracket.after.time - bracket.before.time <= sourceInterval * 1.6;
  }

  async function ensureFramesForEpoch(epoch) {
    let bracket = frameBracket(epoch);
    if (usableBracket(bracket, epoch)) return bracket;

    const months = new Set([monthKey(epoch)]);
    const date = new Date(epoch * 1000);
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
    const nextMonthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
    if (epoch - monthStart < 1800) months.add(monthKey(monthStart - 1));
    if (nextMonthStart - epoch < 1800) months.add(monthKey(nextMonthStart));
    await Promise.all([...months].map(loadMonth));
    bracket = frameBracket(epoch);
    return usableBracket(bracket, epoch) ? bracket : null;
  }

  function frameUrl(frame) {
    return new URL(frame.url, state.manifestBase).href;
  }

  function monthManifestUrl(month, relative) {
    const manifestUrl = new URL(state.manifestUrl);
    if (manifestUrl.pathname.endsWith('.php')) {
      manifestUrl.searchParams.set('month', month);
      return manifestUrl.href;
    }
    return new URL(relative, state.manifestBase).href;
  }

  function preload(url) {
    if (!url) return Promise.resolve(false);
    if (state.preloaded.has(url)) return state.preloaded.get(url);
    const promise = new Promise((resolve) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = url;
    });
    state.preloaded.set(url, promise);
    if (state.preloaded.size > 18) {
      const firstKey = state.preloaded.keys().next().value;
      state.preloaded.delete(firstKey);
    }
    return promise;
  }

  function leafletBounds() {
    const bounds = state.manifest?.bounds || DEFAULT_BOUNDS;
    return [[bounds.south, bounds.west], [bounds.north, bounds.east]];
  }

  async function renderIndex(index, options = {}) {
    if (!state.timeline.length) return;
    const clamped = Math.max(0, Math.min(state.timeline.length - 1, Number(index)));
    state.index = clamped;
    controls.timeRange.value = String(clamped);
    const epoch = state.timeline[clamped];
    const token = ++state.renderToken;
    const bracket = await ensureFramesForEpoch(epoch);
    if (token !== state.renderToken) return;
    if (!bracket) {
      updateTimeLabels(epoch, { after: null });
      controls.frameKind.textContent = 'No source frame';
      controls.frameKind.dataset.kind = 'blend';
      state.layers.forEach((layer) => map.removeLayer(layer));
      state.layers = [];
      return;
    }

    updateTimeLabels(epoch, bracket);
    const beforeUrl = frameUrl(bracket.before);
    const afterUrl = bracket.after ? frameUrl(bracket.after) : '';
    const loaded = await Promise.all([preload(beforeUrl), afterUrl ? preload(afterUrl) : true]);
    if (token !== state.renderToken) return;
    if (!loaded[0]) {
      showToast('That radar frame could not be loaded.');
      return;
    }

    const newLayers = [];
    const beforeOpacity = bracket.after ? state.opacity * (1 - bracket.ratio) : state.opacity;
    const beforeLayer = L.imageOverlay(beforeUrl, leafletBounds(), {
      pane: 'radarPane',
      opacity: beforeOpacity,
      interactive: false,
      alt: `Radar composite at ${formatUtc(bracket.before.time)}`,
    }).addTo(map);
    newLayers.push(beforeLayer);

    if (bracket.after && loaded[1]) {
      const afterLayer = L.imageOverlay(afterUrl, leafletBounds(), {
        pane: 'radarPane',
        opacity: state.opacity * bracket.ratio,
        interactive: false,
        alt: `Radar composite at ${formatUtc(bracket.after.time)}`,
      }).addTo(map);
      newLayers.push(afterLayer);
    }

    const oldLayers = state.layers;
    state.layers = newLayers;
    requestAnimationFrame(() => oldLayers.forEach((layer) => map.removeLayer(layer)));

    if (options.prefetch !== false) prefetchNeighbours(clamped);
  }

  function prefetchNeighbours(index) {
    for (const offset of [-2, -1, 1, 2]) {
      const epoch = state.timeline[index + offset];
      if (!epoch) continue;
      const bracket = frameBracket(epoch);
      if (bracket.before) preload(frameUrl(bracket.before));
      if (bracket.after) preload(frameUrl(bracket.after));
    }
  }

  function formatParts(epoch) {
    const date = new Date(epoch * 1000);
    const ist = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
    const istDate = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    }).format(date);
    const utc = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
    return { ist, istDate, utc };
  }

  function formatUtc(epoch) {
    return new Date(epoch * 1000).toISOString().slice(11, 16) + ' UTC';
  }

  function shortRangeLabel(epoch) {
    const date = new Date(epoch * 1000);
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  function updateTimeLabels(epoch, bracket) {
    const parts = formatParts(epoch);
    controls.selectedTime.textContent = `${parts.ist} IST`;
    controls.selectedDate.textContent = `${parts.istDate} · ${parts.utc} UTC`;
    controls.headerTime.textContent = `${parts.ist} IST`;
    const isBlend = Boolean(bracket.after && bracket.ratio > 0 && bracket.ratio < 1);
    controls.frameKind.textContent = isBlend ? '5-min blend' : 'Source frame';
    controls.frameKind.dataset.kind = isBlend ? 'blend' : 'source';
    const latest = state.index === state.timeline.length - 1;
    controls.latestButton.classList.toggle('is-latest', latest);
    controls.latestButton.textContent = latest ? 'Live' : 'Latest';
    controls.dateButtonLabel.textContent = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
    }).format(new Date(epoch * 1000));
  }

  function updateFeedStatus() {
    if (!state.frames.length) return setFeedStatus('error', 'No data');
    const latest = state.frames[state.frames.length - 1].time;
    const ageMinutes = Math.max(0, (Date.now() / 1000 - latest) / 60);
    if (ageMinutes <= 25) setFeedStatus('live', 'Live');
    else if (ageMinutes <= 90) setFeedStatus('delayed', `${Math.round(ageMinutes)}m old`);
    else setFeedStatus('error', 'Archive');
  }

  function setFeedStatus(kind, text) {
    controls.feedStatus.dataset.state = kind;
    controls.feedStatus.querySelector('span').textContent = text;
  }

  function updateArchiveSummary() {
    if (!state.frames.length || !state.manifest) return;
    const first = Number(state.manifest.first_time ?? state.frames[0].time);
    const last = Number(state.manifest.latest_time ?? state.frames[state.frames.length - 1].time);
    const hours = Math.max(0, (last - first) / 3600);
    const sourceFrames = Number(state.manifest.frame_count ?? state.frames.length).toLocaleString('en-GB');
    controls.archiveSummary.textContent = hours < 48
      ? `${sourceFrames} source frames · ${hours.toFixed(hours < 10 ? 1 : 0)} h archived`
      : `${sourceFrames} source frames · ${Math.round(hours / 24)} days archived`;
  }

  async function refreshManifest({ initial = false } = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    const selectedEpoch = state.timeline[state.index] || null;
    const wasLatest = !state.timeline.length || state.index >= state.timeline.length - 2;
    try {
      const result = await firstUsableManifest();
      state.manifest = result.payload;
      state.manifestUrl = result.endpoint;
      state.manifestBase = baseFromManifestUrl(result.endpoint);
      mergeFrames(result.payload.frames);
      state.monthUrls.clear();
      for (const month of result.payload.months || []) state.monthUrls.set(month.month, month.url);
      if (!state.frames.length) throw new Error('the radar archive contains no frames yet');
      controls.datePicker.min = dateInIst(Number(result.payload.first_time));
      controls.datePicker.max = dateInIst(Number(result.payload.latest_time));
      if (initial) controls.datePicker.value = controls.datePicker.max;
      rebuildTimeline(wasLatest ? null : selectedEpoch);
      updateFeedStatus();
      await renderIndex(state.index);
      controls.mapLoading.hidden = true;
      if (initial) fitIndia();
    } catch (error) {
      setFeedStatus('error', 'Offline');
      if (initial) showFatal(`Radar data are temporarily unavailable. ${error.message || error}`);
    } finally {
      state.refreshing = false;
    }
  }

  function monthKey(epoch) {
    const date = new Date(epoch * 1000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function dateInIst(epoch) {
    return new Date((epoch + IST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
  }

  async function loadMonth(month) {
    if (state.loadedMonths.has(month)) return true;
    if (state.loadingMonths.has(month)) return state.loadingMonths.get(month);
    const relative = state.monthUrls.get(month);
    if (!relative) return false;
    const preserveTime = state.timeline[state.index] || null;
    const promise = (async () => {
      controls.loadingText.textContent = `Loading ${month}…`;
      controls.mapLoading.hidden = false;
      try {
        const payload = await fetchJson(monthManifestUrl(month, relative));
        if (!payload || !Array.isArray(payload.frames)) throw new Error('invalid month manifest');
        mergeFrames(payload.frames);
        state.loadedMonths.add(month);
        rebuildTimeline(preserveTime);
        return true;
      } catch (error) {
        showToast(`Could not load ${month}.`);
        return false;
      } finally {
        state.loadingMonths.delete(month);
        controls.mapLoading.hidden = true;
        controls.loadingText.textContent = 'Loading radar archive…';
      }
    })();
    state.loadingMonths.set(month, promise);
    return promise;
  }

  async function chooseDate(value) {
    if (!value) return;
    const startUtc = Date.parse(`${value}T00:00:00+05:30`) / 1000;
    const endUtc = startUtc + 86400;
    await Promise.all([...new Set([monthKey(startUtc), monthKey(endUtc - 1)])].map(loadMonth));
    const firstFrame = state.frames.find((frame) => frame.time >= startUtc && frame.time < endUtc);
    if (!firstFrame) {
      showToast('No archived radar frame is available for that date.');
      return;
    }
    pausePlayback();
    await renderIndex(closestTimelineIndex(firstFrame.time));
  }

  function step(delta) {
    pausePlayback();
    renderIndex(state.index + delta);
  }

  function startPlayback() {
    if (state.timeline.length < 2) return;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const windowSteps = 24; // two hours at five-minute positions
    if (state.index >= state.timeline.length - 2) {
      state.playEnd = state.timeline.length - 1;
      state.playStart = Math.max(0, state.playEnd - windowSteps);
      state.index = state.playStart;
    } else {
      state.playStart = Math.max(0, state.index - Math.floor(windowSteps / 2));
      state.playEnd = Math.min(state.timeline.length - 1, state.playStart + windowSteps);
    }
    state.playing = true;
    controls.playButton.setAttribute('aria-pressed', 'true');
    controls.playButton.setAttribute('aria-label', 'Pause radar animation');
    renderIndex(state.index);
    state.playTimer = setInterval(() => {
      const next = state.index >= state.playEnd ? state.playStart : state.index + 1;
      renderIndex(next);
    }, reducedMotion ? 1200 : 650);
  }

  function pausePlayback() {
    state.playing = false;
    clearInterval(state.playTimer);
    state.playTimer = null;
    controls.playButton.setAttribute('aria-pressed', 'false');
    controls.playButton.setAttribute('aria-label', 'Play radar animation');
  }

  function togglePlayback() {
    if (state.playing) pausePlayback();
    else startPlayback();
  }

  function fitIndia() {
    const mobile = matchMedia('(max-width: 640px)').matches;
    map.fitBounds([[6.2, 67.2], [37.6, 98.6]], {
      paddingTopLeft: [16, 76],
      paddingBottomRight: [16, mobile ? 182 : 178],
      animate: true,
    });
  }

  function locateUser() {
    if (!navigator.geolocation) return showToast('Location is not available in this browser.');
    controls.locateButton.disabled = true;
    navigator.geolocation.getCurrentPosition((position) => {
      controls.locateButton.disabled = false;
      const latlng = [position.coords.latitude, position.coords.longitude];
      if (state.userMarker) state.userMarker.setLatLng(latlng);
      else state.userMarker = L.circleMarker(latlng, {
        radius: 7, color: '#fff', weight: 3, fillColor: '#e87419', fillOpacity: 1,
      }).addTo(map).bindTooltip('Your location');
      map.setView(latlng, Math.max(map.getZoom(), 7), { animate: true });
    }, (error) => {
      controls.locateButton.disabled = false;
      showToast(error.code === 1 ? 'Location permission was not granted.' : 'Your location could not be found.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 });
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    controls.toast.textContent = message;
    controls.toast.classList.add('is-visible');
    state.toastTimer = setTimeout(() => controls.toast.classList.remove('is-visible'), 4200);
  }

  function showFatal(message) {
    controls.loadingText.textContent = message;
    controls.mapLoading.hidden = false;
  }

  controls.timeRange.addEventListener('input', () => {
    pausePlayback();
    clearTimeout(state.scrubTimer);
    const target = Number(controls.timeRange.value);
    state.scrubTimer = setTimeout(() => renderIndex(target), 120);
  });
  controls.timeRange.addEventListener('change', () => {
    clearTimeout(state.scrubTimer);
    renderIndex(Number(controls.timeRange.value));
  });
  controls.previousButton.addEventListener('click', () => step(-1));
  controls.nextButton.addEventListener('click', () => step(1));
  controls.playButton.addEventListener('click', togglePlayback);
  controls.latestButton.addEventListener('click', () => {
    pausePlayback();
    renderIndex(state.timeline.length - 1);
  });
  controls.fitButton.addEventListener('click', fitIndia);
  controls.locateButton.addEventListener('click', locateUser);
  controls.aboutButton.addEventListener('click', () => controls.aboutDialog.showModal());
  controls.opacityRange.addEventListener('input', () => {
    state.opacity = Number(controls.opacityRange.value) / 100;
    localStorage.setItem('indiaRadarOpacity', String(controls.opacityRange.value));
    controls.opacityOutput.value = `${controls.opacityRange.value}%`;
    renderIndex(state.index, { prefetch: false });
  });
  controls.dateButton.addEventListener('click', () => {
    if (typeof controls.datePicker.showPicker === 'function') controls.datePicker.showPicker();
    else controls.datePicker.click();
  });
  controls.datePicker.addEventListener('change', () => chooseDate(controls.datePicker.value));

  document.addEventListener('keydown', (event) => {
    if (controls.aboutDialog.open) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    if (event.key === ' ') { event.preventDefault(); togglePlayback(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pausePlayback();
    else refreshManifest();
  });

  setInterval(() => refreshManifest(), FIVE_MINUTES * 1000);
  setInterval(updateFeedStatus, 60000);
  refreshManifest({ initial: true });
})();
