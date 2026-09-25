import { useState } from 'react';
import { MdContent } from '@/ui/components/MdContent';
import { renderMd } from '@/utils/renderMd';
import { generateExplanation } from '@/services/aiEngine';
import { questionRepo } from '@/data/repos';
import type { Question } from '@/domain/models';

// ── Cloze renderer (para preview) ──────────────────────────────────────────
export function renderClozePreview(clozeText: string, blanks: { id: string; accepted: string[] }[]): string {
  const blanksMap = Object.fromEntries(blanks.map((b) => [b.id, b.accepted[0] ?? b.id]));
  const filled = clozeText.replace(/\{\{([^}]+)\}\}/g, (_match, id) => {
    const answer = blanksMap[id] ?? id;
    return `<span class="inline-block bg-sage-600/20 border border-sage-600/40 text-sage-300 rounded px-1.5 py-0.5 font-medium mx-0.5">${answer}</span>`;
  });
  return renderMd(filled);
}

// ── Preview: enunciado + respuesta resuelta ─────────────────────────────────
export function QuestionPreviewContent({
  question,
  onExplanationGenerated,
}: {
  question: Question;
  onExplanationGenerated?: (explanation: string) => void;
}) {
  const correctIds = new Set(question.correctOptionIds ?? []);
  const [generatingExpl, setGeneratingExpl] = useState(false);
  const [explError, setExplError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">

      {/* ── Enunciado ── */}
      <div className="flex flex-col gap-3">
        <p className="text-xs text-ink-500 uppercase tracking-widest">Enunciado</p>
        <MdContent
          content={question.prompt}
          className="text-ink-100 text-sm leading-relaxed prose prose-invert prose-sm max-w-none"
        />
        {question.imageDataUrls && question.imageDataUrls.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1">
            {question.imageDataUrls.map((url, i) => (
              <img
                key={i}
                src={url}
                alt={`imagen ${i + 1}`}
                className="max-h-48 rounded-lg border border-ink-700 object-contain"
              />
            ))}
          </div>
        )}
        {/* TEST: opciones neutras en el enunciado */}
        {question.type === 'TEST' && question.options && question.options.length > 0 && (
          <div className="flex flex-col gap-2 mt-1">
            {question.options.map((opt, i) => (
              <div
                key={opt.id}
                className="flex items-start gap-3 rounded-xl px-4 py-3 border border-ink-700 bg-ink-800/50 text-sm text-ink-200"
              >
                <span className="flex-shrink-0 w-5 h-5 rounded-full border border-ink-600 bg-ink-800 flex items-center justify-center text-xs text-ink-500 font-medium mt-0.5">
                  {String.fromCharCode(65 + i)}
                </span>
                <span
                  className="prose prose-invert prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: renderMd(opt.text) }}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Separador ── */}
      <div className="border-t border-ink-700" />

      {/* ── Respuesta ── */}
      <div className="flex flex-col gap-3">
        <p className="text-xs text-ink-500 uppercase tracking-widest">Respuesta</p>

        {/* TEST */}
        {question.type === 'TEST' && (
          <div className="flex flex-col gap-2">
            {(question.options ?? []).map((opt) => {
              const correct = correctIds.has(opt.id);
              return (
                <div
                  key={opt.id}
                  className={`flex items-start gap-2 rounded-xl px-4 py-3 border text-sm ${
                    correct
                      ? 'bg-sage-600/20 border-sage-500/50 text-sage-200'
                      : 'bg-ink-900 border-ink-700 text-ink-500 opacity-50'
                  }`}
                >
                  <span className={`mt-0.5 flex-shrink-0 text-sm font-bold ${correct ? 'text-sage-400' : 'text-rose-500'}`}>
                    {correct ? '✓' : '✗'}
                  </span>
                  <span
                    className={`prose prose-invert prose-sm max-w-none ${!correct ? 'line-through' : ''}`}
                    dangerouslySetInnerHTML={{ __html: renderMd(opt.text) }}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* COMPLETAR */}
        {question.type === 'COMPLETAR' && (
          <div className="flex flex-col gap-3">
            <div
              className="text-sm text-ink-200 leading-relaxed prose prose-invert prose-sm max-w-none bg-ink-800/50 border border-ink-700 rounded-xl p-4"
              dangerouslySetInnerHTML={{ __html: renderClozePreview(question.clozeText ?? '', question.blanks ?? []) }}
            />
            <div className="flex flex-col gap-1">
              {(question.blanks ?? []).map((b) => (
                <div key={b.id} className="flex items-center gap-2 text-xs">
                  <span className="text-ink-500 font-mono">{b.id}:</span>
                  <span className="text-sage-300">{b.accepted.join(' / ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* DESARROLLO / PRACTICO */}
        {(question.type === 'DESARROLLO' || question.type === 'PRACTICO') && (
          <div className="flex flex-col gap-3">
            {question.modelAnswer ? (
              <div
                className="text-sm text-ink-200 leading-relaxed prose prose-invert prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: renderMd(question.modelAnswer) }}
              />
            ) : (
              <p className="text-sm text-ink-500 italic">Sin respuesta modelo.</p>
            )}
            {question.numericAnswer && (
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl px-4 py-3">
                <p className="text-xs text-blue-400 uppercase tracking-widest mb-1">Resultado numérico</p>
                <p className="text-lg font-mono text-blue-300">{question.numericAnswer}</p>
              </div>
            )}
            {question.keywords && question.keywords.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {question.keywords.map((kw) => (
                  <span key={kw} className="text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded px-2 py-0.5">
                    {kw}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Explicación / Feedback ── */}
      {question.explanation ? (
        <>
          <div className="border-t border-ink-700" />
          <div className="flex flex-col gap-3">
            <p className="text-xs text-ink-500 uppercase tracking-widest">Explicación</p>
            <div
              className="text-sm text-ink-300 leading-relaxed prose prose-invert prose-sm max-w-none bg-amber-500/5 border border-amber-500/20 rounded-xl p-4"
              dangerouslySetInnerHTML={{ __html: renderMd(question.explanation) }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="border-t border-ink-700" />
          <div className="flex flex-col gap-3">
            <p className="text-xs text-ink-500 uppercase tracking-widest">Explicación</p>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={async () => {
                  setGeneratingExpl(true);
                  setExplError(null);
                  try {
                    const explanation = await generateExplanation(question);
                    await questionRepo.update(question.id, { explanation });
                    onExplanationGenerated?.(explanation);
                  } catch (e) {
                    setExplError(String(e));
                  } finally {
                    setGeneratingExpl(false);
                  }
                }}
                disabled={generatingExpl}
                className="text-xs bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/20 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {generatingExpl ? (
                  <>⏳ Generando...</>
                ) : (
                  <>✨ Generar explicación con IA</>
                )}
              </button>
              {explError && <p className="text-xs text-rose-400">{explError}</p>}
            </div>
          </div>
        </>
      )}

    </div>
  );
}
