/**
 * PageCardForm.tsx
 *
 * Creates a page card from pasted HTML or an imported .html file. Shows the sanitized
 * preview before saving; the card then joins the review schedule (SM-2 / FSRS).
 */

import { useState } from 'react';
import { Button, Input, Select, Textarea } from '@/ui/components';
import { PageCardView } from '@/ui/components/PageCardView';
import { buildPageCardData, readHtmlFile, type PageCardData } from '@/data/pageCards';
import type { Topic } from '@/domain/models';

interface Props {
  topics: Topic[];
  subjectId: string;
  onSave: (data: PageCardData) => Promise<void> | void;
  onCancel: () => void;
}

export function PageCardForm({ topics, subjectId, onSave, onCancel }: Props) {
  const [title, setTitle] = useState('');
  const [html, setHtml] = useState('');
  const [topicId, setTopicId] = useState(topics[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  let preview: string | null = null;
  let built: PageCardData | null = null;
  if (html.trim() && topicId) {
    try {
      built = buildPageCardData(subjectId, topicId, title, html);
      preview = built.pageHtml ?? null;
    } catch {
      built = null;
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await readHtmlFile(file);
      setHtml(r.html);
      if (!title.trim()) setTitle(r.title);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    setError(null);
    if (!topicId) { setError('Crea primero un tema en la asignatura.'); return; }
    try {
      const data = buildPageCardData(subjectId, topicId, title, html);
      setBusy(true);
      await onSave(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="page-card-form">
      <p className="text-xs text-ink-400">
        Una lección en HTML que entra en tu calendario de repaso y se repasa entera. Se limpia al guardar:
        sin scripts, estilos ni recursos remotos; las imágenes solo como <code>data:</code>.
      </p>
      <Select label="Tema" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
        {topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
      </Select>
      <Input label="Título" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Se toma del <title> o del primer <h1>" />
      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border border-ink-600 bg-ink-800 text-ink-200 hover:bg-ink-700 cursor-pointer">
          Importar .html
          <input type="file" accept=".html,.htm,text/html" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <span className="text-xs text-ink-500">o pega el HTML abajo</span>
      </div>
      <Textarea label="HTML" value={html} onChange={(e) => setHtml(e.target.value)} rows={8} className="font-mono text-xs" />
      {preview && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-ink-500 uppercase tracking-widest">Vista previa (limpia)</p>
          <PageCardView html={preview} />
        </div>
      )}
      {error && <p className="text-sm text-rose-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
        <Button onClick={() => void save()} loading={busy} disabled={!html.trim()}>Guardar página</Button>
      </div>
    </div>
  );
}
