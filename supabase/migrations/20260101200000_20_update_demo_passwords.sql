-- 20_update_demo_passwords.sql
-- ===========================================================
-- Migration: デモ用アカウントのパスワードを統一する
-- 修正: organizationsテーブルにはpassword/admin_passwordカラムがないため
--       configテーブルのみ更新する。contract_idもconfigテーブルから取得。
-- ===========================================================

DO $$
DECLARE
    v_demo_org_id UUID;
BEGIN
    -- 1. デモ用店舗のIDを取得（contract_idはconfigテーブルにある）
    SELECT c.organization_id INTO v_demo_org_id 
    FROM config c WHERE c.contract_id = 'demo' LIMIT 1;

    -- デモ店舗が存在する場合、パスワードを統一
    IF v_demo_org_id IS NOT NULL THEN
        -- configテーブルのパスワードを更新
        UPDATE config
        SET 
            shop_password = crypt('demo', gen_salt('bf')),
            admin_password = crypt('demo', gen_salt('bf'))
        WHERE organization_id = v_demo_org_id;

        RAISE NOTICE 'Demo passwords updated to demo for org_id: %', v_demo_org_id;
    END IF;

    -- 2. 本部・統括（HQ）のデモアカウント追加
    INSERT INTO hq_admins (login_id, password) 
    VALUES ('demo', crypt('demo', gen_salt('bf')))
    ON CONFLICT (login_id) DO UPDATE 
    SET password = crypt('demo', gen_salt('bf'));

    RAISE NOTICE 'HQ demo account (demo/demo) ensured.';
END $$;
