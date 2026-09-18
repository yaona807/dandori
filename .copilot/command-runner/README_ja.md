# ユーザーレベル・ワークスペースコマンドランナー

[English](./README.md)

このディレクトリには、固定Node.jsコマンド本体、boundedな管理・実行interface、Agent固有の `PreToolUse` Hook、個人用Workspace設定のサンプルを格納します。`CommandRunner` Agent定義は、他のDANDORI Agentと同じ `../agents/CommandRunner.agent.md` に配置します。

実際の利用ファイルは `~/.copilot/` 配下へインストールします。CommandRunnerの制御ファイルや個人用の許可コマンド設定を、対象プロジェクトのリポジトリへ追加する必要はありません。

## 対応環境

バージョン1の対象はmacOS、Linux、WSL2です。Windowsネイティブ環境には未対応です。

Hookと固定Runnerの呼び出しには `~/.copilot/...` を使用するため、POSIX互換シェルで `~` が展開される必要があります。

## インストール

Agentは他のDANDORI Agentと一緒に配置し、固定RunnerとHookを追加でインストールします。

```bash
mkdir -p ~/.copilot/agents ~/.copilot/command-runner
cp .copilot/agents/CommandRunner.agent.md ~/.copilot/agents/
cp .copilot/command-runner/command-runner.mjs ~/.copilot/command-runner/
cp .copilot/command-runner/command-runner-interface.mjs ~/.copilot/command-runner/
cp .copilot/command-runner/command-runner-hook.mjs ~/.copilot/command-runner/
test -f ~/.copilot/command-runner/workspaces.json \
  || cp .copilot/command-runner/workspaces.example.json ~/.copilot/command-runner/workspaces.json
```

`~/.copilot/command-runner/workspaces.json`を編集し、サンプルのrootをcanonicalな絶対Workspaceパスへ置き換えます。この個人用ファイルはDANDORIリポジトリへコミットしません。Workspace自体を用意した後は、コマンドmapを手動編集するほか、後述の固定 `register` / `unregister` interfaceから管理できます。

Agent固有HookはPreview機能のため、VS Codeの `chat.useCustomAgentHooks` を `true` にします。Chat Diagnosticsで、`CommandRunner`が `~/.copilot/agents/CommandRunner.agent.md` から読み込まれていることを確認してください。

`COPILOT_HOME`を設定した場合、Runnerの設定・データ参照先だけが変わります。Runnerは `$COPILOT_HOME/command-runner/workspaces.json` を読み、実行出力を `$COPILOT_HOME/command-runner/executions/` 配下へ保存します。Agent・Runner・Hook本体のインストール先は引き続き `~/.copilot/` です。

## Workspaceの選択

Runnerは実行時に次の処理を行います。

1. 実際のカレントディレクトリを解決する
2. 登録された各Workspace rootを解決する
3. カレントディレクトリを含むrootのうち、最も深いrootを選択する
4. 選択したWorkspaceのコマンドだけを公開する
5. 一致するWorkspaceがなければfail-closedで拒否する

実行位置はWorkspace rootでも、その配下のディレクトリでも構いません。AgentからWorkspace IDを指定したり、別のWorkspaceを選択したり、ターミナルのcwd・環境変数・shell・profileを上書きしたり、バックグラウンド実行を要求したりすることはできません。リポジトリ名やGit remoteは認可境界として使用しません。

コマンド管理にも同じ選択規則を使用します。`register` / `update` / `unregister` が変更できるのは、実際のカレントディレクトリから選択されたWorkspaceのcommand mapだけです。Workspace IDやrootを引数で指定することはできません。

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

1コマンドの公開 `describe` 定義にもサイズ上限を設けます。公開結果には固定argvなどを露出せず、CAS置換・削除に使う `definitionHash` を含めます。安全なサイズで返せない場合は、その `describe` 要求をfail-closedで拒否します。

## Runnerのインターフェース

現在のWorkspace内から実行します。

```bash
node ~/.copilot/command-runner/command-runner-interface.mjs list [query=<encoded-id-fragment>] [offset=<n>]
node ~/.copilot/command-runner/command-runner-interface.mjs describe test
node ~/.copilot/command-runner/command-runner-interface.mjs register lint definition=<encoded-json>
node ~/.copilot/command-runner/command-runner-interface.mjs update lint expected=<definition-hash> definition=<encoded-json>
node ~/.copilot/command-runner/command-runner-interface.mjs unregister lint expected=<definition-hash>
node ~/.copilot/command-runner/command-runner-interface.mjs run test runInBand=true
node ~/.copilot/command-runner/command-runner-interface.mjs output <execution-id> stream=stdout|stderr [offset=<n>]
```

引数値にはURI component encodingを使用します。Workspace path型の引数は、選択されたroot配下へ解決できない場合に拒否されます。`register`と`update`はURI component encodingしたJSONコマンド定義を1個だけ受け取り、decode後の定義は16 KiB以内に制限します。`update`には現在の `definitionHash` も必要です。

AgentとHookが直接呼べるのは `command-runner-interface.mjs` だけです。実行時のcommand schema検証とprocess起動は、従来どおり固定 `command-runner.mjs` coreへ委譲します。管理操作でも、保存前に候補となる設定全体を同じcoreで検証します。

Runnerがterminalへ返すレスポンスはすべて固定上限以下です。`list`はcommand IDだけを1回最大100件返し、続きがある場合は `nextOffset` を返します。`query`はcommand IDの単純な部分一致です。`describe`は1コマンドの公開定義と、canonical SHA-256の `definitionHash` を返します。

### コマンド管理

コマンド定義では必須引数と任意引数を直接設定できます。`required` を省略した場合は任意扱いで、未指定時に実行を拒否したい引数は `required: true` とします。

```json
{
  "description": "1つのtargetをbuildする。",
  "run": ["npm", "run", "build", "--"],
  "cwd": ".",
  "arguments": {
    "target": {
      "kind": "positional",
      "required": true,
      "value": { "type": "string", "maxLength": 80 }
    },
    "mode": {
      "kind": "option",
      "token": "--mode",
      "required": false,
      "value": { "type": "choice", "values": ["fast", "safe"] }
    }
  }
}
```

引数kindは `flag` / `option` / `positional` です。flag以外は `value` を持ち、`boolean`、範囲付き `integer`、`choice`、長さ上限付き `string`、`workspace-file`、`workspace-directory` を使用できます。`option` は固定tokenが必須、`positional` はtokenを持ちません。繰り返し可能なflag以外の引数は `repeatable: true` と有限の `maxItems` を指定します。

`register`は新規作成専用です。同じIDが存在する場合は `command_already_registered` で拒否し、upsertは行いません。渡された定義をstrict JSONとして解析し、現在選択中のWorkspaceにだけ挿入したうえで、候補となる `workspaces.json` 全体を固定Runnerで検証してから保存します。

`update`は既存1コマンドの定義を完全置換し、upsertは行いません。`describe`で取得した現在の `definitionHash` が必須で、古いhashは `stale_definition` で拒否します。置換定義をstrict JSONとして解析し、候補設定全体を検証してからatomicに保存します。

`unregister`には、`describe`で取得した現在の `definitionHash` が必須です。観測後に定義が変わっていた場合は `stale_definition` で拒否します。これにより、同じIDが別定義へ差し替わった後に古い削除要求で消してしまうことを防ぎます。バージョン1では既存の「登録Workspaceのcommand mapは空にしない」という不変条件を維持するため、最後の1コマンドは削除できません。

管理操作はユーザーレベルの `workspaces.lock` で直列化します。候補設定は同じディレクトリのmode `0600` 一時ファイルへ書き、設定全体の検証と元ファイル不変確認が通った場合だけatomic renameします。生きているlockがある場合は `configuration_busy`、5分を超えたlockは `stale_configuration_lock` として報告し、自動破壊はせず手動削除を要求します。

これらの管理primitiveは「何を登録・置換・削除・実行すべきか」を判断しません.指定されたexact mutationを設定整合性を維持しながら適用するだけです。

### 実行出力

`run`はstdout/stderrの全文をRunner管理の実行キャッシュへ保存し、terminalには次の小さい結果だけを返します。

- 選択されたWorkspace IDとcommand ID
- 推測困難なtimestamp付き `executionId`
- 設定されたWorkspace相対 `cwd`
- exit codeとsignal
- `timedOut` と `outputTruncated`
- stdout/stderrのバイト数
- stdout/stderr末尾の短いpreview

指定引数の値は結果へ再掲しません。追加出力は `output` だけで取得します。`output`はファイルパスではなくexecution IDを受け取り、固定サイズのチャンクと `nextOffset` / `eof` を返します。

実行出力は次の場所へ保存します。

```text
$COPILOT_HOME/command-runner/executions/<workspace-id>/<UTC-timestamp>_<UUID>/
  stdout.log
  stderr.log
```

このキャッシュは一時的な観測データであり、監査ログではありません。新しい `run` の前に24時間を超えた管理対象executionを削除し、必要な場合は管理キャッシュ全体が256 MiB以内になるまで古いexecutionを削除します。容量整理では61分より新しい結果を削除しません。これはcommandの最大timeout 1時間より長いためです。最近の結果だけで容量上限に達している場合は、実行中の可能性がある出力を消さず、新しい `run` をfail-closedで拒否します。

## セキュリティ境界

- 未登録のWorkspaceとcommandはfail-closedで拒否します。
- 一致するrootが複数ある場合は、最も具体的なrootを選択します。
- AgentからWorkspaceを登録または選択することはできません。
- commandの登録・削除は現在Workspace向けの固定管理operationだけで可能です。Agentの通常write toolによる `workspaces.json` 直接編集は引き続きHookで拒否します。
- `register`は既存IDを上書きせず、`unregister`は観測したdefinition hashへ束縛されます。
- 管理候補はatomic更新前にRunner設定全体として検証されます。
- Hookは、ターミナルのcwd・環境変数・shell・profile・バックグラウンド実行の上書きを拒否します。
- コマンドは `spawn(..., shell: false)` で起動します。
- timeoutまたは出力上限による停止時は、RunnerがコマンドのPOSIX process group全体へ停止を送り、固定猶予後に `SIGTERM` から `SIGKILL` へ昇格するため、通常の子孫processをbounded runの外へ残しません。意図的にdetachされた子孫processはこの保証の対象外です。
- Agent固有Hookは固定Runnerのインターフェースだけを許可し、ユーザーレベルの制御ファイルを保護します。
- `output`は有効なexecution IDだけを受け取り、現在のWorkspaceのexecution領域配下だけを解決します。任意ファイルパスは受け付けません。
- 実行出力は信頼できないデータとして扱い、後続コマンドの権限にはなりません。

Hookは追加のガードであり、OS sandboxではありません。登録済みコマンドはプロジェクトコードを実行し、そのコマンド固有の副作用を発生させる可能性があります。コマンド定義をレビューし、より強い分離が必要な場合はWorkspace Trust、通常の承認、コンテナなどを併用してください。

VS CodeのHookはタイムアウト時にfail-openとなります。偶発的な迂回を減らすためHookのtimeoutは30秒にしていますが、Hookだけを唯一のセキュリティ境界として扱ってはいけません。

## ローカル確認

```bash
node --test \
  .copilot/command-runner/command-runner.test.mjs \
  .copilot/command-runner/command-runner-interface.test.mjs
COPILOT_HOME=/path/to/test-home node .copilot/command-runner/command-runner-interface.mjs list
```
