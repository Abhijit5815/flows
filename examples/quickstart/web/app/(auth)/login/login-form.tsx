'use client';

import { useFormState } from 'react-dom';
import { login } from './actions';

export default function LoginForm() {
  const [error, dispatch] = useFormState(login, undefined);
  return (
    <form action={dispatch}>
      <input name="email" type="email" />
      <input name="password" type="password" />
      {error && <p>{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  );
}
