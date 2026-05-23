-- 26_login_rate_limit.sql
-- ===========================================================
-- Migration: ログイン試行のレート制限
--
-- 方針:
--   verify_shop_login / verify_admin_login / hq_login など既存ログイン関数の
--   本体 (パスワード比較ロジック) は触らない。
--   代わりに「失敗試行を記録するヘルパー」+ 「ロックチェック関数」を提供し、
--   フロントやサーバ側からログイン前/後に呼ぶ運用とする。
--
-- 同一 contract_id (HQ では login_id) に対して
--   - 5分間で 10回失敗すると 5分間ロック
--   - ロック中は can_attempt_login() が false を返す
--   - 成功したらカウンタリセット
--
-- HTTP ヘッダーから IP も併用する余地はあるが、PostgREST 経由では
-- 信頼可能な IP 取得が難しいため、まずは識別子ベースに限定。
-- ===========================================================

CREATE TABLE IF NOT EXISTS login_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier TEXT NOT NULL,
    failed_count INT NOT NULL DEFAULT 0,
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_until TIMESTAMPTZ,
    UNIQUE (identifier)
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_locked_until ON login_attempts(locked_until);

ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "login_attempts_no_access" ON login_attempts;
CREATE POLICY "login_attempts_no_access" ON login_attempts
    FOR ALL TO anon USING (false) WITH CHECK (false);
REVOKE ALL ON login_attempts FROM anon;

-- =========================================================
-- can_attempt_login(p_identifier)
--   ロック中なら false、それ以外は true
-- =========================================================
CREATE OR REPLACE FUNCTION can_attempt_login(p_identifier TEXT)
RETURNS JSONB AS $$
DECLARE
    v_row login_attempts%ROWTYPE;
    v_remain INTEGER;
BEGIN
    IF p_identifier IS NULL OR p_identifier = '' THEN
        RETURN jsonb_build_object('allowed', true);
    END IF;

    SELECT * INTO v_row FROM login_attempts WHERE identifier = p_identifier;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('allowed', true);
    END IF;

    IF v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
        v_remain := EXTRACT(EPOCH FROM (v_row.locked_until - now()))::INTEGER;
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'too_many_attempts',
            'retry_after_seconds', v_remain
        );
    END IF;

    RETURN jsonb_build_object('allowed', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- record_login_failure(p_identifier)
--   失敗を記録し、閾値を超えていればロック設定して返す
-- =========================================================
CREATE OR REPLACE FUNCTION record_login_failure(p_identifier TEXT)
RETURNS JSONB AS $$
DECLARE
    v_threshold INTEGER := 10;
    v_window INTERVAL := interval '5 minutes';
    v_lock_duration INTERVAL := interval '5 minutes';
    v_row login_attempts%ROWTYPE;
    v_count INTEGER;
    v_locked TIMESTAMPTZ;
BEGIN
    IF p_identifier IS NULL OR p_identifier = '' THEN
        RETURN jsonb_build_object('locked', false);
    END IF;

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

    IF v_row.failed_count >= v_threshold THEN
        v_locked := now() + v_lock_duration;
        UPDATE login_attempts
        SET locked_until = v_locked,
            failed_count = 0,
            first_failed_at = now()
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

-- =========================================================
-- clear_login_failures(p_identifier)
--   ログイン成功時のリセット用
-- =========================================================
CREATE OR REPLACE FUNCTION clear_login_failures(p_identifier TEXT)
RETURNS VOID AS $$
BEGIN
    IF p_identifier IS NULL OR p_identifier = '' THEN
        RETURN;
    END IF;
    DELETE FROM login_attempts WHERE identifier = p_identifier;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp;

-- =========================================================
-- 明示的 GRANT EXECUTE
-- (Supabase は PUBLIC EXECUTE のデフォルトで anon が呼べる可能性が高いが、
--  既存運用との一貫性と将来の DEFAULT PRIVILEGES 変更に備えて明示する)
-- =========================================================
GRANT EXECUTE ON FUNCTION can_attempt_login(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_login_failure(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION clear_login_failures(TEXT) TO anon, authenticated;

-- 古いロック解除済みレコードを pg_cron で日次掃除 (利用可能なら)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule(jobname) FROM cron.job
            WHERE jobname = 'cleanup-login-attempts';
        PERFORM cron.schedule(
            'cleanup-login-attempts',
            '30 3 * * *',
            $job$DELETE FROM login_attempts
                 WHERE last_failed_at < now() - interval '7 days'
                   AND (locked_until IS NULL OR locked_until < now())$job$
        );
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
