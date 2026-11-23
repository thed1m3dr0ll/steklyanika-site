// Демо-данные, чтобы кабинеты было на что смотреть при первом запуске.
// Запускать ТОЛЬКО на локальной машине и НЕ на боевой базе. На проде этого делать нельзя:
// фейковые заявки в журнале согласий — это ложные персональные данные, и по ним потом отчитываться.
//
//   node server/seed-demo.mjs
//
// Если база боевая, скрипт откажется работать без явного флага --force.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH ?? './data/steklyanika.db';
const force = process.argv.includes('--force');

if (process.env.NODE_ENV === 'production' && !force) {
  console.error('NODE_ENV=production. Демо-данные в боевую базу не заливаем. Нужно очень — добавь --force');
  process.exit(1);
}

// Та же причина, что в seed-user: на чистом клоне каталога нет, SQLite сам его не создаст
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
const now = () => new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

// Заявки: разные источники и статусы, чтобы фильтры в кабинете было видно в работе
const LEADS = [
  { source: 'modal', name: 'Алексей Морозов', contact: '+7 910 445-12-88', status: 'new', page: 'https://steklyanika.ru/', d: 0 },
  { source: 'quiz', name: 'Ирина Соколова', contact: 'i.sokolova@mail.ru', status: 'new', page: 'https://steklyanika.ru/services/', d: 1 },
  { source: 'resume', name: 'Дмитрий Ковалёв', contact: 'kovalev.d@yandex.ru', status: 'in_progress', page: 'https://steklyanika.ru/careers/', d: 2 },
  { source: 'contacts', name: 'ООО «Гринвуд»', contact: '+7 831 220-45-67', status: 'in_progress', page: 'https://steklyanika.ru/contacts/', d: 3 },
  { source: 'modal', name: 'Сергей Литвинов', contact: '+7 903 118-77-42', status: 'archived', page: 'https://steklyanika.ru/partners/developers/', d: 8 },
  { source: 'quiz', name: 'Бот-спам', contact: 'promo@spam.biz', status: 'spam', page: 'https://steklyanika.ru/', d: 9 },
];

const insLead = db.prepare(`INSERT OR IGNORE INTO leads (id, created_at, source, name, contact, payload, status, ip_hash, user_agent, page)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`);
const insConsent = db.prepare(`INSERT OR IGNORE INTO consents (id, lead_id, created_at, documents, texts, page, accepted_at, ip_hash, user_agent)
                               VALUES (?,?,?,?,?,?,?,?,?)`);

for (const l of LEADS) {
  const id = randomUUID();
  insLead.run(id, daysAgo(l.d), l.source, l.name, l.contact,
    JSON.stringify({ source: l.source, name: l.name, contact: l.contact, message: 'Демо-заявка для проверки кабинета' }),
    l.status, 'demo_hash', 'Mozilla/5.0 (демо)', l.page);
  // Запись согласия кладём к каждой заявке — ровно так же, как это делает настоящий приём
  insConsent.run(randomUUID(), id, daysAgo(l.d),
    JSON.stringify(['Согласие на обработку персональных данных, ред. 2']),
    JSON.stringify(['Я даю согласие на обработку персональных данных']),
    l.page, daysAgo(l.d), 'demo_hash', 'Mozilla/5.0 (демо)');
}

// Вакансии — зеркало того, что лежит в src/content/vacancies
const insVac = db.prepare(`INSERT INTO vacancies (slug, title, status, hh_url, updated_at) VALUES (?,?,?,?,?)
                           ON CONFLICT(slug) DO UPDATE SET title = excluded.title, status = excluded.status`);
insVac.run('inzhener-konstruktor', 'Инженер-конструктор', 'open', 'https://hh.ru/vacancy/100000001', now());
insVac.run('tehnolog-konstruktor', 'Технолог-конструктор', 'open', '', now());
insVac.run('manager-proektov', 'Менеджер проектов', 'paused', '', now());

// Отклики, включая один с HH: проверяем, что дедупликация по external_id работает
const insApp = db.prepare(`INSERT OR IGNORE INTO applications (id, vacancy_slug, source, external_id, name, contact, resume_url, status, created_at)
                           VALUES (?,?,?,?,?,?,?,?,?)`);
insApp.run(randomUUID(), 'inzhener-konstruktor', 'site', null, 'Дмитрий Ковалёв', 'kovalev.d@yandex.ru', '/api/admin/files/demo', 'new', daysAgo(2));
insApp.run(randomUUID(), 'inzhener-konstruktor', 'hh', 'hh:44112233', 'Анна Белова', 'anna.b@mail.ru', 'https://hh.ru/resume/abc123', 'screened', daysAgo(4));
insApp.run(randomUUID(), 'tehnolog-konstruktor', 'hh', 'hh:44112299', 'Павел Титов', '+7 920 334-55-66', 'https://hh.ru/resume/def456', 'invited', daysAgo(6));

// Тексты: один опубликован, один черновик — маркетолог увидит разницу статусов
const insText = db.prepare(`INSERT INTO texts (key, value, status, updated_by, updated_at) VALUES (?,?,?,?,?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value, status = excluded.status,
                            updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
insText.run('home.hero.title', 'Больше света. Больше возможностей.', 'published', 'marketing@steklyanika.ru', daysAgo(5));
insText.run('home.hero.subtitle', 'Светопрозрачные конструкции под ключ — от эскиза до монтажа', 'published', 'marketing@steklyanika.ru', daysAgo(5));
insText.run('home.hero.subtitle', 'Светопрозрачные конструкции под ключ — от эскиза до монтажа. Работаем по всей России', 'draft', 'marketing@steklyanika.ru', daysAgo(1));
insText.run('about.intro', 'Мы проектируем и производим конструкции с 2014 года', 'draft', 'marketing@steklyanika.ru', now());

console.log(`Демо-данные залиты: заявок ${LEADS.length}, вакансий 3, откликов 3, текстов 4`);
console.log('Не забудь перед боевым запуском почистить: удалить data/*.db и залить заново пустую.');
