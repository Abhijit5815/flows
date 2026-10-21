import LoginForm from '../../(auth)/login/login-form';

// A parallel route (@modal) that intercepts /login; not a page of its own.
export default function LoginModal() {
  return <LoginForm />;
}
