-- 43_critical_rls_bypass_fix.sql
-- ===========================================================
-- 🔴 CRITICAL: マルチテナント分離の完全バイパス問題の修正
--
-- 背景 (Supabase Security Advisor で発見):
--   migration 00 で作成された旧 RLS ポリシー `*_all` が
--   後の migration で「USING(true), WITH CHECK(true)」のまま残存。
--   PostgreSQL RLS は **複数ポリシーを OR 結合**するため、
--   _all (true) が存在すると後続の厳密ポリシー (organization_id チェック等)
--   が実質的に無効化されていた。
--
--   結果: anon ロールが他テナントの shifts / staff / requests / organizations / config
--         を SELECT/UPDATE 可能な状態 (テナント分離崩壊)。
--
-- 対策:
--   1. 全 `*_all` ポリシーを DROP
--   2. config の SELECT/INSERT も RPC 経由のみに制限
--   3. config_safe / staff_safe view を SECURITY INVOKER で再作成
--      (PostgreSQL 15+ の WITH (security_invoker = on) 使用)
--      これにより view も呼出側 (anon) の RLS を尊重する
-- ===========================================================

-- =========================================================
-- 1. 致命的な「USING(true), WITH CHECK(true)」全公開ポリシーを DROP
-- =========================================================
DROP POLICY IF EXISTS "orgs_all" ON organizations;
DROP POLICY IF EXISTS "requests_all" ON requests;
DROP POLICY IF EXISTS "shifts_all" ON shifts;
DROP POLICY IF EXISTS "staff_all" ON staff;
DROP POLICY IF EXISTS "config_select_all" ON config;
DROP POLICY IF EXISTS "config_insert_all" ON config;

-- =========================================================
-- 2. config テーブルは全アクセス禁止 (config_safe view + RPC 経由のみ)
-- =========================================================
DROP POLICY IF EXISTS "config_no_direct_access" ON config;
CREATE POLICY "config_no_direct_access" ON config
    FOR ALL TO anon
    USING (false)
    WITH CHECK (false);

-- =========================================================
-- 3. organizations テーブル: 直接アクセス完全禁止 (RPC 経由のみ)
-- =========================================================
DROP POLICY IF EXISTS "org_no_direct_access" ON organizations;
CREATE POLICY "org_no_direct_access" ON organizations
    FOR ALL TO anon
    USING (false)
    WITH CHECK (false);

-- =========================================================
-- 4. shifts / staff / requests のテナント分離ポリシー再強化
--    (migration 01 で staff_select_by_org 等は作成済みだが、
--     _all が DROP されたので二重定義リスクなし。確認のため OR REPLACE 相当の再作成)
-- =========================================================

-- shifts
DROP POLICY IF EXISTS "shifts_select_by_org" ON shifts;
CREATE POLICY "shifts_select_by_org" ON shifts FOR SELECT TO anon
    USING (organization_id = get_session_org_id());
DROP POLICY IF EXISTS "shifts_insert_by_org" ON shifts;
CREATE POLICY "shifts_insert_by_org" ON shifts FOR INSERT TO anon
    WITH CHECK (organization_id = get_session_org_id());
DROP POLICY IF EXISTS "shifts_delete_by_org" ON shifts;
CREATE POLICY "shifts_delete_by_org" ON shifts FOR DELETE TO anon
    USING (organization_id = get_session_org_id());
-- UPDATE は migration 41 で既に WITH CHECK 付与済み (そのまま)

-- staff
DROP POLICY IF EXISTS "staff_select_by_org" ON staff;
CREATE POLICY "staff_select_by_org" ON staff FOR SELECT TO anon
    USING (organization_id = get_session_org_id());
DROP POLICY IF EXISTS "staff_insert_by_org" ON staff;
CREATE POLICY "staff_insert_by_org" ON staff FOR INSERT TO anon
    WITH CHECK (organization_id = get_session_org_id());
DROP POLICY IF EXISTS "staff_delete_by_org" ON staff;
CREATE POLICY "staff_delete_by_org" ON staff FOR DELETE TO anon
    USING (organization_id = get_session_org_id());

-- requests
DROP POLICY IF EXISTS "requests_select_by_org" ON requests;
CREATE POLICY "requests_select_by_org" ON requests FOR SELECT TO anon
    USING (organization_id = get_session_org_id());
DROP POLICY IF EXISTS "requests_insert_by_org" ON requests;
CREATE POLICY "requests_insert_by_org" ON requests FOR INSERT TO anon
    WITH CHECK (organization_id = get_session_org_id());
DROP POLICY IF EXISTS "requests_delete_by_org" ON requests;
CREATE POLICY "requests_delete_by_org" ON requests FOR DELETE TO anon
    USING (organization_id = get_session_org_id());

-- =========================================================
-- 5. config_safe / staff_safe view を SECURITY INVOKER で再作成
--    (旧版は SECURITY DEFINER = postgres 権限で実行 → RLS バイパス)
--    PostgreSQL 15+: WITH (security_invoker = on) で呼出側権限に切替
-- =========================================================

DROP VIEW IF EXISTS config_safe CASCADE;
CREATE VIEW config_safe
WITH (security_invoker = on) AS
SELECT
    c.id,
    c.organization_id,
    c.contract_id,
    c.stripe_customer_id,
    c.stripe_subscription_id,
    c.subscription_status,
    c.stripe_plan,
    c.trial_ends_at,
    c.subscription_current_period_end,
    c.opening_time,
    c.closing_time,
    c.hourly_wage_default,
    c.opening_times,
    c.closed_days,
    c.staff_req,
    c.roles,
    c.special_holidays,
    c.special_days,
    c.time_staff_req,
    c.calendar_notes,
    c.break_rules,
    c.shop_rules_text,
    c.custom_shifts,
    c.openai_model,
    c.gemini_model,
    c.llm_provider,
    c.customer_email,
    c.contact_name,
    c.phone,
    c.contact_phone,
    c.address,
    c.referrer_code,
    c.payment_failed_at,
    o.license_status,
    o.license_suspended_at
FROM config c
LEFT JOIN organizations o ON o.id = c.organization_id;

-- ⚠️ SECURITY INVOKER の view は呼出側 RLS を尊重するため、
-- config / organizations の RLS が「直接アクセス禁止 (USING false)」だと
-- view 経由でも結果が空になる。
-- → view 経由でテナント自身が自社設定を見たいケース用に、
--   config / organizations に「セッション組織IDのみ SELECT 可」ポリシーを追加
DROP POLICY IF EXISTS "config_select_own" ON config;
CREATE POLICY "config_select_own" ON config FOR SELECT TO anon
    USING (organization_id = get_session_org_id());

DROP POLICY IF EXISTS "org_select_own" ON organizations;
CREATE POLICY "org_select_own" ON organizations FOR SELECT TO anon
    USING (id = get_session_org_id());

GRANT SELECT ON config_safe TO anon;

DROP VIEW IF EXISTS staff_safe CASCADE;
CREATE VIEW staff_safe
WITH (security_invoker = on) AS
SELECT
    id,
    organization_id,
    contract_id,
    name,
    login_id,
    role,
    evaluation,
    salary_type,
    hourly_wage,
    monthly_salary,
    annual_holidays,
    max_days_week,
    max_hours_day,
    unavailable_dates
FROM staff;

GRANT SELECT ON staff_safe TO anon;

NOTIFY pgrst, 'reload schema';
