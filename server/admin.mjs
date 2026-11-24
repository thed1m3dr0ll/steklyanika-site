// API админки: заявки для HR, тексты и картинки для маркетолога, статистика.
// Тот же сервер, тот же node:sqlite, ноль зависимостей.
//
// Авторизация — сессии на HTTP-only cookie. Пользователи в таблице users, пароли в scrypt.
// Роли: admin (всё), hr (вакансии, отклики, HH), marketing (тексты, фото, метрика), viewer (только чтение).
// Проверка роли — в одном месте (requireRole), чтобы не забыть её на новой ручке. Забытая проверка = дыра.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, extname, basename, dirname, resolve } from 'node:path';
import { syncHH, authUrl, exchangeCode, hhStatus } from './hh.mjs';
import { json, readJson, readMultipart } from './http.mjs';

const DB_PATH = process.env.DB_PATH ?? './data/steklyanika.db';
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './data/uploads';
const MEDIA_DIR = process.env.MEDIA_DIR ?? './data/media';
// Папка вакансий сайта. Админка пишет туда JSON-файлы — их читает сборка Astro
// (src/data/vacancies.ts). Путь переопределяется, если сайт лежит не рядом с сервером
const SITE_VACANCIES_DIR = process.env.SITE_VACANCIES_DIR ?? './site/src/content/vacancies';
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

  -- Сотрудники. Не путать с users: users — это те, кто входит в кабинет,
  -- сотрудники — это кадровый учёт, у них может не быть доступа вообще.
  -- Держим раздельно намеренно: увольнение сотрудника не должно закрывать вход в CRM
  CREATE TABLE IF NOT EXISTS employees (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    dept       TEXT,              -- отдел: Продажи, Производство, HR, Маркетинг
    pos        TEXT,              -- должность
    hire       TEXT,              -- дата приёма, ISO
    status     TEXT NOT NULL DEFAULT 'active', -- active | prob | fired
    phone      TEXT,
    email      TEXT,
    salary     INTEGER,           -- оклад в рублях
    created_at TEXT NOT NULL,
    updated_at TEXT
  );

  -- Выплаты. Отдельная таблица, а не поле в сотруднике: история нужна за годы,
  -- и по ней потом считается фонд оплаты труда
  CREATE TABLE IF NOT EXISTS payments (
    id         TEXT PRIMARY KEY,
    emp_id     TEXT NOT NULL,
    date       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'salary', -- salary | bonus | advance | vacation
    sum        INTEGER NOT NULL,
    comment    TEXT,
    created_at TEXT NOT NULL
  );
  -- Индекс по сотруднику: без него выплаты по одному человеку ищутся полным перебором
  CREATE INDEX IF NOT EXISTS idx_payments_emp ON payments(emp_id);

  -- Группы соцсетей. Числа вводим руками: тянуть из API ВК и Телеграма —
  -- это отдельные токены и отдельное согласование, а сводка нужна сейчас
  CREATE TABLE IF NOT EXISTS social_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    net        TEXT NOT NULL,     -- VK | Telegram | YouTube | Дзен
    link       TEXT,
    members    INTEGER DEFAULT 0,
    posts      INTEGER DEFAULT 0,
    engagement REAL DEFAULT 0,    -- процент вовлечённости
    status     TEXT NOT NULL DEFAULT 'active', -- active | paused | closed
    manager    TEXT,
    updated_at TEXT NOT NULL
  );

  -- Журнал действий. Нужен, чтобы понять, кто сдвинул заявку и когда.
  -- Пишем только значимые события: вход, правка заявки, удаление, смена прав
  CREATE TABLE IF NOT EXISTS audit (
    id      TEXT PRIMARY KEY,
    at      TEXT NOT NULL,
    actor   TEXT,                 -- почта того, кто сделал
    action  TEXT NOT NULL,        -- lead.update | lead.delete | user.create | media.upload ...
    target  TEXT,                 -- id объекта
    details TEXT                  -- что именно поменяли, коротко
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
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
// Важно про порядок: этот модуль импортируется в index.mjs СВЕРХУ файла, и весь его
// код выполняется раньше, чем index.mjs дойдёт до CREATE TABLE leads. На чистой базе
// таблицы в этот момент ещё нет — первый ALTER падал, и это ловилось только здесь.
// Поэтому миграция оформлена функцией: index.mjs зовёт её после создания таблиц.
// Плюс добиваем недостающие колонки запросом в схему, а не перебором «а вдруг упадёт»:
// CREATE INDEX, стоящий в чужом db.exec, мог оборвать блок на середине
export function migrateLeads() {
  try {
    // На случай, если таблицы нет вовсе — создаём её сами, без индексов.
    // Так функция работает и когда её позвали до схемы index.mjs
    db.exec(`CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, source TEXT NOT NULL, name TEXT,
      contact TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
      comment TEXT, ip_hash TEXT, user_agent TEXT, page TEXT)`);
    const have = new Set(db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name));
    for (const [col, type] of leadColumns) {
      if (have.has(col)) continue;
      try {
        db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${type}`);
      } catch (e) {
        console.error('[migrate] leads.' + col, e?.message ?? e);
      }
    }
  } catch (e) {
    console.error('[migrate] leads:', e?.message ?? e);
  }
}
migrateLeads();

const now = () => new Date().toISOString();

// Журнал действий. Ошибку записи НЕ пробрасываем: если лог упал, это не повод
// отменять удачную правку заявки. Но и молча глотать не будем — пусть будет в консоли
// Транслитерация для имён файлов. Копия таблицы из site/src/data/vacancies.ts:
// если поменять здесь, надо поменять и там, иначе адреса страниц разъедутся
const LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
function slugifyRu(s) {
  return [...s.toLowerCase()].map((ch) => (ch in LAT ? LAT[ch] : ch)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'vacancy';
}

function logAction(actor, action, target, details) {
  try {
    db.prepare('INSERT INTO audit (id, at, actor, action, target, details) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), now(), actor ?? null, action, target ?? null, details ? String(details).slice(0, 500) : null);
  } catch (e) {
    console.error('[audit]', action, e?.message ?? e);
  }
}

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

  // ─────────────────────────────────────────────────────────────────────────────
  //  СОТРУДНИКИ. Кадровый учёт, отдельно от users: у сотрудника может не быть
  //  доступа в кабинет, а у пользователя кабинета может не быть в штате (подрядчик)
  // ─────────────────────────────────────────────────────────────────────────────
  async 'GET /api/admin/employees'(req, res, url) {
    if (!requireRole(req, res, ['hr'])) return;
    const q = url.searchParams.get('q');
    const dept = url.searchParams.get('dept');
    const where = [];
    const args = [];
    if (q) { where.push('(name LIKE ? OR pos LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    if (dept) { where.push('dept = ?'); args.push(dept); }
    const sql = `SELECT * FROM employees ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY name COLLATE NOCASE`;
    return json(res, 200, { ok: true, items: db.prepare(sql).all(...args) });
  },

  async 'POST /api/admin/employees'(req, res) {
    const user = requireRole(req, res, ['hr']);
    if (!user) return;
    const b = await readJson(req);
    if (!b.name) return json(res, 400, { ok: false, error: 'name_required' });
    const id = randomUUID();
    db.prepare(`INSERT INTO employees (id, name, dept, pos, hire, status, phone, email, salary, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, String(b.name).slice(0, 200), b.dept ?? null, b.pos ?? null, b.hire ?? null,
        ['active', 'prob', 'fired'].includes(b.status) ? b.status : 'active',
        b.phone ?? null, b.email ?? null,
        Number.isFinite(Number(b.salary)) && Number(b.salary) >= 0 ? Math.round(Number(b.salary)) : null,
        now());
    logAction(user.email, 'employee.create', id, b.name);
    return json(res, 201, { ok: true, id });
  },

  async 'PATCH /api/admin/employees/:id'(req, res, url, params) {
    const user = requireRole(req, res, ['hr']);
    if (!user) return;
    const b = await readJson(req);
    const fields = ['name', 'dept', 'pos', 'hire', 'status', 'phone', 'email', 'salary'];
    if (b.status && !['active', 'prob', 'fired'].includes(b.status)) {
      return json(res, 400, { ok: false, error: 'bad_status' });
    }
    // Собираем SET только из присланных полей: так апдейт не затирает остальное NULL-ами
    const sets = [];
    const args = [];
    for (const f of fields) {
      if (b[f] === undefined) continue;
      sets.push(`${f} = ?`);
      args.push(f === 'salary' && b[f] !== '' ? Math.round(Number(b[f]) || 0) : b[f]);
    }
    if (!sets.length) return json(res, 400, { ok: false, error: 'nothing_to_update' });
    sets.push('updated_at = ?');
    args.push(now(), params.id);
    db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    logAction(user.email, 'employee.update', params.id, Object.keys(b).join(','));
    return json(res, 200, { ok: true });
  },

  // Удаление сотрудника — только админ. Кадровые данные нельзя терять по клику менеджера
  async 'DELETE /api/admin/employees/:id'(req, res, url, params) {
    const user = requireRole(req, res, ['admin']);
    if (!user) return;
    const hit = db.prepare('DELETE FROM employees WHERE id = ?').run(params.id);
    if (!hit.changes) return json(res, 404, { ok: false, error: 'not_found' });
    logAction(user.email, 'employee.delete', params.id, null);
    return json(res, 200, { ok: true });
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  ВЫПЛАТЫ
  // ─────────────────────────────────────────────────────────────────────────────
  async 'GET /api/admin/payments'(req, res, url) {
    if (!requireRole(req, res, ['hr'])) return;
    const emp = url.searchParams.get('emp');
    const where = emp ? 'WHERE p.emp_id = ?' : '';
    const args = emp ? [emp] : [];
    const sql = `SELECT p.*, e.name AS emp_name FROM payments p
                 LEFT JOIN employees e ON e.id = p.emp_id
                 ${where} ORDER BY p.date DESC LIMIT 500`;
    return json(res, 200, { ok: true, items: db.prepare(sql).all(...args) });
  },

  async 'POST /api/admin/payments'(req, res) {
    const user = requireRole(req, res, ['hr']);
    if (!user) return;
    const b = await readJson(req);
    const sum = Number(b.sum);
    if (!b.emp_id || !Number.isFinite(sum) || sum <= 0) {
      return json(res, 400, { ok: false, error: 'bad_payment' });
    }
    const id = randomUUID();
    db.prepare('INSERT INTO payments (id, emp_id, date, type, sum, comment, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, b.emp_id, b.date || now().slice(0, 10),
        ['salary', 'bonus', 'advance', 'vacation'].includes(b.type) ? b.type : 'salary',
        Math.round(sum), b.comment ?? null, now());
    logAction(user.email, 'payment.create', id, `${sum} ₽`);
    return json(res, 201, { ok: true, id });
  },

  async 'DELETE /api/admin/payments/:id'(req, res, url, params) {
    const user = requireRole(req, res, ['admin', 'hr']);
    if (!user) return;
    const hit = db.prepare('DELETE FROM payments WHERE id = ?').run(params.id);
    if (!hit.changes) return json(res, 404, { ok: false, error: 'not_found' });
    logAction(user.email, 'payment.delete', params.id, null);
    return json(res, 200, { ok: true });
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  СОЦСЕТИ. Маркетолог ведёт список групп и цифры руками.
  // ─────────────────────────────────────────────────────────────────────────────
  async 'GET /api/admin/social'(req, res) {
    if (!requireRole(req, res, ['marketing'])) return;
    return json(res, 200, { ok: true, items: db.prepare('SELECT * FROM social_groups ORDER BY net, name').all() });
  },

  async 'POST /api/admin/social'(req, res) {
    const user = requireRole(req, res, ['marketing']);
    if (!user) return;
    const b = await readJson(req);
    if (!b.name || !b.net) return json(res, 400, { ok: false, error: 'name_and_net_required' });
    const id = randomUUID();
    db.prepare(`INSERT INTO social_groups (id, name, net, link, members, posts, engagement, status, manager, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, String(b.name).slice(0, 200), String(b.net).slice(0, 40), b.link ?? null,
        Math.round(Number(b.members) || 0), Math.round(Number(b.posts) || 0),
        Number(b.engagement) || 0,
        ['active', 'paused', 'closed'].includes(b.status) ? b.status : 'active',
        b.manager ?? user.email, now());
    logAction(user.email, 'social.create', id, b.name);
    return json(res, 201, { ok: true, id });
  },

  async 'PATCH /api/admin/social/:id'(req, res, url, params) {
    const user = requireRole(req, res, ['marketing']);
    if (!user) return;
    const b = await readJson(req);
    const fields = ['name', 'net', 'link', 'members', 'posts', 'engagement', 'status', 'manager'];
    const sets = [];
    const args = [];
    for (const f of fields) {
      if (b[f] === undefined) continue;
      sets.push(`${f} = ?`);
      args.push(b[f]);
    }
    if (!sets.length) return json(res, 400, { ok: false, error: 'nothing_to_update' });
    sets.push('updated_at = ?');
    args.push(now(), params.id);
    db.prepare(`UPDATE social_groups SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    logAction(user.email, 'social.update', params.id, Object.keys(b).join(','));
    return json(res, 200, { ok: true });
  },

  async 'DELETE /api/admin/social/:id'(req, res, url, params) {
    const user = requireRole(req, res, ['marketing']);
    if (!user) return;
    const hit = db.prepare('DELETE FROM social_groups WHERE id = ?').run(params.id);
    if (!hit.changes) return json(res, 404, { ok: false, error: 'not_found' });
    logAction(user.email, 'social.delete', params.id, null);
    return json(res, 200, { ok: true });
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  ПОЛЬЗОВАТЕЛИ КАБИНЕТА. Только админ. Саморегистрации нет и не будет:
  //  в системе с персданными это подарок любому, кто узнал адрес
  // ─────────────────────────────────────────────────────────────────────────────
  async 'GET /api/admin/users'(req, res) {
    if (!requireRole(req, res, ['admin'])) return;
    // pass_hash наружу не отдаём ни при каких условиях — даже хеш
    const items = db.prepare('SELECT id, email, name, role, active, created_at, last_login FROM users ORDER BY created_at')
      .all();
    return json(res, 200, { ok: true, items });
  },

  async 'POST /api/admin/users'(req, res) {
    const admin = requireRole(req, res, ['admin']);
    if (!admin) return;
    const b = await readJson(req);
    const email = String(b.email ?? '').trim().toLowerCase();
    const role = b.role ?? 'viewer';
    const ROLES = ['admin', 'hr', 'marketing', 'viewer'];

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { ok: false, error: 'bad_email' });
    if (!ROLES.includes(role)) return json(res, 400, { ok: false, error: 'bad_role' });
    // Та же планка, что в seed-user: слабый пароль в админке к персданным — не мелочь
    if (String(b.password ?? '').length < 12) return json(res, 400, { ok: false, error: 'password_too_short' });

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return json(res, 409, { ok: false, error: 'email_taken' });
    }
    const id = randomUUID();
    db.prepare('INSERT INTO users (id, email, name, pass_hash, role, active, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, email, String(b.name ?? '').slice(0, 120) || email.split('@')[0], hashPass(String(b.password)), role, 1, now());
    logAction(admin.email, 'user.create', id, `${email} · ${role}`);
    return json(res, 201, { ok: true, id });
  },

  async 'PATCH /api/admin/users/:id'(req, res, url, params) {
    const admin = requireRole(req, res, ['admin']);
    if (!admin) return;
    const b = await readJson(req);
    const ROLES = ['admin', 'hr', 'marketing', 'viewer'];
    if (b.role && !ROLES.includes(b.role)) return json(res, 400, { ok: false, error: 'bad_role' });

    // Защита от самоблокировки: если админ снимет себе роль admin или active,
    // в системе может не остаться ни одного администратора, и войти будет некому
    if (params.id === admin.id && (b.role && b.role !== 'admin' || b.active === 0 || b.active === false)) {
      return json(res, 400, { ok: false, error: 'cannot_demote_self' });
    }
    // И последнего админа в принципе не разжалуем
    if (b.role && b.role !== 'admin') {
      const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1").get().n;
      const target = db.prepare('SELECT role FROM users WHERE id = ?').get(params.id);
      if (target?.role === 'admin' && admins <= 1) return json(res, 400, { ok: false, error: 'last_admin' });
    }

    const sets = [];
    const args = [];
    if (b.role !== undefined) { sets.push('role = ?'); args.push(b.role); }
    if (b.active !== undefined) { sets.push('active = ?'); args.push(b.active ? 1 : 0); }
    if (b.name !== undefined) { sets.push('name = ?'); args.push(String(b.name).slice(0, 120)); }
    if (b.password) {
      if (String(b.password).length < 12) return json(res, 400, { ok: false, error: 'password_too_short' });
      sets.push('pass_hash = ?'); args.push(hashPass(String(b.password)));
      // Смена пароля убивает живые сессии этого пользователя. Иначе старый пароль
      // остаётся действующим через чужую открытую вкладку — то есть смена бесполезна
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(params.id);
    }
    if (!sets.length) return json(res, 400, { ok: false, error: 'nothing_to_update' });
    args.push(params.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    logAction(admin.email, 'user.update', params.id, Object.keys(b).filter((k) => k !== 'password').join(','));
    return json(res, 200, { ok: true });
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  ЖУРНАЛ. Виден админу: там почты сотрудников и что они делали
  // ─────────────────────────────────────────────────────────────────────────────
  async 'GET /api/admin/audit'(req, res, url) {
    if (!requireRole(req, res, ['admin'])) return;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
    return json(res, 200, {
      ok: true,
      items: db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT ?').all(limit),
    });
  },

  // ─────────────────────────────────────────────────────────────────────────────
  //  ВАКАНСИИ САЙТА. Вакансия на сайте — это JSON-файл в src/content/vacancies/.
  //  Поэтому «создать вакансию» = записать файл, а «снять с публикации» = убрать его.
  //  Никакой базы тут нет намеренно: сайт собирается статикой, и файл — единственный
  //  источник правды. Держать вакансии ещё и в SQLite значило бы рассинхрон.
  // ─────────────────────────────────────────────────────────────────────────────

  // GET /api/admin/site-vacancies — список файлов как есть, включая неопубликованные
  async 'GET /api/admin/site-vacancies'(req, res) {
    if (!requireRole(req, res, ['hr'])) return;
    if (!existsSync(SITE_VACANCIES_DIR)) return json(res, 200, { ok: true, items: [], dirMissing: true });
    const items = readdirSync(SITE_VACANCIES_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const data = JSON.parse(readFileSync(join(SITE_VACANCIES_DIR, f), 'utf8'));
          return { file: f, ...data };
        } catch {
          // Битый JSON не должен ломать весь список: показываем как есть, чтобы человек увидел проблему
          return { file: f, title: f, broken: true };
        }
      })
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.title).localeCompare(String(b.title), 'ru'));
    return json(res, 200, { ok: true, items });
  },

  // POST /api/admin/site-vacancies — опубликовать вакансию на сайте
  async 'POST /api/admin/site-vacancies'(req, res) {
    const user = requireRole(req, res, ['hr']);
    if (!user) return;
    const b = await readJson(req);
    if (!String(b.title ?? '').trim()) return json(res, 400, { ok: false, error: 'title_required' });

    // Имя файла строим из названия. Транслитерация та же, что в site/src/data/vacancies.ts,
    // иначе адреса страниц разъедутся между админкой и сборкой
    const slug = slugifyRu(String(b.title));
    const file = `${slug}.json`;
    const path = join(SITE_VACANCIES_DIR, file);

    // Не перетираем чужую вакансию молча: лучше пусть человек допишет название
    if (existsSync(path)) return json(res, 409, { ok: false, error: 'slug_taken', slug });

    const data = {
      title: String(b.title).trim().slice(0, 160),
      place: b.place === 'Офис' ? 'Офис' : 'Производство',
      employment: String(b.employment ?? 'полная занятость').slice(0, 80),
      experience: String(b.experience ?? '').slice(0, 80),
      schedule: String(b.schedule ?? '').slice(0, 160),
      contract: String(b.contract ?? '').slice(0, 160),
      format: String(b.format ?? '').slice(0, 160),
      // Списки приходят строкой, по пункту на строку — ровно так их читает lines.ts на сайте
      duties: String(b.duties ?? '').slice(0, 4000),
      requirements: String(b.requirements ?? '').slice(0, 4000),
      conditions: String(b.conditions ?? '').slice(0, 4000),
      hh: String(b.hh ?? '').trim().slice(0, 300),
      published: b.published !== false,
      order: Number.isFinite(Number(b.order)) ? Number(b.order) : 100,
    };

    mkdirSync(SITE_VACANCIES_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
    logAction(user.email, 'vacancy.publish', slug, data.title);
    return json(res, 201, { ok: true, slug, file });
  },

  // PATCH /api/admin/site-vacancies/:file — снять с публикации или вернуть.
  // Файл не удаляем: вакансию часто возвращают через месяц, и терять текст глупо
  async 'PATCH /api/admin/site-vacancies/:file'(req, res, url, params) {
    const user = requireRole(req, res, ['hr']);
    if (!user) return;
    const file = basename(params.file);           // basename отсекает ../ — иначе выйдем из папки
    if (!file.endsWith('.json')) return json(res, 400, { ok: false, error: 'bad_file' });
    const path = join(SITE_VACANCIES_DIR, file);
    if (!existsSync(path)) return json(res, 404, { ok: false, error: 'not_found' });

    const b = await readJson(req);
    let data;
    try { data = JSON.parse(readFileSync(path, 'utf8')); }
    catch { return json(res, 500, { ok: false, error: 'broken_json' }); }

    if (b.published !== undefined) data.published = !!b.published;
    if (b.order !== undefined) data.order = Number(b.order) || 100;
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
    logAction(user.email, 'vacancy.update', file, 'published=' + data.published);
    return json(res, 200, { ok: true });
  },

  // DELETE — только админ. Удаление файла необратимо, текста больше нигде нет
  async 'DELETE /api/admin/site-vacancies/:file'(req, res, url, params) {
    const user = requireRole(req, res, ['admin']);
    if (!user) return;
    const file = basename(params.file);
    if (!file.endsWith('.json')) return json(res, 400, { ok: false, error: 'bad_file' });
    const path = join(SITE_VACANCIES_DIR, file);
    if (!existsSync(path)) return json(res, 404, { ok: false, error: 'not_found' });
    unlinkSync(path);
    logAction(user.email, 'vacancy.delete', file, null);
    return json(res, 200, { ok: true });
  },

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

  // GET /api/admin/stats — всё из кэша, обновление отдельной ручкой.
  // Тянуть три API на каждый рендер дашборда = упереться в лимиты к вечеру
  async 'GET /api/admin/stats'(req, res) {
    if (!requireRole(req, res, ['marketing'])) return;
    const out = {};
    for (const src of STAT_SOURCES) {
      const row = db.prepare('SELECT value, fetched_at FROM stats_cache WHERE key = ?').get(src.key);
      out[src.key] = row ? { data: JSON.parse(row.value), fetched_at: row.fetched_at } : { data: null, fetched_at: null };
    }
    return json(res, 200, { ok: true, sources: out });
  },

  // POST /api/admin/stats/refresh — опрашивает источники и кладёт в кэш.
  // Источники независимы: упавший Google не должен стирать удачную Метрику.
  // ?source=ym|gads|vk — обновить один, без параметра — все
  async 'POST /api/admin/stats/refresh'(req, res, url) {
    if (!requireRole(req, res, ['marketing'])) return;
    const only = url.searchParams.get('source');
    const list = only ? STAT_SOURCES.filter((s) => s.key === only) : STAT_SOURCES;
    if (!list.length) return json(res, 400, { ok: false, error: 'unknown_source' });

    const out = {};
    for (const src of list) {
      let data;
      try {
        data = await src.run();
      } catch (e) {
        data = { ok: false, hint: String(e?.message ?? e) };
      }
      // В кэш пишем только настоящие данные. Ошибку и «нет токена» не кэшируем:
      // иначе после появления ключа дашборд до утра показывал бы старое «отключено»
      if (data && data.ok && !data.mocked && !data.error) {
        db.prepare(`INSERT INTO stats_cache (key, value, fetched_at) VALUES (?,?,?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at`)
          .run(src.key, JSON.stringify(data), now());
      }
      out[src.key] = data;
    }
    return json(res, 200, { ok: true, sources: out });
  },
};

// Реестр источников статистики. Одна структура на все три сервиса:
// экран и ручка обходят этот список, поэтому новый источник — это одна запись здесь,
// а не правка в пяти местах страницы
const STAT_SOURCES = [
  { key: 'ym', title: 'Яндекс.Метрика', char: 'Я', color: '#FC3F1D', run: () => fetchMetrika() },
  { key: 'gads', title: 'Google Ads', char: 'G', color: '#34A853', run: () => fetchGoogleAds() },
  { key: 'vk', title: 'ВКонтакте', char: 'VK', color: '#0077FF', run: () => fetchVk() },
];

// ---------- Яндекс Метрика ----------
// Тянем отчёты через Management API. Токен — OAuth, лежит в env, никогда в коде.
// Если токена нет, отдаём заглушку, а не падаем: дашборд должен открываться и без аналитики.
async function fetchMetrika() {
  const token = process.env.YM_TOKEN;
  const counter = process.env.YM_COUNTER;
  if (!token || !counter) {
    return { ok: false, mocked: true, need: ['YM_TOKEN', 'YM_COUNTER'],
      hint: 'Нет токена Метрики или номера счётчика — реальные цифры недоступны' };
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
    if (!r.ok) return { ok: false, error: `Метрика ответила ${r.status}` };
    const raw = await r.json();

    // Метрика отдаёт строки по дням. Считаем итоги сами: у неё в ответе нет
    // суммы за период, а дашборду нужна именно она
    const rows = (raw.data || []).map((row) => ({
      date: row.dimensions?.[0]?.name ?? '',
      visits: Number(row.metrics?.[0] ?? 0),
      users: Number(row.metrics?.[1] ?? 0),
      bounce: Number(row.metrics?.[2] ?? 0),
      pageviews: Number(row.metrics?.[3] ?? 0),
    }));
    const sum = (k) => rows.reduce((a, b) => a + b[k], 0);
    const visits = sum('visits');
    const users = sum('users');
    const pageviews = sum('pageviews');
    // Отказы в Метрике — доля, а не проценты. Считаем среднее по дням, взвешенное по визитам:
    // простое среднее врёт, когда один день жирный, а остальные пустые
    const bounce = visits ? rows.reduce((a, b) => a + b.bounce * b.visits, 0) / visits : 0;

    return {
      ok: true,
      counter: String(counter),
      period: '30 дней',
      totals: { visits, users, pageviews, bounce: Math.round(bounce * 1000) / 10 },
      series: rows.map((d) => ({ date: d.date, value: d.visits })),
      fetched: raw.query?.date1 ?? null,
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'Метрика не ответила за 15 с' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Google Ads ----------
// Отчёт по расходам и клику за 30 дней. Нужны три вещи из Google Ads API:
// developer token, refresh token и customer id. Все три — в env, в коде их нет.
// Если чего-то не хватает, честно говорим об этом, а не рисуем нули
async function fetchGoogleAds() {
  const devToken = process.env.GADS_DEVELOPER_TOKEN;
  const clientId = process.env.GADS_CLIENT_ID;
  const clientSecret = process.env.GADS_CLIENT_SECRET;
  const refresh = process.env.GADS_REFRESH_TOKEN;
  const customerId = (process.env.GADS_CUSTOMER_ID || '').replace(/-/g, '');
  if (!devToken || !clientId || !clientSecret || !refresh || !customerId) {
    return { ok: false, mocked: true,
      need: ['GADS_DEVELOPER_TOKEN', 'GADS_CLIENT_ID', 'GADS_CLIENT_SECRET', 'GADS_REFRESH_TOKEN', 'GADS_CUSTOMER_ID'],
      hint: 'Нет доступа к Google Ads API — реальные расходы недоступны' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    // Сначала меняем refresh token на access token. Живёт час, поэтому меняем на каждый запрос
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret,
        refresh_token: refresh, grant_type: 'refresh_token',
      }),
      signal: ctrl.signal,
    });
    if (!tokRes.ok) return { ok: false, error: `Google не выдал токен: ${tokRes.status}` };
    const { access_token: access } = await tokRes.json();

    const q = `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
               FROM customer WHERE segments.date DURING LAST_30_DAYS`;
    const r = await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        'developer-token': devToken,
        'login-customer-id': customerId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: q }),
      signal: ctrl.signal,
    });
    if (!r.ok) return { ok: false, error: `Google Ads ответил ${r.status}` };
    const raw = await r.json();

    const rows = (raw.results || []).map((x) => ({
      date: x.segments?.date ?? '',
      // cost_micros — миллионные доли рубля. Делим один раз здесь, чтобы наружу шли рубли
      cost: Number(x.metrics?.costMicros ?? 0) / 1_000_000,
      clicks: Number(x.metrics?.clicks ?? 0),
      impressions: Number(x.metrics?.impressions ?? 0),
      conversions: Number(x.metrics?.conversions ?? 0),
    })).sort((a, b) => a.date.localeCompare(b.date));

    const sum = (k) => rows.reduce((a, b) => a + b[k], 0);
    const clicks = sum('clicks');
    const cost = sum('cost');
    return {
      ok: true,
      customer: process.env.GADS_CUSTOMER_ID,
      period: '30 дней',
      totals: {
        cost: Math.round(cost),
        clicks,
        impressions: sum('impressions'),
        conversions: Math.round(sum('conversions') * 10) / 10,
        // Цена клика — производная, считаем здесь, а не в браузере
        cpc: clicks ? Math.round((cost / clicks) * 100) / 100 : 0,
      },
      series: rows.map((d) => ({ date: d.date, value: d.cost })),
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'Google Ads не ответил за 15 с' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- ВКонтакте ----------
// Сообщество: подписчики и охваты. Токен — сервисный ключ или токен админа группы,
// права: groups и wall. Версия API зафиксирована строкой: v5.199 живёт давно,
// и без версии ВК начинает отвечать по-разному в разные недели
async function fetchVk() {
  const token = process.env.VK_TOKEN;
  const groupId = (process.env.VK_GROUP_ID || '').replace(/^-/, '');
  if (!token || !groupId) {
    return { ok: false, mocked: true, need: ['VK_TOKEN', 'VK_GROUP_ID'],
      hint: 'Нет токена ВКонтакте или id сообщества — реальные цифры недоступны' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  const call = async (method, params) => {
    const u = new URL(`https://api.vk.com/method/${method}`);
    u.searchParams.set('v', '5.199');
    u.searchParams.set('access_token', token);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const r = await fetch(u, { signal: ctrl.signal });
    const j = await r.json();
    // ВК всегда отвечает 200, ошибку прячет в теле. Без этой проверки молча получим пустоту
    if (j.error) throw new Error(`ВК: ${j.error.error_msg}`);
    return j.response;
  };

  try {
    const [group, stats] = await Promise.all([
      call('groups.getById', { group_id: groupId, fields: 'members_count,status' }),
      // Статистика сообщества требует прав администратора. Если их нет, ВК вернёт ошибку —
      // ловим её отдельно, чтобы подписчики всё равно показались
      call('stats.get', { group_id: groupId, interval: 'day', intervals_count: 30, stats_groups: 'reach' }).catch(() => null),
    ]);

    const g = Array.isArray(group) ? group[0] : group;
    const rows = (stats || []).map((d) => ({
      date: d.day ?? '',
      value: Number(d.reach?.reach_subscribers ?? d.reach?.reach ?? 0),
    })).sort((a, b) => a.date.localeCompare(b.date));

    const reach = rows.reduce((a, b) => a + b.value, 0);
    return {
      ok: true,
      group: g?.name ?? null,
      period: '30 дней',
      totals: {
        members: Number(g?.members_count ?? 0),
        reach,
        // Средний охват на день — понятнее суммы, когда период разный
        reachAvg: rows.length ? Math.round(reach / rows.length) : 0,
      },
      series: rows,
      // Отдельно помечаем, что охватов нет: подписчики пришли, а статистику ВК не отдал.
      // Иначе карточка с нулём выглядит как «аудитории нет»
      reachMissing: !stats,
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'ВКонтакте не ответил за 15 с' : String(e?.message ?? e) };
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

