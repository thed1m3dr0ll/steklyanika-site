// Синхронизация с HH.ru: вакансии работодателя и отклики на них.
//
// ЧЕСТНОЕ ПРЕДУПРЕЖДЕНИЕ, прочитай до того, как включать:
// 1. У работодателя отклики забираются НЕ одним запросом. Схема трёхступенчатая:
//    список вакансий -> коллекции по вакансии -> отклики в коллекции.
// 2. Доступ к методу получения откликов у HH ПЛАТНЫЙ (пакеты запросов).
//    Список коллекций бесплатный, а сами отклики тарифицируются. Считай бюджет заранее.
// 3. OAuth-токен работодателя живёт ограниченное время, refresh_token надо хранить и обновлять.
//    Просроченный refresh = разлогин, и синхронизация встанет молча. Поэтому в базе держим дату.
//
// Код написан так, чтобы работать без токена: в этом режиме возвращает понятную заглушку,
// а не падает. Так кабинет открывается и до подключения HH.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const DB_PATH = process.env.DB_PATH ?? './data/steklyanika.db';
const API = 'https://api.hh.ru';
// HH просит представляться в User-Agent названием приложения и контактом.
// Без этого они могут резать запросы. Контакт обязателен по их правилам
const UA = `SteklyanikaAdmin/1.0 (${process.env.HH_CONTACT ?? 'admin@steklyanika.ru'})`;

const db = new DatabaseSync(DB_PATH);

// Таблица токенов: одна строка на провайдера. refresh_token — секрет, в логи не попадает НИКОГДА
db.exec(`
  CREATE TABLE IF NOT EXISTS hh_tokens (
    id            INTEGER PRIMARY KEY CHECK (id = 1), -- всегда одна строка
    access_token  TEXT,
    refresh_token TEXT,
    expires_at    TEXT,
    updated_at    TEXT NOT NULL
  );

  -- Лог синхронизации. Без него непонятно, почему отклики не появились:
  -- токен протух, лимит кончился или HH ответил 403
  CREATE TABLE IF NOT EXISTS hh_sync_log (
    id         TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status     TEXT,   -- ok | error | no_token
    message    TEXT,
    vacancies  INTEGER DEFAULT 0,
    applications INTEGER DEFAULT 0
  );
`);

const now = () => new Date().toISOString();

const configured = () => Boolean(process.env.HH_CLIENT_ID && process.env.HH_CLIENT_SECRET);

// ---------- Токены ----------

function loadToken() {
  return db.prepare('SELECT * FROM hh_tokens WHERE id = 1').get() ?? null;
}

function saveToken(t) {
  db.prepare(`INSERT INTO hh_tokens (id, access_token, refresh_token, expires_at, updated_at)
              VALUES (1,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token,
              refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
              updated_at = excluded.updated_at`)
    .run(t.access_token, t.refresh_token, t.expires_at, now());
}

// Обновляем заранее, за минуту до конца. Иначе на границе получим 403 в самый неподходящий момент
async function freshAccessToken() {
  const t = loadToken();
  if (!t?.access_token) return null;

  const expiresAt = t.expires_at ? Date.parse(t.expires_at) : 0;
  if (Date.now() < expiresAt - 60_000) return t.access_token;

  if (!t.refresh_token) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
    client_id: process.env.HH_CLIENT_ID ?? '',
    client_secret: process.env.HH_CLIENT_SECRET ?? '',
  });

  const r = await fetch(`${API}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body,
  });
  if (!r.ok) {
    // Не логируем тело: там может быть эхо refresh_token
    console.error('[hh] refresh не прошёл, статус', r.status);
    return null;
  }
  const j = await r.json();
  saveToken({
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? t.refresh_token,
    expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString(),
  });
  return j.access_token;
}

// Один враппер на все запросы к HH: тут же User-Agent, таймаут и разбор ошибок.
// Повторяем один раз при 403 — часто это просто протухший токен, который успел обновиться
async function hhGet(path, retry = true) {
  const token = await freshAccessToken();
  if (!token) throw new Error('no_token');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
      signal: ctrl.signal,
    });

    if (r.status === 403 && retry) {
      // Принудительно считаем токен просроченным и пробуем ещё раз
      db.prepare('UPDATE hh_tokens SET expires_at = ? WHERE id = 1').run(new Date(0).toISOString());
      return hhGet(path, false);
    }
    // 429 — лимит запросов. HH отдаёт Retry-After, но ждать в синхронном запросе нельзя,
    // поэтому просто честно сообщаем наверх
    if (r.status === 429) throw new Error('rate_limited');
    if (!r.ok) throw new Error(`hh_${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Маппинг статусов ----------
// Статусы HH (employer_states / negotiations_state) в наши. Список у HH меняется,
// поэтому всё неизвестное аккуратно падает в 'new' — лучше лишний раз показать HR, чем потерять
const STATE_MAP = {
  response: 'new',
  consideration: 'screened',
  invitation: 'invited',
  discard: 'rejected',
  hiring: 'hired',
};

const mapState = (id) => STATE_MAP[id] ?? 'new';

// ---------- Синхронизация ----------

/**
 * Тянет вакансии и отклики. Возвращает отчёт, а не кидает исключение:
 * синхронизация по кнопке не должна валить весь сервер.
 */
export async function syncHH() {
  const logId = randomUUID();
  db.prepare('INSERT INTO hh_sync_log (id, started_at, status) VALUES (?,?,?)').run(logId, now(), 'running');

  const finish = (status, message, vac = 0, app = 0) => {
    db.prepare('UPDATE hh_sync_log SET finished_at = ?, status = ?, message = ?, vacancies = ?, applications = ? WHERE id = ?')
      .run(now(), status, message, vac, app, logId);
    return { ok: status === 'ok', status, message, vacancies: vac, applications: app };
  };

  if (!configured()) return finish('no_token', 'HH_CLIENT_ID и HH_CLIENT_SECRET не заданы в .env');
  if (!loadToken()?.access_token) return finish('no_token', 'Нет токена. Получи его через /api/admin/hh/auth и сохрани');

  let vacCount = 0;
  let appCount = 0;

  try {
    // 1. Свои активные вакансии. manager_id не передаём — берём все, на которые есть права
    const vac = await hhGet('/vacancies/active?per_page=100');
    for (const v of vac.items ?? []) {
      db.prepare(`INSERT INTO vacancies (slug, title, status, hh_url, updated_at) VALUES (?,?,?,?,?)
                  ON CONFLICT(slug) DO UPDATE SET title = excluded.title, status = 'open',
                  hh_url = excluded.hh_url, updated_at = excluded.updated_at`)
        .run(`hh-${v.id}`, String(v.name ?? 'Без названия').slice(0, 200), 'open', String(v.alternate_url ?? ''), now());
      vacCount++;

      // 2. Коллекции откликов по вакансии. Бесплатно, но и данных там нет — только ссылки
      let collections = [];
      try {
        const c = await hhGet(`/negotiations?vacancy_id=${encodeURIComponent(v.id)}`);
        collections = c.collections ?? [];
      } catch (e) {
        // По одной вакансии упало — не роняем весь прогон. Причина попадёт в лог ниже
        console.warn('[hh] коллекции не получены для', v.id, e?.message ?? e);
        continue;
      }

      for (const col of collections) {
        // 3. Сами отклики. ВОТ ЗДЕСЬ ТАРИФИКАЦИЯ — каждый такой запрос стоит денег
        let items = [];
        try {
          const path = String(col.url ?? '').replace(API, '');
          if (!path) continue;
          const r = await hhGet(path);
          items = r.items ?? [];
        } catch (e) {
          console.warn('[hh] отклики не получены, коллекция', col.id, e?.message ?? e);
          continue;
        }

        for (const n of items) {
          // external_id собираем из номера отклика и коллекции: HH отдаёт один отклик
          // в разных коллекциях, без составного ключа получим дубли
          const ext = `hh:${n.id}:${col.id}`;
          db.prepare(`INSERT INTO applications
                      (id, vacancy_slug, source, external_id, name, contact, resume_url, status, hh_status, created_at, synced_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?)
                      ON CONFLICT(source, external_id) DO UPDATE SET
                        status = excluded.status, hh_status = excluded.hh_status, synced_at = excluded.synced_at`)
            .run(randomUUID(), `hh-${v.id}`, 'hh', ext,
              String(n.resume?.last_name ?? '') + ' ' + String(n.resume?.first_name ?? ''),
              n.resume?.alternate_url ? 'см. резюме на HH' : '', // контакты HH скрывает до приглашения
              String(n.resume?.alternate_url ?? ''),
              mapState(n.state?.id), String(n.state?.id ?? ''), String(n.created_at ?? now()), now());
          appCount++;
        }
      }
    }
    return finish('ok', 'Синхронизация прошла', vacCount, appCount);
  } catch (e) {
    const msg = e?.message === 'rate_limited' ? 'HH ответил 429: кончился лимит запросов' : String(e?.message ?? e);
    return finish('error', msg, vacCount, appCount);
  }
}

// ---------- OAuth: первичная авторизация ----------
// Одноразовый обмен кода на токен. Дальше живём на refresh_token
export function authUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.HH_CLIENT_ID ?? '',
    redirect_uri: process.env.HH_REDIRECT_URI ?? 'http://localhost:8787/api/admin/hh/callback',
  });
  return `${API}/oauth/authorize?${params}`;
}

export async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: process.env.HH_CLIENT_ID ?? '',
    client_secret: process.env.HH_CLIENT_SECRET ?? '',
    redirect_uri: process.env.HH_REDIRECT_URI ?? 'http://localhost:8787/api/admin/hh/callback',
  });
  const r = await fetch(`${API}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body,
  });
  if (!r.ok) throw new Error(`hh_token_${r.status}`);
  const j = await r.json();
  saveToken({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString(),
  });
  return { ok: true, expires_at: new Date(Date.now() + (j.expires_in ?? 3600) * 1000).toISOString() };
}

export function hhStatus() {
  const t = loadToken();
  const last = db.prepare('SELECT * FROM hh_sync_log ORDER BY started_at DESC LIMIT 1').get();
  return {
    configured: configured(),
    hasToken: Boolean(t?.access_token),
    expiresAt: t?.expires_at ?? null,
    lastSync: last ?? null,
  };
}
