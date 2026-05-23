-- 22_enable_missing_rls.sql
-- ===========================================================
-- Migration: RLS未有効テーブルの修正
-- Supabase Security Advisor 警告対応 (rls_disabled_in_public)
--
-- 本番DB現状 (2026-05-22 時点) に基づく:
--   - auth_sessions:  RLS 無効・ポリシー無し → 修正対象
--   - announcements:  RLS 既に有効 (冪等で再宣言のみ)
--   - hq_admins:      テーブル不在のため IF EXISTS で保護
-- ===========================================================

-- =========================================================
-- 1. auth_sessions: RLS を有効化＋セッション単位の閲覧/削除のみ許可
-- INSERT ポリシー無し → anon からの直接 INSERT は拒否
-- (セッション発行は verify_shop_login / verify_admin_login / hq_login
--  などの SECURITY DEFINER RPC 経由でのみ行われる)
-- =========================================================
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_sessions_select_own" ON auth_sessions;
CREATE POLICY "auth_sessions_select_own" ON auth_sessions
    FOR SELECT TO anon
    USING (id = get_session_id());

DROP POLICY IF EXISTS "auth_sessions_delete_own" ON auth_sessions;
CREATE POLICY "auth_sessions_delete_own" ON auth_sessions
    FOR DELETE TO anon
    USING (id = get_session_id());

DROP POLICY IF EXISTS "auth_sessions_admin_all" ON auth_sessions;
CREATE POLICY "auth_sessions_admin_all" ON auth_sessions
    FOR ALL TO anon
    USING (get_session_role() = 'hq_admin');

-- =========================================================
-- 2. announcements: RLS を有効化 (冪等)
-- 既存ポリシー "announcements_select_all" は migration 18 で作成済
-- INSERT/UPDATE/DELETE はポリシー未定義のため自動拒否
-- =========================================================
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

-- =========================================================
-- 3. hq_admins: テーブルが存在する場合のみ RLS 有効化＋遮断
-- =========================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='hq_admins'
    ) THEN
        EXECUTE 'ALTER TABLE hq_admins ENABLE ROW LEVEL SECURITY';
        EXECUTE 'DROP POLICY IF EXISTS "hq_admins_no_direct_access" ON hq_admins';
        EXECUTE 'CREATE POLICY "hq_admins_no_direct_access" ON hq_admins
                 FOR ALL TO anon USING (false) WITH CHECK (false)';
        EXECUTE 'REVOKE ALL ON hq_admins FROM anon';
    END IF;
END $$;

-- =========================================================
-- 4. PostgREST にスキーマ再読み込みを通知
-- =========================================================
NOTIFY pgrst, 'reload schema';
