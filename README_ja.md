<p align="center">
  <img src="./assets/dandori-logo.png" alt="DANDORI logo" width="160">
</p>

<h1 align="center">DANDORI</h1>

<p align="center">
  <strong>今使っているエージェントへ、境界付き適応型の司令塔レイヤーを追加する。</strong>
</p>

<p align="center">
  承認は短く、実行は狭く、Workerは差し替え可能に。
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

DANDORI は、VS Code上のGitHub Copilot Custom Agents向けOrchestratorレイヤーです。

人間が承認したGoalと能力・リソース境界を、厳密なTask Cardへ変換します。Orchestratorは契約内で自律的に調査・計画・再計画し、Workerには指定された対象・Action・Effectの範囲で実行するよう指示し、報告された操作を監査します。

DANDORI の中核は **Orchestrator** です。同梱している Worker は reference implementation です。そのまま使うことも、既存の Custom Agent へ置き換えることも、専用 Worker を追加することもできます。Orchestrator へ Worker の内部詳細を埋め込む必要はありません。

> DANDORI は独立したオープンソースプロジェクトです。GitHub または Microsoft と提携、承認、保守されているものではありません。

## なぜDANDORIか

AIエージェントは強力ですが、曖昧な委譲には次のような問題があります。

- 不要なリポジトリ調査
- 進捗のない tool 呼び出しの反復
- 推測による編集
- 実行中のscope拡張
- Workerによる次工程の自己決定
- 内部計画の変更だけで発生する再承認
- 長すぎて読まれなくなる承認画面

トークン効率化は、プロンプトを短くすることだけではありません。Agentic workflow では、不要な作業、重複したコンテキスト、過剰な検証が、そのままトークン消費になります。

DANDORI は、処理を次の2層へ分離します。

- **ユーザーが承認する契約**: Goal、Completion Criterion、操作能力の種類、リソース境界、累積Effect、除外、検証要件
- **内部で適応する計画**: Worker選択、実行順、Task Cardの統合・分割、境界内調査、再試行、検証

契約を広げる場合だけユーザーへ再承認を求め、契約内の内部計画変更では再承認しません。

## Bounded Adaptive Orchestration

DANDORI は、次の包含関係を中心に設計されています。

```text
Worker execution operation ⊆ exact Task Card operation ⊆ instance of a human-approved capability envelope

active approved contract = ordered fold(authorization source sequence)
```

**Task Flow Review（TFR）** は、ユーザーが短時間で判断するための承認画面です。詳細な実行計画ではありません。

**Task Card** は、Worker非依存の実行契約です。具体的な目的、許可された対象・Action・Effect、上限、成果物、中断条件だけを渡します。Criterion参照、承認由来、進捗分類、ルーティングはOrchestratorの内部台帳で管理し、Workerには渡しません。

人間は目的と対象領域・可能な操作・副作用を承認し、個別ファイル名やコマンドIDは承認しません。Orchestratorは契約内の具体化、Worker選択、調査、修正、再計画を自由に行い、権限を拡張する場合だけ **Task Flow Change（TFC）** を提示します。

事前に監査済みの複数操作は、観測から既知対象の変更まで1枚のTask Cardで委譲できます。Workerは順序や許可済み引数を選択し、副作用のない通常エラーから範囲内で回復できます。汎用ツールでも実際の呼び出しが対象内なら使用できます。新しい変更対象はOrchestratorが監査して別Cardを発行し、登録や権限拡張もOrchestratorが判断します。

ビルド・Lint・テストなどは初回TFRで副作用の範囲を承認できます。Orchestratorは発見されたコマンドの実行条件を監査してから委譲します。既知の実行内容の変更は再監査しますが、Workerが実行時ハッシュを取得・転記する必要はありません。実行時の登録済み定義が正本であり、登録自体は権限ではなく、ホスト制限も回避しません。

## 主な特徴

- **目的単位の承認**: ユーザーはGoal、境界付きCapability、累積Effect、検証、除外を確認し、個別のファイルやコマンドを列挙しない
- **Revision付き契約**: Task CardとWorker結果を、順序付き・追記専用の正規化Authorization Patchをfoldして再構築した1つの有効な契約Revisionへ結び付ける
- **適応的な内部計画**: 契約を広げない限り、Worker・順序・Task Card構成を変更できる
- **競合を避ける並列実行**: 対応環境では独立したTask Cardを最大3件同時に実行し、ファイルや共有リソースの競合時は直列化する
- **権限境界単位のTask Card**: 工程ごとに細分化せず、同じ対象・効果・検証境界の作業をまとめる
- **発見と作用の分離**: Workerが発見した対象を、同じ呼び出し内で変更させない
- **Workerの原子的な作用対象**: 広い人間契約からOrchestratorが正確な対象を具体化し、Workerにはプロジェクト全体の編集権限を渡さない
- **Capability単位の認可**: リソース境界・操作の種類・累積Effect・条件を不可分の権限として扱い、直積権限を作らない
- **Worker非依存**: Worker定義をWorker挙動と出力形式の唯一の情報源とする
- **契約監査**: Workerが報告したOperation、上限、根拠、期待する進捗、Revisionを確認してからCriterionの進行を認める
- **別コンテキスト検証**: 検証対象を変更しない範囲で、認可済みの検証コマンドが既知のcache等を生成することは許容できる
- **差分承認**: 拡張を含むRevisionでは、同時に行う縮小も含めたContract Patch全体を提示する
- **証拠ベースのループ制御**: 検証済みの改善または根拠ある診断の進展で継続し、停滞時は固定2回で終了せず戦略を変える

## 既存Workerを使い回せる

Orchestrator は、固定のWorker能力表、Worker別ルーティング表、Worker指示の複製を持ちません。

実行時に、runtime上で見える許可Agentの名前とdescriptionから候補を選び、自己完結した境界付きTask Cardを1件渡します。委譲前に必要な操作能力を肯定的に確認し、ファイル編集能力からターミナル実行能力を推測しません。`execute+change_local`はローカル変更を伴うコマンド実行として扱い、すべての操作に対応できるWorkerがなければ依存関係付きのTask Cardへ分けます。Worker定義ファイルの事前読み取りには依存せず、Worker固有の入力キー、ラッパー、スキーマ、入力言語要件も採用しません。予想外にblockedになった適合候補は除外し、承認範囲を広げずに未試行の適合候補を試せます。適合する候補が見つかるか、候補が尽きた時点で探索を止めます。

そのため、次の運用が可能です。

- 同梱Workerから始める
- 既存のCustom Agentを再利用する
- Orchestratorの制御ロジックを変えずにWorkerを交換する
- 必要に応じて許可Agent一覧へ専用Workerを追加する

Worker側へDANDORI固有の実装詳細を持たせる必要はありません。Worker定義は、Task Cardのキー、入力ラッパー、呼び出し元固有のスキーマ、DANDORI固有の出力エンベロープを規定してはいけません。

Workerのdescriptionは委譲できる仕事を示すもので、操作権限を与えるものではありません。通常、Workspaceやサブツリーは論理的な対象を表します。ただし、ユーザーがパス文字列そのものを制限した場合は、その条件も守ります。Workerはツールが承認範囲を守れるなら通常のパスで作業でき、別の表記との同一性が権限や完了判定に関わるときだけ根拠を確認します。Orchestratorは実体と承認範囲を照合し、返却されたパス表記を新しい承認・完了条件にはしません。これはコード調査・編集・レビュー・コマンド実行に共通する規則です。範囲外やリンク先が確認できないパスへのアクセス権限は増えません。

VS Code／Copilotのファイル操作ツールがWorkspace内のファイルを誤って範囲外と判定した場合も、Dandoriの承認範囲を勝手に広げたり、ツール側の許可確認を回避したりはしません。ツール名・VS Code／Copilotのバージョン・該当パスを記録して切り分けます。関連する上流の修正は[microsoft/vscode#331566](https://github.com/microsoft/vscode/issues/331566)と[microsoft/vscode#334409](https://github.com/microsoft/vscode/issues/334409)です。現在の環境に修正が入っているかは別途確認が必要です。

## Workerの並列呼び出し

Orchestratorは、使用中のVS Code Harnessが対応する場合、独立したTask Cardを**最大3件まで並列実行**できます。非対応なら直列実行に戻します。依存先の結果は監査完了まで待ちます。並列実行前にはWorker名ではなく、Task Cardで**許可された操作すべて**から読み取り・書き込み・排他的共有リソースの範囲を評価します。読み取り同士は並列可能ですが、同じファイルへの読み書き・書き込み、共通のコマンド出力先、Gitインデックス、キャッシュ、ポートなどが競合すれば直列化します。シンボリックリンクの同一性や副作用が不明な場合も、独立性を推測しません。

人間が対象件数の上限を明示した場合だけ、起動前に残り枠を確保します。戻り順に関係なくTask Card IDと契約Revisionごとに監査し、タイムアウトで副作用が不明なタスクと競合する操作は待機させます。影響する書き込みが終わってから別コンテキストで検証します。この調整は同じOrchestrator Flow内に限られ、別セッションや人間の編集をロックしません。Worker定義とTask Cardの権限構造は変更しません。実機の検証事項は[CONF-025〜030](./tests/conformance.md)に追加しています。

## 仕組み

```text
ユーザー要求
   ↓
短いTask Flow Review
   ↓ 完全一致承認
Authorization source sequence
   ↓ ordered fold
Approved Contract revision
   ↓
Flow Ledger: Completion Criterion、正確なOperation Instance、任意上限、修正・診断の根拠
   ↓
実行可能な独立Task Card（最大3件）
   ↓
選択されたWorker（Task Cardごとに1件）
   ↓
Task Cardごとの結果正規化と契約監査
   ↓
必要な場合だけ別コンテキスト検証
   ↓
完了 / 次のTask Card / 差分承認 / 部分終了
```

Orchestrator がcontrol planeを担当し、Workerは狭い実作業だけを担当します。

## 承認例

Orchestrator は、次のような短いTask Flow Reviewを提示します。

```markdown
## Task Flow Review: TFR-ab12

**目的**
指定された不具合を修正する

**完了条件**
- 原因が根拠とともに説明されている
- 必要な変更が承認済みCapability内で実施されている
- 実施できた検証結果または未検証理由が報告されている

**認可するCapability**
- Inspect: 対象リポジトリ内の検索・読取 (`observe`)
- Edit local: 対象リポジトリ内のコード・テスト作成と修正 (`change_local`)
- Run local: 対象リポジトリ内の出力範囲が限定されたcache生成を含む登録済み検証の実行 (`observe, execute, change_local`)

**検証要件**
- 永続的な変更は別コンテキストで確認する

**再承認**
別のGoalには新しいTFRが必要です。
Criterionの追加、対象範囲・Action種別・Effectの拡張、条件・上限の緩和、除外の削除、検証の弱化にはTFCが必要です。
```

承認は完全一致で判定し、表示言語に関係なく共通の英語トークンを使用します。

```text
APPROVE:TFR-ab12
```

条件、修正、追加指示が含まれている場合は、承認ではなく変更要求として扱います。同じチャットセッション内では、TFR/TFCのIDと承認トークンを再利用しません。

各Capabilityには境界・操作種別・許可するActionの種類・累積Effect・重要な条件を表示します。内部の`actions`は表示した種類から導出し、空欄は全操作を拒否します。個別のファイルやコマンドはOrchestratorが厳密なTask Cardへ具体化し、契約内なら再承認しません。

途中で契約を広げる必要が生じた場合は、差分だけを表示します。

```markdown
## Task Flow Change: TFC-cd34

**理由**
ローカル操作だけの契約では許されていない外部作用が必要になった

**Contract patch**
- Add: 特定の宛先に限定した外部公開能力 (`affect_external`)

記載していない契約項目は変更しません。
```

差分承認も、言語に依存しない共通トークンを使用します。

```text
APPROVE:TFC-cd34
```

## 言語対応

DANDORI は、ユーザーの母国語を推測せず、現在の**対話言語**を使用します。判定の優先順位は次のとおりです。

1. ユーザーが明示的に指定した言語
2. 現在の実質的な依頼で主に使われている言語
3. それまで継続して使われている会話言語
4. 複数言語が混在する、曖昧、または判断できない場合は英語

TFR/TFCのラベルや説明、質問、停止・部分完了報告、検証水準、最終回答は対話言語で表示します。一方、コード、パス、識別子、schema key、効果タグ、Evidence state、status、承認トークンは翻訳しません。表示言語を途中で変更しても、Approved Contract、Revision、既存の承認状態は変わらず、再承認も不要です。

Task Cardの制御フィールドは英語固定です。目的や完了条件などの自由記述は対話言語を使用します。Worker結果は最終統合時に対話言語へ変換しますが、コード、パス、識別子、literal、引用した根拠は翻訳しません。

## 効果モデル

DANDORI は、次の累積効果タグを使用します。

| 効果 | 意味 |
| --- | --- |
| `observe` | 読み取り、検索、確認、分析、情報取得 |
| `change_local` | ローカル成果物の作成・変更 |
| `execute` | コマンド、テスト、スクリプト、自動処理の実行 |
| `affect_external` | UI、API、メッセージ、保存、投稿などによる外部状態の変更 |
| `destructive` | 削除、破棄、不可逆な上書きなど |

効果は排他的ではなく累積します。たとえば、ファイルを変更し得るコマンドには `execute` と `change_local` の両方が必要です。toolや操作を許可しても、その二次的な効果までは自動的に許可されません。

人間の認可はCapability単位です。各権限はリソース境界・人間に提示した閉じたAction集合・累積Effect・重要な条件を不可分に結び付けます。Orchestratorだけが正確なWorker用Operationを生成し、別々の権限を合成しません。

## 対象の認可

調査境界と作用対象は分離します。

人間は対象リポジトリ内の修正を包括的に許可できますが、Workerに渡す作用対象は個別識別できる**原子的な対象**だけです。ディレクトリやワイルドカードをWorkerの一括編集対象にはしません。

発見された候補はOrchestratorが、正確な識別子、目的との関連、承認境界、根拠、Action・Effect、任意の件数上限を照合して具体化します。候補を発見したWorker呼び出し内では作用させません。発見自体は権限ではありません。

既存ディレクトリとディレクトリ配下全体は、原子的な作用対象ではありません。正確に認可されたファイルを新規作成する場合、そのファイルを成立させるために不足している祖先ディレクトリだけは付随的な構造として作成でき、追加の作用対象を消費しません。この扱いから兄弟要素や他の子孫への権限は導出しません。ディレクトリ自体を単独で作成する場合は、存在しないことを確認した正確なパスと`create_directory`、`change_local`を結び付けたOperationが引き続き必要です。

有効な契約は、追記専用のAuthorization Source Sequenceに含まれる正規化Patchを順番にfoldして再構築するmaterialized viewです。最初の承認済みTFRが契約を初期化し、承認済みTFCはRevision全体のPatchを適用し、明示的な縮小は構造的な削減だけを記録します。自由記述の原文は監査用であり、実行可能な権限の正本にはせず、削除した権限を暗黙に復元しません。

表示だけの文言修正やローカライズをRevision不要で行えるのは、正規化されたAuthorization Source Sequenceと実行可能な契約項目がすべてbyte単位で変化しない場合だけです。Criterion、Operation、Effect、上限、検証要件、除外、安定ID、Source順序の変更は構造変更として扱い、対応するRevision経路を使用します。

対象件数に既定の上限は設けません。任意上限が数えるのは**意図的な原子的作用対象**（直接編集するファイルなど）であり、コマンドIDや明示された限定範囲内の付随cache/report生成物ではありません。付随出力の許可範囲は実行CapabilityとTask Cardの両方に記載し、意図的なソース・基準値・成果物の変更はコマンド経由でも件数を消費します。未知の副作用は免除しません。正規化パッチは`set_max_distinct_targets`省略で上限維持、非負整数で設定、明示的な`null`でTFC承認後に解除します。有限上限は消費済み件数未満にできず、canonical typed identityで重複を防ぎます。

## 検証とループ制御

永続的な変更は別コンテキストで検証します。検証Task Cardは、既知のcacheなど付随するローカル生成物を含めてEffectが明示認可され、検証対象を変更しない場合に、登録済みチェックを実行できます。ソース・基準値・snapshotを修正する検証や、未知の副作用・外部作用は許可しません。実行後も予期しない変更がないことを確認します。これは第三者の完全独立レビューを意味しません。

検証手段がない場合は、再承認ループへ入れたり、確認済みと断定したりせず、「未検証」として報告します。

また、各Worker呼び出しには、次のいずれかの具体的な進捗が必要です。

- 新しい重要事実
- 新しい成果物
- 新しいCandidate Operation
- 成果条件の状態変化
- 検証結果
- 矛盾の解消
- より具体化された停止理由

DANDORIは**実質的進捗**（Criterionの検証済み改善）と**診断上の進捗**（根拠を伴う仮説の棄却、前提条件の発見、契約内の新しい有効候補）を区別します。完了根拠になるのは実質的進捗だけです。進捗のない2サイクル後は別戦略や識別力のある調査を検討し、有効な代替策を尽くした場合に部分終了します。同じ状態への等価実行を無意味に繰り返すことは禁止します。`execute`を含むTask CardはOrchestrator内部台帳で有効なCriterionに紐付け、WorkerにはIDを渡しません。

現在セッションの認可状態または累積ループ制御状態を信頼できる形で確立できない場合は、`state_unrecoverable` で停止します。承認済み調査境界内で再取得できる根拠は再観測できますが、権限状態、cap使用数、連続no-progress回数、pending resultとRevisionの対応を推測またはリセットしません。DANDORIはセッションを跨ぐresumeやdurable workflow stateを提供しません。

## 含まれるもの

```text
.copilot/
  agents/
    Orchestrator.agent.md
    Researcher.agent.md
    GitHubResearcher.agent.md
    Writer.agent.md
    Reviewer.agent.md
    BrowserQA.agent.md
  command-runner/
    command-runner.mjs
    command-runner-interface.mjs
    command-runner-hook.mjs
    command-runner.test.mjs
    workspaces.example.json
  skills/
    code-review/
      SKILL.md
.github/
  workflows/
    validate.yml
scripts/
  validate_definitions.py
  validate_release_archive.py
tests/
  test_validate_definitions.py
  test_validate_release_archive.py
  conformance.md
assets/
  dandori-logo.png
```

| Component | 役割 |
| --- | --- |
| `Orchestrator` | 要求整理、短い承認、契約管理、Task Card作成、Worker選択、監査、ループ制御、最終統合を担当するcontrol-plane agent |
| Reference workers | 調査、指定されたGitHub Issue / Pull Request確認、実装、レビュー、ブラウザ確認用の任意Worker |
| `code-review` skill | Reference Reviewerが使用するfocused review guidance |

## 互換性と前提条件

- DANDORI Agentは明示的にVS Codeを対象とします。
- 対応するAgentは、VS Code Local／Copilot harness双方のToolエイリアス（委譲の`agent`／`task`、Researcher・Writerの`execute/runInTerminal`／`execute`など）を宣言します。これは実行可能性の保証ではありません。使用中のharnessでToolが動作するか、[conformanceケース](./tests/conformance.md)（特に`CONF-024`）で確認してください。
- Subagent制限には、現在Experimentalである`agents` allowlistを使用します。
- `GitHubResearcher`にはGitHub Pull Requests拡張機能と、その拡張機能が公開するToolが必要です。
- `BrowserQA`には設定済みのbrowser Tool群が必要です。
- 利用できない、または認識されないTool名はruntimeに無視される場合があるため、実際のTool可用性を確認してください。
- 同梱Workerは、Toolの引数とruntime挙動で委譲境界を強制できる場合だけ、そのToolを呼び出します。利用可能なToolがより広い範囲でしか動作できない場合は、実行せず`blocked`を返し、必要な狭いcapabilityを示します。
- ResearcherとWriterは共通の固定CLIを直接利用します。`.copilot/command-runner/` からRunnerをインストールし、Agent固有Hookのため `chat.useCustomAgentHooks` を有効にしてください。
- 外部Workerは、自己完結した依頼を処理し、再委譲せず、必要以上のToolを持たず、役割と作用範囲をdescriptionへ正確に記載する必要があります。
- VS Code Chat Diagnosticsで、すべてのAgentとSkillの読み込み元を確認してください。

## 推奨モデル

DANDORI は、Orchestratorへ推論能力の高いモデルを使用することを推奨します。

Orchestrator は、実行方法の曖昧さと権限の曖昧さを区別し、契約を広げずに正規化し、最小Task Cardを作り、Worker結果を監査し、矛盾を処理し、包含関係を確認できない場合に停止する必要があります。

同梱のAgent定義では、**OrchestratorとReviewerに GPT-6.1 Sol (copilot)**（`medium`）、**WriterとBrowserQAに GPT-6.1 Terra (copilot)**（`low`）、**Researcher・GitHubResearcherに GPT-6 Luna (copilot)**（`low`）を指定します。`reasoning-effort`はCopilot harness向けのフィールドであり、モデルの実際の認識・選択はVS Codeで確認が必要です。追加した外部Workerのモデルは別途選択できます。

## インストール

VS Code上のGitHub Copilot Custom Agentsが対応する探索パスへ、AgentとSkillをコピーしてください。

### ユーザーレベル配置

複数workspaceで同じDANDORI設定を使う場合：

```bash
mkdir -p ~/.copilot/agents ~/.copilot/skills
cp .copilot/agents/*.agent.md ~/.copilot/agents/
cp -R .copilot/skills/* ~/.copilot/skills/
```

Researcher・Writerのコマンド実行には、固定Runnerを `~/.copilot/command-runner/` に配置する[インストール手順](./.copilot/command-runner/README_ja.md)が必要です。

### 標準workspace配置

1つのリポジトリと一緒に設定を管理する場合は、VS Codeの標準探索パスを使用します。

```bash
mkdir -p .github/agents .github/skills
cp .copilot/agents/*.agent.md .github/agents/
cp -R .copilot/skills/* .github/skills/
```

Workspace側にCommandRunner Agentを配置する必要はありません。ResearcherとWriterは同じ固定CLIを利用します。

### `.copilot`をworkspace内で使う場合

workspace内の `.copilot/agents` と `.copilot/skills` を使うには、`chat.agentFilesLocations` と `chat.agentSkillsLocations` で追加探索先として有効にする必要があります。設定を行わずに `.copilot` をコピーするだけで認識されるとは限りません。

### 既存インストールの更新

既存配置へ新しい版を上書きするだけでは、新版で削除・改名されたファイルが残ります。更新前にDANDORIが管理するファイルだけを削除し、その後で新版をコピーしてください。独自Workerや無関係なSkillは削除しないでください。

ユーザーレベル配置の削除対象：

```bash
rm -f ~/.copilot/agents/{Orchestrator,Researcher,GitHubResearcher,PullRequestResearcher,Writer,CommandRunner,Reviewer,BrowserQA}.agent.md
rm -rf ~/.copilot/skills/code-review
```

標準workspace配置の削除対象：

```bash
rm -f .github/agents/{Orchestrator,Researcher,GitHubResearcher,PullRequestResearcher,Writer,CommandRunner,Reviewer,BrowserQA}.agent.md
rm -rf .github/skills/code-review
```

更新時は旧 `PullRequestResearcher.agent.md` と廃止した `CommandRunner.agent.md` も削除し、古いWorkerが探索対象に残らないようにします。

削除後、選択した配置方法のインストールcommandを実行し、再度読み込み確認を行ってください。`.copilot`を追加探索先として使う場合も、設定した探索先から同じ管理対象ファイル名だけを削除します。

### 読み込み確認

1. VS CodeのChat Viewでcontext menuを開き、**Diagnostics**を選択する
2. すべてのDANDORI Agentと `code-review` Skillがエラーなく読み込まれていることを確認する
3. 各Agentの提供元を確認し、Orchestratorのallowlistが意図した定義を指していることを確認する
4. 外部Workerが上記の互換性チェックを満たすことを確認する
5. workspace、user、organization、extension、追加探索先にある同名定義の重複を削除または無効化する

同じAgent定義を複数の場所で有効にしないでください。重複定義があると、Copilotが利用者の意図とは異なる定義を呼び出す可能性があります。

## 使い方

1. Copilot Chatを開く
2. `Orchestrator` Agentを選択する
3. 作業を依頼する
4. 短いTask Flow Reviewを確認する
5. Goal、承認するCapability、リソースとEffectの境界、除外、検証要件が正しい場合だけ、承認用の1行をそのまま返信する
6. 後から契約を広げる必要が出た場合は、差分だけを確認する

## 定義の検証

Pull Requestを作成する前に、決定論的なvalidatorを実行できます。

```bash
python -m pip install PyYAML==6.0.3
python scripts/validate_definitions.py
python scripts/run_tests.py
```

配布ZIPはworking tree全体を圧縮せず、追跡済みファイルから生成し、実際の成果物も検証します。

```bash
git archive --format=zip --output=dandori.zip HEAD
python scripts/validate_release_archive.py dandori.zip
```

### 配布ZIPの検証

配布ZIPのValidatorは、次の問題を拒否します。

- path traversal
- symlink
- 生成物
- 重複する名前、または移植性上衝突する名前
- 想定外のtop-level entry
- 必須ファイルの欠落
- 展開後の定義検証失敗

移植性検査では、次の問題も拒否します。

- Unicode NFKCとcase-fold後の名前衝突
- Windows予約デバイス名
- 禁止文字・制御文字
- 末尾が空白またはピリオドのpath component

### GitHub Actionsの検証契約

GitHub Actionsでは、すべてのPull Requestと`master`へのpush時に、次の検証を実行します。

- 決定論的な定義検証
- Mutation Test
- 配布ZIP検証

Workflow構成は、次の内容に限定します。

- Workflow: `.github/workflows/validate.yml`
- Job: `validate`
- Trigger: `pull_request`、`push`
- `.github/actions`配下のローカルActionは禁止
- checkout後の資格情報は保持しない
- 検証Jobのtimeoutは15分

Validatorは、無条件のJobと、その配下にある正確なfail-closed検証StepをYAML構造として検査します。次のような迂回は認めません。

- 検証コマンドを別Jobへ移動する
- JobまたはWorkflowを追加する
- 未承認のTriggerを追加する
- `if`、`needs`、`continue-on-error`を追加する
- path filterで検証対象を限定する

Step ActionとReusable Workflowの`uses`もYAMLから解析し、外部参照は完全長commit SHAに限定します。

CIではPython bytecode生成を無効化します。Validatorは、次の状態も拒否します。

- tagまたはbranchを参照する`uses`
- repository symlink
- Python向けignore規則の欠落
- 追跡済み生成物

### Agent・Skill定義の検証

Validatorは、同梱定義をclosed release inventoryとして扱います。

Agent定義では、次の制約を検査します。

- Agentディレクトリでは`*.agent.md`以外を拒否する
- Tool境界を迂回し得る `hooks`、`handoffs`、`mcp-servers` を禁止する。ただしResearcherとWriterの固定Runner用 `hooks` だけは許可する
- 同梱Agentのfrontmatter、Tool、ファイル名、必須Section、安全Policy anchorを固定する
- 十分な圧縮余地を持つ本文回帰下限を固定する
- Orchestratorの中核Invariantが、意図したSection内に残っていることを検査する

同梱`code-review` Skillでは、宣言済みMarkdownだけを許可します。また、すべてのSkill Markdownに対して、次の内容を検査します。

- 大文字小文字や空白・ハイフン・アンダースコアの表記揺れを正規化したDANDORI固有依存
- Reviewerに属するWorker Policyの再流入

追加のローカルWorkerは`*.agent.md`として追加できますが、次の検査対象となります。

- 共通runtime
- 再委譲禁止
- 禁止frontmatter
- DANDORI固有依存

追加のローカルWorkerには、手動Policy／Diagnostics確認を要求するwarningを出します。リポジトリ外の外部Workerも定義を静的検査できないため、引き続きDiagnostics確認を要求するwarningとします。

### Test・Conformanceの検証

専用Test Runnerは、次の場合に失敗します。

- テストが0件
- CIでテストが1件でもskipされた

必須Mutation Testと配布ZIP Testは、次の要件を保持する必要があります。

- 許可されたClass・Method
- 実際の変異
- Validator失敗Assertion
- 空でない共通helper

各Conformance Caseは、空でないInputと、少なくとも1件の具体的なExpected bulletを保持しなければなりません。

静的ファイルからLLM挙動は推定しません。モデル、Worker Tool、VS Code更新時は、`tests/conformance.md`の構造化Caseと実行記録templateを使用します。

### Validatorが保証する範囲

Validatorが証明するのは、次の内容です。

- 構造制約
- Tool境界
- 必須Policy anchor
- 宣言された検証契約の完全性

一方、次の内容は証明しません。

- Agent定義全体に含まれる自然言語の意味的一貫性
- 静的ファイルから推定した実際のモデル挙動

そのため、Policy文言の変更は人間がレビューします。runtime挙動は、対象となるVS Code、Copilot Chat、モデル、拡張機能VersionごとにConformance Caseで確認します。

## 設計原則

- **ユーザー承認は実行履歴ではなく契約である**
- **内部計画は適応できるが、承認済み権限は適応させない**
- **対象、Action、Effectを1つのOperationとして認可する**
- **有効な契約は順序付き・追記専用のAuthorization Source Sequenceから導出する**
- **Task Cardは工程ではなく権限境界で分割する**
- **発見は作用を認可しない**
- **省略された権限は不許可とする**
- **Worker出力は次の作業を認可しない**
- **Worker選択は品質へ影響してもscopeを広げない**
- **重要な主張だけをEvidence stateで管理する**
- **検証は狭く、効果に応じて行う**
- **再承認は差分だけを、実質的なリスク変更時に行う**
- **進捗がなければ再委譲しない**

## セキュリティ境界

Task Cardはモデルへの指示と結果監査の境界であり、すべての編集ツールでファイル単位の許可を強制する仕組みではありません。DANDORIはOSレベルのサンドボックスではなく、実際の強制制御は対応するツール、Hook、ホストの権限設定、Workspace Trust、diff確認などにも依存します。

DANDORI はWorkerの逸脱を完全に不可能にすると主張しません。契約を狭め、発見と作用を分離し、Workerが報告した操作を監査し、包含関係を確認できない場合に停止します。

## 対象外

DANDORI は次のものではありません。

- 人間が承認した能力・対象境界を持たずに動く無制限の自律coding agent
- GitHub Copilotや人間レビューの代替
- OSレベルのセキュリティサンドボックス
- 永続状態を持つworkflow engine
- CI/CD runner
- agent marketplace
- Worker capability manifestの標準
- Worker側へDANDORI固有実装を要求するframework
- Workerの自己委譲やscope拡張を推奨するframework
- GitHubまたはMicrosoftの公式プロダクト

## License

MIT. 詳細は [LICENSE](./LICENSE) を参照してください。

## ビルド済みの Local / Copilot 配布物

GitHub の「Download ZIP」には `packages/local/` と `packages/copilot/` が含まれます。いずれも 6 つの Agent、code-review Skill、CommandRunner の実行スクリプトを収録しています。利用する Session Target に合う **片方だけ**を選択し、同名 Agent の重複を避けて配置してください。

- `agents/` と `skills/` は対応する VS Code のユーザープロファイルまたはワークスペースで有効な Agent / Skill ディレクトリへ配置します。
- `command-runner/` は `~/.copilot/command-runner/` に配置します。Copilot 版のResearcher・Writerは `preToolUse` フックを利用するため、対象環境でフックが実行されることを **先に確認**してください。フックが使えない環境では Researcher・Writerに実行権限を与えないでください。
- 配布物の検証には `python scripts/build_agent_profiles.py --check`、再生成には `--write` を使います。変更時は両方の配布物をコミットしてください。

Copilot 用のサブエージェント呼び出し・モデル選択・ツール・フックは Local と同一仕様ではありません。Copilot 版では未確認のモデル ID を固定せず、実行時の選択モデルを継承します。ホストによる Worker 許可リストの強制は Local のみに依存するため、Copilot ではリポジトリでの権限管理も必要です。
