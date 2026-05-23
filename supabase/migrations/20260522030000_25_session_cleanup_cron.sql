-- 25_session_cleanup_cron.sql
-- ===========================================================
-- Migration: 期限切れセッション・古いエラーログの自動削除
--
-- pg_cron 拡張を用いて日次ジョブを登録する。
--   - auth_sessions:  expires_at < now() を毎日 03:10 UTC に DELETE
--   - rpc_error_log:  occurred_at < now() - 90 days を 03:20 UTC に DELETE
--
-- pg_cron が利用不可の環境 (一部 Supabase プランで未提供) でも
-- マイグレーション全体が止まらないよう、DO ブロックで例外を捕捉する。
-- ===========================================================

DO $$
BEGIN
    -- pg_cron 拡張の有効化を試みる
    CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron extension is unavailable on this project. Skipping scheduled cleanup. (%)', SQLERRM;
    RETURN;
END $$;

-- 二重登録防止: 同名ジョブがあれば一旦解除
DO $$
DECLARE
    j RECORD;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) THEN
        RAISE NOTICE 'pg_cron not installed - skipping cron schedule setup.';
        RETURN;
    END IF;

    FOR j IN SELECT jobname FROM cron.job
        WHERE jobname IN ('cleanup-expired-sessions', 'cleanup-old-error-logs')
    LOOP
        PERFORM cron.unschedule(j.jobname);
    END LOOP;

    -- 期限切れセッションを毎日 03:10 UTC (日本時間 12:10) に削除
    PERFORM cron.schedule(
        'cleanup-expired-sessions',
        '10 3 * * *',
        $job$DELETE FROM auth_sessions WHERE expires_at < now()$job$
    );

    -- 90 日以上前のエラーログを毎日 03:20 UTC に削除
    PERFORM cron.schedule(
        'cleanup-old-error-logs',
        '20 3 * * *',
        $job$DELETE FROM rpc_error_log WHERE occurred_at < now() - interval '90 days'$job$
    );

    RAISE NOTICE 'Cron jobs registered: cleanup-expired-sessions, cleanup-old-error-logs';
END $$;
