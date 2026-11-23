// ═══════════════════════════════════════════════════════════════════════════════
//  КЛИЕНТСКИЙ СКРИПТ cookies.ts · 124 строк
// ═══════════════════════════════════════════════════════════════════════════════
// 
//  КАРТА ФАЙЛА — блоки и строки:
// 
//  13  ЭКСПОРТ        CONSENT_VERSION
//  15  ЭКСПОРТ        POLICY_EDITION
//  18  ТИП            CookieChoice
//  19  ТИП            CookieCategory
//  20  ТИП            ConsentRecord
//  33  ФУНКЦИЯ        isValid
//  43  ЭКСПОРТ ФН     getConsent
//  51  ЭКСПОРТ ФН     getCookieChoice
//  56  ЭКСПОРТ ФН     hasConsent
//  60  ФУНКЦИЯ        newId
//  65  ЭКСПОРТ ФН     setCookieChoice
//  87  ФУНКЦИЯ        sendConsentRecord
// 
// 
// ═══════════════════════════════════════════════════════════════════════════════
// Согласие посетителя на необязательные технологии: единый выбор «Принять» / «Отклонить»
// (баннер — components/CookieBanner.astro). Аналитика и реклама разрешаются и запрещаются вместе, отдельных переключателей нет.
// Здесь только запись и чтение решения. Загрузка и отключение сервисов — в scripts/trackers.ts.
//
// Запись в localStorage — необходимая технология: она нужна, чтобы применять выбор посетителя, и никуда не передаётся.
// Юридическим подтверждением согласия она не служит: посетитель может её удалить или изменить.
// Для подтверждения запись нужно хранить на сервере — см. sendConsentRecord() ниже.

const KEY = 'stk-cookie-choice';

// Поднять, если изменился состав сервисов или условия согласия: у всех старые записи перестанут действовать,
// необязательные технологии отключатся, и посетитель увидит баннер снова.
export const CONSENT_VERSION = 2;
// Редакция Политики cookie, с которой согласился посетитель. Менять вместе с текстом src/content/docs/cookies.md
export const POLICY_EDITION = '2026-11-05';
const TTL = 365 * 24 * 3600e3; // через год спрашиваем снова

export type CookieChoice = 'accepted' | 'declined';
export type CookieCategory = 'analytics' | 'ads';
export type ConsentRecord = {
  id: string;                                // случайный номер записи, с личностью посетителя не связан
  v: number;                                 // версия механизма согласия
  policy: string;                            // редакция Политики cookie
  choice: CookieChoice;
  categories: Record<CookieCategory, boolean>;
  at: string;                                // дата и время выбора
  source: 'banner' | 'settings';             // первый показ баннера или ссылка «Настройки cookie»
};

// Если localStorage недоступен, выбор действует только до ухода со страницы; дальше — снова баннер и блокировка
let unsaved: ConsentRecord | null = null;

function isValid(s: ConsentRecord | null): s is ConsentRecord {
  if (!s || s.v !== CONSENT_VERSION) return false;
  if (s.choice !== 'accepted' && s.choice !== 'declined') return false;
  const at = Date.parse(s.at);
  if (Number.isNaN(at) || Date.now() - at > TTL) return false;
  // Запись, где категории не совпадают с решением, не считаем согласием
  const allowed = s.choice === 'accepted';
  return s.categories?.analytics === allowed && s.categories?.ads === allowed;
}

export function getConsent(): ConsentRecord | null {
  if (unsaved) return unsaved;
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') as ConsentRecord | null;
    return isValid(s) ? s : null;
  } catch { return null; }
}

export function getCookieChoice(): CookieChoice | null {
  return getConsent()?.choice ?? null;
}

// Единственная проверка разрешения. Нет записи — нет разрешения.
export function hasConsent(category: CookieCategory): boolean {
  return getConsent()?.categories[category] === true;
}

function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function setCookieChoice(choice: CookieChoice, source: ConsentRecord['source']) {
  const allowed = choice === 'accepted';
  const record: ConsentRecord = {
    id: getConsent()?.id ?? newId(),
    v: CONSENT_VERSION,
    policy: POLICY_EDITION,
    choice,
    categories: { analytics: allowed, ads: allowed },
    at: new Date().toISOString(),
    source,
  };
  unsaved = null;
  try { localStorage.setItem(KEY, JSON.stringify(record)); } catch { unsaved = record; }
  sendConsentRecord(record);
  notify();
}

// Передача записи на сервер. Запись в localStorage юридически ничего не доказывает:
// посетитель может её удалить или подправить через devtools. Поэтому дублируем на сервер.
//
// keepalive — критично: человек часто ставит галочку и сразу закрывает вкладку.
// Без keepalive браузер прибьёт запрос вместе со страницей, и согласие потеряется.
function sendConsentRecord(record: ConsentRecord) {
  try {
    // Ошибку сети намеренно глотаем: не ронять же интерфейс из-за аналитики.
    // Но и молчать нельзя — в консоль, чтобы при разборе жалоб было видно
    fetch('/api/consent', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    }).catch((e) => console.warn('[согласие] запись не ушла на сервер', e));
  } catch (e) {
    console.warn('[согласие] отправка недоступна', e);
  }
}

const listeners: (() => void)[] = [];
let lastSeen = '';
const stampOf = (r: ConsentRecord | null) => (r ? `${r.id}|${r.at}` : '');

function notify() {
  lastSeen = stampOf(getConsent());
  listeners.forEach((cb) => cb());
}

// Вызывается при любом изменении выбора, в том числе сделанном в другой вкладке
export function onConsentChange(cb: () => void) {
  listeners.push(cb);
}

export function initConsent() {
  lastSeen = stampOf(getConsent());
  const syncIfChanged = () => { if (stampOf(getConsent()) !== lastSeen) notify(); };
  // Выбор изменили в другой вкладке
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) syncIfChanged(); });
  // Страница вернулась кнопкой «Назад» из кэша браузера, а выбор за это время изменился
  window.addEventListener('pageshow', (e) => { if (e.persisted) syncIfChanged(); });
}
