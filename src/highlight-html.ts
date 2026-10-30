export default `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loved Passages — Highlighter</title>
  <style>
    :root {
      --accent: #1db954;
      --accent2: #ff6b9d;
      --bg: #121212;
      --panel: #1e1e1e;
      --surface: #282828;
      --ink: #e0e0e0;
      --ink2: #b3b3b3;
      --ink3: #777;
      --border: #333;
      --select-start: rgba(29, 185, 84, 0.15);
      --select-range: rgba(29, 185, 84, 0.3);
      --saved-passage: rgba(255, 107, 157, 0.2);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg); color: var(--ink);
      padding: 20px; max-width: 760px; margin: 0 auto;
    }

    /* ── Header ── */
    .header { margin-bottom: 16px; }
    .header h1 { color: var(--accent); font-size: 20px; margin-bottom: 4px; }
    .header .subtitle { color: var(--ink2); font-size: 13px; }
    .track-header {
      background: var(--panel); border-radius: 8px; padding: 14px 16px;
      margin-bottom: 12px;
    }
    .track-header .track-name { font-size: 18px; font-weight: 600; }
    .track-header .track-artist { color: var(--ink2); font-size: 14px; margin-top: 2px; }
    .track-header .track-meta { color: var(--ink3); font-size: 12px; margin-top: 4px; }

    /* ── Progress ── */
    .progress-bar {
      background: var(--surface); border-radius: 4px; height: 6px;
      margin-bottom: 16px; overflow: hidden;
    }
    .progress-bar .fill {
      background: var(--accent); height: 100%; border-radius: 4px;
      transition: width 0.3s;
    }
    .progress-label { color: var(--ink3); font-size: 12px; margin-bottom: 6px; }

    /* ── Lyrics ── */
    .lyrics-block {
      background: var(--panel); border-radius: 8px; padding: 12px 0;
      margin-bottom: 12px; max-height: 55vh; overflow-y: auto;
    }
    .lyric-line {
      display: flex; align-items: baseline; padding: 3px 16px; cursor: pointer;
      transition: background 0.1s; font-size: 14px; line-height: 1.6;
      border-left: 3px solid transparent;
    }
    .lyric-line:hover { background: var(--surface); }
    .lyric-line .line-num {
      color: var(--ink3); font-size: 11px; width: 28px; flex-shrink: 0;
      text-align: right; margin-right: 12px; font-family: 'SF Mono', 'Fira Code', monospace;
      user-select: none;
    }
    .lyric-line .line-text {
      font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace; font-size: 13px;
      white-space: pre-wrap;
    }
    .lyric-line.empty-line .line-text { min-height: 1.2em; }
    .lyric-line.select-start {
      background: var(--select-start); border-left-color: var(--accent);
    }
    .lyric-line.select-range {
      background: var(--select-range); border-left-color: var(--accent);
    }
    .lyric-line.saved-passage {
      background: var(--saved-passage); border-left-color: var(--accent2);
    }
    /* Active selection takes precedence */
    .lyric-line.select-start.saved-passage,
    .lyric-line.select-range.saved-passage {
      background: var(--select-range); border-left-color: var(--accent);
    }

    /* ── Selection hint ── */
    .selection-hint {
      color: var(--ink3); font-size: 12px; text-align: center;
      margin-bottom: 8px; min-height: 18px;
    }

    /* ── Passage actions ── */
    .passage-actions {
      display: flex; gap: 8px; justify-content: center; margin-bottom: 16px;
    }
    .btn {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 6px; padding: 8px 16px; color: var(--ink);
      cursor: pointer; font-size: 13px; transition: all 0.15s;
    }
    .btn:hover { border-color: var(--ink3); }
    .btn:disabled { opacity: 0.3; cursor: default; }
    .btn.primary { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 600; }
    .btn.primary:hover { opacity: 0.9; }
    .btn.danger { color: var(--accent2); border-color: var(--accent2); }
    .btn.danger:hover { background: var(--accent2); color: #000; }

    /* ── Saved passages panel ── */
    .passages-panel {
      background: var(--panel); border-radius: 8px; padding: 12px 16px;
      margin-bottom: 16px;
    }
    .passages-panel h3 {
      color: var(--ink2); font-size: 12px; text-transform: uppercase;
      letter-spacing: 1px; margin-bottom: 8px;
    }
    .passage-item {
      background: var(--surface); border-radius: 6px; padding: 10px 12px;
      margin-bottom: 6px; position: relative;
    }
    .passage-item .passage-lines {
      color: var(--ink3); font-size: 11px; margin-bottom: 4px;
    }
    .passage-item .passage-text {
      font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
      font-size: 12px; line-height: 1.5; color: var(--ink);
      white-space: pre-wrap;
    }
    .passage-item .delete-btn {
      position: absolute; top: 8px; right: 8px;
      background: none; border: none; color: var(--ink3);
      cursor: pointer; font-size: 16px; padding: 2px 6px;
      border-radius: 4px;
    }
    .passage-item .delete-btn:hover { color: var(--accent2); background: rgba(255,107,157,0.1); }
    .no-passages { color: var(--ink3); font-size: 13px; font-style: italic; }

    /* ── Nav controls ── */
    .nav-controls {
      display: flex; gap: 8px; justify-content: space-between; margin-bottom: 16px;
    }
    .nav-controls .left { display: flex; gap: 8px; }
    .nav-controls .right { display: flex; gap: 8px; }

    /* ── Loading / error ── */
    .loading { text-align: center; padding: 60px 20px; color: var(--ink2); }
    .error { text-align: center; padding: 40px 20px; color: var(--accent2); }
  </style>
</head>
<body>
  <div class="header">
    <h1>Loved Passages</h1>
    <div class="subtitle">Click lines to select passages. Mark what you love.</div>
  </div>

  <div id="app">
    <div class="loading">Loading tracks...</div>
  </div>

<script>
(function() {
  // ── State ──
  let tracks = [];
  let currentIndex = 0;
  let selectStart = null;  // 1-indexed line number
  let selectEnd = null;
  // passages: Map<uri, Array<{ start_line, end_line, text }>>
  let passages = {};
  const LS_KEY = 'highlight-passages';
  const LS_INDEX_KEY = 'highlight-index';

  // ── LocalStorage ──
  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(passages));
      localStorage.setItem(LS_INDEX_KEY, String(currentIndex));
    } catch(e) { console.error('localStorage save failed', e); }
  }
  function loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) passages = JSON.parse(raw);
      const idx = localStorage.getItem(LS_INDEX_KEY);
      if (idx !== null) currentIndex = parseInt(idx, 10);
    } catch(e) { console.error('localStorage load failed', e); }
  }

  // ── API ──
  async function fetchTracks() {
    const res = await fetch('/api/highlight/tracks');
    if (!res.ok) throw new Error('Failed to load tracks: ' + res.status);
    return res.json();
  }

  async function savePassages(uri, passageList) {
    const body = {
      uri,
      passages: passageList.map((p, i) => ({
        start_line: p.start_line,
        end_line: p.end_line,
        text: p.text,
      }))
    };
    const res = await fetch('/api/highlight/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Save failed: ' + res.status);
    return res.json();
  }

  // ── Helpers ──
  function getLines(track) {
    return track.lyrics_plain.split('\\n');
  }

  function getPassages(uri) {
    return passages[uri] || [];
  }

  function setPassages(uri, list) {
    passages[uri] = list;
    saveLocal();
  }

  function countMarked() {
    return tracks.filter(t => (passages[t.uri] || []).length > 0).length;
  }

  function clearSelection() {
    selectStart = null;
    selectEnd = null;
  }

  // ── Render ──
  function render() {
    const app = document.getElementById('app');
    if (!tracks.length) {
      app.innerHTML = '<div class="error">No tracks loaded.</div>';
      return;
    }

    const track = tracks[currentIndex];
    const uri = track.uri;
    const lines = getLines(track);
    const trackPassages = getPassages(uri);
    const marked = countMarked();

    // Build saved-line set for highlighting
    const savedLineSet = new Set();
    trackPassages.forEach(p => {
      for (let i = p.start_line; i <= p.end_line; i++) savedLineSet.add(i);
    });

    // Selection range
    let selMin = null, selMax = null;
    if (selectStart !== null && selectEnd !== null) {
      selMin = Math.min(selectStart, selectEnd);
      selMax = Math.max(selectStart, selectEnd);
    }

    // Determine hint text
    let hint = 'Click a line to start selecting a passage';
    if (selectStart !== null && selectEnd === null) {
      hint = 'Click another line to complete the selection, or click the same line for a single-line passage';
    } else if (selMin !== null) {
      const count = selMax - selMin + 1;
      hint = count + ' line' + (count !== 1 ? 's' : '') + ' selected \u2014 Add passage or click to reselect';
    }

    let html = '';

    // Progress
    html += '<div class="progress-label">' + marked + ' / ' + tracks.length + ' marked</div>';
    html += '<div class="progress-bar"><div class="fill" style="width:' + (marked / tracks.length * 100) + '%"></div></div>';

    // Track header
    html += '<div class="track-header">';
    html += '<div class="track-name">' + esc(track.track_name) + '</div>';
    html += '<div class="track-artist">' + esc(track.artist_name) + '</div>';
    html += '<div class="track-meta">#' + (currentIndex + 1) + ' of ' + tracks.length + ' &middot; ' + track.play_count + ' plays</div>';
    html += '</div>';

    // Hint
    html += '<div class="selection-hint">' + hint + '</div>';

    // Lyrics
    html += '<div class="lyrics-block">';
    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      let cls = 'lyric-line';
      if (!line.trim()) cls += ' empty-line';
      if (savedLineSet.has(lineNum)) cls += ' saved-passage';
      if (selectStart === lineNum && selectEnd === null) cls += ' select-start';
      if (selMin !== null && lineNum >= selMin && lineNum <= selMax) cls += ' select-range';
      html += '<div class="' + cls + '" data-line="' + lineNum + '">';
      html += '<span class="line-num">' + lineNum + '</span>';
      html += '<span class="line-text">' + (line.trim() ? esc(line) : '&nbsp;') + '</span>';
      html += '</div>';
    });
    html += '</div>';

    // Passage actions
    html += '<div class="passage-actions">';
    const canAdd = selMin !== null;
    html += '<button class="btn primary" id="btn-add"' + (canAdd ? '' : ' disabled') + '>Add passage</button>';
    if (selectStart !== null) {
      html += '<button class="btn" id="btn-clear-sel">Clear selection</button>';
    }
    html += '</div>';

    // Saved passages panel
    html += '<div class="passages-panel">';
    html += '<h3>Saved passages (' + trackPassages.length + ')</h3>';
    if (trackPassages.length === 0) {
      html += '<div class="no-passages">No passages marked yet</div>';
    } else {
      trackPassages.forEach((p, pi) => {
        const preview = p.text.length > 200 ? p.text.slice(0, 200) + '...' : p.text;
        html += '<div class="passage-item">';
        html += '<div class="passage-lines">Lines ' + p.start_line + '\u2013' + p.end_line + '</div>';
        html += '<div class="passage-text">' + esc(preview) + '</div>';
        html += '<button class="delete-btn" data-pidx="' + pi + '" title="Remove">&times;</button>';
        html += '</div>';
      });
    }
    html += '</div>';

    // Nav controls
    html += '<div class="nav-controls">';
    html += '<div class="left">';
    html += '<button class="btn" id="btn-prev"' + (currentIndex === 0 ? ' disabled' : '') + '>&larr; Previous</button>';
    html += '</div>';
    html += '<div class="right">';
    html += '<button class="btn" id="btn-skip">Skip</button>';
    html += '<button class="btn primary" id="btn-save-next">Save &amp; Next &rarr;</button>';
    html += '</div>';
    html += '</div>';

    app.innerHTML = html;
    attachEvents();
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Events ──
  function attachEvents() {
    // Line clicks
    document.querySelectorAll('.lyric-line').forEach(el => {
      el.addEventListener('click', () => {
        const lineNum = parseInt(el.dataset.line, 10);
        if (selectStart === null) {
          selectStart = lineNum;
          selectEnd = null;
        } else if (selectEnd === null) {
          selectEnd = lineNum;
        } else {
          // Already have a full selection; start over
          selectStart = lineNum;
          selectEnd = null;
        }
        render();
      });
    });

    // Add passage
    const btnAdd = document.getElementById('btn-add');
    if (btnAdd) btnAdd.addEventListener('click', addPassage);

    // Clear selection
    const btnClear = document.getElementById('btn-clear-sel');
    if (btnClear) btnClear.addEventListener('click', () => { clearSelection(); render(); });

    // Delete passage
    document.querySelectorAll('.delete-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const pi = parseInt(el.dataset.pidx, 10);
        const uri = tracks[currentIndex].uri;
        const list = getPassages(uri).slice();
        list.splice(pi, 1);
        setPassages(uri, list);
        render();
      });
    });

    // Nav
    const btnPrev = document.getElementById('btn-prev');
    if (btnPrev) btnPrev.addEventListener('click', goPrev);

    const btnSkip = document.getElementById('btn-skip');
    if (btnSkip) btnSkip.addEventListener('click', goSkip);

    const btnSaveNext = document.getElementById('btn-save-next');
    if (btnSaveNext) btnSaveNext.addEventListener('click', goSaveNext);

    // Keyboard
    document.onkeydown = handleKey;
  }

  function handleKey(e) {
    if (e.key === 'Enter' && selectStart !== null && selectEnd !== null) {
      e.preventDefault();
      addPassage();
    }
  }

  function addPassage() {
    if (selectStart === null || selectEnd === null) return;
    const track = tracks[currentIndex];
    const lines = getLines(track);
    const min = Math.min(selectStart, selectEnd);
    const max = Math.max(selectStart, selectEnd);
    const text = lines.slice(min - 1, max).join('\\n');
    const list = getPassages(track.uri).slice();
    list.push({ start_line: min, end_line: max, text });
    setPassages(track.uri, list);
    clearSelection();
    render();
  }

  async function doSave() {
    const track = tracks[currentIndex];
    const list = getPassages(track.uri);
    try {
      await savePassages(track.uri, list);
    } catch(e) {
      console.error(e);
      alert('Save failed: ' + e.message);
      throw e;
    }
  }

  async function goPrev() {
    if (currentIndex === 0) return;
    try { await doSave(); } catch { return; }
    currentIndex--;
    clearSelection();
    saveLocal();
    render();
    scrollToTop();
  }

  async function goSkip() {
    try {
      const track = tracks[currentIndex];
      setPassages(track.uri, []);
      await doSave();
    } catch { return; }
    if (currentIndex < tracks.length - 1) {
      currentIndex++;
      clearSelection();
      saveLocal();
      render();
      scrollToTop();
    } else {
      alert('All tracks reviewed!');
    }
  }

  async function goSaveNext() {
    try { await doSave(); } catch { return; }
    if (currentIndex < tracks.length - 1) {
      currentIndex++;
      clearSelection();
      saveLocal();
      render();
      scrollToTop();
    } else {
      alert('All tracks reviewed! ' + countMarked() + ' marked.');
    }
  }

  function scrollToTop() {
    window.scrollTo(0, 0);
  }

  // ── Init ──
  async function init() {
    try {
      const data = await fetchTracks();
      tracks = data;
      loadLocal();
      // Hydrate from server for any tracks not in localStorage
      tracks.forEach(t => {
        if (!passages[t.uri] && t.existing_passages && t.existing_passages.length > 0) {
          passages[t.uri] = t.existing_passages;
        }
      });
      // Clamp index
      if (currentIndex >= tracks.length) currentIndex = 0;
      render();
    } catch(e) {
      document.getElementById('app').innerHTML = '<div class="error">Failed to load: ' + esc(e.message) + '</div>';
      console.error(e);
    }
  }

  init();
})();
</script>
</body>
</html>`;
