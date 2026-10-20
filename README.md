# Aristotle

Программа для технической экспертизы: стандартизированный сбор, накопление и связывание данных экспертизы, чтобы выявлять партии, мастерские, операторов и инфраструктуру.

Работает без центрального сервера. Данные ведут автономные **Группы** по 2–5 человек; каждая хранит свой Банк на **Опорной станции**, а между Группами обмениваются только подтверждёнными данными — через **Ретрансляторы** и по подписанному **Реестру Сети**.

## Состав

Монорепозиторий на npm workspaces, TypeScript без сборки (Node.js исполняет `.ts` напрямую).

| Пакет | Назначение |
|---|---|
| [`packages/protocol`](packages/protocol) | то, о чём договариваются станции: форматы переноса, схемы Записей, Словарь Сети, Реестр, Отпечатки, ключи, сообщения |
| [`packages/core`](packages/core) | ядро Опорной станции: Банк на SQLite, права и роли, Проверка, журнал, Материалы, Проход, HTTPS-API |
| [`packages/station`](packages/station) | локальная часть Станции: вход в Банк, подпись и подтверждение присутствия, отдача интерфейса |
| [`packages/relay`](packages/relay) | Ретранслятор: Ящики и Проходы между Группами |
| [`packages/cli`](packages/cli) | командная строка `aristotel` |
| [`packages/ui`](packages/ui) | веб-интерфейс Станции (React 19, собирается esbuild) |

Остальное:

- [`tests/`](tests) — контрактные и приёмочные сценарии, общий стенд (`tests/support`);
- [`dictionary/source`](dictionary/source) — исходник Словаря Сети v1 (типы, связи, перечни, Классы изделий, Стоп-листы);
- [`tools/`](tools) — генератор исходника Словаря из приложения спецификации и таблица Unicode для нормализации;
- [`bench/`](bench) — замеры журнала и Словаря;
- [`locales/ru.json`](locales/ru.json) — тексты сообщений и справки CLI.

## Требования

- Node.js **24.16** или новее (проверяется в CI на 24.16 и 26);
- npm.

Поддерживаемые платформы: Linux, macOS, Windows.

## Установка и проверка

```bash
npm ci
npm run typecheck
npm run build:ui
npm test
```

Интерфейс собирается до тестов: его файлы отдаёт локальная часть Станции.

## Скрипты

| Команда | Что делает |
|---|---|
| `npm test` | все тесты пакетов и `tests/` через `node --test` |
| `npm run typecheck` | проверка типов (`tsc`) ядра и интерфейса |
| `npm run build:ui` | сборка веб-интерфейса в `packages/ui/dist` |
| `npm run bench:journal` | замер журнала |
| `npm run bench:dictionary` | замер Словаря |

## Использование

Программа одна, роль задаётся при инициализации: `base-station`, `station` или `relay`.

```bash
# Опорная станция Группы
node packages/cli/src/main.ts init --role base-station --senior-label "Старший"
node packages/cli/src/main.ts serve

# Станция участника: принять приглашение и открыть интерфейс
node packages/cli/src/main.ts station accept <файл-приглашения>
node packages/cli/src/main.ts open

# Ретранслятор
node packages/cli/src/main.ts init --role relay --group <Код> --url https://<имя>:<порт>
```

Полный перечень команд и флагов — `node packages/cli/src/main.ts` без аргументов. В него входят `status`, `member`, `record`, `case`, `form`, `journal`, `material`, `invitation`, `stations`, `registry`, `dictionary`, `group-key`, `coordinator-key`, `tls`, `local`.

Общие флаги: `--data-dir <каталог>` — каталог данных, `--json` — вывод в JSON.

## Словарь Сети

Каталог [`dictionary/source`](dictionary/source) — данные, а не код программы. Из него команда `aristotel dictionary build` собирает неподписанную версию Словаря; на Опорную станцию Словарь приходит подписанным Ключом Координатора (`dictionary sign`, `dictionary apply`). Подробности — в [`dictionary/source/README.md`](dictionary/source/README.md).

Тесты `tests/contract/dictionary-source.test.ts` и `tests/acceptance/common/no-case-data.test.ts` сверяют исходник с приложением спецификации; для них в репозитории лежат два файла: [`docs/spec/slovar-seti-v1.md`](docs/spec/slovar-seti-v1.md) и [`specs/005-model-dannyh-i-slovar/contracts/normalizaciya-v1.md`](specs/005-model-dannyh-i-slovar/contracts/normalizaciya-v1.md).

## Непрерывная проверка

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) на каждый push и pull request прогоняет `typecheck`, `build:ui` и `test` на Ubuntu, Windows и macOS, Node.js 24.16 и 26.
