# Отчет об очистке пакета

Дата проверки: 10.09.2026.

## Исключено

- `.git`, `.env`, локальные secret directories и production-compose;
- приватные ключи, сертификаты, cookies и истории сессий;
- реальные дампы, backups, логи, uploads и parser-training;
- `node_modules`, frontend `dist`, Python venv/cache;
- пользовательские XLSX/XLSM/PDF/DOCX/ZIP и производственные шаблоны;
- Graphify-графы и verification artifacts;
- внешние серверные bind mounts и почтовая конфигурация.

Персональные абсолютные home paths заменены на `/opt/vsm`. Обнаруженный в исходной
копии локальный DSN заменен на placeholder, production-подобный Hermes URL - на
домен `example.invalid`.

## Выполненные проверки

- Сравнение содержимого пакета с 14 фактическими secret values из локальных env
  и контейнерного окружения: `0` совпадений.
- Private-key headers, AWS/GCP/GitHub/OpenAI/Slack token patterns: `0`.
- Literal credential-bearing DSN: `0`; остались только переменные и placeholder.
- Внешние IPv4-адреса: `0`.
- Не-example email-адреса: `0`.
- Персональные home paths, локальные secret-directory names и production-домены: `0`.
- Символические ссылки: `0`.
- Закрытые бинарные документы и backup/log/db-файлы: `0`.
- Printable-строки custom dump проверены отдельно: secret-pattern matches `0`.

В тестах сохранены очевидно фиктивные значения (`example.com`, `re_test`,
`client-secret`) для проверки веток интеграции. Они не являются рабочими
учетными данными. В коде остались публичные адреса документации и внешних API
(OpenStreetMap/Carto/Yandex Maps, Google OAuth/Gmail, Resend), поскольку это
интеграционные зависимости, а не секреты.

## Проверка БД

- `schema.sql` восстановлен в новую пустую PostgreSQL 16.
- `seed_synthetic.sql` применен транзакционно без ошибок.
- `vsm_synthetic.dump` восстановлен во вторую пустую БД с `--exit-on-error`.
- Исходная и восстановленная копии совпали по контрольным количествам.
- Невалидированных ограничений: `0`.

## Проверка приложения

- Python source compile: успешно.
- Frontend production build: успешно, 3022 модуля.
- API запущен на восстановленном dump: успешно.
- Login, material flow, day totals, mechanization units и reference metadata:
  HTTP `200`.

Независимый получатель обязан повторить secret scan перед передачей пакета
третьей стороне: автоматическая проверка снижает риск, но не является правовым
заключением о раскрытии информации.
