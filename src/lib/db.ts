import { prisma } from '@/lib/prisma';
import type {
  Phase,
  Question,
  QuestionType,
  LucideIconName,
  PhaseMetadataPayload,
  PhaseDeletionImpact,
  ReorderPhasesResult,
  ImportPhasesResponse,
} from '@/types';
import { Prisma, QuestionType as PrismaQuestionType } from '@prisma/client';

/**
 * Erros de domínio para rotas granulares de fase.
 */
export class PhaseNotFoundError extends Error {
  constructor(message = 'Fase não encontrada.') {
    super(message);
    this.name = 'PhaseNotFoundError';
  }
}

export class LastPhaseDeletionError extends Error {
  constructor(message = 'Deve existir pelo menos 1 fase. Não é possível excluir a última fase.') {
    super(message);
    this.name = 'LastPhaseDeletionError';
  }
}

export class DuplicatePhaseError extends Error {
  constructor(message = 'Já existe uma fase com este identificador.') {
    super(message);
    this.name = 'DuplicatePhaseError';
  }
}

/**
 * Converte o tipo do TypeScript (minúsculo) para o Enum do Prisma (MAIÚSCULO).
 */
function toPrismaQuestionType(tipo: string): PrismaQuestionType {
  const upper = tipo.toUpperCase();
  if (upper === 'DIAGRAMACAO') return PrismaQuestionType.DIAGRAMACAO;
  if (upper === 'TABELA_VERDADE') return PrismaQuestionType.TABELA_VERDADE;
  if (upper === 'MULTIPLA_ESCOLHA') return PrismaQuestionType.MULTIPLA_ESCOLHA;
  if (upper === 'FORMALIZACAO_ARGUMENTO') return PrismaQuestionType.FORMALIZACAO_ARGUMENTO;
  if (upper.includes('FORMALIZACAO')) return PrismaQuestionType.FORMALIZACAO;
  return PrismaQuestionType.DIAGRAMACAO;
}

/**
 * Converte o Enum do Prisma (MAIÚSCULO) para o tipo do TypeScript (minúsculo).
 */
function fromPrismaQuestionType(type: PrismaQuestionType): QuestionType {
  return type.toLowerCase() as QuestionType;
}

/**
 * Resolve o tipo TypeScript da questão combinando o enum do Prisma e metadados no content.
 * Possui heurística de compatibilidade para identificar formalizacao_argumento persistidas no banco.
 */
function resolveQuestionType(prismaType: PrismaQuestionType, content: Record<string, unknown>): QuestionType {
  if (content.originalTipo && typeof content.originalTipo === 'string') {
    return content.originalTipo as QuestionType;
  }
  if (content.tipo && typeof content.tipo === 'string') {
    return content.tipo as QuestionType;
  }
  // Heurística de retrocompatibilidade para argumentos salvos no banco
  if (
    content.resposta_esperada &&
    typeof content.resposta_esperada === 'object' &&
    'premissas' in (content.resposta_esperada as object)
  ) {
    return 'formalizacao_argumento';
  }
  return fromPrismaQuestionType(prismaType);
}

/**
 * Codifica o ícone e a flag de visibilidade (:oculta) para persistência Zero-DDL.
 */
function encodePhaseIcon(icone: LucideIconName, oculta?: boolean): string {
  return oculta ? `${icone}:oculta` : icone;
}

/**
 * Serializa uma questão para o formato de registro do Prisma.
 */
function serializeQuestionForDb(question: Question, phaseId: string, order: number) {
  const { id, tipo, topico, enunciado, ...content } = question as Question & Record<string, unknown>;

  const prismaType = toPrismaQuestionType(tipo);
  const isStandardPrismaType =
    tipo === 'diagramacao' ||
    tipo === 'tabela_verdade' ||
    tipo === 'formalizacao' ||
    tipo === 'multipla_escolha' ||
    tipo === 'formalizacao_argumento';
  const jsonContent = {
    ...(content || {}),
    ...(!isStandardPrismaType ? { originalTipo: tipo } : {}),
  } as Prisma.InputJsonObject;

  return {
    id,
    phaseId,
    type: prismaType,
    topic: topico,
    enunciado,
    order,
    content: jsonContent,
  };
}

/**
 * Busca todas as fases e questões do banco Neon, ordenadas por `order`.
 */
export async function getPhasesFromDb(): Promise<Phase[]> {
  const dbPhases = await prisma.phase.findMany({
    orderBy: { order: 'asc' },
    include: {
      questions: {
        orderBy: { order: 'asc' },
      },
    },
  });

  return dbPhases.map((p) => {
    const [rawIcon, flag] = (p.icon || 'Network').split(':');
    return {
      id: p.id,
      titulo: p.title,
      icone: (rawIcon || 'Network') as LucideIconName,
      ...(flag === 'oculta' ? { oculta: true } : {}),
      questoes: p.questions.map((q) => {
        const content =
          typeof q.content === 'object' && q.content !== null ? (q.content as Record<string, unknown>) : {};
        return {
          id: q.id,
          tipo: resolveQuestionType(q.type, content),
          topico: q.topic,
          enunciado: q.enunciado,
          ...content,
        } as Question;
      }),
    };
  });
}

/**
 * Cria uma única fase ao final da ordem existente sem reescrever fases ou questões.
 */
export async function createPhaseInDb(phase: PhaseMetadataPayload): Promise<{ id: string; order: number }> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const agg = await tx.phase.aggregate({ _max: { order: true } });
        const nextOrder = (agg._max.order ?? -1) + 1;

        await tx.phase.create({
          data: {
            id: phase.id,
            title: phase.titulo,
            icon: encodePhaseIcon(phase.icone, phase.oculta),
            order: nextOrder,
          },
        });

        return { id: phase.id, order: nextOrder };
      },
      {
        maxWait: 10000,
        timeout: 15000,
      }
    );
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === 'P2002') {
      throw new DuplicatePhaseError();
    }
    throw error;
  }
}

/**
 * Atualiza apenas título, ícone e visibilidade de uma fase específica sem tocar em suas questões.
 */
export async function updatePhaseMetadataInDb(phase: PhaseMetadataPayload): Promise<void> {
  try {
    await prisma.phase.update({
      where: { id: phase.id },
      data: {
        title: phase.titulo,
        icon: encodePhaseIcon(phase.icone, phase.oculta),
      },
    });
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === 'P2025') {
      throw new PhaseNotFoundError();
    }
    throw error;
  }
}

/**
 * Consulta o impacto (questões, submissões e alunos afetados) antes da exclusão explícita de uma fase.
 */
export async function getPhaseDeletionImpact(phaseId: string): Promise<PhaseDeletionImpact | null> {
  const phase = await prisma.phase.findUnique({
    where: { id: phaseId },
    select: {
      id: true,
      _count: { select: { questions: true } },
    },
  });

  if (!phase) {
    return null;
  }

  const [submissionsCount, groupedStudents] = await Promise.all([
    prisma.submission.count({
      where: { question: { phaseId } },
    }),
    prisma.submission.groupBy({
      by: ['userId'],
      where: { question: { phaseId } },
    }),
  ]);

  return {
    phaseId,
    questionsCount: phase._count.questions,
    submissionsCount,
    studentsAffectedCount: groupedStudents.length,
  };
}

/**
 * Exclui exclusivamente a fase alvo (impedindo exclusão da última fase) e compacta as ordens posteriores.
 */
export async function deletePhaseFromDb(
  phaseId: string
): Promise<{ deletedId: string; remainingCount: number }> {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.phase.findUnique({
        where: { id: phaseId },
        select: { id: true, order: true },
      });

      if (!existing) {
        throw new PhaseNotFoundError();
      }

      const totalPhases = await tx.phase.count();
      if (totalPhases <= 1) {
        throw new LastPhaseDeletionError();
      }

      await tx.phase.delete({
        where: { id: phaseId },
      });

      await tx.phase.updateMany({
        where: { order: { gt: existing.order } },
        data: { order: { decrement: 1 } },
      });

      return {
        deletedId: phaseId,
        remainingCount: totalPhases - 1,
      };
    },
    {
      maxWait: 10000,
      timeout: 15000,
    }
  );
}

/**
 * Reordena fases fazendo merge seguro com o estado atual do banco para preservar fases concorrentes,
 * atualizando apenas a coluna `order` em um único UPDATE SQL parametrizado.
 */
export async function reorderPhasesInDb(orderedIds: string[]): Promise<ReorderPhasesResult> {
  return prisma.$transaction(
    async (tx) => {
      const dbPhases = await tx.phase.findMany({
        select: { id: true, order: true },
        orderBy: { order: 'asc' },
      });

      const currentOrderMap = new Map(dbPhases.map((p) => [p.id, p.order]));
      const dbIdSet = new Set(dbPhases.map((p) => p.id));

      const uniqueRequested: string[] = [];
      const seenRequested = new Set<string>();
      for (const id of orderedIds) {
        if (!seenRequested.has(id)) {
          seenRequested.add(id);
          uniqueRequested.push(id);
        }
      }

      const validRequestedIds = uniqueRequested.filter((id) => dbIdSet.has(id));
      const validSet = new Set(validRequestedIds);
      const unseenDbIds = dbPhases.map((p) => p.id).filter((id) => !validSet.has(id));

      const finalOrder = [...validRequestedIds, ...unseenDbIds];
      const hasExternalChanges =
        unseenDbIds.length > 0 || validRequestedIds.length !== uniqueRequested.length;

      const changedEntries = finalOrder
        .map((id, idx) => ({ id, newOrder: idx }))
        .filter(({ id, newOrder }) => currentOrderMap.get(id) !== newOrder);

      if (changedEntries.length > 0) {
        const valueTuples = changedEntries.map(
          ({ id, newOrder }) => Prisma.sql`(${id}, ${newOrder}::int)`
        );
        await tx.$executeRaw(
          Prisma.sql`UPDATE "Phase" AS p SET "order" = v.ord, "updatedAt" = NOW() FROM (VALUES ${Prisma.join(valueTuples)}) AS v(id, ord) WHERE p.id = v.id`
        );
      }

      return {
        orderedIds: finalOrder,
        hasExternalChanges,
      };
    },
    {
      maxWait: 10000,
      timeout: 15000,
    }
  );
}

/**
 * Importa um lote de fases novas e suas questões em batch (`createMany`) ao final da ordem atual.
 */
export async function importPhasesToDb(phases: Phase[]): Promise<ImportPhasesResponse> {
  if (phases.length === 0) {
    return {
      importedPhasesCount: 0,
      importedQuestionsCount: 0,
      phaseOrders: [],
    };
  }

  return prisma.$transaction(
    async (tx) => {
      const agg = await tx.phase.aggregate({ _max: { order: true } });
      const baseOrder = (agg._max.order ?? -1) + 1;

      const phaseRows = phases.map((phase, idx) => ({
        id: phase.id,
        title: phase.titulo,
        icon: encodePhaseIcon(phase.icone, phase.oculta),
        order: baseOrder + idx,
      }));

      const questionRows = phases.flatMap((phase) =>
        phase.questoes.map((q, qIndex) => serializeQuestionForDb(q, phase.id, qIndex))
      );

      await tx.phase.createMany({ data: phaseRows });
      if (questionRows.length > 0) {
        await tx.question.createMany({ data: questionRows });
      }

      return {
        importedPhasesCount: phaseRows.length,
        importedQuestionsCount: questionRows.length,
        phaseOrders: phaseRows.map((p) => ({ id: p.id, order: p.order })),
      };
    },
    {
      maxWait: 10000,
      timeout: 30000,
    }
  );
}

/**
 * Sincroniza uma única fase ativa e suas questões no banco Neon em transação atômica.
 * Usado para operações de questões do Editor até a Issue #6.
 */
export async function syncSinglePhaseToDb(phase: Phase): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // 1. Busca a ordem atual da fase no banco (se já existir), ou calcula após a maior ordem disponível
      const existingPhase = await tx.phase.findUnique({
        where: { id: phase.id },
        select: { order: true },
      });

      let phaseOrder = existingPhase?.order;
      if (phaseOrder === undefined) {
        const agg = await tx.phase.aggregate({ _max: { order: true } });
        phaseOrder = (agg._max.order ?? -1) + 1;
      }

      const phaseIcon = encodePhaseIcon(phase.icone, phase.oculta);

      // 2. Upsert da fase (atualiza título e ícone preservando a ordem)
      await tx.phase.upsert({
        where: { id: phase.id },
        update: {
          title: phase.titulo,
          icon: phaseIcon,
          order: phaseOrder,
        },
        create: {
          id: phase.id,
          title: phase.titulo,
          icon: phaseIcon,
          order: phaseOrder,
        },
      });

      // 3. Exclui questões removidas desta fase
      const questionIds = phase.questoes.map((q) => q.id);
      if (questionIds.length === 0) {
        await tx.question.deleteMany({
          where: { phaseId: phase.id },
        });
      } else {
        await tx.question.deleteMany({
          where: {
            phaseId: phase.id,
            id: { notIn: questionIds },
          },
        });
      }

      // 4. Upsert de cada questão desta fase na ordem indicada via Promise.all
      await Promise.all(
        phase.questoes.map((question, qIndex) => {
          const serialized = serializeQuestionForDb(question, phase.id, qIndex);
          return tx.question.upsert({
            where: { id: serialized.id },
            update: {
              phaseId: serialized.phaseId,
              type: serialized.type,
              topic: serialized.topic,
              enunciado: serialized.enunciado,
              order: serialized.order,
              content: serialized.content,
            },
            create: serialized,
          });
        })
      );
    },
    {
      maxWait: 10000,
      timeout: 30000,
    }
  );
}

/**
 * Busca todas as submissões de um usuário específico no banco Neon.
 */
export async function getUserSubmissions(
  userId: string
): Promise<{ questionId: string; isCorrect: boolean; answer: unknown }[]> {
  const submissions = await prisma.submission.findMany({
    where: { userId },
    select: {
      questionId: true,
      isCorrect: true,
      answer: true,
    },
  });
  return submissions;
}

/**
 * Registra a tentativa de resolução de uma questão por um aluno (gravação de histórico atômica).
 */
export async function saveUserSubmission(data: {
  userId: string;
  questionId: string;
  isCorrect: boolean;
  answer: unknown;
}): Promise<void> {
  const { userId, questionId, isCorrect, answer } = data;
  await prisma.submission.create({
    data: {
      userId,
      questionId,
      isCorrect,
      answer: (answer ?? null) as Prisma.InputJsonValue,
    },
  });
}
