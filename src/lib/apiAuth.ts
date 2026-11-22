import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

/**
 * Verifica se a requisição atual pertence a um usuário autenticado com papel TEACHER
 * (via sessão ou lista TEACHER_EMAILS).
 */
export async function isTeacherRequest(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  if (session?.user?.role === 'TEACHER') {
    return true;
  }

  const email = (session?.user?.email || '').trim().toLowerCase();
  if (!email) {
    return false;
  }

  const teacherEmails = (process.env.TEACHER_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return teacherEmails.includes(email);
}
