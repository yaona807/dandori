<p align="center">
  <img src="./assets/dandori-logo.png" alt="DANDORI logo" width="160">
</p>

<h1 align="center">DANDORI</h1>

<p align="center">
  <strong>今使っているエージェントに、Task Card駆動の司令塔レイヤーを追加する。</strong>
</p>

<p align="center">
  AIエージェントに、暴走した作業ではなく、承認済みの作業へトークンを使わせる。
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

DANDORI は、GitHub Copilot Custom Agents 向けの Orchestrator レイヤーです。

承認済みの作業を境界付き Task Card へ変換し、エージェントに狭く、意図的に、差し替え可能な形で実行させます。

DANDORI の中核は **Orchestrator** です。同梱している Worker は reference implementation です。そのまま使うことも、自分の既存エージェントに置き換えることも、必要に応じて専用 Worker を追加することもできます。

> DANDORI は独立したオープンソースプロジェクトです。GitHub または Microsoft と提携、承認、保守されているものではありません。

## なぜDANDORIか

AI coding agent は強力ですが、作業が曖昧だと次のような失敗が起きやすくなります。

- 不要な repository 調査
- 繰り返しの tool 実行
- 推測による編集
- 広すぎる調査
- 実行中の scope 拡張
- 委譲履歴の不透明化

トークン効率化は、プロンプトを短くすることだけではありません。Agentic workflow では、無駄な作業がそのまま無駄なトークン消費になります。

DANDORI は、Orchestrator が承認済みの作業範囲を定義し、境界付き Task Card を作成し、1つずつ Worker へ委譲し、結果を確認してから次へ進むことで、この無駄を抑えるように設計されています。

## Task Card-driven orchestration

DANDORI は、次の単純なルールを中心に設計されています。

```text
Worker は、境界付き Task Card なしに作業しない。
```

Task Card は、Orchestrator と Worker の間の圧縮された実行契約です。Worker が実施すること、実施しないこと、期待される出力、完了条件、中断して Orchestrator へ戻す条件を定義します。

DANDORI では、ユーザーが Task Flow Review を承認します。Orchestrator は、その承認済み範囲から内部 Task Card を作成します。

中心となる不変条件は次です。

```text
Internal Task Card ⊆ approved Task Flow Review step
```

Worker は、好み、関連性、都合、確信度、一般的なベストプラクティスを理由にタスクを拡張してはいけません。

## 主な特徴

- **Task Card-driven orchestration**: Worker は曖昧な依頼ではなく、境界付き Task Card を実行する
- **トークン効率を重視**: 無駄なエージェント作業を減らすことで、不要なトークン消費を抑えるように設計されている
- **Orchestrator-first control**: 計画、委譲、レビュー、統合を Orchestrator が担う
- **承認済み範囲での実行**: Worker はユーザーが承認した作業範囲内で動く
- **既存 Worker を使い回せる**: 既存エージェントを利用し、必要な Worker だけ追加できる
- **疎結合な Worker 設計**: Orchestrator は Worker の内部詳細ではなく、委譲契約に依存する
- **続行前レビュー**: 次の作業へ進む前に Worker の結果を確認する
- **Orchestrator には強めのモデルを推奨**: Orchestrator には推論能力の高いモデルを使い、Worker はタスクごとに切り分けられる
- **最小 runtime 構成**: runtime は agent 定義と focused code-review skill に限定する

## 既存Workerを使い回せる

DANDORI の中核は Orchestrator です。

DANDORI では、Orchestrator を Worker の内部詳細から疎結合に保ちます。Orchestrator は、各 Worker の実装詳細を抱え込む必要がありません。依存するのは、境界付き Task Card を受け取り、その範囲内で作業し、結果を返す、という単純な委譲契約だけです。

同梱の reference worker を使うことも、自分の既存エージェントに置き換えることも、必要に応じて新しい専門 Worker を追加することもできます。

そのため、DANDORI は段階的に導入できます。まず Orchestrator だけを導入し、既存エージェントを使い回し、必要になったところだけ Worker を追加・交換できます。

## 推奨モデル

DANDORI は、特に Orchestrator に一定以上の推論能力を持つモデルを使うことで効果を発揮しやすくなります。

Orchestrator は、計画、スコープ制御、委譲、レビュー、統合を担います。弱いモデルでも単純な作業を扱える場合はありますが、不足情報の確認漏れ、曖昧な Task Card 生成、過剰な委譲、Worker 結果の範囲外検出漏れが起きやすくなります。

すべての Worker に強いモデルを使う必要はありません。強いモデルを使うべきなのは主に Orchestrator です。Worker は、タスク内容に応じて軽量・高速・特化型のモデルへ切り分ける運用が向いています。

## 仕組み

```text
ユーザー依頼
   ↓
Orchestrator
   ↓
Task Flow Review
   ↓
境界付き Task Card
   ↓
Specialized Worker
   ↓
Orchestrator Review
   ↓
最終回答
```

Orchestrator は control plane を担い、Worker は狭い実作業を担います。

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
      references/
        correctness.md
        maintainability.md
        testability.md
        security.md
        performance.md
assets/
  dandori-logo.svg
  dandori-logo.png
```

| Component | 役割 |
| --- | --- |
| `Orchestrator` | 中核となる control-plane agent。計画、承認要求、Task Card 生成、委譲、監査、最終統合を行う。 |
| Reference workers | 調査、PR 調査、実装、レビュー、browser QA 向けの最小 Worker。 |
| `code-review` skill | Reviewer worker が利用する focused review guidance。 |

Reference Worker は出発点です。Orchestrator からの境界付き委譲に従えるなら、自分の既存エージェントへ置き換えられます。

## インストール

GitHub Copilot 環境がサポートする探索パスに agents と skills をコピーしてください。

User-level installation の例です。

```bash
mkdir -p ~/.copilot/agents ~/.copilot/skills
cp .copilot/agents/*.agent.md ~/.copilot/agents/
cp -R .copilot/skills/* ~/.copilot/skills/
```

Workspace-level installation の例です。

```bash
cp -R .copilot /path/to/your/repository/
```

同じ agent definition の active copy を複数箇所に残さないでください。重複があると、Orchestrator が監査した定義と、実際に Copilot が呼び出す定義がズレる可能性があります。

## 使い方

1. Copilot Chat を開く。
2. `Orchestrator` agent を選択する。
3. タスクを依頼する。
4. 提示された Task Flow Review を確認する。
5. flow、境界、stop condition が正しい場合だけ承認する。

承認が必要な場合、Orchestrator は次のような正確な承認行を求めます。

```text
承認:TFR-xxxx
```

承認は、表示された Task Flow Review にのみ有効です。条件、修正、追加指示を含めた場合、そのメッセージは承認ではなく変更要求として扱われます。

## 設計原則

- **実行前に計画する**: Worker が動く前に Orchestrator が作業を定義する
- **曖昧な委譲ではなく Task Card**: Worker には明示的な実行契約を渡す
- **承認済み範囲のみ**: Worker は承認済みの作業範囲内で作業する
- **1回に1つの境界付き作業**: 委譲を狭く保ち、監査しやすくする
- **続行前にレビューする**: Orchestrator が Worker の出力を確認してから次へ進む
- **疎結合**: Orchestrator は Worker の内部詳細ではなく、委譲契約に依存する
- **小さく差し替え可能な Worker**: Worker は reference implementation であり、中核価値は Orchestrator にある

## 対象外

DANDORI は以下を目的としていません。

- 汎用の自律 coding agent
- GitHub Copilot の代替
- 人間によるレビューの代替
- 永続状態を持つ workflow engine
- CI/CD runner
- agent marketplace
- 1つの agent に何でもやらせるための prompt collection
- Worker が自己判断で委譲・scope 拡張するための framework
- GitHub または Microsoft の公式プロダクト

## License

MIT. [LICENSE](./LICENSE) を参照してください。
