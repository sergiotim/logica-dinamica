jest.mock('next-auth', () => ({
  getServerSession: jest.fn(),
}));

jest.mock('@/lib/auth', () => ({
  authOptions: {},
}));

jest.mock('@/lib/db', () => {
  class PhaseNotFoundError extends Error {
    constructor(message = 'Fase não encontrada.') {
      super(message);
      this.name = 'PhaseNotFoundError';
    }
  }
  class LastPhaseDeletionError extends Error {
    constructor(message = 'Deve existir pelo menos 1 fase. Não é possível excluir a última fase.') {
      super(message);
      this.name = 'LastPhaseDeletionError';
    }
  }
  return {
    syncSinglePhaseToDb: jest.fn(),
    updatePhaseMetadataInDb: jest.fn(),
    deletePhaseFromDb: jest.fn(),
    PhaseNotFoundError,
    LastPhaseDeletionError,
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

import { PUT, PATCH, DELETE } from '@/app/api/phases/[id]/route';
import {
  syncSinglePhaseToDb,
  updatePhaseMetadataInDb,
  deletePhaseFromDb,
  PhaseNotFoundError,
  LastPhaseDeletionError,
} from '@/lib/db';
import { getServerSession } from 'next-auth';

describe('/api/phases/[id] Route Handler (PUT)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEACHER_EMAILS = 'prof@teste.com';
  });

  it('retorna 403 se o usuário não for professor', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'aluno@teste.com', role: 'STUDENT' },
    });

    const mockReq = {
      json: async () => ({ phase: { id: 'f-1', titulo: 'Fase 1' } }),
    } as unknown as Request;

    const res = await PUT(mockReq, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/Não autorizado/i);
    expect(syncSinglePhaseToDb).not.toHaveBeenCalled();
  });

  it('retorna 400 se o corpo da requisição não contiver phase válida', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });

    const mockReq = {
      json: async () => ({}),
    } as unknown as Request;

    const res = await PUT(mockReq, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/inválidos ou ausentes/i);
    expect(syncSinglePhaseToDb).not.toHaveBeenCalled();
  });

  it('retorna 400 se o ID da rota for diferente do ID da fase no payload', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });

    const mockReq = {
      json: async () => ({ phase: { id: 'f-2', titulo: 'Fase 2' } }),
    } as unknown as Request;

    const res = await PUT(mockReq, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/não corresponde ao ID/i);
    expect(syncSinglePhaseToDb).not.toHaveBeenCalled();
  });

  it('sincroniza a fase e retorna 200 quando o professor é autorizado e os dados são válidos', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });
    (syncSinglePhaseToDb as jest.Mock).mockResolvedValue(undefined);

    const phase = {
      id: 'f-1',
      titulo: 'Fase 1 Atualizada',
      icone: 'Network',
      questoes: [],
    };

    const mockReq = {
      json: async () => ({ phase }),
    } as unknown as Request;

    const res = await PUT(mockReq, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.phaseId).toBe('f-1');
    expect(syncSinglePhaseToDb).toHaveBeenCalledWith(phase);
  });

  it('retorna 500 caso a sincronização falhe', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });
    (syncSinglePhaseToDb as jest.Mock).mockRejectedValue(new Error('Erro de conexão no banco'));

    const phase = {
      id: 'f-1',
      titulo: 'Fase 1',
      icone: 'Network',
      questoes: [],
    };

    const mockReq = {
      json: async () => ({ phase }),
    } as unknown as Request;

    const res = await PUT(mockReq, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Erro de conexão no banco');
  });
});

describe('/api/phases/[id] Route Handler (PATCH — Metadados)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEACHER_EMAILS = 'prof@teste.com';
  });

  it('retorna 403 se o usuário não for professor', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'aluno@teste.com', role: 'STUDENT' },
    });

    const mockReq = {
      json: async () => ({ phase: { titulo: 'Fase 1', icone: 'Network' } }),
    } as unknown as Request;

    const res = await PATCH(mockReq, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(403);
    expect(updatePhaseMetadataInDb).not.toHaveBeenCalled();
  });

  it('retorna 400 se titulo ou icone forem inválidos ou se phase.id divergir da rota', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });

    const payloads = [
      {},
      { phase: { titulo: '   ', icone: 'Network' } },
      { phase: { titulo: 'Ok', icone: '' } },
      { phase: { id: 'f-outro', titulo: 'Ok', icone: 'Network' } },
    ];

    for (const payload of payloads) {
      const mockReq = { json: async () => payload } as unknown as Request;
      const res = await PATCH(mockReq, { params: Promise.resolve({ id: 'f-1' }) });
      expect(res.status).toBe(400);
    }

    expect(updatePhaseMetadataInDb).not.toHaveBeenCalled();
  });

  it('atualiza metadados via updatePhaseMetadataInDb e retorna 200', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });
    (updatePhaseMetadataInDb as jest.Mock).mockResolvedValue(undefined);

    const mockReq = {
      json: async () => ({
        phase: { titulo: 'Novo Título', icone: 'Brain', oculta: true },
      }),
    } as unknown as Request;

    const res = await PATCH(mockReq, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, phaseId: 'f-1' });
    expect(updatePhaseMetadataInDb).toHaveBeenCalledWith({
      id: 'f-1',
      titulo: 'Novo Título',
      icone: 'Brain',
      oculta: true,
    });
  });

  it('retorna 404 quando a fase não existe (PhaseNotFoundError)', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });
    (updatePhaseMetadataInDb as jest.Mock).mockRejectedValue(new PhaseNotFoundError());

    const mockReq = {
      json: async () => ({ phase: { titulo: 'Novo', icone: 'Network' } }),
    } as unknown as Request;

    const res = await PATCH(mockReq, { params: Promise.resolve({ id: 'f-missing' }) });
    expect(res.status).toBe(404);
  });

  it('retorna 500 em caso de erro inesperado', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });
    (updatePhaseMetadataInDb as jest.Mock).mockRejectedValue(new Error('Erro no Postgres'));

    const mockReq = {
      json: async () => ({ phase: { titulo: 'Novo', icone: 'Network' } }),
    } as unknown as Request;

    const res = await PATCH(mockReq, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(500);
  });
});

describe('/api/phases/[id] Route Handler (DELETE)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEACHER_EMAILS = 'prof@teste.com';
  });

  it('retorna 403 se o usuário não for professor', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'aluno@teste.com', role: 'STUDENT' },
    });

    const res = await DELETE({} as Request, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(403);
    expect(deletePhaseFromDb).not.toHaveBeenCalled();
  });

  it('exclui a fase via deletePhaseFromDb e retorna 200', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });
    (deletePhaseFromDb as jest.Mock).mockResolvedValue({ deletedId: 'f-1', remainingCount: 2 });

    const res = await DELETE({} as Request, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ success: true, deletedId: 'f-1', remainingCount: 2 });
    expect(deletePhaseFromDb).toHaveBeenCalledWith('f-1');
  });

  it('retorna 404 quando a fase já foi removida (PhaseNotFoundError)', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });
    (deletePhaseFromDb as jest.Mock).mockRejectedValue(new PhaseNotFoundError());

    const res = await DELETE({} as Request, { params: Promise.resolve({ id: 'f-gone' }) });
    expect(res.status).toBe(404);
  });

  it('retorna 409 ao tentar excluir a última fase restante (LastPhaseDeletionError)', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });
    (deletePhaseFromDb as jest.Mock).mockRejectedValue(new LastPhaseDeletionError());

    const res = await DELETE({} as Request, { params: Promise.resolve({ id: 'f-last' }) });
    expect(res.status).toBe(409);
  });

  it('retorna 500 em erro inesperado', async () => {
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { email: 'prof@teste.com', role: 'TEACHER' },
    });
    (deletePhaseFromDb as jest.Mock).mockRejectedValue(new Error('Falha ao excluir'));

    const res = await DELETE({} as Request, { params: Promise.resolve({ id: 'f-1' }) });
    expect(res.status).toBe(500);
  });
});
