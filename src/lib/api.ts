import type {
  Phase,
  PhaseMetadataPayload,
  PhaseDeletionImpact,
  ReorderPhasesResult,
  ImportPhasesResponse,
} from '@/types';

/**
 * Erro HTTP estruturado retornado pelas chamadas de API do cliente.
 */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function parseApiResponse<T>(res: Response, fallbackMessage: string): Promise<T> {
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    const message =
      typeof (errorData as { error?: unknown }).error === 'string'
        ? (errorData as { error: string }).error
        : fallbackMessage;
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

/**
 * Busca a lista de fases e questões persistidas no Neon PostgreSQL.
 */
export async function fetchPhasesApi(): Promise<Phase[]> {
  const res = await fetch('/api/phases', { cache: 'no-store' });
  const data = await parseApiResponse<{ phases?: Phase[] }>(
    res,
    'Falha ao carregar fases do banco de dados'
  );
  return data.phases || [];
}

/**
 * Cria uma única fase no Neon PostgreSQL via POST /api/phases.
 */
export async function createPhaseApi(
  phase: PhaseMetadataPayload
): Promise<{ id: string; order: number }> {
  const res = await fetch('/api/phases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase }),
  });
  const data = await parseApiResponse<{ phase: { id: string; order: number } }>(
    res,
    'Falha ao criar fase no banco de dados'
  );
  return data.phase;
}

/**
 * Atualiza apenas metadados da fase (título, ícone e visibilidade) via PATCH /api/phases/[id].
 */
export async function updatePhaseMetadataApi(phase: PhaseMetadataPayload): Promise<void> {
  const res = await fetch(`/api/phases/${phase.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase }),
  });
  await parseApiResponse<{ success: boolean }>(
    res,
    'Falha ao atualizar metadados da fase no banco de dados'
  );
}

/**
 * Consulta o impacto (questões, submissões e alunos afetados) antes de excluir uma fase.
 */
export async function fetchPhaseImpactApi(phaseId: string): Promise<PhaseDeletionImpact> {
  const res = await fetch(`/api/phases/${phaseId}/impact`, { cache: 'no-store' });
  return parseApiResponse<PhaseDeletionImpact>(
    res,
    'Falha ao verificar impacto de exclusão da fase'
  );
}

/**
 * Exclui exclusivamente a fase informada no Neon PostgreSQL via DELETE /api/phases/[id].
 */
export async function deletePhaseApi(
  phaseId: string
): Promise<{ deletedId: string; remainingCount: number }> {
  const res = await fetch(`/api/phases/${phaseId}`, {
    method: 'DELETE',
  });
  return parseApiResponse<{ deletedId: string; remainingCount: number }>(
    res,
    'Falha ao excluir fase no banco de dados'
  );
}

/**
 * Reordena a lista de fases enviando apenas o array de IDs via PATCH /api/phases/reorder.
 */
export async function reorderPhasesApi(orderedIds: string[]): Promise<ReorderPhasesResult> {
  const res = await fetch('/api/phases/reorder', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  });
  return parseApiResponse<ReorderPhasesResult>(
    res,
    'Falha ao reordenar fases no banco de dados'
  );
}

/**
 * Importa um lote de fases e suas questões via POST /api/phases/import.
 */
export async function importPhasesApi(phases: Phase[]): Promise<ImportPhasesResponse> {
  const res = await fetch('/api/phases/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phases }),
  });
  return parseApiResponse<ImportPhasesResponse>(
    res,
    'Falha ao importar pacote de fases no banco de dados'
  );
}

/**
 * Envia e sincroniza uma única fase ativa e suas questões para o Neon PostgreSQL via PUT /api/phases/[id].
 * Usado para operações de questões até a Issue #6.
 */
export async function saveSinglePhaseApi(phase: Phase): Promise<void> {
  const res = await fetch(`/api/phases/${phase.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase }),
  });
  await parseApiResponse<{ success: boolean }>(
    res,
    'Falha ao salvar fase no banco de dados'
  );
}

/**
 * Busca todas as questões resolvidas pelo aluno autenticado no Neon PostgreSQL.
 */
export async function fetchUserSubmissionsApi(): Promise<{ questionId: string; isCorrect: boolean }[]> {
  const res = await fetch('/api/submissions', { cache: 'no-store' });
  const data = await parseApiResponse<{ submissions?: { questionId: string; isCorrect: boolean }[] }>(
    res,
    'Falha ao buscar submissões do usuário'
  );
  return data.submissions || [];
}

/**
 * Salva a resposta de uma questão enviada pelo aluno no Neon PostgreSQL.
 */
export async function saveUserSubmissionApi(
  questionId: string,
  isCorrect: boolean,
  answer: unknown
): Promise<void> {
  const res = await fetch('/api/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId, isCorrect, answer }),
  });
  await parseApiResponse<{ success: boolean }>(
    res,
    'Falha ao salvar resposta no banco de dados'
  );
}
