-- 44_perf_dedup_policies_and_fk_indexes.sql
-- ===========================================================
-- Performance: Supabase Performance Advisor で検出された
--   1. Multiple Permissive Policies (config, platform_settings の重複ポリシー)
--   2. Unindexed Foreign Keys 3件
-- を一括解消する。
--
-- 各 SELECT で PostgreSQL は重複する permissive policy 全てを評価するため、
-- 重複削除により最大 50% のクエリ高速化が見込める。
-- ===========================================================

-- =========================================================
-- 1. config テーブルの SELECT ポリシー重複解消
--    旧: config_select_by_org + config_select_own (どちらも org_id ベース)
--    新: config_select_own のみ (migration 43 で追加した方を残す)
-- =========================================================
DROP POLICY IF EXISTS "config_select_by_org" ON config;

-- =========================================================
-- 2. platform_settings の重複ポリシー解消
--    旧: platform_settings_no_direct + platform_settings_no_direct_access (機能同一)
--    新: platform_settings_no_direct_access のみ
-- =========================================================
DROP POLICY IF EXISTS "platform_settings_no_direct" ON platform_settings;

-- =========================================================
-- 3. Unindexed Foreign Keys 3件にインデックス追加
--    CASCADE DELETE / 外部キー検証時のフルテーブルスキャンを防ぐ
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_auth_sessions_organization_id
    ON auth_sessions(organization_id)
    WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_config_organization_id
    ON config(organization_id);

CREATE INDEX IF NOT EXISTS idx_requests_staff_id
    ON requests(staff_id);

NOTIFY pgrst, 'reload schema';
