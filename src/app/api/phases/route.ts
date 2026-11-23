import { NextResponse } from 'next/server';
import { isTeacherRequest } from '@/lib/apiAuth';
import { getPhasesFromDb, createPhaseInDb, DuplicatePhaseError } from '@/lib/db';
import type { PhaseMetadataPayload } from '@/types';

export async function GET() {
  try {
    const phases = await getPhasesFromDb();
    return NextResponse.json({ phases });
  } catch (error: unknown) {
    console.error('Erro ao buscar fases do banco:', error);
    return NextResponse.json(
      { error: 'Erro ao buscar fases do banco de dados' },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    if (!(await isTeacherRequest())) {
      return NextResponse.json(
        { error: 'Não autorizado. Apenas professores podem salvar alterações.' },
        { status: 403 }
      );
    }

    const body = (await req.json()) as { phase?: Partial<PhaseMetadataPayload> };
    const phase = body?.phase;

    if (
      !phase ||
      typeof phase.id !== 'string' ||
      !phase.id.trim() ||
      typeof phase.titulo !== 'string' ||
      !phase.titulo.trim() ||
      typeof phase.icone !== 'string' ||
      !phase.icone.trim()
    ) {
      return NextResponse.json(
        { error: 'Dados inválidos. Informe id, titulo e icone da fase.' },
        { status: 400 }
      );
    }

    const created = await createPhaseInDb({
      id: phase.id,
      titulo: phase.titulo,
      icone: phase.icone,
      ...(phase.oculta !== undefined ? { oculta: phase.oculta } : {}),
    });

    return NextResponse.json({ success: true, phase: created }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof DuplicatePhaseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('Erro ao criar fase no banco:', error);
    const message = error instanceof Error ? error.message : 'Erro ao criar fase no banco';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
