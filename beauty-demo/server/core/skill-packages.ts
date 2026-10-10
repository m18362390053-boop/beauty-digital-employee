import { createHash } from 'node:crypto';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { Store } from '../storage/store.js';
import { AppError } from './errors.js';
import { idSchema } from '../contracts/index.js';
import { businessConfigSchema, businessSkillSchema, skillVersionSchema, type BusinessConfig, type BusinessSkill } from './workflow-types.js';

export const uploadSchema = z.object({
  filename: z.string().min(1).max(200), content: z.string().min(1).max(3_000_000), encoding: z.enum(['utf8', 'base64']).default('utf8'),
  overrides: z.object({ id: idSchema.optional(), description: z.string().max(2_000).optional(), version: skillVersionSchema.optional(),
    intents: z.array(idSchema).min(1).optional(), requiresKnowledge: z.boolean().optional() }).strict().default({}),
}).strict();
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function markdown(text: string) {
  const clean = text.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(clean);
  if (!match) return { attributes: {} as Record<string, unknown>, body: clean.trim(), rawBody: clean };
  let attributes: unknown;
  try { attributes = parseYaml(match[1]!, { maxAliasCount: 20, uniqueKeys: true }); }
  catch { throw new AppError(422, 'INVALID_SKILL_HEADER', 'SKILL.md开头的YAML格式无效。'); }
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) throw new AppError(422, 'INVALID_SKILL_HEADER', 'YAML头必须是对象。');
  return { attributes: attributes as Record<string, unknown>, body: match[2]!.trim(), rawBody: match[2]! };
}

export function parseSkillUpload(input: unknown): BusinessSkill {
  const value = uploadSchema.parse(input);
  let definition: Record<string, unknown> = {};
  let instructions = '';
  let knowledge: { title: string; content: string }[] = [];
  const suffix = value.filename.toLowerCase().split('.').pop();
  if (suffix === 'zip') {
    if (value.encoding !== 'base64' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.content)) throw new AppError(422, 'INVALID_ZIP', 'ZIP请以base64上传。');
    const compressed = Buffer.from(value.content, 'base64');
    if (compressed.length > 2_000_000) throw new AppError(413, 'SKILL_TOO_LARGE', 'ZIP压缩文件最大2MB。');
    let total = 0; let count = 0;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(compressed, { filter: file => {
        count++; total += file.originalSize;
        if (count > 40 || total > 512_000 || file.originalSize > 200_000) throw new Error('archive limits');
        if (file.name.includes('\\') || file.name.startsWith('/') || file.name.split('/').includes('..') || file.name.includes(':') || file.name.includes('\0')) throw new Error('unsafe path');
        if (file.name.endsWith('/')) return false;
        if (/\.(png|jpg|jpeg|webp|svg)$/i.test(file.name) && file.name.includes('assets/')) return false;
        if (!/\.(md|txt|json)$/i.test(file.name)) throw new Error('unsupported file');
        return true;
      } });
    } catch { throw new AppError(422, 'INVALID_SKILL_ZIP', 'ZIP损坏、超出解压限额、包含不安全路径或不支持的文件。只接收声明式说明和知识文档，不执行脚本。'); }
    const entries = Object.entries(files);
    const skillFiles = entries.filter(([name]) => /(^|\/)SKILL\.md$/i.test(name));
    if (skillFiles.length !== 1) throw new AppError(422, 'SKILL_MD_REQUIRED', 'ZIP中需要且只能有一个SKILL.md。');
    const [skillPath, skillBytes] = skillFiles[0]!;
    const root = skillPath.slice(0, skillPath.lastIndexOf('/') + 1);
    if (entries.some(([path]) => !path.startsWith(root))) throw new AppError(422, 'INVALID_SKILL_ZIP', '文件必须位于同一个Skill根目录。');
    const md = markdown(strFromU8(skillBytes)); definition = md.attributes; instructions = md.body;
    const manifest = files[`${root}manifest.json`];
    if (manifest) {
      try { const parsed: unknown = JSON.parse(strFromU8(manifest)); definition = { ...definition, ...z.record(z.unknown()).parse(parsed) }; }
      catch { throw new AppError(422, 'INVALID_MANIFEST', 'manifest.json必须是有效JSON对象。'); }
    }
    const preserveText = definition.contentFormat === 'beauty-skill-v1';
    if (preserveText) instructions = md.rawBody;
    const titles = definition.knowledgeTitles === undefined ? {} : z.record(z.string().max(200)).parse(definition.knowledgeTitles);
    knowledge = entries.filter(([path]) => /^(knowledge|references)\/.+\.(md|txt)$/i.test(path.slice(root.length)))
      .map(([path, bytes]) => ({ title: titles[path.slice(root.length)] ?? path.slice(root.length), content: preserveText ? strFromU8(bytes) : strFromU8(bytes).trim() }));
  } else if (suffix === 'md') {
    if (value.encoding !== 'utf8') throw new AppError(422, 'INVALID_ENCODING', 'Markdown使用UTF-8文本上传。');
    const md = markdown(value.content); definition = md.attributes; instructions = md.body;
  } else if (suffix === 'json') {
    try { definition = z.record(z.unknown()).parse(JSON.parse(value.content)); }
    catch { throw new AppError(422, 'INVALID_SKILL_JSON', 'Skill JSON格式无效。'); }
    instructions = typeof definition.instructions === 'string' ? definition.instructions : '';
    knowledge = definition.knowledge as typeof knowledge ?? [];
  } else throw new AppError(422, 'UNSUPPORTED_SKILL_FORMAT', '支持SKILL.md、Skill JSON或ZIP包。');
  const metadata: Record<string, unknown> = { ...definition, ...value.overrides };
  const name = metadata.id ?? metadata.slug ?? metadata.name;
  if (!idSchema.safeParse(name).success) throw new AppError(422, 'SKILL_ID_REQUIRED', '请填写Skill ID（英文、数字、下划线或短横线），或在文件中提供name/id。');
  const parsed = businessSkillSchema.parse({
    id: name, version: metadata.version === undefined ? `import-${digest(JSON.stringify({ metadata, instructions, knowledge }))}` : String(metadata.version),
    description: metadata.description, instructions, knowledge,
    intents: metadata.intents ?? ['product_advice'], knowledgeScopes: metadata.knowledgeScopes ?? ['product'],
    requiredFields: metadata.requiredFields ?? [], requiresKnowledge: metadata.requiresKnowledge ?? false,
    recommendation: metadata.recommendation,
  });
  if (parsed.knowledge.reduce((sum, item) => sum + item.content.length, 0) > 120_000) throw new AppError(413, 'KNOWLEDGE_TOO_LARGE', '每个Skill知识正文总计最多120000字符。');
  return parsed;
}

export class SkillPackages {
  constructor(private store: Store, private baseline: BusinessConfig) {}
  private saved() {
    return (this.store.db.prepare('SELECT id,document,enabled,updated_at FROM skill_packages ORDER BY id').all() as { id: string; document: string; enabled: number; updated_at: string }[])
      .map(row => ({ skill: businessSkillSchema.parse(JSON.parse(row.document)), enabled: row.enabled === 1, updatedAt: row.updated_at }));
  }
  list() {
    const map = new Map(this.baseline.skills.map(skill => [skill.id, { skill, enabled: true, origin: 'built-in', updatedAt: null as string | null }]));
    for (const saved of this.saved()) map.set(saved.skill.id, { ...saved, origin: 'uploaded' });
    return [...map.values()];
  }
  config() {
    const skills = this.list().filter(item => item.enabled).map(item => item.skill);
    const fingerprint = digest(JSON.stringify(skills));
    return businessConfigSchema.parse({ ...this.baseline, version: `${this.baseline.version.slice(0, 70)}-${fingerprint}`, skills });
  }
  import(input: unknown) {
    const skill = parseSkillUpload(input);
    const current = this.list();
    const next = [...current.filter(item => item.skill.id !== skill.id && item.enabled).map(item => item.skill), skill];
    businessConfigSchema.parse({ ...this.baseline, skills: next });
    const json = JSON.stringify(skill); const db = this.store.db;
    const stored = db.prepare('SELECT document FROM skill_package_versions WHERE id=? AND version=?').get(skill.id, skill.version) as { document: string } | undefined;
    const builtin = this.baseline.skills.find(s => s.id === skill.id && s.version === skill.version);
    const previous = stored ?? (builtin ? { document: JSON.stringify(builtin) } : undefined);
    if (previous && previous.document !== json) throw new AppError(409, 'SKILL_VERSION_CONFLICT', '同一Skill版本已有不同内容，请修改version再上传。');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO skill_package_versions VALUES(?,?,?,?)').run(skill.id, skill.version, json, new Date().toISOString());
      db.prepare('INSERT INTO skill_packages VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,enabled=1,updated_at=excluded.updated_at')
        .run(skill.id, json, new Date().toISOString());
      db.prepare('INSERT INTO skill_audit(skill_id,version,action,created_at) VALUES(?,?,?,?)').run(skill.id, skill.version, 'import_and_enable', new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { skill, enabled: true, status: 'imported', policyVersion: this.config().version };
  }
  enable(id: string, enabled: boolean) {
    const item = this.list().find(item => item.skill.id === id);
    if (!item) throw new AppError(404, 'SKILL_NOT_FOUND', 'Skill不存在。');
    const next = this.list().filter(row => row.skill.id === id ? enabled : row.enabled).map(row => row.skill);
    businessConfigSchema.parse({ ...this.baseline, skills: next });
    this.store.db.prepare('INSERT INTO skill_packages VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at')
      .run(id, JSON.stringify(item.skill), enabled ? 1 : 0, new Date().toISOString());
    this.store.db.prepare('INSERT INTO skill_audit(skill_id,version,action,created_at) VALUES(?,?,?,?)').run(id, item.skill.version, enabled ? 'enable' : 'disable', new Date().toISOString());
    return { id, enabled, policyVersion: this.config().version };
  }
  private versionDocuments(id: string) {
    const map = new Map<string, { skill: BusinessSkill; origin: string; createdAt: string | null }>();
    const builtin = this.baseline.skills.find(s => s.id === id);
    if (builtin) map.set(builtin.version, { skill: builtin, origin: 'built-in', createdAt: null });
    const saved = this.saved().find(row => row.skill.id === id);
    if (saved && !map.has(saved.skill.version)) map.set(saved.skill.version, { skill: saved.skill, origin: 'stored', createdAt: saved.updatedAt });
    const rows = this.store.db.prepare('SELECT document,created_at FROM skill_package_versions WHERE id=? ORDER BY created_at').all(id) as { document: string; created_at: string }[];
    for (const row of rows) { const skill = businessSkillSchema.parse(JSON.parse(row.document)); map.set(skill.version, { skill, origin: 'uploaded', createdAt: row.created_at }); }
    if (!map.size) throw new AppError(404, 'SKILL_NOT_FOUND', 'Skill不存在。');
    return map;
  }
  versions(id: string) {
    const current = this.list().find(row => row.skill.id === id);
    return { items: [...this.versionDocuments(id).values()].map(item => ({ version: item.skill.version, origin: item.origin, createdAt: item.createdAt,
      active: item.skill.version === current?.skill.version, enabled: current?.enabled ?? false, contentHash: digest(JSON.stringify(item.skill)) })),
      audit: this.store.db.prepare('SELECT version,action,created_at AS createdAt FROM skill_audit WHERE skill_id=? ORDER BY sequence DESC LIMIT 50').all(id) };
  }
  document(id: string, version: string) {
    const entry = this.versionDocuments(id).get(version);
    if (!entry) throw new AppError(404, 'SKILL_VERSION_NOT_FOUND', 'Skill版本不存在。');
    const { instructions, knowledge, ...manifest } = entry.skill;
    const markdown = `---\n${stringifyYaml({ name: manifest.id, ...manifest }).trim()}\n---\n${instructions}`;
    return { ...entry, manifest, markdown, knowledge, contentHash: digest(JSON.stringify(entry.skill)) };
  }
  exportVersion(id: string, version: string) {
    const doc = this.document(id, version);
    const files: Record<string, Uint8Array> = { 'SKILL.md': strToU8(doc.markdown) };
    const titles: Record<string, string> = {};
    for (const [i, item] of doc.knowledge.entries()) { const path = `knowledge/document-${i + 1}.md`; titles[path] = item.title; files[path] = strToU8(item.content); }
    files['manifest.json'] = strToU8(JSON.stringify({ ...doc.manifest, knowledgeTitles: titles, contentFormat: 'beauty-skill-v1' }, null, 2));
    return zipSync(files);
  }
  activate(id: string, version: string, expectedCurrentVersion: string) {
    const current = this.list().find(row => row.skill.id === id);
    if (!current || current.skill.version !== expectedCurrentVersion) throw new AppError(409, 'SKILL_CHANGED', '当前版本已变化，请刷新后再切换。');
    const doc = this.document(id, version);
    businessConfigSchema.parse({ ...this.baseline, skills: [...this.config().skills.filter(s => s.id !== id), doc.skill] });
    const db = this.store.db; db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO skill_package_versions VALUES(?,?,?,?)').run(id, version, JSON.stringify(doc.skill), new Date().toISOString());
      db.prepare('INSERT INTO skill_packages VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,enabled=1,updated_at=excluded.updated_at')
        .run(id, JSON.stringify(doc.skill), new Date().toISOString());
      db.prepare('INSERT INTO skill_audit(skill_id,version,action,created_at) VALUES(?,?,?,?)').run(id, version, 'activate_version', new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { id, version, enabled: true, policyVersion: this.config().version };
  }
  static template() {
    return zipSync({
      'manifest.json': strToU8(JSON.stringify({ id: 'beauty-usage-guide', version: 'v1', description: '基础护肤使用顺序咨询，依据随包知识回答', intents: ['product_advice'], knowledgeScopes: ['product'], requiresKnowledge: true }, null, 2)),
      'SKILL.md': strToU8('# 使用顺序助手\n用户询问本套演示产品使用顺序时，依据knowledge中的说明回答，并引用来源。不要承诺功效或编造价格。'),
      'knowledge/guide.md': strToU8('# 演示产品组合说明\n本文件为业务编辑格式示例，不是真实商品说明。演示套装的顺序为：清洁、演示精华、演示面霜。若用户询问真实产品，应先核实对应官方资料。'),
    });
  }
}
