import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  productSchema, commentBatchSchema, cardPatchSchema, createUserSchema, userMessageSchema,
  type Card, type ProductDocument, type SessionStatus,
} from '../contracts/index.js';
import { AppError } from '../core/errors.js';

type DocumentRow = { document: string };
type SessionRow = { sessionId: string; userId: string; productId: string; status: SessionStatus; stateVersion: number; createdAt: string };
type MessageRow = { messageId: string; requestId: string; role: string; content: string; createdAt: string };
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class Store {
  /** Shared by local repositories; never exposed through HTTP. */
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 4) {
      this.db.close();
      throw new Error('Database schema is newer than this application');
    }
    if (version.user_version === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE products (id TEXT PRIMARY KEY, current_version TEXT NOT NULL);
        CREATE TABLE product_versions (
          product_id TEXT NOT NULL REFERENCES products(id), version TEXT NOT NULL,
          document TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (product_id, version)
        );
        CREATE TABLE comment_batches (
          id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
          document TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE comments (
          product_id TEXT NOT NULL REFERENCES products(id), id TEXT NOT NULL,
          batch_id TEXT NOT NULL REFERENCES comment_batches(id), document TEXT NOT NULL, digest TEXT NOT NULL,
          PRIMARY KEY (product_id, id)
        );
        CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE cards (user_id TEXT PRIMARY KEY REFERENCES users(id), document TEXT NOT NULL, version INTEGER NOT NULL);
        CREATE TABLE card_revisions (
          user_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL, document TEXT NOT NULL,
          PRIMARY KEY (user_id, version)
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), product_id TEXT NOT NULL REFERENCES products(id),
          status TEXT NOT NULL DEFAULT 'AI_ACTIVE' CHECK(status IN ('AI_ACTIVE','HANDOFF_PENDING','HUMAN_ACTIVE','RESOLVED')),
          state_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
        );
        CREATE INDEX sessions_by_user ON sessions(user_id);
        CREATE TABLE messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
          session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','human','system')),
          content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(session_id, request_id)
        );
        PRAGMA user_version = 1;
      `);
    });
    if (version.user_version < 2) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
        CREATE TABLE consultation_runs (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
          user_message_id TEXT NOT NULL REFERENCES messages(id),
          state TEXT NOT NULL CHECK(state IN ('running','completed','interrupted')),
          route_json TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(session_id, request_id)
        );
        CREATE UNIQUE INDEX one_active_consultation ON consultation_runs(session_id) WHERE state = 'running';
        CREATE TABLE handoffs (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
          status TEXT NOT NULL CHECK(status IN ('pending','active','resolved')),
          reason TEXT NOT NULL, summary_json TEXT NOT NULL, created_at TEXT NOT NULL,
          claimed_at TEXT, resolved_at TEXT
        );
        CREATE UNIQUE INDEX one_open_handoff ON handoffs(session_id) WHERE status != 'resolved';
        CREATE TABLE feedback (
          user_id TEXT NOT NULL REFERENCES users(id), message_id TEXT NOT NULL REFERENCES messages(id),
          type TEXT NOT NULL CHECK(type IN ('helpful','unresolved','request_human')),
          reason TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(user_id, message_id)
        );
        PRAGMA user_version = 2;
      `);
    });
    if (version.user_version < 3) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS skill_packages (
          id TEXT PRIMARY KEY, document TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS skill_package_versions (
          id TEXT NOT NULL, version TEXT NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(id, version)
        );
        PRAGMA user_version = 3;
      `);
    });
    if (version.user_version < 4) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS access_sessions (
          hash TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('customer','operator')),
          user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS api_credentials (
          id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS access_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS run_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES consultation_runs(id),
          kind TEXT NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS run_snapshots (
          run_id TEXT PRIMARY KEY REFERENCES consultation_runs(id), card_json TEXT,
          skill_json TEXT, knowledge_json TEXT, policy_version TEXT
        );
        CREATE TABLE IF NOT EXISTS skill_audit (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, skill_id TEXT NOT NULL, version TEXT NOT NULL,
          action TEXT NOT NULL, created_at TEXT NOT NULL
        );
        PRAGMA user_version = 4;
      `);
    });
  }

  close() { this.db.close(); }
  health() { return { database: this.db.prepare('SELECT 1 AS ok').get()?.ok === 1, schemaVersion: 4 }; }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  importProduct(input: unknown) {
    const product = productSchema.parse(input);
    const digest = hash(product);
    return this.transaction(() => {
      const existingProduct = this.db.prepare('SELECT id FROM products WHERE id = ?').get(product.productId) as { id: string } | undefined;
      const existingKind = this.db.prepare(`SELECT json_extract(pv.document, '$.dataKind') AS dataKind FROM products p JOIN product_versions pv
        ON pv.product_id=p.id AND pv.version=p.current_version LIMIT 1`).get() as { dataKind: string } | undefined;
      if (existingKind && existingKind.dataKind !== product.dataKind) throw new AppError(409, 'DATA_KIND_CONFLICT', 'Do not mix demo and business data in one database.');
      const previous = this.db.prepare('SELECT digest FROM product_versions WHERE product_id = ? AND version = ?')
        .get(product.productId, product.version) as { digest: string } | undefined;
      if (previous) {
        if (previous.digest !== digest) throw new AppError(409, 'VERSION_CONFLICT', 'The same product version cannot contain different facts. Use a new version.');
        return { productId: product.productId, version: product.version, status: 'unchanged' as const };
      }
      if (existingProduct) {
        const current = this.getProduct(product.productId);
        if (current.dataKind !== product.dataKind) throw new AppError(409, 'DATA_KIND_CONFLICT', 'Do not mix demo and business data in one database.');
        this.db.prepare('UPDATE products SET current_version = ? WHERE id = ?').run(product.version, product.productId);
      } else {
        this.db.prepare('INSERT INTO products VALUES (?, ?)').run(product.productId, product.version);
      }
      this.db.prepare('INSERT INTO product_versions VALUES (?, ?, ?, ?, ?)')
        .run(product.productId, product.version, JSON.stringify(product), digest, now());
      return { productId: product.productId, version: product.version, status: 'imported' as const };
    });
  }

  listProducts() {
    const rows = this.db.prepare(`SELECT pv.document FROM products p JOIN product_versions pv
      ON pv.product_id = p.id AND pv.version = p.current_version ORDER BY p.rowid`).all() as DocumentRow[];
    return rows.map(row => {
      const product = JSON.parse(row.document) as ProductDocument;
      return { productId: product.productId, name: product.name, version: product.version, dataKind: product.dataKind,
        recommendation: product.recommendation ?? null };
    });
  }

  recommendationProducts(dataKind: ProductDocument['dataKind']) {
    return this.listProducts().filter(product => product.dataKind === dataKind && product.recommendation)
      .map(product => this.getKnowledge(product.productId))
      .filter(product => Boolean(product.recommendation?.sourceId && product.facts.some(fact => fact.sourceId === product.recommendation!.sourceId)));
  }

  priorClarifications(sessionId: string, skillId: string) {
    const rows = this.db.prepare(`SELECT route_json AS route, result_json AS result FROM consultation_runs
      WHERE session_id=? AND state='completed' ORDER BY created_at DESC LIMIT 6`).all(sessionId) as { route: string | null; result: string | null }[];
    let count = 0;
    for (const row of rows) {
      const route = row.route ? JSON.parse(row.route) as { rawAnswers?: { primary_skill?: { choice?: string } }; primarySkill?: string | null } : null;
      const result = row.result ? JSON.parse(row.result) as { status?: string } : null;
      if (result?.status !== 'clarification_required' || (route?.rawAnswers?.primary_skill?.choice ?? route?.primarySkill) !== skillId) break;
      count++;
    }
    return count;
  }

  getProduct(productId: string): ProductDocument {
    const row = this.db.prepare(`SELECT pv.document FROM products p JOIN product_versions pv
      ON pv.product_id = p.id AND pv.version = p.current_version WHERE p.id = ?`).get(productId) as DocumentRow | undefined;
    if (!row) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    return JSON.parse(row.document) as ProductDocument;
  }

  getKnowledge(productId: string) {
    const product = this.getProduct(productId);
    const facts = product.facts.filter(fact => fact.reviewStatus === 'approved');
    const sourceIds = new Set(facts.map(fact => fact.sourceId));
    return { ...product, facts, sources: product.sources.filter(source => sourceIds.has(source.sourceId)),
      status: facts.length ? 'available' : 'insufficient_evidence' };
  }

  importComments(input: unknown) {
    const batch = commentBatchSchema.parse(input);
    const digest = hash(batch);
    return this.transaction(() => {
      const product = this.getProduct(batch.productId);
      if (product.dataKind !== batch.dataKind) throw new AppError(409, 'DATA_KIND_CONFLICT', 'Comment dataKind must match the product.');
      const previous = this.db.prepare('SELECT digest FROM comment_batches WHERE id = ?').get(batch.batchId) as { digest: string } | undefined;
      if (previous) {
        if (previous.digest !== digest) throw new AppError(409, 'BATCH_CONFLICT', 'Batch ID already exists with different data');
        return { batchId: batch.batchId, imported: 0, skipped: batch.comments.length, total: batch.comments.length };
      }
      this.db.prepare('INSERT INTO comment_batches VALUES (?, ?, ?, ?, ?)')
        .run(batch.batchId, batch.productId, JSON.stringify(batch), digest, now());
      let imported = 0;
      let skipped = 0;
      for (const comment of batch.comments) {
        const source = batch.sources.find(item => item.sourceId === comment.sourceRef)!;
        const document = { ...comment, source, dataKind: batch.dataKind };
        const commentDigest = hash(document);
        const existing = this.db.prepare('SELECT digest FROM comments WHERE product_id = ? AND id = ?')
          .get(batch.productId, comment.commentId) as { digest: string } | undefined;
        if (existing) {
          if (existing.digest !== commentDigest) throw new AppError(409, 'COMMENT_CONFLICT', `Comment ${comment.commentId} already exists with different text, labels or source`);
          skipped++;
        } else {
          this.db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?)')
            .run(batch.productId, comment.commentId, batch.batchId, JSON.stringify(document), commentDigest);
          imported++;
        }
      }
      return { batchId: batch.batchId, imported, skipped, total: batch.comments.length };
    });
  }

  listComments(productId: string, limit: number, offset: number) {
    this.getProduct(productId);
    const rows = this.db.prepare('SELECT batch_id AS batchId, document FROM comments WHERE product_id = ? ORDER BY id LIMIT ? OFFSET ?')
      .all(productId, limit, offset) as (DocumentRow & { batchId: string })[];
    const count = this.db.prepare('SELECT count(*) AS total FROM comments WHERE product_id = ?').get(productId) as { total: number };
    return { ...count, limit, offset, items: rows.map(row => ({ ...JSON.parse(row.document), batchId: row.batchId })) };
  }

  createUser(input: unknown) {
    const value = createUserSchema.parse(input);
    const userId = value.userId ?? randomUUID();
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) throw new AppError(409, 'USER_EXISTS', 'User ID already exists');
      const createdAt = now();
      const card: Card = { userId, confirmedFacts: {}, preferences: [], concerns: [], version: 0, updatedAt: createdAt };
      this.db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(userId, value.displayName, createdAt);
      this.db.prepare('INSERT INTO cards VALUES (?, ?, ?)').run(userId, JSON.stringify(card), 0);
      this.db.prepare('INSERT INTO card_revisions VALUES (?, ?, ?)').run(userId, 0, JSON.stringify(card));
      return { userId, displayName: value.displayName, createdAt };
    });
  }

  listUsers() {
    return this.db.prepare('SELECT id AS userId, display_name AS displayName, created_at AS createdAt FROM users ORDER BY created_at, id').all();
  }

  getCard(userId: string): Card {
    const row = this.db.prepare('SELECT document FROM cards WHERE user_id = ?').get(userId) as DocumentRow | undefined;
    if (!row) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    return JSON.parse(row.document) as Card;
  }

  updateCard(userId: string, input: unknown) {
    const patch = cardPatchSchema.parse(input);
    return this.transaction(() => {
      const current = this.getCard(userId);
      if (current.version !== patch.expectedVersion) throw new AppError(409, 'CARD_VERSION_CONFLICT', 'Card changed. Reload before saving.');
      for (const fact of Object.values(patch.confirmedFacts ?? {})) {
        if (!fact.sourceMessageId) continue;
        const source = this.db.prepare(`SELECT m.role FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.id = ? AND s.user_id = ?`).get(fact.sourceMessageId, userId) as { role: string } | undefined;
        if (!source || source.role !== 'user') throw new AppError(422, 'INVALID_FACT_SOURCE', 'A confirmed fact must reference this user\'s message or use null for manual confirmation.');
      }
      const updated: Card = {
        userId,
        confirmedFacts: patch.confirmedFacts ?? current.confirmedFacts,
        preferences: patch.preferences ?? current.preferences,
        concerns: patch.concerns ?? current.concerns,
        version: current.version + 1,
        updatedAt: now(),
      };
      this.db.prepare('UPDATE cards SET document = ?, version = ? WHERE user_id = ?')
        .run(JSON.stringify(updated), updated.version, userId);
      this.db.prepare('INSERT INTO card_revisions VALUES (?, ?, ?)').run(userId, updated.version, JSON.stringify(updated));
      return updated;
    });
  }

  createSession(userId: string, productId: string) {
    this.getCard(userId);
    this.getProduct(productId);
    const session: SessionRow = { sessionId: randomUUID(), userId, productId, status: 'AI_ACTIVE', stateVersion: 0, createdAt: now() };
    this.db.prepare('INSERT INTO sessions (id, user_id, product_id, created_at) VALUES (?, ?, ?, ?)')
      .run(session.sessionId, userId, productId, session.createdAt);
    return session;
  }

  listSessions(userId: string) {
    this.getCard(userId);
    return this.db.prepare(`SELECT id AS sessionId, user_id AS userId, product_id AS productId,
      status, state_version AS stateVersion, created_at AS createdAt FROM sessions WHERE user_id = ? ORDER BY created_at, id`).all(userId);
  }

  getSession(userId: string, sessionId: string): SessionRow {
    const row = this.db.prepare(`SELECT id AS sessionId, user_id AS userId, product_id AS productId,
      status, state_version AS stateVersion, created_at AS createdAt FROM sessions WHERE id = ? AND user_id = ?`)
      .get(sessionId, userId) as SessionRow | undefined;
    if (!row) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found for this user');
    return row;
  }

  listMessages(userId: string, sessionId: string, limit: number, offset: number) {
    this.getSession(userId, sessionId);
    const total = this.db.prepare('SELECT count(*) AS total FROM messages WHERE session_id = ?').get(sessionId) as { total: number };
    const rows = this.db.prepare(`SELECT id AS messageId, request_id AS requestId, role, content, created_at AS createdAt, metadata
      FROM messages WHERE session_id = ? ORDER BY sequence LIMIT ? OFFSET ?`).all(sessionId, limit, offset) as (MessageRow & { metadata: string })[];
    return { ...total, limit, offset, items: rows.map(row => ({ ...row, metadata: JSON.parse(row.metadata) })) };
  }

  appendUserMessage(userId: string, sessionId: string, input: unknown) {
    const value = userMessageSchema.parse(input);
    return this.transaction(() => {
      this.getSession(userId, sessionId);
      const previous = this.db.prepare(`SELECT id AS messageId, request_id AS requestId, role, content, created_at AS createdAt
        FROM messages WHERE session_id = ? AND request_id = ?`).get(sessionId, value.requestId) as MessageRow | undefined;
      if (previous) {
        if (previous.content !== value.content || previous.role !== 'user') throw new AppError(409, 'REQUEST_CONFLICT', 'requestId already used for a different message or role');
        return { message: previous, duplicate: true, processing: 'not_implemented' as const };
      }
      const message: MessageRow = { messageId: randomUUID(), requestId: value.requestId, role: 'user', content: value.content, createdAt: now() };
      this.db.prepare('INSERT INTO messages (id, session_id, request_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(message.messageId, sessionId, message.requestId, message.role, message.content, message.createdAt);
      return { message, duplicate: false, processing: 'not_implemented' as const };
    });
  }

  getContext(userId: string, sessionId: string) {
    const session = this.getSession(userId, sessionId);
    const latest = this.db.prepare(`SELECT id AS messageId, request_id AS requestId, role, content, created_at AS createdAt
      FROM messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 20`).all(sessionId) as MessageRow[];
    return { session, card: this.getCard(userId), recentMessages: latest.reverse() };
  }
}
