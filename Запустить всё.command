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
if [ ! -d site/node_modules ]; then
  echo "Ставлю зависимости (один раз, пару минут)..."
  (cd site && npm install --no-audit --no-fund)
fi

# База и пользователи. Повторный запуск ничего не ломает: seed-user обновляет, а не дублирует
node server/seed-user.mjs boss@steklyanika.ru admin 'admin-pass-2026!' 2>/dev/null || true
node server/seed-user.mjs hr@steklyanika.ru hr 'hr-pass-2026!' 2>/dev/null || true
node server/seed-user.mjs mkt@steklyanika.ru marketing 'mkt-pass-2026!' 2>/dev/null || true
node server/seed-demo.mjs 2>/dev/null || true

# Сервер заявок в фоне, сайт на переднем плане. При закрытии окна гасим оба
echo "Поднимаю сервер заявок и сайт..."
node --env-file=.env server/index.mjs &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT INT TERM

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
npm run dev
