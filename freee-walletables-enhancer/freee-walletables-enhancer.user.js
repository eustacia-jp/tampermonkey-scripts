// ==UserScript==
// @name         freee 口座一覧コピー＆表示拡張
// @namespace    https://eustacia.jp/
// @version      2.15.0
// @description  freee会計「口座」一覧画面(walletables)の口座情報をコピー(取り違え予防のため事業所名を含める。ボタンのメニューから「現在の残高(リスト形式)」「期末残高のみ(リスト形式)」「全項目(タブ区切り。残高異常・未登録明細数・口座詳細URL・総勘定元帳URL付き。非表示口座も含めaccount_itemsから取得)」の3形式を選択可能)。登録残高に加え、現会計期間の期末残高も内部API(/api/p/reports/general_ledgers)から取得して表示(一覧画面には「同期残高」列の右に期末残高列を追加、ヒント付き。負債の勘定科目は符号を反転して登録残高側と揃え、事業所の「マイナスの表示方法」設定(-/△)にも追従)。口座詳細画面にも勘定科目バッジ・期末残高バッジと総勘定元帳ボタンを表示(クレジットカードは現預金レポートボタンも追加。挿入起点は口座振替の一覧→取引の一覧の順でフォールバック)。コピー時には資産・負債の区分に基づく残高符号異常や非表示口座の残高不整合も検出。「同期中」ステータス表記にも対応。freee側のCSSクラス名ハッシュ変更に追従。
// @author       Eustacia.JP w/ Claude
// @match        https://secure.freee.co.jp/walletables*
// @match        https://secure.freee.co.jp/bank_account/walletables/*
// @match        https://secure.freee.co.jp/credit_card/walletables/*
// @match        https://secure.freee.co.jp/wallet/walletables/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=freee.co.jp
// @updateURL    https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-walletables-enhancer/freee-walletables-enhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-walletables-enhancer/freee-walletables-enhancer.user.js
// @supportURL   https://github.com/eustacia-jp/tampermonkey-scripts/issues
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

  // freeeが検出する「残高ずれ」以外にも、不自然な残高の符号を独自に検出する。
  // ただしこの判定には勘定科目の資産・負債区分(bucket)と期末残高(periodEndBalance)が要るため、
  // それらが出揃った後(コピー処理内でattachPeriodEndBalances()の後)に呼び出すこと。
  // ・非表示ステータスの口座なのに、登録残高または期末残高が0円でない
  // ・資産の口座の登録残高または期末残高がマイナスになっている
  // ・負債の口座の登録残高または期末残高がプラス(1円以上)になっている
  function hasInvalidBalanceSign(a) {
    const regAmount = parseAmount(a.regBalance);
    const periodEndAmount = typeof a.periodEndBalance === 'number' ? a.periodEndBalance : null;

    if (a.status === '非表示') {
      if (regAmount !== null && regAmount !== 0) return true;
      if (periodEndAmount !== null && periodEndAmount !== 0) return true;
    }
    if (a.bucket === '資産') {
      if (regAmount !== null && regAmount < 0) return true;
      if (periodEndAmount !== null && periodEndAmount < 0) return true;
    }
    if (a.bucket === '負債') {
      if (regAmount !== null && regAmount > 0) return true;
      if (periodEndAmount !== null && periodEndAmount > 0) return true;
    }
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

      const nameEl = nameCell.querySelector('[class*="vb-text"]');
      const categoryEl = nameCell.querySelector('[class*="_vb-statusIcon"]');
      const name = nameEl ? nameEl.textContent.trim() : '';
      const category = categoryEl ? categoryEl.textContent.trim() : '';
      if (!name) return;

      const regBalanceEl = row.querySelector('[data-testid="stdui-table-cell-登録残高"] [class*="vb-text"]');
      const syncBalanceEl = row.querySelector('[data-testid="stdui-table-cell-同期残高"] [class*="vb-text"]');
      const statusEl = row.querySelector('[data-testid="stdui-table-cell-ステータス"] [class*="vb-text"]');
      const lastSyncCell = row.querySelector('[data-testid="stdui-table-cell-最終同期日時"]');
      // 未登録明細数のセルは、0件のときは <span class="_vb-text_..."> のプレーンテキスト、
      // 1件以上のときは <a class="vb-inlineLink" href="wallet_txns/stream?...">件数</a> というリンクになる。
      // どちらもtextContentで拾えるため、セル全体のテキストをそのまま使う。
      const unregisteredCountCell = row.querySelector('[data-testid="stdui-table-cell-未登録明細数"]');
      const unregisteredCount = unregisteredCountCell ? unregisteredCountCell.textContent.trim() : '';

      const regBalance = regBalanceEl ? regBalanceEl.textContent.trim() : '';
      const syncBalance = syncBalanceEl ? syncBalanceEl.textContent.trim() : '';
      const status = statusEl ? statusEl.textContent.trim() : '';
      // freee自身が検出する「残高ずれ」と、スクリプト独自の符号異常判定は別の観点なので
      // freeeMismatch/customMismatchとして別々に保持する(タブ区切りの「残高異常」列で
      // 「残高ズレ」「要確認」を出し分けるため)。isMismatchは両方をORした
      // 従来通りの‼️表示用フラグ(customMismatchはattachBalanceSignFlags()で後から設定)。
      const freeeMismatch = isBalanceMismatch(row);
      const isMismatch = freeeMismatch;

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

      accounts.push({
        name,
        category,
        regBalance,
        syncBalance,
        status,
        lastSync,
        isMismatch,
        freeeMismatch,
        unregisteredCount,
      });
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

  // freee.data.get('walletables') には非表示口座のデータが含まれない(確認済み)ため、
  // 口座詳細URLのwalletable_id取得には account_items(勘定科目マスタ)を使う。
  // account_itemsは非表示・表示にかかわらず全口座分を含む。
  // 口座名 → walletable_id を引けるMapを返す。同じ名前で異なるwalletable_idが
  // 複数見つかった場合(通常freeeの仕様上は起こらないはずだが、念のための安全策として)は
  // 誤ったURLを組み立てないよう、そのnameの値をnullにして「取得不可」を表す。
  function getAccountItemsMap() {
    const map = new Map();
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!w.freee || !w.freee.data || typeof w.freee.data.get !== 'function') {
        return map;
      }
      const list = w.freee.data.get('account_items');
      if (!Array.isArray(list)) return map;
      list.forEach((item) => {
        if (!item || !item.name || !item.walletable_id) return;
        if (map.has(item.name)) {
          const existing = map.get(item.name);
          if (existing !== null && existing !== item.walletable_id) {
            console.error(
              `[freee口座一覧コピー] account_itemsで口座名「${item.name}」に複数の異なるwalletable_idが見つかったため、この口座のURLは取得しません。`
            );
            map.set(item.name, null);
          }
        } else {
          map.set(item.name, item.walletable_id);
        }
      });
    } catch (e) {
      console.error('[freee口座一覧コピー] freee.data(account_items)の取得に失敗:', e);
    }
    return map;
  }

  // -------------------------------------------------
  // 負債の勘定科目を判定するためのしくみ
  // ・口座一覧画面には freee.data.get('account_category_options') が埋め込まれている。
  //   (勘定科目設定画面(/account_items)で見られる freee.data.get('account_categories') とは
  //   キー名・構造ともに異なるので注意。実際に確認した形は次の通り:
  //     [
  //       { table: { report_type: "貸借対照表の勘定科目", options: [
  //           { table: { id, name, entry_side, report, category_type, category_names } }, ...
  //       ] } },
  //       { table: { report_type: "損益計算書の勘定科目", options: [...] } },
  //     ]
  //   category_names は法人なら ["負債及び純資産","負債","仕入債務"] のように3階層(中分類が「負債」)、
  //   個人事業主なら ["負債","流動負債","仕入債務"] のように大分類が直接「負債」になる(いずれもユーザー提供の
  //   実データで確認済み)。どちらの階層でも「負債」を含むかどうかで判定すれば安全。
  // ・freee.data.get('account_items') の各要素が持つ account_category_id を
  //   このカテゴリIDと突き合わせることで、口座(勘定科目)ごとに負債かどうかがわかる。
  // ・総勘定元帳サマリーAPIのfinal_balanceは account_item_id をキーに持つため、
  //   「負債のaccount_item_id」の集合を作れば、期末残高マップ構築時に符号反転できる。
  // -------------------------------------------------
  // 貸借対照表の勘定科目カテゴリーのうち、category_names に bucketName(「資産」「負債」等)を
  // 含むものの category_id 集合を返す汎用関数
  function getBsCategoryIdSetByBucket(bucketName) {
    const idSet = new Set();
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!w.freee || !w.freee.data || typeof w.freee.data.get !== 'function') return idSet;
      const categoryOptions = w.freee.data.get('account_category_options');
      if (!Array.isArray(categoryOptions)) return idSet;
      const bsEntry = categoryOptions.find(
        (o) => o && o.table && o.table.report_type === '貸借対照表の勘定科目'
      );
      const bsList = bsEntry && bsEntry.table ? bsEntry.table.options : null;
      if (!Array.isArray(bsList)) return idSet;
      bsList.forEach((opt) => {
        const c = opt && opt.table;
        if (c && Array.isArray(c.category_names) && c.category_names.includes(bucketName)) {
          idSet.add(c.id);
        }
      });
    } catch (e) {
      console.error('[freee口座一覧コピー] freee.data(account_category_options)の取得に失敗:', e);
    }
    return idSet;
  }

  function getLiabilityCategoryIdSet() {
    return getBsCategoryIdSetByBucket('負債');
  }

  function getAssetCategoryIdSet() {
    return getBsCategoryIdSetByBucket('資産');
  }

  // 負債に該当する account_item_id の集合を返す(総勘定元帳の期末残高の符号反転に使う)
  function getLiabilityAccountItemIdSet() {
    const idSet = new Set();
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!w.freee || !w.freee.data || typeof w.freee.data.get !== 'function') return idSet;
      const liabilityCategoryIds = getLiabilityCategoryIdSet();
      if (liabilityCategoryIds.size === 0) return idSet;
      const items = w.freee.data.get('account_items');
      if (!Array.isArray(items)) return idSet;
      items.forEach((item) => {
        if (item && liabilityCategoryIds.has(item.account_category_id)) {
          idSet.add(item.id);
        }
      });
    } catch (e) {
      console.error('[freee口座一覧コピー] 負債account_item_idの判定に失敗:', e);
    }
    return idSet;
  }

  // 口座名 → '資産' | '負債' | null(どちらでもない) を引けるMapを返す。
  // account_items のうち walletable_id を持つもの(=実在の口座)だけを対象とする。
  // account_category_id が資産・負債どちらのカテゴリーIDとも一致しない場合はnull
  // (収益・費用・純資産等の科目を口座として使っているケースなど)。
  // 同じ口座名で判定結果が矛盾する場合(通常は起こらないはずだが念のため)は、
  // 誤検出を避けるためそのnameの値をnullにする。
  function getAccountBucketMap() {
    const map = new Map();
    try {
      const liabilityIds = getLiabilityCategoryIdSet();
      const assetIds = getAssetCategoryIdSet();
      if (liabilityIds.size === 0 && assetIds.size === 0) return map;

      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!w.freee || !w.freee.data || typeof w.freee.data.get !== 'function') return map;
      const items = w.freee.data.get('account_items');
      if (!Array.isArray(items)) return map;

      items.forEach((item) => {
        if (!item || !item.name || !item.walletable_id) return;
        let bucket = null;
        if (liabilityIds.has(item.account_category_id)) bucket = '負債';
        else if (assetIds.has(item.account_category_id)) bucket = '資産';
        if (!bucket) return;

        if (map.has(item.name)) {
          const existing = map.get(item.name);
          if (existing !== null && existing !== bucket) {
            console.error(
              `[freee口座一覧コピー] account_itemsで口座名「${item.name}」の資産・負債区分が一致しないため、この口座の符号異常判定は行いません。`
            );
            map.set(item.name, null);
          }
        } else {
          map.set(item.name, bucket);
        }
      });
    } catch (e) {
      console.error('[freee口座一覧コピー] 資産・負債区分の判定に失敗:', e);
    }
    return map;
  }

  // 各口座に資産・負債区分(a.bucket)を設定したうえで、freee検出以外の符号異常を
  // 独自に検出し、a.customMismatch に格納する(a.isMismatchはfreee検出分と合わせたOR)。
  // 期末残高(periodEndBalance)を使うため、必ずattachPeriodEndBalances()の後に呼び出すこと。
  function attachBalanceSignFlags(accounts) {
    const bucketMap = getAccountBucketMap();
    accounts.forEach((a) => {
      a.bucket = bucketMap.get(a.name) || null;
      a.customMismatch = hasInvalidBalanceSign(a);
      if (a.customMismatch) a.isMismatch = true;
    });
  }

  // タブ区切りの「残高異常」列用のテキストを組み立てる。
  // freee検出の「残高ズレ」とスクリプト独自の「要確認」を出し分け、両方該当する場合は連結する。
  function balanceAnomalyText(a) {
    const labels = [];
    if (a.freeeMismatch) labels.push('残高ズレ');
    if (a.customMismatch) labels.push('要確認');
    return labels.join('・');
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

  // 「現金」口座と銀行口座カテゴリーは対象外(ユーザー指定、リスト形式向け)
  function shouldShowAccountingCategory(a) {
    return a.category !== '銀行口座' && a.name !== '現金';
  }

  // a.accountingCategory: リスト形式用(銀行口座・現金は除外、従来通り)
  // a.accountingCategoryAll: タブ区切り用(銀行口座・現金も含めすべての口座に設定)
  async function attachAccountingCategories(accounts) {
    const items = await fetchAccountItemsSearch();
    if (items.length === 0) return;

    const groupNameMap = new Map();
    items.forEach((item) => {
      if (item && item.name && item.group_name) {
        groupNameMap.set(item.name, item.group_name);
      }
    });

    accounts.forEach((a) => {
      const groupName = groupNameMap.get(a.name);
      if (!groupName) return;
      a.accountingCategoryAll = groupName;
      if (shouldShowAccountingCategory(a)) a.accountingCategory = groupName;
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

  // -------------------------------------------------
  // 現会計期間の期末残高を取得する
  // ・freee.data.get('fiscal_years') から status===1(現会計期間)の年度情報を取得
  // ・freee.data.get('walletables') の各口座の id は、そのまま総勘定元帳の
  //   account_item_id として使える(walletable_id とは別の値なので注意)
  // ・内部API `/api/p/reports/general_ledgers` に fiscal_year_id・start_date・end_date を
  //   付けてfetchすると、全account_item分の期末残高(final_balance)がまとめて返ってくる。
  //   (総勘定元帳の画面(/reports/general_ledgers、/showなし)自体はReactでクライアント
  //   描画されるため、そのHTMLを直接fetchしても中身は取得できない。裏で叩かれている
  //   このJSON APIを直接呼ぶ)
  // -------------------------------------------------
  // 取り違え予防のため、コピー結果に含める事業所名を取得する
  // (freee.data.get('company').display_name。個人事業主は name が null のことがあるため display_name を使う)
  function getCurrentCompanyName() {
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!w.freee || !w.freee.data || typeof w.freee.data.get !== 'function') return null;
      const company = w.freee.data.get('company');
      if (!company) return null;
      return company.display_name || company.name || null;
    } catch (e) {
      console.error('[freee口座一覧コピー] freee.data(company)の取得に失敗:', e);
      return null;
    }
  }

  // 事業所の詳細設定(https://secure.freee.co.jp/company/detail)にある
  // 「マイナスの表示方法」("-" か "△" か)を取得する。
  // freee.data.get('company').minus_format が数値で入っており、
  // ユーザー自身の事業所で「△」に切り替えて確認したところ 1 になったことを確認済み
  // (デフォルトの「-」は 0 とみられる)。
  // この設定は登録残高・同期残高等freeeが自前でレンダリングしている値には既に反映されているが、
  // 期末残高はこのスクリプトが内部APIの数値からformatYen()で独自に文字列化しているため、
  // 同じ設定に追従させる必要がある。
  function getMinusFormatUsesTriangle() {
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!w.freee || !w.freee.data || typeof w.freee.data.get !== 'function') return false;
      const company = w.freee.data.get('company');
      return !!company && company.minus_format === 1;
    } catch (e) {
      console.error('[freee口座一覧コピー] freee.data(company)のマイナス表示方法の取得に失敗:', e);
      return false;
    }
  }

  function getCurrentFiscalYear() {
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!w.freee || !w.freee.data || typeof w.freee.data.get !== 'function') return null;
      const list = w.freee.data.get('fiscal_years');
      if (!Array.isArray(list)) return null;
      // status: 1 = 現会計期間、0 = 過去の期間、5 = 未来の期間(想定)
      const current = list.find((fy) => fy && fy.status === 1);
      if (!current) return null;
      return { id: current.id, start_date: current.start_date, end_date: current.end_date };
    } catch (e) {
      console.error('[freee口座一覧コピー] freee.data(fiscal_years)の取得に失敗:', e);
      return null;
    }
  }

  // freee.data.get('fiscal_years')の各要素が持つ company_id を拝借する
  // (X-Company-Idヘッダーが必要な場合に備えて付与する)
  function getCompanyId() {
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (!w.freee || !w.freee.data || typeof w.freee.data.get !== 'function') return null;
      const list = w.freee.data.get('fiscal_years');
      if (Array.isArray(list) && list[0] && list[0].company_id) return list[0].company_id;
    } catch (e) {
      // 取得できなくても致命的ではないので握りつぶす
    }
    return null;
  }

  // 内部API `/api/p/reports/general_ledgers` から、現会計期間の
  // account_item_id → final_balance(期末残高) の一覧をまとめて取得する
  async function fetchGeneralLedgerSummaries(fiscalYear) {
    const params = new URLSearchParams({
      fiscal_year_id: String(fiscalYear.id),
      start_date: fiscalYear.start_date,
      end_date: fiscalYear.end_date,
      include_master_name_history: 'true',
    });
    const headers = { Accept: 'application/json' };
    const companyId = getCompanyId();
    if (companyId) headers['X-Company-Id'] = String(companyId);

    try {
      const res = await fetch(`/api/p/reports/general_ledgers?${params.toString()}`, {
        credentials: 'same-origin',
        headers,
      });
      if (!res.ok) {
        console.error('[freee口座一覧コピー] 総勘定元帳サマリーAPIのステータス異常:', res.status);
        return [];
      }
      const data = await res.json();
      return Array.isArray(data.general_ledgers_summaries) ? data.general_ledgers_summaries : [];
    } catch (e) {
      console.error('[freee口座一覧コピー] 総勘定元帳サマリーAPIの取得に失敗:', e);
      return [];
    }
  }

  function formatYen(amount) {
    // -1倍などの演算で -0 になったものが "-0円" と表示されるのを防ぐ(0 === -0はtrueなので判定可能)
    const normalized = amount === 0 ? 0 : amount;
    // 事業所の「マイナスの表示方法」が「△」設定の場合は、"-1,000円"ではなく"△1,000円"にする
    if (normalized < 0 && getMinusFormatUsesTriangle()) {
      return `△${Math.abs(normalized).toLocaleString('ja-JP')}円`;
    }
    return `${normalized.toLocaleString('ja-JP')}円`;
  }

  // account_item_id → final_balance のMapをキャッシュする(1ページ内では会計期間は変わらない前提)
  let periodEndBalanceMapCache = null;
  let periodEndBalanceMapCacheFiscalYearId = null;

  async function ensurePeriodEndBalanceMap() {
    const fiscalYear = getCurrentFiscalYear();
    if (!fiscalYear) return new Map();

    if (periodEndBalanceMapCache && periodEndBalanceMapCacheFiscalYearId === fiscalYear.id) {
      return periodEndBalanceMapCache;
    }

    const summaries = await fetchGeneralLedgerSummaries(fiscalYear);
    // 負債の勘定科目は、総勘定元帳のfinal_balanceが会計上の符号(貸方=正)になっている一方、
    // 口座一覧画面の登録残高・同期残高は「現金の動き」としての符号(負債が増える=マイナス)になっている。
    // 見た目の符号を口座一覧側に合わせるため、負債に該当するaccount_item_idの残高は-1倍する。
    const liabilityIdSet = getLiabilityAccountItemIdSet();
    const map = new Map();
    summaries.forEach((s) => {
      if (s && typeof s.account_item_id !== 'undefined' && typeof s.final_balance === 'number') {
        const balance = liabilityIdSet.has(s.account_item_id) ? -1 * s.final_balance : s.final_balance;
        map.set(s.account_item_id, balance);
      }
    });
    periodEndBalanceMapCache = map;
    periodEndBalanceMapCacheFiscalYearId = fiscalYear.id;
    return map;
  }

  // 各口座の期末残高を取得し、a.periodEndBalance(数値) に格納する。
  // walletables の id(=account_item_id) が取得できない口座は対象外とする。
  async function attachPeriodEndBalances(accounts) {
    const walletablesMap = getWalletablesMap();
    if (walletablesMap.size === 0) return;

    const balanceMap = await ensurePeriodEndBalanceMap();
    if (balanceMap.size === 0) return;

    accounts.forEach((a) => {
      const w = walletablesMap.get(a.name);
      if (!w || !w.id) return;
      const balance = balanceMap.get(w.id);
      if (typeof balance === 'number') a.periodEndBalance = balance;
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
      case '同期中':
        return '⏳同期中';
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
  // mode: 'current' = 登録残高/同期残高(通常時向け, デフォルト), 'periodEnd' = 期末残高のみ(決算処理向け)
  function accountDisplayParts(a, mode = 'current') {
    const hidden = isHiddenAccount(a);
    const statusText = hidden ? null : statusDisplay(a.status);

    let balanceParts;
    if (mode === 'periodEnd') {
      const periodEndText = typeof a.periodEndBalance === 'number' ? formatYen(a.periodEndBalance) : '-';
      const periodEndLabel = a.isMismatch ? '‼️期末' : '期末';
      balanceParts = [`${periodEndLabel}: ${periodEndText}`];
    } else {
      const regLabel = a.isMismatch ? '‼️登録' : '登録';
      balanceParts = [`${regLabel}: ${a.regBalance || '-'}`];
      if (a.syncBalance) balanceParts.push(`同期: ${a.syncBalance}`);
    }

    // 期末残高のみモードでは最終同期日時は意味を持たないため表示しない
    const lastSyncStr = mode === 'periodEnd' ? '' : a.lastSync ? ` - ${a.lastSync}` : '';

    return {
      hiddenPrefix: hidden ? '[非表示] ' : '',
      statusText,
      balanceStr: `(${balanceParts.join(' / ')})`,
      lastSyncStr,
    };
  }

  function buildPlainAccountLine(a, mode) {
    const { hiddenPrefix, statusText, balanceStr, lastSyncStr } = accountDisplayParts(a, mode);
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

  function buildPlainText(groupedMap, mode, companyName) {
    const lines = [];
    if (companyName) lines.push(`・事業所名：${companyName}`);
    for (const [cat, list] of groupedMap) {
      lines.push(`・${cat}`);
      list.forEach((a) => {
        lines.push('  ・' + buildPlainAccountLine(a, mode));
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

  function buildHtml(groupedMap, mode, companyName) {
    let html = '<ul>';
    if (companyName) html += `<li><strong>事業所名：${escapeHtml(companyName)}</strong></li>`;
    for (const [cat, list] of groupedMap) {
      html += `<li><strong>${escapeHtml(cat)}</strong><ul>`;
      list.forEach((a) => {
        const hidden = isHiddenAccount(a);
        const { hiddenPrefix, statusText, balanceStr, lastSyncStr } = accountDisplayParts(a, mode);

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

  // タブ区切り(表計算ソフト貼り付け用)。カテゴリ別のグループ化はせず、全口座をフラットな行として出力する
  function tsvEscape(value) {
    return String(value == null ? '' : value)
      .replace(/[\t\n\r]+/g, ' ')
      .trim();
  }

  function buildTabSeparatedText(accounts, accountItemsMap, companyName) {
    const headers = [
      '事業所名',
      'カテゴリ',
      '口座名',
      '表示状態',
      'ステータス',
      '登録残高',
      '同期残高',
      '期末残高',
      '残高異常',
      '未登録明細数',
      '最終同期日時',
      '勘定科目',
      '口座詳細URL',
      '総勘定元帳URL',
    ];
    const lines = [headers.join('\t')];
    accounts.forEach((a) => {
      const hidden = isHiddenAccount(a);
      const statusText = hidden ? '' : statusDisplay(a.status) || a.status || '';
      const periodEndText = typeof a.periodEndBalance === 'number' ? formatYen(a.periodEndBalance) : '';
      const { detailUrl, generalLedgerUrl } = buildAccountUrls(a, accountItemsMap);
      const row = [
        companyName || '',
        a.category || '',
        a.name || '',
        hidden ? '非表示' : '表示',
        statusText,
        a.regBalance || '',
        a.syncBalance || '',
        periodEndText,
        balanceAnomalyText(a),
        a.unregisteredCount || '',
        a.lastSync || '',
        a.accountingCategoryAll || '',
        detailUrl,
        generalLedgerUrl,
      ].map(tsvEscape);
      lines.push(row.join('\t'));
    });
    return lines.join('\n');
  }

  // -------------------------------------------------
  // コピー処理
  // mode: 'current' = 現在の残高(リスト形式), 'periodEnd' = 期末残高のみ(リスト形式), 'tsv' = 全項目(タブ区切り)
  // -------------------------------------------------
  async function copyAccounts(btn, mode = 'current') {
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

    // 勘定科目(決算書表示名)・期末残高を取得する
    const original = btn.dataset.originalLabel || btn.textContent;
    btn.dataset.originalLabel = original;
    btn.disabled = true;
    btn.textContent = '勘定科目を取得中…';
    await attachAccountingCategories(accounts);
    btn.textContent = '期末残高を取得中…';
    await attachPeriodEndBalances(accounts);
    btn.textContent = original;
    btn.disabled = false;

    // 資産・負債区分を判定し、freee検出以外の符号異常(‼️)を反映する
    attachBalanceSignFlags(accounts);

    // 取り違え予防のため、事業所名をコピー結果に含める
    const companyName = getCurrentCompanyName();

    let text, html, successLabel;
    if (mode === 'tsv') {
      text = buildTabSeparatedText(accounts, getAccountItemsMap(), companyName);
      html = null;
      successLabel = `全項目をコピーしました（${accounts.length}件）`;
    } else {
      const grouped = groupByCategory(accounts);
      text = buildPlainText(grouped, mode, companyName);
      html = buildHtml(grouped, mode, companyName);
      successLabel =
        mode === 'periodEnd'
          ? `期末残高をコピーしました（${accounts.length}件）`
          : `コピーしました（${accounts.length}件）`;
    }

    try {
      if (html) {
        const item = new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        });
        await navigator.clipboard.write([item]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      flashButton(btn, successLabel);
      if (extraNote) alert(`${successLabel}${extraNote}`);
    } catch (e) {
      try {
        await navigator.clipboard.writeText(text);
        flashButton(btn, `${successLabel}・書式なし`);
        if (extraNote) alert(`${successLabel}・書式なし${extraNote}`);
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
  // ボタンの生成・配置(コピー形式を選べるメニュー付きボタン)
  // -------------------------------------------------
  const COPY_MENU_ID = 'eustacia-copy-walletables-menu';
  const COPY_MODES = [
    {
      mode: 'current',
      label: '現在の残高 (リスト形式)',
      hint: '登録残高・同期残高がわかる、通常時向けのリスト形式でコピーします',
    },
    {
      mode: 'periodEnd',
      label: '期末残高のみ (リスト形式)',
      hint: '現在の会計期間の期末残高のみを表示するリスト形式でコピーします(決算処理向け)',
    },
    {
      mode: 'tsv',
      label: '全項目 (タブ区切り)',
      hint: '表計算ソフトにそのまま貼り付けられるよう、残高・口座詳細URL・総勘定元帳URL等の全項目をタブ区切りでコピーします',
    },
  ];

  function createButtonGroup() {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;display:inline-block;margin-left:12px;';

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = '口座一覧をコピー ▾';
    btn.title = '画面に表示中の口座一覧をコピーします（クリックしてコピー形式を選択）';
    btn.style.cssText = [
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
      if (!btn.disabled) btn.style.background = '#EBF3FF';
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.disabled) btn.style.background = '#fff';
    });

    const menu = document.createElement('div');
    menu.id = COPY_MENU_ID;
    menu.style.cssText = [
      'position:absolute',
      'top:calc(100% + 4px)',
      'left:0',
      'z-index:1000',
      'display:none',
      'background:#fff',
      'border:1px solid #ddd',
      'border-radius:6px',
      'box-shadow:0 2px 10px rgba(0,0,0,0.15)',
      'min-width:230px',
      'overflow:hidden',
    ].join(';');

    COPY_MODES.forEach(({ mode, label, hint }) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = label;
      item.title = hint;
      item.style.cssText = [
        'display:block',
        'width:100%',
        'text-align:left',
        'padding:8px 14px',
        'font-size:13px',
        'border:none',
        'background:#fff',
        'color:#333',
        'cursor:pointer',
        'font-family:inherit',
        'white-space:nowrap',
      ].join(';');
      item.addEventListener('mouseenter', () => {
        item.style.background = '#EBF3FF';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = '#fff';
      });
      item.addEventListener('click', () => {
        if (btn.disabled) return;
        menu.style.display = 'none';
        copyAccounts(btn, mode);
      });
      menu.appendChild(item);
    });

    btn.addEventListener('click', (e) => {
      if (btn.disabled) return;
      e.stopPropagation();
      menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    });

    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) menu.style.display = 'none';
    });

    wrapper.appendChild(btn);
    wrapper.appendChild(menu);
    return wrapper;
  }

  function insertButton() {
    if (document.getElementById(BUTTON_ID)) return;

    // 「口座」という見出し(h1)の近くに配置する
    const title = Array.from(document.querySelectorAll('h1')).find(
      (h) => h.textContent.trim() === '口座'
    );
    if (!title || !title.parentElement) return;

    const group = createButtonGroup();
    title.parentElement.appendChild(group);
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

  const PERIOD_END_HEADER_CLASS = 'eustacia-period-end-balance-header';
  const PERIOD_END_CELL_CLASS = 'eustacia-period-end-balance-cell';
  const PERIOD_END_HINT_TEXT = '現在の会計期間の末日の登録残高です。総勘定元帳から取得しています。';

  // -------------------------------------------------
  // freee純正の「登録残高」等の「?」アイコンのヒントは、
  // 画面下部にReactポータルとして常駐する.vb-balloon要素を、クリック/ホバー時に
  // JSで表示位置を計算して出し分ける仕組み。挙動そのものは再現できないため、
  // 見た目だけを寄せた吹き出し要素をこちらで1つ用意し、アイコンにマウスを
  // 乗せたときだけ位置を計算して表示する。
  // ・pointer-events:none にして、吹き出し自体がマウスイベントを奪わないようにする
  //   (奪うと、吹き出し表示→アイコンのmouseleave発火→非表示→再度mouseenter…の
  //   ちらつきが発生するため)
  // ・表示直後に位置がジャンプして見えないよう、visibility:hiddenのまま採寸してから
  //   最終位置を確定し、そのあとで見せる
  // -------------------------------------------------
  let eustaciaBalloonEl = null;
  function ensureBalloonEl() {
    if (eustaciaBalloonEl && document.body.contains(eustaciaBalloonEl)) return eustaciaBalloonEl;
    const balloon = document.createElement('div');
    balloon.className = 'eustacia-hint-balloon';
    balloon.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'display:none',
      'pointer-events:none',
      'box-sizing:border-box',
      'max-width:280px',
      'background:#fff',
      'color:#333',
      'font-size:12px',
      'line-height:1.6',
      'padding:10px 14px',
      'border:1px solid #ddd',
      'border-radius:6px',
      'box-shadow:0 2px 10px rgba(0,0,0,0.15)',
    ].join(';');
    const text = document.createElement('span');
    text.className = 'eustacia-balloon-text';
    balloon.appendChild(text);

    // 下向きの三角(▽)。枠線付きに見せるため、少し大きい枠線色の三角の上に、
    // 一回り小さい背景色の三角を重ねる(1pxだけ枠線がのぞく形にする)
    const arrowBorder = document.createElement('div');
    arrowBorder.style.cssText = [
      'position:absolute',
      'bottom:-11px',
      'left:50%',
      'transform:translateX(-50%)',
      'width:0',
      'height:0',
      'border-left:11px solid transparent',
      'border-right:11px solid transparent',
      'border-top:11px solid #ddd',
    ].join(';');
    const arrowFill = document.createElement('div');
    arrowFill.style.cssText = [
      'position:absolute',
      'bottom:-9px',
      'left:50%',
      'transform:translateX(-50%)',
      'width:0',
      'height:0',
      'border-left:10px solid transparent',
      'border-right:10px solid transparent',
      'border-top:10px solid #fff',
    ].join(';');
    balloon.appendChild(arrowBorder);
    balloon.appendChild(arrowFill);

    document.body.appendChild(balloon);
    eustaciaBalloonEl = balloon;
    return balloon;
  }

  function showBalloon(anchorEl, text) {
    const balloon = ensureBalloonEl();
    balloon.querySelector('.eustacia-balloon-text').textContent = text;
    balloon.style.visibility = 'hidden';
    balloon.style.display = 'block';
    const anchorRect = anchorEl.getBoundingClientRect();
    const balloonRect = balloon.getBoundingClientRect();
    const gap = 14;
    const top = anchorRect.top - balloonRect.height - gap;
    const left = anchorRect.left + anchorRect.width / 2 - balloonRect.width / 2;
    balloon.style.top = `${Math.max(4, top)}px`;
    balloon.style.left = `${Math.max(4, Math.min(left, window.innerWidth - balloonRect.width - 4))}px`;
    balloon.style.visibility = 'visible';
  }

  function hideBalloon() {
    if (eustaciaBalloonEl) eustaciaBalloonEl.style.display = 'none';
  }

  // freeeの「?」アイコン(vb-messageIcon)と同じ見た目のアイコンを作り、
  // ホバー/フォーカス時にshowBalloon()でヒントを表示する
  function makeMessageIconHint(ariaLabel, hintText) {
    const messageIcon = document.createElement('span');
    messageIcon.className = 'vb-messageIcon vb-messageIcon--small';
    messageIcon.innerHTML =
      '<span role="none">&nbsp;</span>' +
      `<span class="vb-messageIcon__control" tabindex="0" role="button" aria-label="${escapeHtml(ariaLabel)}">` +
      '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" class="vb-messageIcon__icon vb-messageIcon__icon--info" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg">' +
      '<path fill="none" d="M0 0h24v24H0z"></path>' +
      '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"></path>' +
      '</svg></span>';

    const control = messageIcon.querySelector('.vb-messageIcon__control');
    control.addEventListener('mouseenter', () => showBalloon(control, hintText));
    control.addEventListener('mouseleave', hideBalloon);
    control.addEventListener('focus', () => showBalloon(control, hintText));
    control.addEventListener('blur', hideBalloon);

    return messageIcon;
  }

  // 「同期残高」列の右に「期末残高」列を追加する(ヘッダーはテーブルにつき1回だけ挿入)
  function ensurePeriodEndBalanceHeader(table) {
    if (table.querySelector(`th.${PERIOD_END_HEADER_CLASS}`)) return;
    const headerCells = table.querySelectorAll('thead th');
    const syncBalanceHeader = Array.from(headerCells).find((th) =>
      th.textContent.trim().startsWith('同期残高')
    );
    if (!syncBalanceHeader) return;

    const newHeader = document.createElement('th');
    newHeader.className = `vb-tableListHeadCell vb-tableListHeadCell--alignRight vb-tableListHeadCell--noWrap ${PERIOD_END_HEADER_CLASS}`;
    const content = document.createElement('span');
    content.className = 'vb-tableListHeadCell__content';
    content.textContent = '期末残高';
    content.appendChild(makeMessageIconHint('期末残高に関する説明', PERIOD_END_HINT_TEXT));

    newHeader.appendChild(content);
    syncBalanceHeader.insertAdjacentElement('afterend', newHeader);
  }

  // 各行に「期末残高」セルを追加する(「同期残高」セルの右)
  function ensurePeriodEndBalanceCell(row, name, walletablesMap, balanceMap) {
    if (row.querySelector(`td.${PERIOD_END_CELL_CLASS}`)) return;
    const syncBalanceCell = row.querySelector('[data-testid="stdui-table-cell-同期残高"]');
    if (!syncBalanceCell) return;

    const w = walletablesMap.get(name);
    const balance = w && w.id ? balanceMap.get(w.id) : undefined;
    const displayText = typeof balance === 'number' ? formatYen(balance) : '';

    const newCell = document.createElement('td');
    newCell.className = `vb-tableListCell ${PERIOD_END_CELL_CLASS}`;
    const span = document.createElement('span');
    span.style.cssText = 'display:block;text-align:right;';
    span.textContent = displayText;
    newCell.appendChild(span);
    syncBalanceCell.insertAdjacentElement('afterend', newCell);
  }

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

  // 一覧画面の「カテゴリ」表示文言から、口座詳細URLのパスセグメントを判定する
  // (銀行口座・クレジットカード以外は現金等も含めてすべて wallet 扱いとする)
  function detailUrlSegmentForCategory(category) {
    if (category === '銀行口座') return 'bank_account';
    if (category === 'クレジットカード') return 'credit_card';
    return 'wallet';
  }

  // タブ区切り出力用に、1口座分の各種URL(口座詳細・総勘定元帳)を組み立てる。
  // 口座詳細はwalletable_idが必要。account_items(勘定科目マスタ)は非表示・表示を
  // 問わず全口座分を含むため、こちらを唯一の取得元として使う
  // (getAccountItemsMap()で同名衝突が検出された場合はnullが入っており、その場合は空文字を返す)。
  // 総勘定元帳URLのみ口座名から組み立てられるため、walletable_idが無くても常に返せる。
  function buildAccountUrls(a, accountItemsMap) {
    const generalLedgerUrl = buildGeneralLedgerUrl(a.name);
    const walletableId = accountItemsMap.get(a.name);
    if (!walletableId) {
      return { detailUrl: '', generalLedgerUrl };
    }
    const segment = detailUrlSegmentForCategory(a.category);
    const detailUrl = `https://secure.freee.co.jp/${segment}/walletables/${walletableId}`;
    return { detailUrl, generalLedgerUrl };
  }

  function decorateRow(row, groupNameMap, walletablesMap, balanceMap) {
    if (row.dataset.eustaciaDecorated === '1') return;

    const nameCell = row.querySelector('[data-testid="stdui-table-cell-口座名"]');
    if (!nameCell) return;

    const nameEl = nameCell.querySelector('[class*="vb-text"]');
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
    const regEl = row.querySelector('[data-testid="stdui-table-cell-登録残高"] [class*="vb-text"]');
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

    // 期末残高列(「同期残高」列の右)
    ensurePeriodEndBalanceCell(row, name, walletablesMap, balanceMap);

    row.dataset.eustaciaDecorated = '1';
  }

  function decorateAllRows() {
    const table = document.querySelector('[data-testid="stdui-index-list-table"] table.vb-listTable__table');
    if (!table) return;

    const rows = table.querySelectorAll('tbody tr[data-testid^="stdui-table-row-"]');
    if (rows.length === 0) return;

    ensurePeriodEndBalanceHeader(table);

    Promise.all([ensureGroupNameMap(), ensurePeriodEndBalanceMap()])
      .then(([groupNameMap, balanceMap]) => {
        const walletablesMap = getWalletablesMap();
        rows.forEach((row) => decorateRow(row, groupNameMap, walletablesMap, balanceMap));
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
  const DETAIL_BALANCE_BADGE_ID = 'eustacia-detail-period-end-balance-badge';
  const DETAIL_GL_BUTTON_ID = 'eustacia-detail-gl-button';
  const DETAIL_CASH_BALANCE_BUTTON_ID = 'eustacia-detail-cash-balance-button';

  function makeDetailBadge(id, text) {
    const badge = document.createElement('span');
    badge.id = id;
    badge.textContent = text;
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
    return badge;
  }

  function findDetailPageH1() {
    return document.querySelector('h1[class*="_title--pageHeader"]');
  }

  function findCashBalanceJumpButton() {
    const link = document.querySelector('a[href*="/reports/cash_balance"]');
    return link ? link.closest('.vb-jumpButton') : null;
  }

  // クレジットカードの詳細画面には「現預金レポート」ボタンが元々無いため、
  // 「口座振替の一覧」ボタンを起点として使う。
  // 「口座振替の一覧」自体が将来的に無くなる可能性があるため、
  // 見つからない場合は「取引の一覧」ボタンにフォールバックする。
  function findTransferJumpButton() {
    const link = document.querySelector('a[href*="/deals#code=transfer"]');
    return link ? link.closest('.vb-jumpButton') : null;
  }

  // 「取引の一覧」ボタン(href例: /deals#walletable[]=xxx&walletable_id[]=123)
  // 「口座振替の一覧」(href例: /deals#code=transfer&...)とはhash部分の先頭で区別できる
  function findTransactionsJumpButton() {
    const link = document.querySelector('a[href^="/deals#walletable"]');
    return link ? link.closest('.vb-jumpButton') : null;
  }

  // 「明細の一覧」「取引の一覧」ボタンのリンクからwalletable_idを抜き出す
  // (現預金レポートをクレジットカードで開く際に walletable_for パラメータとして必要)
  function extractWalletableIdFromPage() {
    const txnLink = document.querySelector('a[href^="/wallet_txns#walletable="]');
    if (txnLink) {
      const m = txnLink.getAttribute('href').match(/walletable=(\d+)/);
      if (m) return m[1];
    }
    const dealsLink = document.querySelector(
      'a[href*="walletable_id%5B%5D="], a[href*="walletable_id[]="]'
    );
    if (dealsLink) {
      const href = dealsLink.getAttribute('href');
      const m = href.match(/walletable_id(?:%5B%5D|\[\])=(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  // URLのプレフィックスから「銀行口座」相当かどうかを判定する(一覧画面のカテゴリー名と揃える)
  function getCategoryFromDetailUrl() {
    if (location.pathname.startsWith('/bank_account/')) return '銀行口座';
    if (location.pathname.startsWith('/credit_card/')) return 'クレジットカード';
    return null;
  }

  // decorateDetailPage()はMutationObserverのたびに呼ばれるため、バッジ挿入前に
  // 何度も重複してfetchが走らないようガードする(ページ遷移時にリセット)
  let detailBadgeFetchStarted = false;

  function decorateDetailPage() {
    const h1 = findDetailPageH1();
    if (!h1) return;
    const accountName = h1.textContent.trim();
    if (!accountName) return;

    // 決算書表示名バッジ・期末残高バッジ(h1の右に、この順で表示)
    // 挿入順が入れ替わらないよう、両方の取得が終わってからまとめてDOMに追加する。
    if (
      !detailBadgeFetchStarted &&
      !document.getElementById(DETAIL_BADGE_ID) &&
      !document.getElementById(DETAIL_BALANCE_BADGE_ID)
    ) {
      detailBadgeFetchStarted = true;
      const category = getCategoryFromDetailUrl();
      const shouldShowGroupBadge = APPLY_ACCOUNTING_BADGE_TO_ALL || (category !== '銀行口座' && accountName !== '現金');

      const groupNamePromise = shouldShowGroupBadge ? ensureGroupNameMap() : Promise.resolve(null);

      const walletablesMap = getWalletablesMap();
      const w = walletablesMap.get(accountName);
      const balancePromise = w && w.id
        ? ensurePeriodEndBalanceMap().then((balanceMap) => balanceMap.get(w.id))
        : Promise.resolve(null);

      Promise.all([groupNamePromise, balancePromise])
        .then(([map, periodEndBalance]) => {
          if (document.getElementById(DETAIL_BADGE_ID) || document.getElementById(DETAIL_BALANCE_BADGE_ID)) return;
          if (!h1.parentElement) return;

          let anchor = h1;
          const groupName = map ? map.get(accountName) : null;
          if (groupName) {
            const groupBadge = makeDetailBadge(DETAIL_BADGE_ID, `決算書表示名：${groupName}`);
            anchor.insertAdjacentElement('afterend', groupBadge);
            anchor = groupBadge;
          }
          if (typeof periodEndBalance === 'number') {
            const balanceBadge = makeDetailBadge(DETAIL_BALANCE_BADGE_ID, `期末残高：${formatYen(periodEndBalance)}`);
            anchor.insertAdjacentElement('afterend', balanceBadge);
          }
        })
        .catch((e) => {
          console.error('[freee口座一覧コピー] 決算書表示名・期末残高バッジの表示に失敗:', e);
          detailBadgeFetchStarted = false;
        });
    }

    // 現預金レポート・総勘定元帳ボタンの挿入位置を決める。
    // 通常は「現預金レポート」ボタンの右に総勘定元帳ボタンを追加するが、
    // クレジットカードには「現預金レポート」ボタンが元々無いため、
    // 「口座振替の一覧」ボタン(無ければ「取引の一覧」ボタン)の右に
    // 現預金レポート・総勘定元帳の両方を追加する。
    let anchorBtn = findCashBalanceJumpButton();

    if (!anchorBtn && getCategoryFromDetailUrl() === 'クレジットカード') {
      if (!document.getElementById(DETAIL_CASH_BALANCE_BUTTON_ID)) {
        const insertionBaseBtn = findTransferJumpButton() || findTransactionsJumpButton();
        const walletableId = extractWalletableIdFromPage();
        if (insertionBaseBtn && walletableId) {
          const cashBtn = insertionBaseBtn.cloneNode(true);
          cashBtn.id = DETAIL_CASH_BALANCE_BUTTON_ID;
          const a = cashBtn.querySelector('a');
          if (a) {
            a.href = `https://secure.freee.co.jp/reports/cash_balance?walletable_for=${walletableId}`;
            const textEl = a.querySelector('.vb-button__text');
            if (textEl) textEl.textContent = '現預金レポート';
          }
          insertionBaseBtn.insertAdjacentElement('afterend', cashBtn);
        }
      }
      anchorBtn = document.getElementById(DETAIL_CASH_BALANCE_BUTTON_ID);
    }

    // 総勘定元帳ボタン(上で決めたanchorBtnの右)
    if (anchorBtn && !document.getElementById(DETAIL_GL_BUTTON_ID)) {
      const glBtn = anchorBtn.cloneNode(true);
      glBtn.id = DETAIL_GL_BUTTON_ID;
      const a = glBtn.querySelector('a');
      if (a) {
        a.href = buildGeneralLedgerUrl(accountName);
        const textEl = a.querySelector('.vb-button__text');
        if (textEl) textEl.textContent = '総勘定元帳';
      }
      anchorBtn.insertAdjacentElement('afterend', glBtn);
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
