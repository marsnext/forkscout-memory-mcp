function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderVisualizerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Forkscout Memory Visualizer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07101f;
      --panel: rgba(13,22,40,0.95);
      --panel-2: rgba(18,31,54,0.80);
      --text: #ebf2ff;
      --muted: #8da4c4;
      --accent: #5eead4;
      --accent-2: #60a5fa;
      --danger: #f87171;
      --warning: #fbbf24;
      --success: #4ade80;
      --border: rgba(255,255,255,0.07);
      --border-hover: rgba(255,255,255,0.14);
      --radius: 14px;
      --shadow: 0 8px 32px rgba(0,0,0,0.32);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      background-image:
        radial-gradient(ellipse 80% 50% at 50% -10%, rgba(96,165,250,0.10) 0%, transparent 70%),
        radial-gradient(ellipse 60% 40% at 80% 90%, rgba(94,234,212,0.07) 0%, transparent 70%);
      background-attachment: fixed;
      color: var(--text);
      min-height: 100dvh;
      font-size: 14px;
      line-height: 1.5;
    }
    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.10); border-radius: 99px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
    /* ── Layout ── */
    .app { max-width: 1680px; margin: 0 auto; padding: 20px 24px; }
    /* ── Topbar ── */
    .topbar {
      display: flex; justify-content: space-between; align-items: center;
      gap: 14px; margin-bottom: 20px; flex-wrap: wrap;
    }
    .title { display: flex; align-items: center; gap: 14px; }
    .title-logo {
      width: 40px; height: 40px; border-radius: 12px; flex-shrink: 0;
      background: linear-gradient(135deg, var(--accent-2), var(--accent));
      display: flex; align-items: center; justify-content: center;
      font-size: 20px; font-weight: 900; color: #04111f;
      box-shadow: 0 4px 14px rgba(96,165,250,0.35);
    }
    .title-text h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; line-height: 1.2; }
    .title-text p { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    /* ── Base inputs & buttons ── */
    input, select {
      background: var(--panel-2); color: var(--text);
      border: 1px solid var(--border); border-radius: 10px;
      padding: 8px 12px; font: inherit; font-size: 13px;
      transition: border-color 0.15s, box-shadow 0.15s;
      outline: none;
    }
    input:focus, select:focus {
      border-color: rgba(96,165,250,0.5);
      box-shadow: 0 0 0 3px rgba(96,165,250,0.12);
    }
    input::placeholder { color: var(--muted); }
    button {
      cursor: pointer;
      background: linear-gradient(135deg, var(--accent-2) 0%, var(--accent) 100%);
      color: #04111f; font-weight: 700; border: none; border-radius: 10px;
      padding: 8px 16px; font: inherit; font-size: 13px;
      transition: opacity 0.15s, transform 0.1s, box-shadow 0.15s;
      box-shadow: 0 2px 10px rgba(96,165,250,0.25);
    }
    button:hover { opacity: 0.88; box-shadow: 0 4px 16px rgba(96,165,250,0.38); }
    button:active { transform: scale(0.97); }
    .ghost-btn {
      background: rgba(255,255,255,0.05);
      color: var(--text);
      border: 1px solid var(--border);
      box-shadow: none;
      font-weight: 500;
    }
    .ghost-btn:hover { background: rgba(255,255,255,0.09); border-color: var(--border-hover); box-shadow: none; }
    .icon-btn {
      width: 32px; height: 32px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 16px; font-weight: 700;
      border-radius: 8px;
    }
    /* ── Stats cards ── */
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px; margin-bottom: 20px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 16px 18px;
      position: relative; overflow: hidden;
      transition: border-color 0.2s;
    }
    .card::before {
      content: '';
      position: absolute; inset: 0;
      background: linear-gradient(135deg, rgba(255,255,255,0.03) 0%, transparent 80%);
      pointer-events: none;
    }
    .card:hover { border-color: var(--border-hover); }
    .card .label { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    .card .value { font-size: 32px; font-weight: 800; margin-top: 6px; line-height: 1; letter-spacing: -1px; }
    .card .value.accent { color: var(--accent-2); }
    .card .value.green { color: var(--success); }
    .card .value.warn { color: var(--warning); }
    /* ── Main grid ── */
    .grid {
      display: grid;
      grid-template-columns: 300px minmax(0,1fr) 340px;
      gap: 16px;
      align-items: start;
    }
    /* ── Panel ── */
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .panel-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      display: flex; justify-content: space-between; gap: 12px; align-items: center;
      background: rgba(255,255,255,0.02);
    }
    .panel-header h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .panel-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .panel-body { padding: 14px 16px; }
    /* ── Lists ── */
    .entity-list, .exchange-list, .simple-list {
      display: flex; flex-direction: column; gap: 6px;
      max-height: 70vh; overflow-y: auto; overflow-x: hidden;
      padding-right: 2px;
    }
    .entity-item, .exchange-item, .list-item {
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--panel-2);
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      font-size: 13px;
    }
    .entity-item:hover, .exchange-item:hover, .list-item:hover { background: rgba(255,255,255,0.06); border-color: var(--border); }
    .entity-item.active { border-color: var(--accent); background: rgba(94,234,212,0.07); }
    .entity-item .meta, .exchange-item .meta, .muted { color: var(--muted); font-size: 11px; margin-top: 3px; }
    .entity-item .name { font-weight: 600; font-size: 13px; }
    /* ── Badges ── */
    .badge {
      display: inline-flex; align-items: center;
      padding: 2px 8px; border-radius: 999px;
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
      margin-right: 5px;
      background: rgba(96,165,250,0.14); color: #93c5fd;
      border: 1px solid rgba(96,165,250,0.18);
    }
    .badge.green { background: rgba(74,222,128,0.12); color: #86efac; border-color: rgba(74,222,128,0.2); }
    .badge.yellow { background: rgba(251,191,36,0.12); color: #fde68a; border-color: rgba(251,191,36,0.2); }
    .badge.red { background: rgba(248,113,113,0.12); color: #fca5a5; border-color: rgba(248,113,113,0.2); }
    /* ── Fact items ── */
    .fact {
      padding: 9px 12px;
      background: var(--panel-2);
      border-radius: 10px;
      margin-bottom: 6px;
      font-size: 13px;
      border-left: 2px solid rgba(96,165,250,0.3);
    }
    .fact sup { color: var(--muted); }
    /* ── Split inside graph panel ── */
    .split { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 14px; }
    .split h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 10px; }
    /* ── Graph ── */
    .graph-wrap {
      height: 560px; overflow: hidden; position: relative;
      border-radius: 0; background: #06101d;
    }
    svg { width: 100%; height: 100%; display: block; background: transparent; touch-action: none; cursor: grab; user-select: none; }
    svg.is-dragging { cursor: grabbing; }
    .edge-label rect { fill: rgba(6,16,29,0.88); stroke: rgba(255,255,255,0.06); }
    .edge-label text {
      fill: rgba(200,220,255,0.72);
      text-anchor: middle;
      dominant-baseline: middle;
      font-size: 9px;
      letter-spacing: 0.02em;
      pointer-events: none;
    }
    .node-label { fill: #c7d9f8; pointer-events: none; font-size: 11px; }
    .graph-legend {
      position: absolute; left: 12px; bottom: 12px;
      font-size: 11px; color: var(--muted);
      background: rgba(6,16,29,0.82);
      backdrop-filter: blur(6px);
      padding: 6px 10px; border-radius: 8px;
      border: 1px solid var(--border);
    }
    .graph-controls {
      position: absolute; top: 12px; right: 12px; display: flex; align-items: center; gap: 6px; z-index: 2;
      background: rgba(6,16,29,0.88);
      backdrop-filter: blur(8px);
      border: 1px solid var(--border); border-radius: 10px; padding: 6px;
    }
    .graph-controls .zoom-label { min-width: 48px; text-align: center; color: var(--muted); font-size: 11px; }
    /* ── Expand/fullscreen ── */
    #graphPanel.is-expanded, #graphPanel:fullscreen {
      position: fixed; inset: 0; z-index: 1000; margin: 0;
      display: flex; flex-direction: column;
      width: auto; height: auto; border-radius: 0; background: #06101d;
    }
    #graphPanel.is-expanded .graph-wrap, #graphPanel:fullscreen .graph-wrap {
      flex: 1; height: 0; min-height: 0; border-radius: 0;
    }
    #graphPanel.is-expanded .panel-body.split, #graphPanel:fullscreen .panel-body.split { display: none; }
    #graphPanel.is-expanded .panel-header, #graphPanel:fullscreen .panel-header {
      background: rgba(6,16,29,0.95); backdrop-filter: blur(10px);
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    /* ── Table ── */
    .table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .table th, .table td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .table th { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .table tr:last-child td { border-bottom: none; }
    /* ── Misc ── */
    .warn { color: var(--warning); }
    .danger { color: var(--danger); }
    .small { font-size: 11px; color: var(--muted); }
    .empty { color: var(--muted); padding: 16px 0; text-align: center; font-size: 13px; }
    /* ── Entity detail ── */
    #entityDetails h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 14px 0 8px; }
    #entityDetails h3:first-child { margin-top: 0; }
    .detail-panel .panel-body { max-height: calc(100vh - 200px); overflow-y: auto; }
    /* ── Section titles in right panel ── */
    .section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 16px 0 8px; padding-top: 12px; border-top: 1px solid var(--border); }
    .section-title:first-child { margin-top: 0; border-top: none; padding-top: 0; }
    /* ── Responsive ── */
    @media (max-width: 1380px) {
      .grid { grid-template-columns: 280px minmax(0,1fr) 310px; }
    }
    @media (max-width: 1100px) {
      .grid { grid-template-columns: 260px minmax(0,1fr); }
      .detail-panel { grid-column: 1 / -1; }
      .detail-panel .panel-body { max-height: 50vh; }
    }
    @media (max-width: 760px) {
      .app { padding: 12px 14px; }
      .topbar { flex-direction: column; align-items: flex-start; }
      .actions { width: 100%; }
      .actions input { flex: 1; min-width: 0; }
      .grid { grid-template-columns: 1fr; gap: 12px; }
      .stats { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .card .value { font-size: 24px; }
      .split { grid-template-columns: 1fr; }
      .graph-wrap { height: 380px; }
      .entity-list, .exchange-list, .simple-list { max-height: 50vh; }
      .detail-panel .panel-body { max-height: 60vh; }
    }
    @media (max-width: 480px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
      .title-text h1 { font-size: 17px; }
      .graph-wrap { height: 300px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="topbar">
      <div class="title">
        <div class="title-logo">F</div>
        <div class="title-text">
          <h1>Forkscout Memory</h1>
          <p>Knowledge graph · facts · exchanges · tasks</p>
        </div>
      </div>
      <div class="actions">
        <input id="entitySearch" placeholder="Search entities, facts, tags…" style="width:200px" />
        <input id="exchangeSearch" placeholder="Search exchanges…" style="width:180px" />
        <button id="refreshBtn">↻ Refresh</button>
      </div>
    </div>

    <div id="stats" class="stats"></div>

    <div class="grid">
      <section class="panel">
        <div class="panel-header">
          <h2>Entities</h2>
          <span id="entityCount" class="small"></span>
        </div>
        <div class="panel-body" style="padding:10px 10px">
          <div id="entityList" class="entity-list"></div>
        </div>
      </section>

      <section class="panel" id="graphPanel">
        <div class="panel-header">
          <h2>Knowledge Graph</h2>
          <div class="panel-actions">
            <span id="graphMeta" class="small"></span>
            <button id="graphFullscreenBtn" class="ghost-btn" type="button">⛶ Expand</button>
          </div>
        </div>
        <div class="panel-body graph-wrap">
          <svg id="graph"></svg>
          <div class="graph-controls">
            <button id="graphZoomOutBtn" class="ghost-btn icon-btn" type="button" title="Zoom out">−</button>
            <span id="graphZoomLabel" class="zoom-label">100%</span>
            <button id="graphZoomInBtn" class="ghost-btn icon-btn" type="button" title="Zoom in">+</button>
            <button id="graphFitBtn" class="ghost-btn" type="button" title="Fit graph">Fit</button>
            <button id="graphResetBtn" class="ghost-btn" type="button" title="Reset view">Reset</button>
          </div>
          <div class="graph-legend">Drag canvas to pan · Scroll to zoom · Drag nodes · Double-click to fit</div>
        </div>
        <div class="panel-body split" style="padding: 14px 16px">
          <div>
            <h3 style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px">Tasks</h3>
            <div id="taskTable"></div>
          </div>
          <div>
            <h3 style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:10px">Knowledge Gaps</h3>
            <div id="gapsList" class="simple-list"></div>
          </div>
        </div>
      </section>

      <section class="panel detail-panel">
        <div class="panel-header">
          <h2>Details</h2>
          <span id="selectedMeta" class="small"></span>
        </div>
        <div class="panel-body" style="padding:12px 14px">
          <div id="entityDetails"></div>
          <div class="section-title">Stale Entities</div>
          <div id="staleList" class="simple-list"></div>
          <div class="section-title">Exchanges</div>
          <div id="exchangeList" class="exchange-list"></div>
        </div>
      </section>
    </div>
  </div>

  <script>
    const state = {
      snapshot: null,
      entityQuery: '',
      exchangeQuery: '',
      selectedName: null,
      graphLayout: {},
      graphView: {
        zoom: 1,
        minZoom: 0.06,
        maxZoom: 8,
        centerX: 450,
        centerY: 270,
        baseWidth: 900,
        baseHeight: 540,
        bounds: null,
        initialized: false,
        isDragging: false,
        dragPointerId: null,
        dragStartX: 0,
        dragStartY: 0,
        dragCenterX: 450,
        dragCenterY: 270,
        nodeDragName: null,
        suppressNodeClickUntil: 0,
        dragHasMoved: false,
      },
    };

    const $ = (id) => document.getElementById(id);
    const esc = ${escapeHtml.toString()};
    const GRAPH_LAYOUT_STORAGE_KEY = 'forkscout-memory-visualizer-layout-v6';

    try {
      const savedLayout = localStorage.getItem(GRAPH_LAYOUT_STORAGE_KEY);
      if (savedLayout) state.graphLayout = JSON.parse(savedLayout);
    } catch { }

    function formatDate(ts) {
      try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
    }

    function formatAgo(ts) {
      const diff = Math.max(0, Date.now() - ts);
      const mins = Math.round(diff / 60000);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.round(hrs / 24) + 'd ago';
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function saveGraphLayout() {
      try {
        localStorage.setItem(GRAPH_LAYOUT_STORAGE_KEY, JSON.stringify(state.graphLayout));
      } catch { }
    }

    function screenToWorld(clientX, clientY) {
      const svg = $('graph');
      const viewBox = getGraphViewBox();
      const rect = svg.getBoundingClientRect();
      const px = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
      const py = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
      return {
        x: viewBox.minX + viewBox.width * px,
        y: viewBox.minY + viewBox.height * py,
      };
    }

    function getGraphViewBox() {
      const view = state.graphView;
      const width = view.baseWidth / view.zoom;
      const height = view.baseHeight / view.zoom;
      return {
        width,
        height,
        minX: view.centerX - width / 2,
        minY: view.centerY - height / 2,
      };
    }

    function clampGraphCenter() {
      // Infinite canvas — no clamping on pan
    }

    function applyGraphView() {
      const svg = $('graph');
      if (!svg) return;
      clampGraphCenter();
      const viewBox = getGraphViewBox();
      svg.setAttribute('viewBox', viewBox.minX + ' ' + viewBox.minY + ' ' + viewBox.width + ' ' + viewBox.height);
      $('graphZoomLabel').textContent = Math.round(state.graphView.zoom * 100) + '%';
      updateGraphScaleStyles();
    }

    function updateGraphScaleStyles() {
      const svg = $('graph');
      const zoom = state.graphView.zoom;
      const nodeDivider = Math.pow(zoom, 1.25);
      const textDivider = Math.pow(zoom, 1.15);
      const edgeDivider = Math.pow(zoom, 0.95);
      // Minimum on-screen sizes (CSS pixels) — nodes/labels stay visible at any zoom
      const minNodeScreenR = 9;
      const minFontScreenPx = 10;

      Array.from(svg.querySelectorAll('circle[data-base-size]')).forEach((circle) => {
        const baseSize = Number(circle.getAttribute('data-base-size')) || 10;
        // Scale down when zoomed in (nice detail), but never smaller than minNodeScreenR on screen
        const size = Math.max(baseSize / nodeDivider, minNodeScreenR / zoom);
        circle.setAttribute('r', String(size));
      });

      Array.from(svg.querySelectorAll('.node-label')).forEach((label) => {
        const baseFont = Number(label.getAttribute('data-base-font')) || 11;
        const anchorX = Number(label.getAttribute('data-anchor-x')) || 0;
        const anchorY = Number(label.getAttribute('data-anchor-y')) || 0;
        // Font stays readable: minimum minFontScreenPx on screen
        const fontSize = Math.max(baseFont / textDivider, minFontScreenPx / zoom);
        // Offset = sibling circle's current radius + small gap
        const nodeG = label.parentElement;
        const circle = nodeG ? nodeG.querySelector('circle') : null;
        const circleR = circle ? Number(circle.getAttribute('r')) : (baseFont + 6);
        const offset = circleR + 5 / zoom;
        label.setAttribute('font-size', String(fontSize));
        label.setAttribute('x', String(anchorX + offset));
        label.setAttribute('y', String(anchorY + fontSize * 0.36));
      });

      Array.from(svg.querySelectorAll('line[data-base-stroke]')).forEach((line) => {
        const baseStroke = Number(line.getAttribute('data-base-stroke')) || 1;
        // Edges: scale by zoom so they're always at least 1 screen-px visually
        const stroke = Math.max(baseStroke / edgeDivider, 0.8 / zoom);
        line.setAttribute('stroke-width', String(stroke));
      });

      Array.from(svg.querySelectorAll('.edge-label')).forEach((group) => {
        const baseFont = Number(group.getAttribute('data-base-font')) || 10;
        // Edge labels: hide below ~20% zoom, otherwise keep readable
        if (zoom < 0.20) { group.setAttribute('opacity', '0'); return; }
        const fontSize = Math.max(baseFont / Math.pow(zoom, 1.2), minFontScreenPx / zoom);
        const paddingX = Math.max(14 / Math.pow(zoom, 1.05), 5 / zoom);
        const paddingY = Math.max(8 / Math.pow(zoom, 1.05), 3 / zoom);
        const text = group.querySelector('text');
        const rect = group.querySelector('rect');
        if (!text || !rect) return;
        text.setAttribute('font-size', String(fontSize));
        const content = (text.textContent || '').trim();
        const width = Math.max(fontSize * (content.length * 0.62) + paddingX, fontSize * 3.6);
        const height = Math.max(fontSize + paddingY, fontSize * 1.8);
        rect.setAttribute('x', String(-width / 2));
        rect.setAttribute('y', String(-height / 2));
        rect.setAttribute('width', String(width));
        rect.setAttribute('height', String(height));
        group.setAttribute('opacity', zoom >= 0.5 ? '0.92' : '0.65');
      });
    }

    function fitGraphToBounds() {
      const bounds = state.graphView.bounds;
      if (!bounds) {
        resetGraphView();
        return;
      }
      const view = state.graphView;
      const paddedWidth = Math.max(180, bounds.maxX - bounds.minX + 180);
      const paddedHeight = Math.max(180, bounds.maxY - bounds.minY + 180);
      view.zoom = clamp(Math.min(view.baseWidth / paddedWidth, view.baseHeight / paddedHeight), view.minZoom, view.maxZoom);
      view.centerX = (bounds.minX + bounds.maxX) / 2;
      view.centerY = (bounds.minY + bounds.maxY) / 2;
      applyGraphView();
    }

    function resetGraphView() {
      const view = state.graphView;
      view.zoom = 1;
      view.centerX = view.baseWidth / 2;
      view.centerY = view.baseHeight / 2;
      applyGraphView();
    }

    function zoomGraph(factor, clientX, clientY) {
      const svg = $('graph');
      const view = state.graphView;
      const oldViewBox = getGraphViewBox();
      const oldZoom = view.zoom;
      const nextZoom = clamp(oldZoom * factor, view.minZoom, view.maxZoom);
      if (nextZoom === oldZoom) return;

      if (typeof clientX === 'number' && typeof clientY === 'number') {
        const rect = svg.getBoundingClientRect();
        const px = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
        const py = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
        const worldX = oldViewBox.minX + oldViewBox.width * px;
        const worldY = oldViewBox.minY + oldViewBox.height * py;
        view.zoom = nextZoom;
        const nextWidth = view.baseWidth / view.zoom;
        const nextHeight = view.baseHeight / view.zoom;
        view.centerX = worldX - (px - 0.5) * nextWidth;
        view.centerY = worldY - (py - 0.5) * nextHeight;
      } else {
        view.zoom = nextZoom;
      }
      applyGraphView();
    }

    function syncGraphFullscreenButton() {
      const panel = $('graphPanel');
      const isNativeFull = document.fullscreenElement === panel;
      const isFallbackFull = panel.classList.contains('is-expanded');
      $('graphFullscreenBtn').textContent = (isNativeFull || isFallbackFull) ? 'Collapse' : 'Expand';
      setTimeout(() => renderGraph(), 30);
    }

    async function toggleGraphFullscreen() {
      const panel = $('graphPanel');
      try {
        if (document.fullscreenElement === panel) {
          await document.exitFullscreen();
          return;
        }
        if (!document.fullscreenElement && panel.requestFullscreen) {
          await panel.requestFullscreen();
          return;
        }
      } catch {
        // Fallback below
      }
      panel.classList.toggle('is-expanded');
      syncGraphFullscreenButton();
    }

    function bindGraphInteractions() {
      const svg = $('graph');
      if (svg.dataset.bound === 'true') return;
      svg.dataset.bound = 'true';

      svg.addEventListener('wheel', (event) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        zoomGraph(factor, event.clientX, event.clientY);
      }, { passive: false });

      svg.addEventListener('pointerdown', (event) => {
        const node = event.target.closest('.node');
        if (node) {
          state.graphView.nodeDragName = node.getAttribute('data-name');
          state.graphView.dragPointerId = event.pointerId;
          state.graphView.dragHasMoved = false;
          svg.classList.add('is-dragging');
          if (svg.setPointerCapture) svg.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        state.graphView.isDragging = true;
        state.graphView.dragPointerId = event.pointerId;
        state.graphView.dragStartX = event.clientX;
        state.graphView.dragStartY = event.clientY;
        state.graphView.dragCenterX = state.graphView.centerX;
        state.graphView.dragCenterY = state.graphView.centerY;
        svg.classList.add('is-dragging');
        if (svg.setPointerCapture) svg.setPointerCapture(event.pointerId);
      });

      svg.addEventListener('pointermove', (event) => {
        if (state.graphView.nodeDragName && state.graphView.dragPointerId === event.pointerId) {
          const point = screenToWorld(event.clientX, event.clientY);
          state.graphLayout[state.graphView.nodeDragName] = {
            x: point.x,
            y: point.y,
          };
          state.graphView.dragHasMoved = true;
          renderGraph();
          return;
        }
        if (!state.graphView.isDragging || state.graphView.dragPointerId !== event.pointerId) return;
        const viewBox = getGraphViewBox();
        const rect = svg.getBoundingClientRect();
        const scaleX = rect.width > 0 ? viewBox.width / rect.width : 1;
        const scaleY = rect.height > 0 ? viewBox.height / rect.height : 1;
        state.graphView.centerX = state.graphView.dragCenterX - (event.clientX - state.graphView.dragStartX) * scaleX;
        state.graphView.centerY = state.graphView.dragCenterY - (event.clientY - state.graphView.dragStartY) * scaleY;
        applyGraphView();
      });

      const stopDragging = (event) => {
        if (state.graphView.dragPointerId !== null && event.pointerId !== undefined && state.graphView.dragPointerId !== event.pointerId) return;
        if (state.graphView.nodeDragName && state.graphView.dragHasMoved) {
          state.graphView.suppressNodeClickUntil = Date.now() + 220;
          saveGraphLayout();
        }
        state.graphView.isDragging = false;
        state.graphView.dragPointerId = null;
        state.graphView.nodeDragName = null;
        state.graphView.dragHasMoved = false;
        svg.classList.remove('is-dragging');
      };

      svg.addEventListener('pointerup', stopDragging);
      svg.addEventListener('pointercancel', stopDragging);
      svg.addEventListener('pointerleave', (event) => {
        if (state.graphView.isDragging) stopDragging(event);
      });
      svg.addEventListener('dblclick', () => fitGraphToBounds());
    }

    function getFilteredEntities() {
      if (!state.snapshot) return [];
      const q = state.entityQuery.trim().toLowerCase();
      const entities = state.snapshot.entities.slice().sort((a, b) => (b.accessCount - a.accessCount) || a.name.localeCompare(b.name));
      if (!q) return entities;
      return entities.filter((entity) => {
        const hay = [
          entity.name,
          entity.type,
          ...(entity.facts || []).map((f) => f.content),
          ...Object.entries(entity.tags || {}).map(([k, v]) => k + ':' + v),
        ].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }

    function getFilteredExchanges() {
      if (!state.snapshot) return [];
      const q = state.exchangeQuery.trim().toLowerCase();
      const list = state.snapshot.exchanges || [];
      if (!q) return list.slice(0, 120);
      return list.filter((ex) => (ex.user + ' ' + ex.assistant).toLowerCase().includes(q)).slice(0, 120);
    }

    function renderStats() {
      const stats = state.snapshot.stats;
      const cards = [
        { label: 'Entities',    value: stats.entities,          cls: 'accent' },
        { label: 'Relations',   value: stats.relations,          cls: 'accent' },
        { label: 'Exchanges',   value: stats.exchanges,          cls: '' },
        { label: 'Hot',         value: stats.exchangesHot,       cls: 'green' },
        { label: 'Archived',    value: stats.exchangesArchived,  cls: '' },
        { label: 'Tasks',       value: stats.activeTasks,        cls: stats.activeTasks > 0 ? 'green' : '' },
        { label: 'Stale',       value: stats.staleEntities,      cls: stats.staleEntities > 5 ? 'warn' : '' },
        { label: 'Gaps',        value: stats.knowledgeGaps,      cls: stats.knowledgeGaps > 3 ? 'warn' : '' },
      ];
      $('stats').innerHTML = cards.map((c) =>
        '<div class="card"><div class="label">' + esc(c.label) + '</div>' +
        '<div class="value ' + c.cls + '">' + esc(String(c.value ?? 0)) + '</div></div>'
      ).join('');
    }

    function renderEntities() {
      const entities = getFilteredEntities();
      $('entityCount').textContent = entities.length + ' shown';
      if (!state.selectedName && entities[0]) state.selectedName = entities[0].name;
      if (state.selectedName && !entities.some((e) => e.name === state.selectedName) && entities[0]) state.selectedName = entities[0].name;
      $('entityList').innerHTML = entities.map((entity) => {
        const activeFacts = (entity.facts || []).filter((f) => f.status === 'active').length;
        const tags = Object.entries(entity.tags || {}).map(([k, v]) => '<span class="badge">' + esc(k + ':' + v) + '</span>').join('');
        return '<div class="entity-item ' + (entity.name === state.selectedName ? 'active' : '') + '" data-name="' + esc(entity.name) + '">' +
          '<div class="name">' + esc(entity.name.slice(0, 36)) + '</div>' +
          '<div class="meta"><span class="badge">' + esc(entity.type) + '</span>' + esc(activeFacts + ' facts') + '</div>' +
          (tags ? '<div style="margin-top:5px">' + tags + '</div>' : '') +
        '</div>';
      }).join('') || '<div class="empty">No entities match the filter.</div>';
      Array.from(document.querySelectorAll('.entity-item')).forEach((el) => {
        el.addEventListener('click', () => { state.selectedName = el.getAttribute('data-name'); render(); });
      });
    }

    function renderDetails() {
      const entity = (state.snapshot.entities || []).find((e) => e.name === state.selectedName);
      if (!entity) {
        $('selectedMeta').textContent = 'No entity selected';
        $('entityDetails').innerHTML = '<div class="empty">Select an entity to inspect facts and relations.</div>';
        return;
      }
      const activeFacts = (entity.facts || []).filter((f) => f.status === 'active').sort((a, b) => b.confidence - a.confidence);
      const historyFacts = (entity.facts || []).filter((f) => f.status === 'superseded').sort((a, b) => (b.supersededAt || 0) - (a.supersededAt || 0));
      const rels = (state.snapshot.relations || []).filter((r) => r.from === entity.name || r.to === entity.name);
      $('selectedMeta').textContent = entity.type + ' • ' + formatAgo(entity.lastSeen);
      const tagsHtml = Object.entries(entity.tags || {}).map(([k, v]) => '<span class="badge">' + esc(k + ':' + v) + '</span>').join('');
      $('entityDetails').innerHTML =
        '<div style="font-size:15px;font-weight:700;letter-spacing:-0.2px;margin-bottom:6px">' + esc(entity.name) + '</div>' +
        '<div class="small" style="margin-bottom:8px">' + esc(formatDate(entity.lastSeen)) + ' • ' + esc(String(entity.accessCount)) + ' accesses</div>' +
        (tagsHtml ? '<div style="margin-bottom:12px">' + tagsHtml + '</div>' : '') +
        '<div class="section-title">Active Facts</div>' +
        (activeFacts.map((fact) => '<div class="fact">' + esc(fact.content) + '<br><sup>' + esc(Math.round(fact.confidence * 100) + '% • ' + fact.sources + ' src • ' + formatAgo(fact.lastConfirmed)) + '</sup></div>').join('') || '<div class="empty">No active facts.</div>') +
        '<div class="section-title">History</div>' +
        (historyFacts.slice(0, 20).map((fact) => '<div class="fact" style="opacity:0.6">' + esc(fact.content) + '<br><sup>→ ' + esc(fact.supersededBy || '?') + '</sup></div>').join('') || '<div class="empty">No history.</div>') +
        '<div class="section-title">Relations (' + rels.length + ')</div>' +
        (rels.map((rel) => '<div class="fact">' + esc(rel.from === entity.name ? '→ ' + rel.to : rel.from + ' →') + '<br><sup>[' + esc(rel.type) + '] • ' + esc(Math.round(rel.weight * 100) + '%') + '</sup></div>').join('') || '<div class="empty">No relations.</div>');
    }

    function renderGraph() {
      const svg = $('graph');
      const width = svg.clientWidth || 900;
      const height = svg.clientHeight || 540;
      const entities = getFilteredEntities().slice(0, 300);
      const nodeByName = new Map(entities.map((e) => [e.name, e]));
      const relations = (state.snapshot.relations || []).filter((r) => nodeByName.has(r.from) && nodeByName.has(r.to)).slice(0, 600);
      $('graphMeta').textContent = entities.length + ' nodes • ' + relations.length + ' edges';
      if (entities.length === 0) {
        svg.innerHTML = '<text x="30" y="40" fill="#9fb3d1">No graph data for current filter.</text>';
        state.graphView.bounds = null;
        resetGraphView();
        return;
      }
      state.graphView.baseWidth = width;
      state.graphView.baseHeight = height;
      const cx = width / 2;
      const cy = height / 2;
      // --- Cluster layout: group nodes by entity type ---
      const typeGroups = new Map();
      entities.forEach((e) => {
        if (!typeGroups.has(e.type)) typeGroups.set(e.type, []);
        typeGroups.get(e.type).push(e);
      });
      const clusterTypes = Array.from(typeGroups.keys());
      const numClusters = clusterTypes.length;
      // Per-cluster spread: radius so nodes sit on a circle with ~22px between each
      const NODE_GAP = 22;
      const clusterSpreads = new Map();
      clusterTypes.forEach((type) => {
        const n = typeGroups.get(type).length;
        clusterSpreads.set(type, n <= 1 ? 0 : Math.max(36, (n * NODE_GAP) / (2 * Math.PI)));
      });
      const maxSpread = Math.max(...clusterSpreads.values(), 36);
      // Distance between cluster centroids — large enough so adjacent clusters don't overlap
      const clusterRadius = numClusters <= 1 ? 0 : maxSpread * 2 + 90;
      const positions = new Map();
      clusterTypes.forEach((type, ti) => {
        // Place cluster centroids evenly in a circle; start at top (-PI/2)
        const clusterAngle = (Math.PI * 2 * ti) / numClusters - Math.PI / 2;
        const clusterCx = cx + Math.cos(clusterAngle) * clusterRadius;
        const clusterCy = cy + Math.sin(clusterAngle) * clusterRadius;
        const members = typeGroups.get(type);
        const spread = clusterSpreads.get(type);
        members.forEach((entity, ni) => {
          const saved = state.graphLayout[entity.name];
          if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            positions.set(entity.name, { x: saved.x, y: saved.y });
            return;
          }
          if (members.length === 1) {
            positions.set(entity.name, { x: clusterCx, y: clusterCy });
            return;
          }
          const angle = (Math.PI * 2 * ni) / members.length;
          positions.set(entity.name, { x: clusterCx + Math.cos(angle) * spread, y: clusterCy + Math.sin(angle) * spread });
        });
      });
      // Dot-grid background pattern (infinite canvas whiteboard style)
      const defsHtml = '<defs>' +
        '<pattern id="infiniteDots" x="0" y="0" width="50" height="50" patternUnits="userSpaceOnUse">' +
          '<circle cx="0" cy="0" r="1.2" fill="rgba(94,124,169,0.32)"/>' +
          '<circle cx="50" cy="0" r="1.2" fill="rgba(94,124,169,0.32)"/>' +
          '<circle cx="0" cy="50" r="1.2" fill="rgba(94,124,169,0.32)"/>' +
          '<circle cx="50" cy="50" r="1.2" fill="rgba(94,124,169,0.32)"/>' +
        '</pattern>' +
      '</defs>';
      const bgRect = '<rect x="-100000" y="-100000" width="200000" height="200000" fill="url(#infiniteDots)"/>';
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const lines = relations.map((rel) => {
        const a = positions.get(rel.from);
        const b = positions.get(rel.to);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const stroke = Math.max(1, rel.weight * 2.5);
        minX = Math.min(minX, midX - 30);
        maxX = Math.max(maxX, midX + 30);
        minY = Math.min(minY, midY - 18);
        maxY = Math.max(maxY, midY + 18);
        return '<g>' +
          '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="rgba(159,179,209,0.26)" stroke-width="' + stroke + '" data-base-stroke="' + stroke + '" />' +
          '<g class="edge-label" transform="translate(' + midX + ' ' + midY + ')" data-base-font="10">' +
            '<rect x="-20" y="-8" width="40" height="16"></rect>' +
            '<text y="0">' + esc(rel.type) + '</text>' +
          '</g>' +
        '</g>';
      }).join('');
      const nodes = entities.map((entity, idx) => {
        const pos = positions.get(entity.name);
        const activeFacts = (entity.facts || []).filter((f) => f.status === 'active').length;
        const size = Math.min(18, 8 + activeFacts + Math.min(entity.accessCount, 4));
        const selected = entity.name === state.selectedName;
        const fill = selected ? '#5eead4' : '#60a5fa';
        minX = Math.min(minX, pos.x - size);
        maxX = Math.max(maxX, pos.x + size + 140);
        minY = Math.min(minY, pos.y - size);
        maxY = Math.max(maxY, pos.y + size);
        return '<g class="node" data-name="' + esc(entity.name) + '" style="cursor:pointer">' +
          '<circle cx="' + pos.x + '" cy="' + pos.y + '" r="' + size + '" data-base-size="' + size + '" fill="' + fill + '" fill-opacity="0.88" stroke="#dbeafe" stroke-width="' + (selected ? 2 : 0.6) + '" />' +
          '<text class="node-label" x="' + (pos.x + size + 6) + '" y="' + (pos.y + 4) + '" font-size="11" data-base-font="11" data-base-offset="' + (size + 6) + '" data-anchor-x="' + pos.x + '" data-anchor-y="' + pos.y + '">' + esc(entity.name.slice(0, 24)) + '</text>' +
        '</g>';
      }).join('');
      svg.innerHTML = defsHtml + bgRect + lines + nodes;
      state.graphView.bounds = { minX, maxX, minY, maxY };
      if (!state.graphView.initialized) {
        state.graphView.initialized = true;
        fitGraphToBounds();
      } else {
        applyGraphView();
      }
      bindGraphInteractions();
      Array.from(svg.querySelectorAll('.node')).forEach((el) => {
        el.addEventListener('click', () => {
          if (Date.now() < state.graphView.suppressNodeClickUntil) return;
          state.selectedName = el.getAttribute('data-name');
          render();
        });
      });
    }

    function renderTasks() {
      const tasks = state.snapshot.activeTasks || [];
      if (tasks.length === 0) {
        $('taskTable').innerHTML = '<div class="empty">No tasks recorded.</div>';
        return;
      }
      $('taskTable').innerHTML = '<table class="table"><thead><tr><th>Title</th><th>Status</th><th>Goal</th></tr></thead><tbody>' +
        tasks.map((task) => '<tr><td><strong>' + esc(task.title) + '</strong><div class="small">' + esc(formatAgo(task.lastStepAt)) + '</div></td><td>' + esc(task.status) + '</td><td>' + esc(task.goal) + '</td></tr>').join('') +
        '</tbody></table>';
    }

    function renderGaps() {
      const gaps = state.snapshot.knowledgeGaps || [];
      $('gapsList').innerHTML = gaps.length
        ? gaps.slice(0, 40).map((gap) => '<div class="list-item"><div class="warn"><strong>' + esc(gap.entityName) + '</strong></div><div>' + esc(gap.factContent) + '</div><div class="small">' + esc(gap.verificationHint) + '</div></div>').join('')
        : '<div class="empty">No volatile knowledge gaps detected.</div>';
    }

    function renderStale() {
      const stale = state.snapshot.staleEntities || [];
      $('staleList').innerHTML = stale.length
        ? stale.slice(0, 40).map((entity) => '<div class="list-item"><strong>' + esc(entity.name) + '</strong><div class="small">' + esc(entity.type) + ' • last seen ' + esc(formatAgo(entity.lastSeen)) + '</div></div>').join('')
        : '<div class="empty">No stale entities in the current snapshot.</div>';
    }

    function renderExchanges() {
      const exchanges = getFilteredExchanges();
      $('exchangeList').innerHTML = exchanges.length
        ? exchanges.map((ex) => '<div class="exchange-item"><div><strong>User:</strong> ' + esc(ex.user.slice(0, 260)) + '</div><div style="margin-top:8px"><strong>Assistant:</strong> ' + esc(ex.assistant.slice(0, 320)) + '</div><div class="meta" style="margin-top:8px">' + esc(formatDate(ex.timestamp)) + (ex.importance ? ' • importance ' + Math.round(ex.importance * 100) + '%' : '') + '</div></div>').join('')
        : '<div class="empty">No exchanges match the filter.</div>';
    }

    function render() {
      if (!state.snapshot) return;
      renderStats();
      renderEntities();
      renderDetails();
      renderGraph();
      renderTasks();
      renderGaps();
      renderStale();
      renderExchanges();
    }

    async function load() {
      const res = await fetch('/api/memory');
      if (!res.ok) throw new Error('Failed to load memory snapshot');
      state.snapshot = await res.json();
      render();
    }

    $('entitySearch').addEventListener('input', (e) => { state.entityQuery = e.target.value; render(); });
    $('exchangeSearch').addEventListener('input', (e) => { state.exchangeQuery = e.target.value; render(); });
    $('refreshBtn').addEventListener('click', () => load().catch(showError));
    $('graphFullscreenBtn').addEventListener('click', () => toggleGraphFullscreen());
    $('graphZoomInBtn').addEventListener('click', () => zoomGraph(1.2));
    $('graphZoomOutBtn').addEventListener('click', () => zoomGraph(1 / 1.2));
    $('graphFitBtn').addEventListener('click', () => fitGraphToBounds());
    $('graphResetBtn').addEventListener('click', () => resetGraphView());
    document.addEventListener('fullscreenchange', syncGraphFullscreenButton);

    function showError(err) {
      const message = err instanceof Error ? err.message : String(err);
      $('stats').innerHTML = '<div class="card danger">Failed to load: ' + esc(message) + '</div>';
    }

    load().catch(showError);
  </script>
</body>
</html>`;
}