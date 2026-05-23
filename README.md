# Rakushift AI - AIシフト管理システム

> 📚 **納品ドキュメント一覧は [docs/README.md](docs/README.md) を参照**
> 主要文書:
> - 🛡️ セキュリティ運用: [docs/SECURITY.md](docs/SECURITY.md)
> - 🚀 デプロイ手順: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
> - 📝 最新変更履歴: [docs/CHANGELOG_SECURITY.md](docs/CHANGELOG_SECURITY.md)
> - 🤝 引き継ぎ資料: [docs/引き継ぎ資料_完全版.md](docs/引き継ぎ資料_完全版.md)

## プロジェクト概要
Rakushift AI（ラクシフトAI）は、飲食店や小売店向けのシフト管理を効率化するWebアプリケーションです。
管理者は、従業員の希望休、店舗の営業ルール、必要な人員配置要件を設定するだけで、MILP数理最適化エンジン + AI（Google Gemini）が最適なシフト表を自動生成します。また、直感的なUIで手動調整も可能です。

## 主な機能

### 1. ダッシュボード
- **本日の状況**: 今日の出勤人数、シフト一覧、進行状況（勤務中/終了など）をリアルタイム表示
- **クイックアクション**: 申請確認、シフト表への移動など、頻繁に使う機能へワンクリックでアクセス
- **人件費分析（管理者のみ）**: 直近の人件費推移をグラフ表示

### 2. シフト管理（Shift Table & Calendar）
- **テーブルビュー (Gantt Chart)**: 
    - **日曜始まり**: 週次表示およびAI自動作成の「翌週」ロジックは、全て日曜日を起点として統一されています。
    - **高解像度ガントチャート**: 1週間表示時に15分単位のグリッドと目盛りを表示し、細かいシフト状況を一目で確認可能に改善
    - **見やすい表示**: 営業時間をハイライトし、シフトバーの視認性を向上
    - **期間切り替え**: 月間 / 1週間 / 1日 の3モードに対応 (旧 2週間モードは2026-05-23 廃止)
    - **年月ドロップダウン**: ヘッダで年・月を直接選択して任意の月へジャンプ
    - **1日モード詳細表**: 日毎ガント下にメモ付きシフト一覧テーブル (スタッフ・時間・休憩・メモ・編集ボタン)
    - **シフトメモ**: 各シフトに自由記述メモ (引継ぎ事項・特記事項、最大500字)
    - **過去シフトのグレーアウト**: すでに経過した日程のシフトはグレーアウトされ、視認性が向上しました。
- **カレンダービュー**: 月間カレンダー形式で表示。曜日ごとの配置確認に便利（スクロール対応）
    - **備考・メモ機能**: 日付ごとに「団体予約あり」「大型発注」などのメモを記録・表示できます。
- **AI自動作成**: 
    - 「来週分」や「今月分」を一括生成
    - **過去データの保護**: 分析レポートの整合性を保つため、「リセットして再構築」等の操作を行っても、**本日より前の日付（過去）のシフトは維持され、再生成されません**。
    - **厳格なルール遵守**: スタッフの希望休、勤務日数上限、特定の時間帯の必要人数（`time_staff_req`）を優先
    - **MILP最適化エンジン (PuLP)** + **Gemini監査** の二段構え
- **手動調整**: クリック＆ドラッグ感覚で直感的にシフトを追加・編集・削除

### 3. 店舗設定（Store Settings）
- **基本設定**: 営業時間、定休日
- **役職管理**: 店長、リーダー、スタッフなどの役割とカラー設定
- **シフトパターン**: 「早番」「遅番」などの定型パターン登録
- **人員配置ルール**: 
    - 曜日ごとの最低人数
    - **時間帯別増強**: 「ランチタイム（11:00-14:00）は必ず3人」といった詳細ルール設定
- **休憩ルール**: 勤務時間に応じた休憩時間（例: 6時間超で45分）の自動適用

### 4. スタッフ管理（Staff Management）
- **プロフィール**: 名前、役職、給与形態（時給/月給）
- **勤務制約**: 週の最大勤務日数、1日の最大勤務時間
- **除外日**: 絶対に出勤できない日の管理

### 5. 休暇・シフト申請（Requests）
- スタッフからの「希望休」「勤務希望」を管理
- 承認すると自動的にシフト表や除外日リストに反映

## 技術スタック
- **Frontend**: HTML5, CSS3, JavaScript (Vanilla ES6+)
- **Backend**: Python (FastAPI) + PuLP (数理最適化)
- **Hosting**: Cloudflare Pages (Frontend) + Railway (Backend / Docker)
- **Database**: Supabase (PostgreSQL + RLS)
- **決済**: Stripe (サブスクリプション)
- **AI**: Google Gemini API (シフト監査)
- **Charts**: Chart.js (CDN)
- **Icons**: Font Awesome (CDN)

## 最新のアップデート (2026-01-07)

### ✅ 二段階ログイン機能の実装（店舗共有→管理者認証）
- **第一段階：店舗ログイン**: 全スタッフが共有する「契約ID」と「店舗パスワード」でまずログインします。この状態ではシフト表の閲覧のみが可能です。
- **第二段階：管理者認証**: 画面内の「管理者ログイン」ボタンから、個人の管理者IDとパスワードを入力することで、シフト編集や設定などの管理者機能が有効になります。
- **セキュリティと利便性の両立**: 共用タブレット等での運用を想定し、普段は閲覧モードで置いておき、必要な時だけ店長がログインして操作するフローを実現しました。

### 🛠️ SaaS構成 (Production Architecture)

本システムは、マルチテナントSaaSとして設計されており、以下の構成で動作します。

```
Cloudflare Pages（GitHub自動デプロイ）
├── index.html          ... メインアプリ
├── admin.html          ... 運営管理画面
├── js/                 ... フロントエンドロジック
└── images/             ... 静的アセット

Railway（Python / FastAPI / Docker）
├── main.py             ... APIサーバー
├── scheduler.py        ... PuLP数理最適化エンジン
├── Dockerfile          ... コンテナ定義
└── requirements.txt    ... Python依存関係

Supabase（PostgreSQL + RLS）
├── staff, shifts, config, requests ... データテーブル
├── RPC関数              ... bcrypt認証・テナント管理
└── RLS                  ... 組織間データ分離

Stripe（サブスクリプション決済）
└── Webhook → Railway → Supabase 自動同期
```

1.  **フロントエンド (Cloudflare Pages)**: GitHubリポジトリから自動デプロイ。CDN経由で高速配信。
2.  **バックエンド (Railway)**: シフト最適化・Stripe決済・Gemini AI連携をDockerコンテナで実行。
3.  **データ永続化 (Supabase)**: `staff`, `shifts`, `config` などの全データをRLSで組織分離。
4.  **AI監査 (Gemini API)**: 計算結果をLLMがダブルチェックし、人間的な制約を調整。

### ✅ シフト自動生成エンジンの刷新
- **Python最適化エンジン**: サーバーサイドで厳密な数理最適化計算を実行。
- **Gemini監査**: 生成されたシフトをAIがレビューし、制約違反を修正する二段構えの構成。
- **4段階評価対応**: スタッフ評価をA〜Dの4段階に拡張し、Aランクのスタッフを優先的に割り当てるようにしました。
- **勤務制約の遵守**:
  - **社員（月給）**: 月間労働時間（約160〜177時間）を考慮し、週5日勤務をベースに優先配置します。
  - **アルバイト**: 各自の「週最大勤務日数」「1日の最大時間」設定を遵守し、希望休を避けて配置します。

### 🔑 デモアカウント情報
以下の情報でログインしてシステムをお試しいただけます。

#### 1. 店舗ログイン（全員共通）
| 項目 | 値 |
| :--- | :--- |
| **契約ID (Contract ID)** | `254995332101138` |
| **店舗パスワード** | `rakushift1234` |

#### 2. 管理者ログイン（機能編集用）
| 項目 | 値 |
| :--- | :--- |
| **管理者ID** | `admin` |
| **パスワード** | `rakushift1234` |

## 最新のアップデート (2025-12-19)

### ✅ 機能追加・改善
1.  **カレンダービューへの備考（メモ）機能追加**:
    - 日付ごとに「団体予約」や「大型発注」などのメモを追加できるようになりました。
    - カレンダーセル上に黄色い付箋スタイルで表示され、マウスオーバーで詳細を確認できます。
2.  **過去シフトの視覚的区別**:
    - シフト表およびカレンダービューにおいて、昨日以前（過去）のシフトや日付セルをグレーアウト表示にし、現在・未来のシフトと明確に区別できるようにしました。
    - ※あくまで見た目の変更のみで、分析データの数値には影響しません。

### ✅ 分析レポート保護のための機能変更
1.  **AI自動作成時の過去日保護**:
    - ユーザーからの要望に基づき、「AI自動作成」および「リセット」機能の挙動を変更しました。
    - 分析レポート（人件費・労働時間の実績）への影響を防ぐため、**本日（操作日）より前の日付のシフトデータは、いかなる場合も削除・再生成されません**。
    - 「リセットして再構築」を選択した場合でも、リセット（削除）およびAI生成の対象となるのは「本日以降」のシフトのみとなります。
2.  **週次計算の日曜日統一**:
    - 「来週のシフトを作成」等の自動生成ロジックにおいて、週の開始日を明確に「日曜日」に統一しました。

## デプロイ手順

### 1. Railway（バックエンド）
```bash
# GitHubリポジトリと連携し、pushで自動デプロイ
# Railway設定:
#   - Root Directory: / (ルート)
#   - Builder: Dockerfile (python/Dockerfile)
#   - railway.toml で設定済み
git push origin main
```

### 2. Cloudflare Pages（フロントエンド）
1. Cloudflareダッシュボード → Pages → 「GitHubに接続」
2. リポジトリを選択
3. ビルド設定:
   - **フレームワーク**: なし
   - **ビルドコマンド**: (空欄)
   - **出力ディレクトリ**: `/` (ルート)
4. `js/config.js` を作成（`config.example.js` を参考に、Railway URLを設定）

### 3. 環境変数
| サービス | 変数名 | 値 |
|---------|--------|----|
| Railway | `SUPABASE_URL` | Supabase Project URL |
| Railway | `SUPABASE_SERVICE_KEY` | Supabase Service Role Key |
| Railway | `FRONTEND_URL` | `https://rakushift-ai.pages.dev` |
| Railway | `ADMIN_API_TOKEN` | 管理APIの認証トークン（任意の文字列） |
| Railway | `MIGRATION_TOKEN` | マイグレーション用トークン（使用時のみ） |

### 4. Stripe Webhook
- エンドポイント: `https://YOUR_RAILWAY_URL/stripe/webhook`
- イベント: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

## 今後の予定
- シフト表のPDFエクスポート機能の強化
- スタッフ向けスマホ専用ビューの最適化
- 通知機能の実装

---

## 📦 納品物・引き継ぎ

このリポジトリは **納品状態 (2026-05-22 セキュリティハードニング v1 適用済み)** です。

### 引き継ぎを受ける方への作業

#### 🔥 最初の1営業日以内
1. [docs/README.md](docs/README.md) を開いて全納品文書の一覧を把握
2. [docs/SECURITY.md](docs/SECURITY.md) で **既知のセキュリティ残課題** を必ず確認
3. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) に従って環境変数・GitHub Secrets を新オーナーの認証情報に切替
4. **未適用なら** Supabase へマイグレーション 22〜29 を適用 (Supabase Studio → SQL Editor)
   - `supabase/migrations/20260522000000_22_enable_missing_rls.sql`
   - migration 22〜45 (全 11本) は **2026-05-23 までに本番DB適用済**
   - 詳細は [docs/CHANGELOG_SECURITY.md](docs/CHANGELOG_SECURITY.md) を参照
5. Supabase Studio → Database → Advisors で警告ゼロを確認 (2026-05-23 時点で ERROR 0件達成)

#### 📋 最初の1週間以内
- [docs/引き継ぎ資料_完全版.md](docs/引き継ぎ資料_完全版.md) を全員が読了
- Stripe / Supabase / Railway / Cloudflare の各管理コンソールに新オーナーがアクセスできることを確認
- 全シークレットをローテーション ([docs/SECURITY.md §5](docs/SECURITY.md) 参照)
- [docs/CHANGELOG_SECURITY.md](docs/CHANGELOG_SECURITY.md) 末尾の **動作確認チェックリスト** を実施

#### ⚠️ 経営判断が必要な残課題 (運用前に必ず再評価)
- **マスターパスワード `'rakushift1234'`** (運営者判断で残存中) の取扱 — `verify_shop_login` / `register_store_to_hq` 内に hardcode
- **デモテナント `254995332101138`** と本番DBの分離 — 別 Supabase プロジェクトへ移行推奨
- **API キー (Stripe / Gemini / OpenAI) の DB 平文保存** → Supabase Vault 移行検討
- **`stripe_webhook_secret` / `smtp_host`** が `platform_settings` 未設定 (Railway env で代用済の場合は問題なし、要確認)

#### ✅ 2026-05-23 完了済 (旧バージョンから引き継いだ場合は不要)
- ~~admin_password の平文保存 → bcrypt 化~~ → **migration 45 で完了 + 自動 trigger 設置**
- ~~`config_safe` view から admin_password 除外~~ → **migration 40 で完了**
- ~~マルチテナント分離バイパス (`*_all` ポリシー)~~ → **migration 43 で完了**
- ~~RLS UPDATE WITH CHECK 漏れ~~ → **migration 41 で完了**
- ~~`stripe_subscription_id` UNIQUE 制約~~ → **migration 42 で完了**
- ~~HQ_ACCOUNTS フロントフォールバック~~ → **2026-05-23 コード削除**
