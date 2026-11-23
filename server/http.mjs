// Общие куски HTTP: чтение тела и ответ JSON.
//
// Раньше эти функции были скопированы в index.mjs и admin.mjs — по две копии каждой.
// Две копии multipart-парсера это не «дублирование», это будущий баг: поправишь в одном,
// забудешь в другом, и загрузка файла начнёт разваливаться только в админке.
// Поэтому один модуль. Если правишь парсинг — правишь здесь, и работает везде.

// Лимит тела. Больше не нужно ни одной ручке: резюме до 10 МБ плюс multipart-обвязка
export const MAX_BODY = 12 * 1024 * 1024;

export function json(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// Чтение тела целиком с жёстким обрывом по размеру.
// Без обрыва бот с бесконечным потоком съест всю память процесса — проверено на практике
export function readRaw(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const raw = await readRaw(req);
  try { return JSON.parse(raw.toString('utf8')); } catch { return {}; }
}

// Разбор multipart руками: библиотеки тянуть не хочется ради двух форм,
// а формат простой — разделитель из boundary, части с заголовками и телом.
// Возвращает { fields, file: { name, buf, mime } | null }. Файл берём только первый:
// два резюме в одной заявке это уже не форма, а атака
export async function readMultipart(req) {
  const ct = String(req.headers['content-type'] ?? '');
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return { fields: {}, file: null };

  const boundary = Buffer.from(`--${(m[1] ?? m[2]).trim()}`);
  const raw = await readRaw(req);

  const fields = {};
  let file = null;
  let pos = 0;

  while (true) {
    const start = raw.indexOf(boundary, pos);
    if (start < 0) break;
    const after = start + boundary.length;
    if (raw.subarray(after, after + 2).toString() === '--') break; // финальный разделитель

    // Пропускаем CRLF после разделителя, иначе заголовки части начинаются с пустой строки
    const headStart = raw.subarray(after, after + 2).toString() === '\r\n' ? after + 2 : after;
    const headEnd = raw.indexOf(Buffer.from('\r\n\r\n'), headStart);
    if (headEnd < 0) break;

    const headers = raw.subarray(headStart, headEnd).toString('utf8');
    const bodyStart = headEnd + 4;
    const next = raw.indexOf(boundary, bodyStart);
    const bodyEnd = next < 0 ? raw.length : next - 2; // минус CRLF перед разделителем

    const name = headers.match(/name="([^"]*)"/i)?.[1] ?? '';
    const fname = headers.match(/filename="([^"]*)"/i)?.[1];
    // Тип файла берём из его собственной части, а не из общего заголовка запроса:
    // иначе в базу уедет «multipart/form-data; boundary=...» и по mime потом ничего не найти
    const type = headers.match(/content-type:\s*([^\r\n;]+)/i)?.[1]?.trim() ?? '';
    const buf = raw.subarray(bodyStart, Math.max(bodyStart, bodyEnd));

    if (fname && name) {
      if (!file) file = { name: fname, buf: Buffer.from(buf), mime: type };
    } else if (name) {
      fields[name] = buf.toString('utf8');
    }
    pos = next < 0 ? raw.length : next;
  }

  return { fields, file };
}
