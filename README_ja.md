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

DANDORI は、GitHub Copilot Custom Agents 向けの Orchestrator レイヤーです。

ユーザーが承認した作業契約を、最小限の境界付き Task Card へ変換します。Orchestrator は、承認済みの目的・境界・効果・検証水準を変えない限り、内部の実行計画を適応的に変更できます。一方、各 Worker の実行は、毎回発行される狭い Task Card によって制限されます。

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

- **ユーザーが承認する契約**: 目的、成果、境界、許可効果、自動追加上限、検証水準
- **内部で適応する計画**: Worker選択、実行順、Task Cardの統合・分割、境界内調査、再試行、検証

契約を広げる場合だけユーザーへ再承認を求め、契約内の内部計画変更では再承認しません。

## Bounded Adaptive Orchestration

DANDORI は、次の包含関係を中心に設計されています。

```text
Worker execution ⊆ Task Card ⊆ active approved contract ⊆ approved TFR/TFC chain
```

**Task Flow Review（TFR）** は、ユーザーが短時間で判断するための承認画面です。詳細な実行計画ではありません。

**Task Card** は、1回のWorker呼び出しに対する、Worker非依存の実行契約です。具体的な目的、許可された対象、効果、上限、完了条件、中断条件を定義します。

Orchestrator は、契約内であればWorkerの変更、実行順の変更、Task Cardの統合・分割、境界内の調査、再試行、検証追加を再承認なしで行えます。承認契約そのものを広げる場合だけ、**Task Flow Change（TFC）** を提示します。

## 主な特徴

- **短い承認画面**: ユーザーが確認するのは、目的、成果、境界、効果、自動追加上限、検証、再承認条件だけ
- **Revision付き契約**: Task CardとWorker結果を、1つの有効な承認契約Revisionへ結び付ける
- **適応的な内部計画**: 契約を広げない限り、Worker・順序・Task Card構成を変更できる
- **権限境界単位のTask Card**: 工程ごとに細分化せず、同じ対象・効果・検証境界の作業をまとめる
- **発見と作用の分離**: Workerが発見した対象を、同じ呼び出し内で変更させない
- **原子的な作用対象**: ディレクトリや「関連ファイル一式」ではなく、個別識別できる対象だけを自動認可する
- **累積効果による制御**: 操作が発生させ得る副作用をすべて明示する
- **Worker非依存**: Worker定義をWorker挙動と出力形式の唯一の情報源とする
- **契約監査**: Workerが報告した対象、効果、上限、根拠、Revisionを確認してから進行する
- **別コンテキスト検証**: 永続的な変更は、可能な場合に観察専用の別呼び出しで確認する
- **差分承認**: 再承認時は変更点だけを提示する
- **進捗ベースのループ制御**: 新しい根拠、成果物、認可対象、検証結果などが生まれない同等呼び出しを禁止する

## 既存Workerを使い回せる

Orchestrator は、固定のWorker能力表、Worker別ルーティング表、Worker指示の複製を持ちません。

実行時に、許可されたAgentから候補を選び、選択したWorkerの有効な定義だけを確認します。明示的な不適合がないかを確認し、そのWorker定義がTask Cardへ明示的に要求する項目だけを追加します。Worker選択は実行品質には影響しますが、承認範囲を広げる根拠にはなりません。

そのため、次の運用が可能です。

- 同梱Workerから始める
- 既存のCustom Agentを再利用する
- Orchestratorの制御ロジックを変えずにWorkerを交換する
- 必要に応じて許可Agent一覧へ専用Workerを追加する

Worker側へDANDORI固有の実装詳細を持たせる必要はありません。

## 仕組み

```text
ユーザー要求
   ↓
短いTask Flow Review
   ↓ 完全一致承認
Approved Contract revision
   ↓
Flow Ledger: 成果条件、認可対象、上限、重要な根拠
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

**成果**
原因の説明、必要な変更、実施できた検証結果

**作業境界**
- 調査: 対象リポジトリ内
- 作用: 明示対象と、根拠を確認できた原子的な既存対象
- 自動追加: ローカル変更対象を最大5件

**許可する効果**
- observe
- change_local

**検証**
- 永続的な変更は別コンテキストで確認する

**再承認**
目的、成果、境界、許可効果、自動追加上限、検証水準を広げる場合のみ
```

承認は完全一致で判定し、表示言語に関係なく共通の英語トークンを使用します。

```text
APPROVE:TFR-ab12
```

条件、修正、追加指示が含まれている場合は、承認ではなく変更要求として扱います。

途中で契約を広げる必要が生じた場合は、差分だけを表示します。

```markdown
## Task Flow Change: TFC-cd34

**理由**
現在の自動追加上限を超える対象が必要になった

**変更**
自動追加上限: 5件 → 7件

**変更しないもの**
目的、成果、許可効果、検証水準
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

Task Cardの制御フィールドは英語固定です。目的や完了条件などの自由記述は、選択したWorkerが別言語を明示的に要求しない限り、対話言語を使用します。Worker結果は最終統合時に対話言語へ変換しますが、コード、パス、識別子、literal、引用した根拠は翻訳しません。

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

## 対象の認可

調査境界と作用対象は分離します。

リポジトリ、ディレクトリ、ドメイン、検索クエリ、ワイルドカードは、調査可能範囲にはできますが、1件の自動認可対象にはできません。作用できるのは、ファイル、文書、レコード、Issue、Pull Request、コメント、APIリソース、設定項目など、安定した識別子で個別指定できる**原子的な対象**だけです。

発見された対象は、次の状態で管理します。

```text
explicit → authorized
candidate → authorized または rejected
```

候補を再承認なしで認可できるのは、正確な識別子、承認境界内であること、成果条件との対応、具体的な根拠位置、必要効果、リスク、自動追加上限を確認できる場合だけです。候補を新しい探索起点にはせず、発見した呼び出し内では作用させません。

## 検証とループ制御

永続的なローカル変更、外部作用、破壊的作用は、可能な場合に観察専用の別呼び出しで確認します。これは**別コンテキスト検証**であり、完全に独立した第三者レビューを保証するものではありません。

検証手段がない場合は、再承認ループへ入れたり、確認済みと断定したりせず、「未検証」として報告します。

また、各Worker呼び出しには、次のいずれかの具体的な進捗が必要です。

- 新しい重要事実
- 新しい成果物
- 新しい認可対象
- 成果条件の状態変化
- 検証結果
- 矛盾の解消
- より具体化された停止理由

同等のTask Cardを、進捗なしに繰り返すことは禁止します。

## 含まれるもの

```text
.copilot/
  agents/
    Orchestrator.agent.md
    Researcher.agent.md
    PullRequestResearcher.agent.md
    Writer.agent.md
    Reviewer.agent.md
    BrowserQa.agent.md
  skills/
    code-review/
      SKILL.md
assets/
  dandori-logo.png
```

| Component | 役割 |
| --- | --- |
| `Orchestrator` | 要求整理、短い承認、契約管理、Task Card作成、Worker選択、監査、ループ制御、最終統合を担当するcontrol-plane agent |
| Reference workers | 調査、Pull Request確認、実装、レビュー、ブラウザ確認用の任意Worker |
| `code-review` skill | Reference Reviewerが使用するfocused review guidance |

## 推奨モデル

DANDORI は、Orchestratorへ推論能力の高いモデルを使用することを推奨します。

Orchestrator は、実行方法の曖昧さと権限の曖昧さを区別し、契約を広げずに正規化し、最小Task Cardを作り、Worker結果を監査し、矛盾を処理し、包含関係を確認できない場合に停止する必要があります。

Workerは、委譲する作業に応じて、小型・高速・専門モデルを選択できます。

## インストール

GitHub Copilot環境が対応する探索パスへ、AgentとSkillをコピーしてください。

ユーザーレベルの例：

```bash
mkdir -p ~/.copilot/agents ~/.copilot/skills
cp .copilot/agents/*.agent.md ~/.copilot/agents/
cp -R .copilot/skills/* ~/.copilot/skills/
```

`.copilot`を探索する環境でのリポジトリレベルの例：

```bash
cp -R .copilot /path/to/your/repository/
```

同じAgent定義を複数の場所で有効にしないでください。重複定義があると、Orchestratorが確認した定義と、Copilotが実際に呼び出す定義が異なる可能性があります。

## 使い方

1. Copilot Chatを開く
2. `Orchestrator` Agentを選択する
3. 作業を依頼する
4. 短いTask Flow Reviewを確認する
5. 目的、成果、境界、効果、自動追加上限、検証水準が正しい場合だけ、承認用の1行をそのまま返信する
6. 後から契約を広げる必要が出た場合は、差分だけを確認する

## 設計原則

- **ユーザー承認は実行履歴ではなく契約である**
- **内部計画は適応できるが、承認済み権限は適応させない**
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
