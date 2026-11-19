// src/auth.ts — bearer-token auth. The trial's token is in
// MAKEFUN_SHOP_TOKEN; the viewer it names is always adaiversen (id 1000).
// A request without a matching token is 401. When no token is configured
// (local development without the env var), any non-empty bearer token is
// accepted so the server can be exercised by hand.

import type { IncomingMessage } from 'node:http';
import { VIEWER } from './store.ts';
import type { Owner } from './store.ts';

export function viewer(): Owner {
  return VIEWER;
}

export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return token === expected;
}
