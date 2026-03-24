'use strict';

// --- Constants ----------------------------------------------------------------
const IMG_BASE = 'https://image.tmdb.org/t/p';
const POSTER = (p) => p ? `${IMG_BASE}/w342${p}` : null;
const BACKDROP = (p) => p ? `${IMG_BASE}/w1280${p}` : null;
const AVATAR = (p) => p ? `${IMG_BASE}/w185${p}` : null;

// --- State --------------------------------------------------------------------
const state = {
  genres: { movie: [], tv: [] },
  newEpisodes: [],
  currentPage: null,
  heroItems: [],
  heroIndex: 0,
  heroTimer: null,
  watchlist: { movie: {}, tv: {} },
  watchlistLoaded: false,
};

// --- API Client ---------------------------------------------------------------
async function api(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// --- Toast --------------------------------------------------------------------
function toast(msg, type = 'info', duration = 3000) {
  const icons = { success: 'OK', error: '!', info: 'i' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// --- History Helpers ----------------------------------------------------------
async function getHistory() {
  return api('/api/history');
}

function stripUndefinedFields(obj) {
  return Object.fromEntries(
    Object.entries(obj || {}).filter(([, value]) => value !== undefined)
  );
}

function normalizeHistoryItem(type, item = {}) {
  const tmdbId = item.tmdbId || item.id;
  return stripUndefinedFields({
    ...item,
    tmdbId,
    title: item.title || item.name || item.original_title || item.original_name || 'Unknown',
    name: item.name || item.title || item.original_name || item.original_title,
  });
}

function applyHistoryUpdate(type, item) {
  if (!window._historyDB || !item || !item.tmdbId) return;
  if (type === 'movie') {
    window._historyDB.movies = window._historyDB.movies || {};
    window._historyDB.movies[String(item.tmdbId)] = item;
  } else if (type === 'tv') {
    window._historyDB.tvShows = window._historyDB.tvShows || {};
    window._historyDB.tvShows[String(item.tmdbId)] = item;
  }
}

function applyHistoryRemoval(type, id) {
  if (!window._historyDB) return;
  if (type === 'movie' && window._historyDB.movies) {
    delete window._historyDB.movies[String(id)];
  } else if (type === 'tv' && window._historyDB.tvShows) {
    delete window._historyDB.tvShows[String(id)];
  }
}

function refreshHistoryViews() {
  if (state.currentPage !== 'history' || !window._historyDB) return;
  renderHistMovies(window._historyDB);
  renderHistTV(window._historyDB);
}

function normalizeMediaPayload(type, item = {}) {
  const tmdbId = item.tmdbId || item.id;
  return stripUndefinedFields({
    ...item,
    tmdbId,
    id: tmdbId,
    type,
    media_type: type,
    title: item.title || item.name || item.original_title || item.original_name || 'Unknown',
    name: item.name || item.title || item.original_name || item.original_title || 'Unknown',
  });
}

async function ensureWatchlistLoaded(force = false) {
  if (state.watchlistLoaded && !force) return state.watchlist;
  try {
    const data = await fetchJson('/api/watchlist');
    state.watchlist = data.watchlist || { movie: {}, tv: {} };
    state.watchlistLoaded = true;
  } catch (e) {
    console.warn('Failed to load watchlist:', e);
    if (force) throw e;
  }
  return state.watchlist;
}

function isSavedToWatchlist(type, tmdbId) {
  return !!(((state.watchlist || {})[type] || {})[String(tmdbId)]);
}

async function trackRecommendationEvent(eventType, type, tmdbId, metadata = {}, options = {}) {
  try {
    const res = await fetch('/api/recommendations/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType,
        type,
        tmdbId,
        metadata: normalizeMediaPayload(type, metadata),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to record recommendation signal');
    }
    return data;
  } catch (e) {
    if (!options.silent) {
      console.warn(`Failed to track recommendation event ${eventType}:`, e);
    }
    return null;
  }
}

async function toggleWatchlistItem(type, item, options = {}) {
  const payload = normalizeMediaPayload(type, item);
  if (!payload.tmdbId) {
    throw new Error('Missing TMDB id');
  }

  await ensureWatchlistLoaded();
  const saved = isSavedToWatchlist(type, payload.tmdbId);

  if (saved) {
    const res = await fetch(`/api/watchlist/${type}/${payload.tmdbId}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to remove from watchlist');
    }
    if (state.watchlist[type]) {
      delete state.watchlist[type][String(payload.tmdbId)];
    }
    if (!options.silent) toast('Removed from watchlist', 'info');
    return { saved: false, data };
  }

  const res = await fetch('/api/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      tmdbId: payload.tmdbId,
      item: payload,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to save to watchlist');
  }
  state.watchlist[type] = state.watchlist[type] || {};
  state.watchlist[type][String(payload.tmdbId)] = data.item || payload;
  if (!options.silent) toast('Saved to watchlist', 'success');
  return { saved: true, data };
}

async function markWatched(type, item, options = {}) {
  const normalized = normalizeHistoryItem(type, item);
  try {
    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, item: normalized }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to save watch history');
    }
    applyHistoryUpdate(type, data.item || normalized);
    refreshHistoryViews();
    if (!options.silent) toast('Marked as watched', 'success');
    return data.item || normalized;
  } catch (e) {
    if (!options.silent) toast(e.message || 'Failed to save watch history', 'error');
    throw e;
  }
}

async function removeHistory(type, id) {
  try {
    const res = await fetch(`/api/history/${type}/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Failed to remove history item');
    }
    applyHistoryRemoval(type, id);
    refreshHistoryViews();
    toast('Removed from history', 'info');
  } catch (e) {
    toast(e.message || 'Failed to remove history item', 'error');
    throw e;
  }
}

// --- Utility ------------------------------------------------------------------
function year(item) {
  const d = item.release_date || item.first_air_date || '';
  return d ? d.slice(0, 4) : '';
}

function title(item) {
  return item.title || item.name || 'Unknown';
}

function mediaType(item) {
  return item.media_type || (item.first_air_date !== undefined ? 'tv' : 'movie');
}

function rating(item) {
  return item.vote_average ? item.vote_average.toFixed(1) : '?';
}

function formatDate(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escape(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Card Builder -------------------------------------------------------------
function buildCard(item, opts = {}) {
  const t = title(item);
  const y = year(item);
  const r = rating(item);
  const mt = opts.mediaType || mediaType(item);
  const poster = POSTER(item.poster_path);
  const id = item.tmdbId || item.id;
  const reasonLabel = opts.reasonLabel || '';
  const saved = typeof opts.saved === 'boolean' ? opts.saved : isSavedToWatchlist(mt, id);

  const posterHTML = poster
    ? `<img src="${escape(poster)}" alt="${escape(t)}" loading="lazy" />`
    : `<div class="card-poster-placeholder">MEDIA</div>`;

  const typeBadge = opts.showTypeBadge !== false
    ? `<span class="card-type-badge ${mt === 'tv' ? 'tv' : ''}">${mt === 'tv' ? 'TV' : 'Film'}</span>`
    : '';

  const badges = opts.badges || '';

  const watchedBadge = opts.watched
    ? `<span class="badge badge-watched" style="position:absolute;bottom:.4rem;left:.4rem">Watched</span>`
    : '';

  const newEpBadge = opts.newEp
    ? `<span class="badge badge-new" style="position:absolute;bottom:.4rem;left:.4rem">New Ep</span>`
    : '';

  const progressHTML = opts.progress
    ? `<div class="card-progress">S${opts.progress.s}E${opts.progress.e}</div>
       <div class="progress-bar"><div class="progress-fill" style="width:${opts.progress.pct}%"></div></div>`
    : '';

  const saveButton = opts.showSaveButton
    ? `<button class="card-save-btn ${saved ? 'saved' : ''}" onclick="event.stopPropagation();toggleWatchlistFromCard(event,'${mt}',${id})">${saved ? 'Saved' : 'Save'}</button>`
    : '';

  const reasonHTML = reasonLabel
    ? `<div class="card-reason">${escape(reasonLabel)}</div>`
    : '';

  return `
    <div class="card" data-id="${id}" data-type="${mt}" onclick="openDetail('${mt}',${id})">
      <div class="card-poster">
        ${posterHTML}
        <div class="card-rating">Rating ${r}</div>
        ${typeBadge}
        ${watchedBadge}${newEpBadge}${badges}
        ${saveButton}
        <button class="play-btn-card" onclick="event.stopPropagation();openStreamWizard('${mt}',${id},'${escape(t)}')" title="Stream this">Play</button>
        <div class="card-overlay">
          <div class="card-quick-actions">
            <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openDetail('${mt}',${id})">Details</button>
          </div>
        </div>
      </div>
      <div class="card-body">
        <div class="card-title">${escape(t)}</div>
        <div class="card-year">${y}</div>
        ${reasonHTML}
        ${progressHTML}
      </div>
    </div>`;
}

function skeletonCards(n = 8) {
  return Array.from({ length: n }, () => `
    <div class="card">
      <div class="card-poster skeleton" style="aspect-ratio:2/3"></div>
      <div class="card-body">
        <div class="skeleton" style="height:14px;border-radius:4px;margin-bottom:.4rem"></div>
        <div class="skeleton" style="height:12px;width:50%;border-radius:4px"></div>
      </div>
    </div>`).join('');
}

// --- Pagination ---------------------------------------------------------------
function buildPagination(currentPage, totalPages, onPageClick) {
  if (totalPages <= 1) return '';
  const maxVisible = 5;
  let pages = [];

  if (totalPages <= maxVisible) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    const start = Math.max(1, currentPage - 2);
    const end = Math.min(totalPages, start + maxVisible - 1);
    if (start > 1) pages.push(1, '...');
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < totalPages) pages.push('...', totalPages);
  }

  const btns = pages.map((p) => {
    if (p === '...') return `<button disabled>...</button>`;
    return `<button class="${p === currentPage ? 'active' : ''}" onclick="(${onPageClick})(${p})">${p}</button>`;
  }).join('');

  return `<div class="pagination">
    <button ${currentPage <= 1 ? 'disabled' : ''} onclick="(${onPageClick})(${currentPage - 1})">Prev</button>
    ${btns}
    <button ${currentPage >= totalPages ? 'disabled' : ''} onclick="(${onPageClick})(${currentPage + 1})">Next</button>
  </div>`;
}

// --- Hero ---------------------------------------------------------------------
function renderHero(items) {
  if (!items || items.length === 0) return '';
  state.heroItems = items.slice(0, 6);
  state.heroIndex = 0;
  setTimeout(startHeroAutoplay, 100);
  return buildHeroSlide();
}

function buildHeroSlide() {
  const items = state.heroItems;
  if (!items.length) return '';
  const item = items[state.heroIndex];
  const mt = mediaType(item);
  const backdrop = BACKDROP(item.backdrop_path);

  const dots = items.map((_, i) =>
    `<div class="hero-dot ${i === state.heroIndex ? 'active' : ''}" onclick="goHeroSlide(${i})"></div>`
  ).join('');

  return `
    <div class="hero" id="heroSection">
      <div class="hero-bg" id="heroBg" style="background-image:url('${escape(backdrop || '')}')"></div>
      <div class="hero-gradient"></div>
      <div class="hero-content">
        <div class="hero-badge">${mt === 'tv' ? 'TV Show' : 'Movie'} - Trending</div>
        <h1 class="hero-title">${escape(title(item))}</h1>
        <div class="hero-meta">
          <span class="hero-rating">Rating ${rating(item)}</span>
          <span>${year(item)}</span>
        </div>
        <p class="hero-overview">${escape(item.overview || '')}</p>
        <div class="hero-actions">
          <button class="btn btn-primary" onclick="openDetail('${mt}',${item.id})">Details</button>
          <button class="btn btn-secondary" onclick="heroMarkWatched(${item.id},'${mt}')">
            + Watched
          </button>
        </div>
      </div>
      <div class="hero-dots" id="heroDots">${dots}</div>
    </div>`;
}

function goHeroSlide(idx) {
  clearInterval(state.heroTimer);
  state.heroIndex = idx;
  const section = document.getElementById('heroSection');
  if (!section) return;
  const item = state.heroItems[idx];
  const backdrop = BACKDROP(item.backdrop_path);
  document.getElementById('heroBg').style.backgroundImage = `url('${escape(backdrop || '')}')`;
  document.getElementById('heroDots').querySelectorAll('.hero-dot').forEach((d, i) => {
    d.classList.toggle('active', i === idx);
  });
  startHeroAutoplay();
}

function startHeroAutoplay() {
  clearInterval(state.heroTimer);
  state.heroTimer = setInterval(() => {
    const next = (state.heroIndex + 1) % state.heroItems.length;
    goHeroSlide(next);
  }, 6000);
}

function heroMarkWatched(id, type) {
  const item = state.heroItems.find((i) => i.id === id);
  if (!item) return;
  markWatched(type, { tmdbId: id, title: title(item), poster_path: item.poster_path });
}

// Make globally accessible for inline onclick
window.goHeroSlide = goHeroSlide;
window.heroMarkWatched = heroMarkWatched;

// --- Genre Select Builder -----------------------------------------------------
function buildGenreOptions(type) {
  const genres = state.genres[type] || [];
  return `<option value="">All Genres</option>` +
    genres.map((g) => `<option value="${g.id}">${g.name}</option>`).join('');
}

// --- Router -------------------------------------------------------------------
const routes = {
  '/': renderHome,
  '/movies': renderMovies,
  '/tv': renderTV,
  '/search': renderSearch,
  '/recommendations': renderRecommendations,
  '/history': renderHistory,
  '/stream': renderStreamPage,
};

function getHash() {
  const h = window.location.hash.replace('#', '') || '/';
  return h.split('?')[0];
}

function getHashParams() {
  const h = window.location.hash;
  const idx = h.indexOf('?');
  if (idx === -1) return new URLSearchParams();
  return new URLSearchParams(h.slice(idx + 1));
}

function navigate(path) {
  window.location.hash = path;
}

function route() {
  clearInterval(state.heroTimer);
  const path = getHash();
  const fn = routes[path] || renderHome;

  if (state.currentPage === 'stream' && path !== '/stream') {
    if (wizard.sseSource) { wizard.sseSource.close(); wizard.sseSource = null; }
    clearWaitingTimer();
    clearStreamStatusPolling();
  }

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach((el) => {
    el.classList.toggle('active',
      el.getAttribute('href') === `#${path}` ||
      (path === '/' && el.dataset.page === 'home')
    );
  });

  // Close mobile nav
  document.getElementById('navLinks').classList.remove('open');

  document.getElementById('app').innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;
  fn();
}

// --- Home Page ----------------------------------------------------------------
async function renderHome() {
  state.currentPage = 'home';
  const app = document.getElementById('app');

  try {
    const [trending, trendingMovies, trendingTV] = await Promise.all([
      api('/api/trending?type=all&window=week'),
      api('/api/trending?type=movie&window=week'),
      api('/api/trending?type=tv&window=week'),
    ]);

    const heroHTML = renderHero(trending.results);

    const trendingAllRow = trending.results.slice(0, 16).map((item) =>
      buildCard(item, { showTypeBadge: true })
    ).join('');

    const moviesRow = trendingMovies.results.slice(0, 16).map((item) =>
      buildCard(item, { mediaType: 'movie', showTypeBadge: false })
    ).join('');

    const tvRow = trendingTV.results.slice(0, 16).map((item) =>
      buildCard(item, { mediaType: 'tv', showTypeBadge: false })
    ).join('');

    app.innerHTML = `
      ${heroHTML}
      <div class="section">
        <div class="section-header">
          <h2 class="section-title">Trending This Week</h2>
          <a href="#/search" class="section-link">See all -></a>
        </div>
        <div class="scroll-row">${trendingAllRow}</div>
      </div>
      <div class="section" style="background:var(--bg-2);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div class="section-header">
          <h2 class="section-title">Trending Movies</h2>
          <a href="#/movies" class="section-link">All Movies -></a>
        </div>
        <div class="scroll-row">${moviesRow}</div>
      </div>
      <div class="section">
        <div class="section-header">
          <h2 class="section-title">Trending TV Shows</h2>
          <a href="#/tv" class="section-link">All TV Shows -></a>
        </div>
        <div class="scroll-row">${tvRow}</div>
      </div>`;
  } catch (e) {
    app.innerHTML = errorState(e);
  }
}

// --- Movies Page --------------------------------------------------------------
async function renderMovies(page = 1, filters = {}) {
  state.currentPage = 'movies';
  const app = document.getElementById('app');

  const params = new URLSearchParams({
    type: 'movie',
    page,
    sort: filters.sort || 'popularity.desc',
    ...(filters.genre && { genre: filters.genre }),
    ...(filters.yearFrom && { yearFrom: filters.yearFrom }),
    ...(filters.yearTo && { yearTo: filters.yearTo }),
    ...(filters.minRating && { minRating: filters.minRating }),
  });

  app.innerHTML = `
    <div class="page-layout">
      ${buildDiscoverSidebar('movie', filters, `renderMovies`)}
      <div class="page-content" id="moviesContent">
        <div class="page-header">
          <h1 class="page-title">Movies</h1>
          <p class="page-subtitle">Discover films from every genre</p>
        </div>
        <div class="tabs">
          <button class="tab ${!filters.tab || filters.tab==='discover' ? 'active' : ''}" onclick="renderMovies(1,{...getCurrentFilters('movie'),tab:'discover'})">Discover</button>
          <button class="tab ${filters.tab==='popular' ? 'active' : ''}" onclick="renderMovies(1,{tab:'popular'})">Popular</button>
          <button class="tab ${filters.tab==='top' ? 'active' : ''}" onclick="renderMovies(1,{tab:'top'})">Top Rated</button>
          <button class="tab ${filters.tab==='now' ? 'active' : ''}" onclick="renderMovies(1,{tab:'now'})">Now Playing</button>
        </div>
        <div class="grid grid-lg" id="moviesGrid">${skeletonCards(12)}</div>
        <div id="moviesPagination"></div>
      </div>
    </div>`;

  try {
    let data;
    if (filters.tab === 'popular') data = await api(`/api/popular?type=movie&page=${page}`);
    else if (filters.tab === 'top') data = await api(`/api/top-rated?type=movie&page=${page}`);
    else if (filters.tab === 'now') data = await api(`/api/now-playing?type=movie&page=${page}`);
    else data = await api(`/api/discover?${params}`);

    const grid = document.getElementById('moviesGrid');
    const pag = document.getElementById('moviesPagination');
    if (!grid) return;

    grid.innerHTML = data.results.map((item) =>
      buildCard(item, { mediaType: 'movie', showTypeBadge: false })
    ).join('') || emptyCards();

    pag.innerHTML = buildPagination(page, Math.min(data.total_pages, 500),
      `(p) => renderMovies(p, getCurrentFilters('movie'))`);

    window._currentFilters_movie = filters;
  } catch (e) {
    const grid = document.getElementById('moviesGrid');
    if (grid) grid.innerHTML = errorState(e);
  }
}

// --- TV Shows Page ------------------------------------------------------------
async function renderTV(page = 1, filters = {}) {
  state.currentPage = 'tv';
  const app = document.getElementById('app');

  const params = new URLSearchParams({
    type: 'tv',
    page,
    sort: filters.sort || 'popularity.desc',
    ...(filters.genre && { genre: filters.genre }),
    ...(filters.yearFrom && { yearFrom: filters.yearFrom }),
    ...(filters.yearTo && { yearTo: filters.yearTo }),
    ...(filters.minRating && { minRating: filters.minRating }),
  });

  app.innerHTML = `
    <div class="page-layout">
      ${buildDiscoverSidebar('tv', filters, `renderTV`)}
      <div class="page-content">
        <div class="page-header">
          <h1 class="page-title">TV Shows</h1>
          <p class="page-subtitle">Browse series, anime, documentaries and more</p>
        </div>
        <div class="tabs">
          <button class="tab ${!filters.tab || filters.tab==='discover' ? 'active' : ''}" onclick="renderTV(1,{...getCurrentFilters('tv'),tab:'discover'})">Discover</button>
          <button class="tab ${filters.tab==='popular' ? 'active' : ''}" onclick="renderTV(1,{tab:'popular'})">Popular</button>
          <button class="tab ${filters.tab==='top' ? 'active' : ''}" onclick="renderTV(1,{tab:'top'})">Top Rated</button>
          <button class="tab ${filters.tab==='now' ? 'active' : ''}" onclick="renderTV(1,{tab:'now'})">On The Air</button>
        </div>
        <div class="grid grid-lg" id="tvGrid">${skeletonCards(12)}</div>
        <div id="tvPagination"></div>
      </div>
    </div>`;

  try {
    let data;
    if (filters.tab === 'popular') data = await api(`/api/popular?type=tv&page=${page}`);
    else if (filters.tab === 'top') data = await api(`/api/top-rated?type=tv&page=${page}`);
    else if (filters.tab === 'now') data = await api(`/api/now-playing?type=tv&page=${page}`);
    else data = await api(`/api/discover?${params}`);

    const grid = document.getElementById('tvGrid');
    const pag = document.getElementById('tvPagination');
    if (!grid) return;

    grid.innerHTML = data.results.map((item) =>
      buildCard(item, { mediaType: 'tv', showTypeBadge: false })
    ).join('') || emptyCards();

    pag.innerHTML = buildPagination(page, Math.min(data.total_pages, 500),
      `(p) => renderTV(p, getCurrentFilters('tv'))`);

    window._currentFilters_tv = filters;
  } catch (e) {
    const grid = document.getElementById('tvGrid');
    if (grid) grid.innerHTML = errorState(e);
  }
}

// --- Discover Sidebar ---------------------------------------------------------
function buildDiscoverSidebar(type, filters, renderFn) {
  const sortOptions = [
    { v: 'popularity.desc', l: 'Most Popular' },
    { v: 'vote_average.desc', l: 'Highest Rated' },
    { v: 'vote_count.desc', l: 'Most Voted' },
    { v: 'release_date.desc', l: 'Newest First' },
    { v: 'release_date.asc', l: 'Oldest First' },
  ];

  const genreOpts = buildGenreOptions(type);

  return `
    <aside class="sidebar">
      <div class="sidebar-title">Filters</div>

      <div class="sidebar-group">
        <label class="sidebar-label">Sort By</label>
        <select class="sidebar-select" id="sort_${type}" onchange="applyFilters('${type}','${renderFn}')">
          ${sortOptions.map((s) => `<option value="${s.v}" ${filters.sort === s.v ? 'selected' : ''}>${s.l}</option>`).join('')}
        </select>
      </div>

      <div class="sidebar-group">
        <label class="sidebar-label">Genre</label>
        <select class="sidebar-select" id="genre_${type}" onchange="applyFilters('${type}','${renderFn}')">
          ${genreOpts}
        </select>
      </div>

      <div class="sidebar-group">
        <label class="sidebar-label">Year Range</label>
        <div class="year-range">
          <input type="number" id="yearFrom_${type}" placeholder="From" min="1900" max="2030"
            value="${filters.yearFrom || ''}" onchange="applyFilters('${type}','${renderFn}')" />
          <span>?</span>
          <input type="number" id="yearTo_${type}" placeholder="To" min="1900" max="2030"
            value="${filters.yearTo || ''}" onchange="applyFilters('${type}','${renderFn}')" />
        </div>
      </div>

      <div class="sidebar-group">
        <label class="sidebar-label">Min Rating</label>
        <select class="sidebar-select" id="minRating_${type}" onchange="applyFilters('${type}','${renderFn}')">
          <option value="">Any</option>
          ${[9,8,7,6,5,4].map((v) => `<option value="${v}" ${filters.minRating==v ? 'selected':''}>${v}+</option>`).join('')}
        </select>
      </div>

      <div class="sidebar-actions">
        <button class="btn btn-primary" onclick="applyFilters('${type}','${renderFn}')">Apply</button>
        <button class="btn btn-outline" onclick="${renderFn}(1,{})">Reset</button>
      </div>
    </aside>`;
}

function getCurrentFilters(type) {
  return window[`_currentFilters_${type}`] || {};
}

function applyFilters(type, renderFn) {
  const get = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : '';
  };
  const filters = {
    sort: get(`sort_${type}`),
    genre: get(`genre_${type}`),
    yearFrom: get(`yearFrom_${type}`),
    yearTo: get(`yearTo_${type}`),
    minRating: get(`minRating_${type}`),
    tab: 'discover',
  };
  // eval-like: call the named function
  if (renderFn === 'renderMovies') renderMovies(1, filters);
  else if (renderFn === 'renderTV') renderTV(1, filters);
  else if (renderFn === 'renderRecommendations') renderRecommendations(1, filters);
}

// --- Search Page --------------------------------------------------------------
let searchDebounce = null;

async function renderSearch(initialQuery = '') {
  state.currentPage = 'search';
  const app = document.getElementById('app');
  const params = getHashParams();
  const q = initialQuery || params.get('q') || '';

  app.innerHTML = `
    <div class="search-hero">
      <h1>Find Movies & TV Shows</h1>
      <div class="search-box">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="searchInput" placeholder="Search for a movie or TV show..." value="${escape(q)}" autofocus />
      </div>
      <div class="search-filters">
        <div class="tabs" style="margin-bottom:0">
          <button class="tab active" id="filterAll" onclick="setSearchType('multi')">All</button>
          <button class="tab" id="filterMovies" onclick="setSearchType('movie')">Movies</button>
          <button class="tab" id="filterTV" onclick="setSearchType('tv')">TV Shows</button>
        </div>
      </div>
    </div>
    <div class="search-results-area" id="searchResults">
      ${q ? `<div class="page-loader"><div class="spinner"></div></div>` : buildSearchEmpty()}
    </div>`;

  window._searchType = 'multi';

  const input = document.getElementById('searchInput');
  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => execSearch(1), 350);
  });

  if (q) execSearch(1, q);
}

function setSearchType(type) {
  window._searchType = type;
  document.querySelectorAll('.search-filters .tab').forEach((t, i) => {
    const types = ['multi', 'movie', 'tv'];
    t.classList.toggle('active', types[i] === type);
  });
  const q = document.getElementById('searchInput')?.value;
  if (q) execSearch(1);
}

async function execSearch(page = 1, overrideQuery) {
  const q = overrideQuery || document.getElementById('searchInput')?.value || '';
  const type = window._searchType || 'multi';
  const resultsEl = document.getElementById('searchResults');
  if (!resultsEl) return;

  if (!q.trim()) {
    resultsEl.innerHTML = buildSearchEmpty();
    return;
  }

  resultsEl.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&type=${type}&page=${page}`);

    if (!data.results || data.results.length === 0) {
      resultsEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">No</div>
          <h3>No results for "${escape(q)}"</h3>
          <p>Try different keywords or check the spelling.</p>
        </div>`;
      return;
    }

    const cards = data.results.map((item) =>
      buildCard(item, { showTypeBadge: true })
    ).join('');

    const pag = buildPagination(page, Math.min(data.total_pages, 20),
      `(p) => execSearch(p)`);

    resultsEl.innerHTML = `
      <div class="results-header">
        <span class="results-count"><strong>${data.total_results.toLocaleString()}</strong> results for "${escape(q)}"</span>
      </div>
      <div class="grid grid-lg">${cards}</div>
      ${pag}`;
  } catch (e) {
    resultsEl.innerHTML = errorState(e);
  }
}

function buildSearchEmpty() {
  return `
    <div class="empty-state">
      <div class="empty-icon">Go</div>
      <h3>Search for anything</h3>
      <p>Type a movie title, TV show name, or actor to get started.</p>
    </div>`;
}

function buildRecommendationSummary(data = {}) {
  const personalization = data.personalization || {};
  const status = !personalization.meaningful
    ? 'Warming up'
    : personalization.fullyPersonalized
      ? 'Tuned to your taste'
      : 'Learning your pattern';
  const topGenres = (personalization.topGenres || [])
    .slice(0, 3)
    .map((genre) => genre.label || genre.key)
    .filter(Boolean);

  return `
    <div class="recs-summary-card">
      <div>
        <div class="recs-summary-kicker">${escape(status)}</div>
        <h2 class="recs-summary-title">Personalized with multiple taste signals</h2>
        <p class="recs-summary-text">
          We combine watch history, stream starts, detail clicks, saved titles, genres, people, language, era, and quality preference into one ranking model.
        </p>
      </div>
      <div class="recs-stat-row">
        <span class="recs-stat-pill">Signals ${Math.round(personalization.positiveSignalWeight || 0)}</span>
        <span class="recs-stat-pill">Watchlist ${data.watchlist?.total || 0}</span>
        <span class="recs-stat-pill">Quality floor ${personalization.qualityFloor ? personalization.qualityFloor.toFixed(1) : '6.2'}+</span>
      </div>
      ${topGenres.length ? `<div class="recs-summary-tags">${topGenres.map((genre) => `<span class="genre-chip">${escape(genre)}</span>`).join('')}</div>` : ''}
    </div>`;
}

function buildRecommendationSection(section) {
  return `
    <section class="recs-section">
      <div class="recs-section-header">
        <div>
          <h2 class="recs-section-title">${escape(section.title || 'Recommendations')}</h2>
          <p class="recs-section-subtitle">${escape(section.subtitle || '')}</p>
        </div>
      </div>
      <div class="grid grid-lg">
        ${(section.items || []).map((item) => buildCard(item, {
          showTypeBadge: true,
          mediaType: item.type || mediaType(item),
          reasonLabel: item.reasonLabel,
          showSaveButton: true,
          saved: !!item.isSaved,
        })).join('')}
      </div>
    </section>`;
}

// --- Recommendations Page -----------------------------------------------------
async function renderRecommendations(page = 1, filters = {}) {
  state.currentPage = 'recommendations';
  const app = document.getElementById('app');
  await ensureWatchlistLoaded();

  app.innerHTML = `
    <div class="page-layout">
      ${buildRecommendationsSidebar(filters)}
      <div class="page-content">
        <div class="page-header">
          <h1 class="page-title">For You</h1>
          <p class="page-subtitle">Ranked by your watch behavior, saved titles, recurring tastes, and discovery balance</p>
        </div>
        <div id="recsSummary">${skeletonCards(1)}</div>
        <div id="recsGrid">${skeletonCards(12)}</div>
      </div>
    </div>`;

  const params = new URLSearchParams({
    page,
    ...(filters.type && { type: filters.type }),
    ...(filters.genre && { genre: filters.genre }),
    ...(filters.minRating && { minRating: filters.minRating }),
    ...(filters.yearFrom && { yearFrom: filters.yearFrom }),
    ...(filters.yearTo && { yearTo: filters.yearTo }),
  });

  try {
    const data = await api(`/api/recommendations?${params}`);
    const grid = document.getElementById('recsGrid');
    const summary = document.getElementById('recsSummary');
    const sidebarMeta = document.getElementById('recsSidebarMeta');
    if (!grid) return;
    if (summary) summary.innerHTML = buildRecommendationSummary(data);
    if (sidebarMeta) sidebarMeta.innerHTML = buildRecommendationsSidebarMeta(data);

    if (!data.sections || data.sections.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="empty-icon">New</div>
          <h3>No recommendations yet</h3>
          <p>Start watching, saving, and opening a few titles so the ranking model can learn your taste.<br/>
          Browse <a href="#/movies" style="color:var(--accent)">Movies</a> or <a href="#/tv" style="color:var(--accent)">TV Shows</a> to get started.</p>
        </div>`;
      return;
    }

    grid.innerHTML = data.sections.map((section) => buildRecommendationSection(section)).join('');

    window._recsFilters = filters;
    window._currentFilters_recs = filters;
  } catch (e) {
    const grid = document.getElementById('recsGrid');
    if (grid) grid.innerHTML = errorState(e);
  }
}

function buildRecommendationsSidebarMeta(data = {}) {
  const personalization = data.personalization || {};
  const topGenres = (personalization.topGenres || [])
    .slice(0, 4)
    .map((genre) => genre.label || genre.key)
    .filter(Boolean);
  const status = !personalization.meaningful
    ? 'Cold start'
    : personalization.fullyPersonalized
      ? 'High-confidence profile'
      : 'Hybrid profile';

  return `
    <div class="sidebar-group">
      <label class="sidebar-label">Profile</label>
      <div class="recs-profile-box">
        <div class="recs-profile-title">${escape(status)}</div>
        <div class="recs-profile-text">Signals ${Math.round(personalization.positiveSignalWeight || 0)} • Watchlist ${data.watchlist?.total || 0}</div>
        ${topGenres.length ? `<div class="recs-profile-tags">${topGenres.map((genre) => `<span class="genre-chip">${escape(genre)}</span>`).join('')}</div>` : '<div class="recs-profile-text">Open details, save titles, and stream more to sharpen results.</div>'}
      </div>
    </div>`;
}

function buildRecommendationsSidebar(filters) {
  const genreOpts = [
    `<option value="">All Genres</option>`,
    ...state.genres.movie.map((g) => `<option value="${g.id}" ${filters.genre==g.id ? 'selected':''}>${g.name}</option>`),
  ].join('');

  return `
    <aside class="sidebar">
      <div class="sidebar-title">Filters</div>
      <div class="sidebar-group">
        <label class="sidebar-label">How This Works</label>
        <div class="recs-profile-box">
          <div class="recs-profile-text">Filters refine your personalized pool. They do not replace the recommendation model.</div>
        </div>
      </div>
      <div id="recsSidebarMeta"></div>

      <div class="sidebar-group">
        <label class="sidebar-label">Type</label>
        <div class="chip-group">
          <span class="chip ${!filters.type ? 'active' : ''}" onclick="recsSetType('')">Both</span>
          <span class="chip ${filters.type==='movie' ? 'active' : ''}" onclick="recsSetType('movie')">Movies</span>
          <span class="chip ${filters.type==='tv' ? 'active' : ''}" onclick="recsSetType('tv')">TV Shows</span>
        </div>
      </div>

      <div class="sidebar-group">
        <label class="sidebar-label">Genre</label>
        <select class="sidebar-select" id="genre_recs" onchange="applyRecsFilters()">
          ${genreOpts}
        </select>
      </div>

      <div class="sidebar-group">
        <label class="sidebar-label">Year Range</label>
        <div class="year-range">
          <input type="number" id="yearFrom_recs" placeholder="From" min="1900" max="2030"
            value="${filters.yearFrom || ''}" onchange="applyRecsFilters()" />
          <span>?</span>
          <input type="number" id="yearTo_recs" placeholder="To" min="1900" max="2030"
            value="${filters.yearTo || ''}" onchange="applyRecsFilters()" />
        </div>
      </div>

      <div class="sidebar-group">
        <label class="sidebar-label">Min Rating</label>
        <select class="sidebar-select" id="minRating_recs" onchange="applyRecsFilters()">
          <option value="">Any</option>
          ${[9,8,7,6,5,4].map((v) => `<option value="${v}" ${filters.minRating==v ? 'selected':''}>${v}+</option>`).join('')}
        </select>
      </div>

      <div class="sidebar-actions">
        <button class="btn btn-primary" onclick="applyRecsFilters()">Apply</button>
        <button class="btn btn-outline" onclick="renderRecommendations(1,{})">Reset</button>
      </div>
    </aside>`;
}

function recsSetType(type) {
  const f = window._recsFilters || {};
  renderRecommendations(1, { ...f, type });
}

function applyRecsFilters() {
  const get = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : '';
  };
  const f = window._recsFilters || {};
  renderRecommendations(1, {
    type: f.type || '',
    genre: get('genre_recs'),
    yearFrom: get('yearFrom_recs'),
    yearTo: get('yearTo_recs'),
    minRating: get('minRating_recs'),
  });
}

// --- History Page -------------------------------------------------------------
async function renderHistory() {
  state.currentPage = 'history';
  const app = document.getElementById('app');

  app.innerHTML = `
    <div class="history-header">
      <div class="page-header" style="margin-bottom:0">
        <h1 class="page-title">Watch History</h1>
        <p class="page-subtitle">Everything you've marked as watched</p>
      </div>
    </div>
    <div id="newEpsBanner"></div>
    <div style="padding:0 2rem 2rem">
      <div class="tabs">
        <button class="tab active" id="histTabMovies" onclick="switchHistTab('movies')">Movies</button>
        <button class="tab" id="histTabTV" onclick="switchHistTab('tv')">TV Shows</button>
      </div>
      <div id="histMovies"><div class="page-loader"><div class="spinner"></div></div></div>
      <div id="histTV" style="display:none"></div>
    </div>`;

  try {
    const [db, newEps] = await Promise.all([
      getHistory(),
      api('/api/newEpisodes'),
    ]);

    state.newEpisodes = newEps;

    // New episodes banner
    if (newEps.length > 0) {
      const items = newEps.map((ep) => `
        <div class="new-ep-item">
          <div class="new-ep-info">
            <div class="new-ep-title">${escape(ep.title)}</div>
            <div class="new-ep-detail">
              You watched S${ep.lastWatchedSeason}E${ep.lastWatchedEpisode} -
              New: S${ep.latestSeason}E${ep.latestEpisode} "${escape(ep.latestEpisodeName || '')}"
              ${ep.latestAirDate ? `(${formatDate(ep.latestAirDate)})` : ''}
            </div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="openDetail('tv',${ep.tmdbId})">View</button>
        </div>`).join('');

      document.getElementById('newEpsBanner').innerHTML = `
        <div class="new-episodes-banner">
          <h3>New Episodes Available (${newEps.length})</h3>
          <div class="new-ep-list">${items}</div>
        </div>`;
    }

    window._historyDB = db;
    renderHistMovies(db);
    renderHistTV(db);
  } catch (e) {
    document.getElementById('histMovies').innerHTML = errorState(e);
  }
}

function renderHistMovies(db) {
  const el = document.getElementById('histMovies');
  if (!el) return;
  const movies = Object.values(db.movies || {}).sort((a, b) =>
    new Date(b.watchedAt) - new Date(a.watchedAt)
  );

  if (movies.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">0</div>
        <h3>No movies in history</h3>
        <p>Browse <a href="#/movies" style="color:var(--accent)">Movies</a> and mark them as watched.</p>
      </div>`;
    return;
  }

  el.innerHTML = `<div class="grid grid-lg">${
    movies.map((m) => buildCard(
      { ...m, id: m.tmdbId },
      { mediaType: 'movie', showTypeBadge: false, watched: true }
    ) + buildRemoveBtn('movie', m.tmdbId)).join('')
  }</div>`;
}

function renderHistTV(db) {
  const el = document.getElementById('histTV');
  if (!el) return;
  const shows = Object.values(db.tvShows || {}).sort((a, b) =>
    new Date(b.watchedAt) - new Date(a.watchedAt)
  );

  if (shows.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">0</div>
        <h3>No TV shows in history</h3>
        <p>Browse <a href="#/tv" style="color:var(--accent)">TV Shows</a> and track your episodes.</p>
      </div>`;
    return;
  }

  const newEpIds = new Set(state.newEpisodes.map((e) => String(e.tmdbId)));

  el.innerHTML = `<div class="grid grid-lg">${
    shows.map((s) => {
      const hasNew = newEpIds.has(String(s.tmdbId));
      const progress = (s.lastSeason && s.lastEpisode)
        ? { s: s.lastSeason, e: s.lastEpisode, pct: 60 }
        : null;
      return buildCard(
        { ...s, id: s.tmdbId },
        { mediaType: 'tv', showTypeBadge: false, watched: !hasNew, newEp: hasNew, progress }
      );
    }).join('')
  }</div>`;
}

function buildRemoveBtn(type, id) {
  // Not directly in card HTML ? handled via modal
  return '';
}

function switchHistTab(tab) {
  const moviesEl = document.getElementById('histMovies');
  const tvEl = document.getElementById('histTV');
  document.getElementById('histTabMovies').classList.toggle('active', tab === 'movies');
  document.getElementById('histTabTV').classList.toggle('active', tab === 'tv');
  if (moviesEl) moviesEl.style.display = tab === 'movies' ? '' : 'none';
  if (tvEl) tvEl.style.display = tab === 'tv' ? '' : 'none';
}

// --- Detail Modal -------------------------------------------------------------
async function openDetail(type, id) {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('open');

  content.innerHTML = `<div class="page-loader"><div class="spinner"></div></div>`;

  try {
    await ensureWatchlistLoaded();
    const item = await api(`/api/detail/${type}/${id}`);
    trackRecommendationEvent('detail_click', type, id, item, { silent: true });
    const t = item.title || item.name;
    const backdrop = BACKDROP(item.backdrop_path);
    const poster = POSTER(item.poster_path);
    const r = item.vote_average ? item.vote_average.toFixed(1) : '?';
    const genres = (item.genres || []).map((g) => `<span class="genre-chip">${g.name}</span>`).join('');
    const runtime = item.runtime ? `${item.runtime} min` :
      (item.episode_run_time && item.episode_run_time[0] ? `${item.episode_run_time[0]} min/ep` : '');
    const cast = (item.credits?.cast || []).slice(0, 12);
    const savedToWatchlist = isSavedToWatchlist(type, id);

    const castHTML = cast.length ? `
      <h3 class="modal-section-title">Cast</h3>
      <div class="cast-row">
        ${cast.map((c) => {
          const photo = c.profile_path
            ? `<img class="cast-photo" src="${AVATAR(c.profile_path)}" alt="${escape(c.name)}" loading="lazy" />`
            : `<div class="cast-photo" style="display:flex;align-items:center;justify-content:center;font-size:1.5rem;background:var(--bg-3)">Cast</div>`;
          return `<div class="cast-card">${photo}<div class="cast-name">${escape(c.name)}</div><div class="cast-character">${escape(c.character || '')}</div></div>`;
        }).join('')}
      </div>` : '';

    // Seasons for TV
    let seasonsHTML = '';
    if (type === 'tv' && item.seasons) {
      const sArr = item.seasons.filter((s) => s.season_number > 0);
      seasonsHTML = `
        <h3 class="modal-section-title">Seasons (${sArr.length})</h3>
        <div class="seasons-list">
          ${sArr.map((s) => `
            <div class="season-item">
              <div class="season-header" onclick="toggleSeason(this, ${item.id}, ${s.season_number})">
                <h4>${escape(s.name)}</h4>
                <span>${s.episode_count} episodes - ${s.air_date ? s.air_date.slice(0,4) : ''}</span>
              </div>
              <div class="season-episodes" id="season-${item.id}-${s.season_number}">
                <div class="page-loader" style="min-height:60px"><div class="spinner" style="width:24px;height:24px"></div></div>
              </div>
            </div>`).join('')}
        </div>`;
    }

    // Store current modal item for the watch button to reference
    window._modalItem = {
      type,
      item: {
        tmdbId: id,
        title: t,
        poster_path: item.poster_path,
        backdrop_path: item.backdrop_path,
        release_date: item.release_date,
        first_air_date: item.first_air_date,
        genres: item.genres,
        genre_ids: (item.genres || []).map((genre) => genre.id),
        vote_average: item.vote_average,
        popularity: item.popularity,
        original_language: item.original_language,
        runtime: item.runtime,
        episode_run_time: item.episode_run_time,
        credits: item.credits,
        belongs_to_collection: item.belongs_to_collection,
        created_by: item.created_by,
        ...(type === 'tv' && { totalSeasons: item.number_of_seasons }),
      },
    };

    content.innerHTML = `
      ${backdrop ? `<img class="modal-backdrop" src="${escape(backdrop)}" alt="" />` : ''}
      <div class="modal-layout">
        ${poster ? `<div class="modal-poster"><img src="${escape(poster)}" alt="${escape(t)}" /></div>` : ''}
        <div class="modal-info">
          <h2 class="modal-title">${escape(t)}</h2>
          ${item.tagline ? `<p class="modal-tagline">"${escape(item.tagline)}"</p>` : ''}
          <div class="modal-meta">
            <span class="modal-meta-item"><span class="rating">Rating ${r}</span> / 10</span>
            ${year(item) ? `<span class="modal-meta-item">Year ${year(item)}</span>` : ''}
            ${runtime ? `<span class="modal-meta-item">Runtime ${runtime}</span>` : ''}
            ${item.status ? `<span class="modal-meta-item">Status ${item.status}</span>` : ''}
            ${item.number_of_seasons ? `<span class="modal-meta-item">Seasons ${item.number_of_seasons}</span>` : ''}
            ${item.number_of_episodes ? `<span class="modal-meta-item">${item.number_of_episodes} episodes</span>` : ''}
            ${item.original_language ? `<span class="modal-meta-item">Lang ${item.original_language.toUpperCase()}</span>` : ''}
          </div>
          <div class="modal-genres">${genres}</div>
          <p class="modal-overview">${escape(item.overview || 'No overview available.')}</p>
          <div class="modal-actions">
            <button class="btn btn-primary" style="font-size:1rem;padding:.7rem 1.6rem" onclick="closeModal();openStreamWizard('${type}',${id},'${escape(t)}')">
              Stream
            </button>
            <button class="btn btn-outline" id="modalWatchlistBtn" onclick="toggleCurrentModalWatchlist()">
              ${savedToWatchlist ? 'Saved' : 'Save'}
            </button>
            <button class="btn btn-secondary" onclick="markCurrentModalItem()">
              Mark Watched
            </button>
            <button class="btn btn-danger btn-sm" onclick="removeHistoryFromModal('${type}',${id})">
              Remove
            </button>
          </div>
          <div class="cli-hint">
            CLI: <code>uplayer "${escape(t)}"</code>
          </div>
        </div>
      </div>
      ${castHTML}
      ${seasonsHTML}
      <div id="modalRecs"></div>`;
  } catch (e) {
    content.innerHTML = errorState(e);
  }
}

async function toggleSeason(headerEl, showId, seasonNum) {
  const episodesEl = document.getElementById(`season-${showId}-${seasonNum}`);
  if (!episodesEl) return;

  if (episodesEl.classList.contains('open')) {
    episodesEl.classList.remove('open');
    return;
  }

  episodesEl.classList.add('open');

  if (episodesEl.querySelector('.spinner')) {
    try {
      const data = await api(`/api/tv/${showId}/season/${seasonNum}`);
      const eps = (data.episodes || []).map((ep) => `
        <div class="ep-item" onclick="markEpWatched(${showId}, '${escape(data.name || '')}', ${ep.season_number}, ${ep.episode_number}, event)">
          <div class="ep-num">${ep.episode_number}</div>
          <div class="ep-info">
            <div class="ep-name">${escape(ep.name || `Episode ${ep.episode_number}`)}</div>
            <div class="ep-date">${ep.air_date ? formatDate(ep.air_date) : 'TBA'}</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();markEpWatched(${showId}, '${escape(data.name || '')}', ${ep.season_number}, ${ep.episode_number}, event)">
            Mark
          </button>
        </div>`).join('');
      episodesEl.innerHTML = eps || '<p class="text-muted" style="padding:.5rem;font-size:.8rem">No episodes found</p>';
    } catch (e) {
      episodesEl.innerHTML = `<p style="padding:.5rem;font-size:.8rem;color:var(--red)">Failed to load episodes</p>`;
    }
  }
}

async function markEpWatched(showId, showTitle, season, episode, event) {
  event && event.stopPropagation();
  const item = {
    tmdbId: showId,
    title: showTitle,
    lastSeason: season,
    lastEpisode: episode,
  };
  await markWatched('tv', item);
}

async function markCurrentModalItem() {
  const m = window._modalItem;
  if (!m) return;
  await markWatched(m.type, m.item);
}

async function toggleCurrentModalWatchlist() {
  const modal = window._modalItem;
  if (!modal) return;
  const result = await toggleWatchlistItem(modal.type, modal.item);
  const btn = document.getElementById('modalWatchlistBtn');
  if (btn) {
    btn.textContent = result.saved ? 'Saved' : 'Save';
  }
  if (state.currentPage === 'recommendations') {
    renderRecommendations(1, window._recsFilters || {});
  }
}

async function toggleWatchlistFromCard(event, type, id) {
  if (event) event.stopPropagation();
  const item = {
    tmdbId: id,
    title: event?.currentTarget?.closest('.card')?.querySelector('.card-title')?.textContent || 'Unknown',
  };
  await toggleWatchlistItem(type, item);
  if (state.currentPage === 'recommendations') {
    renderRecommendations(1, window._recsFilters || {});
  }
}

async function markWatchedFromDetail(type, item) {
  await markWatched(type, item);
}

async function removeHistoryFromModal(type, id) {
  await removeHistory(type, id);
  closeModal();
}

// --- Close Modal --------------------------------------------------------------
function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});
document.getElementById('castModalClose').addEventListener('click', closeCastTvModal);
document.getElementById('castModalOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeCastTvModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const castOverlay = document.getElementById('castModalOverlay');
  if (castOverlay && castOverlay.classList.contains('open')) {
    closeCastTvModal();
    return;
  }
  closeModal();
});

// --- Nav Search ---------------------------------------------------------------
function doNavSearch() {
  const q = document.getElementById('navSearchInput').value.trim();
  if (!q) return;
  navigate(`/search?q=${encodeURIComponent(q)}`);
  if (window.location.hash.startsWith('#/search')) renderSearch(q);
}

document.getElementById('navSearchBtn').addEventListener('click', doNavSearch);
document.getElementById('navSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doNavSearch();
});

// --- Hamburger ----------------------------------------------------------------
document.getElementById('hamburger').addEventListener('click', () => {
  document.getElementById('navLinks').classList.toggle('open');
});

// --- Navbar scroll effect -----------------------------------------------------
window.addEventListener('scroll', () => {
  document.getElementById('navbar').style.background =
    window.scrollY > 50 ? 'rgba(11,12,15,0.97)' : 'rgba(11,12,15,0.85)';
}, { passive: true });

// --- Error / Empty helpers ----------------------------------------------------
function errorState(e) {
  return `
    <div class="empty-state">
      <div class="empty-icon">!</div>
      <h3>Something went wrong</h3>
      <p>${escape(e.message || 'Unknown error')}</p>
    </div>`;
}

function emptyCards() {
  return `
    <div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">0</div>
      <h3>No results found</h3>
      <p>Try adjusting your filters.</p>
    </div>`;
}

// --- Streaming Wizard ---------------------------------------------------------

const wizard = {
  type: null,      // 'movie' | 'tv'
  tmdbId: null,
  titleText: '',
  year: '',
  tmdbYear: '',
  // TV selections
  seasons: [],
  selectedSeason: null,
  episodes: [],
  selectedEpisode: null,
  // Torrent
  torrents: [],
  selectedTorrent: null,
  resolvedMagnet: null,
  // Subtitles
  subtitleLangs: [],
  selectedLang: 'en',
  subtitles: [],
  selectedSubtitle: null,
  subtitleToken: null,
  subtitleTokenExpiresAt: null,
  skipSubtitles: false,
  // Stream
  sessionId: null,
  sseSource: null,
  playerUrl: null,
  vlcUrl: null,
  castUrl: null,
  subtitleManifestUrl: null,
  videoFormat: null,
  detail: null,
  historySaved: false,
  // Step
  step: 1, // 1=episode(TV)/torrent(movie), 2=torrents, 3=subtitles, 4=streaming
};

const CAST_SENDER_SCRIPT = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
const LOCAL_QR_SCRIPT = '/vendor/qrcode.min.js';
const DEFAULT_CAST_RECEIVER_APP_ID = 'CC1AD845';
const CAST_SESSION_STORAGE_KEY = 'uplayer.cast.session.v1';
const castTvState = {
  meta: null,
  subtitleOptions: [],
  selectedSubtitleTrackId: '',
  senderAllowed: false,
  castSdkReady: false,
  senderHelperUrl: '',
  // Cast session state
  isCasting: false,
  castSession: null,
  castDeviceName: '',
  castVolume: 0.5,
  isMuted: false,
};
const externalScriptPromises = new Map();
let googleCastSdkPromise = null;
let googleCastContextReady = false;
let castStatusUpdateInterval = null;

const WIZARD_STORAGE_KEY = 'uplayer.stream.wizard.v2';
const WIZARD_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function getWizardSnapshot() {
  return {
    type: wizard.type,
    tmdbId: wizard.tmdbId,
    titleText: wizard.titleText,
    tmdbYear: wizard.tmdbYear,
    selectedSeason: wizard.selectedSeason,
    selectedEpisode: wizard.selectedEpisode,
    selectedLang: wizard.selectedLang,
    selectedTorrent: wizard.selectedTorrent,
    resolvedMagnet: wizard.resolvedMagnet,
    subtitleToken: wizard.subtitleToken,
    subtitleTokenExpiresAt: wizard.subtitleTokenExpiresAt,
    skipSubtitles: wizard.skipSubtitles,
    sessionId: wizard.sessionId,
    playerUrl: wizard.playerUrl,
    vlcUrl: wizard.vlcUrl,
    castUrl: wizard.castUrl,
    subtitleManifestUrl: wizard.subtitleManifestUrl,
    step: wizard.step,
    savedAt: Date.now(),
  };
}

function persistWizardState() {
  try {
    if (!wizard.type || !wizard.tmdbId) return;
    sessionStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(getWizardSnapshot()));
  } catch (e) {
    // Ignore storage write failures.
  }
}

function clearWizardState() {
  try {
    sessionStorage.removeItem(WIZARD_STORAGE_KEY);
  } catch (e) {
    // Ignore storage delete failures.
  }
}

// --- Cast Session Persistence ---

function saveCastSessionState() {
  try {
    if (!castTvState.isCasting) {
      sessionStorage.removeItem(CAST_SESSION_STORAGE_KEY);
      return;
    }
    const state = {
      isCasting: castTvState.isCasting,
      castDeviceName: castTvState.castDeviceName,
      castVolume: castTvState.castVolume,
      isMuted: castTvState.isMuted,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(CAST_SESSION_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // Ignore storage failures
  }
}

function loadCastSessionState() {
  try {
    const raw = sessionStorage.getItem(CAST_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.savedAt) return null;
    // Expire after 5 minutes
    if (Date.now() - parsed.savedAt > 5 * 60 * 1000) {
      sessionStorage.removeItem(CAST_SESSION_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

function clearCastSessionState() {
  try {
    sessionStorage.removeItem(CAST_SESSION_STORAGE_KEY);
  } catch (e) {
    // Ignore storage failures
  }
}

function loadWizardState(expectedType, expectedId) {
  try {
    const raw = sessionStorage.getItem(WIZARD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.savedAt) return null;
    if (Date.now() - parsed.savedAt > WIZARD_MAX_AGE_MS) return null;
    if (parsed.type !== expectedType) return null;
    if (Number(parsed.tmdbId) !== Number(expectedId)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function loadAnyWizardState() {
  try {
    const raw = sessionStorage.getItem(WIZARD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.savedAt) return null;
    if (Date.now() - parsed.savedAt > WIZARD_MAX_AGE_MS) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function openStreamWizard(type, tmdbId, titleText) {
  // Navigate to the stream page with parameters
  navigate(`/stream?type=${type}&id=${tmdbId}&title=${encodeURIComponent(titleText)}`);
}

function buildWizardHistoryItem() {
  const detail = wizard.detail || {};
  const item = {
    tmdbId: wizard.tmdbId,
    title: wizard.titleText || title(detail),
    poster_path: detail.poster_path,
    backdrop_path: detail.backdrop_path,
    release_date: detail.release_date,
    first_air_date: detail.first_air_date,
  };

  if (wizard.type === 'tv') {
    item.totalSeasons = detail.number_of_seasons || wizard.seasons.length || undefined;
    if (wizard.selectedSeason) item.lastSeason = wizard.selectedSeason;
    if (wizard.selectedEpisode) item.lastEpisode = wizard.selectedEpisode;
  }

  return normalizeHistoryItem(wizard.type, item);
}

async function saveWizardHistoryIfNeeded() {
  if (wizard.historySaved || !wizard.type || !wizard.tmdbId) return;
  const item = buildWizardHistoryItem();
  if (!item.tmdbId) return;
  try {
    await markWatched(wizard.type, item, { silent: true });
    wizard.historySaved = true;
  } catch (e) {
    console.warn('Failed to save watch history:', e);
  }
}

function normalizeActiveStreamMeta(meta = {}) {
  const source = meta && typeof meta === 'object' ? meta : {};
  return {
    sessionId: source.sessionId || source.id || wizard.sessionId || null,
    playerUrl: source.playerUrl || source.url || wizard.playerUrl || null,
    vlcUrl: source.vlcUrl || source.mediaUrl || wizard.vlcUrl || null,
    castUrl: source.castUrl || wizard.castUrl || null,
    subtitleManifestUrl: source.subtitleManifestUrl || wizard.subtitleManifestUrl || null,
    videoFormat: source.videoFormat || null,
  };
}

function applyActiveStreamMeta(meta, options = {}) {
  const normalized = normalizeActiveStreamMeta(meta);
  wizard.sessionId = normalized.sessionId;
  wizard.playerUrl = normalized.playerUrl;
  wizard.vlcUrl = normalized.vlcUrl;
  wizard.castUrl = normalized.castUrl;
  wizard.subtitleManifestUrl = normalized.subtitleManifestUrl;
  wizard.videoFormat = normalized.videoFormat || null;
  if (options.persist) persistWizardState();
  return normalized;
}

async function resolveActiveStreamMeta(fallbacks = {}) {
  const normalizedFallbacks = normalizeActiveStreamMeta({
    ...fallbacks,
    playerUrl: fallbacks.playerUrl && fallbacks.playerUrl !== '#' ? fallbacks.playerUrl : null,
  });

  try {
    const active = await fetchJson('/api/stream/status');
    const preferred = active.find((session) => session.id === normalizedFallbacks.sessionId)
      || active.find((session) => session.playerUrl && (session.running || !session.exited))
      || active.find((session) => session.playerUrl);
    if (preferred) {
      return normalizeActiveStreamMeta(preferred);
    }
  } catch (e) {
    // Ignore polling errors and fall back to the rendered stream metadata.
  }

  return normalizedFallbacks;
}

async function resolveActivePlayerUrl(fallbackUrl) {
  const meta = await resolveActiveStreamMeta({ playerUrl: fallbackUrl });
  return meta.playerUrl || null;
}

function openActivePlayer(event, fallbackUrl) {
  if (event) event.preventDefault();
  let popup = null;
  try {
    popup = window.open('', '_blank');
    if (popup) {
      popup.opener = null;
    }
  } catch (e) {
    popup = null;
  }

  resolveActivePlayerUrl(fallbackUrl).then((url) => {
    if (url) {
      if (popup && !popup.closed) popup.location.replace(url);
      else window.open(url, '_blank', 'noopener');
      return;
    }

    if (popup && !popup.closed) popup.close();
    if (state.currentPage !== 'stream') navigate('/stream');
    toast('Player is still starting', 'info');
  }).catch(() => {
    if (popup && !popup.closed) popup.close();
    toast('Could not open the active player', 'error');
  });

  return false;
}

function openActiveVlc(event, fallbackSessionId) {
  if (event) event.preventDefault();
  const sessionId = fallbackSessionId || wizard.sessionId || null;
  fetchJson('/api/stream/open-vlc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sessionId ? { sessionId } : {}),
  }).then((data) => {
    toast(data.message || 'Opening stream in VLC', 'success');
  }).catch((error) => {
    const message = error && error.message ? String(error.message) : 'Could not open VLC';
    if (/player is still starting/i.test(message)) {
      if (state.currentPage !== 'stream') navigate('/stream');
      toast('Player is still starting', 'info');
      return;
    }
    if (/session not found/i.test(message) && state.currentPage !== 'stream') {
      navigate('/stream');
    }
    toast(message, 'error', 5000);
  });
  return false;
}

function isCastSenderOriginAllowed(locationLike = window.location) {
  if (!locationLike) return false;
  const protocol = String(locationLike.protocol || '').toLowerCase();
  const hostname = String(locationLike.hostname || '').toLowerCase();
  return protocol === 'https:'
    || hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function buildLocalhostSenderUrl(locationLike = window.location) {
  if (!locationLike) return 'http://localhost/';
  const port = locationLike.port ? `:${locationLike.port}` : '';
  const path = locationLike.pathname || '/';
  const search = locationLike.search || '';
  const hash = locationLike.hash || '';
  const protocol = String(locationLike.protocol || '').toLowerCase() === 'https:' ? 'https:' : 'http:';
  return `${protocol}//localhost${port}${path}${search}${hash}`;
}

function guessVideoContentType(url) {
  const pathname = (() => {
    try {
      return new URL(url, window.location.href).pathname.toLowerCase();
    } catch (e) {
      return String(url || '').toLowerCase();
    }
  })();

  if (pathname.endsWith('.mp4')) return 'video/mp4';
  if (pathname.endsWith('.mkv')) return 'video/x-matroska';
  if (pathname.endsWith('.webm')) return 'video/webm';
  if (pathname.endsWith('.mov')) return 'video/quicktime';
  if (pathname.endsWith('.avi')) return 'video/x-msvideo';
  if (pathname.endsWith('.m4v')) return 'video/x-m4v';
  return 'video/mp4';
}

function buildCastMediaDraft(meta, subtitleOptions = [], selectedSubtitleTrackId, displayTitle) {
  const normalized = normalizeActiveStreamMeta(meta);
  const castUrl = normalized.castUrl || '';

  // Ensure cast URL uses network IP, not localhost
  let contentUrl = castUrl;
  if (castUrl.includes('localhost') || castUrl.includes('127.0.0.1')) {
    // Try to use the playerUrl which should have network IP, or construct from window.location
    const networkHost = window.location.hostname !== 'localhost'
      ? window.location.host
      : null;
    if (networkHost) {
      try {
        const urlObj = new URL(castUrl);
        urlObj.host = networkHost;
        contentUrl = urlObj.href;
      } catch (e) {
        // Keep original URL if parsing fails
      }
    }
  }

  const tracks = subtitleOptions.map((track, index) => ({
    trackId: Number(track.trackId) || index + 1,
    type: 'TEXT',
    subtype: 'SUBTITLES',
    trackContentId: track.trackContentId,
    trackContentType: track.trackContentType || 'text/vtt',
    name: track.name || track.label || `Subtitle ${index + 1}`,
    language: track.language || 'en',
  }));
  const fallbackTrackId = tracks.length > 0 ? tracks[0].trackId : null;
  const activeTrackId = selectedSubtitleTrackId
    ? Number(selectedSubtitleTrackId)
    : fallbackTrackId;
  return {
    contentId: contentUrl,
    contentType: 'video/mp4', // Chromecast needs MP4 for best compatibility
    streamType: 'BUFFERED', // Use BUFFERED for on-demand content (allows seeking, less latency)
    metadata: {
      title: displayTitle || wizard.titleText || 'Uplayer Stream',
    },
    tracks,
    activeTrackIds: activeTrackId ? [activeTrackId] : [],
  };
}

function renderCastTvModalContent(meta, state = {}) {
  const normalized = normalizeActiveStreamMeta(meta);
  const subtitleOptions = Array.isArray(state.subtitleOptions) ? state.subtitleOptions : [];
  const selectedSubtitleTrackId = state.selectedSubtitleTrackId || '';
  const senderAllowed = !!state.senderAllowed;
  const castSdkReady = !!state.castSdkReady;
  const senderHelperUrl = state.senderHelperUrl || '';
  const sameNetworkUrl = normalized.playerUrl || '';
  const isCasting = castTvState.isCasting && castTvState.castSession;
  const castDeviceName = castTvState.castDeviceName || 'Chromecast';
  const castVolume = castTvState.castVolume || 0.5;
  const isMuted = castTvState.isMuted || false;

  const chromecastSection = senderAllowed
    ? `
      <div class="cast-modal-card">
        <div class="cast-modal-card-head">
          <div>
            <h3>Chromecast</h3>
            <p>${isCasting ? `Currently casting to <strong>${escape(castDeviceName)}</strong>` : 'Send the stream from this browser to a Chromecast on the same network.'}</p>
          </div>
          <span class="cast-chip ${isCasting ? 'cast-chip-casting' : 'cast-chip-ready'}">${isCasting ? 'Casting' : 'Ready'}</span>
        </div>
        ${isCasting ? `
          <label class="cast-modal-label">Volume</label>
          <div class="cast-volume-control">
            <button type="button" class="cast-volume-btn" onclick="return toggleCastMute()" title="${isMuted ? 'Unmute' : 'Mute'}">
              ${isMuted ? '🔇' : '🔊'}
            </button>
            <input type="range" class="cast-volume-slider" min="0" max="100" value="${Math.round(castVolume * 100)}" 
              onchange="return setCastVolume(this.value / 100)" 
              onclick="return setCastVolume(this.value / 100)">
            <span class="cast-volume-value">${Math.round(castVolume * 100)}%</span>
          </div>
          ${subtitleOptions.length > 0 ? `
            <label class="cast-modal-label" for="castSubtitleSelect">Subtitle track</label>
            <select id="castSubtitleSelect" class="cast-modal-select" onchange="handleCastSubtitleSelection(this.value)">
              ${subtitleOptions.map((track) => `
                <option value="${escape(String(track.trackId))}" ${String(track.trackId) === String(selectedSubtitleTrackId) ? 'selected' : ''}>
                  ${escape(track.name || `Subtitle ${track.trackId}`)}
                </option>`).join('')}
            </select>
            <p class="cast-modal-note">Changing subtitles may require restarting the cast session.</p>
          ` : `
            <p class="cast-modal-note">No subtitles available for this stream.</p>
          `}
          <div class="cast-modal-actions">
            <button type="button" class="btn btn-danger" onclick="return stopChromecastCast(event)">
              Stop Casting
            </button>
          </div>
        ` : `
          ${subtitleOptions.length > 0 ? `
            <label class="cast-modal-label" for="castSubtitleSelect">Subtitle track</label>
            <select id="castSubtitleSelect" class="cast-modal-select" onchange="handleCastSubtitleSelection(this.value)">
              ${subtitleOptions.map((track) => `
                <option value="${escape(String(track.trackId))}" ${String(track.trackId) === String(selectedSubtitleTrackId) ? 'selected' : ''}>
                  ${escape(track.name || `Subtitle ${track.trackId}`)}
                </option>`).join('')}
            </select>
            <p class="cast-modal-note">The selected subtitle will be sent with the Chromecast session.</p>
          ` : `
            <p class="cast-modal-note">No subtitles available for this stream. Casting will continue without subtitles.</p>
          `}
          <div class="cast-modal-actions">
            <button type="button" class="btn btn-primary" onclick="return startChromecastCast(event)" ${castSdkReady ? '' : 'disabled'}>
              ${castSdkReady ? 'Choose Chromecast' : 'Preparing Chromecast...'}
            </button>
          </div>
          <p class="cast-modal-note">
            ${castSdkReady
              ? 'Choose a Chromecast device and Uplayer will send the stream as soon as the connection starts.'
              : 'Loading the Chromecast sender tools for this page.'}
          </p>
        `}
      </div>`
    : `
      <div class="cast-modal-card cast-modal-card-disabled">
        <div class="cast-modal-card-head">
          <div>
            <h3>Chromecast</h3>
            <p>Chromecast sending is only enabled from localhost or HTTPS sender pages.</p>
          </div>
          <span class="cast-chip">Host PC only</span>
        </div>
        <p class="cast-modal-note">Open this same Uplayer page on localhost in Chrome or Edge, then cast from there.</p>
        <div class="cast-modal-actions">
          <a class="btn btn-outline" href="${escape(senderHelperUrl)}">
            Open on localhost for Cast
          </a>
        </div>
      </div>`;

  const tvSection = sameNetworkUrl
    ? `
      <div class="cast-modal-card">
        <div class="cast-modal-card-head">
          <div>
            <h3>Open on TV</h3>
            <p>Use this same-network link on Samsung, LG, Chromecast with Google TV browsers, or any TV browser.</p>
          </div>
          <span class="cast-chip">TV browser</span>
        </div>
        <label class="cast-modal-label" for="castTvLinkInput">TV link</label>
        <div class="cast-link-row">
          <input id="castTvLinkInput" class="cast-link-input" type="text" readonly value="${escape(sameNetworkUrl)}">
          <button type="button" class="btn btn-outline btn-sm" onclick="return copyCastTvLink(event)">
            Copy Link
          </button>
        </div>
        <div class="cast-qr-wrap">
          <div class="cast-qr-box" id="castQrCode">
            <div class="cast-qr-placeholder">Loading QR...</div>
          </div>
          <div class="cast-qr-copy">
            <p>Scan this QR code from the TV or another device on the same network.</p>
            <a class="btn btn-outline" href="${escape(sameNetworkUrl)}" target="_blank" rel="noopener">
              Open TV Link
            </a>
          </div>
        </div>
        <div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap">
          <button type="button" class="btn btn-outline btn-sm" onclick="return testTvReadiness(event)">
            Test TV Readiness
          </button>
          <span id="tvReadinessStatus" style="font-size:0.8rem;color:var(--text-muted);align-self:center"></span>
        </div>
      </div>`
    : `
      <div class="cast-modal-card">
        <div class="cast-modal-card-head">
          <div>
            <h3>Open on TV</h3>
            <p>The TV-ready link will appear when the stream player is live.</p>
          </div>
        </div>
      </div>`;

  return `
    <div class="cast-modal-shell">
      <div class="cast-modal-header">
        <div>
          <h2>Cast / TV</h2>
          <p>Chromecast from this PC browser, or open the same stream directly on a TV browser.</p>
        </div>
      </div>
      <div class="cast-modal-grid">
        ${chromecastSection}
        ${tvSection}
      </div>
    </div>`;
}

function loadScriptOnce(src) {
  if (externalScriptPromises.has(src)) {
    return externalScriptPromises.get(src);
  }

  const promise = new Promise((resolve, reject) => {
    const existing = Array.from(document.getElementsByTagName('script'))
      .find((script) => script.getAttribute('src') === src);
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve(existing);
        return;
      }
      existing.addEventListener('load', () => resolve(existing), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Could not load script: ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve(script);
    }, { once: true });
    script.addEventListener('error', () => {
      externalScriptPromises.delete(src);
      reject(new Error(`Could not load script: ${src}`));
    }, { once: true });
    document.head.appendChild(script);
  });

  externalScriptPromises.set(src, promise);
  return promise;
}

function loadQrCodeLibrary() {
  if (typeof window.qrcode === 'function') return Promise.resolve();
  return loadScriptOnce(LOCAL_QR_SCRIPT).then(() => {
    if (typeof window.qrcode !== 'function') {
      throw new Error('QR generator is unavailable');
    }
  });
}

function loadGoogleCastSenderSdk() {
  if (window.cast && window.cast.framework && window.chrome && window.chrome.cast) {
    return Promise.resolve();
  }
  if (googleCastSdkPromise) return googleCastSdkPromise;

  googleCastSdkPromise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      googleCastSdkPromise = null;
      reject(new Error('Timed out loading Google Cast sender'));
    }, 10000);

    const previousCallback = window.__onGCastApiAvailable;
    window.__onGCastApiAvailable = function onGCastApiAvailable(isAvailable) {
      if (typeof previousCallback === 'function') {
        previousCallback(isAvailable);
      }
      clearTimeout(timeoutId);
      if (isAvailable && window.cast && window.cast.framework && window.chrome && window.chrome.cast) {
        resolve();
        return;
      }
      googleCastSdkPromise = null;
      reject(new Error('Google Cast sender is unavailable on this page'));
    };

    loadScriptOnce(CAST_SENDER_SCRIPT).catch((error) => {
      clearTimeout(timeoutId);
      googleCastSdkPromise = null;
      reject(error);
    });
  });

  return googleCastSdkPromise;
}

function getReadyGoogleCastContext() {
  const castContext = window.cast && window.cast.framework
    ? window.cast.framework.CastContext.getInstance()
    : null;
  if (!castContext) return null;
  if (!googleCastContextReady) {
    castContext.setOptions({
      receiverApplicationId: (window.chrome && window.chrome.cast && window.chrome.cast.media
        ? window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID
        : null) || DEFAULT_CAST_RECEIVER_APP_ID,
      autoJoinPolicy: window.chrome && window.chrome.cast
        ? window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
        : 'origin_scoped',
    });
    googleCastContextReady = true;
  }
  return castContext;
}

async function ensureGoogleCastContext() {
  await loadGoogleCastSenderSdk();
  const castContext = getReadyGoogleCastContext();
  if (!castContext) {
    throw new Error('Google Cast sender is unavailable on this page');
  }
  return castContext;
}

async function loadCastSubtitleOptions(subtitleManifestUrl) {
  if (!subtitleManifestUrl) return [];
  const data = await fetchJson(subtitleManifestUrl);
  const subtitles = Array.isArray(data.subtitles) ? data.subtitles : [];
  return subtitles.map((track, index) => ({
    trackId: index + 1,
    name: track.label || `Subtitle ${index + 1}`,
    language: track.language || 'en',
    trackContentId: new URL(track.url, subtitleManifestUrl).href,
    trackContentType: 'text/vtt',
    source: track.source || 'unknown',
  }));
}

function renderCastQrCode(url) {
  const container = document.getElementById('castQrCode');
  if (!container) return;
  if (!url) {
    container.innerHTML = '<div class="cast-qr-placeholder">Waiting for TV link...</div>';
    return;
  }

  container.innerHTML = '<div class="cast-qr-placeholder">Loading QR...</div>';
  loadQrCodeLibrary().then(() => {
    if (!document.getElementById('castQrCode')) return;
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    container.innerHTML = qr.createImgTag(4, 6, 'TV Link QR');
  }).catch(() => {
    container.innerHTML = '<div class="cast-qr-placeholder">QR unavailable</div>';
  });
}

function closeCastTvModal() {
  const overlay = document.getElementById('castModalOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

function handleCastSubtitleSelection(value) {
  castTvState.selectedSubtitleTrackId = String(value || '');
  return false;
}

function copyCastTvLink(event) {
  if (event) event.preventDefault();
  const link = castTvState.meta && castTvState.meta.playerUrl ? castTvState.meta.playerUrl : '';
  if (!link) {
    toast('TV link is not ready yet', 'info');
    return false;
  }

  const fallbackCopy = () => {
    const input = document.getElementById('castTvLinkInput');
    if (!input) return false;
    input.focus();
    input.select();
    try {
      document.execCommand('copy');
      toast('TV link copied', 'success');
      return true;
    } catch (e) {
      return false;
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => {
      toast('TV link copied', 'success');
    }).catch(() => {
      if (!fallbackCopy()) {
        toast('Could not copy the TV link', 'error');
      }
    });
  } else if (!fallbackCopy()) {
    toast('Could not copy the TV link', 'error');
  }

  return false;
}

async function testTvReadiness(event) {
  if (event) event.preventDefault();
  
  const statusEl = document.getElementById('tvReadinessStatus');
  if (statusEl) {
    statusEl.textContent = 'Testing...';
    statusEl.style.color = 'var(--text-muted)';
  }
  
  try {
    const data = await fetchJson('/api/cast/test');
    
    if (!data.ready) {
      if (statusEl) {
        statusEl.textContent = 'Not ready: ' + (data.message || data.error);
        statusEl.style.color = 'var(--red)';
      }
      toast(data.message || 'TV not ready', 'error', 5000);
      return false;
    }
    
    // Check test results
    const issues = [];
    if (!data.tests.castUrlAccessible) {
      issues.push('Cast URL not accessible from network');
    }
    if (!data.tests.subtitleManifestAccessible && data.subtitleManifestUrl) {
      issues.push('Subtitle manifest not accessible from network');
    }
    if (!data.tests.streamRunning) {
      issues.push('Stream is not running');
    }
    
    if (issues.length > 0) {
      if (statusEl) {
        statusEl.textContent = 'Issues found';
        statusEl.style.color = 'var(--gold)';
      }
      toast('TV readiness issues: ' + issues.join(', '), 'warning', 6000);
      
      // Show recommendations
      if (data.recommendations && data.recommendations.length > 0) {
        setTimeout(() => {
          data.recommendations.forEach(rec => toast(rec, 'info', 8000));
        }, 1000);
      }
    } else {
      if (statusEl) {
        statusEl.textContent = '✓ TV Ready!';
        statusEl.style.color = 'var(--green)';
      }
      toast('TV is ready to receive the stream!', 'success', 4000);
      
      // Auto-open the TV link in a new tab after a short delay
      setTimeout(() => {
        if (data.castUrl) {
          window.open(data.castUrl, '_blank', 'noopener');
          toast('Opening stream in new tab for testing...', 'info', 3000);
        }
      }, 1500);
    }
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = 'Test failed';
      statusEl.style.color = 'var(--red)';
    }
    toast('TV readiness test failed: ' + error.message, 'error', 5000);
  }
  
  return false;
}

async function populateCastTvModal(meta) {
  const content = document.getElementById('castModalContent');
  if (!content) return;

  const normalized = normalizeActiveStreamMeta(meta);
  const senderAllowed = isCastSenderOriginAllowed();
  const senderHelperUrl = senderAllowed ? '' : buildLocalhostSenderUrl();
  let subtitleOptions = [];

  // Always refresh subtitle options from the server
  if (normalized.subtitleManifestUrl) {
    try {
      subtitleOptions = await loadCastSubtitleOptions(normalized.subtitleManifestUrl);
    } catch (e) {
      subtitleOptions = [];
    }
  }

  castTvState.meta = normalized;
  castTvState.subtitleOptions = subtitleOptions;
  // Preserve selected subtitle track if it still exists, otherwise select first
  if (subtitleOptions.length > 0) {
    const currentTrackId = String(castTvState.selectedSubtitleTrackId || '');
    const selectedStillExists = subtitleOptions.some((track) => String(track.trackId) === currentTrackId);
    castTvState.selectedSubtitleTrackId = selectedStillExists ? currentTrackId : String(subtitleOptions[0].trackId);
  } else {
    castTvState.selectedSubtitleTrackId = '';
  }
  castTvState.senderAllowed = senderAllowed;
  castTvState.castSdkReady = false;
  castTvState.senderHelperUrl = senderHelperUrl;

  const renderState = () => {
    content.innerHTML = renderCastTvModalContent(normalized, {
      senderAllowed,
      senderHelperUrl,
      subtitleOptions: castTvState.subtitleOptions,
      selectedSubtitleTrackId: castTvState.selectedSubtitleTrackId,
      castSdkReady: castTvState.castSdkReady,
    });
    renderCastQrCode(normalized.playerUrl);
  };

  renderState();

  if (senderAllowed) {
    try {
      await ensureGoogleCastContext();
      castTvState.castSdkReady = true;
      renderState();
      // Try to restore cast session if one exists
      restoreCastSession();
      startCastStatusUpdates();
    } catch (error) {
      castTvState.castSdkReady = false;
      renderState();
      // Keep the modal usable for TV browser fallback even if Cast SDK load fails.
    }
  } else {
    updateCastStatusIndicator();
  }
}

function openCastTvModal(event) {
  if (event) event.preventDefault();
  const overlay = document.getElementById('castModalOverlay');
  const content = document.getElementById('castModalContent');
  if (!overlay || !content) return false;

  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('open');
  content.innerHTML = '<div class="page-loader"><div class="spinner"></div></div>';

  resolveActiveStreamMeta({
    sessionId: wizard.sessionId,
    playerUrl: wizard.playerUrl,
    vlcUrl: wizard.vlcUrl,
    castUrl: wizard.castUrl,
    subtitleManifestUrl: wizard.subtitleManifestUrl,
  }).then((meta) => {
    if (!meta.playerUrl) {
      closeCastTvModal();
      if (state.currentPage !== 'stream') navigate('/stream');
      toast('Player is still starting', 'info');
      return;
    }
    applyActiveStreamMeta(meta, { persist: true });
    return populateCastTvModal(meta);
  }).catch((error) => {
    closeCastTvModal();
    toast(error && error.message ? error.message : 'Could not open Cast / TV', 'error', 5000);
  });

  return false;
}

function startChromecastCast(event) {
  if (event) event.preventDefault();
  if (!castTvState.senderAllowed) {
    toast('Open Uplayer on localhost in Chrome or Edge to use Chromecast', 'info', 5000);
    return false;
  }
  if (!castTvState.castSdkReady) {
    toast('Chromecast is still preparing on this page', 'info');
    return false;
  }

  const meta = castTvState.meta || normalizeActiveStreamMeta();
  if (!meta.castUrl) {
    toast('Cast stream is not ready yet', 'info');
    return false;
  }

  const castContext = getReadyGoogleCastContext();
  if (!castContext) {
    toast('Google Cast sender is unavailable on this page', 'error', 5000);
    return false;
  }

  let sessionPromise;
  try {
    const activeSession = typeof castContext.getCurrentSession === 'function'
      ? castContext.getCurrentSession()
      : null;
    sessionPromise = activeSession || typeof castContext.requestSession !== 'function'
      ? Promise.resolve(activeSession)
      : castContext.requestSession();
  } catch (error) {
    toast(`Could not start Chromecast: ${error.message}`, 'error', 5000);
    return false;
  }

  sessionPromise.then(async (session) => {
    if (!session || typeof session.loadMedia !== 'function') {
      throw new Error('Chromecast session is not ready');
    }
    let subtitleOptions = castTvState.subtitleOptions;
    if (meta.subtitleManifestUrl) {
      try {
        subtitleOptions = await loadCastSubtitleOptions(meta.subtitleManifestUrl);
        castTvState.subtitleOptions = subtitleOptions;
        if (subtitleOptions.length > 0) {
          const currentTrackId = String(castTvState.selectedSubtitleTrackId || '');
          const selectedStillExists = subtitleOptions.some((track) => String(track.trackId) === currentTrackId);
          castTvState.selectedSubtitleTrackId = selectedStillExists
            ? currentTrackId
            : String(subtitleOptions[0].trackId);
        } else {
          castTvState.selectedSubtitleTrackId = '';
        }
      } catch (error) {
        subtitleOptions = castTvState.subtitleOptions;
      }
    }

    if (subtitleOptions.length > 0 && !castTvState.selectedSubtitleTrackId) {
      toast('Choose a subtitle track before casting', 'info');
      return;
    }

    const draft = buildCastMediaDraft(
      meta,
      subtitleOptions,
      castTvState.selectedSubtitleTrackId,
      wizard.titleText
    );
    const mediaInfo = new window.chrome.cast.media.MediaInfo(draft.contentId, draft.contentType);
    mediaInfo.streamType = window.chrome.cast.media.StreamType.BUFFERED;
    const metadata = new window.chrome.cast.media.GenericMediaMetadata();
    metadata.title = draft.metadata.title;
    mediaInfo.metadata = metadata;
    if (draft.tracks.length > 0) {
      mediaInfo.tracks = draft.tracks.map((track) => {
        const castTrack = new window.chrome.cast.media.Track(track.trackId, window.chrome.cast.media.TrackType.TEXT);
        castTrack.trackContentId = track.trackContentId;
        castTrack.trackContentType = track.trackContentType;
        castTrack.subtype = window.chrome.cast.media.TextTrackType.SUBTITLES;
        castTrack.name = track.name;
        castTrack.language = track.language;
        return castTrack;
      });
    }
    const loadRequest = new window.chrome.cast.media.LoadRequest(mediaInfo);
    loadRequest.autoplay = true;
    if (draft.activeTrackIds.length > 0) {
      loadRequest.activeTrackIds = draft.activeTrackIds;
    }
    await session.loadMedia(loadRequest);
    
    // Set up session state tracking
    castTvState.isCasting = true;
    castTvState.castSession = session;
    castTvState.castDeviceName = session.getReceiverStatus?.()?.receiver?.friendlyName || 'Chromecast';

    // Get initial volume
    try {
      const volume = session.getVolume();
      castTvState.castVolume = volume;
      castTvState.isMuted = session.isMuted?.() ?? false;
    } catch (e) {
      // Ignore volume read errors
    }

    saveCastSessionState();
    updateCastStatusIndicator();
    toast(`Casting to ${castTvState.castDeviceName}`, 'success');
    closeCastTvModal();
  }).catch((error) => {
    const errorMsg = error.message || 'Unknown error';
    let userMessage = `Could not start Chromecast: ${errorMsg}`;
    
    // Provide specific error recovery suggestions
    if (errorMsg.includes('timeout') || errorMsg.includes('cancel')) {
      userMessage = 'Device selection cancelled or timed out. Please try again.';
    } else if (errorMsg.includes('network') || errorMsg.includes('unavailable')) {
      userMessage = 'Network error. Make sure your Chromecast is on the same network.';
    } else if (errorMsg.includes('format') || errorMsg.includes('unsupported')) {
      userMessage = 'This format may not be supported. Try a different torrent.';
    }
    
    toast(userMessage, 'error', 6000);
  });

  return false;
}

function handleCastSessionEnd() {
  castTvState.isCasting = false;
  castTvState.castSession = null;
  castTvState.castDeviceName = '';
  clearCastSessionState();
  updateCastStatusIndicator();
  stopCastStatusUpdates();
}

function stopChromecastCast(event) {
  if (event) event.preventDefault();
  
  const session = castTvState.castSession;
  if (!session || typeof session.stop !== 'function') {
    toast('No active cast session', 'info');
    handleCastSessionEnd();
    return false;
  }
  
  session.stop(() => {
    toast('Casting stopped', 'success');
    handleCastSessionEnd();
  }, (error) => {
    // Force local state reset even if stop fails
    toast('Stopping cast...', 'info');
    handleCastSessionEnd();
  });
  
  return false;
}

function setCastVolume(level) {
  const session = castTvState.castSession;
  if (!session || !castTvState.isCasting) return false;
  
  try {
    const volume = new window.chrome.cast.Volume();
    volume.level = Math.max(0, Math.min(1, level));
    volume.muted = castTvState.isMuted;
    session.setVolume(volume, () => {
      castTvState.castVolume = volume.level;
      saveCastSessionState();
      updateCastStatusIndicator();
    }, (error) => {
      toast('Failed to change volume', 'error', 3000);
    });
  } catch (e) {
    toast('Volume control unavailable', 'error', 3000);
  }
  return false;
}

function toggleCastMute() {
  const session = castTvState.castSession;
  if (!session || !castTvState.isCasting) return false;
  
  try {
    const volume = new window.chrome.cast.Volume();
    volume.level = castTvState.castVolume;
    volume.muted = !castTvState.isMuted;
    session.setVolume(volume, () => {
      castTvState.isMuted = volume.muted;
      saveCastSessionState();
      updateCastStatusIndicator();
    }, (error) => {
      toast('Failed to toggle mute', 'error', 3000);
    });
  } catch (e) {
    toast('Mute control unavailable', 'error', 3000);
  }
  return false;
}

function goBackFromWizard() {
  const fallback = wizard.type === 'tv' ? '/tv' : '/movies';
  try {
    const hasHistory = window.history.length > 1;
    const sameOriginReferrer = document.referrer && new URL(document.referrer).origin === window.location.origin;
    if (hasHistory && sameOriginReferrer) {
      window.history.back();
      return;
    }
  } catch (e) {
    // Ignore referrer parsing issues and use the fallback route.
  }
  navigate(fallback);
}

// Entry point called by route()
async function renderStreamPage() {
  state.currentPage = 'stream';
  const params = getHashParams();
  const routeType = params.get('type');
  const routeTmdbId = params.get('id');
  const routeTitleText = params.get('title') || '';
  const restoredAny = loadAnyWizardState();

  let activeSessions = [];
  try {
    activeSessions = await fetchJson('/api/stream/status');
  } catch (e) {
    activeSessions = [];
  }
  const runningSession = activeSessions.find((session) => session.running || !session.exited) || null;

  const type = routeType || restoredAny?.type || 'movie';
  const tmdbId = routeTmdbId || (restoredAny?.tmdbId != null ? String(restoredAny.tmdbId) : '');
  const titleText = routeTitleText || restoredAny?.titleText || (runningSession ? 'Active Stream' : '');

  // Reset wizard state
  Object.assign(wizard, {
    type, tmdbId: Number(tmdbId), titleText,
    year: '', tmdbYear: '',
    seasons: [], selectedSeason: null,
    episodes: [], selectedEpisode: null,
    torrents: [], selectedTorrent: null, resolvedMagnet: null,
    subtitleLangs: [], selectedLang: 'en',
    subtitles: [], selectedSubtitle: null, subtitleToken: null, subtitleTokenExpiresAt: null, skipSubtitles: false,
    sessionId: null, playerUrl: null, vlcUrl: null, castUrl: null, subtitleManifestUrl: null, videoFormat: null,
    detail: null, historySaved: false,
    step: type === 'tv' ? 1 : 2,
  });

  if (wizard.sseSource) { wizard.sseSource.close(); wizard.sseSource = null; }
  clearStreamStatusPolling();

  // Fetch TMDB detail for year, seasons
  if (tmdbId) {
    try {
      const detail = await api(`/api/detail/${type}/${tmdbId}`);
      wizard.detail = detail;
      wizard.tmdbYear = year(detail);
      if (type === 'tv') {
        wizard.seasons = (detail.seasons || []).filter((s) => s.season_number > 0);
      }
    } catch (e) { /* non-fatal */ }
  }

  // Load subtitle languages
  try {
    wizard.subtitleLangs = await api('/api/subtitles/languages');
  } catch (e) {
    wizard.subtitleLangs = [{ code: 'en', label: 'English' }];
  }

  const restored = tmdbId ? loadWizardState(type, tmdbId) : restoredAny;
  if (restored) {
    Object.assign(wizard, {
      selectedSeason: restored.selectedSeason || null,
      selectedEpisode: restored.selectedEpisode || null,
      selectedLang: restored.selectedLang || 'en',
      selectedTorrent: restored.selectedTorrent || null,
      resolvedMagnet: restored.resolvedMagnet || null,
      subtitleToken: restored.subtitleToken || null,
      subtitleTokenExpiresAt: restored.subtitleTokenExpiresAt || null,
      skipSubtitles: !!restored.skipSubtitles,
      sessionId: restored.sessionId || null,
      playerUrl: restored.playerUrl || null,
      vlcUrl: restored.vlcUrl || null,
      castUrl: restored.castUrl || null,
      subtitleManifestUrl: restored.subtitleManifestUrl || null,
      step: restored.step || (type === 'tv' ? 1 : 2),
    });
  }

  if (runningSession) {
    wizard.sessionId = runningSession.id;
    wizard.playerUrl = runningSession.playerUrl || wizard.playerUrl || null;
    wizard.vlcUrl = runningSession.vlcUrl || wizard.vlcUrl || null;
    wizard.castUrl = runningSession.castUrl || wizard.castUrl || null;
    wizard.subtitleManifestUrl = runningSession.subtitleManifestUrl || wizard.subtitleManifestUrl || null;
    wizard.step = 4;
    if (!wizard.titleText) {
      wizard.titleText = restored?.titleText || 'Active Stream';
    }
  }

  if (!tmdbId && !restored && !runningSession) {
    renderEmptyStreamPage();
    clearWizardState();
    updateNavStreamIndicator(false);
    return;
  }

  renderWizardUI();
  persistWizardState();

  if (wizard.step === 4) {
    await resumeStreamSession();
  }
}

function renderEmptyStreamPage() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="page-layout" style="display:block">
      <div class="page-content" style="max-width:900px;margin:0 auto;padding-top:2rem">
        <div class="page-header">
          <h1 class="page-title">Stream</h1>
          <p class="page-subtitle">No active stream session is attached right now.</p>
        </div>
        <div class="empty-state">
          <div class="empty-icon">0</div>
          <h3>No active stream</h3>
          <p>Start a movie or TV stream from the library and this page will show the live session, player link, and runtime status.</p>
          <div style="display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="navigate('/movies')">Browse Movies</button>
            <button class="btn btn-outline" onclick="navigate('/tv')">Browse TV Shows</button>
          </div>
        </div>
      </div>
    </div>`;
}

async function resumeStreamSession() {
  let active = [];
  try {
    active = await fetchJson('/api/stream/status');
  } catch (e) {
    return false;
  }

  const session = active.find((s) => s.id === wizard.sessionId)
    || active.find((s) => s.running || !s.exited)
    || null;

  if (!session) {
    updateNavStreamIndicator(false);
    return false;
  }

  wizard.sessionId = session.id;
  applyActiveStreamMeta(session);
  wizard.step = 4;
  persistWizardState();

  const badge = document.getElementById('streamStatusBadge');

  if (wizard.playerUrl) {
    showPlayerBanner(wizard.playerUrl);
    updateNavStreamIndicator(true, wizard.playerUrl);
    updateStreamReadyActions(session);
    if (badge) {
      badge.innerHTML = '<span style="color:var(--green)">Live</span>';
    }
    clearWaitingTimer();
  } else {
    clearPlayerBanner();
    updateNavStreamIndicator(true);
    updateStreamReadyActions(null);
    if (badge) {
      badge.innerHTML = '<span style="color:var(--text-muted)">Reconnecting...</span>';
    }
    startWaitingTimer();
  }

  connectStreamSSE(session.id);
  startStreamStatusPolling();
  return true;
}

function renderWizardUI() {
  const app = document.getElementById('app');
  const stepDefs = wizard.type === 'tv'
    ? [
        { n: 1, label: 'Season & Episode' },
        { n: 2, label: 'Pick Torrent' },
        { n: 3, label: 'Subtitles' },
        { n: 4, label: 'Streaming' },
      ]
    : [
        { n: 2, label: 'Pick Torrent' },
        { n: 3, label: 'Subtitles' },
        { n: 4, label: 'Streaming' },
      ];

  const stepsHTML = stepDefs.map((s, i) => {
    const isDone = wizard.step > s.n;
    const isActive = wizard.step === s.n;
    const lineAfter = i < stepDefs.length - 1
      ? `<div class="wizard-step-line ${isDone ? 'done' : ''}"></div>`
      : '';
    return `
      <div class="wizard-step ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}">
        <div class="wizard-step-dot">${isDone ? 'OK' : s.n}</div>
        <span class="wizard-step-label">${s.label}</span>
      </div>${lineAfter}`;
  }).join('');

  const typeBadgeText = wizard.type === 'tv' ? 'TV Show' : 'Movie';
  const epSuffix = (wizard.type === 'tv' && wizard.selectedSeason && wizard.selectedEpisode)
    ? ` - S${String(wizard.selectedSeason).padStart(2,'0')}E${String(wizard.selectedEpisode).padStart(2,'0')}`
    : '';

  app.innerHTML = `
    <div class="wizard-page">
      <div class="wizard-header">
        <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
          <button class="btn btn-outline btn-sm" onclick="goBackFromWizard()">Back</button>
          <span class="badge badge-episode" style="font-size:.8rem">${typeBadgeText}</span>
        </div>
        <h1 class="wizard-title">${escape(wizard.titleText)}${epSuffix}</h1>
        <p class="wizard-subtitle">Follow the steps to search and stream</p>
      </div>
      <div class="wizard-steps">${stepsHTML}</div>
      <div id="wizardPanel"></div>
    </div>`;

  renderWizardStep();
}

function renderWizardStep() {
  const panel = document.getElementById('wizardPanel');
  if (!panel) return;
  if (wizard.step === 1 && wizard.type === 'tv') renderWizardStep1(panel);
  else if (wizard.step === 2) renderWizardStep2(panel);
  else if (wizard.step === 3) renderWizardStep3(panel);
  else if (wizard.step === 4) renderWizardStep4(panel);
}

// -- Step 1: Season & Episode picker (TV only) ---------------------------------
function renderWizardStep1(panel) {
  const seasons = wizard.seasons;

  if (!wizard.selectedSeason && seasons.length > 0) {
    wizard.selectedSeason = seasons[0].season_number;
  }

  const seasonTabsHTML = seasons.map((s) => `
    <button class="season-tab ${wizard.selectedSeason === s.season_number ? 'active' : ''}"
      onclick="wizardSelectSeason(${s.season_number})">
      S${String(s.season_number).padStart(2,'0')} <span style="opacity:.6;font-weight:400">(${s.episode_count}ep)</span>
    </button>`).join('');

  panel.innerHTML = `
    <div class="wizard-panel">
      <div class="wizard-panel-title">Select Season and Episode</div>
      <div class="season-tabs" id="seasonTabs">${seasonTabsHTML}</div>
      <div id="episodeGrid" class="episode-grid">
        <div class="page-loader" style="grid-column:1/-1;min-height:80px"><div class="spinner"></div></div>
      </div>
      <div class="wizard-nav">
        <span class="text-muted" style="font-size:.8rem" id="epSelection">
          ${wizard.selectedSeason && wizard.selectedEpisode
            ? `Selected: S${String(wizard.selectedSeason).padStart(2,'0')}E${String(wizard.selectedEpisode).padStart(2,'0')}`
            : 'Select an episode to enable torrent search'}
        </span>
        <div class="wizard-nav-right">
          <button class="btn btn-primary" onclick="wizardStep1Next()" id="step1Next"
            ${wizard.selectedEpisode ? '' : 'disabled'}>
            Search Torrents
          </button>
        </div>
      </div>
    </div>`;

  if (wizard.selectedSeason) loadSeasonEpisodes(wizard.selectedSeason);
}

async function wizardSelectSeason(n) {
  wizard.selectedSeason = n;
  wizard.selectedEpisode = null;
  persistWizardState();
  document.querySelectorAll('.season-tab').forEach((t, i) => {
    t.classList.toggle('active', wizard.seasons[i]?.season_number === n);
  });
  const grid = document.getElementById('episodeGrid');
  if (grid) grid.innerHTML = `<div class="page-loader" style="grid-column:1/-1;min-height:80px"><div class="spinner"></div></div>`;
  await loadSeasonEpisodes(n);
}

async function loadSeasonEpisodes(seasonNum) {
  const grid = document.getElementById('episodeGrid');
  if (!grid) return;
  try {
    const data = await api(`/api/tv/${wizard.tmdbId}/season/${seasonNum}`);
    wizard.episodes = data.episodes || [];
    grid.innerHTML = wizard.episodes.map((ep) => `
      <button class="ep-btn ${wizard.selectedEpisode === ep.episode_number ? 'selected' : ''}"
        onclick="wizardSelectEpisode(${ep.episode_number})"
        title="${escape(ep.name || '')}">
        <span class="ep-btn-num">${ep.episode_number}</span>
        <span class="ep-btn-label">${escape((ep.name || '').slice(0, 12))}</span>
      </button>`).join('');
  } catch (e) {
    grid.innerHTML = `<p class="text-muted" style="grid-column:1/-1;font-size:.8rem">Failed to load episodes</p>`;
  }
}

function wizardSelectEpisode(n) {
  wizard.selectedEpisode = n;
  document.querySelectorAll('.ep-btn').forEach((b, i) => {
    b.classList.toggle('selected', wizard.episodes[i]?.episode_number === n);
  });
  const sel = document.getElementById('epSelection');
  if (sel) sel.textContent = `Selected: S${String(wizard.selectedSeason).padStart(2,'0')}E${String(wizard.selectedEpisode).padStart(2,'0')}`;
  const btn = document.getElementById('step1Next');
  if (btn) btn.disabled = false;
  // Update wizard title
  const h1 = document.querySelector('.wizard-title');
  if (h1) h1.textContent = `${wizard.titleText} - S${String(wizard.selectedSeason).padStart(2,'0')}E${String(wizard.selectedEpisode).padStart(2,'0')}`;
  persistWizardState();
}

function wizardStep1Next() {
  if (!wizard.selectedEpisode) return;
  wizard.step = 2;
  persistWizardState();
  renderWizardUI();
  // Auto-start torrent search
  setTimeout(() => wizardSearchTorrents(), 100);
}

// -- Step 2: Torrent search & selection ---------------------------------------
function renderWizardStep2(panel) {
  const searchLabel = wizard.type === 'tv' && wizard.selectedSeason && wizard.selectedEpisode
    ? `${wizard.titleText} S${String(wizard.selectedSeason).padStart(2,'0')}E${String(wizard.selectedEpisode).padStart(2,'0')}`
    : wizard.titleText;

  panel.innerHTML = `
    <div class="wizard-panel">
      <div class="wizard-panel-title">Find Torrents
        <span style="font-size:.75rem;font-weight:400;color:var(--text-muted);margin-left:.5rem">${escape(searchLabel)}</span>
      </div>
      <div id="torrentSearchStatus" style="font-size:.85rem;color:var(--text-muted);margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem">
        <div class="spinner" style="width:16px;height:16px;border-width:2px"></div>
        Searching 4 sources (1337x, YTS, PirateBay, Nyaa)...
      </div>
      <div class="torrent-list" id="torrentList">
        ${wizard.torrents.length > 0 ? renderTorrentItems() : ''}
      </div>
      <div class="wizard-nav">
        ${wizard.type === 'tv' ? `<button class="btn btn-outline btn-sm" onclick="wizardGoStep(1)">Back</button>` : `<button class="btn btn-outline btn-sm" onclick="history.back()">Back</button>`}
        <div class="wizard-nav-right">
          <button class="btn btn-outline btn-sm" onclick="wizardSearchTorrents()">Search Again</button>
          <button class="btn btn-primary" onclick="wizardStep2Next()" id="step2Next"
            ${wizard.selectedTorrent ? '' : 'disabled'}>
            Next: Subtitles
          </button>
        </div>
      </div>
    </div>`;

  if (wizard.torrents.length === 0) {
    wizardSearchTorrents();
  } else {
    const status = document.getElementById('torrentSearchStatus');
    if (status) status.innerHTML = `Found <strong>${wizard.torrents.length}</strong> results`;
  }
}

async function wizardSearchTorrents() {
  const statusEl = document.getElementById('torrentSearchStatus');
  const listEl = document.getElementById('torrentList');
  if (statusEl) statusEl.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px"></div> Searching 4 sources...`;
  if (listEl) listEl.innerHTML = skeletonCards(4).replace(/class="card"/g, 'style="height:60px;border-radius:8px"');

  try {
    const body = {
      title: wizard.titleText,
      type: wizard.type,
      season: wizard.selectedSeason,
      episode: wizard.selectedEpisode,
    };
    wizard.torrents = await fetch('/api/torrents/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    persistWizardState();

    if (statusEl) statusEl.innerHTML = wizard.torrents.length > 0
      ? `Found <strong>${wizard.torrents.length}</strong> results - pick one to stream`
      : `<span style="color:var(--red)">No torrents found. Try a different search.</span>`;

    if (listEl) listEl.innerHTML = wizard.torrents.length > 0
      ? renderTorrentItems()
      : `<div class="empty-state"><div class="empty-icon">0</div><h3>No torrents found</h3><p>The scrapers could not find any results. Check your connection or try later.</p></div>`;
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">Search failed: ${escape(e.message)}</span>`;
  }
}

function renderTorrentItems() {
  return wizard.torrents.map((t, i) => {
    const src = (t.source || '').toLowerCase().replace(/[^a-z]/g, '');
    const srcClass = src.includes('1337') ? 'source-1337x'
      : src.includes('yts') ? 'source-yts'
      : src.includes('pirate') ? 'source-piratebay'
      : src.includes('nyaa') ? 'source-nyaa'
      : 'source-other';
    const seeds = parseInt(t.seeders) || 0;
    const leech = parseInt(t.leechers) || 0;
    const isSelected = wizard.selectedTorrent && wizard.selectedTorrent._idx === i;
    return `
      <div class="torrent-item ${isSelected ? 'selected' : ''}" onclick="wizardSelectTorrent(${i})">
        <div class="torrent-radio"></div>
        <span class="torrent-source ${srcClass}">${escape(t.source || '?')}</span>
        <span class="torrent-name" title="${escape(t.name)}">${escape(t.name)}</span>
        <div class="torrent-meta">
          <span class="torrent-seeds">Seeds ${seeds}</span>
          <span class="torrent-leech">Leech ${leech}</span>
          ${t.size ? `<span class="torrent-size">${escape(t.size)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

function wizardSelectTorrent(idx) {
  wizard.selectedTorrent = { ...wizard.torrents[idx], _idx: idx };
  persistWizardState();
  // Re-render list to update selection
  const listEl = document.getElementById('torrentList');
  if (listEl) listEl.innerHTML = renderTorrentItems();
  const btn = document.getElementById('step2Next');
  if (btn) btn.disabled = false;
}

async function wizardStep2Next() {
  if (!wizard.selectedTorrent) return;
  // Resolve magnet
  const btn = document.getElementById('step2Next');
  if (btn) { btn.disabled = true; btn.textContent = 'Resolving...'; }

  try {
    const data = await fetch('/api/torrents/magnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ torrent: wizard.selectedTorrent }),
    }).then((r) => r.json());

    if (!data.magnet) throw new Error(data.error || 'No magnet returned');
    wizard.resolvedMagnet = data.magnet;
    wizard.step = 3;
    persistWizardState();
    renderWizardUI();
  } catch (e) {
    toast(`Failed to resolve magnet: ${e.message}`, 'error', 5000);
    if (btn) { btn.disabled = false; btn.textContent = 'Next: Subtitles'; }
  }
}

// -- Step 3: Subtitle selection ------------------------------------------------
function renderWizardStep3(panel) {
  const langHTML = (wizard.subtitleLangs || []).map((l) => `
    <button class="lang-btn ${wizard.selectedLang === l.code ? 'active' : ''}"
      onclick="wizardSetLang('${l.code}')">${l.label}</button>`).join('');

  const subListHTML = wizard.subtitles.length > 0
    ? renderSubtitleItems()
    : `<div class="empty-state"><div class="empty-icon">CC</div><h3>No subtitles loaded</h3><p>Select a language and click Search.</p></div>`;

  panel.innerHTML = `
    <div class="wizard-panel">
      <div class="wizard-panel-title">Subtitles <span style="font-size:.75rem;font-weight:400;color:var(--text-muted)">(optional)</span></div>
      <div class="sidebar-group">
        <label class="sidebar-label">Language</label>
        <div class="lang-grid" id="langGrid">${langHTML}</div>
      </div>
      <div style="display:flex;gap:.5rem;margin-bottom:1rem">
        <button class="btn btn-outline btn-sm" onclick="wizardSearchSubtitles()" id="subSearchBtn">Search Subtitles</button>
        <span id="subStatus" style="font-size:.8rem;color:var(--text-muted);align-self:center"></span>
      </div>
      <div class="subtitle-list" id="subtitleList">${subListHTML}</div>
      <div class="wizard-nav">
        <button class="btn btn-outline btn-sm" onclick="wizardGoStep(2)">Back</button>
        <div class="wizard-nav-right">
          <button class="btn btn-outline" onclick="wizardSkipSubtitles()">Skip Subtitles</button>
          <button class="btn btn-primary" onclick="wizardStep3Next()" id="step3Next"
            ${wizard.selectedSubtitle ? '' : 'disabled'}>
            Start Streaming
          </button>
        </div>
      </div>
    </div>`;
}

function wizardSetLang(code) {
  wizard.selectedLang = code;
  persistWizardState();
  document.querySelectorAll('.lang-btn').forEach((b) => {
    b.classList.toggle('active', b.textContent === (wizard.subtitleLangs.find((l) => l.code === code)?.label || code));
  });
}

async function wizardSearchSubtitles() {
  const btn = document.getElementById('subSearchBtn');
  const status = document.getElementById('subStatus');
  const listEl = document.getElementById('subtitleList');
  if (btn) { btn.disabled = true; btn.textContent = 'Searching...'; }
  if (status) status.textContent = '';

  try {
    const body = {
      title: wizard.titleText,
      type: wizard.type,
      season: wizard.selectedSeason,
      episode: wizard.selectedEpisode,
      year: wizard.tmdbYear,
      tmdbId: wizard.tmdbId,
      language: wizard.selectedLang,
    };
    wizard.subtitles = await fetch('/api/subtitles/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    if (status) status.textContent = wizard.subtitles.length > 0
      ? `${wizard.subtitles.length} result${wizard.subtitles.length > 1 ? 's' : ''} found`
      : 'No subtitles found';

    if (listEl) listEl.innerHTML = wizard.subtitles.length > 0
      ? renderSubtitleItems()
      : `<div class="empty-state"><div class="empty-icon">CC</div><h3>No subtitles found</h3><p>Try a different language or skip.</p></div>`;
  } catch (e) {
    if (status) status.innerHTML = `<span style="color:var(--red)">${escape(e.message)}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Search Subtitles'; }
  }
}

function renderSubtitleItems() {
  return wizard.subtitles.map((s, i) => {
    const isSelected = wizard.selectedSubtitle && wizard.selectedSubtitle._idx === i;
    const dlCount = s.downloadCount || s.attributes?.download_count || 0;
    const relName = s.attributes?.release || s.title || `Subtitle ${i + 1}`;
    return `
      <div class="subtitle-item ${isSelected ? 'selected' : ''}" onclick="wizardSelectSubtitle(${i})">
        <span class="subtitle-source-badge">${escape(s.source || 'OS')}</span>
        <span class="subtitle-name" title="${escape(relName)}">${escape(relName)}</span>
        ${dlCount ? `<span class="subtitle-downloads">${dlCount.toLocaleString()} downloads</span>` : ''}
      </div>`;
  }).join('');
}

function wizardSelectSubtitle(idx) {
  wizard.selectedSubtitle = { ...wizard.subtitles[idx], _idx: idx };
  persistWizardState();
  const listEl = document.getElementById('subtitleList');
  if (listEl) listEl.innerHTML = renderSubtitleItems();
  const btn = document.getElementById('step3Next');
  if (btn) btn.disabled = false;
}

function wizardSkipSubtitles() {
  wizard.skipSubtitles = true;
  wizard.selectedSubtitle = null;
  wizard.subtitleToken = null;
  wizard.subtitleTokenExpiresAt = null;
  wizard.step = 4;
  persistWizardState();
  renderWizardUI();
  setTimeout(() => wizardStartStream(), 100);
}

async function wizardStep3Next() {
  if (!wizard.selectedSubtitle) return;
  const btn = document.getElementById('step3Next');
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading subtitle...'; }

  try {
    const data = await fetchJson('/api/subtitles/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtitle: wizard.selectedSubtitle }),
    });

    if (!data.subtitleToken) throw new Error(data.error || 'Download failed');
    wizard.subtitleToken = data.subtitleToken;
    wizard.subtitleTokenExpiresAt = data.tokenExpiresAt || null;
    toast('Subtitle downloaded', 'success');
    wizard.step = 4;
    persistWizardState();
    renderWizardUI();
    setTimeout(() => wizardStartStream(), 100);
  } catch (e) {
    toast(`Subtitle download failed: ${e.message}`, 'error', 5000);
    if (btn) { btn.disabled = false; btn.textContent = 'Start Streaming'; }
  }
}

// -- Step 4: Streaming --------------------------------------------------------
function renderWizardStep4(panel) {
  const torrentName = wizard.selectedTorrent ? wizard.selectedTorrent.name : wizard.titleText;
  panel.innerHTML = `
    <div class="wizard-panel">
      <div id="playerBanner"></div>
      <div class="wizard-panel-title">Streaming
        <span id="streamStatusBadge" style="font-size:.75rem;font-weight:500;color:var(--text-muted);margin-left:.5rem">Starting...</span>
      </div>

      <!-- Progress bar (hidden until progress events arrive) -->
      <div id="streamProgressWrap" style="display:none;margin-bottom:.75rem">
        <div style="display:flex;justify-content:space-between;font-size:.78rem;color:var(--text-muted);margin-bottom:.3rem">
          <span id="streamProgressLabel">Downloading...</span>
          <span id="streamProgressSpeed"></span>
        </div>
        <div style="height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden">
          <div id="streamProgressBar" style="height:100%;background:var(--accent);border-radius:3px;width:0%;transition:width .5s ease"></div>
        </div>
      </div>

      <div style="font-size:.75rem;color:var(--text-muted);margin-bottom:.4rem">
        Torrent: <span style="color:var(--text)">${escape((torrentName || '').slice(0, 80))}</span>
        ${wizard.subtitleToken ? `<span style="color:var(--green);margin-left:.5rem">Subtitle loaded</span>` : ''}
      </div>

      <div class="stream-terminal" id="streamTerminal"></div>

      <div class="wizard-nav" style="margin-top:1rem">
        <button class="btn btn-danger btn-sm" onclick="wizardStopStream()">Stop Stream</button>
        <div class="wizard-nav-right">
          <button class="btn btn-outline btn-sm" onclick="wizardStartStream()">Retry Start</button>
          <button class="btn btn-outline btn-sm" onclick="wizardGoStep(2)">Change Torrent</button>
        </div>
      </div>
    </div>`;
}

function updateStreamReadyActions(url) {
  const meta = typeof url === 'string'
    ? normalizeActiveStreamMeta({ playerUrl: url })
    : normalizeActiveStreamMeta(url || {});
  const directLink = document.getElementById('directPlayerLink');
  if (directLink) {
    directLink.href = meta.playerUrl || '#';
    directLink.style.display = meta.playerUrl ? '' : 'none';
  }

  const castButton = document.getElementById('castTvButton');
  if (castButton) {
    castButton.style.display = meta.playerUrl ? '' : 'none';
  }

  const vlcButton = document.getElementById('vlcPlayerButton');
  if (vlcButton) {
    vlcButton.style.display = meta.playerUrl ? '' : 'none';
  }
}

async function wizardStartStream() {
  if (!wizard.resolvedMagnet) return;

  // Check if there's already an active session with a player URL (e.g. page was refreshed)
  try {
    const active = await fetchJson('/api/stream/status');
    const running = active.find((s) => s.id === wizard.sessionId) || active.find((s) => s.running);
    if (running) {
      applyActiveStreamMeta(running);
      persistWizardState();
      if (running.playerUrl) {
        showPlayerBanner(running.playerUrl);
        saveWizardHistoryIfNeeded();
      }
      updateNavStreamIndicator(true, running.playerUrl || null);
      const badge = document.getElementById('streamStatusBadge');
      updateStreamReadyActions(running.playerUrl || null);
      if (badge) {
        badge.innerHTML = running.playerUrl
          ? `<span style="color:var(--green)">Live</span>`
          : `<span style="color:var(--text-muted)">Waiting for player...</span>`;
      }
      connectStreamSSE(running.id);
      if (!running.playerUrl) startWaitingTimer();
      startStreamStatusPolling();
      return;
    }
  } catch (e) { /* ignore, proceed to start */ }

  try {
    const data = await fetchJson('/api/stream/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        magnet: wizard.resolvedMagnet,
        subtitleToken: wizard.subtitleToken || null,
        history: {
          type: wizard.type,
          item: buildWizardHistoryItem(),
        },
      }),
    });

    if (!data.sessionId) throw new Error(data.error || 'Failed to start');
    wizard.sessionId = data.sessionId;
    wizard.historySaved = true;
    persistWizardState();

    // Update navbar stream indicator
    updateNavStreamIndicator(true);

    connectStreamSSE(data.sessionId);
    startWaitingTimer();
    startStreamStatusPolling();
  } catch (e) {
    appendTerminalLine(`Error: ${e.message}`, 'error');
    const badge = document.getElementById('streamStatusBadge');
    if (badge) badge.innerHTML = '<span style="color:var(--red)">Failed to start</span>';
  }
}

function startStreamStatusPolling() {
  clearStreamStatusPolling();
  wizard.statusPollId = setInterval(async () => {
    if (state.currentPage !== 'stream' || wizard.step !== 4) return;
    try {
      const active = await fetchJson('/api/stream/status');
      const ours = active.find((s) => s.id === wizard.sessionId);
      if (!ours && wizard.sessionId) {
        clearStreamStatusPolling();
        updateNavStreamIndicator(false);
        clearPlayerBanner();
        updateStreamReadyActions(null);
        const badge = document.getElementById('streamStatusBadge');
        if (badge) badge.innerHTML = '<span style="color:var(--red)">Stopped</span>';
        applyActiveStreamMeta({
          sessionId: null,
          playerUrl: null,
          vlcUrl: null,
          castUrl: null,
          subtitleManifestUrl: null,
        });
        clearWizardState();
      } else if (ours && ours.exited) {
        clearStreamStatusPolling();
        updateNavStreamIndicator(false);
        clearPlayerBanner();
        updateStreamReadyActions(null);
        const badge = document.getElementById('streamStatusBadge');
        if (badge) badge.innerHTML = '<span style="color:var(--red)">Stopped</span>';
        applyActiveStreamMeta({
          sessionId: null,
          playerUrl: null,
          vlcUrl: null,
          castUrl: null,
          subtitleManifestUrl: null,
        });
        clearWizardState();
      } else if (ours && ours.playerUrl && !wizard.playerUrl) {
        applyActiveStreamMeta(ours);
        clearWaitingTimer();
        showPlayerBanner(ours.playerUrl);
        updateStreamReadyActions(ours);
        updateNavStreamIndicator(true, ours.playerUrl);
        saveWizardHistoryIfNeeded();
        persistWizardState();
      } else if (ours) {
        applyActiveStreamMeta(ours);
      }
    } catch (e) { /* ignore */ }
  }, 3000);
}

function clearStreamStatusPolling() {
  if (wizard.statusPollId) { clearInterval(wizard.statusPollId); wizard.statusPollId = null; }
}

function startWaitingTimer() {
  clearWaitingTimer();
  let secs = 0;
  wizard.waitingTimerId = setInterval(() => {
    if (wizard.playerUrl) { clearWaitingTimer(); return; }
    const b = document.getElementById('streamStatusBadge');
    if (!b) { clearWaitingTimer(); return; }
    secs++;
    if (secs < 30) b.textContent = `Connecting to peers... ${secs}s`;
    else if (secs < 90) b.textContent = `Buffering... ${secs}s (finding seeders)`;
    else b.textContent = `Still waiting... ${secs}s - try a torrent with more seeders`;
  }, 1000);
}

function clearWaitingTimer() {
  if (wizard.waitingTimerId) {
    clearInterval(wizard.waitingTimerId);
    wizard.waitingTimerId = null;
  }
}

function connectStreamSSE(sessionId) {
  if (wizard.sseSource) { wizard.sseSource.close(); wizard.sseSource = null; }
  wizard.sseSource = new EventSource(`/api/stream/output/${sessionId}`);
    wizard.sseSource.addEventListener('line', (e) => {
      const { text } = JSON.parse(e.data);
      appendTerminalLine(text);
    });
    wizard.sseSource.addEventListener('progress', (e) => {
      const { percent, speed } = JSON.parse(e.data);
      const wrap = document.getElementById('streamProgressWrap');
      const bar = document.getElementById('streamProgressBar');
      const label = document.getElementById('streamProgressLabel');
      const speedEl = document.getElementById('streamProgressSpeed');
      if (wrap) wrap.style.display = '';
      if (bar) bar.style.width = `${Math.min(percent, 100)}%`;
      if (label) label.textContent = `${percent.toFixed(1)}% downloaded`;
      if (speedEl) speedEl.textContent = speed;
    });
    wizard.sseSource.addEventListener('player_ready', (e) => {
      const payload = JSON.parse(e.data);
      const { url } = payload;
      applyActiveStreamMeta(payload);
      clearWaitingTimer(); // Stop timer immediately so it can't overwrite the badge
      showPlayerBanner(url);
      updateStreamReadyActions(payload);
      updateNavStreamIndicator(true, url);
      persistWizardState();
      saveWizardHistoryIfNeeded();
      const badge = document.getElementById('streamStatusBadge');
      if (badge) badge.innerHTML = `<span style="color:var(--green)">Live</span>`;
      const wrap = document.getElementById('streamProgressWrap');
      if (wrap) wrap.style.display = 'none';
    });
    wizard.sseSource.addEventListener('exit', (e) => {
      const { code } = JSON.parse(e.data);
      clearWaitingTimer();
      appendTerminalLine(`[Process exited with code ${code}]`, code === 0 ? 'success' : 'error');
      updateNavStreamIndicator(false);
      clearPlayerBanner();
      applyActiveStreamMeta({
        sessionId: null,
        playerUrl: null,
        vlcUrl: null,
        castUrl: null,
        subtitleManifestUrl: null,
      });
      const badge = document.getElementById('streamStatusBadge');
      updateStreamReadyActions(null);
      if (badge) badge.innerHTML = `<span style="color:${code === 0 ? 'var(--green)' : 'var(--red)'}">Stopped (${code})</span>`;
      if (wizard.sseSource) { wizard.sseSource.close(); wizard.sseSource = null; }
      clearWizardState();
    });
}

function appendTerminalLine(text, type) {
  const terminal = document.getElementById('streamTerminal');
  if (!terminal) return;

  const t = text || '';
  const lineType = type || (
    /error|failed|exception|unable|refused/i.test(t) ? 'error' :
    /warning|taking longer|timeout|stalled/i.test(t) ? 'warning' :
    /success|ready|streaming|player|connected|added|started|live/i.test(t) ? 'success' :
    /adding|searching|connecting|isolation|subtitle|download|buffer/i.test(t) ? 'info' : ''
  );

  const span = document.createElement('span');
  span.className = `term-line ${lineType}`;
  span.textContent = t;
  terminal.appendChild(span);
  terminal.appendChild(document.createElement('br'));
  // Auto-scroll only if near bottom
  const distFromBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight;
  if (distFromBottom < 80) terminal.scrollTop = terminal.scrollHeight;
}

function clearPlayerBanner() {
  const banner = document.getElementById('playerBanner');
  if (banner) banner.innerHTML = '';
}

function showPlayerBanner(url) {
  const banner = document.getElementById('playerBanner');
  if (!banner) return;
  
  // Build format info display
  let formatInfoHtml = '';
  if (wizard.videoFormat) {
    const container = (wizard.videoFormat.container || 'Unknown').toUpperCase();
    const codec = (wizard.videoFormat.codec || 'Unknown').toUpperCase();
    const needsTranscode = container !== 'MP4' || codec.includes('HEVC') || codec.includes('H265');
    const transcodeStatus = needsTranscode 
      ? '<span style="color:var(--yellow)">Transcoding to MP4/H.264</span>'
      : '<span style="color:var(--green)">Native playback</span>';
    formatInfoHtml = `
      <div style="font-size:.75rem;color:var(--text-muted);margin-top:.5rem">
        Format: ${container} / ${codec} - ${transcodeStatus}
      </div>`;
  }
  
  banner.innerHTML = `
    <div class="stream-player-banner">
      <div class="stream-player-banner-copy">
        <span class="stream-player-banner-kicker">Live Stream</span>
        <h3>Player Ready!</h3>
        <p>Your stream is live - open it in the web player, cast it to a TV, or send it to VLC</p>
        ${formatInfoHtml}
      </div>
      <div class="stream-player-banner-actions">
        <a id="directPlayerLink" href="${escape(url)}" onclick="return openActivePlayer(event, this.getAttribute('href'))" class="btn btn-primary">
          Open in Web Player
        </a>
        <button id="castTvButton" type="button" onclick="return openCastTvModal(event)" class="btn btn-outline">
          Cast / TV
        </button>
        <button id="vlcPlayerButton" type="button" onclick="return openActiveVlc(event)" class="btn btn-outline">
          Open in VLC
        </button>
      </div>
    </div>`;
  updateStreamReadyActions(url);
}

async function wizardStopStream() {
  if (wizard.sseSource) { wizard.sseSource.close(); wizard.sseSource = null; }
  clearWaitingTimer();
  clearStreamStatusPolling();
  if (wizard.sessionId) {
    await fetch(`/api/stream/stop/${wizard.sessionId}`, { method: 'DELETE' }).catch(() => {});
    wizard.sessionId = null;
  } else {
    // No session: call kill-all to ensure the standalone player server is closed.
    await fetch('/api/stream/kill-all', { method: 'DELETE' }).catch(() => {});
  }
  applyActiveStreamMeta({
    sessionId: null,
    playerUrl: null,
    vlcUrl: null,
    castUrl: null,
    subtitleManifestUrl: null,
  });
  clearPlayerBanner();
  updateStreamReadyActions(null);
  updateNavStreamIndicator(false);
  clearWizardState();
  toast('Stream stopped and player server closed', 'info');
  appendTerminalLine('[Stream stopped by user - player server closed]', 'warning');
}

function wizardGoStep(n) {
  wizard.step = n;
  persistWizardState();
  renderWizardUI();
  if (n === 2 && wizard.torrents.length > 0) {
    // Torrents already loaded, just re-render
  } else if (n === 2) {
    setTimeout(() => wizardSearchTorrents(), 100);
  }
}

// -- Nav stream indicator ------------------------------------------------------
function updateNavStreamIndicator(active, url) {
  let indicator = document.getElementById('navStreamIndicator');
  if (!active) {
    if (indicator) indicator.remove();
    return;
  }
  if (!indicator) {
    const navLinks = document.getElementById('navLinks');
    indicator = document.createElement('li');
    indicator.id = 'navStreamIndicator';
    navLinks.appendChild(indicator);
  }
  indicator.innerHTML = `
    <a href="${url || '#/stream'}" onclick="return openActivePlayer(event, '${escape(url || '')}')"
       class="nav-stream-indicator" title="${url ? 'Open Player' : 'Streaming active'}">
      Live
    </a>`;
}

async function refreshNavStreamIndicator() {
  try {
    const active = await fetchJson('/api/stream/status');
    const running = active.find((s) => s.running);
    if (running) {
      updateNavStreamIndicator(true, running.playerUrl || null);
    } else {
      updateNavStreamIndicator(false);
    }
  } catch (e) {
    // Ignore polling errors.
  }
}

// --- Cast Status Indicator ---

function updateCastStatusIndicator() {
  const indicator = document.getElementById('navCastIndicator');
  const deviceNameEl = document.getElementById('castDeviceName');
  const statusDot = indicator ? indicator.querySelector('.cast-status-dot') : null;
  
  if (!indicator) return;
  
  // Remove all state classes
  indicator.classList.remove('casting', 'connecting', 'disconnected');
  
  if (castTvState.isCasting && castTvState.castSession) {
    indicator.classList.add('casting');
    indicator.title = `Casting to ${castTvState.castDeviceName} - Click to control`;
    if (deviceNameEl) deviceNameEl.textContent = castTvState.castDeviceName;
    if (statusDot) statusDot.style.display = 'block';
  } else if (castTvState.senderAllowed && castTvState.castSdkReady) {
    indicator.classList.add('disconnected');
    indicator.title = 'Cast to TV - Click to start';
    if (deviceNameEl) deviceNameEl.textContent = '';
    if (statusDot) statusDot.style.display = 'none';
  } else {
    indicator.classList.add('disconnected');
    indicator.title = 'Cast to TV (unavailable on this network)';
    if (deviceNameEl) deviceNameEl.textContent = '';
    if (statusDot) statusDot.style.display = 'none';
  }
}

function startCastStatusUpdates() {
  stopCastStatusUpdates();
  castStatusUpdateInterval = setInterval(() => {
    // Check if cast session is still active
    if (castTvState.isCasting && castTvState.castSession) {
      try {
        const session = castTvState.castSession;
        const status = session.getStatus?.();
        if (status === window.chrome.cast.SessionStatus.CONNECTED) {
          // Update device name if available
          const receiverStatus = session.getReceiverStatus?.();
          if (receiverStatus?.receiver?.friendlyName) {
            castTvState.castDeviceName = receiverStatus.receiver.friendlyName;
            saveCastSessionState();
          }
        }
      } catch (e) {
        // Session may have been lost
      }
    }
    updateCastStatusIndicator();
  }, 2000);
}

function stopCastStatusUpdates() {
  if (castStatusUpdateInterval) {
    clearInterval(castStatusUpdateInterval);
    castStatusUpdateInterval = null;
  }
}

function restoreCastSession() {
  // Try to restore cast session from storage on page load
  const savedState = loadCastSessionState();
  if (!savedState || !savedState.isCasting) return;
  
  // Try to reconnect to existing cast session
  const castContext = getReadyGoogleCastContext();
  if (!castContext) return;

  try {
    const session = castContext.getCurrentSession();
    if (session && session.getStatus?.() === window.chrome.cast.SessionStatus.CONNECTED) {
      castTvState.isCasting = true;
      castTvState.castSession = session;
      castTvState.castDeviceName = savedState.castDeviceName || 'Chromecast';
      castTvState.castVolume = savedState.castVolume || 0.5;
      castTvState.isMuted = savedState.isMuted || false;

      startCastStatusUpdates();
      updateCastStatusIndicator();
      console.log('Cast session restored from storage');
    }
  } catch (e) {
    // Session restoration failed, clear state
    clearCastSessionState();
  }
}

// --- Global window exports (needed for inline onclick handlers) ---------------
window.openDetail = openDetail;
window.markWatched = markWatched;
window.markWatchedFromDetail = markWatchedFromDetail;
window.markCurrentModalItem = markCurrentModalItem;
window.toggleCurrentModalWatchlist = toggleCurrentModalWatchlist;
window.toggleWatchlistFromCard = toggleWatchlistFromCard;
window.removeHistoryFromModal = removeHistoryFromModal;
window.toggleSeason = toggleSeason;
window.markEpWatched = markEpWatched;
window.switchHistTab = switchHistTab;
window.renderMovies = renderMovies;
window.renderTV = renderTV;
window.renderSearch = renderSearch;
window.renderRecommendations = renderRecommendations;
window.renderHistory = renderHistory;
window.openActivePlayer = openActivePlayer;
window.openActiveVlc = openActiveVlc;
window.openCastTvModal = openCastTvModal;
window.startChromecastCast = startChromecastCast;
window.stopChromecastCast = stopChromecastCast;
window.handleCastSubtitleSelection = handleCastSubtitleSelection;
window.copyCastTvLink = copyCastTvLink;
window.closeCastTvModal = closeCastTvModal;
window.testTvReadiness = testTvReadiness;
window.setCastVolume = setCastVolume;
window.toggleCastMute = toggleCastMute;
window.execSearch = execSearch;
window.setSearchType = setSearchType;
window.applyFilters = applyFilters;
window.applyRecsFilters = applyRecsFilters;
window.recsSetType = recsSetType;
window.getCurrentFilters = getCurrentFilters;

// Streaming wizard exports
window.openStreamWizard = openStreamWizard;
window.wizardSelectSeason = wizardSelectSeason;
window.wizardSelectEpisode = wizardSelectEpisode;
window.wizardStep1Next = wizardStep1Next;
window.wizardSelectTorrent = wizardSelectTorrent;
window.wizardStep2Next = wizardStep2Next;
window.wizardSearchTorrents = wizardSearchTorrents;
window.wizardSetLang = wizardSetLang;
window.wizardSearchSubtitles = wizardSearchSubtitles;
window.wizardSelectSubtitle = wizardSelectSubtitle;
window.wizardSkipSubtitles = wizardSkipSubtitles;
window.wizardStep3Next = wizardStep3Next;
window.wizardStartStream = wizardStartStream;
window.wizardStopStream = wizardStopStream;
window.wizardGoStep = wizardGoStep;
window.startWaitingTimer = startWaitingTimer;
window.connectStreamSSE = connectStreamSSE;

// --- Init ---------------------------------------------------------------------
async function init() {
  try {
    // Load genres once
    const genres = await api('/api/genres');
    state.genres = genres;
  } catch (e) {
    console.warn('Failed to load genres', e);
  }

  ensureWatchlistLoaded().catch((e) => {
    console.warn('Failed to warm watchlist cache', e);
  });

  // Start routing
  window.addEventListener('hashchange', route);
  route();
  refreshNavStreamIndicator();

  // Hide initial loader
  const loader = document.getElementById('initialLoader');
  if (loader) loader.remove();
}

init();


