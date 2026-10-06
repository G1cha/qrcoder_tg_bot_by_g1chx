# QR-коды в Telegram

Отдельный Telegram-бот на Cloudflare Workers. Пользователь нажимает **«Создать QR-коды»**, отправляет список заказов (по одному в строке), а бот ставит их в очередь и присылает по одной PNG-фотографии на каждый номер. Поддерживаются списки до 100 строк, удаление лишних пробелов и отметка повреждённого заказа. В QR закодирован только номер; отметка о повреждении показывается в подписи к фотографии.

Бот не требует постоянно работающего компьютера. Worker принимает Telegram webhook, а Cloudflare Queue постепенно отправляет изображения, выдерживая интервал между сообщениями.

## 1. Подготовка

Создайте бота через BotFather и сохраните токен. **Не публикуйте токен в GitHub и не отправляйте его в чат.** Добавьте его в Cloudflare как Worker secret.

Установите зависимости и авторизуйтесь:

```powershell
npm install
npx wrangler login
```

Создайте KV namespace и очередь:

```powershell
npx wrangler kv namespace create BOT_STATE
npx wrangler queues create qrcoder-qr-jobs
```

Вставьте выданный KV `id` вместо `REPLACE_WITH_KV_NAMESPACE_ID` в `wrangler.toml`.

## 2. Секреты и публикация

Установите секреты Worker. Команды запросят значения интерактивно; токен и секрет не попадут в исходники:

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npm run deploy
```

`WEBHOOK_SECRET` — случайная строка из латинских букв, цифр, `_` или `-`; она защищает webhook от поддельных запросов. Worker будет опубликован по адресу вроде `https://qrcoder-telegram-bot.<ваш-subdomain>.workers.dev`.

## 3. Подключение Telegram webhook

После публикации установите webhook, заменив значения локально в PowerShell. Не вставляйте команду с настоящим токеном в GitHub:

```powershell
$token = Read-Host "BotFather token"
$secret = Read-Host "Webhook secret"
$worker = Read-Host "Worker URL (например https://qrcoder-telegram-bot.example.workers.dev)"
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -Body @{
  url = "$worker/telegram-webhook"
  secret_token = $secret
  allowed_updates = '["message","callback_query"]'
}
```

Убедитесь, что Worker отвечает `ok` по `$worker/health`. Затем откройте бота в Telegram и отправьте `/start`.

## Локальная проверка

```powershell
npm test
npm run check
```

Для локального запуска webhook-туннель не настроен: для полноценного Telegram-тестирования нужен доступный HTTPS URL. Сайт в корне репозитория работает независимо и не меняется этим ботом.

## Возможности и ограничения

- Кнопка создания и переключатели доступны каждому пользователю отдельно.
- Список до 100 непустых строк обрабатывается одним сообщением; каждый QR приходит отдельной фотографией.
- Сообщения очереди отправляются не чаще одного примерно за 1,1 секунды.
- Ожидание списка после нажатия кнопки истекает через 15 минут.
- Номер заказа ограничен 256 символами.
- QR создаётся в PNG непосредственно в Worker; внешний QR-сервис не используется.
- Cloudflare Workers/Queues/KV имеют бесплатные квоты и лимиты, которые могут меняться; проверьте актуальные условия Cloudflare перед запуском для высокой нагрузки.
