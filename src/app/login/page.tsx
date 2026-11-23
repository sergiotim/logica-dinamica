import React from 'react';
import { isPreviewAuthEnabled } from '@/lib/previewAuth';
import { LoginClient } from './LoginClient';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return <LoginClient isPreviewEnabled={isPreviewAuthEnabled()} />;
}
