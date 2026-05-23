-- 42_stripe_unique_constraints.sql
-- ===========================================================
-- Critical: Webhook 重複処理によるテナント重複作成を DB レベルで防止
--
-- 背景:
--   Stripe Webhook は同じイベントを複数回送信する (再試行ポリシー)
--   現状の main.py は SELECT で重複確認 → INSERT というパターン
--   SELECT と INSERT の間に race condition があり、2件作成される可能性
--
-- 対策:
--   config.stripe_subscription_id に UNIQUE 制約追加
--   config.stripe_customer_id にもインデックス追加 (頻繁検索)
--   重複 INSERT は DB レベルで Reject → main.py 側で重複を補足してログのみ
-- ===========================================================

-- 重複データの事前クリーンアップ (もしあれば、最古を残す)
-- 注意: 本番では既に重複なしと仮定。重複があれば手動対応推奨。
-- このスクリプトは UNIQUE 制約のみ追加し、データ移行はしない (安全策)。

-- stripe_subscription_id に部分 UNIQUE 制約
-- NULL は除外 (まだ Stripe 登録前のテナントも存在するため)
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_stripe_subscription_id_unique
    ON config(stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;

-- stripe_customer_id にもインデックス (頻繁検索: webhook → customer_id 逆引き)
CREATE INDEX IF NOT EXISTS idx_config_stripe_customer_id
    ON config(stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
