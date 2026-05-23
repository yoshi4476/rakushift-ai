-- 38_finalize_for_release.sql
-- ===========================================================
-- 納品最終調整 (本番デプロイ漏れ + 関数オーバーロード残骸の解消)
--
-- 背景: ディープデバッグで以下が判明
--   1. migration 30 (inquiries admin RPCs) が本番に未適用
--      → 運営管理コンソールの「お問い合わせ」タブが動作不能
--   2. update_shop_password が2引数版と3引数版で重複定義
--      → PostgREST がどちらを呼ぶか曖昧、RLS バイパスのリスク
--   3. list_inquiries / get_inquiry / update_inquiry が hq_admin 限定で
--      platform_admin (運営管理者) が閲覧できない
-- ===========================================================

-- =========================================================
-- 1. update_shop_password の旧 2引数版を DROP
-- =========================================================
DROP FUNCTION IF EXISTS update_shop_password(p_contract_id TEXT, p_new_password TEXT);
-- 3引数版 (p_contract_id, p_old_password, p_new_password) のみ残る

-- =========================================================
-- 2. inquiries 管理 RPC を再作成 + platform_admin も許可
-- =========================================================
CREATE OR REPLACE FUNCTION list_inquiries(
    p_status TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
) RETURNS JSONB AS $$
DECLARE
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;

    RETURN (
        SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
        FROM (
            SELECT
                id, company_name, company_address, phone, contact_name, contact_phone,
                plan_summary, light_plan_count, standard_plan_count, premium_plan_count,
                preferred_days, preferred_time, schedule_summary, message,
                status, created_at, updated_at, handled_by, handled_at, internal_notes
            FROM inquiries
            WHERE p_status IS NULL OR status = p_status
            ORDER BY created_at DESC
            LIMIT GREATEST(1, LEAST(p_limit, 500))
        ) t
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION get_inquiry(p_id UUID) RETURNS JSONB AS $$
DECLARE
    v_row inquiries%ROWTYPE;
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;
    SELECT * INTO v_row FROM inquiries WHERE id = p_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'お問い合わせが見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true, 'data', row_to_json(v_row));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION update_inquiry(
    p_id UUID,
    p_status TEXT DEFAULT NULL,
    p_handled_by TEXT DEFAULT NULL,
    p_internal_notes TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_allowed_status TEXT[] := ARRAY['new', 'contacted', 'in_progress', 'closed', 'spam'];
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM auth_sessions
    WHERE id = get_session_id() AND expires_at > now() LIMIT 1;
    IF v_role NOT IN ('hq_admin', 'platform_admin') THEN
        RAISE EXCEPTION 'Access denied. Administrator privileges required.';
    END IF;

    IF p_status IS NOT NULL AND NOT (p_status = ANY(v_allowed_status)) THEN
        RETURN jsonb_build_object('success', false, 'message',
            'status は new / contacted / in_progress / closed / spam のいずれかを指定してください');
    END IF;

    UPDATE inquiries SET
        status         = COALESCE(p_status, status),
        handled_by     = COALESCE(p_handled_by, handled_by),
        internal_notes = COALESCE(p_internal_notes, internal_notes)
    WHERE id = p_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'お問い合わせが見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

GRANT EXECUTE ON FUNCTION list_inquiries(TEXT, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_inquiry(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_inquiry(UUID, TEXT, TEXT, TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
