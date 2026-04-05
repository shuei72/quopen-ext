# Quopen

Quopenは、Quick Openでフォルダも選択できるようにすることで、再帰的な絞り込みを可能にするVS Code拡張機能です。  
同名ファイルが多いワークスペースでも、フォルダをたどりながら素早く目的のファイルを開けます。

## コマンド
<!-- コマンド行の最後には空白を2ついれること -->

`Quopen: Quick Open by Folder`  
フォルダとファイルを同じ一覧に表示します。フォルダを選ぶと再帰的に絞り込み、ファイルを選ぶと開きます。

## 特徴

- フォルダとファイルを同じ一覧に表示します。
- フォルダを選ぶたびに、その配下を再帰的な一覧としてたどれます。
- 一覧ではファイルアイコンとフォルダアイコンを表示します。
- マルチルートワークスペースに対応します。
- WindowsでEverythingが利用可能な場合、高速に一覧を生成します。

## Everything推奨(Windows)

QuopenはEverythingなしでも動作しますが、WindowsではEverythingの利用を強く推奨します。  
`es.exe` が利用可能な場合、Quopenは検索バックエンドとしてEverythingを用いて、大規模なワークスペースでもかなり高速に動作します。  
(`es.exe` はEverythingが提供するコマンドラインインターフェースです。)

- 推奨設定: `quopen.searchBackend = auto`
- 必要に応じて: `quopen.everythingPath = C:\\Path\\To\\es.exe`
- Everythingが使えない場合は、自動でネイティブのワークスペースインデックスにフォールバックします。

## 開発用

### PowerShell

```powershell
npm.cmd install
npm.cmd run compile
npm.cmd run package
```

### Command Prompt

```cmd
npm install
npm run compile
npm run package
```

## その他

- この拡張機能の作成にはCodexを利用しています。

## ライセンス

MIT License
