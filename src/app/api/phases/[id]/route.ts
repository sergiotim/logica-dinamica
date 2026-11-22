import { NextResponse } from 'next/server';
import { isTeacherRequest } from '@/lib/apiAuth';
import {
  syncSinglePhaseToDb,
  updatePhaseMetadataInDb,
  deletePhaseFromDb,
  PhaseNotFoundError,
  LastPhaseDeletionError,
} from '@/lib/db';
import type { Phase, PhaseMetadataPayload } from '@/types';

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await isTeacherRequest())) {
      return NextResponse.json(
        { error: 'Não autorizado. Apenas professores podem salvar alterações.' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const phase = body.phase as Phase;

    if (!phase || !phase.id) {
      return NextResponse.json(
        { error: 'Dados da fase inválidos ou ausentes.' },
        { status: 400 }
      );
    }

    const { id } = await params;
    if (id !== phase.id) {
      return NextResponse.json(
        { error: 'O identificador da rota não corresponde ao ID da fase.' },
        { status: 400 }
      );
    }

    await syncSinglePhaseToDb(phase);

    return NextResponse.json({ success: true, phaseId: phase.id });
  } catch (error: unknown) {
    console.error('Erro ao atualizar fase no banco:', error);
    const message = error instanceof Error ? error.message : 'Erro ao sincronizar fase com o banco';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await isTeacherRequest())) {
      return NextResponse.json(
        { error: 'Não autorizado. Apenas professores podem salvar alterações.' },
        { status: 403 }
      );
    }

    const { id } = await params;
    const body = (await req.json()) as { phase?: Partial<PhaseMetadataPayload> };
    const phase = body?.phase;

    if (
      !id ||
      !phase ||
      (phase.id !== undefined && phase.id !== id) ||
      typeof phase.titulo !== 'string' ||
      !phase.titulo.trim() ||
      typeof phase.icone !== 'string' ||
      !phase.icone.trim()
    ) {
      return NextResponse.json(
        { error: 'Metadados da fase inválidos ou ausentes.' },
        { status: 400 }
      );
    }

    await updatePhaseMetadataInDb({
      id,
      titulo: phase.titulo,
      icone: phase.icone,
      ...(phase.oculta !== undefined ? { oculta: phase.oculta } : {}),
    });

    return NextResponse.json({ success: true, phaseId: id });
  } catch (error: unknown) {
    if (error instanceof PhaseNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('Erro ao atualizar metadados da fase:', error);
    const message =
      error instanceof Error ? error.message : 'Erro ao atualizar metadados da fase';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await isTeacherRequest())) {
      return NextResponse.json(
        { error: 'Não autorizado. Apenas professores podem excluir fases.' },
        { status: 403 }
      );
    }

    const { id } = await params;
    if (!id || !id.trim()) {
      return NextResponse.json(
        { error: 'Identificador da fase não informado.' },
        { status: 400 }
      );
    }

    const result = await deletePhaseFromDb(id);
    return NextResponse.json({ success: true, ...result });
  } catch (error: unknown) {
    if (error instanceof PhaseNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof LastPhaseDeletionError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('Erro ao excluir fase no banco:', error);
    const message = error instanceof Error ? error.message : 'Erro ao excluir fase no banco';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
