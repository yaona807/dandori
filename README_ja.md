# DANDORI（段取り）

VS Code の GitHub Copilot Custom Agents による、承認範囲内の自律作業と独立検証。

**人間が目的・権限を一度承認し、Executorが調査から自己修正まで完遂し、Reviewerが独立検証する。**

## Agent構成

| Agent | 担当 |
| --- | --- |
| Orchestrator | TFR/TFC承認、Contract、委譲、並列競合、監査、完了判定 |
| Executor | 調査、設計、コード変更、登録済みチェック、自己修正、承認済みUI/GitHub操作 |
| Reviewer | 独立コードレビュー、必要時だけ登録済みのソース非変更テスト。編集・リモート書込みはしない |

関連する調査・修正・テストは原則1つのExecutorへまとめて委譲します。独立した調査なら複数Executorの並列実行が可能です。競合する編集は直列化します。

## 承認と委譲

最初のTask Flow Review（TFR）で、Goal・完了条件・Capability・リソース境界・累積Effect・除外・検証を提示し、人間が明示承認します。承認トークンに添付ファイルがあっても、添付物はデータであって追加権限ではありません。

権限の拡張だけTask Flow Change（TFC）で差分承認します。認可の正本には、既存の追記型Authorization Patch/foldとContract Revisionを保持します。

Executorの委譲内容は目的・対象範囲・承認済みCapabilityの部分集合・成果物です。個別ファイルや操作IDを先に列挙せず、範囲内で新たな関連ファイルを見つけても司令塔へ戻りません。Workerの報告は権限を追加できません。

## 検証と安全境界

既存CommandRunner・Host承認・Hookはそのまま利用します。すべての編集ツールが契約を機械的に強制するサンドボックスとは主張しません。GitHubへの書き込みには、明示された外部権限と個別Host承認の両方が必要です。ブラウザは人間が共有したタブだけを操作します。

Reviewerは必要時にCommandRunnerで登録済みの読み取り系コマンドやソース非変更テストを実行できます。テスト用の有界な一時出力は承認範囲内で許可します。ソースを変更するテスト・フォーマッタはExecutorが担当します。

重複調査、同一状態での無益な再実行を避け、結果不明の外部副作用は実際の状態を確認してから判断します。

## インストール・検証

1. [CommandRunner](.copilot/skills/command-runner/references/README_ja.md)をユーザーレベルにインストールしAgent-scoped Hooksを有効化。
2. packages/copilot/agents と packages/copilot/skills の生成成果物をCopilotの探索場所へコピー。
3. 旧Researcher.agent.md・Writer.agent.mdを削除し、Orchestrator・Executor・Reviewerだけを認識させる。
4. Orchestratorの直接Workerツール使用拒否、各GitHub書込みのHost承認、Reviewerのターミナル実行を実機確認する。

~~~sh
python scripts/build_agent_profiles.py --check
python scripts/validate_definitions.py
python scripts/run_tests.py
git archive --format=zip --output=dandori-release.zip HEAD
python scripts/validate_release_archive.py dandori-release.zip
~~~

[実機適合性テスト](tests/conformance.md)。静的CIはCopilot上の動作保証ではありません。Copilotの委譲先ツールが不可視となる暫定不具合に対して、司令塔のWorkerツール列挙＋直接実行ガードを当面維持します。恒久的な認可サーバーやクロスセッションDBは追加しません。
