jest.mock('next-auth', () => ({
  getServerSession: jest.fn(),
}));

jest.mock('@/lib/auth', () => ({
  authOptions: {},
}));

jest.mock('@/lib/db', () => ({
  getPhaseDeletionImpact: jest.fn(),
  reorderPhasesInDb: jest.fn(),
  importPhasesToDb: jest.fn(),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, init) => ({
      status: init?.status || 200,
      json: async () => data,
    })),
  },
}));

import { GET as getImpact } from '@/app/api/phases/[id]/impact/route';
import { PATCH as patchReorder } from '@/app/api/phases/reorder/route';
import { POST as postImport } from '@/app/api/phases/import/route';
import { getPhaseDeletionImpact, reorderPhasesInDb, importPhasesToDb } from '@/lib/db';
import { getServerSession } from 'next-auth';

describe('Rotas estruturais de Fases (/impact, /reorder, /import)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEACHER_EMAILS = 'prof@teste.com';
  });

  describe('GET /api/phases/[id]/impact', () => {
    it('retorna 403 se o usuário não for professor', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'aluno@teste.com', role: 'STUDENT' },
      });

      const res = await getImpact({} as Request, { params: Promise.resolve({ id: 'f-1' }) });
      expect(res.status).toBe(403);
      expect(getPhaseDeletionImpact).not.toHaveBeenCalled();
    });

    it('retorna 404 se a fase não existir no banco', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (getPhaseDeletionImpact as jest.Mock).mockResolvedValue(null);

      const res = await getImpact({} as Request, { params: Promise.resolve({ id: 'f-404' }) });
      expect(res.status).toBe(404);
    });

    it('retorna 200 com o impacto de exclusão da fase', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (getPhaseDeletionImpact as jest.Mock).mockResolvedValue({
        phaseId: 'f-1',
        questionsCount: 3,
        submissionsCount: 12,
        studentsAffectedCount: 4,
      });

      const res = await getImpact({} as Request, { params: Promise.resolve({ id: 'f-1' }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        phaseId: 'f-1',
        questionsCount: 3,
        submissionsCount: 12,
        studentsAffectedCount: 4,
      });
    });

    it('retorna 500 se ocorrer falha inesperada', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (getPhaseDeletionImpact as jest.Mock).mockRejectedValue(new Error('Erro Neon'));

      const res = await getImpact({} as Request, { params: Promise.resolve({ id: 'f-1' }) });
      expect(res.status).toBe(500);
    });
  });

  describe('PATCH /api/phases/reorder', () => {
    it('retorna 403 se o usuário não for professor', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'aluno@teste.com', role: 'STUDENT' },
      });

      const mockReq = { json: async () => ({ orderedIds: ['f-2', 'f-1'] }) } as unknown as Request;
      const res = await patchReorder(mockReq);
      expect(res.status).toBe(403);
      expect(reorderPhasesInDb).not.toHaveBeenCalled();
    });

    it('retorna 400 para orderedIds ausente, vazio ou com itens inválidos', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });

      const invalidBodies = [{}, { orderedIds: [] }, { orderedIds: ['f-1', ''] }, { orderedIds: [123] }];
      for (const body of invalidBodies) {
        const mockReq = { json: async () => body } as unknown as Request;
        const res = await patchReorder(mockReq);
        expect(res.status).toBe(400);
      }

      expect(reorderPhasesInDb).not.toHaveBeenCalled();
    });

    it('executa reorderPhasesInDb e retorna 200 com orderedIds e hasExternalChanges', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (reorderPhasesInDb as jest.Mock).mockResolvedValue({
        orderedIds: ['f-2', 'f-1', 'f-3'],
        hasExternalChanges: true,
      });

      const mockReq = { json: async () => ({ orderedIds: ['f-2', 'f-1'] }) } as unknown as Request;
      const res = await patchReorder(mockReq);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        orderedIds: ['f-2', 'f-1', 'f-3'],
        hasExternalChanges: true,
      });
      expect(reorderPhasesInDb).toHaveBeenCalledWith(['f-2', 'f-1']);
    });

    it('retorna 500 se reorderPhasesInDb falhar', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (reorderPhasesInDb as jest.Mock).mockRejectedValue(new Error('Erro no banco'));

      const mockReq = { json: async () => ({ orderedIds: ['f-1', 'f-2'] }) } as unknown as Request;
      const res = await patchReorder(mockReq);
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/phases/import', () => {
    it('retorna 403 se o usuário não for professor', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'aluno@teste.com', role: 'STUDENT' },
      });

      const mockReq = {
        json: async () => ({
          phases: [{ id: 'imp-1', titulo: 'Importada', icone: 'Brain', questoes: [] }],
        }),
      } as unknown as Request;
      const res = await postImport(mockReq);
      expect(res.status).toBe(403);
      expect(importPhasesToDb).not.toHaveBeenCalled();
    });

    it('retorna 400 se phases estiver ausente, vazio ou malformado', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });

      const invalidBodies = [
        {},
        { phases: [] },
        { phases: [{ id: '', titulo: 'Sem ID', icone: 'Network', questoes: [] }] },
        { phases: [{ id: 'p1', titulo: 'Sem Questões Array', icone: 'Network' }] },
      ];

      for (const body of invalidBodies) {
        const mockReq = { json: async () => body } as unknown as Request;
        const res = await postImport(mockReq);
        expect(res.status).toBe(400);
      }

      expect(importPhasesToDb).not.toHaveBeenCalled();
    });

    it('importa fases via importPhasesToDb e retorna 201', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (importPhasesToDb as jest.Mock).mockResolvedValue({
        importedPhasesCount: 1,
        importedQuestionsCount: 2,
        phaseOrders: [{ id: 'imp-1', order: 5 }],
      });

      const phases = [{ id: 'imp-1', titulo: 'Importada', icone: 'Brain', questoes: [] }];
      const mockReq = { json: async () => ({ phases }) } as unknown as Request;
      const res = await postImport(mockReq);

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        importedPhasesCount: 1,
        importedQuestionsCount: 2,
        phaseOrders: [{ id: 'imp-1', order: 5 }],
      });
      expect(importPhasesToDb).toHaveBeenCalledWith(phases);
    });

    it('retorna 500 se importPhasesToDb falhar', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (importPhasesToDb as jest.Mock).mockRejectedValue(new Error('Erro import'));

      const phases = [{ id: 'imp-1', titulo: 'Importada', icone: 'Brain', questoes: [] }];
      const mockReq = { json: async () => ({ phases }) } as unknown as Request;
      const res = await postImport(mockReq);
      expect(res.status).toBe(500);
    });
  });
});
