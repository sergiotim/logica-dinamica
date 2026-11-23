import { NextResponse } from 'next/server';
import { isTeacherRequest } from '@/lib/apiAuth';
import { reorderPhasesInDb } from '@/lib/db';

export async function PATCH(req: Request) {
  try {
    if (!(await isTeacherRequest())) {
      return NextResponse.json(
        { error: 'Não autorizado. Apenas professores podem reordenar fases.' },
        { status: 403 }
      );
    }

    const body = (await req.json()) as { orderedIds?: unknown };
    const orderedIds = body?.orderedIds;

    if (
      !Array.isArray(orderedIds) ||
      orderedIds.length === 0 ||
      !orderedIds.every((item): item is string => typeof item === 'string' && item.trim().length > 0)
    ) {
      return NextResponse.json(
        { error: 'Lista orderedIds inválida ou vazia.' },
        { status: 400 }
      );
    }

    const result = await reorderPhasesInDb(orderedIds);
    return NextResponse.json({ success: true, ...result });
  } catch (error: unknown) {
    console.error('Erro ao reordenar fases no banco:', error);
    const message = error instanceof Error ? error.message : 'Erro ao reordenar fases no banco';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
