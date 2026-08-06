// ==UserScript==
// @name         freee 口座一覧コピー
// @namespace    https://eustacia.jp/
// @version      2.3.1
// @description  freee会計「口座」一覧画面(walletables)の口座情報をワンクリックでコピー。口座詳細画面にも勘定科目バッジと総勘定元帳ボタンを表示。
// @author       Eustacia.JP w/ Claude
// @match        https://secure.freee.co.jp/walletables*
// @match        https://secure.freee.co.jp/bank_account/walletables/*
// @match        https://secure.freee.co.jp/credit_card/walletables/*
// @match        https://secure.freee.co.jp/wallet/walletables/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=secure.freee.co.jp
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_ID = 'eustacia-copy-walletables-btn';

  // 「残高ずれ」アイコンの有無を判定(未登録明細数が0件の場合のみ表示される)
  function isBalanceMismatch(row) {
    return !!row.querySelector('[data-testid="stdui-table-cell-4"] [aria-label="残高ずれ"]');
  }

  // "1,234円" / "-427,943円" のような文字列を数値に変換する。空文字はnull。
  function parseAmount(str) {
    if (!str) return null;
    const cleaned = str.replace(/円/g, '').replace(/,/g, '').trim();
    if (cleaned === '') return null;
    const num = Number(cleaned);
    return Number.isNaN(num) ? null : num;
  }

  // freeeが検出する「残高ずれ」以外にも、不自然な残高の符号を独自に検出する
  // ・クレジットカードの登録残高がプラス(1円以上)
  // ・口座名が「現金」ちょうどで、登録残高がマイナス
  function hasInvalidBalanceSign({ category, name, regBalance }) {
    const amount = parseAmount(regBalance);
    if (amount === null) return false;
    if (category === 'クレジットカード' && amount > 0) return true;
    if (name === '現金' && amount < 0) return true;
    return false;
  }

  // -------------------------------------------------
  // 画面上の口座テーブルから情報を抽出する
  // -------------------------------------------------
  function extractAccounts() {
    const rows = document.querySelectorAll(
      '[data-testid="stdui-index-list-table"] table.vb-listTable__table tbody tr[data-testid^="stdui-table-row-"]'
    );

    const accounts = [];

    rows.forEach((row) => {
      const nameCell = row.querySelector('[data-testid="stdui-table-cell-口座名"]');
      if (!nameCell) return;

      const nameEl = nameCell.querySelector('.vb-text--weightBold');
      const categoryEl = nameCell.querySelector('[class*="_vb-statusIcon"]');
      const name = nameEl ? nameEl.textContent.trim() : '';
      const category = categoryEl ? categoryEl.textContent.trim() : '';
      if (!name) return;

      const regBalanceEl = row.querySelector('[data-testid="stdui-table-cell-登録残高"] .vb-text');
      const syncBalanceEl = row.querySelector('[data-testid="stdui-table-cell-同期残高"] .vb-text');
      const statusEl = row.querySelector('[data-testid="stdui-table-cell-ステータス"] .vb-text');
      const lastSyncCell = row.querySelector('[data-testid="stdui-table-cell-最終同期日時"]');

      const regBalance = regBalanceEl ? regBalanceEl.textContent.trim() : '';
      const syncBalance = syncBalanceEl ? syncBalanceEl.textContent.trim() : '';
      const status = statusEl ? statusEl.textContent.trim() : '';
      const isMismatch = isBalanceMismatch(row) || hasInvalidBalanceSign({ category, name, regBalance });

      let lastSync = '';
      if (lastSyncCell) {
        // ネストしたラッパーspanまで拾うと同じ文字列が何重にもなるため、
        // 日付・時刻を直接保持している最深部のdivだけを対象にする
        const container = lastSyncCell.querySelector('.vb-stack--directionVertical');
        if (container) {
          lastSync = Array.from(container.children)
            .map((el) => el.textContent.trim())
            .filter(Boolean)
            .join(' ');
        }
      }

      accounts.push({ name, category, regBalance, syncBalance, status, lastSync, isMismatch });
    });

    return accounts;
  }

  function isSyncErrorAccount(a) {
    return a.status === '同期失敗';
  }

  // -------------------------------------------------
  // ページ内に埋め込まれた freee.data.get('walletables') から
  // 口座名 → { walletable_id, ... } を引けるようにする
  // -------------------------------------------------
  function getWalletablesMap() {
    const map = new Map();
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!w.freee || !w.freee.data || typeof w.freee.data.get !== 'function') {
        return map;
      }
      const list = w.freee.data.get('walletables');
      if (!Array.isArray(list)) return map;
      list.forEach((item) => {
        if (item && item.name) map.set(item.name, item);
      });
    } catch (e) {
      console.error('[freee口座一覧コピー] freee.data(walletables)の取得に失敗:', e);
    }
    return map;
  }

  // -------------------------------------------------
  // freeeの内部API `/api/p/account_items/search` から、
  // 口座名 → 決算書表示名(group_name。例: 未払金・売掛金・現金及び預金) を直接取得する。
  // 同一ドメインへのリクエストのため fetch() のみでよく、
  // ブラウザのログインセッション(Cookie)でそのまま認証される。
  // -------------------------------------------------
  async function fetchAccountItemsSearch() {
    try {
      const res = await fetch('/api/p/account_items/search?display=default&searchable=manual_usable', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        console.error('[freee口座一覧コピー] account_items検索APIのステータス異常:', res.status);
        return [];
      }
      const data = await res.json();
      return Array.isArray(data.account_items) ? data.account_items : [];
    } catch (e) {
      console.error('[freee口座一覧コピー] account_items検索APIの取得に失敗:', e);
      return [];
    }
  }

  // 「現金」口座と銀行口座カテゴリーは対象外(ユーザー指定)
  function shouldShowAccountingCategory(a) {
    return a.category !== '銀行口座' && a.name !== '現金';
  }

  async function attachAccountingCategories(accounts) {
    const targets = accounts.filter(shouldShowAccountingCategory);
    if (targets.length === 0) return;

    const items = await fetchAccountItemsSearch();
    if (items.length === 0) return;

    const groupNameMap = new Map();
    items.forEach((item) => {
      if (item && item.name && item.group_name) {
        groupNameMap.set(item.name, item.group_name);
      }
    });

    targets.forEach((a) => {
      const groupName = groupNameMap.get(a.name);
      if (groupName) a.accountingCategory = groupName;
    });
  }

  // 同期失敗の口座について、トラブルシューティングページのURLを account.errorUrl に格納する
  // (ページ本文はSPAでJS描画されるため、静的取得はできない。リンクの提示に留める)
  function attachTroubleshootingLinks(accounts) {
    const walletablesMap = getWalletablesMap();
    if (walletablesMap.size === 0) return;

    accounts.filter(isSyncErrorAccount).forEach((a) => {
      const w = walletablesMap.get(a.name);
      if (!w || !w.walletable_id) return;
      a.errorUrl = `https://secure.freee.co.jp/bank_account/walletables/${w.walletable_id}/troubleshooting`;
    });
  }

  // ページャーの「全n件」表示を取得(取得件数との差分チェック用)
  function getTotalCountFromPager() {
    const pager = document.querySelector('[data-testid="stdui-list-pagination"]');
    if (!pager) return null;
    const text = pager.textContent.replace(/\s+/g, '');
    const match = text.match(/全(\d+)件/);
    return match ? parseInt(match[1], 10) : null;
  }

  // -------------------------------------------------
  // カテゴリ単位でグループ化し、各カテゴリ内は
  // 「表示中の口座 → 非表示の口座」の順に並べ替える
  // -------------------------------------------------
  function isHiddenAccount(a) {
    return a.status === '非表示';
  }

  function groupByCategory(accounts) {
    const map = new Map();
    accounts.forEach((a) => {
      const cat = a.category || 'カテゴリ不明';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(a);
    });
    for (const [cat, list] of map) {
      const visible = list.filter((a) => !isHiddenAccount(a));
      const hidden = list.filter((a) => isHiddenAccount(a));
      map.set(cat, visible.concat(hidden));
    }
    return map;
  }

  // -------------------------------------------------
  // ステータス文字列 → 省略アイコン表記への変換
  // 連携非対応・非表示は表示しない(nullを返す)
  // -------------------------------------------------
  function statusDisplay(status) {
    switch (status) {
      case '同期済み':
        return '🔗同期';
      case '未連携':
        return '⛔未同期';
      case '同期失敗':
        return '⚠️エラー';
      case '連携非対応':
      case '非表示':
        return null;
      default:
        return status || null;
    }
  }

  // -------------------------------------------------
  // 1口座分の表示用パーツを組み立てる
  // 例: 三井住友 渋谷駅前-5254211 🔗同期 (登録: 2,074,904円 / 同期: 1,154,758円) - 2026/08/04 04:10
  // -------------------------------------------------
  function accountDisplayParts(a) {
    const hidden = isHiddenAccount(a);
    const statusText = hidden ? null : statusDisplay(a.status);

    const regLabel = a.isMismatch ? '‼️登録' : '登録';
    const balanceParts = [`${regLabel}: ${a.regBalance || '-'}`];
    if (a.syncBalance) balanceParts.push(`同期: ${a.syncBalance}`);

    return {
      hiddenPrefix: hidden ? '[非表示] ' : '',
      statusText,
      balanceStr: `(${balanceParts.join(' / ')})`,
      lastSyncStr: a.lastSync ? ` - ${a.lastSync}` : '',
    };
  }

  function buildPlainAccountLine(a) {
    const { hiddenPrefix, statusText, balanceStr, lastSyncStr } = accountDisplayParts(a);
    const segments = [`${hiddenPrefix}${a.name}`];
    if (statusText) segments.push(statusText);
    segments.push(balanceStr);
    return segments.join(' ') + lastSyncStr;
  }

  // 口座ごとの付加情報(トラブルシューティングリンク・勘定科目カテゴリー)をプレーンテキストの行として返す
  function buildDetailLines(a) {
    const lines = [];
    if (a.errorUrl) lines.push('詳細: ' + a.errorUrl);
    if (a.accountingCategory) lines.push('勘定科目: ' + a.accountingCategory);
    return lines;
  }

  // 同上、HTML(<a>タグ含む)のリスト項目として返す
  function buildDetailLinesHtml(a) {
    const items = [];
    if (a.errorUrl) items.push(`<a href="${escapeHtml(a.errorUrl)}">詳細を確認</a>`);
    if (a.accountingCategory) items.push(`勘定科目: ${escapeHtml(a.accountingCategory)}`);
    return items;
  }

  function buildPlainText(groupedMap) {
    const lines = [];
    for (const [cat, list] of groupedMap) {
      lines.push(`・${cat}`);
      list.forEach((a) => {
        lines.push('  ・' + buildPlainAccountLine(a));
        buildDetailLines(a).forEach((line) => lines.push('    ・' + line));
      });
    }
    return lines.join('\n');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function buildHtml(groupedMap) {
    let html = '<ul>';
    for (const [cat, list] of groupedMap) {
      html += `<li><strong>${escapeHtml(cat)}</strong><ul>`;
      list.forEach((a) => {
        const hidden = isHiddenAccount(a);
        const { hiddenPrefix, statusText, balanceStr, lastSyncStr } = accountDisplayParts(a);

        const segments = [`${escapeHtml(hiddenPrefix)}<strong>${escapeHtml(a.name)}</strong>`];
        if (statusText) segments.push(escapeHtml(statusText));
        segments.push(escapeHtml(balanceStr));
        const line = segments.join(' ') + escapeHtml(lastSyncStr);

        const style = hidden ? ' style="color:#888888;"' : '';
        const details = buildDetailLinesHtml(a);
        if (details.length > 0) {
          const detailItems = details.map((d) => `<li>${d}</li>`).join('');
          html += `<li${style}>${line}<ul>${detailItems}</ul></li>`;
        } else {
          html += `<li${style}>${line}</li>`;
        }
      });
      html += '</ul></li>';
    }
    html += '</ul>';
    return html;
  }

  // -------------------------------------------------
  // コピー処理
  // -------------------------------------------------
  async function copyAccounts(btn) {
    const accounts = extractAccounts();

    if (accounts.length === 0) {
      alert('口座情報を取得できませんでした。ページの読み込みが完了してから再度お試しください。');
      return;
    }

    const total = getTotalCountFromPager();
    let extraNote = '';
    if (total !== null && total > accounts.length) {
      extraNote = `\n\n※ 全${total}件のうち画面表示中の${accounts.length}件のみコピーしました。\n全件コピーするには、画面下部の表示件数を「100件」等に変更してから再度実行してください。`;
    }

    // 同期エラーの口座があれば、トラブルシューティングページへのリンクを付与する
    attachTroubleshootingLinks(accounts);

    // 勘定科目(決算書表示名)を取得する
    const original = btn.textContent;
    btn.textContent = '勘定科目を取得中…';
    btn.disabled = true;
    await attachAccountingCategories(accounts);
    btn.textContent = original;
    btn.disabled = false;

    const grouped = groupByCategory(accounts);
    const text = buildPlainText(grouped);
    const html = buildHtml(grouped);

    try {
      const item = new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      });
      await navigator.clipboard.write([item]);
      flashButton(btn, `コピーしました（${accounts.length}件）`);
      if (extraNote) alert(`コピーしました（${accounts.length}件）${extraNote}`);
    } catch (e) {
      try {
        await navigator.clipboard.writeText(text);
        flashButton(btn, `コピーしました（${accounts.length}件・書式なし）`);
        if (extraNote) alert(`コピーしました（${accounts.length}件・書式なし）${extraNote}`);
      } catch (e2) {
        // エラー詳細取得の待ち時間でクリップボード書き込み権限が失効した場合などのフォールバック
        console.error('[freee口座一覧コピー] コピー失敗:', e2);
        window.prompt(
          '自動コピーに失敗しました。以下のテキストを手動でコピーしてください（Ctrl+A → Ctrl+C）:',
          text
        );
      }
    }
  }

  function flashButton(btn, message) {
    const original = btn.dataset.originalLabel || btn.textContent;
    btn.dataset.originalLabel = original;
    btn.textContent = message;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 2200);
  }

  // -------------------------------------------------
  // ボタンの生成・配置
  // -------------------------------------------------
  function createButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = '口座一覧をコピー';
    btn.title = '画面に表示中の口座一覧をコピーします（Googleドキュメントに箇条書きとして貼り付け可能）';
    btn.style.cssText = [
      'margin-left:12px',
      'padding:4px 12px',
      'font-size:13px',
      'line-height:1.5',
      'border:1px solid #285AC8',
      'border-radius:6px',
      'background:#fff',
      'color:#285AC8',
      'cursor:pointer',
      'font-family:inherit',
      'white-space:nowrap',
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#EBF3FF';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#fff';
    });
    btn.addEventListener('click', () => copyAccounts(btn));
    return btn;
  }

  function insertButton() {
    if (document.getElementById(BUTTON_ID)) return;

    // 「口座」という見出し(h1)の近くに配置する
    const title = Array.from(document.querySelectorAll('h1')).find(
      (h) => h.textContent.trim() === '口座'
    );
    if (!title || !title.parentElement) return;

    const btn = createButton();
    title.parentElement.appendChild(btn);
  }

  // -------------------------------------------------
  // 画面表示の強化
  // ・カテゴリーバッジ(「銀行口座」「クレジットカード」等)の隣に、
  //   同じ見た目のバッジで勘定科目名(決算書表示名)を表示する
  // ・登録残高をリンク化し、総勘定元帳を新しいタブで開けるようにする
  // -------------------------------------------------

  // true にすると、銀行口座・「現金」も含めた全口座にバッジを付与する
  const APPLY_ACCOUNTING_BADGE_TO_ALL = false;

  const ACCOUNTING_BADGE_CLASS = 'eustacia-account-category-badge';

  // account_items検索APIの結果(口座名 → 決算書表示名)をキャッシュする
  let groupNameMapCache = null;
  async function ensureGroupNameMap() {
    if (groupNameMapCache) return groupNameMapCache;
    const items = await fetchAccountItemsSearch();
    const map = new Map();
    items.forEach((item) => {
      if (item && item.name && item.group_name) map.set(item.name, item.group_name);
    });
    groupNameMapCache = map;
    return map;
  }

  function buildGeneralLedgerUrl(accountName) {
    return `https://secure.freee.co.jp/reports/general_ledgers/show?name=${encodeURIComponent(accountName)}`;
  }

  function decorateRow(row, groupNameMap) {
    if (row.dataset.eustaciaDecorated === '1') return;

    const nameCell = row.querySelector('[data-testid="stdui-table-cell-口座名"]');
    if (!nameCell) return;

    const nameEl = nameCell.querySelector('.vb-text--weightBold');
    const categoryEl = nameCell.querySelector('[class*="_vb-statusIcon"]');
    const name = nameEl ? nameEl.textContent.trim() : '';
    const category = categoryEl ? categoryEl.textContent.trim() : '';
    if (!name || !nameEl) return;

    // 勘定科目名バッジ(既存のカテゴリーバッジを複製し、テキストだけ差し替えて隣に表示)
    const shouldShowBadge = APPLY_ACCOUNTING_BADGE_TO_ALL || (category !== '銀行口座' && name !== '現金');
    if (shouldShowBadge && categoryEl && !categoryEl.dataset.eustaciaHasBadge) {
      const groupName = groupNameMap.get(name);
      if (groupName) {
        const badge = categoryEl.cloneNode(true);
        badge.textContent = groupName;
        badge.classList.add(ACCOUNTING_BADGE_CLASS);
        badge.style.marginLeft = '4px';
        categoryEl.insertAdjacentElement('afterend', badge);
        categoryEl.dataset.eustaciaHasBadge = '1';
      }
    }

    // 登録残高を総勘定元帳へのリンクにする
    const regEl = row.querySelector('[data-testid="stdui-table-cell-登録残高"] .vb-text');
    if (regEl && regEl.textContent.trim()) {
      const link = document.createElement('a');
      link.href = buildGeneralLedgerUrl(name);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = regEl.textContent;
      link.title = '総勘定元帳を開く';
      link.style.cssText = 'color:inherit;text-decoration:underline;';
      link.addEventListener('click', (e) => e.stopPropagation());
      regEl.textContent = '';
      regEl.appendChild(link);
    }

    row.dataset.eustaciaDecorated = '1';
  }

  function decorateAllRows() {
    const rows = document.querySelectorAll(
      '[data-testid="stdui-index-list-table"] table.vb-listTable__table tbody tr[data-testid^="stdui-table-row-"]'
    );
    if (rows.length === 0) return;

    ensureGroupNameMap()
      .then((map) => {
        rows.forEach((row) => decorateRow(row, map));
      })
      .catch((e) => {
        console.error('[freee口座一覧コピー] 画面表示の強化に失敗:', e);
      });
  }

  // -------------------------------------------------
  // 口座詳細画面(/bank_account/walletables/xxx, /credit_card/walletables/xxx,
  // /wallet/walletables/xxx)向けの表示強化
  // ・h1(口座名)の右に「決算書表示名：〇〇」を表示
  // ・「関連する操作」の「現預金レポート」ボタンの右に「総勘定元帳」ボタンを追加
  // -------------------------------------------------
  const DETAIL_BADGE_ID = 'eustacia-detail-group-name-badge';
  const DETAIL_GL_BUTTON_ID = 'eustacia-detail-gl-button';

  function findDetailPageH1() {
    return document.querySelector('h1[class*="_title--pageHeader"]');
  }

  function findCashBalanceJumpButton() {
    const link = document.querySelector('a[href*="/reports/cash_balance"]');
    return link ? link.closest('.vb-jumpButton') : null;
  }

  // URLのプレフィックスから「銀行口座」相当かどうかを判定する(一覧画面のカテゴリー名と揃える)
  function getCategoryFromDetailUrl() {
    if (location.pathname.startsWith('/bank_account/')) return '銀行口座';
    if (location.pathname.startsWith('/credit_card/')) return 'クレジットカード';
    return null;
  }

  function decorateDetailPage() {
    const h1 = findDetailPageH1();
    if (!h1) return;
    const accountName = h1.textContent.trim();
    if (!accountName) return;

    // 決算書表示名バッジ(h1の右)
    if (!document.getElementById(DETAIL_BADGE_ID)) {
      const category = getCategoryFromDetailUrl();
      const shouldShowBadge = APPLY_ACCOUNTING_BADGE_TO_ALL || (category !== '銀行口座' && accountName !== '現金');
      if (shouldShowBadge) {
        ensureGroupNameMap()
          .then((map) => {
            if (document.getElementById(DETAIL_BADGE_ID)) return;
            const groupName = map.get(accountName);
            if (!groupName || !h1.parentElement) return;
            const badge = document.createElement('span');
            badge.id = DETAIL_BADGE_ID;
            badge.textContent = `決算書表示名：${groupName}`;
            badge.style.cssText = [
              'display:inline-block',
              'margin-left:12px',
              'font-size:0.75rem',
              'font-weight:normal',
              'color:#555',
              'vertical-align:middle',
              'align-self:center',
              'white-space:nowrap',
              'border:1px solid #ccc',
              'border-radius:6px',
              'padding:2px 8px',
              'background:#f7f7f7',
            ].join(';');
            h1.insertAdjacentElement('afterend', badge);
          })
          .catch((e) => {
            console.error('[freee口座一覧コピー] 決算書表示名バッジの表示に失敗:', e);
          });
      }
    }

    // 総勘定元帳ボタン(「現預金レポート」ボタンの右)
    if (!document.getElementById(DETAIL_GL_BUTTON_ID)) {
      const cashBalanceBtn = findCashBalanceJumpButton();
      if (cashBalanceBtn) {
        const glBtn = cashBalanceBtn.cloneNode(true);
        glBtn.id = DETAIL_GL_BUTTON_ID;
        const a = glBtn.querySelector('a');
        if (a) {
          a.href = buildGeneralLedgerUrl(accountName);
          const textEl = a.querySelector('.vb-button__text');
          if (textEl) textEl.textContent = '総勘定元帳';
        }
        cashBalanceBtn.insertAdjacentElement('afterend', glBtn);
      }
    }
  }

  // -------------------------------------------------
  // ページ種別に応じて実行する処理を切り替える
  // -------------------------------------------------
  const isListPage = /^\/walletables\/?(\?|$)/.test(location.pathname + (location.search || ''));
  const isDetailPage = /^\/(bank_account|credit_card|wallet)\/walletables\/\d+/.test(location.pathname);

  if (isListPage) {
    // SPAのため、DOM変化を監視してボタンを維持する。
    // ただし document.body 全体を subtree:true で監視すると、初期描画時の
    // 大量のDOM更新のたびにコールバックが発火し、画面の読み込みが重くなるため、
    // 一定時間(300ms)まとめてから1回だけ insertButton を実行するようデバウンスする。
    let insertButtonTimer = null;
    const scheduleInsertButton = () => {
      if (insertButtonTimer) return;
      insertButtonTimer = setTimeout(() => {
        insertButtonTimer = null;
        insertButton();
        decorateAllRows();
      }, 300);
    };

    const observer = new MutationObserver(() => {
      scheduleInsertButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    insertButton();
    decorateAllRows();
  } else if (isDetailPage) {
    let detailTimer = null;
    const scheduleDetailDecoration = () => {
      if (detailTimer) return;
      detailTimer = setTimeout(() => {
        detailTimer = null;
        decorateDetailPage();
      }, 300);
    };

    const detailObserver = new MutationObserver(() => {
      scheduleDetailDecoration();
    });
    detailObserver.observe(document.body, { childList: true, subtree: true });

    decorateDetailPage();
  }
})();
