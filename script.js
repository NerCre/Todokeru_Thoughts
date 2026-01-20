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
   *  Master data storage
   *  ========================= */
  const STORAGE_KEY = 'tsunageru_master_v1';
  let masterData = null;

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
      // デモ用: 命をツナゲルと同じ職員マスタに合わせて5名登録します。
      masterData.staff = [
        {
          id: 'S001',
          name: '佐藤 一郎',
          birthday: '',
          blood: 'O+',
          history: ['高血圧'],
          meds: ['降圧薬'],
          allergies: ['ピーナッツ'],
          doctor: '佐々木医院',
          contactRel: '妻',
          contactTel: '090-1234-5678'
        },
        {
          id: 'S002',
          name: '高橋 花子',
          birthday: '',
          blood: 'A+',
          history: ['喘息'],
          meds: ['吸入薬'],
          allergies: [],
          doctor: '高橋クリニック',
          contactRel: '夫',
          contactTel: '080-2345-6789'
        },
        {
          id: 'S003',
          name: '山田 太郎',
          birthday: '',
          blood: 'B+',
          history: [],
          meds: [],
          allergies: [],
          doctor: '',
          contactRel: '',
          contactTel: ''
        },
        {
          id: 'S004',
          name: '伊藤 次郎',
          birthday: '',
          blood: 'AB+',
          history: [],
          meds: [],
          allergies: [],
          doctor: '',
          contactRel: '',
          contactTel: ''
        },
        {
          id: 'S005',
          name: '鈴木 三郎',
          birthday: '',
          blood: 'O-',
          history: [],
          meds: [],
          allergies: [],
          doctor: '',
          contactRel: '',
          contactTel: ''
        }
      ];
    }
    if (!masterData.userPasswordHash) {
      // Default user password: 0000
      masterData.userPasswordHash = await sha256Hex('0000');
    }
    // デモ用に必ず管理者IDとパスワードを固定（ID: 1111, PW: 2222）します。
    // 過去に保存された資格情報は無視されます。
    masterData.adminId = '1111';
    masterData.adminPasswordHash = await sha256Hex('2222');

    // Ensure each staff record has a birthday property
    if (Array.isArray(masterData.staff)) {
      masterData.staff.forEach((s) => {
        if (!Object.prototype.hasOwnProperty.call(s, 'birthday')) {
          s.birthday = '';
        }
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
      const idTd = document.createElement('td');
      // 生年月日を表示。未設定の場合は不明とする
      idTd.textContent = s.birthday || '不明';
      const nameTd = document.createElement('td');
      nameTd.textContent = s.name;
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
      tr.appendChild(idTd);
      tr.appendChild(nameTd);
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
    if (!id || !name) {
      toast('氏名は必須です');
      return;
    }
    const blood = $('#staffBlood').value.trim();
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
  // ヘルメットQRを読む: QRコードの内容を手入力で取得し、職員ID欄に反映します
  $('#btnScanHelmet').addEventListener('click', () => {
    const input = window.prompt('ヘルメットQRの内容を入力してください (職員ID)');
    if (!input) return;
    const value = input.trim();
    if (value) {
      $('#empId').value = value;
      toast(`ID: ${escapeHtml(value)} を設定しました`);
    }
  });
  // 氏名で探す: 氏名の一部を入力して職員を検索し、該当する職員がいればID欄に反映します
  $('#btnSearchName').addEventListener('click', () => {
    const query = window.prompt('氏名を入力してください（部分一致）');
    if (!query) return;
    const q = query.trim();
    if (!q) return;
    // 部分一致で検索（ひらがな・カタカナも許容）
    const matches = masterData.staff.filter((s) => s.name && s.name.includes(q));
    if (matches.length === 1) {
      const m = matches[0];
      $('#empId').value = m.id;
      toast(`${escapeHtml(m.name)} (ID: ${escapeHtml(m.id)}) を選択しました`);
    } else if (matches.length > 1) {
      // 複数候補がある場合は最初のものを選択
      const m = matches[0];
      $('#empId').value = m.id;
      toast(`${escapeHtml(m.name)} (ID: ${escapeHtml(m.id)}) 他${matches.length - 1}件の候補があります`);
    } else {
      toast('該当する職員が見つかりません');
    }
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
    $('#editContactTime').value = currentTsunaguInfo.contactTime || '';
    $('#editEmpId').value = currentTsunaguInfo.empId || '';
    $('#editLocation').value = currentTsunaguInfo.location || '';
    $('#editStatus1').value = currentTsunaguInfo.status1 || '';
    $('#editStatus2').value = currentTsunaguInfo.status2 || '';
    $('#editAccident').value = currentTsunaguInfo.accident || '';
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
      const input = window.prompt('ヘルメットQRの内容を入力してください (職員ID)');
      if (!input) return;
      const value = input.trim();
      if (value) {
        document.getElementById('editEmpId').value = value;
        toast(`ID: ${escapeHtml(value)} を設定しました`);
      }
    });
  }
  // 氏名で探す（編集画面）
  const btnEditSearchName = document.getElementById('btnEditSearchName');
  if (btnEditSearchName) {
    btnEditSearchName.addEventListener('click', () => {
      const query = window.prompt('氏名を入力してください（部分一致）');
      if (!query) return;
      const q = query.trim();
      if (!q) return;
      const matches = masterData.staff.filter((s) => s.name && s.name.includes(q));
      if (matches.length === 1) {
        const m = matches[0];
        document.getElementById('editEmpId').value = m.id;
        toast(`${escapeHtml(m.name)} (ID: ${escapeHtml(m.id)}) を選択しました`);
      } else if (matches.length > 1) {
        const m = matches[0];
        document.getElementById('editEmpId').value = m.id;
        toast(`${escapeHtml(m.name)} (ID: ${escapeHtml(m.id)}) 他${matches.length - 1}件の候補があります`);
      } else {
        toast('該当する職員が見つかりません');
      }
    });
  }
  // 場所QRを読む（編集画面）
  const btnEditScanLocation = document.getElementById('btnEditScanLocation');
  if (btnEditScanLocation) {
    btnEditScanLocation.addEventListener('click', () => {
      const input = window.prompt('場所QRの内容を入力してください (場所名)');
      if (!input) return;
      const value = input.trim();
      if (value) {
        document.getElementById('editLocation').value = value;
        toast(`場所: ${escapeHtml(value)} を設定しました`);
      }
    });
  }
  // 地図から選択（編集画面）
  const btnEditMapSelect = document.getElementById('btnEditMapSelect');
  if (btnEditMapSelect) {
    btnEditMapSelect.addEventListener('click', () => {
      const mapModal = document.getElementById('mapModal');
      const detailImg = document.getElementById('mapDetailImg');
      if (detailImg) {
        detailImg.style.display = 'none';
        detailImg.src = '';
      }
      if (mapModal) mapModal.classList.remove('hidden');
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
      const locField = document.getElementById('editLocation');
      if (locField) {
        locField.value = `エリア${area}`;
      }
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

  // Initialise on load
  document.addEventListener('DOMContentLoaded', async () => {
    await loadMaster();
    // Hide back/logout initially
    showView('view-login');
  });
})();