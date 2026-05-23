-- 28_inquiries_table.sql
-- ===========================================================
-- Migration: 法人お問い合わせテーブルの新設
--
-- 背景:
--   python/main.py の /api/inquiry エンドポイントで
--   supabase_query("inquiries", method="POST", ...) を実行しているが、
--   このテーブルが未定義のため永遠に DB 保存に失敗していた
--   (try/except で握りつぶされていた)。
--
-- 設計:
--   - 受信したお問い合わせを保存
--   - ステータス: new -> contacted -> closed のライフサイクル
--   - 個人情報を含むため RLS で anon からの SELECT/UPDATE/DELETE を遮断
--   - INSERT のみ anon に許可 (フォーム送信元から)
-- ===========================================================

CREATE TABLE IF NOT EXISTS inquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name TEXT NOT NULL,
    company_address TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    contact_name TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    plan_summary TEXT DEFAULT '',
    light_plan_count INTEGER DEFAULT 0,
    standard_plan_count INTEGER DEFAULT 0,
    premium_plan_count INTEGER DEFAULT 0,
    preferred_days TEXT DEFAULT '',
    preferred_time TEXT DEFAULT '',
    schedule_summary TEXT DEFAULT '',
    message TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    handled_by TEXT DEFAULT '',
    handled_at TIMESTAMPTZ,
    internal_notes TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);
CREATE INDEX IF NOT EXISTS idx_inquiries_created_at ON inquiries(created_at DESC);

-- =========================================================
-- RLS: anon は INSERT のみ、SELECT/UPDATE/DELETE は本部のみ
-- =========================================================
ALTER TABLE inquiries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inquiries_anon_insert" ON inquiries;
CREATE POLICY "inquiries_anon_insert" ON inquiries
    FOR INSERT TO anon
    WITH CHECK (true);

DROP POLICY IF EXISTS "inquiries_hq_only" ON inquiries;
CREATE POLICY "inquiries_hq_only" ON inquiries
    FOR ALL TO anon
    USING (get_session_role() = 'hq_admin')
    WITH CHECK (get_session_role() = 'hq_admin');

-- anon に INSERT のみ明示付与
REVOKE ALL ON inquiries FROM anon;
GRANT INSERT ON inquiries TO anon;

-- =========================================================
-- updated_at 自動更新トリガー
-- =========================================================
CREATE OR REPLACE FUNCTION _inquiries_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status != 'new' AND NEW.handled_at IS NULL THEN
        NEW.handled_at = now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions, pg_temp;

DROP TRIGGER IF EXISTS trg_inquiries_updated_at ON inquiries;
CREATE TRIGGER trg_inquiries_updated_at
    BEFORE UPDATE ON inquiries
    FOR EACH ROW
    EXECUTE FUNCTION _inquiries_set_updated_at();

NOTIFY pgrst, 'reload schema';
