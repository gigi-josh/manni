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

// ================= REGISTER =================
async function register(event) {
    event.preventDefault();

    const username = document.getElementById('username').value.trim();
    const email = document.getElementById('email').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const password = document.getElementById('password').value;

    const phoneRegex = /^(\+234|0)[789][01]\d{8}$/;
    if (!phoneRegex.test(phone)) {
        showMessage('registerMessage', 'Enter a valid Nigerian phone number (e.g. 08012345678)', 'error');
        return;
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

        // Refresh LocalStorage with latest data
        Auth.setUser(user);

        document.getElementById('username').textContent = user.username;
        document.getElementById('balance').textContent = `₦${user.balance.toLocaleString()}`;
        document.getElementById('tasksCompleted').textContent = user.tasksCompleted;
        document.getElementById('referralCode').textContent = user.referralCode;

        loadTasks();
    } catch {
        Auth.logout();
    }
}

async function loadTasks() {
    const user = Auth.getUser();
    if (!user) return;

    try {
        const res = await fetch(`/api/tasks/${user.id}`);
        const tasks = await res.json();

        const container = document.getElementById('tasksContainer');
        container.innerHTML = '';

        if (!tasks.length) {
            container.innerHTML = '<p>No tasks available right now.</p>';
            return;
        }

        tasks.forEach(task => {
            const card = document.createElement('div');
            card.className = `task-card ${task.completed ? 'completed' : ''}`;
            card.innerHTML = `
                <div class="task-header">
                    <span class="task-title">${task.title}</span>
                    <span class="task-reward">₦${task.reward}</span>
                </div>
                <span class="task-category">${task.category}</span>
                <p class="task-description">${task.description}</p>
                <small>${task.instructions}</small>
                <div class="task-actions">
                    ${task.link ? `<a href="${task.link}" target="_blank" class="task-link">Open Task</a>` : ''}
                    ${!task.completed
                        ? `<button onclick="completeTask(${task.id})" class="btn btn-success">Complete</button>`
                        : `<span class="task-completed">✅ Completed</span>`}
                </div>
            `;
            container.appendChild(card);
        });
    } catch {
        document.getElementById('tasksContainer').innerHTML = '<p>Failed to load tasks.</p>';
    }
}

async function completeTask(taskId) {
    const user = Auth.getUser();
    if (!user) return;
    if (!confirm('Confirm you have completed this task?')) return;

    try {
        const res = await fetch('/api/tasks/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.id, taskId })
        });
        const data = await res.json();

        if (res.ok) {
            alert(`✅ Task completed! You earned ₦${data.reward}`);
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

    if (!amount || amount < 100) return showMessage('withdrawMessage', 'Minimum is ₦100', 'error');
    if (!bankName) return showMessage('withdrawMessage', 'Select a bank', 'error');
    if (!/^\d{10}$/.test(accountNumber)) return showMessage('withdrawMessage', 'Invalid 10-digit account number', 'error');

    try {
        const res = await fetch('/api/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user.id, amount, bankName, accountNumber })
        });
        const data = await res.json();

        if (res.ok) {
            showMessage('withdrawMessage',
                `✅ ₦${amount} withdrawal to ${bankName} (${accountNumber}) submitted!`,
                'success');
            document.getElementById('withdrawForm').reset();
            loadDashboard();
        } else {
            showMessage('withdrawMessage', data.error || 'Withdrawal failed', 'error');
        }
    } catch {
        showMessage('withdrawMessage', 'Network error. Try again.', 'error');
    }
}

// ================= UTILITIES =================
function showMessage(elementId, message, type) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = `message-${type}`;
    el.style.display = 'block';
    setTimeout(() => (el.style.display = 'none'), 5000);
}

// ================= INIT =================
document.addEventListener('DOMContentLoaded', () => {
    // Redirect logged-in users away from auth pages
    const path = window.location.pathname;
    const user = Auth.getUser();

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

    if (path === '/dashboard') loadDashboard();
});