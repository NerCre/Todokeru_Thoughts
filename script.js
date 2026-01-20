/*
 * 命をツナゲル - 照合アプリ
 *
 * このスクリプトはオフライン環境で動作する単一ページアプリです。
 * 役割:
 *   - ログイン認証（利用者と管理者）
 *   - SMS本文から職員IDを抽出し、マスタ情報と照合
 *   - 結果を救急隊に提示できるよう一覧表示
 *   - 管理者によるマスタデータの追加・編集・削除、パスワード変更、データのエクスポート/インポート
 */

(() => {
  'use strict';

  // Configure QrScanner to load its worker script from the CDN.  Without
  // specifying the WORKER_PATH, QrScanner will attempt to load the worker from
  // the current origin which may fail in offline contexts.  Setting this
  // property ensures that the worker is fetched from the unpkg CDN.
  if (typeof QrScanner !== 'undefined') {
    QrScanner.WORKER_PATH = 'https://unpkg.com/qr-scanner/qr-scanner-worker.min.js';
  }

  /** =========================
   *  DOM utilities
   *  ========================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Escape HTML to prevent XSS when injecting content */
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Compute SHA-256 hash and return as hex string */
  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = enc.encode(text);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Toast notification */
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => el.classList.remove('show'), 2000);
  }

  /** =========================
   *  Custom additions for トドケル
   *  ========================= */
  // Accident pictogram definitions
  const accidentDefs = [
    { key: 'fall', label: '転落', icon: '🤸' },
    { key: 'crush', label: '挟まれ', icon: '🪨' },
    { key: 'flying', label: '飛来', icon: '📦' },
    { key: 'collapse', label: '倒壊', icon: '🏚️' },
    { key: 'burn', label: '熱傷', icon: '🔥' },
    { key: 'hazard', label: '有害物', icon: '☣️' },
    { key: 'electric', label: '感電', icon: '⚡' },
    { key: 'collision', label: '激突', icon: '🚧' },
    { key: 'explosion', label: '爆発', icon: '💥' },
    { key: 'other', label: 'その他', icon: '❓' }
  ];

  // --- Map definitions for interactive location selection ---
  // Base coordinate space for the yard map.  Using the same resolution as
  // 命をツナゲル allows the existing map images to align with our
  // simplified polygon definitions.  All polygon coordinates are defined
  // within this space.
  const MAP_BASE_W = 2048;
  const MAP_BASE_H = 1864;
  // Image assets for each view.  These PNG files are copied from the
  // 命をツナゲル app and included in this project directory.  They are
  // optional: if missing, the map renders on a blank background.
  const MAP_IMAGES = {
    all: 'map_overview.png',
    a1: 'map_area1.png',
    a2: 'map_area2.png',
    a3: 'map_area3.png'
  };
  // Simple rectangular boundaries dividing the yard into three areas.
  // Area1 covers the upper right quadrant, area2 the upper left, area3 the
  // lower half.  These definitions are approximate but sufficient for
  // tapping large regions on the overview.
  const MAP_AREA_POLYS = {
    a1: [ [1024, 0], [2048, 0], [2048, 916], [1024, 916] ],
    a2: [ [0, 0], [1024, 0], [1024, 916], [0, 916] ],
    a3: [ [0, 916], [2048, 916], [2048, 1864], [0, 1864] ],
  };
  // Place polygons.  To keep the demo manageable, only a subset of
  // locations is defined here.  Each place is mapped to a simple
  // rectangular polygon within its respective area.  The centroid (cx, cy)
  // is calculated at runtime for marker rendering.
  const MAP_PLACES = [
    { name: 'A棟', areaKey: 'a1', poly: [[1024, 0],[1536, 0],[1536, 300],[1024, 300]] },
    { name: 'B棟', areaKey: 'a1', poly: [[1024, 300],[1536, 300],[1536, 600],[1024, 600]] },
    { name: '北定盤2', areaKey: 'a1', poly: [[1024, 600],[1536, 600],[1536, 916],[1024, 916]] },
    { name: '南定盤1', areaKey: 'a2', poly: [[0, 0],[512, 0],[512, 305],[0, 305]] },
    { name: '南定盤2', areaKey: 'a2', poly: [[0, 305],[512, 305],[512, 610],[0, 610]] },
    { name: '南定盤3', areaKey: 'a2', poly: [[0, 610],[512, 610],[512, 916],[0, 916]] },
    { name: 'C棟', areaKey: 'a3', poly: [[0, 916],[683, 916],[683, 1390],[0, 1390]] },
    { name: '加工場', areaKey: 'a3', poly: [[683, 916],[1366, 916],[1366, 1390],[683, 1390]] },
    { name: '電気室・コンプレッサー室', areaKey: 'a3', poly: [[1366, 916],[2048, 916],[2048, 1390],[1366, 1390]] },
  ];
  // Compute centroid for each polygon.  The centroid is used to draw a
  // marker dot when a place is selected.
  function polyCentroid(poly) {
    let x = 0, y = 0;
    for (const [px, py] of poly) { x += px; y += py; }
    return { x: x / poly.length, y: y / poly.length };
  }
  MAP_PLACES.forEach((p) => {
    const c = polyCentroid(p.poly);
    p.cx = c.x;
    p.cy = c.y;
  });
  // Map view state.  'all' shows area polygons; 'a1', 'a2', 'a3' show the
  // places within that area.  mapSelected holds the currently selected
  // place object and mapTap the last tap position (unused here but
  // reserved for future enhancements).
  let mapView = 'all';
  let mapSelected = null;
  let mapTap = null;

  /**
   * Set the active state on map tab buttons and update the Reset Zoom
   * button.  The tab IDs correspond to the values 'all', 'a1', 'a2', 'a3'.
   */
  function setMapTabActive(key) {
    const ids = {
      all: 'btnMapViewAll',
      a1: 'btnMapViewA1',
      a2: 'btnMapViewA2',
      a3: 'btnMapViewA3',
    };
    Object.entries(ids).forEach(([k, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const isActive = k === key;
      el.classList.toggle('active', isActive);
      el.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    const resetBtn = document.getElementById('btnMapResetZoom');
    if (resetBtn) {
      resetBtn.disabled = (key === 'all');
    }
  }

  /**
   * Remove all child nodes from an SVG element.
   */
  function clearSvg(svg) {
    while (svg && svg.firstChild) svg.removeChild(svg.firstChild);
  }

  /**
   * Render the yard map into the SVG element.  Depending on the current
   * mapView value, either the area polygons or the place polygons are
   * drawn.  The background image is loaded if available.  Clicking on
   * polygons navigates between views or selects a place.
   */
  function renderYardSvg() {
    const svg = document.getElementById('yardSvg');
    if (!svg) return;
    clearSvg(svg);
    // Determine viewBox: entire map for 'all', or bounding box of area
    if (mapView === 'all') {
      svg.setAttribute('viewBox', `0 0 ${MAP_BASE_W} ${MAP_BASE_H}`);
    } else {
      const poly = MAP_AREA_POLYS[mapView];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of poly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const padX = 100, padY = 100;
      minX = Math.max(0, minX - padX);
      minY = Math.max(0, minY - padY);
      maxX = Math.min(MAP_BASE_W, maxX + padX);
      maxY = Math.min(MAP_BASE_H, maxY + padY);
      svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    }
    // Draw the background image (optional)
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'image');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(MAP_BASE_W));
    bg.setAttribute('height', String(MAP_BASE_H));
    const key = mapView;
    const src = MAP_IMAGES[key] || MAP_IMAGES.all;
    if (src) {
      bg.setAttribute('href', src);
      bg.setAttributeNS('http://www.w3.org/1999/xlink', 'href', src);
      bg.setAttribute('preserveAspectRatio', 'none');
      svg.appendChild(bg);
    }
    if (mapView === 'all') {
      // Draw area polygons with labels
      ['a1', 'a2', 'a3'].forEach((k) => {
        const pts = MAP_AREA_POLYS[k];
        const polyEl = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polyEl.setAttribute('class', 'map-area');
        polyEl.setAttribute('data-area', k);
        polyEl.setAttribute('points', pts.map(([x, y]) => `${x},${y}`).join(' '));
        polyEl.addEventListener('click', () => {
          mapView = k;
          mapSelected = null;
          mapTap = null;
          setMapTabActive(k);
          renderYardSvg();
          renderMapCandidates();
        });
        svg.appendChild(polyEl);
        // Label
        const c = polyCentroid(pts);
        const tx = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        tx.setAttribute('x', String(c.x));
        tx.setAttribute('y', String(c.y));
        tx.setAttribute('text-anchor', 'middle');
        tx.setAttribute('dominant-baseline', 'middle');
        tx.setAttribute('class', 'map-area-label');
        tx.textContent = k === 'a1' ? 'エリア1' : k === 'a2' ? 'エリア2' : 'エリア3';
        tx.setAttribute('pointer-events', 'none');
        svg.appendChild(tx);
      });
    } else {
      // Draw place polygons in the selected area
      MAP_PLACES.filter((p) => p.areaKey === mapView).forEach((p) => {
        const polyEl = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polyEl.setAttribute('class', 'map-poly' + (mapSelected && mapSelected.name === p.name ? ' active' : ''));
        polyEl.setAttribute('data-name', p.name);
        polyEl.setAttribute('points', p.poly.map(([x, y]) => `${x},${y}`).join(' '));
        polyEl.addEventListener('click', () => {
          mapSelected = p;
          renderYardSvg();
          renderMapCandidates();
        });
        svg.appendChild(polyEl);
      });
      // Draw marker for selected place
      if (mapSelected) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('class', 'map-dot');
        dot.setAttribute('cx', String(mapSelected.cx));
        dot.setAttribute('cy', String(mapSelected.cy));
        dot.setAttribute('r', '18');
        svg.appendChild(dot);
      }
    }
  }

  /**
   * Render the list of candidate locations below the map.  In the overview
   * view this lists the area names; in an area view it lists the place
   * names.  Clicking a candidate navigates or selects accordingly.
   */
  function renderMapCandidates() {
    const wrap = document.getElementById('mapCandidates');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (mapView === 'all') {
      ['a1', 'a2', 'a3'].forEach((k) => {
        const div = document.createElement('div');
        div.className = 'map-cand';
        div.textContent = k === 'a1' ? 'エリア1' : k === 'a2' ? 'エリア2' : 'エリア3';
        div.addEventListener('click', () => {
          mapView = k;
          mapSelected = null;
          setMapTabActive(k);
          renderYardSvg();
          renderMapCandidates();
        });
        wrap.appendChild(div);
      });
    } else {
      MAP_PLACES.filter((p) => p.areaKey === mapView).forEach((p) => {
        const div = document.createElement('div');
        div.className = 'map-cand' + (mapSelected && mapSelected.name === p.name ? ' primary' : '');
        div.textContent = p.name;
        div.addEventListener('click', () => {
          mapSelected = p;
          renderYardSvg();
          renderMapCandidates();
        });
        wrap.appendChild(div);
      });
    }
  }

  // QR scanning state
  // Use QrScanner for all QR decoding.  The legacy implementation relied on
  // BarcodeDetector which is not supported on iOS Safari.  QrScanner provides
  // a cross‑browser solution using a WebWorker.  We keep qrStream only for
  // backward compatibility but scanning is handled by qrScanner.
  let qrStream = null;
  let qrScanner = null;
  // qrRunning flag is no longer used for scanning logic; preserved for
  // potential legacy code paths.
  let qrRunning = false;
  let qrPurpose = null;
  let qrTarget = null;
  // When scanning a helmet QR in edit mode, we also need to update a
  // separate field for the staff name.  qrNameTarget holds that element.
  let qrNameTarget = null;
  // State used by the original map implementation (selectedArea/selectedLocation)
  // has been superseded by mapView/mapSelected.  Keep these variables
  // declared to prevent runtime errors in any legacy code paths.
  let selectedLocation = null;
  let selectedArea = null;

  /** =========================
   *  Master data storage
   *  ========================= */
  const STORAGE_KEY = 'tsunageru_master_v1';
  let masterData = null;

  // デモ用の職員デフォルト一覧。命をツナゲルのマスタから取り込み、
  // 所属（会社名）はcompanyIdから解決したものを設定しています。
  // 各フィールドを空欄または空配列で定義することで欠損を防ぎます。
  const DEFAULT_STAFF = [
    { id: 'S001', name: '佐藤 一郎', kana: 'さとういちろう', affiliation: '自社', birthday: '1960/5/23', blood: 'O+', history: ['高血圧'], meds: ['降圧薬'], allergies: ['ピーナッツ'], doctor: '佐々木医院', contactRel: '妻', contactTel: '090-1234-5678' },
    { id: 'S002', name: '高橋 花子', kana: 'たかはしはなこ', affiliation: '自社', birthday: '1973/1/12', blood: 'A+', history: ['喘息'], meds: ['吸入薬'], allergies: ['なし'], doctor: '高橋クリニック', contactRel: '夫', contactTel: '080-2345-6789' },
    { id: 'S003', name: '山田 太郎', kana: 'やまだたろう', affiliation: 'A造船', birthday: '1998/10/19', blood: 'B+', history: ['なし'], meds: ['なし'], allergies: ['なし'], doctor: 'なし', contactRel: '母', contactTel: '080-0123-4567' },
    { id: 'S004', name: '伊藤 次郎', kana: 'いとう じろう', affiliation: 'A造船', birthday: '', blood: '', history: [], meds: [], allergies: [], doctor: '', contactRel: '', contactTel: '' },
    { id: 'S005', name: '鈴木 三郎', kana: 'すずき さぶろう', affiliation: 'B株式会社', birthday: '', blood: '', history: [], meds: [], allergies: [], doctor: '', contactRel: '', contactTel: '' },
    { id: 'S008', name: '造船 太郎', kana: 'ぞうせん たろう', affiliation: '自社', birthday: '', blood: '', history: [], meds: [], allergies: [], doctor: '', contactRel: '', contactTel: '' },
    { id: 'id-5fd2bb7cd942d8-19bb45d165e', name: '高橋 花子', kana: 'たかはし はなこ', affiliation: '自社', birthday: '', blood: '', history: [], meds: [], allergies: [], doctor: '', contactRel: '', contactTel: '' },
    { id: 'U006', name: '山田 太郎', kana: 'やまだ たろう', affiliation: 'A造船', birthday: '', blood: '', history: [], meds: [], allergies: [], doctor: '', contactRel: '', contactTel: '' },
    { id: 'N009', name: '造船 次郎', kana: 'ぞうせん じろう', affiliation: 'A造船', birthday: '', blood: '', history: [], meds: [], allergies: [], doctor: '', contactRel: '', contactTel: '' },
    { id: 'R010', name: '鈴木 三郎', kana: 'すずき さぶろう', affiliation: 'B株式会社', birthday: '', blood: '', history: [], meds: [], allergies: [], doctor: '', contactRel: '', contactTel: '' }
  ];

  /** Load master data from localStorage, or initialise defaults if absent */
  async function loadMaster() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        masterData = JSON.parse(raw);
      }
    } catch (err) {
      console.warn('master data parse error', err);
    }
    if (!masterData || typeof masterData !== 'object') {
      masterData = {};
    }
    // Default values if not present
    if (!masterData.version) masterData.version = 1;
    if (!masterData.staff || !Array.isArray(masterData.staff)) {
      // デモ用の職員マスタが存在しない場合は、事前に定義したリストを読み込みます
      masterData.staff = DEFAULT_STAFF.map((s) => ({ ...s }));
    }
    
    // 既存データ/インポートデータの互換性: 読み仮名(kana)を補完
    masterData.staff = masterData.staff.map((s) => ({
      ...s,
      kana: (s && (s.kana ?? s.reading ?? s.yomi ?? '')) || ''
    }));

    if (!masterData.userPasswordHash) {
      // Default user password: 0000
      masterData.userPasswordHash = await sha256Hex('0000');
    }
    // デモ用に必ず管理者IDとパスワードを固定（ID: 1111, PW: 2222）します。
    // 過去に保存された資格情報は無視されます。
    masterData.adminId = '1111';
    masterData.adminPasswordHash = await sha256Hex('2222');

    // Ensure each staff record has required properties
    if (Array.isArray(masterData.staff)) {
      masterData.staff.forEach((s) => {
        // birthday
        if (!Object.prototype.hasOwnProperty.call(s, 'birthday')) {
          s.birthday = '';
        }
        // affiliation
        if (!Object.prototype.hasOwnProperty.call(s, 'affiliation')) {
          s.affiliation = '';
        }
        // history/meds/allergies arrays may be stored as strings; normalise to array
        if (!Array.isArray(s.history)) s.history = s.history ? String(s.history).split(',').map((t) => t.trim()).filter(Boolean) : [];
        if (!Array.isArray(s.meds)) s.meds = s.meds ? String(s.meds).split(',').map((t) => t.trim()).filter(Boolean) : [];
        if (!Array.isArray(s.allergies)) s.allergies = s.allergies ? String(s.allergies).split(',').map((t) => t.trim()).filter(Boolean) : [];
      });
    }
    saveMaster();
  }

  function saveMaster() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(masterData));
    } catch (err) {
      console.warn('master save error', err);
    }
  }

  /** =========================
   *  View switching
   *  ========================= */
  let currentView = 'view-login';
  const topbarTitle = $('#topbarTitle');
  const btnBack = $('#btnBack');
  const btnLogout = $('#btnLogout');

  function showView(id) {
    // Hide all
    $$('section.view').forEach((v) => v.classList.remove('active'));
    // Show desired view
    const el = $('#' + id);
    if (el) el.classList.add('active');
    currentView = id;
    // Always scroll to top when switching views
    window.scrollTo(0, 0);
    // Adjust topbar
    if (id === 'view-login') {
      btnBack.style.display = 'none';
      btnLogout.style.display = 'none';
      topbarTitle.textContent = '想をトドケル';
    } else {
      btnBack.style.display = '';
      btnLogout.style.display = '';
      if (id === 'view-input') {
        topbarTitle.textContent = '照合';
      } else if (id === 'view-result') {
        topbarTitle.textContent = '職員情報';
      } else if (id === 'view-edit-tsunagu') {
        topbarTitle.textContent = '編集';
      } else if (id === 'view-showcase') {
        // 照合後に表示する照会モード
        topbarTitle.textContent = '照会';
      } else if (id === 'view-admin') {
        topbarTitle.textContent = '管理';
      }
    }
  }

  btnBack.addEventListener('click', () => {
    if (currentView === 'view-input') {
      showView('view-login');
    } else if (currentView === 'view-result') {
      showView('view-input');
    } else if (currentView === 'view-admin') {
      showView('view-login');
    }
  });

  btnLogout.addEventListener('click', () => {
    showView('view-login');
  });

  /** =========================
   *  Login handlers
   *  ========================= */
  $('#btnUserLogin').addEventListener('click', async () => {
    const pw = $('#userPassword').value.trim();
    if (!pw) {
      toast('パスワードを入力してください');
      return;
    }
    const hash = await sha256Hex(pw);
    if (hash === masterData.userPasswordHash) {
      $('#userPassword').value = '';
      showView('view-input');
    } else {
      toast('パスワードが違います');
    }
  });

  $('#btnAdminLogin').addEventListener('click', async () => {
    const id = $('#adminId').value.trim();
    const pw = $('#adminPassword').value.trim();
    if (!id || !pw) {
      toast('IDとパスワードを入力してください');
      return;
    }
    const hash = await sha256Hex(pw);
    if (id === masterData.adminId && hash === masterData.adminPasswordHash) {
      $('#adminId').value = '';
      $('#adminPassword').value = '';
      buildStaffTable();
      showView('view-admin');
    } else {
      toast('IDまたはパスワードが違います');
    }
  });

  /** =========================
   *  Extract ID from SMS input
   *  ========================= */
  function extractIdFromSMS(text) {
    if (!text) return '';
    // Replace Japanese commas and newlines with spaces, then split
    const tokens = text
      .replace(/[\n\r]/g, ' ')
      .replace(/[、，]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    for (const token of tokens) {
      // Accept IDs that are alphanumeric/underscore/hyphen and at least 2 chars
      if (/^[A-Za-z0-9_-]{2,}$/.test(token)) {
        return token;
      }
    }
    return '';
  }

  /**
   * SMS本文からツナゲル情報を抽出します。
   * フォーマット例：
   *   連絡時間: 2025-01-01 12:00\n職員ID: S001\n場所: A棟\n状態1: 意識なし\n状態2: 呼吸なし\n事故種別: 挟まれ
   * 項目が見つからない場合は空文字列となります。
   */
  function parseSmsInfo(text) {
    const result = { contactTime: '', empId: '', location: '', status1: '', status2: '', accident: '' };
    if (!text) return result;
    try {
      // 連絡時間
      const timeMatch = text.match(/連絡時間[：:]+\s*([^\n\r]+)/);
      if (timeMatch) result.contactTime = timeMatch[1].trim();
      // 職員ID
      const empIdMatch = text.match(/職員ID[：:]+\s*([^\n\r]+)/);
      if (empIdMatch) result.empId = empIdMatch[1].trim();
      // 場所
      const locMatch = text.match(/場所[：:]+\s*([^\n\r]+)/);
      if (locMatch) result.location = locMatch[1].trim();
      // 状態1
      const s1Match = text.match(/状態1[：:]+\s*([^\n\r]+)/);
      if (s1Match) result.status1 = s1Match[1].trim();
      // 状態2
      const s2Match = text.match(/状態2[：:]+\s*([^\n\r]+)/);
      if (s2Match) result.status2 = s2Match[1].trim();
      // 事故種別
      const accMatch = text.match(/事故種別[：:]+\s*([^\n\r]+)/);
      if (accMatch) result.accident = accMatch[1].trim();
    } catch (err) {
      console.warn('SMS parse error', err);
    }
    return result;
  }

  $('#smsInput').addEventListener('input', (ev) => {
    const id = extractIdFromSMS(ev.target.value);
    $('#empId').value = id;
  });

  /** =========================
   *  Match button handler
   *  ========================= */
  let currentTsunaguInfo = null;
  let currentStaff = null;
  $('#btnMatch').addEventListener('click', () => {
    // まずSMS本文から情報を解析
    const smsText = $('#smsInput').value.trim();
    const smsInfo = parseSmsInfo(smsText);
    // 職員IDは入力欄優先、なければSMS内から
    let id = $('#empId').value.trim();
    if (!id && smsInfo.empId) {
      id = smsInfo.empId;
      $('#empId').value = id;
    }

    // 「SMSを貼り付けて照合」画面でID入力（QR/氏名検索/手入力）した場合でも、
    // 次の「職員情報」で職員IDが表示・引き継がれるように、
    // ツナゲル情報（smsInfo）にも必ず反映しておく。
    if (id && !smsInfo.empId) {
      smsInfo.empId = id;
    }

    if (!id) {
      toast('職員IDを入力してください');
      return;
    }
    const staff = masterData.staff.find((s) => s.id === id);
    if (!staff) {
      toast('該当する職員が見つかりません');
      return;
    }
    currentTsunaguInfo = smsInfo;
    currentStaff = staff;
    renderResultView();
    showView('view-result');
  });

  function renderStaffInfo(staff) {
    const container = $('#resultCard');
    const rows = [];
    rows.push(
      `<div class="info-row"><span>氏名</span><strong>${escapeHtml(
        staff.name
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>生年月日</span><strong>${escapeHtml(
        staff.birthday || '不明'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>血液型</span><strong>${escapeHtml(
        staff.blood || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>既往歴</span><strong>${escapeHtml(
        Array.isArray(staff.history) ? staff.history.join('、') : staff.history || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>薬剤情報</span><strong>${escapeHtml(
        Array.isArray(staff.meds) ? staff.meds.join('、') : staff.meds || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>アレルギー</span><strong>${escapeHtml(
        Array.isArray(staff.allergies)
          ? staff.allergies.join('、')
          : staff.allergies || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>かかりつけ医</span><strong>${escapeHtml(
        staff.doctor || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>緊急連絡先（続柄）</span><strong>${escapeHtml(
        staff.contactRel || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>緊急連絡先（電話番号）</span><strong>${escapeHtml(
        staff.contactTel || '-'
      )}</strong></div>`
    );
    container.innerHTML = rows.join('');
  }

  /**
   * 職員情報画面を更新する
   */
  function renderResultView() {
    const tsCard = $('#tunaguInfoCard');
    const tdCard = $('#todokeruInfoCard');
    if (!currentTsunaguInfo || !currentStaff) return;
    // ツナゲル情報の表示
    const tsRows = [];
    tsRows.push(`<h3>ツナゲル情報</h3>`);
    const contactTime = currentTsunaguInfo.contactTime || '不明';
    const emp = currentTsunaguInfo.empId || '不明';
    const loc = currentTsunaguInfo.location || '不明';
    const st1 = currentTsunaguInfo.status1 || '不明';
    const st2 = currentTsunaguInfo.status2 || '不明';
    const acc = currentTsunaguInfo.accident || '不明';
    tsRows.push(`<div class="info-row"><span>連絡時間</span><strong>${escapeHtml(contactTime)}</strong></div>`);
    tsRows.push(`<div class="info-row"><span>職員ID</span><strong>${escapeHtml(emp)}</strong></div>`);
    tsRows.push(`<div class="info-row"><span>場所</span><strong>${escapeHtml(loc)}</strong></div>`);
    tsRows.push(`<div class="info-row"><span>状態1</span><strong>${escapeHtml(st1)}</strong></div>`);
    tsRows.push(`<div class="info-row"><span>状態2</span><strong>${escapeHtml(st2)}</strong></div>`);
    tsRows.push(`<div class="info-row"><span>事故種別</span><strong>${escapeHtml(acc)}</strong></div>`);
    tsCard.innerHTML = tsRows.join('');
    // トドケル情報の表示
    const tdRows = [];
    tdRows.push(`<h3>トドケル情報</h3>`);
    tdRows.push(`<div class="info-row"><span>氏名</span><strong>${escapeHtml(currentStaff.name || '不明')}</strong></div>`);
    // 所属: 職員の会社や部門名を表示します
    tdRows.push(`<div class="info-row"><span>所属</span><strong>${escapeHtml(currentStaff.affiliation || '不明')}</strong></div>`);
    tdRows.push(`<div class="info-row"><span>生年月日</span><strong>${escapeHtml(currentStaff.birthday || '不明')}</strong></div>`);
    tdRows.push(`<div class="info-row"><span>血液型</span><strong>${escapeHtml(currentStaff.blood || '不明')}</strong></div>`);
    tdRows.push(`<div class="info-row"><span>既往歴</span><strong>${escapeHtml(Array.isArray(currentStaff.history) ? (currentStaff.history.length ? currentStaff.history.join('、') : '不明') : currentStaff.history || '不明')}</strong></div>`);
    tdRows.push(`<div class="info-row"><span>薬剤情報</span><strong>${escapeHtml(Array.isArray(currentStaff.meds) ? (currentStaff.meds.length ? currentStaff.meds.join('、') : '不明') : currentStaff.meds || '不明')}</strong></div>`);
    tdRows.push(`<div class="info-row"><span>アレルギー</span><strong>${escapeHtml(Array.isArray(currentStaff.allergies) ? (currentStaff.allergies.length ? currentStaff.allergies.join('、') : '不明') : currentStaff.allergies || '不明')}</strong></div>`);
    tdRows.push(`<div class="info-row"><span>かかりつけ医</span><strong>${escapeHtml(currentStaff.doctor || '不明')}</strong></div>`);
    tdRows.push(`<div class="info-row"><span>緊急連絡先（続柄）</span><strong>${escapeHtml(currentStaff.contactRel || '不明')}</strong></div>`);
    tdRows.push(`<div class="info-row"><span>緊急連絡先（電話番号）</span><strong>${escapeHtml(currentStaff.contactTel || '不明')}</strong></div>`);
    tdCard.innerHTML = tdRows.join('');
  }

  /**
   * 紹介モード表示を生成する
   */
  function renderShowcase() {
    const card = $('#showcaseCard');
    if (!currentTsunaguInfo || !currentStaff) return;
    const rows = [];
    // トドケル情報（職員ID、生年月日は非表示）
    rows.push(`<div class="info-row"><span>氏名</span><strong>${escapeHtml(currentStaff.name || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>生年月日</span><strong>${escapeHtml(currentStaff.birthday || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>血液型</span><strong>${escapeHtml(currentStaff.blood || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>既往歴</span><strong>${escapeHtml(Array.isArray(currentStaff.history) ? (currentStaff.history.length ? currentStaff.history.join('、') : '不明') : currentStaff.history || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>薬剤情報</span><strong>${escapeHtml(Array.isArray(currentStaff.meds) ? (currentStaff.meds.length ? currentStaff.meds.join('、') : '不明') : currentStaff.meds || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>アレルギー</span><strong>${escapeHtml(Array.isArray(currentStaff.allergies) ? (currentStaff.allergies.length ? currentStaff.allergies.join('、') : '不明') : currentStaff.allergies || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>かかりつけ医</span><strong>${escapeHtml(currentStaff.doctor || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>緊急連絡先（続柄）</span><strong>${escapeHtml(currentStaff.contactRel || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>緊急連絡先（電話番号）</span><strong>${escapeHtml(currentStaff.contactTel || '不明')}</strong></div>`);
    // ツナゲル情報も表示（職員IDを除く）
    rows.push(`<div class="info-row"><span>連絡時間</span><strong>${escapeHtml(currentTsunaguInfo.contactTime || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>場所</span><strong>${escapeHtml(currentTsunaguInfo.location || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>状態1</span><strong>${escapeHtml(currentTsunaguInfo.status1 || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>状態2</span><strong>${escapeHtml(currentTsunaguInfo.status2 || '不明')}</strong></div>`);
    rows.push(`<div class="info-row"><span>事故種別</span><strong>${escapeHtml(currentTsunaguInfo.accident || '不明')}</strong></div>`);
    card.innerHTML = rows.join('');
  }

  // 結果画面から戻るボタンは他の場所で定義

  /** =========================
   *  Admin functions
   *  ========================= */
  let editingIndex = -1;

  function buildStaffTable() {
    const tbody = $('#staffTable tbody');
    tbody.innerHTML = '';
    masterData.staff.forEach((s, idx) => {
      const tr = document.createElement('tr');

      const tdId = document.createElement('td');
      tdId.textContent = s.id || '';

      const tdName = document.createElement('td');
      tdName.textContent = s.name || '';

      const tdKana = document.createElement('td');
      tdKana.textContent = s.kana || '';

      const tdBirthday = document.createElement('td');
      tdBirthday.textContent = s.birthday || '不明';

      const opTd = document.createElement('td');
      const btnEdit = document.createElement('button');
      btnEdit.textContent = '編集';
      btnEdit.className = 'edit';
      btnEdit.addEventListener('click', () => openStaffForm(idx));
      const btnDel = document.createElement('button');
      btnDel.textContent = '削除';
      btnDel.className = 'delete';
      btnDel.addEventListener('click', () => deleteStaff(idx));
      opTd.appendChild(btnEdit);
      opTd.appendChild(btnDel);

      tr.appendChild(tdId);
      tr.appendChild(tdName);
      tr.appendChild(tdKana);
      tr.appendChild(tdBirthday);
      tr.appendChild(opTd);
      tbody.appendChild(tr);
    });

  }

  function openStaffForm(index) {
    // index == -1 for new
    editingIndex = index;
    const isNew = index === -1;
    $('#staffFormTitle').textContent = isNew ? '職員追加' : '職員編集';
    const form = $('#staffFormContainer');
    form.classList.remove('hidden');
    if (isNew) {
      $('#staffBirthday').value = '';
      $('#staffName').value = '';
      $('#staffKana').value = '';
      $('#staffAffiliation').value = '';
      $('#staffBlood').value = '';
      $('#staffHistory').value = '';
      $('#staffMeds').value = '';
      $('#staffAllergy').value = '';
      $('#staffDoctor').value = '';
      $('#staffContactRel').value = '';
      $('#staffContactTel').value = '';
      // IDは連番で生成（S + 現在数 + 1）
      const nextIdNum = masterData.staff.length + 1;
      $('#staffId').value = 'S' + String(nextIdNum).padStart(3, '0');
    } else {
      const s = masterData.staff[index];
      $('#staffBirthday').value = s.birthday || '';
      $('#staffName').value = s.name;
      $('#staffKana').value = s.kana || '';
      $('#staffAffiliation').value = s.affiliation || '';
      $('#staffBlood').value = s.blood || '';
      $('#staffHistory').value = Array.isArray(s.history) ? s.history.join(',') : s.history || '';
      $('#staffMeds').value = Array.isArray(s.meds) ? s.meds.join(',') : s.meds || '';
      $('#staffAllergy').value = Array.isArray(s.allergies)
        ? s.allergies.join(',')
        : s.allergies || '';
      $('#staffDoctor').value = s.doctor || '';
      $('#staffContactRel').value = s.contactRel || '';
      $('#staffContactTel').value = s.contactTel || '';
      $('#staffId').value = s.id;
    }
  }

  function closeStaffForm() {
    $('#staffFormContainer').classList.add('hidden');
    editingIndex = -1;
  }

  $('#btnAddStaff').addEventListener('click', () => openStaffForm(-1));
  $('#btnCancelStaff').addEventListener('click', () => closeStaffForm());
  $('#staffFormContainer').addEventListener('click', (e) => {
    if (e.target === $('#staffFormContainer')) {
      closeStaffForm();
    }
  });

  $('#btnSaveStaff').addEventListener('click', () => {
    const id = $('#staffId').value.trim();
    const birthday = $('#staffBirthday').value.trim();
    const name = $('#staffName').value.trim();
    const kana = $('#staffKana').value.trim();
    if (!id || !name) {
      toast('職員IDと氏名は必須です');
      return;
    }
    const blood = $('#staffBlood').value.trim();
    const affiliation = $('#staffAffiliation').value.trim();
    const history = $('#staffHistory').value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const meds = $('#staffMeds').value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const allergies = $('#staffAllergy').value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const doctor = $('#staffDoctor').value.trim();
    const contactRel = $('#staffContactRel').value.trim();
    const contactTel = $('#staffContactTel').value.trim();
    const obj = {
      id,
      name,
      kana,
      affiliation,
      birthday,
      blood,
      history,
      meds,
      allergies,
      doctor,
      contactRel,
      contactTel
    };
    if (editingIndex === -1) {
      // New: check duplicate
      const exists = masterData.staff.find((s) => s.id === id);
      if (exists) {
        toast('同じIDの職員が既に存在します');
        return;
      }
      masterData.staff.push(obj);
      toast('職員を追加しました');
    } else {
      masterData.staff[editingIndex] = obj;
      toast('職員を更新しました');
    }
    saveMaster();
    buildStaffTable();
    closeStaffForm();
  });

  function deleteStaff(index) {
    const s = masterData.staff[index];
    if (!s) return;
    if (!confirm(`「${s.name}」を削除しますか？`)) return;
    masterData.staff.splice(index, 1);
    saveMaster();
    buildStaffTable();
    toast('削除しました');
  }

  // Restore demo staff master (useful when localStorage has old/dirty data)
  const restoreDemoBtn = document.getElementById('btnRestoreDemo');
  if (restoreDemoBtn) {
    restoreDemoBtn.addEventListener('click', () => {
      const ok = confirm('デモ用の職員マスタに復元します。現在の職員マスタは上書きされます。よろしいですか？');
      if (!ok) return;
      masterData.staff = DEFAULT_STAFF.map((s) => ({ ...s }));
      // 互換性補完
      masterData.staff = masterData.staff.map((s) => ({
        ...s,
        kana: (s && (s.kana ?? s.reading ?? s.yomi ?? '')) || ''
      }));
      saveMaster();
      buildStaffTable();
      toast('デモマスタに復元しました');
    });
  }

  // Export master data as JSON file
  $('#btnExport').addEventListener('click', () => {
    const dataStr = JSON.stringify(masterData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tsunageru_master.json';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Import master data from JSON file
  $('#importFile').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const obj = JSON.parse(e.target.result);
        // Simple validation
        if (!obj || !Array.isArray(obj.staff)) {
          throw new Error('不正なデータです');
        }
        masterData = obj;
        saveMaster();
        buildStaffTable();
        toast('インポートしました');
      } catch (err) {
        toast('インポートに失敗しました');
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be selected again
    ev.target.value = '';
  });

  // Update user password
  $('#btnSetUserPassword').addEventListener('click', async () => {
    const newPw = $('#newUserPassword').value.trim();
    if (!newPw) {
      toast('新しい利用者パスワードを入力してください');
      return;
    }
    masterData.userPasswordHash = await sha256Hex(newPw);
    saveMaster();
    $('#newUserPassword').value = '';
    toast('利用者パスワードを更新しました');
  });

  // Update admin credentials
  $('#btnSetAdminCredentials').addEventListener('click', async () => {
    const newId = $('#newAdminId').value.trim();
    const newPw = $('#newAdminPassword').value.trim();
    if (!newId || !newPw) {
      toast('新しい管理者IDとパスワードを入力してください');
      return;
    }
    masterData.adminId = newId;
    masterData.adminPasswordHash = await sha256Hex(newPw);
    saveMaster();
    $('#newAdminId').value = '';
    $('#newAdminPassword').value = '';
    toast('管理者ID/パスワードを更新しました');
  });

  /**
   * その他イベントハンドラ
   */
  // 管理者ログイン入り口の表示/非表示切替
  $('#btnAdminEntry').addEventListener('click', () => {
    const sec = $('#adminLoginSection');
    if (sec.classList.contains('hidden')) {
      sec.classList.remove('hidden');
    } else {
      sec.classList.add('hidden');
    }
  });
  // ヘルメットQRを読む: カメラによるQR読み取りを開始します（新UI）
  $('#btnScanHelmet').addEventListener('click', () => {
    openQrModal('helmet', document.getElementById('empId'));
  });
  // 氏名で探す: 検索モーダルを開きます（新UI）
  $('#btnSearchName').addEventListener('click', () => {
    openNameModal('input');
  });
  // クリアボタン
  $('#btnClear').addEventListener('click', () => {
    $('#smsInput').value = '';
    $('#empId').value = '';
    currentTsunaguInfo = null;
    currentStaff = null;
  });
  // 結果画面: 戻る
  $('#btnResultBack').addEventListener('click', () => {
    showView('view-input');
  });
  // ツナゲル情報の編集
  $('#btnEditTunagu').addEventListener('click', () => {
    if (!currentTsunaguInfo) return;
    // Populate edit fields
    // 連絡時間が未設定の場合は現在時刻を設定します（YYYY/MM/DD HH:MM形式）
    let ct = currentTsunaguInfo.contactTime;
    if (!ct) {
      const now = new Date();
      // 2桁ゼロ埋め関数
      const pad = (n) => String(n).padStart(2, '0');
      ct = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    document.getElementById('editContactTime').value = ct;
    $('#editEmpId').value = currentTsunaguInfo.empId || '';
    // Display staff name if available
    const nameField = document.getElementById('editEmpName');
    if (nameField && currentStaff && currentStaff.name) {
      nameField.value = currentStaff.name;
    }
    $('#editLocation').value = currentTsunaguInfo.location || '';
    $('#editStatus1').value = currentTsunaguInfo.status1 || '';
    $('#editStatus2').value = currentTsunaguInfo.status2 || '';
    $('#editAccident').value = currentTsunaguInfo.accident || '';
    // Reflect status values to radio inputs
    const s1 = currentTsunaguInfo.status1 || '';
    const s2 = currentTsunaguInfo.status2 || '';
    // Helper to extract value for a category
    function pickValue(str, label) {
      const idx = str.indexOf(label);
      if (idx >= 0) {
        const sub = str.substring(idx + label.length);
        const m = sub.match(/あり|なし|不明/);
        return m ? m[0] : '不明';
      }
      return '不明';
    }
    const conc = pickValue(s1, '意識') || '不明';
    const breath = pickValue(s1, '呼吸') || '不明';
    const bleed = pickValue(s2, '大量出血') || '不明';
    const pain = pickValue(s2, '強い痛み') || '不明';
    const setRadio = (name, value) => {
      const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
      if (el) el.checked = true;
    };
    setRadio('status-conscious', conc);
    setRadio('status-breathing', breath);
    setRadio('status-bleeding', bleed);
    setRadio('status-pain', pain);
    updateStatusFields();
    // Reflect accident labels
    const acc = currentTsunaguInfo.accident || '';
    const labels = acc ? acc.split('、').filter(Boolean) : [];
    const icons = document.querySelectorAll('#accidentIcons .acc-item');
    icons.forEach((it) => {
      const lbl = it.dataset.label;
      if (labels.includes(lbl)) {
        it.classList.add('active');
      } else {
        it.classList.remove('active');
      }
    });
    // update hidden accident
    const accField = document.getElementById('editAccident');
    if (accField) accField.value = labels.join('、');
    showView('view-edit-tsunagu');
  });
  // 編集完了ボタン
  $('#btnEditDone').addEventListener('click', () => {
    // Save edited values back to currentTsunaguInfo
    if (!currentTsunaguInfo) currentTsunaguInfo = {};
    currentTsunaguInfo.contactTime = $('#editContactTime').value.trim();
    currentTsunaguInfo.empId = $('#editEmpId').value.trim();
    currentTsunaguInfo.location = $('#editLocation').value.trim();
    currentTsunaguInfo.status1 = $('#editStatus1').value.trim();
    currentTsunaguInfo.status2 = $('#editStatus2').value.trim();
    currentTsunaguInfo.accident = $('#editAccident').value.trim();
    renderResultView();
    showView('view-result');
  });
  // 編集キャンセルボタン
  $('#btnEditCancel').addEventListener('click', () => {
    // 編集を反映しないか確認
    const ok = confirm('編集した情報は反映されません。戻りますか？');
    if (ok) {
      showView('view-result');
    }
  });
  // 紹介モード
  $('#btnShowcase').addEventListener('click', () => {
    const ok = confirm('次の画面を消防隊に提示してください');
    if (ok) {
      renderShowcase();
      showView('view-showcase');
    }
  });
  // 紹介モードを終わる（結果画面）
  $('#btnEndShowcase').addEventListener('click', () => {
    const ok = confirm('現在の入力内容は消去されます');
    if (ok) {
      // Reset current info and return to input view
      $('#smsInput').value = '';
      $('#empId').value = '';
      currentTsunaguInfo = null;
      currentStaff = null;
      showView('view-input');
    }
  });
  // 紹介モード画面終了ボタン
  $('#btnShowcaseEnd').addEventListener('click', () => {
    const ok = confirm('あなたは職員ですか？');
    if (ok) {
      // はい: 職員情報画面に戻る
      renderResultView();
      showView('view-result');
    } else {
      // いいえ: 照合画面に戻る
      $('#smsInput').value = '';
      $('#empId').value = '';
      currentTsunaguInfo = null;
      currentStaff = null;
      showView('view-input');
    }
  });

  // === 編集画面用の追加ハンドラ ===
  // ヘルメットQRを読む（編集画面）
  const btnEditScanHelmet = document.getElementById('btnEditScanHelmet');
  if (btnEditScanHelmet) {
    btnEditScanHelmet.addEventListener('click', () => {
      openQrModal('helmet', document.getElementById('editEmpId'));
    });
  }
  // 氏名で探す（編集画面）
  const btnEditSearchName = document.getElementById('btnEditSearchName');
  if (btnEditSearchName) {
    btnEditSearchName.addEventListener('click', () => {
      openNameModal('edit');
    });
  }
  // 場所QRを読む（編集画面）
  const btnEditScanLocation = document.getElementById('btnEditScanLocation');
  if (btnEditScanLocation) {
    btnEditScanLocation.addEventListener('click', () => {
      openQrModal('location', document.getElementById('editLocation'));
    });
  }
  // 地図から選択（編集画面）
  const btnEditMapSelect = document.getElementById('btnEditMapSelect');
  if (btnEditMapSelect) {
    btnEditMapSelect.addEventListener('click', () => {
      openMapModal();
    });
  }
  // マップモーダルのエリアボタン
  document.querySelectorAll('.map-area-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const area = btn.dataset.area;
      const detailImg = document.getElementById('mapDetailImg');
      if (detailImg) {
        detailImg.src = `map_area${area}.png`;
        detailImg.style.display = 'block';
      }
      // ロケーションの自動設定は行わず、別途「この場所を使う」で決定します
    });
  });
  // マップモーダル: キャンセル
  const btnMapSelectCancel = document.getElementById('btnMapSelectCancel');
  if (btnMapSelectCancel) {
    btnMapSelectCancel.addEventListener('click', () => {
      const mapModal = document.getElementById('mapModal');
      if (mapModal) mapModal.classList.add('hidden');
    });
  }

  /**
   * =========================
   * 追加機能: QR読み取り・氏名検索・状態/事故・地図選択
   * =========================
   */

  // --- 氏名検索モーダル ---
  function openNameModal(context) {
    const modal = document.getElementById('nameModal');
    if (!modal) return;
    // Remember context: which field to set (input or edit)
    modal.dataset.context = context;
    // Reset search and populate list
    const search = document.getElementById('nameSearchInput');
    if (search) {
      search.value = '';
      populateNameList('');
      search.oninput = () => {
        populateNameList(search.value);
      };
    }
    modal.classList.remove('hidden');
  }
  function closeNameModal() {
    const modal = document.getElementById('nameModal');
    if (!modal) return;
    modal.classList.add('hidden');
    // Clean list
    const list = document.getElementById('nameList');
    if (list) list.innerHTML = '';
  }
  function toHiragana(str) {
    return (str || '').replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  }

  function normalizeKana(str) {
    return toHiragana(String(str || '')).replace(/\s+/g, '').trim();
  }

  function populateNameList(query) {
    const list = document.getElementById('nameList');
    if (!list) return;
    list.innerHTML = '';
    const q = (query || '').trim();
    // filter by 読み仮名(kana) or 氏名 (1文字でも検索可能)
    const qRaw = (query || '').trim();
    const qKana = normalizeKana(qRaw);
    const items = masterData.staff.filter((s) => {
      if (!s || !s.name) return false;
      if (!qRaw) return true;
      const nameHit = String(s.name).includes(qRaw);
      const kanaHit = qKana ? normalizeKana(s.kana).includes(qKana) : false;
      return nameHit || kanaHit;
    });
    items.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'name-item';
      div.innerHTML = `<span>${escapeHtml(s.name)}</span>` +
        `<span class="sub" style="font-size:12px;color:var(--muted);">${escapeHtml(s.kana || '')} / ${escapeHtml(s.id)}</span>`;
      div.addEventListener('click', () => {
        const modal = document.getElementById('nameModal');
        const ctx = modal ? modal.dataset.context : 'input';
        if (ctx === 'edit') {
          document.getElementById('editEmpId').value = s.id;
          // Also display the name in the edit name field
          const nameField = document.getElementById('editEmpName');
          if (nameField) nameField.value = s.name;
        } else {
          document.getElementById('empId').value = s.id;
        }
        toast(`${escapeHtml(s.name)} (ID: ${escapeHtml(s.id)}) を選択しました`);
        closeNameModal();
      });
      list.appendChild(div);
    });
    if (!items.length) {
      const div = document.createElement('div');
      div.className = 'name-item';
      div.textContent = '該当者なし';
      list.appendChild(div);
    }
  }

  // Close button for name modal
  const btnNameClose = document.getElementById('btnNameClose');
  if (btnNameClose) {
    btnNameClose.addEventListener('click', () => closeNameModal());
  }

  // --- QRモーダル ---
  function openQrModal(purpose, targetEl, targetNameEl = null) {
    qrPurpose = purpose;
    qrTarget = targetEl;
    qrNameTarget = targetNameEl;
    selectedLocation = null;
    const modal = document.getElementById('qrModal');
    if (!modal) return;
    // Set title
    const titleEl = document.getElementById('qrModalTitle');
    if (titleEl) {
      titleEl.textContent = purpose === 'location' ? '場所QRを読み取ってください' : 'ヘルメットQRを読み取ってください';
    }
    // Hide manual input
    const manualWrap = document.getElementById('qrManualInput');
    if (manualWrap) manualWrap.classList.add('hidden');
    // Reset status
    const statusEl = document.getElementById('qrStatus');
    if (statusEl) statusEl.textContent = '';
    // Show video
    const video = document.getElementById('qrVideo');
    if (video) video.style.display = 'block';
    modal.classList.remove('hidden');
    startQrCamera();
  }
  function closeQrModal() {
    stopQrCamera();
    const modal = document.getElementById('qrModal');
    if (modal) modal.classList.add('hidden');
    // Reset manual input
    const manualWrap = document.getElementById('qrManualInput');
    if (manualWrap) manualWrap.classList.add('hidden');
    const video = document.getElementById('qrVideo');
    if (video) video.style.display = 'none';
  }
  async function startQrCamera() {
    const video = document.getElementById('qrVideo');
    const statusEl = document.getElementById('qrStatus');
    // Ensure playsinline for iOS Safari to prevent fullscreen video
    if (video) {
      video.setAttribute('playsinline', '');
    }
    // Check camera availability
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (statusEl) statusEl.textContent = 'このブラウザではカメラが利用できません。写真で読み取るか手入力してください。';
      return;
    }
    try {
      // Dispose of any existing scanner before starting a new one
      if (qrScanner) {
        try { await qrScanner.stop(); } catch {}
        try { qrScanner.destroy && qrScanner.destroy(); } catch {}
        qrScanner = null;
      }
      // Initialize QrScanner.  The callback receives either a string or an
      // object with a `data` property depending on the options passed.  We
      // normalise the result to a trimmed string.
      qrScanner = new QrScanner(
        video,
        (result) => {
          const raw = (result && typeof result === 'object' && 'data' in result) ? result.data : result;
          if (raw) {
            onQrRead(String(raw).trim());
          }
        },
        { returnDetailedScanResult: true }
      );
      await qrScanner.start();
      if (statusEl) statusEl.textContent = 'カメラ起動中… QRを枠内に合わせてください。';
    } catch (err) {
      console.warn('QrScanner start failed', err);
      if (statusEl) statusEl.textContent = 'カメラの起動に失敗しました。写真読み取りか手入力を使ってください。';
    }
  }
  function stopQrCamera() {
    // Stop scanning and release camera resources
    qrRunning = false;
    try {
      if (qrScanner) {
        qrScanner.stop();
        if (typeof qrScanner.destroy === 'function') {
          qrScanner.destroy();
        }
        qrScanner = null;
      }
    } catch {}
    try {
      const video = document.getElementById('qrVideo');
      if (video && video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      }
    } catch {}
    qrStream = null;
  }
  async function qrLoop() {
    // This function is kept for backward compatibility but is no longer used.
    // All QR decoding is handled by QrScanner, which calls the callback
    // automatically when a code is detected.
    return;
  }

  // --- QR parsing helpers ----------------------------------------------------
  // QR payloads can contain decorated text like "STAFF｜S001｜佐藤 一郎" or
  // "職員ID：S001 氏名：佐藤 一郎". These helpers extract only the parts we need.

  function normalizeQrString(input) {
    return String(input || '')
      .replace(/\u3000/g, ' ') // full-width space
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
  }

  function tryParseJsonObject(input) {
    const t = normalizeQrString(input);
    if (!t) return null;
    if (!(t.startsWith('{') && t.endsWith('}'))) return null;
    try {
      const obj = JSON.parse(t);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch {
      return null;
    }
  }

  function parseHelmetQr(raw) {
    const rawNorm = normalizeQrString(raw);
    const obj = tryParseJsonObject(rawNorm);

    let staffId = null;
    let name = null;

    if (obj) {
      staffId = obj.staffId || obj.staff_id || obj.employeeId || obj.employee_id || obj.id || obj.empId || null;
      name = obj.name || obj.staffName || obj.fullName || null;
    }

    // 1) Prefer explicit S*** pattern anywhere
    if (!staffId) {
      const m = rawNorm.match(/\bS\d{3,6}\b/i);
      if (m) staffId = String(m[0]).toUpperCase();
    }

    // 2) Decorated label formats: "職員ID: S001" etc.
    if (!staffId) {
      const m = rawNorm.match(/(?:職員\s*ID|職員ID|社員\s*ID|社員ID|ID)\s*[:：]?\s*([A-Za-z0-9_-]+)/i);
      if (m) staffId = String(m[1]).trim().toUpperCase();
    }

    // 3) Pipe/vertical-bar separated formats: STAFF｜S001｜佐藤 一郎
    const parts = rawNorm.split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
    if (!staffId && parts.length >= 2) {
      const cand = parts.find((p) => /^[Ss]\d{3,6}$/.test(p));
      if (cand) staffId = cand.toUpperCase();
    }
    if (!name) {
      if (parts.length >= 3) {
        // name is usually after the staffId if present, otherwise last segment
        let idx = -1;
        if (staffId) {
          idx = parts.findIndex((p) => p.toUpperCase() == String(staffId).toUpperCase());
        }
        if (idx >= 0 && idx + 1 < parts.length) {
          name = parts.slice(idx + 1).join(' ');
        } else {
          name = parts[parts.length - 1];
        }
      }
    }

    // 4) Label-based name extraction
    if (!name) {
      const m = rawNorm.match(/(?:氏名|名前|name)\s*[:：]\s*([^\n]+)/i);
      if (m) name = String(m[1]).trim();
    }

    // 5) Plain whitespace format: "S001 佐藤 一郎"
    if (!name && staffId) {
      const sid = String(staffId).toUpperCase();
      const one = rawNorm.replace(/[｜|]/g, ' ').replace(/\s+/g, ' ').trim();
      const upper = one.toUpperCase();
      if (upper.startsWith(sid + ' ')) {
        name = one.slice(sid.length).trim();
      }
    }

    return { raw: rawNorm, staffId, name, obj };
  }

  function parseLocationQr(raw) {
    const rawNorm = normalizeQrString(raw);
    const obj = tryParseJsonObject(rawNorm);

    let name = null;

    if (obj) {
      name = obj.name || obj.location || obj.place || obj.placeName || obj.locName || null;
    }

    if (!name) {
      const m = rawNorm.match(/(?:場所|現場|ロケーション|location|place)\s*[:：]\s*([^\n]+)/i);
      if (m) name = String(m[1]).trim();
    }

    if (!name) {
      // Pipe/vertical-bar separated formats: PLACE｜ブロック置場
      const parts = rawNorm.split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        name = parts[parts.length - 1];
      }
    }

    // If it's a single-line plain text QR, treat that as the location name
    if (!name && rawNorm && !rawNorm.includes('\n')) {
      name = rawNorm;
    }

    // Final cleanup
    if (name) {
      name = String(name).trim();
      name = name.replace(/^(?:PLACE|LOC|LOCATION)\s*[:：]?\s*/i, '').trim();
    }

    return { raw: rawNorm, name, obj };
  }


  function onQrRead(value) {
    // Once read, stop camera and handle value
    stopQrCamera();
    closeQrModal();
    if (!value) return;

    // Location QR
    if (qrPurpose === 'location') {
      const info = parseLocationQr(value);
      const loc = (info && info.name) ? info.name : normalizeQrString(value);
      if (qrTarget) qrTarget.value = loc;
      toast(`場所: ${escapeHtml(loc)} を設定しました`);
      return;
    }

    // Helmet QR
    const info = parseHelmetQr(value);
    const id = (info && info.staffId) ? info.staffId : normalizeQrString(value);
    const name = (info && info.name) ? info.name : '';

    const msg = name
      ? `職員ID：${escapeHtml(id)}　氏名：${escapeHtml(name)}
こちらの職員であっていますか？`
      : `職員ID：${escapeHtml(id)}
こちらの職員であっていますか？`;

    // Show confirm modal
    const confirmEl = document.getElementById('confirmModal');
    const confirmMsg = document.getElementById('confirmMessage');
    if (confirmEl && confirmMsg) {
      confirmMsg.innerHTML = msg.replace(/\n/g, '<br>');
      confirmEl.classList.remove('hidden');
      // Set handlers
      const okBtn = document.getElementById('btnConfirmOk');
      const cancelBtn = document.getElementById('btnConfirmCancel');
      const cleanup = () => {
        okBtn.replaceWith(okBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
      };
      okBtn.addEventListener('click', () => {
        // IMPORTANT: store ONLY the staff ID (e.g., "S001")
        if (qrTarget) qrTarget.value = id;
        // Optional name fill (if caller provided a separate target)
        if (qrNameTarget && name) {
          qrNameTarget.value = name;
        }
        confirmEl.classList.add('hidden');
        toast(`ID: ${escapeHtml(id)} を設定しました`);
        cleanup();
      });
      cancelBtn.addEventListener('click', () => {
        confirmEl.classList.add('hidden');
        cleanup();
      });
    } else {
      // fallback confirm() dialog
      const ok = window.confirm(msg);
      if (ok && qrTarget) {
        if (qrTarget) qrTarget.value = id;
        if (qrNameTarget && name) {
          qrNameTarget.value = name;
        }
        toast(`ID: ${escapeHtml(id)} を設定しました`);
      }
    }
  }
  // QR file decode fallback
  // QR file decode fallback
  async function decodeQrFromFile(file) {
    if (!file) return null;
    try {
      const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
      const raw = (result && typeof result === 'object' && 'data' in result) ? result.data : result;
      return raw ? String(raw).trim() : null;
    } catch {
      return null;
    }
  }
  // Buttons within QR modal
  const btnQrPhoto = document.getElementById('btnQrPhoto');
  if (btnQrPhoto) {
    btnQrPhoto.addEventListener('click', () => {
      const fileInput = document.getElementById('qrFile');
      if (fileInput) fileInput.click();
    });
  }
  const btnQrManual = document.getElementById('btnQrManual');
  if (btnQrManual) {
    btnQrManual.addEventListener('click', () => {
      stopQrCamera();
      const manualWrap = document.getElementById('qrManualInput');
      const video = document.getElementById('qrVideo');
      if (video) video.style.display = 'none';
      if (manualWrap) manualWrap.classList.remove('hidden');
    });
  }
  const qrFileInput = document.getElementById('qrFile');
  if (qrFileInput) {
    qrFileInput.addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const raw = await decodeQrFromFile(file);
      if (raw) {
        onQrRead(raw);
      } else {
        toast('QRコードを読み取れませんでした');
      }
      ev.target.value = '';
    });
  }
  const btnQrManualSubmit = document.getElementById('btnQrManualSubmit');
  if (btnQrManualSubmit) {
    btnQrManualSubmit.addEventListener('click', () => {
      const val = document.getElementById('qrManualText').value.trim();
      if (!val) {
        toast('QRコード内容を入力してください');
        return;
      }
      onQrRead(val);
    });
  }
  const btnQrCancel = document.getElementById('btnQrCancel');
  if (btnQrCancel) {
    btnQrCancel.addEventListener('click', () => {
      closeQrModal();
    });
  }

  // --- 状態・事故選択 ---
  function updateStatusFields() {
    // Gather selected options
    const conc = document.querySelector('input[name="status-conscious"]:checked')?.value || '不明';
    const breath = document.querySelector('input[name="status-breathing"]:checked')?.value || '不明';
    const bleed = document.querySelector('input[name="status-bleeding"]:checked')?.value || '不明';
    const pain = document.querySelector('input[name="status-pain"]:checked')?.value || '不明';
    // Compose strings
    const s1 = `意識${conc}、呼吸${breath}`;
    const s2 = `大量出血${bleed}、強い痛み${pain}`;
    const f1 = document.getElementById('editStatus1');
    const f2 = document.getElementById('editStatus2');
    if (f1) f1.value = s1;
    if (f2) f2.value = s2;
  }
  function initStatusHandlers() {
    document.querySelectorAll('#statusFields input[type="radio"]').forEach((r) => {
      r.addEventListener('change', updateStatusFields);
    });
    updateStatusFields();
  }
  // Accident icons initialization
  function initAccidentIcons() {
    const wrap = document.getElementById('accidentIcons');
    if (!wrap) return;
    wrap.innerHTML = '';
    const selected = new Set();
    accidentDefs.forEach((def) => {
      const div = document.createElement('div');
      div.className = 'acc-item';
      div.dataset.key = def.key;
      div.dataset.label = def.label;
      div.innerHTML = `<div class="icon">${def.icon}</div><div class="label">${def.label}</div>`;
      div.addEventListener('click', () => {
        if (div.classList.contains('active')) {
          div.classList.remove('active');
          selected.delete(def.label);
        } else {
          div.classList.add('active');
          selected.add(def.label);
        }
        // update hidden field
        const accField = document.getElementById('editAccident');
        if (accField) accField.value = Array.from(selected).join('、');
      });
      wrap.appendChild(div);
    });
  }

  // --- 地図選択 ---
  function openMapModal() {
    const mapModal = document.getElementById('mapModal');
    if (!mapModal) return;
    // Reset view to overview and clear any previous selection
    mapView = 'all';
    mapSelected = null;
    mapTap = null;
    setMapTabActive('all');
    renderYardSvg();
    renderMapCandidates();
    mapModal.classList.remove('hidden');
  }
  // Use location
  const btnMapUse = document.getElementById('btnMapUse');
  if (btnMapUse) {
    btnMapUse.addEventListener('click', () => {
      const mapModal = document.getElementById('mapModal');
      const locField = document.getElementById('editLocation');
      if (!locField) return;
      // Prioritise a place selection.  If a place is selected, use its name;
      // otherwise, if an area view is active (but no place), assign the
      // area label; if in the overview, do nothing.
      if (mapSelected) {
        locField.value = mapSelected.name;
      } else {
        if (mapView && mapView !== 'all') {
          locField.value = mapView === 'a1' ? 'エリア1' : mapView === 'a2' ? 'エリア2' : 'エリア3';
        }
      }
      if (mapModal) mapModal.classList.add('hidden');
    });
  }

  // Close map modal when clicking background? (handled by cancel button above)

  /**
   * Initialise custom UI on DOM load
   */
  function initCustomUi() {
    // Setup accident icons and status handlers
    initAccidentIcons();
    initStatusHandlers();
    // Override default helmet/ search buttons
    const btnScanHelmet = document.getElementById('btnScanHelmet');
    if (btnScanHelmet) {
      btnScanHelmet.addEventListener('click', () => {
        openQrModal('helmet', document.getElementById('empId'));
      });
    }
    const btnSearchName = document.getElementById('btnSearchName');
    if (btnSearchName) {
      btnSearchName.addEventListener('click', () => {
        openNameModal('input');
      });
    }
    // Edit screen buttons
    const btnEditScanHelmet = document.getElementById('btnEditScanHelmet');
    if (btnEditScanHelmet) {
      btnEditScanHelmet.addEventListener('click', () => {
        // Pass both ID and name fields for edit mode so name can be set
        openQrModal('helmet', document.getElementById('editEmpId'), document.getElementById('editEmpName'));
      });
    }
    const btnEditSearchName = document.getElementById('btnEditSearchName');
    if (btnEditSearchName) {
      btnEditSearchName.addEventListener('click', () => {
        openNameModal('edit');
      });
    }
    const btnEditScanLocation = document.getElementById('btnEditScanLocation');
    if (btnEditScanLocation) {
      btnEditScanLocation.addEventListener('click', () => {
        openQrModal('location', document.getElementById('editLocation'));
      });
    }
    const btnEditMapSelect = document.getElementById('btnEditMapSelect');
    if (btnEditMapSelect) {
      btnEditMapSelect.addEventListener('click', () => {
        openMapModal();
      });
    }

    // Map tab buttons (overview and area views) and reset zoom.
    // These handlers update the current mapView and refresh the SVG and
    // candidate list accordingly.  Reset returns the viewBox to its
    // default state for the current area.
    const mapButtons = {
      all: document.getElementById('btnMapViewAll'),
      a1: document.getElementById('btnMapViewA1'),
      a2: document.getElementById('btnMapViewA2'),
      a3: document.getElementById('btnMapViewA3'),
    };
    Object.entries(mapButtons).forEach(([key, el]) => {
      if (el) {
        el.addEventListener('click', () => {
          mapView = key;
          mapSelected = null;
          mapTap = null;
          setMapTabActive(key);
          renderYardSvg();
          renderMapCandidates();
        });
      }
    });
    const btnResetZoom = document.getElementById('btnMapResetZoom');
    if (btnResetZoom) {
      btnResetZoom.addEventListener('click', () => {
        // Clear any manual tap (unused but reserved) and re-render the area
        mapTap = null;
        renderYardSvg();
      });
    }
  }

  // Initialise on load
  document.addEventListener('DOMContentLoaded', async () => {
    await loadMaster();
    // Hide back/logout initially
    showView('view-login');
    // Initialise custom UI elements (status, accident, new handlers)
    initCustomUi();
  });
})();