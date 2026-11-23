jest.mock('next-auth/providers/google', () =>
  jest.fn((config) => ({ ...config, id: 'google', type: 'oauth' }))
);

jest.mock('next-auth/providers/credentials', () =>
  jest.fn((config) => ({ ...config, type: 'credentials' }))
);

jest.mock('@auth/prisma-adapter', () => ({
  PrismaAdapter: jest.fn(() => ({})),
}));

jest.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      upsert: jest.fn(),
    },
  },
}));

import { getAuthOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  PREVIEW_PROVIDER_ID,
  getPreviewUserConfig,
  isPreviewAuthEnabled,
  isPreviewUserEmail,
} from '@/lib/previewAuth';

describe('Autenticação em ambiente de Preview', () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalTeacherEmails = process.env.TEACHER_EMAILS;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VERCEL_ENV;
    process.env.TEACHER_EMAILS = 'prof@ulbra.br';
  });

  afterAll(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }

    if (originalTeacherEmails === undefined) {
      delete process.env.TEACHER_EMAILS;
    } else {
      process.env.TEACHER_EMAILS = originalTeacherEmails;
    }
  });

  it('isPreviewAuthEnabled retorna true apenas quando VERCEL_ENV=preview', () => {
    expect(isPreviewAuthEnabled()).toBe(false);

    process.env.VERCEL_ENV = 'production';
    expect(isPreviewAuthEnabled()).toBe(false);

    process.env.VERCEL_ENV = 'development';
    expect(isPreviewAuthEnabled()).toBe(false);

    process.env.VERCEL_ENV = 'preview';
    expect(isPreviewAuthEnabled()).toBe(true);
  });

  it('isPreviewUserEmail identifica corretamente e-mails de preview', () => {
    expect(isPreviewUserEmail('preview-teacher@logica-dinamica.local')).toBe(true);
    expect(isPreviewUserEmail('preview-student@logica-dinamica.local')).toBe(true);
    expect(isPreviewUserEmail('aluno@ulbra.br')).toBe(false);
    expect(isPreviewUserEmail(null)).toBe(false);
    expect(isPreviewUserEmail(undefined)).toBe(false);
  });

  it('não registra o provider de preview fora do ambiente preview', () => {
    process.env.VERCEL_ENV = 'production';
    const options = getAuthOptions();

    expect(options.providers).toHaveLength(1);
    expect((options.providers[0] as { id: string }).id).toBe('google');
  });

  it('registra o provider de preview quando VERCEL_ENV=preview', () => {
    process.env.VERCEL_ENV = 'preview';
    const options = getAuthOptions();

    expect(options.providers).toHaveLength(2);
    expect((options.providers[1] as { id: string }).id).toBe(PREVIEW_PROVIDER_ID);
  });

  it('authorize realiza upsert do usuário de preview no banco quando disponível', async () => {
    process.env.VERCEL_ENV = 'preview';
    const options = getAuthOptions();
    const previewProvider = options.providers[1] as unknown as {
      authorize: (credentials?: Record<string, string>) => Promise<unknown>;
    };

    const config = getPreviewUserConfig('TEACHER');
    (prisma.user.upsert as jest.Mock).mockResolvedValue({
      id: 'db-teacher-id',
      name: config.name,
      email: config.email,
      role: 'TEACHER',
    });

    const result = await previewProvider.authorize({ role: 'TEACHER' });

    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: config.email },
        create: expect.objectContaining({ role: 'TEACHER' }),
      })
    );
    expect(result).toEqual({
      id: 'db-teacher-id',
      name: 'Professor (Preview)',
      email: config.email,
      role: 'TEACHER',
    });
  });

  it('authorize faz fallback seguro se o banco estiver indisponível', async () => {
    process.env.VERCEL_ENV = 'preview';
    const options = getAuthOptions();
    const previewProvider = options.providers[1] as unknown as {
      authorize: (credentials?: Record<string, string>) => Promise<unknown>;
    };

    (prisma.user.upsert as jest.Mock).mockRejectedValue(new Error('DB offline'));

    const result = await previewProvider.authorize({ role: 'STUDENT' });

    expect(result).toEqual({
      id: 'preview-student',
      name: 'Aluno (Preview)',
      email: 'preview-student@logica-dinamica.local',
      role: 'STUDENT',
    });
  });

  it('authorize retorna null se VERCEL_ENV deixar de ser preview', async () => {
    process.env.VERCEL_ENV = 'preview';
    const options = getAuthOptions();
    const previewProvider = options.providers[1] as unknown as {
      authorize: (credentials?: Record<string, string>) => Promise<unknown>;
    };

    process.env.VERCEL_ENV = 'production';
    const result = await previewProvider.authorize({ role: 'TEACHER' });

    expect(result).toBeNull();
  });

  it('callback jwt preserva role do preview-login e usa TEACHER_EMAILS para Google', async () => {
    process.env.VERCEL_ENV = 'preview';
    const options = getAuthOptions();
    const jwtCallback = options.callbacks!.jwt!;

    const previewTeacherToken = await jwtCallback({
      token: {},
      user: {
        id: 'db-teacher-id',
        email: 'preview-teacher@logica-dinamica.local',
        role: 'TEACHER',
      },
      account: {
        provider: PREVIEW_PROVIDER_ID,
        type: 'credentials',
        providerAccountId: 'preview-teacher',
      },
    } as Parameters<typeof jwtCallback>[0]);

    expect(previewTeacherToken.role).toBe('TEACHER');
    expect(previewTeacherToken.id).toBe('db-teacher-id');

    const googleTeacherToken = await jwtCallback({
      token: {},
      user: {
        id: 'google-prof-id',
        email: 'prof@ulbra.br',
        role: 'STUDENT',
      },
      account: {
        provider: 'google',
        type: 'oauth',
        providerAccountId: '123',
      },
    } as Parameters<typeof jwtCallback>[0]);

    expect(googleTeacherToken.role).toBe('TEACHER');
  });
});
