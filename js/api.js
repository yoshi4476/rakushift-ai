// =================================================================
// API Client for Rakushift (Supabase Version)
// Backend: Supabase (Data) + Railway (Calculation)
// 設定値は js/config.js から読み込み
// =================================================================

const SUPABASE_URL = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.SUPABASE_URL) || "";
const SUPABASE_KEY = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.SUPABASE_ANON_KEY) || "";
const CALC_BASE_URL = (typeof RAKUSHIFT_CONFIG !== 'undefined' && RAKUSHIFT_CONFIG.CALC_SERVER_URL) || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("[FATAL] js/config.js が未設定です。SUPABASE_URL と SUPABASE_ANON_KEY を設定してください。");
}

const CALC_API_URL = CALC_BASE_URL + "/generate";
const CHECK_API_URL = CALC_BASE_URL + "/check";
const DIAGNOSE_API_URL = CALC_BASE_URL + "/diagnose";

// セッション情報は sessionStorage で管理（タブ閉じで消滅 → XSS の持続性を抑制）。
// UI設定 (組織ID/既読フラグ等) は従来どおり localStorage に保持する。
// プライベートブラウジングやストレージ無効環境では in-memory Map にフォールバック
// (localStorage への自動フォールバックは XSS 永続化リスクを生むため意図的に避ける)
const SessionStore = (() => {
    try {
        if (typeof window !== 'undefined' && window.sessionStorage) {
            // 動作テスト (Safari プライベートモード等で setItem が throw する場合あり)
            const k = '__rakushift_storage_test__';
            window.sessionStorage.setItem(k, '1');
            window.sessionStorage.removeItem(k);
            return window.sessionStorage;
        }
    } catch (_) { /* fall through */ }

    // フォールバック: メモリ内ストア (タブ閉じで消滅。XSS 永続化耐性は最強だが、リロードで消える)
    console.warn('[Storage] sessionStorage unavailable — using in-memory store. Session will not persist across reloads.');
    const mem = new Map();
    return {
        getItem(key) { return mem.has(key) ? mem.get(key) : null; },
        setItem(key, value) { mem.set(key, String(value)); },
        removeItem(key) { mem.delete(key); },
        clear() { mem.clear(); },
    };
})();

const API = {
    session: null,

    // --- 初期化 & 認証 ---
    async init() {
        console.log("API init start (Supabase Mode)");
        try {
            // セッション復元 (Rakushift独自のセッションキーを優先)
            const savedSession = SessionStore.getItem('rakushift_user'); // 独自認証用
            
            if (savedSession) {
                // 独自認証モードの復元
                const user = JSON.parse(savedSession);
                this.session = {
                    access_token: 'dummy_token_for_static_auth',
                    user: user
                };
                // セッション復元完了
            } else {
                // (旧互換) Supabase Auth の復元
                const savedSbSession = SessionStore.getItem('supabase.auth.token');
                if (savedSbSession) {
                    this.session = JSON.parse(savedSbSession);
                    // セッション復元ログは本番では非表示
                } else {
                    // セッションなし
                }
            }
        } catch(e) {
            console.error("API init failed:", e);
        }
    },

    async login(email, password) {
        try {
            const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY
                },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error_description || data.msg || "Login failed");
            
            this.session = data;
            SessionStore.setItem('supabase.auth.token', JSON.stringify(data));
            return data;
        } catch (e) {
            console.error("Login failed:", e);
            throw e;
        }
    },

    async signUp(email, password, shopName) {
        try {
            const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY
                },
                body: JSON.stringify({ 
                    email, 
                    password,
                    data: { full_name: shopName } 
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error_description || data.msg || "Signup failed");
            return data;
        } catch (e) {
            console.error("Signup failed:", e);
            throw e;
        }
    },

    // 認証は app.js 側で staff テーブルを直接検索して行うため (SaaS対応: StaticMode互換)
    // ここではセッション状態の管理のみ行う
    setSession(user) {
        if (!user) {
            this.session = null;
            SessionStore.removeItem('rakushift_user');
            return;
        }
        // Supabaseモードでも、アプリ内の独自認証（契約ID）を使う場合は
        // userオブジェクトをラップしてsessionに入れる運用にする
        this.session = {
            access_token: 'dummy_token_for_static_auth', // 独自認証なのでダミー
            user: user
        };
        // ローカルストレージにも独自キーで保存（Supabase標準とは別管理）
        // セキュリティ: タイムスタンプを付与してセッション有効期限を管理
        user._session_created = Date.now();
        SessionStore.setItem('rakushift_user', JSON.stringify(user));
    },

    // セキュリティ: セッション有効期限チェック（フロントエンド側の補助制御）
    isSessionValid() {
        const saved = SessionStore.getItem('rakushift_user');
        if (!saved) return false;
        try {
            const user = JSON.parse(saved);
            const created = user._session_created || 0;
            const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7日間
            if (Date.now() - created > MAX_SESSION_MS) {
                console.log('[Security] Session expired. Auto logout.');
                this.logout();
                return false;
            }
            return true;
        } catch(e) { return false; }
    },

    async logout() {
        try {
            // サーバー側のセッションも確実に破棄する（完璧なセキュリティ担保）
            await this.rpc('destroy_session', {});
        } catch(e) {
            console.warn("Session destroy failed on server, proceeding with local logout");
        }
        this.session = null;
        SessionStore.removeItem('supabase.auth.token');
        SessionStore.removeItem('rakushift_user');
        location.reload();
    },

    // --- 汎用データ操作 (Supabase REST) ---
    async _request(endpoint, options = {}) {
        // SaaSモード: ログインしていなくてもAPIは叩けるようにする（契約ID認証前でもconfig等は読みたい場合があるため）
        // ただしRLSがかかっているテーブルはSupabase側で弾かれる
        
        const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            // 'Authorization': `Bearer ${this.session?.access_token}`, // 独自認証の場合はBearer不要、あるいはAnonキーでアクセス
            'Authorization': `Bearer ${SUPABASE_KEY}`, // 基本はAnonキーでアクセスし、RLSはフィルタで制御
            'Prefer': 'return=representation',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            ...options.headers
        };

        const savedSession = SessionStore.getItem('rakushift_user');
        if (savedSession) {
            try {
                const user = JSON.parse(savedSession);
                if (user.session_id) {
                    headers['x-session-id'] = user.session_id;
                }
                // 本部 (hq_admin) セッションで login_id が無い旧バージョン → 強制破棄して再ログインを促す
                // (新スキーマでは hq_login 時に login_id がセッションに保存される)
                if (user.role === 'hq_admin' && !user.login_id) {
                    console.warn('[Session] Old HQ session without login_id detected, clearing');
                    SessionStore.removeItem('rakushift_user');
                }
            } catch(e) {}
        }

        const MAX_RETRIES = 2;
        let attempt = 0;

        while (attempt <= MAX_RETRIES) {
            try {
                const res = await fetch(url, { ...options, headers });
                if (!res.ok) {
                    // 500系エラーまたはToo Many Requests (429) の場合はリトライ対象
                    if ((res.status >= 500 && res.status < 600) || res.status === 429) {
                        throw new Error(`Server Error ${res.status}`);
                    }
                    // 400系エラーなどはリトライせずに即時エラーにする
                    const errText = await res.text();
                    let errMsg = res.statusText;
                    try {
                        const json = JSON.parse(errText);
                        errMsg = json.message || json.error || res.statusText;
                    } catch(e) {}
                    
                    console.error(`API Error [${res.status}] ${url}`, errMsg);
                    throw new Error(`データ取得エラー (${res.status}): ${errMsg}`);
                }
                return await res.json();
            } catch (e) {
                // クライアント起因のエラー（400系）の場合はそのままスロー
                if (e.message.includes("データ取得エラー")) {
                    throw e;
                }
                
                attempt++;
                if (attempt > MAX_RETRIES) {
                    console.error("Fetch failed after retries:", e);
                    throw new Error("サーバー通信に失敗しました。ネットワークを確認してください。");
                }
                // 指数バックオフ (1回目: 500ms, 2回目: 1000ms)
                await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
            }
        }
    },

    async list(table, params = {}) {
        const qs = new URLSearchParams(params).toString();
        // Supabase形式のレスポンス {data: [], error: null} を模倣するか、直接配列を返すか
        // Static Table API互換にするため {data: [...]} 形式で返す
        const data = await this._request(`${table}?${qs}`);
        return { data: data };
    },

    async get(table, id) {
        const data = await this._request(`${table}?id=eq.${id}`);
        return data[0];
    },

    async create(table, data) {
        const res = await this._request(table, {
            method: 'POST',
            body: JSON.stringify(data)
        });
        return res[0];
    },

    async update(table, id, data) {
        const res = await this._request(`${table}?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });
        return res[0];
    },

    async delete(table, id) {
        // テナント保護: 重要テーブルの直接削除を禁止
        const protectedTables = ['organizations', 'config', 'hq_admins'];
        if (protectedTables.includes(table)) {
            console.error(`[BLOCKED] テーブル "${table}" の削除はシステムにより禁止されています`);
            throw new Error(`${table} の削除は許可されていません`);
        }
        console.warn(`[DELETE] ${table} id=${id} - 実行`);
        await this._request(`${table}?id=eq.${id}`, {
            method: 'DELETE'
        });
        return true;
    },
    async upsert(table, dataArray) {
        const res = await this._request(table, {
            method: 'POST',
            body: JSON.stringify(dataArray),
            headers: {
                'Prefer': 'return=representation,resolution=merge-duplicates'
            }
        });
        return res;
    },


    // --- RPC (サーバーサイド関数) ---
    async rpc(functionName, params = {}) {
        const url = `${SUPABASE_URL}/rest/v1/rpc/${functionName}`;
        const headers = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        };

        const savedSession = SessionStore.getItem('rakushift_user');
        if (savedSession) {
            try {
                const user = JSON.parse(savedSession);
                if (user.session_id) {
                    headers['x-session-id'] = user.session_id;
                }
                // 本部 (hq_admin) セッションで login_id が無い旧バージョン → 強制破棄して再ログインを促す
                // (新スキーマでは hq_login 時に login_id がセッションに保存される)
                if (user.role === 'hq_admin' && !user.login_id) {
                    console.warn('[Session] Old HQ session without login_id detected, clearing');
                    SessionStore.removeItem('rakushift_user');
                }
            } catch(e) {}
        }

        const res = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(params)
        });
        if (!res.ok) {
            const errText = await res.text();
            console.error(`RPC Error [${res.status}] ${functionName}:`, errText);
            throw new Error(`RPC失敗: ${functionName}`);
        }
        return await res.json();
    },
    // --- 事前チェック (人員不足の検出) ---
    async checkFeasibility(payload) {
        try {
            const res = await fetch(CHECK_API_URL, {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.check || null;
        } catch (e) {
            console.error("Check failed:", e);
            return null;
        }
    },


    // --- 計算エンジン連携 (Python Railway) ---
    // Gemini監査はサーバーサイドで実行 (APIキーをフロントに露出しない)
    async generateShifts(payload) {
        console.log("Starting shift generation process...");

        try {
            // contract_idをペイロードに追加 (サーバーがAPIキーを取得するため)
            const contractId = payload.config?.contract_id || null;

            const serverPayload = {
                staff_list: payload.staff_list,
                config: payload.config,
                dates: payload.dates,
                requests: payload.requests || [],
                mode: payload.mode || 'auto',
                contract_id: contractId,
                existing_shifts: payload.existing_shifts || []
            };

            const res = await fetch(CALC_API_URL, {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(serverPayload)
            });

            if (!res.ok) {
                throw new Error(`Python Server Error: ${res.statusText}`);
            }

            const result = await res.json();
            console.log("Server Result:", result);

            if (result.status === 'success' && Array.isArray(result.shifts)) {
                return {
                    status: "success",
                    shifts: result.shifts,
                    mode: result.mode || "python_optimized",
                    report: result.report || null
                };
            } else if (result.status === 'success' && result.mode === 'math_failed') {
                return { status: "success", shifts: [], mode: "math_failed", report: result.report || null };
            } else {
                throw new Error(result.message || "Invalid response from server");
            }

        } catch (e) {
            console.error("Shift Generation Error:", e);
            return { status: "error", message: e.message };
        }
    },

    async diagnose(payload) {
        try {
            const res = await fetch(DIAGNOSE_API_URL, {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error(`Server Error: ${res.status}`);
            const data = await res.json();
            return data.suggestions || [];
        } catch (e) {
            console.error("Diagnose Error:", e);
            throw e;
        }
    },

    // --- Stripe決済 API ---
    async createCheckout(contractId, plan = 'standard') {
        try {
            const res = await fetch(CALC_BASE_URL + '/stripe/create-checkout', {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contract_id: contractId,
                    plan: plan,
                    success_url: window.location.origin + '/index.html?payment=success',
                    cancel_url: window.location.origin + '/index.html?payment=cancelled'
                })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Checkout creation failed');
            }
            return await res.json();
        } catch (e) {
            console.error("Checkout Error:", e);
            throw e;
        }
    },

    // 新規申し込み用 (契約ID不要、メール+プランのみ)
    async createNewSubscription(email, orgName, plan = 'pro', contact = '', phone = '', address = '', referrerCode = '', contactPhone = '') {
        try {
            const res = await fetch(CALC_BASE_URL + '/stripe/new-subscription', {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: email,
                    org_name: orgName,
                    plan: plan,
                    contact_name: contact,
                    phone: phone,
                    contact_phone: contactPhone,
                    address: address,
                    referrer_code: referrerCode,
                    success_url: window.location.origin + '/index.html?payment=success&new=1',
                    cancel_url: window.location.origin + '/index.html?payment=cancelled'
                })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Subscription creation failed');
            }
            return await res.json();
        } catch (e) {
            console.error("New Subscription Error:", e);
            throw e;
        }
    },

    async createPortal(contractId) {
        try {
            const res = await fetch(CALC_BASE_URL + '/stripe/create-portal', {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contract_id: contractId,
                    return_url: window.location.href
                })
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Portal creation failed');
            }
            return await res.json();
        } catch (e) {
            console.error("Portal Error:", e);
            throw e;
        }
    },

    async getSubscriptionStatus(contractId) {
        try {
            const res = await fetch(CALC_BASE_URL + '/stripe/subscription-status/' + contractId, {
                credentials: 'omit'
            });
            if (!res.ok) return { status: 'unknown' };
            return await res.json();
        } catch (e) {
            console.error("Subscription Status Error:", e);
            return { status: 'unknown' };
        }
    }
};

window.API = API;
console.log("API Loaded (Supabase Mode)");
