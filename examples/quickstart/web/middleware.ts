import { NextResponse, type NextRequest } from 'next/server';

// Signed-in pages: no session cookie, back to /login.
export function middleware(request: NextRequest) {
  if (!request.cookies.has('session')) return NextResponse.redirect(new URL('/login', request.url));
  return NextResponse.next();
}

export const config = { matcher: ['/account/:path*', '/cart'] };
