# tampermonkey-scripts

ユースタシア合同会社の代表 Daiki MORI が個人で作成したTampermonkeyユーザースクリプトを置いているリポジトリです。  
主にfreee会計を使った業務向けに作っています。

## スクリプト一覧

| スクリプト | 説明 | インストール |
|---|---|---|
| [freee事業所設定クイックビュー](./freee-company-settings-quickview/) | freee会計でログイン中の事業所の基本情報・消費税などの設定をワンクリックで確認・コピーできるスクリプト | [Raw URLから導入](https://raw.githubusercontent.com/eustacia-jp/tampermonkey-scripts/main/freee-company-settings-quickview/freee-company-settings-quickview.user.js) |

各スクリプトの詳しい説明・使い方は、上記リンク先のフォルダ内README.mdをご覧ください。

## インストール方法（共通）

1. ブラウザに [Tampermonkey](https://www.tampermonkey.net/) 拡張機能を導入します
2. 上の一覧の「Raw URLから導入」リンクを開きます
3. Tampermonkeyのインストール確認画面が表示されるので、「インストール」を押します

インストール後は、スクリプト側の`@version`が上がると自動的に更新を検知します（Tampermonkeyのダッシュボードから手動でチェックすることもできます）。

## ご利用にあたって

- いずれのスクリプトも非公式のものです。連携先サービス（freee等）の仕様変更により、予告なく動作しなくなる可能性があります
- 自己責任でご利用ください
- 不具合や要望があれば、[Issues](https://github.com/eustacia-jp/tampermonkey-scripts/issues)でお知らせいただけると助かります

## ライセンス

[LICENSE](./LICENSE) を参照してください。
