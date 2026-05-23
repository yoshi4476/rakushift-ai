-- 29_misc_fixes.sql
-- ===========================================================
-- Migration: 過去マイグレーションの整合性修正
--
--   1. inquiries RLS の `FOR ALL TO anon` が INSERT を含み、INSERT-only ポリシーと意図がぶつかるため SELECT/UPDATE/DELETE に分離
--   2. migration 09 の `create_tenant('demo','demo','...')` 3 引数呼び出しは現行定義 (1 引数版) と不一致。新規環境でデモ投入が壊れるため、ここでデモテナントを冪等に再構築
-- ===========================================================

-- =========================================================
-- 1. inquiries の RLS ポリシーを操作別に分離
-- =========================================================
DROP POLICY IF EXISTS "inquiries_anon_insert" ON inquiries;
DROP POLICY IF EXISTS "inquiries_hq_only" ON inquiries;
DROP POLICY IF EXISTS "inquiries_hq_select" ON inquiries;
DROP POLICY IF EXISTS "inquiries_hq_update" ON inquiries;
DROP POLICY IF EXISTS "inquiries_hq_delete" ON inquiries;

CREATE POLICY "inquiries_anon_insert" ON inquiries
    FOR INSERT TO anon
    WITH CHECK (true);

CREATE POLICY "inquiries_hq_select" ON inquiries
    FOR SELECT TO anon
    USING (get_session_role() = 'hq_admin');

CREATE POLICY "inquiries_hq_update" ON inquiries
    FOR UPDATE TO anon
    USING (get_session_role() = 'hq_admin')
    WITH CHECK (get_session_role() = 'hq_admin');

CREATE POLICY "inquiries_hq_delete" ON inquiries
    FOR DELETE TO anon
    USING (get_session_role() = 'hq_admin');

-- =========================================================
-- 2. デモテナントの冪等な再構築 (migration 09 の代替)
--    新規環境では migration 09 の create_tenant('demo','demo','...') 呼び出しが
--    現行の 1 引数定義と不一致で失敗するため、ここで明示的に再構築する
-- =========================================================
DO $$
DECLARE
    v_existing UUID;
    v_new_id UUID;
BEGIN
    SELECT organization_id INTO v_existing FROM config WHERE contract_id = 'demo';
    IF v_existing IS NOT NULL THEN
        RAISE NOTICE 'Demo tenant already exists (org=%), skipping create.', v_existing;
        RETURN;
    END IF;

    INSERT INTO organizations (name) VALUES ('Rakushift Demo Shop') RETURNING id INTO v_new_id;

    INSERT INTO config (
        organization_id, contract_id, shop_password, subscription_status, admin_password
    ) VALUES (
        v_new_id, 'demo',
        crypt('demo', gen_salt('bf')),
        'active',
        crypt('demo', gen_salt('bf'))
    );

    INSERT INTO staff (
        organization_id, contract_id, login_id, password,
        name, role, evaluation, salary_type, monthly_salary
    ) VALUES (
        v_new_id, 'demo', 'admin', crypt('demo', gen_salt('bf')),
        '管理者 (初期アカウント)', 'manager', 'A', 'monthly', 300000
    );

    RAISE NOTICE 'Demo tenant rebuilt: org_id=%', v_new_id;
END $$;

NOTIFY pgrst, 'reload schema';
