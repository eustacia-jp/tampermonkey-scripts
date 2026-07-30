# freee Help Link Copier

freeeヘルプセンター（support.freee.co.jp）の記事ページに、タイトルとURLをワンクリックでコピーできるアイコンを追加するTampermonkeyユーザースクリプトです。

ヘルプページのURLをメールやメモに貼り付ける際、タイトルと合わせてきれいな形式でコピーしたい、というニーズから作りました。

## インストール

[Raw URLはこちら](https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-help-link-copier/freee-help-link-copier.user.js)

[Tampermonkey](https://www.tampermonkey.net/) 拡張機能が導入済みのブラウザで上記リンクを開くと、インストール確認画面が表示されます。

## できること

freeeヘルプセンターの記事ページを開くと、以下の3箇所にコピーアイコンが表示されます。

- ページタイトルの横 — ページ全体のタイトルとURLをコピー
- 目次（ToC）内の各リンクの横 — そのセクションの見出しとURLをコピー
- 本文中のH2/H3見出しの横 — その見出しとURLをコピー

コピーされる文字列には「freee会計」などのプロダクト名（ページ上部のパンくずリストから自動取得）も含まれ、デフォルトでは以下のような形式でコピーされます。

```
▼ヘルプページ：［freee会計］freee会計の事業所の設定を行う
https://support.freee.co.jp/hc/ja/articles/202847220
```

## そのほかの機能

- コピーする文字列のフォーマットは、Tampermonkeyメニューの「コピー形式を設定...」から自由にカスタマイズできます（`{title}` `{product}` `{mainTitle}` `{sectionTitle}` `{url}` のプレースホルダーが使えます）
- 設定内容はTampermonkeyのストレージに保存され、スクリプト更新後も保持されます

## 必要な権限について

このスクリプトは以下の権限を使用しています。

| 権限 | 用途 |
|---|---|
| `GM_setClipboard` | コピー内容をクリップボードに書き込むため |
| `GM_addStyle` | アイコンや設定画面のスタイルを適用するため |
| `GM_getValue` / `GM_setValue` | コピー形式のテンプレート設定を保存するため |
| `GM_registerMenuCommand` | Tampermonkeyメニューに設定画面への導線を追加するため |

## 注意事項

- 本スクリプトはfreeeヘルプセンターのページ構造に依存しています。freee側の仕様変更により、予告なく動作しなくなる可能性があります
- 自己責任でご利用ください
- 不具合や要望があれば、[Issues](https://github.com/eustacia-jp/tampermonkey-scripts/issues)でお知らせいただけると助かります
