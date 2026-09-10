# Пакет для независимого аудита VSM Dashboard

Дата снимка: 10.09.2026.

## Что внутри

- `dashboard/` - очищенная копия приложения и изолированный audit-compose.
- `database/schema.sql` - схема PostgreSQL без реальных данных, владельцев и ACL.
- `database/seed_synthetic.sql` - воспроизводимый синтетический набор данных.
- `database/vsm_synthetic.dump` - custom-format дамп схемы и синтетических данных.
- `database/DATASET_MANIFEST_RU.md` - состав и намеренные пробелы набора.
- `AUDIT_PROMPT_RU.md` - готовое задание независимому аудитору.
- `SANITIZATION_REPORT_RU.md` - результаты проверки на секреты и лишние файлы.
- `MANIFEST.sha256` - контрольные суммы всех файлов пакета.

Архив не предназначен для подключения к production. Все значения в дампе
созданы специально для этого пакета.

## Быстрый порядок проверки

1. Проверьте `MANIFEST.sha256`.
2. Повторно выполните собственный secret scan.
3. Восстановите `database/vsm_synthetic.dump` в пустую PostgreSQL 16.
4. Следуйте `dashboard/README_RU.md` для локального запуска.
5. Передайте аудитору содержимое `AUDIT_PROMPT_RU.md` без сокращений.
