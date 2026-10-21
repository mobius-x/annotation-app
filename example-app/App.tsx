import React, { useRef, useState, useEffect } from "react";
import { Upload, ClipboardPaste, Trash2, FileText, Code2, File as FileIcon, Braces, X, StickyNote, Highlighter, Sparkles } from "lucide-react";

type Annotation = {
  id: string;
  quote: string;
  start: number;
  end: number;
  note: string;
};

const SAMPLE_TEXT = `Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему.

В доме Облонских все смешалось. Жена узнала, что муж был в связи с бывшею в их доме француженкою-гувернанткой, и объявила мужу, что не может жить с ним в одном доме.

Положение это продолжалось уже третий день и мучительно чувствовалось и самими супругами, и всеми членами семьи, и домочадцами. Все члены семьи и домочадцы чувствовали, что нет смысла в их сожительстве и что на каждом постоялом дворе случайно сошедшиеся люди более связаны между собой, чем они, члены семьи и домочадцы Облонских.

Попробуйте выделить любой фрагмент этого текста мышкой — появится кнопка «Добавить заметку». Все заметки появятся справа, а в тексте фрагмент подсветится желтым с номером.

Это демо-текст, вы можете загрузить свой .txt файл или вставить текст через кнопку вверху.`;


function getLineNumber(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getTextOffset(container: HTMLElement, targetNode: Node, targetOffset: number): number {
  let total = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text)) {
    if (node === targetNode) {
      return total + targetOffset;
    }
    total += node.textContent?.length || 0;
  }
  return -1;
}

export default function App() {
  const [originalText, setOriginalText] = useState<string>(SAMPLE_TEXT);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectionInfo, setSelectionInfo] = useState<{ start: number; end: number; rect: DOMRect } | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  const [overlapWarning, setOverlapWarning] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const textContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const leftScrollRef = useRef<HTMLDivElement>(null);

  // clear selection when text changes
  useEffect(() => {
    setSelectionInfo(null);
  }, [originalText]);

  useEffect(() => {
    if (overlapWarning) {
      const t = setTimeout(() => setOverlapWarning(null), 3000);
      return () => clearTimeout(t);
    }
  }, [overlapWarning]);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3500);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const handleMouseUp = () => {
    if (!textContainerRef.current || !originalText) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      return;
    }
    const range = sel.getRangeAt(0);
    const selectedText = sel.toString();
    if (selectedText.trim().length < 2) return;

    // ensure selection inside container
    if (!textContainerRef.current.contains(sel.anchorNode) || !textContainerRef.current.contains(sel.focusNode)) {
      setSelectionInfo(null);
      return;
    }

    const startOffset = getTextOffset(textContainerRef.current, sel.anchorNode!, sel.anchorOffset);
    const endOffset = getTextOffset(textContainerRef.current, sel.focusNode!, sel.focusOffset);

    if (startOffset === -1 || endOffset === -1) return;

    let start = Math.min(startOffset, endOffset);
    let end = Math.max(startOffset, endOffset);

    // trim whitespace from edges to match quote cleanly
    while (start < end && /\s/.test(originalText[start])) start++;
    while (end > start && /\s/.test(originalText[end - 1])) end--;

    if (end - start < 2) return;

    const rect = range.getBoundingClientRect();
    setSelectionInfo({ start, end, rect });
  };

  const handleAddAnnotation = () => {
    if (!selectionInfo) return;
    const { start, end } = selectionInfo;
    const hasOverlap = annotations.some((a) => !(end <= a.start || start >= a.end));
    if (hasOverlap) {
      setOverlapWarning("Этот фрагмент уже пересекается с существующей аннотацией");
      setSelectionInfo(null);
      window.getSelection()?.removeAllRanges();
      return;
    }
    const newAnn: Annotation = {
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      quote: originalText.slice(start, end),
      start,
      end,
      note: "",
    };
    setAnnotations((prev) => [...prev, newAnn].sort((a, b) => a.start - b.start));
    setSelectionInfo(null);
    window.getSelection()?.removeAllRanges();
  };

  const updateNote = (id: string, note: string) => {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, note } : a)));
  };

  const deleteAnnotation = (id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setToast(`Загружен файл: ${file.name} — ${file.size} байт`);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setOriginalText(text);
      setAnnotations([]);
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  };

  const handlePasteConfirm = () => {
    if (pasteValue.trim()) {
      setOriginalText(pasteValue);
      setAnnotations([]);
      setShowPaste(false);
      setPasteValue("");
      setToast(`Вставлен текст — ${pasteValue.length.toLocaleString("ru-RU")} символов`);
    }
  };

  // Render original with highlights
  const renderAnnotatedText = () => {
    if (!originalText) {
      return <div className="text-[var(--muted)] italic">Текст не загружен. Загрузите .txt файл или вставьте текст.</div>;
    }
    const sorted = [...annotations].sort((a, b) => a.start - b.start);
    const nodes: React.ReactNode[] = [];
    let last = 0;
    sorted.forEach((ann, idx) => {
      if (ann.start > last) {
        nodes.push(<span key={`t-${last}`}>{originalText.slice(last, ann.start)}</span>);
      }
      nodes.push(
        <mark key={ann.id} data-badge={idx + 1} className="ann-mark">
          {originalText.slice(ann.start, ann.end)}
        </mark>
      );
      last = ann.end;
    });
    if (last < originalText.length) {
      nodes.push(<span key={`t-${last}-end`}>{originalText.slice(last)}</span>);
    }
    return nodes;
  };

  // Exports
  const exportMarkdown = () => {
    if (!originalText) return;
    setToast("Скачиваю Markdown файл…");
    const sorted = [...annotations].sort((a, b) => a.start - b.start);
    let md = "";
    let last = 0;
    sorted.forEach((ann, i) => {
      md += originalText.slice(last, ann.end) + `[^${i + 1}]`;
      last = ann.end;
    });
    md += originalText.slice(last);
    md += "\n\n---\n\n### 📎 Аннотации\n\n";
    sorted.forEach((ann, i) => {
      const note = ann.note?.trim() ? ann.note : "_Без заметки_";
      const cleanQuote = ann.quote.replace(/\n/g, " ").slice(0, 200);
      md += `> "${cleanQuote}"\n>\n> 📝 Заметка [^${i + 1}]: ${note}\n\n`;
      md += `[^${i + 1}]: Строка ${getLineNumber(originalText, ann.start)} — ${note}\n\n`;
    });
    downloadFile(md, "аннотации.md", "text/markdown;charset=utf-8");
    setTimeout(() => setToast("Готово: аннотации.md скачан"), 300);
  };

  const exportHTML = () => {
    if (!originalText) return;
    setToast("Скачиваю HTML файл…");
    const sorted = [...annotations].sort((a, b) => a.start - b.start);
    let body = "";
    let last = 0;
    sorted.forEach((ann, i) => {
      body += escapeHtml(originalText.slice(last, ann.start));
      body += `<mark class="ann">${escapeHtml(originalText.slice(ann.start, ann.end))}<span class="badge">${i + 1}</span></mark>`;
      last = ann.end;
    });
    body += escapeHtml(originalText.slice(last));
    const paragraphs = body
      .split("\n\n")
      .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
      .join("\n");
    const notes = sorted
      .map(
        (ann, i) => `
      <aside class="note">
        <div class="note-head"><span class="num">${i + 1}</span><em>"${escapeHtml(ann.quote.slice(0, 300))}"</em></div>
        <div class="note-body">${escapeHtml(ann.note || "Без заметки")}</div>
        <div class="note-meta">Строка ${getLineNumber(originalText, ann.start)} · символы ${ann.start}–${ann.end}</div>
      </aside>`
      )
      .join("\n");
    const full = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Аннотированный текст</title>
<style>
  :root{--bg:#fdfcf9;--fg:#171717;--muted:#78716c;--accent:#facc15;--card:#ffffff;--border:#e7e5e4}
  body{font-family: ui-sans-system, -apple-system, Segoe UI, Roboto, Inter, sans-serif; background:var(--bg); color:var(--fg); line-height:1.8; max-width:840px; margin:0 auto; padding:32px 24px}
  h1{font-size:28px; letter-spacing:-0.02em; margin-bottom:8px}
  .meta{color:var(--muted); font-size:14px; margin-bottom:32px}
  article{background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; box-shadow: 0 1px 3px rgba(0,0,0,0.06)}
  mark.ann{background:#fef08a; padding:2px 4px; border-radius:4px; position:relative; border-bottom:2px solid #facc15}
  .badge{display:inline-flex; align-items:center; justify-content:center; background:#111; color:#fff; font-size:10px; width:18px; height:18px; border-radius:50%; margin-left:6px; vertical-align:super}
  aside.note{background:#fffbeb; border:1px solid #fde68a; border-left:4px solid #facc15; padding:14px 16px; margin:20px 0; border-radius:12px}
  .note-head{display:flex; gap:10px; align-items:flex-start; margin-bottom:8px}
  .num{background:#111; color:#fff; width:22px; height:22px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:12px; flex-shrink:0}
  .note-meta{font-size:12px; color:var(--muted); margin-top:8px}
</style></head><body>
<h1>Аннотированный текст</h1><div class="meta">Экспорт из «Аннотатор текста» — ${new Date().toLocaleDateString("ru-RU")}</div>
<article>${paragraphs}</article>
<section style="margin-top:40px"><h2>Заметки</h2>${notes || "<p>Нет аннотаций</p>"}</section>
</body></html>`;
    downloadFile(full, "аннотированный_текст.html", "text/html;charset=utf-8");
    setTimeout(() => setToast("Готово: аннотированный_текст.html скачан"), 300);
  };

  const exportCombined = () => {
    if (!originalText) return;
    setToast("Скачиваю комбинированный TXT…");
    let out = `---\n[ОРИГИНАЛ]\n---\n${originalText}\n\n---\n[АННОТАЦИИ] — ${annotations.length} шт.\n---\n`;
    annotations.forEach((ann, i) => {
      out += `${i + 1}. "${ann.quote.replace(/\n/g, " ")}"\n   -> ${ann.note || "(без заметки)"}\n   [строка ${getLineNumber(originalText, ann.start)}, позиция ${ann.start}:${ann.end}]\n\n`;
    });
    downloadFile(out, "комбинированный.txt", "text/plain;charset=utf-8");
    setTimeout(() => setToast("Готово: комбинированный.txt скачан"), 300);
  };

  const exportJSON = () => {
    setToast("Скачиваю JSON…");
    const data = {
      originalText,
      annotations: annotations.map(({ id, quote, start, end, note }) => ({ id, quote, start, end, note })),
      exportedAt: new Date().toISOString(),
      count: annotations.length,
    };
    downloadFile(JSON.stringify(data, null, 2), "аннотации.json", "application/json;charset=utf-8");
    setTimeout(() => setToast("Готово: аннотации.json скачан"), 300);
  };

  return (
    <div
      className="min-h-screen bg-[var(--bg)] text-[var(--fg)] flex flex-col"
      style={{ paddingTop: "var(--safe-area-inset-top)", boxSizing: "border-box" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap');
        :root{
          --bg:#fcfbf8;
          --fg:#171717;
          --muted:#78716c;
          --muted-2:#a8a29e;
          --card:#ffffff;
          --border:#e7e5e4;
          --border-strong:#d6d3d1;
          --accent:#facc15;
          --accent-2:#fef08a;
          --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04);
          --radius:16px;
        }
        @media (prefers-color-scheme: dark){
          :root{
            --bg:#0f0e0d;
            --fg:#f5f5f4;
            --muted:#a8a29e;
            --muted-2:#78716c;
            --card:#1c1917;
            --border:#292524;
            --border-strong:#44403c;
            --accent:#facc15;
            --accent-2:#422006;
            --shadow: 0 1px 3px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.2);
          }
        }
        .font-display{font-family: "Instrument Serif", Georgia, serif}
        .font-sans{font-family: Inter, ui-sans-system, -apple-system, Segoe UI, Roboto, sans-serif}
        .ann-mark{
          background: var(--accent-2);
          border-bottom: 2px solid var(--accent);
          border-radius: 4px;
          padding: 0 3px;
          position: relative;
          cursor: pointer;
          transition: background 0.15s;
        }
        .ann-mark:hover{background: #fde047}
        @media (prefers-color-scheme: dark){
          .ann-mark:hover{background:#854d0e}
        }
        .ann-mark::after{
          content: attr(data-badge);
          position: absolute;
          top: -9px;
          right: -9px;
          width: 18px;
          height: 18px;
          background: #171717;
          color: white;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          line-height: 1;
          box-shadow: 0 2px 6px rgba(0,0,0,0.2);
          font-family: Inter, sans-serif;
        }
        @media (prefers-color-scheme: dark){
          .ann-mark::after{background:#fafaf9; color:#111}
        }
        ::selection{background:#fde68a}
        .scrollbar-thin::-webkit-scrollbar{width:6px; height:6px}
        .scrollbar-thin::-webkit-scrollbar-thumb{background:#d6d3d1; border-radius:999px}
      `}</style>

      {/* Header */}
      <header
        className="sticky z-30 backdrop-blur-xl bg-[var(--bg)]/80 border-b border-[var(--border)]"
        style={{ top: "var(--safe-area-inset-top)" }}
      >
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 h-[64px] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#111] text-white flex items-center justify-center">
              <Highlighter className="w-4 h-4" />
            </div>
            <h1 className="font-display text-[22px] sm:text-[26px] tracking-[-0.02em]">Аннотатор текста</h1>
            <span className="hidden sm:inline-flex ml-2 px-2 py-0.5 rounded-full bg-[var(--card)] border border-[var(--border)] text-[11px] font-sans font-medium text-[var(--muted)]">
              {originalText.length.toLocaleString("ru-RU")} символов · {annotations.length} заметок
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input ref={fileInputRef} type="file" accept=".txt,text/plain" className="hidden" onChange={handleFileUpload} />
            <button
              onClick={() => {
                setToast("Выберите .txt файл в диалоге");
                fileInputRef.current?.click();
              }}
              className="h-9 px-3.5 rounded-full bg-[#111] text-white font-sans text-[13px] font-medium flex items-center gap-2 hover:bg-[#222] transition-colors"
            >
              <Upload className="w-4 h-4" />
              <span className="hidden sm:inline">Загрузить .txt</span>
              <span className="sm:hidden">Файл</span>
            </button>
            <button
              onClick={() => {
                setShowPaste(true);
                setToast("Откройте окно вставки текста");
              }}
              className="h-9 px-3.5 rounded-full bg-[var(--card)] border border-[var(--border)] font-sans text-[13px] font-medium flex items-center gap-2 hover:border-[var(--border-strong)] transition-colors"
            >
              <ClipboardPaste className="w-4 h-4" />
              <span className="hidden sm:inline">Вставить текст</span>
              <span className="sm:hidden">Вставить</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main */}
      <div className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 flex flex-col lg:flex-row gap-6 lg:gap-6">
        {/* Left */}
        <div className="lg:w-[60%] flex flex-col min-w-0">
          <div className="flex items-center justify-between mb-3 px-1">
            <div className="flex items-center gap-2 font-sans text-[12px] font-medium text-[var(--muted)] uppercase tracking-widest">
              <FileIcon className="w-3.5 h-3.5" />
              Оригинал
            </div>
            <div className="flex items-center gap-2">
              {overlapWarning && (
                <span className="font-sans text-[12px] px-2.5 py-1 rounded-full bg-[#fef2f2] border border-[#fecaca] text-[#991b1b]">
                  {overlapWarning}
                </span>
              )}
              <span className="font-sans text-[11px] text-[var(--muted-2)] hidden sm:inline-flex items-center gap-1.5">
                <Sparkles className="w-3 h-3" /> Выделите текст мышкой
              </span>
            </div>
          </div>

          <div
            ref={leftScrollRef}
            className="relative bg-[var(--card)] border border-[var(--border)] rounded-[var(--radius)] shadow-[var(--shadow)] overflow-hidden flex-1 min-h-[420px] lg:min-h-[560px] flex flex-col"
          >
            <div
              ref={textContainerRef}
              onMouseUp={handleMouseUp}
              onTouchEnd={handleMouseUp}
              className="flex-1 overflow-auto p-6 sm:p-8 lg:p-10 font-sans text-[15px] sm:text-[16px] leading-[1.75] whitespace-pre-wrap break-words scrollbar-thin selection:bg-[#fde68a] outline-none"
              style={{ fontFamily: "Inter, ui-sans-system, sans-serif", letterSpacing: "-0.01em" }}
            >
              {renderAnnotatedText()}
              {originalText && <span className="inline-block w-[2px] h-[1.2em] bg-transparent" />}
            </div>

            {/* subtle footer inside left panel */}
            <div className="h-9 border-t border-[var(--border)] bg-[#fcfaf6]/80 dark:bg-[#1c1917]/80 flex items-center justify-between px-4 font-sans text-[11px] text-[var(--muted)]">
              <span>Строк: {originalText.split("\n").length} · Слов: {originalText.split(/\s+/).filter(Boolean).length}</span>
              <span className="hidden sm:inline">Двойной клик — быстрое выделение слова</span>
            </div>

            {/* selection popup */}
            {selectionInfo && (
              <div
                className="fixed z-40"
                style={{
                  left: Math.min(window.innerWidth - 180, Math.max(12, selectionInfo.rect.left + selectionInfo.rect.width / 2 - 80)),
                  top: Math.max(80, selectionInfo.rect.bottom + 8),
                }}
              >
                <button
                  onClick={handleAddAnnotation}
                  className="px-3.5 py-2 rounded-full bg-[#111] text-white text-[13px] font-medium shadow-[0_4px_16px_rgba(0,0,0,0.2)] flex items-center gap-2 hover:bg-black transition-all animate-[pop_0.15s_ease]"
                >
                  <StickyNote className="w-4 h-4" />
                  Добавить заметку
                </button>
                <style>{`@keyframes pop{0%{transform:scale(0.9) translateY(4px); opacity:0}100%{transform:scale(1) translateY(0); opacity:1}}`}</style>
              </div>
            )}
          </div>
        </div>

        {/* Right */}
        <div className="lg:w-[40%] flex flex-col min-w-0">
          <div className="flex items-center justify-between mb-3 px-1">
            <div className="flex items-center gap-2 font-sans text-[12px] font-medium text-[var(--muted)] uppercase tracking-widest">
              <StickyNote className="w-3.5 h-3.5" />
              Заметки — {annotations.length}
            </div>
            {annotations.length > 0 && (
              <button
                onClick={() => setAnnotations([])}
                className="font-sans text-[11px] text-[var(--muted)] hover:text-[var(--fg)] underline underline-offset-4"
              >
                Очистить все
              </button>
            )}
          </div>

          <div className="bg-[var(--card)] border border-[var(--border)] rounded-[var(--radius)] shadow-[var(--shadow)] flex-1 min-h-[320px] flex flex-col overflow-hidden">
            {annotations.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
                <div className="w-12 h-12 rounded-full bg-[#fef9c3] border border-[#fde68a] flex items-center justify-center mb-4">
                  <Highlighter className="w-6 h-6 text-[#a16207]" />
                </div>
                <p className="font-display text-[18px] leading-tight mb-2">Пока нет заметок</p>
                <p className="font-sans text-[13px] text-[var(--muted)] leading-[1.5] max-w-[28ch]">
                  Выделите фрагмент в левом поле и нажмите «Добавить заметку». Здесь появится цитата и поле для комментария.
                </p>
                <div className="mt-6 p-3 rounded-xl bg-[#fcfaf6] border border-dashed border-[var(--border)] w-full max-w-[320px]">
                  <div className="font-sans text-[11px] text-[var(--muted)] uppercase tracking-widest mb-1.5">Подсказка</div>
                  <div className="font-sans text-[12px] text-[var(--muted)] leading-[1.5]">
                    Аннотации подсвечиваются желтым с номером. Они сохраняются в памяти и доступны для экспорта внизу.
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-3 scrollbar-thin">
                {annotations.map((ann, idx) => (
                  <div
                    key={ann.id}
                    className="group relative rounded-[14px] border border-[var(--border)] bg-[#fffefb] dark:bg-[#1f1c18] p-4 hover:border-[var(--border-strong)] transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-[#111] dark:bg-[#fafaf9] text-white dark:text-[#111] text-[12px] font-semibold flex items-center justify-center">
                          {idx + 1}
                        </span>
                        <span className="font-sans text-[11px] text-[var(--muted)]">
                          Строка {getLineNumber(originalText, ann.start)} · {ann.start}:{ann.end} · {ann.quote.length} симв.
                        </span>
                      </div>
                      <button
                        onClick={() => deleteAnnotation(ann.id)}
                        className="w-7 h-7 rounded-full bg-white dark:bg-[#292524] border border-[var(--border)] flex items-center justify-center text-[var(--muted)] hover:text-[#dc2626] hover:border-[#fecaca] transition-colors"
                        aria-label="Удалить заметку"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="relative pl-3 border-l-2 border-[#fde68a] mb-3">
                      <div className="font-sans text-[13px] leading-[1.6] text-[#44403c] dark:text-[#e7e5e4] italic line-clamp-4">
                        “{ann.quote}”
                      </div>
                    </div>

                    <textarea
                      value={ann.note}
                      onChange={(e) => updateNote(ann.id, e.target.value)}
                      placeholder="Ваша заметка к этому фрагменту…"
                      className="w-full min-h-[72px] rounded-xl border border-[var(--border)] bg-white dark:bg-[#0f0e0d] px-3 py-2.5 font-sans text-[13px] leading-[1.5] outline-none focus:border-[#111] focus:ring-2 focus:ring-[#111]/10 dark:focus:border-[#fafaf9] dark:focus:ring-[#fafaf9]/10 resize-y placeholder:text-[var(--muted-2)]"
                    />

                    {ann.note.trim().length > 0 && (
                      <div className="mt-2 flex items-center gap-1.5 font-sans text-[11px] text-[#a16207] bg-[#fef9c3] border border-[#fde68a] rounded-full px-2.5 py-1 w-fit">
                        <div className="w-1.5 h-1.5 rounded-full bg-[#eab308]" />
                        {ann.note.trim().length} симв. в заметке
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Export bar */}
      <footer className="sticky bottom-0 z-20 mt-auto border-t border-[var(--border)] bg-[var(--card)]/90 backdrop-blur-xl">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-3 sm:py-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#fef9c3] border border-[#fde68a] flex items-center justify-center">
              <FileText className="w-4 h-4 text-[#a16207]" />
            </div>
            <div>
              <div className="font-sans text-[13px] font-medium leading-none">Экспорт</div>
              <div className="font-sans text-[11px] text-[var(--muted)] mt-1">Скачать оригинал + заметки в один файл</div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:flex gap-2">
            <button
              onClick={exportMarkdown}
              disabled={!originalText}
              className="h-10 px-4 rounded-full border border-[var(--border)] bg-white dark:bg-[#1c1917] font-sans text-[13px] font-medium flex items-center justify-center gap-2 hover:border-[var(--border-strong)] disabled:opacity-50 transition-colors"
            >
              <FileText className="w-4 h-4" />
              Markdown .md
            </button>
            <button
              onClick={exportHTML}
              disabled={!originalText}
              className="h-10 px-4 rounded-full border border-[var(--border)] bg-white dark:bg-[#1c1917] font-sans text-[13px] font-medium flex items-center justify-center gap-2 hover:border-[var(--border-strong)] disabled:opacity-50 transition-colors"
            >
              <Code2 className="w-4 h-4" />
              HTML .html
            </button>
            <button
              onClick={exportCombined}
              disabled={!originalText}
              className="h-10 px-4 rounded-full bg-[#111] text-white dark:bg-[#fafaf9] dark:text-[#111] font-sans text-[13px] font-medium flex items-center justify-center gap-2 hover:bg-black disabled:opacity-50 transition-colors"
            >
              <FileIcon className="w-4 h-4" />
              TXT комбинированный
            </button>
            <button
              onClick={exportJSON}
              disabled={!originalText}
              className="h-10 px-4 rounded-full border border-[var(--border)] bg-white dark:bg-[#1c1917] font-sans text-[13px] font-medium flex items-center justify-center gap-2 hover:border-[var(--border-strong)] disabled:opacity-50 transition-colors"
            >
              <Braces className="w-4 h-4" />
              JSON .json
            </button>
          </div>
        </div>
      </footer>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-[84px] left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div className="bg-[#111] text-white dark:bg-[#fafaf9] dark:text-[#111] font-sans text-[13px] px-4 py-2.5 rounded-full shadow-[0_8px_24px_rgba(0,0,0,0.18)] flex items-center gap-2 animate-[slideUp_0.2s_ease]">
            <div className="w-1.5 h-1.5 rounded-full bg-[#facc15] animate-pulse" />
            {toast}
          </div>
          <style>{`@keyframes slideUp{from{transform:translateY(8px); opacity:0} to{transform:translateY(0); opacity:1}}`}</style>
        </div>
      )}

      {/* Paste modal */}
      {showPaste && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[#0a0a0a]/40 backdrop-blur-sm" onClick={() => setShowPaste(false)} />
          <div className="relative w-full max-w-[640px] bg-[var(--card)] rounded-[20px] shadow-[0_16px_48px_rgba(0,0,0,0.18)] border border-[var(--border)] overflow-hidden">
            <div className="p-6 sm:p-7">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <h2 className="font-display text-[20px]">Вставить текст</h2>
                  <p className="font-sans text-[13px] text-[var(--muted)] mt-1">Вставьте содержимое вашего .txt файла. Текущие аннотации будут сброшены.</p>
                </div>
                <button
                  onClick={() => setShowPaste(false)}
                  className="w-8 h-8 rounded-full bg-[#f5f5f4] dark:bg-[#292524] border border-[var(--border)] flex items-center justify-center"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <textarea
                value={pasteValue}
                onChange={(e) => setPasteValue(e.target.value)}
                placeholder="Вставьте текст сюда…"
                className="w-full h-[320px] rounded-[14px] border border-[var(--border)] bg-[#fcfaf6] dark:bg-[#0f0e0d] p-4 font-sans text-[14px] leading-[1.6] outline-none focus:border-[#111] focus:ring-2 focus:ring-[#111]/10 resize-none"
                autoFocus
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setShowPaste(false)}
                  className="h-10 px-5 rounded-full bg-white dark:bg-[#1c1917] border border-[var(--border)] font-sans text-[13px] font-medium"
                >
                  Отмена
                </button>
                <button
                  onClick={handlePasteConfirm}
                  disabled={!pasteValue.trim()}
                  className="h-10 px-6 rounded-full bg-[#111] dark:bg-[#fafaf9] dark:text-[#111] text-white font-sans text-[13px] font-medium disabled:opacity-50"
                >
                  Вставить и начать
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
