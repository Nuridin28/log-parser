# log-trace-parser

Вероятностный distributed-tracing движок, собирающий causal-граф вызовов из **неструктурированных** логов (JSON / plain text / key=value, с пропусками, out-of-order).

Система моделирует задачу так:

```
noisy event stream  →  probabilistic causal graph  →  traces
```

Это **не** deterministic reconstruction — где данных не хватает, система **достраивает** рёбра и узлы с соответствующей `confidence`.

---

## Оглавление

- [Быстрый старт](#быстрый-старт)
- [Формат ввода](#формат-ввода)
- [Формат вывода](#формат-вывода)
- [Pipeline — 6 стадий](#pipeline--6-стадий)
- [Алгоритм matching'а](#алгоритм-matchingа)
- [5 канонических кейсов](#5-канонических-кейсов)
- [Programmatic API](#programmatic-api)
- [Типы (TypeScript)](#типы-typescript)
- [Структура проекта](#структура-проекта)
- [Как расширять](#как-расширять)
- [Гарантии системы](#гарантии-системы)

---

## Быстрый старт

**Требования:** Node.js ≥ 22.7 (для нативного `--experimental-strip-types`). Протестировано на Node 24.

```bash
npm install                                       # @types/node + typescript
npm test                                          # 21 тест
npm run demo                                      # прогнать все 5 моков
npm run typecheck                                 # tsc --noEmit

# на одном файле
node src/index.ts examples/case1-normal.log

# из stdin
cat mylog.log | node src/index.ts

# с debug-выводом (включает нормализованные events)
node src/index.ts --debug examples/case1-normal.log
```

---

## Формат ввода

Строки в любом из форматов:

```
[HH:MM:SS.mmm] LEVEL [container] message...
```

Где:

- `[HH:MM:SS.mmm]` — опциональный timestamp (парсится в миллисекунды от начала суток)
- `LEVEL` — `INFO | DEBUG | WARN | ERROR | TRACE | FATAL` (опционально)
- `container` — имя сервиса (lowercase, 1–32 символа, опционально)
- `message` — произвольный текст, в котором может быть:
  - JSON: `{"request":{"url":"...","method":"POST"}}`
  - key=value: `sender=api receiver=payment url=/pay`
  - plain text: `Incoming request POST /api/url`

Все части опциональны. Система **total** — любая строка даст хотя бы одно событие.

### Примеры

```
[10:00:01.123] INFO api Incoming request: POST /api/url
[10:00:01.200] INFO api Proxy Outgoing Request {"request":{"url":"https://ip/url","method":"POST"}}
[10:00:04.000] INFO api sender=api receiver=payment method=POST url=/pay
not structured at all                   # даже это превратится в event
```

---

## Формат вывода

```ts
interface Trace {
  requestId: string;          // trace-level id, один на вызов pipeline
  edges: PublicEdge[];        // рёбра causal-графа
  services: string[];         // все узлы (для отрисовки диаграммы)
  confidence: number;         // средняя уверенность по всем рёбрам, [0, 1]
  parallel?: true;            // флаг fan-out (параллельные вызовы)
}

interface PublicEdge {
  from: string;               // узел-источник
  to: string;                 // узел-получатель
  message: string | null;     // исходное сообщение лога
  type:                       // тип ребра — определяет стиль стрелки
    | "REQUEST"               // обычный запрос (сплошная стрелка →)
    | "RESPONSE"              // ответ (сплошная стрелка ←)
    | "INFERRED_REQUEST"      // запрос достроен системой (пунктир →)
    | "INFERRED_RESPONSE"     // ответ достроен системой (пунктир ←)
    | "UNKNOWN";              // не удалось классифицировать
}
```

### Пример вывода

```json
{
  "requestId": "r1",
  "edges": [
    { "from": "client", "to": "api",     "message": "Incoming request: POST /api/url", "type": "REQUEST"  },
    { "from": "api",    "to": "payment", "message": "POST /pay",                       "type": "REQUEST"  },
    { "from": "payment","to": "api",     "message": "http_status=200",                 "type": "RESPONSE" },
    { "from": "api",    "to": "client",  "message": "Response 200",                    "type": "RESPONSE" }
  ],
  "services": ["client", "api", "payment"],
  "confidence": 0.72
}
```

---

## Pipeline — 6 стадий

```
raw log lines
    │
    ▼   parser.ts            Stage 1: разбирает [ts] LEVEL container message
{ timestamp, level, container, message, raw, lineNo }
    │
    ▼   normalizer.ts        Stage 2: извлекает method/url/status/sender/receiver/requestId
{ id, timestamp, service, type, method, url, status, sender, receiver, requestId, … }
    │
    ▼   classifier.ts        Stage 3: тип = IN | OUT | RESPONSE | UNKNOWN
    │
    ▼   virtualize.ts        backfill service: external:<url> | virtual:<name> | unknown:<hash>
    │
    ▼   stack.ts             matching + backtracking → Edge[]
    │
    ▼   graph.ts             { requestId, edges, services, confidence, parallel? }
```

Каждая стадия — чистая функция `(events) → events`, никакого состояния кроме монотонных счётчиков (`e1`, `e2`, … для событий и `r1`, `r2`, … для трейсов). Оба счётчика ресетятся в начале `run()`.

---

## Алгоритм matching'а

### Score-функция (spec §7.1)

Для пары (request, response) считается score ∈ [0, 1]:

| Вес | Признак | Почему |
|-----|---------|--------|
| **0.4** | `requestId` совпадает | Единственный строгий сигнал — correlation ID из логов |
| **0.2** | `sender/receiver` зеркальны (req.sender ↔ res.receiver) | Явная причинность, если присутствует |
| **0.2** | URL совпадает | Вторичный сигнал идентичности |
| **0.1** | method совпадает | Слабый |
| **0.1** | временная близость (≤ 5 сек — полный балл, линейный спад до 10 сек) | Самый ненадёжный в async/distributed — поэтому всего 10% |

Threshold по умолчанию — `min: 0.1` для stack-matching, `min: 0.2` для жёстких cutoff'ов.

### Stack с backtracking'ом (spec §8)

Стек = незакрытые REQUEST'ы. RESPONSE ищет в стеке лучший match:

```
REQUEST  → push
RESPONSE → найти best-match в стеке
           если match в глубине стека:
             все фреймы над ним → классифицировать:
               - тот же caller = sibling (fan-out) → оставить на стеке
               - другой caller = skipped (backtracking) → INFERRED_RESPONSE
           emit RESPONSE-ребро
```

### Inferred edges

Если RESPONSE приходит без соответствующего REQUEST на стеке — синтезируется `INFERRED_REQUEST` + обычный `RESPONSE`. Если REQUEST'ы остались на стеке в конце — для них создаются `INFERRED_RESPONSE` с низкой confidence (0.4).

---

## 5 канонических кейсов

Все примеры лежат в [`examples/`](examples/). Запусти `npm run demo` чтобы увидеть все разом.

### CASE 1 — Normal flow

Полный proxy-круговорот: клиент → api → внешний сервис → api → клиент.

**Input** ([examples/case1-normal.log](examples/case1-normal.log)):
```
[10:00:01.123] INFO api Incoming request: POST /api/url
[10:00:01.200] INFO api Proxy Outgoing Request {"request":{"url":"https://ip/url","method":"POST"}}
[10:00:01.350] INFO payment Incoming request POST /payment
[10:00:01.500] INFO payment http_status=200
[10:00:01.700] INFO api Proxy Incoming Response {"response":{"url":"https://ip/url","status":200}}
[10:00:01.900] INFO api Response 200
```

**Output (упрощённо):**
```json
{
  "edges": [
    { "from": "client", "to": "api",             "type": "REQUEST"  },
    { "from": "api",    "to": "external:ip/url", "type": "REQUEST"  },
    { "from": "client", "to": "payment",         "type": "REQUEST"  },
    { "from": "payment","to": "client",          "type": "RESPONSE" },
    { "from": "external:ip/url","to": "api",     "type": "RESPONSE" },
    { "from": "api",    "to": "client",          "type": "RESPONSE" }
  ],
  "services": ["client","api","external:ip/url","payment"]
}
```

### CASE 2 — Response без request

Только ответ — система **достраивает** запрос.

**Input** ([examples/case2-no-request.log](examples/case2-no-request.log)):
```
[10:00:02.100] INFO api Proxy Incoming Response {"response":{"url":"https://ip/url","status":200}}
```

**Output:**
```json
{
  "edges": [
    { "from": "external:ip/url", "to": "api", "type": "INFERRED_REQUEST" },
    { "from": "api", "to": "external:ip/url", "type": "RESPONSE" }
  ]
}
```

### CASE 3 — Backtracking (пропущенные уровни)

Цепочка `A → B → C → D`, потом сразу `D → B` — значит ответы `D→C` и `C→B` потерялись и их надо **достроить**.

**Input** ([examples/case3-backtrack.log](examples/case3-backtrack.log)):
```
[10:00:03.000] INFO A sender=A receiver=B method=POST url=/step1
[10:00:03.100] INFO B sender=B receiver=C method=POST url=/step2
[10:00:03.200] INFO C sender=C receiver=D method=POST url=/step3
[10:00:03.700] INFO B Response from D status=200 sender=D receiver=B
```

**Output:**
```json
{
  "edges": [
    { "from": "A", "to": "B", "type": "REQUEST" },
    { "from": "B", "to": "C", "type": "REQUEST" },
    { "from": "C", "to": "D", "type": "REQUEST" },
    { "from": "D", "to": "C", "type": "INFERRED_RESPONSE" },
    { "from": "C", "to": "B", "type": "INFERRED_RESPONSE" },
    { "from": "B", "to": "A", "type": "INFERRED_RESPONSE" }
  ]
}
```

### CASE 4 — Sender/receiver как primary signal

Явные `sender=` / `receiver=` в логах сразу задают направление ребра — никаких стеков не нужно.

**Input** ([examples/case4-sender-receiver.log](examples/case4-sender-receiver.log)):
```
[10:00:04.000] INFO api sender=api receiver=payment method=POST url=/pay
[10:00:04.200] INFO payment status=200 sender=payment receiver=api
```

**Output:**
```json
{
  "edges": [
    { "from": "api",     "to": "payment", "type": "REQUEST"  },
    { "from": "payment", "to": "api",     "type": "RESPONSE" }
  ]
}
```

### CASE 5 — Async fan-out

Сервис `api` шлёт **параллельно** в `payment` и `notify`. Ответы приходят в порядке: `payment`, потом `notify`. Система различает fan-out от backtracking'а по тому, что оба ожидающих request'а имеют одного caller'а.

**Input** ([examples/case5-async.log](examples/case5-async.log)):
```
[10:00:05.000] INFO api Proxy Outgoing Request {"request":{"url":"https://payment/pay"},"receiver":"payment","sender":"api"}
[10:00:05.050] INFO api Proxy Outgoing Request {"request":{"url":"https://notify/ping"},"receiver":"notify","sender":"api"}
[10:00:05.300] INFO api Proxy Incoming Response {"response":{"url":"https://payment/pay","status":200},"sender":"payment"}
[10:00:05.400] INFO api Proxy Incoming Response {"response":{"url":"https://notify/ping","status":200},"sender":"notify"}
```

**Output:**
```json
{
  "parallel": true,
  "edges": [
    { "from": "api",     "to": "payment", "type": "REQUEST"  },
    { "from": "api",     "to": "notify",  "type": "REQUEST"  },
    { "from": "payment", "to": "api",     "type": "RESPONSE" },
    { "from": "notify",  "to": "api",     "type": "RESPONSE" }
  ]
}
```

---

## Programmatic API

```ts
import { run } from "./src/pipeline.ts";
import type { Trace, DebugTrace } from "./src/types.ts";

// Строка с логами или массив строк
const trace: Trace = run(logText);

// Debug-режим — возвращает и граф, и нормализованные events
const debug: DebugTrace = run(logText, { debug: true });
console.log(debug.events);   // Event[] после классификации
console.log(debug.graph);    // Trace
```

Отдельные стадии тоже экспортируются — можно собрать свой pipeline:

```ts
import { parseLines }     from "./src/parser.ts";
import { normalize }      from "./src/normalizer.ts";
import { classify }       from "./src/classifier.ts";
import { virtualize }     from "./src/virtualize.ts";
import { buildEdges }     from "./src/stack.ts";
import { buildGraph }     from "./src/graph.ts";
import { score, bestMatch } from "./src/matcher.ts";

const events = virtualize(classify(normalize(parseLines(lines))));
const { edges, unresolved } = buildEdges(events);
const trace = buildGraph({ edges, unresolved, events });
```

---

## Типы (TypeScript)

Всё в [src/types.ts](src/types.ts):

| Тип | Что это |
|-----|---------|
| `RawEvent` | Результат stage 1 — разобранная строка лога |
| `Event` | Канонический event после нормализации + классификации + виртуализации |
| `Edge` | Богатое внутреннее ребро (с `confidence`, `evidence`, `container`, `timestamp`) |
| `PublicEdge` | Slim ребро в финальном `Trace` — `{ from, to, message, type }` |
| `StackFrame` | Фрейм matching-стека (REQUEST ожидающий RESPONSE) |
| `Trace` | Финальный результат: `{ requestId, edges, services, confidence, parallel? }` |
| `EventType` | `"IN" \| "OUT" \| "RESPONSE" \| "UNKNOWN"` |
| `EdgeType` | `"REQUEST" \| "RESPONSE" \| "INFERRED_REQUEST" \| "INFERRED_RESPONSE" \| "UNKNOWN"` |

**Важно про `requestId`:** есть **два** разных requestId:
- `Event.requestId` — correlation ID, извлечённый **из лога** (например, из JSON `{"requestId":"..."}`)
- `Trace.requestId` — trace-level идентификатор, генерируется системой для **одного прогона pipeline** (`r1`, `r2`, …)

---

## Структура проекта

```
parser/
├── package.json                # scripts: test / demo / start / typecheck
├── tsconfig.json               # strict + noUncheckedIndexedAccess
├── README.md                   # этот файл
│
├── src/
│   ├── types.ts                # все shared interfaces
│   ├── index.ts                # CLI entry
│   ├── pipeline.ts             # оркестратор 6 стадий
│   │
│   ├── parser.ts               # Stage 1: raw line → RawEvent
│   ├── normalizer.ts           # Stage 2: RawEvent → Event (JSON + kv + plain)
│   ├── classifier.ts           # Stage 3: IN | OUT | RESPONSE | UNKNOWN
│   │
│   ├── virtualize.ts           # backfill service (external:/virtual:/unknown:)
│   ├── matcher.ts              # score(A, B) + bestMatch()
│   ├── stack.ts                # core: stack + backtracking + fan-out
│   ├── graph.ts                # финальный Trace
│   │
│   └── utils/
│       ├── time.ts             # parseTimestamp / stripTimestamp
│       ├── json.ts             # безопасное извлечение JSON из произвольного текста
│       └── hash.ts             # FNV-1a для стабильных unknown-id'шек
│
├── examples/                   # пять канонических кейсов
│   ├── case1-normal.log
│   ├── case2-no-request.log
│   ├── case3-backtrack.log
│   ├── case4-sender-receiver.log
│   └── case5-async.log
│
└── test/                       # node:test, один файл на стадию
    ├── parser.test.ts
    ├── normalizer.test.ts
    ├── matcher.test.ts
    ├── stack.test.ts
    └── pipeline.test.ts        # end-to-end проверки по всем 5 кейсам
```

---

## Как расширять

### Добавить новый формат лога

Если появляется новый паттерн (например, Splunk CSV или logfmt) — расширяй [src/normalizer.ts](src/normalizer.ts):

1. Добавь функцию-экстрактор рядом с `parseKv` / `extractFromJson`.
2. В `normalize()` — смёрджи её результат в цепочку `?? jsonFields.X ?? kv.X ?? extractor.X ?? …`.

Добавлять новые поля в `Event` нужно синхронно в [src/types.ts](src/types.ts).

### Добавить новый тип события

Например, `EVENT` (fire-and-forget, без ответа):

1. `EventType` в [types.ts](src/types.ts) — добавить `"EVENT"`.
2. [classifier.ts](src/classifier.ts) — добавить RULE для распознавания.
3. [stack.ts](src/stack.ts) — ветка в `buildEdges` (вероятно, `push` без ожидаемого response, или сразу `edge` без стека).

### Подкрутить score'инг

Всё в [src/matcher.ts](src/matcher.ts). Веса сидят в виде чисел 0.4/0.2/0.2/0.1/0.1 — подвинь их или добавь новый признак (например, bucket по `timestamp diff` с более грубой дискретизацией).

### Другой output shape

Меняется только [src/graph.ts](src/graph.ts): там проекция `Edge` → `PublicEdge` и формирование `services`. Внутренний граф (богатый) не меняется.

---

## Гарантии системы (spec §12)

- ✅ **Total** — система **всегда** возвращает `Trace`, даже если input полностью мусор.
- ✅ **Никогда не падает** на пропущенных полях — каждый слот имеет fallback.
- ✅ **Достраивает** недостающие рёбра: `INFERRED_REQUEST`, `INFERRED_RESPONSE`.
- ✅ **Достраивает** недостающие узлы: `external:<url>`, `virtual:<name>`, `unknown:<hash>`.
- ✅ **Вероятностная**, не детерминированная — каждое ребро несёт `confidence`, которая отражает качество причинно-следственной связи.

---

## Лицензия

ISC / public domain — делай что хочешь.
