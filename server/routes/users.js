/**
 * 路由：用户管理
 *
 * 权限模型（两层）：
 *  1. **管理员**：可查看全部用户、增删改任意用户、调整角色与权限、强制登出。
 *  2. **普通用户**：仅能查看与修改**自己**的资料（用户名 / 密码）。
 *     - `GET /users` 对普通用户只返回自己一条记录，不泄露其他账户信息；
 *     - 修改他人、调整角色、新建/删除用户一律 403。
 *
 * 前端隐藏入口只是第一层，本模块的接口层校验才是真正的边界。
 */
const { express, configStore, statsStore, authSession } = require('./_context');
const { requireAdmin, sendError } = require('./_shared');

const router = express.Router();

function isAdmin(req) {
  return Boolean(req.authUser && req.authUser.role === 'admin');
}

/* ============================ 自助资料（所有登录用户） ============================ */

// 当前用户资料（等价于 /auth/me 的 user 字段，但语义上归属"我的资料"）
router.get('/users/me', (req, res) => {
  const me = req.authUser;
  if (!me) return res.status(401).json({ error: '请先登录' });
  // FUN-12：只回传安全视图（userView），绝不回退到 getUserById() 的原始记录
  // —— 原始记录含 passwordHash / passwordSalt / webauthn.publicKey。
  const u = configStore.listUsers().find((x) => x.id === me.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ user: u });
});

/**
 * 修改自己的资料：**仅允许用户名与密码**。
 *
 * 明确不接受 role / permissions —— 普通用户不得自行提权，管理员调整自己的角色
 * 也应走 `/users/:id`（那里有"至少保留一个管理员"的保护逻辑）。
 */
router.put('/users/me', async (req, res) => {
  try {
    const me = req.authUser;
    if (!me) return res.status(401).json({ error: '请先登录' });
    const b = req.body || {};

    const patch = {};
    if (b.username !== undefined) patch.username = b.username;
    if (b.password !== undefined && b.password !== '') {
      if (b.confirmPassword !== undefined && String(b.confirmPassword) !== String(b.password)) {
        return res.status(400).json({ error: '两次输入的密码不一致' });
      }
      patch.password = b.password;
    }

    // 显式拒绝越权字段，避免"默默忽略"造成的语义误解
    if (b.role !== undefined) return res.status(403).json({ error: '不能修改自己的角色' });
    if (b.permissions !== undefined) return res.status(403).json({ error: '不能修改自己的权限' });

    const user = await configStore.updateUser(me.id, patch);

    // 用户名为登录凭据的一部分：改名后强制该账户全部会话失效，要求重新登录，
    // 避免旧会话里缓存的旧用户名与新凭据不一致。
    if (patch.username && patch.username !== me.username) {
      authSession.destroyUserSessions(me.id);
      const parts = ['修改用户名'];
      if (patch.password) parts.push('修改密码');
      statsStore.addLog({ action: 'users.self-update', level: 'warn', detail: `用户「${me.username}」${parts.join('并')}，已强制重新登录` });
      return res.json({ ok: true, user, reauthRequired: true });
    }

    const parts = [];
    if (patch.username) parts.push('修改用户名');
    if (patch.password) parts.push('修改密码');
    // SEC-02 同理：改密码后**其它设备**的会话必须立即失效（防「密码已改但仍被旧会话控制」），
    // 当前这台设备保留，避免用户改完密码立刻掉线。
    if (patch.password) {
      authSession.destroyUserSessionsExcept(me.id, req.sessionToken);
    }
    statsStore.addLog({ action: 'users.self-update', detail: `用户「${me.username}」更新了自己的资料（${parts.join('，') || '无变更'}）` });
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

/* ============================ 用户列表 ============================ */

// 用户列表：管理员看到全部；普通用户只看到自己（避免枚举其他账户）
router.get('/users', (req, res) => {
  const me = req.authUser;
  if (!me) return res.status(401).json({ error: '请先登录' });
  const all = configStore.listUsers();
  if (isAdmin(req)) return res.json({ users: all, scope: 'all' });
  res.json({ users: all.filter((u) => u.id === me.id), scope: 'self' });
});

/* ============================ 管理员专用 ============================ */

// 新增用户（用户名 / 密码 / 角色 / 权限）
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.confirmPassword !== undefined && String(b.confirmPassword) !== String(b.password || '')) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }
    const user = await configStore.addUser({
      username: b.username,
      password: b.password,
      role: b.role,
      permissions: b.permissions,
    });
    statsStore.addLog({ action: 'users.create', detail: `管理员「${req.authUser.username}」新增用户「${user.username}」（${user.role === 'admin' ? '管理员' : '普通用户'}）` });
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

// 编辑用户（用户名 / 密码留空不改 / 角色 / 权限）
router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.password !== undefined && b.password !== '' && b.confirmPassword !== undefined &&
      String(b.confirmPassword) !== String(b.password)) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }
    const patch = {};
    if (b.username !== undefined) patch.username = b.username;
    if (b.password !== undefined && b.password !== '') patch.password = b.password;
    if (b.role !== undefined) patch.role = b.role;
    if (b.permissions !== undefined) patch.permissions = b.permissions;
    const user = await configStore.updateUser(req.params.id, patch);
    const parts = [];
    if (patch.username) parts.push('修改用户名');
    if (patch.role) parts.push(`调整为${user.role === 'admin' ? '管理员' : '普通用户'}`);
    if (patch.permissions) parts.push('更新权限');
    if (patch.password) parts.push('重置密码');
    statsStore.addLog({ action: 'users.update', detail: `管理员「${req.authUser.username}」编辑用户「${user.username}」（${parts.join('，') || '无变更'}）` });

    // SEC-02：凡改变「身份 / 权限 / 凭据」的编辑，都必须让该用户的既有会话立即失效。
    //  - 改名：会话里缓存的用户名已过期；
    //  - 降权 / 调整权限：否则旧会话继续持原权限最长 24 小时（越权窗口）；
    //  - 重置密码：这是典型的应急响应动作，不撤销会话等于应急响应失效。
    const sensitive = patch.username !== undefined || patch.role !== undefined
      || patch.permissions !== undefined || patch.password !== undefined;
    if (sensitive) {
      const n = authSession.destroyUserSessions(user.id);
      if (n > 0) {
        statsStore.addLog({ action: 'users.logout', level: 'warn', detail: `管理员「${req.authUser.username}」变更了用户「${user.username}」的凭据/权限，其 ${n} 个会话已失效` });
      }
      return res.json({ ok: true, user, sessionsRevoked: n });
    }
    res.json({ ok: true, user });
  } catch (e) {
    sendError(res, e);
  }
});

// 删除用户（禁止删除自己；系统至少保留一个管理员）
router.delete('/users/:id', requireAdmin, (req, res) => {
  try {
    const target = configStore.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    if (target.id === req.authUser.id) {
      return res.status(400).json({ error: '不能删除当前登录的账户' });
    }
    configStore.removeUser(req.params.id);
    // SEC-02：账户已删除，其会话必须立即失效，否则被删除者仍能继续读写对象存储。
    const n = authSession.destroyUserSessions(target.id);
    statsStore.addLog({ action: 'users.delete', level: 'warn', detail: `管理员「${req.authUser.username}」删除用户「${target.username}」（${n} 个会话已失效）` });
    res.json({ ok: true, sessionsRevoked: n });
  } catch (e) {
    sendError(res, e);
  }
});

// 管理员强制登出指定用户的全部会话（S11）
router.post('/users/:id/logout', requireAdmin, (req, res) => {
  try {
    const target = configStore.getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: '用户不存在' });
    const n = authSession.destroyUserSessions(target.id);
    statsStore.addLog({ action: 'users.logout', level: 'warn', detail: `管理员「${req.authUser.username}」强制登出用户「${target.username}」（${n} 个会话）` });
    res.json({ ok: true, sessions: n });
  } catch (e) {
    sendError(res, e);
  }
});

module.exports = router;
