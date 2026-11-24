// API админки: заявки для HR, тексты и картинки для маркетолога, статистика.
// Тот же сервер, тот же node:sqlite, ноль зависимостей.
//
// Авторизация — сессии на HTTP-only cookie. Пользователи в таблице users, пароли в scrypt.
// Роли: admin (всё), hr (вакансии, отклики, HH), marketing (тексты, фото, метрика), viewer (только чтение).
// Проверка роли — в одном месте (requireRole), чтобы не забыть её на новой ручке. Забытая проверка = дыра.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { syncHH, authUrl, exchangeCode, hhStatus } from './hh.mjs';
import { json, readJson, readMultipart } from './http.mjs';

const DB_PATH = process.env.DB_PATH ?? './data/steklyanika.db';
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './data/uploads';
const MEDIA_DIR = process.env.MEDIA_DIR ?? './data/media';
const SESSION_TTL = 8 * 3600_000; // 8 часов. Дольше держать сессию в админке с персданными — плохая идея

mkdirSync(MEDIA_DIR, { recursive: true });
// Каталог под базу может отличаться от каталога медиа (DB_PATH настраивается отдельно)
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  -- Пользователи админки. Пароль — scrypt с солью, в открытом виде не хранится нигде.
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT,
    pass_hash   TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'viewer', -- admin | hr | marketing | viewer
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    last_login  TEXT
  );

  -- Сессии. Храним хеш токена, а не сам токен: утечка базы не даст войти по чужим сессиям.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    ip_hash     TEXT
  );

  -- Вакансии. Зеркало src/content/vacancies/*.json для быстрого поиска и статусов.
  -- Источник правды для сайта — файл в репозитории, но HR не должен ждать сборки, чтобы увидеть отклики.
  CREATE TABLE IF NOT EXISTS vacancies (
    slug        TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open', -- open | paused | closed
    hh_url      TEXT,
    updated_at  TEXT NOT NULL
  );

  -- Отклики с HH.ru и с сайта. external_id нужен для идемпотентности:
  -- HH отдаёт одно и то же объявление в нескольких коллекциях, без ключа получим дубли.
  CREATE TABLE IF NOT EXISTS applications (
    id           TEXT PRIMARY KEY,
    vacancy_slug TEXT,
    source       TEXT NOT NULL DEFAULT 'site', -- site | hh
    external_id  TEXT,
    name         TEXT,
    contact      TEXT,
    resume_url   TEXT,
    message      TEXT,
    status       TEXT NOT NULL DEFAULT 'new',  -- new | screened | invited | rejected | hired
    hh_status    TEXT,
    created_at   TEXT NOT NULL,
    synced_at    TEXT,
    UNIQUE(source, external_id)
  );
  CREATE INDEX IF NOT EXISTS app_created ON applications(created_at DESC);

  -- Медиатека маркетолога. Файл на диске, метаданные тут.
  CREATE TABLE IF NOT EXISTS media (
    id          TEXT PRIMARY KEY,
    stored_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime        TEXT,
    size        INTEGER,
    width       INTEGER,
    height      INTEGER,
    alt         TEXT,
    folder      TEXT DEFAULT '/',
    uploaded_by TEXT,
    created_at  TEXT NOT NULL
  );

  -- Черновики текстов. Правки маркетолога не уходят на сайт сразу:
  -- сборка читает только подтверждённые, иначе опечатка в тексте = сломанный прод.
  CREATE TABLE IF NOT EXISTS texts (
    key         TEXT PRIMARY KEY,   -- например home.hero.title
    value       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft', -- draft | published
    updated_by  TEXT,
    updated_at  TEXT NOT NULL
  );

  -- Кэш статистики. Не дёргаем API Метрики на каждый показ дашборда:
  -- лимиты и латентность, плюс заказчик отвалится ждать.
  CREATE TABLE IF NOT EXISTS stats_cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
//  Доводим leads до рабочей таблицы: заявка с сайта — это только начало.
//  Дальше её надо превратить в сделку: объект, сумма, кто ведёт, когда менялась.
//  ALTER TABLE ADD COLUMN в SQLite безопасен для непустой базы: старые строки получат NULL,
//  и повторный запуск не упадёт (ошибку «duplicate column» глушим — это идемпотентная миграция)
// ─────────────────────────────────────────────────────────────────────────────
const leadColumns = [
  ['object', 'TEXT'],            // объект: ЖК, адрес, название — по нему ищут и группируют
  ['amount', 'INTEGER'],         // сумма сделки в рублях. Копейки в заявках не нужны
  ['assigned_to', 'TEXT'],       // чей клиент. Пусто — значит никто не взял, и это видно в фильтре
  ['updated_at', 'TEXT'],        // когда последний раз трогали: по нему сортировка «свежие сверху»
];
for (const [col, type] of leadColumns) {
  try {
    db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${type}`);
  } catch {
    // колонка уже есть — нормальный случай на второй и последующих запусках
  }
}

const now = () => new Date().toISOString();

// ---------- Пароли ----------
// scrypt, а не sha256: намеренно медленный, перебор по словарю становится дорогим.
// Параметры по умолчанию Node (N=16384) для админки более чем достаточны.
function hashPass(pass) {
  const salt = randomBytes(16);
  const key = scryptSync(pass, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function checkPass(pass, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex || !keyHex) return false;
  const key = scryptSync(pass, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  // timingSafeEqual, а не ===: обычное сравнение по строке можно прощупать по времени ответа
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ---------- Сессии ----------
const hashToken = (t) => createHash('sha256').update(t).digest('hex');

function parseCookies(req) {
  const raw = String(req.headers.cookie ?? '');
  return Object.fromEntries(
    raw.split(';').map((p) => p.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

export function currentUser(req) {
  const token = parseCookies(req)['stk_session'];
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.email, u.name, u.role FROM sessions s
                          JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`)
    .get(hashToken(token), now());
  return row ?? null;
}

function requireRole(req, res, roles) {
  const user = currentUser(req);
  if (!user) { json(res, 401, { ok: false, error: 'unauthorized' }); return null; }
  // admin проходит везде: иначе придётся перечислять его в каждой ручке и однажды забыть
  if (user.role !== 'admin' && !roles.includes(user.role)) {
    json(res, 403, { ok: false, error: 'forbidden' });
    return null;
  }
  return user;
}

// ---------- Ручки админки ----------

export const adminRoutes = {
  // POST /api/admin/login
  async 'POST /api/admin/login'(req, res) {
    const { email, password } = await readJson(req);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email ?? '').trim().toLowerCase());

    // Одинаковый ответ на «нет такого» и «пароль не тот»: иначе логин превращается в справочник сотрудников
    if (!user || !checkPass(String(password ?? ''), user.pass_hash)) {
      return json(res, 401, { ok: false, error: 'bad_credentials' });
    }

    const token = randomBytes(32).toString('base64url');
    const exp = new Date(Date.now() + SESSION_TTL).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip_hash) VALUES (?,?,?,?,?)')
      .run(hashToken(token), user.id, now(), exp, '');
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now(), user.id);

    // HttpOnly — чтобы токен не утащили через XSS. SameSite=Strict — чтобы не прилетел с чужого сайта.
    // Secure привязан к NODE_ENV, а не к реальной схеме запроса. Если поставить production на локальном
    // http, браузер выбросит cookie и человек застрянет на форме входа без единой ошибки!!
    return json(res, 200, { ok: true, user: { id: user.id, name: user.name, role: user.role } }, {
      'Set-Cookie': `stk_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    });
  },

  // POST /api/admin/logout
  async 'POST /api/admin/logout'(req, res) {
    const token = parseCookies(req)['stk_session'];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'stk_session=; HttpOnly; Path=/; Max-Age=0' });
  },

  // GET /api/admin/me
  async 'GET /api/admin/me'(req, res) {
    const user = currentUser(req);
    return user ? json(res, 200, { ok: true, user }) : json(res, 401, { ok: false });
  },

  // ---------- Заявки (HR + admin) ----------

  // POST /api/admin/leads — завести заявку руками.
  // Нужно, когда клиент позвонил, а не заполнил форму: иначе такие обращения живут
  // в блокноте и в CRM их просто нет
  async 'POST /api/admin/leads'(req, res) {
    const user = requireRole(req, res, ['hr', 'marketing']);
    if (!user) return;
    const b = await readJson(req);
    if (!b.name || !b.contact) return json(res, 400, { ok: false, error: 'name_and_contact_required' });

    const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
    const id = randomUUID();
    db.prepare(`INSERT INTO leads (id, created_at, updated_at, source, name, contact, payload, status, comment, object, amount, assigned_to)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id, now(), now(),
        'manual',                                  // отдельный источник: сразу видно, что завёл человек
        clip(b.name, 200) ?? '',
        clip(b.contact, 200) ?? '',
        JSON.stringify({ manual: true, by: user.email }),
        'new',
        clip(b.comment, 4000),
        clip(b.object, 300),
        Number.isFinite(Number(b.amount)) && Number(b.amount) > 0 ? Math.round(Number(b.amount)) : null,
        clip(b.assigned_to, 120) ?? user.email,
      );
    return json(res, 201, { ok: true, id });
  },

  // DELETE /api/admin/leads/:id — удаление только для админа.
  // Это персональные данные: менеджеру давать кнопку «стереть заявку» нельзя,
  // иначе пропадёт след обращения, а по 152-ФЗ его надо хранить и уметь показать
  async 'DELETE /api/admin/leads/:id'(req, res, url, params) {
    const user = requireRole(req, res, ['admin']);
    if (!user) return;
    const hit = db.prepare('DELETE FROM leads WHERE id = ?').run(params.id);
    if (!hit.changes) return json(res, 404, { ok: false, error: 'not_found' });
    return json(res, 200, { ok: true });
  },

  // GET /api/admin/leads/export — выгрузка CSV для Excel.
  // Разделитель «;» и BOM в начале: без этого русский Excel открывает файл одной колонкой
  // и с кракозябрами вместо кириллицы. Проверено на живых людях
  async 'GET /api/admin/leads/export'(req, res, url) {
    const user = requireRole(req, res, ['hr', 'marketing']);
    if (!user) return;
    const rows = db.prepare(`SELECT created_at, source, name, contact, object, status, amount, assigned_to, comment
                             FROM leads ORDER BY COALESCE(updated_at, created_at) DESC`).all();
    const head = ['Дата', 'Источник', 'Имя', 'Контакт', 'Объект', 'Статус', 'Сумма', 'Ответственный', 'Заметка'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;  // кавычки внутри поля удваиваем
    const csv = [head, ...rows.map((r) => [r.created_at, r.source, r.name, r.contact, r.object,
      r.status, r.amount, r.assigned_to, r.comment])]
      .map((line) => line.map(cell).join(';')).join('\r\n');

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="leads.csv"',
      // no-store: в файле персданные, кэшировать его в браузере или прокси нельзя
      'Cache-Control': 'no-store',
    });
    return res.end('\uFEFF' + csv);
  },

  // GET /api/admin/counters — только цифры для бейджей на вкладках.
  // Отдельная ручка, потому что кабинет опрашивает её по таймеру: тянуть за собой полные
  // списки заявок на каждый тик — это мегабайты впустую
  async 'GET /api/admin/counters'(req, res) {
    const user = requireRole(req, res, ['hr', 'marketing']);
    if (!user) return;
    const one = (sql) => db.prepare(sql).get()?.n ?? 0;
    return json(res, 200, {
      ok: true,
      leads_new: one("SELECT COUNT(*) n FROM leads WHERE status = 'new'"),
      apps_new: one("SELECT COUNT(*) n FROM applications WHERE status = 'new'"),
      // «Свежие» — за сутки. По ним видно, случилось ли что-то с момента прошлого захода
      leads_today: one("SELECT COUNT(*) n FROM leads WHERE created_at >= datetime('now', '-1 day')"),
    });
  },

  // GET /api/admin/leads?status=new&source=resume&q=поиск
  async 'GET /api/admin/leads'(req, res, url) {
    if (!requireRole(req, res, ['hr', 'marketing'])) return;
    const status = url.searchParams.get('status');
    const source = url.searchParams.get('source');
    const q = url.searchParams.get('q');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);

    // Собираем WHERE по кусочкам — так не надо писать шесть вариантов одного запроса
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (source) { where.push('source = ?'); args.push(source); }
    // Ищем и по объекту: менеджер помнит «тот ЖК на Ярославке», а не фамилию
    if (q) { where.push('(name LIKE ? OR contact LIKE ? OR object LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    // payload тянем в список, а не отдельной ручкой: заявок десятки, не тысячи, и лишний круг
    // до сервера на каждый клик по карточке тут дороже, чем 30 лишних килобайт в ответе.
    // ip_hash наружу отдаём, потому что по нему ловятся дубли и спам с одной машины
    // Сортировка по updated_at, а не created_at: в таблице важно, что двигалось последним.
    // COALESCE — потому что у старых строк updated_at пустой после миграции
    const sql = `SELECT id, created_at, updated_at, source, name, contact, status, comment, page,
                        payload, ip_hash, user_agent, object, amount, assigned_to
                 FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`;
    args.push(limit);
    return json(res, 200, { ok: true, items: db.prepare(sql).all(...args) });
  },

  // PATCH /api/admin/leads/:id — сменить статус и/или дописать комментарий
  async 'PATCH /api/admin/leads/:id'(req, res, url, params) {
    // Роли те же, что у вкладки заявок в кабинете. Иначе маркетинг видит список, но не может
    // отметить спам — самая частая операция именно там
    const user = requireRole(req, res, ['hr', 'marketing']);
    if (!user) return;
    const b = await readJson(req);

    const allowed = ['new', 'in_progress', 'archived', 'spam'];
    if (b.status && !allowed.includes(b.status)) return json(res, 400, { ok: false, error: 'bad_status' });

    // Сумма приходит из input type=number — это может быть строка, пустая строка или мусор.
    // В базу пускаем только конечное неотрицательное число, иначе в отчётах появится NaN
    let amount = null;
    if (b.amount !== undefined && b.amount !== null && b.amount !== '') {
      const n = Number(String(b.amount).replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) return json(res, 400, { ok: false, error: 'bad_amount' });
      amount = Math.round(n);
    } else if (b.amount === '') {
      amount = 0;
    }

    // Обрезаем длину: поле ввода не должно уметь положить в базу мегабайт текста
    const clip = (v, n) => (v === undefined || v === null ? null : String(v).slice(0, n));

    db.prepare(`UPDATE leads SET
        status      = COALESCE(?, status),
        comment     = COALESCE(?, comment),
        object      = COALESCE(?, object),
        amount      = COALESCE(?, amount),
        assigned_to = COALESCE(?, assigned_to),
        updated_at  = ?
      WHERE id = ?`)
      .run(
        b.status ?? null,
        clip(b.comment, 4000),
        clip(b.object, 300),
        amount,
        clip(b.assigned_to, 120),
        now(),
        params.id,
      );
    return json(res, 200, { ok: true });
  },

  // ---------- Вакансии (HR) ----------

  async 'GET /api/admin/vacancies'(req, res) {
    if (!requireRole(req, res, ['hr'])) return;
    return json(res, 200, { ok: true, items: db.prepare('SELECT * FROM vacancies ORDER BY updated_at DESC').all() });
  },

  async 'PATCH /api/admin/vacancies/:slug'(req, res, url, params) {
    if (!requireRole(req, res, ['hr'])) return;
    const b = await readJson(req);
    const allowed = ['open', 'paused', 'closed'];
    if (b.status && !allowed.includes(b.status)) return json(res, 400, { ok: false, error: 'bad_status' });
    db.prepare(`UPDATE vacancies SET status = COALESCE(?, status), hh_url = COALESCE(?, hh_url), updated_at = ?
                WHERE slug = ?`).run(b.status ?? null, b.hh_url ?? null, now(), params.slug);
    return json(res, 200, { ok: true });
  },

  // ---------- Отклики ----------

  async 'GET /api/admin/applications'(req, res, url) {
    if (!requireRole(req, res, ['hr'])) return;
    const slug = url.searchParams.get('vacancy');
    const status = url.searchParams.get('status');
    const where = [];
    const args = [];
    if (slug) { where.push('vacancy_slug = ?'); args.push(slug); }
    if (status) { where.push('status = ?'); args.push(status); }
    const sql = `SELECT * FROM applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT 200`;
    return json(res, 200, { ok: true, items: db.prepare(sql).all(...args) });
  },

  async 'PATCH /api/admin/applications/:id'(req, res, url, params) {
    if (!requireRole(req, res, ['hr'])) return;
    const b = await readJson(req);
    const allowed = ['new', 'screened', 'invited', 'rejected', 'hired'];
    if (b.status && !allowed.includes(b.status)) return json(res, 400, { ok: false, error: 'bad_status' });
    db.prepare('UPDATE applications SET status = COALESCE(?, status) WHERE id = ?').run(b.status ?? null, params.id);
    return json(res, 200, { ok: true });
  },

  // ---------- HH (HR) ----------

  // GET /api/admin/hh/status — что с подключением, когда последняя синхронизация
  async 'GET /api/admin/hh/status'(req, res) {
    if (!requireRole(req, res, ['hr'])) return;
    return json(res, 200, { ok: true, ...hhStatus() });
  },

  // GET /api/admin/hh/auth — редирект на HH. Открывать в браузере под HR
  async 'GET /api/admin/hh/auth'(req, res) {
    if (!requireRole(req, res, ['hr'])) return;
    res.writeHead(302, { Location: authUrl() });
    res.end();
  },

  // GET /api/admin/hh/callback — HH возвращает сюда код
  async 'GET /api/admin/hh/callback'(req, res, url) {
    const code = url.searchParams.get('code');
    if (!code) return json(res, 400, { ok: false, error: 'no_code' });
    try {
      const r = await exchangeCode(code);
      // Отвечаем человекочитаемо: это открывается в браузере, не в fetch
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<p>HH подключён. Токен сохранён, можно закрыть вкладку и запускать синхронизацию в кабинете.</p>');
      return r;
    } catch (e) {
      return json(res, 502, { ok: false, error: String(e?.message ?? e) });
    }
  },

  // POST /api/admin/hh/sync — запустить синхронизацию руками.
  // Специально не по крону: каждый прогон может стоить денег по тарифу HH
  async 'POST /api/admin/hh/sync'(req, res) {
    if (!requireRole(req, res, ['hr'])) return;
    const result = await syncHH();
    return json(res, result.ok ? 200 : 502, { ok: result.ok, ...result });
  },

  // ---------- Тексты (маркетинг) ----------

  // GET /api/admin/texts — черновики и опубликованное разом, фронт сам решит, что показать
  async 'GET /api/admin/texts'(req, res) {
    if (!requireRole(req, res, ['marketing'])) return;
    return json(res, 200, { ok: true, items: db.prepare('SELECT * FROM texts ORDER BY key').all() });
  },

  async 'PUT /api/admin/texts/:key'(req, res, url, params) {
    const user = requireRole(req, res, ['marketing']);
    if (!user) return;
    const b = await readJson(req);
    // Ключ пускаем только вида home.hero.title: точка и латиница.
    // Иначе через кривой ключ можно дотянуться до чужих записей или сломать чтение на сборке
    if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(params.key)) return json(res, 400, { ok: false, error: 'bad_key' });
    db.prepare(`INSERT INTO texts (key, value, status, updated_by, updated_at) VALUES (?,?,?,?,?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, status = 'draft',
                updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(params.key, String(b.value ?? '').slice(0, 20_000), 'draft', user.email, now());
    return json(res, 200, { ok: true });
  },

  // Отдельная ручка публикации: черновик не должен уезжать на сайт случайно
  async 'POST /api/admin/texts/:key/publish'(req, res, url, params) {
    const user = requireRole(req, res, ['marketing']);
    if (!user) return;
    db.prepare(`UPDATE texts SET status = 'published', updated_by = ?, updated_at = ? WHERE key = ?`)
      .run(user.email, now(), params.key);
    return json(res, 200, { ok: true });
  },

  // ---------- Медиатека (маркетинг) ----------

  async 'GET /api/admin/media'(req, res) {
    if (!requireRole(req, res, ['marketing', 'hr'])) return;
    return json(res, 200, { ok: true, items: db.prepare('SELECT * FROM media ORDER BY created_at DESC LIMIT 200').all() });
  },

  // POST /api/admin/media — загрузка картинки. Видео отдельной ручкой, там свои лимиты
  async 'POST /api/admin/media'(req, res) {
    const user = requireRole(req, res, ['marketing']);
    if (!user) return;
    const { fields, file } = await readMultipart(req);
    if (!file) return json(res, 400, { ok: false, error: 'no_file' });

    const okMime = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml'];
    if (!okMime.includes(file.mime)) return json(res, 415, { ok: false, error: 'bad_type' });
    if (file.buf.length > 20 * 1024 * 1024) return json(res, 413, { ok: false, error: 'too_large' });

    const id = randomUUID();
    const stored = id + extname(file.name).toLowerCase();
    writeFileSync(join(MEDIA_DIR, stored), file.buf);
    db.prepare(`INSERT INTO media (id, stored_name, original_name, mime, size, alt, folder, uploaded_by, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, stored, basename(file.name).slice(0, 255), file.mime, file.buf.length, String(fields.alt ?? '').slice(0, 300), String(fields.folder ?? '/'), user.email, now());
    return json(res, 200, { ok: true, id, url: `/media/${stored}` });
  },

  // ---------- Статистика (маркетинг) ----------

  // GET /api/admin/stats — из кэша, обновление отдельной ручкой.
  // Тянуть Метрику на каждый рендер дашборда = упереться в лимиты к вечеру
  async 'GET /api/admin/stats'(req, res, url) {
    if (!requireRole(req, res, ['marketing'])) return;
    const key = url.searchParams.get('key') ?? 'metrika:30d';
    const row = db.prepare('SELECT value, fetched_at FROM stats_cache WHERE key = ?').get(key);
    if (!row) return json(res, 200, { ok: true, data: null, hint: 'Кэш пуст. Вызовите POST /api/admin/stats/refresh' });
    return json(res, 200, { ok: true, data: JSON.parse(row.value), fetched_at: row.fetched_at });
  },

  // POST /api/admin/stats/refresh — тянет Метрику и Директ, кладёт в кэш
  async 'POST /api/admin/stats/refresh'(req, res) {
    if (!requireRole(req, res, ['marketing'])) return;
    const result = await fetchMetrika();
    db.prepare(`INSERT INTO stats_cache (key, value, fetched_at) VALUES (?,?,?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`)
      .run('metrika:30d', JSON.stringify(result), now());
    return json(res, 200, { ok: true, data: result });
  },
};

// ---------- Яндекс Метрика ----------
// Тянем отчёты через Management API. Токен — OAuth, лежит в env, никогда в коде.
// Если токена нет, отдаём заглушку, а не падаем: дашборд должен открываться и без аналитики.
async function fetchMetrika() {
  const token = process.env.YM_TOKEN;
  const counter = process.env.YM_COUNTER;
  if (!token || !counter) {
    return { mocked: true, hint: 'YM_TOKEN и YM_COUNTER не заданы — статистика отключена' };
  }
  // Формат отчёта: визиты и посетители по дням. Метрика отвечает медленно, ставим таймаут явно
  const body = new URLSearchParams({
    ids: String(counter),
    date1: '30daysAgo',
    date2: 'today',
    metrics: 'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:pageviews',
    dimensions: 'ym:s:date',
    sort: 'ym:s:date',
    accuracy: 'full',
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000); // жёсткий таймаут: без него дашборд висит
  try {
    const r = await fetch('https://api-metrika.yandex.net/stat/v1/data', {
      method: 'POST',
      headers: { Authorization: `OAuth ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) return { error: `Метрика ответила ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: e?.name === 'AbortError' ? 'Метрика не ответила за 15 с' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Выдача файлов резюме ----------
// Отдаём ТОЛЬКО по авторизации и только роли hr/admin. Файл резюме — персданные,
// прямая ссылка на него не должна работать ни при каких условиях.
// Ищем файл в базе по id: путь из запроса никогда не подставляем в файловую систему.
export async function serveResume(req, res, id) {
  const user = currentUser(req);
  if (!user) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (user.role !== 'admin' && user.role !== 'hr') return json(res, 403, { ok: false, error: 'forbidden' });

  const row = db.prepare('SELECT stored_name, original_name, mime, size FROM files WHERE id = ?').get(String(id ?? ''));
  if (!row) return json(res, 404, { ok: false, error: 'not_found' });

  const path = join(UPLOAD_DIR, row.stored_name);
  try {
    const buf = readFileSync(path);
    // RFC 5987 для кириллицы в имени файла: без filename* браузер сохранит кракозябры.
    // Сам filename оставляем ASCII-заглушкой — старые клиенты её понимают
    const ascii = row.original_name.replace(/[^\x20-\x7E]/g, '_');
    res.writeHead(200, {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Length': buf.length,
      // attachment, а не inline: файл должен скачиваться, а не открываться в браузере.
      // Так меньше шансов, что подсунутый pdf выполнит что-то на нашей странице
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  } catch {
    return json(res, 404, { ok: false, error: 'not_found' });
  }
}

// ---------- Отдача файлов медиатеки ----------
// Файл ищем в базе по имени, а не по пути из запроса. Иначе классика: /media/../../etc/passwd.
// Список разрешённых расширений тоже проверяем — на случай, если в медиатеку как-то попал html
const MEDIA_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.svg', '.gif'];

export async function serveMedia(req, res, name) {
  // decodeURIComponent, потому что имя может прийти с %-кодированием
  const safe = decodeURIComponent(String(name ?? ''));
  if (!safe || safe.includes('/') || safe.includes('..')) return json(res, 400, { ok: false, error: 'bad_name' });
  if (!MEDIA_EXT.includes(extname(safe).toLowerCase())) return json(res, 415, { ok: false, error: 'bad_ext' });

  const row = db.prepare('SELECT stored_name, mime FROM media WHERE stored_name = ?').get(safe);
  if (!row) return json(res, 404, { ok: false, error: 'not_found' });

  const path = join(MEDIA_DIR, row.stored_name);
  try {
    const buf = readFileSync(path);
    res.writeHead(200, {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Length': buf.length,
      // Иммутабельный кэш: имя файла это UUID, содержимое под ним не меняется никогда
      'Cache-Control': 'public, max-age=31536000, immutable',
      // nosniff: браузер не должен додумывать тип сам. Защита от подмены картинки на html
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  } catch {
    return json(res, 404, { ok: false, error: 'not_found' });
  }
}

