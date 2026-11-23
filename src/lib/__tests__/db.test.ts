import {
  getPhasesFromDb,
  syncSinglePhaseToDb,
  createPhaseInDb,
  updatePhaseMetadataInDb,
  getPhaseDeletionImpact,
  deletePhaseFromDb,
  reorderPhasesInDb,
  importPhasesToDb,
  PhaseNotFoundError,
  LastPhaseDeletionError,
  DuplicatePhaseError,
  getUserSubmissions,
  saveUserSubmission,
} from '@/lib/db';
import * as dbModule from '@/lib/db';
import { prisma } from '@/lib/prisma';
import type { Phase, DiagramacaoQuestion, MultiplaEscolhaQuestion } from '@/types';

jest.mock('@/lib/prisma', () => ({
  prisma: {
    phase: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    submission: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

describe('db.ts (Neon PostgreSQL Service)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removeu completamente a função monolítica destrutiva syncPhasesToDb', () => {
    expect((dbModule as Record<string, unknown>).syncPhasesToDb).toBeUndefined();
  });

  describe('getPhasesFromDb()', () => {
    it('carrega fases e questões ordenadas corretamente do banco', async () => {
      (prisma.phase.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'fase-1',
          title: 'Diagramação',
          icon: 'Network',
          order: 0,
          questions: [
            {
              id: 'q-1',
              type: 'DIAGRAMACAO',
              topic: 'Argumentos',
              enunciado: 'Classifique as frases',
              order: 0,
              content: {
                frases: [{ id: '1', texto: 'A' }],
                resposta_esperada: { '1': 'P' },
              },
            },
          ],
        },
      ]);

      const result = await getPhasesFromDb();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('fase-1');
      expect(result[0].titulo).toBe('Diagramação');
      expect(result[0].icone).toBe('Network');
      expect(result[0].questoes).toHaveLength(1);
      expect(result[0].questoes[0].tipo).toBe('diagramacao');
      expect((result[0].questoes[0] as DiagramacaoQuestion).frases).toEqual([{ id: '1', texto: 'A' }]);
    });

    it('reconhece a flag de fase oculta persistida no icon', async () => {
      (prisma.phase.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'fase-oculta',
          title: 'Fase Oculta',
          icon: 'Table2:oculta',
          order: 0,
          questions: [],
        },
      ]);

      const result = await getPhasesFromDb();
      expect(result[0].icone).toBe('Table2');
      expect(result[0].oculta).toBe(true);
    });
  });

  describe('createPhaseInDb()', () => {
    it('cria a primeira fase com order 0 quando o banco está vazio', async () => {
      const mockTx = {
        phase: {
          aggregate: jest.fn().mockResolvedValue({ _max: { order: null } }),
          create: jest.fn().mockResolvedValue({ id: 'fase-1', order: 0 }),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      const result = await createPhaseInDb({
        id: 'fase-1',
        titulo: 'Fase Inicial',
        icone: 'Network',
      });

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 10000,
        timeout: 15000,
      });
      expect(mockTx.phase.aggregate).toHaveBeenCalledWith({ _max: { order: true } });
      expect(mockTx.phase.create).toHaveBeenCalledWith({
        data: {
          id: 'fase-1',
          title: 'Fase Inicial',
          icon: 'Network',
          order: 0,
        },
      });
      expect(result).toEqual({ id: 'fase-1', order: 0 });
    });

    it('calcula nextOrder como _max.order + 1 mesmo quando há lacunas e codifica :oculta', async () => {
      const mockTx = {
        phase: {
          aggregate: jest.fn().mockResolvedValue({ _max: { order: 4 } }),
          create: jest.fn().mockResolvedValue({ id: 'fase-nova', order: 5 }),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      const result = await createPhaseInDb({
        id: 'fase-nova',
        titulo: 'Revisão Oculta',
        icone: 'Table2',
        oculta: true,
      });

      expect(mockTx.phase.create).toHaveBeenCalledWith({
        data: {
          id: 'fase-nova',
          title: 'Revisão Oculta',
          icon: 'Table2:oculta',
          order: 5,
        },
      });
      expect(result).toEqual({ id: 'fase-nova', order: 5 });
    });

    it('lança DuplicatePhaseError quando Prisma retorna erro P2002', async () => {
      const mockTx = {
        phase: {
          aggregate: jest.fn().mockResolvedValue({ _max: { order: 1 } }),
          create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      await expect(
        createPhaseInDb({ id: 'fase-dup', titulo: 'Duplicada', icone: 'Network' })
      ).rejects.toThrow(DuplicatePhaseError);
    });
  });

  describe('updatePhaseMetadataInDb()', () => {
    it('atualiza apenas título, ícone e visibilidade da fase alvo sem tocar na tabela Question', async () => {
      (prisma.phase.update as jest.Mock).mockResolvedValue({ id: 'fase-1' });

      await updatePhaseMetadataInDb({
        id: 'fase-1',
        titulo: 'Novo Título',
        icone: 'Brain',
        oculta: true,
      });

      expect(prisma.phase.update).toHaveBeenCalledWith({
        where: { id: 'fase-1' },
        data: {
          title: 'Novo Título',
          icon: 'Brain:oculta',
        },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lança PhaseNotFoundError quando Prisma retorna P2025', async () => {
      (prisma.phase.update as jest.Mock).mockRejectedValue({ code: 'P2025' });

      await expect(
        updatePhaseMetadataInDb({
          id: 'fase-inexistente',
          titulo: 'Teste',
          icone: 'Network',
        })
      ).rejects.toThrow(PhaseNotFoundError);
    });
  });

  describe('getPhaseDeletionImpact()', () => {
    it('retorna contagem de questões, submissões e alunos distintos afetados', async () => {
      (prisma.phase.findUnique as jest.Mock).mockResolvedValue({
        id: 'fase-1',
        _count: { questions: 4 },
      });
      (prisma.submission.count as jest.Mock).mockResolvedValue(15);
      (prisma.submission.groupBy as jest.Mock).mockResolvedValue([
        { userId: 'u1' },
        { userId: 'u2' },
        { userId: 'u3' },
      ]);

      const impact = await getPhaseDeletionImpact('fase-1');

      expect(prisma.phase.findUnique).toHaveBeenCalledWith({
        where: { id: 'fase-1' },
        select: { id: true, _count: { select: { questions: true } } },
      });
      expect(prisma.submission.count).toHaveBeenCalledWith({
        where: { question: { phaseId: 'fase-1' } },
      });
      expect(prisma.submission.groupBy).toHaveBeenCalledWith({
        by: ['userId'],
        where: { question: { phaseId: 'fase-1' } },
      });
      expect(impact).toEqual({
        phaseId: 'fase-1',
        questionsCount: 4,
        submissionsCount: 15,
        studentsAffectedCount: 3,
      });
    });

    it('retorna null quando a fase não existe no banco', async () => {
      (prisma.phase.findUnique as jest.Mock).mockResolvedValue(null);

      const impact = await getPhaseDeletionImpact('fase-ausente');
      expect(impact).toBeNull();
      expect(prisma.submission.count).not.toHaveBeenCalled();
    });
  });

  describe('deletePhaseFromDb()', () => {
    it('lança PhaseNotFoundError quando a fase não existe', async () => {
      const mockTx = {
        phase: {
          findUnique: jest.fn().mockResolvedValue(null),
          count: jest.fn(),
          delete: jest.fn(),
          updateMany: jest.fn(),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      await expect(deletePhaseFromDb('fase-ausente')).rejects.toThrow(PhaseNotFoundError);
      expect(mockTx.phase.delete).not.toHaveBeenCalled();
    });

    it('lança LastPhaseDeletionError e bloqueia exclusão quando resta apenas 1 fase', async () => {
      const mockTx = {
        phase: {
          findUnique: jest.fn().mockResolvedValue({ id: 'fase-unica', order: 0 }),
          count: jest.fn().mockResolvedValue(1),
          delete: jest.fn(),
          updateMany: jest.fn(),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      await expect(deletePhaseFromDb('fase-unica')).rejects.toThrow(LastPhaseDeletionError);
      expect(mockTx.phase.delete).not.toHaveBeenCalled();
    });

    it('exclui apenas a fase alvo e compacta a ordem das fases posteriores', async () => {
      const mockTx = {
        phase: {
          findUnique: jest.fn().mockResolvedValue({ id: 'fase-2', order: 1 }),
          count: jest.fn().mockResolvedValue(4),
          delete: jest.fn().mockResolvedValue({ id: 'fase-2' }),
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      const result = await deletePhaseFromDb('fase-2');

      expect(mockTx.phase.delete).toHaveBeenCalledWith({ where: { id: 'fase-2' } });
      expect(mockTx.phase.updateMany).toHaveBeenCalledWith({
        where: { order: { gt: 1 } },
        data: { order: { decrement: 1 } },
      });
      expect(result).toEqual({ deletedId: 'fase-2', remainingCount: 3 });
    });
  });

  describe('reorderPhasesInDb()', () => {
    it('executa merge seguro preservando fase criada externamente e atualiza apenas order em 1 $executeRaw', async () => {
      const mockTx = {
        phase: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'p1', order: 0 },
            { id: 'p2', order: 1 },
            { id: 'p3', order: 2 }, // criada por outro professor
          ]),
          deleteMany: jest.fn(),
        },
        $executeRaw: jest.fn().mockResolvedValue(2),
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      // Cliente defasado reordena p2 antes de p1 sem conhecer p3
      const result = await reorderPhasesInDb(['p2', 'p1']);

      expect(result).toEqual({
        orderedIds: ['p2', 'p1', 'p3'],
        hasExternalChanges: true,
      });
      expect(mockTx.phase.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      const rawArg = mockTx.$executeRaw.mock.calls[0][0];
      expect(rawArg.values).toEqual(['p2', 0, 'p1', 1]);
      expect(rawArg.strings.join('?')).toMatch(/::text.*::int/);
    });

    it('ignora IDs removidos por outro professor, sinaliza hasExternalChanges e deduplica entrada', async () => {
      const mockTx = {
        phase: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'p1', order: 0 },
            { id: 'p3', order: 1 },
            { id: 'p4', order: 2 },
          ]),
        },
        $executeRaw: jest.fn().mockResolvedValue(3),
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      const result = await reorderPhasesInDb(['p3', 'p3', 'p-removida', 'p1']);

      expect(result).toEqual({
        orderedIds: ['p3', 'p1', 'p4'],
        hasExternalChanges: true,
      });
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      const rawArg = mockTx.$executeRaw.mock.calls[0][0];
      expect(rawArg.values).toEqual(['p3', 0, 'p1', 1]);
    });

    it('não executa $executeRaw quando nenhuma ordem foi alterada', async () => {
      const mockTx = {
        phase: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'p1', order: 0 },
            { id: 'p2', order: 1 },
          ]),
        },
        $executeRaw: jest.fn(),
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      const result = await reorderPhasesInDb(['p1', 'p2']);

      expect(result).toEqual({
        orderedIds: ['p1', 'p2'],
        hasExternalChanges: false,
      });
      expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('importPhasesToDb()', () => {
    it('retorna zeros sem abrir transação quando a lista de fases é vazia', async () => {
      const result = await importPhasesToDb([]);
      expect(result).toEqual({
        importedPhasesCount: 0,
        importedQuestionsCount: 0,
        phaseOrders: [],
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('importa fases e questões em lote com createMany preservando fases existentes (sem deleteMany)', async () => {
      const mockTx = {
        phase: {
          aggregate: jest.fn().mockResolvedValue({ _max: { order: 2 } }),
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
          deleteMany: jest.fn(),
        },
        question: {
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
          deleteMany: jest.fn(),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      const mcQuestion: MultiplaEscolhaQuestion = {
        id: 'q-mc',
        tipo: 'multipla_escolha',
        topico: 'Tautologias',
        enunciado: 'Qual é tautologia?',
        opcoes: [
          { id: 'o1', texto: 'P ∨ ~P' },
          { id: 'o2', texto: 'P ∧ ~P' },
        ],
        resposta_esperada: 'o1',
      };

      const phasesToImport: Phase[] = [
        {
          id: 'imp-1',
          titulo: 'Fase Importada 1',
          icone: 'Brain',
          oculta: true,
          questoes: [
            {
              id: 'q-diag',
              tipo: 'diagramacao',
              topico: 'Premissas',
              enunciado: 'Classifique',
              frases: [],
              resposta_esperada: {},
            },
            mcQuestion,
          ],
        },
        {
          id: 'imp-2',
          titulo: 'Fase Importada 2 (Vazia)',
          icone: 'Target',
          questoes: [],
        },
      ];

      const result = await importPhasesToDb(phasesToImport);

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 10000,
        timeout: 30000,
      });
      expect(mockTx.phase.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.question.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.phase.createMany).toHaveBeenCalledWith({
        data: [
          { id: 'imp-1', title: 'Fase Importada 1', icon: 'Brain:oculta', order: 3 },
          { id: 'imp-2', title: 'Fase Importada 2 (Vazia)', icon: 'Target', order: 4 },
        ],
      });
      expect(mockTx.question.createMany).toHaveBeenCalledWith({
        data: [
          {
            id: 'q-diag',
            phaseId: 'imp-1',
            type: 'DIAGRAMACAO',
            topic: 'Premissas',
            enunciado: 'Classifique',
            order: 0,
            content: { frases: [], resposta_esperada: {} },
          },
          {
            id: 'q-mc',
            phaseId: 'imp-1',
            type: 'MULTIPLA_ESCOLHA',
            topic: 'Tautologias',
            enunciado: 'Qual é tautologia?',
            order: 1,
            content: {
              opcoes: [
                { id: 'o1', texto: 'P ∨ ~P' },
                { id: 'o2', texto: 'P ∧ ~P' },
              ],
              resposta_esperada: 'o1',
            },
          },
        ],
      });
      expect(result).toEqual({
        importedPhasesCount: 2,
        importedQuestionsCount: 2,
        phaseOrders: [
          { id: 'imp-1', order: 3 },
          { id: 'imp-2', order: 4 },
        ],
      });
    });

    it('não chama question.createMany quando as fases importadas não têm questões', async () => {
      const mockTx = {
        phase: {
          aggregate: jest.fn().mockResolvedValue({ _max: { order: null } }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        question: {
          createMany: jest.fn(),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      const result = await importPhasesToDb([
        { id: 'imp-empty', titulo: 'Vazia', icone: 'Network', questoes: [] },
      ]);

      expect(mockTx.phase.createMany).toHaveBeenCalledTimes(1);
      expect(mockTx.question.createMany).not.toHaveBeenCalled();
      expect(result).toEqual({
        importedPhasesCount: 1,
        importedQuestionsCount: 0,
        phaseOrders: [{ id: 'imp-empty', order: 0 }],
      });
    });

    it('lança DuplicatePhaseError quando Prisma retorna P2002 na importação', async () => {
      const mockTx = {
        phase: {
          aggregate: jest.fn().mockResolvedValue({ _max: { order: 0 } }),
          createMany: jest.fn().mockRejectedValue({ code: 'P2002' }),
        },
        question: {
          createMany: jest.fn(),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(mockTx));

      await expect(
        importPhasesToDb([{ id: 'dup-id', titulo: 'Duplicada', icone: 'Network', questoes: [] }])
      ).rejects.toThrow(DuplicatePhaseError);
    });
  });

  describe('syncSinglePhaseToDb()', () => {
    it('sincroniza uma única fase preservando a ordem existente e atualizando questões', async () => {
      const mockTx = {
        phase: {
          findUnique: jest.fn().mockResolvedValue({ order: 2 }),
          aggregate: jest.fn(),
          upsert: jest.fn(),
        },
        question: {
          deleteMany: jest.fn(),
          upsert: jest.fn(),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        return callback(mockTx);
      });

      const phase: Phase = {
        id: 'fase-2',
        titulo: 'Fase 2 Atualizada',
        icone: 'Table2',
        questoes: [
          {
            id: 'q-2',
            tipo: 'diagramacao',
            topico: 'Premissas',
            enunciado: 'Enunciado 2',
            frases: [],
            resposta_esperada: {},
          },
        ],
      };

      await syncSinglePhaseToDb(phase);

      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { maxWait: 10000, timeout: 30000 }
      );

      expect(mockTx.phase.findUnique).toHaveBeenCalledWith({
        where: { id: 'fase-2' },
        select: { order: true },
      });

      expect(mockTx.phase.upsert).toHaveBeenCalledWith({
        where: { id: 'fase-2' },
        update: { title: 'Fase 2 Atualizada', icon: 'Table2', order: 2 },
        create: { id: 'fase-2', title: 'Fase 2 Atualizada', icon: 'Table2', order: 2 },
      });

      expect(mockTx.question.deleteMany).toHaveBeenCalledWith({
        where: { phaseId: 'fase-2', id: { notIn: ['q-2'] } },
      });

      expect(mockTx.question.upsert).toHaveBeenCalledWith({
        where: { id: 'q-2' },
        update: {
          phaseId: 'fase-2',
          type: 'DIAGRAMACAO',
          topic: 'Premissas',
          enunciado: 'Enunciado 2',
          order: 0,
          content: { frases: [], resposta_esperada: {} },
        },
        create: {
          id: 'q-2',
          phaseId: 'fase-2',
          type: 'DIAGRAMACAO',
          topic: 'Premissas',
          enunciado: 'Enunciado 2',
          order: 0,
          content: { frases: [], resposta_esperada: {} },
        },
      });
    });

    it('calcula nova ordem via _max.order + 1 para fase inédita e remove todas as questões se a lista estiver vazia', async () => {
      const mockTx = {
        phase: {
          findUnique: jest.fn().mockResolvedValue(null),
          aggregate: jest.fn().mockResolvedValue({ _max: { order: 4 } }),
          upsert: jest.fn(),
        },
        question: {
          deleteMany: jest.fn(),
          upsert: jest.fn(),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        return callback(mockTx);
      });

      const phase: Phase = {
        id: 'fase-nova',
        titulo: 'Fase Inédita',
        icone: 'PenLine',
        questoes: [],
      };

      await syncSinglePhaseToDb(phase);

      expect(mockTx.phase.aggregate).toHaveBeenCalledWith({ _max: { order: true } });
      expect(mockTx.phase.upsert).toHaveBeenCalledWith({
        where: { id: 'fase-nova' },
        update: { title: 'Fase Inédita', icon: 'PenLine', order: 5 },
        create: { id: 'fase-nova', title: 'Fase Inédita', icon: 'PenLine', order: 5 },
      });

      expect(mockTx.question.deleteMany).toHaveBeenCalledWith({
        where: { phaseId: 'fase-nova' },
      });
      expect(mockTx.question.upsert).not.toHaveBeenCalled();
    });

    it('persiste a flag :oculta no icon quando a fase for oculta', async () => {
      const mockTx = {
        phase: {
          findUnique: jest.fn().mockResolvedValue({ order: 2 }),
          upsert: jest.fn(),
        },
        question: {
          deleteMany: jest.fn(),
          upsert: jest.fn(),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => {
        return callback(mockTx);
      });

      const phase: Phase = {
        id: 'fase-1',
        titulo: 'Fase 1',
        icone: 'PenLine',
        oculta: true,
        questoes: [],
      };

      await syncSinglePhaseToDb(phase);

      expect(mockTx.phase.upsert).toHaveBeenCalledWith({
        where: { id: 'fase-1' },
        update: { title: 'Fase 1', icon: 'PenLine:oculta', order: 2 },
        create: { id: 'fase-1', title: 'Fase 1', icon: 'PenLine:oculta', order: 2 },
      });
    });
  });

  describe('getUserSubmissions()', () => {
    it('retorna a lista de submissões do usuário', async () => {
      (prisma.submission.findMany as jest.Mock).mockResolvedValue([
        { questionId: 'q-1', isCorrect: true, answer: { f1: 'P' } },
      ]);

      const subs = await getUserSubmissions('user-1');
      expect(subs).toHaveLength(1);
      expect(subs[0].questionId).toBe('q-1');
      expect(prisma.submission.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: {
          questionId: true,
          isCorrect: true,
          answer: true,
        },
      });
    });
  });

  describe('saveUserSubmission()', () => {
    it('executa criação atômica da submissão com userId e questionId', async () => {
      (prisma.submission.create as jest.Mock).mockResolvedValue({});

      await saveUserSubmission({
        userId: 'user-1',
        questionId: 'q-1',
        isCorrect: true,
        answer: { f1: 'P' },
      });

      expect(prisma.submission.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          questionId: 'q-1',
          isCorrect: true,
          answer: { f1: 'P' },
        },
      });
    });
  });
});
