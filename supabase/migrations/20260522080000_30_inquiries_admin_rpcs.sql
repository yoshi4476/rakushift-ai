-- 30_inquiries_admin_rpcs.sql
-- ===========================================================
-- Migration: 本部用 inquiries 管理 RPC + record_login_failure の挙動修正
--
-- 1. list_inquiries / get_inquiry / update_inquiry RPC を追加
--    (本部管理画面で法人お問い合わせを一覧表示・ステータス更新するための API)
--    hq_admin セッションのみ操作可能。anon は EXECUTE 不可。
--
-- 2. record_login_failure: ロック中の追加失敗で failed_count をリセットしないよう修正
--    旧実装: 閾値到達でロック設定 + failed_count=0 リセット
--    新実装: ロック中の追加失敗は何もしない (locked_until を延長もしない)
-- ===========================================================

-- =========================================================
-- 1.1 list_inquiries: お問い合わせ一覧 (status フィルタ可)
-- =========================================================
CREATE OR REPLACE FUNCTION list_inquiries(
    p_status TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
) RETURNS JSONB AS $$
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. HQ admin privileges required.';
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

-- =========================================================
-- 1.2 get_inquiry: 単一のお問い合わせ詳細
-- =========================================================
CREATE OR REPLACE FUNCTION get_inquiry(p_id UUID) RETURNS JSONB AS $$
DECLARE
    v_row inquiries%ROWTYPE;
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. HQ admin privileges required.';
    END IF;
    SELECT * INTO v_row FROM inquiries WHERE id = p_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'お問い合わせが見つかりません');
    END IF;
    RETURN jsonb_build_object('success', true, 'data', row_to_json(v_row));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 1.3 update_inquiry: ステータス・担当者・内部メモの更新
-- =========================================================
CREATE OR REPLACE FUNCTION update_inquiry(
    p_id UUID,
    p_status TEXT DEFAULT NULL,
    p_handled_by TEXT DEFAULT NULL,
    p_internal_notes TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_allowed_status TEXT[] := ARRAY['new', 'contacted', 'in_progress', 'closed', 'spam'];
BEGIN
    IF COALESCE(get_session_role(), '') != 'hq_admin' THEN
        RAISE EXCEPTION 'Access denied. HQ admin privileges required.';
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

-- =========================================================
-- 1.4 GRANT EXECUTE (anon にも公開、ただし RPC 内部で hq_admin 確認するため安全)
-- =========================================================
GRANT EXECUTE ON FUNCTION list_inquiries(TEXT, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_inquiry(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_inquiry(UUID, TEXT, TEXT, TEXT) TO anon, authenticated;

-- =========================================================
-- 2. record_login_failure: ロック中の挙動修正
--    ロック中 (locked_until > now()) は何もせず、現状の failed_count/locked_until を維持する。
--    これにより攻撃者が「ロック中の追加失敗で failed_count をリセット → 次のロック時間を短縮」する
--    攻撃を防ぐ。
-- =========================================================
CREATE OR REPLACE FUNCTION record_login_failure(p_identifier TEXT)
RETURNS JSONB AS $$
DECLARE
    v_threshold INTEGER := 10;
    v_window INTERVAL := interval '5 minutes';
    v_lock_duration INTERVAL := interval '5 minutes';
    v_row login_attempts%ROWTYPE;
    v_locked TIMESTAMPTZ;
BEGIN
    IF p_identifier IS NULL OR p_identifier = '' THEN
        RETURN jsonb_build_object('locked', false);
    END IF;

    -- 既存レコード取得
    SELECT * INTO v_row FROM login_attempts WHERE identifier = p_identifier;

    -- ロック中なら何もしない (failed_count リセット攻撃を防止)
    IF FOUND AND v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
        RETURN jsonb_build_object(
            'locked', true,
            'locked_until', v_row.locked_until,
            'retry_after_seconds', EXTRACT(EPOCH FROM (v_row.locked_until - now()))::INTEGER
        );
    END IF;

    -- UPSERT (ロック中ではないか、レコード自体が無いケース)
    INSERT INTO login_attempts (identifier, failed_count)
    VALUES (p_identifier, 1)
    ON CONFLICT (identifier) DO UPDATE
    SET failed_count = CASE
            WHEN login_attempts.first_failed_at < now() - v_window THEN 1
            ELSE login_attempts.failed_count + 1
        END,
        first_failed_at = CASE
            WHEN login_attempts.first_failed_at < now() - v_window THEN now()
            ELSE login_attempts.first_failed_at
        END,
        last_failed_at = now()
    RETURNING * INTO v_row;

    -- 閾値到達ならロック設定 (failed_count はロック解除/期間切れまで維持)
    IF v_row.failed_count >= v_threshold THEN
        v_locked := now() + v_lock_duration;
        UPDATE login_attempts
        SET locked_until = v_locked
        WHERE identifier = p_identifier;

        RETURN jsonb_build_object(
            'locked', true,
            'locked_until', v_locked,
            'retry_after_seconds', EXTRACT(EPOCH FROM v_lock_duration)::INTEGER
        );
    END IF;

    RETURN jsonb_build_object('locked', false, 'failed_count', v_row.failed_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

NOTIFY pgrst, 'reload schema';
