# Спецификация: Аннотатор текста

## 1. Цель
Инструмент для аннотирования текстового файла и экспорта оригинала + аннотаций в один файл.
Решает задачу: .txt не поддерживает заметки нативно, нужна конвенция хранения.

## 2. Архитектура
- **Frontend**: Single Page React App (SPA), client-only, без бэкенда.
- **Стили**: Tailwind CSS + CSS variables для светлой/темной темы
- **Иконки**: lucide-react
- **Сборка**: Vite (в данном экспорте - готовый built.html для offline запуска)

## 3. Модель данных
```ts
type Annotation = {
  id: string;       // уникальный id (random + timestamp)
  quote: string;    // выделенный фрагмент оригинала
  start: number;    // offset начала в оригинальном тексте
  end: number;      // offset конца
  note: string;     // текст заметки пользователя
}
```
- `originalText: string` - полный текст
- `annotations: Annotation[]` - сортируется по start

Логика выделения:
- `getTextOffset()` - проходит TreeWalker по text-nodes в контейнере, считает смещение, чтобы выделение мышкой мапилось в индексы строки.
- Защита от пересечений: `hasOverlap` check.

## 4. Функционал
### Ввод:
- Загрузка .txt (FileReader, utf-8)
- Вставка текста через модалку
- Демо-текст по умолчанию (Толстой)

### Аннотирование:
- onMouseUp / onTouchEnd -> window.getSelection()
- Проверка что выделение внутри контейнера, trim пробелов
- Попап "Добавить заметку" позиционируется по rect выделения
- Рендер: `renderAnnotatedText()` режет оригинал на куски и оборачивает аннотированные куски в <mark class="ann-mark" data-badge={n}>

### Управление заметками (правая панель):
- Список отсортирован по позиции
- Редактирование note (textarea)
- Удаление
- Очистить все
- Счетчик символов, строка/позиция

## 5. Экспорт - ключевая фича (оригинал + аннотации в один файл)

### a) Markdown (.md)
- Вставляет сноски [^n] прямо после выделенного фрагмента
- Внизу блок "### Аннотации" с цитатой > "..." и заметкой
- Подходит для Obsidian, Notion, VS Code

### b) HTML (.html)
- Self-contained HTML с <style> внутри
- <mark class="ann"> + <span class="badge"> + <aside class="note">
- Экранирование через escapeHtml()
- Параграфы разбиваются по \n\n

### c) Комбинированный TXT (.txt)
```
---
[ОРИГИНАЛ]
---
весь текст

---
[АННОТАЦИИ] — N шт.
---
1. "цитата" -> заметка
   [строка X, позиция start:end]
```

### d) JSON (.json)
```json
{
  "originalText": "...",
  "annotations": [{id, quote, start, end, note}],
  "exportedAt": "ISO",
  "count": N
}
```
- Машиночитаемый, для дальнейшей обработки Python и т.д.

## 6. UI/UX решения
- Светлая тема #fcfbf8, темная #0f0e0d (prefers-color-scheme)
- Шрифты: Instrument Serif для заголовков, Inter для текста
- Sticky header/footer, backdrop-blur
- Toast уведомления
- Подсветка ::selection #fde68a
- Желтые маркеры #fef08a + border #facc15 + бейдж с номером

## 7. Ограничения и улучшения
- Нет сохранения в localStorage (сейчас сбрасывается при перезагрузке) - легко добавить useEffect -> localStorage.setItem
- Нет поддержки пересекающихся аннотаций (намеренно)
- Нет экспорта в DOCX/PDF - можно добавить через docx.js / jsPDF
- Нет поиска по аннотациям

## 8. Как запустить
```bash
npm install
npm run dev
```
Или просто открыть `annotator_built.html` - это полностью автономный билд.

## 9. Файлы в экспорте
- App.tsx - главный компонент (670 строк)
- index.css - tailwind директивы
- annotator_built.html - готовый к открытию билд
- package.json - зависимости
- SPECIFICATION.md - этот файл
