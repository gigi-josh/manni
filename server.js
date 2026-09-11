const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static('public'));

// ---------- In-memory storage (swap for MongoDB/Postgres in production) ----------
const users = [];
const taskProgress = [];
const withdrawalRequests = [];
const withdrawStarts = {};
const cpxTransactions = new Map();

// ---------- Transfer window rule ----------
// Transfers only allowed on days 1–5 of each month
const TRANSFER_WINDOW_START_DAY = 1;
const TRANSFER_WINDOW_END_DAY = 5;

function isTransferWindowOpen() {
    const day = new Date().getDate();
    return day >= TRANSFER_WINDOW_START_DAY && day <= TRANSFER_WINDOW_END_DAY;
}

function nextTransferWindowStart() {
    const now = new Date();
    const day = now.getDate();

    if (day >= TRANSFER_WINDOW_START_DAY && day <= TRANSFER_WINDOW_END_DAY) {
        return now; // window is open now
    }

    // Next 1st of the month
    return new Date(now.getFullYear(), now.getMonth() + 1, TRANSFER_WINDOW_START_DAY);
}

function formatWindowDate(date) {
    return date.toLocaleDateString('en-NG', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    });
}

// ---------- Sample tasks with verification rules ----------
const sampleTasks = [
    {
        id: 1,
        title: 'Watch YouTube Video',
        description: 'Watch a 2-minute video about Nigerian culture',
        reward: 50,
        category: 'Video',
        link: 'https://youtube.com/watch?v=example1',
        instructions: 'Watch the full video, then click "I\'m Done"',
        verification: 'timed',
        minSeconds: 120
    },
    {
        id: 2,
        title: 'Complete Survey',
        description: 'Share your opinion about fintech in Nigeria',
        reward: 100,
        category: 'Survey',
        link: 'https://survey.example.com',
        instructions: 'Answer all questions, then submit a screenshot link',
        verification: 'proof',
        minSeconds: 60
    },
    {
        id: 3,
        title: 'Download App',
        description: 'Download and install a Nigerian shopping app',
        reward: 150,
        category: 'Download',
        link: 'https://play.google.com/store/apps/details?id=example',
        instructions: 'Install, open the app, and submit a screenshot link',
        verification: 'proof',
        minSeconds: 60
    },
    {
        id: 4,
        title: 'Refer a Friend',
        description: 'Refer a friend to MannieNG and earn rewards',
        reward: 200,
        category: 'Referral',
        link: '',
        instructions: 'Share your referral code. Reward after friend completes 1 task.',
        verification: 'admin',
        minSeconds: 0
    },
    {
        id: 5,
        title: 'Social Media Post',
        description: 'Post about MannieNG on Instagram or Twitter',
        reward: 75,
        category: 'Social',
        link: '',
        instructions: 'Post using #MannieNG and tag @MannieNG, then submit the post URL',
        verification: 'proof',
        minSeconds: 0
    }
];

// ---------- Helpers ----------
function findUser(id) {
    return users.find(u => u.id === parseInt(id));
}

function findProgress(userId, taskId) {
    return taskProgress.find(tp => tp.userId === userId && tp.taskId === taskId);
}

function sanitizeUser(user) {
    const { password, ...safe } = user;
    return safe;
}

const RATE_LIMIT_PER_HOUR = 10;

function recentCompletionCount(userId) {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return taskProgress.filter(tp =>
        tp.userId === userId &&
        tp.completedAt &&
        new Date(tp.completedAt).getTime() > oneHourAgo &&
        (tp.status === 'completed' || tp.status === 'pending')
    ).length;
}

// ---------- Pages ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/ad/:taskId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ad.html')));
app.get('/surveys', (req, res) => res.sendFile(path.join(__dirname, 'public', 'surveys.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/transfer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'transfer.html')));

// ==================== AUTH ====================

app.post('/api/register', async (req, res) => {
    const { username, email, password, phone } = req.body;

    if (!username || !email || !password || !phone) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    if (username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const phoneRegex = /^(\+234|0)[789][01]\d{8}$/;
    if (!phoneRegex.test(phone)) {
        return res.status(400).json({ error: 'Invalid Nigerian phone number' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    if (users.find(u => u.email === email || u.username === username)) {
        return res.status(400).json({ error: 'User with that email or username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = {
        id: users.length + 1,
        username,
        email,
        password: hashedPassword,
        phone,
        balance: 0,
        pendingBalance: 0,
        tasksCompleted: 0,
        referralCode: `MNG${Date.now().toString(36).toUpperCase()}`,
        createdAt: new Date().toISOString()
    };

    users.push(user);

    sampleTasks.forEach(task => {
        taskProgress.push({
            userId: user.id,
            taskId: task.id,
            status: 'available',
            startedAt: null,
            completedAt: null,
            proofUrl: null,
            adminNote: null
        });
    });

    res.status(201).json({
        message: 'Registration successful!',
        user: sanitizeUser(user)
    });
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    const user = users.find(u => u.email === email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    res.json({
        message: 'Login successful!',
        user: sanitizeUser(user)
    });
});

// ==================== USER ====================

app.get('/api/user/:id', (req, res) => {
    const user = findUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(sanitizeUser(user));
});

// ==================== TASKS ====================

app.get('/api/tasks/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const user = findUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const tasksWithStatus = sampleTasks.map(task => {
        const p = findProgress(userId, task.id);
        return {
            ...task,
            status: p ? p.status : 'available',
            startedAt: p ? p.startedAt : null,
            completedAt: p ? p.completedAt : null,
            adminNote: p ? p.adminNote : null
        };
    });

    res.json(tasksWithStatus);
});

app.post('/api/tasks/start', (req, res) => {
    const { userId, taskId } = req.body;

    const user = findUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const task = sampleTasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const progress = findProgress(userId, taskId);
    if (!progress) return res.status(404).json({ error: 'Task not found for user' });

    if (progress.status === 'completed') {
        return res.status(400).json({ error: 'Task already completed' });
    }
    if (progress.status === 'pending') {
        return res.status(400).json({ error: 'Task awaiting admin approval' });
    }
    if (progress.status === 'started') {
        return res.json({
            message: 'Task already started',
            startedAt: progress.startedAt,
            minSeconds: task.minSeconds
        });
    }

    progress.status = 'started';
    progress.startedAt = new Date().toISOString();

    res.json({
        message: 'Task started',
        startedAt: progress.startedAt,
        minSeconds: task.minSeconds
    });
});

app.post('/api/tasks/complete', (req, res) => {
    const { userId, taskId, proofUrl } = req.body;

    const user = findUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const task = sampleTasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const progress = findProgress(userId, taskId);
    if (!progress) return res.status(404).json({ error: 'Task not found for user' });

    if (progress.status === 'completed') {
        return res.status(400).json({ error: 'Task already completed' });
    }
    if (progress.status === 'pending') {
        return res.status(400).json({ error: 'Task awaiting admin approval' });
    }

    if (recentCompletionCount(userId) >= RATE_LIMIT_PER_HOUR) {
        return res.status(429).json({
            error: `Too many completions. Max ${RATE_LIMIT_PER_HOUR} per hour. Try again later.`
        });
    }

    if (progress.status !== 'started' || !progress.startedAt) {
        return res.status(400).json({ error: 'You must start this task first' });
    }

    if (task.verification === 'timed' && task.minSeconds > 0) {
        const elapsed = (Date.now() - new Date(progress.startedAt).getTime()) / 1000;
        if (elapsed < task.minSeconds) {
            return res.status(400).json({
                error: `Please spend at least ${task.minSeconds}s on this task. You've only done ${Math.floor(elapsed)}s.`
            });
        }
    }

    if (task.verification === 'proof' || task.verification === 'admin') {
        if (!proofUrl || typeof proofUrl !== 'string' || proofUrl.trim().length < 10) {
            return res.status(400).json({
                error: 'Please provide proof (screenshot URL, post URL, etc.) to submit'
            });
        }

        progress.status = 'pending';
        progress.proofUrl = proofUrl.trim();
        progress.completedAt = new Date().toISOString();
        user.pendingBalance = (user.pendingBalance || 0) + task.reward;

        return res.json({
            message: 'Submitted for review. Reward will be credited after approval.',
            pending: true,
            reward: task.reward,
            pendingBalance: user.pendingBalance
        });
    }

    progress.status = 'completed';
    progress.completedAt = new Date().toISOString();
    user.balance += task.reward;
    user.tasksCompleted += 1;

    res.json({
        message: 'Task completed!',
        reward: task.reward,
        newBalance: user.balance
    });
});

// ==================== TRANSFERS ====================

// Public endpoint: check if transfer window is open
app.get('/api/withdraw/window', (req, res) => {
    const open = isTransferWindowOpen();
    const next = nextTransferWindowStart();

    res.json({
        open,
        nextWindow: next.toISOString(),
        nextWindowLabel: formatWindowDate(next),
        windowStartDay: TRANSFER_WINDOW_START_DAY,
        windowEndDay: TRANSFER_WINDOW_END_DAY
    });
});

// Starts the ad-watch timer (must be called before submitting a transfer)
app.post('/api/withdraw/start', (req, res) => {
    const { userId } = req.body;

    // Reject early if window is closed
    if (!isTransferWindowOpen()) {
        const next = nextTransferWindowStart();
        return res.status(403).json({
            error: `Transfers are only available from the ${TRANSFER_WINDOW_START_DAY}th to the ${TRANSFER_WINDOW_END_DAY}th of each month. Next window opens on ${formatWindowDate(next)}.`
        });
    }

    const user = findUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    withdrawStarts[userId] = Date.now();
    res.json({ ok: true, minSeconds: 600 });
});

app.post('/api/withdraw', (req, res) => {
    const { userId, amount, bankName, accountNumber } = req.body;

    // ---- Rule: transfers only allowed days 1–5 ----
    if (!isTransferWindowOpen()) {
        const next = nextTransferWindowStart();
        return res.status(403).json({
            error: `Transfers are only available from the ${TRANSFER_WINDOW_START_DAY}th to the ${TRANSFER_WINDOW_END_DAY}th of each month. Next window opens on ${formatWindowDate(next)}.`
        });
    }

    const user = findUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // ---- Enforce ad watch ----
    const startedAt = withdrawStarts[userId];
    if (!startedAt) {
        return res.status(400).json({ error: 'Transfer session not started' });
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed < 600) {
        return res.status(400).json({
            error: `You must watch the ad for ${Math.ceil(600 - elapsed)}s more.`
        });
    }
    delete withdrawStarts[userId];

    const amt = parseInt(amount);
    if (!amt || amt < 100) {
        return res.status(400).json({ error: 'Minimum transfer is ₦100' });
    }
    if (user.balance < amt) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }
    if (!bankName || typeof bankName !== 'string') {
        return res.status(400).json({ error: 'Bank name is required' });
    }
    if (!/^\d{10}$/.test(accountNumber)) {
        return res.status(400).json({ error: 'Account number must be 10 digits' });
    }

    // TODO: integrate Flutterwave / Paystack here
    user.balance -= amt;

    withdrawalRequests.push({
        id: withdrawalRequests.length + 1,
        userId: user.id,
        amount: amt,
        bankName,
        accountNumber,
        status: 'processing',
        requestedAt: new Date().toISOString()
    });

    res.json({
        message: 'Transfer request submitted!',
        amount: amt,
        newBalance: user.balance,
        bankName,
        accountNumber
    });
});

app.get('/api/withdrawals/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const user = findUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const list = withdrawalRequests
        .filter(w => w.userId === userId)
        .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

    res.json(list);
});

// ==================== CPX RESEARCH ====================

app.get('/api/cpx-hash/:userId', (req, res) => {
    const userId = parseInt(req.params.userId);
    const user = findUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!process.env.CPX_SECURE_HASH) {
        return res.status(500).json({ error: 'CPX hash not configured' });
    }

    const hash = crypto
        .createHash('md5')
        .update(`${userId}-${process.env.CPX_SECURE_HASH}`)
        .digest('hex');

    res.json({
        appId: process.env.CPX_APP_ID,
        userId: user.id,
        username: user.username,
        email: user.email,
        hash
    });
});

app.all('/api/cpx-webhook', (req, res) => {
    const params = { ...req.query, ...req.body };

    const {
        status,
        trans_id,
        user_id,
        amount_local,
        amount_usd,
        hash,
        ip_click,
        type
    } = params;

    console.log('CPX webhook received:', params);

    if (!trans_id || !user_id) {
        return res.status(400).json({ error: 'Missing trans_id or user_id' });
    }

    // ---- Validate hash: md5(trans_id + "-" + SECURE_HASH) ----
    if (process.env.CPX_SECURE_HASH && hash) {
        const withDash = crypto.createHash('md5')
            .update(`${trans_id}-${process.env.CPX_SECURE_HASH}`)
            .digest('hex');
        const noDash = crypto.createHash('md5')
            .update(`${trans_id}${process.env.CPX_SECURE_HASH}`)
            .digest('hex');

        if (hash !== withDash && hash !== noDash) {
            console.warn('CPX webhook: invalid hash for trans', trans_id);
            return res.status(403).json({ error: 'Invalid hash' });
        }
    }

    const user = findUser(user_id);
    if (!user) {
        console.warn('CPX webhook: user not found', user_id);
        return res.status(404).json({ error: 'User not found' });
    }

    const reward = Math.round(parseFloat(amount_local || '0') || 0);

    // ---- Handle reversal (status = 2) ----
    if (String(status) === '2') {
        const existing = cpxTransactions.get(trans_id);
        if (existing && !existing.reversed) {
            user.balance = Math.max(0, user.balance - existing.amount);
            user.tasksCompleted = Math.max(0, user.tasksCompleted - 1);
            existing.reversed = true;
            cpxTransactions.set(trans_id, existing);
            console.log(`CPX: reversed ₦${existing.amount} from ${user.username} (trans ${trans_id})`);
        }
        return res.json({ ok: true, reversed: true });
    }

    // ---- Only credit on complete (status = 1) ----
    if (String(status) !== '1') {
        return res.json({ ok: true, message: 'Ignored non-complete status' });
    }

    if (cpxTransactions.has(trans_id)) {
        return res.json({ ok: true, message: 'Already processed' });
    }

    cpxTransactions.set(trans_id, { userId: user.id, amount: reward, reversed: false });
    user.balance += reward;
    user.tasksCompleted += 1;

    console.log(`CPX: credited ₦${reward} to ${user.username} (trans ${trans_id})`);

    res.json({ ok: true, credited: reward });
});

// ==================== ADMIN ====================

app.get('/api/admin/pending', (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const pending = taskProgress
        .filter(tp => tp.status === 'pending')
        .map(tp => {
            const user = findUser(tp.userId);
            const task = sampleTasks.find(t => t.id === tp.taskId);
            return {
                userId: tp.userId,
                username: user ? user.username : 'Unknown',
                email: user ? user.email : '',
                taskId: tp.taskId,
                taskTitle: task ? task.title : '',
                reward: task ? task.reward : 0,
                proofUrl: tp.proofUrl,
                submittedAt: tp.completedAt
            };
        });

    res.json(pending);
});

app.post('/api/admin/review', (req, res) => {
    const { adminKey, userId, taskId, approve, note } = req.body;

    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const progress = findProgress(userId, taskId);
    if (!progress || progress.status !== 'pending') {
        return res.status(404).json({ error: 'No pending submission found' });
    }

    const task = sampleTasks.find(t => t.id === taskId);
    const user = findUser(userId);
    if (!task || !user) {
        return res.status(404).json({ error: 'Task or user not found' });
    }

    user.pendingBalance = Math.max(0, (user.pendingBalance || 0) - task.reward);

    if (approve) {
        progress.status = 'completed';
        progress.adminNote = note || null;
        user.balance += task.reward;
        user.tasksCompleted += 1;

        return res.json({
            message: 'Approved',
            userId,
            taskId,
            reward: task.reward,
            newBalance: user.balance,
            newPendingBalance: user.pendingBalance
        });
    } else {
        progress.status = 'rejected';
        progress.adminNote = note || 'Proof insufficient';
        progress.proofUrl = null;

        return res.json({
            message: 'Rejected',
            userId,
            taskId,
            note: progress.adminNote,
            newPendingBalance: user.pendingBalance
        });
    }
});

app.get('/api/admin/users', (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(users.map(sanitizeUser));
});

// Admin: manually process a pending transfer (mark as paid/failed)
app.post('/api/admin/transfer', (req, res) => {
    const { adminKey, transferId, status, note } = req.body;

    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const transfer = withdrawalRequests.find(w => w.id === parseInt(transferId));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    if (!['processing', 'paid', 'failed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    transfer.status = status;
    transfer.processedAt = new Date().toISOString();
    transfer.adminNote = note || null;

    // If failed, refund the user
    if (status === 'failed') {
        const user = findUser(transfer.userId);
        if (user) user.balance += transfer.amount;
    }

    res.json({ ok: true, transfer });
});

// Admin: list all transfers
app.get('/api/admin/transfers', (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const list = [...withdrawalRequests].sort(
        (a, b) => new Date(b.requestedAt) - new Date(a.requestedAt)
    );

    res.json(list);
});

// ==================== START ====================

app.listen(PORT, () => {
    console.log(`MannieNG server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Transfer window: day ${TRANSFER_WINDOW_START_DAY}–${TRANSFER_WINDOW_END_DAY} of each month`);
    console.log(`Currently ${isTransferWindowOpen() ? 'OPEN ✅' : 'CLOSED ❌'}`);
    if (!process.env.ADMIN_KEY) {
        console.warn('⚠️  ADMIN_KEY not set — admin endpoints will reject all requests');
    }
    if (!process.env.CPX_APP_ID || !process.env.CPX_SECURE_HASH) {
        console.warn('⚠️  CPX env vars not set — surveys will not work');
    }
});