(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const meta = (name) => {
    const element = document.querySelector(`meta[name="${name}"]`);
    return element ? element.content : '';
  };
  const absoluteUrl = (url) => (url ? new URL(url, window.location.href).href : '');
  const liveManifestEndpoints = [meta('radar-manifest'), meta('radar-manifest-fallback')]
    .map(absoluteUrl)
    .filter(Boolean);
  const emergencyManifestEndpoint = absoluteUrl(meta('radar-manifest-emergency'));
  const manifestEndpoints = [...new Set([
    ...liveManifestEndpoints,
    emergencyManifestEndpoint,
  ].filter(Boolean))];
  const FIVE_MINUTES = 300;
  const LIGHTNING_WINDOW_SECONDS = 7200;
  const LIGHTNING_AGE_STOPS = [
    { seconds: 0, colour: [255, 240, 90] },
    { seconds: 900, colour: [255, 174, 34] },
    { seconds: 1800, colour: [232, 93, 26] },
    { seconds: 3600, colour: [123, 65, 99] },
    { seconds: 7200, colour: [57, 45, 85] },
  ];
  const LIGHTNING_CACHE_SIZE = 96;
  const LIGHTNING_PREFETCH_OFFSETS = [-2, 1, -3, 2];
  const SCRUB_PREFETCH_STEPS = 24;
  const CONSTRAINED_PREFETCH_STEPS = 6;
  const SCRUB_RADAR_INTERVAL_MS = 16;
  const SCRUB_LIGHTNING_INTERVAL_MS = 48;
  const ARCHIVE_WARM_MAX_DESKTOP_BYTES = 32 * 1024 * 1024;
  const ARCHIVE_WARM_MAX_MOBILE_BYTES = 20 * 1024 * 1024;
  const ARCHIVE_WARM_IDLE_MS = 350;
  const LIGHTNING_WARM_IDLE_MS = 240;
  const RADAR_LAYER_CACHE_SIZE = 8;
  const RADAR_WARM_FRAME_COUNT = 4;
  const RADAR_PRELOAD_CACHE_SIZE = 64;
  const EMPTY_IMAGE_DATA = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  const IST_OFFSET_SECONDS = 5.5 * 3600;
  const DEFAULT_BOUNDS = { south: 0, west: 61.875, north: 40.979898, east: 106.875 };
  const timeFormatters = {
    istTime: new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
    }),
    istDate: new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    }),
    istDayMonth: new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
    }),
    istRange: new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }),
    utcTime: new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }),
  };

  function lightningColourAt(ageSeconds) {
    const age = Math.max(0, Math.min(LIGHTNING_WINDOW_SECONDS, Number(ageSeconds) || 0));
    const upperIndex = LIGHTNING_AGE_STOPS.findIndex((stop) => stop.seconds >= age);
    if (upperIndex <= 0) return LIGHTNING_AGE_STOPS[0].colour;
    const upper = LIGHTNING_AGE_STOPS[upperIndex];
    const lower = LIGHTNING_AGE_STOPS[upperIndex - 1];
    const ratio = (age - lower.seconds) / (upper.seconds - lower.seconds);
    return lower.colour.map((channel, index) => (
      Math.round(channel + (upper.colour[index] - channel) * ratio)
    ));
  }

  const LIGHTNING_AGE_PALETTE = Array.from(
    { length: LIGHTNING_WINDOW_SECONDS / 60 + 1 },
    (_, minute) => lightningColourAt(minute * 60),
  );

  function lightningUpperBound(chunk, epoch) {
    const targetOffset = (Number(epoch) - chunk.hour) * 1000;
    let low = 0;
    let high = chunk.count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (chunk.timeOffsets[middle] <= targetOffset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function readOpacityPreference() {
    try {
      const value = Number(window.localStorage.getItem('indiaRadarOpacity') || 82);
      return Number.isFinite(value) && value >= 35 && value <= 100 ? value / 100 : 0.82;
    } catch (_) {
      return 0.82;
    }
  }

  function saveOpacityPreference(value) {
    try {
      window.localStorage.setItem('indiaRadarOpacity', String(value));
    } catch (_) {
      // Storage can be unavailable in private or embedded browser contexts.
    }
  }

  function readLightningPreference() {
    try {
      return window.localStorage.getItem('indiaRadarLightning') !== 'off';
    } catch (_) {
      return true;
    }
  }

  function saveLightningPreference(enabled) {
    try {
      window.localStorage.setItem('indiaRadarLightning', enabled ? 'on' : 'off');
    } catch (_) {
      // Storage can be unavailable in private or embedded browser contexts.
    }
  }

  const state = {
    manifest: null,
    manifestUrl: '',
    manifestBase: '',
    usingEmergencySnapshot: false,
    frames: [],
    frameByTime: new Map(),
    timeline: [],
    index: 0,
    radarLayers: new Map(),
    activeRadarUrls: new Set(),
    opacity: readOpacityPreference(),
    playing: false,
    playTimer: null,
    playStart: 0,
    playEnd: 0,
    scrubRequest: null,
    pendingScrubIndex: null,
    scrubRadarTimer: null,
    pendingScrubRadar: null,
    lastScrubRadarAt: 0,
    lastScrubInputAt: 0,
    renderToken: 0,
    preloaded: new Map(),
    lastPrefetchIndex: null,
    archiveWarmTimer: null,
    archiveWarmRunning: false,
    archiveWarmRequested: false,
    httpWarmedUrls: new Set(),
    monthUrls: new Map(),
    loadedMonths: new Set(),
    loadingMonths: new Map(),
    refreshing: false,
    toastTimer: null,
    userMarker: null,
    lightningManifest: null,
    lightningManifestUrl: '',
    lightningRadarEndpoint: '',
    lightningEnabled: readLightningPreference(),
    lightningHours: new Map(),
    lightningMonthUrls: new Map(),
    lightningLoadedMonths: new Set(),
    lightningLoadingMonths: new Map(),
    lightningCache: new Map(),
    lightningRenderToken: 0,
    lastLightningPrefetchHour: null,
    scrubLightningTimer: null,
    pendingScrubLightningEpoch: null,
    lastScrubLightningAt: 0,
    lightningWarmTimer: null,
    lightningWarmRunning: false,
    lightningWarmRequested: false,
  };

  if (!window.L) {
    const loading = $('#mapLoading');
    const loadingText = $('#loadingText');
    const retry = $('#retryButton');
    loading.classList.add('is-error');
    loadingText.textContent = 'The map library could not start.';
    retry.hidden = false;
    retry.addEventListener('click', () => window.location.reload());
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
  map.createPane('lightningPane');
  map.getPane('lightningPane').style.zIndex = 450;
  map.getPane('lightningPane').style.pointerEvents = 'none';

  const LightningCanvasLayer = L.Layer.extend({
    initialize() {
      this._chunks = [];
      this._epoch = 0;
      this._enabled = true;
      this._drawRequest = null;
      this._viewRequest = null;
      this._drawZoom = null;
      this._drawTopLeft = null;
      this._ageBuckets = Array.from({ length: LIGHTNING_AGE_PALETTE.length }, () => []);
      this._newestPoints = [];
    },
    onAdd(activeMap) {
      this._map = activeMap;
      this._canvas = L.DomUtil.create('canvas', 'leaflet-layer lightning-canvas');
      if (activeMap._zoomAnimated) L.DomUtil.addClass(this._canvas, 'leaflet-zoom-animated');
      activeMap.getPane('lightningPane').appendChild(this._canvas);
      activeMap.on('move zoom moveend zoomend resize viewreset', this._scheduleViewSync, this);
      if (activeMap._zoomAnimated) activeMap.on('zoomanim', this._animateZoom, this);
      this._syncView();
    },
    onRemove(activeMap) {
      activeMap.off('move zoom moveend zoomend resize viewreset', this._scheduleViewSync, this);
      if (activeMap._zoomAnimated) activeMap.off('zoomanim', this._animateZoom, this);
      if (this._drawRequest) cancelAnimationFrame(this._drawRequest);
      if (this._viewRequest) cancelAnimationFrame(this._viewRequest);
      this._canvas.remove();
      this._canvas = null;
      this._map = null;
    },
    setChunks(chunks, epoch, immediate = false) {
      this._chunks = chunks || [];
      this._epoch = Number(epoch) || 0;
      if (immediate) {
        if (this._drawRequest) {
          cancelAnimationFrame(this._drawRequest);
          this._drawRequest = null;
        }
        this._draw();
      } else {
        this._scheduleDraw();
      }
    },
    setEnabled(enabled) {
      this._enabled = Boolean(enabled);
      if (this._canvas) this._canvas.hidden = !this._enabled;
      this._scheduleDraw();
    },
    _scheduleViewSync() {
      if (!this._canvas || this._viewRequest) return;
      this._viewRequest = requestAnimationFrame(() => {
        this._viewRequest = null;
        this._syncView();
      });
    },
    _syncView() {
      if (!this._map || !this._canvas) return;
      const size = this._map.getSize();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(size.x * ratio));
      const height = Math.max(1, Math.round(size.y * ratio));
      if (this._canvas.width !== width || this._canvas.height !== height) {
        this._canvas.width = width;
        this._canvas.height = height;
        this._canvas.style.width = `${size.x}px`;
        this._canvas.style.height = `${size.y}px`;
      }
      L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
      this._ratio = ratio;
      this._drawZoom = this._map.getZoom();
      this._drawTopLeft = this._map.containerPointToLatLng([0, 0]);
      if (this._drawRequest) {
        cancelAnimationFrame(this._drawRequest);
        this._drawRequest = null;
      }
      this._draw();
    },
    _animateZoom(event) {
      if (!this._map || !this._canvas || !this._drawTopLeft || this._drawZoom == null) return;
      const scale = this._map.getZoomScale(event.zoom, this._drawZoom);
      const offset = this._map._latLngToNewLayerPoint(this._drawTopLeft, event.zoom, event.center);
      L.DomUtil.setTransform(this._canvas, offset, scale);
    },
    _scheduleDraw() {
      if (!this._canvas || this._drawRequest) return;
      this._drawRequest = requestAnimationFrame(() => {
        this._drawRequest = null;
        this._draw();
      });
    },
    _draw() {
      if (!this._map || !this._canvas) return;
      const context = this._canvas.getContext('2d');
      const ratio = this._ratio || 1;
      const size = this._map.getSize();
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, size.x, size.y);
      if (!this._enabled) return;
      const baseRadius = Math.min(4.5, 2.9 + Math.max(0, this._map.getZoom() - 4) * 0.28);
      const ageBuckets = this._ageBuckets;
      for (const bucket of ageBuckets) bucket.length = 0;
      const newestPoints = this._newestPoints;
      newestPoints.length = 0;
      const start = this._epoch - LIGHTNING_WINDOW_SECONDS;
      const drawZoom = this._drawZoom == null ? this._map.getZoom() : this._drawZoom;
      const worldSize = 256 * (2 ** drawZoom);
      const topLeft = this._drawTopLeft || this._map.containerPointToLatLng([0, 0]);
      const topLeftWorld = this._map.project(topLeft, drawZoom);
      for (const chunk of this._chunks) {
        const first = lightningUpperBound(chunk, start);
        const last = lightningUpperBound(chunk, this._epoch);
        for (let index = first; index < last; index += 1) {
          const x = chunk.worldX[index] * worldSize - topLeftWorld.x;
          const y = chunk.worldY[index] * worldSize - topLeftWorld.y;
          if (x < -8 || y < -8 || x > size.x + 8 || y > size.y + 8) continue;
          const strikeTime = chunk.hour + chunk.timeOffsets[index] / 1000;
          const age = Math.max(0, this._epoch - strikeTime);
          const ageMinute = Math.min(
            LIGHTNING_AGE_PALETTE.length - 1,
            Math.floor(age / 60),
          );
          ageBuckets[ageMinute].push(x, y);
          if (age <= 180) newestPoints.push(x, y);
        }
      }

      context.strokeStyle = 'rgba(45,24,35,.76)';
      context.lineWidth = 0.85;
      for (let ageMinute = 0; ageMinute < ageBuckets.length; ageMinute += 1) {
        const points = ageBuckets[ageMinute];
        if (!points.length) continue;
        const ageFraction = Math.min(
          1,
          ageMinute / (LIGHTNING_WINDOW_SECONDS / 60),
        );
        const radius = baseRadius * (1 - ageFraction * 0.35);
        const alpha = 0.96 - ageFraction * 0.46;
        const colour = LIGHTNING_AGE_PALETTE[ageMinute];
        context.beginPath();
        for (let index = 0; index < points.length; index += 2) {
          const x = points[index];
          const y = points[index + 1];
          context.moveTo(x, y - radius);
          context.lineTo(x + radius, y);
          context.lineTo(x, y + radius);
          context.lineTo(x - radius, y);
          context.closePath();
        }
        context.fillStyle = `rgba(${colour[0]},${colour[1]},${colour[2]},${alpha})`;
        context.fill();
        context.stroke();
      }
      if (newestPoints.length) {
        context.beginPath();
        for (let index = 0; index < newestPoints.length; index += 2) {
          const x = newestPoints[index];
          const y = newestPoints[index + 1];
          context.moveTo(x + 0.9, y);
          context.arc(x, y, 0.9, 0, Math.PI * 2);
        }
        context.fillStyle = 'rgba(255,255,235,.95)';
        context.fill();
      }
    },
  });

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map);
  const lightningLayer = new LightningCanvasLayer();
  lightningLayer.addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  const controls = {
    headerTime: $('#headerTime'),
    mapLoading: $('#mapLoading'),
    loadingText: $('#loadingText'),
    retryButton: $('#retryButton'),
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
    lightningButton: $('#lightningButton'),
    lightningToggle: $('#lightningToggle'),
    lightningKey: $('#lightningKey'),
    lightningSummary: $('#lightningSummary'),
    toast: $('#toast'),
  };

  controls.opacityRange.value = String(Math.round(state.opacity * 100));
  controls.opacityOutput.value = `${Math.round(state.opacity * 100)}%`;
  setLightningEnabled(state.lightningEnabled);

  function validManifest(payload) {
    return payload && payload.schema_version === 1 && payload.bounds && Array.isArray(payload.frames);
  }

  function validLightningManifest(payload) {
    return payload && payload.schema_version === 1 && Array.isArray(payload.hours) && Array.isArray(payload.months);
  }

  function baseFromManifestUrl(url) {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/[^/]+$/, '/');
    return parsed.href;
  }

  function lightningManifestEndpoint(radarEndpoint) {
    const endpoint = new URL(radarEndpoint);
    if (endpoint.pathname.endsWith('.php')) {
      endpoint.search = '';
      endpoint.searchParams.set('lightning', 'manifest');
      return endpoint.href;
    }
    return new URL('lightning/manifest.json', baseFromManifestUrl(radarEndpoint)).href;
  }

  function lightningMonthManifestUrl(month, relative) {
    const radarEndpoint = state.lightningRadarEndpoint || state.manifestUrl;
    const endpoint = new URL(radarEndpoint);
    if (endpoint.pathname.endsWith('.php')) {
      endpoint.search = '';
      endpoint.searchParams.set('lightning_month', month);
      return endpoint.href;
    }
    return new URL(relative, baseFromManifestUrl(radarEndpoint)).href;
  }

  function lightningHourUrl(summary) {
    const radarEndpoint = state.lightningRadarEndpoint || state.manifestUrl;
    const endpoint = new URL(radarEndpoint);
    if (endpoint.pathname.endsWith('.php')) {
      endpoint.search = '';
      endpoint.searchParams.set('lightning_hour', String(summary.time));
    } else {
      endpoint.href = new URL(summary.url, baseFromManifestUrl(radarEndpoint)).href;
    }
    if (summary.sha256) endpoint.searchParams.set('v', String(summary.sha256).slice(0, 12));
    return endpoint.href;
  }

  function lightningDisplayUrl(summary) {
    if (!summary.display_url || summary.display_format !== 'ildn-hour-v1') return '';
    const radarEndpoint = state.lightningRadarEndpoint || state.manifestUrl;
    const endpoint = new URL(radarEndpoint);
    if (endpoint.pathname.endsWith('.php')) {
      endpoint.search = '';
      endpoint.searchParams.set('lightning_bin', String(summary.time));
    } else {
      endpoint.href = new URL(summary.display_url, baseFromManifestUrl(radarEndpoint)).href;
    }
    if (summary.display_sha256) {
      endpoint.searchParams.set('v', String(summary.display_sha256).slice(0, 12));
    }
    return endpoint.href;
  }

  function updateLightningUi(kind, text) {
    if (controls.lightningKey.dataset.state !== kind) controls.lightningKey.dataset.state = kind;
    if (controls.lightningSummary.textContent !== text) controls.lightningSummary.textContent = text;
  }

  function mergeLightningHours(hours) {
    for (const summary of hours || []) {
      const time = Number(summary.time);
      if (!Number.isFinite(time) || !summary.url) continue;
      const old = state.lightningHours.get(time);
      if (old && (
        old.sha256 !== summary.sha256
        || old.display_sha256 !== summary.display_sha256
      )) state.lightningCache.delete(time);
      state.lightningHours.set(time, { ...summary, time });
    }
  }

  async function fetchJson(url, timeoutMs = 15000, fetchOptions = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const cacheBust = fetchOptions.cacheBust !== false;
      const separator = url.includes('?') ? '&' : '?';
      const requestUrl = cacheBust ? `${url}${separator}_=${Date.now()}` : url;
      const options = { cache: fetchOptions.cache || (cacheBust ? 'no-store' : 'force-cache') };
      if (controller) options.signal = controller.signal;
      const response = await fetch(requestUrl, options);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchArrayBuffer(url, timeoutMs = 15000, priority = 'auto', controller = null) {
    const activeController = controller
      || (typeof AbortController === 'function' ? new AbortController() : null);
    const timer = activeController ? setTimeout(() => activeController.abort(), timeoutMs) : null;
    try {
      const options = { cache: 'force-cache', priority };
      if (activeController) options.signal = activeController.signal;
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.arrayBuffer();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function loadManifest(endpoint, timeoutMs, emergency = false) {
    const payload = await fetchJson(endpoint, timeoutMs);
    if (!validManifest(payload)) throw new Error('invalid manifest structure');
    return { payload, endpoint, emergency };
  }

  function firstSuccessful(promises) {
    return new Promise((resolve, reject) => {
      if (!promises.length) {
        reject(new Error('no live radar manifest configured'));
        return;
      }
      let remaining = promises.length;
      let lastError = null;
      promises.forEach((promise) => {
        promise.then(resolve).catch((error) => {
          lastError = error;
          remaining -= 1;
          if (!remaining) reject(lastError);
        });
      });
    });
  }

  async function firstUsableManifest() {
    const liveReady = firstSuccessful(liveManifestEndpoints.map((endpoint, index) => (
      loadManifest(endpoint, index === 0 ? 6000 : 8000)
    ))).then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error }),
    );

    if (!emergencyManifestEndpoint) {
      const live = await liveReady;
      if (live.ok) return live.result;
      throw live.error;
    }

    const emergencyReady = loadManifest(emergencyManifestEndpoint, 8000, true).then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error }),
    );
    const graceElapsed = new Promise((resolve) => setTimeout(() => resolve(null), 700));
    const quickLive = await Promise.race([liveReady, graceElapsed]);
    if (quickLive && quickLive.ok) return quickLive.result;

    const emergency = await emergencyReady;
    if (emergency.ok) return emergency.result;

    const live = quickLive || await liveReady;
    if (live.ok) return live.result;
    throw live.error || emergency.error || new Error('no radar manifest available');
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
    const first = Number(state.manifest.first_time != null ? state.manifest.first_time : state.frames[0].time);
    const last = Number(state.manifest.latest_time != null ? state.manifest.latest_time : state.frames[state.frames.length - 1].time);
    state.timeline = [];
    for (let time = first; time <= last; time += FIVE_MINUTES) state.timeline.push(time);

    controls.timeRange.max = String(Math.max(0, state.timeline.length - 1));
    const target = preserveTime != null ? preserveTime : last;
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

  function epochAtIndex(index = state.index) {
    if (!state.timeline.length) return 0;
    const clamped = Math.max(0, Math.min(state.timeline.length - 1, Number(index) || 0));
    return Math.round(state.timeline[0] + clamped * FIVE_MINUTES);
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
    if (!bracket || !bracket.before) return false;
    if (!bracket.after) {
      return Math.abs(epoch - bracket.before.time) <= FIVE_MINUTES;
    }
    const sourceInterval = Number((state.manifest && state.manifest.source_interval_seconds) || 600);
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

  function frameUrl(frame, preview = false) {
    const usePreview = Boolean(preview && frame.preview_url);
    const url = new URL(usePreview ? frame.preview_url : frame.url, state.manifestBase);
    const digest = usePreview ? frame.preview_sha256 : frame.sha256;
    if (digest) url.searchParams.set('v', String(digest).slice(0, 12));
    return url.href;
  }

  function monthManifestUrl(month, relative) {
    const manifestUrl = new URL(state.manifestUrl);
    if (manifestUrl.pathname.endsWith('.php')) {
      manifestUrl.searchParams.set('month', month);
      return manifestUrl.href;
    }
    return new URL(relative, state.manifestBase).href;
  }

  async function loadLightningMonth(month) {
    if (state.lightningLoadedMonths.has(month)) return true;
    if (state.lightningLoadingMonths.has(month)) return state.lightningLoadingMonths.get(month);
    const relative = state.lightningMonthUrls.get(month);
    if (!relative) return false;
    const promise = (async () => {
      try {
        const payload = await fetchJson(lightningMonthManifestUrl(month, relative));
        if (!payload || !Array.isArray(payload.hours)) throw new Error('invalid lightning month');
        mergeLightningHours(payload.hours);
        state.lightningLoadedMonths.add(month);
        return true;
      } catch (_) {
        return false;
      } finally {
        state.lightningLoadingMonths.delete(month);
      }
    })();
    state.lightningLoadingMonths.set(month, promise);
    return promise;
  }

  function lightningHourStarts(epoch) {
    const firstHour = Math.floor((epoch - LIGHTNING_WINDOW_SECONDS) / 3600) * 3600;
    const lastHour = Math.floor(epoch / 3600) * 3600;
    const needed = [];
    for (let hour = firstHour; hour <= lastHour; hour += 3600) needed.push(hour);
    return needed;
  }

  function knownLightningSummaries(epoch) {
    const summaries = lightningHourStarts(epoch).map((hour) => state.lightningHours.get(hour));
    return summaries.every(Boolean) ? summaries : null;
  }

  async function ensureLightningSummaries(epoch) {
    const needed = lightningHourStarts(epoch);
    const missingMonths = new Set(
      needed.filter((hour) => !state.lightningHours.has(hour)).map(monthKey),
    );
    if (missingMonths.size) await Promise.all([...missingMonths].map(loadLightningMonth));
    return needed.map((hour) => state.lightningHours.get(hour)).filter(Boolean);
  }

  function emptyLightningChunk(hour) {
    return {
      hour: Number(hour) || 0,
      count: 0,
      timeOffsets: new Uint32Array(0),
      worldX: new Float32Array(0),
      worldY: new Float32Array(0),
    };
  }

  function lightningChunk(hour, timeOffsets, latitudes, longitudes) {
    const count = timeOffsets.length;
    const worldX = new Float32Array(count);
    const worldY = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const longitude = longitudes[index] / 100000;
      const latitude = Math.max(-85.05112878, Math.min(85.05112878, latitudes[index] / 100000));
      const sinLatitude = Math.sin(latitude * Math.PI / 180);
      worldX[index] = (longitude + 180) / 360;
      worldY[index] = 0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI);
    }
    return {
      hour,
      count,
      timeOffsets,
      worldX,
      worldY,
    };
  }

  function decodeLightningBinary(buffer, summary) {
    const view = new DataView(buffer);
    if (view.byteLength < 12) throw new Error('lightning binary is truncated');
    const magic = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
    );
    const hour = view.getUint32(4, true);
    const count = view.getUint32(8, true);
    if (magic !== 'ILB1' || hour !== Number(summary.time)) {
      throw new Error('lightning binary header is invalid');
    }
    if (view.byteLength !== 12 + count * 12 || count !== Number(summary.count)) {
      throw new Error('lightning binary length is invalid');
    }
    const timeOffsets = new Uint32Array(count);
    const latitudes = new Int32Array(count);
    const longitudes = new Int32Array(count);
    let cursor = 12;
    for (let index = 0; index < count; index += 1, cursor += 4) {
      timeOffsets[index] = view.getUint32(cursor, true);
    }
    for (let index = 0; index < count; index += 1, cursor += 4) {
      latitudes[index] = view.getInt32(cursor, true);
    }
    for (let index = 0; index < count; index += 1, cursor += 4) {
      longitudes[index] = view.getInt32(cursor, true);
    }
    return lightningChunk(hour, timeOffsets, latitudes, longitudes);
  }

  function decodeLightningJson(payload, summary) {
    if (!payload || !Array.isArray(payload.fields) || !Array.isArray(payload.strokes)) {
      throw new Error('invalid lightning hour');
    }
    const timestampIndex = payload.fields.indexOf('unix_seconds');
    const latitudeIndex = payload.fields.indexOf('latitude');
    const longitudeIndex = payload.fields.indexOf('longitude');
    if (timestampIndex < 0 || latitudeIndex < 0 || longitudeIndex < 0) {
      throw new Error('lightning fields are incomplete');
    }
    const valid = payload.strokes.filter((record) => {
      const time = Number(record[timestampIndex]);
      const latitude = Number(record[latitudeIndex]);
      const longitude = Number(record[longitudeIndex]);
      return Number.isFinite(time)
        && Number.isFinite(latitude)
        && Number.isFinite(longitude)
        && latitude >= -90 && latitude <= 90
        && longitude >= -180 && longitude <= 180;
    });
    const timeOffsets = new Uint32Array(valid.length);
    const latitudes = new Int32Array(valid.length);
    const longitudes = new Int32Array(valid.length);
    for (let index = 0; index < valid.length; index += 1) {
      const record = valid[index];
      timeOffsets[index] = Math.max(0, Math.min(
        3599999,
        Math.round((Number(record[timestampIndex]) - summary.time) * 1000),
      ));
      latitudes[index] = Math.round(Number(record[latitudeIndex]) * 100000);
      longitudes[index] = Math.round(Number(record[longitudeIndex]) * 100000);
    }
    return lightningChunk(Number(summary.time), timeOffsets, latitudes, longitudes);
  }

  async function loadLightningHour(summary, priority = 'auto') {
    if (!summary || Number(summary.count) === 0) return emptyLightningChunk(summary && summary.time);
    let cached = state.lightningCache.get(summary.time);
    if (cached) {
      // A low-priority archive warm-up must never sit ahead of the hour the
      // user has just selected. Restart that small request at high priority.
      if (
        !cached.data
        && priority === 'high'
        && cached.priority === 'low'
        && cached.controller
      ) {
        state.lightningCache.delete(summary.time);
        cached.controller.abort();
        cached = null;
      }
    }
    if (cached) {
      state.lightningCache.delete(summary.time);
      state.lightningCache.set(summary.time, cached);
      return cached.promise;
    }
    const displayUrl = lightningDisplayUrl(summary);
    const controller = displayUrl && typeof AbortController === 'function'
      ? new AbortController()
      : null;
    const entry = {
      data: null, promise: null, controller, priority,
    };
    entry.promise = (async () => {
      const chunk = displayUrl
        ? decodeLightningBinary(
          await fetchArrayBuffer(displayUrl, 15000, priority, controller),
          summary,
        )
        : decodeLightningJson(await fetchJson(lightningHourUrl(summary), 15000, {
          cacheBust: false,
          cache: 'force-cache',
        }), summary);
      entry.data = chunk;
      entry.controller = null;
      return chunk;
    })();
    state.lightningCache.set(summary.time, entry);
    while (state.lightningCache.size > LIGHTNING_CACHE_SIZE) {
      const centre = epochAtIndex();
      const discard = [...state.lightningCache.keys()]
        .filter((key) => key !== summary.time)
        .sort((a, b) => Math.abs(b - centre) - Math.abs(a - centre))[0];
      if (discard == null) break;
      state.lightningCache.delete(discard);
    }
    try {
      return await entry.promise;
    } catch (error) {
      if (state.lightningCache.get(summary.time) === entry) state.lightningCache.delete(summary.time);
      throw error;
    }
  }

  function cachedLightningChunks(summaries) {
    const chunks = [];
    for (const summary of summaries || []) {
      if (Number(summary.count) === 0) {
        chunks.push(emptyLightningChunk(summary.time));
        continue;
      }
      const entry = state.lightningCache.get(summary.time);
      if (!entry || !entry.data) return null;
      state.lightningCache.delete(summary.time);
      state.lightningCache.set(summary.time, entry);
      chunks.push(entry.data);
    }
    return chunks;
  }

  function cancelObsoleteLightningLoads(keepHours) {
    const keep = new Set(keepHours.map(Number));
    for (const [hour, entry] of state.lightningCache) {
      if (entry.data || keep.has(Number(hour)) || !entry.controller) continue;
      state.lightningCache.delete(hour);
      entry.controller.abort();
    }
  }

  function showLightningChunks(epoch, chunks, immediate = false) {
    const start = epoch - LIGHTNING_WINDOW_SECONDS;
    let strikeCount = 0;
    for (const chunk of chunks) {
      strikeCount += lightningUpperBound(chunk, epoch) - lightningUpperBound(chunk, start);
    }
    // Canvas drawing is RAF-coalesced even during scrubbing. This makes input
    // handlers constant-time while still drawing the newest slider position on
    // the very next display frame.
    lightningLayer.setChunks(chunks, epoch, false);
    const count = strikeCount.toLocaleString('en-IN');
    updateLightningUi('live', `${count} ${strikeCount === 1 ? 'stroke' : 'strokes'}`);
  }

  function prefetchLightningNeighbours(epoch) {
    if (
      state.lastScrubInputAt > 0
      && performance.now() - state.lastScrubInputAt < ARCHIVE_WARM_IDLE_MS
    ) return;
    const centre = Math.floor(epoch / 3600) * 3600;
    if (state.lastLightningPrefetchHour === centre) return;
    state.lastLightningPrefetchHour = centre;
    for (const offset of LIGHTNING_PREFETCH_OFFSETS) {
      const hour = centre + offset * 3600;
      const summary = state.lightningHours.get(hour);
      if (summary) loadLightningHour(summary, 'low').catch(() => false);
    }
  }

  function cancelQueuedScrubLightning() {
    if (state.scrubLightningTimer != null) clearTimeout(state.scrubLightningTimer);
    state.scrubLightningTimer = null;
    state.pendingScrubLightningEpoch = null;
  }

  function queueScrubLightning(epoch) {
    state.pendingScrubLightningEpoch = epoch;
    if (state.scrubLightningTimer != null) return;
    const elapsed = performance.now() - state.lastScrubLightningAt;
    const delay = Math.max(0, SCRUB_LIGHTNING_INTERVAL_MS - elapsed);
    state.scrubLightningTimer = setTimeout(() => {
      const pendingEpoch = state.pendingScrubLightningEpoch;
      state.scrubLightningTimer = null;
      state.pendingScrubLightningEpoch = null;
      state.lastScrubLightningAt = performance.now();
      if (pendingEpoch != null) {
        renderLightning(pendingEpoch, { immediate: true, fromScrubQueue: true });
      }
    }, delay);
  }

  async function renderLightning(epoch, options = {}) {
    const token = ++state.lightningRenderToken;
    const immediate = Boolean(options.immediate);
    if (!state.lightningEnabled) {
      lightningLayer.setChunks([], epoch, immediate);
      updateLightningUi('off', 'Lightning hidden');
      return;
    }
    if (!state.lightningManifest) {
      lightningLayer.setChunks([], epoch, immediate);
      updateLightningUi('loading', 'Lightning loading…');
      return;
    }
    const scrubIsActive = Boolean(
      options.scrubbing
      || options.fromScrubQueue
      || (
        state.lastScrubInputAt > 0
        && performance.now() - state.lastScrubInputAt < ARCHIVE_WARM_IDLE_MS
      )
    );
    if (scrubIsActive) cancelObsoleteLightningLoads(lightningHourStarts(epoch));
    const known = knownLightningSummaries(epoch);
    const cached = known && cachedLightningChunks(known);
    if (cached) {
      showLightningChunks(epoch, cached, immediate);
      prefetchLightningNeighbours(epoch);
      return;
    }
    if (options.scrubbing && !options.fromScrubQueue) {
      lightningLayer.setChunks([], epoch, true);
      updateLightningUi('loading', 'Loading strokes…');
      queueScrubLightning(epoch);
      return;
    }
    updateLightningUi('loading', 'Loading strokes…');
    try {
      const summaries = await ensureLightningSummaries(epoch);
      const chunks = await Promise.all(
        summaries.map((summary) => loadLightningHour(summary, scrubIsActive ? 'high' : 'auto')),
      );
      if (token !== state.lightningRenderToken) return;
      showLightningChunks(epoch, chunks, immediate);
      prefetchLightningNeighbours(epoch);
    } catch (error) {
      if (token !== state.lightningRenderToken) return;
      console.error('Lightning render failed', error);
      lightningLayer.setChunks([], epoch, immediate);
      updateLightningUi('error', 'Lightning unavailable');
    }
  }

  async function refreshLightningManifest(radarEndpoint) {
    const candidates = [...new Set([radarEndpoint, ...manifestEndpoints])];
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const endpoint = lightningManifestEndpoint(candidate);
        const payload = await fetchJson(endpoint, 8000);
        if (!validLightningManifest(payload)) throw new Error('invalid lightning manifest');
        state.lightningManifest = payload;
        state.lightningManifestUrl = endpoint;
        state.lightningRadarEndpoint = candidate;
        mergeLightningHours(payload.hours);
        state.lightningMonthUrls.clear();
        for (const month of payload.months) state.lightningMonthUrls.set(month.month, month.url);
        const epoch = epochAtIndex();
        if (epoch) renderLightning(epoch);
        scheduleArchiveWarm();
        scheduleLightningWarm();
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    state.lightningManifest = null;
    lightningLayer.setChunks([], epochAtIndex());
    updateLightningUi('error', 'Lightning unavailable');
    throw lastError || new Error('no lightning manifest configured');
  }

  function setLightningEnabled(enabled) {
    state.lightningEnabled = Boolean(enabled);
    saveLightningPreference(state.lightningEnabled);
    controls.lightningToggle.checked = state.lightningEnabled;
    controls.lightningButton.classList.toggle('is-active', state.lightningEnabled);
    controls.lightningButton.setAttribute('aria-pressed', String(state.lightningEnabled));
    controls.lightningButton.setAttribute('aria-label', state.lightningEnabled ? 'Hide lightning' : 'Show lightning');
    controls.lightningButton.title = state.lightningEnabled ? 'Hide lightning' : 'Show lightning';
    lightningLayer.setEnabled(state.lightningEnabled);
    if (!state.lightningEnabled) cancelQueuedScrubLightning();
    renderLightning(epochAtIndex());
  }

  function preload(url, priority = 'auto') {
    if (!url) return Promise.resolve(false);
    const cached = state.preloaded.get(url);
    if (cached) {
      state.preloaded.delete(url);
      state.preloaded.set(url, cached);
      return cached.promise;
    }
    const image = new Image();
    const entry = {
      image, loaded: false, settled: false, promise: null, cancel: null,
    };
    entry.promise = new Promise((resolve) => {
      const finish = (loaded) => {
        if (entry.settled) return;
        entry.settled = true;
        entry.loaded = loaded;
        entry.image = null;
        if (!loaded && state.preloaded.get(url) === entry) state.preloaded.delete(url);
        resolve(loaded);
      };
      entry.cancel = () => {
        if (entry.settled) return;
        image.onload = null;
        image.onerror = null;
        image.src = EMPTY_IMAGE_DATA;
        finish(false);
      };
      image.decoding = 'async';
      image.fetchPriority = priority;
      image.onload = () => {
        if (typeof image.decode === 'function') image.decode().catch(() => false).then(() => finish(true));
        else finish(true);
      };
      image.onerror = () => finish(false);
      image.src = url;
    });
    state.preloaded.set(url, entry);
    while (state.preloaded.size > RADAR_PRELOAD_CACHE_SIZE) {
      const firstKey = state.preloaded.keys().next().value;
      state.preloaded.delete(firstKey);
    }
    return entry.promise;
  }

  function constrainedConnection() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return Boolean(connection && (
      connection.saveData || /(^|-)2g$/.test(connection.effectiveType || '')
    ));
  }

  async function waitForArchiveWarmTurn() {
    while (state.lastScrubInputAt > 0) {
      const elapsed = performance.now() - state.lastScrubInputAt;
      if (elapsed >= ARCHIVE_WARM_IDLE_MS) return;
      await new Promise((resolve) => {
        setTimeout(resolve, ARCHIVE_WARM_IDLE_MS - elapsed);
      });
    }
  }

  async function warmArchiveResponse(url) {
    if (state.httpWarmedUrls.has(url)) return;
    await waitForArchiveWarmTurn();
    try {
      const response = await fetch(url, { cache: 'force-cache', priority: 'low' });
      if (!response.ok) return;
      await response.arrayBuffer();
      state.httpWarmedUrls.add(url);
    } catch (_) {
      // The normal image loader remains the fallback when a host disallows CORS.
    }
  }

  async function warmArchiveHttpCache() {
    if (state.archiveWarmRunning || constrainedConnection() || !state.frames.length) return;
    state.archiveWarmRunning = true;
    try {
      do {
        state.archiveWarmRequested = false;
        const centre = epochAtIndex();
        const radarCandidates = state.frames
          .map((frame) => ({
            url: frameUrl(frame, true),
            bytes: Math.max(
              0,
              Number(frame.preview_url ? frame.preview_bytes : frame.bytes) || 0,
            ),
            distance: Math.abs(frame.time - centre),
          }))
          .filter((item) => !state.httpWarmedUrls.has(item.url))
          .sort((a, b) => a.distance - b.distance);
        const candidates = radarCandidates;
        const urls = [];
        let bytes = 0;
        const mobile = matchMedia('(max-width: 640px)').matches;
        const maximumBytes = mobile
          ? ARCHIVE_WARM_MAX_MOBILE_BYTES
          : ARCHIVE_WARM_MAX_DESKTOP_BYTES;
        for (const item of candidates) {
          if (urls.length && bytes + item.bytes > maximumBytes) break;
          urls.push(item.url);
          bytes += item.bytes;
        }
        let cursor = 0;
        const workerCount = Math.min(urls.length, mobile ? 2 : 4);
        const worker = async () => {
          while (cursor < urls.length) {
            const url = urls[cursor];
            cursor += 1;
            await warmArchiveResponse(url);
          }
        };
        await Promise.all(Array.from({ length: workerCount }, worker));
      } while (state.archiveWarmRequested);
    } finally {
      state.archiveWarmRunning = false;
    }
  }

  function scheduleArchiveWarm() {
    if (constrainedConnection()) return;
    state.archiveWarmRequested = true;
    clearTimeout(state.archiveWarmTimer);
    state.archiveWarmTimer = setTimeout(() => {
      state.archiveWarmTimer = null;
      warmArchiveHttpCache();
    }, ARCHIVE_WARM_IDLE_MS);
  }

  async function warmLightningCache() {
    if (
      state.lightningWarmRunning
      || constrainedConnection()
      || !state.lightningManifest
      || !state.lightningHours.size
    ) return;
    state.lightningWarmRunning = true;
    try {
      do {
        state.lightningWarmRequested = false;
        const centre = epochAtIndex();
        const summaries = [...state.lightningHours.values()]
          .filter((summary) => Number(summary.count) > 0 && !state.lightningCache.has(summary.time))
          .sort((a, b) => Math.abs(a.time - centre) - Math.abs(b.time - centre))
          .slice(0, LIGHTNING_CACHE_SIZE);
        let cursor = 0;
        const mobile = matchMedia('(max-width: 640px)').matches;
        const workerCount = Math.min(summaries.length, mobile ? 1 : 2);
        const worker = async () => {
          while (cursor < summaries.length) {
            const summary = summaries[cursor];
            cursor += 1;
            await waitForArchiveWarmTurn();
            await loadLightningHour(summary, 'low').catch(() => false);
          }
        };
        await Promise.all(Array.from({ length: workerCount }, worker));
      } while (state.lightningWarmRequested);
    } finally {
      state.lightningWarmRunning = false;
    }
  }

  function scheduleLightningWarm() {
    if (constrainedConnection()) return;
    state.lightningWarmRequested = true;
    clearTimeout(state.lightningWarmTimer);
    state.lightningWarmTimer = setTimeout(() => {
      state.lightningWarmTimer = null;
      warmLightningCache();
    }, LIGHTNING_WARM_IDLE_MS);
  }

  function isFrameReady(url) {
    const entry = state.radarLayers.get(url);
    return Boolean(entry && entry.loaded);
  }

  function leafletBounds() {
    const bounds = (state.manifest && state.manifest.bounds) || DEFAULT_BOUNDS;
    return [[bounds.south, bounds.west], [bounds.north, bounds.east]];
  }

  function selectIndex(index) {
    const numeric = Number(index);
    const clamped = Math.max(0, Math.min(
      state.timeline.length - 1,
      Number.isFinite(numeric) ? numeric : 0,
    ));
    state.index = clamped;
    controls.timeRange.value = String(clamped);
    const epoch = epochAtIndex(clamped);
    const immediate = frameBracket(epoch);
    const available = usableBracket(immediate, epoch);
    updateTimeLabels(epoch, available ? immediate : { after: null });
    if (!available) {
      controls.frameKind.textContent = 'Loading frame';
      controls.frameKind.dataset.kind = 'blend';
    }
    return { clamped, epoch };
  }

  function radarLayerEntry(url, frame) {
    let entry = state.radarLayers.get(url);
    if (entry) {
      state.radarLayers.delete(url);
      state.radarLayers.set(url, entry);
      return entry;
    }
    const layer = L.imageOverlay(url, leafletBounds(), {
      pane: 'radarPane',
      opacity: 0,
      interactive: false,
      alt: `Radar composite at ${formatUtc(frame.time)}`,
    });
    entry = {
      layer, loaded: false, settled: false, resolve: null, settle: null, promise: null,
    };
    entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
    entry.settle = (loaded) => {
      if (entry.settled) return;
      entry.loaded = loaded;
      entry.settled = true;
      entry.resolve(loaded);
    };
    layer.once('load', () => {
      const image = layer._image;
      if (image && typeof image.decode === 'function') {
        image.decode().catch(() => false).then(() => entry.settle(true));
      } else {
        entry.settle(true);
      }
    });
    layer.once('error', () => {
      entry.settle(false);
      if (map.hasLayer(layer)) map.removeLayer(layer);
      if (state.radarLayers.get(url) === entry) state.radarLayers.delete(url);
    });
    state.radarLayers.set(url, entry);
    return entry;
  }

  function mountRadarLayer(url, frame, priority = 'auto') {
    const entry = radarLayerEntry(url, frame);
    if (!map.hasLayer(entry.layer)) entry.layer.addTo(map);
    if (entry.layer._image) entry.layer._image.fetchPriority = priority;
    return entry;
  }

  function clearRadarLayers() {
    for (const url of state.activeRadarUrls) {
      const entry = state.radarLayers.get(url);
      if (entry && map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    }
    state.activeRadarUrls.clear();
  }

  function discardRadarEntry(url, entry) {
    if (!entry) return;
    const image = entry.layer && entry.layer._image;
    if (map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    if (!entry.settled) entry.settle(false);
    if (image && !entry.loaded) {
      image.removeAttribute('srcset');
      image.src = EMPTY_IMAGE_DATA;
    }
    if (state.radarLayers.get(url) === entry) state.radarLayers.delete(url);
  }

  function cancelObsoleteRadarLoads(keepUrls) {
    const keep = new Set([...keepUrls, ...state.activeRadarUrls]);
    for (const [url, entry] of [...state.radarLayers]) {
      if (!entry.loaded && !keep.has(url)) discardRadarEntry(url, entry);
    }
    for (const [url, entry] of [...state.preloaded]) {
      if (!entry.loaded && !keep.has(url) && entry.cancel) entry.cancel();
    }
  }

  function pruneRadarLayers() {
    while (state.radarLayers.size > RADAR_LAYER_CACHE_SIZE) {
      const discard = [...state.radarLayers.keys()].find((url) => !state.activeRadarUrls.has(url));
      if (!discard) break;
      const entry = state.radarLayers.get(discard);
      discardRadarEntry(discard, entry);
    }
  }

  function showRadarBracket(bracket, afterLoaded = true, preview = false) {
    const beforeUrl = frameUrl(bracket.before, preview);
    const useAfter = Boolean(bracket.after && afterLoaded);
    const afterUrl = useAfter ? frameUrl(bracket.after, preview) : '';
    const desired = new Set([beforeUrl]);
    if (afterUrl) desired.add(afterUrl);

    const beforeLayer = mountRadarLayer(beforeUrl, bracket.before, 'high').layer;
    beforeLayer.setOpacity(useAfter ? state.opacity * (1 - bracket.ratio) : state.opacity);
    beforeLayer.bringToFront();

    if (useAfter) {
      const afterLayer = mountRadarLayer(afterUrl, bracket.after, 'high').layer;
      afterLayer.setOpacity(state.opacity * bracket.ratio);
      afterLayer.bringToFront();
    }

    for (const oldUrl of state.activeRadarUrls) {
      if (desired.has(oldUrl)) continue;
      const entry = state.radarLayers.get(oldUrl);
      if (entry && map.hasLayer(entry.layer)) entry.layer.setOpacity(0);
    }
    state.activeRadarUrls = desired;
    pruneRadarLayers();
  }

  function cancelQueuedScrubRadar() {
    if (state.scrubRadarTimer != null) clearTimeout(state.scrubRadarTimer);
    state.scrubRadarTimer = null;
    state.pendingScrubRadar = null;
  }

  async function loadScrubRadar(pending) {
    const { bracket, epoch, token } = pending;
    if (token !== state.renderToken || epoch !== epochAtIndex()) return;
    const beforeUrl = frameUrl(bracket.before, true);
    const afterUrl = bracket.after ? frameUrl(bracket.after, true) : '';
    cancelObsoleteRadarLoads([beforeUrl, afterUrl].filter(Boolean));
    const beforeEntry = mountRadarLayer(beforeUrl, bracket.before, 'high');
    const afterEntry = bracket.after
      ? mountRadarLayer(afterUrl, bracket.after, 'high')
      : null;
    // Keep at most a few decoded/in-flight mosaics alive while a fast drag
    // crosses hundreds of archive positions. Removing an obsolete overlay
    // also gives the browser a chance to cancel its image request.
    pruneRadarLayers();

    if (beforeEntry.loaded && (!afterEntry || afterEntry.loaded)) {
      if (token === state.renderToken && epoch === epochAtIndex()) {
        showRadarBracket(bracket, true, true);
      }
      return;
    }
    if (beforeEntry.loaded && token === state.renderToken && epoch === epochAtIndex()) {
      showRadarBracket(bracket, false, true);
    }

    const beforeLoaded = await beforeEntry.promise;
    if (!beforeLoaded || token !== state.renderToken || epoch !== epochAtIndex()) return;
    showRadarBracket(bracket, !afterEntry || afterEntry.loaded, true);
    if (!afterEntry || afterEntry.loaded) return;
    const afterLoaded = await afterEntry.promise;
    if (afterLoaded && token === state.renderToken && epoch === epochAtIndex()) {
      showRadarBracket(bracket, true, true);
    }
  }

  function queueScrubRadar(bracket, epoch, token) {
    state.pendingScrubRadar = { bracket, epoch, token };
    if (state.scrubRadarTimer != null) return;
    const elapsed = performance.now() - state.lastScrubRadarAt;
    const delay = Math.max(0, SCRUB_RADAR_INTERVAL_MS - elapsed);
    state.scrubRadarTimer = setTimeout(() => {
      const pending = state.pendingScrubRadar;
      state.scrubRadarTimer = null;
      state.pendingScrubRadar = null;
      state.lastScrubRadarAt = performance.now();
      if (pending) loadScrubRadar(pending);
      if (state.pendingScrubRadar) {
        queueScrubRadar(
          state.pendingScrubRadar.bracket,
          state.pendingScrubRadar.epoch,
          state.pendingScrubRadar.token,
        );
      }
    }, delay);
  }

  async function renderIndex(index, options = {}) {
    if (!state.timeline.length) return;
    if (!options.fromScrubQueue) {
      cancelQueuedScrub();
      cancelQueuedScrubRadar();
      cancelQueuedScrubLightning();
    }
    const { clamped, epoch } = selectIndex(index);
    const token = ++state.renderToken;
    if (options.lightning !== false) {
      renderLightning(epoch, {
        immediate: Boolean(options.scrubbing || options.lightningImmediate),
        scrubbing: Boolean(options.scrubbing),
      });
    }
    const immediate = frameBracket(epoch);
    let bracket = usableBracket(immediate, epoch) ? immediate : null;
    if (bracket) {
      if (options.scrubbing) {
        updateTimeLabels(epoch, bracket);
        const beforeUrl = frameUrl(bracket.before, true);
        const afterUrl = bracket.after ? frameUrl(bracket.after, true) : '';
        cancelObsoleteRadarLoads([beforeUrl, afterUrl].filter(Boolean));
        if (isFrameReady(beforeUrl) && (!afterUrl || isFrameReady(afterUrl))) {
          showRadarBracket(bracket, true, true);
        } else {
          queueScrubRadar(bracket, epoch, token);
        }
        return;
      }
      const beforeUrl = frameUrl(bracket.before);
      const afterUrl = bracket.after ? frameUrl(bracket.after) : '';
      if (
        state.lastScrubInputAt > 0
        && performance.now() - state.lastScrubInputAt < ARCHIVE_WARM_IDLE_MS
      ) cancelObsoleteRadarLoads([beforeUrl, afterUrl].filter(Boolean));
      if (isFrameReady(beforeUrl) && (!afterUrl || isFrameReady(afterUrl))) {
        updateTimeLabels(epoch, bracket);
        showRadarBracket(bracket);
        if (options.prefetch !== false) prefetchNeighbours(clamped);
        return;
      }
    } else {
      bracket = await ensureFramesForEpoch(epoch);
    }
    if (token !== state.renderToken) return;
    if (!bracket) {
      updateTimeLabels(epoch, { after: null });
      controls.frameKind.textContent = 'No source frame';
      controls.frameKind.dataset.kind = 'blend';
      clearRadarLayers();
      return;
    }

    updateTimeLabels(epoch, bracket);
    const beforeUrl = frameUrl(bracket.before);
    const afterUrl = bracket.after ? frameUrl(bracket.after) : '';
    if (
      state.lastScrubInputAt > 0
      && performance.now() - state.lastScrubInputAt < ARCHIVE_WARM_IDLE_MS
    ) cancelObsoleteRadarLoads([beforeUrl, afterUrl].filter(Boolean));
    const beforeEntry = mountRadarLayer(beforeUrl, bracket.before, 'high');
    const afterEntry = bracket.after
      ? mountRadarLayer(afterUrl, bracket.after, 'high')
      : null;
    const loaded = await Promise.all([
      beforeEntry.promise,
      afterEntry ? afterEntry.promise : true,
    ]);
    if (token !== state.renderToken) return;
    if (!loaded[0]) {
      showToast('That radar frame could not be loaded.');
      return;
    }

    showRadarBracket(bracket, loaded[1]);

    if (options.prefetch !== false) prefetchNeighbours(clamped);
  }

  function prefetchNeighbours(index) {
    const urls = new Set();
    const centre = Math.round(index);
    state.lastPrefetchIndex = centre;
    const constrained = constrainedConnection();
    if (!constrained && state.frames.length <= 48) {
      state.frames.forEach((frame) => urls.add(frameUrl(frame, true)));
    } else {
      const steps = constrained ? CONSTRAINED_PREFETCH_STEPS : SCRUB_PREFETCH_STEPS;
      for (let distance = 1; distance <= steps; distance += 1) {
        for (const offset of [-distance, distance]) {
          const epoch = state.timeline[centre + offset];
          if (!epoch) continue;
          const bracket = frameBracket(epoch);
          if (!usableBracket(bracket, epoch)) continue;
          if (bracket.before) urls.add(frameUrl(bracket.before, true));
          if (bracket.after) urls.add(frameUrl(bracket.after, true));
        }
      }
    }
    urls.forEach((url) => preload(url, 'low'));
    warmRadarNeighbours(centre, constrained ? 2 : RADAR_WARM_FRAME_COUNT);
  }

  function warmRadarNeighbours(index, maximum) {
    const candidates = new Map();
    for (let distance = 0; candidates.size < maximum + 2 && distance <= 8; distance += 1) {
      const offsets = distance === 0 ? [0] : [-distance, distance];
      for (const offset of offsets) {
        const epoch = state.timeline[index + offset];
        if (!epoch) continue;
        const bracket = frameBracket(epoch);
        if (!usableBracket(bracket, epoch)) continue;
        for (const frame of [bracket.before, bracket.after]) {
          if (frame) candidates.set(frameUrl(frame), frame);
        }
      }
    }
    let warmed = 0;
    for (const [url, frame] of candidates) {
      if (state.activeRadarUrls.has(url)) continue;
      const entry = mountRadarLayer(url, frame, 'low');
      entry.layer.setOpacity(0);
      warmed += 1;
      if (warmed >= maximum) break;
    }
    pruneRadarLayers();
  }

  function formatParts(epoch) {
    const date = new Date(epoch * 1000);
    const ist = timeFormatters.istTime.format(date);
    const istDate = timeFormatters.istDate.format(date);
    const utc = timeFormatters.utcTime.format(date);
    return { ist, istDate, utc };
  }

  function formatUtc(epoch) {
    return new Date(epoch * 1000).toISOString().slice(11, 16) + ' UTC';
  }

  function shortRangeLabel(epoch) {
    return timeFormatters.istRange.format(new Date(epoch * 1000));
  }

  function updateTimeLabels(epoch, bracket) {
    const parts = formatParts(epoch);
    controls.selectedTime.textContent = `${parts.ist} IST`;
    controls.selectedDate.textContent = `${parts.istDate} · ${parts.utc} UTC`;
    controls.headerTime.textContent = `${parts.ist} IST`;
    const isBlend = Boolean(bracket.after && bracket.ratio > 0 && bracket.ratio < 1);
    controls.frameKind.textContent = isBlend ? 'Interpolated' : 'Source frame';
    controls.frameKind.dataset.kind = isBlend ? 'blend' : 'source';
    const latest = state.index >= state.timeline.length - 1 - 0.001;
    controls.latestButton.classList.toggle('is-latest', latest);
    controls.latestButton.disabled = latest;
    controls.latestButton.textContent = 'Latest';
    controls.dateButtonLabel.textContent = timeFormatters.istDayMonth.format(new Date(epoch * 1000));
  }

  function updateArchiveSummary() {
    if (!state.frames.length || !state.manifest) return;
    const first = Number(state.manifest.first_time != null ? state.manifest.first_time : state.frames[0].time);
    const last = Number(state.manifest.latest_time != null ? state.manifest.latest_time : state.frames[state.frames.length - 1].time);
    const hours = Math.max(0, (last - first) / 3600);
    const sourceFrames = Number(state.manifest.frame_count != null ? state.manifest.frame_count : state.frames.length).toLocaleString('en-GB');
    const prefix = state.usingEmergencySnapshot ? 'Saved copy · ' : '';
    controls.archiveSummary.textContent = prefix + (hours < 48
      ? `${sourceFrames} source frames · ${hours.toFixed(hours < 10 ? 1 : 0)} h archived`
      : `${sourceFrames} source frames · ${Math.round(hours / 24)} days archived`);
  }

  async function refreshManifest({ initial = false } = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    const selectedEpoch = epochAtIndex() || null;
    const wasLatest = !state.timeline.length || state.index >= state.timeline.length - 2;
    const wasEmergency = state.usingEmergencySnapshot;
    try {
      const result = await firstUsableManifest();
      state.manifest = result.payload;
      state.manifestUrl = result.endpoint;
      state.manifestBase = baseFromManifestUrl(result.endpoint);
      state.usingEmergencySnapshot = Boolean(result.emergency);
      refreshLightningManifest(result.endpoint).catch(() => false);
      mergeFrames(result.payload.frames);
      state.monthUrls.clear();
      for (const month of result.payload.months || []) state.monthUrls.set(month.month, month.url);
      if (!state.frames.length) throw new Error('the radar archive contains no frames yet');
      controls.datePicker.min = dateInIst(Number(result.payload.first_time));
      controls.datePicker.max = dateInIst(Number(result.payload.latest_time));
      if (initial) controls.datePicker.value = controls.datePicker.max;
      rebuildTimeline(wasLatest ? null : selectedEpoch);
      await renderIndex(state.index);
      scheduleArchiveWarm();
      controls.mapLoading.classList.remove('is-error');
      controls.retryButton.hidden = true;
      controls.mapLoading.hidden = true;
      if (initial) fitIndia(false);
      if (state.usingEmergencySnapshot && (initial || !wasEmergency)) {
        showToast('Live data hosts are unavailable; showing the latest saved copy.');
      } else if (!state.usingEmergencySnapshot && wasEmergency) {
        showToast('Live radar data restored.');
      }
    } catch (error) {
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
    const preserveTime = epochAtIndex() || null;
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
    renderIndex(Math.round(state.index) + delta);
  }

  function cancelQueuedScrub() {
    if (state.scrubRequest != null) cancelAnimationFrame(state.scrubRequest);
    state.scrubRequest = null;
    state.pendingScrubIndex = null;
  }

  function queueScrub(index) {
    state.lastScrubInputAt = performance.now();
    state.pendingScrubIndex = index;
    if (state.scrubRequest != null) return;
    state.scrubRequest = requestAnimationFrame(() => {
      const pendingIndex = state.pendingScrubIndex;
      state.scrubRequest = null;
      state.pendingScrubIndex = null;
      renderIndex(pendingIndex, {
        prefetch: false,
        scrubbing: true,
        fromScrubQueue: true,
      });
    });
  }

  function finishScrub(index) {
    cancelQueuedScrub();
    cancelQueuedScrubRadar();
    cancelQueuedScrubLightning();
    renderIndex(index, { lightningImmediate: true });
    scheduleArchiveWarm();
    scheduleLightningWarm();
  }

  function startPlayback() {
    if (state.timeline.length < 2) return;
    state.index = Math.round(state.index);
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
    if (!state.playing && state.playTimer == null) return;
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

  function fitIndia(animate = true) {
    const mobile = matchMedia('(max-width: 640px)').matches;
    map.fitBounds([[6.2, 67.2], [37.6, 98.6]], {
      paddingTopLeft: [16, 76],
      paddingBottomRight: [16, mobile ? 182 : 178],
      animate,
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
    controls.mapLoading.classList.add('is-error');
    controls.retryButton.hidden = false;
    controls.mapLoading.hidden = false;
  }

  controls.timeRange.addEventListener('input', () => {
    pausePlayback();
    queueScrub(Number(controls.timeRange.value));
  });
  controls.timeRange.addEventListener('change', () => {
    finishScrub(Number(controls.timeRange.value));
  });
  controls.previousButton.addEventListener('click', () => step(-1));
  controls.nextButton.addEventListener('click', () => step(1));
  controls.playButton.addEventListener('click', togglePlayback);
  controls.latestButton.addEventListener('click', () => {
    pausePlayback();
    renderIndex(state.timeline.length - 1);
  });
  controls.fitButton.addEventListener('click', () => fitIndia(true));
  controls.locateButton.addEventListener('click', locateUser);
  controls.aboutButton.addEventListener('click', () => {
    if (typeof controls.aboutDialog.showModal === 'function') controls.aboutDialog.showModal();
    else controls.aboutDialog.setAttribute('open', '');
  });
  controls.opacityRange.addEventListener('input', () => {
    state.opacity = Number(controls.opacityRange.value) / 100;
    saveOpacityPreference(controls.opacityRange.value);
    controls.opacityOutput.value = `${controls.opacityRange.value}%`;
    renderIndex(state.index, { prefetch: false });
  });
  controls.lightningButton.addEventListener('click', () => setLightningEnabled(!state.lightningEnabled));
  controls.lightningToggle.addEventListener('change', () => setLightningEnabled(controls.lightningToggle.checked));
  controls.dateButton.addEventListener('click', () => {
    if (typeof controls.datePicker.showPicker === 'function') controls.datePicker.showPicker();
    else controls.datePicker.click();
  });
  controls.datePicker.addEventListener('change', () => chooseDate(controls.datePicker.value));
  controls.retryButton.addEventListener('click', () => {
    controls.retryButton.hidden = true;
    controls.mapLoading.classList.remove('is-error');
    controls.loadingText.textContent = 'Loading radar archive…';
    refreshManifest({ initial: true });
  });

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
  refreshManifest({ initial: true });
})();
