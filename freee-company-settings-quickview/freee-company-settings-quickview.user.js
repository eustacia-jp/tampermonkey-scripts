// ==UserScript==
// @name         freee事業所設定クイックビュー
// @namespace    https://eustacia.jp/
// @version      1.17.0
// @updateURL    https://github.com/eustacia-jp/tampermonkey-scripts/raw/refs/heads/main/freee-company-settings-quickview/freee-company-settings-quickview.user.js
// @downloadURL  https://github.com/eustacia-jp/tampermonkey-scripts/raw/refs/heads/main/freee-company-settings-quickview/freee-company-settings-quickview.user.js
// @description  freee会計の画面上部に常時ボタンを表示し（表示位置は左端からのpxで設定変更可）、クリックすると現在ログイン中の事業所の消費税課税方式・簡易課税事業区分（みなし仕入率付き）・上級者向け設定への博士帽アイコン・インボイス少額特例・買い手側対応・登録番号・決算月・業種・法人番号・住所（マップ検索付き）などをその場で一覧表示し、各項目名クリックで該当の設定編集画面を開けます。パネル上の歯車アイコンから表示項目・ボタン位置を設定・保存でき、内容のコピーや外部検索、矛盾のある設定への注意表示、24時間キャッシュと再取得もできます。
// @author       Eustacia.JP w/ Claude
// @match        https://secure.freee.co.jp/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=secure.freee.co.jp
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_info
// @connect      accounts.secure.freee.co.jp
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ==== オプション設定 ====
  // 下記の項目はパネル右上の歯車アイコンから変更でき、GM_setValueで保存されます。
  // （この初期値はTampermonkeyへ保存する前のデフォルト値です）
  const OPTIONS_STORAGE_KEY = 'fqv_options';
  const OPTION_DEFS = [
    { key: 'showFetchedAt', label: '取得日時を表示', defaultValue: true },
    { key: 'showAddressSimple', label: '住所（簡易）を表示', defaultValue: true },
    { key: 'showAddressDetailed', label: '住所（詳細）を表示', defaultValue: false },
    { key: 'showTaxFraction', label: '消費税の端数処理を表示', defaultValue: true },
    { key: 'showSmallAmountBatch', label: '少額特例の一括修正を表示', defaultValue: true },
    { key: 'showRawDebugJson', label: 'freee内部コードの生値を表示', defaultValue: false },
  ];
  const DEFAULT_OPTIONS = { buttonOffsetLeft: 280 }; // 左端から280px（デフォルト）。空欄にすると画面中央になる
  OPTION_DEFS.forEach((def) => { DEFAULT_OPTIONS[def.key] = def.defaultValue; });

  function loadOptions() {
    let saved = {};
    if (typeof GM_getValue === 'function') {
      try {
        const raw = GM_getValue(OPTIONS_STORAGE_KEY, null);
        if (raw) saved = JSON.parse(raw);
      } catch (e) {
        saved = {};
      }
    }
    // 保存済みデータに無いキー（新しく追加された項目など）はデフォルト値で補う
    return Object.assign({}, DEFAULT_OPTIONS, saved);
  }

  function saveOptions(opts) {
    if (typeof GM_setValue !== 'function') return;
    try {
      GM_setValue(OPTIONS_STORAGE_KEY, JSON.stringify(opts));
    } catch (e) {
      // 保存に失敗しても致命的ではないため無視する
    }
  }

  // オブジェクト自体はconstのまま、プロパティを書き換えることで
  // 各所の`OPTIONS.xxx`参照はそのまま最新の値を読めるようにする。
  const OPTIONS = loadOptions();

  // 直近に描画したデータ。設定変更後、再取得せずに同じデータで再描画するために使う。
  let lastRenderedResults = null;

  // 簡易課税の事業区分ごとのみなし仕入率
  const SIMPLIFIED_TAX_RATES = {
    first: '90%',
    second: '80%',
    third: '70%',
    fourth: '60%',
    fifth: '50%',
    sixth: '40%',
  };

  // 取得に失敗した項目が無かった場合のみキャッシュし、24時間以内かつ
  // スクリプトのバージョンが変わっていなければ再利用する。
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0';

  const EDIT_PATH = '/company/edit';
  const DETAIL_PATH = '/company/detail';
  const TAXES_PATH = '/taxes';
  const ACCOUNTS_API_URL = 'https://accounts.secure.freee.co.jp/api/p/company/info';
  const ACCOUNTS_SETTINGS_PAGE_URL = 'https://accounts.secure.freee.co.jp/company_settings/info';

  // 各項目のラベルをクリックしたときに開く、設定編集画面のURL
  const ROW_LINKS = {
    industry: EDIT_PATH + '#company_sales_information_attributes_industry_class',
    corporateNumber: EDIT_PATH + '#company_corporate_number',
    fiscalYearEnd: DETAIL_PATH,
    addressSimple: EDIT_PATH,
    addressDetailed: EDIT_PATH,
    taxMethod: DETAIL_PATH,
    simplifiedCategory: DETAIL_PATH,
    taxAccountMethod: DETAIL_PATH,
    taxFraction: DETAIL_PATH,
    buyerSide: TAXES_PATH,
    smallAmountBatch: DETAIL_PATH + '#incorrect_list',
    smallAmountEligible: DETAIL_PATH + '#incorrect_list',
    registration: ACCOUNTS_SETTINGS_PAGE_URL,
    creator: ACCOUNTS_SETTINGS_PAGE_URL,
  };

  const REFRESH_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 4V1L8 5l4 4V6a6 6 0 1 1-5.65 8H4.24A8 8 0 1 0 12 4z"/>'
    + '</svg>';
  const GEAR_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.9 3.5c0-.6-.1-1.1-.2-1.6l2-1.4-2-3.4-2.3.8a7.6 7.6 0 0 0-2.8-1.6L15.2 2H8.8l-.4 2.4a7.6 7.6 0 0 0-2.8 1.6l-2.3-.8-2 3.4 2 1.4c-.1.5-.2 1-.2 1.6s.1 1.1.2 1.6l-2 1.4 2 3.4 2.3-.8c.8.7 1.8 1.3 2.8 1.6l.4 2.4h6.4l.4-2.4c1-.3 2-.9 2.8-1.6l2.3.8 2-3.4-2-1.4c.1-.5.2-1 .2-1.6z"/>'
    + '</svg>';
  const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">'
    + '<path d="M15 1H4a2 2 0 0 0-2 2v14h2V3h11V1zm4 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/>'
    + '</svg>';
  // 法人番号公表サイト用：「i」を丸で囲んだアイコン
  const INFO_CIRCLE_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<text x="12" y="16.5" text-anchor="middle" font-size="12" font-family="Georgia, \'Times New Roman\', serif" font-style="italic" font-weight="bold" fill="currentColor">i</text>'
    + '</svg>';
  // インボイス発行事業者公表サイト用：「T」を丸で囲んだアイコン
  const T_CIRCLE_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<text x="12" y="16" text-anchor="middle" font-size="11" font-family="Arial, Helvetica, sans-serif" font-weight="bold" fill="currentColor">T</text>'
    + '</svg>';
  // 組み合わせに注意してほしい項目に添える黄色い警告マーク
  const WARNING_ICON_HTML = '<span class="fqv-warn-icon" title="設定の確認が必要です" aria-label="注意">\u26A0\uFE0F</span>';
  // 「上級者向け・要確認」の項目に添える博士帽アイコン（クリック不可なのでグレー固定）
  const EXPERT_ICON_HTML = '<span class="fqv-inline-icon" title="上級者向けまたは標準と異なる設定です" aria-label="上級者向け設定">'
    + '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#999" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v4c0 1.5 2.7 3 6 3s6-1.5 6-3v-4"/><path d="M20 10v5"/>'
    + '</svg></span>';
  // 住所のGoogleマップ検索用ピンアイコン
  const MAP_PIN_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">'
    + '<path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>'
    + '</svg>';

  // freeeの画面遷移(pjax/turbo等)でbodyが差し替わってもボタンが消えないよう、
  // 定期的に自分のボタンが残っているかを確認して無ければ再設置する。
  function ensureButton() {
    if (document.getElementById('fqv-toggle-btn')) return;
    injectStyles();
    const btn = document.createElement('button');
    btn.id = 'fqv-toggle-btn';
    btn.type = 'button';
    btn.textContent = '事業所設定を見る';
    btn.addEventListener('click', onButtonClick);
    document.body.appendChild(btn);
    applyButtonPosition();
  }

  // OPTIONS.buttonOffsetLeftが数値なら左端からその位置に、
  // 未設定（null）ならCSSの初期値（画面中央）に戻す。
  // どれだけ大きい値を指定しても、ボタンの右端から160px分は必ず画面内に収まるよう
  // clamp()で上限を設ける（大きすぎる値で操作不能になるのを防ぐため）。
  function applyButtonPosition() {
    const btn = document.getElementById('fqv-toggle-btn');
    if (!btn) return;
    const offset = OPTIONS.buttonOffsetLeft;
    if (typeof offset === 'number' && !isNaN(offset)) {
      const safeOffset = Math.max(0, offset);
      btn.style.left = 'clamp(0px, ' + safeOffset + 'px, calc(100vw - 160px))';
      btn.style.transform = 'none';
    } else {
      btn.style.left = '';
      btn.style.transform = '';
    }
  }

  function injectStyles() {
    if (document.getElementById('fqv-style')) return;
    const style = document.createElement('style');
    style.id = 'fqv-style';
    style.textContent = `
#fqv-toggle-btn {
  all: initial;
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  background: #285ac8;
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
  font-size: 12.5px;
  font-weight: bold;
  line-height: 1;
  padding: 7px 16px;
  border-radius: 10px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.3);
  letter-spacing: .02em;
}
#fqv-toggle-btn:hover { background: #1e46a0; }

#fqv-overlay {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  background: rgba(20,25,40,.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
}
#fqv-panel {
  margin-top: 52px;
  width: 480px;
  max-width: 92vw;
  max-height: 84vh;
  overflow-y: auto;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.35);
  color: #222;
  font-size: 13px;
}
#fqv-panel * { box-sizing: border-box; }
#fqv-settings-overlay {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  background: rgba(20,25,40,.45);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
}
#fqv-settings-panel {
  width: 320px;
  max-width: 90vw;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.35);
  color: #222;
  font-size: 13px;
}
#fqv-settings-panel * { box-sizing: border-box; }
.fqv-settings-section-title {
  font-size: 11px;
  font-weight: bold;
  color: #999;
  margin: 14px 0 4px;
}
.fqv-settings-section-title:first-child { margin-top: 0; }
.fqv-option-list { padding: 4px 0; }
.fqv-option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px dashed #eee;
  cursor: pointer;
  font-size: 13px;
}
.fqv-option-row:last-child { border-bottom: none; }
.fqv-option-row input { cursor: pointer; }
.fqv-option-row--input { justify-content: space-between; cursor: default; border-bottom: none; }
.fqv-option-row--input input {
  all: initial;
  width: 70px;
  padding: 4px 6px;
  border: 1px solid #ccc;
  border-radius: 6px;
  font-size: 13px;
  text-align: right;
  cursor: text;
}
.fqv-settings-reset { text-align: right; padding-bottom: 4px; border-bottom: 1px dashed #eee; }
#fqv-settings-position-reset {
  all: initial;
  cursor: pointer;
  color: #285ac8;
  font-family: inherit;
  font-size: 12px;
}
#fqv-settings-position-reset:hover { text-decoration: underline; }
.fqv-settings-actions { padding-top: 12px; text-align: right; }
#fqv-settings-save-btn {
  all: initial;
  cursor: pointer;
  background: #285ac8;
  color: #fff;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: bold;
  padding: 7px 18px;
  border-radius: 999px;
}
#fqv-settings-save-btn:hover { background: #1e46a0; }
.fqv-header {
  position: sticky;
  top: 0;
  background: #285ac8;
  color: #fff;
  padding: 14px 16px;
  border-radius: 10px 10px 0 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.fqv-header-title { font-size: 15px; font-weight: bold; }
.fqv-badge {
  display: inline-block;
  font-size: 10.5px;
  font-weight: bold;
  padding: 2px 8px;
  border-radius: 6px;
  margin-right: 6px;
  vertical-align: middle;
}
.fqv-badge-corp { background: #eaf1ff; color: #1e46a0; }
.fqv-badge-personal { background: #e6f6ea; color: #1e7a3c; }
.fqv-header-sub { font-size: 11px; opacity: .85; margin-top: 2px; }
.fqv-close {
  all: initial;
  cursor: pointer;
  color: #fff;
  font-size: 20px;
  line-height: 1;
  padding: 2px 8px;
  font-family: inherit;
}
.fqv-close:hover { opacity: .7; }
.fqv-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.fqv-icon-btn {
  all: initial;
  cursor: pointer;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px;
  border-radius: 6px;
  font-family: inherit;
}
.fqv-icon-btn:hover { background: rgba(255,255,255,.18); }
@keyframes fqv-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.fqv-icon-btn.fqv-spinning svg { animation: fqv-spin .8s linear infinite; }
.fqv-copy-feedback {
  font-size: 11px;
  color: #fff;
  opacity: .9;
  white-space: nowrap;
}
.fqv-icon-link {
  all: initial;
  cursor: pointer;
  color: #285ac8;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  margin-left: 4px;
  border-radius: 4px;
  vertical-align: middle;
  font-family: inherit;
}
.fqv-icon-link:hover { background: #eaf1ff; }
.fqv-inline-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  margin-left: 4px;
  vertical-align: middle;
}
.fqv-warn-icon {
  display: inline-block;
  margin-left: 5px;
  font-size: 13px;
  cursor: help;
  vertical-align: middle;
}
.fqv-body { padding: 4px 16px 16px; }
.fqv-section { margin-top: 16px; }
.fqv-section-title {
  font-size: 12px;
  font-weight: bold;
  color: #285ac8;
  border-bottom: 1px solid #e3e8f5;
  padding-bottom: 4px;
  margin-bottom: 6px;
}
.fqv-row {
  display: flex;
  padding: 5px 0;
  border-bottom: 1px dashed #eee;
}
.fqv-row:last-child { border-bottom: none; }
.fqv-label { width: 170px; flex-shrink: 0; color: #666; }
.fqv-row-label-link { color: inherit; text-decoration: none !important; cursor: pointer; }
.fqv-row-label-link:hover { color: #285ac8; text-decoration: none !important; }
.fqv-value { font-weight: bold; color: #222; word-break: break-all; }
.fqv-value.fqv-warn { color: #c0392b; }
.fqv-value.fqv-muted { color: #999; font-weight: normal; }
.fqv-note {
  font-size: 11px;
  color: #888;
  margin-top: 8px;
  line-height: 1.5;
}
.fqv-loading { padding: 30px 0; text-align: center; color: #666; }
.fqv-error {
  background: #fdeded;
  color: #c0392b;
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 12px;
  margin-top: 10px;
}
.fqv-raw {
  margin-top: 14px;
  font-size: 11px;
}
.fqv-raw summary {
  cursor: pointer;
  color: #285ac8;
}
.fqv-raw pre {
  background: #f5f6fa;
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  margin-top: 6px;
  white-space: pre-wrap;
  word-break: break-all;
}
`;
    document.head.appendChild(style);
  }

  function onButtonClick() {
    openPanel();
    loadAndRender(false);
  }

  function onRefreshClick() {
    const btn = document.getElementById('fqv-refresh-btn');
    if (btn) btn.classList.add('fqv-spinning');
    loadAndRender(true).finally(() => {
      if (btn) btn.classList.remove('fqv-spinning');
    });
  }

  function openPanel() {
    closePanel();
    const overlay = document.createElement('div');
    overlay.id = 'fqv-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePanel();
    });

    const panel = document.createElement('div');
    panel.id = 'fqv-panel';
    panel.innerHTML = `
      <div class="fqv-header">
        <div>
          <div class="fqv-header-title" id="fqv-company-name">事業所設定を取得中…</div>
          <div class="fqv-header-sub" id="fqv-company-sub"></div>
        </div>
        <div class="fqv-header-actions">
          <span class="fqv-copy-feedback" id="fqv-copy-feedback"></span>
          <button type="button" class="fqv-icon-btn" id="fqv-refresh-btn" title="情報を再取得（キャッシュを使わない）" aria-label="情報を再取得">${REFRESH_ICON_SVG}</button>
          <button type="button" class="fqv-icon-btn" id="fqv-copy-btn" title="表示内容をコピー" aria-label="表示内容をコピー">${COPY_ICON_SVG}</button>
          <button type="button" class="fqv-icon-btn" id="fqv-settings-btn" title="表示設定" aria-label="表示設定">${GEAR_ICON_SVG}</button>
          <button type="button" class="fqv-close" id="fqv-close-btn" aria-label="閉じる">×</button>
        </div>
      </div>
      <div class="fqv-body" id="fqv-body">
        <div class="fqv-loading">読み込み中…</div>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    document.getElementById('fqv-close-btn').addEventListener('click', closePanel);
    document.getElementById('fqv-copy-btn').addEventListener('click', onCopyClick);
    document.getElementById('fqv-refresh-btn').addEventListener('click', onRefreshClick);
    document.getElementById('fqv-settings-btn').addEventListener('click', openSettingsModal);
    document.addEventListener('keydown', onEscKey);
  }

  function onEscKey(e) {
    if (e.key !== 'Escape') return;
    if (document.getElementById('fqv-settings-overlay')) {
      closeSettingsModal();
    } else {
      closePanel();
    }
  }

  function closePanel() {
    const overlay = document.getElementById('fqv-overlay');
    if (overlay) overlay.remove();
    document.removeEventListener('keydown', onEscKey);
  }

  // ---- データ取得 ----

  async function loadAndRender(forceRefresh) {
    const results = {
      edit: null, detail: null, taxes: null, accounts: null, live: null, errors: [],
      fromCache: false, cachedAt: null,
    };

    // 現在のページ自体に埋め込まれているfreee.data（company）は即座に読める
    try {
      results.live = unsafeWindow.freee && unsafeWindow.freee.data && unsafeWindow.freee.data.get
        ? unsafeWindow.freee.data.get('company')
        : null;
    } catch (e) {
      results.live = null;
    }

    const companyId = results.live ? results.live.id : null;

    if (!forceRefresh) {
      const cached = loadCache(companyId);
      if (cached) {
        results.edit = cached.data.edit;
        results.detail = cached.data.detail;
        results.taxes = cached.data.taxes;
        results.accounts = cached.data.accounts;
        results.fromCache = true;
        results.cachedAt = cached.timestamp;
        render(results);
        return;
      }
    }

    showLoadingState(forceRefresh);

    const [editResult, detailResult, taxesResult, accountsResult] = await Promise.allSettled([
      fetchEditPageInfo(),
      fetchDetailPageInfoWithRetry(),
      fetchTaxesPageInfo(),
      fetchAccountsApiInfo(companyId),
    ]);

    if (editResult.status === 'fulfilled') {
      results.edit = editResult.value;
    } else {
      results.errors.push('基本情報設定の取得に失敗しました（' + editResult.reason + '）');
    }

    if (detailResult.status === 'fulfilled') {
      results.detail = detailResult.value;
    } else {
      results.errors.push('詳細設定の取得に失敗しました（' + detailResult.reason + '）');
    }

    if (taxesResult.status === 'fulfilled') {
      results.taxes = taxesResult.value;
    } else {
      results.errors.push('税区分の設定の取得に失敗しました（' + taxesResult.reason + '）');
    }

    if (accountsResult.status === 'fulfilled') {
      results.accounts = accountsResult.value;
    } else {
      results.errors.push('アカウント管理の事業所情報の取得に失敗しました（' + accountsResult.reason + '）');
    }

    if (results.errors.length === 0) {
      saveCache(companyId, results);
    }

    render(results);
  }

  function showLoadingState(isRefresh) {
    const bodyEl = document.getElementById('fqv-body');
    if (bodyEl) {
      bodyEl.innerHTML = '<div class="fqv-loading">' + (isRefresh ? '再取得しています…' : '読み込み中…') + '</div>';
    }
  }

  // ---- キャッシュ ----

  function cacheKey(companyId) {
    return 'fqv_cache_' + companyId;
  }

  function loadCache(companyId) {
    if (!companyId || typeof GM_getValue !== 'function') return null;
    try {
      const raw = GM_getValue(cacheKey(companyId), null);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== SCRIPT_VERSION) return null;
      if (!parsed.timestamp || (Date.now() - parsed.timestamp) > CACHE_TTL_MS) return null;
      if (!parsed.data) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function saveCache(companyId, results) {
    if (!companyId || typeof GM_setValue !== 'function') return;
    try {
      const payload = {
        version: SCRIPT_VERSION,
        timestamp: Date.now(),
        data: {
          edit: results.edit,
          detail: results.detail,
          taxes: results.taxes,
          accounts: results.accounts,
        },
      };
      GM_setValue(cacheKey(companyId), JSON.stringify(payload));
    } catch (e) {
      // 保存に失敗しても致命的ではないため無視する
    }
  }

  async function fetchEditPageInfo() {
    const res = await fetch(EDIT_PATH, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const displayNameEl = doc.querySelector('#company_display_name');
    const corporateNumber = readInputState(doc.querySelector('#company_corporate_number'));

    // 法人向け（業種＋詳細区分の2段）と個人事業向け（単一の業種セレクト）の
    // どちらの画面構成でも取得できるようにする。
    let industry = readSelectState(doc.querySelector('#company_sales_information_attributes_industry_class'));
    let industrySub = readSelectState(doc.querySelector('#company_sales_information_attributes_industry_code'));
    if (industry.state === 'missing') {
      industry = readSelectState(doc.querySelector('#company_industry_code'));
      industrySub = { state: 'missing' };
    }

    return {
      displayName: displayNameEl ? displayNameEl.value.trim() : null,
      corporateNumber,
      industry,
      industrySub,
    };
  }

  function readSelectState(selectEl) {
    if (!selectEl) return { state: 'missing' };
    const opt = selectEl.options[selectEl.selectedIndex];
    if (!opt || opt.value === '') return { state: 'empty' };
    return { state: 'found', value: opt.value, label: opt.textContent.trim() };
  }

  function readInputState(inputEl) {
    if (!inputEl) return { state: 'missing' };
    const v = (inputEl.value || '').trim();
    if (!v) return { state: 'empty' };
    return { state: 'found', value: v };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 詳細設定(/company/detail)はReactで描画されるSPAのため、
  // 非表示iframeで実際に読み込んでレンダリング後のDOMから値を取得する。
  // （表示中の選択肢テキストをそのまま読むので、内部コードの推測は行わない）
  function fetchDetailPageInfo() {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1024px;height:800px;visibility:hidden;';
      iframe.src = DETAIL_PATH;

      let settled = false;
      const cleanup = () => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      };
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearInterval(pollId);
        clearTimeout(timeoutId);
        cleanup();
        fn(arg);
      };

      const pollId = setInterval(() => {
        let doc;
        try {
          doc = iframe.contentDocument;
        } catch (e) {
          return;
        }
        if (doc && doc.querySelector('#invoice_exemption_enable')) {
          // データ反映のための猶予を少し置いてから読み取る
          setTimeout(() => {
            try {
              finish(resolve, extractDetailInfo(doc));
            } catch (e) {
              finish(reject, 'DOM解析エラー: ' + e.message);
            }
          }, 900);
        }
      }, 250);

      const timeoutId = setTimeout(() => {
        finish(reject, 'タイムアウト（画面の読み込みに時間がかかっています）');
      }, 10000);

      document.body.appendChild(iframe);
    });
  }

  // 初回クリック時、iframe内のデータ反映前に読み取ってしまい
  // 「課税方式」が空欄扱いになることがあるため、その場合は少し待って再取得する。
  async function fetchDetailPageInfoWithRetry() {
    let info = await fetchDetailPageInfo();
    if (info.taxMethod && info.taxMethod.state !== 'found') {
      await sleep(700);
      try {
        info = await fetchDetailPageInfo();
      } catch (e) {
        // 再試行に失敗した場合は最初の結果をそのまま使う
      }
    }
    return info;
  }

  // 税区分の設定(/taxes)もReactで描画されるSPAのため、同様にiframeで読み込んで
  // 「買い手側対応機能」の行（項目名／内容の説明リスト）をDOMから取得する。
  function fetchTaxesPageInfo() {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1024px;height:800px;visibility:hidden;';
      iframe.src = TAXES_PATH;

      let settled = false;
      const cleanup = () => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      };
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearInterval(pollId);
        clearTimeout(timeoutId);
        cleanup();
        fn(arg);
      };

      const pollId = setInterval(() => {
        let doc;
        try {
          doc = iframe.contentDocument;
        } catch (e) {
          return;
        }
        if (doc && findDescriptionListTh(doc, '買い手側対応機能')) {
          setTimeout(() => {
            try {
              finish(resolve, {
                buyerSideCompliance: getDescriptionListValue(doc, '買い手側対応機能'),
              });
            } catch (e) {
              finish(reject, 'DOM解析エラー: ' + e.message);
            }
          }, 700);
        }
      }, 250);

      const timeoutId = setTimeout(() => {
        finish(reject, 'タイムアウト（画面の読み込みに時間がかかっています）');
      }, 12000);

      document.body.appendChild(iframe);
    });
  }

  // 「項目名／内容」形式の説明リスト（vb-descriptionList）から、
  // 指定した項目名の行の内容セルを取得する。
  function findDescriptionListTh(doc, labelText) {
    const ths = doc.querySelectorAll('.vb-descriptionListHeadCell');
    for (const th of ths) {
      if (getDirectText(th) === labelText) return th;
    }
    return null;
  }

  function getDescriptionListValue(doc, labelText) {
    const th = findDescriptionListTh(doc, labelText);
    if (!th) return { state: 'missing' };
    const td = th.nextElementSibling;
    if (!td) return { state: 'missing' };
    const v = td.textContent.trim();
    if (!v) return { state: 'empty' };
    return { state: 'found', value: v, label: v };
  }

  // 要素直下のテキストノードのみを連結して返す（アイコン等の子要素は無視する）
  function getDirectText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return text.trim();
  }


  // アカウント管理（accounts.secure.freee.co.jp）は別ドメインのため、GM_xmlhttpRequestで
  // クロスオリジン取得する。事前にHTMLを取得して試したところ、実際にはReactが後から
  // データを描画する画面で、生HTMLには値が入っていなかった（＝常に取得できませんでした）。
  // その後、実際に叩かれているJSON API（/api/p/company/info）が判明したため、
  // そちらを直接呼び出す方式に変更した。このAPIはリクエストヘッダーに
  // 事業所ID（x-company-id）とCSRFトークン（x-csrf-token）を要求するため、
  // CSRFトークンはGM_cookieでaccounts.secure.freee.co.jp用のXSRF-TOKEN Cookieを読んで補う。
  function getXsrfTokenForAccounts() {
    return new Promise((resolve) => {
      if (typeof GM_cookie === 'undefined' || !GM_cookie.list) {
        resolve(null);
        return;
      }
      try {
        GM_cookie.list({ url: 'https://accounts.secure.freee.co.jp/', name: 'XSRF-TOKEN' }, (cookies, error) => {
          if (error || !cookies || !cookies.length) {
            resolve(null);
            return;
          }
          const c = cookies.find((x) => x.name === 'XSRF-TOKEN') || cookies[0];
          resolve(c ? decodeURIComponent(c.value) : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function fetchAccountsApiInfo(companyId) {
    if (!companyId) throw new Error('事業所IDが取得できませんでした');
    if (typeof GM_xmlhttpRequest !== 'function') throw new Error('GM_xmlhttpRequestが利用できません');

    const token = await getXsrfTokenForAccounts();

    return new Promise((resolve, reject) => {
      const headers = {
        Accept: 'application/json, text/plain, */*',
        'X-Company-Id': String(companyId),
        'X-Requested-With': 'XMLHttpRequest',
        'X-Freee-Client-Name': 'accounts',
      };
      if (token) headers['X-CSRF-Token'] = token;

      GM_xmlhttpRequest({
        method: 'GET',
        url: ACCOUNTS_API_URL,
        headers,
        timeout: 10000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error('HTTP ' + res.status));
            return;
          }
          try {
            const data = JSON.parse(res.responseText);
            resolve(buildAccountsResult(data.company_info || {}));
          } catch (e) {
            reject(new Error('JSON解析エラー: ' + e.message));
          }
        },
        onerror: () => reject(new Error('ネットワークエラー')),
        ontimeout: () => reject(new Error('タイムアウト')),
      });
    });
  }

  function buildAccountsResult(info) {
    const isQualified = typeof info.is_invoice_registration_company === 'boolean'
      ? {
        state: 'found',
        value: info.is_invoice_registration_company,
        label: info.is_invoice_registration_company ? '該当する' : '該当しない',
      }
      : { state: 'missing' };

    const registrationNumber = trimmedFieldState(info.invoice_registration_number);
    const corporateNumber = trimmedFieldState(info.corporate_number);
    const creator = buildCreatorState(info.primary_user_name, info.primary_user_email);
    const address = buildAddressState(info.address);

    return {
      isQualified,
      registrationNumber,
      corporateNumber,
      creator,
      address,
      raw: {
        org_type: info.org_type,
        is_invoice_registration_company: info.is_invoice_registration_company,
        invoice_registration_number: info.invoice_registration_number,
        corporate_number: info.corporate_number,
        primary_user_name: info.primary_user_name,
        primary_user_email: info.primary_user_email,
        address: info.address,
      },
    };
  }

  // 郵便番号／都道府県／市区町村・番地／建物名・部屋番号などから、
  // 「簡易」（都道府県＋市区町村・番地）と「詳細」（〒付き・全角スペース区切り）の2形式を組み立てる。
  function buildAddressState(address) {
    if (!address) return { state: 'missing' };
    const zipcode = (address.zipcode || '').toString().trim();
    const pref = (address.prefecture_name || '').toString().trim();
    const street1 = (address.street_name1 || '').toString().trim();
    const street2 = (address.street_name2 || '').toString().trim();

    if (!zipcode && !pref && !street1 && !street2) return { state: 'empty' };

    const simple = pref + street1;

    let detailed = '';
    if (zipcode) detailed += '〒' + zipcode + '\u3000';
    detailed += pref + street1;
    if (street2) detailed += '\u3000' + street2;

    return { state: 'found', simple, detailed, street1 };
  }

  // primary_user_nameは、名前未設定のユーザーの場合はメールアドレスと同じ値が入る仕様のため、
  // その場合は重複表示せずメールアドレスのみにする。
  function buildCreatorState(name, email) {
    const n = (name || '').toString().trim();
    const e = (email || '').toString().trim();
    if (!n && !e) return { state: 'empty' };
    if (!e || n === e) return { state: 'found', value: n || e, label: n || e };
    if (!n) return { state: 'found', value: e, label: e };
    const label = n + ' (' + e + ')';
    return { state: 'found', value: label, label };
  }

  function trimmedFieldState(value) {
    const v = (value || '').toString().trim();
    if (!v) return { state: 'empty' };
    return { state: 'found', value: v, label: v };
  }

  function extractDetailInfo(doc) {
    return {
      taxAccountMethod: getFieldByLabel(doc, '消費税の経理処理'),
      taxFraction: getFieldByLabel(doc, '消費税の端数処理'),
      taxMethod: getFieldByLabel(doc, '課税方式'),
      simplifiedTaxCategory: getFieldByLabel(doc, '簡易課税の事業区分'),
      smallAmountExceptionCheck: getFieldByLabel(doc, 'インボイス制度の少額特例'),
      smallAmountExceptionEligible: getSelectById(doc, 'invoice_exemption_enable'),
      fiscalYearEndMonth: getFiscalYearEndMonth(doc),
    };
  }

  // 会計期間設定の「期末日」（法人の場合のみ存在。個人は年選択のみで常に12月）から
  // 決算月を求める。値は "YYYY-MM-DD" 形式。
  function getFiscalYearEndMonth(doc) {
    const el = doc.getElementById('end_date');
    if (!el) return { state: 'missing' };
    const v = (el.value || '').trim();
    if (!v) return { state: 'empty' };
    const m = v.match(/^\d{4}-(\d{2})-\d{2}$/);
    if (!m) return { state: 'missing' };
    const month = parseInt(m[1], 10);
    return { state: 'found', value: month, label: month + '月' };
  }

  // 画面に表示されているラベル文言から、対応するselect/ラジオボタンの
  // 「現在表示されている選択肢の文字列」をそのまま取得する。
  // state: 'found'（値あり） / 'empty'（未選択・空欄） / 'missing'（要素自体が見つからない＝取得失敗）
  function getFieldByLabel(doc, labelText) {
    const labelNodes = doc.querySelectorAll('.company-detail--section--content--fields--field__label');
    for (const labelEl of labelNodes) {
      const textEl = labelEl.querySelector('.vb-text') || labelEl.querySelector('label') || labelEl;
      const text = (textEl.textContent || '').trim();
      if (text !== labelText) continue;

      const container = labelEl.parentElement;
      if (!container) return { state: 'missing' };

      const select = container.querySelector('select');
      if (select) return readSelectState(select);

      const radios = container.querySelectorAll('input[type="radio"]');
      if (radios.length) {
        const checkedRadio = container.querySelector('input[type="radio"]:checked');
        if (!checkedRadio) return { state: 'empty' };
        let label = checkedRadio.value;
        if (checkedRadio.id) {
          const radioLabel = container.querySelector('label[for="' + cssEscape(checkedRadio.id) + '"]');
          if (radioLabel) label = radioLabel.textContent.trim();
        }
        return { state: 'found', value: checkedRadio.value, label };
      }
      return { state: 'missing' };
    }
    return { state: 'missing' };
  }

  function getSelectById(doc, id) {
    return readSelectState(doc.getElementById(id));
  }

  function cssEscape(str) {
    return String(str).replace(/([\0-\x1f\x7f]|^-?\d)|^-$|[^\x80-\uFFFF\w-]/g, (m) => {
      return '\\' + m;
    });
  }

  // ---- コピー機能 ----

  let copyRows = [];

  function onCopyClick() {
    const text = copyRows.map(([label, value]) => label + '\t' + value).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showCopyFeedback(true),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      showCopyFeedback(ok);
    } catch (e) {
      showCopyFeedback(false);
    }
  }

  function showCopyFeedback(success) {
    const el = document.getElementById('fqv-copy-feedback');
    if (!el) return;
    el.textContent = success ? 'コピーしました' : 'コピーに失敗しました';
    setTimeout(() => {
      if (el) el.textContent = '';
    }, 1800);
  }

  // ---- 設定モーダル ----

  function openSettingsModal() {
    closeSettingsModal();

    const overlay = document.createElement('div');
    overlay.id = 'fqv-settings-overlay';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSettingsModal();
    });

    const optionRows = OPTION_DEFS.map((def) => {
      const checked = OPTIONS[def.key] ? 'checked' : '';
      return '<label class="fqv-option-row">'
        + '<input type="checkbox" id="fqv-opt-' + def.key + '" ' + checked + '>'
        + '<span>' + escapeHtml(def.label) + '</span>'
        + '</label>';
    }).join('');

    const offsetValue = (typeof OPTIONS.buttonOffsetLeft === 'number' && !isNaN(OPTIONS.buttonOffsetLeft))
      ? OPTIONS.buttonOffsetLeft
      : '';

    const panel = document.createElement('div');
    panel.id = 'fqv-settings-panel';
    panel.innerHTML = `
      <div class="fqv-header">
        <div class="fqv-header-title">表示設定</div>
        <button type="button" class="fqv-close" id="fqv-settings-close-btn" aria-label="閉じる">×</button>
      </div>
      <div class="fqv-body">
        <div class="fqv-settings-section-title">ボタンの表示位置</div>
        <label class="fqv-option-row fqv-option-row--input">
          <span>左端からの距離（px、空欄で中央）</span>
          <input type="number" id="fqv-opt-buttonOffsetLeft" min="0" step="1" placeholder="中央" value="${offsetValue}">
        </label>
        <div class="fqv-settings-reset">
          <button type="button" id="fqv-settings-position-reset">デフォルト（${DEFAULT_OPTIONS.buttonOffsetLeft}px）に戻す</button>
        </div>
        <div class="fqv-settings-section-title">表示項目</div>
        <div class="fqv-option-list">${optionRows}</div>
        <div class="fqv-settings-actions">
          <button type="button" id="fqv-settings-save-btn">保存</button>
        </div>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    document.getElementById('fqv-settings-close-btn').addEventListener('click', closeSettingsModal);
    document.getElementById('fqv-settings-save-btn').addEventListener('click', onSettingsSaveClick);
    document.getElementById('fqv-settings-position-reset').addEventListener('click', () => {
      document.getElementById('fqv-opt-buttonOffsetLeft').value = DEFAULT_OPTIONS.buttonOffsetLeft;
    });
  }

  function closeSettingsModal() {
    const overlay = document.getElementById('fqv-settings-overlay');
    if (overlay) overlay.remove();
  }

  function onSettingsSaveClick() {
    OPTION_DEFS.forEach((def) => {
      const el = document.getElementById('fqv-opt-' + def.key);
      if (el) OPTIONS[def.key] = el.checked;
    });

    const offsetEl = document.getElementById('fqv-opt-buttonOffsetLeft');
    const offsetRaw = offsetEl ? offsetEl.value.trim() : '';
    if (offsetRaw === '') {
      OPTIONS.buttonOffsetLeft = null;
    } else {
      const n = Number(offsetRaw);
      // マイナス指定は不可。数値でない場合はデフォルトにフォールバックする。
      OPTIONS.buttonOffsetLeft = isNaN(n) ? DEFAULT_OPTIONS.buttonOffsetLeft : Math.max(0, Math.round(n));
    }

    saveOptions(OPTIONS);
    applyButtonPosition();
    closeSettingsModal();
    // 再取得はせず、直近のデータで表示だけ更新する
    if (lastRenderedResults) render(lastRenderedResults);
  }

  // ---- 表示 ----

  function render(results) {
    const nameEl = document.getElementById('fqv-company-name');
    const subEl = document.getElementById('fqv-company-sub');
    const bodyEl = document.getElementById('fqv-body');
    if (!nameEl || !bodyEl) return;

    lastRenderedResults = results;
    copyRows = [];

    const edit = results.edit || {};
    const detail = results.detail || {};
    const taxes = results.taxes || {};
    const accounts = results.accounts || {};
    const live = results.live || {};

    const isCorporate = typeof live.is_corporate === 'boolean' ? live.is_corporate : null;
    const companyName = edit.displayName || live.display_name || live.name || '(事業所名を取得できませんでした)';
    copyRows.push(['事業所名', companyName]);
    if (live.external_cid) copyRows.push(['事業所番号', live.external_cid]);
    if (live.id) copyRows.push(['事業所ID', String(live.id)]);

    const badgeHtml = isCorporate === null
      ? ''
      : (isCorporate
        ? '<span class="fqv-badge fqv-badge-corp">法人</span>'
        : '<span class="fqv-badge fqv-badge-personal">個人</span>');
    nameEl.innerHTML = badgeHtml + escapeHtml(companyName);

    const subParts = [];
    if (live.external_cid) subParts.push('事業所番号: ' + live.external_cid);
    if (live.id) subParts.push('事業所ID: ' + live.id);
    if (OPTIONS.showFetchedAt) {
      const ts = (results.fromCache && results.cachedAt) ? new Date(results.cachedAt) : new Date();
      const timestamp = ts.toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      subParts.push('取得: ' + timestamp + (results.fromCache ? '（キャッシュ）' : ''));
    }
    subEl.textContent = subParts.join(' ｜ ');

    // 業種（法人向け／個人事業向けのどちらの構成でも表示）
    let industryHtml = fieldStateHtml(edit.industry);
    if (edit.industry && edit.industry.state === 'found'
      && edit.industrySub && edit.industrySub.state === 'found') {
      industryHtml = escapeHtml(edit.industry.label + '（' + edit.industrySub.label + '）');
    }

    // 法人番号（個人事業所の場合はそもそも項目がないため「―」固定）
    const corpNumHtml = isCorporate === false
      ? muted('―')
      : fieldStateHtml(edit.corporateNumber);

    // 有効な法人番号がある場合のみ、国税庁の外部検索サイトへのリンクアイコンを表示する
    let corpNumIconsHtml = '';
    if (isCorporate !== false && edit.corporateNumber && edit.corporateNumber.state === 'found') {
      const num = encodeURIComponent(edit.corporateNumber.value);
      const ntaUrl = 'https://www.houjin-bangou.nta.go.jp/henkorireki-johoto.html?selHouzinNo=' + num;
      const invoiceUrl = 'https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=' + num;
      corpNumIconsHtml = '<a href="' + escapeHtml(ntaUrl) + '" target="_blank" rel="noopener noreferrer" class="fqv-icon-link" title="国税庁 法人番号公表サイトで検索">' + INFO_CIRCLE_ICON_SVG + '</a>'
        + '<a href="' + escapeHtml(invoiceUrl) + '" target="_blank" rel="noopener noreferrer" class="fqv-icon-link" title="国税庁 インボイス発行事業者公表サイトで検索">' + T_CIRCLE_ICON_SVG + '</a>';
    }

    // 決算月：個人事業は会計期間が年選択のみ（常に1〜12月）のため一律「12月」、
    // 法人は詳細設定の期末日から算出する。
    const fiscalYearEndHtml = isCorporate === false
      ? escapeHtml('12月')
      : fieldStateHtml(detail.fiscalYearEndMonth);

    const basicRows = [
      row('業種', industryHtml, ROW_LINKS.industry),
      rowWithExtra('法人番号', corpNumHtml, corpNumIconsHtml, isCorporate !== false ? ROW_LINKS.corporateNumber : null),
      row('決算月', fiscalYearEndHtml, ROW_LINKS.fiscalYearEnd),
    ];

    if (OPTIONS.showAddressSimple || OPTIONS.showAddressDetailed) {
      const addr = accounts.address;
      let simpleAddrHtml;
      let detailedAddrHtml;
      let addressMapHtml = '';
      if (!addr || addr.state === 'missing') {
        simpleAddrHtml = notFound();
        detailedAddrHtml = notFound();
      } else if (addr.state === 'empty') {
        simpleAddrHtml = muted('（未設定）');
        detailedAddrHtml = muted('（未設定）');
      } else {
        simpleAddrHtml = escapeHtml(addr.simple);
        detailedAddrHtml = escapeHtml(addr.detailed);
        if (addr.street1) {
          const mapUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr.street1);
          addressMapHtml = '<a href="' + escapeHtml(mapUrl) + '" target="_blank" rel="noopener noreferrer" class="fqv-icon-link" title="Googleマップで検索（市区町村・番地）">' + MAP_PIN_ICON_SVG + '</a>';
        }
      }
      if (OPTIONS.showAddressSimple) basicRows.push(rowWithExtra('住所（簡易）', simpleAddrHtml, addressMapHtml, ROW_LINKS.addressSimple));
      if (OPTIONS.showAddressDetailed) basicRows.push(rowWithExtra('住所（詳細）', detailedAddrHtml, addressMapHtml, ROW_LINKS.addressDetailed));
    }

    // 課税方式のラベル文字列で判定する（免税／簡易課税／一般課税〜）
    const taxMethodFound = detail.taxMethod && detail.taxMethod.state === 'found';
    const taxMethodLabel = taxMethodFound ? detail.taxMethod.label : null;
    const isExempt = taxMethodLabel === '免税';
    const isSimplifiedTaxation = taxMethodLabel === '簡易課税';
    const isGeneralTaxation = !!taxMethodLabel && taxMethodLabel.indexOf('一般課税') === 0;

    // 簡易課税の事業区分：課税方式が「簡易課税」でなければ「―」。
    // 見つかった場合はみなし仕入率をラベルの後ろに付け足す。
    let simplifiedHtml;
    if (taxMethodFound && !isSimplifiedTaxation) {
      simplifiedHtml = muted('―');
    } else if (detail.simplifiedTaxCategory && detail.simplifiedTaxCategory.state === 'found') {
      const rate = SIMPLIFIED_TAX_RATES[detail.simplifiedTaxCategory.value];
      const label = rate ? detail.simplifiedTaxCategory.label + ' (' + rate + ')' : detail.simplifiedTaxCategory.label;
      simplifiedHtml = escapeHtml(label);
    } else {
      simplifiedHtml = fieldStateHtml(detail.simplifiedTaxCategory);
    }

    // 消費税の経理処理：税抜経理のときだけ上級者アイコンを添える。免税なのに税抜経理の場合は警告も追加する。
    let taxAccountExtraHtml = '';
    if (detail.taxAccountMethod && detail.taxAccountMethod.state === 'found' && detail.taxAccountMethod.label === '税抜経理') {
      taxAccountExtraHtml = EXPERT_ICON_HTML;
      if (isExempt) taxAccountExtraHtml += WARNING_ICON_HTML;
    }

    // 消費税の端数処理：「切り捨て」以外は上級者アイコンを添える
    let taxFractionExtraHtml = '';
    if (detail.taxFraction && detail.taxFraction.state === 'found' && detail.taxFraction.label !== '切り捨て') {
      taxFractionExtraHtml = EXPERT_ICON_HTML;
    }

    const taxRows = [
      row('課税方式', fieldStateHtml(detail.taxMethod), ROW_LINKS.taxMethod),
      row('簡易課税の事業区分', simplifiedHtml, ROW_LINKS.simplifiedCategory),
      rowWithExtra('消費税の経理処理', fieldStateHtml(detail.taxAccountMethod), taxAccountExtraHtml, ROW_LINKS.taxAccountMethod),
    ];
    if (OPTIONS.showTaxFraction) {
      taxRows.push(rowWithExtra('消費税の端数処理', fieldStateHtml(detail.taxFraction), taxFractionExtraHtml, ROW_LINKS.taxFraction));
    }

    // 免税の場合、少額特例・登録番号は実質無効なため「―」にするが、
    // 買い手側対応だけは実際の値を表示し、「使用する」になっていたら警告を出す。
    // 免税以外の場合は、買い手側対応の値に応じて少額特例の要否や警告表示を判定する。
    const buyerSideField = taxes.buyerSideCompliance;
    const buyerSideLabel = (buyerSideField && buyerSideField.state === 'found') ? buyerSideField.label : null;

    let buyerSideHtml;
    let buyerSideExtraHtml = '';
    let smallAmountBatchHtml;
    let smallAmountEligibleHtml;
    let smallAmountEligibleExtraHtml = '';
    let registrationHtml;
    let registrationExtraHtml = '';

    if (isExempt) {
      buyerSideHtml = fieldStateHtml(buyerSideField);
      if (buyerSideLabel === '使用する') buyerSideExtraHtml = WARNING_ICON_HTML;
      smallAmountBatchHtml = muted('―');
      smallAmountEligibleHtml = muted('―');
      registrationHtml = muted('―');
    } else {
      buyerSideHtml = fieldStateHtml(buyerSideField);
      if (isSimplifiedTaxation && buyerSideLabel === '使用する') buyerSideExtraHtml = WARNING_ICON_HTML;
      if (isGeneralTaxation && buyerSideLabel === '使用しない') buyerSideExtraHtml = WARNING_ICON_HTML;

      if (buyerSideLabel === '使用しない') {
        // 買い手側対応を使用しない場合、少額特例の設定自体が意味を持たない
        smallAmountBatchHtml = muted('―');
        smallAmountEligibleHtml = muted('―');
      } else {
        smallAmountEligibleHtml = fieldStateHtml(detail.smallAmountExceptionEligible);

        const eligibleField = detail.smallAmountExceptionEligible;
        const eligibleIsNotApplicable = eligibleField && eligibleField.state === 'found' && eligibleField.value === 'false';
        smallAmountBatchHtml = eligibleIsNotApplicable
          ? muted('―')
          : fieldStateHtml(detail.smallAmountExceptionCheck);

        if (buyerSideLabel === '使用する' && eligibleField && eligibleField.state === 'empty') {
          smallAmountEligibleExtraHtml = WARNING_ICON_HTML;
        } else if (eligibleIsNotApplicable) {
          smallAmountEligibleExtraHtml = EXPERT_ICON_HTML;
        }
      }

      // 「適格請求書発行事業者に該当する」場合のみ登録番号を表示する。
      // APIのinvoice_registration_numberは既に「T」付きなのでそのまま使う。
      // 取れなかった場合のみ、法人番号（会員APIの値、無ければ基本情報設定の値）から「T」+番号を組み立てる。
      let registrationNumberForLink = null; // 「T」を除いた番号（インボイス発行事業者公表サイトのクエリ用）
      if (!accounts.isQualified || accounts.isQualified.state === 'missing') {
        registrationHtml = notFound();
      } else if (accounts.isQualified.value === false) {
        registrationHtml = muted('―');
      } else if (accounts.registrationNumber && accounts.registrationNumber.state === 'found') {
        registrationHtml = escapeHtml(accounts.registrationNumber.value);
        registrationNumberForLink = accounts.registrationNumber.value.replace(/^T/i, '').trim();
      } else {
        const corpNum = (accounts.corporateNumber && accounts.corporateNumber.state === 'found')
          ? accounts.corporateNumber.value
          : (edit.corporateNumber && edit.corporateNumber.state === 'found' ? edit.corporateNumber.value : null);
        if (corpNum) {
          registrationHtml = escapeHtml('T' + corpNum);
          registrationNumberForLink = corpNum;
        } else {
          registrationHtml = notFound();
        }
      }
      if (registrationNumberForLink) {
        const invoiceUrl = 'https://www.invoice-kohyo.nta.go.jp/regno-search/detail?selRegNo=' + encodeURIComponent(registrationNumberForLink);
        registrationExtraHtml = '<a href="' + escapeHtml(invoiceUrl) + '" target="_blank" rel="noopener noreferrer" class="fqv-icon-link" title="国税庁 インボイス発行事業者公表サイトで検索">' + T_CIRCLE_ICON_SVG + '</a>';
      }
    }

    const invoiceRows = [
      rowWithExtra('買い手側対応', buyerSideHtml, buyerSideExtraHtml, ROW_LINKS.buyerSide),
    ];
    if (OPTIONS.showSmallAmountBatch) {
      invoiceRows.push(row('少額特例の一括修正', smallAmountBatchHtml, ROW_LINKS.smallAmountBatch));
    }
    invoiceRows.push(
      rowWithExtra('少額特例の対象事業者', smallAmountEligibleHtml, smallAmountEligibleExtraHtml, ROW_LINKS.smallAmountEligible),
      rowWithExtra('登録番号', registrationHtml, registrationExtraHtml, ROW_LINKS.registration)
    );

    const accountRows = [
      row('事業所作成者', fieldStateHtml(accounts.creator), ROW_LINKS.creator),
    ];

    let html = section('基本情報', basicRows)
      + section('消費税', taxRows)
      + section('インボイス制度関連', invoiceRows)
      + section('アカウント管理', accountRows);

    if (results.errors.length) {
      html += '<div class="fqv-error">' + results.errors.map(escapeHtml).join('<br>') + '</div>';
    }

    if (OPTIONS.showRawDebugJson) {
      const rawFields = {
        is_corporate: live.is_corporate,
        external_cid: live.external_cid,
        tax_method: live.tax_method,
        sales_tax_business_code: live.sales_tax_business_code,
        tax_account_method: live.tax_account_method,
        tax_fraction: live.tax_fraction,
        qualified_invoice_setting: live.qualified_invoice_setting,
        accounts_api: accounts.raw,
        current_fy_industry_codes: live.current_fy ? live.current_fy.industry_codes : undefined,
      };
      html += '<details class="fqv-raw"><summary>参考：freee内部コードの生値</summary><pre>'
        + escapeHtml(JSON.stringify(rawFields, null, 2))
        + '</pre></details>';
    }

    bodyEl.innerHTML = html;
  }

  // state('found'/'empty'/'missing')を持つフィールドを表示用HTMLに変換する。
  // 'missing'（要素が見つからない＝取得失敗）と'empty'（画面上も未設定）を区別する。
  function fieldStateHtml(field) {
    if (!field || field.state === 'missing') return notFound();
    if (field.state === 'empty') return muted('（未設定）');
    return escapeHtml(field.label != null ? field.label : String(field.value));
  }
  function notFound() {
    return '<span class="fqv-value fqv-warn">取得できませんでした</span>';
  }
  function muted(text) {
    return '<span class="fqv-value fqv-muted">' + escapeHtml(text) + '</span>';
  }
  function section(title, rowsHtmlArray) {
    return '<div class="fqv-section"><div class="fqv-section-title">' + escapeHtml(title) + '</div>'
      + rowsHtmlArray.join('')
      + '</div>';
  }
  function row(label, valueHtml, labelUrl) {
    const valueWrapped = /^<span/.test(valueHtml) ? valueHtml : '<span class="fqv-value">' + valueHtml + '</span>';
    copyRows.push([label, htmlToText(valueWrapped)]);
    return '<div class="fqv-row"><div class="fqv-label">' + rowLabelHtml(label, labelUrl) + '</div><div class="fqv-value-cell">' + valueWrapped + '</div></div>';
  }
  // 値の右側にアイコンリンクなどを付け足したい行（法人番号の外部検索リンクなど）用。
  // コピー用テキストにはアイコン部分は含めない。
  function rowWithExtra(label, valueHtml, extraHtml, labelUrl) {
    const valueWrapped = /^<span/.test(valueHtml) ? valueHtml : '<span class="fqv-value">' + valueHtml + '</span>';
    copyRows.push([label, htmlToText(valueWrapped)]);
    return '<div class="fqv-row"><div class="fqv-label">' + rowLabelHtml(label, labelUrl) + '</div><div class="fqv-value-cell">' + valueWrapped + (extraHtml || '') + '</div></div>';
  }
  // labelUrlが指定されていれば、項目名自体をその設定編集画面へのリンクにする。
  // 元の文字色のまま・下線なしで、ホバー時だけ色が変わる（.fqv-row-label-link参照）。
  function rowLabelHtml(label, labelUrl) {
    if (!labelUrl) return escapeHtml(label);
    return '<a href="' + escapeHtml(labelUrl) + '" target="_blank" rel="noopener noreferrer" class="fqv-row-label-link">' + escapeHtml(label) + '</a>';
  }
  function htmlToText(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent.trim();
  }
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  ensureButton();
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
