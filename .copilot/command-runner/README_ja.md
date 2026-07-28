# ユーザーレベル・ワークスペースコマンドランナー

[English](./README.md)

このディレクトリには、ユーザーレベルで利用する `CommandRunner` Agent、固定Node.js Runner、Agent固有の `PreToolUse` Hookの配布元を格納しています。

実際の利用ファイルは `~/.copilot/` 配下へインストールします。CommandRunner関連ファイルや個人用の許可コマンド設定を、対象プロジェクトのリポジトリへ追加する必要はありません。

## 対応環境

バージョン1の対象はmacOS、Linux、WSL2です。Windowsネイティブ環境には未対応です。

Hookと固定Runnerの呼び出しには `~/.copilot/...` を使用するため、POSIX互換シェルで `~` が展開される必要があります。

## インストール

DANDORI本体のAgentとSkillに加えて、このコンポーネントをインストールします。

```bash
mkdir -p ~/.copilot/agents ~/.copilot/command-runner
cp .copilot/command-runner/CommandRunner.agent.md ~/.copilot/agents/
cp .copilot/command-runner/command-runner.mjs ~/.copilot/command-runner/
cp .copilot/command-runner/command-runner-hook.mjs ~/.copilot/command-runner/
test -f ~/.copilot/command-runner/workspaces.json \
  || cp .copilot/command-runner/workspaces.example.json ~/.copilot/command-runner/workspaces.json
```

`~/.copilot/command-runner/workspaces.json`を編集し、サンプルのrootをcanonicalな絶対Workspaceパスへ置き換えます。この個人用ファイルはDANDORIリポジトリへコミットしません。

Agent固有HookはPreview機能のため、VS Codeの `chat.useCustomAgentHooks` を `true` にします。Chat Diagnosticsで、`CommandRunner`が `~/.copilot/agents/CommandRunner.agent.md` から読み込まれていることを確認してください。

`COPILOT_HOME`を設定した場合、変更されるのは設定ファイルの検索先だけです。Runnerは `$COPILOT_HOME/command-runner/workspaces.json` を読み込みますが、Agent・Runner・Hook本体の配置先は引き続き `~/.copilot/` です。

## Workspaceの選択

Runnerは実行時に次の処理を行います。

1. 実際のカレントディレクトリを解決する
2. 登録された各Workspace rootを解決する
3. カレントディレクトリを含むrootのうち、最も深いrootを選択する
4. 選択したWorkspaceのコマンドだけを公開する
5. 一致するWorkspaceがなければfail-closedで拒否する

実行位置はWorkspace rootでも、その配下のディレクトリでも構いません。AgentからWorkspace IDを指定したり、別のWorkspaceを選択したり、ターミナルのcwd・環境変数・shell・profileを上書きしたり、バックグラウンド実行を要求したりすることはできません。リポジトリ名やGit remoteは認可境界として使用しません。

## 設定

各Workspaceには、固定ID、絶対root、Workspace固有のコマンド定義を登録します。コマンドは固定argv配列と、任意の検証済み名前付き引数で構成します。

```json
{
  "version": 1,
  "workspaces": [
    {
      "id": "example",
      "root": "/absolute/path/to/example",
      "commands": {
        "test": {
          "description": "テストを実行する。",
          "run": ["npm", "test", "--"],
          "cwd": ".",
          "arguments": {
            "runInBand": {
              "kind": "flag",
              "token": "--runInBand"
            }
          }
        }
      }
    }
  ]
}
```

`run`は必ずargv配列として定義し、shell文字列は使用しません。動的な実行ファイル、raw引数の受け渡し、利用者定義の正規表現、無制限の引数はサポートしません。

`-`から始まるpositional値は拒否します。対象プログラムが対応している場合は、positional引数より前に固定argvとして `--` を登録してください。

`workspace-file`と`workspace-directory`は、symlink解決後のパスを検証します。`mustExist`が `false` の場合も、最も近い既存の親ディレクトリを先に解決するため、Workspace外を指すsymlink配下の未作成パスは拒否されます。

## Runnerのインターフェース

現在のWorkspace内から実行します。

```bash
node ~/.copilot/command-runner/command-runner.mjs list
node ~/.copilot/command-runner/command-runner.mjs describe test
node ~/.copilot/command-runner/command-runner.mjs run test runInBand=true
```

引数値にはURI component encodingを使用します。Workspace path型の引数は、選択されたroot配下へ解決できない場合に拒否されます。

`run`の結果には次を含めます。

- 選択されたWorkspace ID
- command IDと正規化済みの指定引数
- 設定されたWorkspace相対 `cwd`
- exit codeとsignal
- `timedOut`
- `outputTruncated`
- stdoutとstderr

## セキュリティ境界

- 未登録のWorkspaceとcommandはfail-closedで拒否します。
- 一致するrootが複数ある場合は、最も具体的なrootを選択します。
- AgentからWorkspaceを登録または選択することはできません。
- Hookは、ターミナルのcwd・環境変数・shell・profile・バックグラウンド実行の上書きを拒否します。
- コマンドは `spawn(..., shell: false)` で起動します。
- Agent固有Hookは固定Runnerのインターフェースだけを許可し、ユーザーレベルの制御ファイルを保護します。

Hookは追加のガードであり、OS sandboxではありません。登録済みコマンドはプロジェクトコードを実行し、そのコマンド固有の副作用を発生させる可能性があります。個人設定をレビューし、より強い分離が必要な場合はWorkspace Trust、通常の承認、コンテナなどを併用してください。

VS CodeのHookはタイムアウト時にfail-openとなります。偶発的な迂回を減らすためHookのtimeoutは30秒にしていますが、Hookだけを唯一のセキュリティ境界として扱ってはいけません。

## ローカル確認

```bash
node --test .copilot/command-runner/command-runner.test.mjs
COPILOT_HOME=/path/to/test-home node .copilot/command-runner/command-runner.mjs list
```
