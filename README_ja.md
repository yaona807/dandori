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

ユーザーが承認した作業契約を、最小限の境界付き Task Card へ変換します。Orchestrator は、承認済みのGoal・Completion Criterion・Operation・上限・除外・検証要件を変えない限り、内部の実行計画を適応的に変更できます。一方、各 Worker の実行は、毎回発行される狭い Task Card の対象・Action・Effectを結び付けたOperation権限によって制限されます。

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

- **ユーザーが承認する契約**: 変更しないGoal、Completion Criterion、対象・Action・Effectを結び付けたOperation、自動追加上限、除外、検証要件
- **内部で適応する計画**: Worker選択、実行順、Task Cardの統合・分割、境界内調査、再試行、検証

契約を広げる場合だけユーザーへ再承認を求め、契約内の内部計画変更では再承認しません。

## Bounded Adaptive Orchestration

DANDORI は、次の包含関係を中心に設計されています。

```text
Worker execution operation ⊆ exact Task Card operation ⊆ exact contract permission or authorized instantiation of a contract rule

active approved contract = ordered fold(authorization source sequence)
```

**Task Flow Review（TFR）** は、ユーザーが短時間で判断するための承認画面です。詳細な実行計画ではありません。

**Task Card** は、1回のWorker呼び出しに対する、Worker非依存の実行契約です。具体的な目的、Criterion参照、許可された対象・Action・EffectのOperation、呼び出し上限、期待する進捗、中断条件を定義します。

Orchestrator は、契約内であればWorkerの変更、実行順の変更、Task Cardの統合・分割、境界内の調査、再試行、検証追加を再承認なしで行えます。承認契約そのものを広げる場合だけ、**Task Flow Change（TFC）** を提示します。

## 主な特徴

- **短い承認画面**: ユーザーが確認するのは、Goal、Completion Criterion、完全な対象・Action・Effect Operation、自動追加上限、検証要件、除外、再承認条件だけ
- **Revision付き契約**: Task CardとWorker結果を、順序付き・追記専用の正規化Authorization Patchをfoldして再構築した1つの有効な契約Revisionへ結び付ける
- **適応的な内部計画**: 契約を広げない限り、Worker・順序・Task Card構成を変更できる
- **権限境界単位のTask Card**: 工程ごとに細分化せず、同じ対象・効果・検証境界の作業をまとめる
- **発見と作用の分離**: Workerが発見した対象を、同じ呼び出し内で変更させない
- **原子的な作用対象**: ディレクトリや「関連ファイル一式」ではなく、個別識別できる対象だけを自動認可する
- **Operation単位の認可**: 調査境界または正確な作用対象／境界付き認可ルール、Action、そのActionが生み得るすべてのEffectを1つの権限として結び付け、別々の一覧から直積権限を作らない
- **Worker非依存**: Worker定義をWorker挙動と出力形式の唯一の情報源とする
- **契約監査**: Workerが報告したOperation、上限、根拠、期待する進捗、Revisionを確認してからCriterionの進行を認める
- **別コンテキスト検証**: 永続的な変更は、可能な場合に観察と明示認可された非変更チェックだけを行う別呼び出しで確認する
- **差分承認**: 拡張を含むRevisionでは、同時に行う縮小も含めたContract Patch全体を提示する
- **進捗ベースのループ制御**: 新しい根拠、成果物、認可対象、検証結果などが生まれない同等呼び出しを禁止する

## 既存Workerを使い回せる

Orchestrator は、固定のWorker能力表、Worker別ルーティング表、Worker指示の複製を持ちません。

実行時に、runtime上で見える許可Agentの名前とdescriptionから候補を選び、自己完結した境界付きTask Cardを1件渡します。Worker定義ファイルの事前読み取りには依存せず、Worker固有の入力キー、ラッパー、スキーマ、入力言語要件も採用しません。役割、Tool、入力要件の不一致が返された場合はblockedとして扱い、承認範囲を広げずに別候補を最大1件だけ試します。

そのため、次の運用が可能です。

- 同梱Workerから始める
- 既存のCustom Agentを再利用する
- Orchestratorの制御ロジックを変えずにWorkerを交換する
- 必要に応じて許可Agent一覧へ専用Workerを追加する

Worker側へDANDORI固有の実装詳細を持たせる必要はありません。Worker定義は、Task Cardのキー、入力ラッパー、呼び出し元固有のスキーマ、DANDORI固有の出力エンベロープを規定してはいけません。

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
Flow Ledger: Completion Criterion、正確なOperation Instance、対象上限の使用状況、重要な根拠
   ↓
1つの権限境界に対する最小Task Card
   ↓
選択されたWorker
   ↓
結果の正規化と契約監査
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
- 必要な変更が認可Operation内で実施されている
- 実施できた検証結果または未検証理由が報告されている

**認可するOperation**
- 調査: 対象リポジトリ — 検索および読み取り (`observe`)
- 作用: 明示された既存ファイル — 内容の変更 (`change_local`)
- ルールによる作用: 根拠を確認できた原子的な既存ファイル — 内容の変更 (`change_local`)

**自動追加対象**
- Flow全体の累計上限: 5件

**検証要件**
- 永続的な変更は別コンテキストで確認する

**再承認**
別のGoalには新しいTFRが必要です。
Criterion、Operation、上限の拡張、除外の削除、検証の弱化にはTFCが必要です。
```

承認は完全一致で判定し、表示言語に関係なく共通の英語トークンを使用します。

```text
APPROVE:TFR-ab12
```

条件、修正、追加指示が含まれている場合は、承認ではなく変更要求として扱います。同じチャットセッション内では、TFR/TFCのIDと承認トークンを再利用しません。

各認可Operationには、そのActionが生み得る累積Effectをすべて表示します。ルールによる作用が複数あっても、自動追加上限はFlow全体で共有し、各ルール行ではなく独立した項目として表示します。

途中で契約を広げる必要が生じた場合は、差分だけを表示します。

```markdown
## Task Flow Change: TFC-cd34

**理由**
現在の自動追加上限を超える対象が必要になった

**Contract patch**
- Set: 自動追加対象の上限: 5件 → 7件

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

認可はOperation単位で行います。各権限は、1つの調査境界、正確な作用対象、または境界付き認可ルールを、1つのActionとそのActionが生み得るすべてのEffectへ結び付けます。別の対象・Action・Effect一覧は認可を付与しません。

## 対象の認可

調査境界と作用対象は分離します。

リポジトリ、ディレクトリ、ドメイン、検索クエリ、ワイルドカードは、調査可能範囲にはできますが、1件の自動認可対象にはできません。作用できるのは、ファイル、文書、レコード、Issue、Pull Request、コメント、APIリソース、設定項目など、安定した識別子で個別指定できる**原子的な対象**だけです。

発見された対象は単体では認可せず、対象・Action・Effectを結び付けたCandidate Operationとして管理します。再承認なしで正確なOperation Instanceへ昇格できるのは、正確な識別子、承認境界内であること、Completion Criterionとの対応、具体的な根拠位置、元のPermission、リスク、自動追加上限を確認できる場合だけです。候補を新しい探索起点にはせず、発見した呼び出し内では作用させません。

既存ディレクトリとディレクトリ配下全体は、原子的な作用対象ではありません。存在しないことを確認した正確なディレクトリパスだけは、そのパス、`create_directory`、`change_local`を結び付けたOperationとして認可できます。必要な各親ディレクトリと各子成果物は別Operationとし、ディレクトリ作成から未指定の子要素や既存subtreeへの権限を導出しません。

有効な契約は、追記専用のAuthorization Source Sequenceに含まれる正規化Patchを順番にfoldして再構築するmaterialized viewです。最初の承認済みTFRが契約を初期化し、承認済みTFCはRevision全体のPatchを適用し、明示的な縮小は構造的な削減だけを記録します。自由記述の原文は監査用であり、実行可能な権限の正本にはせず、削除した権限を暗黙に復元しません。

表示だけの文言修正やローカライズをRevision不要で行えるのは、正規化されたAuthorization Source Sequenceと実行可能な契約項目がすべてbyte単位で変化しない場合だけです。Criterion、Operation、Effect、上限、検証要件、除外、安定ID、Source順序の変更は構造変更として扱い、対応するRevision経路を使用します。

自動追加上限は、すでに消費した一意な対象数以上の値にだけ縮小できます。対象の一意性と上限消費は、namespaceまたは包含resourceを含む各原子的対象のcanonical typed identityで判定します。PermissionやCriterionを削除しても、消費済み件数は取り消しません。

## 検証とループ制御

永続的なローカル変更、外部作用、破壊的作用は、可能な場合に別の検証呼び出しで確認します。検証Task Cardでは、観察に加えて、明示的に認可された非変更のチェックだけを実行できます。重要なWorker主張が競合した場合も同じ狭い検証Policyを適用し、信頼度ではなく、観察または明示認可された非変更チェックで正確な矛盾を解消します。実行時は書き込み、更新、fixを行わないモードを使用し、ソース、snapshot、lockfile、cache、reportなどの永続的な成果物を書き得るコマンドは、書き込みを無効化できない限り実行しません。検証呼び出しで修正、ローカル変更、外部変更、破壊的操作は行いません。これは**別コンテキスト検証**であり、完全に独立した第三者レビューを保証するものではありません。

検証手段がない場合は、再承認ループへ入れたり、確認済みと断定したりせず、「未検証」として報告します。

また、各Worker呼び出しには、次のいずれかの具体的な進捗が必要です。

- 新しい重要事実
- 新しい成果物
- 新しいCandidate Operation
- 成果条件の状態変化
- 検証結果
- 矛盾の解消
- より具体化された停止理由

同等のTask Cardを、進捗なしに繰り返すことは禁止します。各実行前に、Task Card内のCriterion IDとSource Permission IDからすべての`<criterion_id>|<source_permission_id>`ペアを作成します。そのため、`execute`を含むTask Cardは少なくとも1件の有効なCriterionを参照しなければならず、契約全体の競合またはblockerでCriterionを省略できるのは観察だけの場合に限ります。各ペアは最大2回まで数え、Worker、順序、グルーピング、Task Card IDを変えても上限はリセットされません。

認可状態または累積ループ制御状態を正確に復元できない場合は、`state_unrecoverable` で停止します。承認済み調査境界内で再取得できる根拠は再観測できますが、失われた権限状態、cap使用数、試行回数、pending resultとRevisionの対応を推測またはリセットしません。

## 含まれるもの

```text
.copilot/
  agents/
    Orchestrator.agent.md
    Researcher.agent.md
    PullRequestResearcher.agent.md
    Writer.agent.md
    Reviewer.agent.md
    BrowserQA.agent.md
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
| Reference workers | 調査、Pull Request確認、実装、レビュー、ブラウザ確認用の任意Worker |
| `code-review` skill | Reference Reviewerが使用するfocused review guidance |

## 互換性と前提条件

- DANDORI Agentは明示的にVS Codeを対象とします。
- Subagent制限には、現在Experimentalである`agents` allowlistを使用します。
- `PullRequestResearcher`にはGitHub Pull Requests拡張機能と、その拡張機能が公開するToolが必要です。
- `BrowserQA`には設定済みのbrowser Tool群が必要です。
- 利用できない、または認識されないTool名はruntimeに無視される場合があるため、実際のTool可用性を確認してください。
- 同梱Workerは、Toolの引数とruntime挙動で委譲境界を強制できる場合だけ、そのToolを呼び出します。利用可能なToolがより広い範囲でしか動作できない場合は、実行せず`blocked`を返し、必要な狭いcapabilityを示します。
- 同梱Reference Workerにはterminal command実行用Workerを含めていません。test、lint、型検査、build、formatterなどのcommand実行が必要な場合は、許可commandと作用範囲を限定した専用Workerを追加してください。
- 外部Workerは、自己完結した依頼を処理し、再委譲せず、必要以上のToolを持たず、役割と作用範囲をdescriptionへ正確に記載する必要があります。
- VS Code Chat Diagnosticsで、すべてのAgentとSkillの読み込み元を確認してください。

## 推奨モデル

DANDORI は、Orchestratorへ推論能力の高いモデルを使用することを推奨します。

Orchestrator は、実行方法の曖昧さと権限の曖昧さを区別し、契約を広げずに正規化し、最小Task Cardを作り、Worker結果を監査し、矛盾を処理し、包含関係を確認できない場合に停止する必要があります。

Workerは、委譲する作業に応じて、小型・高速・専門モデルを選択できます。

## インストール

VS Code上のGitHub Copilot Custom Agentsが対応する探索パスへ、AgentとSkillをコピーしてください。

### ユーザーレベル配置

複数workspaceで同じDANDORI設定を使う場合：

```bash
mkdir -p ~/.copilot/agents ~/.copilot/skills
cp .copilot/agents/*.agent.md ~/.copilot/agents/
cp -R .copilot/skills/* ~/.copilot/skills/
```

### 標準workspace配置

1つのリポジトリと一緒に設定を管理する場合は、VS Codeの標準探索パスを使用します。

```bash
mkdir -p .github/agents .github/skills
cp .copilot/agents/*.agent.md .github/agents/
cp -R .copilot/skills/* .github/skills/
```

### `.copilot`をworkspace内で使う場合

workspace内の `.copilot/agents` と `.copilot/skills` を使うには、`chat.agentFilesLocations` と `chat.agentSkillsLocations` で追加探索先として有効にする必要があります。設定を行わずに `.copilot` をコピーするだけで認識されるとは限りません。


### 既存インストールの更新

既存配置へ新しい版を上書きするだけでは、新版で削除・改名されたファイルが残ります。更新前にDANDORIが管理するファイルだけを削除し、その後で新版をコピーしてください。独自Workerや無関係なSkillは削除しないでください。

ユーザーレベル配置の削除対象：

```bash
rm -f ~/.copilot/agents/{Orchestrator,Researcher,PullRequestResearcher,Writer,Reviewer,BrowserQA}.agent.md
rm -rf ~/.copilot/skills/code-review
```

標準workspace配置の削除対象：

```bash
rm -f .github/agents/{Orchestrator,Researcher,PullRequestResearcher,Writer,Reviewer,BrowserQA}.agent.md
rm -rf .github/skills/code-review
```

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
5. Goal、Completion Criterion、認可Operation、自動追加上限、除外、検証要件が正しい場合だけ、承認用の1行をそのまま返信する
6. 後から契約を広げる必要が出た場合は、差分だけを確認する

## 定義の検証

Pull Requestを作成する前に、決定論的なvalidatorを実行できます。

```bash
python -m pip install PyYAML==6.0.3
python scripts/validate_definitions.py
python -m unittest discover -s tests -p "test_*.py"
```

配布ZIPはworking tree全体を圧縮せず、追跡済みファイルから生成し、実際の成果物も検証します。

```bash
git archive --format=zip --output=dandori.zip HEAD
python scripts/validate_release_archive.py dandori.zip
```

配布ZIPのValidatorは、path traversal、symlink、生成物、重複または移植性上衝突する名前、想定外のtop-level entry、必須ファイル欠落、展開後の定義検証失敗を拒否します。

GitHub Actionsでは、すべてのPull Requestと`master`へのpush時に、決定論的な定義検証、Mutation Test、配布ZIP検証を実行します。Validatorは必須Trigger、無条件の`jobs.validate` Job、その配下の正確なfail-closed検証StepをYAML構造として検査し、別Jobへの移動、`if`、`needs`、`continue-on-error`、path filterによる迂回を認めません。Step ActionとReusable Workflowの`uses`もYAMLから解析し、外部参照は完全長commit SHAに限定します。CIではPython bytecode生成を無効化し、Validatorはtagやbranchを参照する`uses`、repository symlink、Python向けignore規則の欠落、追跡済み生成物を拒否します。Validatorは同梱定義をclosed release inventoryとして扱い、Agentディレクトリでは`*.agent.md`以外を拒否し、`hooks`、`handoffs`、`mcp-servers`などTool境界を迂回し得るfrontmatterを禁止します。同梱Agentのfrontmatter、Tool、ファイル名、必須Section、安全Policy anchor、十分な圧縮余地を持つ本文回帰下限を固定し、Orchestratorの中核Invariantが意図したSection内に残っていることを検査します。同梱`code-review` Skillは宣言済みMarkdownだけを許可し、すべてのSkill Markdownに対して、大文字小文字や空白・ハイフン・アンダースコアの表記揺れを正規化したDANDORI固有依存と、Reviewerに属するWorker Policyの再流入を検査します。追加のローカルWorkerは`*.agent.md`として追加できますが、共通runtime、再委譲禁止、禁止frontmatter、DANDORI固有依存の検査対象となり、手動Policy／Diagnostics確認を要求するwarningを出します。リポジトリ外の外部Workerも定義を静的検査できないため、引き続きDiagnostics確認を要求するwarningとします。必須Mutation Testは、実際のrepository変異とValidator失敗Assertionを保持する必要があり、共通helperの空実装化も検出します。各Conformance Caseは、空でないInputと少なくとも1件の具体的なExpected bulletを保持しなければなりません。静的ファイルからLLM挙動は推定せず、モデル、Worker Tool、VS Code更新時は`tests/conformance.md`の構造化Caseと実行記録templateを使用します。

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

DANDORI は委譲範囲を狭め、逸脱の検出と停止を容易にしますが、OSレベルのサンドボックスではありません。tool制限、Workspace Trust、承認設定、diff確認など、プラットフォーム側の制御も引き続き重要です。

DANDORI はWorkerの逸脱を完全に不可能にすると主張しません。契約を狭め、発見と作用を分離し、Workerが報告した操作を監査し、包含関係を確認できない場合に停止します。

## 対象外

DANDORI は次のものではありません。

- 汎用的な自律coding agent
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
