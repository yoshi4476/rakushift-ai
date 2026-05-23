-- 40_remove_admin_password_from_view.sql
-- ===========================================================
-- Security: config_safe ビューから admin_password を除外
--
-- 背景:
--   migration 10 で view に admin_password 列を含めて anon に GRANT したが、
--   これは XSS でセッション奪取された場合、攻撃者が同テナントの
--   管理者パスワードを平文で取得できる経路となっていた。
--
-- 対策:
--   1. config_safe ビューから admin_password 列を除外
--   2. update_config_safe RPC から admin_password 更新ロジックを除外
--      (パスワード変更は専用 RPC update_admin_password_by_contract のみ可)
--   3. フロントは「設定画面で現在値を表示しない」前提に変更 (別ファイル)
-- ===========================================================

-- 1. config_safe ビューを再作成 (admin_password 列を除外)
DROP VIEW IF EXISTS config_safe;
CREATE VIEW config_safe AS
SELECT
    c.id,
    c.organization_id,
    c.contract_id,
    c.stripe_customer_id,
    c.stripe_subscription_id,
    c.subscription_status,
    -- admin_password を除外 (XSS 経由の漏洩防止)
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

GRANT SELECT ON config_safe TO anon;

-- 2. update_config_safe RPC から admin_password 更新を除外
--    (フロントが誤って admin_password を含むペイロードを送っても無視される)
CREATE OR REPLACE FUNCTION update_config_safe(
    p_config_id UUID,
    p_data JSONB
) RETURNS JSONB AS $$
BEGIN
    UPDATE config SET
        opening_time = COALESCE(p_data->>'opening_time', opening_time),
        closing_time = COALESCE(p_data->>'closing_time', closing_time),
        hourly_wage_default = COALESCE((p_data->>'hourly_wage_default')::INTEGER, hourly_wage_default),
        opening_times = COALESCE(p_data->'opening_times', opening_times),
        closed_days = CASE WHEN p_data ? 'closed_days' THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'closed_days'))::INTEGER[] ELSE closed_days END,
        staff_req = COALESCE(p_data->'staff_req', staff_req),
        roles = COALESCE(p_data->'roles', roles),
        special_holidays = CASE WHEN p_data ? 'special_holidays' THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'special_holidays'))::TEXT[] ELSE special_holidays END,
        special_days = COALESCE(p_data->'special_days', special_days),
        time_staff_req = COALESCE(p_data->'time_staff_req', time_staff_req),
        calendar_notes = COALESCE(p_data->'calendar_notes', calendar_notes),
        break_rules = COALESCE(p_data->'break_rules', break_rules),
        shop_rules_text = COALESCE(p_data->>'shop_rules_text', shop_rules_text),
        custom_shifts = COALESCE(p_data->'custom_shifts', custom_shifts),
        gemini_model = COALESCE(p_data->>'gemini_model', gemini_model),
        openai_model = COALESCE(p_data->>'openai_model', openai_model),
        llm_provider = COALESCE(p_data->>'llm_provider', llm_provider)
        -- 注意: admin_password はここから意図的に除外
        --        変更したい場合は update_admin_password_by_contract RPC を使用
    WHERE id = p_config_id;

    IF p_data ? 'gemini_api_key' AND (p_data->>'gemini_api_key') IS NOT NULL AND (p_data->>'gemini_api_key') != '' THEN
        UPDATE config SET gemini_api_key = p_data->>'gemini_api_key' WHERE id = p_config_id;
    END IF;
    IF p_data ? 'openai_api_key' AND (p_data->>'openai_api_key') IS NOT NULL AND (p_data->>'openai_api_key') != '' THEN
        UPDATE config SET openai_api_key = p_data->>'openai_api_key' WHERE id = p_config_id;
    END IF;

    RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

NOTIFY pgrst, 'reload schema';
