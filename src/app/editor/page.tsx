'use client';
/* eslint-disable react-hooks/set-state-in-effect */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  loadEditorState,
  saveEditorState,
  createPhase,
  deletePhase,
  updatePhase,
  updateQuestion,
  deleteQuestion,
  reorderPhases,
  reorderQuestions,
} from '@/lib/storage';
import { exportPackage, importPackage, chunkPhasesForImport } from '@/lib/exportImport';
import { EditorState, Phase, Question, LucideIconName, PhaseMetadataPayload } from '@/types';
import { EditorLayout } from '@/components/editor/EditorLayout';
import { Feedback } from '@/components/ui/Feedback';
import { ArrowLeft, Settings, X, Loader2, CheckCircle2, WifiOff, BarChart3 } from 'lucide-react';
import {
  ApiError,
  fetchPhasesApi,
  createPhaseApi,
  updatePhaseMetadataApi,
  fetchPhaseImpactApi,
  deletePhaseApi,
  reorderPhasesApi,
  importPhasesApi,
  saveSinglePhaseApi,
} from '@/lib/api';

type SyncStatus = 'hydrating' | 'synced' | 'offline';

interface ImportProgressState {
  currentChunk: number;
  totalChunks: number;
  importedPhases: number;
  totalPhases: number;
}

const METADATA_DEBOUNCE_MS = 500;
const TAB_RESYNC_COOLDOWN_MS = 5000;

export default function EditorPage() {
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() =>
    typeof fetch === 'function' ? 'hydrating' : 'offline'
  );
  const [importProgress, setImportProgress] = useState<ImportProgressState | null>(null);
  const [isMobileDevice, setIsMobileDevice] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.screen.width > 0 && Math.min(window.screen.width, window.screen.height) < 768;
  });
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);

  const editorStateRef = useRef<EditorState | null>(null);
  const selectedPhaseIdRef = useRef<string | null>(null);
  const syncStatusRef = useRef<SyncStatus>(typeof fetch === 'function' ? 'hydrating' : 'offline');
  const isSavingRef = useRef(false);
  const importProgressRef = useRef<ImportProgressState | null>(null);
  const hasOpenModalRef = useRef(false);
  const lastSyncAtRef = useRef(0);
  const pendingMetadataRef = useRef<{
    phase: PhaseMetadataPayload;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const pendingCreatesRef = useRef<Map<string, Promise<boolean>>>(new Map());

  useEffect(() => {
    editorStateRef.current = editorState;
  }, [editorState]);

  useEffect(() => {
    selectedPhaseIdRef.current = selectedPhaseId;
  }, [selectedPhaseId]);

  useEffect(() => {
    syncStatusRef.current = syncStatus;
  }, [syncStatus]);

  useEffect(() => {
    isSavingRef.current = isSaving;
  }, [isSaving]);

  useEffect(() => {
    importProgressRef.current = importProgress;
  }, [importProgress]);

  useEffect(() => {
    // Checagem de tela para bloquear smartphones fisicamente
    if (typeof window !== 'undefined' && window.screen.width > 0) {
      const isMobile = Math.min(window.screen.width, window.screen.height) < 768;
      setIsMobileDevice(isMobile);
    }
  }, []);

  useEffect(() => {
    if (feedback) {
      const timer = setTimeout(() => setFeedback(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [feedback]);

  const applyServerPhases = useCallback((dbPhases: Phase[], currentLocal: EditorState | null): EditorState => {
    const stateFromDb: EditorState = {
      version: currentLocal?.version || 1,
      updatedAt: new Date().toISOString(),
      phases: dbPhases,
    };
    editorStateRef.current = stateFromDb;
    setEditorState(stateFromDb);
    saveEditorState(stateFromDb);
    if (dbPhases.length > 0) {
      setSelectedPhaseId((prev) => {
        const nextId = prev && dbPhases.some((p) => p.id === prev) ? prev : dbPhases[0].id;
        selectedPhaseIdRef.current = nextId;
        return nextId;
      });
    } else {
      selectedPhaseIdRef.current = null;
      setSelectedPhaseId(null);
    }
    return stateFromDb;
  }, []);

  useEffect(() => {
    // 1. Inicia imediatamente com o estado local para renderização instantânea
    const local = loadEditorState();
    editorStateRef.current = local;
    setEditorState(local);
    if (local.phases.length > 0) {
      selectedPhaseIdRef.current = local.phases[0].id;
      setSelectedPhaseId(local.phases[0].id);
    }
    setIsLoaded(true);

    // 2. Busca os dados reais e atualizados do Neon PostgreSQL
    let cancelled = false;
    fetchPhasesApi()
      .then((dbPhases) => {
        if (cancelled) return;
        applyServerPhases(dbPhases, local);
        lastSyncAtRef.current = Date.now();
        syncStatusRef.current = 'synced';
        setSyncStatus('synced');
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('Sincronização com o banco falhou, usando cache local:', err.message);
        syncStatusRef.current = 'offline';
        setSyncStatus('offline');
      });

    return () => {
      cancelled = true;
    };
  }, [applyServerPhases]);

  // Re-sincronização automática ao retornar o foco da aba quando não há modais nem edições pendentes
  useEffect(() => {
    const handleVisibilityOrFocus = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (syncStatusRef.current === 'hydrating') return;
      if (isSavingRef.current || importProgressRef.current) return;
      if (hasOpenModalRef.current || pendingMetadataRef.current) return;
      if (Date.now() - lastSyncAtRef.current < TAB_RESYNC_COOLDOWN_MS) return;

      try {
        lastSyncAtRef.current = Date.now();
        const dbPhases = await fetchPhasesApi();
        syncStatusRef.current = 'synced';
        setSyncStatus('synced');

        const prevPhases = editorStateRef.current?.phases || [];
        const changedStructure =
          prevPhases.length !== dbPhases.length ||
          prevPhases.some((p, idx) => p.id !== dbPhases[idx]?.id);
        const changedAny = JSON.stringify(prevPhases) !== JSON.stringify(dbPhases);

        if (changedAny) {
          applyServerPhases(dbPhases, editorStateRef.current);
          if (changedStructure) {
            setFeedback({
              type: 'success',
              message: 'Lista de fases atualizada com alterações recentes.',
            });
          }
        }
      } catch {
        // Mantém trabalho local silenciosamente caso o banco esteja inacessível ao retomar foco
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void handleVisibilityOrFocus();
      }
    };

    const onWindowFocus = () => {
      void handleVisibilityOrFocus();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [applyServerPhases]);

  const waitForPendingCreate = useCallback(async (phaseId: string): Promise<boolean> => {
    const pendingCreate = pendingCreatesRef.current.get(phaseId);
    if (!pendingCreate) return true;
    return pendingCreate;
  }, []);

  const sendMetadataToServer = useCallback(
    async (payload: PhaseMetadataPayload) => {
      if (syncStatusRef.current === 'offline') return;
      const createdOk = await waitForPendingCreate(payload.id);
      if (!createdOk || !editorStateRef.current?.phases.some((p) => p.id === payload.id)) {
        return;
      }

      try {
        setIsSaving(true);
        await updatePhaseMetadataApi(payload);
        lastSyncAtRef.current = Date.now();
      } catch (err: unknown) {
        if (err instanceof ApiError && err.status === 404) {
          try {
            const freshPhases = await fetchPhasesApi();
            applyServerPhases(freshPhases, editorStateRef.current);
          } catch {
            // mantém estado local se re-sync falhar
          }
          setFeedback({
            type: 'warning',
            message: 'Esta fase foi excluída em outra sessão. A lista foi atualizada.',
          });
        } else {
          console.error('Erro ao atualizar metadados da fase:', err);
          const msg = err instanceof Error ? err.message : '';
          setFeedback({
            type: 'warning',
            message: 'Alteração salva localmente, mas houve erro ao sincronizar com o banco: ' + msg,
          });
        }
      } finally {
        setIsSaving(false);
      }
    },
    [applyServerPhases, waitForPendingCreate]
  );

  const flushPendingMetadata = useCallback(() => {
    const pending = pendingMetadataRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingMetadataRef.current = null;
    if (!pending.phase.titulo.trim()) return;
    void sendMetadataToServer(pending.phase);
  }, [sendMetadataToServer]);

  const handleFlushMetadataOnBlur = useCallback(() => {
    flushPendingMetadata();
    const activeId = selectedPhaseIdRef.current;
    const activePhase = editorStateRef.current?.phases.find((p) => p.id === activeId);
    if (activePhase && !activePhase.titulo.trim()) {
      setFeedback({
        type: 'warning',
        message: 'O título da fase não pode ficar em branco para sincronizar com o banco.',
      });
    }
  }, [flushPendingMetadata]);

  useEffect(() => {
    return () => {
      flushPendingMetadata();
    };
  }, [flushPendingMetadata]);

  const persistSinglePhase = async (updatedState: EditorState, phase: Phase) => {
    if (pendingMetadataRef.current?.phase.id === phase.id) {
      clearTimeout(pendingMetadataRef.current.timer);
      pendingMetadataRef.current = null;
    }

    editorStateRef.current = updatedState;
    setEditorState(updatedState);
    saveEditorState(updatedState);
    if (syncStatusRef.current === 'offline') return;

    const createdOk = await waitForPendingCreate(phase.id);
    if (!createdOk || !editorStateRef.current?.phases.some((p) => p.id === phase.id)) {
      return;
    }

    try {
      setIsSaving(true);
      await saveSinglePhaseApi(phase);
      lastSyncAtRef.current = Date.now();
    } catch (err: unknown) {
      console.error('Erro ao persistir fase no banco:', err);
      const msg = err instanceof Error ? err.message : '';
      setFeedback({
        type: 'warning',
        message: 'Alteração salva localmente, mas houve erro ao sincronizar com o banco: ' + msg,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSelectPhase = (phaseId: string) => {
    if (pendingMetadataRef.current && pendingMetadataRef.current.phase.id !== phaseId) {
      flushPendingMetadata();
    }
    selectedPhaseIdRef.current = phaseId;
    setSelectedPhaseId(phaseId);
  };

  const handleCreatePhase = async (titulo: string, icone: LucideIconName) => {
    const previousState = editorStateRef.current;
    if (!previousState) return;
    const previousSelectedId = selectedPhaseIdRef.current;

    flushPendingMetadata();

    const newPhase = createPhase(titulo, icone);
    const updatedState: EditorState = {
      ...previousState,
      phases: [...previousState.phases, newPhase],
    };

    editorStateRef.current = updatedState;
    setEditorState(updatedState);
    saveEditorState(updatedState);
    selectedPhaseIdRef.current = newPhase.id;
    setSelectedPhaseId(newPhase.id);

    if (syncStatusRef.current === 'offline') return;

    const createPromise = (async (): Promise<boolean> => {
      try {
        setIsSaving(true);
        await createPhaseApi({
          id: newPhase.id,
          titulo: newPhase.titulo,
          icone: newPhase.icone,
        });
        lastSyncAtRef.current = Date.now();
        return true;
      } catch (err: unknown) {
        const latestState = editorStateRef.current;
        if (latestState) {
          const rolledBack: EditorState = {
            ...latestState,
            phases: latestState.phases.filter((p) => p.id !== newPhase.id),
          };
          editorStateRef.current = rolledBack;
          setEditorState(rolledBack);
          saveEditorState(rolledBack);
          if (selectedPhaseIdRef.current === newPhase.id) {
            const nextId =
              previousSelectedId && rolledBack.phases.some((p) => p.id === previousSelectedId)
                ? previousSelectedId
                : rolledBack.phases[0]?.id ?? null;
            selectedPhaseIdRef.current = nextId;
            setSelectedPhaseId(nextId);
          }
        }
        const msg = err instanceof Error ? err.message : 'Erro ao criar fase no banco.';
        setFeedback({ type: 'error', message: msg });
        return false;
      } finally {
        pendingCreatesRef.current.delete(newPhase.id);
        setIsSaving(false);
      }
    })();

    pendingCreatesRef.current.set(newPhase.id, createPromise);
    await createPromise;
  };

  const handleUpdatePhase = (phase: Phase, options?: { immediate?: boolean }) => {
    const current = editorStateRef.current;
    if (!current) return;

    const updatedState = updatePhase(current, phase);
    editorStateRef.current = updatedState;
    setEditorState(updatedState);
    saveEditorState(updatedState);

    if (syncStatusRef.current === 'offline') return;

    const payload: PhaseMetadataPayload = {
      id: phase.id,
      titulo: phase.titulo,
      icone: phase.icone,
      ...(phase.oculta !== undefined ? { oculta: phase.oculta } : {}),
    };

    if (options?.immediate) {
      if (pendingMetadataRef.current?.phase.id === phase.id) {
        clearTimeout(pendingMetadataRef.current.timer);
        pendingMetadataRef.current = null;
      } else if (pendingMetadataRef.current) {
        flushPendingMetadata();
      }
      if (payload.titulo.trim()) {
        void sendMetadataToServer(payload);
      }
      return;
    }

    if (pendingMetadataRef.current && pendingMetadataRef.current.phase.id !== phase.id) {
      flushPendingMetadata();
    } else if (pendingMetadataRef.current) {
      clearTimeout(pendingMetadataRef.current.timer);
    }

    if (!payload.titulo.trim()) {
      pendingMetadataRef.current = null;
      return;
    }

    const timer = setTimeout(() => {
      const latest = pendingMetadataRef.current;
      if (latest && latest.phase.id === payload.id) {
        pendingMetadataRef.current = null;
        void sendMetadataToServer(latest.phase);
      }
    }, METADATA_DEBOUNCE_MS);

    pendingMetadataRef.current = { phase: payload, timer };
  };

  const handleDeletePhase = async (phaseId: string) => {
    const previousState = editorStateRef.current;
    if (!previousState || previousState.phases.length <= 1) return;
    const previousSelectedId = selectedPhaseIdRef.current;

    if (pendingMetadataRef.current?.phase.id === phaseId) {
      clearTimeout(pendingMetadataRef.current.timer);
      pendingMetadataRef.current = null;
    }

    const updatedState = deletePhase(previousState, phaseId);
    editorStateRef.current = updatedState;
    setEditorState(updatedState);
    saveEditorState(updatedState);

    if (selectedPhaseIdRef.current === phaseId) {
      const nextId = updatedState.phases.length > 0 ? updatedState.phases[0].id : null;
      selectedPhaseIdRef.current = nextId;
      setSelectedPhaseId(nextId);
    }

    if (syncStatusRef.current === 'offline') return;

    const createdOk = await waitForPendingCreate(phaseId);
    if (!createdOk) return;

    try {
      setIsSaving(true);
      await deletePhaseApi(phaseId);
      lastSyncAtRef.current = Date.now();
    } catch (err: unknown) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        try {
          const freshPhases = await fetchPhasesApi();
          applyServerPhases(freshPhases, previousState);
        } catch {
          editorStateRef.current = previousState;
          setEditorState(previousState);
          saveEditorState(previousState);
          selectedPhaseIdRef.current = previousSelectedId;
          setSelectedPhaseId(previousSelectedId);
        }
        setFeedback({ type: 'error', message: err.message });
      } else {
        editorStateRef.current = previousState;
        setEditorState(previousState);
        saveEditorState(previousState);
        selectedPhaseIdRef.current = previousSelectedId;
        setSelectedPhaseId(previousSelectedId);
        const msg = err instanceof Error ? err.message : 'Erro ao excluir fase no banco.';
        setFeedback({ type: 'error', message: msg });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleRequestPhaseImpact = useCallback(async (phaseId: string) => {
    if (syncStatusRef.current === 'offline') {
      return null;
    }
    return fetchPhaseImpactApi(phaseId);
  }, []);

  const handleModalVisibilityChange = useCallback((isOpen: boolean) => {
    hasOpenModalRef.current = isOpen;
  }, []);

  const handleSaveQuestion = async (phaseId: string, question: Question) => {
    const current = editorStateRef.current;
    if (!current) return;
    const phase = current.phases.find((p) => p.id === phaseId);
    if (!phase) return;

    const exists = phase.questoes.some((q) => q.id === question.id);
    let updatedState: EditorState;

    if (exists) {
      updatedState = updateQuestion(current, phaseId, question);
    } else {
      updatedState = {
        ...current,
        phases: current.phases.map((p) =>
          p.id === phaseId ? { ...p, questoes: [...p.questoes, question] } : p
        ),
      };
    }

    const updatedPhase = updatedState.phases.find((p) => p.id === phaseId);
    if (updatedPhase) {
      await persistSinglePhase(updatedState, updatedPhase);
    }
  };

  const handleDeleteQuestion = async (phaseId: string, questionId: string) => {
    const current = editorStateRef.current;
    if (!current) return;
    const updatedState = deleteQuestion(current, phaseId, questionId);
    const updatedPhase = updatedState.phases.find((p) => p.id === phaseId);
    if (updatedPhase) {
      await persistSinglePhase(updatedState, updatedPhase);
    }
  };

  const handleReorderPhases = async (oldIndex: number, newIndex: number) => {
    const previousState = editorStateRef.current;
    if (!previousState) return;

    const updatedState = reorderPhases(previousState, oldIndex, newIndex);
    editorStateRef.current = updatedState;
    setEditorState(updatedState);
    saveEditorState(updatedState);

    if (syncStatusRef.current === 'offline') return;

    try {
      setIsSaving(true);
      const res = await reorderPhasesApi(updatedState.phases.map((p) => p.id));
      lastSyncAtRef.current = Date.now();
      if (res.hasExternalChanges) {
        const freshPhases = await fetchPhasesApi();
        applyServerPhases(freshPhases, updatedState);
        setFeedback({
          type: 'success',
          message: 'Ordem salva e lista sincronizada com alterações recentes de outro professor.',
        });
      }
    } catch (err: unknown) {
      editorStateRef.current = previousState;
      setEditorState(previousState);
      saveEditorState(previousState);
      const msg = err instanceof Error ? err.message : 'Erro ao reordenar fases no banco.';
      setFeedback({ type: 'error', message: msg });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReorderQuestions = async (phaseId: string, oldIndex: number, newIndex: number) => {
    const current = editorStateRef.current;
    if (!current) return;
    const updatedState = reorderQuestions(current, phaseId, oldIndex, newIndex);
    const updatedPhase = updatedState.phases.find((p) => p.id === phaseId);
    if (updatedPhase) {
      await persistSinglePhase(updatedState, updatedPhase);
    }
  };

  const handleExportPhase = (phaseId: string) => {
    if (!editorState) return;
    const phase = editorState.phases.find((p) => p.id === phaseId);
    const pkg = exportPackage(editorState, [phaseId]);
    const json = JSON.stringify(pkg, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeTitle = (phase?.titulo || 'fase')
      .toLowerCase()
      .replace(/[^a-z0-9]/gi, '_');
    a.download = `fase-${safeTitle}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setFeedback({
      type: 'success',
      message: `Fase "${phase?.titulo || ''}" exportada com sucesso!`,
    });
  };

  const handleExportAll = () => {
    if (!editorState || editorState.phases.length === 0) return;
    const pkg = exportPackage(editorState);
    const json = JSON.stringify(pkg, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `logica-dinamica-todas-fases-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setFeedback({
      type: 'success',
      message: `Todas as ${editorState.phases.length} fases foram exportadas em um único pacote com sucesso!`,
    });
  };

  const handleImportPackage = async (packageData: unknown) => {
    const previousState = editorStateRef.current;
    if (!previousState) return;
    const previousSelectedId = selectedPhaseIdRef.current;

    flushPendingMetadata();

    let result;
    try {
      result = importPackage(previousState, packageData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao importar pacote.';
      setFeedback({ type: 'error', message: msg });
      return;
    }

    if (syncStatusRef.current === 'offline') {
      editorStateRef.current = result.state;
      setEditorState(result.state);
      saveEditorState(result.state);
      const lastImported = result.importedPhases[result.importedPhases.length - 1];
      if (lastImported) {
        selectedPhaseIdRef.current = lastImported.id;
        setSelectedPhaseId(lastImported.id);
      }
      setFeedback({
        type: 'success',
        message: `${result.importedPhasesCount} fase(s) e ${result.importedQuestionsCount} questão(ões) importada(s) localmente.`,
      });
      return;
    }

    const chunks = chunkPhasesForImport(result.importedPhases);
    let completedPhases = 0;

    try {
      setIsSaving(true);
      for (let idx = 0; idx < chunks.length; idx++) {
        const chunk = chunks[idx];
        const nextProgress: ImportProgressState = {
          currentChunk: idx + 1,
          totalChunks: chunks.length,
          importedPhases: completedPhases,
          totalPhases: result.importedPhases.length,
        };
        importProgressRef.current = nextProgress;
        setImportProgress(nextProgress);

        await importPhasesApi(chunk);
        completedPhases += chunk.length;
      }

      lastSyncAtRef.current = Date.now();
      editorStateRef.current = result.state;
      setEditorState(result.state);
      saveEditorState(result.state);

      const lastImported = result.importedPhases[result.importedPhases.length - 1];
      if (lastImported) {
        selectedPhaseIdRef.current = lastImported.id;
        setSelectedPhaseId(lastImported.id);
      }

      setFeedback({
        type: 'success',
        message: `${result.importedPhasesCount} fase(s) e ${result.importedQuestionsCount} questão(ões) importada(s) e salvas no banco com sucesso!`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro ao importar pacote.';

      if (completedPhases > 0) {
        try {
          const freshPhases = await fetchPhasesApi();
          applyServerPhases(freshPhases, previousState);
        } catch {
          editorStateRef.current = previousState;
          setEditorState(previousState);
          saveEditorState(previousState);
          selectedPhaseIdRef.current = previousSelectedId;
          setSelectedPhaseId(previousSelectedId);
        }
        setFeedback({
          type: 'error',
          message: `Falha parcial na importação: ${completedPhases} fase(s) já haviam sido salvas e a lista foi atualizada. (${msg})`,
        });
      } else {
        selectedPhaseIdRef.current = previousSelectedId;
        setSelectedPhaseId(previousSelectedId);
        setFeedback({ type: 'error', message: msg });
      }
    } finally {
      importProgressRef.current = null;
      setImportProgress(null);
      setIsSaving(false);
    }
  };

  if (isMobileDevice) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base p-6 text-center">
        <div className="bg-surface border border-border-subtle rounded-xl p-8 max-w-sm">
          <h2 className="text-xl font-bold text-error mb-4">Acesso Bloqueado</h2>
          <p className="text-text-muted mb-6">O Modo Editor é uma ferramenta administrativa que não suporta smartphones.</p>
          <p className="text-text-muted text-sm mb-6">Por favor, acesse via Tablet ou Computador.</p>
          <Link href="/" className="inline-flex items-center justify-center bg-primary text-white font-bold py-2 px-4 rounded-lg w-full transition-colors hover:bg-primary/90">
            Voltar ao Modo Estudo
          </Link>
        </div>
      </div>
    );
  }

  if (!isLoaded || !editorState) {
    return null;
  }

  const isStructuralDisabled = syncStatus === 'hydrating' || Boolean(importProgress);

  return (
    <div className="min-h-screen flex flex-col bg-base text-text-main font-sans">
      {/* Header do Editor */}
      <header className="h-16 bg-surface/80 backdrop-blur-md border-b border-border-subtle px-4 md:px-6 flex items-center justify-between shrink-0 sticky top-0 z-50 transition-all duration-300">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 text-primary rounded-lg">
            <Settings size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-lg text-white leading-tight">Editor de Conteúdo</h1>
              {importProgress ? (
                <span className="flex items-center gap-1 text-[11px] font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                  <Loader2 size={11} className="animate-spin" /> Importando lote {importProgress.currentChunk}/{importProgress.totalChunks}...
                </span>
              ) : isSaving ? (
                <span className="flex items-center gap-1 text-[11px] font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                  <Loader2 size={11} className="animate-spin" /> Salvando...
                </span>
              ) : syncStatus === 'hydrating' ? (
                <span className="flex items-center gap-1 text-[11px] font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                  <Loader2 size={11} className="animate-spin" /> Sincronizando...
                </span>
              ) : syncStatus === 'offline' ? (
                <span className="hidden sm:flex items-center gap-1 text-[11px] font-mono text-warning bg-warning/10 px-2 py-0.5 rounded-full border border-warning/20">
                  <WifiOff size={11} /> Modo offline
                </span>
              ) : (
                <span className="hidden sm:flex items-center gap-1 text-[11px] font-mono text-success bg-success/10 px-2 py-0.5 rounded-full border border-success/20">
                  <CheckCircle2 size={11} /> Sincronizado
                </span>
              )}
            </div>
            <span className="text-xs text-text-muted hidden sm:inline">
              Gerencie fases, formule questões e acompanhe o preview em tempo real
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/editor/analytics"
            className="text-sm font-medium text-text-muted hover:text-white flex items-center gap-2 px-3 py-2 rounded-lg bg-surface hover:bg-surface/80 border border-border-subtle transition-colors"
          >
            <BarChart3 size={16} className="text-primary" /> Análises
          </Link>

          <Link
            href="/"
            className="text-sm font-medium text-text-muted hover:text-white flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-base transition-colors border border-transparent hover:border-border-subtle"
          >
            <ArrowLeft size={16} /> Voltar ao Modo Estudo
          </Link>
        </div>
      </header>

      {/* Corpo do Editor */}
      <EditorLayout
        phases={editorState.phases}
        selectedPhaseId={selectedPhaseId}
        onSelectPhase={handleSelectPhase}
        onCreatePhase={handleCreatePhase}
        onUpdatePhase={handleUpdatePhase}
        onFlushPhaseMetadata={handleFlushMetadataOnBlur}
        onDeletePhase={handleDeletePhase}
        onRequestPhaseImpact={syncStatus !== 'offline' ? handleRequestPhaseImpact : undefined}
        onSaveQuestion={handleSaveQuestion}
        onDeleteQuestion={handleDeleteQuestion}
        onReorderPhases={handleReorderPhases}
        onReorderQuestions={handleReorderQuestions}
        onImportPackage={handleImportPackage}
        onExportPhase={handleExportPhase}
        onExportAll={handleExportAll}
        isStructuralDisabled={isStructuralDisabled}
        onModalVisibilityChange={handleModalVisibilityChange}
      />

      {/* Toast flutuante de Feedback */}
      {feedback && (
        <div className="fixed bottom-6 right-6 z-50 bg-surface border border-border-subtle p-3.5 rounded-xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
          <Feedback type={feedback.type} message={feedback.message} />
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-text-muted hover:text-white text-xs p-1 rounded transition-colors"
            aria-label="Fechar notificação"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
