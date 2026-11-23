// Создать первого пользователя админки. Запускать руками, один раз, на сервере.
//
//   node server/seed-user.mjs andrey@steklyanika.ru admin 'пароль-минимум-12-символов'
//   node server/seed-user.mjs hr@steklyanika.ru hr 'пароль'
//   node server/seed-user.mjs mkt@steklyanika.ru marketing 'пароль'
//
// Почему скриптом, а не «регистрацией»: в админке с персональными данными саморегистрация — это подарок
// для любого, кто узнал адрес. Пользователей заводит только тот, у кого есть доступ к серверу.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH ?? './data/steklyanika.db';
const [email, role = 'viewer', password] = process.argv.slice(2);

const ROLES = ['admin', 'hr', 'marketing', 'viewer'];

if (!email || !password) {
  console.error('Использование: node server/seed-user.mjs <email> <admin|hr|marketing|viewer> <пароль>');
  process.exit(1);
}
if (!ROLES.includes(role)) {
  console.error(`Роль должна быть одной из: ${ROLES.join(', ')}`);
  process.exit(1);
}
// Длину проверяем на входе: слабый пароль в админке к персданным — это не «мелочь на потом»
if (password.length < 12) {
  console.error('Пароль короче 12 символов. Для админки с персональными данными так нельзя.');
  process.exit(1);
}

// Папку под базу создаём сами. SQLite не умеет создавать каталоги, а на свежем клоне data/ нет:
// без этого скрипт падал с 'unable to open database file' прямо на первом запуске
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, last_login TEXT);`);

const salt = randomBytes(16);
const passHash = `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
const mail = email.trim().toLowerCase();

// Сравнение было бы достаточно, но ON CONFLICT надёжнее: повторный запуск не создаст дубль,
// а просто обновит пароль и роль. Удобно, когда забыли пароль от своей же админки
db.prepare(`INSERT INTO users (id, email, name, pass_hash, role, active, created_at) VALUES (?,?,?,?,?,1,?)
            ON CONFLICT(email) DO UPDATE SET pass_hash = excluded.pass_hash, role = excluded.role, active = 1`)
  .run(randomUUID(), mail, mail.split('@')[0], passHash, role, new Date().toISOString());

console.log(`Готово: ${mail}, роль ${role}. Пароль в базе лежит хешем, восcтановить его нельзя — только сбросить этим же скриптом.`);
