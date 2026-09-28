// ==UserScript==
// @name         freee 自動で経理：一部入出金補完・消込行クリック選択
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  freee会計の「自動で経理」における未決済取引の消込操作を楽にします。「一部入金/出金にする」をクリックしたときに明細金額を自動入力し、未決済取引の行はどこをクリックしても選択できるようにします。
// @author       Eustacia.JP w/ Claude
// @match        https://secure.freee.co.jp/wallet_txns*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=freee.co.jp
// @updateURL    https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-reconciliation-helper/freee-reconciliation-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-reconciliation-helper/freee-reconciliation-helper.user.js
// @supportURL   https://github.com/eustacia-jp/tampermonkey-scripts/issues
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // --- 設定 ---

    // --- 一部入出金機能用 ---
    const partialPaymentButtonSelector = 'button.un-selected-due-amount-button'; // 「一部入金/出金にする」ボタン
    // aria-labelの末尾一致に加えて、cell-part-due-amount 内のinputも対象にする（UI変更への耐性を上げるため）
    const partialPaymentInputSelector = 'td.cell-part-due-amount input, input.vb-textField[aria-label$="の一部入金額"], input.vb-textField[aria-label$="の一部出金額"]';
    const statementAmountSelector = 'div.registration-modal-header-container span.amount-number'; // 明細金額 (画面上部)

    // Reactのstate反映が遅れて上書きしてくるケースに備えて、短時間だけ複数回再設定する
    const partialPaymentReassertIntervalMs = 150; // 再設定の間隔(ミリ秒)
    const partialPaymentReassertCount = 8;         // 再設定を行う回数（合計 約1.2秒間）

    // --- 未決済取引の消込：行クリックでチェックボックスを選択する機能用 ---
    const scrubRowSelector = 'tr.scrub-deal-list-table-row'; // 「未決済取引を探す」「選択した未決済取引」テーブルの行
    const scrubRowCheckboxSelector = 'td.cell-select-all input[type="checkbox"]'; // 行内のチェックボックス
    // クリックしても行選択のトグルをさせない（本来の機能を優先させる）要素
    const scrubRowInteractiveSelector = 'input, button, a, select, textarea, label';

    // --- スクリプト本体 ---

    // 消込画面の行にマウスを合わせたときに、クリックで選択できることが分かるようにする
    const style = document.createElement('style');
    style.textContent = `
        ${scrubRowSelector} { cursor: pointer; }
        ${scrubRowSelector} a, ${scrubRowSelector} button, ${scrubRowSelector} input,
        ${scrubRowSelector} select, ${scrubRowSelector} textarea, ${scrubRowSelector} label {
            cursor: auto;
        }
    `;
    document.head.appendChild(style);

    let currentStatementAmount = null; // 一部入出金用の明細金額(絶対値)
    let targetTbodyForPartialPayment = null; // 一部入出金対象のtbodyを保持

    // --- 汎用関数 ---
    function parseAmount(text) {
        if (typeof text !== 'string') return NaN;
        return parseInt(text.replace(/[¥¥￥,円\s]/g, ''), 10);
    }

    // React管理下のinput（controlled input）用。
    // ネイティブのvalue setterを直接呼び出すことで、Reactの内部トラッカー(_valueTracker)を
    // 更新せずに値を書き換え、その後にinputイベントを発火させることで
    // Reactのvalueトラッカー比較を「値が変化した」と正しく認識させ、onChangeを確実に発火させる。
    function setReactInputValue(inputElement, value) {
        if (!inputElement) return;
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(inputElement, String(value));
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        inputElement.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 入力欄にフォーカスを当て、値を全選択状態にする。
    // freeeは「入力欄にフォーカス→フォーカスを外す」という操作を一度経ないと
    // 登録ボタンを有効化しないため、フォーカスだけスクリプト側で済ませておく。
    // これによりユーザーは通常どおり(どこかをクリックしてフォーカスを外す→登録ボタンをクリック)
    // の2アクションで登録できるようになる。
    function focusAndSelect(inputElement) {
        if (!inputElement || !document.contains(inputElement)) return;
        try {
            inputElement.focus();
            inputElement.select();
        } catch (e) {
            console.warn('focusAndSelect failed:', e);
        }
    }

    // --- メインのクリックイベントリスナー ---
    document.body.addEventListener('click', function(event) {
        // --- 0. 未決済取引の消込：行クリックによるチェックボックス選択 ---
        const scrubRow = event.target.closest(scrubRowSelector);
        if (scrubRow) {
            // リンク・ボタン・入力欄など、本来の機能を持つ要素の上でのクリックは邪魔しない
            // (例: 「参照元リンク」列の「取引」リンク、「一部入金/出金にする」ボタン、金額入力欄など)
            // これらの要素上のクリックは処理せず、下の各機能の判定にそのまま処理を委ねる。
            if (!event.target.closest(scrubRowInteractiveSelector)) {
                const checkbox = scrubRow.querySelector(scrubRowCheckboxSelector);
                if (checkbox) {
                    checkbox.click(); // ネイティブのクリックとして扱わせることでReact側にも正しく伝わる
                }
                return;
            }
        }

        // --- 1. 一部入金/出金にするボタンの処理 ---
        const partialPaymentButton = event.target.closest(partialPaymentButtonSelector);
        if (partialPaymentButton) {
            console.log('Partial payment button clicked:', partialPaymentButton);
            const statementAmountElement = document.querySelector(statementAmountSelector);
            if (!statementAmountElement) { console.error('Could not find statement amount element using selector:', statementAmountSelector); return; }
            const amount = parseAmount(statementAmountElement.textContent);
            if (isNaN(amount)) { console.error('Could not parse statement amount:', statementAmountElement.textContent); return; }
            currentStatementAmount = Math.abs(amount); // 絶対値を取得
            console.log(`Extracted statement amount: ${amount}, Storing absolute value: ${currentStatementAmount}`);

            targetTbodyForPartialPayment = partialPaymentButton.closest('tbody');
            if (!targetTbodyForPartialPayment) { console.error('Could not find parent tbody for partial payment button.'); return; }

            // 「選択した未決済取引」が複数件ある場合、同じtbody内で最初に見つかった入力欄
            // （＝別の未決済取引の一部入金/出金欄）に誤って自動入力してしまう問題があるため、
            // 複数選択時は自動入力自体を行わない（freee標準の決済残額表示のまま）。
            const selectedRowCount = targetTbodyForPartialPayment.querySelectorAll(scrubRowSelector).length;
            if (selectedRowCount > 1) {
                console.log(`${selectedRowCount} unpaid transactions are selected. Skipping auto-fill to avoid affecting the wrong row.`);
                targetTbodyForPartialPayment = null;
                currentStatementAmount = null;
                return;
            }

            console.log('Target tbody for observation:', targetTbodyForPartialPayment);
            observePartialPaymentInput(targetTbodyForPartialPayment, currentStatementAmount);
            return;
        }
    });

    // --- 一部入出金入力欄が表示されるのを監視する関数 ---
    function observePartialPaymentInput(targetTbody, statementAmount) {
        if (!targetTbody || isNaN(statementAmount)) return;

        const observer = new MutationObserver((mutationsList, observer) => {
            const inputElement = targetTbody.querySelector(partialPaymentInputSelector);

            if (inputElement) {
                console.log('Partial payment input field detected in target tbody.');
                observer.disconnect();
                targetTbodyForPartialPayment = null;
                currentStatementAmount = null;

                // freee(React)側がデフォルト値（決済残額）を非同期にセットして
                // 上書きしてくることがあるため、短時間のあいだ繰り返し値を再設定して勝つようにする。
                let count = 0;
                const reassert = () => {
                    // 対象inputがDOMから消えていたら（登録済み等）中断
                    if (!document.contains(inputElement)) return;
                    setReactInputValue(inputElement, statementAmount);
                    console.log(`Partial payment input populated (${count + 1}/${partialPaymentReassertCount}) with statement amount (abs):`, statementAmount);
                    count++;
                    if (count < partialPaymentReassertCount) {
                        setTimeout(reassert, partialPaymentReassertIntervalMs);
                    } else {
                        // 再設定が完了したタイミングでフォーカスを当て、値を全選択しておく。
                        // freeeの仕様上、入力欄に一度フォーカスしてから外さないと登録ボタンが
                        // 有効にならないため、フォーカスだけは自動化し、その後のクリック操作は
                        // 通常どおり(フォーカス解除→登録)で済むようにする。
                        focusAndSelect(inputElement);
                    }
                };
                reassert();
                return;
            }
        });

        observer.observe(targetTbody, { childList: true, subtree: true, attributes: true });
        console.log('MutationObserver started for partial payment input in tbody:', targetTbody);

        const timeoutId = setTimeout(() => {
            if (observer) {
                observer.disconnect();
                console.log('Partial Payment Observer timed out.');
                targetTbodyForPartialPayment = null;
                currentStatementAmount = null;
            }
        }, 5000);

        const originalDisconnect = observer.disconnect.bind(observer);
        observer.disconnect = () => { clearTimeout(timeoutId); originalDisconnect(); };
    }

    console.log('freee Partial Payment Helper script loaded (v1.1).');

})();
