# Установка CLIProxyAPI в OpenCode v1 на Windows

`install.ps1` устанавливает локальный плагин из папки `opencode-cliproxyapi`.
Нужны Windows PowerShell 5.1 (или PowerShell 7), установленный **OpenCode 1.x**
и доступный сервер CLIProxyAPI. Права администратора, Node.js, npm и отдельный Bun
для установки плагина не нужны: OpenCode сам исполняет TypeScript.

## Установка по ссылке из GitHub

Загрузите в свой публичный репозиторий оба скрипта и исходники, сохранив структуру:

```text
install-online.ps1
install.ps1
opencode-cliproxyapi/
  package.json
  LICENSE
  src/index.ts
  src/catalog.ts
```

На другом компьютере достаточно выполнить в PowerShell следующие команды,
заменив `OWNER/REPO` на имя своего репозитория:

```powershell
$repo = 'OWNER/REPO'
$ref = 'main'
$installer = Join-Path $env:TEMP 'opencode-cliproxyapi-install-online.ps1'
Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/$repo/$ref/install-online.ps1" -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Repository $repo -Ref $ref
```

`install-online.ps1` скачает необходимые файлы из этого репозитория во временную
папку, запустит `install.ps1` и удалит временные исходники. Git на компьютере
не требуется. Обычный запуск запросит адрес API, ссылку на каталог моделей и ключ.
Для установки из тега или конкретного коммита укажите его вместо `main` в `$ref`.
Удалённому установщику доступны те же параметры подключения, например
`-BaseUrl`, `-ModelsUrl`, `-ApiKey` и `-NonInteractive`.

Адреса вашего API и ключ вводятся при установке: их не нужно публиковать в GitHub.
Готовая рабочая ссылка появится после публикации файлов в вашем репозитории;
`OWNER/REPO` в примере — шаблон.

## Установка из локальной папки

Откройте PowerShell в корне этого проекта:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Скрипт запросит адрес API, ссылку на каталог моделей и, если ключ ещё не настроен,
сам ключ со скрытым вводом. По умолчанию API — `http://localhost:8317/v1`,
каталог — `http://localhost:8317/v1/models?client_version=pi`. Нажмите Enter,
чтобы оставить предложенный адрес или пропустить настройку ключа.
Введённый ключ сохраняется в пользовательскую переменную Windows `CPA_API_KEY`;
он не записывается в исходники и параметры плагина. Переменные среды пользователя
хранятся Windows в открытом виде.

Для своего сервера:

```powershell
.\install.ps1 -BaseUrl 'http://192.168.1.10:8317' -ModelsUrl 'http://192.168.1.10:8317/v1/models?client_version=pi'
```

Для автоматического запуска без вопросов, когда `CPA_API_KEY` уже задан:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -BaseUrl 'http://localhost:8317' -NonInteractive
```

При отсутствии ключа этот режим устанавливает плагин с предупреждением;
ключ можно настроить позже. Если сервер допускает запросы без авторизации,
ключ не нужен. Можно передать ключ как `SecureString` из PowerShell:

```powershell
.\install.ps1 -ApiKey (Read-Host 'API key' -AsSecureString)
```

После установки полностью перезапустите терминал и OpenCode. В каталоге своего
рабочего проекта выполните:

```powershell
opencode models cliproxyapi
opencode
```

В OpenCode откройте `/models` и выберите модель провайдера **CLIProxyAPI**.
Установка не запускает сервер CLIProxyAPI. Проверку моделей выполняйте вне папки
`opencode-cliproxyapi`: её собственный `opencode.json` ссылается на `dist/index.js`
и предназначен для разработки со сборкой.

По умолчанию файлы устанавливаются в `%USERPROFILE%\.config\opencode`:

```text
opencode/
  plugins/opencode-cliproxyapi.ts   # загрузчик с единственным экспортом
  cliproxyapi/
    src/index.ts
    src/catalog.ts
    options.json                  # URL и прочие параметры подключения
    installation.json
    LICENSE
```

При заданном `OPENCODE_CONFIG_DIR` используется этот каталог. Иначе учитывается
`XDG_CONFIG_HOME`: `<XDG_CONFIG_HOME>\opencode`. Параметр `-ConfigDir` позволяет
указать каталог явно; для нестандартного каталога задайте `OPENCODE_CONFIG_DIR`
также при запуске OpenCode.

Повторный запуск обновляет копию исходников, сохраняет параметры подключения
и создаёт резервную копию предыдущей установки в `.cliproxyapi-backups` внутри
каталога конфигурации. Исходная папка после установки не требуется.
Файлы `opencode.json` и `opencode.jsonc` остаются без изменений. Если в них уже
подключён `opencode-cliproxyapi` из npm, удалите прежнюю запись `plugin` вручную,
чтобы плагин не загружался дважды. Скрипт предупреждает при обнаружении такой записи.

Дополнительные параметры:

| Параметр | Назначение |
| --- | --- |
| `-SourcePath` | Каталог исходного пакета, содержащий `package.json` и `src` |
| `-ConfigDir` | Каталог конфигурации OpenCode |
| `-BaseUrl` | URL CLIProxyAPI; суффикс `/v1` необязателен |
| `-ModelsUrl` | Полный URL каталога, например `http://localhost:8317/v1/models?client_version=pi` |
| `-Protocol chat` / `-Protocol responses` | Протокол по умолчанию |
| `-ProviderName` | Название провайдера в списке моделей |
| `-ApiKey` | Ключ как `SecureString`, сохраняемый в среде пользователя |
| `-OpenCodePath` | Путь к `opencode.exe`, если он отсутствует в `PATH` |
| `-NonInteractive` | Не запрашивать адреса и ключ |
| `-WhatIf` | Проверить входные данные и показать действие без установки |

При повторном запуске предложены сохранённые адреса. В режиме `-NonInteractive`
параметры сохраняются, если не переданы новые. Если меняется адрес API,
стандартная ссылка на каталог обновляется вместе с ним; пользовательская ссылка сохраняется.
При первой установке `-BaseUrl` по умолчанию учитывает `CLIPROXY_BASE_URL`.
Другие опции плагина можно указать в `cliproxyapi/options.json`, например
`"modelMetadataURL": false` для отключения загрузки метаданных с models.dev.

## Ошибка `Provider not found: cliproxyapi`

Включите логи, чтобы увидеть причину:

```powershell
opencode --print-logs --log-level DEBUG models cliproxyapi
```

Если плагин загрузился, но API отвечает `401 Missing API key`, текущий терминал
может ещё не видеть сохранённую пользовательскую переменную. В этом случае
загрузите ключ в текущую сессию PowerShell и повторите проверку:

```powershell
$env:CPA_API_KEY = [Environment]::GetEnvironmentVariable('CPA_API_KEY', 'User')
opencode models cliproxyapi
```

Эта команда подходит, если ключ уже сохранён установщиком. Новая вкладка
в давно открытом Windows Terminal может наследовать прежнее окружение;
для обновления среды полностью закройте приложение терминала и откройте снова.

## Проверки

Проверки установщика без изменения пользовательской конфигурации:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\install.Tests.ps1
```

При наличии Node.js можно также проверить реальную загрузку в OpenCode
и запросы с тестовым ключом к локальному тестовому API:

```powershell
node .\tests\smoke.mjs
```

Обе проверки используют временные каталоги и не изменяют пользовательские настройки.

Механизм локальной загрузки описан в [документации OpenCode](https://opencode.ai/docs/plugins/).
Подробнее о плагине — в [его README](opencode-cliproxyapi/README.md).
