import { useEffect, useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '@/ui/store';
import { Button, Card, Modal, Input, Countdown, Progress, EmptyState } from '@/ui/components';
import { removeDuplicateQuestions, commitAndCleanContributions } from '@/data/exportImport';
import { loadSubjectExtraInfo } from '@/data/resourceLoader';
import type { Subject, SubjectExtraInfo, ExternalLink } from '@/domain/models';
import { db, getSettings } from '@/data/db';
import { migrateOrphanSubjects, assignMissingSubjectColors, repairOrphanRecords } from '@/data/packageManager';
import { CalendarWidget } from '@/ui/components/CalendarWidget';
import { ActiveSessionsSidebar } from '@/ui/components/ActiveSessionsSidebar';
import { deliverableRepo } from '@/data/deliverableRepo';
import type { Deliverable } from '@/domain/models';
import { useTheme } from '@/ui/context/ThemeContext';
import { useHoardMode } from '@/data/hoardMode';

// Chip de sincronización con Hypatia's Hoard: solo se descarga en modo hoard.
const HoardChip = import.meta.env.VITE_HOARD === '1' ? lazy(() => import('@/ui/components/HoardChip')) : null;

const SUBJECT_COLORS = [
  '#f59e0b', '#ef4444', '#3b82f6', '#10b981', '#8b5cf6', '#f97316', '#06b6d4', '#ec4899',
];

export function Dashboard() {
  const navigate = useNavigate();
  const hoard = useHoardMode();
  const { theme, toggleTheme } = useTheme();
  const {
    subjects, loadSubjects, createSubject, deleteSubject, updateSubject,
    settings, loadSettings,
    syncGlobalBank, syncing, lastSyncResult,
  } = useStore();

  const [showCreate, setShowCreate] = useState(false);
  const [subjectName, setSubjectName] = useState('');
  const [subjectColor, setSubjectColor] = useState(SUBJECT_COLORS[0]);

  const [stats, setStats] = useState<Record<string, { total: number; correct: number; seen: number }>>({});
  const [dueToday, setDueToday] = useState<Record<string, number>>({});
  const [incompleteSessions, setIncompleteSessions] = useState<Record<string, string>>({}); // subjectId → sessionId
  const [extraInfo, setExtraInfo] = useState<Record<string, SubjectExtraInfo | null>>({});
  const [pendingCorrectionCount, setPendingCorrectionCount] = useState<Record<string, number>>({});

  // Global search state
  const [globalSearch, setGlobalSearch] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<Array<{
    questionId: string;
    subjectId: string;
    subjectName: string;
    topicName: string;
    prompt: string;
    type: string;
  }>>([]);
  const [globalSearching, setGlobalSearching] = useState(false);

  const [externalLinks, setExternalLinks] = useState<ExternalLink[]>([]);

  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [showDonateMenu, setShowDonateMenu] = useState(false);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [dedupMsg, setDedupMsg] = useState('');
  const [deduping, setDeduping] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [pwaPromptEvent, setPwaPromptEvent] = useState<Event | null>(null);
  const [pwaIosHint, setPwaIosHint] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [upcomingDeliverables, setUpcomingDeliverables] = useState<Deliverable[]>([]);
  // nextExamDates: subjectId → next upcoming exam dueDate (from exam deliverables)
  const [nextExamDates, setNextExamDates] = useState<Record<string, string>>({});
  const [streak, setStreak] = useState(0);

  // ── Inicialización ─────────────────────────────────────────────────────────

  const loadDeliverables = () => {
    deliverableRepo.getAll().then(all => {
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const upcoming = all
        .filter(d => d.dueDate && d.dueDate >= today && !d.status.includes('done'))
        .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
        .slice(0, 10);
      setUpcomingDeliverables(upcoming);

      const examMap: Record<string, string> = {};
      const upcomingExams = all
        .filter(d => d.type === 'exam' && d.dueDate && d.dueDate >= today)
        .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
      for (const ex of upcomingExams) {
        if (!examMap[ex.subjectId]) {
          examMap[ex.subjectId] = ex.dueDate!;
        }
      }
      setNextExamDates(examMap);
    });
  };

  useEffect(() => {
    loadSettings();
    getSettings().then(s => setStreak(s.studyStreak ?? 0));

    // Primero reparar huérfanos, luego cargar todo con datos correctos
    Promise.all([
      repairOrphanRecords(),
      assignMissingSubjectColors(),
      migrateOrphanSubjects(),
    ]).then(() => {
      loadSubjects();
      loadDeliverables();
    }).catch(() => {
      // Fallback: cargar igualmente aunque falle la reparación
      loadSubjects();
      loadDeliverables();
    });
  }, []);

  // ── Stats por asignatura ───────────────────────────────────────────────────
  useEffect(() => {
    async function loadStats() {
      const result: Record<string, { total: number; correct: number; seen: number }> = {};
      const pendingCounts: Record<string, number> = {};
      const dueTodayMap: Record<string, number> = {};
      const incompleteSessionsMap: Record<string, string> = {};
      const today = new Date().toISOString().split('T')[0];

      for (const s of subjects) {
        const qs = await db.questions.where('subjectId').equals(s.id).toArray();
        result[s.id] = {
          total: qs.length,
          correct: qs.reduce((acc, q) => acc + q.stats.correct, 0),
          seen: qs.reduce((acc, q) => acc + q.stats.seen, 0),
        };
        // SM-2 preguntas pendientes hoy (para badge "Repaso de hoy")
        dueTodayMap[s.id] = qs.filter(q => !q.stats.nextReviewAt || q.stats.nextReviewAt <= today).length;

        // Count pending corrections (finished sessions with unanswered DESARROLLO/PRACTICO)
        const sessions = await db.sessions
          .where('subjectId')
          .equals(s.id)
          .filter(sess => sess.finishedAt != null && sess.answers.some(a => a.result === null))
          .toArray();
        pendingCounts[s.id] = sessions.reduce((acc, sess) => acc + sess.answers.filter(a => a.result === null).length, 0);

        // Sesión incompleta más reciente (A3) — excluir mixtas (se muestran en sidebar)
        const incompleteSess = await db.sessions
          .where('subjectId')
          .equals(s.id)
          .filter(sess =>
            sess.finishedAt == null &&
            sess.answers.length > 0 &&
            !(sess.subjectIds && sess.subjectIds.length > 1) // no mixtas
          )
          .toArray();
        if (incompleteSess.length > 0) {
          // Tomar la más reciente
          incompleteSess.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          incompleteSessionsMap[s.id] = incompleteSess[0].id;
        }
      }
      setStats(result);
      setPendingCorrectionCount(pendingCounts);
      setDueToday(dueTodayMap);
      setIncompleteSessions(incompleteSessionsMap);
    }
    if (subjects.length) loadStats();
  }, [subjects]);

  // ── ITER2: extra_info.json ─────────────────────────────────────────────────
  useEffect(() => {
    if (!subjects.length) return;
    async function loadExtra() {
      const result: Record<string, SubjectExtraInfo | null> = {};
      await Promise.all(subjects.map(async (s) => {
        result[s.id] = await loadSubjectExtraInfo(s.name);
      }));
      setExtraInfo(result);
    }
    loadExtra();
  }, [subjects]);

  // ── ITER3: enlaces externos ────────────────────────────────────────────────
  useEffect(() => {
    if (!subjects.length) return;
    const allLinks: ExternalLink[] = [];
    for (const sid of Object.keys(extraInfo)) {
      const info = extraInfo[sid];
      if (info?.externalLinks) {
        for (const link of info.externalLinks) {
          if (!allLinks.some((l) => l.url === link.url)) {
            allLinks.push(link);
          }
        }
      }
    }
    setExternalLinks(allLinks);
  }, [extraInfo]);

  // ── Global search ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!globalSearch.trim()) {
      setGlobalSearchResults([]);
      return;
    }
    setGlobalSearching(true);
    const timer = setTimeout(async () => {
      try {
        const terms = globalSearch.toLowerCase().trim().split(/\s+/);
        const allQuestions = await db.questions.toArray();
        const allTopics = await db.topics.toArray();
        const topicMap = new Map(allTopics.map((t) => [t.id, t.title]));
        const results = allQuestions
          .filter((q) => {
            const hay = [q.prompt, q.explanation ?? '', q.modelAnswer ?? '', ...(q.tags ?? [])].join(' ').toLowerCase();
            return terms.every((t) => hay.includes(t));
          })
          .slice(0, 30)
          .map((q) => {
            const subject = subjects.find((s) => s.id === q.subjectId);
            return {
              questionId: q.id,
              subjectId: q.subjectId,
              subjectName: subject?.name ?? '?',
              topicName: topicMap.get(q.topicId) ?? '',
              prompt: q.prompt,
              type: q.type,
            };
          });
        setGlobalSearchResults(results);
      } finally {
        setGlobalSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [globalSearch, subjects]);

  // ── PWA install prompt ─────────────────────────────────────────────────────
  useEffect(() => {
    const handlePrompt = (e: Event) => {
      e.preventDefault();
      setPwaPromptEvent(e);
    };
    window.addEventListener('beforeinstallprompt', handlePrompt);
    return () => window.removeEventListener('beforeinstallprompt', handlePrompt);
  }, []);


  // ── Crear asignatura ───────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!subjectName.trim()) return;
    const s = await createSubject({
      name: subjectName.trim(),
      color: subjectColor,
    });
    setSubjectName('');
    setSubjectColor(SUBJECT_COLORS[0]);
    setShowCreate(false);
    navigate(`/subject/${s.id}`);
  };


  const handleCommitAndClean = async () => {
    if (!confirm(
      '¿Integrar contributions en el banco global?\n\n' +
      'Se actualizará src/data/global-bank.json con todo el contenido actual. ' +
      'Las preguntas de contribution packs quedarán marcadas como preguntas del banco global ' +
      '(se limpia su origen pero NO se eliminan de IndexedDB).\n\n' +
      'Tus propias preguntas y estadísticas NO se tocan.'
    )) return;

    setCommitting(true);
    setCommitMsg('');
    try {
      const result = await commitAndCleanContributions();
      if (result.wroteToFile) {
        setCommitMsg(`✓ global-bank.json actualizado (${result.questionsInBank} preguntas, ${result.conceptsInBank} conceptos clave) · ${result.committedFromPacks} preguntas y ${result.committedConceptsFromPacks} conceptos integrados · historial reseteado`);
      } else {
        setCommitMsg(`⚠ No se pudo escribir en disco (solo funciona en dev). ${result.committedFromPacks} preguntas y ${result.committedConceptsFromPacks} conceptos de packs marcados como globales.`);
      }
      await loadSubjects();
    } catch (err) {
      setCommitMsg('Error: ' + String(err));
    } finally {
      setCommitting(false);
      setTimeout(() => setCommitMsg(''), 7000);
    }
  };

  const handleRemoveDuplicates = async () => {
    if (!confirm(
      '¿Eliminar preguntas duplicadas?\n\n' +
      'Se compararán las preguntas por su contentHash. Si hay duplicados, ' +
      'se conservará la que tenga más historial de uso y se borrarán las demás.\n\n' +
      'Esta operación NO se puede deshacer.'
    )) return;

    setDeduping(true);
    setDedupMsg('');
    try {
      const result = await removeDuplicateQuestions();
      if (result.removed === 0) {
        setDedupMsg(`✓ Sin duplicados: ${result.checked} preguntas revisadas, ninguna eliminada.`);
      } else {
        setDedupMsg(`✓ Limpieza completada: ${result.removed} duplicadas eliminadas de ${result.checked} revisadas.`);
        await loadSubjects();
      }
    } catch (err) {
      setDedupMsg('Error: ' + String(err));
    } finally {
      setDeduping(false);
      setTimeout(() => setDedupMsg(''), 7000);
    }
  };



  const handlePwaInstall = async () => {
    setMobileMenuOpen(false);
    if (pwaPromptEvent) {
      await (pwaPromptEvent as any).prompt();
      const choice = await (pwaPromptEvent as any).userChoice;
      if (choice.outcome === 'accepted') setPwaPromptEvent(null);
    } else {
      // iOS/Safari: no beforeinstallprompt — mostrar hint manual
      setPwaIosHint(true);
      setTimeout(() => setPwaIosHint(false), 8000);
    }
  };

  // ── Toggle apuntes en examen ───────────────────────────────────────────────
  const handleToggleAllowsNotes = async (e: React.MouseEvent, s: Subject) => {
    e.stopPropagation();
    // Cicla: undefined → true → false → undefined
    let next: boolean | undefined;
    if (s.allowsNotes === undefined) next = true;
    else if (s.allowsNotes === true) next = false;
    else next = undefined;
    await updateSubject(s.id, { allowsNotes: next });
  };

  const pctCorrect = (s: Subject) => {
    const st = stats[s.id];
    if (!st || st.seen === 0) return 0;
    return Math.round((st.correct / st.seen) * 100);
  };


  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-ink-950 text-ink-100 flex flex-col overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-ink-800 bg-ink-900/50 backdrop-blur-sm flex-shrink-0 z-10">
        <div className="px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center">
              <span className="text-ink-900 font-display font-bold text-sm">S</span>
            </div>
            <span className="font-display text-xl text-ink-100">Hypatia</span>
          </div>

          {/* Nav: accesos rápidos + info + hamburger (todos los tamaños) */}
          <div className="flex items-center gap-1">
            {hoard && HoardChip && (
              <Suspense fallback={null}>
                <HoardChip />
              </Suspense>
            )}
            <Button variant="ghost" size="sm" onClick={() => navigate('/sessions')} title="Historial de sesiones">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z"/>
                <path fillRule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd"/>
              </svg>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate('/stats')} title="Estadísticas">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zm6-4a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zm6-3a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/>
              </svg>
            </Button>
            {/* Botón de donación con menú desplegable */}
            <div className="relative">
              <button
                onClick={() => setShowDonateMenu(v => !v)}
                title="Apoya el proyecto con una donación"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium font-body bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 hover:text-amber-300 border border-amber-500/30 hover:border-amber-400/50 transition-all duration-150"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                </svg>
                <span className="hidden sm:inline">Donar</span>
              </button>

              {showDonateMenu && (
                <>
                  {/* Overlay para cerrar al hacer clic fuera */}
                  <div className="fixed inset-0 z-40" onClick={() => setShowDonateMenu(false)} />
                  <div className="absolute right-0 top-full mt-2 z-50 bg-ink-800 border border-ink-600 rounded-xl shadow-xl overflow-hidden min-w-[180px]">
                    <p className="text-[10px] font-medium text-ink-500 uppercase tracking-widest px-3 pt-2.5 pb-1">Apoya el proyecto</p>
                    <a
                      href="https://www.paypal.com/donate/?business=luismasc16%40gmail.com&currency_code=EUR"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setShowDonateMenu(false)}
                      className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-ink-200 hover:bg-ink-700 hover:text-white transition-colors font-body"
                    >
                      {/* PayPal icon */}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-blue-400">
                        <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106zm14.146-14.42a3.35 3.35 0 0 0-.607-.541c-.013.076-.026.175-.041.26-.93 4.778-4.005 7.201-9.138 7.201h-2.19a.563.563 0 0 0-.556.479l-1.187 7.527h-.506l-.24 1.516a.56.56 0 0 0 .554.647h3.882c.46 0 .85-.334.922-.788.06-.26.76-4.852.816-5.09a.932.932 0 0 1 .923-.788h.58c3.76 0 6.705-1.528 7.565-5.946.36-1.847.174-3.388-.777-4.477z"/>
                      </svg>
                      PayPal
                    </a>
                    <a
                      href="https://buymeacoffee.com/luissalet"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setShowDonateMenu(false)}
                      className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-ink-200 hover:bg-ink-700 hover:text-white transition-colors font-body border-t border-ink-700"
                    >
                      {/* Coffee icon */}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-yellow-400">
                        <path d="M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM4 19h16v2H4z"/>
                      </svg>
                      Buy Me a Coffee
                    </a>
                  </div>
                </>
              )}
            </div>

            <Button variant="ghost" size="sm" onClick={() => navigate('/marketplace')} title="Marketplace">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 2a4 4 0 00-4 4v1H5a1 1 0 00-.994.89l-1 9A1 1 0 004 18h12a1 1 0 00.994-1.11l-1-9A1 1 0 0015 7h-1V6a4 4 0 00-4-4zm2 5V6a2 2 0 10-4 0v1h4zm-6 3a1 1 0 112 0 1 1 0 01-2 0zm7-1a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd"/>
              </svg>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate('/settings')} title="Ajustes">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd"/>
              </svg>
            </Button>

            {/* Botón tema */}
            <button
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
              className="p-2 text-ink-400 hover:text-ink-200 hover:bg-ink-800 rounded-lg transition-colors"
            >
              {theme === 'dark' ? (
                <svg width="17" height="17" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd"/>
                </svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/>
                </svg>
              )}
            </button>

            {/* Botón info */}
            <button
              onClick={() => setInfoOpen(true)}
              className="p-2 text-ink-400 hover:text-ink-200 hover:bg-ink-800 rounded-lg transition-colors"
              title="Ayuda e información"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
            </button>

            {/* Hamburger — acciones avanzadas */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 text-ink-400 hover:text-ink-200 hover:bg-ink-800 rounded-lg transition-colors ml-1"
              title="Menú"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                {mobileMenuOpen
                  ? <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  : <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
                }
              </svg>
            </button>
          </div>
        </div>

        {/* Dropdown menú — todos los tamaños */}
        {mobileMenuOpen && (
          <div className="border-t border-ink-800 bg-ink-900/95 backdrop-blur-sm px-4 py-3 flex flex-col gap-2 animate-slide-up">

            {/* Instalar app — siempre visible */}
            <button
              onClick={handlePwaInstall}
              className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg font-medium font-body transition-all justify-start w-full text-amber-300 hover:text-amber-200 hover:bg-ink-800 border border-amber-500/30"
            >
              <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor" className="flex-shrink-0">
                <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd"/>
              </svg>
              Instalar app
            </button>

            <div className="border-t border-ink-800/60 my-0.5" />

            {/* Actualizar app — siempre visible */}
            <button
              onClick={() => { window.location.reload(); }}
              className="flex items-center gap-2 text-sm px-3 py-2 rounded-lg font-medium font-body transition-all justify-start w-full text-emerald-300 hover:text-emerald-200 hover:bg-ink-800 border border-emerald-500/30"
            >
              <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor" className="flex-shrink-0">
                <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd"/>
              </svg>
              Actualizar app
            </button>

            <div className="border-t border-ink-800/60 my-0.5" />

            <Button
              variant="ghost"
              size="sm"
              onClick={() => { navigate('/marketplace'); setMobileMenuOpen(false); }}
              className="justify-start w-full"
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" className="flex-shrink-0">
                <path fillRule="evenodd" d="M10 2a4 4 0 00-4 4v1H5a1 1 0 00-.994.89l-1 9A1 1 0 004 18h12a1 1 0 00.994-1.11l-1-9A1 1 0 0015 7h-1V6a4 4 0 00-4-4zm2 5V6a2 2 0 10-4 0v1h4zm-6 3a1 1 0 112 0 1 1 0 01-2 0zm7-1a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd"/>
              </svg>
              Marketplace
            </Button>
            {/* Maintainer flow: writes src/data/global-bank.json through the Vite dev server. Hypatia's Hoard
                ships no course content in the repo (the bank lives on the local server), so it is hidden. */}
            {!hoard && <Button
              variant="ghost"
              size="sm"
              onClick={() => { handleCommitAndClean(); setMobileMenuOpen(false); }}
              disabled={committing}
              className="justify-start w-full"
            >
              {committing ? (
                <svg className="animate-spin h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" className="flex-shrink-0">
                  <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd"/>
                </svg>
              )}
              Integrar & limpiar
            </Button>}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { handleRemoveDuplicates(); setMobileMenuOpen(false); }}
              disabled={deduping}
              className="justify-start w-full"
            >
              {deduping ? (
                <svg className="animate-spin h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" className="flex-shrink-0">
                  <path fillRule="evenodd" d="M3 3a1 1 0 000 2v8a2 2 0 002 2h2.586l-1.293 1.293a1 1 0 101.414 1.414L10 15.414l2.293 2.293a1 1 0 001.414-1.414L12.414 15H15a2 2 0 002-2V5a1 1 0 100-2H3zm11 4a1 1 0 10-2 0v4a1 1 0 102 0V7zm-3 1a1 1 0 10-2 0v3a1 1 0 102 0V8zM8 9a1 1 0 00-2 0v2a1 1 0 102 0V9z" clipRule="evenodd"/>
                </svg>
              )}
              Eliminar duplicadas
            </Button>
          </div>
        )}
      </header>


      {/* iOS PWA hint */}
      {pwaIosHint && (
        <div className="bg-blue-500/10 border-b border-blue-500/20 px-4 sm:px-6 py-2.5 flex items-center justify-between flex-shrink-0">
          <span className="text-xs text-blue-300">
            📱 <strong>iOS:</strong> pulsa el botón Compartir <span className="font-mono">⬆</span> en Safari → "Añadir a pantalla de inicio"
          </span>
          <button onClick={() => setPwaIosHint(false)} className="text-xs text-ink-600 hover:text-ink-400 transition-colors ml-3 flex-shrink-0">✕</button>
        </div>
      )}


      {/* ── Body: left sidebar + main + right sidebar ────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left sidebar: Sesiones activas ──────────────────────────────── */}
        <ActiveSessionsSidebar refreshKey={sidebarRefresh} />

        {/* ── Main (scrollable) ──────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-4 py-6 sm:px-6 sm:py-10">

            {/* Título */}
            <div className="mb-6 sm:mb-8 flex items-end justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl sm:text-3xl text-ink-100 mb-1">Mis asignaturas</h1>
                <p className="text-ink-500 text-sm">
                  {subjects.length === 0
                    ? 'Instala asignaturas desde el marketplace'
                    : `${subjects.length} asignatura${subjects.length !== 1 ? 's' : ''} · ${Object.values(stats).reduce((k, b) => k + b.total, 0)} preguntas`}
                </p>
              </div>
              {subjects.length >= 2 && (
                <button
                  onClick={() => navigate('/global-practice')}
                  className="shrink-0 flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/30 text-amber-300 hover:text-amber-200 hover:border-amber-400/40 rounded-xl text-sm font-medium transition-all"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                    <polyline points="16 3 21 3 21 8"/>
                    <line x1="4" y1="20" x2="21" y2="3"/>
                    <polyline points="21 16 21 21 16 21"/>
                    <line x1="15" y1="15" x2="21" y2="21"/>
                  </svg>
                  Práctica mixta
                </button>
              )}
            </div>

            {/* Study streak */}
            {streak > 0 && (
              <div className="mb-6 flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
                <svg width="22" height="22" viewBox="0 0 20 20" fill="currentColor" className="text-amber-400 flex-shrink-0">
                  <path fillRule="evenodd" d="M12.395 2.553a1 1 0 00-1.45-.385c-.345.23-.614.558-.822.88-.214.33-.403.713-.57 1.116-.334.804-.614 1.768-.84 2.734a31.365 31.365 0 00-.613 3.58 2.64 2.64 0 01-.945-1.067c-.328-.68-.398-1.534-.398-2.654A1 1 0 005.05 6.05 6.981 6.981 0 003 11a7 7 0 1011.95-4.95c-.592-.591-.98-.985-1.348-1.467-.363-.476-.724-1.063-1.207-2.03zM12.12 15.12A3 3 0 017 13s.879.5 2.5.5c0-1 .5-4 1.25-4.5.5 1 .786 1.293 1.371 1.879A2.99 2.99 0 0113 13a2.99 2.99 0 01-.879 2.121z" clipRule="evenodd"/>
                </svg>
                <div>
                  <p className="font-bold text-amber-400 text-sm">{streak} día{streak !== 1 ? 's' : ''} de racha</p>
                  <p className="text-xs text-ink-500">Sigue practicando para mantener la racha</p>
                </div>
              </div>
            )}

            {/* Global search */}
            <div className="relative mb-6">
              <input
                type="search"
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
                placeholder="Buscar en todas las asignaturas…"
                className="w-full bg-ink-900 border border-ink-700 rounded-xl px-4 py-2.5 pl-9 text-sm text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-amber-500/60 transition-colors"
              />
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-600">
                <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd"/>
                </svg>
              </span>
              {globalSearch && (
                <button
                  onClick={() => { setGlobalSearch(''); setGlobalSearchResults([]); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-600 hover:text-ink-400 transition-colors text-xs"
                >
                  ✕
                </button>
              )}
              {/* Search results dropdown */}
              {globalSearch.trim() && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-ink-800 border border-ink-700 rounded-xl shadow-2xl z-50 max-h-72 overflow-y-auto">
                  {globalSearching ? (
                    <p className="text-ink-500 text-sm p-4 text-center animate-pulse">Buscando…</p>
                  ) : globalSearchResults.length === 0 ? (
                    <p className="text-ink-500 text-sm p-4 text-center">Sin resultados para "{globalSearch}"</p>
                  ) : (
                    <>
                      <p className="text-xs text-ink-600 px-4 pt-3 pb-1">{globalSearchResults.length} resultado{globalSearchResults.length !== 1 ? 's' : ''}</p>
                      {globalSearchResults.map((r) => (
                        <button
                          key={r.questionId}
                          onClick={() => { navigate(`/subject/${r.subjectId}?tab=questions`); setGlobalSearch(''); }}
                          className="w-full text-left px-4 py-3 hover:bg-ink-700 transition-colors border-b border-ink-700/50 last:border-0"
                        >
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] bg-ink-700 text-ink-400 px-1.5 py-0.5 rounded font-mono">{r.type}</span>
                            <span className="text-xs text-amber-400/80 font-medium truncate">{r.subjectName}</span>
                            {r.topicName && <span className="text-xs text-ink-600 truncate">· {r.topicName}</span>}
                          </div>
                          <p className="text-sm text-ink-200 line-clamp-2 leading-snug">{r.prompt}</p>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Mensajes de estado */}
            {commitMsg && (
              <div className={`mb-4 px-4 py-3 rounded-lg text-sm font-body border ${
                commitMsg.startsWith('Error')
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                  : commitMsg.startsWith('⚠')
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  : 'bg-sage-600/10 border-sage-600/30 text-sage-400'
              }`}>
                {commitMsg}
              </div>
            )}
            {dedupMsg && (
              <div className={`mb-4 px-4 py-3 rounded-lg text-sm font-body border ${
                dedupMsg.startsWith('Error')
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                  : 'bg-sage-600/10 border-sage-600/30 text-sage-400'
              }`}>
                {dedupMsg}
              </div>
            )}

            {/* Grid de asignaturas */}
            {subjects.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
                <svg width="56" height="56" viewBox="0 0 20 20" fill="currentColor" className="text-ink-700">
                  <path fillRule="evenodd" d="M10 2a4 4 0 00-4 4v1H5a1 1 0 00-.994.89l-1 9A1 1 0 004 18h12a1 1 0 00.994-1.11l-1-9A1 1 0 0015 7h-1V6a4 4 0 00-4-4zm2 5V6a2 2 0 10-4 0v1h4zm-6 3a1 1 0 112 0 1 1 0 01-2 0zm7-1a1 1 0 100 2 1 1 0 000-2z" clipRule="evenodd"/>
                </svg>
                <div>
                  <p className="font-display text-lg text-ink-300 mb-1">Sin asignaturas</p>
                  <p className="text-sm text-ink-500 max-w-xs">Instala paquetes de asignaturas desde el marketplace o crea una manualmente.</p>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => navigate('/marketplace')}
                    className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-ink-900 text-sm font-semibold transition-colors"
                  >
                    Ir al Marketplace
                  </button>
                  <Button variant="ghost" onClick={() => setShowCreate(true)}>+ Crear manual</Button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {subjects.map((s) => {
                  const st = stats[s.id] ?? { total: 0, correct: 0, seen: 0 };
                  const pct = pctCorrect(s);
                  const extra = extraInfo[s.id];
                  return (
                    <Card
                      key={s.id}
                      hover
                      onClick={() => navigate(`/subject/${s.id}`)}
                      className="group relative overflow-hidden"
                    >
                      <div
                        className="absolute top-0 left-0 right-0 h-1 rounded-t-xl"
                        style={{ backgroundColor: s.color ?? '#f59e0b' }}
                      />
                      <div className="pt-1">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex flex-col gap-1 min-w-0 flex-1">
                            <h2 className="font-display text-lg text-ink-100 leading-tight break-words line-clamp-3 group-hover:text-amber-300 transition-colors">
                              {s.name}
                            </h2>
                            {pendingCorrectionCount[s.id] > 0 && (
                              <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded w-fit">
                                {pendingCorrectionCount[s.id]} sin corregir
                              </span>
                            )}
                            {/* A1: Badge "Repaso de hoy" */}
                            {(dueToday[s.id] ?? 0) > 0 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/subject/${s.id}?tab=practice&autostart=smart`);
                                }}
                                className="text-xs bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30 px-2 py-0.5 rounded w-fit transition-colors font-medium"
                                title="Lanzar repaso inteligente del día"
                              >
                                🧠 {dueToday[s.id]} por repasar hoy
                              </button>
                            )}
                            {/* A3: Badge "Sesión en curso" */}
                            {incompleteSessions[s.id] && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/practice/${incompleteSessions[s.id]}`);
                                }}
                                className="text-xs bg-orange-500/20 text-orange-300 hover:bg-orange-500/30 border border-orange-500/30 px-2 py-0.5 rounded w-fit transition-colors font-medium"
                                title="Reanudar sesión en curso"
                              >
                                ▶ Sesión en curso
                              </button>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {/* ── Indicador de apuntes — siempre clickable ──── */}
                            {(() => {
                              const effective = s.allowsNotes !== undefined ? s.allowsNotes : extra?.allowsNotes;
                              return (
                                <button
                                  onClick={(e) => handleToggleAllowsNotes(e, s)}
                                  title={
                                    effective === true  ? 'Permite apuntes · pulsa para cambiar'
                                    : effective === false ? 'Sin apuntes · pulsa para cambiar'
                                    : 'Configura si permite apuntes (pulsa para activar)'
                                  }
                                  className={`flex items-center justify-center w-6 h-6 rounded transition-all ${
                                    effective === true
                                      ? 'bg-sage-600/20 text-sage-400 hover:bg-sage-600/30'
                                      : effective === false
                                      ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30'
                                      : 'text-ink-700 hover:text-ink-500 hover:bg-ink-700/60 opacity-0 group-hover:opacity-100'
                                  }`}
                                >
                                  {effective === true ? (
                                    <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
                                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/>
                                    </svg>
                                  ) : effective === false ? (
                                    <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
                                      <path fillRule="evenodd" d="M13.477 14.89A6 6 0 015.11 6.524l8.367 8.368zm1.414-1.414L6.524 5.11a6 6 0 018.367 8.367zM18 10a8 8 0 11-16 0 8 8 0 0116 0z" clipRule="evenodd"/>
                                    </svg>
                                  ) : (
                                    <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
                                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
                                    </svg>
                                  )}
                                </button>
                              );
                            })()}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`¿Eliminar "${s.name}" y todas sus preguntas?`)) {
                                  deleteSubject(s.id);
                                }
                              }}
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-ink-600 hover:text-rose-400 p-1 -mr-1 -mt-1"
                            >
                              ✕
                            </button>
                          </div>
                        </div>

                        {/* ── ITER2: profesor si existe ──────────────────────── */}
                        {extra?.professor && (
                          <p className="text-xs text-ink-500 -mt-1 mb-1">Prof. {extra.professor}</p>
                        )}

                        {/* Próximo examen — leído de deliverables tipo 'exam' */}
                        <div className="mb-2">
                          {nextExamDates[s.id] ? (
                            <div>
                              <Countdown examDate={nextExamDates[s.id]} />
                              <span className="text-[10px] text-ink-600 block -mt-0.5 flex items-center gap-1">
                                <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor" className="inline-block opacity-70"><path d="M10.394 2.08a1 1 0 00-.788 0l-7 3a1 1 0 000 1.84L5.25 8.051a.999.999 0 01.356-.257l4-1.714a1 1 0 11.788 1.838L7.667 9.088l1.94.831a1 1 0 00.787 0l7-3a1 1 0 000-1.838l-7-3zM3.31 9.397L5 10.12v4.102a8.969 8.969 0 00-1.05-.174 1 1 0 01-.89-.89 11.115 11.115 0 01.25-3.762zM9.3 16.573A9.026 9.026 0 007 14.935v-3.957l1.818.78a3 3 0 002.364 0l5.508-2.361a11.026 11.026 0 01.25 3.762 1 1 0 01-.89.89 8.968 8.968 0 00-5.35 2.524 1 1 0 01-1.4 0zM6 18a1 1 0 001-1v-2.065a8.935 8.935 0 00-2-.712V17a1 1 0 001 1z"/></svg>
                                próximo examen
                              </span>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); navigate('/deliverables'); }}
                              className="text-xs text-ink-600 hover:text-amber-400 transition-colors"
                            >
                              + Añadir examen →
                            </button>
                          )}
                        </div>

                        <div className="mt-3 flex items-center gap-2 text-xs text-ink-500">
                          <span>{st.total} preguntas</span>
                          {st.seen > 0 && (
                            <>
                              <span>·</span>
                              <span className={pct >= 70 ? 'text-sage-400' : pct >= 40 ? 'text-amber-400' : 'text-rose-400'}>
                                {pct}% acierto
                              </span>
                            </>
                          )}
                        </div>

                        {st.seen > 0 && (
                          <Progress
                            value={st.correct}
                            max={st.seen}
                            color={pct >= 70 ? 'sage' : pct >= 40 ? 'amber' : 'rose'}
                          />
                        )}
                      </div>
                    </Card>
                  );
                })}

                {/* Tarjeta nueva asignatura */}
                <button
                  onClick={() => setShowCreate(true)}
                  className="border-2 border-dashed border-ink-700 hover:border-amber-500/50 rounded-xl p-5 flex flex-col items-center justify-center gap-3 text-ink-500 hover:text-amber-400 transition-all duration-200 min-h-[140px] group cursor-pointer"
                >
                  <span className="text-3xl group-hover:scale-110 transition-transform">+</span>
                  <span className="text-sm font-medium font-body">Nueva asignatura</span>
                </button>
              </div>
            )}

            {/* PDF Tools card */}
            <div className="mt-8">
              <button
                onClick={() => navigate('/pdf-tools')}
                className="w-full flex items-center gap-4 bg-ink-800 border border-ink-700 rounded-xl p-5 hover:border-amber-500/30 hover:bg-ink-800/80 transition-all group text-left"
              >
                <div className="w-10 h-10 rounded-xl bg-ink-700 flex items-center justify-center flex-shrink-0 group-hover:bg-amber-500/20 transition-colors">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" className="text-ink-400 group-hover:text-amber-400 transition-colors">
                    <path fillRule="evenodd" d="M6.672 1.911a1 1 0 10-1.932.518l.259.966a1 1 0 001.932-.518l-.26-.966zM2.429 4.74a1 1 0 10-.517 1.932l.966.259a1 1 0 00.517-1.932l-.966-.26zm8.814-.569a1 1 0 00-1.415-1.414l-.707.707a1 1 0 101.415 1.415l.707-.708zm-7.071 7.072l.707-.707A1 1 0 003.465 9.12l-.708.707a1 1 0 001.415 1.415zm3.2-5.171a1 1 0 00-1.3 1.3l4 10a1 1 0 001.823.075l1.38-2.759 3.018 3.02a1 1 0 001.414-1.415l-3.019-3.02 2.76-1.379a1 1 0 00-.076-1.822l-10-4z" clipRule="evenodd"/>
                  </svg>
                </div>
                <div>
                  <h3 className="font-display text-lg text-ink-100 group-hover:text-amber-300 transition-colors">
                    Herramientas PDF
                  </h3>
                  <p className="text-sm text-ink-400 font-body">
                    Unir, dividir, extraer, rotar, imágenes→PDF, marca de agua, metadatos
                  </p>
                </div>
                <span className="ml-auto text-ink-600 group-hover:text-amber-400 transition-colors text-lg">→</span>
              </button>
            </div>


            {/* ── Botones link externos ───────────────────────────────────── */}
            {externalLinks.length > 0 && (
              <div className="mt-10 pb-12">
                <h2 className="font-display text-xl text-ink-200 mb-4">Otros recursos</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {externalLinks.map((link) => (
                    <a
                      key={link.url}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 bg-ink-800 border border-ink-700 rounded-xl px-4 py-3 hover:border-ink-500 hover:bg-ink-800/80 transition-all group"
                    >
                      {link.icon ? (
                        link.icon.startsWith('http') ? (
                          <img src={link.icon} alt="" className="w-5 h-5 rounded" />
                        ) : (
                          <span className="text-lg">{link.icon}</span>
                        )
                      ) : (
                        <img
                          src={`https://www.google.com/s2/favicons?domain=${new URL(link.url).hostname}&sz=32`}
                          alt=""
                          className="w-5 h-5 rounded"
                        />
                      )}
                      <span className="text-sm text-ink-200 group-hover:text-amber-300 transition-colors truncate">
                        {link.name}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            )}
            {/* ── Mobile: Calendario + Entregas inline ─────────────────── */}
            <div className="lg:hidden mt-10 pb-8">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {/* Calendario */}
                <div>
                  <h2 className="text-xs font-medium text-ink-500 uppercase tracking-widest mb-3">
                    Calendario
                  </h2>
                  <CalendarWidget subjects={subjects} />
                </div>

                {/* Próximas entregas */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-xs font-medium text-ink-500 uppercase tracking-widest">
                      Próximas entregas
                    </h2>
                    <button
                      onClick={() => navigate('/deliverables')}
                      className="text-xs text-amber-500 hover:text-amber-300 transition-colors"
                    >
                      Ver todas →
                    </button>
                  </div>
                  {upcomingDeliverables.length === 0 ? (
                    <div className="bg-ink-900 border border-ink-700 rounded-xl p-4 text-center">
                      <p className="text-sm text-ink-600">Sin entregas pendientes</p>
                      <button
                        onClick={() => navigate('/deliverables')}
                        className="text-xs text-amber-500 hover:text-amber-300 mt-2 transition-colors block mx-auto"
                      >
                        Gestionar actividades →
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {upcomingDeliverables.slice(0, 5).map(d => {
                        const subj = subjects.find(s => s.id === d.subjectId);
                        const _n = new Date();
                        const _tl = `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, '0')}-${String(_n.getDate()).padStart(2, '0')}`;
                        const dl = d.dueDate
                          ? Math.round((new Date(d.dueDate + 'T00:00:00').getTime() - new Date(_tl + 'T00:00:00').getTime()) / 86400000)
                          : null;
                        return (
                          <div
                            key={d.id}
                            onClick={() => navigate('/deliverables')}
                            className="flex items-center gap-3 p-3 bg-ink-900 border border-ink-700 rounded-xl hover:border-ink-600 cursor-pointer transition-colors"
                          >
                            {subj?.color && (
                              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: subj.color }} />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-ink-200 truncate">{d.name}</p>
                              <p className="text-xs text-ink-500 truncate">{subj?.name}</p>
                            </div>
                            {dl !== null && (
                              <span className={`text-xs flex-shrink-0 font-medium ${
                                dl <= 3 ? 'text-rose-400' : dl <= 7 ? 'text-amber-400' : 'text-ink-500'
                              }`}>
                                {dl < 0 ? 'Pasado' : dl === 0 ? '¡Hoy!' : dl === 1 ? 'Mañana' : `${dl}d`}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

          </div>
        </main>

        {/* ── Sidebar derecho: Calendario + Próximas entregas (desktop only) */}
        <aside className="hidden lg:block w-72 flex-shrink-0 border-l border-ink-800 overflow-y-auto bg-ink-950/50">
          <div className="p-4 flex flex-col gap-6 pt-6">

            {/* Calendario */}
            <div>
              <h2 className="text-xs font-medium text-ink-500 uppercase tracking-widest mb-3">
                Calendario
              </h2>
              <CalendarWidget subjects={subjects} />
            </div>

            {/* Próximas entregas */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium text-ink-500 uppercase tracking-widest">
                  Próximas entregas
                </h2>
                <button
                  onClick={() => navigate('/deliverables')}
                  className="text-xs text-amber-500 hover:text-amber-300 transition-colors"
                >
                  Ver todas →
                </button>
              </div>

              {upcomingDeliverables.length === 0 ? (
                <div className="bg-ink-900 border border-ink-700 rounded-xl p-4 text-center">
                  <p className="text-sm text-ink-600">Sin entregas pendientes próximas</p>
                  <button
                    onClick={() => navigate('/deliverables')}
                    className="text-xs text-amber-500 hover:text-amber-300 mt-2 transition-colors block mx-auto"
                  >
                    Gestionar actividades →
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {upcomingDeliverables.map(d => {
                    const subject = subjects.find(s => s.id === d.subjectId);
                    const _now = new Date();
                    const _todayLocal = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
                    const daysLeft = d.dueDate
                      ? Math.round((new Date(d.dueDate + 'T00:00:00').getTime() - new Date(_todayLocal + 'T00:00:00').getTime()) / 86400000)
                      : null;
                    return (
                      <div
                        key={d.id}
                        onClick={() => navigate('/deliverables')}
                        className="flex items-center gap-3 p-3 bg-ink-900 border border-ink-700 rounded-xl hover:border-ink-600 cursor-pointer transition-colors"
                      >
                        {subject?.color && (
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: subject.color }} />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-ink-200 truncate">{d.name}</p>
                          <p className="text-xs text-ink-500 truncate">{subject?.name}</p>
                        </div>
                        {daysLeft !== null && (
                          <span className={`text-xs flex-shrink-0 font-medium ${
                            daysLeft <= 0 ? 'text-rose-400' :
                            daysLeft <= 3 ? 'text-rose-400' :
                            daysLeft <= 7 ? 'text-amber-400' : 'text-ink-500'
                          }`}>
                            {daysLeft < 0 ? 'Pasado' : daysLeft === 0 ? '¡Hoy!' : daysLeft === 1 ? 'Mañana' : `${daysLeft}d`}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        </aside>

      </div>{/* fin flex body */}

      {/* ── Modal Info / Ayuda ─────────────────────────────────────────────── */}
      <Modal open={infoOpen} onClose={() => setInfoOpen(false)} title="Hypatia — Guía rápida">
        <div className="flex flex-col gap-6 text-sm text-ink-300 font-body max-h-[75vh] overflow-y-auto pr-1">

          <p className="text-ink-400 leading-relaxed">App web para estudiar con bancos de preguntas. Todo se guarda en tu navegador — sin registro, sin servidor, sin conexión necesaria.</p>

          {/* ── DASHBOARD ── */}
          <section>
            <h3 className="font-display text-amber-400 mb-2.5 text-base border-b border-ink-800 pb-1">Dashboard</h3>
            <ul className="flex flex-col gap-1.5 text-ink-400">
              <li>Muestra todas tus <strong className="text-ink-300">asignaturas</strong> como tarjetas con su progreso de acierto y las preguntas pendientes de repaso del día.</li>
              <li>El badge <strong className="text-blue-300">🧠 N por repasar hoy</strong> aparece cuando el algoritmo SM-2 tiene preguntas vencidas. Púlsalo para lanzar directamente el modo inteligente.</li>
              <li>Si hay una sesión pausada, aparece el badge <strong className="text-orange-300">▶ Sesión en curso</strong> — púlsalo para reanudarla.</li>
              <li>La barra lateral izquierda muestra las <strong className="text-ink-300">sesiones mixtas activas</strong> (práctica de varias asignaturas a la vez).</li>
              <li>La barra lateral derecha (o abajo en móvil) muestra el <strong className="text-ink-300">calendario</strong> y las <strong className="text-ink-300">próximas entregas</strong>.</li>
              <li>El botón <strong className="text-amber-300">🔀 Práctica mixta</strong> (aparece con 2+ asignaturas) lanza una sesión mezclando preguntas de todas.</li>
              <li>El buscador del dashboard busca en tiempo real por todas las asignaturas y temas a la vez.</li>
            </ul>
          </section>

          {/* ── CALENDARIO ── */}
          <section>
            <h3 className="font-display text-amber-400 mb-2.5 text-base border-b border-ink-800 pb-1">Calendario</h3>
            <ul className="flex flex-col gap-1.5 text-ink-400">
              <li>Muestra todos los <strong className="text-ink-300">exámenes y entregas</strong> que hayas registrado en la sección Entregas.</li>
              <li>Los días con eventos llevan indicadores de color: un <strong className="text-ink-300">diamante ◆</strong> para exámenes y un <strong className="text-ink-300">punto •</strong> para el resto de actividades. El color corresponde al color de la asignatura.</li>
              <li><strong className="text-ink-300">Pulsa cualquier día</strong> con eventos para ver el detalle: nombre de la actividad, asignatura, estado y hora si la tiene.</li>
              <li>Navega entre meses con las flechas ‹ ›. El día de hoy aparece resaltado en ámbar.</li>
            </ul>
          </section>

          {/* ── PESTAÑAS DE ASIGNATURA ── */}
          <section>
            <h3 className="font-display text-amber-400 mb-2.5 text-base border-b border-ink-800 pb-1">Pestañas dentro de una asignatura</h3>
            <p className="text-ink-500 mb-3 text-xs">Al entrar en una asignatura encontrarás estas pestañas:</p>

            <div className="flex flex-col gap-4">

              <div>
                <p className="text-ink-200 font-semibold mb-1">📚 Temas</p>
                <ul className="flex flex-col gap-1 text-ink-400 pl-3">
                  <li>Crea y organiza los <strong className="text-ink-300">temas</strong> de la asignatura. Las preguntas se agrupan por tema.</li>
                  <li>Cada tema puede tener un <strong className="text-ink-300">PDF asociado</strong>: arrástralo encima del tema o súbelo desde el botón. El PDF queda vinculado y accesible desde la práctica.</li>
                  <li>Puedes <strong className="text-ink-300">ver el PDF</strong> de un tema directamente en el visor integrado.</li>
                  <li>Los temas se pueden <strong className="text-ink-300">reordenar</strong> arrastrando y soltando.</li>
                  <li>Desde cada tema puedes lanzar práctica de ese tema, abrir las flashcards o escuchar el PDF con voz.</li>
                </ul>
              </div>

              <div>
                <p className="text-ink-200 font-semibold mb-1">❓ Preguntas</p>
                <ul className="flex flex-col gap-1 text-ink-400 pl-3">
                  <li>Lista completa del banco de preguntas de la asignatura con <strong className="text-ink-300">filtros</strong> por tema, tipo, origen, autor y texto libre.</li>
                  <li>Pulsa cualquier pregunta para <strong className="text-ink-300">previsualizarla</strong> con su respuesta y explicación renderizadas.</li>
                  <li>Activa el <strong className="text-ink-300">modo selección</strong> para marcar preguntas concretas y exportarlas a PDF, contribution pack o Anki.</li>
                  <li>Desde esta pestaña también puedes <strong className="text-ink-300">importar un contribution pack</strong> de otro usuario directamente sobre esta asignatura.</li>
                  <li>Una pregunta puede pertenecer a <strong className="text-ink-300">varios temas</strong> a la vez.</li>
                  <li>Cada pregunta puede llevar imágenes (arrastra o pega), tags, dificultad 1–5, origen y un ancla a una página de PDF.</li>
                </ul>
              </div>

              <div>
                <p className="text-ink-200 font-semibold mb-1">🎯 Práctica</p>
                <ul className="flex flex-col gap-1 text-ink-400 pl-3">
                  <li><strong className="text-ink-300">Aleatorio N</strong> — elige cuántas preguntas al azar.</li>
                  <li><strong className="text-ink-300">Todas</strong> — sesión completa con todas las preguntas.</li>
                  <li><strong className="text-ink-300">Solo falladas</strong> — repasa únicamente las que has respondido mal.</li>
                  <li><strong className="text-ink-300">Por tema</strong> — selecciona un tema concreto.</li>
                  <li><strong className="text-ink-300">Inteligente (SM-2)</strong> — el algoritmo de repetición espaciada prioriza las preguntas vencidas según tu historial. Cada pregunta tiene su propia fecha de próximo repaso.</li>
                  <li><strong className="text-ink-300">Modo examen</strong> — sesión cronometrada con cuenta atrás configurable.</li>
                  <li>Puedes pausar cualquier sesión y reanudarla más tarde.</li>
                </ul>
              </div>

              <div>
                <p className="text-ink-200 font-semibold mb-1">📝 Exámenes</p>
                <ul className="flex flex-col gap-1 text-ink-400 pl-3">
                  <li>Crea <strong className="text-ink-300">conjuntos de preguntas seleccionadas a mano</strong> para simular exámenes reales.</li>
                  <li>Cada examen tiene su propio historial de resultados y se puede repetir independientemente.</li>
                  <li>Útil para repasar exactamente las preguntas que suelen caer en el examen de la asignatura.</li>
                </ul>
              </div>

              <div>
                <p className="text-ink-200 font-semibold mb-1">📁 Recursos</p>
                <ul className="flex flex-col gap-1 text-ink-400 pl-3">
                  <li>Acceso a los <strong className="text-ink-300">archivos de la asignatura</strong> organizados en categorías: <em>Resúmenes</em>, <em>Exámenes</em> y <em>Práctica</em>.</li>
                  <li>Los archivos se cargan desde el ZIP de recursos que hayas importado (menú ☰ → Importar recursos) y se almacenan en tu navegador.</li>
                  <li>Puedes abrir cualquier PDF directamente en el visor integrado o escucharlo con síntesis de voz.</li>
                </ul>
              </div>

              <div>
                <p className="text-ink-200 font-semibold mb-1">💡 Conceptos clave</p>
                <ul className="flex flex-col gap-1 text-ink-400 pl-3">
                  <li>Almacena <strong className="text-ink-300">fórmulas, definiciones y observaciones</strong> organizadas por categoría.</li>
                  <li>Admiten Markdown y LaTeX completo. Puedes buscar por texto dentro de los conceptos.</li>
                  <li>Durante las sesiones de práctica puedes abrir la <strong className="text-ink-300">barra lateral de conceptos</strong> como referencia rápida sin salir de la sesión.</li>
                </ul>
              </div>

              <div>
                <p className="text-ink-200 font-semibold mb-1">🤖 IA</p>
                <ul className="flex flex-col gap-1 text-ink-400 pl-3">
                  <li>Sube un PDF y la IA <strong className="text-ink-300">extrae automáticamente las preguntas</strong> del documento y las añade al banco.</li>
                  <li>Requiere configurar una API key de OpenAI o Anthropic en Ajustes (⚙).</li>
                  <li>También disponible opción <strong className="text-ink-300">WebLLM</strong> (modelo local en el navegador, sin API key, más lento).</li>
                </ul>
              </div>

              <div>
                <p className="text-ink-200 font-semibold mb-1">💬 Chatbots <span className="text-xs text-ink-500 font-normal">(aparece si está configurado)</span></p>
                <ul className="flex flex-col gap-1 text-ink-400 pl-3">
                  <li>Accesos directos a <strong className="text-ink-300">GPTs personalizados</strong> vinculados a esa asignatura. Se abren en una pestaña nueva.</li>
                </ul>
              </div>

            </div>
          </section>

          {/* ── TIPOS DE PREGUNTAS ── */}
          <section>
            <h3 className="font-display text-amber-400 mb-2.5 text-base border-b border-ink-800 pb-1">Tipos de preguntas</h3>
            <ul className="flex flex-col gap-1.5 text-ink-400">
              <li>✅ <strong className="text-ink-300">Test</strong> — opciones múltiples (una o varias correctas), corrección automática.</li>
              <li>✏️ <strong className="text-ink-300">Completar</strong> — rellena los huecos marcados como <code className="bg-ink-800 px-1 rounded text-xs">{`{{respuesta}}`}</code>. Corrección automática con normalización de tildes y mayúsculas.</li>
              <li>📝 <strong className="text-ink-300">Desarrollo</strong> — respuesta de texto libre. Tú decides si es correcta.</li>
              <li>🔢 <strong className="text-ink-300">Práctico</strong> — texto libre más resultado numérico opcional. Corrección manual.</li>
            </ul>
          </section>

          {/* ── FÓRMULAS ── */}
          <section>
            <h3 className="font-display text-amber-400 mb-2.5 text-base border-b border-ink-800 pb-1">Fórmulas LaTeX y Markdown</h3>
            <p className="text-ink-400 mb-2">Todos los campos de texto admiten <strong className="text-ink-300">Markdown</strong> (negrita, cursiva, tablas, listas, código) y fórmulas <strong className="text-ink-300">LaTeX</strong> con KaTeX.</p>
            <ul className="flex flex-col gap-1 text-ink-400">
              <li>Fórmula en línea: <code className="bg-ink-800 px-1 rounded">$E = mc^2$</code></li>
              <li>Fórmula en bloque: <code className="bg-ink-800 px-1 rounded">$$\int_a^b f(x)\,dx$$</code></li>
            </ul>
            <p className="text-ink-500 text-xs mt-2">Si usas ChatGPT para generar preguntas, dile que use <code className="bg-ink-800 px-0.5 rounded">$...$</code> y <code className="bg-ink-800 px-0.5 rounded">$$...$$</code> para las fórmulas.</p>
          </section>

          {/* ── MENÚ ── */}
          <section>
            <h3 className="font-display text-amber-400 mb-2.5 text-base border-b border-ink-800 pb-1">Menú (☰) — acciones avanzadas</h3>
            <ul className="flex flex-col gap-1.5 text-ink-400">
              <li>📲 <strong className="text-ink-300">Instalar app</strong> — añade Hypatia a tu pantalla de inicio.</li>
              {/* Hypatia's Hoard ships no global bank: subjects arrive as packages (Marketplace). */}
              {!hoard && <li>⟳ <strong className="text-ink-300">Sincronizar banco</strong> — descarga la última versión del banco global de preguntas compartido.</li>}
              <li>↑ <strong className="text-ink-300">Backup personal</strong> — exporta <em>todos</em> tus datos (preguntas, estadísticas, ajustes) a un JSON. Guárdalo como copia de seguridad.</li>
              <li>↓ <strong className="text-ink-300">Importar backup</strong> — restaura un backup en este navegador o dispositivo.</li>
              <li>📦 <strong className="text-ink-300">Importar recursos</strong> — sube un ZIP con PDFs organizados por asignatura. También puedes arrastrarlo a la zona inferior del dashboard.</li>
            </ul>
          </section>

          {/* ── INSTALAR ── */}
          <section>
            <h3 className="font-display text-amber-400 mb-2.5 text-base border-b border-ink-800 pb-1">Instalar como app</h3>
            <p className="text-ink-400 mb-1.5"><strong className="text-ink-300">Chrome / Edge / Android:</strong> pulsa "📲 Instalar app" en el menú (☰).</p>
            <p className="text-ink-400"><strong className="text-ink-300">iOS / Safari:</strong> pulsa el botón Compartir ⬆ en la barra de Safari → "Añadir a pantalla de inicio".</p>
          </section>

          <p className="text-xs text-ink-600 border-t border-ink-800 pt-3">
            {hoard ? "© 2026 Luis M. Salete · Servido por Hypatia's Hoard en tu PC" : '© 2026 Luis M. Salete · Código privado · Acceso vía GitHub Pages'}
          </p>
        </div>
      </Modal>

      {/* ── Modal crear asignatura ─────────────────────────────────────────── */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Nueva asignatura">
        <div className="flex flex-col gap-4">
          <Input
            label="Nombre"
            value={subjectName}
            onChange={(e) => setSubjectName(e.target.value)}
            placeholder="Bases de Datos"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <div>
            <label className="block text-xs text-ink-500 mb-2 font-body">Color</label>
            <div className="flex gap-2 flex-wrap">
              {SUBJECT_COLORS.map((c) => (
                <button
                  key={c}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${
                    subjectColor === c ? 'border-white scale-110' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                  onClick={() => setSubjectColor(c)}
                />
              ))}
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button onClick={handleCreate} disabled={!subjectName.trim()}>Crear</Button>
          </div>
        </div>
      </Modal>

    </div>
  );
}