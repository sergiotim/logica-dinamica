import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import LoginPage from '@/app/login/page';
import { signIn } from 'next-auth/react';

// Mock do next-auth
jest.mock('next-auth/react', () => ({
  signIn: jest.fn(),
}), { virtual: true });

describe('Página de Login (/login)', () => {
  const originalVercelEnv = process.env.VERCEL_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VERCEL_ENV;
  });

  afterAll(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }
  });

  it('deve renderizar a marca do projeto e a mensagem de boas-vindas', () => {
    render(<LoginPage />);
    expect(screen.getByRole('heading', { name: /Lógica Dinâmica/i })).toBeInTheDocument();
    expect(screen.getByText(/Faça login com sua conta do Google/i)).toBeInTheDocument();
  });

  it('deve renderizar o botão de login com Google', () => {
    render(<LoginPage />);
    const button = screen.getByRole('button', { name: /Entrar com Google/i });
    expect(button).toBeInTheDocument();
  });

  it('deve chamar a função signIn do next-auth ao clicar no botão de login', () => {
    render(<LoginPage />);
    const button = screen.getByRole('button', { name: /Entrar com Google/i });
    
    fireEvent.click(button);
    
    // Espera que chame o signIn passando 'google' como provider e callbackUrl
    expect(signIn).toHaveBeenCalledWith('google', expect.objectContaining({ callbackUrl: '/' }));
  });

  it('deve renderizar os créditos institucionais (autor e orientadora)', () => {
    render(<LoginPage />);
    expect(screen.getByText(/Desenvolvido por/i)).toBeInTheDocument();
    expect(screen.getByText(/Sérgio Gabriel Timoteo da Silva/i)).toBeInTheDocument();
    expect(screen.getByText(/Orientação:/i)).toBeInTheDocument();
    expect(screen.getByText(/Prof.ª Dr.ª Parcilene Fernandes de Brito/i)).toBeInTheDocument();
  });

  it('não deve exibir os botões de login de preview fora do ambiente de preview', () => {
    process.env.VERCEL_ENV = 'production';
    render(<LoginPage />);

    expect(
      screen.queryByRole('button', { name: /Entrar como Professor \(Preview\)/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Entrar como Aluno \(Preview\)/i })
    ).not.toBeInTheDocument();
  });

  it('deve exibir os botões de login de preview quando VERCEL_ENV=preview', () => {
    process.env.VERCEL_ENV = 'preview';
    render(<LoginPage />);

    expect(
      screen.getByRole('button', { name: /Entrar como Professor \(Preview\)/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Entrar como Aluno \(Preview\)/i })
    ).toBeInTheDocument();
  });

  it('deve autenticar como Professor ao clicar em Entrar como Professor (Preview)', () => {
    process.env.VERCEL_ENV = 'preview';
    render(<LoginPage />);

    fireEvent.click(
      screen.getByRole('button', { name: /Entrar como Professor \(Preview\)/i })
    );

    expect(signIn).toHaveBeenCalledWith(
      'preview-login',
      expect.objectContaining({ role: 'TEACHER', callbackUrl: '/' })
    );
  });

  it('deve autenticar como Aluno ao clicar em Entrar como Aluno (Preview)', () => {
    process.env.VERCEL_ENV = 'preview';
    render(<LoginPage />);

    fireEvent.click(
      screen.getByRole('button', { name: /Entrar como Aluno \(Preview\)/i })
    );

    expect(signIn).toHaveBeenCalledWith(
      'preview-login',
      expect.objectContaining({ role: 'STUDENT', callbackUrl: '/' })
    );
  });
});
