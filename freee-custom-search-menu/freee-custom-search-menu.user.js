// ==UserScript==
// @name         freee会計 Ctrl+右クリック カスタム検索メニュー
// @namespace    http://tampermonkey.net/
// @version      1.22
// @description  freee会計の画面で文字列や金額を選択して、取引や明細を簡単に検索できます。※初めて実行する際、ブラウザ（Tampermonkey）から「外部サイト（freee内）へのアクセスを許可しますか？」という確認が出る場合がありますが、「常に許可」を選択してください。
// @author       Eustacia.JP w/ Gemini+Claude
// @match        https://secure.freee.co.jp/*
// @match        https://settings.secure.freee.co.jp/partners*
// @match        https://invoice.secure.freee.co.jp/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=freee.co.jp
// @updateURL    https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-custom-search-menu/freee-custom-search-menu.user.js
// @downloadURL  https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-custom-search-menu/freee-custom-search-menu.user.js
// @supportURL   https://github.com/eustacia-jp/tampermonkey-scripts/issues
// @grant        GM_openInTab
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const menuId = 'freee-ctrl-context-menu-userscript-v122';
    let selectedText = '';
    let menuElement = null;

    // --- 【機能1】取引先詳細ページへのボタン追加 (Settingsドメイン用) ---
    // 取引先マスタは SPA なので、一覧 → 詳細は再読み込みなしで遷移する。
    // ページ読み込み時に一度だけ判定すると、一覧から開いたときにボタンが出ない（再読み込みすると出る）。
    // そのため、@match は一覧（/partners?…）も含め、DOM の変化のたびに「今が詳細ページか」を判定し直す。
    if (location.hostname === 'settings.secure.freee.co.jp') {
        const buttonsId = 'freee-deal-search-buttons';

        const btnBaseStyle = `
            padding: 4px 12px;
            font-size: 13px;
            border: 1px solid #dcdcdc;
            border-radius: 4px;
            background: #fff;
            cursor: pointer;
            text-decoration: none;
            color: #333;
            font-weight: normal;
            display: flex;
            align-items: center;
            transition: all 0.2s;
        `;

        function createDealSearchButtons(partnerId, partnerName) {
            const container = document.createElement('div');
            container.id = buttonsId;
            container.dataset.partnerId = partnerId;
            container.dataset.partnerName = partnerName;
            container.style.display = 'inline-flex';
            container.style.marginLeft = '20px';
            container.style.gap = '8px';
            container.style.verticalAlign = 'middle';

            // 旧画面ボタン
            const oldBtn = document.createElement('a');
            oldBtn.innerHTML = `<span style="margin-right:5px; color:#666;">[旧]</span>取引を検索`;
            oldBtn.href = `https://secure.freee.co.jp/deals#mode=search&partner=${encodeURIComponent(partnerName)}`;
            oldBtn.target = '_blank';
            oldBtn.setAttribute('style', btnBaseStyle);

            // 新画面ボタン
            const newBtn = document.createElement('a');
            newBtn.innerHTML = `<span style="margin-right:5px; color:#007bff;">[新]</span>取引を検索`;
            newBtn.href = `https://secure.freee.co.jp/deals/standards?partner=${partnerId}_${encodeURIComponent(partnerName)}`;
            newBtn.target = '_blank';
            newBtn.setAttribute('style', btnBaseStyle);

            // マウスオーバー時のエフェクト
            [oldBtn, newBtn].forEach(btn => {
                btn.onmouseenter = () => { btn.style.borderColor = '#aaa'; btn.style.backgroundColor = '#f8f9fa'; };
                btn.onmouseleave = () => { btn.style.borderColor = '#dcdcdc'; btn.style.backgroundColor = '#fff'; };
            });

            container.appendChild(oldBtn);
            container.appendChild(newBtn);
            return container;
        }

        function syncDealSearchButtons() {
            const existing = document.getElementById(buttonsId);
            const m = location.pathname.match(/^\/partners\/(\d+)/);
            if (!m) { if (existing) existing.remove(); return; } // 一覧など詳細以外のページ
            const h1 = document.querySelector('h1');
            const partnerName = h1 ? h1.textContent.trim() : '';
            if (!partnerName) return; // 取引先名がまだ描画されていない
            if (existing && existing.dataset.partnerId === m[1] && existing.dataset.partnerName === partnerName && existing.previousElementSibling === h1) return;
            if (existing) existing.remove();
            // h1の構造を維持しつつ横に並べる
            h1.style.display = 'inline-block';
            h1.style.verticalAlign = 'middle';
            h1.after(createDealSearchButtons(m[1], partnerName));
        }

        new MutationObserver(syncDealSearchButtons).observe(document.body, { childList: true, subtree: true, characterData: true });
        syncDealSearchButtons();
    }

    // --- 【機能2】右クリックメニュー関連 (以下は従来の v1.14 と同様) ---

    // 取引画面が新画面（/deals/standards）かどうかを判定する。
    // 2026-09 時点で、新画面のページにも disable_new_deal_editor=true が出力されるため、このフラグ単体では判定できない。
    // enable_new_deal_editor と ui_migration_states.deal_editor.enabled を優先し、旧フラグは最後の手段にする。
    function isNewDealEditor() {
        if (location.pathname.startsWith('/deals/standards')) return true;
        let legacy = null;
        for (const script of document.getElementsByTagName('script')) {
            const content = script.textContent;
            if (!content.includes('deal_editor')) continue;
            let m = content.match(/freee\.data\.set\('enable_new_deal_editor',\s*(true|false)\)/);
            if (m) return m[1] === 'true';
            m = content.match(/"deal_editor":\{"enabled":(true|false)/);
            if (m) return m[1] === 'true';
            m = content.match(/freee\.data\.set\('disable_new_deal_editor',\s*(true|false)\)/);
            if (m && legacy === null) legacy = m[1] === 'false';
        }
        return legacy === true;
    }

    // 取引先名から新画面用の検索URL（partner=ID_名前）を組み立てて開く。
    // 検索APIは secure.freee.co.jp 上のページからは fetch で直接呼ぶ（Cookie・ヘッダーがページ本来のリクエストと同じになる）。
    // 他ドメイン（invoice.secure など）では GM_xmlhttpRequest を使う。
    function fetchPartners(name) {
        const apiUrl = `https://secure.freee.co.jp/api/p/partners?q=${encodeURIComponent(name)}&limit=10`;
        if (location.hostname === 'secure.freee.co.jp') {
            return fetch(apiUrl, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
                .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); });
        }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url: apiUrl,
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                onload: res => {
                    if (res.status < 200 || res.status >= 300) return reject(new Error('HTTP ' + res.status));
                    try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout'))
            });
        });
    }

    function fetchPartnerIdAndOpen(name) {
        // 取得できなかったときは、取引先マスタの検索結果を開く（keywords= は新画面が無視して既定の一覧に戻ってしまう）
        const masterUrl = `https://settings.secure.freee.co.jp/partners?is_disable=false&service_name=accounting&q=${encodeURIComponent(name)}`;
        fetchPartners(name).then(data => {
            const partners = data.partners || [];
            if (partners.length === 0) throw new Error('取引先が見つかりません: ' + name);
            const target = partners.find(p => p.name === name) || partners[0];
            GM_openInTab(`https://secure.freee.co.jp/deals/standards?partner=${target.id}_${encodeURIComponent(target.name)}`, {active:true});
        }).catch(err => {
            console.warn('[freee検索メニュー] 取引先IDの取得に失敗したため、取引先マスタを開きます:', err);
            GM_openInTab(masterUrl, {active:true});
        });
    }

    // Tabler Icons (MIT)。線画なので、span の fill:currentColor を svg 属性の fill="none" で打ち消している
    // 取引内容（明細上の文字）= freee の画面と同じカード / 備考 = 鉛筆
    const icons = {
        card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3l0 -8"/><path d="M3 10l18 0"/><path d="M7 15l.01 0"/><path d="M11 15l2 0"/></svg>',
        pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/></svg>',
        partnerTag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M6.168 18.849a4 4 0 0 1 3.832 -2.849h4a4 4 0 0 1 3.834 2.855"/></svg>',
        partner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l18 0"/><path d="M9 8l1 0"/><path d="M9 12l1 0"/><path d="M9 16l1 0"/><path d="M14 8l1 0"/><path d="M14 12l1 0"/><path d="M14 16l1 0"/><path d="M5 21v-16a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16"/></svg>',
        amount: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2"/><path d="M9 7l1 0"/><path d="M9 13l6 0"/><path d="M13 17l2 0"/></svg>',
        description: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5h8"/><path d="M13 9h5"/><path d="M13 15h8"/><path d="M13 19h5"/><path d="M3 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4"/><path d="M3 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4"/></svg>',
        notebook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-11a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1m3 0v18"/><path d="M13 8l2 0"/><path d="M13 12l2 0"/></svg>',
        help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 16v.01"/><path d="M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483"/></svg>'
    };

    // 選択した文字列の扱い（文字列 / 金額）を示すアイコン
    const typeIcons = {
        text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14"/><path d="M10 16v-6a2 2 0 1 1 4 0v6"/><path d="M10 13h4"/></svg>',
        amount: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M9 12h6"/><path d="M9 15h6"/><path d="M9 8l3 4.5"/><path d="M15 8l-3 4.5v4.5"/></svg>'
    };

    GM_addStyle(`
        #${menuId} { position: absolute; background-color: #fff; border: 1px solid #ccc; box-shadow: 2px 2px 5px rgba(0,0,0,0.15); z-index: 2147483647; min-width: 340px; font-family: sans-serif; font-size: 14px; border-radius: 6px; overflow: hidden; }
        #${menuId} div.menu-heading { padding: 8px 16px; font-weight: bold; color: #555; background-color: #f8f9fa; border-bottom: 1px solid #eee; }
        #${menuId} div.menu-item, #${menuId} div.menu-item-disabled { display: flex; align-items: center; padding: 8px 16px; white-space: nowrap; }
        #${menuId} div.grp-1 { background-color: #ebf3fd; }
        #${menuId} div.grp-2 { background-color: #edf6e7; }
        #${menuId} div.menu-item { cursor: pointer; color: #333; }
        #${menuId} div.menu-item:hover { background-color: #f0f7ff; color: #007bff; }
        #${menuId} div.menu-item-disabled { color: #aaa; cursor: default; }
        .menu-icon { width: 16px; height: 16px; margin-right: 10px; flex-shrink: 0; fill: currentColor; }
        .menu-label { display: inline-block; min-width: 10.5em; margin-right: 4px; }
        .attr-icon { width: 17px; height: 17px; margin-right: 6px; flex-shrink: 0; }
        .attr-text { color: #28a745; } .attr-amount { color: #e44d26; }
        #${menuId} hr { border: none; border-top: 1px solid #eee; margin: 0; }
    `);

    function createItem(parent, group, type, prefix, label, title, iconSvg, onClick, disabled = false) {
        const item = document.createElement('div');
        item.className = (disabled ? 'menu-item-disabled ' : 'menu-item ') + group;
        const iconSpan = document.createElement('span'); iconSpan.className = 'menu-icon'; iconSpan.innerHTML = iconSvg; item.appendChild(iconSpan);
        const labelSpan = document.createElement('span'); labelSpan.className = 'menu-label'; labelSpan.textContent = prefix; item.appendChild(labelSpan);
        const attrSpan = document.createElement('span'); attrSpan.className = `attr-icon ${type === 'text' ? 'attr-text' : 'attr-amount'}`; attrSpan.innerHTML = typeIcons[type === 'text' ? 'text' : 'amount']; item.appendChild(attrSpan);
        const textSpan = document.createElement('span'); textSpan.textContent = label; item.appendChild(textSpan);
        item.title = title;
        if (!disabled && onClick) { item.addEventListener('click', () => { onClick(); removeCustomMenu(); }); }
        parent.appendChild(item);
    }

    document.addEventListener('contextmenu', e => {
        removeCustomMenu();
        if (e.ctrlKey) {
            selectedText = window.getSelection().toString().trim();
            if (selectedText) { e.preventDefault(); createCustomMenu(e.pageX, e.pageY); }
        }
    }, false);

    document.addEventListener('click', e => { if (!menuElement || !menuElement.contains(e.target)) removeCustomMenu(); }, false);

    function createCustomMenu(x, y) {
        if (location.hostname.includes('settings')) return; // Settingsドメインではメニューを出さない（必要なら削除可）
        menuElement = document.createElement('div');
        menuElement.id = menuId;
        const sText = selectedText.substring(0, 16) + (selectedText.length > 16 ? '…' : '');
        const val = selectedText.replace(/[^0-9]/g, '');
        const sVal = val.substring(0, 15).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (val.length > 15 ? '…' : ''); // 表示用に3桁区切り（検索URLにはカンマなしの val を使う）

        const head = document.createElement('div'); head.className = 'menu-heading'; head.textContent = '選択した文字列で検索'; menuElement.appendChild(head);

        createItem(menuElement, 'grp-1', 'text', '取引 - 取引内容: ', `「${sText}」`, '取引内容として検索', icons.card, () => {
            const kw = encodeURIComponent(selectedText);
            const url = isNewDealEditor() ? `https://secure.freee.co.jp/deals/standards?wallet_txn_description=${kw}` : `https://secure.freee.co.jp/deals#mode=search&wallet_txn_description=${kw}`;
            GM_openInTab(url, {active:true});
        });

        createItem(menuElement, 'grp-1', 'text', '取引 - 備考: ', `「${sText}」`, '備考（明細行の備考）として検索', icons.pencil, () => {
            const kw = encodeURIComponent(selectedText);
            const url = isNewDealEditor() ? `https://secure.freee.co.jp/deals/standards?line_item_description=${kw}` : `https://secure.freee.co.jp/deals#mode=search&line_item_description=${kw}`;
            GM_openInTab(url, {active:true});
        });

        createItem(menuElement, 'grp-1', 'text', '取引 - 取引先: ', `「${sText}」`, '取引先として検索', icons.partnerTag, () => {
            if (isNewDealEditor()) { fetchPartnerIdAndOpen(selectedText); }
            else { GM_openInTab(`https://secure.freee.co.jp/deals#mode=search&partner=${encodeURIComponent(selectedText)}`, {active:true}); }
        });

        createItem(menuElement, 'grp-2', 'text', 'マスタ - 取引先: ', `「${sText}」`, '取引先マスタ画面で検索', icons.partner, () => { GM_openInTab(`https://settings.secure.freee.co.jp/partners?is_disable=false&service_name=accounting&q=${encodeURIComponent(selectedText)}`, {active:true}); });
        createItem(menuElement, 'grp-1', 'amount', '自動で経理 - 金額: ', sVal || '(数字なし)', '同額の明細を「自動で経理」で検索', icons.amount, () => { GM_openInTab(`https://secure.freee.co.jp/wallet_txns/stream?ignore_unsettle=true&limit=20&registration_status=for_reconcile&start_amount=${val}&end_amount=${val}`, {active:true}); }, !val);
        createItem(menuElement, 'grp-1', 'text', '自動で経理 - 文字列: ', `「${sText}」`, '摘要として明細を「自動で経理」で検索', icons.description, () => { GM_openInTab(`https://secure.freee.co.jp/wallet_txns/stream?ignore_unsettle=true&limit=20&registration_status=for_reconcile&start_amount=NaN&description=${encodeURIComponent(selectedText)}`, {active:true}); });
        // 「明細の一覧」は会計期間より前の明細も出る（開いた直後は現在の会計期間で絞り込まれるため、取引日を空欄にして絞り込み直す）
        createItem(menuElement, 'grp-1', 'amount', '明細の一覧 - 金額: ', sVal || '(数字なし)', '同額の明細を「明細の一覧」で検索', icons.amount, () => { GM_openInTab(`https://secure.freee.co.jp/wallet_txns#ignore_condition=with&start_amount=${val}&end_amount=${val}`, {active:true}); }, !val);
        createItem(menuElement, 'grp-1', 'text', '明細の一覧 - 文字列: ', `「${sText}」`, '摘要として明細を「明細の一覧」で検索', icons.description, () => { GM_openInTab(`https://secure.freee.co.jp/wallet_txns#ignore_condition=with&description=${encodeURIComponent(selectedText)}`, {active:true}); });
        createItem(menuElement, 'grp-1', 'amount', '仕訳帳 - 金額: ', sVal || '(数字なし)', '同額の仕訳を検索', icons.notebook, () => { GM_openInTab(`https://secure.freee.co.jp/reports/journals?page=1&per_page=50&amount_max=${val}&amount_min=${val}`, {active:true}); }, !val);
        menuElement.appendChild(document.createElement('hr'));
        createItem(menuElement, 'grp-2', 'text', 'ヘルプセンター: ', `「${sText}」`, 'ヘルプセンターで検索', icons.help, () => { GM_openInTab(`https://support.freee.co.jp/hc/ja/search?type=category&id=200193700&query=${encodeURIComponent(selectedText)}`, {active:true}); });

        document.body.appendChild(menuElement);
        const mW = menuElement.offsetWidth, mH = menuElement.offsetHeight;
        let fX = (x + mW > window.scrollX + window.innerWidth) ? window.scrollX + window.innerWidth - mW - 5 : x;
        let fY = (y + mH > window.scrollY + window.innerHeight) ? window.scrollY + window.innerHeight - mH - 5 : y;
        menuElement.style.left = `${fX}px`; menuElement.style.top = `${fY}px`;
    }

    function removeCustomMenu() { if (menuElement) { menuElement.remove(); menuElement = null; } }
})();