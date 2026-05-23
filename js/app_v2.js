const app = {
    // セキュリティ: ログイン試行回数制限
    _loginAttempts: {},
    _MAX_LOGIN_ATTEMPTS: 5,
    _LOCKOUT_DURATION_MS: 5 * 60 * 1000, // 5分間ロックアウト

    // セキュリティ: 入力サニタイゼーション
    _sanitize(str) {
        if (typeof str !== 'string') return '';
        return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    },

    // パフォーマンス: 大量データの DOM 構築を1回の reflow に抑えるヘルパー
    // 5000件超のシフトを表示する将来の renderShiftTable 等で使用想定。
    // 旧 `container.innerHTML = html` 方式より 5-10倍高速。
    _setHTMLPerformant(container, html) {
        if (!container) return;
        const template = document.createElement('template');
        template.innerHTML = html;
        container.replaceChildren(template.content);
    },

    // パフォーマンス: シフトを「現在月の前後3ヶ月」に絞ってロードするためのヘルパー
    // 長期運用 (5年以上) でも初回ロードを 0.3秒程度に抑える
    _getShiftLoadRange(date) {
        const d = new Date(date || new Date());
        const from = new Date(d.getFullYear(), d.getMonth() - 3, 1);
        const to = new Date(d.getFullYear(), d.getMonth() + 4, 0); // +3月の最終日
        const fmt = (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
        return { from: fmt(from), to: fmt(to) };
    },

    // 表示中の月が既ロード範囲外の場合のみ shifts を再ロード (キャッシュ判定付き)
    // 範囲内なら何もしないため、頻繁な月切替でも DB 負荷ゼロ
    async ensureShiftsLoaded() {
        if (!this.state.organization_id) return;
        const target = this._getShiftLoadRange(this.state.currentDate);
        const loaded = this.state.loadedShiftRange;
        if (loaded && loaded.from <= target.from && loaded.to >= target.to) {
            return; // 既にロード済み範囲内
        }
        try {
            const res = await API.list('shifts', {
                organization_id: `eq.${this.state.organization_id}`,
                and: `(date.gte.${target.from},date.lte.${target.to})`
            });
            this.state.shifts = res.data || [];
            this.state.loadedShiftRange = target;
            console.log(`[Shifts] Reloaded ${this.state.shifts.length} for ${target.from}〜${target.to}`);
        } catch (e) {
            console.error('ensureShiftsLoaded failed:', e);
        }
    },

    // セキュリティ: ログイン試行チェック
    _checkLoginLock(key) {
        const record = this._loginAttempts[key];
        if (!record) return false;
        if (record.count >= this._MAX_LOGIN_ATTEMPTS) {
            const elapsed = Date.now() - record.lastAttempt;
            if (elapsed < this._LOCKOUT_DURATION_MS) {
                const remainSec = Math.ceil((this._LOCKOUT_DURATION_MS - elapsed) / 1000);
                this.showToast('ログイン試行回数の上限に達しました。' + remainSec + '秒後に再試行してください。', 'error');
                return true;
            }
            // ロックアウト期間が過ぎたのでリセット
            delete this._loginAttempts[key];
        }
        return false;
    },
    _recordLoginAttempt(key, success) {
        if (success) {
            delete this._loginAttempts[key];
            return;
        }
        if (!this._loginAttempts[key]) {
            this._loginAttempts[key] = { count: 0, lastAttempt: 0 };
        }
        this._loginAttempts[key].count++;
        this._loginAttempts[key].lastAttempt = Date.now();
    },

    // アプリケーションの状態管理
    state: {
        currentDate: null, // Initialized in init()
        view: 'dashboard', // 現在のビュー
        shiftViewMode: 'table', // 'table' or 'calendar'
        shiftTablePeriod: 'month', // 'month' | 'week' | 'day'
        dashboardMode: 'month', // 'month', '2week-1', '2week-2'
        isShopLoggedIn: false, // 店舗ログイン状態
        isAdmin: false, // 管理者ログイン状態
        isHQ: false, // 本部ログイン状態
        
        // データ（APIからロード）
        config: {},
        staff: [],
        shifts: [],
        requests: [],
        organization_id: null,
        
        // 設定デフォルト値
        defaultConfig: {
            // admin_password は config_safe ビューから除外済 (migration 40)
            // 変更は専用モーダル + update_admin_password_by_contract RPC のみ
            opening_time: "09:00",
            closing_time: "22:00",
            hourly_wage_default: 1100,
            
            // 営業時間（詳細）
            opening_times: {
                weekday: { start: "09:00", end: "22:00" },
                weekend: { start: "10:00", end: "20:00" },
                holiday: { start: "10:00", end: "20:00" }
            },

            // 定休日 (0=日, 1=月...)
            closed_days: [], 
            
            // 人員配置ルール（詳細）
            staff_req: {
                min_manager: 1,
                min_weekday: 2,
                min_weekend: 3,
                min_holiday: 3
            },
            
            // 役職設定 (ID, 名前, 色, レベル:高いほど権限強)
            roles: [
                { id: 'manager', name: '店長', color: 'purple', level: 5 },
                { id: 'sub_manager', name: '副店長', color: 'red', level: 4 },
                { id: 'employee', name: '社員', color: 'green', level: 3 },
                { id: 'leader', name: 'リーダー', color: 'blue', level: 2 },
                { id: 'staff', name: 'アルバイト', color: 'gray', level: 1 }
            ],

            // 臨時休業日 (YYYY-MM-DD)
            special_holidays: [],
            
            // 特定日の営業時間 (YYYY-MM-DD: {start, end, note})
            special_days: {},

            // 時間帯別人員ルール
            time_staff_req: [], // [{ days: [0,6], start: '11:00', end: '14:00', count: 4 }]

            // カレンダー備考 (YYYY-MM-DD: "メモ内容")
            calendar_notes: {},

            // 休憩時間ルール
            break_rules: [
                { min_hours: 6, break_minutes: 45 },
                { min_hours: 8, break_minutes: 60 }
            ],
            
            // お店のルール（自由記述）
            shop_rules_text: "希望休の提出は前月20日までにお願いします。\n急な欠勤の場合は、必ず店長まで直接連絡してください。\nシフトの変更希望は「休暇・シフト申請」ボタンから行えます。",

            // 旧互換
            // staffing_rules removed
            
            // カスタムシフト設定 (早番・遅番など)
            custom_shifts: [
                { name: "早番", start: "09:00", end: "17:00" },
                { name: "遅番", start: "17:00", end: "22:00" }
            ],
            
            special_days: {} 
        },

        
        // チャートインスタンス保持用
        dashboardChartInstance: null,
        // ダッシュボード自動更新用タイマー
        dashboardTimer: null
    },

    /**
     * ログインタブの切り替え
     */
    switchLoginTab(tabId) {
        const tabs = ['shop', 'admin', 'hq', 'platform'];
        tabs.forEach(t => {
            const btn = document.getElementById('tab-' + t);
            const form = document.getElementById('form-' + t);
            if (btn && form) {
                if (t === tabId) {
                    btn.classList.add('text-blue-600', 'border-blue-600', 'bg-white');
                    btn.classList.remove('text-gray-500', 'border-transparent', 'hover:bg-gray-100');
                    form.classList.remove('hidden');
                } else {
                    btn.classList.remove('text-blue-600', 'border-blue-600', 'bg-white');
                    btn.classList.add('text-gray-500', 'border-transparent', 'hover:bg-gray-100');
                    form.classList.add('hidden');
                }
            }
        });
        
        // 色の調整
        if (tabId === 'hq') {
            document.getElementById('tab-hq').classList.replace('text-blue-600', 'text-indigo-600');
            document.getElementById('tab-hq').classList.replace('border-blue-600', 'border-indigo-600');
        } else if (tabId === 'platform') {
            document.getElementById('tab-platform').classList.replace('text-blue-600', 'text-purple-600');
            document.getElementById('tab-platform').classList.replace('border-blue-600', 'border-purple-600');
        }
    },

    /**
     * 初期化処理
     */
    async init() {
        console.log("App initializing...");
        try {
            await API.init();

            // Use native Date to avoid external dependency issues
            this.state.currentDate = new Date();
            this.bindEvents();

            // Stripe決済完了時の処理
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('payment') === 'success') {
                setTimeout(() => this.showToast('決済が完了しました。プランが有効化されました。', 'success'), 1000);
                window.history.replaceState({}, '', window.location.pathname);
            } else if (urlParams.get('payment') === 'cancelled') {
                setTimeout(() => this.showToast('決済がキャンセルされました。', 'info'), 1000);
                window.history.replaceState({}, '', window.location.pathname);
            }

            // 本部観覧モード: admin.html から ?as_hq=<contract_id> で開かれた場合、
            // 該当テナントに自動的に「閲覧専用」として入る
            const asHq = urlParams.get('as_hq');
            if (asHq) {
                try {
                    await this._enterHQViewMode(asHq);
                } catch (e) {
                    console.error('[HQ View] failed:', e);
                    this.showToast('本部観覧モードの初期化に失敗しました', 'error');
                }
                window.history.replaceState({}, '', window.location.pathname);
            }
            
            // セッションチェック
            if (API.session) {
                console.log("Session found. Loading data...");
                
                // 【復元処理】
                // session内のuser情報から状態を復元する
                const user = API.session.user;
                if (user) {
                    // ライセンス状態チェック（セッション復元時）
                    if (user.contract_id) {
                        try {
                            const licenseCheck = await API.rpc('check_license_status', { p_contract_id: user.contract_id });
                            if (licenseCheck && !licenseCheck.allowed && licenseCheck.status === 'suspended') {
                                console.log('[Init] License suspended. Forcing logout.');
                                await API.logout();
                                this.state.isAdmin = false;
                                this.state.isShopLoggedIn = false;
                                this.renderCurrentView();
                                this.updateHeader();
                                this.openModal('loginModal');
                                this.showToast('ライセンスが停止中のため、自動ログアウトしました。運営までお問い合わせください。', 'error');
                                return;
                            }
                        } catch (e) {
                            console.warn('[Init] License check skipped:', e.message);
                        }
                    }

                    this.state.isShopLoggedIn = true;
                    // contract_id を優先的に復元
                    if (user.contract_id) {
                        this.state.organization_id = user.contract_id;
                    }
                    // 管理者かどうかの復元
                    if (user.role === 'admin' || user.role === 'Manager' || user.role === 'manager') {
                        this.state.isAdmin = true;
                    }
                }

                await this.loadData();
            } else {
                console.log("No session. Showing login modal.");
                // データをロードせず、空の状態で描画してからログインモーダルを出す
                this.state.isAdmin = false;
                this.state.isShopLoggedIn = false; // 明示的にfalse
                this.renderCurrentView();
                this.updateHeader();

                // ログインモーダルを表示（お知らせはサイドバーで確認する方式に統一）
                this.openModal('loginModal');
                
                const loadingEl = document.getElementById('viewContainer').querySelector('.loading-spinner')?.parentElement?.parentElement;
                if(loadingEl) loadingEl.innerHTML = ''; 
                return; // ここで終了
            }
            
        } catch (e) {
            // ... (error handling)
        } finally {
            this.updateAuthUI();
            this.renderCurrentView();
            this.updateHeader();
        }
    },

    /**
     * イベントリスナー登録
     */
    bindEvents() {
        const closeSidebar = () => {
            if (window.innerWidth < 768) {
                document.querySelector('aside')?.classList.add('-translate-x-full');
                document.getElementById('sidebarOverlay')?.classList.remove('active');
            }
        };

        document.querySelectorAll('.sidebar-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const view = e.currentTarget.dataset.view;
                this.changeView(view);
                closeSidebar();
            });
        });

        document.getElementById('mobileMenuBtn')?.addEventListener('click', () => {
            const aside = document.querySelector('aside');
            const overlay = document.getElementById('sidebarOverlay');
            aside.classList.toggle('-translate-x-full');
            if (aside.classList.contains('-translate-x-full')) {
                overlay?.classList.remove('active');
            } else {
                overlay?.classList.add('active');
            }
        });
        
        // Dynamic buttons (autoFill, aiAdvice) are bound in updateAuthUI()

        document.getElementById('authBtn')?.addEventListener('click', () => this.handleAuth());

        // ヘッダの期間ナビゲーション (← 月/期間 → / 今日)
        document.getElementById('prevPeriod')?.addEventListener('click', () => this.navigatePeriod(-1));
        document.getElementById('nextPeriod')?.addEventListener('click', () => this.navigatePeriod(1));
        document.getElementById('todayBtn')?.addEventListener('click', () => this.goToToday());

        // ヘッダの年/月ドロップダウン (任意の年月へ直接ジャンプ)
        this._initJumpDropdowns();
    },

    _initJumpDropdowns() {
        const ySel = document.getElementById('jumpYear');
        const mSel = document.getElementById('jumpMonth');
        if (!ySel || !mSel) return;
        const now = new Date();
        const baseYear = (this.state.currentDate || now).getFullYear();
        // 過去5年〜未来3年
        let yOpts = '';
        for (let y = baseYear - 5; y <= baseYear + 3; y++) {
            yOpts += `<option value="${y}">${y}年</option>`;
        }
        ySel.innerHTML = yOpts;
        let mOpts = '';
        for (let m = 1; m <= 12; m++) {
            mOpts += `<option value="${m}">${m}月</option>`;
        }
        mSel.innerHTML = mOpts;
        ySel.value = baseYear;
        mSel.value = (this.state.currentDate || now).getMonth() + 1;

        const onJump = () => {
            const y = parseInt(ySel.value, 10);
            const m = parseInt(mSel.value, 10) - 1;
            if (isNaN(y) || isNaN(m)) return;
            const d = new Date(this.state.currentDate || now);
            const day = Math.min(d.getDate(), new Date(y, m + 1, 0).getDate());
            d.setFullYear(y, m, day);
            this.state.currentDate = d;
            // 月モードなら1日揃え、週/日モードはそのまま
            if (this.state.view === 'manual-shift' && this.state.shiftTablePeriod === 'week') {
                d.setDate(d.getDate() - d.getDay());
                this.state.currentDate = d;
            } else if (!(this.state.view === 'manual-shift' && this.state.shiftTablePeriod === 'day')) {
                d.setDate(1);
                this.state.currentDate = d;
            }
            this.updateHeader();
            // 範囲外月への大ジャンプの場合に shifts を再ロード
            this.ensureShiftsLoaded().then(() => this.renderCurrentView());
        };
        ySel.addEventListener('change', onJump);
        mSel.addEventListener('change', onJump);
    },

    // 表示中ビュー/期間モードに応じた前後送り
    navigatePeriod(delta) {
        if (this.state.view === 'manual-shift' && this.state.shiftTablePeriod && this.state.shiftTablePeriod !== 'month') {
            this.changeTablePeriod(delta);
        } else {
            this.changeMonth(delta);
        }
    },

    goToToday() {
        const today = new Date();
        if (this.state.view === 'manual-shift' && this.state.shiftTablePeriod && this.state.shiftTablePeriod !== 'month') {
            // 週/2週モードは今日を含む週の日曜揃え
            const d = new Date(today);
            d.setDate(d.getDate() - d.getDay());
            this.state.currentDate = d;
        } else {
            this.state.currentDate = today;
        }
        this.updateHeader();
        this.ensureShiftsLoaded().then(() => this.renderCurrentView());
    },

    /**
     * データのロード
     */
    async loadData() {
        if (!this._shiftGenInProgress) this.showLoading(true);
        try {
            // 1. organization_id を確定する (セッション → localStorage の順)
            let orgId = null;

            if (API.session?.user?.organization_id) {
                orgId = API.session.user.organization_id;
            }
            if (!orgId && API.session?.user?.contract_id) {
                // contract_id からconfig_safeビューを引いてorganization_idを取得
                try {
                    const cRes = await API.list('config_safe', { contract_id: `eq.${API.session.user.contract_id}`, select: 'organization_id' });
                    if (cRes.data?.[0]?.organization_id) {
                        orgId = cRes.data[0].organization_id;
                    }
                } catch(e) { console.warn("Config lookup failed:", e); }
            }
            if (!orgId) {
                orgId = localStorage.getItem('rakushift_org_id') || this.state.organization_id;
            }

            // orgIdが無ければデータ取得不可 → ログイン画面へ
            if (!orgId) {
                console.error("No organization_id available. Cannot load data.");
                this.showLoading(false);
                this.openModal('loginModal');
                return;
            }

            this.state.organization_id = orgId;
            localStorage.setItem('rakushift_org_id', orgId);

            // 2. テナント分離: 全クエリにorganization_idフィルタを適用
            const orgFilter = { organization_id: `eq.${orgId}` };

            console.log(`Loading data for org: ${orgId}`);

            // シフトのみ「現在月の前後3ヶ月」に範囲限定してロード (長期累積によるロード遅延を予防)
            // 月切替で範囲外へ移動した時は ensureShiftsLoaded() で追加ロードする
            const shiftRange = this._getShiftLoadRange(this.state.currentDate || new Date());
            const shiftFilter = {
                ...orgFilter,
                and: `(date.gte.${shiftRange.from},date.lte.${shiftRange.to})`
            };
            this.state.loadedShiftRange = shiftRange;

            // staffは全カラム取得（存在しないカラム指定エラーを防ぐ）
            const staffSelect = '*';
            const [configRes, staffRes, shiftsRes, requestsRes] = await Promise.all([
                API.list('config_safe', orgFilter),
                API.list('staff', { ...orgFilter, select: staffSelect }),
                API.list('shifts', shiftFilter),
                API.list('requests', orgFilter)
            ]);

            // 3. configをマージ (DBの値を優先、足りない項目はデフォルトで補完)
            if (configRes.data && configRes.data.length > 0) {
                this.state.config = { ...this.state.defaultConfig, ...configRes.data[0] };
            } else {
                if (!this.state.config.id) {
                    console.log("No config in DB for this org, keeping defaults.");
                }
            }

            // 4. データをStateに保存
            this.state.staff = staffRes.data || [];
            this.state.shifts = shiftsRes.data || [];
            this.state.requests = requestsRes.data || [];

            console.log(`Loaded: ${this.state.staff.length} staff, ${this.state.shifts.length} shifts.`);
            this.updateRequestBadge();

            // スタッフ数がプラン上限を超えていたら警告
            if (this.isStaffOverLimit()) {
                this.showStaffOverLimitAlert();
            } else {
                this.clearStaffOverLimitAlert();
            }

            // 決済エラー状態なら警告表示
            if (this.state.config.subscription_status === 'past_due') {
                this.showPaymentAlert();
            }

        } catch (error) {
            console.error('Data Load Error:', error);
        } finally {
            if (!this._shiftGenInProgress) this.showLoading(false);
        }
    },

    handleAuth() {
        if (this.state.isAdmin) {
            // 管理者ログアウトのみ（店舗ログインは維持）
            if(confirm('管理者権限からログアウトしますか？')) {
                this.state.isAdmin = false;
                // セッション情報を更新（管理者情報を消す）
                const currentUser = API.session.user;
                // 契約情報は残すが、個人特定は消すイメージ（ここでは簡易的にisAdminフラグのみ操作）
                const shopUser = {
                    contract_id: currentUser.contract_id,
                    organization_id: currentUser.organization_id, // RLSフィルター用に維持
                    session_id: currentUser.session_id,           // セッションを維持
                    name: 'Guest (Staff)',
                    role: 'Guest'
                };
                API.setSession(shopUser);
                
                this.showToast('管理者からログアウトしました', 'info');
                this.updateAuthUI();
                this.updateHeader();
                this.changeView('dashboard');
            }
        } else {
            // 管理者ログインタブを開く
            this.switchLoginTab('admin');
            this.openModal('loginModal');
        }
    },

    /**
     * 契約者（店舗）ログイン処理 - RPC経由bcrypt認証
     */
    async login() {
        console.log('[ShopLogin] Login attempt started...');

        const contractIdEl = document.getElementById('loginContractId');
        const passwordEl = document.getElementById('loginShopPass');

        if (!contractIdEl) {
            app.showToast('エラー: 入力欄が見つかりません。ページを再読み込みしてください。', 'error');
            return;
        }

        const contractId = this._sanitize(contractIdEl.value.trim());
        const password = passwordEl ? passwordEl.value.trim() : '';

        if (!contractId || !password) {
            this.showToast('契約IDとパスワードを入力してください', 'error');
            return;
        }

        // セキュリティ: ブルートフォース対策
        if (this._checkLoginLock('shop_' + contractId)) return;

        this.showLoading(true);
        try {
            // 1. ライセンス・サブスクリプション状態チェック
            try {
                const subCheck = await API.rpc('check_subscription_status', { p_contract_id: contractId });
                if (subCheck && !subCheck.allowed) {
                    if (subCheck.status === 'suspended') {
                        this.showToast('このアカウントのライセンスは停止中です。運営までお問い合わせください。', 'error');
                        this.showLoading(false);
                        return;
                    } else if (subCheck.status === 'not_found') {
                        this.showToast('契約IDが見つかりません', 'error');
                        this.showLoading(false);
                        return;
                    } else if (subCheck.status === 'canceled' || subCheck.status === 'unpaid') {
                        this.showToast('サブスクリプションが無効です。プランを再度ご契約ください。', 'error');
                        this.showLoading(false);
                        return;
                    } else if (subCheck.status === 'past_due') {
                        this._paymentPastDue = true;
                    }
                }
                // サブスク未契約(free)の場合 → ログインは許可するが決済を促す
                if (subCheck && subCheck.status === 'free') {
                    this._pendingPayment = true;
                } else {
                    this._pendingPayment = false;
                }
            } catch (licenseErr) {
                console.warn('[ShopLogin] Subscription check skipped:', licenseErr.message);
            }

            // 2a. サーバ側レート制限チェック (RPC が無い古いDBでも壊れないように try)
            try {
                const rl = await API.rpc('can_attempt_login', { p_identifier: 'shop:' + contractId });
                if (rl && rl.allowed === false) {
                    const sec = rl.retry_after_seconds || 300;
                    this.showToast('ログイン試行回数の上限に達しました。' + sec + '秒後に再度お試しください。', 'error');
                    return;
                }
            } catch (_) { /* RPC 未デプロイ環境では握りつぶす */ }

            // 2b. bcrypt認証 (RPC経由)
            const authResult = await API.rpc('verify_shop_login', {
                p_contract_id: contractId,
                p_password: password
            });

            console.log('[ShopLogin] Auth result: success=', authResult?.success);

            if (authResult && authResult.success) {
                this._recordLoginAttempt('shop_' + contractId, true);
                try { await API.rpc('clear_login_failures', { p_identifier: 'shop:' + contractId }); } catch (_) {}
                this.state.isShopLoggedIn = true;
                this.state.isAdmin = false;
                this.state.organization_id = authResult.organization_id;

                API.setSession({
                    contract_id: authResult.contract_id,
                    organization_id: authResult.organization_id,
                    session_id: authResult.session_id,
                    name: 'Guest (Staff)',
                    role: 'Guest'
                });

                this.closeModal('loginModal');

                await this.loadData();
                this.updateAuthUI();
                this.updateHeader();

                // サブスク未契約の場合、決済を促す
                if (this._pendingPayment) {
                    this.showToast('ご利用にはプランの契約が必要です', 'warning');
                    this.changeView('settings');
                    setTimeout(() => {
                        const section = document.getElementById('subscriptionSection');
                        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 500);
                } else if (this._paymentPastDue) {
                    this.showToast(`契約ID: ${contractId} でログインしました`, 'success');
                    this.showPaymentAlert();
                } else {
                    this.showToast(`契約ID: ${contractId} でログインしました`, 'success');
                }

                // お知らせバッジを更新（サイドバーで確認する方式に統一）
                this.updateAnnouncementBadge();
            } else {
                this._recordLoginAttempt('shop_' + contractId, false);
                try { await API.rpc('record_login_failure', { p_identifier: 'shop:' + contractId }); } catch (_) {}
                this.showToast(authResult?.message || 'ログインに失敗しました', 'error');
            }

        } catch (error) {
            console.error('[ShopLogin] Error:', error);
            this.showToast(`ログイン処理中にエラーが発生しました: ${error.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    },


    /**
     * 管理者ログイン処理 - RPC経由bcrypt認証
     * 契約IDと管理者パスワードで直接ログイン可能
     * verify_admin_login → verify_shop_login → demo フォールバック
     */
    async adminLogin() {
        const password = document.getElementById('adminLoginPass')?.value.trim() || '';
        const inputContractId = this._sanitize(document.getElementById('adminLoginContractId')?.value.trim() || '');

        if (!inputContractId) {
            this.showToast('契約IDを入力してください', 'error');
            return;
        }
        if (!password) {
            this.showToast('管理者パスワードを入力してください', 'error');
            return;
        }

        if (this._checkLoginLock('admin_' + inputContractId)) return;

        this.showLoading(true);
        try {
            // サーバ側レート制限チェック
            try {
                const rl = await API.rpc('can_attempt_login', { p_identifier: 'admin:' + inputContractId });
                if (rl && rl.allowed === false) {
                    const sec = rl.retry_after_seconds || 300;
                    this.showToast('ログイン試行回数の上限に達しました。' + sec + '秒後に再度お試しください。', 'error');
                    return;
                }
            } catch (_) {}

            let authResult = null;
            let authMethod = 'none';
            let orgId = null;

            // 方法1: verify_admin_login RPC
            try {
                authResult = await API.rpc('verify_admin_login', {
                    p_contract_id: inputContractId,
                    p_login_id: 'admin',
                    p_password: password
                });
                if (authResult && authResult.success) {
                    authMethod = 'admin_rpc';
                    orgId = authResult.organization_id;
                }
            } catch (rpcErr) {
                console.warn('[AdminLogin] admin RPC failed:', rpcErr.message);
            }

            // 方法2: verify_shop_login で店舗認証
            if (authMethod === 'none') {
                try {
                    authResult = await API.rpc('verify_shop_login', {
                        p_contract_id: inputContractId,
                        p_password: password
                    });
                    if (authResult && authResult.success) {
                        authMethod = 'shop_rpc';
                        orgId = authResult.organization_id;
                    }
                } catch (shopErr) {
                    console.warn('[AdminLogin] shop RPC also failed:', shopErr.message);
                }
            }

            // 方法3は削除: config_safeルックアップによるフォールバック認証は
            // パスワード検証をバイパスするセキュリティリスクがあるため廃止。
            // RPC（verify_admin_login / verify_shop_login）が両方失敗した場合は
            // 認証失敗として扱う。

            if (authResult && authResult.success) {
                this._recordLoginAttempt('admin_' + inputContractId, true);
                try { await API.rpc('clear_login_failures', { p_identifier: 'admin:' + inputContractId }); } catch (_) {}
                this.state.isAdmin = true;
                this.state.isShopLoggedIn = true;
                this.state.organization_id = orgId;

                API.setSession({
                    id: authResult.staff_id,
                    contract_id: inputContractId,
                    organization_id: orgId,
                    session_id: authResult.session_id || ('admin_' + Date.now()),
                    name: authResult.name || '管理者',
                    role: authResult.role || 'admin'
                });

                this.closeModal('loginModal');
                await this.loadData();
                this.updateAuthUI();
                this.updateHeader();
                this.showToast(`管理者: ${this._sanitize(authResult.name || '管理者')} でログインしました`, 'success');
                this.updateAnnouncementBadge();
            } else {
                this._recordLoginAttempt('admin_' + inputContractId, false);
                try { await API.rpc('record_login_failure', { p_identifier: 'admin:' + inputContractId }); } catch (_) {}
                this.showToast(authResult?.message || '契約IDまたはパスワードが正しくありません', 'error');
            }

        } catch(e) {
            console.error('Admin Login Error:', e);
            this.showToast(`エラーが発生しました: ${e.message}`, 'error');
        } finally {
            this.showLoading(false);
        }
    },


    // =========================================================
    // 3店舗以上お問い合わせフォーム送信
    // =========================================================
    openPrivacyPolicy() {
        // 完全版プライバシーポリシーページを別タブで開く
        window.open('privacy.html', '_blank', 'noopener,noreferrer');
    },

    async submitMultiStoreInquiry() {
        // 個人情報取得の同意確認 (個人情報保護法 第17条)
        const consent = document.getElementById('inquiryConsent');
        if (consent && !consent.checked) {
            this.showToast('個人情報の取扱いについて同意が必要です', 'warning');
            consent.focus();
            return;
        }
        const company = document.getElementById('inquiryCompany')?.value.trim() || '';
        const address = document.getElementById('inquiryAddress')?.value.trim() || '';
        const phone = document.getElementById('inquiryPhone')?.value.trim() || '';
        const name = document.getElementById('inquiryName')?.value.trim() || '';
        const lightCount = document.getElementById('inquiryLightCount')?.value || '0';
        const standardCount = document.getElementById('inquiryStandardCount')?.value || '0';
        const premiumCount = document.getElementById('inquiryPremiumCount')?.value || '0';
        const message = document.getElementById('inquiryMessage')?.value.trim() || '';

        // 希望日取得
        const date1 = document.getElementById('inquiryDate1')?.value || '';
        const date2 = document.getElementById('inquiryDate2')?.value || '';
        const date3 = document.getElementById('inquiryDate3')?.value || '';

        // 時間帯ラジオ取得
        const timeSlot = document.querySelector('input[name="inquiryTimeSlot"]:checked')?.value || '';

        // バリデーション
        if (!company) { this.showToast('会社名を入力してください', 'error'); return; }
        if (!address) { this.showToast('会社住所を入力してください', 'error'); return; }
        if (!phone) { this.showToast('会社連絡先を入力してください', 'error'); return; }
        if (!name) { this.showToast('ご担当者名を入力してください', 'error'); return; }

        // プラン件数チェック（合計1件以上）
        const totalPlans = (parseInt(lightCount) || 0) + (parseInt(standardCount) || 0) + (parseInt(premiumCount) || 0);
        if (totalPlans === 0 && lightCount === '0' && standardCount === '0' && premiumCount === '0') {
            this.showToast('契約予定プランを1件以上選択してください', 'error'); return;
        }

        if (!date1) { this.showToast('第1希望日を選択してください', 'error'); return; }

        this.showLoading(true);
        try {
            // プランサマリー文字列を構築
            const planParts = [];
            if (lightCount !== '0') planParts.push(`ライトプラン ${lightCount}件`);
            if (standardCount !== '0') planParts.push(`スタンダードプラン ${standardCount}件`);
            if (premiumCount !== '0') planParts.push(`プレミアムプラン ${premiumCount}件`);
            const planSummary = planParts.join('、');

            // 連絡希望日程サマリー
            const dateParts = [date1];
            if (date2) dateParts.push(date2);
            if (date3) dateParts.push(date3);
            const scheduleSummary = [
                `希望日: ${dateParts.join(', ')}`,
                timeSlot ? `時間帯: ${timeSlot}` : ''
            ].filter(Boolean).join(' / ');

            const inquiryData = {
                company_name: this._sanitize(company),
                company_address: this._sanitize(address),
                phone: this._sanitize(phone),
                contact_name: this._sanitize(name),
                plan_summary: planSummary,
                light_plan_count: lightCount,
                standard_plan_count: standardCount,
                premium_plan_count: premiumCount,
                preferred_days: dateParts.join(','),
                preferred_time: timeSlot,
                schedule_summary: scheduleSummary,
                message: this._sanitize(message),
                status: 'new',
                created_at: new Date().toISOString()
            };

            // localStorageにバックアップ保存
            const pending = JSON.parse(localStorage.getItem('rakushift_pending_inquiries') || '[]');
            pending.push(inquiryData);
            localStorage.setItem('rakushift_pending_inquiries', JSON.stringify(pending));

            // Railwayサーバー経由でメール送信
            try {
                const serverUrl = RAKUSHIFT_CONFIG.CALC_SERVER_URL || '';
                const res = await fetch(`${serverUrl}/api/inquiry`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(inquiryData)
                });
                const result = await res.json();
                console.log('[Inquiry] Server response:', result);
            } catch (serverErr) {
                console.warn('[Inquiry] Server send failed:', serverErr.message);
            }

            // フォームリセット
            ['inquiryCompany', 'inquiryAddress', 'inquiryPhone', 'inquiryName', 'inquiryMessage', 'inquiryDate1', 'inquiryDate2', 'inquiryDate3'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            ['inquiryLightCount', 'inquiryStandardCount', 'inquiryPremiumCount'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '0';
            });
            const checkedRadio = document.querySelector('input[name="inquiryTimeSlot"]:checked');
            if (checkedRadio) checkedRadio.checked = false;

            this.closeModal('multiStoreInquiryModal');
            this.showToast('お問い合わせを受け付けました。担当者より1営業日以内にご連絡いたします。', 'success');
        } catch (e) {
            console.error('Inquiry Error:', e);
            this.showToast('送信に失敗しました。時間をおいて再度お試しください。', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // =========================================================
    // ログインタブ切り替え
    // =========================================================
    switchLoginTab(tab) {
        const tabs = ['admin', 'shop', 'hq', 'platform'];
        tabs.forEach(t => {
            const form = document.getElementById(`form-${t}`);
            const btn = document.getElementById(`tab-${t}`);
            if (form) form.classList.toggle('hidden', t !== tab);
            if (btn) {
                if (t === tab) {
                    btn.classList.add('text-blue-600', 'border-blue-600', 'bg-white');
                    btn.classList.remove('text-gray-500', 'border-transparent');
                } else {
                    btn.classList.remove('text-blue-600', 'border-blue-600', 'bg-white');
                    btn.classList.add('text-gray-500', 'border-transparent');
                }
            }
        });
    },

    signUpMode() {
        app.showToast('新規登録機能は現在メンテナンス中です。管理者に連絡してアカウントを発行してください。', 'error');
    },

    async hqLogin() {
        const loginId = this._sanitize((document.getElementById('loginHqId')?.value || '').trim());
        const password = document.getElementById('loginHqPass')?.value.trim() || '';
        if (!loginId || !password) {
            this.showToast('本部IDとパスワードを入力してください', 'error');
            return;
        }

        // セキュリティ: ブルートフォース対策
        if (this._checkLoginLock('hq_' + loginId)) return;

        this.showLoading(true);
        try {
            // サーバ側レート制限
            try {
                const rl = await API.rpc('can_attempt_login', { p_identifier: 'hq:' + loginId });
                if (rl && rl.allowed === false) {
                    const sec = rl.retry_after_seconds || 300;
                    this.showToast('ログイン試行回数の上限に達しました。' + sec + '秒後に再度お試しください。', 'error');
                    return;
                }
            } catch (_) {}

            let result = null;

            // RPC経由の認証のみ (migration 18 以降は hq_login RPC が必須)
            // 旧 HQ_ACCOUNTS フロントフォールバックは migration 適用済の現環境では不要なため削除
            // (削除前はフロントに rakushift_hq 等の固定パスワードが残っていてセキュリティリスク)
            try {
                result = await API.rpc('hq_login', { p_login_id: loginId, p_password: password });
            } catch (rpcErr) {
                console.error('[HQ] hq_login RPC failed:', rpcErr.message);
                result = { status: 'error', message: 'ログインサーバに接続できません。時間をおいて再試行してください。' };
            }

            if (result && result.status === 'success') {
                this._recordLoginAttempt('hq_' + loginId, true);
                try { await API.rpc('clear_login_failures', { p_identifier: 'hq:' + loginId }); } catch (_) {}
                this.state.isHQ = true;
                this.state.isAdmin = false;
                this.state.isShopLoggedIn = false;
                this.state.organization_id = null;
                
                API.setSession({
                    session_id: result.session_id || ('hq_' + Date.now()),
                    name: result.company_name || 'HQ Admin',
                    role: 'hq_admin',
                    login_id: result.login_id || loginId,           // get_hq_scope() で必要
                    is_global: !!result.is_global,
                    company_name: result.company_name || null,
                    scope_org_ids: result.scope_org_ids || []
                });

                this.closeModal('loginModal');
                this.showToast('本部としてログインしました', 'success');
                this.changeView('hq_dashboard');
                this.updateAuthUI();
                this.updateHeader();
            } else {
                this._recordLoginAttempt('hq_' + loginId, false);
                try { await API.rpc('record_login_failure', { p_identifier: 'hq:' + loginId }); } catch (_) {}
                this.showToast(result?.message || 'ログインに失敗しました', 'error');
            }
        } catch (e) {
            console.error(e);
            this.showToast('エラーが発生しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async logout() {
        if(!confirm('アプリケーションから完全にログアウトしますか？\n（ログイン画面に戻ります）')) return;
        
        await API.logout();
        // セキュリティ: 全ての認証状態を完全にクリア
        this.state.isAdmin = false;
        this.state.isShopLoggedIn = false;
        this.state.isHQ = false;
        this.state.organization_id = null;
        this.state.config = {};
        this.state.staff = [];
        this.state.shifts = [];
        this.state.requests = [];
        // セキュリティ: セッション関連のlocalStorageを全消去
        sessionStorage.removeItem('rakushift_user');
        sessionStorage.removeItem('supabase.auth.token');
        localStorage.removeItem('rakushift_org_id');
        this.showToast('ログアウトしました', 'info');
        this.updateAuthUI();
        this.changeView('dashboard'); 
        this.openModal('loginModal');
    },

    updateAuthUI() {
        const authBtn = document.getElementById('authBtn');
        const adminLinks = document.querySelectorAll('.admin-link');
        const adminHeader = document.getElementById('adminHeaderControls');

        // --- 本部（閲覧専用）モードの制御 ---
        if (this.state.isHQ) {
            if (authBtn) authBtn.classList.add('hidden');
            
            // 店舗が選択されている場合のみサイドバーメニューを表示
            const hasShop = !!this.state.organization_id;
            adminLinks.forEach(link => {
                if (hasShop) {
                    link.classList.remove('hidden');
                } else {
                    link.classList.add('hidden');
                }
            });

            if (adminHeader) {
                adminHeader.innerHTML = `
                    <div class="hidden md:flex items-center gap-2 mr-4 bg-indigo-50 border border-indigo-200 text-indigo-700 px-3 py-1.5 rounded text-xs font-bold shadow-sm">
                        <i class="fa-solid fa-eye"></i> 閲覧専用モード
                    </div>
                    <button onclick="app.changeView('hq_dashboard')" class="px-3 py-1.5 text-xs font-bold text-indigo-600 border border-indigo-200 hover:bg-indigo-50 rounded bg-white transition-all mr-2 shadow-sm">
                        <i class="fa-solid fa-list mr-1"></i>店舗一覧
                    </button>
                    <button onclick="app.hqLogout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all shadow-sm">
                        <i class="fa-solid fa-power-off mr-1"></i>ログアウト
                    </button>
                `;
            }

            // 閲覧専用: 編集系ボタンを隠す
            if (hasShop) {
                setTimeout(() => {
                    const actionKeywords = ['追加', '保存', '作成', '申請', '編集', '設定', '削除', '承認', '却下'];
                    document.querySelectorAll('button').forEach(btn => {
                        if (!btn.closest('#adminHeaderControls') && !btn.closest('#sidebar')) {
                            const txt = btn.textContent;
                            if (actionKeywords.some(kw => txt.includes(kw))) {
                                btn.classList.add('hidden');
                            }
                        }
                    });
                }, 100);
            }

            this.updateRequestBadge();
            this.updateAnnouncementBadge();
            return;
        }

        // サイドバーの「管理者ログイン」ボタンの表示
        if (authBtn) {
            if (this.state.isAdmin) {
                authBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket w-6 text-center"></i> 管理者ログアウト';
                authBtn.classList.remove('text-blue-600', 'hover:bg-blue-50');
                authBtn.classList.add('text-red-600', 'hover:bg-red-50');
            } else {
                authBtn.innerHTML = '<i class="fa-solid fa-user-shield w-6 text-center"></i> 管理者ログイン';
                authBtn.classList.add('text-blue-600', 'hover:bg-blue-50');
                authBtn.classList.remove('text-red-600', 'hover:bg-red-50');
            }
        }
        
        // 管理者専用メニューの表示切り替え
        adminLinks.forEach(link => {
            if (this.state.isAdmin) {
                link.classList.remove('hidden');
            } else {
                link.classList.add('hidden');
            }
        });

        // ヘッダーへの管理者コントロール注入
        if (adminHeader) {
            if (this.state.isAdmin) {
                adminHeader.innerHTML = `
                    <button onclick="app.logout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all ml-2">
                        <i class="fa-solid fa-power-off mr-1"></i>ログアウト
                    </button>
                `;
            } else {
                // スタッフモード（閲覧のみ）のときはヘッダーに契約IDと完全ログアウトボタンを表示
                if (this.state.isShopLoggedIn) {
                     adminHeader.innerHTML = `
                        <div class="hidden md:block px-3 py-1 text-xs font-mono text-gray-400 border border-gray-200 rounded bg-gray-50 mr-2">
                            ID: ${this.state.organization_id}
                        </div>
                        <button onclick="app.logout()" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded bg-white transition-all">
                            <i class="fa-solid fa-power-off mr-1"></i>ログアウト
                        </button>
                     `;
                } else {
                    adminHeader.innerHTML = '';
                }
            }
        }
        
        // メニューバッジなどの更新
        this.updateRequestBadge();
        this.updateAnnouncementBadge();
    },

    changeView(viewName) {
        // タイマークリア
        if (this.state.dashboardTimer) {
            clearInterval(this.state.dashboardTimer);
            this.state.dashboardTimer = null;
        }

        this.state.view = viewName;
        document.querySelectorAll('.sidebar-link').forEach(link => {
            if (link.dataset.view === viewName) {
                link.classList.add('active', 'bg-blue-50', 'text-blue-600');
                link.classList.remove('text-gray-600', 'hover:bg-gray-50');
            } else {
                link.classList.remove('active', 'bg-blue-50', 'text-blue-600');
                link.classList.add('text-gray-600', 'hover:bg-gray-50');
            }
        });
        this.renderCurrentView();
    },

    changeMonth(delta) {
        this.state.currentDate.setMonth(this.state.currentDate.getMonth() + delta);
        this.updateHeader();
        this.ensureShiftsLoaded().then(() => this.renderCurrentView());
    },

    updateHeader() {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth() + 1;
        const display = document.getElementById('currentPeriodDisplay');
        if(display) display.textContent = `${year}年 ${month}月`;
        // 年月ドロップダウンも追従
        const ySel = document.getElementById('jumpYear');
        const mSel = document.getElementById('jumpMonth');
        if (ySel && mSel) {
            // 範囲外の年を表示する場合は option を追加
            if (!Array.from(ySel.options).some(o => o.value === String(year))) {
                const opt = document.createElement('option');
                opt.value = year; opt.textContent = `${year}年`;
                ySel.appendChild(opt);
            }
            ySel.value = year;
            mSel.value = month;
        }
        this.calculateMonthlyStats();
    },

    renderCurrentView() {
        const container = document.getElementById('viewContainer');
        container.innerHTML = '';

        switch (this.state.view) {
            case 'hq_dashboard':
                this.renderHQDashboard(container);
                break;
            case 'dashboard':
                this.renderDashboard(container);
                break;
            case 'manual-shift':
                this.renderShiftView(container);
                break;
            case 'staff':
                this.renderStaffList(container);
                break;
            case 'requests':
                this.renderRequests(container);
                break;
            case 'analytics':
                this.renderAnalytics(container);
                break;
            case 'settings':
                this.renderSettings(container);
                break;
            case 'manual':
                this.renderManual(container);
                break;
            case 'hq_manual':
                this.renderHQManual(container);
                break;
            case 'announcements':
                this.renderAnnouncementsAdmin(container);
                break;
            default:
                this.renderDashboard(container);
        }
    },

    // --- 開発者用ツール (Dev Tools) ---
    async devCreateTestData() {
        // 1. マスターアカウントチェック
        const currentUser = API.session?.user?.email;
        console.log("Current user:", currentUser);
        if (currentUser !== 'master@mochikuro.com') {
            app.showToast('現在のアカウントではこの機能を使用できません。管理者のみ実行可能です。', 'error');
            return;
        }

        // 削除確認ではなく「データ整備」の確認に変更
        if (!confirm("【開発者用】テストデータを整備しますか？\n※既存データは保持され、不足しているスタッフや設定が補充されます。")) return;
        
        this.showLoading(true);
        try {
            // 2. 組織IDの確保と検証 (自己修復ロジック)
            let orgId = this.state.organization_id || localStorage.getItem('rakushift_org_id');
            let isValidOrg = false;

            // IDを持っている場合、DBに実在するか確認
            if (orgId) {
                try {
                    const check = await API.list('organizations', { id: `eq.${orgId}` });
                    if (check.data && check.data.length > 0) isValidOrg = true;
                } catch(e) { console.warn("Org check failed", e); }
            }

            // 無効または持っていない場合、再取得・作成
            if (!isValidOrg) {
                console.log("Org ID is invalid or missing. Repairing...");
                const orgRes = await API.list('organizations');
                if (orgRes && orgRes.data && orgRes.data.length > 0) {
                    orgId = orgRes.data[0].id; // 既存のものを採用
                } else {
                    console.log("No organizations found. Creating new...");
                    const newOrg = await API.create('organizations', { name: 'Test Shop' });
                    orgId = newOrg?.id;
                }
                
                // 新しいIDを保存
                if (orgId) {
                    this.state.organization_id = orgId;
                    localStorage.setItem('rakushift_org_id', orgId);
                    
                    // プロフィールも強制更新して紐付け直す
                    const userId = API.session?.user?.id;
                    if (userId) {
                        await API.update('profiles', userId, { organization_id: orgId }).catch(e=>{});
                    }
                } else {
                    throw new Error("組織IDの生成に失敗しました。");
                }
            }

            // 3. 既存データの確認 (全削除はしない)
            const allStaffRes = await API.list('staff', { organization_id: `eq.${orgId}` });
            const currentStaff = allStaffRes.data || [];
            
            // 4. 不足分の補充
            // 少なくとも10名は確保したい
            const targetCount = 13;
            const currentCount = currentStaff.length;
            
            if (currentCount < targetCount) {
                this.showToast(`スタッフを補充中... (${currentCount} -> ${targetCount}名)`, 'info');
                
                // 補充用テンプレート (シフトが埋まりやすい「最強バイト」を含める)
                // ランクA-D, 年間休日対応
                const templates = [
                    { name: "【万能】佐藤 (店長)", role: 'manager', max_days: 5, max_hours: 8, wage: 1500, eval: 'A', salary_type: 'monthly', holidays: 105 }, 
                    { name: "【万能】鈴木 (副店長)", role: 'manager', max_days: 5, max_hours: 8, wage: 1400, eval: 'A', salary_type: 'monthly', holidays: 110 },
                    { name: "高橋 (リーダー)", role: 'leader', max_days: 5, max_hours: 8, wage: 1300, eval: 'B', salary_type: 'monthly', holidays: 120 },
                    { name: "田中 (フル)", role: 'staff', max_days: 5, max_hours: 8, wage: 1100, eval: 'B' },
                    { name: "渡辺 (フル)", role: 'staff', max_days: 5, max_hours: 8, wage: 1100, eval: 'B' },
                    { name: "フリーターA (長時間)", role: 'staff', max_days: 5, max_hours: 8, wage: 1200, eval: 'C' }, 
                    { name: "フリーターB (長時間)", role: 'staff', max_days: 5, max_hours: 8, wage: 1200, eval: 'C' },
                    { name: "学生C (夕方)", role: 'staff', max_days: 4, max_hours: 5, wage: 1000, eval: 'D' },
                    { name: "学生D (夕方)", role: 'staff', max_days: 4, max_hours: 5, wage: 1000, eval: 'D' },
                    { name: "主婦E (昼)", role: 'staff', max_days: 4, max_hours: 6, wage: 1050, eval: 'C' },
                    { name: "主婦F (昼)", role: 'staff', max_days: 4, max_hours: 6, wage: 1050, eval: 'C' },
                    { name: "週末G (土日)", role: 'staff', max_days: 2, max_hours: 8, wage: 1100, eval: 'D' },
                    { name: "新人H", role: 'staff', max_days: 3, max_hours: 4, wage: 950, eval: 'D' }
                ];

                // 足りない人数分だけ追加
                const addCount = targetCount - currentCount;
                const createdStaff = [];
                
                // 直列実行で確実にIDを紐付ける
                for (let i = 0; i < addCount; i++) {
                    const tmpl = templates[i % templates.length];
                    const uniqueName = currentCount > 0 ? `${tmpl.name} ${i+1}` : tmpl.name;
                    
                    // 個別の作成エラーをキャッチせず、失敗したら全体を止める
                    const data = {
                        name: uniqueName,
                        role: tmpl.role,
                        evaluation: tmpl.eval || 'B',
                        salary_type: tmpl.salary_type || 'hourly',
                        hourly_wage: tmpl.wage,
                        monthly_salary: tmpl.salary_type === 'monthly' ? 250000 : 0,
                        max_days_week: tmpl.max_days,
                        max_hours_day: tmpl.max_hours,
                        min_days_week: 0,
                        min_days_month: 0,
                        organization_id: orgId
                    };
                    if (tmpl.holidays) {
                        data.annual_holidays = tmpl.holidays; // ここで保存
                    }

                    const res = await API.create('staff', data);
                    
                    if (!res) {
                        throw new Error(`スタッフ「${uniqueName}」のDB保存に失敗しました。RLS設定を確認してください。`);
                    }
                    createdStaff.push(res);
                }
                
                // State更新 (既存 + 新規)
                this.state.staff = [...currentStaff, ...createdStaff];
                
                // 画面更新 (リロードなしで即時反映)
                this.renderCurrentView();
                this.showToast(`完了！ ${this.state.staff.length}名のスタッフを表示中`, 'success');
                
            } else {
                this.showToast('スタッフ数は十分です (データ維持)', 'success');
                this.state.staff = currentStaff;
            }

            // 5. 設定データの修復 (空の場合のみ)
            if (!this.state.config.id) {
                // configはcreate_tenant RPCで作成されるため、ここでは再読み込みのみ
                const confRes = await API.list('config_safe', { organization_id: `eq.${orgId}` });
                if(confRes.data?.[0]) this.state.config = { ...this.state.defaultConfig, ...confRes.data[0] };
            }

            this.renderCurrentView();
            this.showToast(`データ整備完了。現在のスタッフ: ${this.state.staff.length}名`, 'success');
            
        } catch(e) {
            console.error("Test data setup failed:", e);
            app.showToast('エラーが発生しました: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // =================================================================
    // =================================================================
    // HQ (本部) ダッシュボード
    // =================================================================
    async renderHQDashboard(container) {
        if (!this.state.isHQ) return;

        this.showLoading(true);
        let shops = [];
        try {
            // バックエンド(Railway)経由で取得（サービスキーでRLSバイパス）
            const backendUrl = RAKUSHIFT_CONFIG?.CALC_SERVER_URL || 'https://rakushift-ai-production.up.railway.app';
            const sessionData = JSON.parse(sessionStorage.getItem('rakushift_user') || '{}');
            const res = await fetch(`${backendUrl}/hq/shops`, {
                headers: {
                    'x-session-id': sessionData.session_id || '',
                    'Content-Type': 'application/json'
                }
            });
            if (res.ok) {
                shops = await res.json();
            } else {
                throw new Error('Backend returned ' + res.status);
            }
        } catch (backendErr) {
            console.warn('[HQ] Backend fallback failed:', backendErr.message);
            // フォールバック: Supabase RPC
            try {
                const result = await API.rpc('hq_get_all_shops', {});
                shops = result || [];
            } catch (rpcErr) {
                console.warn('[HQ] RPC also failed:', rpcErr.message);
                this.showToast('店舗一覧の取得に失敗しました', 'error');
            }
        } finally {
            this.showLoading(false);
        }

        const planLabels = { standard: 'Standard', pro: 'Pro', premium: 'Premium', oem: 'OEM', free: '未契約' };
        const planColors = { standard: 'bg-blue-100 text-blue-800', pro: 'bg-green-100 text-green-800', premium: 'bg-purple-100 text-purple-800', oem: 'bg-amber-100 text-amber-800', free: 'bg-gray-100 text-gray-500' };

        // ローカルストレージに保存されている店舗のみ表示（入力しない限り見えない）
        let savedOrgIds = [];
        try {
            savedOrgIds = JSON.parse(localStorage.getItem('hq_saved_shops') || '[]');
        } catch(e) {}
        shops = shops.filter(shop => savedOrgIds.includes(shop.id) || savedOrgIds.includes(shop.organization_id));

        let tableRows = '';
        if (shops.length === 0) {
            tableRows = `<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500">登録されている店舗がありません</td></tr>`;
        } else {
            tableRows = shops.map(shop => {
                const date = new Date(shop.created_at);
                const dateStr = `${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')}`;
                const plan = shop.plan || 'free';
                const status = shop.license_status || 'active';
                const statusBadge = status === 'active'
                    ? '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-700">稼働中</span>'
                    : '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-600">停止</span>';
                return `
                <tr class="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                    <td class="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600">
                                <i class="fa-solid fa-store"></i>
                            </div>
                            <div>
                                <span class="font-bold">${this._sanitize(shop.name || '未設定')}</span>
                                ${shop.contact_name ? `<div class="text-xs text-gray-400">${this._sanitize(shop.contact_name)}</div>` : ''}
                            </div>
                        </div>
                    </td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">${this._sanitize(shop.contract_id || '—')}</td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm">
                        <span class="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${planColors[plan] || planColors.free}">
                            ${planLabels[plan] || plan}
                        </span>
                    </td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-center text-gray-700">${shop.staff_count || 0}名</td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-center">${statusBadge}</td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-400">${dateStr}</td>
                    <td class="px-4 py-4 whitespace-nowrap text-sm text-center font-medium space-x-2">
                        <button onclick="app.switchToHQShop('${shop.organization_id || shop.id}')" class="text-indigo-600 hover:text-indigo-900 font-bold">
                            <i class="fa-solid fa-eye"></i> 閲覧
                        </button>
                        <button onclick="app.removeHQShop('${shop.organization_id || shop.id}')" class="text-red-600 hover:text-red-900 font-bold ml-2">
                            <i class="fa-solid fa-trash"></i> 削除
                        </button>
                    </td>
                </tr>
            `}).join('');
        }

        container.innerHTML = `
            <div class="max-w-6xl mx-auto space-y-6 pb-20">
                <div class="bg-gradient-to-r from-indigo-600 to-blue-600 rounded-2xl shadow-lg p-6 md:p-8 text-white flex justify-between items-center relative overflow-hidden">
                    <div class="relative z-10">
                        <h2 class="text-2xl md:text-3xl font-bold mb-2"><i class="fa-solid fa-building mr-2"></i>本部・ダッシュボード</h2>
                        <p class="text-indigo-100 text-sm md:text-base">店舗にアクセスするには、下記の入力フォームから契約IDとパスワードを入力してください。</p>
                    </div>
                    <div class="relative z-10 flex flex-wrap gap-2 md:gap-3">
                        <button onclick="app.changeView('hq_manual')" class="bg-white/20 hover:bg-white/30 backdrop-blur text-white px-3 py-2 rounded-lg font-bold text-sm transition flex items-center gap-1.5">
                            <i class="fa-solid fa-book"></i> 本部マニュアル
                        </button>
                        <button onclick="app.openHQPasswordChange()" class="bg-white/20 hover:bg-white/30 backdrop-blur text-white px-3 py-2 rounded-lg font-bold text-sm transition flex items-center gap-1.5">
                            <i class="fa-solid fa-key"></i> パスワード変更
                        </button>
                        <button onclick="app.hqLogout()" class="bg-white/20 hover:bg-white/30 backdrop-blur text-white px-3 py-2 rounded-lg font-bold text-sm transition flex items-center gap-1.5">
                            <i class="fa-solid fa-right-from-bracket"></i> ログアウト
                        </button>
                    </div>
                    <div class="absolute right-0 top-0 opacity-10 text-[120px] leading-none transform translate-x-1/4 -translate-y-1/4 pointer-events-none">
                        <i class="fa-solid fa-globe"></i>
                    </div>
                </div>

                <!-- Manual Shop Login Card -->
                <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="px-6 py-4 border-b border-gray-200 bg-gray-50">
                        <h3 class="font-bold text-gray-800"><i class="fa-solid fa-key text-blue-500 mr-2"></i>指定の店舗を閲覧 (IDとパスワードでアクセス)</h3>
                    </div>
                    <div class="p-6">
                        <div class="flex flex-col md:flex-row gap-4 items-end">
                            <div class="flex-1">
                                <label class="block text-xs font-bold text-gray-500 mb-1">契約ID</label>
                                <input type="text" id="hqManualContractId" class="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="例: 123456789012345">
                            </div>
                            <div class="flex-1">
                                <label class="block text-xs font-bold text-gray-500 mb-1">パスワード</label>
                                <input type="password" id="hqManualPassword" class="w-full px-4 py-2 rounded-xl border border-gray-300 focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="店舗用または管理者パスワード" onkeydown="if(event.key==='Enter') app.hqManualShopLogin()">
                            </div>
                            <div>
                                <button onclick="app.hqManualShopLogin()" class="w-full md:w-auto px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow transition whitespace-nowrap">
                                    <i class="fa-solid fa-eye mr-2"></i>閲覧する
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="px-6 py-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800"><i class="fa-solid fa-list text-gray-400 mr-2"></i>登録店舗一覧 (${shops.length}店舗)</h3>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="min-w-full divide-y divide-gray-200">
                            <thead class="bg-gray-50">
                                <tr>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">店舗名</th>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">契約ID</th>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">プラン</th>
                                    <th scope="col" class="px-4 py-3 text-center text-xs font-bold text-gray-500 uppercase tracking-wider">スタッフ</th>
                                    <th scope="col" class="px-4 py-3 text-center text-xs font-bold text-gray-500 uppercase tracking-wider">状態</th>
                                    <th scope="col" class="px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider">登録日</th>
                                    <th scope="col" class="px-4 py-3 text-center text-xs font-bold text-gray-500 uppercase tracking-wider">操作</th>
                                </tr>
                            </thead>
                            <tbody class="bg-white divide-y divide-gray-200">
                                ${tableRows}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    },

    async hqManualShopLogin() {
        if (!this.state.isHQ) return;
        
        const contractId = document.getElementById('hqManualContractId')?.value.trim();
        const password = document.getElementById('hqManualPassword')?.value.trim();

        if (!contractId || !password) {
            this.showToast('契約IDとパスワードを入力してください', 'warning');
            return;
        }

        this.showLoading(true);
        try {
            // 店舗のパスワード（スタッフまたは管理者）を検証
            // 管理者パスワードでも通るように、まず shop login、ダメなら admin login を試すか、shop login で一元化
            // 今回は店舗用ログインを試す
            const authResult = await API.rpc('verify_shop_login', {
                p_contract_id: contractId,
                p_password: password
            });

            if (authResult && authResult.success) {
                // Save to localStorage
                try {
                    let savedOrgIds = JSON.parse(localStorage.getItem('hq_saved_shops') || '[]');
                    if (!savedOrgIds.includes(authResult.organization_id)) {
                        savedOrgIds.push(authResult.organization_id);
                        localStorage.setItem('hq_saved_shops', JSON.stringify(savedOrgIds));
                    }
                } catch(e) {}

                this.state.organization_id = authResult.organization_id;
                this.state.isAdmin = true;
                this.state.isShopLoggedIn = true;
                await this.loadData();
                this.showToast('店舗 (' + contractId + ') の閲覧を開始します', 'success');
                this.updateAuthUI();
                this.changeView('dashboard');
            } else {
                // 管理者として試す
                const adminResult = await API.rpc('verify_admin_login', {
                    p_contract_id: contractId,
                    p_login_id: 'admin',
                    p_password: password
                });

                if (adminResult && adminResult.success) {
                    // Save to localStorage
                    try {
                        let savedOrgIds = JSON.parse(localStorage.getItem('hq_saved_shops') || '[]');
                        if (!savedOrgIds.includes(adminResult.organization_id)) {
                            savedOrgIds.push(adminResult.organization_id);
                            localStorage.setItem('hq_saved_shops', JSON.stringify(savedOrgIds));
                        }
                    } catch(e) {}

                    this.state.organization_id = adminResult.organization_id;
                    this.state.isAdmin = true;
                    this.state.isShopLoggedIn = true;
                    await this.loadData();
                    this.showToast('管理者権限で店舗 (' + contractId + ') の閲覧を開始します', 'success');
                    this.updateAuthUI();
                    this.changeView('dashboard');
                } else {
                    this.showToast('IDまたはパスワードが正しくありません', 'error');
                }
            }
        } catch(e) {
            console.error('HQ Manual Shop Login error:', e);
            this.showToast('エラーが発生しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    removeHQShop(orgId) {
        if (!confirm('この店舗をリストから削除しますか？\n(※データベースのデータは削除されません)')) return;
        try {
            let savedOrgIds = JSON.parse(localStorage.getItem('hq_saved_shops') || '[]');
            savedOrgIds = savedOrgIds.filter(id => id !== orgId);
            localStorage.setItem('hq_saved_shops', JSON.stringify(savedOrgIds));
            this.showToast('店舗をリストから削除しました', 'info');
            this.renderCurrentView();
        } catch(e) {
            console.error('Failed to remove shop', e);
        }
    },

    async switchToHQShop(orgId) {
        if (!this.state.isHQ) return;
        this.showLoading(true);
        try {
            this.state.organization_id = orgId;
            this.state.isAdmin = true;
            this.state.isShopLoggedIn = true;
            await this.loadData();
            this.showToast('店舗情報を読み込みました（閲覧専用モード）', 'success');
            this.updateAuthUI();
            this.changeView('dashboard');
        } catch(e) {
            console.error('Shop loading error:', e);
            this.showToast('店舗情報の読み込みに失敗しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // admin.html → openTenantView(contract_id) → index.html?as_hq=<contract_id> から呼ばれる。
    // ローカルの本部セッション (rakushift_user.role='hq_admin') を確認し、
    // 該当 contract_id が本部の scope_org_ids に含まれるかチェックしてから閲覧モードに入る。
    async _enterHQViewMode(contractId) {
        // 既に本部としてセッションがあるか確認
        let sess = null;
        try {
            const raw = sessionStorage.getItem('rakushift_user') || localStorage.getItem('rakushift_user');
            if (raw) sess = JSON.parse(raw);
        } catch (_) {}

        if (!sess || sess.role !== 'hq_admin') {
            this.showToast('本部観覧モードには本部ログインが必要です。本部ログインしてからご利用ください。', 'warning');
            return;
        }

        // login_id undefined の古いセッションは強制再ログイン
        if (!sess.login_id) {
            this.showToast('セッションが古いため再ログインしてください', 'warning');
            sessionStorage.removeItem('rakushift_user');
            localStorage.removeItem('rakushift_user');
            return;
        }

        this.state.isHQ = true;
        API.setSession(sess);

        // contract_id → organization_id 解決
        let orgId = null;
        try {
            const rows = await API.list('config_safe', { contract_id: `eq.${contractId}`, select: 'organization_id', limit: 1 });
            if (Array.isArray(rows) && rows[0]) orgId = rows[0].organization_id;
        } catch (e) {
            console.error('[HQ View] resolve org_id failed:', e);
        }

        if (!orgId) {
            this.showToast('指定されたテナントが見つかりません', 'error');
            return;
        }

        // スコープチェック: グローバル本部以外は scope_org_ids に含まれる店舗のみ可
        // (サーバ側 RLS でも弾かれるが、フロント側でも明示)
        if (sess.is_global !== true) {
            const scope = Array.isArray(sess.scope_org_ids) ? sess.scope_org_ids : [];
            if (!scope.includes(orgId)) {
                this.showToast('この店舗は貴社の管轄外のため閲覧できません', 'error');
                return;
            }
        }

        await this.switchToHQShop(orgId);
        // ヘッダーに本部観覧モードのバナー表示
        setTimeout(() => this.showToast('🔍 本部観覧モード — 編集操作はサーバ側でも遮断されます', 'info'), 800);
    },

    // 本部ログアウト（confirmなしで即時実行）
    hqLogout() {
        this.state.isHQ = false;
        this.state.isAdmin = false;
        this.state.isShopLoggedIn = false;
        this.state.organization_id = null;
        this.state.config = {};
        this.state.staff = [];
        this.state.shifts = [];
        this.state.requests = [];
        API.setSession(null);
        sessionStorage.removeItem('rakushift_user');
        localStorage.removeItem('rakushift_org_id');
        localStorage.removeItem('hq_saved_shops');
        window.location.reload();
    },

    // 1. ダッシュボード (Dashboard)
    // =================================================================
    renderDashboard(container) {
        // タイマークリア（念のため）
        if (this.state.dashboardTimer) {
            clearInterval(this.state.dashboardTimer);
            this.state.dashboardTimer = null;
        }

        const todayStr = new Date().toISOString().split('T')[0];
        const pendingCount = this.state.requests.filter(r => r.status === 'pending').length;
        const chartData = this.getDashboardChartData();

        const todayShiftsInitial = this.state.shifts.filter(s => s.date === todayStr);

        container.innerHTML = `
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                <!-- 左カラム -->
                <div class="lg:col-span-2 space-y-6">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <!-- 承認待ち (管理者の場合のみクリック可) -->
                        <div class="bg-white p-4 rounded-xl shadow-sm border ${pendingCount > 0 ? 'border-red-200 bg-red-50' : 'border-gray-200'} ${this.state.isAdmin ? 'cursor-pointer hover:scale-[1.02]' : ''} transition-transform" ${this.state.isAdmin ? `onclick="app.changeView('requests')"` : ''}>
                            <div class="flex justify-between items-start">
                                <div>
                                    <p class="text-xs font-bold text-gray-500 uppercase">未承認の申請</p>
                                    <h3 class="text-2xl font-bold ${pendingCount > 0 ? 'text-red-600' : 'text-gray-700'}">${pendingCount} <span class="text-sm text-gray-500">件</span></h3>
                                </div>
                                <div class="w-10 h-10 rounded-full ${pendingCount > 0 ? 'bg-red-100 text-red-500' : 'bg-gray-100 text-gray-400'} flex items-center justify-center">
                                    <i class="fa-solid fa-inbox"></i>
                                </div>
                            </div>
                            ${this.state.isAdmin ? (pendingCount > 0 ? '<p class="text-xs text-red-500 mt-2 font-bold">確認してください</p>' : '<p class="text-xs text-gray-400 mt-2">対応は完了しています</p>') : '<p class="text-xs text-gray-400 mt-2">※管理人のみ閲覧可能</p>'}
                        </div>

                        <!-- 本日のスタッフ数 -->
                        <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                             <div class="flex justify-between items-start">
                                <div>
                                    <p class="text-xs font-bold text-gray-500 uppercase">本日の出勤</p>
                                    <h3 class="text-2xl font-bold text-blue-600">${todayShiftsInitial.length} <span class="text-sm text-gray-500">名</span></h3>
                                </div>
                                <div class="w-10 h-10 rounded-full bg-blue-50 text-blue-500 flex items-center justify-center">
                                    <i class="fa-solid fa-users"></i>
                                </div>
                            </div>
                            <p class="text-xs text-gray-400 mt-2">営業時間: ${this.state.config.opening_time || '09:00'} - ${this.state.config.closing_time || '22:00'}</p>
                        </div>
                    </div>

                    <!-- 今日のシフトリスト -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                        <div class="p-4 border-b border-gray-100 flex justify-between items-center">
                            <h3 class="font-bold text-gray-800 flex items-center gap-2">
                                <i class="fa-regular fa-calendar-check text-blue-500"></i> 今日のシフト詳細
                            </h3>
                            <span class="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-1 rounded" id="dashboardCurrentTime">${todayStr}</span>
                        </div>
                        
                        <div id="dashboardShiftList" class="divide-y divide-gray-50 max-h-[300px] overflow-y-auto">
                            <!-- JSで自動更新 -->
                        </div>
                    </div>
                </div>

                <!-- 右カラム -->
                <div class="space-y-6">
                    <!-- グラフ (管理者のみ表示) -->
                    ${this.state.isAdmin ? `
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                        <h3 class="font-bold text-gray-800 mb-1 text-sm">直近7日間の人件費(概算)</h3>
                        <p class="text-xs text-gray-400 mb-4">祝日割増・休憩控除を含みます</p>
                        <div class="h-[200px] w-full">
                            <canvas id="dashboardChart"></canvas>
                        </div>
                    </div>
                    ` : ''}

                    <!-- クイックアクション -->
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                         <h3 class="font-bold text-gray-800 mb-3 text-sm">クイックメニュー</h3>
                         <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            ${this.state.isAdmin ? `
                            <button onclick="app.openModal('staffModal'); document.getElementById('staffForm').reset(); document.getElementById('staffId').value=''; app.toggleSalaryInputs(); app.togglePrefHoursInputs();" 
                                class="w-full text-left px-4 py-3 hover:bg-blue-50 rounded-lg text-sm font-bold text-gray-600 hover:text-blue-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-blue-200">
                                <i class="fa-solid fa-user-plus text-blue-500 text-lg"></i> スタッフ追加
                            </button>
                            ` : ''}
                            
                            <button onclick="app.openModal('requestModal'); app.initRequestModal();"
                                class="w-full text-left px-4 py-3 hover:bg-red-50 rounded-lg text-sm font-bold text-gray-600 hover:text-red-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-red-200">
                                <i class="fa-solid fa-umbrella-beach text-red-400 text-lg"></i> 休み希望を出す
                            </button>

                            <button onclick="app.showShopRules()" 
                                class="w-full text-left px-4 py-3 hover:bg-orange-50 rounded-lg text-sm font-bold text-gray-600 hover:text-orange-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-orange-200">
                                <i class="fa-solid fa-book-open text-orange-400 text-lg"></i> お店のルール
                            </button>

                            <button id="btn-quick-shift" onclick="app.changeView('manual-shift')" 
                                class="w-full text-left px-4 py-3 hover:bg-teal-50 rounded-lg text-sm font-bold text-gray-600 hover:text-teal-700 flex items-center gap-3 transition-colors border border-gray-100 hover:border-teal-200">
                                <i class="fa-solid fa-calendar-days text-teal-500 text-lg"></i> シフト表を確認
                            </button>
                         </div>
                    </div>
                </div>
            </div>
        `;

        // 自動更新関数
        const updateShiftList = () => {
            const listContainer = document.getElementById('dashboardShiftList');
            const timeDisplay = document.getElementById('dashboardCurrentTime');
            if (!listContainer) return;

            const now = new Date();
            // 修正: 時間もゼロパディングして2桁にする (例: 1:05 -> 01:05)
            // これにより文字列比較 "01:00" >= "09:00" が正しく false になる
            const currentHour = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
            
            // 時刻表示更新
            if(timeDisplay) timeDisplay.textContent = `${todayStr} ${currentHour}`;

            const todayShifts = this.state.shifts
                .filter(s => s.date === todayStr)
                .sort((a, b) => a.start_time.localeCompare(b.start_time));

            if (todayShifts.length === 0) {
                listContainer.innerHTML = '<div class="p-6 text-center text-gray-400 text-sm">本日のシフトはありません</div>';
                return;
            }

            listContainer.innerHTML = todayShifts.map(s => {
                const staff = this.getStaff(s.staff_id);
                
                // 勤務状況判定 (日またぎ対応)
                let isWorking = false;
                let isFinished = false;

                if (s.start_time > s.end_time) {
                    // 日またぎシフト (例: 22:00 - 05:00)
                    // 現在時刻が開始時刻以降(22:00-23:59) または 終了時刻以前(00:00-05:00)
                    if (currentHour >= s.start_time || currentHour <= s.end_time) {
                        isWorking = true;
                    } else {
                        // 勤務時間外
                        // 例: 06:00 (終了後) -> 21:00 (開始前)
                        // 今日の日付のシフトとして扱われているため、終了時刻を過ぎていれば「終了」とみなす
                        isFinished = currentHour > s.end_time && currentHour < s.start_time;
                    }
                } else {
                    // 通常シフト (例: 09:00 - 18:00)
                    isWorking = currentHour >= s.start_time && currentHour <= s.end_time;
                    isFinished = currentHour > s.end_time;
                }
                
                const statusClass = isWorking ? 'bg-green-50' : (isFinished ? 'bg-gray-50 opacity-60' : '');
                const borderClass = isWorking ? 'border-l-4 border-green-500' : 'border-l-4 border-transparent';
                
                return `
                    <div class="flex items-center justify-between p-3 hover:bg-gray-50 transition-colors ${statusClass} ${borderClass}">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center font-bold text-gray-600 text-xs">
                                ${staff ? this._sanitize(staff.name.charAt(0)) : '?'}
                            </div>
                            <div>
                                <div class="font-bold text-sm text-gray-800">${staff ? this._sanitize(staff.name) : '削除済スタッフ'}</div>
                                <div class="text-[10px] text-gray-500">${s.start_time} - ${s.end_time}</div>
                            </div>
                        </div>
                        <div>
                            ${isWorking ? '<span class="text-[10px] font-bold text-green-600 flex items-center gap-1"><span class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>勤務中</span>' : ''}
                            ${isFinished ? '<span class="text-[10px] font-bold text-gray-400">勤務終了</span>' : ''}
                            ${!isWorking && !isFinished ? '<span class="text-[10px] font-bold text-blue-500">出勤前</span>' : ''}
                        </div>
                    </div>
                `;
            }).join('');
        };

        // 初回実行
        updateShiftList();

        // タイマーセット (1分ごと)
        this.state.dashboardTimer = setInterval(updateShiftList, 60000);

        // チャート描画
        setTimeout(() => {
            const ctx = document.getElementById('dashboardChart');
            if(ctx) {
                if (this.dashboardChartInstance) this.dashboardChartInstance.destroy();

                this.dashboardChartInstance = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: chartData.labels,
                        datasets: [{
                            label: '日次人件費 (円)',
                            data: chartData.data,
                            backgroundColor: chartData.colors,
                            borderRadius: 4,
                            barThickness: 12
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: { 
                            y: { display: true, ticks: { callback: v => '¥' + v/1000 + 'k', font: { size: 10 } }, grid: { color: '#f3f4f6' } }, 
                            x: { grid: { display: false }, ticks: { font: { size: 10 } } } 
                        }
                    }
                });
            }
        }, 100);
        
        // Ensure button works
        setTimeout(() => {
            const btn = document.getElementById('btn-quick-shift');
            if(btn) btn.onclick = () => app.changeView('manual-shift');
        }, 50);
    },

    getDashboardChartData() {
        const labels = [];
        const data = [];
        const colors = [];
        const today = new Date();

        for (let i = 6; i >= 0; i--) {
            const targetDate = new Date(today);
            targetDate.setDate(today.getDate() - i);
            const dateStr = targetDate.toISOString().split('T')[0];
            
            labels.push(`${targetDate.getMonth()+1}/${targetDate.getDate()}`);

            let dailyCost = 0;
            const dayShifts = this.state.shifts.filter(s => s.date === dateStr);

            dayShifts.forEach(shift => {
                const staff = this.getStaff(shift.staff_id);
                if (!staff || staff.salary_type !== 'hourly') return;

                const start = new Date(`${dateStr}T${shift.start_time}`);
                const end = new Date(`${dateStr}T${shift.end_time}`);
                if (end < start) end.setDate(end.getDate() + 1);
                let hours = (end - start) / (1000 * 60 * 60) - ((shift.break_minutes || 0) / 60);
                if (hours < 0) hours = 0;

                let wage = staff.hourly_wage;
                if (JapaneseHolidays.isHoliday(dateStr)) wage *= 1.25;
                dailyCost += Math.floor(hours * wage);
            });

            data.push(dailyCost);
            colors.push(i === 0 ? '#3b82f6' : '#cbd5e1');
        }
        return { labels, data, colors };
    },

    // =================================================================
    // 2. 申請リスト (Requests) - Admin Only
    // =================================================================
    renderRequests(container) {
        if (!this.state.isAdmin) {
             container.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full text-gray-500">
                    <i class="fa-solid fa-lock text-4xl mb-4 text-gray-300"></i>
                    <p class="font-bold text-gray-600">権限がありません</p>
                    <p class="text-sm">申請の管理を行うには管理者としてログインしてください</p>
                    <button onclick="app.openModal('loginModal')" class="mt-4 bg-blue-600 text-white px-6 py-2 rounded-lg font-bold shadow hover:bg-blue-700">管理者ログイン</button>
                </div>
            `;
            return;
        }

        const pending = this.state.requests.filter(r => r.status === 'pending');
        const history = this.state.requests.filter(r => r.status !== 'pending').sort((a, b) => b.id - a.id).slice(0, 10);

        container.innerHTML = `
            <div class="grid lg:grid-cols-2 gap-8">
                <!-- Pending -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-blue-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2">
                            <i class="fa-solid fa-inbox text-blue-600"></i> 承認待ち
                            <span class="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">${pending.length}</span>
                        </h3>
                        ${pending.length > 1 ? `<button onclick="app.handleBatchApprove()" class="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1"><i class="fa-solid fa-check-double"></i> 全て承認</button>` : ''}
                    </div>
                    <div class="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                        ${pending.length === 0 ? '<div class="p-8 text-center text-gray-400">現在、承認待ちの申請はありません</div>' : ''}
                        ${pending.map(req => {
                            const staff = this.getStaff(req.staff_id);
                            return `
                                <div class="p-4 hover:bg-gray-50 transition-colors">
                                    <div class="flex justify-between items-start mb-2">
                                        <div class="flex items-center gap-2">
                                            <div class="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center font-bold text-gray-500 text-xs">
                                                ${staff ? this._sanitize(staff.name.charAt(0)) : '?'}
                                            </div>
                                            <div>
                                                <div class="font-bold text-gray-800 text-sm">${staff ? this._sanitize(staff.name) : '不明'}</div>
                                                <div class="text-xs text-gray-500">${new Date(req.created_at || Date.now()).toLocaleDateString()} 申請</div>
                                            </div>
                                        </div>
                                        <span class="text-xs font-bold px-2 py-1 rounded bg-yellow-100 text-yellow-700">
                                            ${req.type === 'off' ? '休み希望' : '勤務希望'}
                                        </span>
                                    </div>
                                    <div class="pl-10">
                                        <div class="text-sm font-bold text-gray-800 mb-1">
                                            <i class="fa-regular fa-calendar mr-1 text-gray-400"></i> ${this._sanitize(req.dates)}
                                            ${req.type === 'work' ? `<span class="ml-2 text-gray-600">${this._sanitize(req.start_time)} - ${this._sanitize(req.end_time)}</span>` : ''}
                                        </div>
                                        ${req.reason ? `<div class="text-xs text-gray-600 bg-gray-50 p-2 rounded mb-3">"${this._sanitize(req.reason)}"</div>` : ''}
                                        
                                        <div class="flex gap-3 mt-3 justify-end">
                                            <button onclick="app.handleRequest('${req.id}', 'rejected')" class="px-4 py-1.5 border border-gray-300 rounded text-gray-600 text-xs font-bold hover:bg-gray-50 shadow-sm transition-colors">
                                                却下
                                            </button>
                                            <button onclick="app.handleRequest('${req.id}', 'approved')" class="px-4 py-1.5 bg-blue-600 text-white rounded text-xs font-bold hover:bg-blue-700 shadow-sm transition-colors flex items-center gap-1">
                                                <i class="fa-solid fa-check"></i> 承認
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>

                <!-- History -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden opacity-80">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2">
                            <i class="fa-solid fa-clock-rotate-left text-gray-500"></i> 処理履歴 (直近10件)
                        </h3>
                    </div>
                    <div class="divide-y divide-gray-100">
                        ${history.map(req => {
                             const staff = this.getStaff(req.staff_id);
                             const isApproved = req.status === 'approved';
                             return `
                                <div class="p-3 flex justify-between items-center text-sm">
                                    <div class="flex items-center gap-3">
                                        <div class="w-2 h-2 rounded-full ${isApproved ? 'bg-green-500' : 'bg-red-500'}"></div>
                                        <div>
                                            <span class="font-bold text-gray-700">${staff ? this._sanitize(staff.name) : '不明'}</span>
                                            <span class="text-gray-400 mx-1">|</span>
                                            <span class="text-gray-600">${this._sanitize(req.dates)}</span>
                                        </div>
                                    </div>
                                    <span class="font-bold text-xs ${isApproved ? 'text-green-600' : 'text-red-500'}">
                                        ${isApproved ? '承認済' : '却下'}
                                    </span>
                                </div>
                             `;
                        }).join('')}
                    </div>
                </div>
            </div>
        `;
    },

    // =================================================================
    // 3. シフトビュー (Shift View: Table & Calendar)
    // =================================================================
    renderShiftView(container) {
        // Toggle Buttons logic
        const getBtnClass = (isActive) => isActive 
            ? 'bg-white text-blue-600 shadow-sm font-bold' 
            : 'text-gray-500 hover:text-gray-700 font-medium hover:bg-gray-200/50';

        const isTable = this.state.shiftViewMode === 'table';
        const p = this.state.shiftTablePeriod;

        // Period controls (only for table mode)
        let periodControls = '';
        if (isTable) {
            periodControls = `
                <div class="flex items-center bg-white border border-gray-200 p-1 rounded-lg ml-4">
                    <button onclick="app.switchShiftTablePeriod('month')" class="px-3 py-1 text-xs rounded transition-all ${getBtnClass(p==='month')}">月間</button>
                    <button onclick="app.switchShiftTablePeriod('week')" class="px-3 py-1 text-xs rounded transition-all ${getBtnClass(p==='week')}">1週間</button>
                    <button onclick="app.switchShiftTablePeriod('day')" class="px-3 py-1 text-xs rounded transition-all ${getBtnClass(p==='day')}">1日</button>
                </div>
            `;
        }

        // Navigation arrows for Week/2Weeks
        let navControls = '';
        if (isTable && p !== 'month') {
            const label = p === 'week' ? '1週間' : '1日';
            navControls = `
                <div class="flex items-center gap-1 ml-2">
                    <button onclick="app.changeTablePeriod(-1)" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-600 transition">
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    <span class="text-xs font-bold text-gray-500">${label}移動</span>
                    <button onclick="app.changeTablePeriod(1)" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-600 transition">
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>
                </div>
            `;
        }

        container.innerHTML = `
            <div class="flex flex-col h-full space-y-4">
                <div class="flex items-center justify-between bg-white p-3 rounded-xl shadow-sm border border-gray-200 flex-wrap gap-2">
                    <div class="flex items-center gap-2">
                        <h2 class="text-lg font-bold text-gray-800">シフト表</h2>
                        <span class="text-sm text-gray-500 bg-gray-100 px-2 py-0.5 rounded font-mono whitespace-nowrap">
                            ${this.state.currentDate.getFullYear()}年${this.state.currentDate.getMonth()+1}月
                            ${isTable && p !== 'month' ? `<span class="ml-1 text-xs text-blue-600">(${this.state.currentDate.getDate()}日〜)</span>` : ''}
                        </span>
                        ${navControls}
                    </div>
                    
                    <div class="flex items-center gap-2">
                        ${this.state.isAdmin ? `
                        <button onclick="app.openModal('autoFillModal')" class="flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> AIシフト作成
                        </button>
                        ` : ''}
                        ${periodControls}
                        <div class="flex bg-white border border-gray-200 p-1 rounded-lg">
                            <button onclick="app.switchShiftViewMode('table')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${isTable ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}">
                                <i class="fa-solid fa-table-list mr-1"></i>表
                            </button>
                            <button onclick="app.switchShiftViewMode('calendar')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${!isTable ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}">
                                <i class="fa-regular fa-calendar-days mr-1"></i>カレンダー
                            </button>
                        </div>
                    </div>
                </div>
                <div id="shiftViewContent" class="flex-1 overflow-x-auto overflow-y-hidden bg-white rounded-xl shadow-sm border border-gray-200 relative">
                    <!-- Content injected here -->
                </div>
                <div class="flex justify-end pt-2">
                    <button onclick="app.printShiftTable()" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-bold text-gray-600 hover:bg-gray-50 transition">
                        <i class="fa-solid fa-print mr-2"></i>印刷
                    </button>
                </div>
            </div>
        `;
        
        const content = document.getElementById('shiftViewContent');
        if (this.state.shiftViewMode === 'table') {
            this.renderShiftTable(content);
        } else {
            this.renderCalendar(content);
        }
    },

    switchShiftViewMode(mode) {
        this.state.shiftViewMode = mode;
        this.renderShiftView(document.getElementById('viewContainer'));
    },

    switchShiftTablePeriod(period) {
        this.state.shiftTablePeriod = period;
        if (period === 'month') {
            const d = new Date(this.state.currentDate);
            d.setDate(1);
            this.state.currentDate = d;
        } else if (period === 'week') {
            // 直近の日曜に揃える
            const d = new Date(this.state.currentDate);
            d.setDate(d.getDate() - d.getDay());
            this.state.currentDate = d;
        }
        // day モードは currentDate をそのまま使う (揃え不要)
        this.updateHeader();
        this.ensureShiftsLoaded().then(() => this.renderShiftView(document.getElementById('viewContainer')));
    },

    changeTablePeriod(delta) {
        const d = new Date(this.state.currentDate);
        if (this.state.shiftTablePeriod === 'week') {
            d.setDate(d.getDate() + (delta * 7));
        } else if (this.state.shiftTablePeriod === 'day') {
            d.setDate(d.getDate() + delta);
        }
        this.state.currentDate = d;
        this.updateHeader();
        this.ensureShiftsLoaded().then(() => this.renderShiftView(document.getElementById('viewContainer')));
    },

    renderShiftTable(container) {
        const period = this.state.shiftTablePeriod || 'month';
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();
        
        let days = [];
        let colWidthClass = 'min-w-[40px]'; // Default narrow
        let isGanttMode = false;

        if (period === 'month') {
            const lastDay = new Date(year, month + 1, 0).getDate();
            days = Array.from({length: lastDay}, (_, i) => {
                return new Date(year, month, i + 1);
            });
        } else if (period === 'day') {
            // 1日表示: ガント大幅 (15分目盛りが見やすい幅) + メモ列付き
            colWidthClass = 'min-w-[1600px]';
            isGanttMode = true;
            days = [new Date(this.state.currentDate)];
        } else {
            // 1週間ガント (15分目盛り視認のため広く)
            colWidthClass = 'min-w-[1200px]';
            isGanttMode = true;
            const start = new Date(this.state.currentDate);
            days = Array.from({length: 7}, (_, i) => {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                return d;
            });
        }
        
        // ヘッダー生成
        let headerHtml = `<th class="p-3 sticky left-0 z-50 bg-gray-50 border-b border-r border-gray-200 min-w-[120px] text-left text-xs font-bold text-gray-500 uppercase tracking-wider">スタッフ</th>`;
        days.forEach(date => {
            const d = date.getDate();
            const m = date.getMonth() + 1;
            const dayOfWeek = date.getDay();
            const dateStr = `${date.getFullYear()}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            const isHoliday = JapaneseHolidays.isHoliday(dateStr);
            let colorClass = 'text-gray-700';
            if (dayOfWeek === 0 || isHoliday) colorClass = 'text-red-500';
            else if (dayOfWeek === 6) colorClass = 'text-blue-500';
            
            // Show Month/Date if crossing months or in week mode
            const label = period === 'month' ? d : `${m}/${d}`;
            
            // 時間スケールをヘッダーに追加 (ガントチャート用)
            let timeScale = '';
            if (isGanttMode) {
                // 1時間おきに数字を表示
                let scaleHtml = '';
                for (let i = 0; i <= 24; i++) {
                    const left = (i / 24) * 100;
                    scaleHtml += `<span class="absolute -translate-x-1/2 font-mono" style="left: ${left}%">${String(i).padStart(2,'0')}</span>`;

                    // 15分刻みの目盛り (week / day モード)
                    if ((period === 'week' || period === 'day') && i < 24) {
                        for(let m=1; m<4; m++) {
                            const mLeft = ((i + m/4) / 24) * 100;
                            scaleHtml += `<span class="absolute -translate-x-1/2 text-[8px] text-gray-300 top-1" style="left: ${mLeft}%">|</span>`;
                        }
                    }
                }
                
                timeScale = `
                    <div class="relative h-5 text-[10px] text-gray-400 font-bold mt-1 border-t border-gray-100 pt-0.5 select-none">
                        ${scaleHtml}
                    </div>
                `;
            }
            
            headerHtml += `<th class="p-2 ${colWidthClass} text-center border-b border-gray-200 bg-gray-50 text-xs font-bold ${colorClass}">
                <div class="sticky left-0 right-0 flex flex-col items-center justify-center leading-tight">
                    <span class="text-sm block">${label}</span>
                    <span class="text-[10px] font-normal block">${['日','月','火','水','木','金','土'][dayOfWeek]}</span>
                </div>
                ${timeScale}
            </th>`;
        });

        // ボディ生成
        let bodyHtml = '';
        this.state.staff.forEach(staff => {
            bodyHtml += `<tr data-staff-id="${staff.id}">`;
            bodyHtml += `<td class="p-3 sticky left-0 z-40 bg-white border-b border-r border-gray-100 font-bold text-sm text-gray-800 truncate h-14">${this._sanitize(staff.name)}</td>`;
            
            days.forEach(date => {
                const y = date.getFullYear();
                const m = date.getMonth() + 1;
                const d = date.getDate();
                const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                
                // 過去日判定
                const checkDate = new Date(date);
                checkDate.setHours(0,0,0,0);
                const today = new Date();
                today.setHours(0,0,0,0);
                const isPast = checkDate < today;

                // シフト検索
                const shift = this.state.shifts.find(s => s.staff_id === staff.id && s.date === dateStr);
                
                // セル背景色
                const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
                let bgClass = isSpecialHoliday ? 'bg-red-50 pattern-diagonal-lines' : 'bg-white';
                
                if (isPast) {
                    bgClass = isSpecialHoliday ? 'bg-red-50 pattern-diagonal-lines opacity-75' : 'bg-gray-50/30';
                } else if (!shift && !isSpecialHoliday) {
                    bgClass = 'hover:bg-gray-50';
                }

                // セルアクション (ガントモードではバーのドラッグ操作があるため、空セルのみクリックイベント)
                let action = '';
                let cursor = '';
                if (this.state.isAdmin) {
                    if (isGanttMode) {
                        action = shift ? '' : `onclick="app.openAddShift('${dateStr}'); document.getElementById('editShiftStaffSelect').value='${staff.id}';"`;
                    } else {
                        action = shift ? `onclick="app.openEditShift('${shift.id}')"` : `onclick="app.openAddShift('${dateStr}'); document.getElementById('editShiftStaffSelect').value='${staff.id}';"`;
                    }
                    cursor = 'cursor-pointer';
                }

                // ガントチャート用: 営業時間の背景（Open-Close以外をグレーアウト）を生成するための時間取得
                let openTime = "09:00";
                let closeTime = "22:00";
                if (isGanttMode) {
                    const dayOfWeek = new Date(dateStr).getDay();
                    const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
                    const isHoliday = jh ? jh.isHoliday(dateStr) : false;
                    
                    // 特定日設定
                    const specialDay = (this.state.config.special_days || {})[dateStr];
                    if (specialDay) {
                        openTime = specialDay.start;
                        closeTime = specialDay.end;
                    } else {
                        // 通常営業設定
                        const times = this.state.config.opening_times || {};
                        const defTimes = this.state.defaultConfig.opening_times;
                        const getStart = (type) => times[type]?.start || defTimes[type].start;
                        const getEnd = (type) => times[type]?.end || defTimes[type].end;

                        if (isHoliday) {
                            openTime = getStart('holiday');
                            closeTime = getEnd('holiday');
                        } else if (dayOfWeek === 0 || dayOfWeek === 6) { 
                            openTime = getStart('weekend');
                            closeTime = getEnd('weekend');
                        } else {
                            openTime = getStart('weekday');
                            closeTime = getEnd('weekday');
                        }
                    }
                }

                let content = '';
                if (shift) {
                    const startH = parseInt(shift.start_time);
                    let barColor = 'bg-blue-100 text-blue-700 border-blue-500'; // base
                    if (startH < 10) barColor = 'bg-yellow-100 text-yellow-800 border-yellow-500';
                    if (startH >= 17) barColor = 'bg-purple-100 text-purple-700 border-purple-500';
                    
                    // イレギュラーアサイン（社員の強制アサイン等）の強調
                    if (shift.is_irregular) {
                        barColor = 'bg-red-50 text-red-700 border-red-500 border-2 pattern-diagonal-lines ring-2 ring-red-400 ring-inset';
                    }
                    
                    // 社員（月給制・店長・副店長・社員）のシフト枠組みの色を変更して強調
                    const isEmployeeRole = staff && (staff.salary_type === 'monthly' || ['manager', 'sub_manager', 'employee'].includes(staff.role));
                    if (isEmployeeRole) {
                        barColor += ' border-emerald-500 shadow-md';
                    }
                    
                    // 過去の場合は少し透明にして元の色を残す
                    if (isPast) {
                        barColor += ' opacity-50 hover:opacity-70';
                    }

                    if (isGanttMode) {
                        // === Gantt Style (Bar inside timeline) ===
                        const timeToPct = (t) => {
                            const [h, m] = t.split(':').map(Number);
                            return ((h + m/60) / 24) * 100;
                        };
                        const startPct = timeToPct(shift.start_time);
                        let endPct = timeToPct(shift.end_time);
                        if (endPct <= startPct) endPct += 100;
                        const widthPct = endPct - startPct;
                        
                        // 営業時間外マスク (Open前、Close後)
                        const openPct = timeToPct(openTime);
                        const closePct = timeToPct(closeTime);
                        
                        // CSS Gradientで細かいグリッドを描画
                        // 1h = 100/24 %, 15m = 1h/4
                        const oneHour = 100/24;
                        const oneFifteen = oneHour / 4;
                        const bgGuides = '';
                        
                        const adminDrag = this.state.isAdmin ? `data-shift-id="${shift.id}" data-staff-id="${staff.id}" data-date="${dateStr}" style="left: ${startPct}%; width: ${Math.max(widthPct, 0.5)}%; min-width: 2px; cursor: grab;"` : `style="left: ${startPct}%; width: ${Math.max(widthPct, 0.5)}%; min-width: 2px;"`;
                        const resizeHandles = this.state.isAdmin ? `
                                    <div class="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 hover:bg-black/10 rounded-l" style="touch-action:none;"></div>
                                    <div class="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 hover:bg-black/10 rounded-r" style="touch-action:none;"></div>
                        ` : '';
                        content = `
                            <div class="w-full h-full relative group bg-transparent overflow-hidden">
                                ${bgGuides}
                                <!-- Bar with text -->
                                <div class="absolute top-1/2 -translate-y-1/2 h-8 ${period==='week'?'':'h-6'} rounded ${barColor} border shadow-sm flex items-center justify-center overflow-hidden z-10 hover:brightness-95 transition-all px-1"
                                     ${adminDrag}
                                     ${this.state.isHQ ? '' : `ondblclick="app.openEditShift('${shift.id}')"`}>
                                     ${resizeHandles}
                                     <span class="text-[9px] md:text-[10px] font-bold whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none select-none">
                                        ${shift.start_time} - ${shift.end_time}
                                     </span>
                                </div>

                                <!-- Tooltip on hover -->
                                <div class="opacity-0 group-hover:opacity-100 absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs rounded px-2 py-1 z-20 pointer-events-none whitespace-nowrap shadow-lg">
                                    ${shift.start_time} - ${shift.end_time}
                                </div>
                            </div>
                        `;
                    } else {
                        // === Month Style (Block) ===
                        content = `<div class="w-full h-full p-1"><div class="${barColor} border-l-2 rounded text-[10px] font-bold text-center leading-tight py-1 truncate shadow-sm">${shift.start_time}<br>|${shift.end_time}</div></div>`;
                    }
                } else if (isSpecialHoliday) {
                    content = `<div class="w-full h-full flex items-center justify-center"><span class="text-[10px] text-red-300 font-bold">休</span></div>`;
                }

                // Ganttモードの場合は空セルにもガイド線を表示
                if (!shift && isGanttMode && !isSpecialHoliday) {
                    // 営業時間取得 (繰り返しロジックになるが、shift有無に関わらず必要)
                    // 上記で計算済み変数を再利用
                    const timeToPct = (t) => {
                        const [h, m] = t.split(':').map(Number);
                        return ((h + m/60) / 24) * 100;
                    };
                    const openPct = timeToPct(openTime);
                    const closePct = timeToPct(closeTime);

                    const guides = '';
                    content = `<div class="w-full h-full relative group overflow-hidden bg-transparent">${guides}</div>`;
                }

                bodyHtml += `<td class="p-0 border-b border-r border-gray-100 h-14 relative transition-colors ${bgClass} ${cursor}" ${action}>${content}</td>`;
            });
            bodyHtml += `</tr>`;
        });

        // === 人員不足アラート行の生成 ===
        let alertRowHtml = '';
        if (this.state.isAdmin && this.state.config) {
            const staffReq = this.state.config.staff_req || this.state.defaultConfig.staff_req;
            const closedDays = this.state.config.closed_days || [];
            const specialHolidays = this.state.config.special_holidays || [];

            alertRowHtml += `<tr>`;
            alertRowHtml += `<td class="p-2 sticky left-0 z-40 bg-white border-b border-r border-gray-100 text-xs font-bold text-gray-500 h-10 whitespace-nowrap">
                <i class="fa-solid fa-triangle-exclamation text-amber-500 mr-1"></i>人員状況
            </td>`;

            days.forEach(date => {
                const m = date.getMonth() + 1;
                const d = date.getDate();
                const dateStr = `${date.getFullYear()}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const dayOfWeek = date.getDay();
                const jsDow = dayOfWeek; // 0=日, 6=土

                // 休業日チェック
                const isSpecialHoliday = specialHolidays.includes(dateStr);
                const isClosedDay = closedDays.map(Number).includes(jsDow);
                if (isSpecialHoliday || isClosedDay) {
                    alertRowHtml += `<td class="p-0 border-b border-r border-gray-100 h-10 bg-gray-50 text-center">
                        <span class="text-[10px] text-gray-300">-</span>
                    </td>`;
                    return;
                }

                // 祝日チェック
                const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
                const isHoliday = jh ? jh.isHoliday(dateStr) : false;

                // 必要人数を取得（ベース値）
                let required = parseInt(staffReq.min_weekday || 2);
                if (isHoliday || dayOfWeek === 0) {
                    required = parseInt(staffReq.min_holiday || 3);
                } else if (dayOfWeek === 6) {
                    required = parseInt(staffReq.min_weekend || 3);
                }

                // 営業時間の取得
                const times = this.state.config.opening_times || this.state.defaultConfig.opening_times;
                const defTimes = this.state.defaultConfig.opening_times;
                const getT = (key) => ((times || {})[key] || defTimes[key]);
                let dayOpen, dayClose;
                const specialDay = (this.state.config.special_days || {})[dateStr];
                if (specialDay && specialDay.start && specialDay.end) {
                    dayOpen = specialDay.start;
                    dayClose = specialDay.end;
                } else if (isHoliday) {
                    dayOpen = getT('holiday').start; dayClose = getT('holiday').end;
                } else if (dayOfWeek === 0 || dayOfWeek === 6) {
                    dayOpen = getT('weekend').start; dayClose = getT('weekend').end;
                } else {
                    dayOpen = getT('weekday').start; dayClose = getT('weekday').end;
                }

                const toMins = (t) => { const [h, m] = (t || '09:00').split(':').map(Number); return h * 60 + m; };
                const openM = toMins(dayOpen);
                let closeM = toMins(dayClose);
                if (closeM <= openM) closeM += 24 * 60; // 日またぎ対応

                // 時間帯別の必要人数ルール適用（days配列の型を数値に統一して安全にフィルタ）
                const timeRules = (this.state.config.time_staff_req || []).filter(r => (r.days || []).map(Number).includes(jsDow));

                // 15分スロットごとに「同時在籍人数」vs「そのスロットの要件」を比較
                const shiftsForDay = this.state.shifts.filter(s => s.date === dateStr);
                let totalSlots = 0;
                let shortageSlots = 0;
                let worstDeficit = 0; // 最悪の不足数（正値=不足あり）
                let maxConcurrent = 0;
                let maxSlotReq = required;
                let surplusSlots = 0;

                for (let t = openM; t < closeM; t += 15) {
                    // このスロットでの必要人数（ベース or 時間帯別ルールの大きい方）
                    let slotReq = required;
                    timeRules.forEach(rule => {
                        const rs = toMins(rule.start);
                        let re = toMins(rule.end);
                        if (re <= rs) re += 24 * 60;
                        if (t >= rs && t < re) {
                            slotReq = Math.max(slotReq, parseInt(rule.count || 0));
                        }
                    });

                    // このスロットの同時在籍人数
                    const concurrent = shiftsForDay.filter(s => {
                        const sStart = toMins(s.start_time);
                        let sEnd = toMins(s.end_time);
                        if (sEnd <= sStart) sEnd += 24 * 60;
                        return sStart <= t && t < sEnd;
                    }).length;

                    totalSlots++;
                    const slotDeficit = slotReq - concurrent;
                    if (slotDeficit > 0) shortageSlots++;
                    if (slotDeficit > worstDeficit) worstDeficit = slotDeficit;
                    if (slotReq > maxSlotReq) maxSlotReq = slotReq;
                    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
                    if (concurrent > slotReq + 1) surplusSlots++;
                }

                // 表示用: スロットごとの分析結果から判定（±1の実態表示）
                const assigned = shiftsForDay.length;

                let cellContent = '';
                let cellBg = 'bg-white';
                if (shortageSlots > 0) {
                    // 不足スロットがある
                    cellBg = 'bg-red-50';
                    const label = shortageSlots > totalSlots / 2 ? `${worstDeficit}名不足` : '一部不足';
                    cellContent = `<div class="flex items-center justify-center h-full px-0.5 w-full overflow-hidden">
                        <span class="text-red-600 font-bold text-[9px] sm:text-[10px] md:text-xs whitespace-nowrap truncate tracking-tighter animate-pulse">${label} <span class="opacity-80 ml-0.5">${assigned}名(要${maxSlotReq})</span></span>
                    </div>`;
                } else if (surplusSlots > totalSlots / 3) {
                    // 過剰スロットが多い（±1超え）
                    cellBg = 'bg-amber-50';
                    cellContent = `<div class="flex items-center justify-center h-full px-0.5 w-full overflow-hidden">
                        <span class="text-amber-500 font-bold text-[9px] sm:text-[10px] md:text-xs whitespace-nowrap truncate tracking-tighter">過剰 <span class="opacity-80 ml-0.5">${assigned}名(要${maxSlotReq})</span></span>
                    </div>`;
                } else {
                    // ±1以内で適正
                    cellContent = `<div class="flex items-center justify-center h-full px-0.5 w-full overflow-hidden">
                        <span class="text-green-600 font-bold text-[9px] sm:text-[10px] md:text-xs whitespace-nowrap truncate tracking-tighter">ぴったり <span class="opacity-80 ml-0.5">${assigned}名(要${maxSlotReq})</span></span>
                    </div>`;
                }

                alertRowHtml += `<td class="p-0 border-b border-r border-gray-100 h-10 ${cellBg} text-center">${cellContent}</td>`;
            });
            alertRowHtml += `</tr>`;
        }

        // 日毎モード: ガント下に「本日のシフト一覧 (時刻順 + メモ)」を追加表示
        let dayDetailHtml = '';
        if (period === 'day') {
            const targetDate = days[0];
            const y = targetDate.getFullYear();
            const m = String(targetDate.getMonth() + 1).padStart(2, '0');
            const dd = String(targetDate.getDate()).padStart(2, '0');
            const ds = `${y}-${m}-${dd}`;
            const todays = (this.state.shifts || [])
                .filter(s => s.date === ds)
                .slice()
                .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
            const rowsHtml = todays.length === 0
                ? `<tr><td colspan="5" class="py-6 text-center text-sm text-gray-400">この日のシフトはありません</td></tr>`
                : todays.map(s => {
                    const staff = this.getStaff(s.staff_id);
                    const name = staff ? this._sanitize(staff.name) : '不明';
                    const st = (s.start_time || '').substr(0, 5);
                    const et = (s.end_time || '').substr(0, 5);
                    const memo = this._sanitize(s.memo || '');
                    const editBtn = this.state.isAdmin
                        ? `<button onclick="app.openEditShift('${s.id}')" class="px-2.5 py-1 text-xs bg-blue-50 text-blue-600 rounded-md hover:bg-blue-100 border border-blue-100"><i class="fa-solid fa-pen"></i></button>`
                        : '';
                    return `<tr class="border-b border-gray-100 hover:bg-amber-50/30">
                        <td class="py-2 px-3 text-sm font-mono font-bold text-gray-700 whitespace-nowrap">${st} - ${et}</td>
                        <td class="py-2 px-3 text-sm font-bold text-gray-900">${name}</td>
                        <td class="py-2 px-3 text-xs text-gray-500 whitespace-nowrap">休憩 ${s.break_minutes || 0}分</td>
                        <td class="py-2 px-3 text-sm text-gray-700">${memo ? `<span class="inline-flex items-start gap-1"><i class="fa-regular fa-note-sticky text-amber-500 mt-0.5"></i><span class="whitespace-pre-wrap">${memo}</span></span>` : '<span class="text-gray-300">—</span>'}</td>
                        <td class="py-2 px-3 text-center">${editBtn}</td>
                    </tr>`;
                }).join('');
            const dateLabel = `${y}年${parseInt(m,10)}月${parseInt(dd,10)}日 (${'日月火水木金土'[targetDate.getDay()]})`;
            dayDetailHtml = `
                <div class="mt-4 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    <div class="px-4 py-2.5 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-gray-200 flex items-center justify-between">
                        <div class="text-sm font-bold text-gray-800"><i class="fa-regular fa-note-sticky text-amber-600 mr-2"></i>${dateLabel} のシフト詳細・メモ</div>
                        <div class="text-xs text-gray-500">合計 ${todays.length}件</div>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full border-collapse">
                            <thead class="bg-gray-50 border-b border-gray-200">
                                <tr>
                                    <th class="py-2 px-3 text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider">時間</th>
                                    <th class="py-2 px-3 text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider">スタッフ</th>
                                    <th class="py-2 px-3 text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider">休憩</th>
                                    <th class="py-2 px-3 text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider">メモ</th>
                                    <th class="py-2 px-3 text-center text-[11px] font-bold text-gray-500 uppercase tracking-wider">編集</th>
                                </tr>
                            </thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                    </div>
                </div>`;
        }

        container.innerHTML = `
            <div class="h-full overflow-auto custom-scrollbar">
                <table class="w-full border-collapse">
                    <thead><tr>${headerHtml}</tr></thead>
                    <tbody id="shiftTableBody">
                        ${alertRowHtml}
                        ${bodyHtml}
                    </tbody>
                </table>
                ${dayDetailHtml}
            </div>
        `;
    },

    renderCalendar(container) {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        
        let html = `
            <div class="h-full overflow-y-auto overflow-x-auto custom-scrollbar">
                <div class="bg-white rounded-t-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="grid grid-cols-7 border-b border-gray-200 bg-gray-50 sticky top-0 z-10 shadow-sm">
                        ${['日', '月', '火', '水', '木', '金', '土'].map((day, i) => 
                            `<div class="py-3 text-center text-[10px] sm:text-sm font-bold ${i===0 ? 'text-red-500' : i===6 ? 'text-blue-500' : 'text-gray-600'}">${day}</div>`
                        ).join('')}
                    </div>
                    <div class="grid grid-cols-7 auto-rows-fr bg-gray-200 gap-px border-b border-gray-200">
        `;

        for (let i = 0; i < firstDay.getDay(); i++) {
            html += `<div class="bg-gray-50 min-h-[60px] sm:min-h-[120px]"></div>`;
        }

        for (let day = 1; day <= lastDay.getDate(); day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
            const holidayName = jh ? jh.getHolidayName(dateStr) : null;
            const currentD = new Date(year, month, day);
            const isToday = new Date().toDateString() === currentD.toDateString();
            const dayOfWeek = currentD.getDay();
            
            // 過去日判定
            const todayD = new Date();
            todayD.setHours(0,0,0,0);
            const isPast = currentD < todayD;

            let dateColorClass = 'text-gray-700';
            let dateBgClass = isPast ? 'bg-gray-100' : '';
            if (isPast) dateColorClass = 'text-gray-400';
            
            // 臨時休業判定
            const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
            // 特定日判定 (短縮営業など)
            const specialDayConfig = (this.state.config.special_days || {})[dateStr];
            // 備考メモ
            const note = (this.state.config.calendar_notes || {})[dateStr];
            
            if (dayOfWeek === 0 || holidayName) dateColorClass = 'text-red-500';
            else if (dayOfWeek === 6) dateColorClass = 'text-blue-500';
            
            if (isSpecialHoliday) {
                dateColorClass = 'text-red-600';
                dateBgClass = 'bg-red-50 pattern-diagonal-lines';
            } else if (specialDayConfig) {
                dateBgClass = 'bg-yellow-50';
            }

            const dayShifts = this.state.shifts
                .filter(s => s.date === dateStr)
                .sort((a, b) => a.start_time.localeCompare(b.start_time));

            // Admin: Click to add shift. Guest: No click action.
            const cellAction = this.state.isAdmin ? `onclick="app.openAddShift('${dateStr}')"` : `onclick="app.showToast('シフトの編集は管理者のみ可能です')"` ;
            const hoverClass = this.state.isAdmin ? 'hover:bg-blue-50/30 cursor-pointer' : '';
            
            // アクションボタン群 (管理者のみ)
            let actionBtns = '';
            if (this.state.isAdmin) {
                actionBtns = `
                    <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick="event.stopPropagation(); app.openCalendarNoteModal('${dateStr}')" class="text-gray-400 hover:text-yellow-500 w-5 h-5 flex items-center justify-center rounded hover:bg-yellow-50" title="メモ編集">
                            <i class="fa-regular fa-note-sticky"></i>
                        </button>
                        <button onclick="event.stopPropagation(); app.openAddShift('${dateStr}')" class="text-gray-400 hover:text-blue-600 w-5 h-5 flex items-center justify-center rounded hover:bg-blue-50" title="シフト追加">
                            <i class="fa-solid fa-plus-circle"></i>
                        </button>
                    </div>
                `;
            }

            html += `
                <div class="bg-white calendar-cell p-1.5 flex flex-col gap-1 relative group min-h-[160px] transition-colors ${hoverClass} ${dateBgClass}" 
                     ${cellAction}>
                    <div class="flex justify-between items-start px-1 mb-1">
                        <div class="flex flex-col">
                            <span class="text-sm font-bold ${dateColorClass} ${isToday ? 'bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center shadow-md' : ''}">
                                ${day}
                            </span>
                            ${holidayName ? `<span class="text-[10px] font-bold text-red-500 truncate max-w-[60px] leading-tight">${holidayName}</span>` : ''}
                        </div>
                        ${actionBtns}
                    </div>
                    
                    <div class="flex-1 flex flex-col gap-1 mt-1 overflow-y-auto custom-scrollbar">
                        ${dayShifts.map(shift => {
                            const staff = this.getStaff(shift.staff_id);
                            if (!staff) return '';
                            const shiftCursorClass = this.state.isAdmin ? 'cursor-pointer hover:brightness-95' : '';
                            const shiftClickAction = this.state.isAdmin ? `onclick="event.stopPropagation(); app.openEditShift('${shift.id}')"` : '';
                            return `
                                <div class="text-xs px-2 py-1.5 rounded-md border-l-4 shadow-sm transition-all bg-blue-50 border-blue-500 text-blue-900 ${shiftCursorClass}"
                                     ${shiftClickAction} title="${this._sanitize(staff.name)} ${shift.start_time}-${shift.end_time}">
                                    <div class="font-bold truncate">${this._sanitize(staff.name)}</div>
                                    <div class="font-mono text-[10px] opacity-90">${shift.start_time} - ${shift.end_time}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
        html += `</div></div></div>`;
        // Removed standalone print button as it is now in the view header
        container.innerHTML = html;
    },

    openCalendarNoteModal(dateStr) {
        if (!this.state.isAdmin) return;
        document.getElementById('noteDate').value = dateStr;
        document.getElementById('noteDateDisplay').textContent = dateStr;
        
        const note = (this.state.config.calendar_notes || {})[dateStr] || '';
        document.getElementById('noteText').value = note;
        
        this.openModal('calendarNoteModal');
    },

    async saveCalendarNote() {
        const date = (document.getElementById('noteDate')?.value || '');
        const text = (document.getElementById('noteText')?.value || '').trim();
        
        if (!this.state.config.calendar_notes) this.state.config.calendar_notes = {};
        
        if (text) {
            this.state.config.calendar_notes[date] = text;
        } else {
            delete this.state.config.calendar_notes[date];
        }

        this.showLoading(true);
        try {
            await API.rpc('update_config_safe', {
                p_config_id: this.state.config.id,
                p_data: { calendar_notes: this.state.config.calendar_notes }
            });

            // カレンダー再描画
            if (this.state.shiftViewMode === 'calendar') {
                this.renderCalendar(document.getElementById('shiftViewContent'));
            }
            this.closeModal('calendarNoteModal');
            this.showToast('メモを保存しました', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('保存に失敗しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async deleteCalendarNote() {
        if (!confirm('このメモを削除しますか？')) return;
        const date = (document.getElementById('noteDate')?.value || '');
        
        if (this.state.config.calendar_notes && this.state.config.calendar_notes[date]) {
            delete this.state.config.calendar_notes[date];
            
            this.showLoading(true);
            try {
                await API.rpc('update_config_safe', {
                    p_config_id: this.state.config.id,
                    p_data: { calendar_notes: this.state.config.calendar_notes }
                });

                // カレンダー再描画
                if (this.state.shiftViewMode === 'calendar') {
                    this.renderCalendar(document.getElementById('shiftViewContent'));
                }
                this.closeModal('calendarNoteModal');
                this.showToast('メモを削除しました', 'success');
            } catch (e) {
                this.showToast('削除に失敗しました', 'error');
            } finally {
                this.showLoading(false);
            }
        } else {
            this.closeModal('calendarNoteModal');
        }
    },

    // =================================================================
    // 4. 分析 (Analytics) - Admin Only
    // =================================================================
    renderAnalytics(container) {
        if (!this.state.isAdmin) return; // Sidebar should hide this, but safe guard.
        
        const stats = this.calculateMonthlyAnalytics();
        
        // ヘルパー関数: 日本語通貨表記
        const formatMoney = (n) => {
            if(n < 10000) return '¥' + n.toLocaleString();
            const man = Math.floor(n / 10000);
            const rest = n % 10000;
            return `${man}万${rest > 0 ? rest.toLocaleString() : ''}円`;
        };

        container.innerHTML = `
            <div class="space-y-6">
                <h2 class="text-xl font-bold text-gray-800">分析レポート (${this.state.currentDate.getFullYear()}年${this.state.currentDate.getMonth()+1}月)</h2>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200">
                        <p class="text-sm font-bold text-gray-500 uppercase">月間推定人件費</p>
                        <h3 class="text-2xl font-bold text-gray-800 mt-2 truncate" title="${stats.totalCost.toLocaleString()}円">
                            ${formatMoney(stats.totalCost)}
                        </h3>
                        <p class="text-xs text-gray-400 mt-1">※祝日割増・深夜手当を含む概算</p>
                    </div>
                    <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                        <p class="text-sm font-bold text-gray-500 uppercase">総労働時間</p>
                        <h3 class="text-2xl font-bold text-blue-600 mt-2">${stats.totalHours.toFixed(1)}h</h3>
                    </div>
                    <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                        <p class="text-sm font-bold text-gray-500 uppercase">スタッフ稼働数</p>
                        <h3 class="text-2xl font-bold text-indigo-600 mt-2">${stats.activeStaffCount} <span class="text-lg text-gray-500">名</span></h3>
                    </div>
                </div>
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200"><h3 class="font-bold text-gray-800 mb-4">日次コスト推移</h3><div class="h-[200px] sm:h-[300px]"><canvas id="dailyCostChart"></canvas></div></div>
                    <div class="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-gray-200"><h3 class="font-bold text-gray-800 mb-4">スタッフ別コスト構成比</h3><div class="h-[200px] sm:h-[300px] flex justify-center"><canvas id="staffShareChart"></canvas></div></div>
                </div>
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50"><h3 class="font-bold text-gray-800">スタッフ別詳細・労働時間チェック</h3></div>
                    <div class="overflow-x-auto"><table class="w-full text-left text-sm">
                        <thead class="bg-gray-50 text-gray-500 border-b border-gray-200">
                            <tr>
                                <th class="p-4 font-medium">スタッフ名</th>
                                <th class="p-4 font-medium text-right">出勤日数</th>
                                <th class="p-4 font-medium text-right">労働時間</th>
                                <th class="p-4 font-medium text-right">法定目安(176h)との差</th>
                                <th class="p-4 font-medium text-right">推定支給額</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-100">
                            ${stats.staffStats.map(s => {
                                const limit = 176; // 月間法定労働時間の目安 (40週 * 4.4週)
                                const diff = s.hours - limit;
                                const isOver = diff > 0;
                                const diffText = isOver ? `+${diff.toFixed(1)}h` : 'OK';
                                const rowClass = isOver ? 'bg-red-50' : 'hover:bg-gray-50';
                                const textClass = isOver ? 'text-red-600 font-bold' : 'text-green-600';
                                const icon = isOver ? '<i class="fa-solid fa-triangle-exclamation mr-1"></i>' : '<i class="fa-solid fa-check mr-1"></i>';

                                return `
                                <tr class="${rowClass}">
                                    <td class="p-4 font-bold text-gray-700">${this._sanitize(s.name)}</td>
                                    <td class="p-4 text-right">${s.days}日</td>
                                    <td class="p-4 text-right">${s.hours.toFixed(1)}h</td>
                                    <td class="p-4 text-right ${textClass}">${icon}${diffText}</td>
                                    <td class="p-4 text-right font-mono">¥${s.cost.toLocaleString()}</td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table></div>
                </div>
            </div>
        `;
        setTimeout(() => this.renderAnalyticsCharts(stats), 100);
    },

    calculateMonthlyAnalytics() {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth() + 1;
        const prefix = `${year}-${String(month).padStart(2, '0')}`;
        const monthShifts = this.state.shifts.filter(s => s.date.startsWith(prefix));
        const daysInMonth = new Date(year, month, 0).getDate();

        let totalCost = 0, totalHours = 0;
        const dailyCosts = new Array(daysInMonth).fill(0);
        const dailyLabels = Array.from({length: daysInMonth}, (_, i) => `${i+1}日`);
        const staffMap = {};

        monthShifts.forEach(shift => {
            const staff = this.getStaff(shift.staff_id);
            if (!staff) return;
            const start = new Date(`${shift.date}T${shift.start_time}`);
            const end = new Date(`${shift.date}T${shift.end_time}`);
            if (end < start) end.setDate(end.getDate() + 1);
            let hours = (end - start) / (1000 * 60 * 60) - ((shift.break_minutes || 0) / 60);
            if (hours < 0) hours = 0;

            let cost = 0;
            if (staff.salary_type === 'hourly') {
                let wage = staff.hourly_wage;
                if (JapaneseHolidays.isHoliday(shift.date)) wage *= 1.25;
                cost = Math.floor(hours * wage);
            }

            totalCost += cost;
            totalHours += hours;
            const dayIndex = parseInt(shift.date.split('-')[2]) - 1;
            dailyCosts[dayIndex] += cost;

            if (!staffMap[staff.id]) staffMap[staff.id] = { name: staff.name, cost: 0, hours: 0, days: new Set() };
            staffMap[staff.id].cost += cost;
            staffMap[staff.id].hours += hours;
            staffMap[staff.id].days.add(shift.date);
        });

        this.state.staff.forEach(s => {
            if (s.salary_type === 'monthly') {
                totalCost += (s.monthly_salary || 0);
                if (!staffMap[s.id]) staffMap[s.id] = { name: s.name, cost: 0, hours: 0, days: new Set() };
                staffMap[s.id].cost += (s.monthly_salary || 0);
            }
        });

        const staffStats = Object.values(staffMap).map(s => ({ ...s, days: s.days.size })).sort((a, b) => b.cost - a.cost);
        return { totalCost, totalHours, daysCount: daysInMonth, activeStaffCount: Object.keys(staffMap).length, dailyCosts, dailyLabels, staffStats };
    },

    renderAnalyticsCharts(stats) {
        if (this.analyticsDailyChart) this.analyticsDailyChart.destroy();
        if (this.analyticsShareChart) this.analyticsShareChart.destroy();

        this.analyticsDailyChart = new Chart(document.getElementById('dailyCostChart'), {
            type: 'line',
            data: { labels: stats.dailyLabels, datasets: [{ label: '日次人件費', data: stats.dailyCosts, borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, tension: 0.3 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
        });
        const topStaff = stats.staffStats.slice(0, 5);
        const otherCost = stats.staffStats.slice(5).reduce((sum, s) => sum + s.cost, 0);
        const labels = topStaff.map(s => s.name);
        const data = topStaff.map(s => s.cost);
        if (otherCost > 0) { labels.push('その他'); data.push(otherCost); }

        this.analyticsShareChart = new Chart(document.getElementById('staffShareChart'), {
            type: 'doughnut',
            data: { labels: labels, datasets: [{ data: data, backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899', '#9ca3af'] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
        });
    },

    // =================================================================
    // 5. スタッフ管理 (Staff) - Admin Only
    // =================================================================
    renderStaffList(container) {
        if (!this.state.isAdmin) return;

        container.innerHTML = `
            <div class="max-w-6xl mx-auto space-y-6 pb-20">
                <div class="flex items-center justify-between">
                    <h2 class="text-2xl font-bold text-gray-800">スタッフ管理</h2>
                    <button onclick="app.prepareStaffModal()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-plus mr-2"></i>新規登録
                    </button>
                </div>
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead class="bg-gray-50 border-b border-gray-200 text-xs font-bold text-gray-500 uppercase tracking-wider">
                                <tr>
                                    <th class="p-4 whitespace-nowrap min-w-[200px]">名前</th>
                                    <th class="p-4 whitespace-nowrap">役割</th>
                                    <th class="p-4 whitespace-nowrap">評価</th>
                                    <th class="p-4 whitespace-nowrap">給与形態</th>
                                    <th class="p-4 whitespace-nowrap">勤務制約</th>
                                    <th class="p-4 text-right whitespace-nowrap">操作</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-gray-100">
                                ${this.state.staff.map(s => {
                                    // 安全策: config.rolesが無い場合はデフォルトを使う
                                    const roleList = this.state.config.roles || this.state.defaultConfig.roles || [];
                                    const role = roleList.find(r => r.id === s.role) || { name: '未設定', color: 'gray' };
                                    const colorMap = {
                                        purple: 'bg-purple-50 text-purple-700 border-purple-100',
                                        blue: 'bg-blue-50 text-blue-700 border-blue-100',
                                        green: 'bg-green-50 text-green-700 border-green-100',
                                        yellow: 'bg-yellow-50 text-yellow-700 border-yellow-100',
                                        red: 'bg-red-50 text-red-700 border-red-100',
                                        gray: 'bg-gray-50 text-gray-700 border-gray-100'
                                    };
                                    const badgeClass = colorMap[role.color] || colorMap['gray'];
                                    
                                    return `
                                <tr class="hover:bg-gray-50 group transition-colors">
                                    <td class="p-4 whitespace-nowrap">
                                        <div class="flex items-center gap-3">
                                            <div class="w-9 h-9 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 border border-gray-200 flex items-center justify-center text-gray-500 font-bold text-sm shadow-sm">
                                                ${this._sanitize(s.name.charAt(0))}
                                            </div>
                                            <div>
                                                <div class="font-bold text-gray-800 text-sm">${this._sanitize(s.name)}</div>
                                                <div class="text-[10px] text-gray-400 font-mono">ID: ${s.id ? s.id.substr(0, 6) : '---'}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td class="p-4 whitespace-nowrap">
                                        <span class="px-2.5 py-1 text-xs font-bold rounded-full border shadow-sm ${badgeClass}">
                                            ${this._sanitize(role.name)}
                                        </span>
                                    </td>
                                    <td class="p-4 whitespace-nowrap">
                                        ${s.evaluation === 'A' ? '<span class="bg-yellow-100 text-yellow-800 text-xs font-bold px-2 py-1 rounded-md border border-yellow-200 shadow-sm">A</span>' : ''}
                                        ${s.evaluation === 'B' ? '<span class="bg-blue-50 text-blue-800 text-xs font-bold px-2 py-1 rounded-md border border-blue-100 shadow-sm">B</span>' : ''}
                                        ${s.evaluation === 'C' ? '<span class="bg-gray-100 text-gray-600 text-xs font-bold px-2 py-1 rounded-md border border-gray-200 shadow-sm">C</span>' : ''}
                                        ${s.evaluation === 'D' ? '<span class="bg-red-50 text-red-600 text-xs font-bold px-2 py-1 rounded-md border border-red-100 shadow-sm">D</span>' : ''}
                                        ${!['A','B','C','D'].includes(s.evaluation) ? '<span class="text-xs text-gray-400">-</span>' : ''}
                                    </td>
                                    <td class="p-4 whitespace-nowrap text-sm text-gray-600 font-mono">
                                        ${s.salary_type === 'hourly' 
                                            ? `<div class="flex items-center gap-2"><span class="px-1.5 py-0.5 rounded bg-gray-100 text-[10px] text-gray-500 font-bold">時給</span> <span class="font-bold">¥${s.hourly_wage ? s.hourly_wage.toLocaleString() : '0'}</span></div>` 
                                            : `<div class="flex items-center gap-2"><span class="px-1.5 py-0.5 rounded bg-gray-100 text-[10px] text-gray-500 font-bold">月給</span> <span class="font-bold">¥${s.monthly_salary ? s.monthly_salary.toLocaleString() : '0'}</span></div>`}
                                    </td>
                                    <td class="p-4 whitespace-nowrap text-xs text-gray-500">
                                        <div class="flex items-center gap-3">
                                            <span class="flex items-center gap-1 bg-gray-50 px-2 py-1 rounded border border-gray-100" title="週の勤務日数上限"><i class="fa-regular fa-calendar-check text-gray-400"></i> 週${s.max_days_week || '-'}日</span>
                                            <span class="flex items-center gap-1 bg-gray-50 px-2 py-1 rounded border border-gray-100" title="1日の勤務時間上限"><i class="fa-regular fa-clock text-gray-400"></i> 1日${s.max_hours_day || '-'}h</span>
                                        </div>
                                    </td>
                                    <td class="p-4 text-right whitespace-nowrap">
                                        <div class="flex justify-end gap-2">
                                            <button onclick="app.editStaff('${s.id}')" class="w-8 h-8 flex items-center justify-center text-blue-600 hover:bg-blue-50 rounded-lg transition-colors border border-transparent hover:border-blue-100" title="編集">
                                                <i class="fa-solid fa-pen-to-square"></i>
                                            </button>
                                            <button onclick="app.deleteStaff('${s.id}')" class="w-8 h-8 flex items-center justify-center text-red-500 hover:bg-red-50 rounded-lg transition-colors border border-transparent hover:border-red-100" title="削除">
                                                <i class="fa-solid fa-trash"></i>
                                            </button>
                                        </div>
                                    </td>
                                </tr>`}).join('')}
                                ${this.state.staff.length === 0 ? '<tr><td colspan="5" class="p-12 text-center text-gray-400 flex flex-col items-center gap-2"><i class="fa-solid fa-users-slash text-3xl mb-2 text-gray-300"></i><span>スタッフが登録されていません</span></td></tr>' : ''}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    },

    // =================================================================
    // 6. 設定 (Settings) - Admin Only
    // =================================================================
    renderSettings(container) {
        if (!this.state.isAdmin) return;
        const config = this.state.config;
        
        const times = config.opening_times || this.state.defaultConfig.opening_times;
        const reqs = config.staff_req || this.state.defaultConfig.staff_req;
        const closedDays = config.closed_days || [];
        const customShifts = config.custom_shifts || [];
        const roles = config.roles || this.state.defaultConfig.roles;
        const breakRules = config.break_rules || this.state.defaultConfig.break_rules;
        const shopRulesText = config.shop_rules_text || this.state.defaultConfig.shop_rules_text;
        const specialHolidays = config.special_holidays || [];
        const specialDays = config.special_days || {};
        const timeStaffReq = config.time_staff_req || [];
        const positions = config.positions || ['ホール', 'キッチン'];

        container.innerHTML = `
            <div class="max-w-4xl mx-auto space-y-8 pb-24">
                <div class="flex items-center justify-between border-b border-gray-200 pb-4">
                    <div>
                        <h2 class="text-2xl font-bold text-gray-800">店舗設定</h2>
                        <p class="text-sm text-gray-500 mt-1">AIシフト生成に使われるルールです。</p>
                    </div>
                    <button onclick="app.saveSettings()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-save mr-2"></i>設定を保存
                    </button>
                </div>

                <div class="mb-6 p-4 bg-purple-50 border-l-4 border-purple-500 rounded-lg text-sm text-purple-900 leading-relaxed shadow-sm">
                    <strong><i class="fa-solid fa-triangle-exclamation text-purple-600 mr-2"></i> 【重要】店舗設定の正確さがAIの精度を決めます</strong><br>
                    <div class="mt-2 space-y-2">
                        <p>ラクシフトAIは、ここに入力された条件を「店舗の絶対的なルール」として学習しシフトを組みます。</p>
                        <p>・<span class="font-bold text-purple-700">正確に設定した場合</span>：時間帯ごとの最適な人員配置、管理者の確実なカバー、休憩の自動付与など「店長が頭を抱えていたパズル」を完璧に解いたシフトを生成します。</p>
                        <p>・<span class="font-bold text-red-500">設定が甘い場合</span>（例: 必要な人数を全て0にする、管理者を設定しない等）：AIは「何人でも良い」「誰でも良い」と判断するため、人が足りない時間帯ができたり、法律上は問題なくても実用的でないシフトが出来上がってしまいます。</p>
                        <p class="font-bold mt-2">※特に「営業時間内の管理者カバー」と「時間帯別の必要人数」は、店舗の実態に合わせて正確に入力してください。</p>
                    </div>
                </div>

                <!-- 1. 役職・ロール設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-id-badge text-indigo-500"></i> 役職・ロール設定</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">スタッフの肩書きを設定します。AIは「Manager」を管理者、「Rookie」を新人として自動判定します。</p>
                        <button onclick="app.addRole()" class="text-xs bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg font-bold hover:bg-indigo-200 transition">
                            <i class="fa-solid fa-plus mr-1"></i>役職追加
                        </button>
                    </div>
                    <div class="p-6">
                        <div class="overflow-x-auto">
                            <table class="w-full text-left">
                                <thead class="bg-gray-50 text-xs text-gray-500 uppercase font-bold">
                                    <tr>
                                        <th class="p-3 rounded-l-lg">役職名</th>
                                        <th class="p-3">識別ID</th>
                                        <th class="p-3">バッジカラー</th>
                                        <th class="p-3 text-right rounded-r-lg">操作</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100" id="rolesBody">
                                    ${roles.map((role, index) => `
                                        <tr class="group hover:bg-gray-50">
                                            <td class="p-2">
                                                <input type="text" class="setting-role-name w-full border-gray-300 rounded px-2 py-1.5 text-sm font-bold" value="${role.name}" placeholder="役職名">
                                            </td>
                                            <td class="p-2">
                                                <input type="text" class="setting-role-id w-full border-gray-300 rounded px-2 py-1.5 text-sm bg-gray-50" value="${role.id}" readonly title="IDは変更できません">
                                            </td>
                                            <td class="p-2">
                                                <select class="setting-role-color w-full border-gray-300 rounded px-2 py-1.5 text-sm">
                                                    <option value="purple" ${role.color==='purple'?'selected':''}>紫 (Manager)</option>
                                                    <option value="blue" ${role.color==='blue'?'selected':''}>青 (Leader)</option>
                                                    <option value="green" ${role.color==='green'?'selected':''}>緑 (Staff)</option>
                                                    <option value="yellow" ${role.color==='yellow'?'selected':''}>黄 (Rookie)</option>
                                                    <option value="red" ${role.color==='red'?'selected':''}>赤 (Admin)</option>
                                                    <option value="gray" ${role.color==='gray'?'selected':''}>灰 (Other)</option>
                                                </select>
                                            </td>
                                            <td class="p-2 text-right">
                                                <button onclick="app.deleteRole(${index})" class="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50 transition" ${role.id==='manager'||role.id==='staff'?'disabled title="基本役職は削除できません" style="opacity:0.3"':''}>
                                                    <i class="fa-solid fa-trash"></i>
                                                </button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                        <p class="text-xs text-gray-400 mt-3">※ IDはシステム内部で使用するため変更できません。新規追加時のみ自動生成されます。</p>
                    </div>
                </div>

                <!-- 1.5. ポジション設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden mt-8">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-map-pin text-teal-500"></i> ポジション設定</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">店舗内の役割（ホール、キッチンなど）を自由に設定できます。</p>
                    </div>
                    <div class="p-6">
                        <label class="block text-xs font-bold text-gray-500 mb-2">ポジション一覧（スペース・読点等で区切って入力）</label>
                        <input type="text" id="settingPositions" class="w-full border-gray-300 rounded-lg px-3 py-2 text-sm font-bold bg-white" value="${positions.join('　')}" placeholder="例: ホール　キッチン　デリバリー">
                        <p class="text-xs text-gray-400 mt-3">※ ここで設定したポジションは、スタッフ管理の「担当ポジション」や、時間帯別ルールの「ポジション指定」の選択肢になります。</p>
                        <div class="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs text-yellow-800 leading-relaxed">
                            <i class="fa-solid fa-circle-exclamation mr-1 text-yellow-600"></i> <strong>【重要】ポジション変更時のご注意</strong><br>
                            稼働中にポジション名を変更・削除すると、過去にそのポジションに設定されていたスタッフは「指定なし (全般)」として扱われます。なるべく初期設定の段階でポジションを確定させてください。
                        </div>
                    </div>
                </div>

                <!-- 2. 営業時間・定休日 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-regular fa-clock text-blue-500"></i> 営業時間 & 定休日</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">AIはこの時間帯の中でだけシフトを生成します。定休日にはシフトを入れません。</p>
                    </div>
                    <div class="p-6 space-y-8">
                        <!-- 営業時間 -->
                        <div class="space-y-4">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider">営業時間設定</h4>
                            <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center border-b border-gray-50 pb-4">
                                <div class="md:col-span-3 font-bold text-gray-700">平日 (月-金)</div>
                                <div class="md:col-span-9 flex items-center gap-3">
                                    ${this.get15MinTimeSelect(times.weekday?.start || '09:00', 'time_weekday_start', 'form-input border-gray-300 rounded-lg w-full')}
                                    <span class="text-gray-400">～</span>
                                    ${this.get15MinTimeSelect(times.weekday?.end || '22:00', 'time_weekday_end', 'form-input border-gray-300 rounded-lg w-full')}
                                </div>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center border-b border-gray-50 pb-4">
                                <div class="md:col-span-3 font-bold text-blue-600">土曜日</div>
                                <div class="md:col-span-9 flex items-center gap-3">
                                    ${this.get15MinTimeSelect(times.weekend?.start || '10:00', 'time_weekend_start', 'form-input border-gray-300 rounded-lg w-full')}
                                    <span class="text-gray-400">～</span>
                                    ${this.get15MinTimeSelect(times.weekend?.end || '20:00', 'time_weekend_end', 'form-input border-gray-300 rounded-lg w-full')}
                                </div>
                            </div>
                            <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                                <div class="md:col-span-3 font-bold text-red-600">日祝日</div>
                                <div class="md:col-span-9 flex items-center gap-3">
                                    ${this.get15MinTimeSelect(times.holiday?.start || '10:00', 'time_holiday_start', 'form-input border-gray-300 rounded-lg w-full')}
                                    <span class="text-gray-400">～</span>
                                    ${this.get15MinTimeSelect(times.holiday?.end || '20:00', 'time_holiday_end', 'form-input border-gray-300 rounded-lg w-full')}
                                </div>
                            </div>
                        </div>

                        <!-- 定休日 -->
                        <div class="pt-4 border-t border-gray-100">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">定休日設定</h4>
                            <div class="flex flex-wrap gap-4 mb-4">
                                ${['日', '月', '火', '水', '木', '金', '土'].map((day, i) => `
                                    <label class="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-gray-50 border border-transparent hover:border-gray-200 transition">
                                        <input type="checkbox" name="setting_closed_days" value="${i}" class="w-5 h-5 text-red-500 rounded focus:ring-red-500 border-gray-300" ${closedDays.map(Number).includes(i) ? 'checked' : ''}>
                                        <span class="font-bold ${i===0?'text-red-500':i===6?'text-blue-500':'text-gray-700'}">${day}曜日</span>
                                    </label>
                                `).join('')}
                            </div>
                            
                            <!-- 臨時休業 -->
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">臨時休業設定</h4>
                            <div class="flex items-center gap-3 mb-3">
                                <input type="date" id="newSpecialHoliday" class="border-gray-300 rounded-lg px-3 py-1.5 text-sm">
                                <button onclick="app.addSpecialHoliday()" class="bg-red-50 text-red-600 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-red-100 transition">追加</button>
                            </div>
                            <div class="flex flex-wrap gap-2">
                                ${specialHolidays.map((date, idx) => `
                                    <div class="bg-red-50 border border-red-100 text-red-700 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-2">
                                        ${date} <button onclick="app.removeSpecialHoliday(${idx})" class="hover:text-red-900"><i class="fa-solid fa-times"></i></button>
                                    </div>
                                `).join('')}
                                ${specialHolidays.length === 0 ? '<span class="text-xs text-gray-400">設定なし</span>' : ''}
                            </div>
                            
                            <!-- 特定日の営業時間（短縮営業など） -->
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mt-4 mb-3">特定日の営業時間変更 (短縮営業など)</h4>
                            <div class="space-y-3" id="specialDaysContainer">
                                <div class="flex items-center gap-2 flex-wrap bg-yellow-50 p-2 rounded-lg border border-yellow-100">
                                    <input type="date" id="newSpecialDayDate" class="border-gray-300 rounded px-2 py-1 text-sm">
                                    <div class="w-24">${this.get15MinTimeSelect('', 'newSpecialDayStart', 'border-gray-300 rounded px-2 py-1 text-sm w-full')}</div>
                                    <span class="text-gray-400 text-xs">～</span>
                                    <div class="w-24">${this.get15MinTimeSelect('', 'newSpecialDayEnd', 'border-gray-300 rounded px-2 py-1 text-sm w-full')}</div>
                                    <input type="text" id="newSpecialDayNote" class="border-gray-300 rounded px-2 py-1 text-sm w-24" placeholder="メモ (例: 短縮)">
                                    <button onclick="app.addSpecialDay()" class="bg-yellow-100 text-yellow-700 px-3 py-1 rounded text-xs font-bold hover:bg-yellow-200 transition">追加</button>
                                </div>
                                
                                <div class="space-y-2">
                                    ${Object.entries(specialDays).map(([date, conf]) => `
                                        <div class="flex items-center justify-between bg-white border border-gray-200 px-3 py-2 rounded-lg text-sm">
                                            <div class="flex items-center gap-3">
                                                <span class="font-bold text-gray-800">${this._sanitize(date)}</span>
                                                <span class="bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded text-xs font-mono">${this._sanitize(conf.start)} - ${this._sanitize(conf.end)}</span>
                                                <span class="text-gray-500 text-xs">${this._sanitize(conf.note || '')}</span>
                                            </div>
                                            <button onclick="app.removeSpecialDay('${date}')" class="text-gray-400 hover:text-red-500"><i class="fa-solid fa-trash"></i></button>
                                        </div>
                                    `).join('')}
                                    ${Object.keys(specialDays).length === 0 ? '<p class="text-xs text-gray-400 pl-2">設定なし</p>' : ''}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 3. シフトパターン設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-layer-group text-purple-500"></i> シフトパターン (早番/遅番など)</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">AIが組み合わせるシフトの「型」です。例：早番9-14時、遅番17-22時など。</p>
                        <button onclick="app.addShiftPattern()" class="text-xs bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg font-bold hover:bg-purple-200 transition">
                            <i class="fa-solid fa-plus mr-1"></i>追加
                        </button>
                    </div>
                    <div class="p-6">
                        <div class="overflow-x-auto">
                            <table class="w-full text-left">
                                <thead class="bg-gray-50 text-xs text-gray-500 uppercase font-bold">
                                    <tr>
                                        <th class="p-3 rounded-l-lg">パターン名</th>
                                        <th class="p-3">開始時間</th>
                                        <th class="p-3">終了時間</th>
                                        <th class="p-3 text-right rounded-r-lg">操作</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100" id="shiftPatternsBody">
                                    ${customShifts.map((shift, index) => `
                                        <tr class="group hover:bg-gray-50">
                                            <td class="p-2">
                                                <input type="text" class="setting-shift-name w-full border-gray-300 rounded px-2 py-1.5 text-sm font-bold" value="${shift.name}" placeholder="例: 早番">
                                            </td>
                                            <td class="p-2">
                                                ${this.get15MinTimeSelect(shift.start, '', 'setting-shift-start w-full border-gray-300 rounded px-2 py-1.5 text-sm')}
                                            </td>
                                            <td class="p-2">
                                                ${this.get15MinTimeSelect(shift.end, '', 'setting-shift-end w-full border-gray-300 rounded px-2 py-1.5 text-sm')}
                                            </td>
                                            <td class="p-2 text-right">
                                                <button onclick="app.deleteShiftPattern(${index})" class="text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-50 transition">
                                                    <i class="fa-solid fa-trash"></i>
                                                </button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                    ${customShifts.length === 0 ? '<tr><td colspan="4" class="p-4 text-center text-gray-400 text-sm">シフトパターンが登録されていません。「追加」ボタンまたはプリセットから登録してください。</td></tr>' : ''}
                                </tbody>
                            </table>
                        </div>
                        <p class="text-xs text-gray-400 mt-3">💡 ここで登録したパターンの中からAIが最適な組み合わせを選びます。パターンが多いほどAIの選択肢が広がります。</p>
                        <div class="mt-4 pt-4 border-t border-gray-100">
                            <p class="text-xs font-bold text-gray-500 mb-2"><i class="fa-solid fa-wand-magic-sparkles text-purple-400 mr-1"></i>プリセットから一括追加</p>
                            <div class="flex flex-wrap gap-2">
                                <button onclick="app.applyShiftPreset('restaurant')" class="text-xs bg-orange-50 text-orange-600 border border-orange-200 px-3 py-1.5 rounded-lg font-bold hover:bg-orange-100 transition">
                                    <i class="fa-solid fa-utensils mr-1"></i>飲食店向け
                                </button>
                                <button onclick="app.applyShiftPreset('office')" class="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-3 py-1.5 rounded-lg font-bold hover:bg-blue-100 transition">
                                    <i class="fa-solid fa-building mr-1"></i>オフィス向け
                                </button>
                                <button onclick="app.applyShiftPreset('retail')" class="text-xs bg-green-50 text-green-600 border border-green-200 px-3 py-1.5 rounded-lg font-bold hover:bg-green-100 transition">
                                    <i class="fa-solid fa-store mr-1"></i>小売店向け
                                </button>
                                <button onclick="app.applyShiftPreset('medical')" class="text-xs bg-pink-50 text-pink-600 border border-pink-200 px-3 py-1.5 rounded-lg font-bold hover:bg-pink-100 transition">
                                    <i class="fa-solid fa-hospital mr-1"></i>医療・介護向け
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 4. 人員配置ルール -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-users text-green-500"></i> 人員配置要件</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">「最低何人いればお店が回るか」を設定します。AIはこの人数を必ず確保しようとします。</p>
                    </div>
                    <div class="p-6">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-6">
                            <div>
                                <h4 class="text-sm font-bold text-gray-700 mb-4 border-b border-gray-100 pb-2">管理者要件</h4>
                                <div>
                                    <label class="block text-xs font-bold text-gray-500 mb-1">最低管理者数 (店長/リーダー)</label>
                                    <input type="number" id="req_min_manager" class="w-full border-gray-300 rounded-lg px-3 py-2" value="${reqs.min_manager || 1}">
                                    <p class="text-xs text-gray-400 mt-1">営業中に常に最低1名の管理者(店長/リーダー)がいるように制御します</p>
                                </div>
                            </div>
                            <div>
                                <h4 class="text-sm font-bold text-gray-700 mb-4 border-b border-gray-100 pb-2">スタッフ総数要件</h4>
                                <div class="space-y-4">
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-gray-600">平日</label>
                                        <input type="number" id="req_min_weekday" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_weekday || reqs.min_total || 2}">
                                    </div>
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-blue-600">土日</label>
                                        <input type="number" id="req_min_weekend" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_weekend || reqs.min_total || 3}">
                                    </div>
                                    <div class="grid grid-cols-3 gap-2 items-center">
                                        <label class="text-xs font-bold text-red-600">祝日</label>
                                        <input type="number" id="req_min_holiday" class="col-span-2 border-gray-300 rounded-lg px-3 py-1.5" value="${reqs.min_holiday || reqs.min_total || 3}">
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- 時間帯別人員配置 -->
                        <div class="border-t border-gray-100 pt-4">
                            <div class="flex justify-between items-center mb-3">
                                <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider">時間帯別・曜日別 人員増強</h4>
                                <button onclick="app.addTimeStaffReq()" class="text-xs bg-green-100 text-green-700 px-3 py-1.5 rounded-lg font-bold hover:bg-green-200 transition">
                                    <i class="fa-solid fa-plus mr-1"></i>ルール追加
                                </button>
                            </div>
                            <div class="overflow-x-auto">
                                <table class="w-full text-left text-sm">
                                    <thead class="bg-gray-50 text-xs text-gray-500">
                                        <tr>
                                            <th class="p-2 w-1/3">曜日</th>
                                            <th class="p-2">開始</th>
                                            <th class="p-2">終了</th>
                                            <th class="p-2">人数</th>
                                            <th class="p-2 w-1/4">ポジション</th>
                                            <th class="p-2 text-right"></th>
                                        </tr>
                                    </thead>
                                    <tbody id="timeStaffReqBody" class="divide-y divide-gray-50">
                                        ${timeStaffReq.map((rule, idx) => {
                                            const daysStr = ['日','月','火','水','木','金','土'];
                                            return `
                                            <tr>
                                                <td class="p-2">
                                                    <div class="flex flex-wrap gap-1">
                                                    ${daysStr.map((d, i) => `
                                                        <label class="cursor-pointer select-none">
                                                            <input type="checkbox" class="hidden peer setting-time-req-day-${idx}" value="${i}" ${rule.days.includes(i) ? 'checked' : ''}>
                                                            <span class="block w-6 h-6 text-center leading-6 rounded text-xs font-bold peer-checked:bg-green-500 peer-checked:text-white bg-gray-100 text-gray-400 hover:bg-gray-200 transition-colors">${d}</span>
                                                        </label>
                                                    `).join('')}
                                                    </div>
                                                </td>
                                                <td class="p-2">
                                                    ${this.get15MinTimeSelect(rule.start, '', 'setting-time-req-start border-gray-300 rounded px-2 py-1 text-xs w-full')}
                                                </td>
                                                <td class="p-2">
                                                    ${this.get15MinTimeSelect(rule.end, '', 'setting-time-req-end border-gray-300 rounded px-2 py-1 text-xs w-full')}
                                                </td>
                                                <td class="p-2"><input type="number" class="setting-time-req-count border-gray-300 rounded px-2 py-1 text-xs w-12 text-center font-bold" value="${rule.count}"></td>
                                                <td class="p-2">
                                                    <select class="setting-time-req-position border-gray-300 rounded px-2 py-1 text-xs w-full font-bold">
                                                        <option value="any" ${rule.position === 'any' || !rule.position ? 'selected' : ''}>全般 (区別なし)</option>
                                                        ${positions.map(p => `<option value="${this._sanitize(p)}" ${rule.position === p ? 'selected' : ''}>${this._sanitize(p)}のみ</option>`).join('')}
                                                    </select>
                                                </td>
                                                <td class="p-2 text-right"><button onclick="app.removeTimeStaffReq(${idx})" class="text-red-400 hover:text-red-600"><i class="fa-solid fa-trash"></i></button></td>
                                            </tr>
                                            `;
                                        }).join('')}
                                    </tbody>
                                </table>
                                ${timeStaffReq.length === 0 ? '<p class="text-xs text-gray-400 text-center py-4">特定の時間帯（例：ランチタイム）に必要な人数を設定できます</p>' : ''}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 5. システム設定 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-gears text-gray-500"></i> システム設定</h3>
                        <p class="text-xs text-gray-400 font-normal ml-6">時給の初期値、管理者パスワード、休憩ルールなどの基本設定です。</p>
                    </div>
                    <div class="p-6 space-y-6">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">デフォルト時給 (円)</label>
                                <input type="number" id="settingHourlyWage" class="w-full border border-gray-300 rounded-lg px-3 py-2" value="${config.hourly_wage_default || 1100}">
                            </div>
                            
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">管理者パスワード</label>
                                <div class="w-full border border-gray-200 bg-gray-50 rounded-lg px-3 py-2 font-mono text-gray-400 tracking-wider select-none">••••••••</div>
                                <p class="text-[11px] text-gray-400 mt-1">セキュリティのため画面表示しません。変更は下の「管理者パスワードを変更」ボタンから</p>
                            </div>
                        </div>

                        <div class="border-t border-gray-100 pt-4 flex flex-wrap gap-3">
                            <button onclick="app.openModal('changePasswordModal')" class="flex items-center gap-2 text-sm font-bold text-amber-600 bg-amber-50 border border-amber-200 px-4 py-2.5 rounded-lg hover:bg-amber-100 transition">
                                <i class="fa-solid fa-key"></i> 店舗ログインパスワードを変更
                            </button>
                            <button onclick="app.openAdminPasswordChange()" class="flex items-center gap-2 text-sm font-bold text-purple-600 bg-purple-50 border border-purple-200 px-4 py-2.5 rounded-lg hover:bg-purple-100 transition">
                                <i class="fa-solid fa-user-shield"></i> 管理者パスワードを変更
                            </button>
                            <p class="text-xs text-gray-400 mt-1 w-full">※ 店舗パスワード=日常閲覧用 / 管理者パスワード=編集権限用</p>
                        </div>

                        <!-- AI設定 (運営管理のため非表示) -->
                        
                        <!-- 休憩時間ルール -->
                        <div class="border-t border-gray-100 pt-4">
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">休憩時間ルール</h4>
                            <div class="space-y-3" id="breakRulesContainer">
                                ${breakRules.map((rule, idx) => `
                                    <div class="flex items-center gap-3">
                                        <div class="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                                            <input type="number" class="setting-break-hours w-16 border-gray-300 rounded px-2 py-1 text-sm text-center font-bold" value="${rule.min_hours}">
                                            <span class="text-xs text-gray-500">時間超で</span>
                                        </div>
                                        <i class="fa-solid fa-arrow-right text-gray-300 text-xs"></i>
                                        <div class="flex items-center gap-2 bg-blue-50 px-3 py-2 rounded-lg border border-blue-100">
                                            <input type="number" class="setting-break-minutes w-16 border-blue-200 rounded px-2 py-1 text-sm text-center font-bold text-blue-700" value="${rule.break_minutes}">
                                            <span class="text-xs text-blue-500">分休憩</span>
                                        </div>
                                        <button onclick="app.removeBreakRule(${idx})" class="text-gray-400 hover:text-red-500 ml-2"><i class="fa-solid fa-times"></i></button>
                                    </div>
                                `).join('')}
                            </div>
                            <button onclick="app.addBreakRule()" class="mt-3 text-xs flex items-center gap-1 text-blue-600 font-bold hover:text-blue-800"><i class="fa-solid fa-plus-circle"></i> ルールを追加</button>
                        </div>
                    </div>
                </div>

                <!-- 6. 運用ルール (お店のルール) -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-clipboard-list text-orange-500"></i> 運用ルール (スタッフ向け表示)</h3>
                    </div>
                    <div class="p-6">
                        <label class="block text-xs font-bold text-gray-500 mb-2">お店のルール・連絡事項</label>
                        <textarea id="settingShopRules" class="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm min-h-[60px] sm:min-h-[120px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="シフト提出期限や注意事項などを入力してください...">${shopRulesText}</textarea>
                        <p class="text-xs text-gray-400 mt-2">※ ここに入力した内容は、スタッフ画面の「お店のルール」に表示されます。</p>
                    </div>
                </div>
                
                <!-- 7. アカウント情報 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-user-gear text-indigo-500"></i> アカウント情報</h3>
                    </div>
                    <div class="p-6 space-y-4">
                        <div>
                            <label class="block text-xs font-bold text-gray-500 mb-1">契約ID</label>
                            <p class="font-mono text-lg font-bold text-gray-800">${config.contract_id || '-'}</p>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-gray-500 mb-1">登録メールアドレス</label>
                            <div class="flex gap-2">
                                <input type="email" id="settingEmail" value="${config.customer_email || ''}" class="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="メールアドレスを入力">
                                <button onclick="app.updateEmail()" class="px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 transition whitespace-nowrap">
                                    <i class="fa-solid fa-save mr-1"></i>変更
                                </button>
                            </div>
                            <p class="text-xs text-gray-400 mt-1">案内メールの送信先アドレスです</p>
                        </div>
                    </div>
                </div>

                <!-- 8. プラン管理 -->
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                    <div class="p-4 border-b border-gray-100 bg-gray-50">
                        <h3 class="font-bold text-gray-800 flex items-center gap-2"><i class="fa-solid fa-credit-card text-green-500"></i> プラン管理</h3>
                    </div>
                    <div class="p-6 space-y-5" id="subscriptionSection">
                        <!-- 現在のプラン表示 -->
                        <div class="bg-gradient-to-r ${
                            (config.stripe_plan === 'premium') ? 'from-purple-500 to-indigo-600' :
                            (config.stripe_plan === 'pro') ? 'from-green-500 to-emerald-600' :
                            'from-blue-500 to-indigo-600'
                        } rounded-xl p-5 text-white">
                            <div class="flex items-center justify-between">
                                <div>
                                    <p class="text-white/70 text-xs font-medium">現在ご利用中のプラン</p>
                                    <p class="text-3xl font-extrabold mt-1">${{standard:'Standard', pro:'Pro', premium:'Premium'}[config.stripe_plan] || 'Standard'}</p>
                                    <p class="text-white/80 text-sm mt-1">${{standard:'3,380円/月 - スタッフ10名まで', pro:'4,880円/月 - スタッフ50名まで', premium:'9,980円/月 - スタッフ無制限'}[config.stripe_plan] || '3,380円/月 - スタッフ10名まで'}</p>
                                </div>
                                <div class="text-right">
                                    <span class="inline-flex items-center gap-1.5 px-3 py-1 bg-white/20 rounded-full text-sm font-bold backdrop-blur-sm">
                                        <i class="fa-solid fa-circle-check text-xs"></i> 有効
                                    </span>
                                </div>
                            </div>
                        </div>

                        <!-- プラン変更カード -->
                        <div>
                            <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">プラン変更</h4>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                                ${[
                                    { key: 'standard', name: 'Standard', price: '3,380', staffs: '10名', color: 'blue', features: ['スタッフ10名まで', 'AI自動シフト生成', 'AI労基法チェック', 'シフト管理全機能'] },
                                    { key: 'pro', name: 'Pro', price: '4,880', staffs: '50名', color: 'green', badge: '人気', features: ['スタッフ50名まで', '全AI機能', '優先サポート', '分析レポート'] },
                                    { key: 'premium', name: 'Premium', price: '9,980', staffs: '無制限', color: 'purple', features: ['スタッフ無制限', '全AI機能', '複数店舗対応', '専属サポート'] },
                                ].map(p => {
                                    const currentPlanKey = (config.stripe_plan && config.stripe_plan !== 'free') ? config.stripe_plan : 'standard';
                                    const isCurrent = currentPlanKey === p.key;
                                    const planOrder = {standard: 0, pro: 1, premium: 2};
                                    const currentOrder = planOrder[currentPlanKey] || 0;
                                    const thisOrder = planOrder[p.key] || 0;
                                    const isUpgrade = thisOrder > currentOrder;
                                    const isDowngrade = thisOrder < currentOrder;

                                    const borderClass = isCurrent
                                        ? (p.color === 'blue' ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200' : p.color === 'green' ? 'border-green-500 bg-green-50 ring-2 ring-green-200' : 'border-purple-500 bg-purple-50 ring-2 ring-purple-200')
                                        : 'border-gray-200 hover:border-gray-300 hover:shadow-md';

                                    const badgeHtml = p.badge && !isCurrent ? '<div class="text-[10px] font-bold text-green-700 bg-green-200 rounded-full px-2 py-0.5 inline-block mb-1">人気</div>' : '';
                                    const currentBadge = isCurrent ? '<div class="text-[10px] font-bold text-white bg-gray-800 rounded-full px-2 py-0.5 inline-block mb-1">現在のプラン</div>' : '';

                                    let btnHtml = '';
                                    if (isCurrent) {
                                        btnHtml = '<p class="mt-3 text-xs font-bold text-gray-500 text-center py-1.5"><i class="fa-solid fa-circle-check mr-1"></i>ご利用中</p>';
                                    } else if (isUpgrade) {
                                        const btnColor = p.color === 'green' ? 'bg-green-600 hover:bg-green-700' : 'bg-purple-600 hover:bg-purple-700';
                                        btnHtml = '<button onclick="app.startCheckout(&#39;'+p.key+'&#39;)" class="mt-3 w-full py-2 '+btnColor+' text-white rounded-lg text-xs font-bold transition"><i class="fa-solid fa-arrow-up mr-1"></i>アップグレード</button>';
                                    } else {
                                        btnHtml = '<button onclick="app.startCheckout(&#39;'+p.key+'&#39;)" class="mt-3 w-full py-2 bg-gray-200 text-gray-600 rounded-lg text-xs font-bold hover:bg-gray-300 transition"><i class="fa-solid fa-arrow-down mr-1"></i>ダウングレード</button>';
                                    }

                                    const checkColor = p.color === 'blue' ? 'text-blue-500' : p.color === 'green' ? 'text-green-500' : 'text-purple-500';
                                    const nameColor = p.color === 'blue' ? 'text-blue-600' : p.color === 'green' ? 'text-green-600' : 'text-purple-600';

                                    return '<div class="p-4 rounded-xl border-2 '+borderClass+' transition-all duration-200 text-center flex flex-col hover:-translate-y-1 hover:shadow-xl">'
                                        + currentBadge + badgeHtml
                                        + '<p class="font-bold '+nameColor+' text-lg">'+p.name+'</p>'
                                        + '<p class="text-2xl font-extrabold text-gray-900 mt-1">'+p.price+'<span class="text-sm font-normal text-gray-400">円/月</span></p>'
                                        + '<p class="text-xs text-gray-500 mt-1">スタッフ'+p.staffs+'</p>'
                                        + '<ul class="text-xs text-gray-600 mt-3 space-y-1 text-left flex-1">'
                                        + p.features.map(f => '<li class="flex items-center gap-1.5"><i class="fa-solid fa-check '+checkColor+' text-[10px]"></i>'+f+'</li>').join('')
                                        + '</ul>'
                                        + '<div class="mt-auto pt-3">'+btnHtml+'</div>'
                                        + '</div>';
                                }).join('')}
                            </div>
                        </div>

                        <!-- Stripeポータルリンク -->
                        ${config.stripe_subscription_id ? `
                        <div class="border-t border-gray-100 pt-4 flex justify-between items-center">
                            <p class="text-xs text-gray-400">請求書・支払い方法の変更・解約はStripeポータルから</p>
                            <button onclick="app.openStripePortal()" class="px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-xs font-bold hover:bg-gray-200 transition">
                                <i class="fa-solid fa-arrow-up-right-from-square mr-1"></i> 請求管理ポータル
                            </button>
                        </div>
                        ` : ''}
                    </div>
                </div>

                <!-- 下部保存ボタン -->
                <div class="flex items-center justify-between bg-white rounded-xl shadow-sm border border-gray-200 p-4">
                    <p class="text-sm text-gray-500"><i class="fa-solid fa-info-circle text-blue-400 mr-1"></i>上部の変更を含め、すべての設定を一括保存します</p>
                    <button onclick="app.saveSettings()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-8 rounded-lg shadow-md shadow-blue-200 transition-all transform active:scale-95 flex items-center whitespace-nowrap shrink-0">
                        <i class="fa-solid fa-save mr-2"></i>設定を保存
                    </button>
                </div>

                <!-- データリセット -->
                <div class="text-right">
                    <button onclick="if(confirm('【警告】全てのデータを削除して初期化しますか？')) { localStorage.clear(); location.reload(); }" class="text-red-500 text-xs hover:text-red-700 font-bold opacity-60 hover:opacity-100 transition">
                        <i class="fa-solid fa-trash mr-1"></i>全データをリセット
                    </button>
                </div>
            </div>
        `;
    },

    toggleLlmSettings() {
        const provider = document.querySelector('input[name="settingLlmProvider"]:checked')?.value;
        if (provider === 'openai') {
            document.getElementById('openaiSettings').classList.remove('hidden');
            document.getElementById('geminiSettings').classList.add('hidden');
        } else {
            document.getElementById('openaiSettings').classList.add('hidden');
            document.getElementById('geminiSettings').classList.remove('hidden');
        }
    },

    addRole() {
        this.state.config = this.readSettingsFromDOM();
        if(!this.state.config.roles) this.state.config.roles = [];
        // ユニークID生成
        const newId = 'role_' + Math.random().toString(36).substr(2, 5);
        this.state.config.roles.push({ id: newId, name: '新規役職', color: 'gray', level: 1 });
        this.renderSettings(document.getElementById('viewContainer'));
    },

    deleteRole(index) {
        this.state.config = this.readSettingsFromDOM();
        const role = this.state.config.roles[index];
        if(role.id === 'manager' || role.id === 'staff') {
            this.showToast('この役職は削除できません', 'error');
            return;
        }
        this.state.config.roles.splice(index, 1);
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addBreakRule() {
        this.state.config = this.readSettingsFromDOM();
        if(!this.state.config.break_rules) this.state.config.break_rules = [];
        this.state.config.break_rules.push({ min_hours: 0, break_minutes: 60 });
        this.renderSettings(document.getElementById('viewContainer'));
    },

    removeBreakRule(index) {
        this.state.config = this.readSettingsFromDOM();
        this.state.config.break_rules.splice(index, 1);
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addSpecialHoliday() {
        const dateInput = document.getElementById('newSpecialHoliday');
        const date = dateInput.value;
        if(!date) return;
        
        this.state.config = this.readSettingsFromDOM();
        if(!this.state.config.special_holidays) this.state.config.special_holidays = [];
        if(!this.state.config.special_holidays.includes(date)) {
            this.state.config.special_holidays.push(date);
            this.state.config.special_holidays.sort();
        }
        this.renderSettings(document.getElementById('viewContainer'));
    },

    removeSpecialHoliday(index) {
        this.state.config = this.readSettingsFromDOM(); // 現在の入力を保存
        if(this.state.config.special_holidays) {
            this.state.config.special_holidays.splice(index, 1);
        }
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addSpecialDay() {
        const date = (document.getElementById('newSpecialDayDate')?.value || '');
        const start = (document.getElementById('newSpecialDayStart')?.value || '');
        const end = (document.getElementById('newSpecialDayEnd')?.value || '');
        const note = (document.getElementById('newSpecialDayNote')?.value || '');

        if(!date || !start || !end) return;

        this.state.config = this.readSettingsFromDOM(); // 現在の入力を保存
        if(!this.state.config.special_days) this.state.config.special_days = {};
        
        this.state.config.special_days[date] = { start, end, note };
        this.renderSettings(document.getElementById('viewContainer'));
    },

    removeSpecialDay(date) {
        this.state.config = this.readSettingsFromDOM(); // 現在の入力を保存
        if(this.state.config.special_days) {
            delete this.state.config.special_days[date];
        }
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addTimeStaffReq() {
        this.state.config = this.readSettingsFromDOM();
        if(!this.state.config.time_staff_req) this.state.config.time_staff_req = [];
        this.state.config.time_staff_req.push({ days: [1,2,3,4,5], start: '11:00', end: '14:00', count: 2 });
        this.renderSettings(document.getElementById('viewContainer'));
    },

    removeTimeStaffReq(index) {
        this.state.config = this.readSettingsFromDOM();
        this.state.config.time_staff_req.splice(index, 1);
        this.renderSettings(document.getElementById('viewContainer'));
    },

    addShiftPattern() {
        // 現在の入力を一時保存
        this.state.config = this.readSettingsFromDOM();
        // 新しい空行を追加
        if(!this.state.config.custom_shifts) this.state.config.custom_shifts = [];
        this.state.config.custom_shifts.push({ name: '', start: '09:00', end: '18:00' });
        // 再描画
        this.renderSettings(document.getElementById('viewContainer'));
    },

    deleteShiftPattern(index) {
        // 現在の入力を一時保存
        this.state.config = this.readSettingsFromDOM();
        // 削除
        this.state.config.custom_shifts.splice(index, 1);
        // 再描画
        this.renderSettings(document.getElementById('viewContainer'));
    },

    readSettingsFromDOM() {
        const config = { ...this.state.config }; // 既存の設定をコピー

        // 基本設定
        config.hourly_wage_default = Number(document.getElementById('settingHourlyWage')?.value || 1100);
        // admin_password は専用モーダル + update_admin_password_by_contract RPC でのみ変更可
        // (config_safe view から除外され、ここで読んでも空文字なので参照しない)
        config.shop_rules_text = document.getElementById('settingShopRules')?.value || '';

        // 営業時間
        const getVal = (id) => document.getElementById(id)?.value;
        config.opening_times = {
            weekday: { start: getVal('time_weekday_start') || '09:00', end: getVal('time_weekday_end') || '22:00' },
            weekend: { start: getVal('time_weekend_start') || '10:00', end: getVal('time_weekend_end') || '20:00' },
            holiday: { start: getVal('time_holiday_start') || '10:00', end: getVal('time_holiday_end') || '20:00' }
        };
        // 旧互換
        config.opening_time = config.opening_times.weekday.start;
        config.closing_time = config.opening_times.weekday.end;

        // 定休日
        config.closed_days = Array.from(document.querySelectorAll('input[name="setting_closed_days"]:checked')).map(el => parseInt(el.value));

        // ポジション設定
        const posInput = document.getElementById('settingPositions')?.value || '';
        config.positions = posInput.split(/[,、\s　]+/).map(p => p.trim()).filter(p => p !== '');
        if (config.positions.length === 0) config.positions = ['ホール', 'キッチン'];

        // 役職・ロール設定
        const roleNames = document.querySelectorAll('.setting-role-name');
        const roleIds = document.querySelectorAll('.setting-role-id');
        const roleColors = document.querySelectorAll('.setting-role-color');

        const existingRoles = this.state.config.roles || [];
        config.roles = [];
        roleNames.forEach((el, i) => {
            if (el.value) {
                const rId = roleIds[i].value;
                const prev = existingRoles.find(r => r.id === rId);
                config.roles.push({
                    id: rId,
                    name: el.value,
                    color: roleColors[i].value,
                    level: prev ? prev.level : 1
                });
            }
        });

        // シフトパターン
        const shiftNames = document.querySelectorAll('.setting-shift-name');
        const shiftStarts = document.querySelectorAll('.setting-shift-start');
        const shiftEnds = document.querySelectorAll('.setting-shift-end');

        config.custom_shifts = [];
        shiftNames.forEach((el, i) => {
            if (el.value) {
                config.custom_shifts.push({
                    name: el.value,
                    start: shiftStarts[i].value,
                    end: shiftEnds[i].value
                });
            }
        });

        // 人員配置ルール
        config.staff_req = {
            min_manager: Number(document.getElementById('req_min_manager')?.value || 1),
            min_weekday: Number(document.getElementById('req_min_weekday')?.value || 2),
            min_weekend: Number(document.getElementById('req_min_weekend')?.value || 3),
            min_holiday: Number(document.getElementById('req_min_holiday')?.value || 3)
        };

        // 休憩ルール
        const breakRules = [];
        const breakRuleDivs = document.querySelectorAll('#breakRulesContainer > div');
        breakRuleDivs.forEach(div => {
            const h = Number(div.querySelector('.setting-break-hours')?.value || 0);
            const m = Number(div.querySelector('.setting-break-minutes')?.value || 0);
            if (h > 0) breakRules.push({ min_hours: h, break_minutes: m });
        });
        breakRules.sort((a, b) => a.min_hours - b.min_hours);
        config.break_rules = breakRules.length > 0 ? breakRules : config.break_rules;

        // 時間帯別ルール
        config.time_staff_req = [];
        const timeReqRows = document.querySelectorAll('#timeStaffReqBody tr');
        timeReqRows.forEach((row, idx) => {
            const start = row.querySelector('.setting-time-req-start')?.value;
            const end = row.querySelector('.setting-time-req-end')?.value;
            const count = Number(row.querySelector('.setting-time-req-count')?.value || 0);
            const position = row.querySelector('.setting-time-req-position')?.value || 'any';

            const daysChecks = document.querySelectorAll(`.setting-time-req-day-${idx}:checked`);
            const days = Array.from(daysChecks).map(c => Number(c.value));

            if (days.length > 0 && start && end && count > 0) {
                config.time_staff_req.push({ days, start, end, count, position });
            }
        });

        return config;
    },

    async saveSettings() {
        const newConfig = this.readSettingsFromDOM();

        const configId = this.state.config.id;
        if (!configId) {
            this.showToast('設定IDが見つかりません。再ログインしてください。', 'error');
            return;
        }

        this.showLoading(true);
        try {
            // RPC経由で安全に設定を更新 (機密フィールドは個別関数で更新)
            const updateData = {
                opening_time: newConfig.opening_time,
                closing_time: newConfig.closing_time,
                hourly_wage_default: newConfig.hourly_wage_default,
                opening_times: newConfig.opening_times,
                closed_days: newConfig.closed_days,
                positions: newConfig.positions,
                staff_req: newConfig.staff_req,
                roles: newConfig.roles,
                special_holidays: newConfig.special_holidays,
                special_days: newConfig.special_days,
                time_staff_req: newConfig.time_staff_req,
                calendar_notes: newConfig.calendar_notes || {},
                break_rules: newConfig.break_rules,
                shop_rules_text: newConfig.shop_rules_text,
                custom_shifts: newConfig.custom_shifts,
            };

            await API.rpc('update_config_safe', {
                p_config_id: configId,
                p_data: updateData
            });

            // 管理者パスワード変更は専用モーダル + update_admin_password_by_contract RPC のみ
            // (このブロックの旧 staff/config 平文保存ロジックは migration 40 で view 除外後は無効化)
            if (false) {
                const adminStaff = this.state.staff.find(s => s.login_id === 'admin');
                if (adminStaff) {
                    try {
                        // 廃止: openAdminPasswordChange モーダル経由で行う
                    } catch (pwErr) {
                        console.error('[Settings] Password update failed:', pwErr);
                        this.showToast('パスワード更新に失敗しました', 'error');
                    }
                }
            }

            // Stateを更新
            this.state.config = { ...this.state.config, ...newConfig };
            this.showToast('設定を保存しました', 'success');
        } catch (e) {
            console.error(e);
            this.showToast('保存エラー: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    // --- 印刷機能 (完全版 v7・分割レイアウト & PDF対応) ---
    // Fixed syntax error
    printShiftTable() {
        // 現在の表示モードと期間を取得
        const period = this.state.shiftTablePeriod || 'month';
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth();
        
        let allDays = [];
        
        // 1. 全期間の日付リスト生成
        if (period === 'month') {
            const lastDay = new Date(year, month + 1, 0).getDate();
            allDays = Array.from({length: lastDay}, (_, i) => new Date(year, month, i + 1));
        } else if (period === 'day') {
            allDays = [new Date(this.state.currentDate)];
        } else {
            // week モード
            const start = new Date(this.state.currentDate);
            allDays = Array.from({length: 7}, (_, i) => {
                const d = new Date(start);
                d.setDate(start.getDate() + i);
                return d;
            });
        }

        // 2. 期間分割 (A4横に収まるよう 7日区切り でテーブルを生成)
        const CHUNK_SIZE = 7; // 1週間ずつ
        const dayChunks = [];
        for (let i = 0; i < allDays.length; i += CHUNK_SIZE) {
            dayChunks.push(allDays.slice(i, i + CHUNK_SIZE));
        }

        // 3. 印刷用ウィンドウ作成
        // 印刷ウィンドウの opener 参照を切断し tabnabbing を防止。
        // (noopener フラグ付き open は戻り値が null になるため、開いた後で opener を nullify する)
        const printWindow = window.open('', '_blank');
        if (printWindow) {
            try { printWindow.opener = null; } catch (_) { /* same-origin restriction で失敗しても無害 */ }
        } else {
            this.showToast('ポップアップがブロックされました。ブラウザの設定を確認してください。', 'error');
            return;
        }
        if (!printWindow) {
            alert('ポップアップがブロックされました。「許可」してください。');
            return;
        }

        // --- コンテンツ生成関数 ---
        const generateTableHTML = (days, chunkIndex, totalChunks) => {
            // 時間目盛り
            const timeScaleHtml = `
                <div style="display: flex; justify-content: space-between; font-size: 8px; color: #555; margin-top: 2px; border-top: 1px solid #ccc;">
                    <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
                </div>
            `;

            // ヘッダー生成
            const headerCols = days.map(date => {
                const d = date.getDate();
                const m = date.getMonth() + 1;
                const w = ['日','月','火','水','木','金','土'][date.getDay()];
                const isSun = date.getDay() === 0;
                const isSat = date.getDay() === 6;
                const colorStyle = isSun ? 'color:#d32f2f;' : isSat ? 'color:#1976d2;' : 'color:#111;';
                const bgStyle = isSun ? 'background-color:#fff5f5;' : isSat ? 'background-color:#f0f9ff;' : 'background-color:#f9fafb;';
                
                return `
                    <th style="${bgStyle} border: 1px solid #666; padding: 4px; width: 130px; min-width: 130px;">
                        <div style="${colorStyle} font-size: 11px; font-weight: bold;">${m}/${d} (${w})</div>
                        ${timeScaleHtml}
                    </th>
                `;
            }).join('');

            // ボディ生成
            const bodyRows = this.state.staff.map(staff => {
                const cols = days.map(date => {
                    const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
                    const shift = this.state.shifts.find(s => s.staff_id === staff.id && s.date === dateStr);
                    
                    let cellContent = '';
                    
                    if (shift) {
                        const startH = parseInt(shift.start_time.split(':')[0]);
                        const startM = parseInt(shift.start_time.split(':')[1]);
                        const endH = parseInt(shift.end_time.split(':')[0]);
                        const endM = parseInt(shift.end_time.split(':')[1]);
                        
                        const startMin = startH * 60 + startM;
                        const endMin = endH * 60 + endM;
                        const endMinAdjusted = endMin < startMin ? endMin + 1440 : endMin;
                        
                        // 1日 = 1440分
                        const startPct = (startMin / 1440) * 100;
                        const widthPct = ((endMinAdjusted - startMin) / 1440) * 100;
                        
                        let bgColor = '#dbeafe'; 
                        let borderColor = '#2563eb';
                        if (startH < 10) { bgColor = '#fef9c3'; borderColor = '#ca8a04'; }
                        else if (startH >= 17) { bgColor = '#f3e8ff'; borderColor = '#9333ea'; }

                        const timeText = `${shift.start_time} - ${shift.end_time}`;

                        cellContent = `
                            <div style="
                                position: absolute;
                                left: ${startPct}%;
                                width: ${Math.max(widthPct, 1)}%;
                                top: 6px; 
                                bottom: 6px;
                                background-color: ${bgColor};
                                border: 1px solid ${borderColor};
                                border-radius: 3px;
                                z-index: 10;
                                overflow: visible; /* 文字はみ出し許可 */
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            ">
                                <span style="
                                    font-size: 10px; 
                                    font-weight: bold; 
                                    color: #000; 
                                    white-space: nowrap; 
                                    text-shadow: 1px 1px 0 #fff, -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff;
                                    pointer-events: none;
                                    position: relative;
                                    z-index: 20;
                                ">${timeText}</span>
                            </div>
                        `;
                    }
                    
                    // 背景グリッド
                    const gridLines = `
                        <div style="position:absolute; left:25%; top:0; bottom:0; border-left:1px dotted #ccc; z-index:0;"></div>
                        <div style="position:absolute; left:50%; top:0; bottom:0; border-left:1px solid #ccc; z-index:0;"></div>
                        <div style="position:absolute; left:75%; top:0; bottom:0; border-left:1px dotted #ccc; z-index:0;"></div>
                    `;

                    const isSpecialHoliday = (this.state.config.special_holidays || []).includes(dateStr);
                    const bgStyle = isSpecialHoliday ? 'background-color: #ffebee;' : ''; 

                    return `<td style="position: relative; padding: 0; height: 38px; border: 1px solid #666; ${bgStyle}">
                        ${gridLines}
                        ${cellContent}
                    </td>`;
                }).join('');

                return `
                    <tr style="page-break-inside: avoid;">
                        <td style="padding: 4px 8px; font-weight: bold; background-color: #f3f4f6; text-align: left; width: 140px; border: 1px solid #666; font-size: 11px;">
                            ${this._sanitize(staff.name)}
                        </td>
                        ${cols}
                    </tr>
                `;
            }).join('');

            // 期間表示
            const startStr = `${days[0].getMonth()+1}/${days[0].getDate()}`;
            const endStr = `${days[days.length-1].getMonth()+1}/${days[days.length-1].getDate()}`;

            return `
                <div class="table-chunk" style="margin-bottom: 20px; page-break-after: always;">
                    <h3 style="margin: 0 0 10px 0; font-size: 16px; border-left: 5px solid #2563eb; padding-left: 10px;">
                        期間: ${startStr} 〜 ${endStr}
                    </h3>
                    <table style="width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px;">
                        <thead>
                            <tr>
                                <th style="width: 140px; background-color: #e5e7eb; border: 1px solid #666; padding: 4px;">スタッフ</th>
                                ${headerCols}
                            </tr>
                        </thead>
                        <tbody>
                            ${bodyRows}
                        </tbody>
                    </table>
                    <div style="text-align: right; font-size: 10px; color: #666; margin-top: 5px;">
                        Page ${chunkIndex + 1} / ${totalChunks}
                    </div>
                </div>
            `;
        };

        // 全チャンクのHTML結合
        const allTablesHtml = dayChunks.map((chunk, idx) => generateTableHTML(chunk, idx, dayChunks.length)).join('');

        const html = `
            <!DOCTYPE html>
            <html lang="ja">
            <head>
                <meta charset="UTF-8">
                <title>シフト表印刷</title>
                <style>
                    @page { size: landscape; margin: 8mm; }
                    body { font-family: "Helvetica Neue", Arial, sans-serif; margin: 0; padding: 10px; background: white; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                    .no-print { margin-bottom: 20px; padding: 15px; background: #e0f2fe; border: 1px solid #bae6fd; border-radius: 8px; color: #0369a1; }
                    button { cursor: pointer; padding: 10px 20px; background: #0284c7; color: white; border: none; border-radius: 4px; font-weight: bold; font-size: 14px; margin-right: 10px; }
                    @media print { .no-print { display: none; } .table-chunk:last-child { page-break-after: auto !important; } }
                </style>
            </head>
            <body>
                <div class="no-print">
                    <h2 style="margin-top:0;">🖨 印刷プレビュー (分割レイアウト版)</h2>
                    <p style="font-size: 14px; line-height: 1.6;">
                        視認性を確保するため、<strong>7日ごとに分割して表示</strong>しています。<br>
                        「印刷」ボタンを押し、送信先で<strong>「PDFに保存」</strong>を選択すると、全期間を含むPDFファイルが作成できます。<br>
                        ※ 紙に印刷する場合も、A4横サイズで綺麗にページ分けされます。
                    </p>
                    <div style="margin-top: 15px;">
                        <button onclick="window.print()">🖨 印刷 / PDF保存</button>
                    </div>
                </div>

                <h1 style="font-size: 24px; margin-bottom: 20px;">
                    ${year}年 ${month + 1}月 シフト表
                </h1>

                ${allTablesHtml}

            </body>
            </html>
        `;

        printWindow.document.open();
        printWindow.document.write(html);
        printWindow.document.close();
    },

    // =================================================================
    // ロジック・ヘルパー関数
    // =================================================================

    // --- シフト編集 ---
    get15MinTimeSelect(currentVal, id, className) {
        let options = '';
        const normalizedVal = currentVal ? currentVal.substr(0, 5) : '';
        for (let h = 0; h < 24; h++) {
            for (let m = 0; m < 60; m += 15) {
                const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                const selected = (normalizedVal === time) ? 'selected' : '';
                options += `<option value="${time}" ${selected}>${time}</option>`;
            }
        }
        // Fallback for custom values
        if (normalizedVal && !options.includes(`value="${normalizedVal}"`)) {
             options += `<option value="${normalizedVal}" selected>${normalizedVal}</option>`;
        }
        
        const idAttr = id ? `id="${id}"` : '';
        // 既存の input が持っていたクラスを継承しつつ、appearance-none でブラウザデフォルトのスタイルを消す
        const finalClass = `${className || ''} appearance-none cursor-pointer bg-white`;
        
        return `
            <div class="relative w-full">
                <select ${idAttr} class="${finalClass}" style="padding-right: 2rem;">
                    ${options}
                </select>
                <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-500">
                    <i class="fa-solid fa-chevron-down text-xs"></i>
                </div>
            </div>
        `;
    },

    generateTimeOptionsHTML(selectedValue) {
        // 正規化: 秒が含まれている場合(HH:mm:ss)はHH:mmに切り詰める
        const normalizedSelected = selectedValue ? selectedValue.substr(0, 5) : '';
        
        let options = [];
        let found = false;
        // 15分刻みの選択肢を生成
        for (let i = 0; i < 24; i++) {
            for (let j = 0; j < 60; j += 15) {
                const h = String(i).padStart(2, '0');
                const m = String(j).padStart(2, '0');
                const time = `${h}:${m}`;
                if (time === normalizedSelected) found = true;
                options.push(time);
            }
        }
        // 既存の値が15分刻みでない場合も、表示崩れを防ぐために選択肢に追加
        if (normalizedSelected && !found) {
            options.push(normalizedSelected);
            options.sort(); 
        }
        return options.map(t => `<option value="${t}" ${t === normalizedSelected ? 'selected' : ''}>${t}</option>`).join('');
    },

    openAddShift(dateStr) {
        document.getElementById('shiftForm')?.reset();
        document.getElementById('editShiftId').value = ''; 
        document.getElementById('editShiftDate').value = dateStr;
        document.getElementById('editShiftTitle').textContent = 'シフト追加';
        document.getElementById('editShiftDateDisplay').textContent = dateStr;
        document.getElementById('deleteShiftBtn').classList.add('hidden');
        
        const staffSelectHtml = `<select id="editShiftStaffSelect" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none mb-2"><option value="">スタッフを選択</option>${this.state.staff.map(s => `<option value="${s.id}">${this._sanitize(s.name)}</option>`).join('')}</select>`;
        document.getElementById('editShiftStaffName').innerHTML = staffSelectHtml;
        
        // Selectボックスの初期化
        const defStart = (this.state.config.opening_time || '09:00').substr(0, 5);
        const defEnd = (this.state.config.closing_time || '18:00').substr(0, 5);
        
        const startEl = document.getElementById('editShiftStart');
        const endEl = document.getElementById('editShiftEnd');
        
        startEl.innerHTML = this.generateTimeOptionsHTML(defStart);
        endEl.innerHTML = this.generateTimeOptionsHTML(defEnd);
        
        // 値を明示的にセットして確実にする
        startEl.value = defStart;
        endEl.value = defEnd;

        document.getElementById('editShiftBreak').value = 60;
        const memoEl = document.getElementById('editShiftMemo');
        if (memoEl) memoEl.value = '';

        this.openModal('editShiftModal');
        const saveBtn = document.getElementById('saveShiftBtn');
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        newSaveBtn.addEventListener('click', () => this.saveShift());
    },

    async updateShiftDrag(shiftId, updates) {
        try {
            await API.update('shifts', shiftId, updates);
            // ローカルステートも更新
            const shift = this.state.shifts.find(s => s.id === shiftId);
            if (shift) {
                Object.assign(shift, updates);
            }
            // 休憩時間を再計算
            if (shift && (updates.start_time || updates.end_time)) {
                const [sh, sm] = shift.start_time.split(':').map(Number);
                const [eh, em] = shift.end_time.split(':').map(Number);
                let hours = (eh + em / 60) - (sh + sm / 60);
                if (hours <= 0) hours += 24; // 日またぎ対応
                const breakRules = this.state.config.break_rules || this.state.defaultConfig.break_rules || [];
                let brk = 0;
                for (const rule of breakRules.sort((a, b) => a.min_hours - b.min_hours)) {
                    if (hours >= rule.min_hours) brk = rule.break_minutes;
                }
                if (shift.break_minutes !== brk) {
                    shift.break_minutes = brk;
                    await API.update('shifts', shiftId, { break_minutes: brk });
                }
            }
            this.renderCurrentView();
            this.updateHeader();
            const staff = this.getStaff(updates.staff_id || shift?.staff_id);
            this.showToast(`シフトを更新しました${staff ? ' (' + staff.name + ')' : ''}`, 'success');
        } catch (e) {
            console.error('Drag update failed:', e);
            this.showToast('シフト更新に失敗しました', 'error');
            this.renderCurrentView();
        }
    },

    openEditShift(shiftId) {
        const shift = this.state.shifts.find(s => s.id == shiftId);
        if (!shift) return;
        const staff = this.getStaff(shift.staff_id);
        document.getElementById('editShiftId').value = shift.id;
        document.getElementById('editShiftDate').value = shift.date;
        document.getElementById('editShiftStaffId').value = shift.staff_id;
        document.getElementById('editShiftTitle').textContent = 'シフト編集';
        document.getElementById('editShiftDateDisplay').textContent = shift.date;
        const safeName = staff ? this._sanitize(staff.name) : '不明なスタッフ';
        document.getElementById('editShiftStaffName').innerHTML = `<div class="py-2 text-xl text-gray-800">${safeName}</div>`;
        
        // 時間の正規化 (HH:mm:ss -> HH:mm)
        const startTime = shift.start_time.substr(0, 5);
        const endTime = shift.end_time.substr(0, 5);

        // Selectボックスの初期化
        const startEl = document.getElementById('editShiftStart');
        const endEl = document.getElementById('editShiftEnd');
        
        startEl.innerHTML = this.generateTimeOptionsHTML(startTime);
        endEl.innerHTML = this.generateTimeOptionsHTML(endTime);
        
        // 値を明示的にセットして確実にする
        startEl.value = startTime;
        endEl.value = endTime;
        
        document.getElementById('editShiftBreak').value = shift.break_minutes;
        const memoEl = document.getElementById('editShiftMemo');
        if (memoEl) memoEl.value = shift.memo || '';
        document.getElementById('deleteShiftBtn').classList.remove('hidden');

        const deleteBtn = document.getElementById('deleteShiftBtn');
        deleteBtn.onclick = () => this.deleteShift(shift.id);
        const saveBtn = document.getElementById('saveShiftBtn');
        const newSaveBtn = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
        newSaveBtn.addEventListener('click', () => this.saveShift());
        this.openModal('editShiftModal');
    },

    async saveShift() {
        const id = (document.getElementById('editShiftId')?.value || '');
        const date = (document.getElementById('editShiftDate')?.value || '');
        const start = (document.getElementById('editShiftStart')?.value || '');
        const end = (document.getElementById('editShiftEnd')?.value || '');
        const breakMins = Number((document.getElementById('editShiftBreak')?.value || ''));
        let staffId = (document.getElementById('editShiftStaffId')?.value || '');
        const selectEl = document.getElementById('editShiftStaffSelect');
        if (selectEl) staffId = selectEl.value;

        if (!staffId || !start || !end) { app.showToast('必須項目を入力してください', 'error'); return; }
        if (start === end) { app.showToast('開始時間と終了時間が同じです', 'error'); return; }
        if (document.getElementById('editShiftHoliday').checked && id) { await this.deleteShift(id); this.closeModal('editShiftModal'); return; }

        const memo = (document.getElementById('editShiftMemo')?.value || '').trim();
        const data = { staff_id: staffId, date, start_time: start, end_time: end, break_minutes: breakMins, memo };
        if (!id) data.organization_id = this.state.organization_id;
        
        this.showLoading(true);
        try {
            if (id) await API.update('shifts', id, data); else await API.create('shifts', data);
            await this.loadData();
            
            // ビューの更新 (カレンダーに戻らず、現在のモードを維持)
            if (this.state.view === 'manual-shift' && document.getElementById('shiftViewContent')) {
                const content = document.getElementById('shiftViewContent');
                // スクロール位置の保持を試みる
                const scrollEl = content.firstElementChild;
                const sTop = scrollEl ? scrollEl.scrollTop : 0;
                const sLeft = scrollEl ? scrollEl.scrollLeft : 0;
                
                if (this.state.shiftViewMode === 'table') {
                    this.renderShiftTable(content);
                } else {
                    this.renderCalendar(content);
                }
                
                // スクロール復元
                if (content.firstElementChild) {
                    content.firstElementChild.scrollTop = sTop;
                    content.firstElementChild.scrollLeft = sLeft;
                }
            } else {
                this.renderCurrentView();
            }

            // ヘッダーの分析数値（人件費など）を更新
            this.calculateMonthlyStats();

            this.closeModal('editShiftModal');
            this.showToast('シフトを保存しました', 'success');
        } catch (e) { this.showToast('保存に失敗しました', 'error'); } finally { this.showLoading(false); }
    },

    async deleteShift(id) {
        // シフト削除の安全確認
        const shift = this.state.shifts.find(s => s.id === id);
        const staffName = shift ? (this.state.staff.find(st => st.id === shift.staff_id)?.name || '不明') : '不明';
        if (!confirm(`【シフト削除確認】\n\nスタッフ: ${staffName}\n日付: ${shift?.date || '不明'}\n\nこのシフトを削除しますか？\n※この操作は元に戻せません`)) return;
        this.showLoading(true);
        try {
            await API.delete('shifts', id);
            await this.loadData();
            
            // ビューの更新 (カレンダーに戻らず、現在のモードを維持)
            if (this.state.view === 'manual-shift' && document.getElementById('shiftViewContent')) {
                const content = document.getElementById('shiftViewContent');
                // スクロール位置の保持
                const scrollEl = content.firstElementChild;
                const sTop = scrollEl ? scrollEl.scrollTop : 0;
                const sLeft = scrollEl ? scrollEl.scrollLeft : 0;

                if (this.state.shiftViewMode === 'table') {
                    this.renderShiftTable(content);
                } else {
                    this.renderCalendar(content);
                }

                // スクロール復元
                if (content.firstElementChild) {
                    content.firstElementChild.scrollTop = sTop;
                    content.firstElementChild.scrollLeft = sLeft;
                }
            } else {
                this.renderCurrentView();
            }

            // ヘッダーの分析数値（人件費など）を更新
            this.calculateMonthlyStats();

            this.closeModal('editShiftModal');
            this.showToast('削除しました', 'success');
        } catch (e) { this.showToast('失敗しました', 'error'); } finally { this.showLoading(false); }
    },

    // --- スタッフ管理 ---
    prepareStaffModal() {
        this.updateStaffRoleSelect();
        this.updateStaffPositionSelect();
        this.openModal('staffModal');
        document.getElementById('staffForm').reset();
        document.getElementById('staffId').value='';
        for(let i=0; i<=6; i++) {
            const cb = document.getElementById('prefDay'+i);
            if(cb) cb.checked = true;
        }
    },
    
    updateStaffRoleSelect() {
        const select = document.getElementById('staffRole');
        if(!select) return;
        
        const roles = this.state.config.roles || this.state.defaultConfig.roles;
        select.innerHTML = roles.map(r => `<option value="${r.id}">${this._sanitize(r.name)}</option>`).join('');
    },
    
    updateStaffPositionSelect() {
        const select = document.getElementById('staffPosition');
        if(!select) return;
        const positions = this.state.config.positions || ['ホール', 'キッチン'];
        let html = '<option value="any">指定なし (全般)</option>';
        positions.forEach(p => {
            html += `<option value="${this._sanitize(p)}">${this._sanitize(p)}専用</option>`;
        });
        select.innerHTML = html;
    },

    // プラン別スタッフ上限
    getStaffLimit() {
        // demoテナントは無制限
        const contractId = this.state.config.contract_id || '';
        if (contractId === 'demo') return 9999;

        const plan = this.state.config.stripe_plan || '';
        if (plan === 'premium') return 9999;
        if (plan === 'pro') return 50;
        if (plan === 'standard') return 10;
        return 30; // プラン未設定時のデフォルト
    },

    // スタッフ数がプラン上限を超えているかチェック
    isStaffOverLimit() {
        const limit = this.getStaffLimit();
        return this.state.staff.length > limit;
    },

    // スタッフ超過警告を表示（ダウングレード後など）
    showStaffOverLimitAlert() {
        const limit = this.getStaffLimit();
        const current = this.state.staff.length;
        const over = current - limit;
        const planName = {standard: 'Standard', pro: 'Pro', premium: 'Premium'}[this.state.config.stripe_plan] || 'Standard';

        const alertEl = document.getElementById('staffOverLimitAlert');
        if (alertEl) alertEl.remove();

        const alert = document.createElement('div');
        alert.id = 'staffOverLimitAlert';
        alert.className = 'fixed top-0 left-0 right-0 z-[200] bg-red-600 text-white px-4 py-3 text-center shadow-lg';
        alert.innerHTML = `
            <div class="max-w-3xl mx-auto flex items-center justify-center gap-3 flex-wrap">
                <i class="fa-solid fa-triangle-exclamation text-lg"></i>
                <span class="font-bold">${planName}プランのスタッフ上限(${limit}名)を${over}名超過しています。</span>
                <span class="text-red-200">スタッフを${over}名削除するまでシフト作成はできません。</span>
                <button onclick="app.changeView('staff'); document.getElementById('staffOverLimitAlert')?.remove();" class="px-4 py-1 bg-white text-red-600 rounded font-bold text-sm hover:bg-red-50 transition">
                    スタッフ管理へ
                </button>
            </div>
        `;
        document.body.prepend(alert);
    },

    // スタッフ超過警告を消す
    clearStaffOverLimitAlert() {
        const alertEl = document.getElementById('staffOverLimitAlert');
        if (alertEl) alertEl.remove();
    },

    // 決済エラーアラート表示
    showPaymentAlert() {
        const existing = document.getElementById('paymentAlert');
        if (existing) existing.remove();

        const alert = document.createElement('div');
        alert.id = 'paymentAlert';
        alert.className = 'fixed top-0 left-0 right-0 z-[200] bg-orange-500 text-white px-4 py-3 shadow-lg';
        alert.innerHTML = `
            <div class="max-w-3xl mx-auto flex items-center justify-center gap-3 flex-wrap">
                <i class="fa-solid fa-credit-card text-lg animate-pulse"></i>
                <span class="font-bold">決済エラーが発生しています</span>
                <span class="text-orange-100">お支払い方法を更新してください。未対応の場合サービスが停止されます。</span>
                <button onclick="app.openStripePortal()" class="px-4 py-1.5 bg-white text-orange-600 rounded font-bold text-sm hover:bg-orange-50 transition">
                    <i class="fa-solid fa-arrow-up-right-from-square mr-1"></i>支払い方法を更新
                </button>
                <button onclick="document.getElementById('paymentAlert')?.remove()" class="text-orange-200 hover:text-white ml-2">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        `;
        document.body.prepend(alert);
    },

    async saveStaff() {
        const id = (document.getElementById('staffId')?.value || '');

        // テナント情報を確実に取得
        const contractId = this.state.config.contract_id || API.session?.user?.contract_id;
        const orgId = this.state.config.organization_id || this.state.organization_id || API.session?.user?.organization_id;

        if (!contractId || !orgId) {
            this.showToast('テナント情報が取得できません。再ログインしてください。', 'error');
            return;
        }

        // 新規作成時: プラン別スタッフ数制限チェック
        if (!id) {
            const limit = this.getStaffLimit();
            const currentCount = this.state.staff.length;
            if (currentCount >= limit) {
                this.showUpgradeModal();
                return;
            }
        }

        const data = {
            name: (document.getElementById('staffName')?.value || ''),
            role: (document.getElementById('staffRole')?.value || ''),
            evaluation: (document.getElementById('staffEvaluation')?.value || ''),
            salary_type: (document.getElementById('staffSalaryType')?.value || ''),
            hourly_wage: Number((document.getElementById('staffHourlyWage')?.value || '')),
            monthly_salary: Number((document.getElementById('staffMonthlySalary')?.value || '')),
            max_days_week: Number((document.getElementById('staffMaxDaysPerWeek')?.value || '')),
            max_hours_day: Number((document.getElementById('staffMaxHoursPerDay')?.value || '')),
            min_days_week: Number((document.getElementById('staffMinDaysPerWeek')?.value || '')) || 0,
            min_days_month: Number((document.getElementById('staffMinDaysPerMonth')?.value || '')) || 0,
            contract_id: contractId
        };

        if (data.min_days_week > data.max_days_week) {
            this.showToast('最低出勤日数は、最大出勤日数以下に設定してください', 'error');
            return;
        }

        if (!id) {
            data.organization_id = orgId;
        }

        // DBマイグレーション不要で保存するためのハック：unavailable_datesにメタデータを埋め込む
        const existingStaff = this.state.staff.find(st => st.id === id);
        let uDates = [];
        if (existingStaff && existingStaff.unavailable_dates) {
            uDates = Array.isArray(existingStaff.unavailable_dates) 
                ? [...existingStaff.unavailable_dates] 
                : String(existingStaff.unavailable_dates).split(',').map(d=>d.trim()).filter(d=>d);
        }
        // 既存のタグを削除
        uDates = uDates.filter(d => !d.startsWith('priority:') && !d.startsWith('contract:') && !d.startsWith('prefStart') && !d.startsWith('prefEnd') && !d.startsWith('ngDay:') && !d.startsWith('ngPair:') && !d.startsWith('reqPair:') && !d.startsWith('position:'));
        
        const contractType = document.getElementById('staffContractType')?.value || 'general';
        const shiftPriority = document.getElementById('staffShiftPriority')?.value || 'medium';
        const usePref = document.getElementById('staffUsePrefHours')?.checked;
        const prefStartWd = usePref ? (document.getElementById('staffPrefStartWeekday')?.value || '') : '';
        const prefEndWd = usePref ? (document.getElementById('staffPrefEndWeekday')?.value || '') : '';
        const prefStartWe = usePref ? (document.getElementById('staffPrefStartWeekend')?.value || '') : '';
        const prefEndWe = usePref ? (document.getElementById('staffPrefEndWeekend')?.value || '') : '';
        const ngPairs = document.getElementById('staffNgPairs')?.value || '';
        const reqPairs = document.getElementById('staffReqPairs')?.value || '';
        const position = document.getElementById('staffPosition')?.value || 'any';
        
        uDates.push(`priority:${shiftPriority}`);
        uDates.push(`contract:${contractType}`);
        if (prefStartWd) uDates.push(`prefStartWd:${prefStartWd}`);
        if (prefEndWd) uDates.push(`prefEndWd:${prefEndWd}`);
        if (prefStartWe) uDates.push(`prefStartWe:${prefStartWe}`);
        if (prefEndWe) uDates.push(`prefEndWe:${prefEndWe}`);
        if (ngPairs) uDates.push(`ngPair:${ngPairs}`);
        if (reqPairs) uDates.push(`reqPair:${reqPairs}`);
        if (position !== 'any') uDates.push(`position:${position}`);
        for(let i=0; i<=6; i++) {
            const cb = document.getElementById('prefDay'+i);
            if(cb && !cb.checked) uDates.push(`ngDay:${i}`);
        }
        
        data.unavailable_dates = uDates;

        this.showLoading(true);
        try {
            let result;
            if (id) {
                // 更新: 先にAPIに送信し、成功後にStateを更新
                await API.update('staff', id, data);
                const index = this.state.staff.findIndex(s => s.id === id);
                if (index !== -1) {
                    this.state.staff[index] = { ...this.state.staff[index], ...data };
                }
            } else {
                // 新規作成
                result = await API.create('staff', data);
                if (!result) {
                    data.id = 'temp_' + Date.now();
                    this.state.staff.push(data);
                } else {
                    this.state.staff.push(result);
                }
            }
            
            this.renderStaffList(document.getElementById('viewContainer'));
            this.closeModal('staffModal');
            this.showToast('保存しました', 'success');
        } catch (e) { 
            console.error('[SaveStaff] 保存失敗:', e);
            // 保存失敗時はDBから最新データを再取得してStateを復元
            try { await this.loadData(); } catch(reloadErr) { console.error(reloadErr); }
            this.renderStaffList(document.getElementById('viewContainer'));
            this.showToast('保存に失敗しました: ' + e.message, 'error');
        } finally { 
            this.showLoading(false); 
        }
    },
    editStaff(id) {
        const s = this.getStaff(id);
        if(!s) return;
        this.updateStaffRoleSelect(); // Selectを最新化
        this.updateStaffPositionSelect(); // ポジション一覧を最新化
        document.getElementById('staffId').value = s.id;
        document.getElementById('staffName').value = s.name;
        document.getElementById('staffRole').value = s.role;
        document.getElementById('staffEvaluation').value = s.evaluation || 'B';
        
        // unavailable_datesからメタデータを抽出
        let shiftPriority = 'medium';
        let contractType = 'general';
        let prefStartWd = '';
        let prefEndWd = '';
        let prefStartWe = '';
        let prefEndWe = '';
        let ngPairs = '';
        let reqPairs = '';
        let position = 'any';
        let ngDays = [];
        let hasPref = false;
        if (s.unavailable_dates) {
            const uDates = Array.isArray(s.unavailable_dates) ? s.unavailable_dates : String(s.unavailable_dates).split(',');
            uDates.forEach(d => {
                const txt = d.trim();
                if (txt.startsWith('priority:')) shiftPriority = txt.replace('priority:', '');
                if (txt.startsWith('contract:')) contractType = txt.replace('contract:', '');
                if (txt.startsWith('prefStartWd:')) { prefStartWd = txt.replace('prefStartWd:', ''); hasPref = true; }
                if (txt.startsWith('prefEndWd:')) { prefEndWd = txt.replace('prefEndWd:', ''); hasPref = true; }
                if (txt.startsWith('prefStartWe:')) { prefStartWe = txt.replace('prefStartWe:', ''); hasPref = true; }
                if (txt.startsWith('prefEndWe:')) { prefEndWe = txt.replace('prefEndWe:', ''); hasPref = true; }
                if (txt.startsWith('ngPair:')) ngPairs = txt.replace('ngPair:', '');
                if (txt.startsWith('reqPair:')) reqPairs = txt.replace('reqPair:', '');
                if (txt.startsWith('position:')) position = txt.replace('position:', '');
                // 互換性のため古いタグもサポート
                if (txt.startsWith('prefStart:')) { prefStartWd = txt.replace('prefStart:', ''); prefStartWe = txt.replace('prefStart:', ''); hasPref = true; }
                if (txt.startsWith('prefEnd:')) { prefEndWd = txt.replace('prefEnd:', ''); prefEndWe = txt.replace('prefEnd:', ''); hasPref = true; }
                if (txt.startsWith('ngDay:')) ngDays.push(txt.replace('ngDay:', ''));
            });
        }
        if (document.getElementById('staffContractType')) document.getElementById('staffContractType').value = contractType;
        if (document.getElementById('staffShiftPriority')) document.getElementById('staffShiftPriority').value = shiftPriority;
        
        const usePrefCb = document.getElementById('staffUsePrefHours');
        if (usePrefCb) {
            usePrefCb.checked = hasPref;
        }
        
        if (document.getElementById('staffPrefStartWeekday')) document.getElementById('staffPrefStartWeekday').value = prefStartWd;
        if (document.getElementById('staffPrefEndWeekday')) document.getElementById('staffPrefEndWeekday').value = prefEndWd;
        if (document.getElementById('staffPrefStartWeekend')) document.getElementById('staffPrefStartWeekend').value = prefStartWe;
        if (document.getElementById('staffPrefEndWeekend')) document.getElementById('staffPrefEndWeekend').value = prefEndWe;
        if (document.getElementById('staffNgPairs')) document.getElementById('staffNgPairs').value = ngPairs;
        if (document.getElementById('staffReqPairs')) document.getElementById('staffReqPairs').value = reqPairs;
        if (document.getElementById('staffPosition')) document.getElementById('staffPosition').value = position;
        for(let i=0; i<=6; i++) {
            const cb = document.getElementById('prefDay'+i);
            if(cb) cb.checked = !ngDays.includes(String(i));
        }
        document.getElementById('staffSalaryType').value = s.salary_type;
        document.getElementById('staffHourlyWage').value = s.hourly_wage;
        document.getElementById('staffMonthlySalary').value = s.monthly_salary;
        document.getElementById('staffMaxDaysPerWeek').value = s.max_days_week || 5;
        document.getElementById('staffMaxHoursPerDay').value = s.max_hours_day || 8;
        document.getElementById('staffMinDaysPerWeek').value = s.min_days_week || 0;
        document.getElementById('staffMinDaysPerMonth').value = s.min_days_month || 0;
        this.toggleSalaryInputs();
        this.togglePrefHoursInputs();
        this.openModal('staffModal');
    },
    async deleteStaff(id) {
        // 管理者権限チェック
        if (!this.state.isAdmin) {
            this.showToast('スタッフの削除には管理者権限が必要です', 'error');
            return;
        }

        const staff = this.state.staff.find(s => s.id === id);
        if (!staff) {
            this.showToast('スタッフが見つかりません', 'error');
            return;
        }

        // 管理者アカウントは絶対に削除不可
        if (staff.login_id === 'admin' || staff.role === 'manager' || staff.role === 'admin') {
            this.showToast('管理者・店長アカウントは削除できません。', 'error');
            return;
        }

        if (!confirm(`「${staff.name}」を削除しますか？\n\n※関連するシフト・申請データも全て削除されます。\nこの操作は元に戻せません。`)) return;

        this.showLoading(true);
        try {
            await API.delete('staff', id);
            this.state.staff = this.state.staff.filter(s => s.id !== id);
            this.renderStaffList(document.getElementById('viewContainer'));
            this.showToast(`${staff.name} を削除しました`, 'success');
        } catch (e) {
            console.error(e);
            this.showToast('削除に失敗しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },
    toggleSalaryInputs() {
        const type = (document.getElementById('staffSalaryType')?.value || '');
        if(type === 'hourly') {
            document.getElementById('hourlyInputGroup').classList.remove('hidden');
            document.getElementById('monthlyInputGroup').classList.add('hidden');
        } else {
            document.getElementById('hourlyInputGroup').classList.add('hidden');
            document.getElementById('monthlyInputGroup').classList.remove('hidden');
        }
    },
    togglePrefHoursInputs() {
        const usePref = document.getElementById('staffUsePrefHours')?.checked;
        const group = document.getElementById('prefHoursInputGroup');
        if (group) {
            if (usePref) {
                group.classList.remove('hidden');
            } else {
                group.classList.add('hidden');
            }
        }
    },

    // --- 申請 ---
    _selectedRequestDates: [],
    _requestCalendarMonth: null,

    initRequestModal() {
        const select = document.getElementById('requestStaffId');
        if (!select) return;
        select.innerHTML = this.state.staff.map(s => `<option value="${s.id}">${this._sanitize(s.name)}</option>`).join('');

        this._selectedRequestDates = [];
        this._requestCalendarMonth = new Date();
        this._requestCalendarMonth.setDate(1);
        this._renderRequestCalendar();
    },

    _renderRequestCalendar() {
        const container = document.getElementById('requestDatePicker');
        const display = document.getElementById('selectedDatesDisplay');
        const titleEl = document.getElementById('requestCalendarTitle');
        const countEl = document.getElementById('selectedDateCount');
        if (!container || !display) return;
        const month = this._requestCalendarMonth;
        if (!month) return;
        const year = month.getFullYear();
        const m = month.getMonth();
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
        const dayNames = ['日', '月', '火', '水', '木', '金', '土'];

        if (titleEl) titleEl.textContent = `${year}年 ${monthNames[m]}`;

        const firstDay = new Date(year, m, 1).getDay();
        const daysInMonth = new Date(year, m + 1, 0).getDate();

        let html = `<div class="grid grid-cols-7 gap-1 text-center">`;
        html += dayNames.map((d, i) => `<div class="text-[10px] font-bold py-1 ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-gray-400'}">${d}</div>`).join('');

        for (let i = 0; i < firstDay; i++) {
            html += `<div></div>`;
        }

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dateObj = new Date(year, m, d);
            const isPast = dateObj < today;
            const isSelected = this._selectedRequestDates.includes(dateStr);
            const dow = dateObj.getDay();
            const textColor = dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-700';

            if (isPast) {
                html += `<div class="text-xs py-2 text-gray-300 rounded-lg">${d}</div>`;
            } else {
                html += `<div onclick="app._toggleRequestDate('${dateStr}')" class="text-xs py-2 cursor-pointer rounded-lg transition-all active:scale-90 ${isSelected ? 'bg-indigo-600 text-white font-bold shadow-sm' : textColor + ' hover:bg-indigo-50 hover:font-bold'}">${d}</div>`;
            }
        }

        html += `</div>`;
        container.innerHTML = html;

        // 選択日の表示
        const sorted = [...this._selectedRequestDates].sort();
        if (countEl) countEl.textContent = sorted.length;

        if (sorted.length === 0) {
            display.innerHTML = '<span class="text-xs text-gray-300">カレンダーから日付を選んでください</span>';
        } else {
            display.innerHTML = sorted.map(d => {
                const dt = new Date(d);
                const dayLabel = ['日','月','火','水','木','金','土'][dt.getDay()];
                const short = `${dt.getMonth()+1}/${dt.getDate()}(${dayLabel})`;
                return `<span class="inline-flex items-center gap-1 bg-indigo-100 text-indigo-700 text-xs font-bold px-2.5 py-1 rounded-full">
                    ${short}
                    <button onclick="app._toggleRequestDate('${d}')" class="hover:text-red-500 ml-0.5"><i class="fa-solid fa-xmark text-[10px]"></i></button>
                </span>`;
            }).join('');
        }
    },

    _changeRequestMonth(delta) {
        this._requestCalendarMonth.setMonth(this._requestCalendarMonth.getMonth() + delta);
        this._renderRequestCalendar();
    },

    _toggleRequestDate(dateStr) {
        const idx = this._selectedRequestDates.indexOf(dateStr);
        if (idx >= 0) {
            this._selectedRequestDates.splice(idx, 1);
        } else {
            this._selectedRequestDates.push(dateStr);
        }
        this._renderRequestCalendar();
    },

    async submitRequest() {
        const staffId = (document.getElementById('requestStaffId')?.value || '');
        const type = document.querySelector('input[name="requestType"]:checked').value;
        const dates = [...this._selectedRequestDates].sort();
        const reason = (document.getElementById('requestReason')?.value || '');

        if (!staffId || dates.length === 0) {
            app.showToast('スタッフと日付を選択してください', 'error');
            return;
        }

        const typeStr = type === 'off' ? '【休み希望】' : '【勤務希望】';
        const datesStr = dates.join(', ');
        const confirmMsg = `以下の内容で申請を提出します。\n\n日付: ${datesStr}\n件数: ${dates.length}日分\n内容: ${typeStr}\n理由: ${reason || 'なし'}\n\n送信しますか？`;

        if (!confirm(confirmMsg)) return;

        this.showLoading(true);
        try {
            // 日付ごとに1件ずつ申請を作成
            for (const date of dates) {
                const data = {
                    staff_id: staffId,
                    type,
                    dates: date,
                    reason,
                    status: 'pending',
                    created_at: new Date().toISOString(),
                    organization_id: this.state.organization_id
                };

                if (type === 'work') {
                    data.start_time = (document.getElementById('requestStartTime')?.value || '');
                    data.end_time = (document.getElementById('requestEndTime')?.value || '');
                    if (!data.start_time || !data.end_time) { app.showToast('時間を入力してください', 'error'); return; }
                }

                await API.create('requests', data);
            }

            await this.loadData();
            this.closeModal('requestModal');
            this.showToast(`${dates.length}件の申請を送信しました`, 'success');
            if (this.state.view === 'requests') this.renderRequests(document.getElementById('viewContainer'));
        } catch (e) {
            this.showToast('送信失敗', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async submitMultiRequest() { return this.submitRequest(); },

    async handleRequest(id, status) {
        if (!confirm(status === 'approved' ? '承認しますか？' : '却下しますか？')) return;
        this.showLoading(true);
        try {
            await API.update('requests', id, { status: status });
            
            // 承認時の追加処理
            if (status === 'approved') {
                const req = this.state.requests.find(r => r.id == id);
                if (req) {
                    // 1. 勤務希望ならシフト作成
                    if (req.type === 'work') {
                        // 開始・終了時間が指定されていない場合は店舗設定から取得などのロジックが必要だが
                        // ここではリクエストになければデフォルト値を入れる
                        const start = req.start_time || this.state.config.opening_time || '09:00';
                        const end = req.end_time || this.state.config.closing_time || '18:00';
                        await API.create('shifts', { 
                            staff_id: req.staff_id, 
                            date: req.dates, 
                            start_time: start, 
                            end_time: end, 
                            break_minutes: 60, // デフォルト
                            organization_id: this.state.organization_id
                        });
                    }
                    // 2. 休み希望なら unavailable_dates を更新
                    else if (req.type === 'off' || req.type === 'holiday') {
                        const staff = this.getStaff(req.staff_id);
                        if (staff) {
                            // 複数日カンマ区切り対応
                            const reqDates = String(req.dates).split(',').map(d => d.trim()).filter(d => d);
                            let uDates = [];
                            if (staff.unavailable_dates) {
                                uDates = Array.isArray(staff.unavailable_dates)
                                    ? [...staff.unavailable_dates]
                                    : String(staff.unavailable_dates).split(',').map(d => d.trim()).filter(d => d);
                            }
                            let changed = false;
                            for (const dateStr of reqDates) {
                                if (!uDates.includes(dateStr)) {
                                    uDates.push(dateStr);
                                    changed = true;
                                }
                            }
                            if (changed) {
                                await API.update('staff', staff.id, {
                                    unavailable_dates: uDates
                                });
                                staff.unavailable_dates = uDates;
                            }
                        }
                    }
                }
            }
            await this.loadData();
            this.renderRequests(document.getElementById('viewContainer'));
            this.showToast('処理完了', 'success');
        } catch(e) { this.showToast('エラー発生', 'error'); } finally { this.showLoading(false); }
    },

    async handleBatchApprove() {
        const pending = this.state.requests.filter(r => r.status === 'pending');
        if (pending.length === 0) return;
        if (!confirm(`承認待ち ${pending.length}件 を全て承認しますか？`)) return;

        this.showLoading(true);
        try {
            for (const req of pending) {
                await this.handleRequest(req.id, 'approved');
            }
        } catch (e) {
            this.showToast('一括承認中にエラーが発生しました', 'error');
        } finally {
            this.showLoading(false);
        }
    },

    updateRequestBadge() {
        const count = this.state.requests.filter(r => r.status === 'pending').length;
        const badge = document.getElementById('pendingRequestsBadge');
        if(badge) {
            badge.textContent = count;
            badge.classList.toggle('hidden', count === 0);
        }
    },

       // --- AIシフト作成 (Python + Gemini) ---
       _shiftGenTips: [
            '労基法32条: 1日8時間・週40時間が法定労働時間の上限です',
            '労基法34条: 6時間超で45分、8時間超で60分の休憩が必要です',
            '労基法35条: 週1日以上の休日が必要です（連続6日まで）',
            'AIが各スタッフの希望休を尊重しながら最適配置を計算中...',
            '土日祝は割増賃金(1.25倍)を考慮してコスト最適化しています',
            '管理者が各シフトに最低1名配置されるよう調整しています',
            'スタッフの評価・スキルに応じてバランスよく配置します',
            '新人スタッフにはメンター（管理者）を配置します',
            '月間の総人件費が最小になるよう数理最適化を実行中...',
            'Pythonで一次案を作成 → AIで労基法チェック＆最終調整',
        ],
        _tipTimer: null,

       async runAutoFill() {
        if (this._shiftGenInProgress) return;
        if (!this.state.isShopLoggedIn || !this.state.organization_id) {
            this.showToast('セッションエラー: 再ログインしてください', 'error');
            return;
        }

        // スタッフ超過チェック（ダウングレード後のハック防止）
        if (this.isStaffOverLimit()) {
            const limit = this.getStaffLimit();
            const over = this.state.staff.length - limit;
            const planName = {standard: 'Standard', pro: 'Pro', premium: 'Premium'}[this.state.config.stripe_plan] || 'Standard';
            this.closeModal('autoFillModal');
            this.showStaffOverLimitAlert();
            this.showToast(`${planName}プランの上限(${limit}名)を${over}名超過しています。スタッフを削除してください。`, 'error');
            this.changeView('staff');
            return;
        }

        const targetType = (document.getElementById('autoFillTarget')?.value || '');
        this.closeModal('autoFillModal');

        const loadingEl = document.getElementById('globalLoading');
        const loadingDefault = document.getElementById('loadingDefault');
        const loadingShiftGen = document.getElementById('loadingShiftGen');
        const stepEl = document.getElementById('shiftGenStep');
        const barEl = document.getElementById('shiftGenBar');
        const tipEl = document.getElementById('shiftGenTip');

        this._shiftGenInProgress = true;

        if (loadingDefault) loadingDefault.style.display = 'none';
        if (loadingShiftGen) loadingShiftGen.style.display = 'flex';
        if (loadingEl) loadingEl.classList.remove('hidden');
        if (stepEl) stepEl.textContent = 'スタッフ情報を読み込んでいます...';
        if (barEl) { barEl.style.transition = 'width 2s ease'; barEl.style.width = '5%'; }

        // 最低表示時間を保証
        const loadingStartTime = Date.now();
        const MIN_LOADING_MS = 12000;

        // プログレスバーを滑らかに進める（実処理と独立）
        let fakeProgress = 5;
        const progressTimer = setInterval(() => {
            if (fakeProgress < 90) {
                fakeProgress += Math.random() * 3 + 1;
                if (fakeProgress > 90) fakeProgress = 90;
                if (barEl) barEl.style.width = fakeProgress + '%';
            }
        }, 800);

        // 豆知識ローテーション開始
        let tipIdx = 0;
        if (this._tipTimer) clearInterval(this._tipTimer);
        this._tipTimer = setInterval(() => {
            tipIdx = (tipIdx + 1) % this._shiftGenTips.length;
            if (tipEl) {
                tipEl.style.opacity = '0';
                setTimeout(() => {
                    tipEl.textContent = this._shiftGenTips[tipIdx];
                    tipEl.style.opacity = '1';
                }, 200);
            }
        }, 4000);

        // ステップメッセージをゆっくり切り替え
        const steps = [
            { delay: 2000, msg: '人員配置の事前チェック中...' },
            { delay: 4500, msg: 'AIがシフトを最適化しています...' },
            { delay: 7000, msg: '労働基準法に基づいて検証中...' },
            { delay: 9500, msg: '最終調整を行っています...' },
        ];
        const stepTimers = steps.map(s => setTimeout(() => { if (stepEl) stepEl.textContent = s.msg; }, s.delay));

        try {
            console.log("Refreshing data before generation...");
            await this.loadData();

            const today = new Date();
            let startDate, endDate;

            if (targetType === 'reset_all' || targetType === 'empty_only') {
                startDate = new Date(this.state.currentDate.getFullYear(), this.state.currentDate.getMonth(), 1);
                endDate = new Date(this.state.currentDate.getFullYear(), this.state.currentDate.getMonth() + 1, 0);
            } else if (targetType === 'next_week') {
                const day = today.getDay();
                const diff = 7 - day;
                startDate = new Date(today);
                startDate.setDate(today.getDate() + diff);
                endDate = new Date(startDate);
                endDate.setDate(startDate.getDate() + 6);
            }

            const dates = [];
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                dates.push(dateStr);
            }

            if (!this.state.config.organization_id) {
                this.state.config.organization_id = this.state.organization_id;
            }

            const payload = {
                staff_list: this.state.staff,
                config: this.state.config,
                dates: dates,
                requests: this.state.requests || [],
                mode: 'auto',
                existing_shifts: []
            };

            // empty_only モード: 期間内の既存シフトを「固定」として Python に渡し、
            // 空きスロットのみ最適化される。これがないとサーバはゼロから組み直すため
            // 「空きを埋めるをクリックすると人数が減る」現象が発生する。
            // 注意: id が無いシフト (=未保存のローカルプレビュー残骸) は除外する。
            //       これがないと、前回の生成試行で残った仮データを「既存」として固定して
            //       しまい、本当の DB データと矛盾する。
            if (targetType === 'empty_only') {
                payload.existing_shifts = (this.state.shifts || [])
                    .filter(s => s && s.id && s.date && dates.includes(s.date) && s.staff_id && s.start_time && s.end_time)
                    .map(s => ({
                        staff_id: s.staff_id,
                        date: s.date,
                        start_time: (s.start_time || '').substr(0, 5),
                        end_time: (s.end_time || '').substr(0, 5)
                    }));
            }

            // デバッグ: 送信スタッフ数を確認
            console.log(`[AutoFill] Sending ${payload.staff_list.length} staff, ${dates.length} dates, ${payload.requests.length} requests, ${payload.existing_shifts.length} fixed-existing`);
            console.log('[AutoFill] Staff IDs:', payload.staff_list.map(s => s.name || s.id).join(', '));

            // === STEP 2: 事前チェック ===

            const checkResult = await API.checkFeasibility(payload);

            if (checkResult && !checkResult.feasible) {
                if (loadingEl) loadingEl.classList.add('hidden');

                const summary = checkResult.summary || {};
                const details = checkResult.daily_details || [];

                let alertMsg = '⚠️ 人員不足が検出されました\n\n';
                alertMsg += '稼働可能スタッフ: ' + summary.usable_staff + '/' + summary.total_staff + '名\n';
                alertMsg += '不足合計: ' + summary.total_shortage_hours + ' 人時\n';
                alertMsg += '影響日数: ' + summary.affected_days + '日\n\n';

                if (details.length > 0) {
                    alertMsg += '--- 不足の詳細 (最大5日) ---\n';
                    for (var di = 0; di < Math.min(details.length, 5); di++) {
                        var dd = details[di];
                        alertMsg += dd.date + ': 出勤可能' + dd.available_staff + '名 / 必要' + dd.required_per_slot + '名\n';
                        for (var ri = 0; ri < dd.shortage_ranges.length; ri++) {
                            var r = dd.shortage_ranges[ri];
                            alertMsg += '  ' + r.start + '~' + r.end + ': ' + r.shortage + '名不足\n';
                        }
                    }
                }

                alertMsg += '\n【OK】労働条件を緩和して強行生成\n【キャンセル】中止して人員を調整';

                const forceGenerate = confirm(alertMsg);

                if (!forceGenerate) {
                    if (this._tipTimer) { clearInterval(this._tipTimer); this._tipTimer = null; }
                    clearInterval(progressTimer);
                    stepTimers.forEach(t => clearTimeout(t));
                    this._shiftGenInProgress = false;
                    if (loadingShiftGen) loadingShiftGen.style.display = 'none';
                    if (loadingDefault) loadingDefault.style.display = 'flex';
                    if (loadingEl) loadingEl.classList.add('hidden');
                    this.showToast('シフト生成を中止しました。スタッフの追加や条件の見直しを検討してください。', 'info');
                    return;
                }

                payload.mode = 'force';
                if (loadingEl) loadingEl.classList.remove('hidden');
                if (loadingShiftGen) loadingShiftGen.style.display = 'flex';
                this.showToast('⚠️ 労働条件を緩和して生成します', 'warning');
            }

            // === STEP 3: 削除処理 ===
            if (targetType === 'reset_all') {

                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                const shiftsToDelete = this.state.shifts.filter(function(s) {
                    return dates.includes(s.date) && new Date(s.date) >= today && s.id && uuidRegex.test(s.id);
                });
                if (shiftsToDelete.length > 0) {
                    await Promise.all(shiftsToDelete.map(function(s) { return API.delete('shifts', s.id); }));
                }
                this.state.shifts = this.state.shifts.filter(function(s) {
                    return !(dates.includes(s.date) && new Date(s.date) >= today);
                });
            }

            // === STEP 4: シフト生成 ===

            console.log("Sending request to Calculation Engine...");
            const result = await API.generateShifts(payload);

            if (result.status === 'error') {
                this.showToast('生成エラー: ' + result.message, 'error');
                this._generationSuccess = false;
                return;
            }

            console.log("Server Response:", result);
            if (barEl) barEl.style.width = '80%';

            if (result.status === 'success' && result.shifts && result.shifts.length > 0) {
                const newShifts = result.shifts;

                const existing = this.state.shifts.filter(function(s) { return dates.includes(s.date); });
                const finalShifts = [];

                for (var i = 0; i < newShifts.length; i++) {
                    var s = newShifts[i];
                    if (targetType === 'empty_only') {
                        var exists = existing.find(function(ex) { return ex.date === s.date && ex.staff_id === s.staff_id; });
                        if (exists) continue;
                    }
                    finalShifts.push(s);
                }

                // プレビュー表示 (DB保存はプレビュー承認後に実行)
                this._generationSuccess = finalShifts.length > 0;
                this._generationCount = finalShifts.length;
                this._pendingPreviewShifts = finalShifts;
                this._pendingPreviewTargetType = targetType;
                this._pendingPreviewDates = dates;
                this._pendingPreviewReport = result.report || null;

            } else if (result.status === 'success' && result.mode === 'math_failed') {
                // 数理最適化が解を見つけられなかった
                console.warn('Math optimization failed - no feasible solution');
                this.showToast('最適化エンジンが解を見つけられませんでした。スタッフの勤務条件を緩和するか、スタッフを追加してください。', 'warning');
                this._generationSuccess = false;
            } else if (result.status === 'success' && (!result.shifts || result.shifts.length === 0)) {
                // シフトが0件
                console.warn('No shifts generated');
                this.showToast('生成可能なシフトがありませんでした。スタッフの設定や休暇申請を確認してください。', 'warning');
                this._generationSuccess = false;
            } else {
                this._generationSuccess = false;
            }

        } catch (e) {
            console.error('AutoFill Error:', e);
            this._generationSuccess = false;
        } finally {
            // タイマー全クリア
            clearInterval(progressTimer);
            stepTimers.forEach(t => clearTimeout(t));
            if (this._tipTimer) { clearInterval(this._tipTimer); this._tipTimer = null; }

            // 最低表示時間を待つ
            const elapsed = Date.now() - loadingStartTime;
            if (elapsed < MIN_LOADING_MS) {
                if (stepEl) stepEl.textContent = this._generationSuccess ? 'シフトの最終確認中...' : '処理を完了しています...';
                if (barEl) barEl.style.width = '95%';
                await new Promise(r => setTimeout(r, MIN_LOADING_MS - elapsed));
            }

            // 100%にしてから少し待つ
            if (barEl) barEl.style.width = '100%';
            if (stepEl) stepEl.textContent = this._generationSuccess ? '完了しました！' : '処理が終了しました';
            if (tipEl) { tipEl.style.opacity = '0'; setTimeout(() => { tipEl.textContent = 'カレンダーに反映します'; tipEl.style.opacity = '1'; }, 200); }
            await new Promise(r => setTimeout(r, 1500));

            // フェードアウト
            const loadingElFinal = document.getElementById('globalLoading');
            const loadingDefaultFinal = document.getElementById('loadingDefault');
            const loadingShiftGenFinal = document.getElementById('loadingShiftGen');

            if (loadingElFinal) { loadingElFinal.style.transition = 'opacity 0.6s'; loadingElFinal.style.opacity = '0'; }
            await new Promise(r => setTimeout(r, 600));

            if (loadingShiftGenFinal) loadingShiftGenFinal.style.display = 'none';
            if (loadingDefaultFinal) loadingDefaultFinal.style.display = 'flex';
            if (loadingElFinal) { loadingElFinal.classList.add('hidden'); loadingElFinal.style.opacity = ''; loadingElFinal.style.transition = ''; }

            // カレンダー更新
            this.renderCurrentView();
            this.calculateMonthlyStats();

            this._shiftGenInProgress = false;

            // プレビューモーダルを表示（生成成功時）
            if (this._generationSuccess && this._pendingPreviewShifts && this._pendingPreviewShifts.length > 0) {
                setTimeout(() => {
                    this.showShiftPreview(this._pendingPreviewShifts, this._pendingPreviewTargetType, this._pendingPreviewDates, this._pendingPreviewReport);
                    this._pendingPreviewShifts = null;
                    this._pendingPreviewTargetType = null;
                    this._pendingPreviewDates = null;
                    this._pendingPreviewReport = null;
                }, 300);
            } else if (!this._generationSuccess) {
                this.showToast('シフト作成に問題がありました。条件を見直してください。', 'warning');
            }
        }
    },


    // 一括保存 (大量データの保存)
            async saveAllShifts(shifts) {
        if (!shifts || shifts.length === 0) return;

        var targetDates = [...new Set(shifts.map(function(s){ return s.date; }))];

        console.log("Deleting existing shifts for " + targetDates.length + " days...");
        for (var di = 0; di < targetDates.length; di++) {
            try {
                await API._request('shifts?organization_id=eq.' + this.state.organization_id + '&date=eq.' + targetDates[di], {
                    method: 'DELETE'
                });
            } catch(e) {
                console.error("Delete error for " + targetDates[di] + ":", e);
            }
        }

        this.state.shifts = this.state.shifts.filter(function(s){ return targetDates.indexOf(s.date) === -1; });

        var cleanShifts = shifts.map(function(s){
            var obj = {
                organization_id: this.state.organization_id,
                staff_id: s.staff_id,
                date: s.date,
                start_time: s.start_time,
                end_time: s.end_time,
                break_minutes: s.break_minutes || 0
            };
            // イレギュラーフラグがある場合のみ保存（通常シフトではfalse/未設定）
            if (s.is_irregular) obj.is_irregular = true;
            return obj;
        }.bind(this));

        var batchSize = 50;
        for (var i = 0; i < cleanShifts.length; i += batchSize) {
            var batch = cleanShifts.slice(i, i + batchSize);
            try {
                await Promise.all(batch.map(function(s){ return API.create('shifts', s); }));
            } catch(e) {
                console.error("Batch save error:", e);
            }
        }

        this.state.shifts.push.apply(this.state.shifts, cleanShifts);
        console.log("All shifts saved.");
    },





    async generateShiftsForDay(dateStr, existingShifts, generatedShiftsSoFar = []) {
        // ---------------------------------------------------------
        // 0. 日付と設定の初期化 (厳格モード)
        // ---------------------------------------------------------
        const dateObj = new Date(dateStr.replace(/-/g, '/'));
        const dayOfWeek = dateObj.getDay(); // 0=Sun, 6=Sat
        const config = this.state.config;
        
        // 祝日判定
        const jh = (typeof window !== 'undefined' && window.JapaneseHolidays) || (typeof JapaneseHolidays !== 'undefined' ? JapaneseHolidays : null);
        const isHoliday = jh ? jh.isHoliday(dateStr) : false;

        // 営業時間の決定
        let openTime = "09:00";
        let closeTime = "22:00";
        
        const specialDay = (config.special_days || {})[dateStr];
        if (specialDay && specialDay.start && specialDay.end) {
            openTime = specialDay.start;
            closeTime = specialDay.end;
        } else {
            const times = config.opening_times || {};
            const defTimes = this.state.defaultConfig.opening_times;
            const getT = (key) => (times[key] || defTimes[key]);
            
            if (isHoliday) { openTime = getT('holiday').start; closeTime = getT('holiday').end; }
            else if (dayOfWeek === 0 || dayOfWeek === 6) { openTime = getT('weekend').start; closeTime = getT('weekend').end; }
            else { openTime = getT('weekday').start; closeTime = getT('weekday').end; }
        }

        // 時間変換ヘルパー (分単位)
        const toMins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        const fromMins = (m) => { 
            let h = Math.floor(m / 60); 
            let min = m % 60;
            // 24時間表記正規化
            if (h >= 24) h -= 24;
            return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        };

        const startMins = toMins(openTime);
        const endMins = toMins(closeTime);
        // 日またぎ対応 (close < open なら +24h)
        const effectiveEndMins = endMins < startMins ? endMins + (24 * 60) : endMins;

        // ---------------------------------------------------------
        // 1. 必要人数の算出 (15分刻みバケット)
        // ---------------------------------------------------------
        const timeReqs = new Map(); // key: minutes, val: count
        const timeReqManager = new Map(); // key: minutes, val: count (1 or 0)

        // ベース要件
        let baseReq = 2;
        const sReq = config.staff_req || {};
        if (isHoliday) baseReq = sReq.min_holiday || 3;
        else if (dayOfWeek === 0 || dayOfWeek === 6) baseReq = sReq.min_weekend || 3;
        else baseReq = sReq.min_weekday || 2;
        
        const reqManager = sReq.min_manager || 1;

        // 全スロット初期化 (15分刻み)
        for (let t = startMins; t < effectiveEndMins; t += 15) {
            timeReqs.set(t, Number(baseReq));
            timeReqManager.set(t, Number(reqManager));
        }

        // 時間帯別ルールの適用 (time_staff_req)（days配列の型を数値に統一）
        const timeRules = (config.time_staff_req || []).filter(r => (r.days || []).map(Number).includes(dayOfWeek));
        timeRules.forEach(rule => {
            const rStart = toMins(rule.start);
            let rEnd = toMins(rule.end);
            if (rEnd < rStart) rEnd += 24*60;
            
            for (let t = startMins; t < effectiveEndMins; t += 15) {
                // ルール期間内か (絶対値 or 日またぎ考慮)
                // 簡易判定として、シフト生成日(当日)の営業範囲内で、ルールの開始〜終了に合致するか
                
                // ※日またぎ同士の厳密判定は複雑だが、ここでは「営業日」という概念内の絶対分で比較する
                // rule.start が "22:00"(1320), rule.end が "02:00"(1560)
                // t が "23:00"(1380) なら範囲内。
                // 営業時間が "18:00"(1080) ~ "26:00"(1560) であれば、t=1380 は範囲内。
                
                // ただし、rule.start が "01:00"(60) で rule.end が "02:00"(120) の場合（深夜のみ指定）
                // 営業時間が深夜に及ぶ場合、t=60 は "翌日の01:00" を指す可能性がある。
                // startMinsが540(9:00)でeffectiveEndMinsが1320(22:00)なら、t=60は存在しない。
                // startMinsが1080(18:00)でeffectiveEndMinsが1560(26:00)なら、t=1500(25:00=01:00)が存在する。
                // 入力された rule.start(01:00) をどう解釈するか？
                // 通常、「営業時間内の 01:00」とみなすべき。
                // => t を 24h正規化した値 (t % 1440) と ruleの時刻を比較する？
                
                // ここではシンプルに、ruleも絶対分(startMins基準)に変換できればベストだが、
                // ruleはただの時刻文字列。
                // 「開始時刻 >= rule.start && 開始時刻 < rule.end」
                
                // A. ruleが日またぎでない (11:00-14:00)
                // B. ruleが日またぎ (22:00-02:00)
                
                // tの時刻表現
                const tMod = t % 1440;
                
                let inRule = false;
                if (rStart < rEnd) {
                    // 通常
                    inRule = (tMod >= rStart && tMod < rEnd);
                } else {
                    // 日またぎ (22:00 <= t < 24:00 OR 00:00 <= t < 02:00)
                    inRule = (tMod >= rStart || tMod < rEnd);
                }
                
                // さらに、t自体が「営業開始前」の深夜（早朝）でないことの保証が必要だが、
                // loop範囲が startMins〜effectiveEndMins なのでOK。
                
                if (inRule) {
                    const current = timeReqs.get(t) || 0;
                    timeReqs.set(t, Math.max(current, Number(rule.count)));
                }
            }
        });

        // ---------------------------------------------------------
        // 2. 現在の充足状況マップ作成
        // ---------------------------------------------------------
        const currentDayNewShifts = [];
        const getAllShifts = () => [...existingShifts, ...generatedShiftsSoFar, ...currentDayNewShifts];

        const getCoverage = () => {
            const coverage = new Map();
            const managerCoverage = new Map();
            
            for (let t = startMins; t < effectiveEndMins; t += 15) {
                coverage.set(t, 0);
                managerCoverage.set(t, 0);
            }

            const shifts = getAllShifts().filter(s => s.date === dateStr);
            shifts.forEach(s => {
                const sStart = toMins(s.start_time);
                let sEnd = toMins(s.end_time);
                if (sEnd < sStart) sEnd += 24*60;
                
                const staff = this.getStaff(s.staff_id);
                const isManager = staff && (staff.role === 'manager' || staff.role === 'leader');

                for (let t = startMins; t < effectiveEndMins; t += 15) {
                    if (t >= sStart && t < sEnd) {
                        coverage.set(t, (coverage.get(t) || 0) + 1);
                        if (isManager) managerCoverage.set(t, (managerCoverage.get(t) || 0) + 1);
                    }
                }
            });
            return { coverage, managerCoverage };
        };

        // ---------------------------------------------------------
        // 3. 承認済みシフトの適用 (Requests)
        // ---------------------------------------------------------
        const workReqs = this.state.requests.filter(r => 
            r.dates === dateStr && r.type === 'work' && r.status === 'approved'
        );
        workReqs.forEach(req => {
            const already = getAllShifts().some(s => s.staff_id === req.staff_id && s.date === dateStr);
            if (!already) {
                const s = this.getStaff(req.staff_id);
                if (s) {
                    const rs = req.start_time || openTime;
                    const re = req.end_time || closeTime;
                    currentDayNewShifts.push(this.createShiftObject(s.id, dateStr, rs, re));
                }
            }
        });

        // ---------------------------------------------------------
        // 4. スタッフリストの準備 (ランク順 A>B>C)
        // ---------------------------------------------------------
        const offStaffIds = this.state.requests
            .filter(r => r.dates === dateStr && (r.type === 'off' || r.type === 'holiday') && r.status === 'approved')
            .map(r => r.staff_id);

        let sortedStaff = [...this.state.staff].filter(s => !offStaffIds.includes(s.id));
        
        sortedStaff.sort((a, b) => {
            const rankScore = { 'A': 3, 'B': 2, 'C': 1 };
            const rA = rankScore[a.evaluation] || 2;
            const rB = rankScore[b.evaluation] || 2;
            if (rA !== rB) return rB - rA;
            const roleScore = { 'manager': 3, 'leader': 2, 'staff': 1 };
            const rolA = roleScore[a.role] || 1;
            const rolB = roleScore[b.role] || 1;
            if (rolA !== rolB) return rolB - rolA;
            return Math.random() - 0.5;
        });

        // ---------------------------------------------------------
        // 5. 不足分の充填 (Gap Filling) - 強化版
        // ---------------------------------------------------------
        const ignoredSlots = new Set(); // 埋められなかったスロットを記憶して無限ループ回避

        // ループ処理 (最大100パス)
        for (let pass = 0; pass < 100; pass++) {
            const { coverage, managerCoverage } = getCoverage();
            
            // 不足スロット探索
            let deficitSlot = -1;
            let missingType = null;

            for (let t = startMins; t < effectiveEndMins; t += 15) {
                if (ignoredSlots.has(t)) continue; // 諦めたスロットはスキップ

                if (managerCoverage.get(t) < timeReqManager.get(t)) {
                    deficitSlot = t;
                    missingType = 'manager';
                    break;
                }
                if (coverage.get(t) < timeReqs.get(t)) {
                    deficitSlot = t;
                    missingType = 'staff';
                    break;
                }
            }

            if (deficitSlot === -1) break; // 全充足 (または全て諦めた)

            let shiftAddedOrExtended = false;
            
            const targetEnd = Math.min(deficitSlot + 480, effectiveEndMins); // 基本は+8時間
            const reqTimeRange = { start: fromMins(deficitSlot), end: fromMins(targetEnd) };
            const roleFilter = missingType === 'manager' ? (s) => (s.role === 'manager' || s.role === 'leader') : null;

            // =========================================================
            // 戦略1: 既存シフトの延長 (通常時間内)
            // =========================================================
            for (const s of currentDayNewShifts) {
                const sEnd = toMins(s.end_time) + (s.end_time < s.start_time ? 24*60 : 0);
                
                // ギャップが60分以内なら結合対象
                if (sEnd <= deficitSlot && (deficitSlot - sEnd) <= 60) {
                    const staff = this.getStaff(s.staff_id);
                    if (roleFilter && !roleFilter(staff)) continue;

                    const maxMins = (Number(staff.max_hours_day) || 8) * 60;
                    // 延長後の終了時間 (最低でもdeficitを埋めるために+3h)
                    const newEndMins = Math.min(deficitSlot + 180, effectiveEndMins);
                    const sStart = toMins(s.start_time);
                    const newDurMins = newEndMins - sStart;

                    // 通常上限内であれば延長
                    if (newDurMins <= maxMins) {
                        s.end_time = fromMins(newEndMins);
                        if (newDurMins > 480) s.break_minutes = 60; else if (newDurMins > 360) s.break_minutes = 45;
                        shiftAddedOrExtended = true;
                        break;
                    }
                }
            }
            if (shiftAddedOrExtended) continue;

            // =========================================================
            // 戦略2: 新規シフト追加 (通常時間内)
            // =========================================================
            let candidate = this.findAvailableStaff(sortedStaff, dateStr, getAllShifts(), roleFilter, { timeRange: reqTimeRange });
            
            if (candidate) {
                const maxH = Number(candidate.max_hours_day) || 8;
                const dur = Math.min(480, maxH * 60);
                const endT = Math.min(deficitSlot + dur, effectiveEndMins);
                // オーバータイム許可なし(第4引数省略)で作成
                const newShift = this.createShiftObject(candidate.id, dateStr, fromMins(deficitSlot), fromMins(endT));
                currentDayNewShifts.push(newShift);
                shiftAddedOrExtended = true;
                continue;
            }

            // =========================================================
            // 戦略3: 既存シフトの延長 (残業 +3h許容)
            // =========================================================
            for (const s of currentDayNewShifts) {
                const sEnd = toMins(s.end_time) + (s.end_time < s.start_time ? 24*60 : 0);
                
                if (sEnd <= deficitSlot && (deficitSlot - sEnd) <= 60) {
                    const staff = this.getStaff(s.staff_id);
                    if (roleFilter && !roleFilter(staff)) continue;

                    const maxMins = (Number(staff.max_hours_day) || 8) * 60;
                    const limitMins = Math.min(maxMins + 180, 660); // Max 11h
                    const newEndMins = Math.min(deficitSlot + 180, effectiveEndMins);
                    const sStart = toMins(s.start_time);
                    const newDurMins = newEndMins - sStart;

                    if (newDurMins <= limitMins) {
                        s.end_time = fromMins(newEndMins);
                        if (newDurMins > 480) s.break_minutes = 60; else if (newDurMins > 360) s.break_minutes = 45;
                        shiftAddedOrExtended = true;
                        break;
                    }
                }
            }
            if (shiftAddedOrExtended) continue;

            // =========================================================
            // 戦略4: 新規シフト追加 (緊急モード: 週制限無視 & 残業許容)
            // =========================================================
            // まず週制限だけ無視して探す
            candidate = this.findAvailableStaff(sortedStaff, dateStr, getAllShifts(), roleFilter, { timeRange: reqTimeRange, ignoreWeekLimit: true });
            
            // それでもいなければ、重複以外なんでもあり (Manager欠員など深刻な場合)
            if (!candidate) {
                 candidate = this.findAvailableStaff(sortedStaff, dateStr, getAllShifts(), roleFilter, { 
                     timeRange: reqTimeRange, ignoreWeekLimit: true, ignoreOverlap: false 
                 });
            }

            if (candidate) {
                const maxH = Number(candidate.max_hours_day) || 8;
                // 緊急時は+3hまで許容
                const limitMins = Math.min((maxH + 3) * 60, 660);
                const dur = Math.min(480, limitMins);
                const endT = Math.min(deficitSlot + dur, effectiveEndMins);
                
                // createShiftObjectにオーバータイム許可フラグ(true)を渡す
                const newShift = this.createShiftObject(candidate.id, dateStr, fromMins(deficitSlot), fromMins(endT), true);
                currentDayNewShifts.push(newShift);
                shiftAddedOrExtended = true;
                continue;
            }

            // 手詰まり
            if (!shiftAddedOrExtended) {
                ignoredSlots.add(deficitSlot);
            }
        }

        return currentDayNewShifts;
    },

    findAvailableStaff(staffList, dateStr, allShiftsContext, filterFn = null, options = {}) {
        const { ignoreWeekLimit = false, timeRange = null } = options;
        
        // 日付範囲計算
        const dateObj = new Date(dateStr.replace(/-/g, '/'));
        const day = dateObj.getDay();
        const startOfWeek = new Date(dateObj);
        startOfWeek.setDate(dateObj.getDate() - day);
        const formatYMD = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const startStr = formatYMD(startOfWeek);
        const endStr = formatYMD(new Date(startOfWeek.getTime() + 6*24*60*60*1000));

        // 時間変換
        const toMins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

        for (const staff of staffList) {
            // 基本フィルター
            if (filterFn && !filterFn(staff)) continue;

            // 1. 休み希望チェック
            const isOff = this.state.requests.some(r => 
                r.staff_id === staff.id && r.dates === dateStr && (r.type === 'off' || r.type === 'holiday') && r.status === 'approved'
            );
            if (isOff && !ignoreWeekLimit) continue; 

            // 2. 重複チェック & 勤務時間
            const dailyShifts = allShiftsContext.filter(s => s.staff_id === staff.id && s.date === dateStr);
            
            if (timeRange) {
                const newStart = toMins(timeRange.start);
                let newEnd = toMins(timeRange.end);
                if (newEnd < newStart) newEnd += 24*60;

                // 時間被り
                const isOverlap = dailyShifts.some(s => {
                    const sStart = toMins(s.start_time);
                    let sEnd = toMins(s.end_time);
                    if (sEnd < sStart) sEnd += 24*60;
                    return sStart < newEnd && sEnd > newStart; 
                });
                if (isOverlap) continue;
            } else {
                if (dailyShifts.length > 0) continue; 
            }

            // 3. 勤務時間上限 (日) - 既存シフト + 新規
            const maxMins = (Number(staff.max_hours_day) || 8) * 60;
            const limitMins = ignoreWeekLimit ? Math.min(maxMins + 180, 660) : maxMins; 
            
            const currentMins = dailyShifts.reduce((acc, s) => {
                 const sStart = toMins(s.start_time);
                 let sEnd = toMins(s.end_time);
                 if (sEnd < sStart) sEnd += 24*60;
                 return acc + (sEnd - sStart);
            }, 0);
            
            let newDur = 180; // 仮
            if (timeRange) {
                const ns = toMins(timeRange.start);
                let ne = toMins(timeRange.end);
                if (ne < ns) ne += 24*60;
                newDur = ne - ns;
            }
            
            if (currentMins + newDur > limitMins) continue;

            // 4. 週勤務日数チェック
            if (!ignoreWeekLimit) {
                const weekShifts = allShiftsContext.filter(s => s.staff_id === staff.id && s.date >= startStr && s.date <= endStr);
                const workedDays = new Set(weekShifts.map(s => s.date)).size;
                const maxDays = Number(staff.max_days_week) || 5;
                
                const workedToday = dailyShifts.length > 0;
                if (!workedToday && workedDays >= maxDays) continue;
            }

            return staff; 
        }
        return null;
    },

    createShiftObject(staffId, date, start, end, allowOvertime = false) {
        if (!staffId || !date || !start || !end) {
            console.warn('Shift creation skipped due to missing data', { staffId, date, start, end });
            // ダミーを返してエラーを防ぐが、保存時に除外されるようにする（あるいはバリデーションで弾く）
            return { staff_id: staffId, date, start_time: start || '00:00', end_time: end || '00:00', break_minutes: 0, _invalid: true };
        }

        // --- スタッフの勤務時間を厳格に守るためのファイヤーウォール ---
        const staff = this.getStaff(staffId);
        let maxHours = (staff && staff.max_hours_day) ? Number(staff.max_hours_day) : 8;
        
        // オーバータイム許可時は最大11時間まで拡張
        if (allowOvertime) {
            maxHours = Math.min(maxHours + 3, 11);
        }

        let startDate = new Date(`2000-01-01T${start}`);
        let endDate = new Date(`2000-01-01T${end}`);
        // 日付またぎ対応
        if (endDate < startDate) {
            endDate.setDate(endDate.getDate() + 1);
        }

        let duration = (endDate - startDate) / 3600000;

        // 最大勤務時間を超えている場合、強制的に短縮する
        if (duration > maxHours) {
            // 短縮ロジック:
            // 基本的には「終了時間を早める」ことで調整する。
            // ただし、元のシフトが「遅番（例: 17-22）」のような場合、
            // 「17-20 (早上がり)」にするか「19-22 (遅入り)」にするかは文脈による。
            // ここでは安全策として「終了時間を基準」に調整（遅入り）するロジックを採用するケースも考慮したいが、
            // 最も汎用的なのは「開始時間を維持して早上がり」させることである。
            // しかし、ユーザーの苦情「17-22シフト」に対し「3時間制限」がある場合、
            // 17-20になるのが自然。
            
            // 例外対応: もしシフトが「店舗の閉店時間(config.closing_time)」と一致して終わる場合、
            // 「ラストまで」という意味合いが強いため、「開始時間を遅らせる」ほうが適切かもしれない。
            // が、configへのアクセスが複雑になるため、ここではシンプルに
            // 「開始時間を維持し、終了時間をmaxHours後に設定する」方式で統一し、
            // 絶対にmaxHoursを超えないことを保証する。
            
            // もし呼び出し元で「遅番だから遅く始めてほしい」場合は、
            // 呼び出し元で時間を計算して渡すべきである。
            // ここは「最終防衛ライン」として機能させる。

            const newEndMillis = startDate.getTime() + (maxHours * 3600000);
            endDate = new Date(newEndMillis);
            
            // end文字列を再生成 (HH:mm)
            end = `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`;
            
            // 再計算
            duration = maxHours;
        }

        let breakMins = 0;
        // 設定された休憩ルールを適用
        const rules = this.state.config.break_rules || this.state.defaultConfig.break_rules;
        // 降順にソートして、最大の条件に合致するものを適用
        const sortedRules = [...rules].sort((a,b) => b.min_hours - a.min_hours);
        
        for(const rule of sortedRules) {
            if(duration >= rule.min_hours) {
                breakMins = rule.break_minutes;
                break;
            }
        }
        
        return { staff_id: staffId, date, start_time: start, end_time: end, break_minutes: breakMins };
    },

    // --- マニュアル ---
    renderManual(container) {
        if (!this.state.isAdmin && !this.state.isHQ) { this.changeView('dashboard'); return; }

        let tabsHtml = '';
        if (this.state.isHQ) {
            tabsHtml = `
            <div class="flex border-b border-gray-200 mb-6 bg-white rounded-xl p-1 shadow-sm max-w-4xl mx-auto">
                <button onclick="app.changeView('manual')" class="flex-1 py-2.5 text-sm font-bold text-center rounded-lg bg-indigo-50 text-indigo-700 shadow-sm transition-all">
                    <i class="fa-solid fa-book mr-1"></i>店舗管理者マニュアル
                </button>
                <button onclick="app.changeView('hq_manual')" class="flex-1 py-2.5 text-sm font-bold text-center rounded-lg text-gray-500 hover:text-gray-900 transition-all">
                    <i class="fa-solid fa-building-user mr-1"></i>本部管理者マニュアル
                </button>
            </div>
            `;
        }

        container.innerHTML = `
        ${tabsHtml}
        <div class="max-w-4xl mx-auto space-y-6 pb-20">
            <h2 class="text-2xl font-bold text-gray-800"><i class="fa-solid fa-book mr-2 text-indigo-500"></i>システムマニュアル</h2>

            <!-- 目次 -->
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="font-bold text-gray-800 mb-3">目次</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                    <a href="#m-important" class="text-red-600 hover:underline font-bold">⚠ 設定の重要性</a>
                    <a href="#m-roles" class="text-indigo-600 hover:underline">1. 役職・ロール</a>
                    <a href="#m-eval" class="text-indigo-600 hover:underline">2. スタッフ評価 (A〜D)</a>
                    <a href="#m-shift" class="text-indigo-600 hover:underline">3. AIシフト作成</a>
                    <a href="#m-labor" class="text-indigo-600 hover:underline">4. 労働基準法ルール</a>
                    <a href="#m-break" class="text-indigo-600 hover:underline">5. 休憩ルール</a>
                    <a href="#m-request" class="text-indigo-600 hover:underline">6. 休み希望</a>
                    <a href="#m-settings" class="text-indigo-600 hover:underline">7. 店舗設定</a>
                    <a href="#m-plan" class="text-indigo-600 hover:underline">8. プラン・課金</a>
                    <a href="#m-auth" class="text-indigo-600 hover:underline">9. 権限 (管理者/スタッフ)</a>
                    <a href="#m-analytics" class="text-indigo-600 hover:underline">10. 分析・レポート</a>
                    <a href="#m-other" class="text-indigo-600 hover:underline">11. その他機能</a>
                </div>
            </div>

            <!-- 設定の重要性 -->
            <div id="m-important" class="bg-gradient-to-r from-red-50 to-orange-50 rounded-xl shadow-sm border-2 border-red-300 p-6">
                <h3 class="text-lg font-bold text-red-700 mb-3"><i class="fa-solid fa-triangle-exclamation mr-2"></i>設定の重要性 ― AIシフト精度を最大化するために</h3>
                <div class="bg-white/80 rounded-lg p-4 mb-4">
                    <p class="text-sm text-gray-800 font-bold mb-2">ラクシフトAIのシフト精度は「設定の正確さ」に直結します。</p>
                    <p class="text-sm text-gray-600">AIは設定された情報だけを元に最適なシフトを組みます。設定が不十分だと、偏った配置や穴抜けの原因になります。以下の設定を必ず確認してください。</p>
                </div>

                <div class="space-y-4">
                    <div class="bg-white rounded-lg p-4 border border-orange-200">
                        <h4 class="font-bold text-orange-700 mb-2"><i class="fa-solid fa-user-gear mr-1"></i>スタッフ設定（最重要）</h4>
                        <table class="w-full text-sm border-collapse">
                            <thead><tr class="bg-orange-50"><th class="p-2 text-left border">設定項目</th><th class="p-2 text-left border">説明</th><th class="p-2 text-left border">未設定時の影響</th></tr></thead>
                            <tbody>
                                <tr><td class="p-2 border font-bold">週最大出勤日数</td><td class="p-2 border">1週間に最大何日働けるか</td><td class="p-2 border text-red-600">デフォルト5日になり、バイトに過剰配置される</td></tr>
                                <tr><td class="p-2 border font-bold">週最低出勤日数</td><td class="p-2 border">1週間に最低何日は入りたいか</td><td class="p-2 border text-red-600">0日扱いでシフトに入らない場合がある</td></tr>
                                <tr><td class="p-2 border font-bold">1日の最大労働時間</td><td class="p-2 border">1日に最大何時間働けるか</td><td class="p-2 border text-red-600">8時間扱いで短時間バイトが長時間シフトに入る</td></tr>
                                <tr><td class="p-2 border font-bold">役職</td><td class="p-2 border">店長/リーダー/スタッフ/新人</td><td class="p-2 border text-red-600">OJT制約やメンター配置が機能しない</td></tr>
                                <tr><td class="p-2 border font-bold">評価 (A〜D)</td><td class="p-2 border">スキルレベル</td><td class="p-2 border text-red-600">チーム戦力バランスが偏る</td></tr>
                                <tr><td class="p-2 border font-bold">給与形態</td><td class="p-2 border">月給制 or 時給制</td><td class="p-2 border text-red-600">月給スタッフが優先配置されず人件費が増大</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="bg-white rounded-lg p-4 border border-blue-200">
                        <h4 class="font-bold text-blue-700 mb-2"><i class="fa-solid fa-store mr-1"></i>店舗設定（重要）</h4>
                        <table class="w-full text-sm border-collapse">
                            <thead><tr class="bg-blue-50"><th class="p-2 text-left border">設定項目</th><th class="p-2 text-left border">説明</th><th class="p-2 text-left border">未設定時の影響</th></tr></thead>
                            <tbody>
                                <tr><td class="p-2 border font-bold">営業時間（曜日別）</td><td class="p-2 border">平日/土日/祝日の開店・閉店時間</td><td class="p-2 border text-red-600">閉店後の時間帯にも人員配置される</td></tr>
                                <tr><td class="p-2 border font-bold">必要人員（曜日別）</td><td class="p-2 border">平日/土日/祝日の最低配置人数</td><td class="p-2 border text-red-600">人手不足・過剰配置が発生する</td></tr>
                                <tr><td class="p-2 border font-bold">シフトパターン</td><td class="p-2 border">早番/遅番等の時間テンプレート</td><td class="p-2 border text-red-600">全員が同じ時間帯に集中する</td></tr>
                                <tr><td class="p-2 border font-bold">定休日</td><td class="p-2 border">曜日ベースの休業日</td><td class="p-2 border text-red-600">休業日にシフトが配置される</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="bg-green-50 rounded-lg p-4 border border-green-300">
                        <h4 class="font-bold text-green-700 mb-2"><i class="fa-solid fa-lightbulb mr-1"></i>AI精度を最大化するコツ</h4>
                        <ul class="text-sm text-gray-700 space-y-1">
                            <li>✅ <strong>全スタッフの勤務制約を正確に入力</strong>する（週最大/最低日数、1日最大時間）</li>
                            <li>✅ <strong>月給制/時給制を正しく設定</strong>する → 月給スタッフが優先配置され人件費が最適化される</li>
                            <li>✅ <strong>営業時間を曜日別に設定</strong>する → 土日の短縮営業等が正確に反映される</li>
                            <li>✅ <strong>シフトパターンを2つ以上登録</strong>する → AIが自動的に中番も生成</li>
                            <li>✅ <strong>必要人員を曜日別に設定</strong>する → 平日と土日の配置バランスが最適化される</li>
                            <li>✅ <strong>役職と評価を正しく設定</strong>する → チーム編成の質が向上する</li>
                        </ul>
                    </div>
                </div>
            </div>

            <!-- 1. 役職 -->
            <div id="m-roles" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">1.</span>役職・ロール</h3>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">役職</th><th class="p-2 text-left border">役割</th><th class="p-2 text-left border">シフト生成への影響</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border font-bold">店長 (Manager)</td><td class="p-2 border">最高権限、メンター役</td><td class="p-2 border text-red-600 font-bold">毎営業日に最低○名配置必須（AIが最優先で配置）</td></tr>
                        <tr><td class="p-2 border font-bold">副店長 (Sub-Manager)</td><td class="p-2 border">副管理者、メンター役</td><td class="p-2 border text-orange-600 font-bold">店長の代理として配置可能（店長と同等の権限）</td></tr>
                        <tr><td class="p-2 border font-bold">社員 (Employee)</td><td class="p-2 border">一般社員</td><td class="p-2 border">アルバイトより優先的に配置（月給制の場合はコスト計算上有利に働きます）</td></tr>
                        <tr><td class="p-2 border font-bold">リーダー (Leader)</td><td class="p-2 border">時間帯責任者、メンター役</td><td class="p-2 border">新人スタッフの指導役として重宝されます</td></tr>
                        <tr><td class="p-2 border font-bold">アルバイト (Staff)</td><td class="p-2 border">一般スタッフ</td><td class="p-2 border">通常配置</td></tr>
                        <tr><td class="p-2 border font-bold">新人 (Rookie)</td><td class="p-2 border">研修中</td><td class="p-2 border">必ずメンター（店長〜リーダー）と同日配置</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 2. 評価 -->
            <div id="m-eval" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">2.</span>スタッフ評価 (A〜D)</h3>
                <p class="text-sm text-gray-600 mb-3">評価はAIシフト生成時のチーム編成・配置優先度に影響します。</p>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">評価</th><th class="p-2 text-left border">意味</th><th class="p-2 text-left border">戦力スコア</th><th class="p-2 text-left border">影響</th></tr></thead>
                    <tbody>
                        <tr class="bg-yellow-50"><td class="p-2 border font-bold text-yellow-700">A</td><td class="p-2 border">優秀</td><td class="p-2 border">3.0</td><td class="p-2 border">優先的に配置、ペナルティなし</td></tr>
                        <tr class="bg-blue-50"><td class="p-2 border font-bold text-blue-700">B</td><td class="p-2 border">良好</td><td class="p-2 border">2.0</td><td class="p-2 border">通常配置</td></tr>
                        <tr><td class="p-2 border font-bold text-gray-500">C</td><td class="p-2 border">普通</td><td class="p-2 border">1.0</td><td class="p-2 border">やや控えめに配置</td></tr>
                        <tr class="bg-red-50"><td class="p-2 border font-bold text-red-600">D</td><td class="p-2 border">研修中・要指導</td><td class="p-2 border">0.5</td><td class="p-2 border">メンター必須、単独配置不可</td></tr>
                    </tbody>
                </table>
                <p class="text-xs text-gray-400 mt-2">※ チーム全体の戦力スコアが基準を満たすようAIが自動調整します</p>
            </div>

            <!-- 3. AIシフト作成 -->
            <div id="m-shift" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">3.</span>AIシフト作成</h3>
                <div class="space-y-3 text-sm text-gray-700">
                    <p><strong>「AIシフト作成」ボタン1つ</strong>で以下が自動実行されます:</p>
                    <ol class="list-decimal list-inside space-y-1 ml-2">
                        <li>スタッフの条件・希望休・週勤務日数を読み込み</li>
                        <li>Python数理最適化エンジン(PuLP)でベースシフト生成</li>
                        <li>AI(Gemini)が労基法チェック・違反修正・最適化</li>
                        <li>シフト保存→AI診断レポート表示</li>
                    </ol>
                    <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-2">
                        <p class="text-xs text-blue-700"><strong>作成範囲の選択肢:</strong></p>
                        <ul class="text-xs text-blue-600 mt-1 space-y-0.5">
                            <li>・今月の空きシフトのみ埋める</li>
                            <li>・来週分を作成</li>
                            <li>・現在のシフトをリセットして再構築</li>
                        </ul>
                    </div>
                </div>
            </div>

            <!-- 4. 労基法 -->
            <div id="m-labor" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">4.</span>労働基準法ルール（自動遵守）</h3>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">条項</th><th class="p-2 text-left border">内容</th><th class="p-2 text-left border">システムの制御</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border">労基法32条</td><td class="p-2 border">1日8時間以内</td><td class="p-2 border">スタッフ個別設定で上書き可</td></tr>
                        <tr><td class="p-2 border">労基法32条</td><td class="p-2 border">週40時間以内</td><td class="p-2 border">自動計算で制限</td></tr>
                        <tr><td class="p-2 border">労基法34条</td><td class="p-2 border">6h超→45分休憩、8h超→60分休憩</td><td class="p-2 border">自動付与（設定変更可）</td></tr>
                        <tr><td class="p-2 border">労基法35条</td><td class="p-2 border">週1日以上の休日（連続6日まで）</td><td class="p-2 border">自動遵守</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 5. 休憩ルール -->
            <div id="m-break" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">5.</span>休憩ルール</h3>
                <p class="text-sm text-gray-600 mb-2">シフト作成時に勤務時間から自動計算されます。店舗設定で変更可能です。</p>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">勤務時間</th><th class="p-2 text-left border">休憩時間</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border">6時間超</td><td class="p-2 border">45分以上</td></tr>
                        <tr><td class="p-2 border">8時間超</td><td class="p-2 border">60分以上</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 6. 休み希望 -->
            <div id="m-request" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">6.</span>休み希望</h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <p><strong>スタッフ側:</strong> カレンダーから複数日をタップ選択→「休み希望を提出」</p>
                    <p><strong>管理者側:</strong> 申請リストで確認→承認/却下</p>
                    <p><strong>承認された休み希望</strong>はAIシフト作成時に自動反映され、その日にはシフトが配置されません。</p>
                    <div class="bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <p class="text-xs text-amber-700"><strong>ポイント:</strong> 勤務日数はスタッフの「週最大勤務日数」設定で自動管理されます。休み希望は追加の休日指定です。</p>
                    </div>
                </div>
            </div>

            <!-- 7. 店舗設定 -->
            <div id="m-settings" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">7.</span>店舗設定</h3>
                <div class="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-3">
                    <p class="text-sm text-amber-800 font-bold"><i class="fa-solid fa-triangle-exclamation mr-1"></i>店舗設定はAIシフトの品質に直結します。必ず正確に設定してください。</p>
                </div>
                <div class="space-y-4 text-sm text-gray-700">
                    
                    <div class="border-l-4 border-indigo-400 pl-4 py-1">
                        <h4 class="font-bold text-indigo-700 text-base mb-1">1. 役職・ロール設定</h4>
                        <p>スタッフの肩書き（店長・副店長・社員など）を自由にカスタマイズし、バッジの色を設定できます。また、各役職がシステムの裏側でどの「識別ID（Manager/Sub-Manager/Staffなど）」として扱われるかを決定します。</p>
                        <p class="text-xs text-gray-500 mt-1">※AIは「Manager」や「Sub-Manager」を管理者として扱い、店舗を空にしないよう必ず配置します。</p>
                    </div>

                    <div class="border-l-4 border-teal-400 pl-4 py-1">
                        <h4 class="font-bold text-teal-700 text-base mb-1">1.5. ポジション設定（重要）</h4>
                        <p>店舗内の役割（ホール・キッチン・デリバリーなど）をスペースや読点等で区切って自由に設定できます。</p>
                        <p class="text-xs text-red-600 font-bold mt-1">※注意: 稼働中にポジション名を変更・削除すると、過去そのポジションだったスタッフは「指定なし (全般)」扱いになるため、なるべく初期設定で確定させてください。</p>
                    </div>
                    
                    <div class="border-l-4 border-blue-400 pl-4 py-1">
                        <h4 class="font-bold text-blue-700 text-base mb-1">2. 営業時間 ＆ 定休日</h4>
                        <p>平日・土日・祝日ごとに開店/閉店時間を設定します。未設定だと全日同一営業時間で計算されます。<br>定休日（毎週水曜など）を設定すると、AIはその曜日には一切シフトを入れません。</p>
                    </div>

                    <div class="border-l-4 border-orange-400 pl-4 py-1">
                        <h4 class="font-bold text-orange-700 text-base mb-1">3. ベースの人員設定（1日あたり）</h4>
                        <p><strong>管理者の必須人数:</strong> 「店長・副店長」といった管理者が、1日に最低何人必要かを設定します。<br>
                        <strong>全体の最低人数:</strong> 平日・土日・祝日ごとの最低配置人数。これがシフト表の「人員状況」アラートの基準値になります。</p>
                    </div>

                    <div class="border-l-4 border-red-500 pl-4 py-1">
                        <h4 class="font-bold text-red-700 text-base mb-1">4. 時間帯別・曜日別 人員増強（ピンポイント指定）</h4>
                        <p>「毎週金曜日の17:00〜22:00は、ホールを＋2名増やしたい」といったピンポイントなルールの追加が可能です。<br>
                        設定されたルールはAIの計算エンジンに最優先で組み込まれ、ポジションごとの過不足を完璧に防ぎます。</p>
                    </div>
                    
                    <div class="border-l-4 border-purple-400 pl-4 py-1">
                        <h4 class="font-bold text-purple-700 text-base mb-1">5. シフトパターンの設定</h4>
                        <p>「早番（09:00〜18:00）」「遅番（13:00〜22:00）」などの時間テンプレートです。<strong>2つ以上登録するとAIが自動的に間を埋める中番パターンも生成</strong>し、時間帯の穴抜けを柔軟に防ぎます。</p>
                    </div>

                    <div class="border-l-4 border-green-400 pl-4 py-1">
                        <h4 class="font-bold text-green-700 text-base mb-1">6. 休憩ルールの設定</h4>
                        <p>「〇〇時間以上の勤務なら〇〇分の休憩を与える」というルールです。労働基準法に則り、6時間超で45分、8時間超で60分がデフォルトで設定されています。</p>
                    </div>
                </div>
            </div>

            <!-- 8. プラン -->
            <div id="m-plan" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">8.</span>プラン・課金</h3>
                <table class="w-full text-sm border-collapse">
                    <thead><tr class="bg-gray-50"><th class="p-2 text-left border">プラン</th><th class="p-2 text-left border">月額</th><th class="p-2 text-left border">スタッフ上限</th><th class="p-2 text-left border">機能</th></tr></thead>
                    <tbody>
                        <tr><td class="p-2 border font-bold text-blue-600">Standard</td><td class="p-2 border">3,380円</td><td class="p-2 border">10名</td><td class="p-2 border">全AI機能・シフト管理全機能</td></tr>
                        <tr class="bg-green-50"><td class="p-2 border font-bold text-green-600">Pro</td><td class="p-2 border">4,880円</td><td class="p-2 border">50名</td><td class="p-2 border">+ 優先サポート・分析レポート</td></tr>
                        <tr><td class="p-2 border font-bold text-purple-600">Premium</td><td class="p-2 border">9,980円</td><td class="p-2 border">無制限</td><td class="p-2 border">+ 複数店舗対応・専属サポート</td></tr>
                    </tbody>
                </table>
                <div class="mt-3 space-y-1 text-xs text-gray-500">
                    <p>・上限超過時はスタッフ追加・シフト作成がブロックされます</p>
                    <p>・ダウングレード時、超過分のスタッフを削除するまでシフト作成不可</p>
                    <p>・解約後もデータは6ヶ月間保持されます</p>
                    <p>・決済不備から3週間未対応でサービス一時停止</p>
                </div>
            </div>

            <!-- 9. 権限 -->
            <div id="m-auth" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">9.</span>権限 (管理者 / スタッフ)</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div>
                        <h4 class="font-bold text-green-600 mb-2">管理者ができること</h4>
                        <ul class="space-y-1 text-gray-700">
                            <li>・AIシフト作成</li>
                            <li>・シフトの手動編集・ドラッグ移動</li>
                            <li>・スタッフの追加・編集・削除</li>
                            <li>・休み希望の承認・却下</li>
                            <li>・店舗設定の変更</li>
                            <li>・分析レポートの閲覧</li>
                            <li>・プラン変更</li>
                            <li>・このマニュアルの閲覧</li>
                        </ul>
                    </div>
                    <div>
                        <h4 class="font-bold text-blue-600 mb-2">スタッフができること</h4>
                        <ul class="space-y-1 text-gray-700">
                            <li>・自分のシフト確認</li>
                            <li>・休み希望の提出</li>
                            <li>・お店のルール確認</li>
                        </ul>
                        <p class="text-xs text-gray-400 mt-2">※ スタッフは他のスタッフの情報やシフト編集にはアクセスできません</p>
                    </div>
                </div>
            </div>

            <!-- 10. 分析 -->
            <div id="m-analytics" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">10.</span>分析・レポート</h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <p><strong>月間推定人件費:</strong> 時給スタッフの実績＋月給スタッフの固定額。祝日割増(1.25倍)含む。</p>
                    <p><strong>日次コスト推移:</strong> 日ごとの人件費グラフ。</p>
                    <p><strong>スタッフ別詳細:</strong> 出勤日数・労働時間・法定目安(176h)との比較・推定支給額。</p>
                    <p><strong>コスト構成比:</strong> スタッフ別の人件費割合（円グラフ）。</p>
                </div>
            </div>

            <!-- 11. その他 -->
            <div id="m-other" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h3 class="text-lg font-bold text-gray-800 mb-3"><span class="text-indigo-500 mr-2">11.</span>その他機能</h3>
                <div class="space-y-2 text-sm text-gray-700">
                    <p><strong>カレンダーメモ:</strong> 特定の日にメモを残せます（イベント・団体予約など）。</p>
                    <p><strong>ドラッグ&ドロップ:</strong> シフト表でシフトをドラッグして時間変更・スタッフ変更が可能（管理者のみ）。</p>
                    <p><strong>印刷:</strong> シフト表をPDF/印刷できます。</p>
                    <p><strong>データリセット:</strong> 設定画面の最下部から全データを初期化できます（注意：復元不可）。</p>
                </div>
            </div>
        </div>`;
    },

    renderHQManual(container) {
        if (!this.state.isHQ) { this.changeView('dashboard'); return; }

        // 店舗選択中（＝organization_idがある）なら、サイドバーの枠内なので店舗マニュアルとの切り替えタブを表示
        // 店舗未選択（＝本部ダッシュボードから直接アクセス）なら、本部ダッシュボードに戻るボタンを表示
        const hasShop = !!this.state.organization_id;
        let headerHtml = '';
        if (hasShop) {
            headerHtml = `
            <div class="flex border-b border-gray-200 mb-6 bg-white rounded-xl p-1 shadow-sm max-w-4xl mx-auto">
                <button onclick="app.changeView('manual')" class="flex-1 py-2.5 text-sm font-bold text-center rounded-lg text-gray-500 hover:text-gray-900 transition-all">
                    <i class="fa-solid fa-book mr-1"></i>店舗管理者マニュアル
                </button>
                <button onclick="app.changeView('hq_manual')" class="flex-1 py-2.5 text-sm font-bold text-center rounded-lg bg-indigo-50 text-indigo-700 shadow-sm transition-all">
                    <i class="fa-solid fa-building-user mr-1"></i>本部管理者マニュアル
                </button>
            </div>
            `;
        } else {
            headerHtml = `
            <div class="max-w-4xl mx-auto flex items-center justify-between mb-6">
                <h2 class="text-xl font-bold text-gray-800"><i class="fa-solid fa-building-user mr-2 text-indigo-500"></i>本部管理者マニュアル</h2>
                <button onclick="app.changeView('hq_dashboard')" class="px-4 py-2 text-sm font-bold text-indigo-600 border border-indigo-200 hover:bg-indigo-50 rounded-xl bg-white transition-all shadow-sm">
                    <i class="fa-solid fa-arrow-left mr-1"></i>本部ダッシュボードへ戻る
                </button>
            </div>
            `;
        }

        container.innerHTML = `
        ${headerHtml}
        <div class="max-w-4xl mx-auto space-y-6 pb-20">
            <!-- 概要 -->
            <div class="bg-gradient-to-r from-indigo-50 to-blue-50 rounded-2xl shadow-sm border border-indigo-100 p-6">
                <h3 class="text-lg font-bold text-indigo-900 mb-2"><i class="fa-solid fa-circle-info mr-2"></i>本部アカウントとは</h3>
                <p class="text-sm text-indigo-700 leading-relaxed">
                    本部アカウントは、複数店舗（テナント）のシフト稼働状況や人件費、スタッフ構成を横断的に把握・閲覧するための専用アカウントです。<br>
                    <strong>セキュリティ保護のため、全店舗データは「閲覧専用」であり、本部から直接データの追加や編集、削除を行うことはできません。</strong>
                </p>
            </div>

            <!-- 目次 -->
            <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h3 class="font-bold text-gray-800 mb-3">目次</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                    <a href="#hq-auth" class="text-indigo-600 hover:underline">1. 本部権限とセキュリティポリシー</a>
                    <a href="#hq-dashboard-guide" class="text-indigo-600 hover:underline">2. 本部ダッシュボードの使い方</a>
                    <a href="#hq-shop-access" class="text-indigo-600 hover:underline">3. 店舗へのアクセス手順</a>
                    <a href="#hq-view-mode" class="text-indigo-600 hover:underline">4. 閲覧専用モードでの制限操作</a>
                    <a href="#hq-faq" class="text-indigo-600 hover:underline">5. よくある質問 (FAQ)</a>
                </div>
            </div>

            <!-- 1. 本部権限 -->
            <div id="hq-auth" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">1.</span>本部権限とセキュリティポリシー</h4>
                <div class="space-y-4">
                    <p class="text-sm text-gray-600">本部管理者は、店舗のデータを誤って変更することを防ぐため、各画面が読み取り専用（閲覧のみ）の構成に自動制限されます。</p>
                    <table class="w-full text-sm border-collapse border border-gray-200">
                        <thead>
                            <tr class="bg-gray-50 text-gray-700 font-bold">
                                <th class="p-2 border text-left">操作項目</th>
                                <th class="p-2 border text-center">本部管理者</th>
                                <th class="p-2 border text-center">店舗管理者</th>
                            </tr>
                        </thead>
                        <tbody class="text-gray-600">
                            <tr>
                                <td class="p-2 border font-bold">登録店舗一覧の表示</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                                <td class="p-2 border text-center text-red-500"><i class="fa-solid fa-circle-xmark"></i> 不可</td>
                            </tr>
                            <tr>
                                <td class="p-2 border font-bold">シフト表の閲覧・印刷</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                            </tr>
                            <tr>
                                <td class="p-2 border font-bold">スタッフ構成の閲覧</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                            </tr>
                            <tr>
                                <td class="p-2 border font-bold">シフトの新規作成・編集</td>
                                <td class="p-2 border text-center text-red-500 font-bold"><i class="fa-solid fa-circle-xmark"></i> 閲覧のみ</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                            </tr>
                            <tr>
                                <td class="p-2 border font-bold">スタッフの追加・変更</td>
                                <td class="p-2 border text-center text-red-500 font-bold"><i class="fa-solid fa-circle-xmark"></i> 閲覧のみ</td>
                                <td class="p-2 border text-center text-green-600"><i class="fa-solid fa-circle-check"></i> 可能</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- 2. ダッシュボード -->
            <div id="hq-dashboard-guide" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">2.</span>本部ダッシュボードの使い方</h4>
                <div class="space-y-3 text-sm text-gray-600 leading-relaxed">
                    <p>ログイン後に表示される本部管理者用コントロールパネルです。ここでは以下の情報が確認できます。</p>
                    <ul class="list-disc pl-5 space-y-2">
                        <li><strong>登録店舗一覧:</strong> 傘下の全店舗の名前、契約ID、契約中のプラン（Standard/Proなど）、登録スタッフ数、および稼働状態が一覧で表示されます。</li>
                        <li><strong>店舗へのアクセス:</strong> セキュリティ保護のため、一覧から店舗を直接クリックして入ることはできません。店舗に入るには次の「店舗へのアクセス手順」を実行してください。</li>
                    </ul>
                </div>
            </div>

            <!-- 3. 店舗へのアクセス手順 -->
            <div id="hq-shop-access" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">3.</span>店舗へのアクセス手順</h4>
                <div class="space-y-4">
                    <div class="bg-indigo-50 border border-indigo-100 rounded-xl p-4 text-sm text-indigo-900">
                        店舗の詳細情報やシフト表を確認するには、以下の手順で<strong>認証</strong>を行ってください。
                    </div>
                    <ol class="list-decimal pl-5 text-sm text-gray-600 space-y-3">
                        <li>本部ダッシュボードの<strong>「指定の店舗を閲覧」</strong>欄を確認します。</li>
                        <li>一覧表から、アクセスしたい店舗の<strong>契約ID（15桁）</strong>をコピーまたは入力します。</li>
                        <li>その店舗の<strong>管理者パスワード</strong>（または店舗用一般パスワード）を入力します。</li>
                        <li><strong>「閲覧する」</strong>ボタンをクリックします。</li>
                        <li>認証に成功すると、店舗側の管理画面に切り替わり、ヘッダーに「<i class="fa-solid fa-eye mr-1"></i>閲覧専用モード」と表示されます。</li>
                    </ol>
                </div>
            </div>

            <!-- 4. 閲覧専用モードでの制限操作 -->
            <div id="hq-view-mode" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">4.</span>閲覧専用モードでの制限操作</h4>
                <div class="space-y-3 text-sm text-gray-600 leading-relaxed">
                    <p>店舗に入った後は、店長アカウントと同等の表示情報を確認できますが、操作ボタンの大部分は非表示または無効化されます。</p>
                    <div class="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 text-xs">
                        ⚠️ <strong>ご注意:</strong> 本部閲覧中は、ボタン（「追加」「保存」「作成」「削除」など）は画面から自動的に非表示になります。もし編集が必要な場合は、自店舗の管理者が「店舗管理者ログイン」からアクセスして操作する必要があります。
                    </div>
                </div>
            </div>

            <!-- 5. FAQ -->
            <div id="hq-faq" class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                <h4 class="text-lg font-bold text-gray-800 border-b pb-2 mb-4"><span class="text-indigo-500 mr-2">5.</span>よくある質問 (FAQ)</h4>
                <div class="space-y-4">
                    <div class="space-y-1">
                        <p class="text-sm font-bold text-gray-800">Q. 店舗一覧から直接入れないのはなぜですか？</p>
                        <p class="text-sm text-gray-600">A. セキュリティおよび誤操作防止のため、各テナントの管理者パスワードを入力する追加認証を必須としています。これにより不正アクセスや意図しない店舗データの閲覧を防止しています。</p>
                    </div>
                    <hr class="border-gray-100">
                    <div class="space-y-1">
                        <p class="text-sm font-bold text-gray-800">Q. ログアウトするにはどうすればよいですか？</p>
                        <p class="text-sm text-gray-600">A. 画面ヘッダー右上の「ログアウト」ボタンをクリックしてください。即座にセッションがクリアされ、ログイン画面に戻ります。</p>
                    </div>
                    <hr class="border-gray-100">
                    <div class="space-y-1">
                        <p class="text-sm font-bold text-gray-800">Q. パスワードが一致しているのに店舗に入れません。</p>
                        <p class="text-sm text-gray-600">A. 契約IDが15桁正確に入力されているかご確認ください（スペースなどの余分な文字が含まれていないか注意してください）。</p>
                    </div>
                </div>
            </div>
        </div>
        `;
    },

    // --- その他 ---
    calculateMonthlyStats() {
        const year = this.state.currentDate.getFullYear();
        const month = this.state.currentDate.getMonth() + 1;
        const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
        let totalCost = 0, totalHours = 0;
        
        this.state.shifts.filter(s => s.date.startsWith(monthPrefix)).forEach(shift => {
            const staff = this.getStaff(shift.staff_id);
            if (!staff) return;
            const start = new Date(`${shift.date}T${shift.start_time}`);
            const end = new Date(`${shift.date}T${shift.end_time}`);
            if (end < start) end.setDate(end.getDate() + 1);
            const hours = (end - start) / (1000 * 60 * 60) - ((shift.break_minutes || 0) / 60);
            if (hours > 0) {
                totalHours += hours;
                if (staff.salary_type === 'hourly') {
                    let wage = staff.hourly_wage || this.state.config.hourly_wage_default;
                    if (JapaneseHolidays.isHoliday(shift.date)) wage *= 1.25;
                    totalCost += wage * hours;
                }
            }
        });
        this.state.staff.filter(s => s.salary_type === 'monthly').forEach(s => totalCost += (s.monthly_salary || 0));
        
        // 要素が存在する場合のみ表示を更新（スタッフ画面では要素がないためスキップされる）
        const costEl = document.getElementById('headerTotalCost');
        const hoursEl = document.getElementById('headerTotalHours');
        
        if(costEl) costEl.textContent = `¥${Math.floor(totalCost).toLocaleString()}`;
        if(hoursEl) hoursEl.textContent = `${Math.floor(totalHours)}h`;
    },

    // --- AI診断 (サーバーサイド経由) ---
    async runAIDiagnosis() {
        this.openModal('aiAdviceModal');
        const content = document.getElementById('aiAnalysisContent');
        content.innerHTML = `<div class="flex justify-center py-8"><div class="loading-spinner"></div><p class="ml-3 text-gray-500">AIがシフトを分析中...</p></div>`;

        try {
            const result = await API.diagnose({
                contract_id: this.state.config?.contract_id || API.session?.user?.contract_id,
                config: {
                    opening_time: this.state.config.opening_time,
                    closing_time: this.state.config.closing_time,
                    staff_req: this.state.config.staff_req
                },
                staff_count: this.state.staff.length,
                shift_count: this.state.shifts.length,
                shifts: this.state.shifts.map(s => ({
                    staff_id: s.staff_id,
                    date: s.date,
                    start_time: s.start_time,
                    end_time: s.end_time
                })),
                staff_list: this.state.staff.map(s => ({
                    id: s.id,
                    name: s.name,
                    role: s.role,
                    max_days_week: s.max_days_week,
                    max_hours_day: s.max_hours_day,
                    min_days_week: s.min_days_week,
                    min_days_month: s.min_days_month
                }))
            });

            if (!result || !Array.isArray(result)) throw new Error("AIからの応答がありません");

            content.innerHTML = result.map(s => {
                const typeStyles = {
                    danger: { border: 'border-red-300 bg-red-50', icon: '<i class="fa-solid fa-circle-exclamation text-red-600 text-xl"></i>' },
                    warning: { border: 'border-orange-200 bg-orange-50', icon: '<i class="fa-solid fa-triangle-exclamation text-orange-500 text-xl"></i>' },
                    info: { border: 'border-blue-200 bg-blue-50', icon: '<i class="fa-solid fa-lightbulb text-blue-500 text-xl"></i>' },
                };
                const style = typeStyles[s.type] || typeStyles.info;
                return `
                <div class="bg-white border ${style.border} rounded-lg p-4 flex gap-4">
                    <div class="mt-1">${style.icon}</div>
                    <div>
                        <h4 class="font-bold text-gray-800 mb-1">${this._sanitize(s.title || '')}</h4>
                        <p class="text-sm text-gray-600 mb-3">${this._sanitize(s.desc || '')}</p>
                        <p class="text-xs font-bold text-gray-500">${this._sanitize(s.action || '')}</p>
                    </div>
                </div>`;
            }).join('');

        } catch (e) {
            console.error(e);
            content.innerHTML = `<div class="text-red-500 p-4"><i class="fa-solid fa-circle-exclamation mr-2"></i>診断エラー: ${this._sanitize(e.message)}</div>`;
        }
    },
    
    applyAiFixes() { this.closeModal('aiAdviceModal'); this.showToast('修正案を適用しました', 'success'); },

    // --- Stripe決済 ---
    async startCheckout(plan) {
        const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast('ログインが必要です', 'error');
            return;
        }
        this.showLoading(true);
        try {
            const result = await API.createCheckout(contractId, plan);
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                this.showToast('チェックアウトURLの取得に失敗しました', 'error');
            }
        } catch (e) {
            console.error('Checkout Error:', e);
            this.showToast('決済エラー: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async openStripePortal() {
        const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast('ログインが必要です', 'error');
            return;
        }
        this.showLoading(true);
        try {
            const result = await API.createPortal(contractId);
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                this.showToast('ポータルURLの取得に失敗しました', 'error');
            }
        } catch (e) {
            console.error('Portal Error:', e);
            this.showToast('エラー: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    _markFieldError(id, show) {
        const el = document.getElementById(id);
        if (!el) return;
        if (show) {
            el.classList.add('border-red-500', 'ring-2', 'ring-red-200');
            el.classList.remove('border-gray-300');
        } else {
            el.classList.remove('border-red-500', 'ring-2', 'ring-red-200');
            el.classList.add('border-gray-300');
        }
    },

    // 「なし」相当の入力かどうか判定
    _isReferrerNone(code) {
        const normalized = (code || '').trim().toLowerCase();
        return ['なし', '無し', '無', 'none', 'nashi', 'no', 'n/a', 'na'].includes(normalized);
    },

    copyCompanyPhoneToContact() {
        const company = document.getElementById('newSubPhone')?.value.trim();
        if (!company) {
            this.showToast('代表電話番号を先に入力してください', 'error');
            return;
        }
        const target = document.getElementById('newSubContactPhone');
        if (target) {
            target.value = company;
            this._markFieldError('newSubContactPhone', false);
        }
    },

    async validateReferrerCode() {
        const raw = document.getElementById('newSubReferrerCode')?.value.trim();
        const status = document.getElementById('referrerCodeStatus');
        if (!raw) {
            status.innerHTML = '<span class="text-gray-400">コードを入力してください（紹介者がいない場合は「なし」）</span>';
            return;
        }
        // 「なし」系の入力
        if (this._isReferrerNone(raw)) {
            status.innerHTML = '<span class="text-blue-600"><i class="fa-solid fa-circle-info mr-1"></i>紹介者なしで登録します</span>';
            this._markFieldError('newSubReferrerCode', false);
            return;
        }
        const code = raw.toUpperCase();
        try {
            // 統一の API.rpc() 経由で呼ぶ (エラーハンドリング・リトライ機構の恩恵)
            const result = await API.rpc('validate_referrer_code', { p_code: code });
            if (result && result.valid) {
                status.innerHTML = `<span class="text-green-600"><i class="fa-solid fa-circle-check mr-1"></i>有効: ${this._sanitize(result.name)}</span>`;
                this._markFieldError('newSubReferrerCode', false);
            } else {
                status.innerHTML = `<span class="text-red-500"><i class="fa-solid fa-circle-xmark mr-1"></i>${this._sanitize(result.message || '無効なコードです')}（紹介者がいない場合は「なし」と入力）</span>`;
                this._markFieldError('newSubReferrerCode', true);
            }
        } catch (e) {
            status.innerHTML = '<span class="text-red-500">確認に失敗しました</span>';
        }
    },

    async startNewSubscription() {
        const orgName = document.getElementById('newSubOrgName')?.value.trim();
        const contact = document.getElementById('newSubContact')?.value.trim();
        const email = document.getElementById('newSubEmail')?.value.trim();
        const phone = document.getElementById('newSubPhone')?.value.trim();
        const contactPhone = document.getElementById('newSubContactPhone')?.value.trim();
        const address = document.getElementById('newSubAddress')?.value.trim();
        const referrerInput = document.getElementById('newSubReferrerCode')?.value.trim() || '';
        const plan = document.querySelector('input[name="newSubPlan"]:checked')?.value;

        // 全フィールドリセット
        ['newSubOrgName','newSubContact','newSubEmail','newSubPhone','newSubContactPhone','newSubAddress','newSubReferrerCode'].forEach(id => this._markFieldError(id, false));

        const errors = [];
        if (!orgName) { errors.push('事業者名'); this._markFieldError('newSubOrgName', true); }
        if (!contact) { errors.push('担当者名'); this._markFieldError('newSubContact', true); }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) { errors.push('メールアドレス'); this._markFieldError('newSubEmail', true); }
        const phoneRegex = /^[0-9\-\+]{10,15}$/;
        if (!phone || !phoneRegex.test(phone.replace(/[\s\(\)]/g, ''))) { errors.push('代表電話番号'); this._markFieldError('newSubPhone', true); }
        if (!contactPhone || !phoneRegex.test(contactPhone.replace(/[\s\(\)]/g, ''))) { errors.push('担当者電話番号'); this._markFieldError('newSubContactPhone', true); }
        if (!address || address.length < 5) { errors.push('住所'); this._markFieldError('newSubAddress', true); }
        if (!referrerInput) { errors.push('紹介者コード（不明な場合は「なし」と入力）'); this._markFieldError('newSubReferrerCode', true); }
        if (!plan) { errors.push('プラン'); }

        if (errors.length > 0) {
            this.showToast(`以下の項目を正しく入力してください: ${errors.join('、')}`, 'error');
            return;
        }

        // 紹介者コード処理
        let referrerCode = '';  // 「なし」の場合は空文字をDBに保存
        if (!this._isReferrerNone(referrerInput)) {
            referrerCode = referrerInput.toUpperCase();
            try {
                // 統一の API.rpc() 経由で呼ぶ
                const vresult = await API.rpc('validate_referrer_code', { p_code: referrerCode });
                if (!vresult || !vresult.valid) {
                    this._markFieldError('newSubReferrerCode', true);
                    this.showToast(`紹介者コード: ${this._sanitize(vresult?.message || '無効')}（紹介者がいない場合は「なし」と入力）`, 'error');
                    return;
                }
            } catch (e) {
                this.showToast('紹介者コードの検証に失敗しました', 'error');
                return;
            }
        }

        this.showLoading(true);
        try {
            const result = await API.createNewSubscription(email, orgName, plan, contact, phone, address, referrerCode, contactPhone);
            if (result && result.url) {
                window.location.href = result.url;
            } else {
                this.showToast('決済ページの作成に失敗しました', 'error');
            }
        } catch (e) {
            console.error('New Subscription Error:', e);
            this.showToast('エラー: ' + e.message, 'error');
        } finally {
            this.showLoading(false);
        }
    },

    async updateEmail() {
        const email = document.getElementById('settingEmail')?.value.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) {
            this.showToast('有効なメールアドレスを入力してください', 'error');
            return;
        }
        const contractId = this.state.config.contract_id || API.session?.user?.contract_id;
        if (!contractId) {
            this.showToast('ログインが必要です', 'error');
            return;
        }
        try {
            await API._request(`config?contract_id=eq.${contractId}`, {
                method: 'PATCH',
                body: JSON.stringify({ customer_email: email })
            });
            this.state.config.customer_email = email;
            this.showToast('メールアドレスを更新しました', 'success');
        } catch (e) {
            this.showToast('更新に失敗しました: ' + e.message, 'error');
        }
    },

    openPricingModal() {
        // 設定画面のサブスクリプションセクションまでスクロール
        const section = document.getElementById('subscriptionSection');
        if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'center' });
            section.classList.add('ring-2', 'ring-blue-400');
            setTimeout(() => section.classList.remove('ring-2', 'ring-blue-400'), 2000);
        }
    },
    
    showShopRules() {
        const config = this.state.config;
        const content = document.getElementById('shopRulesContent');
        const rulesText = config.shop_rules_text || this.state.defaultConfig.shop_rules_text;
        // 改行をリストアイテムに変換
        const rulesList = rulesText.split('\n').filter(line => line.trim() !== '').map(line => `<li>${line}</li>`).join('');
        
        // 金銭情報を完全に削除し、業務ルールのみを表示
        content.innerHTML = `
            <div class="space-y-4">
                <div class="bg-blue-50 p-4 rounded-xl border border-blue-100">
                    <h4 class="font-bold text-blue-800 text-sm mb-2"><i class="fa-regular fa-clock mr-2"></i>営業時間</h4>
                    <p class="text-2xl font-bold text-gray-800 text-center">${config.opening_time || '09:00'} <span class="text-sm text-gray-400 mx-2">〜</span> ${config.closing_time || '22:00'}</p>
                </div>
                
                <div class="bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <h4 class="font-bold text-gray-600 text-xs mb-1">最低勤務人数</h4>
                    <p class="text-lg font-bold text-gray-800">${config.staff_req?.min_weekday || 2}名</p>
                </div>

                <div class="border-t border-gray-100 pt-4">
                    <h4 class="font-bold text-gray-800 text-sm mb-2">シフト申請について・お知らせ</h4>
                    <ul class="text-sm text-gray-600 space-y-1 list-disc pl-5">
                        ${rulesList}
                    </ul>
                </div>
            </div>
        `;
        this.openModal('shopRulesModal');
    },

    getStaff(id) { return this.state.staff.find(s => s.id === id); },
    showLoading(show) { const el = document.getElementById('globalLoading'); if (show) el.classList.remove('hidden'); else el.classList.add('hidden'); },
    showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        let colorClass = type === 'success' ? 'border-green-200 text-green-600' : type === 'error' ? 'border-red-200 text-red-600' : 'border-gray-200 text-gray-600';
        let icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-circle-xmark' : 'fa-info-circle';
        toast.className = `flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border bg-white transform transition-all duration-300 translate-y-2 opacity-0 min-w-[300px] ${colorClass}`;
        const safeMsg = this._sanitize(message);
        toast.innerHTML = `<i class="fa-solid ${icon}"></i><span class="text-sm font-medium text-gray-700">${safeMsg}</span>`;
        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));
        setTimeout(() => { toast.classList.add('opacity-0', 'translate-x-full'); setTimeout(() => toast.remove(), 300); }, 3000);
    },
    showUpgradeModal() {
        const currentPlan = this.state.config.stripe_plan || 'standard';
        const limit = this.getStaffLimit();
        const currentCount = this.state.staff.length;
        const planNames = {standard: 'Standard', pro: 'Pro', premium: 'Premium'};

        // 現在プラン情報
        const infoEl = document.getElementById('upgradeCurrentInfo');
        if (infoEl) {
            infoEl.textContent = `現在: ${planNames[currentPlan] || 'Standard'}プラン（${currentCount}/${limit}名）`;
        }

        // アップグレード先プランカードを動的生成
        const plansEl = document.getElementById('upgradePlans');
        if (!plansEl) return;

        const plans = [
            { key: 'standard', name: 'Standard', price: '3,380', limit: 10, color: 'blue', features: ['スタッフ10名まで', 'AI自動シフト生成', 'AI労基法チェック', 'シフト管理全機能'] },
            { key: 'pro', name: 'Pro', price: '4,880', limit: 50, badge: '人気', color: 'green', features: ['スタッフ50名まで', '全AI機能', '優先サポート', '分析レポート'] },
            { key: 'premium', name: 'Premium', price: '9,980', limit: 9999, color: 'purple', features: ['スタッフ無制限', '全AI機能', '複数店舗対応', '専属サポート'] },
        ];

        // 現在より上のプランのみ表示
        const upgradePlans = plans.filter(p => p.limit > limit);

        const colorMap = {
            green:  { ring: 'ring-2 ring-green-400 border-green-400', text: 'text-green-600', check: 'text-green-500', badge: 'bg-green-500', btn: 'bg-green-600 hover:bg-green-700' },
            purple: { ring: 'ring-2 ring-purple-400 border-purple-400', text: 'text-purple-600', check: 'text-purple-500', badge: 'bg-purple-500', btn: 'bg-purple-600 hover:bg-purple-700' },
            blue:   { ring: 'ring-2 ring-blue-400 border-blue-400', text: 'text-blue-600', check: 'text-blue-500', badge: 'bg-blue-500', btn: 'bg-blue-600 hover:bg-blue-700' },
        };

        plansEl.innerHTML = upgradePlans.map((p, i) => {
            const isRecommended = i === 0;
            const c = colorMap[p.color];
            const ringClass = isRecommended ? c.ring : 'border-gray-200';
            const badgeHtml = p.badge ? `<span class="absolute -top-2 right-3 ${c.badge} text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow">${p.badge}</span>` : '';
            const recommendHtml = isRecommended ? '<span class="absolute -top-2 left-3 bg-orange-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow flex items-center gap-1"><i class="fa-solid fa-star text-[8px]"></i>おすすめ</span>' : '';

            return `
                <div class="relative border-2 ${ringClass} rounded-xl p-5 hover:shadow-lg transition-all cursor-pointer group" onclick="app.upgradeFromModal('${p.key}')">
                    ${recommendHtml}${badgeHtml}
                    <div class="text-center mb-3">
                        <p class="font-bold ${c.text} text-lg">${p.name}</p>
                        <p class="text-3xl font-extrabold text-gray-900 mt-1">${p.price}<span class="text-sm font-normal text-gray-400">円/月</span></p>
                    </div>
                    <ul class="text-xs text-gray-600 space-y-1.5 mb-4">
                        ${p.features.map(f => `<li class="flex items-center gap-1.5"><i class="fa-solid fa-check ${c.check} text-[10px]"></i>${f}</li>`).join('')}
                    </ul>
                    <button class="w-full py-2.5 ${c.btn} text-white rounded-lg text-sm font-bold transition group-hover:shadow-md">
                        <i class="fa-solid fa-rocket mr-1"></i>このプランに変更
                    </button>
                </div>
            `;
        }).join('');

        this.openModal('upgradeModal');
    },

    upgradeFromModal(plan) {
        this.closeModal('upgradeModal');
        this.startCheckout(plan);
    },

    openModal(id) {
        const el = document.getElementById(id);
        if(el) el.classList.add('active');
    },
    closeModal(id) {
        const el = document.getElementById(id);
        if(el) el.classList.remove('active');
    },

    // =========================================================
    // お知らせバッジ更新
    // =========================================================
    // お知らせ既読管理
    _getReadAnnouncementIds() {
        try {
            return JSON.parse(localStorage.getItem('rakushift_read_announcements') || '[]');
        } catch { return []; }
    },
    _markAnnouncementRead(id) {
        const readIds = this._getReadAnnouncementIds();
        if (!readIds.includes(id)) {
            readIds.push(id);
            localStorage.setItem('rakushift_read_announcements', JSON.stringify(readIds));
        }
    },
    _markAllAnnouncementsRead() {
        const allIds = (this._announcements || []).map(a => a.id).filter(Boolean);
        localStorage.setItem('rakushift_read_announcements', JSON.stringify(allIds));
    },
    _filterUnreadAnnouncements(announcements) {
        const readIds = this._getReadAnnouncementIds();
        return (announcements || []).filter(a => !readIds.includes(a.id));
    },

    async updateAnnouncementBadge() {
        const badge = document.getElementById('announcementCountBadge');
        if (!badge) return;
        try {
            const announcements = await API.rpc('list_active_announcements');
            const unread = this._filterUnreadAnnouncements(announcements);
            if (!unread || unread.length === 0) {
                badge.classList.add('hidden');
                badge.textContent = '0';
                return;
            }
            const count = unread.length;
            const circledNums = ['⓪','①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
            badge.textContent = count <= 10 ? circledNums[count] : count.toString();
            badge.classList.remove('hidden');
        } catch (e) {
            badge.classList.add('hidden');
        }
    },

    // =========================================================
    // お知らせ管理ビュー (管理者用)
    // =========================================================
    renderAnnouncementsAdmin(container) {
        if (!this.state.isAdmin) { this.changeView('dashboard'); return; }

        container.innerHTML = `
            <div class="max-w-4xl mx-auto space-y-6 pb-20">
                <div class="flex items-center justify-between">
                    <div>
                        <h2 class="text-2xl font-bold text-gray-800">お知らせ管理</h2>
                        <p class="text-sm text-gray-500 mt-1">運営からのお知らせを確認できます</p>
                    </div>
                    <button onclick="app.refreshAnnouncementsAdmin()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-2 px-4 rounded-lg transition flex items-center gap-2">
                        <i class="fa-solid fa-arrows-rotate"></i> 更新
                    </button>
                </div>
                <div id="announcementsAdminList">
                    <div class="text-center py-12 text-gray-400">
                        <div class="loading-spinner mb-4 mx-auto"></div>
                        <p>読み込み中...</p>
                    </div>
                </div>
            </div>
        `;

        this._loadAnnouncementsAdmin();
    },

    async _loadAnnouncementsAdmin() {
        const listEl = document.getElementById('announcementsAdminList');
        if (!listEl) return;
        try {
            const allAnnouncements = await API.rpc('list_active_announcements');
            const readIds = this._getReadAnnouncementIds();
            const announcements = (allAnnouncements || []);

            if (!announcements || !Array.isArray(announcements) || announcements.length === 0) {
                listEl.innerHTML = `
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
                        <i class="fa-solid fa-bell-slash text-4xl text-gray-300 mb-4"></i>
                        <p class="text-gray-500 font-bold">お知らせはありません</p>
                        <p class="text-xs text-gray-400 mt-2">現在、配信されているお知らせはありません</p>
                    </div>
                `;
                return;
            }

            const typeIcons = { info: 'fa-circle-info', warning: 'fa-triangle-exclamation', promotion: 'fa-gift', update: 'fa-rocket' };
            const typeColors = { info: 'text-blue-500 bg-blue-50', warning: 'text-amber-500 bg-amber-50', promotion: 'text-emerald-500 bg-emerald-50', update: 'text-purple-500 bg-purple-50' };
            const typeLabels = { info: 'お知らせ', warning: '注意', promotion: 'キャンペーン', update: 'アップデート' };

            const unreadCount = announcements.filter(a => !readIds.includes(a.id)).length;

            listEl.innerHTML = `
                ${unreadCount > 0 ? `
                <div class="flex justify-end mb-3">
                    <button onclick="app.markAllAnnouncementsRead()" class="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-bold transition flex items-center gap-2">
                        <i class="fa-solid fa-check-double"></i> 全て既読にする
                    </button>
                </div>` : ''}
                <div class="space-y-4">
                    ${announcements.map((item, idx) => {
                        const isRead = readIds.includes(item.id);
                        return `
                        <div class="bg-white rounded-xl shadow-sm border ${isRead ? 'border-gray-100 opacity-60' : 'border-gray-200'} overflow-hidden hover:shadow-md transition-shadow ${isRead ? 'relative' : ''}">
                            ${isRead ? '<div class="absolute top-3 right-3"><span class="text-[10px] font-bold text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">既読</span></div>' : ''}
                            <div class="p-5">
                                <div class="flex items-start gap-4">
                                    <div class="w-10 h-10 rounded-xl ${typeColors[item.type] || typeColors.info} flex items-center justify-center shrink-0">
                                        <i class="fa-solid ${typeIcons[item.type] || typeIcons.info} text-lg"></i>
                                    </div>
                                    <div class="flex-1 min-w-0">
                                        <div class="flex items-center gap-2 mb-1">
                                            <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${typeColors[item.type] || typeColors.info}">
                                                ${typeLabels[item.type] || 'お知らせ'}
                                            </span>
                                            ${item.created_at ? `<span class="text-xs text-gray-400">${new Date(item.created_at).toLocaleDateString('ja-JP')}</span>` : ''}
                                        </div>
                                        <h3 class="font-bold text-gray-800 text-lg">${this._sanitize(item.title)}</h3>
                                        <p class="text-sm text-gray-600 mt-2 whitespace-pre-line leading-relaxed">${this._sanitize(item.content)}</p>
                                        <div class="flex items-center gap-3 mt-3">
                                            ${item.target_url ? `
                                                <a href="${item.target_url}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-sm font-bold text-blue-600 hover:text-blue-700 transition">
                                                    <i class="fa-solid fa-arrow-up-right-from-square text-xs"></i>
                                                    ${this._sanitize(item.button_text || '詳しく見る')}
                                                </a>
                                            ` : ''}
                                            ${!isRead ? `
                                                <button onclick="app.dismissAnnouncement('${item.id}')" class="inline-flex items-center gap-1 text-sm font-bold text-gray-500 hover:text-gray-700 transition">
                                                    <i class="fa-solid fa-eye-slash text-xs"></i> 既読にする
                                                </button>
                                            ` : ''}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `}).join('')}
                </div>
            `;
        } catch (e) {
            listEl.innerHTML = `
                <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
                    <i class="fa-solid fa-exclamation-triangle text-4xl text-amber-400 mb-4"></i>
                    <p class="text-gray-600 font-bold">お知らせの取得に失敗しました</p>
                    <p class="text-xs text-gray-400 mt-2">${this._sanitize(e.message || '')}</p>
                    <button onclick="app._loadAnnouncementsAdmin()" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition">再試行</button>
                </div>
            `;
        }
    },

    async refreshAnnouncementsAdmin() {
        this._loadAnnouncementsAdmin();
        this.updateAnnouncementBadge();
        this.showToast('お知らせを更新しました', 'success');
    },

    // 個別のお知らせを既読にする
    dismissAnnouncement(id) {
        this._markAnnouncementRead(id);
        this._loadAnnouncementsAdmin();
        this.updateAnnouncementBadge();
        this.showToast('既読にしました', 'info');
    },

    // 全てのお知らせを既読にする
    markAllAnnouncementsRead() {
        this._markAllAnnouncementsRead();
        this._loadAnnouncementsAdmin();
        this.updateAnnouncementBadge();
        this.showToast('全てのお知らせを既読にしました', 'success');
    },

    // =========================================================
    // お知らせポップアップ機能
    // =========================================================
    _announcements: [],
    _announcementIndex: 0,

    /**
     * ログイン成功後にお知らせを取得してポップアップ表示
     */
    async showAnnouncementsAfterLogin() {
        try {
            const announcements = await API.rpc('list_active_announcements');
            if (!announcements || !Array.isArray(announcements) || announcements.length === 0) {
                return; // お知らせなし
            }
            this._announcements = announcements;
            this._announcementIndex = 0;
            // 少し遅延させてからポップアップ表示（ログイントーストと被らないように）
            setTimeout(() => this._renderAnnouncement(), 1500);
        } catch (e) {
            console.warn('[Announcements] Load failed:', e.message);
        }
    },

    /**
     * 現在のお知らせをモーダルに描画
     */
    _renderAnnouncement() {
        const list = this._announcements;
        const idx = this._announcementIndex;
        if (!list || idx >= list.length) return;

        const item = list[idx];
        const typeIcons = {
            info: 'fa-circle-info',
            warning: 'fa-triangle-exclamation',
            promotion: 'fa-gift',
            update: 'fa-rocket'
        };
        const typeColors = {
            info: 'from-blue-600 via-indigo-600 to-purple-600',
            warning: 'from-amber-500 via-orange-500 to-red-500',
            promotion: 'from-emerald-500 via-teal-500 to-cyan-500',
            update: 'from-violet-600 via-purple-600 to-fuchsia-600'
        };

        // ヘッダー色変更
        const headerEl = document.querySelector('#announcementModal .modal-content > div:first-child');
        if (headerEl) {
            headerEl.className = `relative bg-gradient-to-r ${typeColors[item.type] || typeColors.info} text-white p-6`;
        }

        // タイトル
        document.getElementById('announcementTitle').textContent = item.title;

        // 本文 (改行をbrに変換)
        const bodyEl = document.getElementById('announcementBody');
        bodyEl.innerHTML = item.content.split('\n').map(line => `<p>${this._sanitize(line)}</p>`).join('');

        // アクションボタン
        const actionEl = document.getElementById('announcementAction');
        if (item.target_url && /^https?:\/\//i.test(item.target_url)) {
            actionEl.classList.remove('hidden');
            document.getElementById('announcementLink').href = item.target_url;
            document.getElementById('announcementBtnText').textContent = item.button_text || '詳しく見る';
        } else {
            actionEl.classList.add('hidden');
        }

        // カウンター
        document.getElementById('announcementCounter').textContent = `${idx + 1} / ${list.length}`;

        // ナビゲーションボタン
        const prevBtn = document.getElementById('announcementPrev');
        const nextBtn = document.getElementById('announcementNext');
        if (list.length > 1) {
            prevBtn.classList.toggle('hidden', idx === 0);
            nextBtn.classList.toggle('hidden', idx === list.length - 1);
        } else {
            prevBtn.classList.add('hidden');
            nextBtn.classList.add('hidden');
        }

        this.openModal('announcementModal');
    },

    prevAnnouncement() {
        if (this._announcementIndex > 0) {
            this._announcementIndex--;
            this._renderAnnouncement();
        }
    },

    nextAnnouncement() {
        if (this._announcementIndex < this._announcements.length - 1) {
            this._announcementIndex++;
            this._renderAnnouncement();
        }
    },

    closeAnnouncementModal() {
        // 表示したお知らせを全て既読にする
        if (this._announcements && this._announcements.length > 0) {
            for (const item of this._announcements) {
                if (item.id) this._markAnnouncementRead(item.id);
            }
            this.updateAnnouncementBadge();
        }
        this.closeModal('announcementModal');
        // ページ訪問時のお知らせの場合、閉じた後にログインモーダルを表示
        if (this._showLoginAfterAnnouncement) {
            this._showLoginAfterAnnouncement = false;
            setTimeout(() => this.openModal('loginModal'), 300);
        }
    },

    /**
     * ページ訪問時（ログイン前）にお知らせを表示
     * @returns {boolean} お知らせがあった場合true
     */
    async showAnnouncementsOnPageLoad() {
        try {
            const announcements = await API.rpc('list_active_announcements');
            if (!announcements || !Array.isArray(announcements) || announcements.length === 0) {
                return false;
            }
            this._announcements = announcements;
            this._announcementIndex = 0;
            this._showLoginAfterAnnouncement = true;
            setTimeout(() => this._renderAnnouncement(), 500);
            return true;
        } catch (e) {
            console.warn('[Announcements] Page load fetch failed:', e.message);
            return false;
        }
    },

    // ===========================================================
    // シフト生成プレビュー機能
    // ===========================================================

    // プレビュー用の一時データ
    _previewShifts: null,
    _previewTargetType: null,
    _previewDates: null,

    /**
     * プレビューモーダルを表示
     * @param {Array} shifts - 生成されたシフト配列
     * @param {string} targetType - 'reset_all' | 'empty_only'
     * @param {Array} dates - 対象日付配列
     */
    showShiftPreview(shifts, targetType, dates, report) {
        this._previewShifts = shifts;
        this._previewTargetType = targetType;
        this._previewDates = dates;
        this._previewReport = report || null;

        // サマリー統計
        const totalShifts = shifts.length;
        const uniqueDates = [...new Set(shifts.map(s => s.date))].sort();
        const uniqueStaff = [...new Set(shifts.map(s => s.staff_id))];
        const totalHours = shifts.reduce((sum, s) => {
            const startParts = s.start_time.split(':');
            const endParts = s.end_time.split(':');
            let startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
            let endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
            if (endMin <= startMin) endMin += 1440;
            return sum + (endMin - startMin) / 60;
        }, 0);

        const summaryEl = document.getElementById('previewSummary');
        if (summaryEl) {
            summaryEl.innerHTML = `
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-emerald-600">${totalShifts}</p>
                    <p class="text-xs text-gray-500 mt-1">生成シフト数</p>
                </div>
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-blue-600">${uniqueDates.length}</p>
                    <p class="text-xs text-gray-500 mt-1">対象日数</p>
                </div>
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-purple-600">${uniqueStaff.length}</p>
                    <p class="text-xs text-gray-500 mt-1">配置スタッフ数</p>
                </div>
                <div class="bg-white rounded-lg p-3 border border-gray-200 text-center">
                    <p class="text-2xl font-bold text-orange-600">${totalHours.toFixed(1)}</p>
                    <p class="text-xs text-gray-500 mt-1">合計労働時間</p>
                </div>
            `;
        }

        // ⚠️ 制約違反レポート (report があれば表示)
        if (this._previewReport) {
            const r = this._previewReport;
            const ot = (r.overtime_warnings || []).slice(0, 10);
            const cg = r.coverage_gaps || [];
            const oc = r.open_close_gaps || [];
            const mg = r.manager_gaps || [];
            const hasAny = ot.length || cg.length || oc.length || mg.length;
            let warnHtml = '';
            if (hasAny) {
                warnHtml = `<div class="mt-4 mb-2 bg-amber-50 border border-amber-300 rounded-lg p-4">
                    <div class="flex items-center justify-between mb-2">
                        <div class="text-sm font-bold text-amber-800"><i class="fa-solid fa-triangle-exclamation mr-1"></i>制約違反・警告レポート</div>
                        <div class="text-xs text-gray-500">Tier ${r.tier || '?'} / ${r.mode || '?'} モード</div>
                    </div>`;
                if (cg.length) {
                    warnHtml += `<div class="mb-2"><div class="text-xs font-bold text-amber-700 mb-1">🟧 スタッフ不足: ${cg.length}件</div><div class="text-xs text-gray-700 max-h-32 overflow-y-auto bg-white rounded p-2 border border-amber-100">${
                        cg.slice(0, 20).map(g => `<div>・${g.date} ${g.time}: 必要 ${g.required}名 / <span class="text-red-600 font-bold">${g.shortage}名不足</span></div>`).join('')
                    }${cg.length > 20 ? `<div class="text-gray-400 mt-1">... 他 ${cg.length - 20} 件</div>` : ''}</div></div>`;
                }
                if (oc.length) {
                    warnHtml += `<div class="mb-2"><div class="text-xs font-bold text-red-700 mb-1">🟥 開け締めに社員不在: ${oc.length}件</div><div class="text-xs text-gray-700 max-h-24 overflow-y-auto bg-white rounded p-2 border border-amber-100">${
                        oc.slice(0, 15).map(g => `<div>・${g.date} ${g.time}: 月給/管理者ロールのスタッフが不在</div>`).join('')
                    }${oc.length > 15 ? `<div class="text-gray-400 mt-1">... 他 ${oc.length - 15} 件</div>` : ''}</div></div>`;
                }
                if (mg.length) {
                    warnHtml += `<div class="mb-2"><div class="text-xs font-bold text-amber-700 mb-1">🟨 管理者不足: ${mg.length}件</div><div class="text-xs text-gray-700 max-h-24 overflow-y-auto bg-white rounded p-2 border border-amber-100">${
                        mg.slice(0, 15).map(g => `<div>・${g.date} ${g.time}: 必要 ${g.required}名 / ${g.shortage}名不足</div>`).join('')
                    }${mg.length > 15 ? `<div class="text-gray-400 mt-1">... 他 ${mg.length - 15} 件</div>` : ''}</div></div>`;
                }
                if (ot.length) {
                    warnHtml += `<div class="mb-1"><div class="text-xs font-bold text-amber-700 mb-1">⏰ 時間超過: ${ot.length}件</div><div class="text-xs text-gray-700 bg-white rounded p-2 border border-amber-100">${
                        ot.map(w => `<div>・${this._sanitize(w)}</div>`).join('')
                    }</div></div>`;
                }
                warnHtml += `<div class="text-[11px] text-amber-700 mt-2"><i class="fa-solid fa-circle-info mr-1"></i>これらは制約緩和で「強行生成」された場合のみ発生します。スタッフ追加や勤務条件見直しで解消可能。</div>`;
                warnHtml += `</div>`;
            } else {
                warnHtml = `<div class="mt-4 mb-2 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2"><i class="fa-solid fa-circle-check text-emerald-600"></i><span class="text-sm font-bold text-emerald-700">制約違反なし: 全条件を満たした最適配置です</span></div>`;
            }
            const summaryParent = document.getElementById('previewSummary');
            if (summaryParent) {
                // summaryEl の直後に挿入
                const existing = document.getElementById('previewReportSection');
                if (existing) existing.remove();
                const wrapper = document.createElement('div');
                wrapper.id = 'previewReportSection';
                wrapper.innerHTML = warnHtml;
                summaryParent.parentNode.insertBefore(wrapper, summaryParent.nextSibling);
            }
        }

        // 日付ごとのテーブル生成
        const contentEl = document.getElementById('previewContent');
        if (contentEl) {
            let html = '';
            const staffMap = {};
            (this.state.staff || []).forEach(s => { staffMap[s.id] = s; });

            for (const dateStr of uniqueDates) {
                const dayShifts = shifts.filter(s => s.date === dateStr);
                const dt = new Date(dateStr + 'T00:00:00');
                const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
                const dow = dayNames[dt.getDay()];
                const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;

                html += `
                    <div class="mb-4">
                        <h4 class="text-sm font-bold ${isWeekend ? 'text-red-600' : 'text-gray-700'} mb-2 flex items-center gap-2">
                            <span class="w-6 h-6 rounded-full ${isWeekend ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-600'} flex items-center justify-center text-xs font-bold">${dow}</span>
                            ${dateStr}
                            <span class="text-xs text-gray-400 font-normal">(${dayShifts.length}名配置)</span>
                        </h4>
                        <div class="overflow-x-auto">
                            <table class="w-full text-sm">
                                <thead class="bg-gray-50 text-xs text-gray-500">
                                    <tr>
                                        <th class="px-3 py-2 text-left rounded-l-lg">スタッフ</th>
                                        <th class="px-3 py-2 text-left">役職</th>
                                        <th class="px-3 py-2 text-center">出勤</th>
                                        <th class="px-3 py-2 text-center">退勤</th>
                                        <th class="px-3 py-2 text-center">休憩</th>
                                        <th class="px-3 py-2 text-center">実働</th>
                                        <th class="px-3 py-2 text-left rounded-r-lg">配置理由</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-gray-100">
                `;

                for (const shift of dayShifts) {
                    const staff = staffMap[shift.staff_id] || { name: shift.staff_id, role: '' };
                    const roleList = this.state.config.roles || this.state.defaultConfig.roles || [];
                    const roleObj = roleList.find(r => r.id === staff.role) || { name: 'スタッフ', color: 'gray' };
                    const colorMap = {
                        purple: 'bg-purple-100 text-purple-700',
                        blue: 'bg-blue-100 text-blue-700',
                        green: 'bg-green-100 text-green-700',
                        yellow: 'bg-yellow-100 text-yellow-700',
                        red: 'bg-red-100 text-red-700',
                        gray: 'bg-gray-100 text-gray-700'
                    };
                    const badgeClass = colorMap[roleObj.color] || colorMap['gray'];
                    const roleBadge = `<span class="inline-block ${badgeClass} text-xs px-2 py-0.5 rounded-full font-bold">${this._sanitize(roleObj.name)}</span>`;
                    const breakMin = shift.break_minutes || 0;
                    const startParts = shift.start_time.split(':');
                    const endParts = shift.end_time.split(':');
                    let startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
                    let endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
                    if (endMin <= startMin) endMin += 1440;
                    const workHours = ((endMin - startMin) - breakMin) / 60;

                    const reasonText = shift.reason || '通常配置';
                    // 理由ごとに色分け (一覧性UP)
                    const reasonColor = reasonText.includes('既存')   ? 'bg-gray-100 text-gray-700' :
                                        reasonText.includes('承認済') ? 'bg-emerald-100 text-emerald-700' :
                                        reasonText.includes('完全一致')? 'bg-blue-100 text-blue-700' :
                                        reasonText.includes('希望')    ? 'bg-sky-100 text-sky-700' :
                                        reasonText.includes('優先度')  ? 'bg-amber-100 text-amber-700' :
                                        reasonText.includes('メンター')? 'bg-purple-100 text-purple-700' :
                                        reasonText.includes('月給')    ? 'bg-pink-100 text-pink-700' :
                                        reasonText.includes('レギュラ')? 'bg-indigo-100 text-indigo-700' :
                                        reasonText.includes('高評価')  ? 'bg-yellow-100 text-yellow-700' :
                                                                          'bg-slate-100 text-slate-600';
                    html += `
                        <tr class="hover:bg-gray-50">
                            <td class="px-3 py-2 font-bold text-gray-800">${this._sanitize(staff.name || '不明')}</td>
                            <td class="px-3 py-2">${roleBadge}</td>
                            <td class="px-3 py-2 text-center font-mono text-emerald-600 font-bold">${shift.start_time}</td>
                            <td class="px-3 py-2 text-center font-mono text-red-500 font-bold">${shift.end_time}</td>
                            <td class="px-3 py-2 text-center text-gray-500">${breakMin}分</td>
                            <td class="px-3 py-2 text-center font-bold">${workHours.toFixed(1)}h</td>
                            <td class="px-3 py-2"><span class="inline-block ${reasonColor} text-[11px] px-2 py-0.5 rounded-full font-bold">${this._sanitize(reasonText)}</span></td>
                        </tr>
                    `;
                }

                html += `
                                </tbody>
                            </table>
                        </div>
                    </div>
                `;
            }

            contentEl.innerHTML = html;
        }

        this.openModal('shiftPreviewModal');
    },

    /**
     * プレビューを承認してDB保存を実行
     */
    async confirmShiftPreview() {
        if (!this._previewShifts || this._previewShifts.length === 0) {
            this.showToast('保存するシフトがありません', 'error');
            return;
        }

        this.closeModal('shiftPreviewModal');

        // ローディング表示
        const loadingEl = document.getElementById('globalLoading');
        const loadingDefault = document.getElementById('loadingDefault');
        if (loadingDefault) loadingDefault.style.display = 'flex';
        if (loadingEl) loadingEl.classList.remove('hidden');

        try {
            const dates = this._previewDates;
            const targetType = this._previewTargetType;

            // reset_allの場合は既存削除
            if (targetType === 'reset_all') {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                const shiftsToDelete = this.state.shifts.filter(function(s) {
                    return dates.includes(s.date) && new Date(s.date) >= today && s.id && uuidRegex.test(s.id);
                });
                if (shiftsToDelete.length > 0) {
                    await Promise.all(shiftsToDelete.map(function(s) { return API.delete('shifts', s.id); }));
                }
                this.state.shifts = this.state.shifts.filter(function(s) {
                    return !(dates.includes(s.date) && new Date(s.date) >= today);
                });
            }

            // DB保存
            const existing = this.state.shifts.filter(s => dates.includes(s.date));
            const finalShifts = [];
            for (const s of this._previewShifts) {
                if (targetType === 'empty_only') {
                    const exists = existing.find(ex => ex.date === s.date && ex.staff_id === s.staff_id);
                    if (exists) continue;
                }
                finalShifts.push(s);
            }

            if (finalShifts.length > 0) {
                await this.saveAllShifts(finalShifts);
            }

            if (targetType === 'reset_all') {
                this.state.shifts = this.state.shifts.filter(s => !dates.includes(s.date));
            }

            await this.loadData();
            this.renderCurrentView();
            this.calculateMonthlyStats();

            // バックグラウンドAI診断
            try {
                await API.diagnose({
                    contract_id: this.state.config?.contract_id || API.session?.user?.contract_id,
                    config: { opening_time: this.state.config.opening_time, closing_time: this.state.config.closing_time, staff_req: this.state.config.staff_req },
                    staff_count: this.state.staff.length,
                    shift_count: this.state.shifts.length,
                    shifts: this.state.shifts.map(s => ({ staff_id: s.staff_id, date: s.date, start_time: s.start_time, end_time: s.end_time })),
                    staff_list: this.state.staff.map(s => ({ id: s.id, name: s.name, role: s.role, max_days_week: s.max_days_week, max_hours_day: s.max_hours_day, min_days_week: s.min_days_week, min_days_month: s.min_days_month }))
                });
            } catch (diagErr) {
                console.error('Auto AI Diagnosis error:', diagErr);
            }

            this.showToast(`${finalShifts.length}件のシフトを保存しました`, 'success');
        } catch (e) {
            console.error('Preview Save Error:', e);
            this.showToast('シフトの保存に失敗しました: ' + e.message, 'error');
        } finally {
            if (loadingEl) loadingEl.classList.add('hidden');
            this._previewShifts = null;
            this._previewTargetType = null;
            this._previewDates = null;
        }
    },

    /**
     * プレビューをキャンセル（破棄）
     */
    cancelShiftPreview() {
        this._previewShifts = null;
        this._previewTargetType = null;
        this._previewDates = null;
        this.closeModal('shiftPreviewModal');
        this.showToast('シフト生成をキャンセルしました', 'info');
    },

    // ===========================================================
    // パスワード変更機能
    // ===========================================================

    /**
     * 店舗パスワードを変更
     */
    async changeShopPassword() {
        const currentPass = document.getElementById('currentPassword')?.value || '';
        const newPass = document.getElementById('newPassword')?.value || '';
        const confirmPass = document.getElementById('confirmPassword')?.value || '';

        if (!currentPass) {
            this.showToast('現在のパスワードを入力してください', 'error');
            return;
        }
        if (!newPass || newPass.length < 6) {
            this.showToast('新しいパスワードは6文字以上で入力してください', 'error');
            return;
        }
        if (newPass !== confirmPass) {
            this.showToast('新しいパスワードが一致しません', 'error');
            return;
        }

        try {
            const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
            if (!contractId) {
                this.showToast('セッションエラー: 再ログインしてください', 'error');
                return;
            }

            // 現在のパスワード確認 (verify_shop_login RPC)
            const verifyResult = await API.rpc('verify_shop_login', {
                p_contract_id: contractId,
                p_password: currentPass
            });

            // verify_shop_loginはJSONBを返すため、直接オブジェクトとして扱う
            // （ログイン時と同じ形式）
            if (!verifyResult || !verifyResult.success) {
                this.showToast('現在のパスワードが正しくありません', 'error');
                return;
            }

            // 新しいパスワードに更新 (update_shop_password RPC)
            await API.rpc('update_shop_password', {
                p_contract_id: contractId,
                p_new_password: newPass
            });

            this.closeModal('changePasswordModal');
            // フォームクリア
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('confirmPassword').value = '';

            this.showToast('パスワードが正常に変更されました', 'success');
        } catch (e) {
            console.error('Password change error:', e);
            this.showToast('パスワード変更に失敗しました: ' + e.message, 'error');
        }
    },

    // --- 管理者パスワード変更 (店舗管理者) ---
    openAdminPasswordChange() {
        // 簡易ダイアログ (現在/新規/確認)
        const cur = prompt('現在の管理者パスワードを入力してください\n(初期値: rakushift1234)', '');
        if (cur === null) return;
        const np1 = prompt('新しい管理者パスワード (6文字以上):', '');
        if (np1 === null) return;
        if (!np1 || np1.length < 6) { this.showToast('6文字以上で入力してください', 'error'); return; }
        const np2 = prompt('もう一度入力してください:', '');
        if (np1 !== np2) { this.showToast('新しいパスワードが一致しません', 'error'); return; }
        this._submitAdminPasswordChange(cur, np1);
    },

    async _submitAdminPasswordChange(oldPw, newPw) {
        const contractId = this.state.config?.contract_id || API.session?.user?.contract_id;
        if (!contractId) { this.showToast('セッションエラー: 再ログインしてください', 'error'); return; }
        try {
            const result = await API.rpc('update_admin_password_by_contract', {
                p_contract_id: contractId,
                p_old_password: oldPw,
                p_new_password: newPw,
            });
            if (result && result.success) {
                this.showToast('管理者パスワードを変更しました。次回管理者ログイン時から有効です。', 'success');
            } else {
                this.showToast(result?.message || '変更に失敗しました', 'error');
            }
        } catch (e) {
            console.error('Admin password change error:', e);
            this.showToast('変更に失敗しました', 'error');
        }
    },

    // --- 本部管理者パスワード変更 ---
    async openHQPasswordChange() {
        if (!this.state.isHQ) { this.showToast('本部としてログインしている必要があります', 'error'); return; }
        const loginId = (API.session?.user?.login_id) || prompt('本部ログインID:', 'hq_master');
        if (!loginId) return;
        const cur = prompt('現在の本部パスワード:', '');
        if (cur === null) return;
        const np1 = prompt('新しい本部パスワード (8文字以上):', '');
        if (!np1 || np1.length < 8) { this.showToast('8文字以上で入力してください', 'error'); return; }
        const np2 = prompt('もう一度入力してください:', '');
        if (np1 !== np2) { this.showToast('新しいパスワードが一致しません', 'error'); return; }

        try {
            const result = await API.rpc('update_hq_admin_password', {
                p_login_id: loginId,
                p_old_password: cur,
                p_new_password: np1,
            });
            if (result && result.success) {
                this.showToast('本部パスワードを変更しました。一度ログアウトされます。', 'success');
                setTimeout(() => this.logout(), 2000);
            } else {
                this.showToast(result?.message || '変更に失敗しました', 'error');
            }
        } catch (e) {
            console.error('HQ password change error:', e);
            this.showToast('変更に失敗しました', 'error');
        }
    },

    // ===========================================================
    // シフトパターンプリセット機能
    // ===========================================================

    SHIFT_PRESETS: {
        restaurant: {
            name: '飲食店向け',
            patterns: [
                { name: '早番', start: '09:00', end: '15:00' },
                { name: '中番', start: '12:00', end: '18:00' },
                { name: '遅番', start: '16:00', end: '22:00' },
                { name: '通し', start: '09:00', end: '22:00' },
                { name: 'ランチ', start: '10:00', end: '14:00' },
                { name: 'ディナー', start: '17:00', end: '22:00' },
            ]
        },
        office: {
            name: 'オフィス向け',
            patterns: [
                { name: '日勤', start: '09:00', end: '18:00' },
                { name: '早番', start: '08:00', end: '17:00' },
                { name: '遅番', start: '10:00', end: '19:00' },
                { name: '半日AM', start: '09:00', end: '13:00' },
                { name: '半日PM', start: '13:00', end: '18:00' },
            ]
        },
        retail: {
            name: '小売店向け',
            patterns: [
                { name: '早番', start: '09:00', end: '15:00' },
                { name: '遅番', start: '14:00', end: '21:00' },
                { name: '通し', start: '09:00', end: '21:00' },
                { name: '午前', start: '09:00', end: '13:00' },
                { name: '午後', start: '13:00', end: '17:00' },
                { name: '夕方', start: '17:00', end: '21:00' },
            ]
        },
        medical: {
            name: '医療・介護向け',
            patterns: [
                { name: '日勤', start: '08:30', end: '17:30' },
                { name: '早番', start: '07:00', end: '16:00' },
                { name: '遅番', start: '10:00', end: '19:00' },
                { name: '夜勤', start: '16:30', end: '09:00' },
                { name: '準夜勤', start: '16:30', end: '01:00' },
                { name: '半日', start: '08:30', end: '12:30' },
            ]
        }
    },

    /**
     * プリセットのシフトパターンを一括適用
     * @param {string} presetKey - 'restaurant' | 'office' | 'retail' | 'medical'
     */
    applyShiftPreset(presetKey) {
        const preset = this.SHIFT_PRESETS[presetKey];
        if (!preset) return;

        const existing = this.state.config.custom_shifts || [];
        if (existing.length > 0) {
            if (!confirm(`現在のシフトパターン(${existing.length}件)を上書きしますか？\n「${preset.name}」(${preset.patterns.length}パターン)に置き換えます。`)) {
                return;
            }
        }

        this.state.config.custom_shifts = preset.patterns.map(p => ({ ...p }));
        this.renderCurrentView();
        this.showToast(`「${preset.name}」プリセット(${preset.patterns.length}パターン)を適用しました`, 'success');
    }
};

document.addEventListener('DOMContentLoaded', () => { app.init(); });














