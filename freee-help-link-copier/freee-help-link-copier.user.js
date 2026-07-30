// ==UserScript==
// @name         freee Help Link Copier
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  freeeヘルプページでタイトル、目次、H2/H3見出しから整形済みURLとタイトルを簡単にコピーするアイコンを追加します。コピーする文字列のフォーマットは設定画面から変更できます。
// @author       Eustacia.JP w/ Claude
// @match        https://support.freee.co.jp/hc/ja/articles/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=support.freee.co.jp
// @updateURL    https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-help-link-copier/freee-help-link-copier.user.js
// @downloadURL  https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-help-link-copier/freee-help-link-copier.user.js
// @supportURL   https://github.com/eustacia-jp/tampermonkey-scripts/issues
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const ICON_CLASS = 'freee-help-copy-icon';
    const COPIED_CLASS = 'copied';
    const PROCESSED_ATTR = 'data-copy-icon-added'; // 処理済みマーク用の属性

    // ページ全体をコピーする場合のテンプレート（H1横のアイコン用）
    const PAGE_TEMPLATE_STORAGE_KEY = 'freeeHelpCopier_pageTemplate';
    // {title} = ページタイトル
    // {url}   = 整形済みURL
    const DEFAULT_PAGE_TEMPLATE = '▼ヘルプページ：［{product}］{title}\n{url}';

    // 見出し（TOC・H2・H3）をコピーする場合のテンプレート
    const SECTION_TEMPLATE_STORAGE_KEY = 'freeeHelpCopier_sectionTemplate';
    // {mainTitle}    = ページタイトル
    // {sectionTitle} = 見出しのタイトル
    // {url}          = 整形済みURL
    const DEFAULT_SECTION_TEMPLATE = '▼ヘルプページ：［{product}］{mainTitle} - {sectionTitle}\n{url}';

    function getPageTemplate() {
        return GM_getValue(PAGE_TEMPLATE_STORAGE_KEY, DEFAULT_PAGE_TEMPLATE);
    }

    function setPageTemplate(value) {
        GM_setValue(PAGE_TEMPLATE_STORAGE_KEY, value);
    }

    function getSectionTemplate() {
        return GM_getValue(SECTION_TEMPLATE_STORAGE_KEY, DEFAULT_SECTION_TEMPLATE);
    }

    function setSectionTemplate(value) {
        GM_setValue(SECTION_TEMPLATE_STORAGE_KEY, value);
    }

    function formatPageText(title, url, product) {
        return getPageTemplate()
            .replace(/\{title\}/g, title)
            .replace(/\{url\}/g, url)
            .replace(/\{product\}/g, product || '');
    }

    function formatSectionText(mainTitle, sectionTitle, url, product) {
        return getSectionTemplate()
            .replace(/\{mainTitle\}/g, mainTitle)
            .replace(/\{sectionTitle\}/g, sectionTitle)
            .replace(/\{url\}/g, url)
            .replace(/\{product\}/g, product || '');
    }

    /**
     * パンくずリスト（ol.breadcrumbs）からプロダクト名を取得する。
     * 通常は2番目の項目（例：「freee会計」）だが、
     * 2番目が「その他サービス」に完全一致する場合のみ3番目の項目を使う。
     */
    function getProductName() {
        try {
            const breadcrumbs = document.querySelector('ol.breadcrumbs');
            if (!breadcrumbs) return '';
            const items = breadcrumbs.querySelectorAll(':scope > li');
            if (items.length < 2) return '';

            const getItemText = (li) => (li.getAttribute('title') || li.textContent || '').trim();

            let product = getItemText(items[1]);
            if (product === 'その他サービス' && items.length >= 3) {
                product = getItemText(items[2]);
            }
            return product;
        } catch (e) {
            console.warn('getProductName failed:', e);
            return '';
        }
    }

    // Simple clipboard SVG icon
    const CLIPBOARD_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
        </svg>
    `;
    // Checkmark SVG for feedback
     const CHECK_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="green" style="width: 1em; height: 1em; display: inline-block; vertical-align: middle;">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
    `;

    // --- Styling ---
    GM_addStyle(`
        .${ICON_CLASS} {
            display: inline-block;
            vertical-align: middle;
            margin-left: 6px;
            cursor: pointer;
            opacity: 0.6;
            transition: opacity 0.2s ease-in-out;
            line-height: 1;
        }
        .${ICON_CLASS}:hover {
            opacity: 1.0;
        }
        .${ICON_CLASS} svg {
             width: 1.1em;
             height: 1.1em;
        }
        h2 > .${ICON_CLASS}, h3 > .${ICON_CLASS} {
            width: 1em;
            height: 1em;
            opacity: 0.5;
        }
         h2 > .${ICON_CLASS}:hover, h3 > .${ICON_CLASS}:hover {
             opacity: 0.9;
         }

        /* --- Settings dialog --- */
        #freee-help-copier-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.4);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Meiryo, sans-serif;
        }
        #freee-help-copier-dialog {
            background: #fff;
            border-radius: 8px;
            padding: 20px 24px;
            width: 480px;
            max-width: 90vw;
            box-shadow: 0 8px 30px rgba(0,0,0,0.25);
        }
        #freee-help-copier-dialog h2 {
            font-size: 16px;
            margin: 0 0 12px;
        }
        #freee-help-copier-dialog p {
            font-size: 12px;
            color: #555;
            line-height: 1.6;
            margin: 0 0 10px;
        }
        #freee-help-copier-dialog textarea {
            width: 100%;
            box-sizing: border-box;
            min-height: 90px;
            font-family: Consolas, Menlo, monospace;
            font-size: 13px;
            padding: 8px;
            border: 1px solid #ccc;
            border-radius: 4px;
            resize: vertical;
        }
        #freee-help-copier-dialog .fhc-preview {
            margin-top: 10px;
            padding: 8px;
            background: #f7f7f7;
            border-radius: 4px;
            font-size: 12px;
            white-space: pre-wrap;
            word-break: break-all;
            color: #333;
        }
        #freee-help-copier-dialog .fhc-buttons {
            margin-top: 16px;
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }
        #freee-help-copier-dialog button {
            font-size: 13px;
            padding: 6px 14px;
            border-radius: 4px;
            border: 1px solid #ccc;
            background: #f2f2f2;
            cursor: pointer;
        }
        #freee-help-copier-dialog button.fhc-primary {
            background: #16a144;
            border-color: #16a144;
            color: #fff;
        }
        #freee-help-copier-dialog button:hover {
            opacity: 0.85;
        }
    `);

    // --- Settings dialog ---
    function openSettingsDialog() {
        if (document.getElementById('freee-help-copier-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'freee-help-copier-overlay';

        const dialog = document.createElement('div');
        dialog.id = 'freee-help-copier-dialog';
        dialog.innerHTML = `
            <h2>コピー形式の設定</h2>
            <p>
                <strong>ページ全体をコピーする場合</strong><br>
                <code>{title}</code> = ページタイトル、<code>{product}</code> = プロダクト名（パンくずリストから取得）、<code>{url}</code> = 整形済みURL
            </p>
            <textarea id="fhc-page-template-input"></textarea>
            <div class="fhc-preview" id="fhc-page-preview"></div>

            <p style="margin-top:16px;">
                <strong>見出し（目次・H2・H3）をコピーする場合</strong><br>
                <code>{mainTitle}</code> = ページタイトル、<code>{sectionTitle}</code> = 見出しのタイトル、<code>{product}</code> = プロダクト名、<code>{url}</code> = 整形済みURL
            </p>
            <textarea id="fhc-section-template-input"></textarea>
            <div class="fhc-preview" id="fhc-section-preview"></div>

            <div class="fhc-buttons">
                <button type="button" id="fhc-reset">初期値に戻す</button>
                <button type="button" id="fhc-cancel">キャンセル</button>
                <button type="button" id="fhc-save" class="fhc-primary">保存</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const pageTextarea = dialog.querySelector('#fhc-page-template-input');
        const pagePreview = dialog.querySelector('#fhc-page-preview');
        const sectionTextarea = dialog.querySelector('#fhc-section-template-input');
        const sectionPreview = dialog.querySelector('#fhc-section-preview');

        pageTextarea.value = getPageTemplate();
        sectionTextarea.value = getSectionTemplate();

        function updatePagePreview() {
            const sample = pageTextarea.value
                .replace(/\{title\}/g, 'freee会計の事業所の設定を行う')
                .replace(/\{product\}/g, 'freee会計')
                .replace(/\{url\}/g, 'https://support.freee.co.jp/hc/ja/articles/202847220');
            pagePreview.textContent = 'プレビュー：\n' + sample;
        }

        function updateSectionPreview() {
            const sample = sectionTextarea.value
                .replace(/\{mainTitle\}/g, 'freee会計の事業所の設定を行う')
                .replace(/\{sectionTitle\}/g, '基本情報設定')
                .replace(/\{product\}/g, 'freee会計')
                .replace(/\{url\}/g, 'https://support.freee.co.jp/hc/ja/articles/202847220#1');
            sectionPreview.textContent = 'プレビュー：\n' + sample;
        }

        updatePagePreview();
        updateSectionPreview();
        pageTextarea.addEventListener('input', updatePagePreview);
        sectionTextarea.addEventListener('input', updateSectionPreview);

        function closeDialog() {
            overlay.remove();
        }

        dialog.querySelector('#fhc-cancel').addEventListener('click', closeDialog);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeDialog();
        });
        dialog.querySelector('#fhc-reset').addEventListener('click', () => {
            pageTextarea.value = DEFAULT_PAGE_TEMPLATE;
            sectionTextarea.value = DEFAULT_SECTION_TEMPLATE;
            updatePagePreview();
            updateSectionPreview();
        });
        dialog.querySelector('#fhc-save').addEventListener('click', () => {
            setPageTemplate(pageTextarea.value);
            setSectionTemplate(sectionTextarea.value);
            closeDialog();
        });
    }

    GM_registerMenuCommand('コピー形式を設定...', openSettingsDialog);

    // --- Helper Functions ---

    /**
     * Simplifies the freee help page URL.
     */
    function simplifyUrl(fullUrl) {
        try {
            const url = new URL(fullUrl);
            const fragment = url.hash;
            const articlePathMatch = url.pathname.match(/(\/hc\/ja\/articles\/\d+)/);

            if (articlePathMatch && articlePathMatch[1]) {
                return `${url.protocol}//${url.host}${articlePathMatch[1]}${fragment}`;
            } else {
                console.warn("simplifyUrl: Article path pattern not matched, using basic simplification for:", fullUrl);
                return `${url.protocol}//${url.host}${url.pathname}${fragment}`;
            }
        } catch (e) {
            console.error("Error simplifying URL:", e, "Input:", fullUrl);
            const fragmentMatch = fullUrl.match(/#.*$/);
            const fragment = fragmentMatch ? fragmentMatch[0] : '';
            const base = fullUrl.replace(/#.*$/, '').replace(/\?.*$/, '');
            return base + fragment;
        }
    }

    /**
     * Gets the text content of the H2 or H3 element targeted by the fragment.
     */
    function getHeadlineText(fragment) {
        if (!fragment || fragment.length <= 1 || !fragment.startsWith('#')) return null;
        try {
            const targetId = decodeURIComponent(fragment.substring(1));
            const element = document.getElementById(targetId);
            if (element && (element.tagName === 'H2' || element.tagName === 'H3')) {
                const clone = element.cloneNode(true);
                clone.querySelectorAll(`.invisible, [style*="display: none"], .${ICON_CLASS}`).forEach(el => el.remove());
                return clone.textContent?.trim().replace(/\s+/g, ' ') || null;
            }
        } catch (e) {
            console.warn("Could not find headline element for fragment:", fragment, e);
        }
        return null;
    }

    /**
     * Copies text to the clipboard and provides visual feedback on the icon.
     */
    function copyToClipboard(text, iconElement) {
        if (iconElement.classList.contains(COPIED_CLASS)) {
            return;
        }

        GM_setClipboard(text, 'text');

        const originalContent = iconElement.innerHTML;
        const originalTitle = iconElement.title;
        iconElement.innerHTML = CHECK_ICON_SVG;
        iconElement.classList.add(COPIED_CLASS);
        iconElement.title = 'コピーしました！';

        setTimeout(() => {
            if (document.body.contains(iconElement)) {
                iconElement.innerHTML = originalContent;
                iconElement.classList.remove(COPIED_CLASS);
                iconElement.title = originalTitle;
            }
        }, 1500);
    }

    /**
     * Creates a clipboard icon span element.
     */
    function createIconElement(tooltip = 'タイトルとURLをコピー') {
        const iconSpan = document.createElement('span');
        iconSpan.classList.add(ICON_CLASS);
        iconSpan.title = tooltip;
        iconSpan.innerHTML = CLIPBOARD_ICON_SVG;
        return iconSpan;
    }

    // --- Main Execution ---
    function addCopyIcons() {
        const articleContainer = document.querySelector('article.article, main[role="main"] article, .article-body');
        if (!articleContainer) {
            return;
        }

        const h1 = articleContainer.querySelector('h1');
        if (!h1) {
            return;
        }
        const mainTitleText = h1.textContent?.trim().replace(/\s+/g, ' ') || '（タイトル不明）';
        const productName = getProductName();

        // --- Add icon after H1 ---
        if (!h1.hasAttribute(PROCESSED_ATTR)) {
            h1.setAttribute(PROCESSED_ATTR, 'true');
            const mainIcon = createIconElement('ページタイトルとURLをコピー');
            h1.appendChild(mainIcon);

            mainIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const baseUrl = location.origin + location.pathname;
                const simplifiedUrl = simplifyUrl(baseUrl);
                const textToCopy = formatPageText(mainTitleText, simplifiedUrl, productName);
                copyToClipboard(textToCopy, mainIcon);
            });
        }

        // --- Add icons within TOC ---
        const tocDiv = document.querySelector('div.toc');
        if (tocDiv) {
            const tocLinks = tocDiv.querySelectorAll('ul li a');
            tocLinks.forEach(a => {
                const href = a.getAttribute('href');
                if (href && href.startsWith('#') && !a.hasAttribute(PROCESSED_ATTR)) {
                    a.setAttribute(PROCESSED_ATTR, 'true');

                    const tocIcon = createIconElement('このセクションのタイトルとURLをコピー');
                    a.appendChild(tocIcon);

                    tocIcon.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault();

                        const targetFragment = href;
                        const targetUrl = new URL(targetFragment, location.href).href;

                        const simplifiedUrl = simplifyUrl(targetUrl);
                        const targetHeadlineText = getHeadlineText(targetFragment);

                        const fallbackHeadline = targetHeadlineText || a.textContent?.trim().replace(/\s+/g, ' ') || '';
                        const textToCopy = formatSectionText(mainTitleText, fallbackHeadline, simplifiedUrl, productName);
                        copyToClipboard(textToCopy, tocIcon);
                    });
                }
            });
        }

        // --- Add icons after H2 and H3 within the article ---
        const headings = articleContainer.querySelectorAll('h2, h3');
        headings.forEach(heading => {
            if (heading.id && !heading.hasAttribute(PROCESSED_ATTR) && !heading.closest('div.toc')) {
                heading.setAttribute(PROCESSED_ATTR, 'true');

                const headingIcon = createIconElement('この見出しのタイトルとURLをコピー');
                heading.appendChild(headingIcon);

                headingIcon.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();

                    const clone = heading.cloneNode(true);
                    clone.querySelectorAll(`.${ICON_CLASS}`).forEach(el => el.remove());
                    const headingText = clone.textContent?.trim().replace(/\s+/g, ' ');

                    const headingFragment = '#' + heading.id;
                    const targetUrl = new URL(headingFragment, location.href).href;

                    const simplifiedUrl = simplifyUrl(targetUrl);
                    const textToCopy = formatSectionText(mainTitleText, headingText || '', simplifiedUrl, productName);
                    copyToClipboard(textToCopy, headingIcon);
                });
            }
        });
    }

    // --- Run ---
    let debounceTimer;
    const observer = new MutationObserver((mutationsList) => {
        let needsUpdate = false;
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                 needsUpdate = true;
                 break;
            }
        }

        if (needsUpdate) {
             clearTimeout(debounceTimer);
             debounceTimer = setTimeout(() => {
                 addCopyIcons();
             }, 300);
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addCopyIcons);
    } else {
        addCopyIcons();
    }

    console.log("freee Help Link Copier loaded.");

})();
