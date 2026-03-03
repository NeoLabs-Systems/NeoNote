/**
 * NeoNote — app.js
 * Main SPA controller. Handles:
 *   • Navigation (notebook grid → page grid → canvas editor)
 *   • CRUD for notebooks / pages
 *   • Settings
 *   • Layers panel
 *   • Toolbar wiring
 *   • Context menus
 *   • Keyboard shortcuts
 */
import { CanvasEngine } from './canvas.js';

/* ══════════════════════════════════════════════════════════════
   API HELPERS
   ══════════════════════════════════════════════════════════════ */
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch('/api' + path, opts);
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return r.json();
}

const GET    = (path)       => api('GET',    path);
const POST   = (path, body) => api('POST',   path, body);
const PATCH  = (path, body) => api('PATCH',  path, body);
const DELETE = (path)       => api('DELETE', path);

/* ══════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════ */
let state = {
  view:        'home',  /* home | notebook | settings */
  viewMode:    'grid',  /* grid | list */
  notebooks:   [],
  pages:       [],
  activeNb:    null,    /* current notebook object */
  activePages: [],      /* pages of current notebook */
  currentPageIdx: 0,
  user:        null,
  settings:    {},
  tags:        [],
  filterTag:   null,
  filterArchived: false,
  searchQ:     '',
};

let engine = null;
let editorNotebookId = null;
let editorPages = [];
let editorPageIdx = 0;
let contextTarget = null; /* {type: 'notebook'|'page', data} */
let nbModalMode = 'create'; /* 'create' | 'edit' */
let editingNbId = null;
let templateCtx = { mode: 'new-page', pageId: null };

/* ══════════════════════════════════════════════════════════════
   DOM REFERENCES
   ══════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);
const dom = {
  app:         $('app'),
  sidebar:     $('sidebar'),
  overlay:     $('mobile-overlay'),
  viewHome:    $('view-home'),
  viewNb:      $('view-notebook'),
  nbContainer: $('notebooks-container'),
  nbEmpty:     $('notebooks-empty'),
  pageContainer: $('pages-container'),
  pageEmpty:   $('pages-empty'),
  homeTitle:   $('home-title'),
  homeSub:     $('home-sub'),
  nbBadge:     $('nb-count-badge'),
  nbTitle:     $('nb-title-header'),
  nbIcon:      $('nb-icon-header'),
  sidebarTags: $('sidebar-tags'),
  toast:       $('toast'),
  ctxMenu:     $('context-menu'),
};

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
async function init() {
  try {
    state.user     = await GET('/auth/me');
    state.settings = await GET('/settings');
    applySettings(state.settings);
    updateUserChip();
    await loadNotebooks();
    bindNav();
    bindToolbar();
    bindEditorToolbar();
    bindModals();
    bindContextMenu();
    bindSettings();
    bindMobile();
    bindKeyboard();
    bindSidebarSearch();
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeSettingsModal();
        hideAllModals();
        hideContextMenu();
      }
    });
  } catch (e) {
    console.error('[NeoNote] init error', e);
    location.href = '/login';
  }
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS
   ══════════════════════════════════════════════════════════════ */
function applySettings(s) {
  /* Theme always follows system — handled by inline script in HTML */

  /* Propagate to engine if open */
  if (engine) {
    engine.setPalmRejection(s.palm_rejection !== 0);
    engine.setPressureEnabled(s.pressure_enabled !== 0);
    engine.setColor(s.default_pen_color || '#000000');
    engine.setWidth(s.default_pen_width || 2.5);
    engine.setAutoSaveInterval((s.auto_save_interval || 5) * 1000);
  }
}

/* ══════════════════════════════════════════════════════════════
   VIEW NAVIGATION
   ══════════════════════════════════════════════════════════════ */
function switchView(view) {
  state.view = view;
  [dom.viewHome, dom.viewNb].forEach(v => v.classList.remove('active'));
  ['home', 'notebook'].forEach(id => {
    const nav = $('nav-' + id);
    if (nav) nav.classList.remove('active');
  });

  if (view === 'home' || view === 'pinned' || view === 'recent' || view === 'archive') {
    dom.viewHome.classList.add('active');
    const nav = $('nav-' + view); if (nav) nav.classList.add('active');
    else $('nav-home')?.classList.add('active');
    loadNotebooks(view);
  } else if (view === 'notebook') {
    dom.viewNb.classList.add('active');
  }
}

/* ══════════════════════════════════════════════════════════════
   NOTEBOOKS
   ══════════════════════════════════════════════════════════════ */
async function loadNotebooks(view) {
  try {
    const archived = (view === 'archive') ? '1' : '0';
    let notebooks = await GET('/notebooks?archived=' + archived + (state.searchQ ? '&q=' + encodeURIComponent(state.searchQ) : ''));

    if (view === 'pinned') notebooks = notebooks.filter(n => n.pinned);
    if (view === 'recent') notebooks = [...notebooks].sort((a, b) => b.updated_at - a.updated_at).slice(0, 20);
    if (state.filterTag)   notebooks = notebooks.filter(n => n.tags && n.tags.includes(state.filterTag));

    state.notebooks = notebooks;
    dom.nbBadge.textContent = notebooks.length;

    /* Titles */
    const titles   = { home: 'All Notebooks', pinned: 'Pinned', recent: 'Recent', archive: 'Archive' };
    dom.homeTitle.textContent = titles[view || 'home'] || 'All Notebooks';
    dom.homeSub.textContent   = `${notebooks.length} notebook${notebooks.length !== 1 ? 's' : ''}`;

    renderNotebooks(notebooks);
    loadSidebarTags();
  } catch (e) {
    showToast('Failed to load notebooks', 'error');
  }
}

function renderNotebooks(notebooks) {
  if (notebooks.length === 0) {
    dom.nbContainer.style.display = 'none';
    dom.nbEmpty.style.display = 'flex';
    return;
  }
  dom.nbContainer.style.display = '';
  dom.nbEmpty.style.display = 'none';

  if (state.viewMode === 'grid') {
    dom.nbContainer.className = 'notebooks-grid';
    dom.nbContainer.innerHTML = notebooks.map(nb => notebookCardHTML(nb)).join('');
  } else {
    dom.nbContainer.className = 'notebooks-list';
    dom.nbContainer.innerHTML = notebooks.map(nb => notebookListHTML(nb)).join('');
  }

  /* Bind click events */
  dom.nbContainer.querySelectorAll('[data-nb-id]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.nb-ctx-btn')) return;
      openNotebook(el.dataset.nbId);
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const nb = state.notebooks.find(n => n.id === el.dataset.nbId);
      showContextMenu(e, { type: 'notebook', data: nb });
    });
    const ctxBtn = el.querySelector('.nb-ctx-btn');
    if (ctxBtn) {
      ctxBtn.addEventListener('click', e => {
        e.stopPropagation();
        const nb = state.notebooks.find(n => n.id === el.dataset.nbId);
        showContextMenu(e, { type: 'notebook', data: nb });
      });
    }
  });
}

function notebookCardHTML(nb) {
  const color = nb.cover_color || '#6366f1';
  return `
    <div class="nb-card" data-nb-id="${nb.id}">
      <button class="nb-ctx-btn" title="Options">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
      <div class="nb-card-badge">
        ${nb.pinned ? '<div class="nb-pin-badge">📌</div>' : ''}
        ${nb.archived ? '<div class="nb-arc-badge">📦</div>' : ''}
      </div>
      <div class="nb-card-cover" style="background:${coverGradient(nb)}">
        <span style="position:relative;z-index:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))">${nb.icon || '📓'}</span>
      </div>
      <div class="nb-card-info">
        <div class="nb-card-title" title="${escHtml(nb.title)}">${escHtml(nb.title)}</div>
        <div class="nb-card-meta">${nb.page_count || 0} page${nb.page_count !== 1 ? 's' : ''} · ${relativeDate(nb.updated_at)}</div>
      </div>
    </div>`;
}

function notebookListHTML(nb) {
  return `
    <div class="nb-list-item" data-nb-id="${nb.id}">
      <button class="nb-ctx-btn" title="Options">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
      <div class="nb-list-cover" style="background:${coverGradient(nb)}">${nb.icon || '📓'}</div>
      <div class="nb-list-info">
        <div class="nb-list-title">${escHtml(nb.title)}</div>
        <div class="nb-list-meta">${nb.page_count || 0} pages · ${relativeDate(nb.updated_at)}</div>
      </div>
      ${nb.pinned ? '<span style="font-size:.7rem">📌</span>' : ''}
    </div>`;
}

function coverGradient(nb) {
  const c = nb.cover_color || '#6366f1';
  if (nb.cover_style === 'gradient') return `linear-gradient(135deg, ${c}, ${shiftHue(c, 30)})`;
  return c;
}

async function openNotebook(id) {
  const nb = state.notebooks.find(n => n.id === id) || await GET('/notebooks/' + id);
  state.activeNb = nb;
  dom.nbTitle.textContent = nb.title;
  dom.nbIcon.textContent  = nb.icon || '📓';
  await loadPages(id);
  /* Jump straight into the editor if the notebook has pages.
     Only show the pages-grid for empty notebooks (so user can create the first page). */
  if (state.activePages.length > 0) {
    openPageEditor(state.activePages[0].id);
  } else {
    switchView('notebook');
  }
}

async function loadPages(notebookId) {
  try {
    const pages = await GET('/pages?notebook=' + notebookId);
    state.activePages = pages;
    renderPages(pages);
  } catch (e) {
    showToast('Failed to load pages');
  }
}

function renderPages(pages) {
  if (pages.length === 0) {
    dom.pageContainer.style.display = 'none';
    dom.pageEmpty.style.display = 'flex';
    return;
  }
  dom.pageContainer.style.display = '';
  dom.pageEmpty.style.display = 'none';
  dom.pageContainer.innerHTML = pages.map((p, i) => pageCardHTML(p, i + 1)).join('');

  dom.pageContainer.querySelectorAll('[data-page-id]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.nb-ctx-btn')) return;
      openPageEditor(el.dataset.pageId);
    });
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const p = pages.find(pg => pg.id === el.dataset.pageId);
      showContextMenu(e, { type: 'page', data: p });
    });
    const ctxBtn = el.querySelector('.nb-ctx-btn');
    if (ctxBtn) ctxBtn.addEventListener('click', e => {
      e.stopPropagation();
      const p = pages.find(pg => pg.id === el.dataset.pageId);
      showContextMenu(e, { type: 'page', data: p });
    });
  });
}

function pageCardHTML(page, num) {
  const tmb = page.thumbnail
    ? `<img src="${page.thumbnail}" alt="page thumbnail">`
    : `<div class="page-thumb-blank">Page ${num}</div>`;
  return `
    <div class="page-card" data-page-id="${page.id}">
      <button class="nb-ctx-btn" title="Options">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
      <div class="page-thumb">${tmb}<span class="page-num">${num}</span></div>
      <div class="page-card-info">
        <div class="page-card-title">${escHtml(page.title || 'Page ' + num)}</div>
        <div class="page-card-meta">${page.template || 'blank'} · ${relativeDate(page.updated_at)}</div>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   CANVAS EDITOR
   ══════════════════════════════════════════════════════════════ */
async function openPageEditor(pageId) {
  const editorOverlay = $('editor-overlay');
  editorOverlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  editorPages     = state.activePages;
  editorNotebookId = state.activeNb?.id;
  editorPageIdx   = editorPages.findIndex(p => p.id === pageId);
  if (editorPageIdx < 0) editorPageIdx = 0;

  /* Init engine on first open */
  if (!engine) {
    engine = new CanvasEngine({
      onSave: () => {},
      onStatusUpdate: status => {
        if (status.coords) $('status-coords').textContent = status.coords;
        if (status.save)   $('status-save').textContent   = status.save;
      },
      onUndoRedoUpdate: (canUndo, canRedo) => {
        $('btn-undo').disabled = !canUndo;
        $('btn-redo').disabled = !canRedo;
      },
      onLayersChange: (layers, activeIdx) => renderLayersPanel(layers, activeIdx),
      onToolChange: (tool) => {
        document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
        document.querySelector(`.tool-btn[data-tool="${tool}"]`)?.classList.add('active');
        $('status-tool').textContent = tool.charAt(0).toUpperCase() + tool.slice(1);
        updateToolPanel(tool);
      },
      onActivePageChange: (idx) => {
        editorPageIdx = idx;
        if (editorPages[idx]) {
          $('editor-page-title').value = editorPages[idx].title || '';
        }
      },
    });
    applySettings(state.settings);
    bindCanvasEngineToolbar();
    updateToolPanel('pen'); // default tool on open
    /* Expose for automated tests (harmless in production) */
    window._canvasEngine = engine;
    /* Debug log button */
    const btnLog = document.getElementById('btn-copy-debug-log');
    if (btnLog) btnLog.addEventListener('click', () => engine.copyDebugLog());
  }

  await loadAllPagesIntoEditor();
}

/* Load every page in the current notebook into the engine as a vertical stack. */
async function loadAllPagesIntoEditor() {
  if (!editorPages.length) return;
  /* Remember which page to scroll to (set by openPageEditor or the caller) */
  const targetIdx = Math.max(0, Math.min(editorPageIdx, editorPages.length - 1));
  try {
    if (engine) await engine.forceSave();
    const allData = await Promise.all(editorPages.map(p => GET('/export/page/' + p.id)));
    await engine.loadAllPages(allData);
    /* Scroll to the requested page — loadAllPages always starts at page 0 */
    if (targetIdx > 0) engine.scrollToPage(targetIdx);
    $('editor-page-title').value = editorPages[editorPageIdx]?.title || '';
  } catch (e) {
    console.error('[NeoNote] loadAllPagesIntoEditor failed', e);
    showToast('Failed to load notebook pages');
  }
}

async function loadPageIntoEditor(idx) {
  if (idx < 0 || idx >= editorPages.length) return;
  editorPageIdx = idx;
  const page = editorPages[idx];

  $('editor-page-title').value = page.title || '';
  /* page-indicator / prev/next buttons removed from UI — guard against null */
  const pi = $('page-indicator');
  if (pi) pi.textContent = `${idx + 1} / ${editorPages.length}`;
  const pp = $('btn-prev-page');
  if (pp) pp.disabled = (idx === 0);
  const np = $('btn-next-page');
  if (np) np.disabled = (idx === editorPages.length - 1);

  try {
    /* Flush any pending eraser deletions / stroke saves before loading new page */
    if (engine) await engine.forceSave();
    const data = await GET('/export/page/' + page.id);
    await engine.loadPage(data);
  } catch (e) {
    showToast('Failed to load page data');
  }
}

function closeEditor() {
  const editorOverlay = $('editor-overlay');
  if (engine) engine.forceSave().catch(() => {});
  editorOverlay.style.display = 'none';
  document.body.style.overflow = '';
  /* Refresh page thumbnails */
  if (state.activeNb) loadPages(state.activeNb.id);
}

/* ══════════════════════════════════════════════════════════════
   LAYERS PANEL
   ══════════════════════════════════════════════════════════════ */
function renderLayersPanel(layers, activeIdx) {
  const list = $('layers-list');
  if (!list) return;
  list.innerHTML = [...layers].reverse().map((l, i) => {
    const realIdx = layers.length - 1 - i;
    return `
      <div class="layer-item ${realIdx === activeIdx ? 'active' : ''}" data-layer-idx="${realIdx}">
        <div class="layer-thumb"></div>
        <span class="layer-name">${escHtml(l.name)}</span>
        <div class="layer-actions">
          <button class="layer-btn layer-vis-btn ${l.visible ? 'active-vis' : ''}" data-idx="${realIdx}" title="Toggle visibility">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${l.visible
                ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
                : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'}
            </svg>
          </button>
          <button class="layer-btn layer-lock-btn ${l.locked ? '' : ''}" data-idx="${realIdx}" title="Toggle lock">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${l.locked
                ? '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
                : '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'}
            </svg>
          </button>
          <button class="layer-btn layer-del-btn" data-idx="${realIdx}" title="Delete layer" style="color:var(--danger);opacity:.6">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.layer-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.layer-btn')) return;
      engine.setActiveLayer(parseInt(el.dataset.layerIdx));
    });
  });
  list.querySelectorAll('.layer-vis-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      engine.updateLayerProp(idx, 'visible', !engine.layers[idx].visible);
    });
  });
  list.querySelectorAll('.layer-lock-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      engine.updateLayerProp(idx, 'locked', !engine.layers[idx].locked);
    });
  });
  list.querySelectorAll('.layer-del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      if (confirm('Delete this layer and all its strokes?')) engine.deleteLayer(idx);
    });
  });
}

/* ══════════════════════════════════════════════════════════════
   TOOLBAR BINDING
   ══════════════════════════════════════════════════════════════ */
function bindCanvasEngineToolbar() {
  /* Stroke width slider */
  $('stroke-width').addEventListener('input', () => {
    const v = parseFloat($('stroke-width').value);
    engine.setWidth(v);
    $('stroke-width-val').textContent = v;
  });

  /* Opacity slider */
  $('stroke-opacity').addEventListener('input', () => {
    const v = parseInt($('stroke-opacity').value) / 100;
    engine.setOpacity(v);
    $('stroke-opacity-val').textContent = Math.round(v * 100) + '%';
  });

  /* Text font size slider */
  $('text-font-size').addEventListener('input', () => {
    const v = parseInt($('text-font-size').value);
    engine.setTextFontSize(v);
    $('text-font-size-val').textContent = v + 'px';
  });

  /* Quick colors */
  document.querySelectorAll('.qcolor').forEach(el => {
    if (el.id === 'btn-custom-color') return;
    el.addEventListener('click', () => {
      document.querySelectorAll('.qcolor').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      const color = el.dataset.color;
      engine.setColor(color);
      $('active-color-swatch').style.background = color;
    });
  });

  /* Custom color */
  $('btn-custom-color').addEventListener('click', () => $('color-picker-input').click());
  $('color-picker-input').addEventListener('input', e => {
    const color = e.target.value;
    engine.setColor(color);
    $('active-color-swatch').style.background = color;
    document.querySelectorAll('.qcolor').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.color-preset-btn').forEach(el => el.classList.remove('active'));
  });

  /* ══════════════════════════════════════════════════════════
     PRESET BUBBLE — shared for color + thickness presets
     ══════════════════════════════════════════════════════════ */

  const PRESET_KEY             = 'neonote_color_presets';
  const DEFAULT_PRESETS        = ['#ef4444', '#22c55e', '#6366f1'];
  const THICKNESS_PRESET_KEY   = 'neonote_thickness_presets';
  const DEFAULT_THICKNESS_PRESETS = [2, 5, 14];

  let colorPresets     = (() => { try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || DEFAULT_PRESETS; } catch { return DEFAULT_PRESETS; } })();
  let thicknessPresets = (() => { try { return JSON.parse(localStorage.getItem(THICKNESS_PRESET_KEY)) || DEFAULT_THICKNESS_PRESETS; } catch { return DEFAULT_THICKNESS_PRESETS; } })();

  function saveColorPresets()     { localStorage.setItem(PRESET_KEY, JSON.stringify(colorPresets)); }
  function saveThicknessPresets() { localStorage.setItem(THICKNESS_PRESET_KEY, JSON.stringify(thicknessPresets)); }

  function thicknessToDotSize(v) { return Math.round(4 + (Math.min(v, 40) / 40) * 16); }

  /* Render all preset button visuals */
  function refreshColorPresetBtn(i) {
    const dot = $(`color-preset-dot-${i}`);
    if (dot) dot.style.background = colorPresets[i];
  }
  function refreshThicknessPresetBtn(i) {
    const dot = $(`thickness-preset-dot-${i}`);
    if (!dot) return;
    const d = thicknessToDotSize(thicknessPresets[i]) + 'px';
    dot.style.width = d; dot.style.height = d;
  }
  for (let i = 0; i < 3; i++) { refreshColorPresetBtn(i); refreshThicknessPresetBtn(i); }

  /* ── Bubble DOM refs ────────────────────────────────────── */
  const bubble        = $('preset-bubble');
  const pbColorEl     = $('pb-color');
  const pbThicknessEl = $('pb-thickness');
  const pbSwatch      = $('pb-color-swatch');
  const pbColorPicker = $('pb-color-picker');
  const pbHex         = $('pb-hex');
  const pbChangeBtn   = $('pb-color-change');
  const pbSlider      = $('pb-thickness-slider');
  const pbSliderVal   = $('pb-thickness-val');
  const pbPreviewCanvas = $('pb-stroke-preview');
  const pbApplyBtn    = $('pb-apply');
  const pbSaveBtn     = $('pb-save');
  const bubbleArrow   = bubble.querySelector('.preset-bubble-arrow');

  let _bubbleType  = null;   // 'color' | 'thickness'
  let _bubbleIdx   = -1;
  let _bubbleWorkingColor = '#000000';
  let _bubbleWorkingThickness = 4;

  function drawThicknessPreview(val) {
    const ctx = pbPreviewCanvas.getContext('2d');
    const w = pbPreviewCanvas.width, h = pbPreviewCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.moveTo(16, h / 2);
    ctx.lineTo(w - 16, h / 2);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#eeeef5';
    ctx.lineWidth   = Math.min(val, h - 4);
    ctx.lineCap     = 'round';
    ctx.stroke();
  }

  function openBubble(type, idx, anchorBtn) {
    _bubbleType = type;
    _bubbleIdx  = idx;

    /* Show correct content panel */
    pbColorEl.style.display     = type === 'color'     ? '' : 'none';
    pbThicknessEl.style.display = type === 'thickness' ? '' : 'none';

    if (type === 'color') {
      _bubbleWorkingColor = colorPresets[idx];
      pbSwatch.style.background = _bubbleWorkingColor;
      pbHex.textContent = _bubbleWorkingColor;
    } else {
      _bubbleWorkingThickness = thicknessPresets[idx];
      pbSlider.value      = _bubbleWorkingThickness;
      pbSliderVal.textContent = _bubbleWorkingThickness;
      drawThicknessPreview(_bubbleWorkingThickness);
    }

    /* Position bubble below the button */
    bubble.style.display = 'block';
    // Re-trigger animation
    bubble.style.animation = 'none';
    bubble.offsetHeight; // reflow
    bubble.style.animation = '';

    const rect  = anchorBtn.getBoundingClientRect();
    const bw    = 210;
    let   left  = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - bw - 6));
    const top   = rect.bottom + 10;
    bubble.style.left = left + 'px';
    bubble.style.top  = top  + 'px';

    /* Position the arrow to point at the button */
    const arrowLeft = (rect.left + rect.width / 2) - left;
    bubbleArrow.style.left = Math.max(12, Math.min(bw - 26, arrowLeft)) + 'px';
    bubbleArrow.style.transform = 'none';
  }

  function closeBubble() {
    bubble.style.display = 'none';
    _bubbleType = null;
    _bubbleIdx  = -1;
  }

  /* Active colour swatch — opens/closes style popup */
  $('tool-style-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    $('tool-color-popup').classList.toggle('open');
  });
  $('tool-color-popup')?.addEventListener('click', e => e.stopPropagation());

  /* Close on outside click */
  bubble.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => {
    closeBubble();
    $('tool-color-popup')?.classList.remove('open');
  });

  /* Color swatch → open native picker */
  pbSwatch.addEventListener('click', () => pbColorPicker.click());
  pbChangeBtn.addEventListener('click', () => pbColorPicker.click());
  pbColorPicker.addEventListener('input', e => {
    _bubbleWorkingColor = e.target.value;
    pbSwatch.style.background = _bubbleWorkingColor;
    pbHex.textContent = _bubbleWorkingColor;
    /* Live-apply as you drag the color wheel */
    engine?.setColor(_bubbleWorkingColor);
    $('active-color-swatch').style.background = _bubbleWorkingColor;
    document.querySelectorAll('.qcolor').forEach(el => el.classList.remove('active'));
  });

  /* Thickness slider */
  pbSlider.addEventListener('input', () => {
    _bubbleWorkingThickness = parseFloat(pbSlider.value);
    pbSliderVal.textContent = _bubbleWorkingThickness;
    drawThicknessPreview(_bubbleWorkingThickness);
    /* Live-apply */
    engine?.setWidth(_bubbleWorkingThickness);
    $('stroke-width').value = _bubbleWorkingThickness;
    $('stroke-width-val').textContent = _bubbleWorkingThickness;
  });

  /* Apply button — applies the working value without saving the preset */
  pbApplyBtn.addEventListener('click', () => {
    if (_bubbleType === 'color') {
      engine?.setColor(_bubbleWorkingColor);
      $('active-color-swatch').style.background = _bubbleWorkingColor;
      document.querySelectorAll('.qcolor').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.color-preset-btn').forEach(el => el.classList.remove('active'));
    } else if (_bubbleType === 'thickness') {
      engine?.setWidth(_bubbleWorkingThickness);
      $('stroke-width').value = _bubbleWorkingThickness;
      $('stroke-width-val').textContent = _bubbleWorkingThickness;
      document.querySelectorAll('.thickness-preset-btn').forEach(b => b.classList.remove('active'));
    }
    closeBubble();
  });

  /* Save preset button — saves new value into the slot */
  pbSaveBtn.addEventListener('click', () => {
    if (_bubbleIdx < 0) return;
    if (_bubbleType === 'color') {
      colorPresets[_bubbleIdx] = _bubbleWorkingColor;
      saveColorPresets();
      refreshColorPresetBtn(_bubbleIdx);
      engine?.setColor(_bubbleWorkingColor);
      $('active-color-swatch').style.background = _bubbleWorkingColor;
      document.querySelectorAll('.qcolor').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.color-preset-btn').forEach(el => el.classList.remove('active'));
      $(`color-preset-${_bubbleIdx}`)?.classList.add('active');
    } else if (_bubbleType === 'thickness') {
      thicknessPresets[_bubbleIdx] = _bubbleWorkingThickness;
      saveThicknessPresets();
      refreshThicknessPresetBtn(_bubbleIdx);
      engine?.setWidth(_bubbleWorkingThickness);
      $('stroke-width').value = _bubbleWorkingThickness;
      $('stroke-width-val').textContent = _bubbleWorkingThickness;
      document.querySelectorAll('.size-preset-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.thickness-preset-btn').forEach(b => b.classList.remove('active'));
      $(`thickness-preset-${_bubbleIdx}`)?.classList.add('active');
    }
    closeBubble();
  });

  /* ── Color preset buttons ───────────────────────────────── */
  for (let i = 0; i < 3; i++) {
    const btn = $(`color-preset-${i}`);
    if (!btn) continue;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (bubble.style.display !== 'none' && _bubbleIdx === i && _bubbleType === 'color') {
        closeBubble(); return;
      }
      /* First tap: apply the preset and open edit bubble */
      engine?.setColor(colorPresets[i]);
      $('active-color-swatch').style.background = colorPresets[i];
      document.querySelectorAll('.qcolor').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.color-preset-btn').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.thickness-preset-btn').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      openBubble('color', i, btn);
    });
  }

  /* ── Thickness preset buttons ───────────────────────────── */
  for (let i = 0; i < 3; i++) {
    const btn = $(`thickness-preset-${i}`);
    if (!btn) continue;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (bubble.style.display !== 'none' && _bubbleIdx === i && _bubbleType === 'thickness') {
        closeBubble(); return;
      }
      /* First tap: apply the preset and open edit bubble */
      engine?.setWidth(thicknessPresets[i]);
      $('stroke-width').value = thicknessPresets[i];
      $('stroke-width-val').textContent = thicknessPresets[i];
      document.querySelectorAll('.size-preset-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.color-preset-btn').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.thickness-preset-btn').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      openBubble('thickness', i, btn);
    });
  }

  /* ── Size preset dots ──────────────────────────────────── */
  document.querySelectorAll('.size-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const size = parseFloat(btn.dataset.size);
      engine?.setWidth(size);
      $('stroke-width').value = size;
      $('stroke-width-val').textContent = size;
      document.querySelectorAll('.size-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  /* ── Pressure chips ────────────────────────────────────── */
  document.querySelectorAll('#pen-pressure-chips .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#pen-pressure-chips .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (engine) engine.pressureEnabled = btn.dataset.pressure === 'on';
    });
  });

  /* ── Blend mode chips (pen) ────────────────────────────── */
  document.querySelectorAll('#pen-blend-chips .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#pen-blend-chips .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      engine?.setPenBlendMode(btn.dataset.blend);
    });
  });

  /* ── Shape fill chips ──────────────────────────────────── */
  document.querySelectorAll('#shape-fill-chips .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#shape-fill-chips .chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      engine?.setShapeFillMode(btn.dataset.fill);
    });
  });
}

/* Contextual tool panel: show/hide sections based on active tool */
function updateToolPanel(tool) {
  const SHAPE_TOOLS = ['line', 'rect', 'circle', 'arrow'];
  const showPen   = tool === 'pen';
  const showShape = SHAPE_TOOLS.includes(tool);
  const showText  = tool === 'text';
  const hideSize  = tool === 'lasso' || tool === 'select';

  const mark = (id, show) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('visible', show);
  };

  mark('section-pen-opts',   showPen);
  mark('hr-pen',             showPen);
  mark('section-shape-opts', showShape);
  mark('hr-shape',           showShape);
  mark('section-text-opts',  showText);
  mark('hr-text',            showText);

  const sizeSection = $('section-size');
  const hrSize      = $('hr-size');
  if (sizeSection) sizeSection.style.display = hideSize ? 'none' : '';
  if (hrSize)      hrSize.style.display      = hideSize ? 'none' : '';
}

function bindEditorToolbar() {
  /* Tool buttons */
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!engine) return;
      document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      engine.setTool(btn.dataset.tool);
      $('status-tool').textContent = btn.dataset.tool.charAt(0).toUpperCase() + btn.dataset.tool.slice(1);
      updateToolPanel(btn.dataset.tool);
    });
  });

  /* Back */
  $('btn-editor-back').addEventListener('click', () => closeEditor());

  /* Undo/redo */
  $('btn-undo').addEventListener('click', () => engine?.undo());
  $('btn-redo').addEventListener('click', () => engine?.redo());

  /* Export PDF (primary) */
  $('btn-export-pdf').addEventListener('click', () => {
    if (!engine) return;
    const rawTitle = editorPages[editorPageIdx]?.title || '';
    const safeName = rawTitle.replace(/[^\w\s-]/g, '').trim() || `page-${Date.now()}`;
    engine.exportPDF(safeName);
    showToast('Page exported as PDF');
  });

  /* Export PNG */
  $('btn-export-png').addEventListener('click', () => {
    if (!engine) return;
    engine.exportPNG();
    showToast('Page exported as PNG');
  });

  /* Fit to screen */
  $('btn-zoom-fit').addEventListener('click', () => engine?.fitToScreen());

  /* Layers toggle */
  $('btn-layers-toggle').addEventListener('click', () => {
    const panel = $('layers-panel');
    panel.classList.toggle('hidden');
  });

  /* Add layer */
  $('btn-add-layer').addEventListener('click', () => engine?.addLayer());

  /* Page template button — use engine.pageId to always match the currently active page */
  $('btn-page-template').addEventListener('click', () => {
    templateCtx = { mode: 'change', pageId: engine?.pageId || editorPages[editorPageIdx]?.id };
    openModal('modal-template');
  });

  /* Page title edit */
  $('editor-page-title').addEventListener('change', async () => {
    const page = editorPages[editorPageIdx];
    if (!page) return;
    await PATCH('/pages/' + page.id, { title: $('editor-page-title').value });
    page.title = $('editor-page-title').value;
  });

  /* Add page in editor — appends after the current active page then reloads the full stack */
  $('btn-add-page-editor').addEventListener('click', async () => {
    if (!editorNotebookId) return;
    try {
      /* Match template & background of the first page in this notebook */
      const firstPage = editorPages[0];
      const template  = firstPage?.template  || 'blank';
      const bgColor   = firstPage?.bg_color  || 'default';
      const insertAfterIdx = editorPageIdx;
      const page = await POST('/pages', { notebookId: editorNotebookId, afterPageId: editorPages[insertAfterIdx]?.id, template, bgColor });
      editorPages.splice(insertAfterIdx + 1, 0, page);
      await loadAllPagesIntoEditor();
      /* Scroll the viewport to the newly created page */
      engine.scrollToPage(insertAfterIdx + 1);
    } catch (e) { showToast('Failed to add page'); }
  });

  /* Delete current page in editor — reloads the full stack after deletion */
  $('btn-delete-page-editor').addEventListener('click', async () => {
    console.log('[NeoNote] Delete bin clicked', { editorPages, editorPageIdx });
    if (editorPages.length === 0) {
      showToast('No pages to delete');
      return;
    }
    const page = editorPages[editorPageIdx];
    const label = page?.title || `Page ${editorPageIdx + 1}`;
    if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
    try {
      await DELETE('/pages/' + page.id);
      const deletedIdx = editorPageIdx;
      editorPages.splice(deletedIdx, 1);
      if (editorPages.length === 0) {
        closeEditor();
      } else {
        await loadAllPagesIntoEditor();
        engine.scrollToPage(Math.min(deletedIdx, editorPages.length - 1));
      }
      showToast('Page deleted');
    } catch (e) {
      console.error('[NeoNote] Failed to delete page', e);
      showToast('Failed to delete page: ' + (e.message || e));
    }
  });

  /* Insert image */
  $('btn-insert-image').addEventListener('click', () => $('image-file-input').click());
  $('image-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file || !engine) return;
    const reader = new FileReader();
    reader.onload = ev => engine.insertImage(ev.target.result);
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  /* Import PDF */
  $('btn-import-pdf').addEventListener('click', () => $('pdf-file-input').click());
  $('pdf-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    await importPDF(file);
  });
}

/* ══════════════════════════════════════════════════════════════
   NAV BINDINGS
   ══════════════════════════════════════════════════════════════ */
function bindNav() {
  ['home', 'recent', 'pinned', 'archive'].forEach(v => {
    const el = $('nav-' + v);
    if (!el) return;
    el.addEventListener('click', () => {
      state.filterTag = null; state.filterArchived = v === 'archive';
      switchView(v);
    });
  });
  $('nav-settings').addEventListener('click', () => openSettingsModal());
  $('btn-back-home').addEventListener('click', () => switchView('home'));
  $('btn-logout').addEventListener('click', logout);
}

function bindToolbar() {
  [$('btn-new-notebook'), $('btn-new-notebook-2'), $('btn-new-notebook-empty')].forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', () => openNotebookModal('create'));
  });
  [$('btn-new-page'), $('btn-new-page-empty')].forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      templateCtx = { mode: 'new-page', notebookId: state.activeNb?.id };
      openModal('modal-template');
    });
  });
  $('btn-nb-settings').addEventListener('click', () => openNotebookModal('edit', state.activeNb));

  /* View mode toggle */
  document.querySelectorAll('.btn-view-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-view-mode').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.viewMode = btn.dataset.mode;
      renderNotebooks(state.notebooks);
    });
  });
}

/* ══════════════════════════════════════════════════════════════
   MODALS
   ══════════════════════════════════════════════════════════════ */
function bindModals() {
  document.querySelectorAll('.modal-close,[data-modal]').forEach(btn => {
    const target = btn.dataset.modal;
    if (!target) return;
    btn.addEventListener('click', () => closeModal(target));
  });
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', e => { if (e.target === bd) closeModal(bd.id); });
  });

  /* Notebook modal save */
  $('btn-notebook-save').addEventListener('click', saveNotebookModal);

  /* Notebook color picker */
  document.querySelectorAll('#nb-colors .nb-color').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('#nb-colors .nb-color').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
    });
  });
  $('nb-custom-color').addEventListener('input', e => {
    document.querySelectorAll('#nb-colors .nb-color').forEach(el => el.classList.remove('active'));
  });

  /* Icon picker */
  document.querySelectorAll('#nb-icon-picker span').forEach(sp => {
    sp.addEventListener('click', () => {
      document.querySelectorAll('#nb-icon-picker span').forEach(s => s.classList.remove('active'));
      sp.classList.add('active');
      $('nb-modal-icon').value = sp.dataset.emoji;
    });
  });

  /* Template modal */
  document.querySelectorAll('.tmpl-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.tmpl-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });
  document.querySelectorAll('#page-bg-colors .nb-color').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('#page-bg-colors .nb-color').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
    });
  });
  $('btn-template-apply').addEventListener('click', applyTemplateModal);
}

function openModal(id) { $(id).style.display = 'flex'; }
function closeModal(id) { if ($(id)) $(id).style.display = 'none'; }
function hideAllModals() {
  document.querySelectorAll('.modal-backdrop').forEach(m => m.style.display = 'none');
}

function openNotebookModal(mode, nb) {
  nbModalMode = mode;
  editingNbId = nb?.id || null;
  $('modal-notebook-title').textContent = mode === 'edit' ? 'Edit Notebook' : 'New Notebook';
  $('btn-notebook-save').textContent     = mode === 'edit' ? 'Save' : 'Create';

  if (mode === 'edit' && nb) {
    $('nb-modal-title').value = nb.title || '';
    $('nb-modal-icon').value  = nb.icon  || '📓';
    $('nb-modal-tags').value  = (nb.tags || []).join(', ');
    /* Set color */
    document.querySelectorAll('#nb-colors .nb-color').forEach(el => {
      el.classList.toggle('active', el.dataset.color === nb.cover_color);
    });
    /* Emoji highlight */
    document.querySelectorAll('#nb-icon-picker span').forEach(s => {
      s.classList.toggle('active', s.dataset.emoji === nb.icon);
    });
  } else {
    $('nb-modal-title').value = '';
    $('nb-modal-icon').value  = '📓';
    $('nb-modal-tags').value  = '';
    document.querySelectorAll('#nb-colors .nb-color').forEach((el, i) => el.classList.toggle('active', i === 0));
  }
  openModal('modal-notebook');
  setTimeout(() => $('nb-modal-title').focus(), 80);
}

async function saveNotebookModal() {
  const title      = $('nb-modal-title').value.trim() || 'Untitled Notebook';
  const icon       = $('nb-modal-icon').value || '📓';
  const tags       = $('nb-modal-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const colorEl    = document.querySelector('#nb-colors .nb-color.active');
  const coverColor = colorEl ? colorEl.dataset.color : ($('nb-custom-color').value || '#6366f1');

  try {
    if (nbModalMode === 'create') {
      const nb = await POST('/notebooks', { title, icon, coverColor, tags });
      state.notebooks.unshift(nb);
      renderNotebooks(state.notebooks);
      dom.nbBadge.textContent = state.notebooks.length;
      closeModal('modal-notebook');
      showToast('Notebook created!');
      openNotebook(nb.id);
    } else {
      await PATCH('/notebooks/' + editingNbId, { title, icon, coverColor, tags });
      closeModal('modal-notebook');
      showToast('Notebook updated');
      await loadNotebooks(state.view);
      if (state.activeNb?.id === editingNbId) {
        state.activeNb.title = title;
        state.activeNb.icon  = icon;
        dom.nbTitle.textContent = title;
        dom.nbIcon.textContent  = icon;
      }
    }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function applyTemplateModal() {
  const tmplCard = document.querySelector('.tmpl-card.active');
  const template = tmplCard?.dataset.tmpl || 'blank';
  const bgEl     = document.querySelector('#page-bg-colors .nb-color.active');
  const bgColor  = bgEl ? bgEl.dataset.bg : ($('page-bg-custom').value || 'default');

  if (templateCtx.mode === 'new-page') {
    const nbId = templateCtx.notebookId || state.activeNb?.id;
    if (!nbId) return;
    try {
      const page = await POST('/pages', { notebookId: nbId, template, bgColor });
      state.activePages.push(page);
      renderPages(state.activePages);
      closeModal('modal-template');
      showToast('Page added');
      openPageEditor(page.id);
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  } else if (templateCtx.mode === 'change') {
    if (!templateCtx.pageId) return;
    try {
      await PATCH('/pages/' + templateCtx.pageId, { template, bgColor });
      if (engine) {
        engine.template = template;
        engine.bgColor  = bgColor;
        engine._renderTemplate();
      }
      closeModal('modal-template');
      showToast('Template changed');
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  }
}

/* ══════════════════════════════════════════════════════════════
   CONTEXT MENU
   ══════════════════════════════════════════════════════════════ */
function bindContextMenu() {
  $('ctx-open').addEventListener('click', () => {
    if (!contextTarget) return;
    const target = contextTarget;
    hideContextMenu();
    if (target.type === 'notebook') openNotebook(target.data.id);
    else if (target.type === 'page') openPageEditor(target.data.id);
  });
  $('ctx-rename').addEventListener('click', () => {
    if (!contextTarget) return;
    const target = contextTarget;
    hideContextMenu();
    if (target.type === 'notebook') openNotebookModal('edit', target.data);
    else if (target.type === 'page') {
      const newTitle = prompt('Page title:', target.data.title || '');
      if (newTitle !== null) PATCH('/pages/' + target.data.id, { title: newTitle }).then(() => loadPages(state.activeNb.id));
    }
  });
  $('ctx-duplicate').addEventListener('click', async () => {
    if (!contextTarget) return;
    const target = contextTarget;
    hideContextMenu();
    try {
      if (target.type === 'notebook') {
        showToast('Duplicate notebook coming soon');
      } else if (target.type === 'page') {
        await POST('/pages/' + target.data.id + '/duplicate');
        await loadPages(state.activeNb.id);
        showToast('Page duplicated');
      }
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  });
  $('ctx-pin').addEventListener('click', async () => {
    if (!contextTarget || contextTarget.type !== 'notebook') return;
    const nb = contextTarget.data;
    hideContextMenu();
    await PATCH('/notebooks/' + nb.id, { pinned: !nb.pinned });
    await loadNotebooks(state.view);
    showToast(nb.pinned ? 'Unpinned' : 'Pinned');
  });
  $('ctx-archive').addEventListener('click', async () => {
    if (!contextTarget || contextTarget.type !== 'notebook') return;
    const nb = contextTarget.data;
    hideContextMenu();
    await PATCH('/notebooks/' + nb.id, { archived: !nb.archived });
    await loadNotebooks(state.view);
    showToast(nb.archived ? 'Unarchived' : 'Archived');
  });
  $('ctx-delete').addEventListener('click', async () => {
    if (!contextTarget) return;
    const { type, data } = contextTarget;
    hideContextMenu();
    const label = type === 'notebook' ? `notebook "${data.title}"` : 'this page';
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      if (type === 'notebook') {
        await DELETE('/notebooks/' + data.id);
        await loadNotebooks(state.view);
        showToast('Notebook deleted');
      } else if (type === 'page') {
        await DELETE('/pages/' + data.id);
        await loadPages(state.activeNb.id);
        showToast('Page deleted');
        if (state.activePages.length === 0 && state.activeNb) {
          dom.pageEmpty.style.display = 'flex';
          dom.pageContainer.style.display = 'none';
        }
      }
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#context-menu')) hideContextMenu();
  });
}

function showContextMenu(e, target) {
  contextTarget = target;
  const menu = dom.ctxMenu;
  menu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth  - 180);
  const y = Math.min(e.clientY, window.innerHeight - 240);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  /* Hide options not applicable */
  $('ctx-pin').style.display     = target.type === 'notebook' ? '' : 'none';
  $('ctx-archive').style.display = target.type === 'notebook' ? '' : 'none';
  $('ctx-pin').textContent       = target.data?.pinned ? 'Unpin' : 'Pin';
  $('ctx-archive').textContent   = target.data?.archived ? 'Unarchive' : 'Archive';
}

function hideContextMenu() {
  dom.ctxMenu.style.display = 'none';
  contextTarget = null;
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS
   ══════════════════════════════════════════════════════════════ */
function bindSettings() {
  /* Modal open/close */
  $('settings-close').addEventListener('click', closeSettingsModal);
  $('settings-overlay').addEventListener('click', e => {
    if (e.target === $('settings-overlay')) closeSettingsModal();
  });

  /* Tab switching */
  document.querySelectorAll('#settings-tab-list .stab').forEach(btn => {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.stab));
  });

  $('st-pen-width').addEventListener('input', () => {
    $('st-pen-width-val').textContent = $('st-pen-width').value;
  });

  $('btn-save-account').addEventListener('click', async () => {
    try {
      await api('PATCH', '/auth/me', {
        displayName: $('st-displayname').value,
        email: $('st-email').value || undefined,
        avatarColor: $('st-avatar-color').value,
        currentPassword: $('st-cur-pw').value || undefined,
        newPassword: $('st-new-pw').value || undefined,
      });
      await PATCH('/settings', {
        defaultPenColor: $('st-pen-color').value,
        defaultPenWidth: parseFloat($('st-pen-width').value),
        palmRejection: $('st-palm').checked,
        pressureEnabled: $('st-pressure').checked,
        autoSaveInterval: parseInt($('st-autosave').value),
        showPageNumbers: $('st-pgnums').checked,
      });
      state.user = await GET('/auth/me');
      state.settings = await GET('/settings');
      applySettings(state.settings);
      showToast('Settings saved!');
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  });
}

function openSettingsModal() {
  loadSettingsForm();
  $('settings-overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeSettingsModal() {
  $('settings-overlay').style.display = 'none';
  document.body.style.overflow = '';
}

function switchSettingsTab(tab) {
  document.querySelectorAll('#settings-tab-list .stab').forEach(b => {
    b.classList.toggle('active', b.dataset.stab === tab);
  });
  document.querySelectorAll('.settings-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'stab-' + tab);
  });
}

function loadSettingsForm() {
  const s = state.settings;
  $('st-palm').checked      = s.palm_rejection !== 0;
  $('st-pressure').checked  = s.pressure_enabled !== 0;
  $('st-pen-color').value   = s.default_pen_color || '#000000';
  $('st-pen-width').value   = s.default_pen_width || 2.5;
  $('st-pen-width-val').textContent = s.default_pen_width || 2.5;
  $('st-autosave').value    = s.auto_save_interval || 5;
  $('st-pgnums').checked    = s.show_page_numbers !== 0;
  if (state.user) {
    $('st-email').value       = state.user.email || '';
    $('st-displayname').value   = state.user.displayName || state.user.username || '';
    $('st-avatar-color').value  = state.user.avatarColor || '#6366f1';
  }
}

/* ══════════════════════════════════════════════════════════════
   SIDEBAR TAGS
   ══════════════════════════════════════════════════════════════ */
async function loadSidebarTags() {
  try {
    /* Collect all tags from loaded notebooks */
    const allTags = [...new Set(state.notebooks.flatMap(nb => nb.tags || []))];
    state.tags = allTags;
    dom.sidebarTags.innerHTML = allTags.map(t => `
      <div class="tag-item ${state.filterTag === t ? 'active' : ''}" data-tag="${escHtml(t)}">
        <div class="tag-dot"></div>${escHtml(t)}
      </div>`).join('') || '<div style="padding:.2rem .8rem;font-size:.78rem;color:var(--text-3)">No tags yet</div>';
    dom.sidebarTags.querySelectorAll('.tag-item').forEach(el => {
      el.addEventListener('click', () => {
        state.filterTag = state.filterTag === el.dataset.tag ? null : el.dataset.tag;
        loadNotebooks(state.view);
      });
    });
  } catch {}
}

function bindSidebarSearch() {
  $('sidebar-search').addEventListener('input', () => {
    state.searchQ = $('sidebar-search').value;
    clearTimeout(state._searchTimer);
    state._searchTimer = setTimeout(() => loadNotebooks(state.view), 250);
  });
}

/* ══════════════════════════════════════════════════════════════
   MOBILE
   ══════════════════════════════════════════════════════════════ */
function bindMobile() {
  $('btn-menu-toggle').addEventListener('click', () => {
    dom.sidebar.classList.toggle('open');
    dom.overlay.classList.toggle('visible');
  });
  dom.overlay.addEventListener('click', () => {
    dom.sidebar.classList.remove('open');
    dom.overlay.classList.remove('visible');
  });
  $('btn-mobile-new').addEventListener('click', () => openNotebookModal('create'));
}

/* ══════════════════════════════════════════════════════════════
   KEYBOARD
   ══════════════════════════════════════════════════════════════ */
function bindKeyboard() {
  document.addEventListener('keydown', e => {
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
    /* Space in editor is handled by canvas engine */
    if (e.key === 'Escape') {
      const edOverlay = $('editor-overlay');
      if (edOverlay.style.display !== 'none') {
        /* Do nothing — canvas engine handles Escape for text */
      }
    }
    if (e.key === 'F' || e.key === 'f') {
      if (!e.metaKey && !e.ctrlKey) $('sidebar-search')?.focus();
    }
  });
  document.addEventListener('keyup', e => {
    if (e.key === ' ' && engine) {
      engine._spaceDown = false;
      engine.canvasArea.style.cursor = '';
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   USER CHIP
   ══════════════════════════════════════════════════════════════ */
function updateUserChip() {
  /* User chip has been replaced by sidebar-footer buttons.
     Kept as a no-op to avoid breaking any call sites. */
}

/* ══════════════════════════════════════════════════════════════
   LOGOUT
   ══════════════════════════════════════════════════════════════ */
async function logout() {
  try { await POST('/auth/logout'); } catch {}
  location.href = '/login';
}

/* ══════════════════════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════════════════════ */
let _toastTimer = null;
function showToast(msg, type = 'info') {
  const el = dom.toast;
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = type === 'error' ? 'var(--danger)' : 'var(--surface4)';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2800);
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relativeDate(unixSec) {
  if (!unixSec) return '';
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800)return Math.floor(diff / 86400) + 'd ago';
  return new Date(unixSec * 1000).toLocaleDateString();
}

function shiftHue(hex, deg) {
  /* Simple hue shift for gradient covers */
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.min(255, r + deg)},${Math.min(255, g + deg / 2)},${Math.min(255, b)})`;
}

/* ══════════════════════════════════════════════════════════════
   PDF IMPORT
   ══════════════════════════════════════════════════════════════ */
async function importPDF(file) {
  if (!window.pdfjsLib) { showToast('PDF library not ready yet, try again'); return; }
  if (!editorNotebookId)  { showToast('Open a notebook first'); return; }

  let pdf;
  try {
    showToast('Reading PDF…');
    const ab = await file.arrayBuffer();
    /* Pass Uint8Array — more reliable across PDF.js versions than raw ArrayBuffer */
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(ab) }).promise;
  } catch (err) {
    console.error('[NeoNote] PDF load error', err);
    showToast('Could not read PDF: ' + (err.message || err));
    return;
  }

  const total       = pdf.numPages;
  const firstNewIdx = editorPages.length;
  let   imported    = 0;

  for (let i = 1; i <= total; i++) {
    showToast(`Rendering page ${i} / ${total}…`);
    try {
      const pdfPage  = await pdf.getPage(i);
      const viewport = pdfPage.getViewport({ scale: 1.0 });

      /* Scale to fill as much of 1404×1872 as possible while keeping aspect ratio */
      const scale    = Math.min(1404 / viewport.width, 1872 / viewport.height);
      const scaledVp = pdfPage.getViewport({ scale });

      /* Render to a temp canvas that exactly matches the scaled PDF dimensions.
         This avoids the PDF-coordinate-space transform ambiguity: instead of
         passing a transform to render(), we use ctx.drawImage() to composite
         the result onto the final 1404×1872 white canvas at the right position. */
      const tmp    = document.createElement('canvas');
      tmp.width    = Math.ceil(scaledVp.width);
      tmp.height   = Math.ceil(scaledVp.height);
      await pdfPage.render({ canvasContext: tmp.getContext('2d'), viewport: scaledVp }).promise;

      /* Composite onto a 1404×1872 white canvas, centred */
      const out  = document.createElement('canvas');
      out.width  = 1404; out.height = 1872;
      const ctx  = out.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1404, 1872);
      ctx.drawImage(tmp, Math.round((1404 - tmp.width) / 2), Math.round((1872 - tmp.height) / 2));

      const dataUrl = out.toDataURL('image/jpeg', 0.90);

      /* Create server page, attach the rasterised image, save thumbnail */
      const newPage = await POST('/pages', {
        notebookId: editorNotebookId,
        afterPageId: editorPages[editorPages.length - 1]?.id,
      });
      editorPages.push(newPage);

      const layers  = await GET('/pages/' + newPage.id + '/layers');
      const layerId = layers[0]?.id;
      if (layerId) {
        await POST('/strokes/images', {
          pageId: newPage.id, layerId,
          data: dataUrl, x: 0, y: 0, width: 1404, height: 1872, rotation: 0,
        });
        const th = document.createElement('canvas');
        th.width = 350; th.height = Math.round(350 * 1872 / 1404);
        th.getContext('2d').drawImage(out, 0, 0, th.width, th.height);
        await PATCH('/pages/' + newPage.id, { thumbnail: th.toDataURL('image/jpeg', 0.5) });
      }
      imported++;
    } catch (pageErr) {
      console.error('[NeoNote] PDF page', i, 'render error:', pageErr);
      showToast(`Warning: page ${i} failed — skipped`);
      /* continue with remaining pages */
    }
  }

  try { pdf.destroy(); } catch { /* best-effort cleanup */ }

  if (imported === 0) {
    showToast('PDF import failed — no pages could be rendered');
    return;
  }

  await loadAllPagesIntoEditor();
  engine.scrollToPage(firstNewIdx);
  showToast(`PDF imported — ${imported} of ${total} page${total > 1 ? 's' : ''} added`);
}

/* ══════════════════════════════════════════════════════════════
   BOOTSTRAP
   ══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
