import { NextResponse } from 'next/server';
import { isTeacherRequest } from '@/lib/apiAuth';
import { getPhaseDeletionImpact } from '@/lib/db';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!(await isTeacherRequest())) {
      return NextResponse.json(
        { error: 'Não autorizado. Apenas professores podem consultar impacto.' },
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

    const impact = await getPhaseDeletionImpact(id);
    if (!impact) {
      return NextResponse.json({ error: 'Fase não encontrada.' }, { status: 404 });
    }

    return NextResponse.json(impact);
  } catch (error: unknown) {
    console.error('Erro ao calcular impacto de exclusão da fase:', error);
    const message =
      error instanceof Error ? error.message : 'Erro ao consultar impacto da fase';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
