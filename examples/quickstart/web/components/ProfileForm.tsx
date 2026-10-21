'use client';

import type { FormEvent } from 'react';
import { updateProfile } from '@/lib/api';
import AddressFields from './AddressFields';

export default function ProfileForm() {
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await updateProfile(String(form.get('name')), String(form.get('email')));
  }

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" />
      <input name="email" type="email" />
      <AddressFields />
      <button type="submit">Save</button>
    </form>
  );
}
