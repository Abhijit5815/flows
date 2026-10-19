import type { Response } from 'express';

// Every JSON response has the same envelope: { success, data, error, timestamp }.
export const ok = <T>(res: Response, data: T, status = 200) =>
  res.status(status).json({ success: true, data, error: null, timestamp: new Date().toISOString() });

export const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, data: null, error: message, timestamp: new Date().toISOString() });
