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

// Track active timers so we can clear them on reload
const activeTimers = {};

// Cache tasks so completeTask doesn't re-fetch
let taskCache = [];

// Pending withdrawal payload (set before ad modal opens)
let pendingWithdrawal = null;

// Withdraw ad interval handle
let withdrawAdInterval = null;

// ================= REGISTER =================
async function register(event) {
    event.preventDefault();

    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const password = document.getElementById('password').value;

    if (username.length < 3) {
        return showMessage('registerMessage', 'Username must be at least 3 characters', 'error');
    }

    if (password.length < 6) {
        return showMessage('registerMessage', 'Password must be at least 6 characters', 'error');
    }

    const phoneRegex = /^(\+234|0)[789][01]\d{8}$/;
    if (!phoneRegex.test(phone)) {
        return showMessage('registerMessage', 'Enter a valid Nigerian phone number (e.g. 08012345678)', 'error');
    }

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, phone, password })
        });
        const data = await res.json();

        if (res.ok) {
            Auth.setUser(data.user);
            showMessage('registerMessage', 'Registration successful! Redirecting...', 'success');
            setTimeout(() => (window.location.href = '/dashboard'), 1200);
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

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
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

        // Refresh LocalStorage with latest server data
        Auth.setUser(user);

        const usernameEl = document.getElementById('username');
        const balanceEl = document.getElementById('balance');
        const tasksEl = document.getElementById('tasksCompleted');
        const referralEl = document.getElementById('referralCode');
        const pendingEl = document.getElementById('pendingBalance');

        if (usernameEl) usernameEl.textContent = user.username;
        if (balanceEl) balanceEl.textContent = `₦${(user.balance || 0).toLocaleString()}`;
        if (tasksEl) tasksEl.textContent = user.tasksCompleted || 0;
        if (referralEl) referralEl.textContent = user.referralCode || '-';
        if (pendingEl) pendingEl.textContent = `₦${(user.pendingBalance || 0).toLocaleString()}`;

        loadTasks();
        loadWithdrawalHistory();
    } catch {
        Auth.logout();
    }
}

// ================= TASKS =================
async function loadTasks() {
    const user = Auth.getUser();
    if (!user) return;

    // Clear any existing timers before re-rendering
    Object.values(activeTimers).forEach(id => clearInterval(id));
    Object.keys(activeTimers).forEach(k => delete activeTimers[k]);

    try {
        const res = await fetch(`/api/tasks/${user.id}`);
        const tasks = await res.json();

        if (!res.ok) {
            document.getElementById('tasksContainer').innerHTML = '<p>Failed to load tasks.</p>';
            return;
        }

        taskCache = tasks; // keep fresh copy

        const container = document.getElementById('tasksContainer');
        container.innerHTML = '';

        if (!tasks.length) {
            container.innerHTML = '<p>No tasks available right now.</p>';
            return;
        }

        tasks.forEach(task => container.appendChild(renderTaskCard(task)));
    } catch {
        document.getElementById('tasksContainer').innerHTML = '<p>Failed to load tasks.</p>';
    }
}

function renderTaskCard(task) {
    const card = document.createElement('div');
    card.className = `task-card status-${task.status}`;

    let actionHtml = '';

    switch (task.status) {
        case 'completed':
            actionHtml = `<span class="task-completed">✅ Completed</span>`;
            break;

        case 'pending':
            actionHtml = `<span class="task-pending">⏳ Awaiting approval</span>`;
            break;

        case 'rejected':
            actionHtml = `
                <div class="task-rejected-note">${escapeHtml(task.adminNote || 'Proof insufficient')}</div>
                <button onclick="startTask(${task.id})" class="btn btn-outline">Retry</button>
            `;
            break;

        case 'started':
            actionHtml = `
                <div class="task-timer" id="timer-${task.id}">
                    <span class="timer-label">Time on task:</span>
                    <span class="timer-value" data-task-id="${task.id}">0s</span>
                </div>
                <button id="completeBtn-${task.id}"
                        onclick="completeTask(${task.id})"
                        class="btn btn-success"
                        ${task.verification === 'timed' ? 'disabled' : ''}>
                    I'm Done
                </button>
            `;
            break;

        default: // available
            actionHtml = `<button onclick="startTask(${task.id})" class="btn btn-primary">Start Task</button>`;
    }

    const proofBadge = task.verification === 'proof' || task.verification === 'admin'
        ? `<span class="badge badge-proof">Proof required</span>`
        : task.verification === 'timed'
            ? `<span class="badge badge-timed">⏱ ${task.minSeconds}s min</span>`
            : '';

    // Route task links through the ad interstitial page
    const adLink = task.link
        ? `/ad/${task.id}?url=${encodeURIComponent(task.link)}`
        : '';

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
            ${adLink
                ? `<a href="${escapeAttr(adLink)}" target="_blank" rel="noopener" class="task-link">Open Task</a>`
                : ''}
            ${actionHtml}
        </div>
    `;

    // Start the countdown timer if task is in progress
    if (task.status === 'started' && task.startedAt) {
        startTimer(task.id, task.startedAt, task.minSeconds || 0, task.verification);
    }

    return card;
}

// ================= START TASK =================
async function startTask(taskId) {
    const user = Auth.getUser();
    if (!user) return;

    try {
        const res = await fetch('/api/tasks/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.id, taskId })
        });
        const data = await res.json();

        if (res.ok) {
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

    const tick = () => {
        const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
        valueEl.textContent = `${elapsed}s`;

        if (verification === 'timed' && elapsed >= minSeconds) {
            if (timerBox) timerBox.classList.add('timer-ready');
            valueEl.textContent = `✅ ${elapsed}s — ready`;
            if (completeBtn && completeBtn.disabled) {
                completeBtn.disabled = false;
            }
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

    // Proof/admin tasks require proof input
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

    if (task.verification === 'timed') {
        if (!confirm('Confirm you have completed this task?')) return;
    }

    try {
        const res = await fetch('/api/tasks/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.id, taskId, proofUrl })
        });
        const data = await res.json();

        if (res.ok) {
            if (data.pending) {
                alert(`⏳ Submitted for review.\n₦${data.reward} will be credited after approval.`);
            } else {
                alert(`✅ Task completed!\nYou earned ₦${data.reward}`);
            }
            loadDashboard();
        } else {
            alert(data.error || 'Failed to complete task');
        }
    } catch {
        alert('Network error. Try again.');
    }
}

// ================= WITHDRAW (with 10-min ad modal) =================
async function withdraw(event) {
    event.preventDefault();

    const user = Auth.getUser();
    if (!user) return;

    const amount = parseInt(document.getElementById('withdrawAmount').value);
    const bankName = document.getElementById('bankName').value;
    const accountNumber = document.getElementById('accountNumber').value.trim();

    if (!amount || amount < 100) {
        return showMessage('withdrawMessage', 'Minimum withdrawal is ₦100', 'error');
    }
    if (!bankName) {
        return showMessage('withdrawMessage', 'Please select a bank', 'error');
    }
    if (!/^\d{10}$/.test(accountNumber)) {
        return showMessage('withdrawMessage', 'Account number must be 10 digits', 'error');
    }

    // Save payload and open the ad modal
    pendingWithdrawal = { userId: user.id, amount, bankName, accountNumber };
    openWithdrawAdModal();
}

function openWithdrawAdModal() {
    const modal = document.getElementById('withdrawAdModal');
    if (!modal) {
        // Fallback: if no modal exists, submit directly
        return submitWithdrawal();
    }

    const timerEl = document.getElementById('withdrawTimer');
    const confirmBtn = document.getElementById('confirmWithdrawBtn');
    const cancelBtn = document.getElementById('cancelWithdrawBtn');
    const video = document.getElementById('adVideo');

    modal.classList.add('open');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirm Withdrawal';
    timerEl.classList.remove('timer-ready');

    // Tell the server the user started watching the ad
    fetch('/api/withdraw/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: Auth.getUser().id })
    }).catch(() => {});

    // 10 minutes = 600 seconds
    let remaining = 600;

    const format = (s) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    };

    timerEl.textContent = format(remaining);

    // Try to play the video
    if (video) video.play().catch(() => {});

    // Clear any previous interval
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

    // Confirm handler
    confirmBtn.onclick = () => submitWithdrawal();

    // Cancel handler
    cancelBtn.onclick = () => {
        if (withdrawAdInterval) {
            clearInterval(withdrawAdInterval);
            withdrawAdInterval = null;
        }
        closeWithdrawAdModal();
        pendingWithdrawal = null;
    };
}

async function submitWithdrawal() {
    if (!pendingWithdrawal) return;

    const confirmBtn = document.getElementById('confirmWithdrawBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Processing…';
    }

    try {
        const res = await fetch('/api/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pendingWithdrawal)
        });
        const data = await res.json();

        closeWithdrawAdModal();

        if (res.ok) {
            showMessage(
                'withdrawMessage',
                `✅ ₦${data.amount} withdrawal to ${data.bankName} (${data.accountNumber}) submitted!`,
                'success'
            );
            document.getElementById('withdrawForm').reset();
            loadDashboard();
        } else {
            showMessage('withdrawMessage', data.error || 'Withdrawal failed', 'error');
        }
    } catch {
        closeWithdrawAdModal();
        showMessage('withdrawMessage', 'Network error. Try again.', 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.textContent = 'Confirm Withdrawal';
            confirmBtn.disabled = true;
        }
        pendingWithdrawal = null;
    }
}

function closeWithdrawAdModal() {
    const modal = document.getElementById('withdrawAdModal');
    const video = document.getElementById('adVideo');
    if (video) {
        video.pause();
        video.currentTime = 0;
    }
    if (modal) modal.classList.remove('open');

    const timerEl = document.getElementById('withdrawTimer');
    if (timerEl) timerEl.classList.remove('timer-ready');

    if (withdrawAdInterval) {
        clearInterval(withdrawAdInterval);
        withdrawAdInterval = null;
    }
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
            container.innerHTML = '<p class="empty-state">No withdrawals yet.</p>';
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
    setTimeout(() => (el.style.display = 'none'), 5000);
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

    // Redirect logged-in users away from public pages
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