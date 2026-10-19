import { createHash } from 'node:crypto';

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
