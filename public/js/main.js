// ================= AUTH HELPERS =================
const Auth = {
    setUser(user) {
        localStorage.setItem('mannieng_user', JSON.stringify(user));
    },
    getUser() {
        try {
            return JSON.parse(localStorage.getItem('mannieng_user'));
        } catch {
            return null;
        }
    },
    updateUser(partial) {
        const current = this.getUser() || {};
        this.setUser({ ...current, ...partial });
    },
    logout() {
        localStorage.removeItem('mannieng_user');
        window.location.href = '/';
    },
    requireAuth() {
        const user = this.getUser();
        if (!user || !user.id) {
            window.location.href = '/login';
            return null;
        }
        return user;
    }
};

// ================= POPUNDER (Adsterra) =================
const Popunder = {
    src: "https://pl31287847.profitableratecpmnetwork.com/45/6c/f2/456cf2a7c0671bb8bdb1924b6cee4621.js",

    fire() {
        if (sessionStorage.getItem('mannieng_popunder_fired')) return;
        sessionStorage.setItem('mannieng_popunder_fired', '1');

        try {
            const s = document.createElement('script');
            s.src = Popunder.src;
            s.async = true;
            s.referrerPolicy = 'no-referrer-when-downgrade';
            document.body.appendChild(s);
        } catch (e) {}
    }
};

// ================= STATE =================
const activeTimers = {};
let taskCache = [];
let pendingWithdrawal = null;
let withdrawAdInterval = null;
let cooldownInterval = null;

const activeVideos = {};

function saveActiveVideos() {
    try {
        sessionStorage.setItem('mannieng_active_videos', JSON.stringify(activeVideos));
    } catch {}
}

function loadActiveVideos() {
    try {
        const raw = sessionStorage.getItem('mannieng_active_videos');
        if (raw) Object.assign(activeVideos, JSON.parse(raw));
    } catch {}
}

// ================= VALIDATORS =================
function isValidEmail(str) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

function isValidPhone(str) {
    return /^(\+234|0)[789][01]\d{8}$/.test(str);
}

// ================= REGISTER =================
async function register(event) {
    event.preventDefault();

    const username = document.getElementById('username').value.trim();
    const identifier = document.getElementById('identifier').value.trim();
    const password = document.getElementById('password').value;

    const urlParams = new URLSearchParams(window.location.search);
    const ref = (urlParams.get('ref') || '').trim().toUpperCase() || null;

    if (username.length < 3) {
        return showMessage('registerMessage', 'Username must be at least 3 characters', 'error');
    }
    if (password.length < 6) {
        return showMessage('registerMessage', 'Password must be at least 6 characters', 'error');
    }
    if (!isValidEmail(identifier) && !isValidPhone(identifier)) {
        return showMessage('registerMessage', 'Enter a valid email address or Nigerian phone number', 'error');
    }

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, identifier, password, ref })
        });
        const data = await res.json();

        if (res.ok) {
            Auth.setUser(data.user);
            const msg = data.referralApplied
                ? `🎉 Welcome! You earned ₦${data.user.balance} signup bonus! Redirecting...`
                : 'Registration successful! Redirecting...';
            showMessage('registerMessage', msg, 'success');
            setTimeout(() => (window.location.href = '/dashboard'), 1500);
        } else {
            showMessage('registerMessage', data.error || 'Registration failed', 'error');
        }
    } catch {
        showMessage('registerMessage', 'Network error. Try again.', 'error');
    }
}

// ================= LOGIN =================
async function login(event) {
    event.preventDefault();

    const identifier = document.getElementById('identifier').value.trim();
    const password = document.getElementById('password').value;

    if (!identifier || !password) {
        return showMessage('loginMessage', 'Enter your phone/email and password', 'error');
    }

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, password })
        });
        const data = await res.json();

        if (res.ok) {
            Auth.setUser(data.user);
            showMessage('loginMessage', 'Login successful! Redirecting...', 'success');
            setTimeout(() => (window.location.href = '/dashboard'), 1200);
        } else {
            showMessage('loginMessage', data.error || 'Login failed', 'error');
        }
    } catch {
        showMessage('loginMessage', 'Network error. Try again.', 'error');
    }
}

// ================= DASHBOARD =================
async function loadDashboard() {
    const current = Auth.requireAuth();
    if (!current) return;

    try {
        const res = await fetch(`/api/user/${current.id}`);
        const user = await res.json();

        if (!res.ok) {
            Auth.logout();
            return;
        }

        Auth.setUser(user);

        const usernameEl = document.getElementById('username');
        const balanceEl = document.getElementById('balance');
        const tasksEl = document.getElementById('tasksCompleted');
        const referralEl = document.getElementById('referralCode');
        const pendingEl = document.getElementById('pendingBalance');
        const streakEl = document.getElementById('streakCount');

        if (usernameEl) usernameEl.textContent = user.username;
        if (balanceEl) balanceEl.textContent = `₦${(user.balance || 0).toLocaleString()}`;
        if (tasksEl) tasksEl.textContent = user.tasksCompleted || 0;
        if (referralEl) referralEl.textContent = user.referralCode || '-';
        if (pendingEl) pendingEl.textContent = `₦${(user.pendingBalance || 0).toLocaleString()}`;
        if (streakEl) streakEl.textContent = user.streakCount || 0;

        loadTasks();
        loadWithdrawalHistory();
        loadReferralWidget();
    } catch {
        Auth.logout();
    }
}

// ================= REFERRAL WIDGET =================
async function loadReferralWidget() {
    const container = document.getElementById('referralWidget');
    if (!container) return;

    const user = Auth.getUser();
    if (!user) return;

    try {
        const res = await fetch(`/api/referrals/${user.id}`);
        const data = await res.json();
        if (!res.ok) return;

        const shareMessage = encodeURIComponent(
            `Join MannieNG! Get ₦${data.bonusNewUser} signup bonus instantly. Sign up: ${data.referralLink}`
        );

        container.innerHTML = `
            <div class="referral-widget">
                <h3>Invite Friends, Earn ₦${data.bonusReferrer} Each</h3>
                <p class="referral-sub">Share your link. When they sign up, you get ₦${data.bonusReferrer} — they get ₦${data.bonusNewUser} instantly.</p>

                <div class="referral-link-box">
                    <input type="text" id="referralLinkInput" readonly value="${escapeAttr(data.referralLink)}">
                    <button onclick="copyReferralLink()" class="btn btn-primary">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                </div>

                <div class="referral-stats">
                    <div>
                        <span class="ref-stat-label">Referrals</span>
                        <span class="ref-stat-value">${data.referralCount}</span>
                    </div>
                    <div>
                        <span class="ref-stat-label">Earned</span>
                        <span class="ref-stat-value">₦${(data.referralEarnings || 0).toLocaleString()}</span>
                    </div>
                </div>

                <div class="referral-share">
                    <a href="https://wa.me/?text=${shareMessage}" target="_blank" rel="noopener" class="btn btn-outline">
                        <i class="fab fa-whatsapp"></i> Share on WhatsApp
                    </a>
                    <a href="https://twitter.com/intent/tweet?text=${shareMessage}" target="_blank" rel="noopener" class="btn btn-outline">
                        <i class="fab fa-twitter"></i> Tweet
                    </a>
                </div>

                ${data.referrals.length ? `
                    <h4 class="referral-list-title">Your Referrals</h4>
                    <div class="referral-list">
                        ${data.referrals.map(r => `
                            <div class="referral-item">
                                <span>${escapeHtml(r.username)}</span>
                                <span class="referral-status status-paid">✅ Earned ₦${r.earned}</span>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    } catch {
        container.innerHTML = '';
    }
}

function copyReferralLink() {
    const input = document.getElementById('referralLinkInput');
    if (!input) return;
    input.select();
    input.setSelectionRange(0, 99999);
    try {
        navigator.clipboard.writeText(input.value);
        const btn = input.nextElementSibling;
        if (!btn) return;
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
        setTimeout(() => (btn.innerHTML = original), 1500);
    } catch {}
}

// ================= TASKS =================
async function loadTasks() {
    const user = Auth.getUser();
    if (!user) return;

    Object.values(activeTimers).forEach(id => clearInterval(id));
    Object.keys(activeTimers).forEach(k => delete activeTimers[k]);

    try {
        const res = await fetch(`/api/tasks/${user.id}`);
        const data = await res.json();

        if (!res.ok) {
            document.getElementById('tasksContainer').innerHTML = '<p>Failed to load tasks.</p>';
            return;
        }

        const tasks = Array.isArray(data) ? data : (data.tasks || []);
        const cooldownRemaining = data.cooldownRemaining || 0;
        const cooldownTotal = data.cooldownTotal || 120;

        taskCache = tasks;
        renderCooldownBanner(cooldownRemaining, cooldownTotal);

        const container = document.getElementById('tasksContainer');
        container.innerHTML = '';

        if (!tasks.length) {
            container.innerHTML = '<p>No tasks available right now.</p>';
            return;
        }

        tasks.forEach(task => container.appendChild(renderTaskCard(task)));
        tasks.forEach(task => {
            if (task.status === 'started' && task.startedAt) {
                startTimer(task.id, task.startedAt, task.minSeconds || 0, task.verification);
            }
        });
    } catch {
        document.getElementById('tasksContainer').innerHTML = '<p>Failed to load tasks.</p>';
    }
}

function renderTaskCard(task) {
    const card = document.createElement('div');
    card.className = `task-card status-${task.status}`;

    let actionHtml = '';

    switch (task.status) {
        case 'completed': {
            let completionText = '✅ Completed';
            if (task.renewsOn) {
                const daysLeft = Math.max(0, Math.ceil((new Date(task.renewsOn) - Date.now()) / (1000 * 60 * 60 * 24)));
                if (daysLeft > 0) completionText = `✅ Completed · Renews in ${daysLeft}d`;
            }
            actionHtml = `<span class="task-completed">${completionText}</span>`;
            break;
        }

        case 'pending':
            actionHtml = `<span class="task-pending">⏳ Awaiting approval</span>`;
            break;

        case 'rejected':
            actionHtml = `
                <div class="task-rejected-note">${escapeHtml(task.adminNote || 'Proof insufficient')}</div>
                <button onclick="startTask(${task.id})" class="btn btn-outline">Retry</button>
            `;
            break;

        case 'started': {
            const activeVideo = activeVideos[task.id] || task.currentVideo;
            const videoHtml = (task.verification === 'video' && activeVideo)
                ? `<div class="task-video">
                       <iframe src="${escapeAttr(activeVideo.url)}" frameborder="0"
                               allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                               allowfullscreen></iframe>
                   </div>`
                : '';

            const isTimed = task.verification === 'timed' || task.verification === 'video';
            const disabledAttr = isTimed ? 'disabled' : '';

            actionHtml = `
                ${videoHtml}
                ${isTimed ? `
                    <div class="task-timer" id="timer-${task.id}">
                        <span class="timer-label">Time on task:</span>
                        <span class="timer-value" data-task-id="${task.id}">0s</span>
                    </div>
                ` : ''}
                <button id="completeBtn-${task.id}" onclick="completeTask(${task.id})" class="btn btn-success" ${disabledAttr}>
                    I'm Done
                </button>
            `;
            break;
        }

        default:
            actionHtml = `<button onclick="startTask(${task.id})" class="btn btn-primary">Start Task</button>`;
    }

    const proofBadge = task.verification === 'proof' || task.verification === 'admin'
        ? `<span class="badge badge-proof">Proof required</span>`
        : task.verification === 'timed'
            ? `<span class="badge badge-timed">⏱ ${task.minSeconds}s min</span>`
            : task.verification === 'video'
                ? `<span class="badge badge-video">▶ Video · ${task.minSeconds}s min</span>`
                : '';

    const adLink = task.link ? `/ad/${task.id}?url=${encodeURIComponent(task.link)}` : '';

    card.innerHTML = `
        <div class="task-header">
            <span class="task-title">${escapeHtml(task.title)}</span>
            <span class="task-reward">₦${task.reward}</span>
        </div>
        <div class="task-meta">
            <span class="task-category">${escapeHtml(task.category)}</span>
            ${proofBadge}
        </div>
        <p class="task-description">${escapeHtml(task.description)}</p>
        <small class="task-instructions">${escapeHtml(task.instructions)}</small>
        <div class="task-actions">
            ${adLink ? `<a href="${escapeAttr(adLink)}" target="_blank" rel="noopener" class="task-link">Open Task</a>` : ''}
            ${actionHtml}
        </div>
    `;

    return card;
}

// ================= COOLDOWN =================
function renderCooldownBanner(remaining, total) {
    const existing = document.getElementById('cooldownBanner');
    if (existing) existing.remove();

    if (cooldownInterval) {
        clearInterval(cooldownInterval);
        cooldownInterval = null;
    }

    if (!remaining || remaining <= 0) return;

    const tasksSection = document.querySelector('.tasks-section');
    if (!tasksSection) return;

    const banner = document.createElement('div');
    banner.id = 'cooldownBanner';
    banner.className = 'cooldown-banner';

    const heading = tasksSection.querySelector('h2');
    if (heading && heading.nextSibling) {
        tasksSection.insertBefore(banner, heading.nextSibling);
    } else {
        tasksSection.insertBefore(banner, tasksSection.firstChild);
    }

    let seconds = remaining;
    const render = () => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        banner.innerHTML = `
            <i class="fas fa-hourglass-half"></i>
            <div>
                <strong>Cooldown active</strong>
                <span>Next task unlocks in ${m}:${String(s).padStart(2, '0')}</span>
            </div>
        `;
    };

    render();

    cooldownInterval = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
            clearInterval(cooldownInterval);
            cooldownInterval = null;
            banner.remove();
            loadTasks();
        } else {
            render();
        }
    }, 1000);
}

// ================= START TASK =================
async function startTask(taskId) {
    const user = Auth.getUser();
    if (!user) return;

    Popunder.fire();

    try {
        const res = await fetch('/api/tasks/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.id, taskId })
        });
        const data = await res.json();

        if (res.ok) {
            if (data.video) {
                activeVideos[taskId] = data.video;
                saveActiveVideos();
            }
            loadTasks();
        } else if (res.status === 429 && data.cooldownRemaining) {
            renderCooldownBanner(data.cooldownRemaining, data.cooldownRemaining);
            loadTasks();
        } else {
            alert(data.error || 'Could not start task');
        }
    } catch {
        alert('Network error. Try again.');
    }
}

// ================= TIMER =================
function startTimer(taskId, startedAt, minSeconds, verification) {
    const valueEl = document.querySelector(`.timer-value[data-task-id="${taskId}"]`);
    const timerBox = document.getElementById(`timer-${taskId}`);
    const completeBtn = document.getElementById(`completeBtn-${taskId}`);
    if (!valueEl) return;

    const startMs = new Date(startedAt).getTime();
    if (isNaN(startMs)) return;

    const isTimed = verification === 'timed' || verification === 'video';

    const tick = () => {
        const elapsed = Math.floor((Date.now() - startMs) / 1000);
        valueEl.textContent = `${elapsed}s`;

        if (isTimed && elapsed >= minSeconds) {
            if (timerBox) timerBox.classList.add('timer-ready');
            valueEl.textContent = `✅ ${elapsed}s — ready`;
            if (completeBtn && completeBtn.disabled) completeBtn.disabled = false;
            clearInterval(activeTimers[taskId]);
            delete activeTimers[taskId];
        }
    };

    tick();
    activeTimers[taskId] = setInterval(tick, 1000);
}

// ================= COMPLETE TASK =================
async function completeTask(taskId) {
    const user = Auth.getUser();
    if (!user) return;

    const task = taskCache.find(t => t.id === taskId);
    if (!task) {
        alert('Task not found');
        return;
    }

    let proofUrl = null;
    let videoId = null;

    if (task.verification === 'proof' || task.verification === 'admin') {
        proofUrl = prompt(
            'Paste a link to your proof (screenshot URL, post URL, etc.):\n\n' +
            'Tip: upload your screenshot to imgur.com or drive.google.com and paste the link.'
        );
        if (!proofUrl || proofUrl.trim().length < 10) {
            alert('You must provide proof to submit this task.');
            return;
        }
        proofUrl = proofUrl.trim();
    }

    if (task.verification === 'video') {
        const v = activeVideos[taskId] || task.currentVideo;
        videoId = v && v.id ? v.id : null;
    }

    if (task.verification === 'timed' || task.verification === 'video') {
        if (!confirm('Confirm you have completed this task?')) return;
    }

    try {
        const res = await fetch('/api/tasks/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.id, taskId, proofUrl, videoId })
        });
        const data = await res.json();

        if (res.ok) {
            delete activeVideos[taskId];
            saveActiveVideos();

            if (data.pending) {
                alert(`⏳ Submitted for review.\n₦${data.reward} will be credited after approval.`);
            } else if (data.streakBonus) {
                alert(`🔥 STREAK BONUS! 🔥\n\nYou completed a ${data.streak.target}-day streak!\n\n+₦${data.reward} task reward\n+₦${data.streakBonus} streak bonus\n\nTotal: ₦${data.reward + data.streakBonus}`);
            } else {
                const streakMsg = data.streak ? `\n\n🔥 Streak: ${data.streak.count}/${data.streak.target} days` : '';
                alert(`✅ Task completed!\nYou earned ₦${data.reward}${streakMsg}\n\nNext task unlocks in 2 minutes.`);
            }
            loadDashboard();
        } else {
            alert(data.error || 'Failed to complete task');
        }
    } catch {
        alert('Network error. Try again.');
    }
}

// ================= WITHDRAW =================
async function withdraw(event) {
    event.preventDefault();
    const user = Auth.getUser();
    if (!user) return;

    const amount = parseInt(document.getElementById('withdrawAmount').value);
    const bankName = document.getElementById('bankName').value;
    const accountNumber = document.getElementById('accountNumber').value.trim();

    if (!amount || amount < 2500) return showMessage('withdrawMessage', 'Minimum transfer is ₦2,500', 'error');
    if (!bankName) return showMessage('withdrawMessage', 'Please select a bank', 'error');
    if (!/^\d{10}$/.test(accountNumber)) return showMessage('withdrawMessage', 'Account number must be 10 digits', 'error');

    pendingWithdrawal = { userId: user.id, amount, bankName, accountNumber };
    openWithdrawAdModal();
}

function openWithdrawAdModal() {
    const modal = document.getElementById('withdrawAdModal');
    if (!modal) return submitWithdrawal();

    Popunder.fire();

    const timerEl = document.getElementById('withdrawTimer');
    const confirmBtn = document.getElementById('confirmWithdrawBtn');
    const cancelBtn = document.getElementById('cancelWithdrawBtn');

    modal.classList.add('open');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirm Withdrawal';
    timerEl.classList.remove('timer-ready');

    fetch('/api/withdraw/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: Auth.getUser().id })
    }).catch(() => {});

    let remaining = 600;
    const format = (s) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    };
    timerEl.textContent = format(remaining);

    if (withdrawAdInterval) clearInterval(withdrawAdInterval);
    withdrawAdInterval = setInterval(() => {
        remaining--;
        timerEl.textContent = format(remaining);
        if (remaining <= 0) {
            clearInterval(withdrawAdInterval);
            withdrawAdInterval = null;
            timerEl.textContent = '✅ Unlocked';
            timerEl.classList.add('timer-ready');
            confirmBtn.disabled = false;
        }
    }, 1000);

    confirmBtn.onclick = () => submitWithdrawal();
    cancelBtn.onclick = () => {
        if (withdrawAdInterval) { clearInterval(withdrawAdInterval); withdrawAdInterval = null; }
        closeWithdrawAdModal();
        pendingWithdrawal = null;
    };
}

async function submitWithdrawal() {
    if (!pendingWithdrawal) return;
    const confirmBtn = document.getElementById('confirmWithdrawBtn');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Processing…'; }

    try {
        const res = await fetch('/api/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pendingWithdrawal)
        });
        const data = await res.json();
        closeWithdrawAdModal();

        if (res.ok) {
            showMessage('withdrawMessage', `✅ ₦${data.amount.toLocaleString()} transfer to ${data.bankName} (${data.accountNumber}) submitted!`, 'success');
            const form = document.getElementById('withdrawForm');
            if (form) form.reset();
            loadDashboard();
        } else {
            showMessage('withdrawMessage', data.error || 'Transfer failed', 'error');
        }
    } catch {
        closeWithdrawAdModal();
        showMessage('withdrawMessage', 'Network error. Try again.', 'error');
    } finally {
        if (confirmBtn) { confirmBtn.textContent = 'Confirm Withdrawal'; confirmBtn.disabled = true; }
        pendingWithdrawal = null;
    }
}

function closeWithdrawAdModal() {
    const modal = document.getElementById('withdrawAdModal');
    if (modal) modal.classList.remove('open');
    const timerEl = document.getElementById('withdrawTimer');
    if (timerEl) timerEl.classList.remove('timer-ready');
    if (withdrawAdInterval) { clearInterval(withdrawAdInterval); withdrawAdInterval = null; }
}

// ================= WITHDRAWAL HISTORY =================
async function loadWithdrawalHistory() {
    const container = document.getElementById('withdrawalHistory');
    if (!container) return;
    const user = Auth.getUser();
    if (!user) return;

    try {
        const res = await fetch(`/api/withdrawals/${user.id}`);
        const list = await res.json();

        if (!res.ok || !list.length) {
            container.innerHTML = '<p class="empty-state">No transfers yet.</p>';
            return;
        }

        container.innerHTML = list.map(w => `
            <div class="withdrawal-item">
                <div>
                    <strong>₦${w.amount.toLocaleString()}</strong>
                    <span class="withdrawal-bank">${escapeHtml(w.bankName)} · ${escapeHtml(w.accountNumber)}</span>
                </div>
                <span class="withdrawal-status status-${w.status}">${escapeHtml(w.status)}</span>
            </div>
        `).join('');
    } catch {
        container.innerHTML = '<p class="empty-state">Could not load history.</p>';
    }
}

// ================= UTILITIES =================
function showMessage(elementId, message, type) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = `message message-${type}`;
    el.style.display = 'block';
    setTimeout(() => (el.style.display = 'none'), 6000);
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    return escapeHtml(str);
}

// ================= INIT =================
document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname;
    const user = Auth.getUser();

    loadActiveVideos();

    if (user && (path === '/' || path === '/login' || path === '/register')) {
        window.location.href = '/dashboard';
        return;
    }

    const registerForm = document.getElementById('registerForm');
    if (registerForm) registerForm.addEventListener('submit', register);

    const loginForm = document.getElementById('loginForm');
    if (loginForm) loginForm.addEventListener('submit', login);

    const withdrawForm = document.getElementById('withdrawForm');
    if (withdrawForm) withdrawForm.addEventListener('submit', withdraw);

    if (path === '/dashboard') {
        loadDashboard();
    }
});