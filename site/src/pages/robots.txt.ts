// robots.txt собирается на лету из одного флага — site.indexable (src/data/site.ts).
// Раньше запрет был захардкожен в public/robots.txt, и при запуске про него забывали.
// Теперь одно переключение: поставили true — поисковики пущены, ссылка на карту сайта появилась.
// Учти: статический public/robots.txt перебивает этот файл, поэтому его удалили. Не создавай заново!
import type { APIRoute } from 'astro';
import { site } from '../data/site';

export const GET: APIRoute = ({ site: siteUrl }) => {
  const base = siteUrl ?? new URL('https://steklyanika.ru');

  // Черновик: закрыто всё. Никакие «точечные» разрешения тут не нужны — черновик есть черновик.
  if (!site.indexable) {
    return new Response(
      ['# Черновик сайта — индексация запрещена.', '# Пускать поисковики: indexable: true в src/data/site.ts', 'User-agent: *', 'Disallow: /', ''].join('\n'),
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  // Боевой режим. Служебное закрываем: админка, документы согласий, тестовые страницы.
  // Clean-param режет utm-метки из индекса — иначе Яндекс плодит дубли по каждой рекламной ссылке.
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin/',
    'Disallow: /consent',
    'Disallow: /consent-candidates',
    'Disallow: /cookies',
    'Disallow: /privacy',
    '',
    'Clean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&yclid&gclid',
    '',
    `Sitemap: ${new URL('/sitemap-index.xml', base).href}`,
    '',
  ].join('\n');

  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
