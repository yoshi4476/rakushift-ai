-- 45_bcrypt_password_migration.sql
-- ===========================================================
-- 🔴 Critical: 既存平文パスワードを bcrypt 化 + 将来の平文化を防止
--
-- 背景:
--   - staff.password に平文が 4件残存 (verify_admin_login は bcrypt 必須なので、これらは事実上ログイン不可状態)
--   - config.admin_password に平文が 10件残存 (register_store_to_hq で使用)
--   - 新規スタッフ追加時に自動 bcrypt 化される仕組みがないため、
--     フロントから API.create('staff') で平文 INSERT され続けるリスク
--
-- 対策:
--   1. 既存の平文を bcrypt 化 (元の平文と同じ値でログイン可能)
--   2. trigger 追加で INSERT/UPDATE 時に平文を自動 bcrypt 化
--   3. config.admin_password も同様に処理
-- ===========================================================

-- =========================================================
-- 1. 既存平文 staff.password を bcrypt 化
--    NOT LIKE '$2%' = bcrypt ハッシュ形式でない (平文)
-- =========================================================
UPDATE staff
SET password = crypt(password, gen_salt('bf'))
WHERE password IS NOT NULL
  AND password != ''
  AND password NOT LIKE '$2%';

-- =========================================================
-- 2. 既存平文 config.admin_password を bcrypt 化
-- =========================================================
UPDATE config
SET admin_password = crypt(admin_password, gen_salt('bf'))
WHERE admin_password IS NOT NULL
  AND admin_password != ''
  AND admin_password NOT LIKE '$2%';

-- =========================================================
-- 3. shop_password も同様にチェック・bcrypt 化
-- =========================================================
UPDATE config
SET shop_password = crypt(shop_password, gen_salt('bf'))
WHERE shop_password IS NOT NULL
  AND shop_password != ''
  AND shop_password NOT LIKE '$2%';

-- =========================================================
-- 4. staff の INSERT/UPDATE 時に平文を自動 bcrypt 化する trigger
-- =========================================================
CREATE OR REPLACE FUNCTION _staff_password_bcrypt_trigger()
RETURNS TRIGGER AS $$
BEGIN
    -- password が変更されていて、かつ bcrypt 形式でない場合のみ bcrypt 化
    IF NEW.password IS NOT NULL
       AND NEW.password != ''
       AND NEW.password NOT LIKE '$2%' THEN
        NEW.password := crypt(NEW.password, gen_salt('bf'));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions, pg_temp;

DROP TRIGGER IF EXISTS trg_staff_password_bcrypt ON staff;
CREATE TRIGGER trg_staff_password_bcrypt
    BEFORE INSERT OR UPDATE OF password ON staff
    FOR EACH ROW
    EXECUTE FUNCTION _staff_password_bcrypt_trigger();

-- =========================================================
-- 5. config.admin_password / shop_password にも同様の trigger
-- =========================================================
CREATE OR REPLACE FUNCTION _config_password_bcrypt_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.admin_password IS NOT NULL
       AND NEW.admin_password != ''
       AND NEW.admin_password NOT LIKE '$2%' THEN
        NEW.admin_password := crypt(NEW.admin_password, gen_salt('bf'));
    END IF;
    IF NEW.shop_password IS NOT NULL
       AND NEW.shop_password != ''
       AND NEW.shop_password NOT LIKE '$2%' THEN
        NEW.shop_password := crypt(NEW.shop_password, gen_salt('bf'));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions, pg_temp;

DROP TRIGGER IF EXISTS trg_config_password_bcrypt ON config;
CREATE TRIGGER trg_config_password_bcrypt
    BEFORE INSERT OR UPDATE OF admin_password, shop_password ON config
    FOR EACH ROW
    EXECUTE FUNCTION _config_password_bcrypt_trigger();

-- =========================================================
-- 6. hq_admins.password にも同様 (既存は migration 32 で bcrypt 化済の想定)
-- =========================================================
UPDATE hq_admins
SET password = crypt(password, gen_salt('bf'))
WHERE password IS NOT NULL
  AND password != ''
  AND password NOT LIKE '$2%';

CREATE OR REPLACE FUNCTION _hq_admins_password_bcrypt_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.password IS NOT NULL
       AND NEW.password != ''
       AND NEW.password NOT LIKE '$2%' THEN
        NEW.password := crypt(NEW.password, gen_salt('bf'));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions, pg_temp;

DROP TRIGGER IF EXISTS trg_hq_admins_password_bcrypt ON hq_admins;
CREATE TRIGGER trg_hq_admins_password_bcrypt
    BEFORE INSERT OR UPDATE OF password ON hq_admins
    FOR EACH ROW
    EXECUTE FUNCTION _hq_admins_password_bcrypt_trigger();

-- =========================================================
-- 7. platform_admins.password も同様
-- =========================================================
UPDATE platform_admins
SET password = crypt(password, gen_salt('bf'))
WHERE password IS NOT NULL
  AND password != ''
  AND password NOT LIKE '$2%';

CREATE OR REPLACE FUNCTION _platform_admins_password_bcrypt_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.password IS NOT NULL
       AND NEW.password != ''
       AND NEW.password NOT LIKE '$2%' THEN
        NEW.password := crypt(NEW.password, gen_salt('bf'));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public, extensions, pg_temp;

DROP TRIGGER IF EXISTS trg_platform_admins_password_bcrypt ON platform_admins;
CREATE TRIGGER trg_platform_admins_password_bcrypt
    BEFORE INSERT OR UPDATE OF password ON platform_admins
    FOR EACH ROW
    EXECUTE FUNCTION _platform_admins_password_bcrypt_trigger();

NOTIFY pgrst, 'reload schema';
