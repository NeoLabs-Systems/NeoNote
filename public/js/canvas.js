/**
 * NeoNote — canvas.js
 * Full-featured drawing engine:
 *   • Pressure-sensitive strokes (PointerEvents API)
 *   • Tools: pen, highlighter, eraser, text, line, rect, circle, arrow, lasso, select
 *   • Catmull-Rom spline smoothing
 *   • Layers
 *   • Undo / redo (command pattern)
 *   • Zoom & infinite pan
 *   • Page templates rendered on separate canvas
 *   • Auto-save with debounce
 *   • Export to PNG
 */

export class CanvasEngine {
  constructor(opts = {}) {
    // For straight line detection
    this._lineSnapTimer = null;
    this._lineSnapActive = false;
    this.onSave       = opts.onSave       || (() => {});
    this.onStatusUpdate = opts.onStatusUpdate || (() => {});
    this.onUndoRedoUpdate = opts.onUndoRedoUpdate || (() => {});
    this.onLayersChange = opts.onLayersChange || (() => {});
    this.onActivePageChange = opts.onActivePageChange || null;
    this.onActivePageChange = opts.onActivePageChange || null;
    this.onActivePageChange = opts.onActivePageChange || null;

    /* Page dimensions (logical, in CSS px at 100% zoom) */
    this.pageW = 1404;
    this.pageH = 1872;

    /* Canvas DOM nodes — set to null until first loadAllPages() call */
    this.templateCanvas  = null;
    this.activeCanvas    = null;
    this.overlayCanvas   = null;
    this.container       = null;  /* active page's .page-frame element */
    this.pagesContainer  = document.getElementById('page-canvas-container');
    this.viewport        = document.getElementById('canvas-viewport');
    this.canvasArea      = document.getElementById('canvas-area');

    /* Contexts — set to null until first loadAllPages() call */
    this.tCtx = null;
    this.aCtx = null;
    this.oCtx = null;

    /* Multi-page state */
    this._pages         = [];   /* [{pageId, pageW, pageH, template, bgColor, yOffset, frame, templateCanvas, tCtx, activeCanvas, aCtx, overlayCanvas, oCtx, layers, activeLayerIdx, strokes, images}] */
    this._activePageIdx = 0;

    /* Layer canvases: [{id, name, canvas, ctx, visible, locked, opacity}] */
    this.layers       = [];
    this.activeLayerIdx = 0;

    /* Tool state */
    this.tool     = 'pen';
    this.color    = '#000000';
    this.width    = 2.5;
    this.opacity  = 1.0;
    this.pressureEnabled = true;

    /* Zoom / pan */
    this.scale    = 1.0;
    this.offsetX  = 0;
    this.offsetY  = 0;
    this._fitScale = 1.0;

    /* Drawing state */
    this._drawing    = false;
    this._points     = [];   /* [{x,y,p,t}] current stroke */
    this._lastX      = 0;
    this._lastY      = 0;
    this._shapeStart = null;

    /* Text tool */
    this._textInput  = null;

    /* Lasso / select state */
    this._lassoPath  = [];
    this._selection  = null;   /* { strokes: [], images: [] } */
    this._copyBuffer = null;
    this._moveStart  = null;

    /* Undo / redo */
    this._undoStack  = [];   /* array of { type, … } snapshots */
    this._redoStack  = [];
    this._MAX_UNDO   = 80;

    /* Pending save */
    this._savePending   = [];
    this._deletePending = [];
    this._autoSaveTimer = null;
    this._autoSaveInterval = 5000;

    /* Page metadata */
    this.pageId     = null;
    this.notebookId = null;
    this.template   = 'blank';
    this.bgColor    = 'default';

    /* Strokes (already committed to server) */
    this._strokes = [];   /* [{id, layerId, tool, color, width, opacity, blendMode, points, bbox, extra}] */
    this._images  = [];   /* [{id, layerId, data, x, y, width, height, rotation}] */

    /* Palm rejection */
    this._palmRejection = true;

    /* Text font size (independent of stroke width) */
    this.textFontSize = 24;

    /* Pen proximity tracking — true when stylus is hovering over canvas */
    this._penNearby      = false;
    this._penNearbyTimer = null;

    /* Pan inertia */
    this._panVelX  = 0;
    this._panVelY  = 0;
    this._panRafId = null;
    this._panLastT = 0;

    /* Set to true while a 2-finger gesture is active — blocks pointer-event pan */
    this._twoFingerActive = false;

    /* True from the moment a pen pointerdown fires until pointerup/cancel.
       Used to detect stylus-sourced touch events on Android Chrome (which has no
       touchType property) and skip e.preventDefault() so pointer events survive. */
    this._penPointerActive = false;

    /* Debug log buffer — stores the last 200 [NoteNeo]-tagged console messages
       so they can be copied to clipboard on devices without DevTools. */
    this._debugLog = [];
    (() => {
      const origLog  = console.log.bind(console);
      const origWarn = console.warn.bind(console);
      const capture  = (level, args) => {
        if (typeof args[0] === 'string' && args[0].includes('[NoteNeo]')) {
          const ts = new Date().toISOString().slice(11, 23);
          this._debugLog.push(`[${ts}][${level}] ` + args.map(String).join(' '));
          if (this._debugLog.length > 200) this._debugLog.shift();
        }
      };
      console.log  = (...a) => { capture('LOG',  a); origLog(...a); };
      console.warn = (...a) => { capture('WARN', a); origWarn(...a); };
    })();

    /* Selection toolbar element */
    this._selectToolbar = document.getElementById('select-toolbar');
    this._selectionBbox = null;

    this._bindEvents();
  }

  /* ═══════════════════════════════════════════════════════════
     INIT / LOAD PAGE
     ═══════════════════════════════════════════════════════════ */
  /* Backward-compat single-page wrapper */
  async loadPage(pageData) {
    return this.loadAllPages([pageData]);
  }

  /* Load one or more pages and display them stacked vertically. */
  async loadAllPages(allPagesData) {
    /* Stop any in-progress stroke */
    this._drawing = false;
    this._drawingPointerId = null;
    this._points = [];
    this._panning = false;
    if (this.aCtx) { this.aCtx.clearRect(0, 0, this.pageW, this.pageH); }
    if (this.oCtx) { this.oCtx.clearRect(0, 0, this.pageW, this.pageH); }

    /* Remove previous page frames from DOM */
    this._pages.forEach(pg => {
      if (pg.frame?.parentNode) pg.frame.parentNode.removeChild(pg.frame);
    });
    this._pages = [];

    this._undoStack = [];
    this._redoStack = [];
    this._savePending = [];
    this._deletePending = [];
    this.onUndoRedoUpdate(false, false);

    const PAGE_GAP = 40;
    let yOffset = 0;

    for (const pageData of allPagesData) {
      const pg = await this._buildPageFrame(pageData, yOffset);
      this._pages.push(pg);
      yOffset += pg.pageH + PAGE_GAP;
    }

    /* Size the viewport container to cover all page frames */
    const totalH = Math.max(1, yOffset - PAGE_GAP);
    const maxW   = Math.max(1, ...this._pages.map(pg => pg.pageW));
    this.pagesContainer.style.width  = maxW + 'px';
    this.pagesContainer.style.height = totalH + 'px';

    /* Activate first page — sets this.activeCanvas, this.layers, etc. */
    this._switchActivePage(0);

    this._fitToScreen();
    this._renderAllPages();
    this.onLayersChange(this.layers, this.activeLayerIdx);
  }

  /* Build one page's DOM frame + canvases. Returns a page record. */
  async _buildPageFrame(pageData, yOffset) {
    const p = pageData.page;
    const W = p.width  || 1404;
    const H = p.height || 1872;

    /* Outer frame div — positioned absolutely within pagesContainer */
    const frame = document.createElement('div');
    frame.className = 'page-frame';
    frame.style.cssText = `position:absolute;top:${yOffset}px;left:0;width:${W}px;height:${H}px;overflow:hidden;`;
    this.pagesContainer.appendChild(frame);

    /* Template canvas (bottom) */
    const templateCanvas = document.createElement('canvas');
    templateCanvas.width  = W; templateCanvas.height = H;
    templateCanvas.style.cssText = `position:absolute;top:0;left:0;width:${W}px;height:${H}px;`;
    frame.appendChild(templateCanvas);

    /* Active (drawing) canvas */
    const activeCanvas = document.createElement('canvas');
    activeCanvas.width  = W; activeCanvas.height = H;
    activeCanvas.className = 'canvas-active-layer';
    activeCanvas.style.cssText = `position:absolute;top:0;left:0;width:${W}px;height:${H}px;touch-action:none;user-select:none;`;
    /* (layer canvases inserted between template and active by _buildPageLayers) */

    /* Overlay canvas (top) */
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width  = W; overlayCanvas.height = H;
    overlayCanvas.className = 'canvas-overlay-layer';
    overlayCanvas.style.cssText = `position:absolute;top:0;left:0;width:${W}px;height:${H}px;pointer-events:none;`;

    /* Strokes / images for this page (normalized from snake_case) */
    const strokes = (pageData.strokes || []).map(s => ({
      id:        s.id,
      layerId:   s.layerId   ?? s.layer_id,
      pageId:    s.pageId    ?? s.page_id,
      tool:      s.tool      ?? 'pen',
      color:     s.color     ?? '#000000',
      width:     s.width     ?? 2,
      opacity:   s.opacity   ?? 1.0,
      blendMode: s.blendMode ?? s.blend_mode ?? 'source-over',
      points:    s.points    ?? [],
      bbox:      s.bbox      ?? null,
      extra:     s.extra     ?? null,
    }));
    const images = (pageData.images || []).map(img => ({
      id:       img.id,
      layerId:  img.layerId  ?? img.layer_id,
      pageId:   img.pageId   ?? img.page_id,
      data:     img.data,
      x:        img.x        ?? 0,
      y:        img.y        ?? 0,
      width:    img.width    ?? 300,
      height:   img.height   ?? 300,
      rotation: img.rotation ?? 0,
    }));

    const pg = {
      /* identity */
      pageId:    p.id,
      notebookId: p.notebook_id,
      pageW:     W,
      pageH:     H,
      template:  p.template || 'blank',
      bgColor:   p.bg_color || 'default',
      yOffset,
      /* DOM */
      frame,
      templateCanvas,
      tCtx: templateCanvas.getContext('2d'),
      activeCanvas,
      aCtx: activeCanvas.getContext('2d'),
      overlayCanvas,
      oCtx: overlayCanvas.getContext('2d'),
      /* data */
      strokes,
      images,
      /* layers — filled by _buildPageLayers */
      layers: [],
      activeLayerIdx: 0,
    };

    await this._buildPageLayers(pg, pageData.layers || []);

    /* Insert active + overlay after layer canvases */
    frame.appendChild(activeCanvas);
    frame.appendChild(overlayCanvas);

    this._bindPageCanvasEvents(pg);

    return pg;
  }

  async _buildPageLayers(pg, layerDefs) {
    /* Remove existing layer canvases if rebuilding */
    pg.layers.forEach(l => {
      if (l.canvas?.parentNode) l.canvas.parentNode.removeChild(l.canvas);
    });
    pg.layers = [];

    layerDefs = [...layerDefs].sort((a, b) => a.sort_order - b.sort_order);

    for (const ld of layerDefs) {
      const canvas = document.createElement('canvas');
      canvas.width  = pg.pageW;
      canvas.height = pg.pageH;
      canvas.style.cssText = `position:absolute;top:0;left:0;width:${pg.pageW}px;height:${pg.pageH}px;`;
      canvas.dataset.layerId = ld.id;
      /* Append after template canvas — active/overlay appended later in _buildPageFrame */
      pg.frame.appendChild(canvas);
      pg.layers.push({
        id:        ld.id,
        name:      ld.name,
        visible:   ld.visible !== 0,
        locked:    ld.locked  === 1,
        opacity:   ld.opacity ?? 1.0,
        sortOrder: ld.sort_order,
        canvas,
        ctx: canvas.getContext('2d'),
        _pageRef:  pg,   /* back-reference so _renderLayer can find page strokes/dims */
      });
    }
    pg.activeLayerIdx = Math.max(0, pg.layers.length - 1);
  }

  /* Bind per-page canvas pointer events. Pointerdown first switches active page. */
  _bindPageCanvasEvents(pg) {
    const canvas = pg.activeCanvas;
    canvas.addEventListener('pointerdown', e => {
      const idx = this._pages.indexOf(pg);
      if (idx >= 0 && idx !== this._activePageIdx) this._switchActivePage(idx);
      this._onDown(e);
    }, { passive: false });
    canvas.addEventListener('pointermove',  e => this._onMove(e),   { passive: false });
    canvas.addEventListener('pointerup',    e => this._onUp(e),     { passive: false });
    canvas.addEventListener('pointerleave', e => {
      if (e.pointerType === 'mouse') this._onUp(e);
      if (e.pointerType === 'pen') {
        clearTimeout(this._penNearbyTimer);
        this._penNearby = false;
      }
      if (this.tool === 'eraser' && pg === this._pages[this._activePageIdx]) {
        pg.oCtx.clearRect(0, 0, pg.pageW, pg.pageH);
      }
    }, { passive: false });
    canvas.addEventListener('pointercancel', e => this._onCancel(e), { passive: false });
    canvas.addEventListener('contextmenu',   e => e.preventDefault());
    canvas.addEventListener('dblclick',      e => this._onDblClick(e));
    /* Track pen proximity */
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'pen') {
        this._penNearby = true;
        clearTimeout(this._penNearbyTimer);
        this._penNearbyTimer = setTimeout(() => { this._penNearby = false; }, 800);
      }
    }, { passive: true });
  }

  /* Switch which page is "active" — updates all this.* shortcut refs. */
  _switchActivePage(idx) {
    if (!this._pages.length) return;
    idx = Math.max(0, Math.min(idx, this._pages.length - 1));
    this._activePageIdx = idx;
    const pg = this._pages[idx];
    this.pageId      = pg.pageId;
    this.notebookId  = pg.notebookId;
    this.pageW       = pg.pageW;
    this.pageH       = pg.pageH;
    this.template    = pg.template;
    this.bgColor     = pg.bgColor;
    this.container   = pg.frame;
    this.templateCanvas = pg.templateCanvas;
    this.tCtx        = pg.tCtx;
    this.activeCanvas = pg.activeCanvas;
    this.aCtx        = pg.aCtx;
    this.overlayCanvas = pg.overlayCanvas;
    this.oCtx        = pg.oCtx;
    this.layers      = pg.layers;
    this.activeLayerIdx = pg.activeLayerIdx;
    this._strokes    = pg.strokes;
    this._images     = pg.images;
    this.onLayersChange(this.layers, this.activeLayerIdx);
    if (this.onActivePageChange) this.onActivePageChange(idx);
  }

  /* Animate the viewport so that page [idx] is centered/top-aligned. */
  scrollToPage(idx) {
    if (!this._pages.length) return;
    idx = Math.max(0, Math.min(idx, this._pages.length - 1));
    const pg = this._pages[idx];
    const area = this.canvasArea;
    /* Position the top of the target page 20px below the top of the area */
    this.offsetY = 20 - pg.yOffset * this.scale;
    this.offsetX = Math.round((area.clientWidth - pg.pageW * this.scale) / 2);
    this._switchActivePage(idx);
    this._applyTransform();
  }

  /* _buildLayers kept for internal compatibility — delegates to active page record */
  async _buildLayers(layerDefs) {
    const pg = this._pages[this._activePageIdx];
    if (pg) await this._buildPageLayers(pg, layerDefs);
  }

  /* ═══════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════ */
  _renderTemplate(opts = {}) {
    const ctx      = opts.ctx      ?? this.tCtx;
    const W        = opts.pageW    ?? this.pageW;
    const H        = opts.pageH    ?? this.pageH;
    const template = opts.template ?? this.template ?? 'blank';
    const bgColor  = opts.bgColor  ?? this.bgColor  ?? 'default';
    ctx.clearRect(0, 0, W, H);

    /* Background — always fill so canvas is never transparent/black */
    ctx.fillStyle = (bgColor && bgColor !== 'default') ? bgColor : '#ffffff';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#888';
    ctx.lineWidth   = 1;

    switch (template) {
      case 'lined':
        for (let y = 60; y < H; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        ctx.strokeStyle = '#e05'; ctx.globalAlpha = 0.1;
        ctx.beginPath(); ctx.moveTo(80, 0); ctx.lineTo(80, H); ctx.stroke();
        break;
      case 'dotted':
        for (let y = 40; y < H; y += 28) {
          for (let x = 40; x < W; x += 28) {
            ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fillStyle = '#888'; ctx.globalAlpha = 0.25; ctx.fill();
          }
        }
        break;
      case 'grid':
        for (let y = 0; y < H; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        for (let x = 0; x < W; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
        break;
      case 'hex': {
        const s = 22, h = s * Math.sqrt(3);
        ctx.strokeStyle = '#888'; ctx.globalAlpha = 0.15;
        for (let row = -1; row * h < H + h; row++) {
          for (let col = -1; col * 1.5 * s < W + s; col++) {
            const cx2 = col * 1.5 * s + (row % 2 === 0 ? 0 : s * 0.75);
            const cy2 = row * h * 0.5;
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
              const angle = Math.PI / 180 * (60 * i - 30);
              const px = cx2 + s * Math.cos(angle), py = cy2 + s * Math.sin(angle);
              i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
            }
            ctx.closePath(); ctx.stroke();
          }
        }
        break;
      }
      case 'music':
        for (let group = 40; group < H; group += 80) {
          for (let line = 0; line < 5; line++) {
            const y = group + line * 10;
            ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(W - 40, y); ctx.stroke();
          }
        }
        break;
      case 'cornell': {
        /* Margin line */
        ctx.strokeStyle = '#e05'; ctx.globalAlpha = 0.12;
        ctx.beginPath(); ctx.moveTo(200, 60); ctx.lineTo(200, H - 60); ctx.stroke();
        /* Horizontal lines */
        ctx.strokeStyle = '#888'; ctx.globalAlpha = 0.15;
        for (let y = 60; y < H - 60; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        /* Footer line */
        ctx.strokeStyle = '#e05'; ctx.globalAlpha = 0.12;
        ctx.beginPath(); ctx.moveTo(0, H - 100); ctx.lineTo(W, H - 100); ctx.stroke();
        break;
      }
      case 'isometric': {
        const step = 40;
        ctx.strokeStyle = '#888'; ctx.globalAlpha = 0.12;
        /* 60-degree lines */
        for (let x = -H; x < W + H; x += step) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + H * Math.tan(Math.PI/6), H); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - H * Math.tan(Math.PI/6), H); ctx.stroke();
        }
        break;
      }
    }
    ctx.restore();
  }

  _renderLayer(layerObj) {
    const pg      = layerObj._pageRef;
    const ctx     = layerObj.ctx;
    const W       = pg ? pg.pageW   : this.pageW;
    const H       = pg ? pg.pageH   : this.pageH;
    /* For the active page always use this._strokes / this._images — these stay
       up-to-date after undo, erase, move, etc. (which reassign this._strokes to a
       new filtered/mapped array without touching pg.strokes).  For non-active pages
       use pg.strokes, which is fresh from the server at loadAllPages time and is never
       mutated while that page is not active. */
    const isActivePg = pg && (pg === this._pages[this._activePageIdx]);
    const strokes = (!pg || isActivePg) ? this._strokes : pg.strokes;
    const images  = (!pg || isActivePg) ? this._images  : pg.images;

    ctx.clearRect(0, 0, W, H);
    const layerStrokes = strokes.filter(s => s.layerId === layerObj.id);
    const layerImages  = images.filter(i => i.layerId === layerObj.id);
    console.log('[NoteNeo] _renderLayer id:', layerObj.id, '| matched strokes:', layerStrokes.length, '| total strokes:', strokes.length, '| unique layerIds in strokes:', [...new Set(strokes.map(s=>s.layerId))]);

    /* Images first */
    layerImages.forEach(img => this._renderImage(ctx, img));
    /* Strokes */
    layerStrokes.forEach(s => this._renderStroke(ctx, s));
  }

  _renderAll() {
    this.layers.forEach(l => this._renderLayer(l));
  }

  /* Render templates + layers for every page in the notebook. */
  _renderAllPages() {
    this._pages.forEach(pg => {
      this._renderTemplate({
        ctx:      pg.tCtx,
        pageW:    pg.pageW,
        pageH:    pg.pageH,
        template: pg.template,
        bgColor:  pg.bgColor,
      });
      pg.layers.forEach(l => this._renderLayer(l));
    });
  }

  _renderStroke(ctx, stroke) {
    if (!stroke.points || stroke.points.length < 2) {
      if (stroke.tool === 'text' && stroke.extra) this._renderText(ctx, stroke);
      return;
    }
    if (stroke.tool === 'eraser') return; /* erasure is baked */
    if (['line','rect','circle','arrow'].includes(stroke.tool)) { this._renderShape(ctx, stroke); return; }
    if (stroke.tool === 'text') { this._renderText(ctx, stroke); return; }

    ctx.save();
    ctx.globalAlpha    = stroke.opacity ?? 1.0;
    ctx.globalCompositeOperation = stroke.blendMode || 'source-over';

    if (stroke.tool === 'highlighter') {
      ctx.globalAlpha = (stroke.opacity ?? 1.0) * 0.35;
      ctx.globalCompositeOperation = 'multiply';
    } else if (stroke.tool === 'marker') {
      ctx.globalAlpha = stroke.opacity ?? 1.0;
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.strokeStyle = stroke.color;
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    const pts = stroke.points;

    if (stroke.tool === 'highlighter') {
      ctx.lineWidth = stroke.width * 8;
      ctx.lineCap   = 'square';
      this._drawSmooth(ctx, pts, stroke.width * 8);
    } else {
      /* Pressure-responsive width */
      this._drawPressurePath(ctx, pts, stroke.width);
    }
    ctx.restore();
  }

  _drawSmooth(ctx, pts, width) {
    if (pts.length < 2) return;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  _drawPressurePath(ctx, pts, baseWidth) {
    if (pts.length < 2) return;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const pressure = curr.p != null ? curr.p : 0.5;
      const w  = Math.max(0.5, baseWidth * (0.4 + pressure * 1.2));
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      /* Smooth with next point */
      if (i < pts.length - 1) {
        const next = pts[i + 1];
        const mx = (curr.x + next.x) / 2;
        const my = (curr.y + next.y) / 2;
        ctx.quadraticCurveTo(curr.x, curr.y, mx, my);
      } else {
        ctx.lineTo(curr.x, curr.y);
      }
      ctx.stroke();
    }
  }

  _renderShape(ctx, stroke) {
    const e = stroke.extra || {};
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth   = stroke.width;
    ctx.globalAlpha = stroke.opacity ?? 1.0;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (e.fill) { ctx.fillStyle = e.fill; }

    const [x1, y1] = [stroke.points[0].x, stroke.points[0].y];
    const [x2, y2] = [stroke.points[stroke.points.length - 1].x, stroke.points[stroke.points.length - 1].y];

    ctx.beginPath();
    switch (stroke.tool) {
      case 'line':
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); break;
      case 'rect':
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
        if (e.fill) ctx.fill(); ctx.stroke(); break;
      case 'circle': {
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        if (e.fill) ctx.fill(); ctx.stroke(); break;
      }
      case 'arrow': {
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const hw   = 14 + stroke.width * 1.5;
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - hw * Math.cos(angle - 0.4), y2 - hw * Math.sin(angle - 0.4));
        ctx.lineTo(x2 - hw * Math.cos(angle + 0.4), y2 - hw * Math.sin(angle + 0.4));
        ctx.closePath(); ctx.fillStyle = stroke.color; ctx.fill(); break;
      }
    }
    ctx.restore();
  }

  _renderText(ctx, stroke) {
    const e = stroke.extra || {};
    if (!e.text) return;
    ctx.save();
    ctx.globalAlpha = stroke.opacity ?? 1.0;
    ctx.fillStyle   = stroke.color;
    ctx.font        = `${e.bold ? 'bold ' : ''}${e.italic ? 'italic ' : ''}${e.fontSize || stroke.width * 8}px ${e.font || 'Inter, sans-serif'}`;
    ctx.textBaseline = 'top';
    const x = stroke.points[0].x;
    const y = stroke.points[0].y;
    const lines = e.text.split('\n');
    const lineH = (e.fontSize || stroke.width * 8) * 1.4;
    lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineH));
    ctx.restore();
  }

  _renderImage(ctx, img) {
    if (!img._el) {
      const el = new Image();
      el.src = img.data;
      el.onload = () => {
        img._el = el;
        const l = this.layers.find(l => l.id === img.layerId);
        if (l) this._renderLayer(l);
      };
      return;
    }
    ctx.save();
    ctx.globalAlpha = 1.0;
    const cx = img.x + img.width / 2, cy = img.y + img.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((img.rotation || 0) * Math.PI / 180);
    ctx.drawImage(img._el, -img.width / 2, -img.height / 2, img.width, img.height);
    ctx.restore();
  }

  /* ═══════════════════════════════════════════════════════════
     ZOOM / PAN
     ═══════════════════════════════════════════════════════════ */
  _fitToScreen() {
    const area = this.canvasArea;
    if (!area.clientWidth || !area.clientHeight) {
      /* Layout not ready yet — retry next frame */
      requestAnimationFrame(() => this._fitToScreen());
      return;
    }
    const aw = area.clientWidth  - 40;
    const ah = area.clientHeight - 40;
    this.scale      = Math.max(0.05, Math.min(aw / this.pageW, ah / this.pageH, 1.5));
    this._fitScale  = this.scale;
    this.offsetX    = Math.round((area.clientWidth  - this.pageW * this.scale) / 2);
    /* For multi-page notebooks position the first page near the top.
       For a single page keep it vertically centred. */
    if (this._pages.length > 1) {
      this.offsetY = 20;
    } else {
      this.offsetY = Math.round((area.clientHeight - this.pageH * this.scale) / 2);
    }
    this._applyTransform();
  }

  /* Clamp offsetX/offsetY so at least MARGIN px of the page stack stays on-screen. */
  _clampOffset() {
    const area     = this.canvasArea;
    const aw       = area.clientWidth;
    const ah       = area.clientHeight;
    /* Use the pagesContainer's intrinsic size (set by loadAllPages) to know total content extent. */
    const contentW = (this.pagesContainer.offsetWidth  || this.pageW) * this.scale;
    const contentH = (this.pagesContainer.offsetHeight || this.pageH) * this.scale;
    /* How much of the content must stay visible on each side */
    const MARGIN = 120;
    /* X: right edge of content must be >= MARGIN from left edge of area,
          left edge of content must be <= aw - MARGIN from left edge of area */
    this.offsetX = Math.max(MARGIN - contentW, Math.min(aw - MARGIN, this.offsetX));
    /* Y: bottom edge of content must be >= MARGIN from top of area,
          top edge of content must be <= ah - MARGIN from top of area */
    this.offsetY = Math.max(MARGIN - contentH, Math.min(ah - MARGIN, this.offsetY));
  }

  _applyTransform() {
    this._clampOffset();
    this.viewport.style.transform = `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
    document.getElementById('zoom-display').textContent = Math.round(this.scale * 100) + '%';
    /* Reposition selection toolbar if selection is active */
    if (this._selectionBbox && this._selectToolbar?.style.display !== 'none') {
      const { bx, by, bw, bh } = this._selectionBbox;
      this._showSelectToolbar(bx, by, bw, bh);
    }
  }

  setZoom(scale, clientX, clientY) {
    const area = this.canvasArea;
    const rect = area.getBoundingClientRect();
    /* Convert screen coords → coords relative to canvas-area origin */
    const ocx = (clientX != null) ? clientX - rect.left : area.clientWidth  / 2;
    const ocy = (clientY != null) ? clientY - rect.top  : area.clientHeight / 2;
    const oldScale = this.scale;
    this.scale  = Math.max(0.05, Math.min(10, scale));
    /* Keep the point under the cursor fixed */
    this.offsetX = ocx - (ocx - this.offsetX) * this.scale / oldScale;
    this.offsetY = ocy - (ocy - this.offsetY) * this.scale / oldScale;
    this._applyTransform();
  }

  fitToScreen() { this._fitToScreen(); }

  /* UUID helper — crypto.randomUUID() is only available in Chrome ≥92 / Safari ≥15.4.
     Fall back to a Math.random-based UUID v4 on older Android WebViews. */
  _uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* Copy the buffered [NoteNeo] debug log to the system clipboard.
     Useful on mobile devices where DevTools is unavailable. */
  copyDebugLog() {
    const text = this._debugLog.length
      ? this._debugLog.join('\n')
      : '(no debug entries yet — try drawing a stroke first)';
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => alert('Debug log copied!\n\n' + this._debugLog.slice(-5).join('\n')))
        .catch(() => prompt('Copy this log:', text));
    } else {
      prompt('Copy this log:', text);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     POINTER EVENTS
     ═══════════════════════════════════════════════════════════ */
  _bindEvents() {
    /* Per-page canvas pointer events (pointerdown/move/up/leave/cancel, contextmenu,
       pen proximity tracking, dblclick) are wired in _bindPageCanvasEvents() when
       each page frame is built.  touch-action:none is also set per-page canvas.

       _bindEvents only wires the shared / global listeners:
         • document-level pointerup / pointercancel  (iPad fallback)
         • canvasArea wheel  (zoom)
         • canvasArea touch events  (pan + pinch-zoom)
         • document keydown  (keyboard shortcuts) */

    this.canvasArea.style.touchAction = 'none';

    /* Document-level fallback for pointerup/pointercancel: on some tablets (iPadOS especially)
       the canvas element may not reliably receive pointerup when using setPointerCapture.
       If we are actively drawing and receive a matching pointerup at document level, commit it. */
    document.addEventListener('pointerup', e => {
      if (!this._drawing) return;
      if (this._drawingPointerId != null && e.pointerId !== this._drawingPointerId) return;
      this._onUp(e);
    }, { passive: false });
    document.addEventListener('pointercancel', e => {
      if (!this._drawing) return;
      if (this._drawingPointerId != null && e.pointerId !== this._drawingPointerId) return;
      this._onCancel(e);
    }, { passive: false });

    /* Wheel: zoom */
    this.canvasArea.addEventListener('wheel', e => this._onWheel(e), { passive: false });

    /* Keyboard shortcuts */
    document.addEventListener('keydown', e => this._onKey(e));

    /* Context menu on the canvasArea (per-page canvases handle their own via _bindPageCanvasEvents). */
    this.canvasArea.addEventListener('contextmenu', e => e.preventDefault());

    /* ── Unified touch gesture system ─────────────────────────────
       ALL finger-based panning (1-finger) and pinch-zoom (2-finger) is handled
       here via Touch Events.  Pointer events are completely excluded from touch
       panning — they only handle pen/mouse/keyboard input.  This eliminates the
       race condition where pointerdown starts a pan before the 2nd finger arrives
       and the touchstart handler tries to reconcile the drifted state. */

    /* _tg = touch gesture state.  null when no touch gesture active. */
    let _tg = null;

    this.canvasArea.addEventListener('touchstart', e => {
      const n = e.touches.length;
      if (n === 0) return;

      /* ── Stylus / Apple Pencil / Android pen guard ──────────────
         Calling e.preventDefault() on a stylus touchstart suppresses pointer
         events for that contact — pointerdown never fires, pen cannot draw.
         • iOS Safari:     touchType === 'stylus' (available before pointerdown)
         • Chrome Android: _penPointerActive flag (set by pen pointerdown, which
           fires BEFORE touchstart on Android — opposite order to iOS) */
      if (n === 1 && (e.touches[0].touchType === 'stylus' || this._penPointerActive)) return;

      /* ── 2+ fingers: start / restart pinch-zoom ────────────── */
      if (n >= 2) {
        e.preventDefault();
        /* Mark active so pointer events back off completely */
        this._twoFingerActive = true;
        this._panning  = false;
        this._panStart = null;
        this._stopInertia();
        /* Do NOT clear _drawing/_points here.  Since _onDown now returns early for
           all touch-type pointers, _drawing=true can only be from a pen or mouse.
           Clearing it here would silently discard an in-progress pen stroke whenever
           the palm touches the screen mid-stroke.  The pen's own pointerup will
           commit the stroke normally. */

        const rect = this.canvasArea.getBoundingClientRect();
        const t0 = e.touches[0], t1 = e.touches[1];
        const mx = (t0.clientX + t1.clientX) / 2 - rect.left;
        const my = (t0.clientY + t1.clientY) / 2 - rect.top;
        _tg = {
          mode:     'pinch',
          rect,
          /* snapshot at pinch start */
          offsetX0: this.offsetX,
          offsetY0: this.offsetY,
          scale0:   this.scale,
          mx0:      mx,
          my0:      my,
          dist0:    Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
          /* inertia tracking */
          lastMx: mx, lastMy: my, lastT: Date.now(),
          velX: 0, velY: 0,
        };
        return;
      }

      /* ── 1 finger: start pan ───────────────────────────────── */
      if (n === 1) {
        /* Don't pan with finger if a stylus is nearby and a draw tool is active
           (the pen draws, the finger should do nothing or is palm-rejected). */
        const _DRAW_TOOLS = ['pen', 'highlighter', 'eraser', 'line', 'rect', 'circle', 'arrow'];
        if (this._penNearby && _DRAW_TOOLS.includes(this.tool)) return;

        /* Confirmed finger pan — take ownership of this touch to prevent scroll */
        e.preventDefault();
        this._stopInertia();
        const t = e.touches[0];
        _tg = {
          mode:  'pan',
          startX: t.clientX,
          startY: t.clientY,
          ox:     this.offsetX,
          oy:     this.offsetY,
          lastX:  t.clientX,
          lastY:  t.clientY,
          lastT:  Date.now(),
          velX: 0, velY: 0,
        };
      }
    }, { passive: false });

    this.canvasArea.addEventListener('touchmove', e => {
      if (!_tg) return;
      e.preventDefault();
      const n = e.touches.length;

      /* ── Pinch-zoom mode ───────────────────────────────────── */
      if (_tg.mode === 'pinch' && n >= 2) {
        const now = Date.now();
        const t0 = e.touches[0], t1 = e.touches[1];
        const mx1  = (t0.clientX + t1.clientX) / 2 - _tg.rect.left;
        const my1  = (t0.clientY + t1.clientY) / 2 - _tg.rect.top;
        const dist1 = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);

        /* Scale ratio relative to gesture start */
        const r = _tg.dist0 > 1 ? dist1 / _tg.dist0 : 1;
        const newScale = Math.max(0.05, Math.min(10, _tg.scale0 * r));

        /* From-scratch offset: page point under start midpoint → current midpoint */
        this.scale   = newScale;
        this.offsetX = mx1 - (_tg.mx0 - _tg.offsetX0) * r;
        this.offsetY = my1 - (_tg.my0 - _tg.offsetY0) * r;

        /* Inertia velocity */
        const dt = Math.max(1, now - _tg.lastT);
        _tg.velX  = (mx1 - _tg.lastMx) / dt;
        _tg.velY  = (my1 - _tg.lastMy) / dt;
        _tg.lastMx = mx1; _tg.lastMy = my1; _tg.lastT = now;

        this._applyTransform();
        return;
      }

      /* ── 1-finger pan mode ─────────────────────────────────── */
      if (_tg.mode === 'pan' && n >= 1) {
        const now = Date.now();
        const t = e.touches[0];
        const newX = _tg.ox + (t.clientX - _tg.startX);
        const newY = _tg.oy + (t.clientY - _tg.startY);

        const dt = Math.max(1, now - _tg.lastT);
        _tg.velX = (t.clientX - _tg.lastX) / dt;
        _tg.velY = (t.clientY - _tg.lastY) / dt;
        _tg.lastX = t.clientX;
        _tg.lastY = t.clientY;
        _tg.lastT = now;

        this.offsetX = newX;
        this.offsetY = newY;
        this._applyTransform();
      }
    }, { passive: false });

    const _touchEnd = e => {
      if (!_tg) return;
      const n = e.touches.length;

      /* If fingers remaining and was pinching, keep going (finger replaced) */
      if (n >= 2 && _tg.mode === 'pinch') return;

      /* Transition pinch → single-finger pan (one finger lifted) */
      if (n === 1 && _tg.mode === 'pinch') {
        const t = e.touches[0];
        _tg = {
          mode:   'pan',
          startX: t.clientX,
          startY: t.clientY,
          ox:     this.offsetX,
          oy:     this.offsetY,
          lastX:  t.clientX,
          lastY:  t.clientY,
          lastT:  Date.now(),
          velX: 0, velY: 0,
        };
        this._twoFingerActive = false;
        return;
      }

      /* All fingers up — end gesture, maybe inertia */
      const vel = _tg;
      _tg = null;
      this._twoFingerActive = false;
      const dt = Date.now() - vel.lastT;
      if (dt < 100 && (Math.abs(vel.velX) > 0.05 || Math.abs(vel.velY) > 0.05)) {
        this._startInertia(vel.velX, vel.velY);
      }
    };
    this.canvasArea.addEventListener('touchend',    _touchEnd, { passive: false });
    this.canvasArea.addEventListener('touchcancel', _touchEnd, { passive: false });

    /* Space key release */
    document.addEventListener('keyup', e => {
      if (e.key === ' ') {
        this._spaceDown = false;
        if (!this._panning) this.canvasArea.style.cursor = this.activeCanvas.style.cursor || 'crosshair';
      }
    });

    /* dblclick, eraser-ring clearing, and pen proximity are
       all handled per-page in _bindPageCanvasEvents — nothing needed here. */

    /* Selection toolbar buttons */
    const stb = this._selectToolbar;
    if (stb) {
      stb.querySelector('#sel-tb-copy')?.addEventListener('click', e => { e.stopPropagation(); this._copySelection(); });
      stb.querySelector('#sel-tb-duplicate')?.addEventListener('click', e => { e.stopPropagation(); this._duplicateSelection(); });
      stb.querySelector('#sel-tb-delete')?.addEventListener('click', e => { e.stopPropagation(); this._deleteSelection(); });
    }
  }

  _onDblClick(e) {
    if (this.tool !== 'select' && this.tool !== 'text') return;
    const pt = this._screenToPage(e.clientX, e.clientY);
    const textStroke = [...this._strokes].reverse().find(s => {
      if (s.tool !== 'text' || !s.extra?.text || !s.points?.length) return false;
      const sx = s.points[0].x, sy = s.points[0].y;
      const fs = s.extra.fontSize || Math.max(10, s.width * 8);
      const lines = s.extra.text.split('\n');
      const w = Math.max(...lines.map(l => l.length)) * fs * 0.65 + 20;
      const h  = lines.length * fs * 1.4 + 20;
      return pt.x >= sx - 8 && pt.x <= sx + w && pt.y >= sy - 8 && pt.y <= sy + h;
    });
    if (!textStroke) return;
    /* Remove from canvas, schedule server delete, then re-open editor with existing text */
    this._strokes = this._strokes.filter(s => s.id !== textStroke.id);
    this._scheduleDelete([textStroke.id]);
    const layer = this.layers.find(l => l.id === textStroke.layerId);
    if (layer) this._renderLayer(layer);
    this._selection = null;
    this._hideSelectToolbar();
    this.oCtx.clearRect(0, 0, this.pageW, this.pageH);
    this.color = textStroke.color;
    this.width = textStroke.width;
    /* Restore the original font size so the re-edit textarea matches */
    if (textStroke.extra?.fontSize) this.textFontSize = textStroke.extra.fontSize;
    this.setTool('text');
    this._startTextInput(textStroke.points[0].x, textStroke.points[0].y, textStroke);
  }

  _screenToPage(x, y) {
    /* Convert screen coords to page-local coords.
       For multi-page notebooks the active page frame is offset vertically
       inside canvas-viewport, so we subtract its yOffset. */
    const rect = this.canvasArea.getBoundingClientRect();
    const sx = (x - rect.left - this.offsetX) / this.scale;
    const sy = (y - rect.top  - this.offsetY) / this.scale;
    const pg = this._pages[this._activePageIdx];
    return { x: sx, y: sy - (pg?.yOffset ?? 0) };
  }

  _onDown(e) {
    e.preventDefault();
    console.log('[NoteNeo] _onDown type:', e.pointerType, 'id:', e.pointerId, 'pressure:', e.pressure, 'twoFingerActive:', this._twoFingerActive, 'penNearby:', this._penNearby, 'palmRej:', this._palmRejection, 'tool:', this.tool, 'w:', e.width?.toFixed(1), 'h:', e.height?.toFixed(1));
    /* Touch panning/zoom is handled entirely by the unified touch event system
       (touchstart/touchmove/touchend on canvasArea).  Pointer events must NEVER
       start a pan for touch input. */
    if (this._twoFingerActive) { console.log('[NoteNeo] _onDown BLOCKED: twoFingerActive'); return; }
    /* Stop any ongoing inertia scroll when a new gesture starts */
    this._stopInertia();

    /* Safety: if a previous stroke was never properly ended (missed pointerup),
       clear the stale live-preview so it doesn’t linger into the next stroke. */
    if (this._drawing) {
      console.warn('[NoteNeo] _onDown safety: previous stroke never committed! strokes in memory:', this._strokes.length, 'points lost:', this._points.length);
      this.aCtx.clearRect(0, 0, this.pageW, this.pageH);
      this._drawing = false;
      this._drawingPointerId = null;
      this._points = [];
    }
    /* Touch input: panning is handled by touch events. Only allow touch-pointer
       through for drawing when pen nearby + draw tool + no palm rejection. */
    if (e.pointerType === 'touch') {
      const _DRAW_TOOLS = ['pen', 'highlighter', 'eraser', 'line', 'rect', 'circle', 'arrow'];
      if (!this._penNearby) { console.log('[NoteNeo] _onDown BLOCKED: touch+penNearby=false'); return; }
      if (!_DRAW_TOOLS.includes(this.tool)) { console.log('[NoteNeo] _onDown BLOCKED: touch+notDrawTool'); return; }
      if (this._palmRejection) { console.log('[NoteNeo] _onDown BLOCKED: touch+palmRejection'); return; }
    }
    /* Space + drag = pan */
    if (this._spaceDown) {
      this._panning = true; this._panStart = { x: e.clientX, y: e.clientY, ox: this.offsetX, oy: this.offsetY };
      this._panVelX = 0; this._panVelY = 0; this._panLastT = Date.now();
      return;
    }

    const layer = this.layers[this.activeLayerIdx];
    if (!layer || layer.locked) return;
    if (!layer.visible) return;

    const pt = this._screenToPage(e.clientX, e.clientY);
    const pressure = (e.pressure > 0 && this.pressureEnabled) ? e.pressure : 0.5;

    this._drawing = true;
    this._drawingPointerId = e.pointerId;   /* track which pointer started this stroke */
    if (e.pointerType === 'pen') this._penPointerActive = true;
    this._points  = [{ x: pt.x, y: pt.y, p: pressure, t: Date.now() }];
    this._lastX   = pt.x; this._lastY = pt.y;

    // Start straight line detection timer for pen tool
    if (this.tool === 'pen') {
      this._lineSnapActive = false;
      clearTimeout(this._lineSnapTimer);
      this._lineSnapTimer = setTimeout(() => {
        if (this._points.length > 8 && this._isAlmostStraightLine(this._points)) {
          this._lineSnapActive = true;
          // Optionally, show a visual indicator here
        }
      }, 500); // 0.5s hold
    }

    if (this.tool === 'text') {
      this._drawing = false;
      this._startTextInput(pt.x, pt.y);
      return;
    }
    if (this.tool === 'eraser') {
      this._eraseAt(pt.x, pt.y, this.width * 5);
    }
    if (this.tool === 'select') {
      this._selectStart(pt.x, pt.y);
    }
    if (this.tool === 'lasso') {
      /* If there's already a selection, check if the user clicked inside/on it to move or resize */
      if (this._selection) {
        this._selectStart(pt.x, pt.y);
        if (this._moveStart || this._selection?._dragMode) {
          this._lassoPath = [];
          /* Leave _drawing=true so _onMove fires for move/resize, skip new lasso */
        } else {
          this._lassoPath = [pt];
        }
      } else {
        this._lassoPath = [pt];
      }
    }
    if (['line','rect','circle','arrow'].includes(this.tool)) {
      this._shapeStart = { x: pt.x, y: pt.y };
    }
    try { this.activeCanvas.setPointerCapture(e.pointerId); } catch { /* synthetic events may not support capture */ }
  }

  _onMove(e) {
    e.preventDefault();
    /* Only block TOUCH pointer-moves during an active 2-finger gesture.
       Pen/mouse strokes must continue uninterrupted even if a palm is on screen. */
    if (this._twoFingerActive && e.pointerType === 'touch') return;
    const pt = this._screenToPage(e.clientX, e.clientY);
    this.onStatusUpdate({ coords: `${Math.round(pt.x)}, ${Math.round(pt.y)}` });

    /* Hover cursor feedback for select tool */
    if (this.tool === 'select' && !this._drawing && !this._panning) {
      let cur = 'default';
      if (this._selection) {
        const allBboxes = [
          ...this._selection.strokes.map(s => s.bbox),
          ...this._selection.images.map(img => ({ x: img.x, y: img.y, w: img.width, h: img.height })),
        ];
        const bbox = this._unionBbox(allBboxes);
        if (bbox) {
          const pad = 10, HR = 14 / this.scale;
          const ex = bbox.x - pad, ey = bbox.y - pad, ew = bbox.w + pad * 2, eh = bbox.h + pad * 2;
          const corners = [
            { id: 'nw', hx: ex,      hy: ey      },
            { id: 'ne', hx: ex + ew, hy: ey      },
            { id: 'se', hx: ex + ew, hy: ey + eh },
            { id: 'sw', hx: ex,      hy: ey + eh },
          ];
          const cursMap = { nw: 'nwse-resize', ne: 'nesw-resize', se: 'nwse-resize', sw: 'nesw-resize' };
          let onHandle = false;
          for (const c of corners) {
            if (Math.hypot(pt.x - c.hx, pt.y - c.hy) < HR) { cur = cursMap[c.id]; onHandle = true; break; }
          }
          if (!onHandle && pt.x >= ex && pt.x <= ex + ew && pt.y >= ey && pt.y <= ey + eh) cur = 'move';
        }
      }
      this.activeCanvas.style.cursor = cur;
    }

    /* Pan mode */
    if (this._panning && this._panStart) {
      const now = Date.now();
      const dt = Math.max(1, now - this._panLastT);
      const newX = this._panStart.ox + (e.clientX - this._panStart.x);
      const newY = this._panStart.oy + (e.clientY - this._panStart.y);
      this._panVelX = (newX - this.offsetX) / dt;
      this._panVelY = (newY - this.offsetY) / dt;
      this._panLastT = now;
      this.offsetX = newX;
      this.offsetY = newY;
      this._applyTransform(); return;
    }
    if (!this._drawing) return;
    /* Ignore events from a different pointer (e.g. palm while pen is active) */
    if (this._drawingPointerId != null && e.pointerId !== this._drawingPointerId) return;
    if (this._palmRejection && e.pointerType === 'touch') return;

    const pressure = (e.pressure > 0 && this.pressureEnabled) ? e.pressure : 0.5;

    /* Use coalesced events for smoother lines */
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    /* Fall back to the event itself when no coalesced events (e.g. synthetic / some devices) */
    const coalesced = events.length > 0 ? events : [e];
    for (const ce of coalesced) {
      const cp = this._screenToPage(ce.clientX, ce.clientY);
      this._points.push({ x: cp.x, y: cp.y, p: (ce.pressure > 0 && this.pressureEnabled) ? ce.pressure : pressure, t: Date.now() });
    }

    // If line snap is active, replace points with endpoints
    if (this.tool === 'pen' && this._lineSnapActive && this._points.length > 2) {
      const first = this._points[0];
      const last = this._points[this._points.length - 1];
      this._points = [first, last];
    }

    this._lastX = pt.x; this._lastY = pt.y;

    /* Live preview */
    this._livePreview(pt);
  }

  _onCancel(e) {
    /* Browser cancelled the pointer (system gesture, screenshot, palm, etc.).
       Only act if we were actually drawing this pointer (or drawing state is unknown). */
    if (this._drawingPointerId != null && e && e.pointerId !== this._drawingPointerId) return;
    if (!this._drawing) return;
    console.warn('[NoteNeo] pointercancel fired - pointerId:', e?.pointerId, 'type:', e?.pointerType, 'points:', this._points.length);
    /* For drawing tools with enough points, commit the stroke rather than silently
       discarding it. On some iPads/Android tablets the browser fires pointercancel
       instead of pointerup for stylus input, which would cause every stroke to be
       lost.  Calling _onUp(null) runs the normal commit path (null = no event obj). */
    const _COMMIT_TOOLS = ['pen', 'highlighter', 'line', 'rect', 'circle', 'arrow'];
    if (_COMMIT_TOOLS.includes(this.tool) && this._points.length >= 1) {
      console.warn('[NoteNeo] committing stroke via cancel-rescue path');
      this._onUp(null);
      return;
    }
    /* For eraser/lasso/select or too-short strokes, discard cleanly */
    this._drawing          = false;
    this._drawingPointerId = null;
    this._penPointerActive = false;
    this._points           = [];
    this._panning          = false;
    this.aCtx.clearRect(0, 0, this.pageW, this.pageH);
  }
  _onUp(e) {
    console.log('[NoteNeo] _onUp type:', e?.pointerType, 'id:', e?.pointerId, 'drawing:', this._drawing, 'panning:', this._panning, 'points:', this._points.length);
    if (this._panning) {
      this._panning = false;
      /* Start inertia if the last move was recent and velocity is significant */
      const dt = Date.now() - this._panLastT;
      if (dt < 100 && (Math.abs(this._panVelX) > 0.05 || Math.abs(this._panVelY) > 0.05)) {
        this._startInertia(this._panVelX, this._panVelY);
      }
      return;
    }
    if (!this._drawing) return;
    /* Ignore lift events from a different pointer than the one that started drawing */
    if (e && this._drawingPointerId != null && e.pointerId !== this._drawingPointerId) {
      console.log('[NoteNeo] _onUp EARLY RETURN: pointerId mismatch e:', e.pointerId, 'drawing:', this._drawingPointerId);
      return;
    }
    this._drawing = false;
    this._drawingPointerId = null;
    this._penPointerActive = false;
    if (e) e.preventDefault();
    clearTimeout(this._lineSnapTimer);
    this._lineSnapActive = false;

    const layer = this.layers[this.activeLayerIdx];
    if (!layer) {
      console.warn('[NoteNeo] _onUp EARLY RETURN: no layer! layers.length:', this.layers.length, 'activeLayerIdx:', this.activeLayerIdx);
      this.aCtx.clearRect(0, 0, this.pageW, this.pageH);
      return;
    }
    console.log('[NoteNeo] _onUp layer ok:', layer.id, 'pts:', this._points.length);

    const pts = this._points;
    if (pts.length < 2) {
      console.log('[NoteNeo] _onUp EARLY RETURN: pts.length < 2 =', pts.length);
      this.aCtx.clearRect(0, 0, this.pageW, this.pageH);
      /* Single tap → place a dot for drawing tools */
      if (pts.length === 1 && ['pen', 'highlighter'].includes(this.tool)) {
        const p = pts[0];
        const dotStroke = {
          id: this._uuid(), layerId: layer.id, pageId: this.pageId,
          tool: this.tool, color: this.color, width: this.width,
          opacity: this.opacity, blendMode: 'source-over',
          points: [p, { ...p, x: p.x + 0.1, y: p.y + 0.1 }],
          bbox: { x: p.x - this.width / 2, y: p.y - this.width / 2, w: this.width, h: this.width },
          extra: null,
        };
        this._strokes.push(dotStroke);
        this._renderLayer(layer);
        this._pushUndo({ type: 'add', strokes: [dotStroke] });
        this._scheduleSave([dotStroke]);
      }
      return;
    }

    /* Commit stroke */
    if (this.tool === 'eraser') {
      console.log('[NoteNeo] _onUp EARLY RETURN: eraser');
      /* Already handled in _onMove */
      this.aCtx.clearRect(0, 0, this.pageW, this.pageH);
      return;
    }
    if (this.tool === 'lasso') {
      console.log('[NoteNeo] _onUp: lasso finish');
      if (this._moveStart || this._selection?._dragMode) {
        /* Was interacting with an existing selection — use select finish logic */
        this._finishSelect(pts);
      } else {
        this._finalizeLasso();
      }
      return;
    }
    if (this.tool === 'select') {
      this._finishSelect(pts); return;
    }

    let finalPoints = pts;
    let extra = null;

    if (['line','rect','circle','arrow'].includes(this.tool) && this._shapeStart) {
      finalPoints = [this._shapeStart, pts[pts.length - 1]];
    }

    try {
      const bbox = this._computeBbox(finalPoints);
      const stroke = {
        id: this._uuid(),
        layerId: layer.id,
        pageId: this.pageId,
        tool: this.tool,
        color: this.color,
        width: this.width,
        opacity: this.opacity,
        blendMode: this.tool === 'highlighter' ? 'multiply' : 'source-over',
        points: finalPoints,
        bbox,
        extra,
      };

      /* Bake onto layer canvas */
      console.log('[NoteNeo] committing stroke. strokes before:', this._strokes.length, '| layer:', layer.id, '| layerId:', stroke.layerId);
      this._strokes.push(stroke);
      console.log('[NoteNeo] strokes after push:', this._strokes.length);
      this._renderLayer(layer);

      /* Clear active canvas */
      this.aCtx.clearRect(0, 0, this.pageW, this.pageH);
      this.oCtx.clearRect(0, 0, this.pageW, this.pageH);

      /* Undo entry */
      this._pushUndo({ type: 'add', strokes: [stroke] });

      /* Schedule save */
      this._scheduleSave([stroke]);
    } catch (err) {
      console.warn('[NoteNeo] EXCEPTION during stroke commit:', err?.message, err?.stack);
    }
  }

  _livePreview(pt) {
    const ctx = this.aCtx;
    ctx.clearRect(0, 0, this.pageW, this.pageH);

    if (this.tool === 'eraser') {
      this._eraseAt(pt.x, pt.y, this.width * 5);
      /* Draw eraser radius ring on overlay canvas */
      const oc = this.oCtx;
      oc.clearRect(0, 0, this.pageW, this.pageH);
      oc.save();
      oc.strokeStyle = 'rgba(0,0,0,0.45)';
      oc.lineWidth   = 1.5 / this.scale;
      oc.setLineDash([3 / this.scale, 3 / this.scale]);
      oc.beginPath();
      oc.arc(pt.x, pt.y, this.width * 5, 0, Math.PI * 2);
      oc.stroke();
      oc.restore();
      return;
    }

    if (['line','rect','circle','arrow'].includes(this.tool) && this._shapeStart) {
      const fakeStroke = {
        tool: this.tool, color: this.color, width: this.width, opacity: this.opacity,
        blendMode: 'source-over', extra: {},
        points: [this._shapeStart, pt],
      };
      this._renderShape(ctx, fakeStroke);
      return;
    }

    if (this.tool === 'lasso') {
      if (this._moveStart && this._selection) {
        const dx = pt.x - this._moveStart.x;
        const dy = pt.y - this._moveStart.y;
        this._applyMoveToSelection(dx, dy, this._moveStart.origStrokes, this._moveStart.origImages);
      } else if (this._selection?._dragMode && this._selection._dragStart) {
        this._applyResizeToSelection(pt);
      } else {
        this._lassoPath.push(pt);
        this._drawLassoPreview();
      }
      return;
    }

    if (this.tool === 'select') {
      if (this._moveStart && this._selection) {
        const dx = pt.x - this._moveStart.x;
        const dy = pt.y - this._moveStart.y;
        this._applyMoveToSelection(dx, dy, this._moveStart.origStrokes, this._moveStart.origImages);
      } else if (this._selection?._dragMode && this._selection._dragStart) {
        this._applyResizeToSelection(pt);
      } else {
        /* Rubber-band rectangle */
        const p0 = this._points[0];
        if (p0) {
          const rx = Math.min(p0.x, pt.x), ry = Math.min(p0.y, pt.y);
          const rw = Math.abs(pt.x - p0.x),  rh = Math.abs(pt.y - p0.y);
          ctx.save();
          ctx.strokeStyle = '#6366f1';
          ctx.fillStyle   = 'rgba(99,102,241,0.07)';
          ctx.lineWidth   = 1.5 / this.scale;
          ctx.setLineDash([5 / this.scale, 4 / this.scale]);
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.restore();
        }
      }
      return;
    }

    /* Normal drawing preview */
    const pts = this._points;
    if (pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha  = this.tool === 'highlighter' ? this.opacity * 0.35 : this.opacity;
    ctx.globalCompositeOperation = this.tool === 'highlighter' ? 'multiply' : 'source-over';
    ctx.strokeStyle  = this.color;
    ctx.lineCap      = 'round';
    ctx.lineJoin     = 'round';

    if (this.tool === 'highlighter') {
      ctx.lineWidth = this.width * 8; ctx.lineCap = 'square';
      this._drawSmooth(ctx, pts, this.width * 8);
    } else if (this.tool === 'pen' && this._lineSnapActive && pts.length === 2) {
      // Draw a perfect line preview
      ctx.lineWidth = this.width;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
    } else {
      this._drawPressurePath(ctx, pts, this.width);
    }
    ctx.restore();
  }

  // Helper: check if points are almost a straight line
  _isAlmostStraightLine(pts) {
    if (pts.length < 2) return false;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 40) return false; // ignore very short lines
    // Compute max distance from any point to the line
    let maxDist = 0;
    for (let i = 1; i < pts.length - 1; ++i) {
      const p = pts[i];
      // Line AB: (b.y-a.y)x - (b.x-a.x)y + b.x*a.y - b.y*a.x = 0
      const dist = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
      if (dist > maxDist) maxDist = dist;
    }
    return maxDist < 8; // threshold in px
  }

  /* ═══════════════════════════════════════════════════════════
     ERASER
     ═══════════════════════════════════════════════════════════ */
  _eraseAt(x, y, radius) {
    const layer  = this.layers[this.activeLayerIdx];
    if (!layer) return;
    const before = this._strokes.filter(s => s.layerId === layer.id);
    const toDelete = [];
    this._strokes = this._strokes.filter(s => {
      if (s.layerId !== layer.id) return true;
      if (!s.points || s.points.length === 0) return true;
      const hit = s.points.some(p => Math.hypot(p.x - x, p.y - y) < radius);
      if (hit) { toDelete.push(s); return false; }
      return true;
    });
    if (toDelete.length > 0) {
      this._renderLayer(layer);
      this._pushUndo({ type: 'delete', strokes: toDelete });
      this._scheduleDelete(toDelete.map(s => s.id));
    }
  }

  /* ═══════════════════════════════════════════════════════════
     TEXT TOOL
     ═══════════════════════════════════════════════════════════ */
  _startTextInput(x, y, existingStroke = null) {
    if (this._textInput) this._commitTextInput();
    const area = this.canvasArea;
    const rect = area.getBoundingClientRect();

    const inp = document.createElement('textarea');
    const sx  = x * this.scale + this.offsetX + rect.left;
    const sy  = y * this.scale + this.offsetY + rect.top;
    const fontSize = Math.max(8, this.textFontSize * this.scale);
    inp.style.cssText = `
      position:fixed; left:${sx}px; top:${sy}px;
      min-width:120px; min-height:${fontSize * 1.6}px;
      font-size:${fontSize}px; font-family:Inter,sans-serif;
      color:${this.color}; background:transparent;
      border:2px dashed var(--primary); border-radius:4px;
      outline:none; resize:both; z-index:600; padding:4px 6px;
      line-height:1.4; white-space:pre;
    `;
    if (existingStroke?.extra?.text) inp.value = existingStroke.extra.text;
    document.body.appendChild(inp);
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    this._textInput = { el: inp, x, y };

    inp.addEventListener('keydown', e => {
      if (e.key === 'Escape') { document.body.removeChild(inp); this._textInput = null; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { this._commitTextInput(); }
    });
    inp.addEventListener('blur', () => {
      setTimeout(() => { if (this._textInput) this._commitTextInput(); }, 100);
    });
  }

  _commitTextInput() {
    if (!this._textInput) return;
    const { el, x, y } = this._textInput;
    const text = el.value.trim();
    document.body.removeChild(el);
    this._textInput = null;
    if (!text) return;

    const layer = this.layers[this.activeLayerIdx];
    const fontSize = Math.max(8, this.textFontSize);
    const lines    = text.split('\n');
    const maxLen   = Math.max(...lines.map(l => l.length));
    const textBbox = { x, y, w: Math.max(20, maxLen * fontSize * 0.62), h: lines.length * fontSize * 1.4 };
    const stroke = {
      id: this._uuid(), layerId: layer.id, pageId: this.pageId,
      tool: 'text', color: this.color, width: this.width,
      opacity: this.opacity, blendMode: 'source-over',
      points: [{ x, y, p: 1, t: Date.now() }],
      bbox: textBbox, extra: { text, fontSize, font: 'Inter, sans-serif' },
    };
    this._strokes.push(stroke);
    this._renderLayer(layer);
    this._pushUndo({ type: 'add', strokes: [stroke] });
    this._scheduleSave([stroke]);
  }

  /* ═══════════════════════════════════════════════════════════
     LASSO SELECT
     ═══════════════════════════════════════════════════════════ */
  _drawLassoPreview() {
    const ctx = this.oCtx;
    ctx.clearRect(0, 0, this.pageW, this.pageH);
    const pts = this._lassoPath;
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth   = 1.5 / this.scale;
    ctx.setLineDash([5 / this.scale, 4 / this.scale]);
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath(); ctx.stroke();
    ctx.restore();
  }

  _finalizeLasso() {
    const pts = this._lassoPath;
    this.oCtx.clearRect(0, 0, this.pageW, this.pageH);
    this.aCtx.clearRect(0, 0, this.pageW, this.pageH);
    this._lassoPath = [];
    if (pts.length < 3) return;

    /* Find strokes inside lasso */
    const insideStrokes = this._strokes.filter(s => {
      if (!s.points || s.points.length === 0) return false;
      return s.points.some(p => this._pointInPolygon(p.x, p.y, pts));
    });
    /* Find images that overlap the lasso — check center AND whether any lasso
       point falls inside the image bbox (handles large/full-page PDF images). */
    const insideImages = this._images.filter(img => {
      if (this._pointInPolygon(img.x + img.width / 2, img.y + img.height / 2, pts)) return true;
      return pts.some(p =>
        p.x >= img.x && p.x <= img.x + img.width &&
        p.y >= img.y && p.y <= img.y + img.height
      );
    });
    if (insideStrokes.length > 0 || insideImages.length > 0) {
      this._selection = { strokes: insideStrokes, images: insideImages };
      this._drawSelectOverlay();
    }
  }

  _pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  _selectStart(x, y) {
    if (this._selection) {
      const sel = this._selection;
      const allBboxes = [
        ...sel.strokes.map(s => s.bbox),
        ...sel.images.map(img => ({ x: img.x, y: img.y, w: img.width, h: img.height })),
      ];
      const bbox = this._unionBbox(allBboxes);
      if (bbox) {
        const pad = 10;
        const ex = bbox.x - pad, ey = bbox.y - pad;
        const ew = bbox.w + pad * 2, eh = bbox.h + pad * 2;
        const HR = 14 / this.scale;
        /* Check resize handles at the 4 corners */
        const corners = [
          { id: 'nw', hx: ex,      hy: ey      },
          { id: 'ne', hx: ex + ew, hy: ey      },
          { id: 'se', hx: ex + ew, hy: ey + eh },
          { id: 'sw', hx: ex,      hy: ey + eh },
        ];
        for (const c of corners) {
          if (Math.hypot(x - c.hx, y - c.hy) < HR) {
            this._selection._dragMode  = 'resize-' + c.id;
            this._selection._dragStart = {
              x, y,
              origBbox:    { ...bbox, ex, ey, ew, eh },
              origImages:  JSON.parse(JSON.stringify(sel.images.map(({ _el, ...img }) => img))),
              origStrokes: JSON.parse(JSON.stringify(sel.strokes)),
            };
            return;
          }
        }
        /* Click inside bbox → start move */
        if (x >= ex && x <= ex + ew && y >= ey && y <= ey + eh) {
          this._moveStart = {
            x, y,
            origStrokes: JSON.parse(JSON.stringify(sel.strokes)),
            origImages:  JSON.parse(JSON.stringify(sel.images)),
          };
          return;
        }
      }
    }
    /* Auto-select: single click on image or stroke — no rubber-band needed */
    const hitImage = [...this._images].reverse().find(img =>
      x >= img.x && x <= img.x + img.width && y >= img.y && y <= img.y + img.height
    );
    if (hitImage) {
      this._selection = { strokes: [], images: [hitImage] };
      this._moveStart = { x, y, origStrokes: [], origImages: [{ ...hitImage }] };
      this._drawSelectOverlay();
      return;
    }
    const hitStroke = [...this._strokes].reverse().find(s =>
      s.bbox && x >= s.bbox.x && x <= s.bbox.x + s.bbox.w &&
      y >= s.bbox.y && y <= s.bbox.y + s.bbox.h
    );
    if (hitStroke) {
      this._selection = { strokes: [hitStroke], images: [] };
      this._moveStart = {
        x, y,
        origStrokes: JSON.parse(JSON.stringify([hitStroke])),
        origImages:  [],
      };
      this._drawSelectOverlay();
      return;
    }
    this._selection = null;
    this._hideSelectToolbar();
    this.oCtx.clearRect(0, 0, this.pageW, this.pageH);
  }

  _finishSelect(pts) {
    this.aCtx.clearRect(0, 0, this.pageW, this.pageH);

    /* Finish resize */
    if (this._selection?._dragMode) {
      delete this._selection._dragMode;
      delete this._selection._dragStart;
      this._selection.images.forEach(img => this._saveImagePosition(img));
      this._scheduleSave(this._selection.strokes);
      return;
    }

    /* Finish move */
    if (this._moveStart) {
      const lastPt = pts[pts.length - 1];
      const dx = lastPt.x - this._moveStart.x;
      const dy = lastPt.y - this._moveStart.y;
      /* Minimal movement = deselect click */
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
        this._moveStart = null;
        return;
      }
      /* Positions already applied live — just save */
      this._selection.images.forEach(img => this._saveImagePosition(img));
      this._scheduleSave(this._selection.strokes);
      this._moveStart = null;
      this._drawSelectOverlay();
      return;
    }

    /* Rubber-band select: find strokes + images in rect */
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const rx = Math.min(...xs), ry = Math.min(...ys);
    const rw = Math.max(...xs) - rx, rh = Math.max(...ys) - ry;
    if (rw < 4 && rh < 4) { this._selection = null; this._hideSelectToolbar(); return; }
    const insideStrokes = this._strokes.filter(s => {
      if (!s.bbox) return false;
      return s.bbox.x >= rx && s.bbox.y >= ry && s.bbox.x + s.bbox.w <= rx + rw && s.bbox.y + s.bbox.h <= ry + rh;
    });
    const insideImages = this._images.filter(img =>
      img.x >= rx && img.y >= ry && img.x + img.width <= rx + rw && img.y + img.height <= ry + rh
    );
    if (insideStrokes.length > 0 || insideImages.length > 0) {
      this._selection = { strokes: insideStrokes, images: insideImages };
      this._drawSelectOverlay();
    } else {
      this._selection = null;
      this._hideSelectToolbar();
    }
  }

  _drawSelectOverlay() {
    if (!this._selection) return;
    const ctx = this.oCtx;
    ctx.clearRect(0, 0, this.pageW, this.pageH);
    const allBboxes = [
      ...this._selection.strokes.map(s => s.bbox),
      ...this._selection.images.map(img => ({ x: img.x, y: img.y, w: img.width, h: img.height })),
    ];
    const bbox = this._unionBbox(allBboxes);
    if (!bbox) return;

    const pad = 10;
    const bx = bbox.x - pad, by = bbox.y - pad;
    const bw = bbox.w + pad * 2, bh = bbox.h + pad * 2;
    /* Store bbox for toolbar repositioning during pan/zoom */
    this._selectionBbox = { bx, by, bw, bh };
    const lw = 1.5 / this.scale;
    const hr = 6  / this.scale;   /* handle circle radius */

    ctx.save();

    /* Selection box — solid indigo border, very light fill */
    ctx.strokeStyle = '#6366f1';
    ctx.fillStyle   = 'rgba(99,102,241,0.05)';
    ctx.lineWidth   = lw;
    ctx.setLineDash([6 / this.scale, 3 / this.scale]);
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    /* Corner handles (resize) — white circle with indigo border + subtle shadow */
    const corners = [
      [bx,      by      ],
      [bx + bw, by      ],
      [bx + bw, by + bh ],
      [bx,      by + bh ],
    ];
    corners.forEach(([cx, cy]) => {
      ctx.save();
      ctx.shadowColor   = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur    = 4 / this.scale;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1 / this.scale;
      ctx.beginPath();
      ctx.arc(cx, cy, hr, 0, Math.PI * 2);
      ctx.fillStyle   = '#ffffff';
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth   = lw * 1.5;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });

    /* Edge midpoint handles (smaller, indicate axis-constrained resize) */
    const midpoints = [
      [bx + bw / 2, by         ],
      [bx + bw,     by + bh / 2],
      [bx + bw / 2, by + bh    ],
      [bx,          by + bh / 2],
    ];
    const mr = hr * 0.7;
    midpoints.forEach(([cx, cy]) => {
      ctx.beginPath();
      ctx.arc(cx, cy, mr, 0, Math.PI * 2);
      ctx.fillStyle   = '#6366f1';
      ctx.fill();
    });

    ctx.restore();

    /* Show floating selection toolbar above the selection */
    this._showSelectToolbar(bx, by, bw, bh);
  }

  _showSelectToolbar(bx, by, bw, bh) {
    const tb = this._selectToolbar;
    if (!tb) return;
    const area = this.canvasArea;
    /* Convert canvas coordinates to canvas-area CSS coordinates */
    const screenX = bx * this.scale + this.offsetX;
    const screenY = by * this.scale + this.offsetY;
    const screenW = bw * this.scale;
    const screenH = bh * this.scale;
    const tbH = tb.offsetHeight || 40;
    const tbW = tb.offsetWidth  || 180;
    const GAP = 8;
    let top = screenY - tbH - GAP;
    /* If toolbar would go above the visible area, show it below selection instead */
    if (top < 4) top = screenY + screenH + GAP;
    /* Clamp to area bounds */
    top = Math.max(4, Math.min(top, area.clientHeight - tbH - 4));
    /* Center the toolbar horizontally over the selection */
    let left = screenX + screenW / 2 - tbW / 2;
    left = Math.max(4, Math.min(left, area.clientWidth - tbW - 4));
    tb.style.top  = top  + 'px';
    tb.style.left = left + 'px';
    tb.style.display = 'flex';
  }

  _hideSelectToolbar() {
    if (this._selectToolbar) this._selectToolbar.style.display = 'none';
    this._selectionBbox = null;
  }

  _moveSelection(dx, dy) {
    if (!this._selection) return;
    const ids    = new Set(this._selection.strokes.map(s => s.id));
    const imgIds = new Set(this._selection.images.map(i => i.id));
    this._strokes = this._strokes.map(s => {
      if (!ids.has(s.id)) return s;
      return { ...s,
        points: s.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
        bbox:   s.bbox ? { x: s.bbox.x + dx, y: s.bbox.y + dy, w: s.bbox.w, h: s.bbox.h } : null,
      };
    });
    this._images = this._images.map(img => {
      if (!imgIds.has(img.id)) return img;
      return { ...img, x: img.x + dx, y: img.y + dy };
    });
    this._selection.strokes = this._selection.strokes.map(s => ({
      ...s,
      points: s.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
      bbox:   s.bbox ? { x: s.bbox.x + dx, y: s.bbox.y + dy, w: s.bbox.w, h: s.bbox.h } : null,
    }));
    this._selection.images = this._selection.images.map(img => ({ ...img, x: img.x + dx, y: img.y + dy }));
    this._renderAll();
    this._drawSelectOverlay();
    this._scheduleSave(this._selection.strokes);
    this._selection.images.forEach(img => this._saveImagePosition(img));
  }

  _unionBbox(bboxes) {
    const valid = bboxes.filter(Boolean);
    if (valid.length === 0) return null;
    const x = Math.min(...valid.map(b => b.x));
    const y = Math.min(...valid.map(b => b.y));
    const x2 = Math.max(...valid.map(b => b.x + b.w));
    const y2 = Math.max(...valid.map(b => b.y + b.h));
    return { x, y, w: x2 - x, h: y2 - y };
  }

  /* Apply movement from original snapshots (used for live-preview drag) */
  _applyMoveToSelection(dx, dy, origStrokes, origImages) {
    if (!this._selection) return;
    const strokeIds = new Set(this._selection.strokes.map(s => s.id));
    const imageIds  = new Set(this._selection.images.map(i => i.id));
    const movedStrokes = origStrokes.map(s => ({
      ...s,
      points: s.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
      bbox:   s.bbox ? { x: s.bbox.x + dx, y: s.bbox.y + dy, w: s.bbox.w, h: s.bbox.h } : null,
    }));
    /* Preserve _el (HTMLImageElement) — lost by JSON clone in origImages */
    const actualImgMap = new Map(this._images.map(i => [i.id, i]));
    const movedImages = origImages.map(img => ({ ...img, _el: actualImgMap.get(img.id)?._el, x: img.x + dx, y: img.y + dy }));
    this._strokes = this._strokes.map(s   => strokeIds.has(s.id)   ? (movedStrokes.find(ms => ms.id === s.id) ?? s)   : s);
    this._images  = this._images.map(img  => imageIds.has(img.id)  ? (movedImages.find(mi => mi.id === img.id) ?? img) : img);
    this._selection.strokes = movedStrokes;
    this._selection.images  = movedImages;
    this._renderAll();
    this._drawSelectOverlay();
  }

  /* Live resize of selected images by corner-handle drag */
  _applyResizeToSelection(pt) {
    if (!this._selection?._dragMode || !this._selection._dragStart) return;
    const { origBbox, origImages } = this._selection._dragStart;
    const mode = this._selection._dragMode;
    const { ex, ey, ew, eh } = origBbox;
    let scaleX = 1, scaleY = 1, originX = ex, originY = ey;
    if (mode === 'resize-se') {
      scaleX = Math.max(0.05, (pt.x - ex) / ew);
      scaleY = Math.max(0.05, (pt.y - ey) / eh);
    } else if (mode === 'resize-nw') {
      const nw = Math.max(20, ew + (ex - pt.x)), nh = Math.max(20, eh + (ey - pt.y));
      scaleX = nw / ew; scaleY = nh / eh;
      originX = ex + ew; originY = ey + eh;
    } else if (mode === 'resize-ne') {
      scaleX = Math.max(0.05, (pt.x - ex) / ew);
      const nh = Math.max(20, eh + (ey - pt.y)); scaleY = nh / eh;
      originY = ey + eh;
    } else if (mode === 'resize-sw') {
      const nw = Math.max(20, ew + (ex - pt.x)); scaleX = nw / ew;
      scaleY = Math.max(0.05, (pt.y - ey) / eh);
      originX = ex + ew;
    }
    const imageIds = new Set(this._selection.images.map(i => i.id));
    const actualImgMap = new Map(this._images.map(i => [i.id, i]));
    const scaledImages = origImages.map(img => ({
      ...img,
      _el:    actualImgMap.get(img.id)?._el,
      x:      originX + (img.x - originX) * scaleX,
      y:      originY + (img.y - originY) * scaleY,
      width:  Math.max(10, img.width  * scaleX),
      height: Math.max(10, img.height * scaleY),
    }));
    this._images = this._images.map(img => imageIds.has(img.id) ? (scaledImages.find(si => si.id === img.id) ?? img) : img);
    this._selection.images = scaledImages;
    /* Scale stroke point positions too */
    const origStrokes = this._selection._dragStart?.origStrokes;
    if (origStrokes?.length) {
      const strokeIds = new Set(this._selection.strokes.map(s => s.id));
      const scaledStrokes = origStrokes.map(s => ({
        ...s,
        points: s.points.map(p => ({
          ...p,
          x: originX + (p.x - originX) * scaleX,
          y: originY + (p.y - originY) * scaleY,
        })),
        bbox: s.bbox ? {
          x: originX + (s.bbox.x - originX) * scaleX,
          y: originY + (s.bbox.y - originY) * scaleY,
          w: Math.max(1, s.bbox.w * scaleX),
          h: Math.max(1, s.bbox.h * scaleY),
        } : null,
      }));
      this._strokes = this._strokes.map(s => strokeIds.has(s.id) ? (scaledStrokes.find(ss => ss.id === s.id) ?? s) : s);
      this._selection.strokes = scaledStrokes;
    }
    this._renderAll();
    this._drawSelectOverlay();
  }

  /* Persist image position/size to server */
  async _saveImagePosition(img) {
    try {
      await fetch(`/api/strokes/images/${img.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: img.x, y: img.y, width: img.width, height: img.height }),
      });
    } catch {}
  }

  /* ═══════════════════════════════════════════════════════════
     UNDO / REDO
     ═══════════════════════════════════════════════════════════ */
  _pushUndo(entry) {
    this._undoStack.push(entry);
    if (this._undoStack.length > this._MAX_UNDO) this._undoStack.shift();
    this._redoStack = [];
    this.onUndoRedoUpdate(true, false);
  }

  undo() {
    if (this._undoStack.length === 0) return;
    const entry = this._undoStack.pop();
    this._applyInverse(entry, this._redoStack);
    this.onUndoRedoUpdate(this._undoStack.length > 0, true);
  }

  redo() {
    if (this._redoStack.length === 0) return;
    const entry = this._redoStack.pop();
    this._applyInverse(entry, this._undoStack);
    this.onUndoRedoUpdate(true, this._redoStack.length > 0);
  }

  _applyInverse(entry, otherStack) {
    if (entry.type === 'add') {
      const ids = new Set(entry.strokes.map(s => s.id));
      this._strokes = this._strokes.filter(s => !ids.has(s.id));
      this._scheduleDelete(entry.strokes.map(s => s.id));
      otherStack.push({ type: 'delete', strokes: entry.strokes });
    } else if (entry.type === 'delete') {
      this._strokes.push(...entry.strokes);
      this._scheduleSave(entry.strokes);
      otherStack.push({ type: 'add', strokes: entry.strokes });
    }
    this._renderAll();
  }

  /* ═══════════════════════════════════════════════════════════
     WHEEL (ZOOM)
     ═══════════════════════════════════════════════════════════ */
  _onWheel(e) {
    e.preventDefault();
    this._stopInertia();
    if (e.ctrlKey || e.metaKey) {
      /* Trackpad pinch or Ctrl+scroll — proportional, smooth zoom */
      const factor = Math.pow(1.002, -e.deltaY);
      this.setZoom(this.scale * factor, e.clientX, e.clientY);
    } else {
      /* Two-finger pan / scroll wheel pan */
      const speed = e.deltaMode === 1 ? 20 : 1; /* line mode vs pixel mode */
      this.offsetX -= e.deltaX * speed;
      this.offsetY -= e.deltaY * speed;
      this._applyTransform();
    }
  }

  /* ═══════════════════════════════════════════════════════════
     PAN INERTIA
     ═══════════════════════════════════════════════════════════ */
  _startInertia(vx, vy) {
    this._stopInertia();
    /* Convert velocity from px/ms to px/frame (assumes ~60 fps → 16.67 ms/frame) */
    const MS_PER_FRAME = 16;
    let velX = vx * MS_PER_FRAME;
    let velY = vy * MS_PER_FRAME;
    const FRICTION = 0.96;
    const MIN_VEL  = 0.08;
    const step = () => {
      velX *= FRICTION;
      velY *= FRICTION;
      if (Math.abs(velX) < MIN_VEL && Math.abs(velY) < MIN_VEL) {
        this._panRafId = null;
        return;
      }
      this.offsetX += velX;
      this.offsetY += velY;
      this._applyTransform();
      this._panRafId = requestAnimationFrame(step);
    };
    this._panRafId = requestAnimationFrame(step);
  }

  _stopInertia() {
    if (this._panRafId != null) {
      cancelAnimationFrame(this._panRafId);
      this._panRafId = null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     KEYBOARD SHORTCUTS
     ═══════════════════════════════════════════════════════════ */
  _onKey(e) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
    if ((e.metaKey || e.ctrlKey) && (e.shiftKey && e.key === 'z' || e.key === 'y')) { e.preventDefault(); this.redo(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); this._selectAll(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (this._selection) this._deleteSelection(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') { this._copySelection(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') { this._pasteSelection(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'd') { e.preventDefault(); this._duplicateSelection(); }
    if (e.key === ' ') { e.preventDefault(); this._spaceDown = true; this.canvasArea.style.cursor = 'grab'; }

    /* Tool shortcuts */
    const toolMap = { p: 'pen', h: 'highlighter', e: 'eraser', t: 'text', l: 'lasso' };
    if (!e.metaKey && !e.ctrlKey && toolMap[e.key]) { this.setTool(toolMap[e.key]); }
  }

  _selectAll() {
    this._selection = { strokes: [...this._strokes], images: [...this._images] };
    this._drawSelectOverlay();
  }

  _deleteSelection() {
    if (!this._selection) return;
    const ids = new Set(this._selection.strokes.map(s => s.id));
    this._pushUndo({ type: 'delete', strokes: this._selection.strokes });
    this._strokes = this._strokes.filter(s => !ids.has(s.id));
    this._scheduleDelete([...ids]);
    /* Delete selected images */
    if (this._selection.images.length > 0) {
      const imgIds = new Set(this._selection.images.map(i => i.id));
      this._images = this._images.filter(i => !imgIds.has(i.id));
      this._selection.images.forEach(img => {
        fetch(`/api/strokes/images/${img.id}`, { method: 'DELETE' }).catch(() => {});
      });
    }
    this._selection = null;
    this._hideSelectToolbar();
    this.oCtx.clearRect(0, 0, this.pageW, this.pageH);
    this._renderAll();
  }

  _copySelection() {
    if (!this._selection) return;
    this._copyBuffer = {
      strokes: JSON.parse(JSON.stringify(this._selection.strokes)),
      images:  JSON.parse(JSON.stringify(this._selection.images.map(i => ({ ...i, _el: undefined })))),
    };
  }

  _pasteSelection() {
    if (!this._copyBuffer) return;
    const layer  = this.layers[this.activeLayerIdx];
    /* Support both old array format and new {strokes, images} format */
    const buf    = Array.isArray(this._copyBuffer)
      ? { strokes: this._copyBuffer, images: [] }
      : this._copyBuffer;
    const newStrokes = buf.strokes.map(s => ({
      ...s, id: this._uuid(), layerId: layer.id,
      points: s.points.map(p => ({ ...p, x: p.x + 14, y: p.y + 14 })),
      bbox: s.bbox ? { ...s.bbox, x: s.bbox.x + 14, y: s.bbox.y + 14 } : null,
    }));
    const newImages = buf.images.map(img => ({
      ...img, id: this._uuid(), layerId: layer.id, _el: null,
      x: img.x + 14, y: img.y + 14,
    }));
    this._strokes.push(...newStrokes);
    newImages.forEach(img => {
      this._images.push(img);
      fetch('/api/strokes/images', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: this.pageId, layerId: img.layerId, id: img.id, data: img.data, x: img.x, y: img.y, width: img.width, height: img.height, rotation: img.rotation || 0 }),
      }).catch(() => {});
    });
    this._renderLayer(layer);
    this._pushUndo({ type: 'add', strokes: newStrokes });
    this._scheduleSave(newStrokes);
    this._copyBuffer = { strokes: newStrokes, images: newImages };
  }

  _duplicateSelection() {
    this._copySelection();
    this._pasteSelection();
  }

  /* ═══════════════════════════════════════════════════════════
     TOOL / COLOR / WIDTH SETTERS
     ═══════════════════════════════════════════════════════════ */
  setTool(tool) {
    const prev = this.tool;
    this.tool = tool;
    this._drawing = false;
    this.aCtx.clearRect(0, 0, this.pageW, this.pageH);
    /* Always clear overlay (eraser ring, rubber-band, etc.) */
    this.oCtx.clearRect(0, 0, this.pageW, this.pageH);
    if (tool !== 'select' && tool !== 'lasso') {
      this._selection = null;
      this._hideSelectToolbar();
    }
    /* Re-draw selection overlay if switching to select/lasso while selection exists */
    if ((tool === 'select' || tool === 'lasso') && this._selection) {
      this._drawSelectOverlay();
    }
    const cursors = {
      pen: 'crosshair',
      highlighter: 'crosshair', eraser: 'cell', text: 'text',
      select: 'default', lasso: 'crosshair',
      line: 'crosshair', rect: 'crosshair', circle: 'crosshair', arrow: 'crosshair',
    };
    this.activeCanvas.style.cursor = cursors[tool] || 'crosshair';
  }

  setColor(color) { this.color = color; }
  setWidth(w) { this.width = w; }
  setOpacity(o) { this.opacity = o; }
  setTextFontSize(sz) { this.textFontSize = Math.max(8, sz); }
  setPalmRejection(v) { this._palmRejection = v; }
  setPressureEnabled(v) { this.pressureEnabled = v; }
  setAutoSaveInterval(ms) { this._autoSaveInterval = ms; }

  /* ═══════════════════════════════════════════════════════════
     LAYERS
     ═══════════════════════════════════════════════════════════ */
  setActiveLayer(idx) {
    this.activeLayerIdx = Math.max(0, Math.min(idx, this.layers.length - 1));
    this.onLayersChange(this.layers, this.activeLayerIdx);
  }

  updateLayerProp(idx, prop, val) {
    if (!this.layers[idx]) return;
    this.layers[idx][prop] = val;
    if (prop === 'visible' || prop === 'opacity') {
      this.layers[idx].canvas.style.opacity = this.layers[idx].visible ? this.layers[idx].opacity : 0;
    }
    if (prop === 'locked') {
      this.layers[idx].canvas.style.pointerEvents = val ? 'none' : 'auto';
    }
    this.onLayersChange(this.layers, this.activeLayerIdx);
  }

  async addLayer(name) {
    /* Create via API */
    const r = await fetch(`/api/pages/${this.pageId}/layers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || `Layer ${this.layers.length + 1}` }),
    });
    const ld = await r.json();
    const canvas = document.createElement('canvas');
    canvas.width = this.pageW; canvas.height = this.pageH;
    canvas.style.cssText = `position:absolute;top:0;left:0;width:${this.pageW}px;height:${this.pageH}px;`;
    canvas.dataset.layerId = ld.id;
    this.container.insertBefore(canvas, this.activeCanvas);
    const pg = this._pages[this._activePageIdx];
    this.layers.push({
      id: ld.id, name: ld.name, visible: true, locked: false, opacity: 1.0, sortOrder: ld.sort_order,
      canvas, ctx: canvas.getContext('2d'),
      _pageRef: pg,   /* needed by _renderLayer to find page strokes/dims */
    });
    this.activeLayerIdx = this.layers.length - 1;
    this.onLayersChange(this.layers, this.activeLayerIdx);
  }

  async deleteLayer(idx) {
    if (this.layers.length <= 1) return;
    const l = this.layers[idx];
    await fetch(`/api/pages/${this.pageId}/layers/${l.id}`, { method: 'DELETE' });
    if (l.canvas.parentNode) l.canvas.parentNode.removeChild(l.canvas);
    const filtered = this._strokes.filter(s => s.layerId !== l.id);
    /* Update both the instance ref AND the page record so _renderAllPages stays in sync */
    this._strokes = filtered;
    const pg = this._pages[this._activePageIdx];
    if (pg) pg.strokes = filtered;
    this.layers.splice(idx, 1);
    this.activeLayerIdx = Math.min(this.activeLayerIdx, this.layers.length - 1);
    this.onLayersChange(this.layers, this.activeLayerIdx);
  }

  /* ═══════════════════════════════════════════════════════════
     IMAGE INSERT
     ═══════════════════════════════════════════════════════════ */
  async insertImage(dataUrl) {
    const layer = this.layers[this.activeLayerIdx];
    const img = {
      id: this._uuid(),
      layerId: layer.id,
      data: dataUrl,
      x: (this.pageW - 300) / 2,
      y: (this.pageH - 300) / 2,
      width: 300, height: 300, rotation: 0,
    };
    this._images.push(img);
    this._renderLayer(layer);

    /* Save to server */
    try {
      const r = await fetch('/api/strokes/images', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: this.pageId, layerId: layer.id, ...img }),
      });
      const d = await r.json();
      img.id = d.id;
    } catch {}
  }

  /* ═══════════════════════════════════════════════════════════
     EXPORT
     ═══════════════════════════════════════════════════════════ */
  exportPNG() {
    const merged = document.createElement('canvas');
    merged.width  = this.pageW;
    merged.height = this.pageH;
    const ctx = merged.getContext('2d');

    /* Background */
    ctx.fillStyle = this.bgColor && this.bgColor !== 'default' ? this.bgColor : (document.documentElement.dataset.theme === 'dark' ? '#1a1a2e' : '#ffffff');
    ctx.fillRect(0, 0, this.pageW, this.pageH);

    /* Template */
    ctx.drawImage(this.templateCanvas, 0, 0);

    /* Layers (bottom to top) */
    this.layers.forEach(l => {
      if (!l.visible) return;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, 0, 0);
    });
    ctx.globalAlpha = 1;

    const url = merged.toDataURL('image/png', 1.0);
    const a   = document.createElement('a');
    a.href = url; a.download = `page-${Date.now()}.png`;
    a.click();

    /* Also save thumbnail */
    const th = document.createElement('canvas');
    th.width = 350; th.height = Math.round(350 * this.pageH / this.pageW);
    th.getContext('2d').drawImage(merged, 0, 0, th.width, th.height);
    return th.toDataURL('image/jpeg', 0.7);
  }

  exportPDF(fileName) {
    fileName = fileName || `page-${Date.now()}`;

    /* Merge all layers */
    const merged = document.createElement('canvas');
    merged.width  = this.pageW;
    merged.height = this.pageH;
    const ctx = merged.getContext('2d');
    ctx.fillStyle = this.bgColor && this.bgColor !== 'default'
      ? this.bgColor
      : (document.documentElement.dataset.theme === 'dark' ? '#1a1a2e' : '#ffffff');
    ctx.fillRect(0, 0, this.pageW, this.pageH);
    ctx.drawImage(this.templateCanvas, 0, 0);
    this.layers.forEach(l => {
      if (!l.visible) return;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, 0, 0);
    });
    ctx.globalAlpha = 1;

    /* Rasterise to JPEG */
    const jpegDataUrl = merged.toDataURL('image/jpeg', 0.92);
    const b64 = jpegDataUrl.slice('data:image/jpeg;base64,'.length);
    const imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    const W = this.pageW, H = this.pageH;
    const te = s => new TextEncoder().encode(s);
    const concat = arrs => {
      const total = arrs.reduce((s, a) => s + a.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const a of arrs) { out.set(a, off); off += a.length; }
      return out;
    };

    /* PDF object bytes */
    const header = te('%PDF-1.4\n');
    const o1 = te('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
    const o2 = te('2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n');
    const o3 = te(`3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${W} ${H}]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>\nendobj\n`);
    const cstream = te(`q ${W} 0 0 ${H} 0 0 cm /Im Do Q`);
    const o4 = concat([
      te(`4 0 obj\n<</Length ${cstream.length}>>\nstream\n`),
      cstream,
      te('\nendstream\nendobj\n'),
    ]);
    const o5 = concat([
      te(`5 0 obj\n<</Type/XObject/Subtype/Image/Width ${W}/Height ${H}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${imgBytes.length}>>\nstream\n`),
      imgBytes,
      te('\nendstream\nendobj\n'),
    ]);

    /* Byte offsets for xref */
    const offs = [];
    let pos = header.length;
    for (const chunk of [o1, o2, o3, o4, o5]) {
      offs.push(pos);
      pos += chunk.length;
    }

    /* Cross-reference table (each entry exactly 20 bytes incl \r\n) */
    const xrefPos = pos;
    let xrefStr = 'xref\n0 6\n';
    xrefStr += '0000000000 65535 f\r\n';
    for (const o of offs) {
      xrefStr += String(o).padStart(10, '0') + ' 00000 n\r\n';
    }
    const trailer = te(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`);

    const pdf = concat([header, o1, o2, o3, o4, o5, te(xrefStr), trailer]);
    const blob = new Blob([pdf], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = fileName + '.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  async saveThumbnail() {
    const merged = document.createElement('canvas');
    merged.width = 350; merged.height = Math.round(350 * this.pageH / this.pageW);
    const ctx = merged.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, merged.width, merged.height);
    ctx.drawImage(this.templateCanvas, 0, 0, merged.width, merged.height);
    this.layers.forEach(l => {
      if (!l.visible) return;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, 0, 0, merged.width, merged.height);
    });
    ctx.globalAlpha = 1;
    const thumb = merged.toDataURL('image/jpeg', 0.5);
    await fetch(`/api/pages/${this.pageId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thumbnail: thumb }),
    });
    return thumb;
  }

  /* ═══════════════════════════════════════════════════════════
     AUTO-SAVE
     ═══════════════════════════════════════════════════════════ */
  _scheduleSave(strokes) {
    this._savePending.push(...strokes);
    clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(() => this._flushSave(), this._autoSaveInterval);
    this.onStatusUpdate({ save: 'Unsaved…' });
  }

  _scheduleDelete(ids) {
    this._deletePending.push(...ids);
    clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(() => this._flushSave(), this._autoSaveInterval);
  }

  async _flushSave() {
    if (!this.pageId) return;
    const layer = this.layers[this.activeLayerIdx];
    if (!layer) return;

    const toSave   = this._savePending.splice(0);
    const toDelete = this._deletePending.splice(0);

    try {
      if (toDelete.length > 0) {
        await fetch('/api/strokes', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: toDelete, pageId: this.pageId }),
        });
      }
      if (toSave.length > 0) {
        /* Deduplicate (keep last instance), then group by layerId */
        const deduped = [...new Map(toSave.map(s => [s.id, s])).values()];
        const groups  = new Map();
        for (const s of deduped) {
          const lid = s.layerId || layer.id;
          if (!groups.has(lid)) groups.set(lid, []);
          groups.get(lid).push(s);
        }
        for (const [lId, group] of groups) {
          await fetch('/api/strokes/batch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pageId: this.pageId, layerId: lId,
              strokes: group.map(s => ({
                id: s.id, tool: s.tool, color: s.color, width: s.width,
                opacity: s.opacity, blendMode: s.blendMode,
                points: s.points, bbox: s.bbox, extra: s.extra,
              })),
            }),
          });
        }
      }
      this.onStatusUpdate({ save: 'Saved' });
      /* Save thumbnail periodically */
      this.saveThumbnail().catch(() => {});
    } catch {
      this.onStatusUpdate({ save: 'Save failed' });
      /* Re-queue */
      this._savePending.push(...toSave);
      this._deletePending.push(...toDelete);
    }
    this.onSave();
  }

  /* Force immediate save */
  async forceSave() {
    clearTimeout(this._autoSaveTimer);
    await this._flushSave();
  }

  /* ═══════════════════════════════════════════════════════════
     CLEAR PAGE
     ═══════════════════════════════════════════════════════════ */
  async clearPage() {
    const layer = this.layers[this.activeLayerIdx];
    if (!layer) return;
    const deleted = this._strokes.filter(s => s.layerId === layer.id);
    this._strokes   = this._strokes.filter(s => s.layerId !== layer.id);
    this._renderLayer(layer);
    this._pushUndo({ type: 'delete', strokes: deleted });
    await fetch(`/api/strokes/page/${this.pageId}?layerId=${layer.id}`, { method: 'DELETE' });
  }

  /* ═══════════════════════════════════════════════════════════
     COMPUTE BBOX
     ═══════════════════════════════════════════════════════════ */
  _computeBbox(pts) {
    if (!pts || pts.length === 0) return null;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    const w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    return { x, y, w, h };
  }

  /* ═══════════════════════════════════════════════════════════
     SPACE KEY pan and release
     ═══════════════════════════════════════════════════════════ */
  _spaceDown = false;
  _panning   = false;
  _panStart  = null;
}

export default CanvasEngine;
