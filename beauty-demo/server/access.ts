import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Request, Response, RequestHandler } from 'express';
import { Store } from './storage/store.js';
import { AppError } from './core/errors.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const customerCookie = 'beauty_customer';
const operatorCookie = 'beauty_operator';
type Identity = { role: 'customer' | 'operator'; userId: string | null; csrf: string; expiresAt: number };
type ApiIdentity = { role: 'mcp'; userId: string };

export class AccessControl {
  private salt: Buffer;
  private passwordHash: Buffer;
  private failures = new Map<string, { count: number; until: number }>();
  constructor(private store: Store, options: { operatorPassword?: string; passwordFile?: string } = {}) {
    let password = options.operatorPassword ?? process.env.BEAUTY_OPERATOR_PASSWORD;
    if (!password && options.passwordFile) {
      if (existsSync(options.passwordFile)) password = readFileSync(options.passwordFile, 'utf8').trim();
      else {
        password = randomBytes(24).toString('base64url');
        mkdirSync(dirname(options.passwordFile), { recursive: true });
        writeFileSync(options.passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
      }
    }
    // An unconfigured embedded instance is locked, never given a public default password.
    password ||= randomBytes(32).toString('base64url');
    if (password.length < 12 || password.length > 1024) throw new Error('Operator password must contain 12–1024 characters.');
    const previous = store.db.prepare("SELECT value FROM access_state WHERE name='operator-secret'").get() as { value: string } | undefined;
    const saved = previous ? JSON.parse(previous.value) as { salt: string; hash: string } : null;
    this.salt = saved ? Buffer.from(saved.salt, 'hex') : randomBytes(16);
    this.passwordHash = scryptSync(password, this.salt, 32);
    if (!saved || saved.hash !== this.passwordHash.toString('hex')) {
      store.db.prepare("DELETE FROM access_sessions WHERE role='operator'").run();
      store.db.prepare("INSERT INTO access_state VALUES('operator-secret',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({ salt: this.salt.toString('hex'), hash: this.passwordHash.toString('hex') }));
    }
    store.db.prepare('DELETE FROM access_sessions WHERE expires_at < ?').run(Date.now());
    store.db.prepare('DELETE FROM api_credentials WHERE expires_at < ?').run(Date.now());
  }
  private cookieValue(req: Request, name: string) {
    return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
  }
  private session(req: Request, role: Identity['role']): Identity | null {
    const token = this.cookieValue(req, role === 'operator' ? operatorCookie : customerCookie);
    if (!token || !/^[A-Za-z0-9_-]{32,100}$/.test(token)) return null;
    const row = this.store.db.prepare('SELECT role,user_id AS userId,csrf,expires_at AS expiresAt FROM access_sessions WHERE hash=? AND role=? AND expires_at>?')
      .get(hash(token), role, Date.now()) as Identity | undefined;
    return row ?? null;
  }
  private createSession(req: Request, res: Response, role: Identity['role'], userId: string | null) {
    const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url');
    const maxAge = (role === 'operator' ? 8 * 3600 : 30 * 86400) * 1000;
    this.store.db.prepare('INSERT INTO access_sessions VALUES(?,?,?,?,?)').run(hash(token), role, userId, csrf, Date.now() + maxAge);
    res.cookie(role === 'operator' ? operatorCookie : customerCookie, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge });
    return { role, userId, csrfToken: csrf, expiresAt: Date.now() + maxAge };
  }
  customerStatus(req: Request) {
    const identity = this.session(req, 'customer');
    return identity ? { authenticated: true, userId: identity.userId, csrfToken: identity.csrf } : { authenticated: false };
  }
  startCustomer(req: Request, res: Response) {
    const identity = this.session(req, 'customer');
    if (identity) return this.customerStatus(req);
    const user = this.store.createUser({ userId: `customer-${randomUUID()}`, displayName: '访客' });
    return { authenticated: true, ...this.createSession(req, res, 'customer', user.userId) };
  }
  operatorStatus(req: Request) {
    const identity = this.session(req, 'operator');
    return identity ? { authenticated: true, csrfToken: identity.csrf, expiresAt: identity.expiresAt } : { authenticated: false };
  }
  login(req: Request, res: Response, password: string) {
    const key = req.ip ?? 'unknown'; const failure = this.failures.get(key);
    if (failure && failure.until > Date.now() && failure.count >= 5) throw new AppError(429, 'LOGIN_RATE_LIMIT', '尝试次数过多，请一分钟后再试。');
    const candidate = scryptSync(password, this.salt, 32);
    if (!timingSafeEqual(candidate, this.passwordHash)) {
      if (this.failures.size > 1000) this.failures.clear();
      this.failures.set(key, { count: failure && failure.until > Date.now() ? failure.count + 1 : 1, until: Date.now() + 60_000 });
      throw new AppError(401, 'INVALID_OPERATOR_PASSWORD', '运营口令不正确。它不是模型API Key。');
    }
    this.failures.delete(key);
    const old = this.cookieValue(req, operatorCookie);
    if (old) this.store.db.prepare('DELETE FROM access_sessions WHERE hash=?').run(hash(old));
    return { authenticated: true, ...this.createSession(req, res, 'operator', null) };
  }
  logout(req: Request, res: Response) {
    this.requireOperator(req);
    const token = this.cookieValue(req, operatorCookie)!;
    this.store.db.prepare('DELETE FROM access_sessions WHERE hash=?').run(hash(token));
    res.clearCookie(operatorCookie, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
  }
  private csrf(req: Request, identity: Identity) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-csrf-token'] !== identity.csrf) {
      throw new AppError(403, 'CSRF_REQUIRED', '请求缺少有效会话校验，请刷新页面后再试。');
    }
  }
  requireOperator(req: Request) {
    const identity = this.session(req, 'operator');
    if (!identity) throw new AppError(401, 'OPERATOR_LOGIN_REQUIRED', '请先登录运营端。');
    this.csrf(req, identity); return identity;
  }
  requireCustomer(req: Request) {
    const identity = this.session(req, 'customer');
    if (!identity?.userId) throw new AppError(401, 'CUSTOMER_SESSION_REQUIRED', '请重新打开客服页面建立访客会话。');
    this.csrf(req, identity); return identity as Identity & { userId: string };
  }
  apiIdentity(token: string): ApiIdentity | null {
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) return null;
    const row = this.store.db.prepare('SELECT user_id AS userId FROM api_credentials WHERE hash=? AND expires_at>?')
      .get(hash(token), Date.now()) as { userId: string } | undefined;
    return row ? { role: 'mcp', userId: row.userId } : null;
  }
  issueMcp(userId: string) {
    this.store.getCard(userId);
    const token = randomBytes(32).toString('base64url'); const id = randomUUID(); const expiresAt = Date.now() + 30 * 86400_000;
    this.store.db.prepare('INSERT INTO api_credentials VALUES(?,?,?,?)').run(id, hash(token), userId, expiresAt);
    return { token, id, userId, expiresAt };
  }
  /** Legacy routes are operator-only except a fixed, user-bound MCP allowlist. */
  guard: RequestHandler = (req, _res, next) => {
    try {
      if (req.headers.authorization) {
        const identity = this.apiIdentity(req.headers.authorization.replace(/^Bearer /, ''));
        if (!identity) throw new AppError(401, 'INVALID_API_TOKEN', 'MCP访问凭据无效或已过期。');
        const path = req.path;
        const readProduct = req.method === 'GET' && (/^\/products$/.test(path) || /^\/products\/[A-Za-z0-9_-]+\/(knowledge|comments)$/.test(path));
        const own = /^\/users\/([A-Za-z0-9_-]+)(\/.*)$/.exec(path);
        let allowed = readProduct;
        if (own?.[1] === identity.userId) {
          const tail = own[2]!;
          allowed ||= (['GET', 'PATCH'].includes(req.method) && tail === '/card')
            || (['GET', 'POST'].includes(req.method) && tail === '/sessions')
            || (req.method === 'GET' && /^\/sessions\/[A-Za-z0-9_-]+\/(context|messages|runs\/[A-Za-z0-9_-]+)$/.test(tail))
            || (req.method === 'POST' && /^\/sessions\/[A-Za-z0-9_-]+\/(messages|consult|handoff)$/.test(tail))
            || (req.method === 'POST' && /^\/messages\/[A-Za-z0-9_-]+\/feedback$/.test(tail));
        }
        if (!allowed) throw new AppError(403, 'MCP_SCOPE_DENIED', '该MCP凭据仅允许操作绑定用户的客服数据。');
      } else this.requireOperator(req);
      next();
    } catch (error) { next(error); }
  };
}
