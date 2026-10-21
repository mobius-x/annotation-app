# ПОЛНАЯ ТЕХНИЧЕСКАЯ СПЕЦИФИКАЦИЯ: Аннотатор текста
## Text Annotator & Unified Export Engine
Версия: 2.0-draft | Дата: 2026-10-21 | Автор: Meta AI + User
Статус: Расширенная спецификация для рефактора и развития

---

### 0. EXECUTIVE SUMMARY

**Проблема:** .txt не имеет слоя аннотаций. Пользователи вынуждены держать 2 файла (original.txt + notes.txt) или использовать проприетарные инструменты (Word, PDF) которые ломают plain-text workflow.

**Решение v1 (текущий):** Client-only React SPA. Выделение мышкой -> создание аннотации (start, end, quote, note) -> рендер с <mark> + бейджами -> экспорт в 4 формата (MD, HTML, Combined TXT, JSON).

**Цель v2:** Универсальный движок аннотаций, который:
1. Сохраняет оригинал нетронутым (non-destructive)
2. Поддерживает 12+ форматов экспорта/импорта
3. Совместим с экосистемами: Pandoc, Obsidian, CriticMarkup, W3C Web Annotation, TEI, DOCX, Hypothesis
4. Готов к коллаборации и AI

---

### 1. ГЛОССАРИЙ

- **Оригинал (Source Text)** - неизменяемый исходный текст, UTF-8.
- **Аннотация (Annotation)** - объект с привязкой к диапазону [start, end) и содержимым.
- **Квота (Quote)** - срез оригинала originalText.slice(start, end) - денормализуется для читаемости, но источник истины - start/end.
- **Слой аннотаций (Annotation Layer)** - массив аннотаций, отдельный от текста.
- **Экспорт (Export)** - проекция Source + Layer в один файл целевого формата.
- **CriticMarkup** - синтаксис для трекинга правок в Markdown: {++добавление++}, {--удаление--}, {~~старое~>новое~~}, {==комментарий==}{>>разрешение<<}
- **W3C Web Annotation** - стандарт W3C для аннотаций в вебе.

### 2. АНАЛИЗ ТЕКУЩЕЙ РЕАЛИЗАЦИИ (v1)

**Файл:** App.tsx ~670 строк

**Стек:**
- React 18 + hooks (useState, useRef, useEffect)
- Tailwind (через CDN/classes)
- lucide-react для иконок
- Vite (для dev), но есть автономный built.html

**Ключевые функции:**

```ts
getTextOffset(container: HTMLElement, targetNode: Node, targetOffset: number): number
// Обходит TreeWalker(SHOW_TEXT), суммирует длины textContent до targetNode.
// Проблема: не учитывает скрытые символы, эмодзи (surrogate pairs). Нужно использовать Intl.Segmenter.

handleMouseUp()
// window.getSelection(), проверка contains(), trim пробелов, создание selectionInfo {start, end, rect}

handleAddAnnotation()
// Проверка hasOverlap: annotations.some(a => !(end <= a.start || start >= a.end))
// Сейчас запрещает пересечения. В v2 - разрешить с режимом.

renderAnnotatedText()
// Сортирует по start, режет строку на куски, оборачивает в <mark class="ann-mark" data-badge>
```

**Ограничения v1, которые фиксим в v2:**
1. Нет localStorage / IndexedDB - потеря при перезагрузке.
2. Нет типов аннотаций (только note).
3. Нет undo/redo.
4. Оффсеты ломаются если оригинал редактируется (нужен stable anchoring).
5. Только 4 формата экспорта.
6. Нет импорта.

### 3. МОДЕЛЬ ДАННЫХ v2 (расширенная)

```ts
// Базовый тип
type AnnotationId = string; // ULID

type AnnotationType = 
  | 'note'        // заметка
  | 'highlight'   // просто подсветка
  | 'question'    // вопрос
  | 'todo'        // todo
  | 'critic_add'  // CriticMarkup: добавление
  | 'critic_del'  // удаление
  | 'critic_sub'  // замена
  | 'critic_comment' // комментарий
  | 'critic_highlight';

type AnnotationStatus = 'open' | 'resolved' | 'archived';

interface BaseAnnotation {
  id: AnnotationId;
  type: AnnotationType;
  quote: string;          // денормализовано, для экспорта
  start: number;          // UTF-16 offset (совместимость с JS) + дополнительно startUtf8, startGrapheme
  end: number;
  // Для robust anchoring (по Pandoc/Hypothesis):
  prefix?: string;        // 32 символа до
  suffix?: string;        // 32 символа после
  exact?: string;         // точная цитата для fuzzy matching
  note: string;           // тело заметки
  tags?: string[];        // #теги
  color?: string;         // hex, для UI
  author?: string;
  createdAt: string;      // ISO
  updatedAt: string;
  status: AnnotationStatus;
  parentId?: AnnotationId; // для тредов
  metadata?: Record<string, any>;
}

interface DocumentState {
  id: string;
  originalText: string;
  originalHash: string; // sha256 для проверки изменений
  annotations: BaseAnnotation[];
  version: number;
  history: HistoryEntry[]; // для undo
}
```

**Robust Anchoring:** При экспорте сохраняем prefix/suffix, чтобы при изменении оригинала можно было перепривязать через алгоритм Fuzzy Search (как в Hypothesis).

### 4. АРХИТЕКТУРА v2

```
src/
  core/
    anchor.ts      // перевод DOM Selection -> offsets + prefix/suffix + fuzzy re-anchor
    model.ts       // типы, валидация zod
    store.ts       // Zustand + IndexedDB (idb-keyval)
    history.ts     // undo/redo stack
    exportEngine.ts // фасад: export(format, doc) -> string | Blob
    importEngine.ts
  exporters/
    markdown.ts
    html.ts
    combinedTxt.ts
    json.ts
    criticMarkup.ts
    pandoc.ts
    docx.ts        // использует docx.js
    tei.ts
    w3c.ts
    csv.ts
    obsidian.ts
    epub.ts
  components/
    TextPane.tsx
    AnnotationList.tsx
    ...
```

**Хранение:** IndexedDB (Dexie) + localStorage fallback + опционально file-system-access API для прямой записи в файл.

### 5. ДЕТАЛЬНАЯ СПЕЦИФИКАЦИЯ ЭКСПОРТОВ

#### 5.1 Markdown (GitHub Flavored + Footnotes + Callouts)
**Текущий:** `text[^n]` + `[^n]: note`
**v2 улучшение:**
- Поддержка Obsidian Callouts: `> [!note] Title`
- Поддержка ссылок на строки.
- Опция: inline vs footnote vs blockquote.

Пример:
```md
Все смешалось[^1].

[^1]: **Заметка (вопрос):** Проверить источник
     > "Все смешалось" — строка 2
     > Теги: #проверить
```

Библиотека: `remark`, `mdast`.

#### 5.2 HTML Standalone
**Текущий:** <mark> + <aside>
**v2:**
- Семантический: <article>, <mark data-annotation-id>, <aside data-for>
- Microdata: schema.org/Comment
- Интерактив: клик по маркеру скроллит к заметке, подсветка.
- Темная тема через prefers-color-scheme, print styles.

#### 5.3 Combined TXT (человеко-читаемый лог)
Для diff и git.

```
--- META ---
hash: sha256:abc
count: 3
exported: 2026-10-21T...

--- ORIGINAL ---
...

--- ANNOTATIONS ---
[1] TYPE=note STATUS=open LINE=2 POS=28-41
QUOTE: "Все смешалось"
NOTE: Тут надо проверить источник
TAGS: #фактчек
```

#### 5.4 JSON (наш + W3C)
**Наш (internal):** полный DocumentState
**W3C Web Annotation JSON-LD:**
```json
{
  "@context": "http://www.w3.org/ns/anno.jsonld",
  "id": "urn:uuid:...",
  "type": "Annotation",
  "body": [{ "type": "TextualBody", "value": "Проверить источник", "purpose": "commenting" }],
  "target": {
    "source": "original.txt",
    "selector": { "type": "TextQuoteSelector", "exact": "Все смешалось", "prefix": "В доме Облонских ", "suffix": ". Жена узнала" }
  }
}
```
Совместимость с Hypothesis, Recogito.

#### 5.5 CriticMarkup (КРИТИЧЕСКИ ВАЖНО для писателей/редакторов)
Синтаксис:
- Добавление: `{++новый текст++}`
- Удаление: `{--старый текст--}`
- Замена: `{~~старый~>новый~~}`
- Комментарий: `{==комментарий==}`
- Подсветка: `{==выделенный текст==}{>>комментарий<<}`

Экспорт из наших аннотаций:
- type=critic_add -> `{++quote + note++}` или `{++note++}` если вставка
- type=critic_del -> `{--quote--}`
- type=critic_sub -> `{~~quote~>note~~}`
- type=critic_comment -> `{==quote==}{>>note<<}`

Пример:
```md
В доме Облонских {--все смешалось--}{++все пошло прахом++} {==все смешалось==}{>>клише? перефразировать<<}
```

Парсинг: `critic-markup` npm.

#### 5.6 Pandoc AST JSON
Pandoc - лингва франка для конвертации. Экспорт в Pandoc JSON позволяет потом конвертировать в DOCX, PDF, LaTeX, EPUB одной командой.

Структура: `pandoc -t json` дает `{blocks: [{t: "Para", c: [...]}]}`

Наш экспорт: преобразуем оригинал в Para, а аннотации в Span с атрибутами:

```json
{
  "t": "Span",
  "c": [
    ["", ["annotation", "note"], [["data-note", "Проверить"], ["data-id", "abc"]]],
    [{ "t": "Str", "c": "Все смешалось" }]
  ]
}
```

Использование:
```bash
pandoc annotations.pandoc.json -o output.docx
pandoc annotations.pandoc.json -o output.pdf
```

Библиотека: `pandoc-filter`, писать на TS.

#### 5.7 DOCX (OOXML) с комментариями
Самый запрашиваемый корпоративный формат.

Требования:
- Оригинал -> Paragraphs
- Аннотации -> Word Comments (w:commentRangeStart, w:commentRangeEnd, w:comment) + Highlights (w:highlight)
- Поддержка типов: note -> comment, highlight -> highlight yellow

Библиотека: `docx` (npm docx) - умеет создавать Comments.

Пример кода (псевдо):
```ts
import { Document, Packer, Paragraph, TextRun, CommentRangeStart, CommentRangeEnd } from "docx";
// ...
const doc = new Document({
  comments: { children: [{ id: 0, author: "Аннотатор", text: "Проверить источник", range: ... }] }
});
```

Альтернатива: `mammoth` для импорта DOCX -> наш формат.

#### 5.8 TEI XML (для академиков, Digital Humanities)
Text Encoding Initiative.

```xml
<TEI>
  <text>
    <body>
      <p>В доме Облонских <seg xml:id="ann1">все смешалось</seg>...</p>
    </body>
  </text>
  <standOff>
    <annotation xml:id="ann1" type="note">
      <note>Проверить источник</note>
    </annotation>
  </standOff>
</TEI>
```

#### 5.9 CSV / TSV (для анализа)
Таблица для Excel / Python pandas.

| id | start | end | quote | note | type | tags | line | status |
|---|---|---|---|---|---|---|---|

#### 5.10 Obsidian / Logseq совместимый
- Файл в vault: оригинал + блок `%% annotator:start %%` ... `%% annotator:end %%` с JSON
- Или отдельные заметки-ссылки: `[[аннотация-1]]`

#### 5.11 EPUB (с сносками)
Конвертация через Pandoc + вставка footnotes как EPUB notes.

#### 5.12 Hypothesis JSON (импорт/экспорт)
Совместимость с hypothesis.is API.

#### 5.13 SQLite / DuckDB
Один .db файл: таблица documents, annotations. Для больших корпусов.

---

### 6. СПЕЦИФИКАЦИЯ ИМПОРТОВ

Нужно уметь загрузить обратно:
- Наш JSON / W3C
- Markdown с [^n] сносками -> парсить и восстанавливать оффсеты через поиск цитат
- CriticMarkup -> парсить {++ ++} и т.д. -> создавать аннотации типа critic_*
- DOCX comments -> через mammoth + docx-parser
- HTML с <mark> -> DOMParser

### 7. ИДЕИ УЛУЧШЕНИЙ (BACKLOG)

#### A. Хранение и надежность
- [ ] IndexedDB + autosave каждые 2 сек + debounce
- [ ] File System Access API: открыть файл с диска и сохранять прямо туда (Chrome/Edge)
- [ ] Версионирование: git-like history, diff оригинала
- [ ] Hash оригинала (SHA-256) + предупреждение если оригинал изменился вне инструмента
- [ ] Экспорт как self-contained .html с встроенным JSON для re-import (round-trip)

#### B. Типы аннотаций и UX
- [ ] Типы: note, question, todo, highlight, important, critic_add/del/sub/comment
- [ ] Цвета: 5 цветов (желтый, зеленый, голубой, розовый, оранжевый) как в Kindle
- [ ] Теги: #важно #проверить + автокомплит + фильтр
- [ ] Статусы: open/resolved/archived + фильтр
- [ ] Вложенные треды: отвечать на аннотацию (parentId)
- [ ] Голосовые заметки: запись аудио к аннотации (MediaRecorder -> base64 в JSON)
- [ ] Рисование: для PDF-подобных аннотаций (canvas overlay)

#### C. Навигация и поиск
- [ ] Поиск по заметкам (Fuse.js)
- [ ] Фильтр по типу/тегу/статусу/цвету
- [ ] Мини-карта (minimap) как в VS Code с точками аннотаций
- [ ] Оглавление по заголовкам (если оригинал markdown)
- [ ] Горячие клавиши: n - новая, j/k - следующая/предыдущая

#### D. Robust Anchoring
- [ ] При редактировании оригинала пересчитывать оффсеты через diff (diff-match-patch)
- [ ] Fuzzy re-anchoring по prefix/suffix/exact (алгоритм Hypothesis)
- [ ] Поддержка Unicode grapheme clusters (Intl.Segmenter)

#### E. Коллаборация
- [ ] Share link: закодировать DocumentState в URL hash (lz-string) или в gist
- [ ] Yjs CRDT для realtime коллаба
- [ ] Комментарии от разных авторов с цветами
- [ ] Экспорт в Google Docs comments API

#### F. AI-фичи
- [ ] Авто-саммари аннотаций
- [ ] Предложить теги
- [ ] Найти противоречия в аннотациях
- [ ] Сгенерировать вопросы к тексту
- [ ] Перевести заметки
- [ ] AI-ассистент: "Объясни этот фрагмент"

#### G. Интеграции
- [ ] Obsidian Plugin: команда "Открыть в Аннотаторе"
- [ ] VS Code Extension
- [ ] Pandoc filter: `pandoc --filter annotator-filter`
- [ ] CLI: `npx annotator export original.txt --format docx --annotations annotations.json`

#### H. Accessibility & i18n
- [ ] ARIA для маркеров
- [ ] Клавиатурная навигация
- [ ] Локализация: ru/en/es
- [ ] Высокая контрастность, уменьшение анимаций

### 8. ТЕХНИЧЕСКИЙ СТЕК v2

- **State:** Zustand + Immer
- **DB:** Dexie (IndexedDB)
- **Text processing:** diff-match-patch, Intl.Segmenter, grapheme-splitter
- **Exports:**
  - docx: `docx` npm
  - pdf: `pdf-lib` или через pandoc
  - critic: кастомный парсер
  - pandoc: генерация AST руками
- **Import:** `mammoth` (docx), `critic-markup` parser, `linkedom` для HTML
- **UI:** React + Tailwind + Radix UI + Framer Motion
- **Testing:** Vitest + Playwright (для выделения)

### 9. ROADMAP

**v1.1 (2 недели):**
- localStorage + undo/redo + цвета + теги
- Экспорт CriticMarkup + CSV + W3C

**v1.5 (1 месяц):**
- DOCX экспорт с комментариями
- Pandoc JSON экспорт
- Импорт из MD (footnotes)

**v2.0 (2 месяца):**
- IndexedDB + File System Access + robust anchoring
- Yjs коллаб + AI саммари

### 10. ПРИМЕРЫ ЭКСПОРТОВ (для тестов)

#### CriticMarkup пример:
Вход: quote="все смешалось", note="все пошло прахом", type=critic_sub
Выход: `{~~все смешалось~>все пошло прахом~~}`

#### DOCX комментарии (ожидаемый XML):
```xml
<w:commentRangeStart w:id="0"/>
<w:r><w:t>все смешалось</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:comment w:id="0" w:author="Аннотатор"><w:p><w:r><w:t>Проверить источник</w:t></w:r></w:p></w:comment>
```

#### Pandoc:
```bash
# Наш JSON -> Pandoc AST -> DOCX
cat doc.pandoc.json | pandoc -f json -t docx -o out.docx
```

### 11. API ДИЗАЙН (для будущего SDK)

```ts
import { Annotator } from '@annotator/core';

const doc = await Annotator.loadText(originalText);
doc.addAnnotation({ start, end, note, type: 'note', tags: ['#важно'] });
const md = await doc.export('markdown', { style: 'footnotes' });
const docxBlob = await doc.export('docx', { includeComments: true });
await doc.saveToFile('my-doc.annotated.json');
```

### 12. ТЕСТИРОВАНИЕ

- Юнит: anchor.ts (100 тестов на эмодзи, перенос строк)
- E2E: Playwright - выделить текст мышкой, проверить создание аннотации
- Снапшоты экспортов: для каждого формата есть golden file

### 13. ОТКРЫТЫЕ ВОПРОСЫ

1. Как обрабатывать редактирование оригинала? Пересчитывать или замораживать?
2. Разрешать ли пересекающиеся аннотации? (Да, но с UI как в Google Docs - слои)
3. Где хранить большие файлы (>10MB)? Streaming + Web Worker.

---
КОНЕЦ СПЕЦИФИКАЦИИ
