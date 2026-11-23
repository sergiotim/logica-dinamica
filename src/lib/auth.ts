import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@/lib/prisma';
import {
  PREVIEW_PROVIDER_ID,
  getPreviewUserConfig,
  isPreviewAuthEnabled,
} from '@/lib/previewAuth';

export function getAuthOptions(): NextAuthOptions {
  const providers: NextAuthOptions['providers'] = [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      authorization: {
        params: {
          prompt: 'select_account',
        },
      },
    }),
  ];

  if (isPreviewAuthEnabled()) {
    providers.push(
      CredentialsProvider({
        id: PREVIEW_PROVIDER_ID,
        name: 'Login de Preview',
        credentials: {
          role: { label: 'Perfil', type: 'text' },
        },
        async authorize(credentials) {
          if (!isPreviewAuthEnabled()) {
            return null;
          }

          const role = credentials?.role === 'TEACHER' ? 'TEACHER' : 'STUDENT';
          const previewUser = getPreviewUserConfig(role);

          try {
            const dbUser = await prisma.user.upsert({
              where: { email: previewUser.email },
              update: {
                name: previewUser.name,
                role: previewUser.role,
              },
              create: {
                email: previewUser.email,
                name: previewUser.name,
                role: previewUser.role,
              },
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
              },
            });

            return {
              id: dbUser.id,
              name: dbUser.name,
              email: dbUser.email,
              role: dbUser.role,
            };
          } catch {
            // Fallback em caso de indisponibilidade do banco durante testes de preview
            return previewUser;
          }
        },
      })
    );
  }

  return {
    adapter: PrismaAdapter(prisma) as unknown as NextAuthOptions['adapter'],
    session: {
      strategy: 'jwt',
    },
    pages: {
      signIn: '/login',
    },
    providers,
    callbacks: {
      async jwt({ token, user, account }) {
        if (user) {
          token.id = user.id;
          if (account?.provider === PREVIEW_PROVIDER_ID && isPreviewAuthEnabled()) {
            token.role = user.role === 'TEACHER' ? 'TEACHER' : 'STUDENT';
          } else {
            const teacherEmails = (process.env.TEACHER_EMAILS || '')
              .split(',')
              .map((e) => e.trim().toLowerCase())
              .filter(Boolean);
            const email = (user.email || '').toLowerCase();
            token.role = teacherEmails.includes(email) ? 'TEACHER' : 'STUDENT';
          }
          if (user.image) {
            token.picture = user.image;
          }
        }
        return token;
      },
      async session({ session, token }) {
        if (session?.user) {
          session.user.role = (token.role as 'STUDENT' | 'TEACHER') || 'STUDENT';
          session.user.id = (token.id as string) || token.sub || '';
          if (token.picture) {
            session.user.image = token.picture as string;
          }
        }
        return session;
      },
    },
  };
}

export const authOptions: NextAuthOptions = getAuthOptions();
