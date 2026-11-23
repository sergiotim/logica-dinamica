jest.mock('next-auth', () => ({
  getServerSession: jest.fn(),
}));

jest.mock('@/lib/auth', () => ({
  authOptions: {},
}));

jest.mock('@/lib/db', () => {
  class DuplicatePhaseError extends Error {
    constructor(message = 'Já existe uma fase com este identificador.') {
      super(message);
      this.name = 'DuplicatePhaseError';
    }
  }
  return {
    getPhasesFromDb: jest.fn(),
    createPhaseInDb: jest.fn(),
    DuplicatePhaseError,
  };
});

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((data, init) => ({
      status: init?.status || 200,
      json: async () => data,
    })),
  },
}));

import { GET, POST } from '@/app/api/phases/route';
import { getPhasesFromDb, createPhaseInDb, DuplicatePhaseError } from '@/lib/db';
import { getServerSession } from 'next-auth';

describe('/api/phases Route Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEACHER_EMAILS = 'prof@teste.com';
  });

  describe('GET', () => {
    it('retorna a lista de fases com status 200', async () => {
      (getPhasesFromDb as jest.Mock).mockResolvedValue([
        { id: 'f-1', titulo: 'Fase 1', icone: 'Network', questoes: [] },
      ]);

      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.phases).toHaveLength(1);
      expect(json.phases[0].id).toBe('f-1');
    });
  });

  describe('POST (Criação unitária de Fase)', () => {
    it('retorna 403 se o usuário não for professor', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'aluno@teste.com', role: 'STUDENT' },
      });

      const mockReq = {
        json: async () => ({
          phase: { id: 'f-1', titulo: 'Nova Fase', icone: 'Table2' },
        }),
      } as unknown as Request;

      const res = await POST(mockReq);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toMatch(/Não autorizado/i);
      expect(createPhaseInDb).not.toHaveBeenCalled();
    });

    it('retorna 400 se o payload não contiver uma fase válida com id, titulo e icone', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });

      const invalidPayloads = [
        {},
        { phases: [{ id: 'f-1', titulo: 'Monolítico', icone: 'Network', questoes: [] }] },
        { phase: { id: '', titulo: 'Sem ID', icone: 'Network' } },
        { phase: { id: 'f-1', titulo: '   ', icone: 'Network' } },
        { phase: { id: 'f-1', titulo: 'Sem Ícone', icone: '' } },
      ];

      for (const payload of invalidPayloads) {
        const mockReq = { json: async () => payload } as unknown as Request;
        const res = await POST(mockReq);
        expect(res.status).toBe(400);
      }

      expect(createPhaseInDb).not.toHaveBeenCalled();
    });

    it('cria 1 única fase via createPhaseInDb e retorna 201', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (createPhaseInDb as jest.Mock).mockResolvedValue({ id: 'f-new', order: 4 });

      const phase = { id: 'f-new', titulo: 'Nova Fase', icone: 'Table2' as const };
      const mockReq = {
        json: async () => ({ phase }),
      } as unknown as Request;

      const res = await POST(mockReq);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        phase: { id: 'f-new', order: 4 },
      });
      expect(createPhaseInDb).toHaveBeenCalledWith(phase);
    });

    it('retorna 409 se já existir fase com o mesmo ID (DuplicatePhaseError)', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (createPhaseInDb as jest.Mock).mockRejectedValue(new DuplicatePhaseError());

      const mockReq = {
        json: async () => ({
          phase: { id: 'f-dup', titulo: 'Duplicada', icone: 'Network' },
        }),
      } as unknown as Request;

      const res = await POST(mockReq);
      expect(res.status).toBe(409);
    });

    it('retorna 500 se ocorrer erro inesperado ao criar fase', async () => {
      (getServerSession as jest.Mock).mockResolvedValue({
        user: { email: 'prof@teste.com', role: 'TEACHER' },
      });
      (createPhaseInDb as jest.Mock).mockRejectedValue(new Error('Falha no Neon'));

      const mockReq = {
        json: async () => ({
          phase: { id: 'f-err', titulo: 'Fase', icone: 'Network' },
        }),
      } as unknown as Request;

      const res = await POST(mockReq);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe('Falha no Neon');
    });
  });
});
