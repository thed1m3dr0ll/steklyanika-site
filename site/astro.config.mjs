import { defineConfig } from 'astro/config';
import { adminUploads } from './tools/admin-uploads.mjs';
import { devImageCache } from './tools/dev-image-cache.mjs';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  // адрес сайта: по нему строятся полные ссылки для превью в соцсетях и данных для поисковиков (src/layouts/Base.astro).
  // Сменится домен — поменять здесь
  site: 'https://steklyanika.ru',
  // allowedHosts нужен только для локальной работы в контейнере (превью по внешнему домену).
  // В проде сборка статическая, эта настройка ни на что не влияет.
  server: { port: 4321, host: true, allowedHosts: true },
  devToolbar: { enabled: false },
  // порядок в файлах админки (/admin/): тяжёлые фото уменьшаются до 2000 px, пути к фото объектов выправляются —
  // см. tools/admin-uploads.mjs
  // в dev картинки не залипают в кэше браузера после замены фото — см. tools/dev-image-cache.mjs
  integrations: [
    adminUploads(),
    devImageCache(),
    // Карта сайта для Яндекс.Вебмастера и Search Console. Адреса строятся от site — менять домен только там.
    // Служебное в карту не пускаем: админку, тестовые страницы, документы согласий (они noindex, поисковику они не нужны).
    sitemap({
      filter: (page) =>
        !/\/(admin|consent|consent-candidates|cookies|privacy|404)\b/.test(page),
    }),
  ],
  // 3D-модель профиля (three.js) — отдельный файл ~560 КБ, грузится лениво только у блока «Технологии»
  vite: {
    build: { chunkSizeWarningLimit: 700 },
    // Прокси на сервер заявок. Нужен и в dev, и в preview: фронт всегда стучится в /api на своём же домене.
    // В проде вместо этого работает nginx, но одинаковый путь оставляем, чтобы не править фронт при деплое.
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
        '/media': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      },
      // на Windows с кириллицей в пути изменения стилей иногда не подхватываются — опрашиваем файлы сами
      watch: { usePolling: true, interval: 300 },
    },
  },
  image: {
    // исходные фото весят десятки мегабайт — Astro сам ужимает их в WebP при сборке
    responsiveStyles: true,
  },
});
