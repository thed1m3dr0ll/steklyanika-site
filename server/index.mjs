// Приём заявок, файлов резюме и журнала согласий.
// Один файл, ноль внешних зависимостей кроме node:sqlite (встроен в Node 22.5+).
// Почему так, а не Nest/Express: принятых заявок десятки в месяц, тащить сюда фреймворк — оверкилл,
// а вот требования 152-ФЗ и ст. 9 ч. 3 (докажи, что согласие было) — обязательны. Под них тут всё и сделано.
//
// Запуск:  node --env-file=.env server/index.mjs
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join, extname, dirname } from 'node:path';
import { adminRoutes, serveMedia, serveResume } from './admin.mjs';
import { json, readJson, readMultipart, MAX_BODY } from './http.mjs';

const PORT = Number(process.env.API_PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? './data/steklyanika.db';
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? './data/uploads';

// Соль для хеша IP. Без неё IP из журнала — персональные данные в чистом виде, а так — псевдоним.
// Сменишь соль — старые хеши перестанут биться, поэтому задать один раз и не трогать.
const IP_SALT = process.env.IP_SALT ?? 'CHANGE_ME_IN_ENV';

// Сроки взяты из Политики/Согласия (см. ДЛЯ-РАЗРАБОТЧИКА.md, «Сроки удаления»).
// Автоудаление — не luxury: если данные лежат дольше, это нарушение собственных же документов.
const RETENTION = {
  lead_days: 30,      // первичная консультация — 30 календарных дней после ответа
  resume_days: 180,   // резюме соискателя — не более 6 месяцев с даты согласия
  consent_days: 1825, // журнал согласий — 5 лет (срок надо вписать в Политику, см. аудит)
};

mkdirSync(UPLOAD_DIR, { recursive: true });
// SQLite папок не создаёт. На чистом клоне data/ ещё нет — без этого сервер умирал на старте
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  -- Заявки. Содержимое формы лежим в JSON: поля меняются чаще схемы,
  -- по контактам потом ищем через json_extract. Так не нужна миграция на каждую новую галочку.
  CREATE TABLE IF NOT EXISTS leads (
    id            TEXT PRIMARY KEY,
    created_at    TEXT NOT NULL,               -- время сервера, не браузера. Это основное время
    source        TEXT NOT NULL,               -- modal | quiz | contacts | resume
    name          TEXT,
    contact       TEXT,                        -- телефон или почта, сведено в строку для поиска
    payload       TEXT NOT NULL,               -- вся форма целиком
    status        TEXT NOT NULL DEFAULT 'new', -- new | in_progress | archived | spam
    comment       TEXT,
    ip_hash       TEXT,                        -- sha256(ip + соль). Сам IP не храним
    user_agent    TEXT,
    page          TEXT
  );
  CREATE INDEX IF NOT EXISTS leads_created ON leads(created_at DESC);
  CREATE INDEX IF NOT EXISTS leads_status  ON leads(status);

  -- Журнал согласий. Отдельно от лида: требование другое — доказать получение согласия,
  -- а не обработать заявку. Записи не меняем и не удаляем руками.
  CREATE TABLE IF NOT EXISTS consents (
    id            TEXT PRIMARY KEY,
    lead_id       TEXT,
    created_at    TEXT NOT NULL,
    documents     TEXT NOT NULL,   -- названия и редакции принятых документов
    texts         TEXT NOT NULL,   -- точные тексты галочек, которые видел человек
    page          TEXT,
    accepted_at   TEXT,            -- время из браузера, только для справки
    ip_hash       TEXT,
    user_agent    TEXT
  );
  CREATE INDEX IF NOT EXISTS consents_created ON consents(created_at DESC);

  -- Файлы резюме. В базе метаданные, сам файл на диске под UUID.
  -- По прямой ссылке никому не отдаётся без авторизации — это персональные данные.
  CREATE TABLE IF NOT EXISTS files (
    id            TEXT PRIMARY KEY,
    lead_id       TEXT NOT NULL,
    stored_name   TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime          TEXT,
    size          INTEGER,
    created_at    TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();

// Хеш IP, а не IP. Соль обязательна, иначе деанонимизировать журнал — дело пяти минут.
// ВАЖНО: если IP_SALT остался дефолтным, в журнале мусор, а не псевдоним. Проверяем на старте и орём.
const hashIp = (req) => {
  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '';
  return createHash('sha256').update(ip + IP_SALT).digest('hex').slice(0, 32);
};

// ---------- Чтение тела запроса ----------
// Сами функции лежат в http.mjs, тут только их использование

// ---------- Валидация. Дублирует то, что в браузере, и это НЕ лишнее ----------
// Проверка на фронте защищает от опечаток, но не от ботов. Обязательные поля проверяем заново.

const LIMITS = { name: 120, contact: 200, comment: 4000, page: 500 };

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function validateLead(body) {
  const errors = [];
  const source = ['modal', 'quiz', 'contacts', 'resume'].includes(body.source) ? body.source : 'modal';
  const name = clean(body.name, LIMITS.name);
  const contact = clean(body.contact ?? body.phone ?? body.email, LIMITS.contact);

  if (!name) errors.push('name');
  if (!contact) errors.push('contact');

  // Галочки обязательны и на сервере. Без них заявку не сохраняем и никуда не передаём (152-ФЗ)
  const consent = body.consentRecord;
  const docs = consent && Array.isArray(consent.documents) ? consent.documents : [];
  if (!docs.length) errors.push('consent');

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    lead: {
      source,
      name,
      contact,
      // Страховка от «умных» ботов с полем на 10 МБ
      payload: JSON.stringify(body).slice(0, 100_000),
      page: clean(consent.page, LIMITS.page),
    },
    consent,
  };
}

// ---------- Файлы резюме ----------
// Расширение проверяем, но решаем по магии первых байт. Иначе .exe переименуют в .pdf и он пролетит
const MAX_FILE = 10 * 1024 * 1024;

function sniffFile(buf, name) {
  const ext = extname(name).toLowerCase();
  const okExt = ['.pdf', '.doc', '.docx'].includes(ext);
  const h = buf.subarray(0, 4);
  const isPdf = h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46; // %PDF
  const isZip = h[0] === 0x50 && h[1] === 0x4b;                                   // docx = zip
  const isDoc = h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0;  // старый .doc
  return okExt && (isPdf || isZip || isDoc);
}

// ---------- Ручки ----------

const routes = {
  // POST /api/lead — приём заявки (JSON или multipart, если есть резюме)
  async 'POST /api/lead'(req, res) {
    const ct = String(req.headers['content-type'] ?? '');
    let body, fileBuf, fileName, fileMime;

    if (ct.includes('multipart/form-data')) {
      const parsed = await readMultipart(req);
      body = parsed.fields;
      fileBuf = parsed.file?.buf;
      fileName = parsed.file?.name;
      fileMime = parsed.file?.mime;
      // consentRecord в multipart приходит строкой JSON — так требует инструкция для сервера
      if (typeof body.consentRecord === 'string') {
        try { body.consentRecord = JSON.parse(body.consentRecord); } catch { body.consentRecord = null; }
      }
    } else {
      body = await readJson(req);
    }

    const v = validateLead(body);
    if (!v.ok) return json(res, 422, { ok: false, errors: v.errors });

    // Файл проверяем ДО записи в базу: не хотим полусостояния «лид есть, файла нет»
    if (fileBuf) {
      if (fileBuf.length > MAX_FILE) return json(res, 413, { ok: false, error: 'file_too_large' });
      if (!sniffFile(fileBuf, fileName ?? '')) return json(res, 415, { ok: false, error: 'file_type' });
    }

    const leadId = randomUUID();
    const ipHash = hashIp(req);
    const ua = clean(req.headers['user-agent'], 400);

    db.prepare(`INSERT INTO leads (id, created_at, source, name, contact, payload, ip_hash, user_agent, page)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(leadId, now(), v.lead.source, v.lead.name, v.lead.contact, v.lead.payload, ipHash, ua, v.lead.page);

    // Журнал согласий пишем сразу и отдельной строкой. Без него заявка юридически бесполезна
    db.prepare(`INSERT INTO consents (id, lead_id, created_at, documents, texts, page, accepted_at, ip_hash, user_agent)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), leadId, now(),
        JSON.stringify(v.consent.documents ?? []),
        JSON.stringify(v.consent.texts ?? []),
        v.lead.page, clean(v.consent.acceptedAt, 40), ipHash, ua);

    let fileId = null;
    if (fileBuf && fileName) {
      fileId = randomUUID();
      const stored = fileId + extname(fileName).toLowerCase(); // имя на диске — UUID, оригинал только в базе
      writeFileSync(join(UPLOAD_DIR, stored), fileBuf);
      db.prepare(`INSERT INTO files (id, lead_id, stored_name, original_name, mime, size, created_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(fileId, leadId, stored, clean(fileName, 255), clean(fileMime, 120), fileBuf.length, now());
    }

    // TODO: отсюда дёргать CRM/почту. Пока только в базу — заявка уже не теряется
    return json(res, 200, { ok: true, id: leadId, file: !!fileId });
  },

  // POST /api/consent — запись согласия на cookie, если человек согласился, но заявку не отправлял
  async 'POST /api/consent'(req, res) {
    const b = await readJson(req);
    if (!b || typeof b !== 'object') return json(res, 400, { ok: false });
    db.prepare(`INSERT INTO consents (id, created_at, documents, texts, page, accepted_at, ip_hash, user_agent)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), now(), JSON.stringify(b.categories ?? []), JSON.stringify([]),
        clean(b.page, LIMITS.page), clean(b.at, 40), hashIp(req), clean(req.headers['user-agent'], 400));
    return json(res, 200, { ok: true });
  },

  // GET /api/health — для мониторинга. Умышленно ничего не отдаёт про сами данные
  async 'GET /api/health'(req, res) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
    return json(res, 200, { ok: true, leads: count });
  },
};

// Защита от ботов: ограничение частоты по IP-хешу, в памяти. На один инстанс хватает.
// За балансировщиком это придётся менять на Redis, иначе каждый инстанс считает своё и лимит врёт.
//
// Лимиты разные, и это не придирка: 5 запросов в минуту на все POST — это и защита, и саботаж.
// Маркетолог грузит десять фото подряд и упирается в 429, а HR не может сохранить вакансию.
// Поэтому логин давим жёстко (там перебор паролей), остальное — мягко.
const hits = new Map();
function rateLimited(key, max, windowMs = 60_000) {
  const t = Date.now();
  const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  arr.push(t);
  hits.set(key, arr);
  return arr.length > max;
}

// Чистим карту, чтобы она не пухла от ботов, которые меняют IP. Раз в 10 минут хватает
setInterval(() => {
  const t = Date.now();
  for (const [k, arr] of hits) {
    const alive = arr.filter((x) => t - x < 60_000);
    if (alive.length) hits.set(k, alive); else hits.delete(k);
  }
}, 600_000).unref();

// Ручки админки живут в server/admin.mjs. Здесь только склейка двух наборов —
// иначе index.mjs распухнет до нечитаемого состояния.
const allRoutes = { ...routes, ...adminRoutes };

// :id и :key в путях — простой матчинг без роутера. Три параметризованных ручки, тянуть path-to-regexp не за чем
function matchRoute(method, pathname) {
  const direct = allRoutes[`${method} ${pathname}`];
  if (direct) return { handler: direct, params: {} };
  for (const [key, handler] of Object.entries(allRoutes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const names = [];
    const rx = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const hit = pathname.match(rx);
    if (hit) return { handler, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])])) };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Медиатека отдаётся отдельно и раньше роутера: имя файла проверяется в serveMedia по базе
  if ((req.method ?? 'GET') === 'GET' && url.pathname.startsWith('/media/')) {
    return serveMedia(req, res, url.pathname.slice('/media/'.length));
  }

  // Резюме — только по авторизации. Проверка роли внутри serveResume, тут ничего не решаем
  if ((req.method ?? 'GET') === 'GET' && url.pathname.startsWith('/api/admin/files/')) {
    return serveResume(req, res, url.pathname.slice('/api/admin/files/'.length));
  }

  const route = matchRoute(req.method ?? 'GET', url.pathname);
  const handler = route?.handler;
  if (!handler) return json(res, 404, { ok: false, error: 'not_found' });

  // Лимиты только на запись — GET/health пусть опрашивают сколько хотят
  if (req.method !== 'GET') {
    const ip = hashIp(req);
    const isLogin = url.pathname === '/api/admin/login';
    // Логин: 5 попыток в минуту на IP. Перебор пароля должен упираться, а не идти со скоростью сети
    const limited = isLogin ? rateLimited('login:' + ip, 5) : rateLimited('write:' + ip, 60);
    if (limited) return json(res, 429, { ok: false, error: 'too_many_requests' });
  }

  try {
    await handler(req, res, url, route.params);
  } catch (e) {
    // Наружу — ничего. В лог — стек. Клиенту статус и сухое сообщение
    console.error('[api]', url.pathname, e?.message ?? e);
    json(res, e?.message === 'body_too_large' ? 413 : 500, { ok: false, error: 'internal' });
  }
});

// Дефолтная соль = фикция вместо псевдонима. Не валим сервис (сайт важнее),
// но пишем так, чтобы это увидели в логах и на мониторинге
if (IP_SALT === 'CHANGE_ME_IN_ENV' || IP_SALT.length < 16) {
  console.error('[api] ВНИМАНИЕ: IP_SALT не задан или слишком короткий. Хеши IP в журнале согласий бесполезны. Задай случайную строку 32+ символа в .env');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] слушаю ${PORT}, база ${DB_PATH}`);
  sweepOld();                       // подчистка при старте
  setInterval(sweepOld, 86_400_000); // и раз в сутки. Не чаще: это тяжёлый проход по таблицам
});

// ---------- Удаление по срокам ----------
// Собственные документы обещают удалять данные. Если не делать руками — пусть делает код
function sweepOld() {
  const cut = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const oldLeads = db.prepare(`SELECT id FROM leads WHERE created_at < ? AND status != 'in_progress'`).all(cut(RETENTION.lead_days));
    for (const l of oldLeads) {
      const f = db.prepare('SELECT stored_name FROM files WHERE lead_id = ?').all(l.id);
      for (const x of f) {
        const p = join(UPLOAD_DIR, x.stored_name);
        if (existsSync(p)) rmSync(p);
      }
      db.prepare('DELETE FROM files WHERE lead_id = ?').run(l.id);
      db.prepare('DELETE FROM leads WHERE id = ?').run(l.id);
    }
    // Журнал согласий живёт дольше лида — на него срок отдельный
    db.prepare('DELETE FROM consents WHERE created_at < ?').run(cut(RETENTION.consent_days));
    if (oldLeads.length) console.log(`[cleanup] удалено заявок: ${oldLeads.length}`);
  } catch (e) {
    // Упавшая подчистка не должна валить сервис. Но и молчать нельзя — сюда надо смотреть глазами
    console.error('[cleanup] сломалось:', e);
  }
}
