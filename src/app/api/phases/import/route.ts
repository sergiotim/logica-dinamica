import { NextResponse } from 'next/server';
import { isTeacherRequest } from '@/lib/apiAuth';
import { importPhasesToDb, DuplicatePhaseError } from '@/lib/db';
import type { Phase, Question } from '@/types';

function isValidImportQuestion(item: unknown): item is Question {
  if (!item || typeof item !== 'object') return false;
  const q = item as Partial<Question>;
  return (
    typeof q.id === 'string' &&
    q.id.trim().length > 0 &&
    typeof q.tipo === 'string' &&
    q.tipo.trim().length > 0 &&
    typeof q.topico === 'string' &&
    typeof q.enunciado === 'string'
  );
}

function isValidImportPhase(item: unknown): item is Phase {
  if (!item || typeof item !== 'object') return false;
  const p = item as Partial<Phase>;
  return (
    typeof p.id === 'string' &&
    p.id.trim().length > 0 &&
    typeof p.titulo === 'string' &&
    p.titulo.trim().length > 0 &&
    typeof p.icone === 'string' &&
    p.icone.trim().length > 0 &&
    Array.isArray(p.questoes) &&
    p.questoes.every(isValidImportQuestion)
  );
}

export async function POST(req: Request) {
  try {
    if (!(await isTeacherRequest())) {
      return NextResponse.json(
        { error: 'Não autorizado. Apenas professores podem importar fases.' },
        { status: 403 }
      );
    }

    const body = (await req.json()) as { phases?: unknown };
    const phases = body?.phases;

    if (!Array.isArray(phases) || phases.length === 0 || !phases.every(isValidImportPhase)) {
      return NextResponse.json(
        { error: 'Pacote de fases inválido ou vazio para importação.' },
        { status: 400 }
      );
    }

    const result = await importPhasesToDb(phases);
    return NextResponse.json({ success: true, ...result }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof DuplicatePhaseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('Erro ao importar fases no banco:', error);
    const message = error instanceof Error ? error.message : 'Erro ao importar fases no banco';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
