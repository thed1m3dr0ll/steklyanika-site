#!/bin/bash
# Запуск сайта и кабинета на macOS. Двойной клик во Finder — и всё поднимается.
# Первый запуск делает всю настройку сам: зависимости, .env, пользователей, демо-данные.
#
# Если Terminal ругается «нет прав» — выполни один раз:
#   chmod +x "Запустить всё.command"
set -e
cd "$(dirname "$0")"

# Node нужен 22+, иначе Astro 7 просто не запустится. Ищем локальную копию, потом системную
if [ -x "$HOME/.local/node22/bin/node" ]; then
  export PATH="$HOME/.local/node22/bin:$PATH"
elif ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Нужен Node.js 22 или новее."
  echo "Скачай LTS с https://nodejs.org и запусти снова."
  exit 1
fi
echo "Node: $(node -v)"

# .env из шаблона, соли генерим свои — дефолтную оставлять нельзя
if [ ! -f .env ]; then
  cp .env.example .env
  SALT=$(LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 48)
  sed -i '' "s|^IP_SALT=.*|IP_SALT=$SALT|" .env
  echo "Создан .env со случайной солью для хеша IP"
fi

# Зависимости сайта
# Проверяем не папку, а конкретный пакет: после git pull node_modules может существовать,
# но без @astrojs/sitemap — и сборка упадёт с непонятной ошибкой импорта
if [ ! -d site/node_modules/@astrojs/sitemap ]; then
  echo "Ставлю зависимости (один раз, пара минут)..."
  (cd site && npm install --no-audit --no-fund)
fi

# Папку под базу создаём до всех скриптов. SQLite каталоги не делает, а в git data/ не лежит:
# на свежем клоне его нет, и раньше сервер падал с 'unable to open database file'
mkdir -p data

# Сервер заявок поднимаем ПЕРВЫМ. Он создаёт схему базы (leads, vacancies, applications, texts).
# Демо-скрипт вставляет строки в эти таблицы, поэтому раньше него идти не может —
# на чистой машине падал с 'no such table: leads'
echo "Поднимаю сервер заявок..."
node --env-file=.env server/index.mjs &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT INT TERM

# Ждём, пока база реально откроется. Без этого окна — гонка: сервер ещё грузится, а seed уже стучится.
# 40 попыток по четверти секунды = 10 секунд потолок
for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "http://127.0.0.1:${API_PORT:-8787}/api/health" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

# Пользователи и демо. Повторный запуск ничего не ломает: seed-user обновляет, а не дублирует.
# Ошибки не глушим молча — иначе на пустой базе человек увидит пустой кабинет и не поймёт почему
node server/seed-user.mjs boss@steklyanika.ru admin 'admin-pass-2026!' || echo "!! не создался админ"
node server/seed-user.mjs hr@steklyanika.ru hr 'hr-pass-2026!' || echo "!! не создался HR"
node server/seed-user.mjs mkt@steklyanika.ru marketing 'mkt-pass-2026!' || echo "!! не создался маркетинг"
node server/seed-demo.mjs || echo "!! демо-данные не залились"

# Сайт на переднем плане
echo "Поднимаю сайт..."

cd site
echo
echo "======================================================================"
echo "  Сайт:    http://localhost:4321"
echo "  Кабинет: http://localhost:4321/admin/cabinet/"
echo
echo "  Вход:    boss@steklyanika.ru / admin-pass-2026!   (админ)"
echo "           hr@steklyanika.ru   / hr-pass-2026!      (HR)"
echo "           mkt@steklyanika.ru  / mkt-pass-2026!     (маркетинг)"
echo "======================================================================"
echo
# Открываем браузер сами: человек только что запустил скрипт, ему не нужно копировать адрес
(sleep 6 && open "http://localhost:4321/admin/cabinet/") &
npm run dev
