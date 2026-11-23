export const PREVIEW_PROVIDER_ID = 'preview-login';
export const PREVIEW_EMAIL_DOMAIN = '@logica-dinamica.local';

export type PreviewUserRole = 'TEACHER' | 'STUDENT';

export interface PreviewUserConfig {
  id: string;
  email: string;
  name: string;
  role: PreviewUserRole;
}

/**
 * Habilita o login rápido de preview apenas em deploys de Preview da Vercel.
 */
export function isPreviewAuthEnabled(): boolean {
  return process.env.VERCEL_ENV === 'preview';
}

/**
 * Identifica contas fictícias geradas pelo login de preview para isolá-las do analytics real.
 */
export function isPreviewUserEmail(email?: string | null): boolean {
  return Boolean(email && email.toLowerCase().endsWith(PREVIEW_EMAIL_DOMAIN));
}

export function getPreviewUserConfig(role: PreviewUserRole): PreviewUserConfig {
  if (role === 'TEACHER') {
    return {
      id: 'preview-teacher',
      email: `preview-teacher${PREVIEW_EMAIL_DOMAIN}`,
      name: 'Professor (Preview)',
      role: 'TEACHER',
    };
  }

  return {
    id: 'preview-student',
    email: `preview-student${PREVIEW_EMAIL_DOMAIN}`,
    name: 'Aluno (Preview)',
    role: 'STUDENT',
  };
}
