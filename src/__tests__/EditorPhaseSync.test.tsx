/**
 * @file EditorPhaseSync.test.tsx
 * @description Testes de integração (TDD) para resolução completa da Issue #5 (Solução C):
 * - Endpoints granulares REST para operações estruturais e metadados de fases
 * - Simulador relacional completo (Phase -> Question -> Submission com onDelete: Cascade)
 * - Bloqueio durante hidratação inicial, debounce de título com flush no blur,
 *   aviso de impacto de submissões Zero-DDL, chunking automático de importação,
 *   prevenção de falso-positivo no toast de erro e re-sync no foco da aba.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// --- Captura determinística do onDragEnd da PhaseSidebar sem quebrar @dnd-kit/core ---
let capturedSidebarOnDragEnd: ((event: { active: { id: string }; over: { id: string } | null }) => void) | null = null;

jest.mock('@dnd-kit/core', () => {
  const actual = jest.requireActual('@dnd-kit/core');
  return {
    ...actual,
    DndContext: (props: Record<string, unknown>) => {
      const children = props.children as { props?: { items?: unknown[] } } | undefined;
      const items = children?.props?.items;
      if (Array.isArray(items) && items.some((id) => typeof id === 'string' && id.startsWith('phase-'))) {
        capturedSidebarOnDragEnd = props.onDragEnd as typeof capturedSidebarOnDragEnd;
      }
      return React.createElement(actual.DndContext, props);
    },
  };
});

// --- Simulador Relacional em Memória (Phase -> Question -> Submission com onDelete: Cascade) ---

interface DbPhaseRow {
  id: string;
  title: string;
  icon: string;
  order: number;
}

interface DbQuestionRow {
  id: string;
  phaseId: string;
  type: string;
  topic: string;
  enunciado: string;
  order: number;
  content: unknown;
}

interface DbSubmissionRow {
  id: string;
  userId: string;
  questionId: string;
  isCorrect: boolean;
  answer: unknown;
}

interface QueryLog {
  model: 'phase' | 'question' | 'submission';
  action: 'deleteMany' | 'upsert' | 'create' | 'update' | 'delete' | 'updateMany' | 'createMany' | '$executeRaw';
  detail?: string;
}

const dbState = {
  phases: new Map<string, DbPhaseRow>(),
  questions: new Map<string, DbQuestionRow>(),
  submissions: new Map<string, DbSubmissionRow>(),
  queryLog: [] as QueryLog[],
};

function resetDb() {
  dbState.phases.clear();
  dbState.questions.clear();
  dbState.submissions.clear();
  dbState.queryLog = [];
}

function deleteQuestionWithCascade(questionId: string) {
  dbState.questions.delete(questionId);
  for (const [sId, s] of dbState.submissions.entries()) {
    if (s.questionId === questionId) {
      dbState.submissions.delete(sId);
    }
  }
}

function deletePhaseWithCascade(phaseId: string) {
  dbState.phases.delete(phaseId);
  for (const [qId, q] of dbState.questions.entries()) {
    if (q.phaseId === phaseId) {
      deleteQuestionWithCascade(qId);
    }
  }
}

jest.mock('@/lib/prisma', () => {
  const prismaCore = {
    phase: {
      findMany: jest.fn(async (args?: { include?: { questions?: unknown }; select?: { id?: boolean; order?: boolean } }) => {
        const sorted = Array.from(dbState.phases.values()).sort((a, b) => a.order - b.order);
        if (args?.include?.questions) {
          return sorted.map((p) => ({
            ...p,
            questions: Array.from(dbState.questions.values())
              .filter((q) => q.phaseId === p.id)
              .sort((a, b) => a.order - b.order),
          }));
        }
        return sorted.map((p) => ({ id: p.id, order: p.order }));
      }),
      findUnique: jest.fn(
        async (args: {
          where: { id: string };
          select?: { id?: boolean; order?: boolean; _count?: { select?: { questions?: boolean } } };
        }) => {
          const found = dbState.phases.get(args.where.id);
          if (!found) return null;
          if (args.select?._count?.select?.questions) {
            const qCount = Array.from(dbState.questions.values()).filter((q) => q.phaseId === found.id).length;
            return { id: found.id, _count: { questions: qCount } };
          }
          return { id: found.id, order: found.order };
        }
      ),
      aggregate: jest.fn(async () => {
        const orders = Array.from(dbState.phases.values()).map((p) => p.order);
        return { _max: { order: orders.length > 0 ? Math.max(...orders) : null } };
      }),
      count: jest.fn(async () => dbState.phases.size),
      create: jest.fn(async (args: { data: DbPhaseRow }) => {
        dbState.queryLog.push({ model: 'phase', action: 'create', detail: args.data.id });
        if (dbState.phases.has(args.data.id)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        dbState.phases.set(args.data.id, { ...args.data });
        return dbState.phases.get(args.data.id);
      }),
      update: jest.fn(async (args: { where: { id: string }; data: Partial<DbPhaseRow> }) => {
        dbState.queryLog.push({ model: 'phase', action: 'update', detail: args.where.id });
        const existing = dbState.phases.get(args.where.id);
        if (!existing) {
          throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
        }
        const updated = { ...existing, ...args.data };
        dbState.phases.set(args.where.id, updated);
        return updated;
      }),
      delete: jest.fn(async (args: { where: { id: string } }) => {
        dbState.queryLog.push({ model: 'phase', action: 'delete', detail: args.where.id });
        const existing = dbState.phases.get(args.where.id);
        if (!existing) {
          throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        }
        deletePhaseWithCascade(args.where.id);
        return existing;
      }),
      updateMany: jest.fn(async (args: { where?: { order?: { gt?: number } }; data?: { order?: { decrement?: number } } }) => {
        dbState.queryLog.push({ model: 'phase', action: 'updateMany' });
        const gt = args?.where?.order?.gt;
        const dec = args?.data?.order?.decrement ?? 0;
        let count = 0;
        for (const p of dbState.phases.values()) {
          if (gt === undefined || p.order > gt) {
            p.order -= dec;
            count++;
          }
        }
        return { count };
      }),
      createMany: jest.fn(async (args: { data: DbPhaseRow[] }) => {
        dbState.queryLog.push({ model: 'phase', action: 'createMany', detail: String(args.data.length) });
        for (const row of args.data) {
          dbState.phases.set(row.id, { ...row });
        }
        return { count: args.data.length };
      }),
      deleteMany: jest.fn(async () => {
        dbState.queryLog.push({ model: 'phase', action: 'deleteMany' });
        return { count: 0 };
      }),
      upsert: jest.fn(async (args: { where: { id: string }; create: DbPhaseRow; update: Partial<DbPhaseRow> }) => {
        dbState.queryLog.push({ model: 'phase', action: 'upsert', detail: args.where.id });
        const existing = dbState.phases.get(args.where.id);
        const next = existing ? { ...existing, ...args.update } : { ...args.create };
        dbState.phases.set(args.where.id, next);
        return next;
      }),
    },
    question: {
      createMany: jest.fn(async (args: { data: DbQuestionRow[] }) => {
        dbState.queryLog.push({ model: 'question', action: 'createMany', detail: String(args.data.length) });
        for (const row of args.data) {
          dbState.questions.set(row.id, { ...row });
        }
        return { count: args.data.length };
      }),
      deleteMany: jest.fn(async () => {
        dbState.queryLog.push({ model: 'question', action: 'deleteMany' });
        return { count: 0 };
      }),
      upsert: jest.fn(async () => {
        dbState.queryLog.push({ model: 'question', action: 'upsert' });
        return {};
      }),
    },
    submission: {
      count: jest.fn(async (args?: { where?: { question?: { phaseId?: string } } }) => {
        const targetPhaseId = args?.where?.question?.phaseId;
        if (!targetPhaseId) return dbState.submissions.size;
        let count = 0;
        for (const s of dbState.submissions.values()) {
          const q = dbState.questions.get(s.questionId);
          if (q?.phaseId === targetPhaseId) count++;
        }
        return count;
      }),
      groupBy: jest.fn(async (args: { where?: { question?: { phaseId?: string } } }) => {
        const targetPhaseId = args?.where?.question?.phaseId;
        const distinctUsers = new Set<string>();
        for (const s of dbState.submissions.values()) {
          const q = dbState.questions.get(s.questionId);
          if (!targetPhaseId || q?.phaseId === targetPhaseId) {
            distinctUsers.add(s.userId);
          }
        }
        return Array.from(distinctUsers).map((userId) => ({ userId }));
      }),
    },
    $executeRaw: jest.fn(async (sqlQuery: { values?: unknown[] }) => {
      dbState.queryLog.push({ model: 'phase', action: '$executeRaw' });
      const vals = sqlQuery?.values || [];
      for (let i = 0; i < vals.length; i += 2) {
        const id = String(vals[i]);
        const order = Number(vals[i + 1]);
        const existing = dbState.phases.get(id);
        if (existing) {
          existing.order = order;
        }
      }
      return vals.length / 2;
    }),
  };
  const prismaMock = {
    ...prismaCore,
    $transaction: jest.fn(async (callback: (tx: typeof prismaCore) => Promise<unknown>) => {
      return callback(prismaCore);
    }),
  };
  return { prisma: prismaMock };
});

jest.mock('next-auth', () => ({
  getServerSession: jest.fn(async () => ({
    user: { email: 'prof@instituicao.edu.br', role: 'TEACHER' },
  })),
}));

jest.mock('@/lib/auth', () => ({
  authOptions: {},
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data: unknown, init?: { status?: number }) => {
      const status = init?.status || 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => data,
      };
    }),
  },
}));

jest.mock('@/lib/storage', () => {
  const actual = jest.requireActual('@/lib/storage');
  return {
    ...actual,
    loadEditorState: jest.fn(),
    saveEditorState: jest.fn(),
  };
});

import EditorPage from '@/app/editor/page';
import { GET as getPhasesRoute, POST as postPhasesRoute } from '@/app/api/phases/route';
import { PUT as putPhaseRoute, PATCH as patchPhaseRoute, DELETE as deletePhaseRoute } from '@/app/api/phases/[id]/route';
import { GET as getPhaseImpactRoute } from '@/app/api/phases/[id]/impact/route';
import { PATCH as patchReorderRoute } from '@/app/api/phases/reorder/route';
import { POST as postImportRoute } from '@/app/api/phases/import/route';
import { loadEditorState } from '@/lib/storage';
import type { EditorState, Phase, Question } from '@/types';

// --- Helpers de Seed e Bridge HTTP ---

function makeQuestion(id: string, index: number): Question {
  return {
    id,
    tipo: 'diagramacao',
    topico: 'Lógica Proposicional',
    enunciado: `Questão ${index}: Classifique as sentenças.`,
    frases: [
      { id: 'f1', texto: 'Premissa A' },
      { id: 'f2', texto: 'Conclusão B' },
    ],
    resposta_esperada: { f1: 'P', f2: 'C' },
  };
}

function buildCurriculum(phaseCount: number, questionsPerPhase: number): Phase[] {
  return Array.from({ length: phaseCount }, (_, pIdx) => ({
    id: `phase-${pIdx + 1}`,
    titulo: `Módulo ${pIdx + 1}`,
    icone: 'Network' as const,
    questoes: Array.from({ length: questionsPerPhase }, (_, qIdx) =>
      makeQuestion(`p${pIdx + 1}-q${qIdx + 1}`, qIdx + 1)
    ),
  }));
}

function seedDbWithPhases(phases: Phase[]) {
  resetDb();
  phases.forEach((p, pIndex) => {
    dbState.phases.set(p.id, {
      id: p.id,
      title: p.titulo,
      icon: p.oculta ? `${p.icone}:oculta` : p.icone,
      order: pIndex,
    });
    p.questoes.forEach((q, qIndex) => {
      const { id, tipo, topico, enunciado, ...content } = q as Question & Record<string, unknown>;
      dbState.questions.set(id, {
        id,
        phaseId: p.id,
        type: tipo.toUpperCase(),
        topic: topico,
        enunciado,
        order: qIndex,
        content,
      });
    });
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  bodyBytes: number;
  bodyJson: Record<string, unknown> | null;
}

let capturedRequests: CapturedRequest[] = [];
let getPhasesGate: Promise<void> | null = null;
let getImpactGate: Promise<void> | null = null;
let postPhaseGate: Promise<void> | null = null;
let forceImportFailure = false;
let failImportOnCall: number | null = null;
let importCallCount = 0;

function setupFetchBridge() {
  capturedRequests = [];
  getPhasesGate = null;
  getImpactGate = null;
  postPhaseGate = null;
  forceImportFailure = false;
  failImportOnCall = null;
  importCallCount = 0;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method || 'GET').toUpperCase();
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    const bodyBytes = Buffer.byteLength(bodyStr, 'utf8');
    const bodyJson = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : null;

    capturedRequests.push({ url, method, bodyBytes, bodyJson });

    if (url === '/api/phases' && method === 'GET') {
      if (getPhasesGate) {
        await getPhasesGate;
      }
      return (await getPhasesRoute()) as unknown as Response;
    }

    if (url === '/api/phases' && method === 'POST') {
      if (postPhaseGate) {
        await postPhaseGate;
      }
      return (await postPhasesRoute({ json: async () => bodyJson } as unknown as Request)) as unknown as Response;
    }

    if (url === '/api/phases/reorder' && method === 'PATCH') {
      return (await patchReorderRoute({ json: async () => bodyJson } as unknown as Request)) as unknown as Response;
    }

    if (url === '/api/phases/import' && method === 'POST') {
      importCallCount += 1;
      if (forceImportFailure || (failImportOnCall !== null && importCallCount === failImportOnCall)) {
        return {
          status: 500,
          ok: false,
          json: async () => ({ error: 'Falha simulada no lote de importação' }),
        } as unknown as Response;
      }
      return (await postImportRoute({ json: async () => bodyJson } as unknown as Request)) as unknown as Response;
    }

    const impactMatch = url.match(/^\/api\/phases\/([^/]+)\/impact$/);
    if (impactMatch && method === 'GET') {
      if (getImpactGate) {
        await getImpactGate;
      }
      const id = impactMatch[1];
      return (await getPhaseImpactRoute({} as Request, { params: Promise.resolve({ id }) })) as unknown as Response;
    }

    const phaseIdMatch = url.match(/^\/api\/phases\/([^/]+)$/);
    if (phaseIdMatch) {
      const id = phaseIdMatch[1];
      const req = { json: async () => bodyJson } as unknown as Request;
      const ctx = { params: Promise.resolve({ id }) };
      if (method === 'PUT') return (await putPhaseRoute(req, ctx)) as unknown as Response;
      if (method === 'PATCH') return (await patchPhaseRoute(req, ctx)) as unknown as Response;
      if (method === 'DELETE') return (await deletePhaseRoute(req, ctx)) as unknown as Response;
    }

    throw new Error(`Rota não tratada no bridge: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe('[Issue #5 — Solução C] Sincronização Granular de Fases no Modo Editor', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedSidebarOnDragEnd = null;
    resetDb();
    setupFetchBridge();
    process.env.TEACHER_EMAILS = 'prof@instituicao.edu.br';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    global.fetch = realFetch;
  });

  it('Test 1 (Hydration Lock): bloqueia ações estruturais e exibe "Sincronizando..." até o GET inicial concluir', async () => {
    const phases = buildCurriculum(2, 1);
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    let releaseGate!: () => void;
    getPhasesGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    render(<EditorPage />);

    // Durante o GET inicial pendente: status "Sincronizando..." e botões estruturais desabilitados
    expect(screen.getByText(/Sincronizando\.\.\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nova Fase/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Importar/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Excluir Fase/i })).toBeDisabled();

    // Libera o GET inicial
    await act(async () => {
      releaseGate();
    });

    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Nova Fase/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Importar/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Excluir Fase/i })).toBeEnabled();
  });

  it('Test 2 (Cenário 1A — Create Granular): criar 1 fase em currículo de 8 fases / 104 questões trafega < 1 KB e faz 0 upserts de questão', async () => {
    const phases = buildCurriculum(8, 13); // 104 questões
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    dbState.queryLog = [];
    capturedRequests = [];

    fireEvent.click(screen.getByRole('button', { name: /Nova Fase/i }));
    const nomeInput = await screen.findByPlaceholderText(/Nome da fase/i);
    await userEvent.type(nomeInput, 'Módulo 9 (Novo)');
    fireEvent.click(screen.getByRole('button', { name: /^Criar$/i }));

    await waitFor(() => {
      expect(capturedRequests.some((r) => r.method === 'POST' && r.url === '/api/phases')).toBe(true);
    });

    const postReq = capturedRequests.find((r) => r.method === 'POST' && r.url === '/api/phases')!;
    expect(postReq.bodyBytes).toBeLessThan(1024);
    expect(postReq.bodyJson).toHaveProperty('phase');
    expect((postReq.bodyJson?.phase as Record<string, unknown>)?.questoes).toBeUndefined();
    expect(postReq.bodyJson?.phases).toBeUndefined();

    // Zero reescrita de questões e zero deleteMany
    expect(dbState.queryLog.filter((q) => q.model === 'question')).toHaveLength(0);
    expect(dbState.queryLog.filter((q) => q.action === 'deleteMany')).toHaveLength(0);
    expect(dbState.phases.size).toBe(9);
  });

  it('Test 3 (Metadados com Debounce + Flush no Blur + Toggle Imediato): usa PATCH /api/phases/[id] sem tocar em Questões', async () => {
    const phases = buildCurriculum(2, 5);
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    dbState.queryLog = [];
    capturedRequests = [];

    const titleInput = screen.getByDisplayValue('Módulo 1');

    // Digitação contínua com fake timers -> debounce de 500ms
    jest.useFakeTimers();
    act(() => {
      fireEvent.change(titleInput, { target: { value: 'Módulo 1 A' } });
      fireEvent.change(titleInput, { target: { value: 'Módulo 1 AB' } });
      fireEvent.change(titleInput, { target: { value: 'Módulo 1 Atualizado' } });
    });

    expect(capturedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);

    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(capturedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);

    act(() => {
      jest.advanceTimersByTime(150);
    });
    jest.useRealTimers();

    await waitFor(() => {
      expect(capturedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    });

    const patchReq = capturedRequests.find((r) => r.method === 'PATCH')!;
    expect(patchReq.url).toBe('/api/phases/phase-1');
    expect((patchReq.bodyJson?.phase as Record<string, unknown>)?.questoes).toBeUndefined();
    expect(dbState.phases.get('phase-1')?.title).toBe('Módulo 1 Atualizado');
    expect(dbState.queryLog.filter((q) => q.model === 'question')).toHaveLength(0);

    // Flush imediato no onBlur
    capturedRequests = [];
    fireEvent.change(titleInput, { target: { value: 'Módulo 1 Blur' } });
    expect(capturedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    fireEvent.blur(titleInput);

    await waitFor(() => {
      expect(capturedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    });
    expect(dbState.phases.get('phase-1')?.title).toBe('Módulo 1 Blur');

    // Toggle rápido de visibilidade na sidebar envia PATCH imediato
    capturedRequests = [];
    const sidebar = screen.getByTestId('phase-sidebar');
    const toggleVisBtn = within(sidebar).getAllByRole('button', { name: /Alternar visibilidade/i })[0];
    fireEvent.click(toggleVisBtn);

    await waitFor(() => {
      expect(capturedRequests.some((r) => r.method === 'PATCH' && r.url === '/api/phases/phase-1')).toBe(true);
    });
    expect(dbState.phases.get('phase-1')?.icon).toBe('Network:oculta');
  });

  it('Test 4 (Impact Warning + DELETE Granular + Bloqueio 409 da última fase): consulta impacto antes de excluir e preserva demais fases', async () => {
    const phases = buildCurriculum(2, 2); // phase-1 (p1-q1, p1-q2) e phase-2 (p2-q1, p2-q2)
    seedDbWithPhases(phases);

    // 3 submissões de 2 alunos na phase-1; 2 submissões na phase-2
    dbState.submissions.set('s1', { id: 's1', userId: 'aluno-1', questionId: 'p1-q1', isCorrect: true, answer: {} });
    dbState.submissions.set('s2', { id: 's2', userId: 'aluno-1', questionId: 'p1-q2', isCorrect: false, answer: {} });
    dbState.submissions.set('s3', { id: 's3', userId: 'aluno-2', questionId: 'p1-q1', isCorrect: true, answer: {} });
    dbState.submissions.set('s4', { id: 's4', userId: 'aluno-1', questionId: 'p2-q1', isCorrect: true, answer: {} });
    dbState.submissions.set('s5', { id: 's5', userId: 'aluno-2', questionId: 'p2-q2', isCorrect: true, answer: {} });

    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    dbState.queryLog = [];
    capturedRequests = [];

    fireEvent.click(screen.getByRole('button', { name: /Excluir Fase/i }));

    // Modal deve consultar GET /api/phases/phase-1/impact e exibir alerta exato
    const warning = await screen.findByTestId('phase-deletion-impact-warning');
    expect(warning).toHaveTextContent(/3 submissão\(ões\) de 2 aluno\(s\)/i);

    const modal = screen.getByText(/Tem certeza que deseja excluir a fase/i).closest('div')!;
    fireEvent.click(within(modal).getByRole('button', { name: /^Excluir$/i }));

    await waitFor(() => {
      expect(capturedRequests.some((r) => r.method === 'DELETE' && r.url === '/api/phases/phase-1')).toBe(true);
    });

    // Apenas phase-1 foi apagada; phase-2 e suas 2 submissões permanecem intactas
    expect(dbState.phases.has('phase-1')).toBe(false);
    expect(dbState.phases.has('phase-2')).toBe(true);
    expect(dbState.submissions.has('s4')).toBe(true);
    expect(dbState.submissions.has('s5')).toBe(true);
    expect(dbState.queryLog.filter((q) => q.action === 'upsert')).toHaveLength(0);
    expect(dbState.phases.get('phase-2')?.order).toBe(0);
  });

  it('Test 4A (Modal só abre após carregar impacto): não exibe o modal antes da resposta de /impact', async () => {
    const phases = buildCurriculum(2, 2);
    seedDbWithPhases(phases);
    dbState.submissions.set('s1', { id: 's1', userId: 'aluno-1', questionId: 'p1-q1', isCorrect: true, answer: {} });
    dbState.submissions.set('s2', { id: 's2', userId: 'aluno-2', questionId: 'p1-q2', isCorrect: true, answer: {} });

    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    let releaseImpact!: () => void;
    getImpactGate = new Promise<void>((resolve) => {
      releaseImpact = resolve;
    });

    fireEvent.click(screen.getByRole('button', { name: /Excluir Fase/i }));

    // Enquanto /impact está carregando, o modal NÃO deve abrir nem exibir texto incorreto
    expect(screen.queryByText(/Tem certeza que deseja excluir a fase/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('phase-deletion-impact-safe')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Verificando\.\.\./i })).toBeDisabled();

    await act(async () => {
      releaseImpact();
    });

    // Assim que /impact conclui, o modal abre já exibindo o impacto real
    const warning = await screen.findByTestId('phase-deletion-impact-warning');
    expect(warning).toHaveTextContent(/2 submissão\(ões\) de 2 aluno\(s\)/i);
    expect(screen.getByText(/Tem certeza que deseja excluir a fase/i)).toBeInTheDocument();
  });

  it('Test 4B (Proteção 409 no DELETE): se outro professor excluiu as outras fases no servidor, DELETE retorna 409 e re-sincroniza', async () => {
    const phases = buildCurriculum(2, 1);
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    // Outro professor removeu phase-2 direto no banco antes de Prof A confirmar exclusão da phase-1
    deletePhaseWithCascade('phase-2');

    fireEvent.click(screen.getByRole('button', { name: /Excluir Fase/i }));
    await screen.findByTestId('phase-deletion-impact-safe');
    const modal = screen.getByText(/Tem certeza que deseja excluir a fase/i).closest('div')!;
    fireEvent.click(within(modal).getByRole('button', { name: /^Excluir$/i }));

    await waitFor(() => {
      expect(screen.getByText(/pelo menos 1 fase/i)).toBeInTheDocument();
    });
    expect(dbState.phases.has('phase-1')).toBe(true);
  });

  it('Test 5 (Cenário 2A — Reorder Granular + Aba Defasada): reordenar não apaga Fase 6 concorrente nem submissões e sincroniza estado', async () => {
    const phasesV1 = buildCurriculum(5, 2); // Fases 1..5
    seedDbWithPhases(phasesV1);

    // Professor A abre o Editor com V1 (5 fases)
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T19:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phasesV1)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    // Professor B cria a Fase 6 com 3 questões + 5 submissões de alunos no banco
    dbState.phases.set('phase-6', {
      id: 'phase-6',
      title: 'Fase 6 (Professor B)',
      icon: 'Brain',
      order: 5,
    });
    for (let i = 1; i <= 3; i++) {
      dbState.questions.set(`p6-q${i}`, {
        id: `p6-q${i}`,
        phaseId: 'phase-6',
        type: 'FORMALIZACAO',
        topic: 'Predicados',
        enunciado: `Q${i} Fase 6`,
        order: i - 1,
        content: { dicas: [], teclado_virtual: ['∀'], resposta_esperada: '∀x P(x)' },
      });
    }
    for (let s = 1; s <= 5; s++) {
      dbState.submissions.set(`sub-${s}`, {
        id: `sub-${s}`,
        userId: `aluno-${s}`,
        questionId: `p6-q${((s - 1) % 3) + 1}`,
        isCorrect: s % 2 === 0,
        answer: '∀x P(x)',
      });
    }

    dbState.queryLog = [];
    capturedRequests = [];

    // Professor A (aba defasada sem Módulo 6) arrasta phase-1 para a posição de phase-2
    expect(capturedSidebarOnDragEnd).not.toBeNull();
    await act(async () => {
      capturedSidebarOnDragEnd!({ active: { id: 'phase-1' }, over: { id: 'phase-2' } });
    });

    await waitFor(() => {
      expect(capturedRequests.some((r) => r.method === 'PATCH' && r.url === '/api/phases/reorder')).toBe(true);
    });

    const reorderReq = capturedRequests.find((r) => r.method === 'PATCH' && r.url === '/api/phases/reorder')!;
    expect(reorderReq.bodyBytes).toBeLessThan(512);
    expect(reorderReq.bodyJson).toEqual({
      orderedIds: ['phase-2', 'phase-1', 'phase-3', 'phase-4', 'phase-5'],
    });

    // Fase 6, suas 3 questões e TODAS as 5 submissões sobreviveram 100% intactas!
    expect(dbState.phases.has('phase-6')).toBe(true);
    expect(dbState.phases.get('phase-6')?.order).toBe(5);
    expect(dbState.questions.has('p6-q1')).toBe(true);
    expect(dbState.questions.has('p6-q2')).toBe(true);
    expect(dbState.questions.has('p6-q3')).toBe(true);
    expect(dbState.submissions.size).toBe(5);

    // 1 único batch SQL e 0 writes na tabela Question
    expect(dbState.queryLog.filter((q) => q.action === '$executeRaw')).toHaveLength(1);
    expect(dbState.queryLog.filter((q) => q.model === 'question')).toHaveLength(0);
    expect(dbState.queryLog.filter((q) => q.action === 'deleteMany')).toHaveLength(0);

    // Como hasExternalChanges === true, o Editor re-sincronizou e exibiu a Fase 6 do Prof B
    await waitFor(() => {
      const sidebar = screen.getByTestId('phase-sidebar');
      expect(within(sidebar).getByText('Fase 6 (Professor B)')).toBeInTheDocument();
    });
  });

  it('Test 6 (Cenário 2B — Import Granular + Chunking + Sem Falso Positivo): preserva Fase 6, divide lotes >100Q e mostra erro quando falha', async () => {
    const phasesV1 = buildCurriculum(5, 2);
    seedDbWithPhases(phasesV1);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T19:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phasesV1)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    // Professor B cria Fase 6 + submissões no servidor depois que Prof A carregou a aba
    dbState.phases.set('phase-6', { id: 'phase-6', title: 'Fase 6 Segura', icon: 'Brain', order: 5 });
    dbState.questions.set('p6-q1', {
      id: 'p6-q1',
      phaseId: 'phase-6',
      type: 'DIAGRAMACAO',
      topic: 'T',
      enunciado: 'E',
      order: 0,
      content: { frases: [], resposta_esperada: {} },
    });
    dbState.submissions.set('sub-safe', {
      id: 'sub-safe',
      userId: 'aluno-1',
      questionId: 'p6-q1',
      isCorrect: true,
      answer: {},
    });

    // 6A: Importação pequena com aba defasada envia APENAS a fase importada
    dbState.queryLog = [];
    capturedRequests = [];

    const fileInput = screen.getByLabelText(/Selecionar arquivo JSON para importar/i);
    const smallPkg = {
      metadata: {
        version: 1,
        type: 'logica-dinamica:package_export',
        exportedAt: '2026-11-21T20:00:00.000Z',
      },
      phases: [{ titulo: 'Fase Importada Única', icone: 'Target', originalQuestionIds: ['imp-q1', 'imp-q2'] }],
      questions: [
        { ...makeQuestion('imp-q1', 1), originalId: 'imp-q1' },
        { ...makeQuestion('imp-q2', 2), originalId: 'imp-q2' },
      ],
    };
    fireEvent.change(fileInput, {
      target: { files: [new File([JSON.stringify(smallPkg)], 'small.json', { type: 'application/json' })] },
    });

    await waitFor(() => {
      expect(screen.getByText(/1 fase\(s\) e 2 questão\(ões\) importada\(s\) e salvas no banco com sucesso!/i)).toBeInTheDocument();
    });

    const importRequests = capturedRequests.filter((r) => r.method === 'POST' && r.url === '/api/phases/import');
    expect(importRequests).toHaveLength(1);
    expect((importRequests[0].bodyJson?.phases as Phase[])).toHaveLength(1);
    expect(dbState.phases.has('phase-6')).toBe(true);
    expect(dbState.submissions.has('sub-safe')).toBe(true);
    expect(dbState.queryLog.filter((q) => q.action === 'deleteMany')).toHaveLength(0);

    // 6B: Importação grande (3 fases x 45 questões = 135 questões) divide em 2 chunks sequenciais
    capturedRequests = [];
    const largePhases = Array.from({ length: 3 }, (_, pIdx) => ({
      titulo: `Lote Fase ${pIdx + 1}`,
      icone: 'Brain',
      originalQuestionIds: Array.from({ length: 45 }, (_, qIdx) => `big-${pIdx}-${qIdx}`),
    }));
    const largeQuestions = largePhases.flatMap((p, pIdx) =>
      p.originalQuestionIds.map((origId, qIdx) => ({
        ...makeQuestion(origId, qIdx + 1),
        originalId: origId,
      }))
    );
    const largePkg = {
      metadata: {
        version: 1,
        type: 'logica-dinamica:package_export',
        exportedAt: '2026-11-21T20:05:00.000Z',
      },
      phases: largePhases,
      questions: largeQuestions,
    };

    fireEvent.change(fileInput, {
      target: { files: [new File([JSON.stringify(largePkg)], 'large.json', { type: 'application/json' })] },
    });

    await waitFor(() => {
      expect(screen.getByText(/3 fase\(s\) e 135 questão\(ões\) importada\(s\) e salvas no banco com sucesso!/i)).toBeInTheDocument();
    });

    const chunkReqs = capturedRequests.filter((r) => r.method === 'POST' && r.url === '/api/phases/import');
    expect(chunkReqs).toHaveLength(2);
    expect((chunkReqs[0].bodyJson?.phases as Phase[])).toHaveLength(2);
    expect((chunkReqs[1].bodyJson?.phases as Phase[])).toHaveLength(1);

    // 6C: Falha no servidor NÃO exibe toast de sucesso falso-positivo
    forceImportFailure = true;
    const failPkg = {
      metadata: {
        version: 1,
        type: 'logica-dinamica:package_export',
        exportedAt: '2026-11-21T20:10:00.000Z',
      },
      phases: [{ titulo: 'Fase Falha', icone: 'Network', originalQuestionIds: ['fail-q1'] }],
      questions: [{ ...makeQuestion('fail-q1', 1), originalId: 'fail-q1' }],
    };
    fireEvent.change(fileInput, {
      target: { files: [new File([JSON.stringify(failPkg)], 'fail.json', { type: 'application/json' })] },
    });

    await waitFor(() => {
      expect(screen.getByText(/Falha simulada no lote de importação/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Fase Falha.*salvas no banco com sucesso/i)).not.toBeInTheDocument();
  });

  it('Test 7 (Re-sync no Foco da Aba): atualiza lista quando outro professor cria fase e ignora quando há modal aberto', async () => {
    const phases = buildCurriculum(2, 1);
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    let timeOffsetMs = 0;
    const realDateNow = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => realDateNow() + timeOffsetMs);

    let currentVisibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => currentVisibility,
    });

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    // Outro professor adiciona Fase 3 no banco
    dbState.phases.set('phase-3', { id: 'phase-3', title: 'Fase 3 Externa', icon: 'Lightbulb', order: 2 });

    // Enquanto modal de criação está aberto, retorno à aba NÃO deve disparar GET /api/phases
    fireEvent.click(screen.getByRole('button', { name: /Nova Fase/i }));
    await screen.findByPlaceholderText(/Nome da fase/i);

    capturedRequests = [];
    timeOffsetMs += 10000;
    currentVisibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(capturedRequests.filter((r) => r.method === 'GET' && r.url === '/api/phases')).toHaveLength(0);

    // Fecha modal -> dispara visibilitychange após cooldown -> deve re-sincronizar e exibir Fase 3 Externa
    fireEvent.click(screen.getByRole('button', { name: /Cancelar/i }));
    timeOffsetMs += 10000;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => {
      const sidebar = screen.getByTestId('phase-sidebar');
      expect(within(sidebar).getByText('Fase 3 Externa')).toBeInTheDocument();
    });
  });

  it('Test 8 (Bug 1 — Troca de fase durante /impact): reseta botão "Verificando..." e cancela modal obsoleto', async () => {
    const phases = buildCurriculum(2, 1);
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    let releaseImpact!: () => void;
    getImpactGate = new Promise<void>((resolve) => {
      releaseImpact = resolve;
    });

    fireEvent.click(screen.getByRole('button', { name: /Excluir Fase/i }));
    expect(screen.getByRole('button', { name: /Verificando\.\.\./i })).toBeDisabled();

    // Troca para Módulo 2 antes do /impact da Módulo 1 retornar
    const sidebar = screen.getByTestId('phase-sidebar');
    fireEvent.click(within(sidebar).getByText('Módulo 2'));

    // Botão da nova fase NÃO deve permanecer travado em "Verificando..."
    const deleteBtn = screen.getByRole('button', { name: /Excluir Fase/i });
    expect(deleteBtn).toBeEnabled();

    await act(async () => {
      releaseImpact();
    });

    // Modal da fase antiga NÃO deve abrir sobre a nova fase
    expect(screen.queryByText(/Tem certeza que deseja excluir a fase/i)).not.toBeInTheDocument();
  });

  it('Test 9 (Bug 2 — Corrida criação otimista vs PATCH imediato): PATCH aguarda POST da nova fase concluir sem gerar 404', async () => {
    const phases = buildCurriculum(1, 1);
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    let releasePost!: () => void;
    postPhaseGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    capturedRequests = [];

    fireEvent.click(screen.getByRole('button', { name: /Nova Fase/i }));
    const nomeInput = await screen.findByPlaceholderText(/Nome da fase/i);
    await userEvent.type(nomeInput, 'Fase Corrida');
    fireEvent.click(screen.getByRole('button', { name: /^Criar$/i }));

    // Enquanto POST ainda está pendente, alterna visibilidade da fase recém-criada
    const sidebar = screen.getByTestId('phase-sidebar');
    expect(within(sidebar).getByText('Fase Corrida')).toBeInTheDocument();
    const toggleBtns = within(sidebar).getAllByRole('button', { name: /Alternar visibilidade/i });
    fireEvent.click(toggleBtns[1]);

    // PATCH NÃO deve disparar antes do POST concluir
    expect(capturedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);

    await act(async () => {
      releasePost();
    });

    await waitFor(() => {
      expect(capturedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    });

    // Sem falso 404, a fase permanece visível na sidebar e oculta no banco
    expect(within(sidebar).getByText('Fase Corrida')).toBeInTheDocument();
    expect(screen.queryByText(/excluída em outra sessão/i)).not.toBeInTheDocument();
    const createdDbPhase = Array.from(dbState.phases.values()).find((p) => p.title === 'Fase Corrida');
    expect(createdDbPhase?.icon).toBe('Network:oculta');
  });

  it('Test 10 (Bug 3 — PUT cancela PATCH debounced pendente): reordenar/editar questão não dispara PATCH redundante após PUT', async () => {
    const phases = buildCurriculum(1, 2);
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    capturedRequests = [];
    const titleInput = screen.getByDisplayValue('Módulo 1');

    jest.useFakeTimers();
    act(() => {
      fireEvent.change(titleInput, { target: { value: 'Módulo 1 Via PUT' } });
    });

    // Antes do debounce de 500ms vencer, altera visibilidade de uma questão (dispara PUT /api/phases/phase-1)
    fireEvent.click(screen.getAllByTitle(/Ocultar questão/i)[0]);

    act(() => {
      jest.advanceTimersByTime(600);
    });
    jest.useRealTimers();

    await waitFor(() => {
      expect(capturedRequests.filter((r) => r.method === 'PUT' && r.url === '/api/phases/phase-1')).toHaveLength(1);
    });

    expect(capturedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    expect(dbState.phases.get('phase-1')?.title).toBe('Módulo 1 Via PUT');
  });

  it('Test 11 (Bug 4 — Falha parcial na importação multi-lote): informa quantas fases já foram salvas antes da falha', async () => {
    const phases = buildCurriculum(1, 1);
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    render(<EditorPage />);
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    failImportOnCall = 2; // Lote 1 (2 fases) salva; Lote 2 (1 fase) falha
    const largePhases = Array.from({ length: 3 }, (_, pIdx) => ({
      titulo: `Lote Parcial ${pIdx + 1}`,
      icone: 'Brain',
      originalQuestionIds: Array.from({ length: 45 }, (_, qIdx) => `part-${pIdx}-${qIdx}`),
    }));
    const largeQuestions = largePhases.flatMap((p) =>
      p.originalQuestionIds.map((origId, qIdx) => ({
        ...makeQuestion(origId, qIdx + 1),
        originalId: origId,
      }))
    );

    const fileInput = screen.getByLabelText(/Selecionar arquivo JSON para importar/i);
    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(
            [
              JSON.stringify({
                metadata: {
                  version: 1,
                  type: 'logica-dinamica:package_export',
                  exportedAt: '2026-11-23T15:00:00.000Z',
                },
                phases: largePhases,
                questions: largeQuestions,
              }),
            ],
            'partial-fail.json',
            { type: 'application/json' }
          ),
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/2 fase\(s\) já haviam sido salvas/i)).toBeInTheDocument();
    });

    const sidebar = screen.getByTestId('phase-sidebar');
    expect(within(sidebar).getByText('Lote Parcial 1')).toBeInTheDocument();
    expect(within(sidebar).getByText('Lote Parcial 2')).toBeInTheDocument();
    expect(within(sidebar).queryByText('Lote Parcial 3')).not.toBeInTheDocument();
  });

  it('Test 12 (Melhorias menores — dragOver bloqueado + aviso título em branco no blur)', async () => {
    const phases = buildCurriculum(1, 1);
    seedDbWithPhases(phases);
    (loadEditorState as jest.Mock).mockReturnValue({
      version: 1,
      updatedAt: '2026-11-21T20:00:00.000Z',
      phases: JSON.parse(JSON.stringify(phases)),
    } satisfies EditorState);

    let releaseGate!: () => void;
    getPhasesGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    render(<EditorPage />);

    // Durante hidratação inicial, dragOver de arquivo não exibe overlay de drop
    fireEvent.dragOver(screen.getByTestId('phase-sidebar'), {
      dataTransfer: { types: ['Files'] },
    });
    expect(screen.queryByText(/Solte o arquivo \.json aqui/i)).not.toBeInTheDocument();

    await act(async () => {
      releaseGate();
    });
    await waitFor(() => {
      expect(screen.getByText(/^Sincronizado$/i)).toBeInTheDocument();
    });

    capturedRequests = [];
    const titleInput = screen.getByDisplayValue('Módulo 1');
    fireEvent.change(titleInput, { target: { value: '   ' } });
    fireEvent.blur(titleInput);

    await waitFor(() => {
      expect(screen.getByText(/título da fase não pode ficar em branco/i)).toBeInTheDocument();
    });
    expect(capturedRequests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });
});
