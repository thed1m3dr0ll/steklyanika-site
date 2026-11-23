// ═══════════════════════════════════════════════════════════════════════════════
//  КЛИЕНТСКИЙ СКРИПТ leads.ts · 163 строк
// ═══════════════════════════════════════════════════════════════════════════════
// 
//  КАРТА ФАЙЛА — блоки и строки:
// 
//  6  ТИП            LeadSource
//  10  ФУНКЦИЯ        consentRecord
//  27  ЭКСПОРТ ФН     submitLead
//  32  ФУНКЦИЯ        file
//  76  ЭКСПОРТ        formErrors
//  85  ФУНКЦИЯ        markTarget
//  88  ЭКСПОРТ ФН     markInvalid
//  89  ЭКСПОРТ ФН     clearInvalid
//  91  ФУНКЦИЯ        contactOk
//  93  ФУНКЦИЯ        fieldProblem
//  106  ЭКСПОРТ ФН     checkForm
//  122  ЭКСПОРТ ФН     initFormCheck
// 
// 
// ═══════════════════════════════════════════════════════════════════════════════
// Отправка и проверка заявок с сайта (окно заявки, квиз, резюме).
// Сейчас заявки никуда не уходят — только выводятся в консоль браузера.
// Подключение сервера и CRM делается здесь, в одном месте: что нужно сделать — ДЛЯ-РАЗРАБОТЧИКА.md, раздел «Заявки и согласия».
// Внимание: в заявке 'resume' есть файл (поле resume, File) — его нужно отправлять как FormData, а не JSON.

export type LeadSource = 'modal' | 'quiz' | 'contacts' | 'resume';

// Что именно подтвердил человек: документы и редакции, точные тексты у галочек, страница, время.
// Время из браузера — только для справки: в журнале согласий основным считается время сервера.
function consentRecord(form: HTMLFormElement) {
  const boxes = [...form.querySelectorAll<HTMLInputElement>('input[data-consent]')];
  return {
    documents: boxes.map((b) => b.value),
    texts: boxes.map((b) => (b.closest('label')?.textContent ?? '').replace(/\s+/g, ' ').trim()),
    page: location.origin + location.pathname,
    acceptedAt: new Date().toISOString(),
  };
}

// Куда стучимся. В dev Astro проксирует /api на локальный сервер заявок (см. astro.config.mjs),
// в проде это тот же путь за тем же доменом — nginx разрулит. Абсолютных адресов тут быть не должно:
// смена домена не должна требовать правки фронта.
const API = '/api';

// Заявка улетает на сервер. Ошибка сети не должна «терять» человека: он уже нажал кнопку,
// нарисовать ему «попробуйте ещё раз» честнее, чем делать вид, что всё ушло.
export async function submitLead(source: LeadSource, form: HTMLFormElement, data: Record<string, unknown>): Promise<void> {
  const payload = { source, ...data, consentRecord: consentRecord(form) };

  // Резюме отправляем как FormData: файл в JSON не влезет, а base64 раздувает его на треть.
  // В этом случае consentRecord едет строкой — сервер разбирает её сам (он это умеет, проверено).
  const file = (data.resume as File | undefined) ?? (form.querySelector<HTMLInputElement>('input[type="file"]')?.files?.[0]);
  let body: BodyInit;
  const headers: Record<string, string> = {};

  if (source === 'resume' && file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined || v === null) continue;
      fd.append(k, typeof v === 'object' && !(v instanceof File) ? JSON.stringify(v) : String(v));
    }
    fd.set('resume', file);
    body = fd; // Content-Type не ставим руками — браузер сам добавит boundary, иначе сервер не разберёт
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }

  // Жёсткий таймаут. Без него «вечная» отправка вешает кнопку в состоянии загрузки и человек уходит
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);

  try {
    const res = await fetch(`${API}/lead`, { method: 'POST', headers, body, signal: ctrl.signal });
    if (!res.ok) {
      // 422 — сервер завернул данные: значит, наша проверка что-то пропустила.
      // 429 — прилетели ботом или слишком часто. Разные тексты, чтобы человек понимал, что делать
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error === 'too_many_requests' ? 'Слишком много попыток, подождите минуту' : 'Заявка не прошла проверку на сервере');
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Проверка формы перед отправкой ----------
// Обязательные поля — те, у которых есть атрибут required. Скрытые (disabled) не проверяются.
// Эта проверка — для человека; бота она не остановит, поэтому на сервере нужно проверять всё заново.

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const INVALID = 'is-invalid';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_CHARS = /^[\d\s()+-]+$/;

export const formErrors = {
  required: 'Заполните обязательные поля',
  consent: 'Чтобы отправить форму, отметьте обязательные галочки',
  phone: 'Проверьте номер телефона: в нём должно быть 11 цифр',
  email: 'Проверьте адрес электронной почты',
  contact: 'Проверьте телефон или e-mail: кажется, в нём ошибка',
};

// Что подсвечиваем: у галочки — строку, у файла — рамку, у вопроса с вариантами — весь блок, иначе само поле
const markTarget = (f: Field): Element =>
  f.closest('.consent__check') ?? f.closest('[data-drop]') ?? (f.type === 'radio' ? f.closest('fieldset') : null) ?? f;

export function markInvalid(f: Field) { markTarget(f).classList.add(INVALID); f.setAttribute('aria-invalid', 'true'); }
export function clearInvalid(f: Field) { markTarget(f).classList.remove(INVALID); f.removeAttribute('aria-invalid'); }

const contactOk = (v: string) => EMAIL.test(v) || (PHONE_CHARS.test(v) && v.replace(/\D/g, '').length >= 10);

function fieldProblem(f: Field, root: ParentNode): string {
  if (f.type === 'checkbox') return (f as HTMLInputElement).checked ? '' : formErrors.consent;
  if (f.type === 'radio') return root.querySelector(`input[name="${f.name}"]:checked`) ? '' : formErrors.required;
  if (f.type === 'file') return (f as HTMLInputElement).files?.length ? '' : formErrors.required;
  const v = f.value.trim();
  if (!v) return formErrors.required;
  if ('phone' in f.dataset && v.replace(/\D/g, '').length !== 11) return formErrors.phone;
  if (f.type === 'email' && !EMAIL.test(v)) return formErrors.email;
  if ('contact' in f.dataset && !contactOk(v)) return formErrors.contact;
  return '';
}

// Проверяет форму и подсвечивает ошибки. Возвращает текст для плашки или '', если всё заполнено верно.
export function checkForm(root: ParentNode): string {
  const fields = [...root.querySelectorAll<Field>('[required]')].filter((f) => !f.matches(':disabled'));
  const problems = fields.map((f) => {
    const problem = fieldProblem(f, root);
    if (problem) markInvalid(f); else clearInvalid(f);
    return { f, problem };
  }).filter((p) => p.problem);
  if (!problems.length) return '';
  const first = problems[0].f;
  if (!['checkbox', 'radio', 'file'].includes(first.type)) first.focus();
  return problems.find((p) => p.problem === formErrors.required)?.problem
    ?? problems.find((p) => p.problem !== formErrors.consent)?.problem
    ?? formErrors.consent;
}

// Красная рамка уходит, как только человек исправляет поле; плашка — когда исправлено всё
export function initFormCheck(root: HTMLElement, error: HTMLElement) {
  const onFix = (e: Event) => {
    const f = e.target as Field;
    if (f.type === 'file' && !(f as HTMLInputElement).files?.length) return;
    if (f.type === 'checkbox' && !(f as HTMLInputElement).checked) return;
    clearInvalid(f);
    if (!root.querySelector(`.${INVALID}`)) error.hidden = true;
  };
  root.addEventListener('input', onFix);
  root.addEventListener('change', onFix);
}

// Новое открытие формы: галочки пустые, подсветка снята. Галочки человек ставит сам каждый раз.
export function resetConsent(root: ParentNode) {
  root.querySelectorAll<HTMLInputElement>('input[data-consent]').forEach((b) => { b.checked = false; });
  root.querySelectorAll(`.${INVALID}`).forEach((el) => el.classList.remove(INVALID));
  root.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
}

// Простая маска телефона: +7 (999) 999-99-99
export function initPhoneMasks(root: ParentNode) {
  root.querySelectorAll<HTMLInputElement>('input[data-phone]').forEach((input) => {
    const format = () => {
      let d = input.value.replace(/\D/g, '');
      if (!d) { input.value = ''; return; }
      if (d[0] === '8') d = '7' + d.slice(1);
      if (d[0] !== '7') d = '7' + d;
      d = d.slice(0, 11);
      const p = [d.slice(1, 4), d.slice(4, 7), d.slice(7, 9), d.slice(9, 11)];
      let out = '+7';
      if (p[0]) out += ` (${p[0]}`;
      if (p[0].length === 3) out += ')';
      if (p[1]) out += ` ${p[1]}`;
      if (p[2]) out += `-${p[2]}`;
      if (p[3]) out += `-${p[3]}`;
      input.value = out;
    };
    input.addEventListener('input', format);
    input.addEventListener('blur', () => { if (input.value.replace(/\D/g, '').length <= 1) input.value = ''; });
  });
}
